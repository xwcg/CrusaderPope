/**
 * Mod lists for the index and the UI (docs/mods.md): the user folder, the Paradox Launcher's playsets, the game's own
 * list (dlc_load.json) and the app's custom lists; resolving the selected list to its enabled mods in load order.
 *
 * Managing them: which list the index loads, custom lists, writing a list back to its launcher playset or to
 * dlc_load.json (backups first), the active mod, new mods, packing and unpacking. Plain Node (scripts use it too);
 * the settings and the index belong to the main process, reached through a ModsHost. IPC: ./ipc.ts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { DeleteModPlan, DeleteModResult, ModInfo, ModList, ModListEntry, ModsState, NewModRequest, Settings } from '../../shared/api.ts';
import { descriptorTextProblem, modFolderProblem } from '../../shared/modRules.ts';
import { BACKUP_FOLDER, rotatingBackup } from './backup.ts';
import { parseDescriptor, writeDescriptor, type ModDescriptor } from './descriptor.ts';
import { defaultUserDir, discoverMods, gameVersion } from './discover.ts';
import { readLauncher, writeLauncherPlayset, type NewLauncherMod } from './launcher.ts';
import { runningLauncher } from './processes.ts';
import { packFolder, unpackZip } from './zip.ts';
import { MANIFEST_FILE } from './fixesManifest.ts';
import { patchFor } from './patchLife.ts';
import { journalOf, type UndoJournal } from './undo.ts';
import { encodeText } from './textCodec.ts';
import { forgetText } from './keptTexts.ts';

import { tr } from '../../shared/i18n.ts';
export function userDirOf(settings: Settings, documents: string): string
{
    return settings.userDir || defaultUserDir(documents);
}

/** `enabled_mods` of dlc_load.json: what the game loads when started without the launcher. */
export function readGameList(userDir: string): string[] | null
{
    try
    {
        const j = JSON.parse(readFileSync(join(userDir, 'dlc_load.json'), 'utf8')) as { enabled_mods?: string[]; };
        return Array.isArray(j.enabled_mods) ? j.enabled_mods.map((s) => s.replace(/\\/g, '/')) : [];
    }
    catch
    {
        return null;
    }
}

export async function readModsState(settings: Settings, gameDir: string | null, documents: string): Promise<ModsState>
{
    const userDir = userDirOf(settings, documents);
    const launcher = await readLauncher(join(userDir, 'launcher-v2.sqlite'));
    const mods = gameDir ? discoverMods(userDir, gameDir, launcher) : [];
    const game0 = gameDir ? gameVersion(gameDir) : undefined;

    // (a fixes patch mod: the mod it is for, and whether that mod has caught up with the game)
    for (const m of mods)
    {
        const pf = patchFor(m, mods, game0);

        if (pf)
            m.patchFor = pf;
    }

    const byLauncher = new Map(mods.filter((m) => m.launcherId).map((m) => [m.launcherId!, m.id]));
    const byLower = new Map(mods.map((m) => [m.id.toLowerCase(), m.id]));
    const lists: ModList[] = [];

    for (const p of launcher?.playsets ?? [])
    {
        lists.push({
            ref: 'playset:' + p.id,
            kind: 'playset',
            name: p.name,
            active: p.active,
            ...(p.sync ? { sync: p.sync } : {}),
            mods: p.mods.map((e) => ({ id: byLauncher.get(e.modId) ?? 'launcher/' + e.modId, enabled: e.enabled }))
        });
    }

    const game = readGameList(userDir);

    if (game)
        lists.push({ ref: 'game', kind: 'game', name: 'Game (dlc_load.json)', mods: game.map((id) => ({ id: byLower.get(id.toLowerCase()) ?? id, enabled: true })) });

    for (const c of settings.customModLists ?? [])
        lists.push({ ref: 'custom:' + c.id, kind: 'custom', name: c.name, mods: c.mods });

    return {
        userDir,
        userDirFound: existsSync(userDir),
        launcher: !!launcher,
        mods,
        lists,
        selected: settings.modList ?? 'none',
        activeMod: settings.activeMod,
        gameVersion: game0
    };
}

