import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { Worker } from 'node:worker_threads';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import { createHash } from 'node:crypto';
import type { IndexStatus, ModChange, ModInfo, Settings, ShaderLogEntry } from '../shared/api.ts';
import { handleImageProtocol, imageInfo, initImages, refreshImages, registerImageScheme } from './imageService.ts';
import type { RefreshResult } from './indexer/gameIndex.ts';
import { captureWebglConsole, initShaderLog, logShader } from './shaderLog.ts';
import { loadedModsKey, modsOfList, readModsState, writeAtomic, type ModsHost } from './mods/manager.ts';
import { formatScript, isScriptFile } from '../shared/scriptFormat.ts';
import { registerModsIpc } from './mods/ipc.ts';
import { registerBlenderIpc } from './blender/ipc.ts';
import { ModWatcher } from './mods/watch.ts';
import { cleanExtracted, extractEntry, splitZipPath } from './mods/zipEntry.ts';
import { resolveGameDir } from './gameDir.ts';
import { findInstalls, findUserDirs } from './detect.ts';

// test runs (scripts/drive.mjs) can keep their own settings and caches
if (process.env.CRUSADERPOPE_USER_DATA)
    app.setPath('userData', process.env.CRUSADERPOPE_USER_DATA);

// `npm run dev`: a remote-debugging port the test driver attaches to (scripts/drive.mjs ATTACH=9333) —
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
    catch
    {
        // first run: the wizard confirms the folders found (detect.ts) before anything is indexed
        return { ...defaults, gameDir: findInstalls(app.getPath('home'))[0] ?? '', setupDone: false };
    }
}

