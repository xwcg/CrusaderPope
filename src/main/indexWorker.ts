/**
 * Worker thread that owns the GameIndex. The main process forwards renderer queries here so that
 * indexing (~10 s) and big queries never block the UI or the main process event loop.
 */
import { parentPort, Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { GameIndex, resolveGameDir, type RefreshResult } from './indexer/gameIndex.ts';
import { StoryBuilder } from './describe/stories.ts';
import { scannedPath } from './describe/scriptKeys.ts';
import { CONTEXT_RULES, isFlagKey, isVariableKey } from './indexer/schema.ts';
import { LocExamples } from './describe/locExamples.ts';
import { rootCtx } from './describe/describer.ts';
import { parse } from './indexer/parser.ts';
import { PortraitBuilder } from './portraits/portrait.ts';
import { History } from './portraits/modifiers.ts';
import { CharacterTable } from './history/characters.ts';
import { ModelBrowser } from './portraits/models.ts';
import { deleteShaderCache, fxFingerprint, ShaderStore } from './shaders/store.ts';
import { ShaderPool } from './shaders/pool.ts';
import { cacheParts, deleteIndexCache, readIndexCache } from './indexer/cache.ts';
import { GameFiles } from './mods/gamefiles.ts';
import { MapData } from './map/mapData.ts';
import { RASTER_VERSION, readRasterMeta, type RasterMeta } from './map/raster.ts';
import { mapTerrain } from './map/terrain.ts';
import { mapOverlays } from './map/overlays.ts';
import { mapCharacter, mapCharacters } from './map/edit-characters.ts';
import { coatOfArms } from './coa/coa.ts';
import type { CharacterFilter, CoaKind, IndexStatus, ModInfo, PortraitRequest, ScriptKeys, ShaderRequest } from '../shared/api.ts';

/** Index cache (main process decides): file, version of the indexer code, on/off, `force` = parse even if valid. */
interface CacheOptions
{
    file: string;
    code: string;
    enabled: boolean;
    force?: boolean;
}

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

/** compiled shaders live next to the index cache */
const shaderCacheFile = (cache: CacheOptions): string => join(dirname(cache.file), 'shaders.json');

/** enabled mods of the current build (the script key scan layers the same files) */
let buildMods: ModInfo[] = [];
/** the effect / trigger keys of the loaded script (the picker's "Other…" list), once per build */
let scriptKeysJob: Promise<ScriptKeys> | null = null;

/**
 * The effect and trigger keys the loaded script uses: collected on a thread of its own (scriptKeysWorker.ts) on
 * first request, kept next to the index cache under the index fingerprint.
 */
function scriptKeys(): Promise<ScriptKeys>
{
    if (scriptKeysJob)
        return scriptKeysJob;

    if (!index || !vfs)
        return Promise.reject(new Error('Index not ready'));

    const seq = buildSeq;
    const cache = cacheState ? { file: join(dirname(cacheState.file), 'script-keys.json'), fingerprint: cacheState.fingerprint } : undefined;
    // (with an editable mod loaded the thread stays: incremental updates rescan the files they changed)
    const stays = buildMods.some((m) => m.editable && m.root);
    const job = new Promise<ScriptKeys>((resolve, reject) =>
    {
        const w = new Worker(join(__dirname, 'scriptKeysWorker.js'), { workerData: { gameDir: vfs!.gameDir, mods: buildMods, cache } });
        keysWaiting = [{ resolve, reject }];
        w.on('message', (m: { keys?: ScriptKeys; error?: string; }) =>
        {
            if (!stays)
                void w.terminate();

            const p = keysWaiting.shift();

            if (m.keys)
                p?.resolve(m.keys);
            else
                p?.reject(new Error(m.error ?? 'No script keys'));
        });
        w.once('error', (err) =>
        {
            for (const p of keysWaiting.splice(0))
                p.reject(err);

            if (keysWorker === w)
                keysWorker = null;
        });

        if (stays)
            keysWorker = w;
    });
    scriptKeysJob = job;
    // (a failed scan is tried again on the next request; a newer build starts over)
    job.catch(() =>
    {
        if (scriptKeysJob === job && seq === buildSeq)
            scriptKeysJob = null;
    });
    return job;
}

/** the scan thread kept for incremental updates (an editable mod loaded), and the requests waiting for its answers */
let keysWorker: Worker | null = null;
let keysWaiting: { resolve: (k: ScriptKeys) => void; reject: (e: unknown) => void; }[] = [];

/** Files an incremental update changed: the scan thread takes them in, the next request gets the keys with them. */
function rescanKeys(rels: string[]): void
{
    const w = keysWorker;

    if (!w || !scriptKeysJob || !rels.some(scannedPath))
        return;

    const seq = buildSeq;
    const job = new Promise<ScriptKeys>((resolve, reject) => keysWaiting.push({ resolve, reject }));
    w.postMessage({ rescan: rels });
    scriptKeysJob = job;
    job.catch(() =>
    {
        if (scriptKeysJob === job && seq === buildSeq)
            scriptKeysJob = null;
    });
}

/** The scan thread goes with its build. */
function dropKeysWorker(): void
{
    void keysWorker?.terminate();
    keysWorker = null;
    keysWaiting = [];
}
/** the current index's fingerprint and whether the cache file holds it */
let cacheState: { file: string; fingerprint: string; written: boolean; } | null = null;
/** one cache write at a time (they share the .tmp file) */
let cacheWrites: Promise<void> = Promise.resolve();

/**
 * Writes the index cache on a thread of its own (cacheWriter.ts): here only the snapshot — the state as built,
 * before queries create flag/variable entities on demand — and its parts (typed arrays transferred, strings joined).
 */
function saveCache(idx: GameIndex, file: string, fingerprint: string, state = idx.exportState()): void
{
    const cs = cacheState;
    const { parts, transfer } = cacheParts(state);
    const write = (): Promise<void> =>
        new Promise((resolve) =>
        {
            if (index !== idx || cacheState !== cs)
                return resolve();

            const w = new Worker(join(__dirname, 'cacheWriter.js'));
            w.once('message', (m: { ok?: boolean; }) =>
            {
                if (m.ok && cacheState === cs && cs)
                    cs.written = true;

                void w.terminate();
                resolve();
            });
            w.once('error', () =>
            {
                void w.terminate();
                resolve();
            });
            w.postMessage({ file, fingerprint, parts }, transfer);
        });
    setTimeout(() => (cacheWrites = cacheWrites.then(write)), 200);
}

/**
 * After incremental updates the cache file no longer matches the files (the next start would parse everything):
 * a while after the last update, the index is written again — remapped to the files as a fresh scan lists them,
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

        cacheState = { file: cache.file, fingerprint: snap.fingerprint, written: false };
        saveCache(idx, cache.file, snap.fingerprint, snap.state);
        // (the picker's keys, rescanned since: kept under the new fingerprint too)
        keysWorker?.postMessage({ cache: { file: join(dirname(cache.file), 'script-keys.json'), fingerprint: snap.fingerprint } });
    }, RECACHE_DELAY);
}
/** quiet time after the last update before the cache is written again (the export takes the worker ~1 s) */
const RECACHE_DELAY = 8000;

/** Build stages with their usual share of the time (full build ≈ 9 s; shaders ≈ 4 s on the compiler threads). */
const STAGE_WEIGHT: Record<string, number> = {
    'Scanning files': 3,
    'Checking the cached index': 2,
    'Loading the cached index': 20,
    'Reading localization': 10,
    'Parsing script': 55,
    'Resolving references': 20,
    'Resolving localization references': 5,
    'Compiling shaders': 25
};
const PARSE_STAGES = ['Reading localization', 'Parsing script', 'Resolving references', 'Resolving localization references'];

/**
 * Total progress over the planned stages: finished ones plus the running one's share. When the plan changes (a
 * cache turned out stale, the shaders need compiling after all) the bar keeps its position and spreads the rest over
 * the remaining work — it never goes backwards and never stalls on a wrong estimate.
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

function postStatus(s: IndexStatus): void
{
    parentPort!.postMessage({ status: s });
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
        return Promise.reject(new Error('Index not ready'));

    const files = mapData.mapFiles();
    const pf = vfs.get(files.provinces);
    const df = vfs.get(files.definitions);

    if (!pf || !df)
        return Promise.reject(new Error('The loaded game files have no map'));

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
                return reject(new Error('Cannot read the map files'));

            const worker = new Worker(join(__dirname, 'mapWorker.js'), { workerData: { png, csv, dir, key } });
            worker.once('message', (m: { meta?: RasterMeta; error?: string; }) =>
            {
                void worker.terminate();

                if (m.meta)
                    resolve(m.meta);
                else
                    reject(new Error(m.error ?? 'No province raster'));
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

/**
 * What is derived from the index — rebuilt after a build and after updates (all lazy: the work happens on use).
 * `lib`: the portrait asset library to keep (its mesh and texture caches) when no gfx file changed.
 */
function derive(idx: GameIndex, what: { lib?: PortraitBuilder['lib']; characters?: boolean; models?: boolean; } = {}): void
{
    stories = new StoryBuilder(idx);
    mapData = new MapData(idx);
    history = new History(idx);
    // (what a text code prints for the sample character: the example sentences of the faith cards' names in game)
    {
        const h = history;
        let lx: LocExamples | undefined;
        stories.locExample = (chain) => (lx ??= new LocExamples(idx, h)).examples([chain])[chain];
    }
    portraits = new PortraitBuilder(idx, history, what.lib);

    if (what.characters !== false || !characters)
        characters = new CharacterTable(idx, history);

    // meshes creatures show: their previews borrow the decal list of the first character showing them (the current builder)
    if (what.models !== false || !models)
        models = new ModelBrowser(idx, portraits.lib, (mesh) => portraits!.previewDecals(mesh));
}

/**
 * Compiler threads and the store of compiled shaders for the loaded files (a build; shader files of a loaded mod that
 * changed — docs/shaders.md): the programs of an earlier run with the same FX files come from the cache (`load`).
 * Replaces the running pool (its threads read the FX files as they were).
 */
function shaderStore(gameDir: string, mods: ModInfo[], cache: CacheOptions | undefined, files: GameFiles, load: boolean): ShaderStore
{
    pool?.terminate();
    const threads = new ShaderPool(join(__dirname, 'shaderWorker.js'), { gameDir, mods }, Math.max(1, Math.min(4, Math.floor(availableParallelism() / 3))));
    pool = threads;
    const store = new ShaderStore(
        (req) => threads.compile(req),
        cache?.enabled ? shaderCacheFile(cache) : null,
        fxFingerprint(files, (cache?.code ?? '') + threads.version),
        (req, message) => logShader('COMPILE', requestTitle(req), message)
    );

    if (load && cache?.enabled)
        store.load();

    return store;
}

/** @param mods enabled mods of the selected list, in load order (later wins) */
async function build(installDir: string, language: string, cache?: CacheOptions, mods: ModInfo[] = []): Promise<void>
{
    const seq = ++buildSeq;
    index = null;
    scriptKeysJob = null;
    dropKeysWorker();
    buildMods = mods;
    stories = null;
    portraits = null;
    characters = null;
    models = null;
    shaders = null;
    history = null;

    if (recacheTimer)
        clearTimeout(recacheTimer);

    recacheTimer = null;
    const gameDir = resolveGameDir(installDir);

    if (!gameDir)
    {
        postStatus({ state: 'error', message: `No Crusader Kings III game files found in "${installDir}". Expected a folder containing game/common.`, gameDir: installDir });
        return;
    }

    cacheState = null;
    pool?.terminate();
    pool = null;
    // total progress: the stages this build will probably run — corrected once the caches are checked
    const total = new TotalProgress();
    const useCache = !!cache?.enabled && !cache.force;
    const head = ['Scanning files', ...(cache?.enabled ? ['Checking the cached index'] : [])];
    total.plan([...head, ...(useCache && existsSync(cache!.file) ? ['Loading the cached index'] : PARSE_STAGES), 'Compiling shaders']);
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
        vfs = new GameFiles(gameDir, mods);
        const files = vfs;
        let idx = new GameIndex(files, language);
        idx.scan(progress);
        // the game's shaders: compiled on their own threads (each layers the same mods: a mod's gfx/FX files win); the
        // store (from the cache) says right away whether any need compiling, which sets the shader stage's share of the
        // total progress
        const store = shaderStore(gameDir, mods, cache, files, useCache);

        if (!useCache && cache && !cache.enabled)
            deleteShaderCache(shaderCacheFile(cache));

        const assets = idx.modelFiles().filter((m) => /\.asset$/i.test(m.rel));
        total.weigh('Compiling shaders', store.covers(assets, idx.vfs) ? 1 : STAGE_WEIGHT['Compiling shaders']);
        // dispatched now, compiled on the pool's threads while this thread parses or loads the index; the shader stage
        // at the end only waits for what is left
        let shaderStage = false;
        let compiled = { done: 0, n: 0 };
        const shadersDone = store.precompile(assets, idx.vfs, {
            planned: (missing) => missing || total.weigh('Compiling shaders', 1),
            progress: (done, n) =>
            {
                compiled = { done, n };

                if (shaderStage)
                    progress({ phase: 'Compiling shaders', done, total: n });
            },
            alive: () => seq === buildSeq
        });
        // the cache: valid while every indexed file, the gfx listing, language and the indexer code are unchanged
        let fingerprint = '';
        let loaded = false;

        if (cache?.enabled)
        {
            progress({ phase: 'Checking the cached index', done: 0, total: 1 });
            fingerprint = idx.fingerprint(cache.code);

            if (!cache.force && existsSync(cache.file))
                progress({ phase: 'Loading the cached index', done: 0, total: 100 });

            const state = cache.force ? null : readIndexCache(cache.file, fingerprint);

            if (state)
            {
                progress({ phase: 'Loading the cached index', done: 30, total: 100 });

                try
                {
                    idx.importState(state, progress);
                    loaded = true;
                }
                catch
                {
                    idx = new GameIndex(files, language);
                    idx.scan(progress);
                }
            }
        }
        else if (cache?.file)
            deleteIndexCache(cache.file);

        if (!loaded)
        {
            total.plan([...head, ...PARSE_STAGES, 'Compiling shaders']);
            idx.parseAll(progress);
        }

        if (seq !== buildSeq)
            return;

        index = idx;

        if (cache?.enabled)
        {
            cacheState = { file: cache.file, fingerprint, written: loaded };

            if (!loaded)
                saveCache(idx, cache.file, fingerprint);
        }

        derive(idx);
        readyGameDir = gameDir;
        readyCache = cache;
        // every Effect the .asset files name — compiled meanwhile on the shader threads (or already in the store)
        shaderStage = true;
        progress({ phase: 'Compiling shaders', done: compiled.done, total: Math.max(1, compiled.n) });
        await shadersDone;

        if (seq !== buildSeq)
            return;

        // every failure the store knows — also the ones loaded from the cache — so each session's log is complete
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
        postStatus({ state: 'ready', stats: idx.stats, gameDir, revision: ++revision });
    }
    catch (err)
    {
        postStatus({ state: 'error', message: String((err as Error)?.stack ?? err), gameDir });
    }
}