/** The enabled mods of a list in load order ('none' or an unknown list: no mods). Unknown ids are left out. */
export function modsOfList(state: ModsState, ref: string): ModInfo[]
{
    const list = state.lists.find((l) => l.ref === ref);

    if (!list)
        return [];

    const byId = new Map(state.mods.map((m) => [m.id.toLowerCase(), m]));
    return list.mods
        .filter((e) => e.enabled)
        .map((e) => byId.get(e.id.toLowerCase()))
        .filter((m): m is ModInfo => !!m);
}

// ---------------------------------------------------------------------------
// Managing lists and mods
// ---------------------------------------------------------------------------

/** What the manager needs from the main process, which owns the settings and the index (src/main/index.ts). */
export interface ModsHost
{
    settings(): Settings;
    /** merges into the settings and saves them */
    updateSettings(patch: Partial<Settings>): void;
    /** the resolved game folder (…/game); null when not configured */
    gameDir(): string | null;
    /** the OS Documents folder (the default user folder is below it) */
    documents(): string;
    /** rebuilds the index with the loaded list */
    reindex(): void;
    /**
     * the running Paradox Launcher's process name, undefined when it is not running, null when that cannot be told
     * (default: the process list; tests replace it)
     */
    launcherRunning?(): Promise<string | null | undefined>;
    /** a query to the index (GameIndex methods through the worker): editing the active mod reads definitions */
    query?<T>(method: string, ...params: unknown[]): Promise<T>;
    /**
     * files the app is about to write or delete in a mod folder (the active mod's edits, a migration run's patch mod), told
     * before the change: the folder watcher ignores their events for 4 s (no save of another editor: not formatted, not
     * handed to the index a second time)
     */
    wrote?(files: string[]): void;
    /**
     * files of the active mod written by the app (absolute paths): the index takes them in, incrementally where it can
     * (IndexStatus.revision bumps), else by a re-index
     */
    refreshFiles?(files: string[]): Promise<void>;
    /** resolves when the index is ready (a build started meanwhile: when it is done) */
    ready?(): Promise<void>;
    /** the app's own data folder (userData): the undo steps of what the app wrote into mods are kept there (undo.ts) */
    dataDir?(): string;
    /** moves a file or folder to the system's Recycle Bin / Trash (default, for scripts and tests: deleted for good) */
    trash?(path: string): Promise<void>;
    /**
     * the undo journal when another thread keeps it (a job in the migration worker records its steps in main's journal,
     * migrationThread.ts); absent: the journal of `dataDir`, or one in memory (undo.ts `journalOf`)
     */
    undoJournal?(): UndoJournal;
}

// the last state read: thumbnails are served only for mods it lists
let last: ModsState | undefined;
// a state a job hands to the operations it runs (`withModsState`), dropped by a change of what it holds
const heldState = new AsyncLocalStorage<{ state?: ModsState; }>();

export async function modsState(host: ModsHost): Promise<ModsState>
{
    const held = heldState.getStore();

    if (held?.state)
        return held.state;

    last = await readModsState(host.settings(), host.gameDir(), host.documents());

    if (held)
        held.state = last;

    return last;
}

/**
 * Runs `work` with `modsState` answering `state` (read by the caller just before): for the many operations of a job that change
 * no descriptor, list, setting or active mod (the migration's fixes, which write the patch mod's files only; each read every
 * installed mod again, 284 reads of 51 to 62 ms in AGOT's run, round 11). A change of the state inside (`change`, `setActive`)
 * reads it anew.
 */
export function withModsState<T>(state: ModsState, work: () => Promise<T>): Promise<T>
{
    return heldState.run({ state }, work);
}

/** The held state is stale: the next `modsState` reads the mods again. */
function dropHeld(): void
{
    const held = heldState.getStore();

    if (held)
        held.state = undefined;
}

/** What the index loads for a state: the enabled mods of the loaded list, where their files are, what they replace. */
function loadedKey(state: ModsState): string
{
    return JSON.stringify(modsOfList(state, state.selected).map((m) => [m.id, m.status, m.root ?? m.archive ?? '', m.replacePaths]));
}

export async function loadedModsKey(host: ModsHost): Promise<string>
{
    return loadedKey(await modsState(host));
}

/**
 * Runs a change and re-indexes when it changed what the index loads: another list selected, the loaded list saved or
 * written back with other mods, a mod of it unpacked elsewhere, a mod it names created. Also after a failure: part of
 * the change may have happened.
 */
