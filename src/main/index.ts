import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { Worker } from 'node:worker_threads';
import { appendFileSync, copyFileSync, existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
import type { IndexStatus, ModChange, ModInfo, Settings, ShaderLogEntry } from '../shared/api.ts';
import { handleImageProtocol, initImages, refreshImages, registerImageScheme } from './imageService.ts';
import { onWorkerGone } from './workerGuard.ts';
import type { RefreshResult } from './indexer/gameIndex.ts';
import { captureWebglConsole, initShaderLog, logShader } from './shaderLog.ts';
import { checkForUpdate } from './updates.ts';
import { browsed } from './findNear.ts';
import { drives, listDirs, makeFolder, nearestExisting } from './folders.ts';
import { loadedModsKey, modsOfList, readModsState, writeAtomic, type ModsHost } from './mods/manager.ts';
import { formatScript, isScriptFile } from '../shared/scriptFormat.ts';
import { registerModsIpc } from './mods/ipc.ts';
import { MigrationThread } from './mods/migrationThread.ts';
import { registerSavesIpc } from './saves/ipc.ts';
import { defaultUserDir } from './mods/discover.ts';
import { registerBlenderIpc, testDialog } from './blender/ipc.ts';
import { ModWatcher } from './mods/watch.ts';
import { PendingChange } from '../shared/gameChange.ts';
import { cleanExtracted, extractEntry, splitZipPath } from './mods/zipEntry.ts';
import { resolveGameDir } from './gameDir.ts';
import { findInstalls, findUserDirs } from './detect.ts';
import { locale, tr } from '../shared/i18n.ts';
import { CATALOGS } from '../shared/locales/index.ts';
import { indexCachesKept } from '../shared/indexCaches.ts';
import { indexCacheDiskUse } from './indexer/cache.ts';
import { currentScriptFacts, onScriptFacts, openScriptDb, scriptDbEntry, scriptDbLabels, scriptDbSearch, scriptDbStatus, updateScriptDb } from './scriptDbService.ts';
import type { DbKind } from './scriptDb.ts';

// test runs (scripts/drive.mjs) can keep their own settings and caches
if (process.env.CRUSADERPOPE_USER_DATA)
    app.setPath('userData', process.env.CRUSADERPOPE_USER_DATA);

// `npm run dev`: a remote-debugging port the test driver attaches to (scripts/drive.mjs ATTACH=9333);
// CRUSADERPOPE_DEBUG_PORT sets another one, 0 none; built apps open none unless it is set
const debugPort = process.env.CRUSADERPOPE_DEBUG_PORT ?? (process.env['ELECTRON_RENDERER_URL'] ? '9333' : '0');

if (debugPort !== '0')
    app.commandLine.appendSwitch('remote-debugging-port', debugPort);

registerImageScheme();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json');
const mapCacheDir = (): string => join(app.getPath('userData'), 'map-cache');

function loadSettings(): Settings
{
    const defaults: Settings = { gameDir: '', language: 'english' };

    try
    {
        // (settings written before the first-run wizard existed: set up already)
        return { ...defaults, setupDone: true, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) };
    }
    catch (e)
    {
        // a file that exists but cannot be read (damaged, locked): kept as settings.json.bad before the first-run
        // wizard's save replaces it; the folders and lists in it can be fetched back by hand
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        {
            try
            {
                copyFileSync(settingsPath(), settingsPath() + '.bad');
            }
            catch
            {
                // (gone, or not readable at all)
            }

            console.warn('settings.json could not be read, kept as settings.json.bad:', (e as Error).message);
        }

        // first run: the wizard confirms the folders found (detect.ts) before anything is indexed
        return { ...defaults, gameDir: findInstalls(app.getPath('home'))[0] ?? '', setupDone: false };
    }
}

/** Written through a temporary file (a kill or a full disk never leaves half a file, which loadSettings would take for a first run). */
function saveSettings(s: Settings): void
{
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeAtomic(settingsPath(), JSON.stringify(s, null, 2));
}

/** The new settings are in force once they are on disk: a write that fails leaves the old ones (and throws). */
function commitSettings(next: Settings): void
{
    try
    {
        saveSettings(next);
    }
    catch (e)
    {
        throw new Error(tr('The settings could not be saved: ') + (e as Error).message);
    }

    settings = next;
}

let settings: Settings;

const sendAll = (channel: string, value: unknown): void =>
{
    for (const w of BrowserWindow.getAllWindows())
        w.webContents.send(channel, value);
};

/**
 * The top bar's "Re-index" notice: the loaded mods' change (modWatcher) and the game's files the index found changed
 * on disk while the app runs (the worker's `{stale}`); gone when a build starts.
 */
const pendingChange = new PendingChange((change) => sendAll('mods:changed', change));

/**
 * The folders of the loaded mods (docs/mods.md, "Watching the loaded mods"): changed files are taken in by the index
 * incrementally; what needs a full build shows as the pending change. Only the active mod's saves are formatted.
 */