const handlers: Record<string, (...args: never[]) => unknown> = {
    build: (installDir: string, language: string, cache?: CacheOptions, mods?: ModInfo[]) => build(installDir, language, cache, mods),
    // the setting changed: write the current index now, or remove the file
    setCache: (cache: CacheOptions) =>
    {
        readyCache = cache;
        shaders?.setFile(cache.enabled ? shaderCacheFile(cache) : null);

        if (!cache.enabled)
        {
            cacheState = null;
            deleteIndexCache(cache.file);
            deleteShaderCache(shaderCacheFile(cache));
            return;
        }

        if (!index || cacheState?.written)
            return;

        if (index.refreshed)
        {
            // (updated since the build: the files as a fresh scan lists them; unknown versions are the current ones)
            const snap = index.cacheSnapshot(cache.code, true);

            if (!snap)
                return;

            cacheState = { file: cache.file, fingerprint: snap.fingerprint, written: false };
            saveCache(index, cache.file, snap.fingerprint, snap.state);
            return;
        }

        cacheState = { file: cache.file, fingerprint: index.fingerprint(cache.code), written: false };
        saveCache(index, cache.file, cacheState.fingerprint);
    },
    // files of loaded mod folders changed — written by the app or seen by a folder watcher (docs/indexer.md,
    // "Incremental updates"): taken in without a build — many files in several updates, queries answered in between;
    // `fallback` says when a full build is needed (or faster)
    refreshFiles: async (paths: string[]): Promise<RefreshResult> =>
    {
        const idx = index;

        if (!idx || !stories)
            return { changed: false, files: [], gfx: [], parsed: 0, resolved: 0, ms: 0, fallback: 'the index is not ready' };

        const all: RefreshResult = { changed: false, files: [], gfx: [], parsed: 0, resolved: 0, ms: 0 };
        let next: string[] | undefined = paths;
        const rederive = (): void =>
            derive(idx, {
                // (a new asset library forgets the meshes and textures read so far: only when a gfx file changed)
                lib: all.gfx.length ? undefined : portraits?.lib,
                characters: all.files.some((f) => /^(history|localization)\//i.test(f) || /^common\/(dynast|religion|culture|traits)/i.test(f)),
                models: all.gfx.length > 0
            });

        while (next)
        {
            const r = idx.refreshFiles(next);
            all.changed ||= r.changed;
            all.files.push(...r.files);
            all.gfx.push(...r.gfx);
            all.parsed += r.parsed;
            all.resolved += r.resolved;
            all.ms += r.ms;

            if (r.shaders?.length)
            {
                (all.shaders ??= []).push(...r.shaders);
                // (compiled again on demand — the next build precompiles them)
                shaders = shaderStore(readyGameDir, buildMods, readyCache, idx.vfs, true);
            }

            if (r.fallback)
            {
                all.fallback = r.fallback;
                break;
            }

            next = r.rest;

            // (the next part after the queries that came in meanwhile — answered from what is derived from the index
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

        if (!all.changed && !all.shaders)
            return all;

        if (all.changed)
        {
            rederive();
            // (the picker's "Other…" keys: the changed files scanned again — before the views ask for them)
            rescanKeys(all.files);
            scheduleRecache(readyCache);
        }

        postStatus({ state: 'ready', stats: idx.stats, gameDir: readyGameDir, revision: ++revision, changedFiles: all.files.slice(0, 500) });
        return all;
    },
    // loaded mods renamed in their descriptors (main checked that the layering is the same): no build — the views reload
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
    types: () => index?.types() ?? [],
    typeDoc: (type: string) => index?.typeDoc(type) ?? [],
    list: (type: string) => index?.list(type) ?? [],
    search: (q: string, opts?: { limit?: number; types?: string[]; text?: boolean; modOnly?: boolean; noRemoved?: boolean; }) => index?.search(q, opts) ?? [],
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
    // (with what the common ones print for William of Normandy in 1066 — the picker shows it)
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
    // every user of one type (a card's "Used by" row in full)
    usageAll: (type: string, name: string, userType: string) =>
    {
        const e = entityOf(type, name);
        return e && stories ? stories.usageAll(e, userType) : [];
    },
    // a script snippet in plain language (the statement picker's and the in-place editor's preview)
    describeScript: (text: string, kind: 'effect' | 'trigger' | 'modifier' | 'field', type?: string) =>
    {
        if (!stories)
            return [];

        const nodes = parse(text);

        if (kind === 'modifier')
            return stories.d.statsOf(nodes);

        if (kind === 'field')
            return type === 'trait_opinion' ? stories.traitOpinionLines(nodes) : type === 'doctrine_parameters' ? stories.doctrineParamLines(nodes) : stories.fieldLines(type ?? '', nodes);

        return kind === 'trigger' ? stories.d.triggers(nodes, rootCtx(text)) : stories.d.effects(nodes, rootCtx(text));
    },
    // the picker's modifier menus: every stat modifier, most used first
    modifierKeys: () => stories?.modifierKeys() ?? [],
    fieldSuggestions: (source: string) => stories?.fieldSuggestions(source) ?? [],
    // the picker's "Other effect… / Other condition…" list (waits for the scan thread, never blocks this one)
    // (a key whose value names an entry: the type it names — "Other…" lists its entries)
    scriptKeys: (kind: 'effect' | 'trigger') =>
        scriptKeys().then((k) =>
            k[kind].map((x) =>
            {
                const t = CONTEXT_RULES[x.key]?.[0] ?? CONTEXT_RULES[`${x.key}.id`]?.[0] ?? (isFlagKey(x.key) ? 'flag' : isVariableKey(x.key) ? 'variable' : undefined);
                // (a block's fields naming entries: `add_opinion.modifier` → opinion modifiers — the picker's block editor lists them)
                const refs = Object.fromEntries([...(x.fields ?? []).map(([f]) => f), ...Object.keys(x.fieldValues ?? {})].map((f) => [f, CONTEXT_RULES[`${x.key}.${f}`]?.[0] ?? CONTEXT_RULES[f]?.[0]] as const).filter((e): e is readonly [string, string] => !!e[1]));
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
        return e && portraits ? portraits.build(e, opts) : null;
    },
    portraitReport: (type: string, name: string, opts?: PortraitRequest) =>
    {
        const e = entityOf(type, name);
        return e && portraits ? portraits.report(e, opts) : null;
    },
    filesIn: (type: string, folder: string) => index?.filesIn(type, folder) ?? [],
    modelFolder: (folder: string) => models?.folder(folder) ?? [],
    modelInfo: (path: string) => models?.info(path) ?? null,
    modelGeometry: (path: string, pdxmesh?: string) => models?.geometry(path, pdxmesh) ?? null,
    textureUsers: (path: string) => models?.textureUsers(path) ?? [],
    // the Blender round trip (src/main/blender): the mesh file and each sub-mesh's material
    modelExportPlan: (path: string, pdxmesh?: string) => models?.exportPlan(path, pdxmesh) ?? null,
    shader: (req: ShaderRequest) =>
    {
        if (!shaders)
            throw new Error('Index not ready');

        return shaders.compile(req);
    },
    shaderPrograms: () => shaders?.list() ?? { programs: [], failures: [] },
    mapInfo: async (dir: string, date?: string) =>
    {
        const meta = await mapRaster(dir);
        return mapData ? mapData.info(meta, date) : null;
    },
    mapStatic: async (dir: string) =>
    {
        const meta = await mapRaster(dir);
        return mapData ? mapData.static(meta) : null;
    },
    mapDated: async (dir: string, date?: string) =>
    {
        const meta = await mapRaster(dir);
        return mapData ? mapData.dated(meta, date) : null;
    },
    mapTerrain: (dir: string) => (vfs && mapData ? mapTerrain(vfs, mapData.mapFiles(), dir) : null),
    mapOverlays: (dir: string) => (vfs && mapData ? mapOverlays(vfs, mapData.mapFiles(), dir) : null),
    // editing from the map (map/edit.ts): the holder chooser's characters, one character's facts at a date
    mapCharacters: (q: string, date: string) => (index && characters ? mapCharacters(index, characters, q, date) : []),
    mapCharacter: (id: string, date: string) => (index && characters ? mapCharacter(index, characters, id, date) : undefined),
    coatOfArms: (kind: CoaKind, key: string, date?: string) => (index ? coatOfArms(index, kind, key, date) : null),
    textureData: async (path: string, maxSize?: number) =>
    {
        const t = await portraits?.lib.texture(path, maxSize ?? 0);
        return t ? { width: t.width, height: t.height, rgba: t.rgba } : null;
    },
    characterFilter: (filter: CharacterFilter) => characters?.filter(filter) ?? [],
    characterFacets: () => characters?.facets() ?? { cultures: [], faiths: [], religions: [], traits: [] },
    familyTree: (id: string) => characters?.familyTree(id) ?? null,
    searchCharacters: (q: string, limit?: number) => characters?.search(q, limit) ?? [],
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
                throw new Error('Unknown method ' + req.method);

            return (h as (...a: unknown[]) => unknown)(...req.params);
        })
        .then((result) => parentPort!.postMessage({ id: req.id, result }))
        .catch((err) => parentPort!.postMessage({ id: req.id, error: String((err as Error)?.message ?? err) }));
});