async function change<T>(host: ModsHost, fn: (state: ModsState) => T | Promise<T>): Promise<{ result: T; state: ModsState; }>
{
    dropHeld();
    const before = await modsState(host);
    let state = before;
    let result: T;

    try
    {
        result = await fn(before);
    }
    finally
    {
        dropHeld();
        state = await modsState(host);

        if (loadedKey(state) !== loadedKey(before))
            host.reindex();
    }

    return { result, state };
}

function findMod(state: ModsState, id: string): ModInfo
{
    const m = state.mods.find((x) => x.id.toLowerCase() === String(id).toLowerCase());

    if (!m)
        throw new Error(tr('Unknown mod: ') + id);

    return m;
}

const customId = (ref: string | undefined): string | undefined => (ref?.startsWith('custom:') ? ref.slice('custom:'.length) : undefined);
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Entries as stored: ids trimmed, each mod once (the first), enabled unless false. */
function cleanEntries(mods: unknown): ModListEntry[]
{
    if (!Array.isArray(mods))
        throw new Error(tr('A mod list needs its mods.'));

    const seen = new Set<string>();
    const out: ModListEntry[] = [];

    for (const e of mods as Partial<ModListEntry>[])
    {
        const id = typeof e?.id === 'string' ? e.id.trim() : '';

        if (!id || seen.has(id.toLowerCase()))
            continue;

        seen.add(id.toLowerCase());
        out.push({ id, enabled: e.enabled !== false });
    }

    return out;
}

/**
 * Writes through a temporary file so a crash never leaves half a file the game or launcher reads. A text is written as
 * UTF-8, the bytes of a file that was no UTF-8 (`decodeText`) as they were.
 */
export function writeAtomic(file: string, data: string | Uint8Array): void
{
    const tmp = file + '.crusaderpope-tmp';
    writeFileSync(tmp, typeof data === 'string' ? encodeText(data) : data);
    // (a text a running job keeps of it is read again)
    forgetText(file);

    try
    {
        renameSync(tmp, file);
    }
    catch (e)
    {
        // (a read-only or locked target: no leftover next to it)
        rmSync(tmp, { force: true });
        throw e;
    }
}

/** The list the index loads ('none' = the game alone). */
export async function selectList(host: ModsHost, ref: string): Promise<ModsState>
{
    const { state } = await change(host, (s) =>
    {
        if (ref !== 'none' && !s.lists.some((l) => l.ref === ref))
            throw new Error(tr('Unknown mod list: ') + ref);

        host.updateSettings({ modList: ref });
    });
    return state;
}

/** Creates (no ref) or updates one of the app's own lists (settings.customModLists). */
export async function saveList(host: ModsHost, list: { ref?: string; name: string; mods: ModListEntry[]; }): Promise<ModsState>
{
    const { state } = await change(host, () =>
    {
        const name = String(list?.name ?? '').trim() || tr('Unnamed list');
        const mods = cleanEntries(list?.mods);
        const lists = [...(host.settings().customModLists ?? [])];

        if (list.ref)
        {
            const id = customId(list.ref);
            const i = lists.findIndex((l) => l.id === id);

            if (i < 0)
                throw new Error(id ? tr('This list no longer exists.') : tr('Only the app’s own lists are saved here — write playsets and the game list back instead.'));

            lists[i] = { id: lists[i].id, name, mods };
        }
        else
            lists.push({ id: randomUUID(), name, mods });

        host.updateSettings({ customModLists: lists });
    });
    return state;
}

/** Deletes one of the app's own lists; when it was loaded, the index goes back to the game alone. */
export async function deleteList(host: ModsHost, ref: string): Promise<ModsState>
{
    const { state } = await change(host, () =>
    {
        const id = customId(ref);
        const lists = host.settings().customModLists ?? [];

        if (!id || !lists.some((l) => l.id === id))
            throw new Error(tr('Only the app’s own lists can be deleted.'));

        host.updateSettings({ customModLists: lists.filter((l) => l.id !== id), ...(host.settings().modList === ref ? { modList: 'none' } : {}) });
    });
    return state;
}

/** What writing a list back did. */
export interface WriteListResult
{
    /** the copy of the file taken before writing (crusaderpope-backups/) */
    backup?: string;
    /** launcher: names of the local mods the app registered in the launcher database to put them into the playset */
    registered?: string[];
    /**
     * launcher: nothing written (whether the Paradox Launcher runs could not be checked: the process list could not be
     * read); the reason. Writing again with `launcherClosed` goes ahead.
     */
    unchecked?: string;
}