const modWatcher = new ModWatcher(
    (change: ModChange | null) => pendingChange.setMods(change),
    (files, mod) =>
    {
        if (mod.active)
            formatSaved(files);

        void queueRefresh(files, false);
    }
);

/**
 * The size and times of the active mod's files as formatSaved last saw them: Windows reports a file that was only read
 * (its last-access time changes: the index build reads every file), and the watcher hands the index's script files on
 * as they come (the index compares its own versions), which is no save.
 */
const savedStats = new Map<string, string>();

/** The active mod's folder and since when it is watched: formatSaved leaves files written before as they are. */
let activeWatched = { root: '', since: 0 };

/**
 * Script files of the active mod saved in another editor: formatted like the app's own writes (settings.formatScripts,
 * shared/scriptFormat.ts), rewritten only when that changes them; the watcher takes the rewrite as the app's own.
 * (Not other mods' files: the user edits only the active mod with the app; the others are as their authors wrote them.)
 * Only saves: a file whose size and times are as seen before, or (seen the first time) last written before its folder
 * was watched, was only read (a file copied in keeps its old times on Windows: formatted at its next change).
 */
function formatSaved(files: string[]): void
{
    if (settings.formatScripts === false)
        return;

    const sig = (st: { size: number; mtimeMs: number; ctimeMs: number; }): string => `${st.size}|${st.mtimeMs}|${st.ctimeMs}`;

    for (const file of files)
    {
        if (!isScriptFile(file))
            continue;

        try
        {
            const st = statSync(file);

            if (!st.isFile())
                continue;

            const key = file.toLowerCase();
            const last = savedStats.get(key);
            savedStats.set(key, sig(st));

            if (last === sig(st) || (last === undefined && Math.max(st.mtimeMs, st.ctimeMs) < activeWatched.since))
                continue;

            const raw = readFileSync(file, 'utf8');
            const bom = raw.startsWith('﻿');
            const body = bom ? raw.slice(1) : raw;
            const out = formatScript(body);

            if (out === body)
                continue;

            modWatcher.ignore([file, file + '.crusaderpope-tmp']);
            writeAtomic(file, (bom ? '﻿' : '') + out);
            savedStats.set(key, sig(statSync(file)));
        }
        catch
        {
            // (gone, a folder, being written: the index takes it as it is)
        }
    }
}

/**
 * Watches the folders of the loaded list's mods (unpacked ones; a zip is not watched: the index cache's fingerprint
 * notices a changed one at the next start), the active one among them; called after every change of the list, the
 * active mod or the user folder, and by every rebuild.
 */
async function updateModWatch(): Promise<void>
{
    try
    {
        const state = await readModsState(settings, resolveGameDir(settings.gameDir), app.getPath('documents'));
        const active = state.activeMod?.toLowerCase();
        const mods = modsOfList(state, state.selected)
            .filter((m) => (m.root || m.archive) && m.status === 'ok')
            // (a zipped mod: the zip file, ModWatcher watches it through its folder)
            .map((m) => ({ id: m.id, name: m.name, root: (m.root ?? m.archive)!, archive: !m.root, active: m.editable && m.id.toLowerCase() === active, workshop: m.source === 'steam', descriptor: m.descriptorFile }));
        const root = mods.find((m) => m.active && !m.archive)?.root ?? '';

        // (another active folder: its files are seen afresh, formatSaved)
        if (root.toLowerCase() !== activeWatched.root.toLowerCase())
            activeWatched = { root, since: Date.now() };

        modWatcher.watch(mods);
    }
    catch
    {
        modWatcher.watch([]);
    }
}

/** The mod manager's view of the settings and the index (src/main/mods/manager.ts); main keeps owning both. */
const modsHost: ModsHost = {
    settings: () => settings,
    updateSettings: (patch) =>
    {
        commitSettings({ ...settings, ...patch });
        // (another active mod or list: another folder to watch)
        void updateModWatch();
    },
    gameDir: () => resolveGameDir(settings.gameDir),
    documents: () => app.getPath('documents'),
    reindex: () => rebuild(),
    query: (method, ...params) => call(method, ...params),
    wrote: (files) => modWatcher.ignore(files),
    // incrementally; a change only a build can take in re-indexes (through the cache check)
    refreshFiles: (files) => queueRefresh(files, true),
    // (a failed index too: the queries that follow fail with its error instead of waiting for a build nobody started)
    ready: () => (status.state === 'ready' || status.state === 'error' ? Promise.resolve() : new Promise<void>((resolve) => readyWaiters.push(resolve))),
    trash: (path) => shell.trashItem(path),
    dataDir: () => app.getPath('userData')
};

// ---------------------------------------------------------------------------
// Index worker
// ---------------------------------------------------------------------------

let worker: Worker;
/** Why the worker ended (it crashed or ran out of memory): set while the worker is dead, until "Re-index now" starts a new one. */
let workerEnded: string | undefined;
let status: IndexStatus = { state: 'idle' };
let reqId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; }>();

/**
 * The worker is over: everything asked of it fails with the reason (nothing hangs), whoever waited for a finished
 * index goes on, and the status shows the error. Nothing restarts by itself (a crash on the same input would repeat):
 * rebuild() starts a new worker.
 */
