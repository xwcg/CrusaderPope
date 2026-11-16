/**
 * Worker thread that owns the GameIndex. The main process forwards renderer queries here so that
 * indexing (~10 s) and big queries never block the UI or the main process event loop.
 */
import { parentPort, Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { GameIndex, resolveGameDir, type RefreshResult } from './indexer/gameIndex.ts';
import { StoryBuilder } from './describe/stories.ts';
import { scannedPath } from './describe/scriptKeys.ts';
import { CONTEXT_RULES, isFlagKey, isVariableKey } from './indexer/schema.ts';
import { VALUE_TYPES } from './indexer/valueTypes.ts';
import { LocExamples } from './describe/locExamples.ts';
import { rootCtx } from './describe/describer.ts';
import { parse } from './indexer/parser.ts';
import { PortraitBuilder } from './portraits/portrait.ts';
import { History } from './portraits/modifiers.ts';
import { CharacterTable } from './history/characters.ts';
import { ModelBrowser } from './portraits/models.ts';
import { GuiLibrary } from './gui/library.ts';
import { guiDetail, guiFind, guiItem, guiList } from './gui/detail.ts';
import { guiLayout } from './gui/preview.ts';
import { fxFingerprint, ShaderStore } from './shaders/store.ts';
import { ShaderPool } from './shaders/pool.ts';
import { CacheFileQueue, cacheFileFor, cacheKeyOf, cacheParts, cacheSibling, pruneIndexCaches, readIndexCache, runCacheWriter, touchIndexCache } from './indexer/cache.ts';
import { KeyScanThread } from './scriptKeysThread.ts';
import { GameFiles, type SaveLayer } from './mods/gamefiles.ts';
import { readSave } from './saves/envelope.ts';
import { Gamestate, entries as gsEntries } from './saves/gamestate.ts';
import { saveLayer } from './saves/project.ts';
import { SaveSession } from './saves/session.ts';
import { migrationLibraries, type LibraryConfig } from './mods/libraries.ts';
import type { InertOptions } from './mods/inertWork.ts';
import { guiWork, type GuiConfig } from './mods/guiWork.ts';
import { deleteFactStores, factsCode, saveFactStore, stopFactStore, useFactStore } from './mods/gameFacts.ts';
import { absentNames, knownNames, migrationPlan, stillOld } from './mods/migrations.ts';
import { ParsePool, ParseSuperseded } from './indexer/parsePool.ts';
import { decodeDna, encodeDna, geneCatalog, type GeneCatalog } from './saves/dna.ts';
import { saveTitleHolders } from './saves/project-state.ts';
import { T_SAVE_CHARACTER } from './indexer/schema.ts';
import { dateNum } from './map/history.ts';
import { characterChanges } from './saves/reverse.ts';
import { MapData } from './map/mapData.ts';
import { RASTER_VERSION, readRasterMeta, type RasterMeta } from './map/raster.ts';
import { mapTerrain } from './map/terrain.ts';
import { mapOverlays } from './map/overlays.ts';
import { mapFog } from './map/fog.ts';
import { mapCharacter, mapCharacters, mapHolderSuggestions } from './map/edit-characters.ts';
import { characterBasis, cultureName } from './history/newCharacter.ts';
import { coatOfArms } from './coa/coa.ts';
import type { CharacterFilter, CoaKind, DnaGene, GuiKind, GuiLayoutOptions, IndexStatus, MapEditRequest, MapEditResult, ModInfo, PortraitRequest, ScriptKeys, ShaderRequest } from '../shared/api.ts';

import { tr } from '../shared/i18n.ts';
import { parseThreadCount } from '../shared/parseThreads.ts';
import { INDEX_CACHES_DEFAULT } from '../shared/indexCaches.ts';
import { applyScriptFacts, type ScriptFacts } from '../shared/scriptFacts.ts';
/**
 * Index cache (main process decides): `file` names the cache folder (each layering's index is a file of its own there,
 * cacheFileFor), version of the indexer code, on/off, `force` = parse even if valid, `keep` = how many layerings'
 * caches the folder keeps (Settings "Index caches kept"; absent = 3).
 */
interface CacheOptions
{
    file: string;
    code: string;
    enabled: boolean;
    force?: boolean;
    keep?: number;
}

/** the index caches kept when the setting is absent */
const CACHES_KEPT = INDEX_CACHES_DEFAULT;

interface Request
{
    id: number;
    method: string;
    params: unknown[];
}

let index: GameIndex | null = null;
let stories: StoryBuilder | null = null;
let portraits: PortraitBuilder | null = null;
let characters: CharacterTable | null = null;
let models: ModelBrowser | null = null;
/** the `.gui` files, read on first use (the GUI tab) */
let gui: GuiLibrary | null = null;
let shaders: ShaderStore | null = null;
/** the game's files layered with the loaded mods (docs/mods.md) */
let vfs: GameFiles | null = null;
/** compiler threads of the current build (a newer build cancels the old pool) */
let pool: ShaderPool | null = null;
let buildSeq = 0;

/** "file · effect · defines" of a shader request (log titles) */
function requestTitle(req: { file: string; effect: string; defines?: string[]; }): string
{
    return `${req.file} · ${req.effect}${req.defines?.length ? ' · ' + req.defines.join(' ') : ''}`;
}

/** an entry for logs/shaders.log (written by the main process) */
function logShader(kind: string, title: string, detail?: string): void
{
    parentPort!.postMessage({ log: { kind, title, detail } });
}

/** compiled shaders live next to the index cache of their layering (`key`: GameIndex.layerKey) */
const shaderCacheFile = (cache: CacheOptions, key: string): string => cacheSibling(cacheFileFor(cache.file, key), 'shaders');

/** the layering of the build running now (set once its files are layered, cleared once it is the loaded index): its cache file is never pruned */
let buildKey = '';
/** "Index caches kept" as last set (a build's options or setCache): a prune reads it when it runs */
let cachesKept: number | undefined;
/**
 * The cache options as last set (a build's start or setCache): a build reads them after its waits, so a setting
 * changed meanwhile (the cache turned off) is not undone by the build that started before it
 */
let cacheOpts: CacheOptions | undefined;
/** the loaded index is a save's (built without the cache, also when the save could not be read) */
let saveBuild = false;
/**
 * the layering the shader store was made for, '' when made without the cache options (a save's build): setCache points
 * the store at this key's file only, so a store never writes its programs over another layering's file
 */
let shadersKey = '';

/** the keys a prune never drops: `inUse`, the loaded index's (cacheState), the running build's and the shader store's */
function keptKeys(inUse: string[]): string[]
{
    const now = cacheState ? cacheKeyOf(cacheState.file) : null;
    return [...inUse, ...(now ? [now] : []), ...(buildKey ? [buildKey] : []), ...(shadersKey ? [shadersKey] : [])];
}

/**
 * Drops the caches the folder no longer keeps (cache.ts pruneIndexCaches), in the write queue (never beside a write):
 * `inUse` are the layering keys never dropped, with the loaded index's and the running build's added when the job runs.
 */
function pruneCaches(cache: CacheOptions, inUse: string[]): Promise<void>
{
    return cacheWrites.run(() =>
    {
        pruneIndexCaches(dirname(cache.file), cachesKept ?? cache.keep ?? CACHES_KEPT, cache.code, keptKeys(inUse));
    });
}

/** enabled mods of the current build (the script key scan layers the same files) */
let buildMods: ModInfo[] = [];
/** the effect / trigger keys of the loaded script (the picker's "Other…" list), once per build */
let scriptKeysJob: Promise<ScriptKeys> | null = null;

/**
 * The effect and trigger keys the loaded script uses: collected on a thread of its own (scriptKeysWorker.ts,
 * driven through scriptKeysThread.ts) on first request, kept next to the index cache under the index fingerprint.
 */
function scriptKeys(): Promise<ScriptKeys>
{
    if (scriptKeysJob)
        return scriptKeysJob;

    if (!index || !vfs)
        return Promise.reject(new Error(tr('Index not ready')));

    const seq = buildSeq;
    // (keysStale: an update changed scanned files since the fingerprint was taken; the keys kept under it lack them)
    const cache = cacheState ? { file: cacheSibling(cacheState.file, 'script-keys'), fingerprint: cacheState.fingerprint, read: !keysStale } : undefined;
    // (with an editable mod loaded the thread stays: incremental updates rescan the files they changed)
    const stays = buildMods.some((m) => m.editable && m.root);

    // (a staying thread left over (its rescan failed, it was replaced): closed. A thread that does not stay and is still
    // scanning answers its own request and ends; the build closes it if it comes first)
    if (keysThread?.stays)
        keysThread.close(tr('A new key scan started'));

    const t = new KeyScanThread(join(__dirname, 'scriptKeysWorker.js'), { gameDir: vfs.gameDir, mods: buildMods, cache, facts: scriptFacts }, stays, (gone) =>
    {
        keysThreads.delete(gone);

        if (keysThread === gone)
            keysThread = null;
    });
    keysThreads.add(t);
    keysThread = t;
    const job = t.first;
    scriptKeysJob = job;
    // (a failed scan is tried again on the next request; a newer build starts over)
    job.catch(() =>
    {
        if (scriptKeysJob === job && seq === buildSeq)
            scriptKeysJob = null;
    });
    return job;
}

/** the newest scan thread (it stays for incremental updates while an editable mod is loaded) */
let keysThread: KeyScanThread | null = null;
/** the script database's facts (docs/script-database.md), applied here and handed to the key scan */
let scriptFacts: ScriptFacts | null = null;
/** every scan thread not over yet: a build closes them all */
const keysThreads = new Set<KeyScanThread>();
/** scanned files changed since cacheState's fingerprint was taken (until the recache): script-keys.json is not read */
let keysStale = false;

/** Files an incremental update changed: the scan thread takes them in, the next request gets the keys with them. */
function rescanKeys(rels: string[]): void
{
    if (!rels.some(scannedPath))
        return;

    const t = keysThread;

    // (no staying thread: the keys answered so far lack the change, the next request scans again)
    if (!t || t.dead || !t.stays || !scriptKeysJob)
    {
        scriptKeysJob = null;
        return;
    }

    const seq = buildSeq;
    const job = t.rescan(rels);
    scriptKeysJob = job;
    job.catch(() =>
    {
        if (scriptKeysJob === job && seq === buildSeq)
            scriptKeysJob = null;
    });
}

/** The scan threads go with their build: terminated, what they still owe rejected (the renderer asks again on 'ready'). */
function dropKeysThreads(): void
{
    for (const t of [...keysThreads])
        t.close(tr('The index is being rebuilt'));

    keysThreads.clear();
    keysThread = null;
    keysStale = false;
}
/** the current index's fingerprint and whether the cache file holds it */
let cacheState: { file: string; fingerprint: string; written: boolean; } | null = null;
/** one cache write at a time, and a delete (the setting turned off) only after the writes queued before it */
const cacheWrites = new CacheFileQueue();

/**
 * Writes the index cache on a thread of its own (cacheWriter.ts): here only the snapshot (the state as built,
 * before queries create flag/variable entities on demand) and its parts (typed arrays transferred, strings joined).
 */
function saveCache(idx: GameIndex, cache: CacheOptions, file: string, fingerprint: string, state = idx.exportState()): void
{
    const cs = cacheState;
    const { parts, transfer } = cacheParts(state);
    const key = cacheKeyOf(file) ?? '';
    // (the queue goes on however the writer ends, runCacheWriter)
    const write = async (): Promise<void> =>
    {
        if (index !== idx || cacheState !== cs)
            return;

        const ok = await runCacheWriter(join(__dirname, 'cacheWriter.js'), { file, fingerprint, parts, meta: { code: cache.code, layer: key } }, transfer);

        if (ok && cacheState === cs && cs)
            cs.written = true;

        // (one file more in the folder: the oldest beyond `keep` go; this one and the loaded one stay. In this job, so
        // no write of the folder runs beside it)
        if (ok)
            pruneIndexCaches(dirname(file), cachesKept ?? cache.keep ?? CACHES_KEPT, cache.code, keptKeys([key]));
    };
    setTimeout(() => void cacheWrites.run(write), 200);
}

/**
 * After incremental updates the cache file no longer matches the files (the next start would parse everything):
 * a while after the last update, the index is written again, remapped to the files as a fresh scan lists them,
 * fingerprinted with the versions it read (GameIndex.cacheSnapshot).
 */
let recacheTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRecache(cache: CacheOptions | undefined): void
{
    if (recacheTimer)
        clearTimeout(recacheTimer);

    recacheTimer = null;

    if (!cache?.enabled || !cacheState)
        return;

    recacheTimer = setTimeout(() =>
    {
        recacheTimer = null;
        const idx = index;

        if (!idx || !cacheState)
            return;

        const snap = idx.cacheSnapshot(cache.code);

        if (!snap)
            return;

        // (the layering's own file: a replace_path change taken in by an update (relayer) is another layering)
        const file = cacheFileFor(cache.file, idx.layerKey());
        cacheState = { file, fingerprint: snap.fingerprint, written: false };
        saveCache(idx, cache, file, snap.fingerprint, snap.state);
        // (the picker's keys, rescanned since: kept under the new fingerprint too, by a staying thread; else the next
        // start scans: what script-keys.json holds is under the old fingerprint)
        keysStale = false;
        const kt = keysThread;

        if (kt && !kt.dead && kt.stays)
            kt.writeCache({ file: cacheSibling(file, 'script-keys'), fingerprint: snap.fingerprint });
    }, RECACHE_DELAY);
}
/** quiet time after the last update before the cache is written again (the export takes the worker ~1 s) */
const RECACHE_DELAY = 8000;

/** Build stages with their usual share of the time (full build ≈ 9 s; shaders ≈ 4 s on the compiler threads). */
const STAGE_WEIGHT: Record<string, number> = {
    [tr('Scanning files')]: 3,
    [tr('Checking the cached index')]: 2,
    [tr('Loading the cached index')]: 20,
    [tr('Reading localization')]: 10,
    [tr('Parsing scripts')]: 55,
    [tr('Resolving references')]: 20,
    [tr('Resolving localization references')]: 5,
    [tr('Compiling shaders')]: 25
};
const PARSE_STAGES = [tr('Reading localization'), tr('Parsing scripts'), tr('Resolving references'), tr('Resolving localization references')];

/**
 * Total progress over the planned stages: finished ones plus the running one's share. When the plan changes (a
 * cache turned out stale, the shaders need compiling after all) the bar keeps its position and spreads the rest over
 * the remaining work: it never goes backwards and never stalls on a wrong estimate.
 */
class TotalProgress
{
    private stages: string[] = [];
    private weights = new Map<string, number>();
    private shown = 0;
    private step = 1;
    /** shown value and weighted work done at the last plan change */
    private base = 0;
    private baseDone = 0;
    private replanned = false;

    plan(stages: string[]): void
    {
        this.stages = stages;
        this.replanned = true;
    }

    weigh(stage: string, w: number): void
    {
        this.weights.set(stage, w);
        this.replanned = true;
    }

    at(phase: string, frac: number): { overall: number; step: number; steps: number; }
    {
        const w = (s: string): number => this.weights.get(s) ?? STAGE_WEIGHT[s] ?? 1;
        const i = this.stages.indexOf(phase);

        if (i >= 0)
        {
            const all = this.stages.reduce((s, x) => s + w(x), 0);
            const done = this.stages.slice(0, i).reduce((s, x) => s + w(x), 0) + w(phase) * Math.min(1, Math.max(0, frac));

            if (this.replanned)
            {
                this.base = this.shown;
                this.baseDone = done;
                this.replanned = false;
            }

            const rest = all - this.baseDone;
            const v = this.base + (1 - this.base) * (rest > 0 ? (done - this.baseDone) / rest : 1);
            this.shown = Math.max(this.shown, Math.min(1, v));
            this.step = i + 1;
        }

        return { overall: this.shown, step: this.step, steps: this.stages.length };
    }
}

function entityOf(type: string, name: string): ReturnType<GameIndex['get']>
{
    return index?.get(type, name);
}

/** the game files last posted as changed on disk (postStale), one per line */
let staleKey = '';

/**
 * The game's files the index read again and found changed on disk since it read them (GameIndex.staleGameFiles: a
 * Steam update while the app runs; no update takes them in), posted to main when the list changed: main shows them
 * with the loaded mods' pending change, the top bar's "Re-index" (docs/indexer.md, "Not like a build"). Checked after
 * every request (what it read is what can be found stale; an empty list costs a Set copy).
 */
function postStale(): void
{
    const idx = index;

    if (!idx)
        return;

    // (it runs in the dispatcher's finally: a throw would end the thread on an unhandled rejection)
    try
    {
        const files = idx.staleGameFiles();
        const key = files.join('\n');

        if (key === staleKey)
            return;

        staleKey = key;
        parentPort!.postMessage({ stale: files });
    }
    catch
    {
        // (the notice is a hint: none this time)
    }
}

function postStatus(s: IndexStatus): void
{
    parentPort!.postMessage({ status: s });
}

/**
 * A query of the migration's passes (libraries, interface) with the game facts of this thread kept next to the index cache while
 * the cache is on (mods/gameFacts.ts; docs/mods.md "The game's own files"): taken from the file at the first, written after each
 * that kept something new.
 */
function withFacts<T>(work: () => T): T
{
    const code = factsCode();

    if (code && readyCache?.enabled)
        useFactStore(join(dirname(readyCache.file), 'game-facts-index.bin'), `${code}|${readyCache.code}`);

    try
    {
        return work();
    }
    finally
    {
        saveFactStore();
    }
}

/** bumped by every build and incremental update (IndexStatus.revision): views reload */
let revision = 0;
/** the ready index's game folder and cache options (updates report and re-cache with them) */
let readyGameDir = '';
let readyCache: CacheOptions | undefined;
let history: History | null = null;
let mapData: MapData | null = null;
/** the province raster of the loaded map files (built once per version of them, on a thread of its own) */
let rasterJob: { key: string; job: Promise<RasterMeta>; } | null = null;

/**
 * The province raster (map/raster.ts) of the map files the loaded game and mods have: read from the map cache folder,
 * else built by mapWorker.ts from the files' bytes. Keyed by the files' locations, sizes and times.
 */
function mapRaster(dir: string): Promise<RasterMeta>
{
    if (!vfs || !mapData)
        return Promise.reject(new Error(tr('Index not ready')));

    const files = mapData.mapFiles();
    const pf = vfs.get(files.provinces);
    const df = vfs.get(files.definitions);

    if (!pf || !df)
        return Promise.reject(new Error(tr('The loaded game files have no map')));

    const key = createHash('sha1')
        .update(JSON.stringify([RASTER_VERSION, ...[pf, df].map((f) => [vfs!.where(f), vfs!.stat(f).size, vfs!.stat(f).mtime])]))
        .digest('hex')
        .slice(0, 16);

    if (rasterJob?.key === key)
        return rasterJob.job;

    const cached = readRasterMeta(dir, key);
    const job = cached
        ? Promise.resolve(cached)
        : new Promise<RasterMeta>((resolve, reject) =>
        {
            const png = vfs!.read(pf);
            const csv = vfs!.readText(df);

            if (!png || csv === undefined)
                return reject(new Error(tr('Cannot read the map files')));

            const worker = new Worker(join(__dirname, 'mapWorker.js'), { workerData: { png, csv, dir, key } });
            worker.once('message', (m: { meta?: RasterMeta; error?: string; }) =>
            {
                void worker.terminate();

                if (m.meta)
                    resolve(m.meta);
                else
                    reject(new Error(m.error ?? tr('No province raster')));
            });
            worker.once('error', reject);
        });
    rasterJob = { key, job };
    // (a failed build is tried again on the next request)
    job.catch(() =>
    {
        if (rasterJob?.job === job)
            rasterJob = null;
    });
    return job;
}

/** The map's data over the index (and the loaded save, if any). */
function makeMapData(idx: GameIndex): MapData
{
    return new MapData(idx, saveState?.g, saveState ? (p) => saveState?.session.changedBlock(p) : undefined);
}

/**
 * The files an update reports to the views (IndexStatus.changedFiles): the first 500, and (when the list is longer)
 * one gfx file and one shader file if the rest holds them, since the views tell gfx and shader changes from the list.
 */
function changedSample(files: string[]): string[]
{
    const sample = files.slice(0, 500);

    if (files.length <= 500)
        return sample;

    for (const test of [/^gfx\/fx\//i, /^gfx\//i])
    {
        if (!sample.some((f) => test.test(f)))
        {
            const f = files.find((x) => test.test(x));

            if (f)
                sample[sample.length - 1] = f;
        }
    }

    return sample;
}

/**
 * Answers a map request from the MapData that was current when it was asked: if a build or an update made another
 * meanwhile (the raster takes a while), the request is asked again of that one: the raster belongs to the map files of
 * the MapData it was asked for, and a MapData that went (a build starts with none) has no answer. While a build runs
 * the request fails (Index not ready), as it does at its start.
 */
async function withMapData<T>(dir: string, ask: (md: MapData, meta: RasterMeta) => T): Promise<T>
{
    for (;;)
    {
        const md = mapData;
        const meta = await mapRaster(dir);

        if (md && md === mapData)
            return ask(md, meta);
    }
}

/**
 * What is derived from the index, rebuilt after a build and after updates (all lazy: the work happens on use).
 * `lib`: the portrait asset library to keep (its mesh and texture caches) when no gfx file changed.
 */
function derive(idx: GameIndex, what: { lib?: PortraitBuilder['lib']; characters?: boolean; models?: boolean; } = {}): void
{
    stories = new StoryBuilder(idx);
    gui = null;
    mapData = makeMapData(idx);
    history = new History(idx);
    // (what a text code prints for the sample character: the example sentences of the faith cards' names in game)
    {
        const h = history;
        let lx: LocExamples | undefined;
        stories.locExample = (chain) => (lx ??= new LocExamples(idx, h)).examples([chain])[chain];
    }
    stories.familyOf = (id) => characters?.familyTree(id) ?? null;
    stories.guiUsers = (name) => (vfs ? (gui ??= new GuiLibrary(vfs)).usedBy('scriptedGui', name).map(guiItem) : []);
    stories.d.guiFind = (name) => (vfs ? guiFind(gui ??= new GuiLibrary(vfs), name) : undefined);
    portraits = new PortraitBuilder(idx, history, what.lib);

    if (what.characters !== false || !characters)
        characters = new CharacterTable(idx, history);

    // meshes creatures show: their previews borrow the decal list of the first character showing them (the current builder)
    if (what.models !== false || !models)
        models = new ModelBrowser(idx, portraits.lib, (mesh) => portraits!.previewDecals(mesh));

    // a loaded save (docs/saves.md): its characters' history (the save's date, its titles), portraits from their DNA, and
    // family trees: the same builders over the save's characters
    saveViews = null;

    if (saveState)
    {
        const s = saveState;
        const saveHistory = new History(idx, { type: T_SAVE_CHARACTER, date: dateNum(s.g.date()) ?? 0, titles: saveTitleHolders(s.g) });
        const builder = new PortraitBuilder(idx, saveHistory, portraits.lib);
        let cat: GeneCatalog | undefined;
        builder.saveGenes = (id) =>
        {
            const dna = s.session.dnaOf(Number(id));
            return dna ? decodeDna(dna, (cat ??= geneCatalog(idx, s.g, s.session.save.meta))) : undefined;
        };
        saveViews = { history: saveHistory, portraits: builder, characters: new CharacterTable(idx, saveHistory), catalog: () => (cat ??= geneCatalog(idx, s.g, s.session.save.meta)) };
        stories.saveFamilyOf = (id) => saveViews?.characters.familyTree(id) ?? null;
    }
}

/** A loaded save's views (derive): its history, portraits, family trees, the DNA's gene catalog. */
let saveViews: { history: History; portraits: PortraitBuilder; characters: CharacterTable; catalog: () => GeneCatalog; } | null = null;

/** The builder of a portrait: a loaded save's characters have their own (their DNA, the save's history). */
const portraitsFor = (type: string): PortraitBuilder | null => (type === T_SAVE_CHARACTER ? (saveViews?.portraits ?? null) : portraits);

/**
 * Compiler threads and the store of compiled shaders for the loaded files (a build; shader files of a loaded mod that
 * changed, docs/shaders.md): the programs of an earlier run with the same FX files come from the cache (`load`).
 * Replaces the running pool (its threads read the FX files as they were).
 */
function shaderStore(gameDir: string, mods: ModInfo[], cache: CacheOptions | undefined, files: GameFiles, load: boolean, key: string): ShaderStore
{
    pool?.terminate();
    const threads = new ShaderPool(join(__dirname, 'shaderWorker.js'), { gameDir, mods }, Math.max(1, Math.min(4, Math.floor(availableParallelism() / 3))));
    pool = threads;
    const store = new ShaderStore(
        (req) => threads.compile(req),
        cache?.enabled ? shaderCacheFile(cache, key) : null,
        fxFingerprint(files, (cache?.code ?? '') + threads.version),
        (req, message) => logShader('COMPILE', requestTitle(req), message)
    );

    if (load && cache?.enabled)
        store.load();

    return store;
}

/** @param mods enabled mods of the selected list, in load order (later wins) */
/** The loaded save (docs/saves.md): its gamestate, read once per build (the map and edits read it again) */
let saveState: { file: string; g: Gamestate; session: SaveSession; stack: { rel: string; key: string; before: string; after: string; n: number; label: string; }[]; } | null = null;
/** why the save asked for could not be loaded (the build goes on without it) */
let saveProblem: string | null = null;
/** the save's title ids by key (map edits of a title's block) */
let saveTitleIds: Map<string, number> | null = null;

function saveTitleId(g: Gamestate, key: string): number | undefined
{
    if (!saveTitleIds)
    {
        saveTitleIds = new Map();
        const db = g.sub(g.section('landed_titles'), 'landed_titles');

        for (const x of db?.block ? gsEntries(g.buf, db.vs, db.ve) : [])
        {
            if (!x.block || !x.key)
                continue;

            for (const f of gsEntries(g.buf, x.vs, x.ve))
            {
                if (f.key === 'key' && !f.block)
                {
                    saveTitleIds.set(g.buf.subarray(f.vs, f.ve).toString('latin1'), Number(x.key));
                    break;
                }
            }
        }
    }

    return saveTitleIds.get(key);
}

/** After a map edit of the save: the map made anew from the save as changed, the views told (a revision). */
function remakeSaveMap(): void
{
    const idx = index;

    if (!idx || !saveState)
        return;

    mapData = new MapData(idx, saveState.g, (p) => saveState?.session.changedBlock(p));
    postStatus({ state: 'ready', stats: idx.stats, gameDir: readyGameDir, revision: ++revision, changedFiles: [] });
}

/** `save`: a loaded game save (its file): the last layer, over the mods; the index cache is not used with it */
async function build(installDir: string, language: string, cache?: CacheOptions, mods: ModInfo[] = [], save?: string, parseThreadsSetting?: number): Promise<void>
{
    // (the latest options, also for a save's build: its setting changes and prunes, setCache)
    cacheOpts = cache;
    saveBuild = !!save;

    // (the index cache is the game's and mods'; a save's index is built each time)
    if (save)
        cache = undefined;

    saveProblem = null;
    const seq = ++buildSeq;
    index = null;
    buildKey = '';

    if (cacheOpts)
        cachesKept = cacheOpts.keep;

    // (the build reads every file as it is now: no game file is stale any more; posted after any older list, so main
    // never keeps one past the build)
    staleKey = '';
    parentPort!.postMessage({ stale: [] });
    scriptKeysJob = null;
    dropKeysThreads();
    buildMods = mods;
    stories = null;
    portraits = null;
    characters = null;
    models = null;
    gui = null;
    shaders = null;
    shadersKey = '';
    history = null;
    // (and the rest that holds the old index: a full build lets it go at its start: nothing asks it anything while
    // `index` is null, and keeping it in the heap shared by all threads doubled the build's peak; docs/indexer.md, "Memory".
    // `rasterJob` stays: it resolves to a small RasterMeta and de-duplicates a raster build already running)
    mapData = null;
    saveViews = null;

    if (recacheTimer)
        clearTimeout(recacheTimer);

    recacheTimer = null;
    const gameDir = resolveGameDir(installDir);

    if (!gameDir)
    {
        postStatus({ state: 'error', message: tr('No Crusader Kings III game files found in "{installDir}". Expected a folder containing game/common.', { installDir }), gameDir: installDir });
        return;
    }

    cacheState = null;
    pool?.terminate();
    pool = null;
    // total progress: the stages this build will probably run, corrected once the caches are checked
    const total = new TotalProgress();
    const useCache = !!cache?.enabled && !cache.force;
    const head = [tr('Scanning files'), ...(cache?.enabled ? [tr('Checking the cached index')] : [])];
    // (planned as loaded from the cache while it is on: the layering's own file is known once the files are layered, below)
    total.plan([...head, ...(useCache ? [tr('Loading the cached index')] : PARSE_STAGES), tr('Compiling shaders')]);
    let last = 0;
    let lastPhase = '';
    const progress = (p: { phase: string; done: number; total: number; }): void =>
    {
        // (the index's own end marker: the next stage follows at once)
        if (p.phase === 'Done')
            return;

        const now = Date.now();

        if (now - last > 80 || p.phase !== lastPhase)
        {
            last = now;
            lastPhase = p.phase;
            postStatus({ state: 'indexing', phase: p.phase, done: p.done, total: p.total, gameDir, ...total.at(p.phase, p.total ? p.done / p.total : 0) });
        }
    };
    progress({ phase: 'Starting', done: 0, total: 1 });

    try
    {
        vfs?.close();
        // a loaded save: read, its files made (saves/project.ts); a save that can't be read is left out, said in the status
        let layer: SaveLayer | undefined;
        saveState = null;

        if (save)
        {
            progress({ phase: tr('Reading the save'), done: 0, total: 1 });

            try
            {
                const f = readSave(save);

                if (f.binary)
                    throw new Error(tr('a binary save (an autosave or ironman) can\'t be read'));

                const g = new Gamestate(f.gamestate);
                saveState = { file: save, g, session: new SaveSession(save, { save: f, g }), stack: [] };
                saveTitleIds = null;
                // (named "Savegame" in chips and badges; the Save tab says which)
                layer = saveLayer(save, statSync(save).mtimeMs, g, tr('Savegame'));
            }
            catch (e)
            {
                saveProblem = `${basename(save)}: ${e instanceof Error ? e.message : String(e)}`;
            }
        }

        vfs = new GameFiles(gameDir, mods, layer);
        const files = vfs;
        let idx = new GameIndex(files, language);
        // (one cache per layering: this list's own file, docs/indexer.md "One per mod list")
        const key = idx.layerKey();
        const cacheFile = cache ? cacheFileFor(cache.file, key) : '';
        // (a prune meanwhile, a write of the list before finishing or "Index caches kept" changed, keeps this file)
        buildKey = cache ? key : '';

        if (useCache && !existsSync(cacheFile))
            total.plan([...head, ...PARSE_STAGES, tr('Compiling shaders')]);

        idx.scan(progress);
        // the game's shaders: compiled on their own threads (each layers the same mods: a mod's gfx/FX files win); the
        // store (from the cache) says right away whether any need compiling, which sets the shader stage's share of the
        // total progress
        const store = shaderStore(gameDir, mods, cache, files, useCache, key);

        const assets = idx.modelFiles().filter((m) => /\.asset$/i.test(m.rel));
        total.weigh(tr('Compiling shaders'), store.covers(assets, idx.vfs) ? 1 : STAGE_WEIGHT[tr('Compiling shaders')]);
        // dispatched now, compiled on the pool's threads while this thread parses or loads the index; the shader stage
        // at the end only waits for what is left
        let shaderStage = false;
        let compiled = { done: 0, n: 0 };
        const shadersDone = store.precompile(assets, idx.vfs, {
            planned: (missing) => missing || total.weigh(tr('Compiling shaders'), 1),
            progress: (done, n) =>
            {
                compiled = { done, n };

                if (shaderStage)
                    progress({ phase: tr('Compiling shaders'), done, total: n });
            },
            alive: () => seq === buildSeq
        });
        // the cache: valid while every indexed file, the gfx listing, language and the indexer code are unchanged
        let fingerprint = '';
        let loaded = false;

        if (cache?.enabled)
        {
            progress({ phase: tr('Checking the cached index'), done: 0, total: 1 });
            fingerprint = idx.fingerprint(cache.code);

            if (!cache.force && existsSync(cacheFile))
                progress({ phase: tr('Loading the cached index'), done: 0, total: 100 });

            const state = cache.force ? null : readIndexCache(cacheFile, fingerprint);

            if (state)
            {
                progress({ phase: tr('Loading the cached index'), done: 30, total: 100 });

                try
                {
                    idx.importState(state, progress);
                    loaded = true;
                    // (the most recently used now: the prune keeps the newest)
                    touchIndexCache(cacheFile);
                }
                catch
                {
                    idx = new GameIndex(files, language);
                    idx.scan(progress);
                }
            }
        }
        else if (cache?.file)
            void cacheWrites.deleteAll(dirname(cache.file));

        if (!loaded)
        {
            total.plan([...head, ...PARSE_STAGES, tr('Compiling shaders')]);
            // (the script files parsed on threads, docs/indexer.md "Parallel parsing"; the shader pool runs meanwhile)
            // (a newer build meanwhile (selecting a list, then making a mod …) stops this one's threads: two builds
            // side by side ran a thread out of memory)
            // (Settings.parseThreads: off parses on this thread, as before the pool)
            const parseThreads = parseThreadCount(parseThreadsSetting, availableParallelism());

            try
            {
                if (parseThreads === 0)
                    idx.parseAll(progress);
                else
                    await idx.parseAllParallel(new ParsePool(join(__dirname, 'parseWorker.js'), parseThreads), progress, () => seq === buildSeq);
            }
            catch (e)
            {
                if (e instanceof ParseSuperseded)
                    return;

                throw e;
            }
        }

        if (seq !== buildSeq)
            return;

        index = idx;
        // (the loaded index now: its file is kept as cacheState's; a relayer's new layering no longer keeps the old one)
        buildKey = '';

        // (the setting as it is now: turned off while this build ran, nothing is written and the cache stays off)
        if (cache?.enabled && cacheOpts?.enabled)
        {
            cacheState = { file: cacheFile, fingerprint, written: loaded };

            if (!loaded)
                saveCache(idx, cache, cacheFile, fingerprint);

            // (at once: caches of another app version or language, older versions' one file, dead writes' leftovers;
            // queued before this build's write, which prunes again when it is done)
            void pruneCaches(cacheOpts, [key]);
        }
        // (a save's build reads and writes no cache, but the folder is still pruned: another app version's files go)
        else if (saveBuild && cacheOpts?.enabled)
            void pruneCaches(cacheOpts, []);

        derive(idx);
        readyGameDir = gameDir;
        readyCache = saveBuild ? undefined : cacheOpts;
        // every Effect the .asset files name, compiled meanwhile on the shader threads (or already in the store)
        shaderStage = true;
        progress({ phase: tr('Compiling shaders'), done: compiled.done, total: Math.max(1, compiled.n) });
        await shadersDone;

        if (seq !== buildSeq)
            return;

        // every failure the store knows (also the ones loaded from the cache), so each session's log is complete
        const { programs, failures } = store.list();
        logShader(
            'SUMMARY',
            `${programs.length} shader programs compiled, ${failures.length} failed`,
            failures
                .map((f) =>
                {
                    const req = JSON.parse(f.key) as { file: string; effect: string; defines?: string[]; };
                    return `${requestTitle(req)}\n  ${f.error.split('\n').slice(0, 3).join('\n  ')}`;
                })
                .join('\n') || undefined
        );
        shaders = store;
        // (made with this layering's file when the cache options were given; the cache turned off meanwhile: no file)
        shadersKey = cache ? key : '';

        if (cache?.enabled && !cacheOpts?.enabled)
            store.setFile(null);

        postStatus({ state: 'ready', stats: idx.stats, gameDir, revision: ++revision });
    }
    catch (err)
    {
        postStatus({ state: 'error', message: String((err as Error)?.stack ?? err), gameDir });
    }
}

const handlers: Record<string, (...args: never[]) => unknown> = {
    build: (installDir: string, language: string, cache?: CacheOptions, mods?: ModInfo[], save?: string, parseThreads?: number) => build(installDir, language, cache, mods, save, parseThreads),
    // ---- edits of a loaded save (docs/saves.md, "Edits"): its generated files changed, the save changed with them
    // a save file's text as indexed
    saveFileText: (rel: string) => index?.vfs.save?.files.get(rel)?.toString('utf8') ?? null,
    // the top-level block of a save file around an offset of its text (as indexed: a string)
    saveBlock: (rel: string, at: number) =>
    {
        const text = index?.vfs.save?.files.get(rel)?.toString('utf8');
        const n = text === undefined ? undefined : parse(text).find((x) => x.s <= at && at < x.e && x.k);
        return n && text !== undefined ? { key: n.k!, start: n.s, end: n.e, text: text.slice(n.s, n.e) } : null;
    },
    // a block of a save file edited: the save's character changed with it (refused as a whole when the save can't take
    // a part), the file made anew and taken in by the index
    saveSetBlock: async (rel: string, start: number, end: number, before: string, after: string, label: string) =>
    {
        const s = saveState;
        const vfsNow = index?.vfs;
        const text = vfsNow?.save?.files.get(rel)?.toString('utf8');

        if (!s || !vfsNow || text === undefined)
            throw new Error(tr('No save is loaded'));

        if (text.slice(start, end) !== before)
            throw new Error(tr('The save\'s entry changed meanwhile: try again'));

        if (!/^savegame\/characters\//i.test(rel))
            throw new Error(tr('Only the save\'s characters can be changed so far'));

        const old = parse(before)[0];
        const now = parse(after)[0];

        if (!old || !now || old.k !== now.k || !Array.isArray(old.v) || !Array.isArray(now.v))
            throw new Error(tr('The character\'s block must stay one block with its id'));

        const { edits, unsupported } = characterChanges(s.g, old.v, now.v);

        if (unsupported.length)
            throw new Error(tr('The save can\'t take this change: {what}', { what: unsupported.join('; ') }));

        const id = Number(old.k);
        let n = 0;

        try
        {
            for (const e of edits)
            {
                s.session.edit({ ...e, id, label });
                n++;
            }
        }
        catch (e)
        {
            for (; n > 0; n--)
                s.session.undo();

            throw e;
        }

        s.stack.push({ rel, key: old.k!, before, after, n, label });
        const next = text.slice(0, start) + after + text.slice(end);
        vfsNow.setSaveFile(rel, Buffer.from(next, 'utf8'));
        await (handlers.refreshFiles as unknown as (p: string[], r?: unknown, v?: string[]) => Promise<RefreshResult>)([], undefined, [rel]);
        return { line: next.slice(0, start).split('\n').length, pending: s.session.pending, changes: edits.length };
    },
    // undoes the last edit of the save: the character's block as it was, the save's changes taken back
    saveUndo: async () =>
    {
        const s = saveState;
        const u = s?.stack.pop();
        const vfsNow = index?.vfs;

        if (!s || !u || !vfsNow)
            return null;

        for (let i = 0; i < u.n; i++)
            s.session.undo();

        // (a map edit: the map made anew)
        if (!u.rel)
        {
            remakeSaveMap();
            return { label: u.label, pending: s.session.pending, left: s.stack.length };
        }

        const text = vfsNow.save?.files.get(u.rel)?.toString('utf8') ?? '';
        const n = parse(text).find((x) => x.k === u.key);

        if (n)
        {
            vfsNow.setSaveFile(u.rel, Buffer.from(text.slice(0, n.s) + u.before + text.slice(n.e), 'utf8'));
            await (handlers.refreshFiles as unknown as (p: string[], r?: unknown, v?: string[]) => Promise<RefreshResult>)([], undefined, [u.rel]);
        }

        return { label: u.label, pending: s.session.pending, left: s.stack.length };
    },
    // a map edit of a loaded save (docs/saves.md "The map"): a county's culture, faith, development, a title's colour;
    // its holder, liege and holdings are the realm's structure in the save (refused for now)
    saveMapEdit: (req: MapEditRequest): MapEditResult =>
    {
        const s = saveState;
        const layer = index?.vfs.save;

        if (!s || !layer)
            return { ok: false, message: tr('No save is loaded') };

        const mod = { id: layer.id, name: tr('Savegame') };

        if (req.kind === 'undo')
        {
            const u = s.stack[s.stack.length - 1];

            if (!u || u.rel)
                return { ok: false, message: tr('The last change of the save was not made on the map: undo it from the change bar or the Save tab'), mod };

            s.stack.pop();
            s.session.undo();
            remakeSaveMap();
            return { ok: true, message: tr('Undone: {label}', { label: u.label }), mod, undo: s.stack.filter((x) => !x.rel).length };
        }

        const t = req.title ?? '';
        const v = req.value ?? '';
        let path: string;
        let field: string;
        let value: string;
        let label: string;

        switch (req.kind)
        {
            case 'culture':
            {
                const id = [...s.g.cultures()].find(([, k]) => k === v)?.[0];

                if (id === undefined)
                    return { ok: false, message: tr('{key} is not a culture of this save', { key: v }), mod };

                [path, field, value, label] = [`county_manager/counties/${t}`, 'culture', String(id), tr('{title}: culture {key}', { title: t, key: v })];
                break;
            }
            case 'faith':
            {
                const id = [...s.g.faiths()].find(([, k]) => k === v)?.[0];

                if (id === undefined)
                    return { ok: false, message: tr('{key} is not a faith of this save', { key: v }), mod };

                // (written as the save has it: `faith = <id>`, a 1.20 save `rite = <a rite of the faith>`: the county's own
                // when it is the faith's, else the main rite)
                const county = s.session.pathBlock(`county_manager/counties/${t}`);
                const w = s.g.faithField(id, county && s.g.riteIn(county));

                if (!w)
                    return { ok: false, message: tr('This save has no rite for that faith'), mod };

                [path, field, value, label] = [`county_manager/counties/${t}`, w.field, w.value, tr('{title}: faith {key}', { title: t, key: v })];
                break;
            }
            case 'development':
                if (!/^\d+$/.test(v))
                    return { ok: false, message: tr('Development: a whole number'), mod };

                [path, field, value, label] = [`county_manager/counties/${t}`, 'development', v, tr('{title}: development {n}', { title: t, n: v })];
                break;
            case 'color':
            {
                const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
                const id = saveTitleId(s.g, t);

                if (!m || id === undefined)
                    return { ok: false, message: !m ? tr('A colour: #rrggbb') : tr('The save has no title {key}', { key: t }), mod };

                [path, field, value, label] = [`landed_titles/landed_titles/${id}`, 'color', `rgb { ${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)} }`, tr('{title}: colour {hex}', { title: t, hex: v })];
                break;
            }
            default:
                return { ok: false, message: tr('A save\'s holders, lieges and holdings are part of its realms: not changed from the map yet'), mod };
        }

        if (req.plan)
            return { ok: true, message: label, mod };

        try
        {
            s.session.editPath(path, [{ field: [field], value }], label);
        }
        catch (e)
        {
            return { ok: false, message: e instanceof Error ? e.message : String(e), mod };
        }

        s.stack.push({ rel: '', key: path, before: '', after: '', n: 1, label });
        remakeSaveMap();
        return { ok: true, message: label, mod, undo: s.stack.filter((x) => !x.rel).length, notes: [tr('Changed in the loaded save ({n} not written yet) — “Write save as…” on the Save tab writes them', { n: s.session.pending })] };
    },
    // the save with its changes written to a new file
    saveWrite: async (out: string) =>
    {
        if (!saveState)
            throw new Error(tr('No save is loaded'));

        return saveState.session.writeAs(out);
    },
    savePending: () => (saveState ? { pending: saveState.session.pending, edits: saveState.stack.map((x) => x.label) } : { pending: 0, edits: [] }),
    // what a mod needs to follow the loaded game's version (docs/mods.md "Migrating a mod")
    migrationPlan: (modId: string, supported?: string, game?: string, patchId?: string) => (index && stories ? migrationPlan(index, stories, modId, supported, game, patchId) : null),
    migrationStillOld: (type: string, name: string) => !!index && !!stories && stillOld(index, stories, type, name),
    // which of the `prefix:name` references a mod's statements make the index has no entry for (mods/migrations.ts)
    migrationNames: (refs: string[]) => (index ? absentNames(index, refs) : null),
    // which of the names the index has, as a live definition or otherwise (mods/renameRule.ts)
    migrationKnown: (names: string[]) => (index ? knownNames(index, names) : null),
    // the game's definitions a mod's older copies of game files hide and loaded files still use (mods/libraries.ts)
    migrationLibraries: (modId: string, patchId: string | undefined, config: LibraryConfig, extra: string[], inert?: InertOptions) => (index ? withFacts(() => migrationLibraries(index!, config, modId, patchId, extra, inert)) : null),
    migrationGui: (config: GuiConfig, modId: string, patchId: string | undefined) => (index ? withFacts(() => guiWork(index!, config, modId, patchId)) : null),
    // the loaded save as the index has it (docs/saves.md): its file, date, player, or why it isn't loaded
    saveInfo: () => (saveState ? { file: saveState.file, date: saveState.g.date(), players: saveState.session.players(), problem: null, note: saveState.g.layoutNote() ?? null } : { file: null, date: null, players: [], problem: saveProblem }),
    // the setting changed: write the current index now, or remove the file
    // (and "Index caches kept" changed: the folder pruned to the new count)
    setCache: (cache: CacheOptions) =>
    {
        cachesKept = cache.keep;
        cacheOpts = cache;

        // (a save's index is built without the cache each time (build), also when the save could not be read: turned
        // off, the folder is deleted; else only pruned to the new count. The save's layering is never written, and
        // readyCache and the shader store stay as the build left them: writing it here once pruned every list's cache
        // to make room for a file no build reads)
        if (saveBuild)
        {
            if (!cache.enabled)
            {
                void cacheWrites.deleteAll(dirname(cache.file));
                stopFactStore();
                deleteFactStores(dirname(cache.file));
            }
            else
                void pruneCaches(cache, []);

            return;
        }

        readyCache = cache;
        const key = index?.layerKey() ?? '';
        // (the store's own layering's file, not the index's key now: after a relayer without an FX change they differ,
        // and the store's programs written under the new key's file could never hit there)
        shaders?.setFile(cache.enabled && shadersKey ? shaderCacheFile(cache, shadersKey) : null);

        if (!cache.enabled)
        {
            cacheState = null;
            // (every list's index, keys and shaders, and the older versions' one file)
            void cacheWrites.deleteAll(dirname(cache.file));
            stopFactStore();
            deleteFactStores(dirname(cache.file));
            return;
        }

        void pruneCaches(cache, key ? [key] : []);

        // (written, or a write of it pending: a count change does not export and write the same index again)
        if (!index || cacheState)
            return;

        const file = cacheFileFor(cache.file, key);

        if (index.refreshed)
        {
            // (updated since the build: the files as a fresh scan lists them; unknown versions are the current ones)
            const snap = index.cacheSnapshot(cache.code, true);

            if (!snap)
                return;

            cacheState = { file, fingerprint: snap.fingerprint, written: false };
            saveCache(index, cache, file, snap.fingerprint, snap.state);
            return;
        }

        cacheState = { file, fingerprint: index.fingerprint(cache.code), written: false };
        saveCache(index, cache, file, cacheState.fingerprint);
    },
    // files of loaded mod folders changed, written by the app or seen by a folder watcher (docs/indexer.md,
    // "Incremental updates"): taken in without a build: many files in several updates, queries answered in between;
    // `fallback` says when a full build is needed (or faster)
    // (`relayer`: loaded mods whose replace_path changed: the first update takes the new layering, GameIndex.relayer)
    refreshFiles: async (paths: string[], relayer?: { id: string; replacePaths: string[]; }[], virtual?: string[]): Promise<RefreshResult> =>
    {
        const idx = index;

        if (!idx || !stories)
            return { changed: false, files: [], gfx: [], parsed: 0, resolved: 0, ms: 0, fallback: tr('the index is not ready') };

        const all: RefreshResult = { changed: false, files: [], gfx: [], parsed: 0, resolved: 0, ms: 0 };
        let next: string[] | undefined = paths;
        const rederive = (): void =>
            derive(idx, {
                // (a new asset library forgets the meshes and textures read so far: only when a gfx file changed)
                lib: all.gfx.length ? undefined : portraits?.lib,
                characters: all.files.some((f) => /^(history|localization)\//i.test(f) || /^common\/(dynast|religion|culture|traits)/i.test(f)),
                models: all.gfx.length > 0
            });

        let first = true;

        while (next)
        {
            const r: RefreshResult = first && relayer?.length ? idx.relayer(relayer) : idx.refreshFiles(next, undefined, first && virtual?.length ? { virtual } : {});

            // (replace paths changed: the shader store and the next index worker's mods have the new layering; the compiled
            // programs of a changed gfx/FX folder are new)
            if (first && relayer?.length && !r.fallback)
            {
                const fx = (paths: string[]): boolean => paths.some((p) => /^gfx(\/fx)?(\/|$)/i.test(p.replace(/\\/g, '/').replace(/^\/+/, '')));
                const touchesFx = relayer.some((c) => fx(c.replacePaths) || fx(buildMods.find((m) => m.id === c.id)?.replacePaths ?? []));
                buildMods = buildMods.map((m) => ({ ...m, replacePaths: relayer.find((c) => c.id === m.id)?.replacePaths ?? m.replacePaths }));

                // (no FX change: the store stays on the file of the layering it was made for. Its fingerprint hashes
                // that layering's identity (store.ts), so under the new key's file it could never hit: the new layering
                // compiles once on its first build and keeps its programs under its own key)
                if (touchesFx)
                {
                    shaders = shaderStore(readyGameDir, buildMods, readyCache, idx.vfs, true, idx.layerKey());
                    shadersKey = readyCache ? idx.layerKey() : '';
                }
            }

            first = false;
            all.changed ||= r.changed;

            // (the keys kept under the current fingerprint lack these files' changes until the recache: set with the part
            // that changed them, so a picker request between two parts (the yield below) scans instead of reading them)
            if (r.changed && r.files.some(scannedPath))
                keysStale = true;

            // (loops: a replace_path over a big folder lists thousands of files, too many arguments for push)
            for (const f of r.files)
                all.files.push(f);

            for (const f of r.gfx)
                all.gfx.push(f);

            all.parsed += r.parsed;
            all.resolved += r.resolved;
            all.ms += r.ms;

            // (the GUI library is read again on its next use; the previews' expansions go with it)
            if (r.gui?.length)
            {
                (all.gui ??= []).push(...r.gui);
                gui = null;
            }

            // (the map's data is made again from the listings: see the end)
            if (r.map?.length)
                (all.map ??= []).push(...r.map);

            if (r.shaders?.length)
            {
                (all.shaders ??= []).push(...r.shaders);
                // (compiled again on demand; the next build precompiles them)
                shaders = shaderStore(readyGameDir, buildMods, readyCache, idx.vfs, true, idx.layerKey());
                shadersKey = readyCache ? idx.layerKey() : '';
            }

            if (r.fallback)
            {
                all.fallback = r.fallback;
                break;
            }

            next = r.rest;

            // (the next part after the queries that came in meanwhile, answered from what is derived from the index
            // as it is now; a build that started meanwhile has it all)
            if (next)
            {
                if (r.changed)
                    rederive();

                await new Promise((resolve) => setImmediate(resolve));

                if (index !== idx)
                    return all;
            }
        }

        // (interface and map files only: no index change, but the GUI tab and the map reload on the revision, renderer revision.ts `gui`)
        if (!all.changed && !all.shaders && !all.gui && !all.map)
            return all;

        if (all.changed)
        {
            rederive();
            // (the picker's "Other…" keys: the changed files scanned again, before the views ask for them)
            rescanKeys(all.files);
            scheduleRecache(readyCache);
        }
        else if (all.map)
        {
            // (map files alone: only the map's data is made again)
            mapData = makeMapData(idx);
        }

        postStatus({ state: 'ready', stats: idx.stats, gameDir: readyGameDir, revision: ++revision, changedFiles: changedSample(all.files) });
        return all;
    },
    // loaded mods renamed in their descriptors (main checked that the layering is the same): no build, the views reload
    renameMods: (names: { id: string; name: string; }[]) =>
    {
        const idx = index;

        if (!idx || !idx.renameMods(names))
            return false;

        const byId = new Map(names.map((m) => [m.id, m.name]));
        buildMods = buildMods.map((m) => ({ ...m, name: byId.get(m.id) ?? m.name }));
        postStatus({ state: 'ready', stats: idx.stats, gameDir: readyGameDir, revision: ++revision, changedFiles: [] });
        return true;
    },
    types: (counts?: boolean) => index?.types(counts !== false) ?? [],
    typeDoc: (type: string) => index?.typeDoc(type) ?? [],
    list: (type: string) => index?.list(type) ?? [],
    // which DLC each entry of a type comes with (the picker's grouping)
    dlcGroups: (type: string) => index?.dlcGroups(type) ?? {},
    // the entries limited to a DLC by their own script, and its flag (the picker's "Only with <DLC>")
    dlcFlags: (type: string) => index?.dlcFlags(type) ?? {},
    search: (q: string, opts?: { limit?: number; types?: string[]; text?: boolean; modOnly?: boolean; noRemoved?: boolean; state?: string; }) => index?.search(q, opts) ?? [],
    detail: (type: string, name: string) => index?.detail(type, name) ?? null,
    // editing the active mod (src/main/mods/edit.ts): the text to copy, the file to replace
    overrideSource: (type: string, name: string, activeMod?: string) => index?.overrideSource(type, name, activeMod) ?? null,
    overrideFileBytes: (type: string, name: string) => index?.overrideFileBytes(type, name) ?? null,
    graph: (type: string, name: string, opts: { depth: number; excludeTypes: string[]; onlyTypes: string[] | null; maxNodes?: number; }) => index?.graph(type, name, opts.depth, opts.excludeTypes, opts.onlyTypes, opts.maxNodes) ?? { nodes: [], edges: [] },
    card: (type: string, name: string) =>
    {
        const e = entityOf(type, name);
        return e && stories ? stories.card(e) : null;
    },
    // the loc codes the game uses, the scopes an entry's texts can speak of (the text editor's "Insert code…")
    // (with what the common ones print for William of Normandy in 1066, which the picker shows)
    locCodes: () =>
    {
        const c = stories?.locCodes() ?? { functions: [], concepts: [], icons: [], formats: [] };

        if (!index || !history)
            return c;

        const ex = new LocExamples(index, history);
        return { ...c, examples: ex.examples(c.functions.map(([f]) => f)), iconImages: ex.iconImages() };
    },
    locScopes: (type: string, name: string) =>
    {
        const e = entityOf(type, name);
        return e && stories ? stories.locScopes(e) : [];
    },
    eventBackgrounds: () => index?.eventBackgroundList() ?? [],
    // what an event portrait can be set to (moods, cameras, outfits)
    portraitOptions: () => index?.portraitOptions() ?? { animations: [], cameras: [], scripted: [], outfits: [] },
    // the names an event uses without saving them (the picker's "Pass along…")
    eventScopes: (name: string) =>
    {
        const e = entityOf('events', name);
        return e && stories ? stories.eventScopes(e) : [];
    },
    // the on_actions an event can be fired from ("When it happens…")
    onActions: (event?: string) => stories?.onActionList(event ? (entityOf('events', event) ?? undefined) : undefined) ?? [],
    // an event's current background and its environment (a new scene takes its lighting)
    eventBackground: (type: string, name: string) =>
    {
        const e = entityOf(type, name);
        return e && index ? index.eventBackground(e) : null;
    },
    // a localization key's text and where it is (editing an event's texts in place)
    locEntry: (key: string) => index?.locEntry(key) ?? null,
    // where a new entry of a type goes (mods/create.ts: the explorer's "New <type>…")
    newEntryInfo: (type: string, ns?: string) => index?.newEntryInfo(type, ns) ?? null,
    childrenOf: (type: string, holderType: string, holder: string) => index?.childrenOf(type, holderType, holder) ?? [],
    layouts: () => index?.layouts() ?? null,
    // every user of one type (a card's "Used by" row in full)
    usageAll: (type: string, name: string, userType: string) =>
    {
        const e = entityOf(type, name);
        return e && stories ? stories.usageAll(e, userType) : [];
    },
    // a script snippet in plain language (the statement picker's and the in-place editor's preview)
    // (`names`: the entries the picker is making, not in the index yet, read by the name given)
    describeScript: (text: string, kind: 'effect' | 'trigger' | 'modifier' | 'field', type?: string, names?: Record<string, string>) =>
    {
        if (!stories)
            return [];

        const nodes = parse(text);
        const d = stories.d;
        d.pendingNames = names && Object.keys(names).length ? names : undefined;

        try
        {
            if (kind === 'modifier')
                return d.statsOf(nodes);

            if (kind === 'field')
                return type === 'trait_opinion' ? stories.traitOpinionLines(nodes) : type === 'doctrine_parameters' ? stories.doctrineParamLines(nodes) : stories.fieldLines(type ?? '', nodes);

            return kind === 'trigger' ? d.triggers(nodes, rootCtx(text)) : d.effects(nodes, rootCtx(text));
        }
        finally
        {
            d.pendingNames = undefined;
        }
    },
    // lines a card left out for its size ("Show them here", Line.more)
    moreLines: (id: number) => stories?.d.moreLines(id) ?? null,
    // the picker's modifier menus: every stat modifier, most used first
    modifierKeys: () => stories?.modifierKeys() ?? [],
    fieldSuggestions: (source: string) => stories?.fieldSuggestions(source) ?? [],
    // the picker's "Other effect… / Other condition…" list (waits for the scan thread, never blocks this one)
    // (a key whose value names an entry: the type it names; "Other…" lists its entries)
    scriptKeys: (kind: 'effect' | 'trigger') =>
        scriptKeys().then((k) =>
            k[kind].map((x) =>
            {
                // (the value table first (what the game's own use says the key names), then the hand-written rules)
                const typed = (k: string): string | undefined => VALUE_TYPES.get(k)?.[0] ?? CONTEXT_RULES[k]?.[0];
                const t = typed(x.key) ?? CONTEXT_RULES[`${x.key}.id`]?.[0] ?? (isFlagKey(x.key) ? 'flag' : isVariableKey(x.key) ? 'variable' : undefined);
                // (a block's fields naming entries: `add_opinion.modifier` → opinion modifiers; the picker's block editor lists them)
                const refs = Object.fromEntries([...(x.fields ?? []).map(([f]) => f), ...Object.keys(x.fieldValues ?? {})].map((f) => [f, typed(`${x.key}.${f}`) ?? typed(f)] as const).filter((e): e is readonly [string, string] => !!e[1]));
                return t || Object.keys(refs).length ? { ...x, ...(t ? { refType: t } : {}), ...(Object.keys(refs).length ? { fieldRefs: refs } : {}) } : x;
            })
        ),
    story: (type: string, name: string) =>
    {
        const e = entityOf(type, name);

        if (!e || !stories)
            return null;

        return type === 'on_action' ? stories.onActionStory(e) : type === 'events' ? stories.eventStory(e) : null;
    },
    fileFolders: (type: string) => index?.fileFolders(type) ?? [],
    portrait: (type: string, name: string, opts?: PortraitRequest) =>
    {
        const e = entityOf(type, name);
        const p = portraitsFor(type);
        return e && p ? p.build(e, opts) : null;
    },
    dnaEditor: (type: string, name: string, date?: string) =>
    {
        const e = entityOf(type, name);
        const p = portraitsFor(type);
        return e && p ? p.dnaEditor(e, date) : null;
    },
    ethnicityGenes: (ethnicity: string, seed: string) => portraits?.genesFromEthnicity(ethnicity, seed) ?? [],
    portraitReport: (type: string, name: string, opts?: PortraitRequest) =>
    {
        const e = entityOf(type, name);
        const p = portraitsFor(type);
        return e && p ? p.report(e, opts) : null;
    },
    // a loaded save's character's DNA changed in the barbershop (docs/saves.md "Portraits"): the save's bytes made anew
    saveSetDna: (id: string, genes: DnaGene[], label: string) =>
    {
        const s = saveState;

        if (!s || !saveViews)
            throw new Error(tr('No save is loaded'));

        const now = s.session.dnaOf(Number(id));

        if (!now)
            throw new Error(tr('This character has no DNA in the save'));

        s.session.edit({ id: Number(id), field: 'dna', text: encodeDna(now, genes, saveViews.catalog()), label });
        s.stack.push({ rel: '', key: 'dna:' + id, before: '', after: '', n: 1, label });
        postStatus({ state: 'ready', stats: index!.stats, gameDir: readyGameDir, revision: ++revision, changedFiles: [] });
        return { pending: s.session.pending };
    },
    // (the game's files the index read against their disk versions: changed ones are posted by postStale after it)
    checkGameFiles: () => index?.checkGameFiles() ?? 0,
    filesIn: (type: string, folder: string) => index?.filesIn(type, folder) ?? [],
    modelFolder: (folder: string) => models?.folder(folder) ?? [],
    modelInfo: (path: string) => models?.info(path) ?? null,
    modelGeometry: (path: string, pdxmesh?: string) => models?.geometry(path, pdxmesh) ?? null,
    textureUsers: (path: string) => models?.textureUsers(path) ?? [],
    guiList: () => (vfs ? guiList(gui ??= new GuiLibrary(vfs)) : []),
    guiDetail: (kind: GuiKind, name: string) => (vfs && index ? guiDetail(gui ??= new GuiLibrary(vfs), index, kind, name) : null),
    guiLayout: (kind: GuiKind, name: string, hidden: number[], opts?: GuiLayoutOptions) => (vfs && index ? guiLayout(gui ??= new GuiLibrary(vfs), vfs, index, kind, name, hidden, opts) : null),
    // the Blender round trip (src/main/blender): the mesh file and each sub-mesh's material
    modelExportPlan: (path: string, pdxmesh?: string) => models?.exportPlan(path, pdxmesh) ?? null,
    shader: (req: ShaderRequest) =>
    {
        if (!shaders)
            throw new Error(tr('Index not ready'));

        return shaders.compile(req);
    },
    shaderPrograms: () => shaders?.list() ?? { programs: [], failures: [] },
    mapInfo: (dir: string, date?: string) => withMapData(dir, (md, meta) => md.info(meta, date)),
    mapStatic: (dir: string) => withMapData(dir, (md, meta) => md.static(meta)),
    mapHoldings: (dir: string, date?: string) => withMapData(dir, (md, meta) => md.holdings(meta, date)),
    mapDated: (dir: string, date?: string) => withMapData(dir, (md, meta) => md.dated(meta, date)),
    // a new bookmark's group: the one whose default start date is nearest the bookmark's (before it on a tie)
    bookmarkGroupFor: (date: string) =>
    {
        const idx = index;

        if (!idx)
            return null;

        const num = (d: string): number => d.split('.').reduce((a, x, i) => a + Number(x) * [10000, 100, 1][i], 0);
        let best: { key: string; d: number; } | null = null;

        for (const key of idx.names('bookmarks/groups'))
        {
            const e = idx.get('bookmarks/groups', key);
            const node = e && idx.defNode(e)?.node;
            const v = Array.isArray(node?.v) ? node.v.find((c) => c.k === 'default_start_date' && typeof c.v === 'string')?.v : undefined;

            if (typeof v !== 'string')
                continue;

            const d = Math.abs(num(v) - num(date)) - (num(v) <= num(date) ? 0.5 : 0);

            if (!best || d < best.d)
                best = { key, d };
        }

        return best?.key ?? null;
    },
    // a bookmark character filled from history at the bookmark's date (mods/create.ts `bookmark_character`)
    bookmarkFacts: (dir: string, id: string, date: string) => withMapData(dir, (md, meta) => md.bookmarkFacts(meta, id, date)),
    mapTerrain: (dir: string) => (vfs && mapData ? mapTerrain(vfs, mapData.mapFiles(), dir) : null),
    mapOverlays: (dir: string) => (vfs && mapData ? mapOverlays(vfs, mapData.mapFiles(), dir) : null),
    mapFog: () => (vfs && mapData ? mapFog(vfs) : null),
    // editing from the map (map/edit.ts): the holder chooser's characters, one character's facts at a date
    mapCharacters: (q: string, date: string) => (index && characters ? mapCharacters(index, characters, q, date) : []),
    mapHolderSuggestions: (seeds: [string, string][], date: string, others?: boolean) => (index && characters ? mapHolderSuggestions(index, characters, seeds, date, 40, others) : []),
    mapCharacter: (id: string, date: string) => (index && characters ? mapCharacter(index, characters, id, date) : undefined),
    // a new historical character (mods/create.ts `character`): a relative's basics, a name from a culture's name list
    characterBasis: (id: string) => (index ? characterBasis(index, id) : null),
    cultureName: (culture: string | undefined, female: boolean, seed: number) => (index ? cultureName(index, culture, female, seed) : undefined),
    coatOfArms: (kind: CoaKind, key: string, date?: string) => (index ? coatOfArms(index, kind, key, date) : null),
    textureData: async (path: string, maxSize?: number) =>
    {
        const t = await portraits?.lib.texture(path, maxSize ?? 0);
        return t ? { width: t.width, height: t.height, rgba: t.rgba } : null;
    },
    characterFilter: (filter: CharacterFilter) => characters?.filter(filter) ?? [],
    characterFacets: () => characters?.facets() ?? { cultures: [], faiths: [], religions: [], traits: [] },
    familyTree: (id: string, type?: string) => (type === T_SAVE_CHARACTER ? saveViews?.characters.familyTree(id) : characters?.familyTree(id)) ?? null,
    characterLifespans: (ids: string[]) => characters?.lifespans(ids) ?? [],
    searchCharacters: (q: string, limit?: number) => characters?.search(q, limit) ?? [],
    // the script database's facts for this worker's tables (the main process sends them before a build and after a new database)
    scriptFacts: (facts: ScriptFacts) =>
    {
        scriptFacts = facts;
        applyScriptFacts(facts);
    },
    tooltip: (type: string, name: string) =>
    {
        const e = entityOf(type, name);
        return e && stories ? stories.tooltip(e) : null;
    }
};

parentPort!.on('message', (req: Request) =>
{
    const h = handlers[req.method];
    // handlers may return promises (portraits decode BC7 palettes asynchronously)
    Promise.resolve()
        .then(() =>
        {
            if (!h)
                throw new Error(tr('Unknown method ') + req.method);

            return (h as (...a: unknown[]) => unknown)(...req.params);
        })
        .then((result) => parentPort!.postMessage({ id: req.id, result }))
        .catch((err) => parentPort!.postMessage({ id: req.id, error: String((err as Error)?.message ?? err) }))
        // (what the request read again may have been a game file changed on disk since the build)
        .finally(postStale);
});