/**
 * Writes a list back: `launcher` = its own playset in the launcher database (playsets only; the database is copied to
 * crusaderpope-backups/ first; refused while the launcher runs, not written while that cannot be checked unless
 * `launcherClosed`; local mods the launcher has not registered yet get their `mods` row); `game` = dlc_load.json, the
 * enabled mods in order (the old file copied to crusaderpope-backups/ first).
 */
export async function writeList(host: ModsHost, ref: string, target: 'launcher' | 'game', entries: ModListEntry[], opts: { launcherClosed?: boolean; } = {}): Promise<WriteListResult>
{
    const { result } = await change(host, async (state) =>
    {
        const mods = cleanEntries(entries);
        const byId = new Map(state.mods.map((m) => [m.id.toLowerCase(), m]));

        if (target === 'launcher')
            return writePlayset(host, state, ref, mods, byId, !!opts?.launcherClosed);

        if (target === 'game')
            return writeGameList(state, mods, byId);

        throw new Error(tr('Unknown target: ') + String(target));
    });
    return result;
}

/** A local mod of the user's mod folder the launcher can be told about (it registers those when it starts). */
function registrable(m: ModInfo): boolean
{
    return !m.launcherId && m.status === 'ok' && !m.staleLocation && m.source === 'local' && !!m.descriptorFile && /^mod\/[^/\\]+\.mod$/i.test(m.id);
}

/** Bytes of the files below a folder. */
function folderSize(dir: string): number
{
    let n = 0;

    for (const d of readdirSync(dir, { withFileTypes: true }))
    {
        const p = join(dir, d.name);

        if (d.isDirectory())
            n += folderSize(p);
        else if (d.isFile())
            n += statSync(p).size;
    }

    return n;
}

/** The launcher's `mods` row for a local mod it has not registered (docs/mods.md, "Registering a new mod"). */
function launcherRow(m: ModInfo): NewLauncherMod
{
    let size: number | undefined;

    try
    {
        size = m.root ? folderSize(m.root) : m.archive ? statSync(m.archive).size : undefined;
    }
    catch
    {
        /* unreadable: the launcher fills it */
    }

    return {
        gameRegistryId: m.id,
        displayName: m.name,
        version: m.version,
        tags: m.tags,
        requiredVersion: m.supportedVersion,
        dirPath: m.root,
        archivePath: m.root ? undefined : m.archive,
        remoteSteamId: m.remoteId,
        size
    };
}

async function writePlayset(host: ModsHost, state: ModsState, ref: string, mods: ModListEntry[], byId: Map<string, ModInfo>, launcherClosed: boolean): Promise<WriteListResult>
{
    if (!ref.startsWith('playset:'))
        throw new Error(tr('Only a Paradox Launcher playset can be written to the launcher.'));

    if (!state.lists.some((l) => l.ref === ref))
        throw new Error(tr('This playset is no longer in the Paradox Launcher (removed there?) — nothing written. Save the list as one of the app’s own, or pick another playset.'));

    const rows: Parameters<typeof writeLauncherPlayset>[2] = [];
    const registered: string[] = [];
    const unknown: string[] = [];

    for (const e of mods)
    {
        const m = byId.get(e.id.toLowerCase());
        // a playset row whose mod the launcher no longer lists keeps its uuid
        const uuid = m?.launcherId ?? (e.id.startsWith('launcher/') ? e.id.slice('launcher/'.length) : undefined);

        if (uuid)
            rows.push({ modId: uuid, enabled: e.enabled });
        else if (m && registrable(m))
        {
            rows.push({ register: launcherRow(m), enabled: e.enabled });
            registered.push(m.name);
        }
        // (the launcher and the game read the descriptor's location: registered, it would not load in the game)
        else if (m?.staleLocation && !m.launcherId && m.descriptorFile)
        {
            throw new Error(
                tr('“{name}” was found in {value}, but its descriptor ({descriptorFile}) still points to {staleLocation}, where the game and the launcher look for it. Correct the descriptor\'s path first (or start the launcher once), then write the playset.', { name: m.name, value: m.root ?? m.archive, descriptorFile: m.descriptorFile, staleLocation: m.staleLocation })
            );
        }
        else
            unknown.push(m?.name ?? e.id);
    }

    if (unknown.length)
    {
        const it = plural(unknown.length, 'it', 'them');
        throw new Error(
            tr('The Paradox Launcher does not know {plural} yet: {join}. Start the launcher once so it registers {it}, or remove {it} from the playset.', { plural: plural(unknown.length, tr('this mod'), tr('these mods')), join: unknown.join(', '), it })
        );
    }

    const running = await (host.launcherRunning ?? runningLauncher)();

    if (running)
        throw new Error(tr('The Paradox Launcher is running ({running}). Close it first — it keeps its playsets in memory and would overwrite the change.', { running }));

    // fail safe: without the process list nobody knows whether the launcher would overwrite the change
    if (running === null && !launcherClosed)
        return { unchecked: tr('The list of running programs could not be read, so the app cannot tell whether the Paradox Launcher is running. Nothing was written.') };

    const db = join(state.userDir, 'launcher-v2.sqlite');
    const backup = rotatingBackup(db, join(state.userDir, BACKUP_FOLDER));
    await writeLauncherPlayset(db, ref.slice('playset:'.length), rows);
    return registered.length ? { backup, registered } : { backup };
}