function workerGone(message: string): void
{
    workerEnded = message;
    status = { state: 'error', message };

    for (const w of BrowserWindow.getAllWindows())
        w.webContents.send('index:status', status);

    const error = new Error(message);

    for (const p of pending.values())
        p.reject(error);

    pending.clear();

    for (const f of readyWaiters.splice(0))
        f();

    releaseRefreshQueue();
}

function startWorker(): void
{
    // (a young generation of 192 MB, semi-spaces of 64 MB instead of 16: the migration's passes (libraries, interface, the
    // index's updates) make short-lived texts and parse trees; scavenges 400 -> 120 and GC about half on a parse pass, round 12)
    const w = new Worker(join(__dirname, 'indexWorker.js'), {
        resourceLimits: { maxOldGenerationSizeMb: 6144, maxYoungGenerationSizeMb: 192 }
    });
    worker = w;
    workerEnded = undefined;
    // (the script database's facts first, so the worker's tables have them before any build; docs/script-database.md)
    const facts = currentScriptFacts();

    if (facts)
        void call('scriptFacts', facts).catch(() =>
        {});

    onWorkerGone(w, (error, exitCode) =>
    {
        // (an older worker's end is no news)
        if (w === worker)
            workerGone(error ? tr('Index worker crashed: ') + error.message : tr('Index worker stopped (exit code {code}).', { code: exitCode }));
    });
    w.on('message', (msg: { id?: number; result?: unknown; error?: string; status?: IndexStatus; log?: ShaderLogEntry; stale?: string[]; }) =>
    {
        if (msg.log)
        {
            logShader(msg.log);
            return;
        }

        // (game files changed on disk since the build, as the worker lists them now: the "Re-index" notice)
        if (msg.stale)
        {
            if (w === worker)
                pendingChange.setGame(msg.stale);

            return;
        }

        if (msg.status)
        {
            status = msg.status;

            for (const w of BrowserWindow.getAllWindows())
                w.webContents.send('index:status', status);

            if (status.state === 'ready' || status.state === 'error')
            {
                for (const f of readyWaiters.splice(0))
                    f();
            }

            if (status.state === 'error')
                releaseRefreshQueue();

            // (files changed while it was building)
            if (status.state === 'ready')
                void flushRefresh();

            return;
        }

        const p = pending.get(msg.id!);

        if (!p)
            return;

        pending.delete(msg.id!);

        if (msg.error)
            p.reject(new Error(msg.error));
        else
            p.resolve(msg.result);
    });
}

/** hash of the code deciding what the cached index holds (electron.vite.config.ts `indexCodeHash`) */
declare const __INDEX_CODE__: string;

/**
 * The index cache for the worker: one file per mod list's layering in `index-cache/` (`file` names the folder; a new
 * fingerprint of the same layering overwrites its file; the least recently used beyond `keep` go), keyed to the
 * indexer's code (GameIndex, the cache format and what they import), so an indexer change invalidates it and other
 * changes keep it.
 */
function cacheOptions(force = false): { file: string; code: string; enabled: boolean; force: boolean; keep: number; }
{
    // (and to the app's language with its catalog: texts the indexer writes are in it, docs/localization.md)
    const lang = locale();
    const codeVersion = `${__INDEX_CODE__}|${app.getVersion()}|${lang}:${createHash('sha1').update(JSON.stringify(CATALOGS[lang] ?? {})).digest('hex').slice(0, 12)}`;
    return { file: indexCacheAnchor(), code: codeVersion, enabled: settings.indexCache !== false, force, keep: indexCachesKept(settings.indexCachesKept) };
}

/** a file name in the index cache folder (the worker keeps each layering's index beside it, cacheFileFor) */
function indexCacheAnchor(): string
{
    return join(app.getPath('userData'), 'index-cache', 'index.bin');
}

function call<T>(method: string, ...params: unknown[]): Promise<T>
{
    return new Promise((resolve, reject) =>
    {
        // (a dead worker answers nothing: fail at once with what happened)
        if (workerEnded)
        {
            reject(new Error(workerEnded));
            return;
        }

        const id = ++reqId;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });

        try
        {
            worker.postMessage({ id, method, params });
        }
        catch (e)
        {
            // (parameters that cannot be sent)
            pending.delete(id);
            reject(e as Error);
        }
    });
}

/** least time between two checks of the game's files (checkGameFiles): about 0.45 s of stats for 16k files */
const GAME_CHECK_MS = 30_000;
let gameCheckAt = 0;

/**
 * When a window of the app gets the focus (back from Steam after an update): the index worker compares the game's
 * files it read with their disk versions (GameIndex.checkGameFiles); changed ones come back as its `{stale}`, the top
 * bar's "Re-index" notice. At most once in GAME_CHECK_MS, only with an index ready.
 */
function checkGameFiles(): void
{
    if (status.state !== 'ready' || workerEnded || Date.now() - gameCheckAt < GAME_CHECK_MS)
        return;

    gameCheckAt = Date.now();
    call('checkGameFiles').catch(() =>
    {});
}