function saveSettings(s: Settings): void
{
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

let settings: Settings;

const sendAll = (channel: string, value: unknown): void =>
{
    for (const w of BrowserWindow.getAllWindows())
        w.webContents.send(channel, value);
};

/**
 * The folders of the loaded mods (docs/mods.md, "Watching the loaded mods"): changed files are taken in by the index
 * incrementally; what needs a full build shows as the pending change. Only the active mod's saves are formatted.
 */
const modWatcher = new ModWatcher(
    (change: ModChange | null) => sendAll('mods:changed', change),
    (files, mod) =>
    {
        if (mod.active)
            formatSaved(files);

        void queueRefresh(files, false);
    }
);

/**
 * The size and times of the active mod's files as formatSaved last saw them: Windows reports a file that was only read
 * (its last-access time changes — the index build reads every file), and the watcher hands the index's script files on
 * as they come (the index compares its own versions), which is no save.
 */
const savedStats = new Map<string, string>();

/** The active mod's folder and since when it is watched: formatSaved leaves files written before as they are. */
let activeWatched = { root: '', since: 0 };

/**
 * Script files of the active mod saved in another editor: formatted like the app's own writes (settings.formatScripts,
 * shared/scriptFormat.ts) — rewritten only when that changes them; the watcher takes the rewrite as the app's own.
 * (Not other mods' files: the user edits only the active mod with the app — the others are as their authors wrote them.)
 * Only saves: a file whose size and times are as seen before, or — seen the first time — last written before its folder
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
 * Watches the folders of the loaded list's mods (unpacked ones — a zip is not watched: the index cache's fingerprint
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
            .filter((m) => m.root && m.status === 'ok')
            .map((m) => ({ id: m.id, name: m.name, root: m.root!, active: m.editable && m.id.toLowerCase() === active, workshop: m.source === 'steam', descriptor: m.descriptorFile }));
        const root = mods.find((m) => m.active)?.root ?? '';

        // (another active folder: its files are seen afresh — formatSaved)
        if (root.toLowerCase() !== activeWatched.root.toLowerCase())
            activeWatched = { root, since: Date.now() };

        modWatcher.watch(mods);
    }
    catch
    {
        modWatcher.watch([]);
    }
}

/** The mod manager's view of the settings and the index (src/main/mods/manager.ts) — main keeps owning both. */
const modsHost: ModsHost = {
    settings: () => settings,
    updateSettings: (patch) =>
    {
        settings = { ...settings, ...patch };
        saveSettings(settings);
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
    dataDir: () => app.getPath('userData')
};

// ---------------------------------------------------------------------------
// Index worker
// ---------------------------------------------------------------------------

let worker: Worker;
let status: IndexStatus = { state: 'idle' };
let reqId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; }>();

function startWorker(): void
{
    worker = new Worker(join(__dirname, 'indexWorker.js'), {
        resourceLimits: { maxOldGenerationSizeMb: 6144 }
    });
    worker.on('message', (msg: { id?: number; result?: unknown; error?: string; status?: IndexStatus; log?: ShaderLogEntry; }) =>
    {
        if (msg.log)
        {
            logShader(msg.log);
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
    worker.on('error', (err) =>
    {
        status = { state: 'error', message: 'Index worker crashed: ' + err.message };

        for (const w of BrowserWindow.getAllWindows())
            w.webContents.send('index:status', status);
    });
}

/** hash of the code deciding what the cached index holds (electron.vite.config.ts `indexCodeHash`) */
declare const __INDEX_CODE__: string;

/**
 * The index cache for the worker: one file (a new fingerprint overwrites it), keyed to the indexer's code — GameIndex,
 * the cache format and what they import — so an indexer change invalidates it and other changes keep it.
 */
function cacheOptions(force = false): { file: string; code: string; enabled: boolean; force: boolean; }
{
    const codeVersion = `${__INDEX_CODE__}|${app.getVersion()}`;
    return { file: join(app.getPath('userData'), 'index-cache', 'index.bin'), code: codeVersion, enabled: settings.indexCache !== false, force };
}

function call<T>(method: string, ...params: unknown[]): Promise<T>
{
    return new Promise((resolve, reject) =>
    {
        const id = ++reqId;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        worker.postMessage({ id, method, params });
    });
}

/** `force`: parse the game folder even if the cached index is valid ("Re-index now"). */
function rebuild(force = false): void
{
    // (first run: nothing is indexed before the wizard is done)
    if (settings.setupDone === false)
        return;

    if (!settings.gameDir)
    {
        status = { state: 'error', message: 'No Crusader Kings III folder configured. Open settings to choose it.' };

        for (const w of BrowserWindow.getAllWindows())
            w.webContents.send('index:status', status);

        for (const f of readyWaiters.splice(0))
            f();

        return;
    }

    status = { state: 'indexing', phase: 'Starting', done: 0, total: 1 };
    // the build reads the loaded mods' files as they are now: their pending change is taken in
    modWatcher.building();
    void loadedMods().then((mods) =>
    {
        builtMods = mods;
        void call('build', settings.gameDir, settings.language, cacheOptions(force), mods);
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
/** collects writes that come in a burst (an editor saving several files) */
const REFRESH_DEBOUNCE = 60;

/**
 * Changed files of loaded mod folders (absolute paths; a folder stands for everything in it) → the index updates
 * itself, one update at a time and never during a build (files changed meanwhile are taken in after it). Resolves once
 * the index has them — also when they needed a build: `fromApp` (the app's own writes) starts one; changes the folder
 * watchers saw show the "Active mod changed — Re-index" notice instead. Descriptors (`.mod`) are compared, not indexed.
 */
function queueRefresh(files: string[], fromApp: boolean): Promise<void>
{
    for (const f of files)
        refreshQueue.files.add(f);

    if (fromApp)
        refreshQueue.app = true;

    const done = new Promise<void>((resolve) => refreshQueue.waiters.push(resolve));

    if (refreshTimer)
        clearTimeout(refreshTimer);

    refreshTimer = setTimeout(() =>
    {
        refreshTimer = null;
        void flushRefresh();
    }, REFRESH_DEBOUNCE);
    return done;
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
        return 'a descriptor changed what the game loads (replace_path, location)';

    const renamed = now.some((m, i) => m.name !== builtMods[i].name);
    builtMods = now;

    if (renamed)
        await call('renameMods', now.map((m) => ({ id: m.id, name: m.name })));

    return undefined;
}

async function flushRefresh(): Promise<void>
{
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
        throw new Error('Not the zip of a known mod: ' + archive);

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
        const cacheToggled = changed('indexCache');
        // another user folder or list can change the loaded mods
        const modSettings = changed('userDir') || changed('modList') || changed('activeMod');
        const modsBefore = !reindex && (changed('userDir') || changed('modList')) ? await loadedModsKey(modsHost) : undefined;
        settings = { ...settings, ...patch };
        saveSettings(settings);
        const modsChanged = modsBefore !== undefined && (await loadedModsKey(modsHost)) !== modsBefore;

        // a new worker count only restarts the image workers
        if (reindex || modsChanged)
            rebuild();
        else if (workers && settings.gameDir)
            void loadedMods().then((mods) => initImages(settings.gameDir, settings.imageWorkers, mods));

        // (a re-index applies the setting itself)
        if (!reindex && !modsChanged && cacheToggled)
            void call('setCache', cacheOptions());

        // (a re-index checks the watched folder itself)
        if (!reindex && !modsChanged && modSettings)
            void updateModWatch();

        return settings;
    });
    ipcMain.handle('settings:cpuCount', () => availableParallelism());
    // the first-run wizard: the folders found on this machine, and whether a chosen one is the right kind
    ipcMain.handle('settings:detect', () => ({ installs: findInstalls(app.getPath('home')), userDirs: findUserDirs(app.getPath('documents'), app.getPath('home')), documents: app.getPath('documents') }));
    ipcMain.handle('settings:checkDir', (_e, kind: 'game' | 'user', dir: string) => (kind === 'game' ? !!resolveGameDir(dir) : existsSync(join(dir, 'mod')) || existsSync(join(dir, 'launcher-v2.sqlite')) || existsSync(join(dir, 'dlc_load.json'))));
    ipcMain.handle('settings:chooseGameDir', async (e) =>
    {
        const win = BrowserWindow.fromWebContents(e.sender)!;
        const r = await dialog.showOpenDialog(win, {
            title: 'Select the Crusader Kings III installation folder',
            defaultPath: settings.gameDir || undefined,
            properties: ['openDirectory']
        });
        return r.canceled ? null : r.filePaths[0];
    });
    ipcMain.handle('settings:chooseUserDir', async (e) =>
    {
        const win = BrowserWindow.fromWebContents(e.sender)!;
        const r = await dialog.showOpenDialog(win, {
            title: 'Select the Crusader Kings III user folder (Documents\\Paradox Interactive\\Crusader Kings III)',
            defaultPath: settings.userDir || join(app.getPath('documents'), 'Paradox Interactive', 'Crusader Kings III'),
            properties: ['openDirectory']
        });
        return r.canceled ? null : r.filePaths[0];
    });
    ipcMain.handle('settings:languages', () => availableLanguages());
    ipcMain.handle('index:status', () => status);
    // the map: its province raster is built into the map cache folder (served as ck3://map/<key>.bin)
    ipcMain.handle('index:mapInfo', (_e, date?: string) => call('mapInfo', mapCacheDir(), date));
    // (the same in two parts: what stays at every date once, then what changes per date)
    ipcMain.handle('index:mapStatic', () => call('mapStatic', mapCacheDir()));
    ipcMain.handle('index:mapDated', (_e, date?: string) => call('mapDated', mapCacheDir(), date));
    ipcMain.handle('index:mapTerrain', () => call('mapTerrain', mapCacheDir()));
    ipcMain.handle('index:mapOverlays', () => call('mapOverlays', mapCacheDir()));
    ipcMain.handle('index:mapCharacters', (_e, q: string, date: string) => call('mapCharacters', q, date));
    // "Re-index now" parses afresh; the active mod's change notice re-indexes through the cache check (unchanged files load)
    ipcMain.handle('index:rebuild', (_e, force?: boolean) => rebuild(force !== false));

    for (
        const m of [
            'types',
            'typeDoc',
            'list',
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
            'eventBackground',
            'eventBackgrounds',
            'childrenOf',
            'onActions',
            'portraitOptions',
            'eventScopes',
            'describeScript',
            'scriptKeys',
            'modifierKeys',
            'fieldSuggestions',
            'fileFolders',
            'filesIn',
            'modelFolder',
            'modelInfo',
            'modelGeometry',
            'textureUsers',
            'shader',
            'textureData',
            'shaderPrograms',
            'portrait',
            'portraitReport',
            'dnaEditor',
            'characterFilter',
            'characterFacets',
            'familyTree',
            'searchCharacters',
            'coatOfArms'
        ]
    )
    {
        ipcMain.handle('index:' + m, (_e, ...args: unknown[]) => call(m, ...args));
    }

    ipcMain.handle('mods:changeState', () => modWatcher.change);
    ipcMain.handle('shell:openFile', async (_e, absPath: string, line?: number) =>
    {
        // a file inside a zip: a read-only copy of it
        const file = await openableFile(absPath);

        if (logExternal('open', file, line))
            return;

        // Prefer VS Code (jumps to the line); fall back to the OS default app.
        const url = `vscode://file/${file.replace(/\\/g, '/')}${line ? ':' + line : ''}`;

        try
        {
            await shell.openExternal(url);
        }
        catch
        {
            await shell.openPath(file);
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
    ipcMain.handle('image:info', (_e, rel: string) => imageInfo(rel));
    ipcMain.handle('log:shader', (_e, entry: ShaderLogEntry) => logShader(entry));
    registerModsIpc(modsHost);
    registerBlenderIpc({ mods: modsHost, loadedMods, query: call, workerFile: join(__dirname, 'blenderWorker.js') });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): void
{
    // (test runs: CRUSADERPOPE_HIDDEN=1 keeps the window off screen — scripts/drive.mjs — and rendering at full speed)
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
        void shell.openExternal(url);
        return { action: 'deny' };
    });

    if (process.env['ELECTRON_RENDERER_URL'])
        void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
    else
        void win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() =>
{
    settings = loadSettings();
    initShaderLog();
    handleImageProtocol({ map: { dir: mapCacheDir, name: /^[0-9a-f]{16}(-[a-z0-9]+)?\.bin$/ } });
    startWorker();
    registerIpc();
    rebuild();
    createWindow();
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