function writeGameList(state: ModsState, mods: ModListEntry[], byId: Map<string, ModInfo>): WriteListResult
{
    const ids: string[] = [];
    const bad: string[] = [];

    for (const e of mods)
    {
        if (!e.enabled)
            continue;

        const m = byId.get(e.id.toLowerCase());
        const id = m?.id ?? e.id;

        // the game loads registered descriptors only (mod/<file>.mod)
        if (/^mod\/[^/\\]+\.mod$/i.test(id))
            ids.push(id);
        else
            bad.push(m?.name ?? e.id);
    }

    if (bad.length)
    {
        const it = plural(bad.length, 'it', 'them');
        throw new Error(
            tr('The game loads only mods with a descriptor in the mod folder; not registered: {join}. Start the Paradox Launcher once so it registers {it}, or remove {it} from the list.', { join: bad.join(', '), it })
        );
    }

    if (!state.userDirFound)
        throw new Error(tr('The CK3 user folder was not found: ') + state.userDir);

    const file = join(state.userDir, 'dlc_load.json');
    let json: Record<string, unknown> = {};
    let backup: string | undefined;

    if (existsSync(file))
    {
        try
        {
            const j = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown;

            if (j && typeof j === 'object' && !Array.isArray(j))
                json = j as Record<string, unknown>;
        }
        catch
        {
            /* unreadable: replaced; the backup keeps it */
        }

        backup = rotatingBackup(file, join(state.userDir, BACKUP_FOLDER));
    }

    // other keys (disabled_dlcs …) stay as they are, in their order
    json.enabled_mods = ids;

    if (!Array.isArray(json.disabled_dlcs))
        json.disabled_dlcs = [];

    writeAtomic(file, JSON.stringify(json));
    return { backup };
}

/** The mod being edited: only an unpacked mod in the user's mod folder (null = none). */
export async function setActive(host: ModsHost, id: string | null): Promise<ModsState>
{
    const state = await modsState(host);

    if (id === null)
        host.updateSettings({ activeMod: undefined });
    else
    {
        const m = findMod(state, id);

        if (!m.editable)
            throw new Error(tr('“{name}” cannot be the active mod: only unpacked mods in your mod folder ({join}) are edited here.', { name: m.name, join: join(state.userDir, 'mod') }));

        host.updateSettings({ activeMod: m.id });
    }

    dropHeld();
    return modsState(host);
}

/**
 * A new local mod: `<user>/mod/<folder>/descriptor.mod` (inner, no location) and `<user>/mod/<folder>.mod` (outer,
 * `path=` absolute with forward slashes as the launcher writes it). It becomes the active mod. The launcher registers
 * it (gives it a uuid for playsets) the next time it starts, or the app, when it writes it into a playset.
 */