/** `force`: parse the game folder even if the cached index is valid ("Re-index now"). */
function rebuild(force = false): void
{
    // (first run: nothing is indexed before the wizard is done)
    if (settings.setupDone === false)
        return;

    if (!settings.gameDir)
    {
        status = { state: 'error', message: tr('No Crusader Kings III folder configured. Open settings to choose it.') };

        for (const w of BrowserWindow.getAllWindows())
            w.webContents.send('index:status', status);

        for (const f of readyWaiters.splice(0))
            f();

        releaseRefreshQueue();
        return;
    }

    // (the script database of the game's version: opened again only when that changes the file)
    openScriptDb(settings.gameDir);

    // (a worker that crashed or ran out of memory: "Re-index now" starts a new one)
    if (workerEnded)
        startWorker();

    status = { state: 'indexing', phase: 'Starting', done: 0, total: 1 };
    // the build reads the loaded mods' and the game's files as they are now: their pending change is taken in (one
    // null for both sides: the watcher's own null that follows sends nothing more)
    pendingChange.clear();
    modWatcher.building();
    void loadedMods().then((mods) =>
    {
        builtMods = mods;
        // (a worker that ends meanwhile shows as the status)
        call('build', settings.gameDir, settings.language, cacheOptions(force), mods, settings.loadedSave, settings.parseThreads).catch(() =>
        {});
        initImages(settings.gameDir, settings.imageWorkers, mods);
    });
    void updateModWatch();
}

// ---------------------------------------------------------------------------
// Incremental index updates (docs/indexer.md, "Incremental updates")
// ---------------------------------------------------------------------------

/** Files of loaded mods waiting to be taken in; `app`: the app wrote some (a change only a build can take re-indexes). */
let refreshQueue = { files: new Set<string>(), app: false, waiters: [] as (() => void)[] };
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshing = false;
/** resolved by the next ready (or failed) index */
const readyWaiters: (() => void)[] = [];
/**
 * collects writes that come in a burst (an editor saving several files); not for the app's own writes: their caller
 * hands over all files of a change at once and waits for the index (a migration run, a fix after a fix: 60 ms each)
 */
const REFRESH_DEBOUNCE = 60;

/**
 * Changed files of loaded mod folders (absolute paths; a folder stands for everything in it) → the index updates
 * itself, one update at a time and never during a build (files changed meanwhile are taken in after it). Resolves once
 * the index has them, also when they needed a build: `fromApp` (the app's own writes) starts one; changes the folder
 * watchers saw show the "Active mod changed" notice (Re-index) instead. Descriptors (`.mod`) are compared, not indexed.
 */
function queueRefresh(files: string[], fromApp: boolean): Promise<void>
{
    // (a failed index or a dead worker takes nothing in: the next build reads the files as they are)
    if (status.state === 'error')
    {
        releaseRefreshQueue();
        return Promise.resolve();
    }

    // (no files and none queued: nothing to take in, resolved at once. Queued, its waiter would sit in an empty queue that
    // flushRefresh skips, until some later change's files flushed it; with files queued it waits for them like the rest)
    if (!files.length && !refreshQueue.files.size)
        return Promise.resolve();

    for (const f of files)
        refreshQueue.files.add(f);

    if (fromApp)
        refreshQueue.app = true;

    const done = new Promise<void>((resolve) => refreshQueue.waiters.push(resolve));

    if (refreshTimer)
        clearTimeout(refreshTimer);

    // (the app's own writes in the queue: taken in on the next turn of the event loop, with whatever came along by then)
    refreshTimer = setTimeout(() =>
    {
        refreshTimer = null;
        void flushRefresh();
    }, refreshQueue.app ? 0 : REFRESH_DEBOUNCE);
    return done;
}

/**
 * The index failed or its worker ended: nobody will flush the queue, so whoever waits for it goes on (the files are
 * read by the build that follows "Re-index now"). Without this the commands that write a file and then wait for the index never return.
 */
function releaseRefreshQueue(): void
{
    const batch = refreshQueue;
    refreshQueue = { files: new Set(), app: false, waiters: [] };

    if (refreshTimer)
    {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }

    for (const w of batch.waiters)
        w();
}

/** The mods the last build loaded (in load order): descriptor changes are compared with them. */
let builtMods: ModInfo[] = [];

/** What the index's layering depends on (manager.ts's re-index rule): the mods in order, where they are, what they replace. */
const layeringKey = (mods: ModInfo[]): string => JSON.stringify(mods.map((m) => [m.id, m.status, m.root ?? m.archive ?? '', m.replacePaths]));

/**
 * A loaded mod's descriptor changed (its descriptor.mod, or its outer descriptor in the user's mod folder): the same
 * layering → nothing to build (a new name goes to the index: chips, origins); another one (replace_path, location,
 * status) → why a build is needed.
 */
