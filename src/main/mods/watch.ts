/**
 * Watches the folders of the mods the explorer loads (docs/mods.md, "Watching the loaded mods"): the active mod's, the
 * other local mods', Steam Workshop folders (Steam rewrites them on an update) and the outer descriptors in the user's
 * mod folder. Changes are collected, debounced per folder and handed to `onFiles`: the index takes them in
 * incrementally. What it can't take in (a descriptor change that moves files between layers, …) is reported back
 * (`report`) as the pending change: the renderer offers a re-index (a full one takes 10–30 s, so it never starts by
 * itself). A build clears it; the app's own writes (editing the active mod) are not changes; the app hands them to
 * the index itself. Recursive fs.watch: one OS handle per folder on Windows and macOS, however big the folder; on
 * Linux (Node ≥ 20) it walks the tree with a watch per folder, so Workshop folders are not watched there; Steam's list of
 * installed Workshop items (`appworkshop_<app>.acf`, its `timeupdated` per item) is, and an update of one is the mod's
 * pending change. A zipped mod (`archive=`): the zip file, watched through its folder without subfolders; a changed zip
 * is the pending change too (the index doesn't take a zip's files in one by one).
 */
import { readFileSync, statSync, watch, type FSWatcher, type Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { ModChange } from '../../shared/api.ts';

/** A loaded mod folder to watch. */
export interface WatchedMod
{
    /** ModInfo id and name */
    id: string;
    name: string;
    /** the mod folder (a zipped mod: the zip file, `archive`) */
    root: string;
    /** a zipped mod: `root` is the zip file */
    archive?: boolean;
    /** the active mod (the one being edited) */
    active?: boolean;
    /** a Steam Workshop folder: Steam writes an update over seconds; a longer pause collects it */
    workshop?: boolean;
    /** the outer descriptor (`<user>/mod/<name>.mod`, ModInfo.descriptorFile): its changes are the mod's */
    descriptor?: string;
}

/** Not mod content: editor and VCS folders (dot folders), temp and swap files, OS litter. */
function ignored(rel: string): boolean
{
    const parts = rel.split(/[\\/]/);

    if (parts.some((p) => p.startsWith('.')))
        return true;

    const base = parts[parts.length - 1].toLowerCase();
    return base === 'thumbs.db' || base === 'desktop.ini' || base === '4913' || /(~|\.tmp|\.swp|\.crusaderpope-tmp)$/.test(base) || base.startsWith('~$');
}

/** A mod's file the index keeps versions of (GameIndex FileInfo.stamp): script and localization files. */
const INDEX_FILE = /^(common|events|history\/characters)\/.*\.txt$|^localization\/.*\.yml$/i;

/** pause after the last event of a folder before its changes go to the index */
const DELAY = 250;
const WORKSHOP_DELAY = 2000;

interface Folder
{
    mod: WatchedMod;
    watcher: FSWatcher | null;
    /** changed paths (absolute; the root: the OS lost track, the whole folder; an outer descriptor of the mod) */
    files: Set<string>;
    timer: ReturnType<typeof setTimeout> | null;
    /**
     * size|mtime|ctime of each file of the mod as last seen (keyOf path): an event for a file that is as it was is a
     * read; Windows reports last-access updates too (the recursive watch asks for them), so the app reading a mod's
     * images, models or descriptor would look like changes (the index has versions only of its script files)
     */
    stamps: Map<string, string>;
    /** the walk filling `stamps` when the folder is first watched (in the background; its events wait for it) */
    scan: Promise<void>;
}

const lc = (s: string): string => s.toLowerCase();
/** A path's key for comparisons: absolute, the platform's separators, no trailing separator, lower case. */
const keyOf = (p: string): string => lc(resolve(p));
const stampOf = (st: Stats): string => `${st.size}|${st.mtimeMs}|${st.ctimeMs}`;

/** Every file below a folder (dot folders and files aside) with its stamp, a few stats at a time. */
async function scanStamps(root: string, out: Map<string, string>): Promise<void>
{
    const walk = async (dir: string): Promise<void> =>
    {
        let list;

        try
        {
            list = await readdir(dir, { withFileTypes: true });
        }
        catch
        {
            return;
        }

        const files: string[] = [];

        for (const d of list)
        {
            if (d.name.startsWith('.'))
                continue;

            if (d.isDirectory())
                await walk(join(dir, d.name));
            else if (d.isFile())
                files.push(join(dir, d.name));
        }

        for (let i = 0; i < files.length; i += 64)
        {
            await Promise.all(
                files.slice(i, i + 64).map(async (f) =>
                {
                    try
                    {
                        const st = await stat(f);
                        const k = keyOf(f);

                        // (an event may have stamped it meanwhile)
                        if (!out.has(k))
                            out.set(k, stampOf(st));
                    }
                    catch
                    {
                        /* gone meanwhile */
                    }
                })
            );
        }
    };
    await walk(root);
}

/** An installed Workshop item's last update time in Steam's `appworkshop_<app>.acf` (its WorkshopItemsInstalled part). */
function acfTimes(file: string): Map<string, string>
{
    const out = new Map<string, string>();
    let text: string;

    try
    {
        text = readFileSync(file, 'utf8');
    }
    catch
    {
        return out;
    }

    // (the installed items come first; WorkshopItemDetails repeats the ids; the first one counts)
    for (const m of text.matchAll(/"(\d+)"\s*\{[^{}]*?"timeupdated"\s*"(\d+)"/g))
        if (!out.has(m[1]))
            out.set(m[1], m[2]);

    return out;
}

/** Steam's list of a Workshop item folder's app (`…/workshop/content/<app>/<item>` → `…/workshop/appworkshop_<app>.acf`). */
function acfOf(root: string): string
{
    const app = dirname(resolve(root));
    return join(dirname(dirname(app)), `appworkshop_${basename(app)}.acf`);
}

/** Steam's list of installed Workshop items, watched for the Workshop mods on Linux (ModWatcher.acfs). */
interface Acf
{
    file: string;
    watcher: FSWatcher | null;
    mods: WatchedMod[];
    /** item id → timeupdated as last read */
    seen: Map<string, string>;
    timer: ReturnType<typeof setTimeout> | null;
}

export class ModWatcher
{
    /** by lower-case root */
    private folders = new Map<string, Folder>();
    /** Linux: Steam's Workshop lists of the Workshop mods (their folders are not watched), by lower-case path */
    private acfs = new Map<string, Acf>();
    /** the user's mod folder (outer descriptors `mod/<name>.mod`), watched without subfolders */
    private descDirs = new Map<string, FSWatcher | null>();
    /** the app's own writes: lowercase absolute path → until when events for it are ignored */
    private own = new Map<string, number>();
    /** the change not re-indexed yet */
    change: ModChange | null = null;
    /** files reported back as needing a re-index, per mod id (the change's list) */
    private reported = new Map<string, { mod: WatchedMod; files: Set<string>; }>();
    private readonly onChange: (c: ModChange | null) => void;
    private readonly onFiles: (files: string[], mod: WatchedMod) => void;

    /** @param onFiles changed files of one mod (absolute paths; a folder for everything in it); the index updates itself */
    // (no parameter properties: scripts load this with --experimental-strip-types)
    constructor(onChange: (c: ModChange | null) => void, onFiles: (files: string[], mod: WatchedMod) => void)
    {
        this.onChange = onChange;
        this.onFiles = onFiles;
    }

    /**
     * Watches these mods' folders (the loaded ones; mods no longer listed are let go) and their outer descriptors (the
     * folders holding them, without subfolders). The pending change belongs to the mods watched: changes of mods let
     * go are dropped.
     */
    watch(mods: WatchedMod[]): void
    {
        const want = new Map<string, WatchedMod>();
        const lists = new Map<string, WatchedMod[]>();

        for (const m of mods)
        {
            if (!m.root)
                continue;

            if (m.workshop && !m.archive && process.platform === 'linux')
            {
                const k = keyOf(acfOf(m.root));
                lists.set(k, [...(lists.get(k) ?? []), m]);
            }
            else
                want.set(keyOf(m.root), m);
        }

        this.watchAcfs(lists);

        for (const [key, f] of this.folders)
        {
            const m = want.get(key);

            if (m && m.id === f.mod.id)
            {
                // (the same folder: only what is said about it may change (active, name))
                f.mod = m;
                continue;
            }

            this.drop(key, f);
        }

        for (const [key, m] of want)
            if (!this.folders.has(key))
                this.open(key, m);

        // the outer descriptors' folders (the user's mod folder)
        const dirs = new Map<string, string>();

        for (const f of this.folders.values())
        {
            const d = f.mod.descriptor ? dirname(f.mod.descriptor) : '';

            if (d)
                dirs.set(keyOf(d), resolve(d));
        }

        for (const [key, w] of this.descDirs)
        {
            if (dirs.has(key))
                continue;

            w?.close();
            this.descDirs.delete(key);
        }

        for (const [key, dir] of dirs)
            if (!this.descDirs.has(key))
                this.descDirs.set(key, this.listen(dir, false, (rel) => this.descriptorEvent(dir, rel)));

        // (a mod let go takes its pending change with it)
        let dropped = false;

        for (const id of [...this.reported.keys()])
        {
            if (this.watched().some((m) => m.id === id))
                continue;

            this.reported.delete(id);
            dropped = true;
        }

        if (dropped)
            this.publish();
    }

    /** The mods watched now (also those watched through Steam's Workshop list). */
    watched(): WatchedMod[]
    {
        return [...[...this.folders.values()].map((f) => f.mod), ...[...this.acfs.values()].flatMap((a) => a.mods)];
    }

    /** Files the app writes itself (and their folders): not reported for a few seconds. */
    ignore(files: string[], ms = 4000): void
    {
        const until = Date.now() + ms;

        for (const f of files)
            this.own.set(lc(f), until);
    }

    /** A build starts: it reads every change made up to now (also those still in the debounce). */
    building(): void
    {
        for (const f of this.folders.values())
        {
            if (f.timer)
                clearTimeout(f.timer);

            f.timer = null;
            f.files.clear();
        }

        this.reported.clear();
        this.set(null);
    }

    /**
     * Changed files the index could not take in (absolute paths, as handed to onFiles): shown as the pending change
     * until the next build.
     */
    report(files: string[]): void
    {
        for (const file of files)
        {
            const a = keyOf(file);
            const inside = (root: string): boolean => a === keyOf(root) || a.startsWith(keyOf(root) + sep);
            // (an outer descriptor: the mod it describes)
            const mod = this.watched().find((m) => inside(m.root)) ?? this.descriptorMod(file);

            if (!mod)
                continue;

            // (a path in the mod folder, relative to it; an outer descriptor or a zip: its file name; `othermod.mod` begins
            // with the folder's path `…/othermod`, so the separator counts)
            const rel = inside(mod.root) && !mod.archive ?
                resolve(file)
                    .slice(keyOf(mod.root).length)
                    .replace(/\\/g, '/')
                    .replace(/^\/+/, '') :
                basename(file);
            const r = this.reported.get(mod.id) ?? { mod, files: new Set<string>() };
            this.reported.set(mod.id, r);
            r.files.add(rel || '(the mod folder)');
        }

        this.publish();
    }

    close(): void
    {
        this.watch([]);
    }

    /** Linux: the Workshop lists of these Workshop mods (by lower-case path) watched; their folders the OS can't watch cheaply. */
    private watchAcfs(lists: Map<string, WatchedMod[]>): void
    {
        for (const [key, a] of this.acfs)
        {
            if (lists.has(key))
                continue;

            a.watcher?.close();

            if (a.timer)
                clearTimeout(a.timer);

            this.acfs.delete(key);
        }

        for (const [key, mods] of lists)
        {
            const old = this.acfs.get(key);

            if (old)
            {
                old.mods = mods;
                continue;
            }

            const file = acfOf(mods[0].root);
            const a: Acf = { file, watcher: null, mods, seen: acfTimes(file), timer: null };
            const name = lc(basename(file));
            // (Steam rewrites the list through a temp file: any event for its name, then a pause)
            a.watcher = this.listen(dirname(file), false, (rel) =>
            {
                if (rel && lc(rel) !== name)
                    return;

                if (a.timer)
                    clearTimeout(a.timer);

                a.timer = setTimeout(() =>
                {
                    a.timer = null;

                    if (this.acfs.get(key) === a)
                        this.acfChanged(a);
                }, WORKSHOP_DELAY);
            });
            this.acfs.set(key, a);
        }
    }

    /** Steam's Workshop list changed: the watched items it updated are their mods' pending change. */
    private acfChanged(a: Acf): void
    {
        const now = acfTimes(a.file);
        const updated: string[] = [];

        for (const m of a.mods)
        {
            const item = basename(resolve(m.root));
            const t = now.get(item);

            if (t !== undefined && a.seen.get(item) !== undefined && t !== a.seen.get(item))
                updated.push(m.root);
        }

        // (a list Steam is still writing reads short: kept as it was)
        if (now.size)
            a.seen = now;

        if (updated.length)
            this.report(updated);
    }

    private open(key: string, mod: WatchedMod): void
    {
        const f: Folder = { mod, watcher: null, files: new Set(), timer: null, stamps: new Map(), scan: Promise.resolve() };
        this.folders.set(key, f);

        // a zip: its folder, without subfolders; its own events (stamped: a read is no change)
        if (mod.archive)
        {
            const name = lc(basename(mod.root));
            f.watcher = this.listen(dirname(mod.root), false, (rel) =>
            {
                if (!rel || lc(rel) === name)
                    this.changed(f, mod.root);
            });
            this.moved(f, mod.root);

            if (mod.descriptor)
                this.moved(f, mod.descriptor);

            return;
        }

        f.watcher = this.listen(mod.root, true, (rel) => this.event(f, rel));
        // (the outer descriptor too: the app reads it whenever it reads the mods)
        f.scan = scanStamps(mod.root, f.stamps)
            .then(() => void (mod.descriptor && this.moved(f, mod.descriptor)))
            .catch(() =>
            {});
    }

    /**
     * Whether a path reported for a folder changed since last seen, stamping it (Folder.stamps): a file as it was is no
     * change, a read. Folders, the mod folder itself and files gone: always (the index looks at what is below).
     */
    private moved(f: Folder, abs: string): boolean
    {
        const k = keyOf(abs);
        const root = keyOf(f.mod.root);

        // (the index's script files: it compares them with the versions it read itself; a stamp taken here while a
        // build reads them could hide a change made meanwhile)
        if (k.startsWith(root + sep) && INDEX_FILE.test(k.slice(root.length + 1).replace(/\\/g, '/')))
            return true;

        let st: Stats;

        try
        {
            st = statSync(abs);
        }
        catch
        {
            f.stamps.delete(k);
            return true;
        }

        if (!st.isFile())
            return true;

        const now = stampOf(st);

        if (f.stamps.get(k) === now)
            return false;

        f.stamps.set(k, now);
        return true;
    }

    private drop(key: string, f: Folder): void
    {
        f.watcher?.close();

        if (f.timer)
            clearTimeout(f.timer);

        this.folders.delete(key);
    }

    /** fs.watch of a folder; null when it can't be watched (gone, too many files for the OS), stopped quietly. */
    private listen(dir: string, recursive: boolean, on: (rel: string) => void): FSWatcher | null
    {
        try
        {
            const w = watch(dir, { recursive }, (_event, filename) => on(filename ? String(filename) : ''));
            w.on('error', () => w.close());
            return w;
        }
        catch
        {
            return null;
        }
    }

    /** Some of the app's own writes are within their ignore window. */
    private writing(): boolean
    {
        const now = Date.now();

        for (const until of this.own.values())
            if (until >= now)
                return true;

        return false;
    }

    private isOwn(abs: string): boolean
    {
        const now = Date.now();
        const a = lc(abs);

        for (const [f, until] of this.own)
        {
            if (until < now)
                this.own.delete(f);
            // the file, or a folder created for it
            else if (f === a || f.startsWith(a + sep) || f.startsWith(a + '/'))
                return true;
        }

        return false;
    }

    private event(f: Folder, rel: string): void
    {
        const root = f.mod.root;

        if (rel && ignored(rel))
            return;

        // (the app's own write: the index gets it from the app; its stamp is the new version)
        if (rel && this.isOwn(join(root, rel)))
        {
            this.moved(f, join(root, rel));
            return;
        }

        // Windows reports some events without a file name when many files change at once (an import from Blender writes
        // a mesh, its blend shapes and textures); while the app's own writes are fresh, they are taken as those
        if (!rel && f.mod.active && this.writing())
            return;

        // (no file name: the OS lost track, the whole folder is looked at; the time alone doesn't filter: on Windows a
        // file copied over another keeps the source's mtime and ctime; its size and times against the last seen do)
        this.changed(f, rel ? join(root, rel) : root);
    }

    /** A changed path of a watched mod (absolute): handed on once the folder is quiet. */
    private changed(f: Folder, abs: string): void
    {
        f.files.add(abs);

        if (f.timer)
            clearTimeout(f.timer);

        f.timer = setTimeout(() =>
        {
            f.timer = null;

            if (this.folders.get(keyOf(f.mod.root)) !== f)
                return;

            const files = [...f.files];
            f.files.clear();
            // (compared with the stamps once the first walk has them: a read reports a file that is as it was)
            void f.scan.then(() =>
            {
                const changed = this.folders.get(keyOf(f.mod.root)) === f ? files.filter((abs) => this.moved(f, abs)) : [];

                // (a zip, or its descriptor: the index reads a zip only in a build, so it is the pending change)
                if (changed.length && f.mod.archive)
                    this.report(changed);
                else if (changed.length)
                    this.onFiles(changed, f.mod);
            });
        }, f.mod.workshop ? WORKSHOP_DELAY : DELAY);
    }

    /** The watched mod an outer descriptor (`<user>/mod/<name>.mod`) describes. */
    private descriptorMod(file: string): WatchedMod | undefined
    {
        const a = keyOf(file);
        return this.watched().find((m) => m.descriptor && keyOf(m.descriptor) === a);
    }

    /** An outer descriptor changed: the mod's own change (main compares the layering). */
    private descriptorEvent(dir: string, rel: string): void
    {
        if (!rel || rel.includes('/') || rel.includes('\\') || !/\.mod$/i.test(rel))
            return;

        const file = join(dir, rel);
        const mod = this.descriptorMod(file);

        if (!mod || this.isOwn(file))
            return;

        const f = this.folders.get(keyOf(mod.root));

        // (handed on with the mod's own changes; a Workshop mod on Linux, watched through Steam's list: at once)
        if (f)
            this.changed(f, file);
        else
            this.onFiles([file], mod);
    }

    private publish(): void
    {
        const all = [...this.reported.values()];

        if (!all.length)
            return this.set(null);

        const several = all.length > 1;
        const files = all.flatMap((r) => [...r.files].map((x) => (several ? `${r.mod.name}: ${x}` : x)));
        // (`total`: how many in all, so the top bar's "and N more" counts beyond the sample)
        this.set({ mod: all[0].mod.id, name: all[0].mod.name, mods: all.map((r) => ({ id: r.mod.id, name: r.mod.name, active: !!r.mod.active })), files: files.slice(-50), ...(files.length > 50 ? { total: files.length } : {}), at: Date.now() });
    }

    private set(c: ModChange | null): void
    {
        if (c === null && this.change === null)
            return;

        this.change = c;
        this.onChange(c);
    }
}