export async function createMod(host: ModsHost, req: NewModRequest): Promise<ModsState>
{
    const { state } = await change(host, (s) =>
    {
        const name = String(req?.name ?? '').trim();
        const folder = String(req?.folder ?? '').trim();
        const version = String(req?.version ?? '').trim();
        const supportedVersion = String(req?.supportedVersion ?? '').trim();
        const tags = [...new Set((Array.isArray(req?.tags) ? req.tags : []).map((t) => String(t).trim()).filter(Boolean))];
        const problem = (name ? undefined : tr('Enter a name for the mod.')) ??
            descriptorTextProblem('Name', name) ??
            modFolderProblem(folder) ??
            descriptorTextProblem('Version', version) ??
            (supportedVersion && !/^v?[0-9*]+(\.[0-9*]+){0,3}$/i.test(supportedVersion) ? tr('Supported version: numbers or * separated by dots, like 1.19.*') : undefined) ??
            tags.map((t) => descriptorTextProblem('Tags', t)).find(Boolean);

        if (problem)
            throw new Error(problem);

        if (!s.userDirFound)
            throw new Error(tr('The CK3 user folder was not found: {userDir}. Start the game once, or set the folder in the settings.', { userDir: s.userDir }));

        const modDir = join(s.userDir, 'mod');
        const root = join(modDir, folder);
        const outer = join(modDir, folder + '.mod');

        if (existsSync(root) || existsSync(outer))
            throw new Error(tr('mod/{folder} already exists — choose another folder name.', { folder }));

        const d: ModDescriptor = { name, version: version || undefined, supportedVersion: supportedVersion || undefined, tags, replacePaths: [], dependencies: [], extra: [] };
        // (the folder watcher is told first, as of every write the app makes; the new folder counts with the descriptor in it)
        host.wrote?.([join(root, 'descriptor.mod'), outer]);
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'descriptor.mod'), writeDescriptor(d, false));
        writeFileSync(outer, writeDescriptor({ ...d, path: root.replace(/\\/g, '/') }));
        host.updateSettings({ activeMod: 'mod/' + folder + '.mod' });
    });
    return state;
}

/** A mod's descriptor without its location: the outer one when readable (unknown keys kept), else from ModInfo. */
function descriptorOf(m: ModInfo): ModDescriptor
{
    if (m.descriptorFile)
    {
        try
        {
            return { ...parseDescriptor(readFileSync(m.descriptorFile, 'utf8')), path: undefined, archive: undefined };
        }
        catch
        {
            /* unreadable: from what discovery found */
        }
    }

    return { name: m.name, version: m.version, supportedVersion: m.supportedVersion, tags: m.tags, replacePaths: m.replacePaths, remoteFileId: m.remoteId, dependencies: [], extra: [] };
}

/** Left out of a mod zip: dot files and folders (.git, .vscode, the launcher's .cpatch), OS litter, zips at the top. */
export function skipInModZip(rel: string): boolean
{
    const parts = rel.split('/');

    if (parts.some((p) => p.startsWith('.')))
        return true;

    const base = parts[parts.length - 1].toLowerCase();

    if (base === 'thumbs.db' || base === 'desktop.ini')
        return true;

    return parts.length === 1 && base.endsWith('.zip');
}

/** Zips an unpacked mod of the user's mod folder next to its folder (`<folder>.zip`); the mod itself stays as it is. */
/** Zips an unpacked local mod to `<folder>.zip` next to it; an existing zip is only replaced with `overwrite`. */
export async function packMod(host: ModsHost, id: string, overwrite = false): Promise<{ file: string; files: number; exists?: boolean; }>
{
    const m = findMod(await modsState(host), id);

    if (!m.editable || !m.root)
        throw new Error(tr('Only unpacked mods in your mod folder can be packed — “{name}” is {value}.', { name: m.name, value: m.archive ? 'packed already' : m.root ? 'somewhere else' : 'missing' }));

    // the zip carries the inner descriptor (the launcher and uploads read it)
    if (!existsSync(join(m.root, 'descriptor.mod')))
        writeFileSync(join(m.root, 'descriptor.mod'), writeDescriptor(descriptorOf(m), false));

    const file = join(dirname(m.root), basename(m.root) + '.zip');

    if (existsSync(file) && !overwrite)
        return { file, files: 0, exists: true };

    const tmp = file + '.crusaderpope-tmp';

    try
    {
        // (a patch mod's manifest travels with it: unpacked again, its next run still tells a game file it carried from one
        // changed by hand. A merge leaves it out: the merged mod is no patch mod, its files are not the record's)
        const { files } = await packFolder(m.root, tmp, (rel) => rel !== MANIFEST_FILE && skipInModZip(rel));
        renameSync(tmp, file);
        return { file, files };
    }
    finally
    {
        rmSync(tmp, { force: true });
    }
}