async function descriptorsChanged(): Promise<string | undefined>
{
    const now = await loadedMods();

    if (layeringKey(now) !== layeringKey(builtMods))
    {
        // (only replace paths changed, the same mods, order, status and locations: the index takes the new layering in
        // as an update; anything else, a full build)
        const placeKey = (mods: ModInfo[]): string => JSON.stringify(mods.map((m) => [m.id, m.status, m.root ?? m.archive ?? '']));

        if (placeKey(now) !== placeKey(builtMods))
            return tr('a descriptor changed what the game loads (a location, the mods)');

        const changes = now.filter((m, i) => JSON.stringify(m.replacePaths) !== JSON.stringify(builtMods[i].replacePaths)).map((m) => ({ id: m.id, replacePaths: m.replacePaths }));
        const r = await call<RefreshResult>('refreshFiles', [], changes);

        if (r.fallback)
            return r.fallback;

        // (the image workers keep the layering they were started with: new ones for the new replace paths)
        if (r.gfx.length)
            initImages(settings.gameDir, settings.imageWorkers, now);
    }

    const renamed = now.some((m, i) => m.name !== builtMods[i].name);
    builtMods = now;

    if (renamed)
        await call('renameMods', now.map((m) => ({ id: m.id, name: m.name })));

    return undefined;
}

async function flushRefresh(): Promise<void>
{
    if (status.state === 'error')
    {
        releaseRefreshQueue();
        return;
    }

    if (refreshing || refreshTimer || !refreshQueue.files.size || status.state !== 'ready')
        return;

    refreshing = true;
    const batch = refreshQueue;
    refreshQueue = { files: new Set(), app: false, waiters: [] };
    const files = [...batch.files];
    // descriptors (`.mod`: a mod folder's descriptor.mod, an outer descriptor) are not the index's files
    const descriptors = files.filter((f) => /\.mod$/i.test(f));
    const content = files.filter((f) => !/\.mod$/i.test(f));

    try
    {
        let fallback = descriptors.length ? await descriptorsChanged() : undefined;

        if (!fallback && content.length)
        {
            const r = await call<RefreshResult>('refreshFiles', content);

            // (images: the decoded copies of changed files go)
            if (r.gfx.length)
                refreshImages(r.gfx);

            fallback = r.fallback;
        }

        if (fallback)
        {
            if (batch.app)
            {
                const ready = new Promise<void>((resolve) => readyWaiters.push(resolve));
                rebuild(false);
                await ready;
            }
            else
                modWatcher.report(files);
        }
    }
    catch
    {
        // (the worker is gone: a crash shows as the index status)
    }
    finally
    {
        refreshing = false;

        for (const w of batch.waiters)
            w();

        void flushRefresh();
    }
}

/** The enabled mods of the selected mod list, in load order (none selected or unreadable: the game alone). */
async function loadedMods(): Promise<ModInfo[]>
{
    const ref = settings.modList ?? 'none';

    if (ref === 'none')
        return [];

    try
    {
        return modsOfList(await readModsState(settings, resolveGameDir(settings.gameDir), app.getPath('documents')), ref);
    }
    catch
    {
        return [];
    }
}

function availableLanguages(): string[]
{
    const g = existsSync(join(settings.gameDir, 'game', 'localization')) ? join(settings.gameDir, 'game') : settings.gameDir;

    try
    {
        return readdirSync(join(g, 'localization'), { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name !== 'jomini')
            .map((d) => d.name);
    }
    catch
    {
        return ['english'];
    }
}

// ---------------------------------------------------------------------------
// Opening files (the editor, the folder)
// ---------------------------------------------------------------------------

/** where files inside zipped mods are extracted to be opened (read-only copies) */
const zipCopies = (): string => join(app.getPath('temp'), 'crusaderpope-zip-entries');

/** A zip the renderer names: only the archive of a discovered (packed) mod is opened. */
async function knownArchive(archive: string): Promise<string>
{
    const state = await readModsState(settings, resolveGameDir(settings.gameDir), app.getPath('documents'));
    const want = resolve(archive).toLowerCase();
    const m = state.mods.find((x) => x.archive && resolve(x.archive).toLowerCase() === want);

    if (!m?.archive)
        throw new Error(tr('Not the zip of a known mod: ') + archive);

    return m.archive;
}

/** A path to open: a disk file as it is; `archive.zip › entry` (GameFiles.where) extracted as a read-only copy. */
async function openableFile(p: string): Promise<string>
{
    const zip = splitZipPath(p);
    return zip ? extractEntry(await knownArchive(zip.archive), zip.entry, zipCopies()) : p;
}

/**
 * Test runs (scripts/drive.mjs) set CRUSADERPOPE_OPEN_LOG to a file: opening and revealing files is logged there
 * (one JSON line each) instead of starting the editor or Explorer.
 */
function logExternal(op: 'open' | 'reveal', file: string, line?: number): boolean
{
    const log = process.env.CRUSADERPOPE_OPEN_LOG;

    if (!log)
        return false;

    appendFileSync(log, JSON.stringify({ op, file, line }) + '\n');
    return true;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void
{
    ipcMain.handle('settings:get', () => settings);
    ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) =>
    {
        const changed = (k: keyof Settings): boolean => k in patch && patch[k] !== settings[k];
        // (the first-run wizard done: the first build)
        const reindex = changed('gameDir') || changed('language') || (patch.setupDone === true && settings.setupDone === false);
        const workers = changed('imageWorkers');
        // (the count kept changed too: the worker prunes the folder to it)
        const cacheToggled = changed('indexCache') || changed('indexCachesKept');
        // another user folder or list can change the loaded mods
        const modSettings = changed('userDir') || changed('modList') || changed('activeMod');
        const modsBefore = !reindex && (changed('userDir') || changed('modList')) ? await loadedModsKey(modsHost) : undefined;
        commitSettings({ ...settings, ...patch });
        const modsChanged = modsBefore !== undefined && (await loadedModsKey(modsHost)) !== modsBefore;

        // a new worker count only restarts the image workers
        if (reindex || modsChanged)
            rebuild();
        else if (workers && settings.gameDir)
            void loadedMods().then((mods) => initImages(settings.gameDir, settings.imageWorkers, mods));

        // (a re-index applies the setting itself)
        if (!reindex && !modsChanged && cacheToggled)
            call('setCache', cacheOptions()).catch(() =>
            {});

        // (a re-index checks the watched folder itself)
        if (!reindex && !modsChanged && modSettings)
            void updateModWatch();

        return settings;
    });
    // (another app language: the app starts again; its texts are translated as its modules load, shared/i18n.ts)
    ipcMain.handle('app:restart', () =>
    {
        process.env.CRUSADERPOPE_LOCALE = settings.appLanguage ?? 'en';
        // (the new start would find the lock still held by this one)
        app.releaseSingleInstanceLock();
        app.relaunch();
        app.exit(0);
    });
    ipcMain.handle('settings:cpuCount', () => availableParallelism());
    // what the index caches take on disk (Settings, "Index caches kept")
    ipcMain.handle('settings:indexCacheDisk', () => indexCacheDiskUse(dirname(indexCacheAnchor())));
    // the first-run wizard: the folders found on this machine, and whether a chosen one is the right kind
    // (CRUSADERPOPE_DETECT=<json file> `{ installs, userDirs }`: what the first-run wizard is shown as found, for test runs)
    ipcMain.handle('settings:detect', () =>
        process.env.CRUSADERPOPE_DETECT ?
            { documents: app.getPath('documents'), ...JSON.parse(readFileSync(process.env.CRUSADERPOPE_DETECT, 'utf8')) } :
            { installs: findInstalls(app.getPath('home')), userDirs: findUserDirs(app.getPath('documents'), app.getPath('home')), documents: app.getPath('documents') });
    ipcMain.handle('settings:checkDir', (_e, kind: 'game' | 'user', dir: string) => (kind === 'game' ? !!resolveGameDir(dir) : existsSync(join(dir, 'mod')) || existsSync(join(dir, 'launcher-v2.sqlite')) || existsSync(join(dir, 'dlc_load.json'))));
    // the in-app folder picker (folders.ts; renderer FolderPicker.tsx): the native dialog freezes on huge folders and
    // network shares
    ipcMain.handle('folders:list', (_e, path: string) => listDirs(path));
    ipcMain.handle('folders:drives', () => drives());
    ipcMain.handle('folders:nearest', (_e, path: string) => nearestExisting(path));
    ipcMain.handle('folders:mkdir', (_e, parent: string, name: string) => makeFolder(parent, name));
    ipcMain.handle('folders:places', () =>
    {
        // folders the app uses: the settings' and the found installs and user folders
        const used = [settings.gameDir, settings.userDir, ...findInstalls(app.getPath('home')), ...findUserDirs(app.getPath('documents'), app.getPath('home'))].filter((p): p is string => !!p && existsSync(p));
        const shortcuts = (['documents', 'downloads', 'desktop', 'home'] as const).map((k) => ({ name: k[0].toUpperCase() + k.slice(1), path: app.getPath(k) }));
        return { used: [...new Map(used.map((p) => [p.toLowerCase(), p])).values()], shortcuts };
    });
    // the picker's "System dialog…" (test runs: CRUSADERPOPE_DIALOG_PATHS `folder` answers it)
    ipcMain.handle('folders:native', async (e, title: string, start?: string) =>
    {
        const test = testDialog('folder');

        if (test !== undefined)
            return test;

        const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, { title, defaultPath: start || undefined, properties: ['openDirectory'] });
        return r.canceled ? null : r.filePaths[0];
    });
    // a folder picked for the game or user folder: the right one near it (findNear.ts)
    ipcMain.handle('folders:near', (_e, kind: 'game' | 'user', path: string) => browsed(path, kind));
    ipcMain.handle('settings:languages', () => availableLanguages());
    ipcMain.handle('index:status', () => status);
    // the map: its province raster is built into the map cache folder (served as ck3://map/<key>.bin)
    ipcMain.handle('index:mapInfo', (_e, date?: string) => call('mapInfo', mapCacheDir(), date));
    // (the same in two parts: what stays at every date once, then what changes per date)
    ipcMain.handle('index:mapStatic', () => call('mapStatic', mapCacheDir()));
    ipcMain.handle('index:mapDated', (_e, date?: string) => call('mapDated', mapCacheDir(), date));
    ipcMain.handle('index:mapHoldings', (_e, date?: string) => call('mapHoldings', mapCacheDir(), date));
    ipcMain.handle('index:mapTerrain', () => call('mapTerrain', mapCacheDir()));
    ipcMain.handle('index:mapOverlays', () => call('mapOverlays', mapCacheDir()));
    ipcMain.handle('index:mapFog', () => call('mapFog'));
    ipcMain.handle('index:mapCharacters', (_e, q: string, date: string) => call('mapCharacters', q, date));
    ipcMain.handle('index:mapHolderSuggestions', (_e, seeds: [string, string][], date: string, others?: boolean) => call('mapHolderSuggestions', seeds, date, others));
    // "Re-index now" parses afresh; the active mod's change notice re-indexes through the cache check (unchanged files load)
    ipcMain.handle('index:rebuild', (_e, force?: boolean) => rebuild(force !== false));

    for (
        const m of [
            'types',
            'typeDoc',
            'list',
            'dlcGroups',
            'dlcFlags',
            'search',
            'detail',
            'graph',
            'card',
            'story',
            'tooltip',
            'usageAll',
            'locEntry',
            'locCodes',
            'locScopes',
            'eventBackgrounds',
            'childrenOf',
            'onActions',
            'portraitOptions',
            'eventScopes',
            'describeScript',
            'moreLines',
            'scriptKeys',
            'modifierKeys',
            'fieldSuggestions',
            'fileFolders',
            'filesIn',
            'modelFolder',
            'modelInfo',
            'modelGeometry',
            'textureUsers',
            'guiList',
            'guiDetail',
            'guiLayout',
            'shader',
            'textureData',
            'shaderPrograms',
            'portrait',
            'portraitReport',
            'dnaEditor',
            'ethnicityGenes',
            'characterFilter',
            'characterFacets',
            'familyTree',
            'characterLifespans',
            'searchCharacters',
            'coatOfArms'
        ]
    )
    {
        ipcMain.handle('index:' + m, (_e, ...args: unknown[]) => call(m, ...args));
    }

    ipcMain.handle('mods:changeState', () => pendingChange.current);
    // the script database (docs/script-database.md): its facts for the window's tables, entries and explanations
    ipcMain.handle('scriptDb:facts', () => currentScriptFacts());
    ipcMain.handle('scriptDb:entry', (_e, kind: DbKind, key: string, variant?: string) => scriptDbEntry(kind, key, variant));
    ipcMain.handle('scriptDb:labels', (_e, kind: DbKind) => scriptDbLabels(kind));
    ipcMain.handle('scriptDb:search', (_e, text: string, kinds?: DbKind[], limit?: number) => scriptDbSearch(text, kinds, limit));
    ipcMain.handle('scriptDb:status', () => scriptDbStatus());
    // ("Check now" in Settings: also when checked today; the database is replaced and its facts sent out when there was a newer one)
    ipcMain.handle('scriptDb:checkUpdate', () => updateScriptDb(settings.gameDir, true));
    ipcMain.handle('shell:openFile', async (_e, absPath: string, line?: number) =>
    {
        // a file inside a zip: a read-only copy of it
        const file = await openableFile(absPath);

        if (logExternal('open', file, line))
            return;

        // Prefer VS Code (jumps to the line); fall back to the OS default app. (Each part of the path encoded: a `#`, `?`
        // or `%` in a folder name is no URL syntax; the drive's colon stays.)
        const path = file.replace(/\\/g, '/').split('/').map((part, i) => (i === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part))).join('/');
        const url = `vscode://file/${path}${line ? ':' + line : ''}`;

        try
        {
            await shell.openExternal(url);
        }
        catch
        {
            // (openPath answers with the error as text; empty when it worked)
            const error = await shell.openPath(file);

            if (error)
                throw new Error(tr('{file} could not be opened: {error}', { file, error }));
        }
    });
    ipcMain.handle('shell:revealFile', async (_e, absPath: string) =>
    {
        // a file inside a zip: the zip
        const zip = splitZipPath(absPath);
        const file = zip ? await knownArchive(zip.archive) : absPath;

        if (!logExternal('reveal', file))
            shell.showItemInFolder(file);
    });
    // the test API's start target (src/renderer/src/testApi.ts): CRUSADERPOPE_START=<target>
    ipcMain.handle('app:startTarget', () => process.env.CRUSADERPOPE_START || null);
    // the update check: once per start (a reload of the window asks again, the answer is kept), never when turned off
    let update: ReturnType<typeof checkForUpdate> | undefined;
    ipcMain.handle('app:updateInfo', async () =>
    {
        if (settings.updateCheck === false)
            return { current: app.getVersion(), update: null };

        update ??= checkForUpdate(app.getVersion());
        return { current: app.getVersion(), update: await update };
    });
    ipcMain.handle('log:shader', (_e, entry: ShaderLogEntry) => logShader(entry));
    // ("Fix for 1.20…" plans and runs in a worker of its own: the window stays responsive meanwhile, docs/mods.md "The migration worker")
    registerModsIpc(modsHost, new MigrationThread(join(__dirname, 'migrationWorker.js'), modsHost));
    registerBlenderIpc({ mods: modsHost, loadedMods, query: call, workerFile: join(__dirname, 'blenderWorker.js') });
    // (the save dialogs start in the user folder's `save games`: the setting's, else the detected one)
    registerSavesIpc({
        userDir: () => settings.userDir || defaultUserDir(app.getPath('documents')),
        loaded: () => settings.loadedSave,
        loadedSource: () => settings.loadedSaveSource,
        // (another save, or none: a build, since the save is a layer of the index)
        setLoaded: (file, source) =>
        {
            commitSettings({ ...settings, loadedSave: file ?? undefined, loadedSaveSource: source });
            rebuild();
        },
        query: (method, ...params) => call(method, ...params),
        dataDir: () => app.getPath('userData')
    });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/** Web links go to the browser; any other scheme (file:, vscode:, a program's handler …) is not started from a link. */