/** `<mod folder>/<name>`, or `<name>_unpacked`, `<name>_unpacked2` … while that exists and is not empty. */
function freeFolder(modDir: string, name: string): string
{
    const empty = (p: string): boolean =>
    {
        try
        {
            return readdirSync(p).length === 0;
        }
        catch
        {
            return false;
        }
    };

    for (let i = 0;; i++)
    {
        const p = join(modDir, i === 0 ? name : `${name}_unpacked${i === 1 ? '' : i}`);

        if (!existsSync(p) || empty(p))
            return p;
    }
}

/**
 * Unpacks a packed mod into `<user>/mod/<descriptor name>/` and points its outer descriptor there (`path=`, no
 * `archive=`). The zip stays where it is. All or nothing: a zip with an entry that can't be unpacked (unpackZip) or
 * without files fails; the new folder is removed, the descriptor stays as it was.
 */
export async function unpackMod(host: ModsHost, id: string): Promise<{ dir: string; files: number; }>
{
    const { result } = await change(host, async (state) =>
    {
        const m = findMod(state, id);

        if (m.root || !m.archive)
            throw new Error(tr('“{name}” is not a packed mod{value}.', { name: m.name, value: m.status === 'missing' ? ' (its files were not found)' : '' }));

        if (!m.descriptorFile)
            throw new Error(tr('“{name}” has no descriptor in your mod folder that could point to the unpacked files.', { name: m.name }));

        if (!state.userDirFound)
            throw new Error(tr('The CK3 user folder was not found: ') + state.userDir);

        const descriptorFile = m.descriptorFile;
        const dir = freeFolder(join(state.userDir, 'mod'), basename(descriptorFile).replace(/\.mod$/i, ''));

        try
        {
            const { files } = await unpackZip(m.archive, dir);

            if (!files)
                throw new Error(tr('{basename} holds no files.', { basename: basename(m.archive) }));

            if (!existsSync(join(dir, 'descriptor.mod')))
                writeFileSync(join(dir, 'descriptor.mod'), writeDescriptor(descriptorOf(m), false));

            // (the last step: when anything before fails, the descriptor still names the zip)
            const d = parseDescriptor(readFileSync(descriptorFile, 'utf8'));
            writeAtomic(descriptorFile, writeDescriptor({ ...d, path: dir.replace(/\\/g, '/'), archive: undefined }));
            return { dir, files };
        }
        catch (e)
        {
            // (the folder did not exist or was empty)
            rmSync(dir, { recursive: true, force: true });
            throw e;
        }
    });
    return result;
}

/**
 * A stale descriptor fixed (`ModInfo.staleLocation`): the outer descriptor's `path=` (or `archive=`) set to where the
 * mod was found (the launcher moved it, or the user did), after a copy of the descriptor in crusaderpope-backups/.
 * The game and the launcher look where the descriptor says; registration needs it right.
 */
export async function fixModLocation(host: ModsHost, id: string): Promise<{ descriptor: string; location: string; backup: string; }>
{
    const { result } = await change(host, async (state) =>
    {
        const m = findMod(state, id);

        if (!m.staleLocation || !m.descriptorFile)
            throw new Error(tr('“{name}”’s descriptor points to where the mod is — nothing to fix.', { name: m.name }));

        const location = (m.root ?? m.archive)!;
        const backup = rotatingBackup(m.descriptorFile, join(state.userDir, BACKUP_FOLDER));
        const d = parseDescriptor(readFileSync(m.descriptorFile, 'utf8'));
        writeAtomic(m.descriptorFile, writeDescriptor(m.root ? { ...d, path: m.root.replace(/\\/g, '/'), archive: undefined } : { ...d, archive: m.archive!.replace(/\\/g, '/'), path: undefined }));
        return { descriptor: m.descriptorFile, location, backup };
    });
    return result;
}

/** Where a mod's files are: its folder, or its zip. */
export async function modLocation(host: ModsHost, id: string): Promise<{ folder?: string; file?: string; }>
{
    const m = findMod(await modsState(host), id);

    if (m.root)
        return { folder: m.root };

    if (m.archive)
        return { file: m.archive };

    throw new Error(tr('The files of “{name}” were not found.', { name: m.name }));
}