function openLink(url: string): void
{
    try
    {
        if (/^https?:$/.test(new URL(url).protocol))
            void shell.openExternal(url);
    }
    catch
    {
        // (no URL)
    }
}

/** Whether `url` is the app's own page (a reload, a route inside it): the dev server's origin, or the built page's file. */
function sameApp(current: string, url: string): boolean
{
    try
    {
        const a = new URL(current);
        const b = new URL(url);
        return a.protocol === 'file:' ? b.protocol === 'file:' && a.pathname === b.pathname : a.origin === b.origin;
    }
    catch
    {
        return false;
    }
}

function createWindow(): void
{
    // (test runs: CRUSADERPOPE_HIDDEN=1 keeps the window off screen (scripts/drive.mjs) and rendering at full speed)
    const hidden = process.env.CRUSADERPOPE_HIDDEN === '1';
    const win = new BrowserWindow({
        width: 1600,
        height: 980,
        minWidth: 1000,
        minHeight: 600,
        show: false,
        backgroundColor: '#15161a',
        title: 'CrusaderPope',
        autoHideMenuBar: true,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false,
            contextIsolation: true,
            backgroundThrottling: !hidden
        }
    });

    if (!hidden)
        win.once('ready-to-show', () => win.show());

    captureWebglConsole(win.webContents);
    win.webContents.setWindowOpenHandler(({ url }) =>
    {
        openLink(url);
        return { action: 'deny' };
    });
    // (the window stays the app: a link or a script cannot navigate it away; web links open in the browser)
    win.webContents.on('will-navigate', (e, url) =>
    {
        if (!sameApp(win.webContents.getURL(), url))
        {
            e.preventDefault();
            openLink(url);
        }
    });

    // (the app's language in the URL: the renderer's texts are translated as its modules load, shared/i18n.ts)
    const lang = locale();

    if (process.env['ELECTRON_RENDERER_URL'])
        void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?lang=${encodeURIComponent(lang)}`);
    else
        void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { lang } });
}

// One app per user data folder: two would write the same settings.json and index cache. (Test runs with their own
// folder, CRUSADERPOPE_USER_DATA, may run next to the real app.) A second start brings the first one forward.
const firstInstance = process.env.CRUSADERPOPE_USER_DATA ? true : app.requestSingleInstanceLock();

if (!firstInstance)
    app.quit();

app.on('second-instance', () =>
{
    const win = BrowserWindow.getAllWindows()[0];

    if (win)
    {
        if (win.isMinimized())
            win.restore();

        win.focus();
    }
});

app.whenReady().then(() =>
{
    if (!firstInstance)
        return;

    settings = loadSettings();
    initShaderLog();
    // (before the index worker starts: it gets the database's facts first)
    if (settings.gameDir)
        openScriptDb(settings.gameDir);

    // (a database opened later, a new game version: the worker's tables follow)
    onScriptFacts((f) =>
    {
        void call('scriptFacts', f).catch(() =>
        {});

        for (const w of BrowserWindow.getAllWindows())
            w.webContents.send('scriptDb:facts', f);
    });
    handleImageProtocol({ map: { dir: mapCacheDir, name: /^[0-9a-f]{16}(-[a-z0-9]+)?\.bin$/ } });
    startWorker();
    registerIpc();
    rebuild();
    createWindow();
    // (a newer script database from the release `script-db`: at most once a day, a while after the start; docs/script-database.md)
    if (settings.scriptDbUpdates !== false)
        setTimeout(() => void updateScriptDb(settings.gameDir).catch(() =>
        {}), 20_000);
    app.on('browser-window-focus', checkGameFiles);
    // read-only copies of zip entries opened in earlier sessions
    setTimeout(() => cleanExtracted(zipCopies()), 30_000);
    app.on('activate', () =>
    {
        if (BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});

app.on('window-all-closed', () =>
{
    if (process.platform !== 'darwin')
        app.quit();
});

app.on('will-quit', () => modWatcher.close());