/** The preview image of a discovered mod (only these are served: thumbnails are absolute paths anywhere). */
/**
 * A mod of one's own that may be deleted: unpacked in the user's mod folder (`editable`), its folder strictly inside
 * `<user>/mod`. Never a workshop or launcher-managed mod, never the mod folder itself.
 */
function deletable(state: ModsState, id: string): ModInfo
{
    const m = findMod(state, id);
    const modDir = join(state.userDir, 'mod');
    const rel = m.root ? relative(modDir, m.root) : '';

    if (!m.editable || !m.root || !rel || rel.startsWith('..') || isAbsolute(rel))
        throw new Error(tr('Only mods of your own — unpacked in your mod folder ({modDir}) — can be deleted here; “{name}” is not one.', { modDir, name: m.name }));

    return m;
}

const filesBelow = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce((n, d) => n + (d.isDirectory() ? filesBelow(join(dir, d.name)) : 1), 0);

/** What deleting a mod would do (docs/mods.md "Deleting a mod"). */
export async function deleteModPlan(host: ModsHost, id: string): Promise<DeleteModPlan>
{
    const state = await modsState(host);
    const m = deletable(state, id);
    const has = (l: ModList): boolean => l.mods.some((e) => e.id.toLowerCase() === m.id.toLowerCase());
    return {
        id: m.id,
        name: m.name,
        folder: m.root!,
        descriptor: m.descriptorFile,
        files: existsSync(m.root!) ? filesBelow(m.root!) : 0,
        lists: state.lists.filter((l) => l.kind === 'custom' && has(l)).map((l) => l.name),
        gameList: state.lists.some((l) => l.kind === 'game' && has(l)),
        playsets: state.lists.filter((l) => l.kind === 'playset' && has(l)).map((l) => l.name),
        active: state.activeMod?.toLowerCase() === m.id.toLowerCase()
    };
}

/**
 * Deletes a mod of one's own: out of the app's lists and the game's list (dlc_load.json, a backup first), no longer
 * the active mod, its undo steps dropped, then its folder and outer descriptor moved to the Recycle Bin (host.trash;
 * without one deleted). Launcher playsets are left as they are (the launcher shows the mod as missing). Re-indexes
 * when the loaded list held it.
 */
export async function deleteMod(host: ModsHost, id: string): Promise<{ state: ModsState; result: DeleteModResult; }>
{
    const { result, state } = await change(host, async (s) =>
    {
        const m = deletable(s, id);
        const lid = m.id.toLowerCase();
        const lists = (host.settings().customModLists ?? []).map((l) => ({ ...l, mods: l.mods.filter((e) => e.id.toLowerCase() !== lid) }));
        host.updateSettings({ customModLists: lists, ...(host.settings().activeMod?.toLowerCase() === lid ? { activeMod: undefined } : {}) });

        // (the game's list: the mod taken out, the rest as it was)
        const gameList = join(s.userDir, 'dlc_load.json');

        if (existsSync(gameList))
        {
            try
            {
                const json = JSON.parse(readFileSync(gameList, 'utf8').replace(/^﻿/, '')) as { enabled_mods?: unknown; };
                const mods = Array.isArray(json.enabled_mods) ? (json.enabled_mods as unknown[]) : [];

                if (mods.some((x) => typeof x === 'string' && x.toLowerCase() === lid))
                {
                    rotatingBackup(gameList, join(s.userDir, BACKUP_FOLDER));
                    json.enabled_mods = mods.filter((x) => !(typeof x === 'string' && x.toLowerCase() === lid));
                    writeAtomic(gameList, JSON.stringify(json));
                }
            }
            catch
            {
                /* unreadable: left alone */
            }
        }

        const undoSteps = journalOf(host).forgetMod(m.id);
        const remove = async (p: string): Promise<boolean> =>
        {
            if (!existsSync(p))
                return true;

            if (host.trash)
            {
                await host.trash(p);
                return true;
            }

            rmSync(p, { recursive: true, force: true });
            return false;
        };
        const trashed = await remove(m.root!);

        if (m.descriptorFile)
            await remove(m.descriptorFile);

        return { trashed, undoSteps };
    });
    return { state, result };
}

export async function thumbnailFile(host: ModsHost, id: string): Promise<string | undefined>
{
    const find = (s: ModsState | undefined): ModInfo | undefined => s?.mods.find((m) => m.id === id);
    return (find(last) ?? find(await modsState(host)))?.thumbnail;
}
