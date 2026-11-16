/**
 * The game's files as the game sees them with mods (docs/mods.md, "File layering"): the game folder, then each mod
 * in load order. A mod's file replaces the file of the same path from the game or earlier mods; its `replace_path`
 * hides the game's and earlier mods' files directly in that folder (not in subfolders). Folders and zip archives.
 *
 * Engine layers (only with `engine: true`, e.g. gfx): the game folder wins over its DLC folders, then jomini, then
 * clausewitz, like the existing gfx/FX lookups.
 *
 * A loaded game save (docs/saves.md, "The save as a layer of the index") is the last source: virtual files made from
 * it in memory (`SaveLayer`), over the game and every mod.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { ModInfo } from '../../shared/api.ts';
import { decodeTextBody } from './textCodec.ts';
import { ZipArchive, type ZipEntry } from './zip.ts';

export interface GameFile
{
    /** game-relative path as found (forward slashes) */
    rel: string;
    /** 0 = the game (and its engine layers), 1.. = mods in load order */
    source: number;
    /** file on disk; absent for files inside a zip */
    abs?: string;
    zip?: ZipArchive;
    entry?: ZipEntry;
    /** a file of the save layer: its bytes (made in memory) */
    data?: Buffer;
}

/** A line a loaded save adds to an entry's card ("Savegame"): a value, or links. */
export interface SaveFact
{
    label: string;
    text?: string;
    /** an entry (no type: whatever has the name) */
    ref?: { type?: string; name: string; };
    refs?: { type?: string; name: string; }[];
}

/** The loaded save as the last source: its files made in memory (saves/project.ts). */
export interface SaveLayer
{
    /** `save:<file>`: the source's modId (mod touches name it) */
    id: string;
    name: string;
    /** the save file (where() names it) */
    file: string;
    mtime: number;
    /** game-relative path → bytes */
    files: Map<string, Buffer>;
    /**
     * game entries the save carries as entries of its own (`type|name` → the save's): a historical character the save
     * has (`character_lookup`), marked overridden by the save
     */
    overrides: Map<string, { type?: string; name?: string; }>;
    /** `type|name` → what the save says about it (its card's "Savegame" section) */
    facts: Map<string, SaveFact[]>;
}

export interface HiddenFile
{
    file: GameFile;
    /** source that hid it */
    by: number;
    how: 'file' | 'replace_path';
}

export interface FileSource
{
    index: number;
    kind: 'game' | 'mod' | 'save';
    name: string;
    /** ModInfo.id */
    modId?: string;
    replacePaths: string[];
}

interface ListOpts
{
    /** only this extension (regex on the file name) */
    ext?: RegExp;
    /** only files directly in the folder */
    shallow?: boolean;
    /** include the game's engine layers (DLC folders, jomini, clausewitz) below the game folder */
    engine?: boolean;
}

const lc = (s: string): string => s.toLowerCase();
const parentOf = (rel: string): string =>
{
    const i = rel.lastIndexOf('/');
    return i < 0 ? '' : rel.slice(0, i);
};
const norm = (rel: string): string => rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
/**
 * The game's load order of two relative paths: the files directly in a folder first (alphabetical), then each subfolder,
 * depth first. Segment by segment, case-insensitive; at the first differing segment a file (the last segment) sorts before
 * a folder, otherwise alphabetical. (Proven against every "Overriding entry" of a game run's database_conflicts.log: a plain
 * sort of the whole path puts `common/decisions/dlc_decisions/x.txt` before `common/decisions/zz.txt`, the game loads it after.)
 */
export function gamePathOrder(a: string, b: string): number
{
    const x = lc(a).split('/');
    const y = lc(b).split('/');
    const n = Math.min(x.length, y.length);

    for (let i = 0; i < n; i++)
    {
        if (x[i] === y[i])
            continue;

        const xf = i === x.length - 1;
        const yf = i === y.length - 1;

        if (xf !== yf)
            return xf ? -1 : 1;

        return x[i] < y[i] ? -1 : 1;
    }

    return x.length - y.length;
}
/** order of listed files: the game's load order */
const byPath = (a: GameFile, b: GameFile): number => gamePathOrder(a.rel, b.rel);
/** order of hidden files: by the source that hid them, then by path; the same for a fresh listing and a patched one */
const byHider = (a: HiddenFile, b: HiddenFile): number => a.by - b.by || byPath(a.file, b.file);

function walk(root: string, dir: string, shallow: boolean, out: { rel: string; abs: string; }[], skipDots = false): void
{
    let list;

    try
    {
        list = readdirSync(join(root, dir), { withFileTypes: true });
    }
    catch
    {
        return;
    }

    for (const d of list)
    {
        if (skipDots && d.name.startsWith('.'))
            continue;

        const rel = dir ? dir + '/' + d.name : d.name;

        if (d.isDirectory())
        {
            if (!shallow)
                walk(root, rel, false, out, skipDots);
        }
        else if (d.isFile())
            out.push({ rel, abs: join(root, rel) });
    }
}

/** Index of the first element not ordered before `x` (sorted `list`). */
function lowerBound<T>(list: T[], x: T, cmp: (a: T, b: T) => number): number
{
    let lo = 0;
    let hi = list.length;

    while (lo < hi)
    {
        const mid = (lo + hi) >> 1;

        if (cmp(list[mid], x) < 0)
            lo = mid + 1;
        else
            hi = mid;
    }

    return lo;
}

export class GameFiles
{
    readonly gameDir: string;
    readonly sources: FileSource[];
    /** the game's engine layers below the game folder, highest first */
    private readonly engineRoots: string[];
    private readonly mods: { root?: string; zip?: ZipArchive; replace: Set<string>; save?: { layer: SaveLayer; byLc: Map<string, string>; }; }[];
    private readonly listed = new Map<string, { files: GameFile[]; hidden: HiddenFile[]; }>();

    /** @param mods enabled mods in load order (later wins); missing ones are skipped. `save`: a loaded save, over all */
    constructor(gameDir: string, mods: ModInfo[] = [], save?: SaveLayer)
    {
        this.gameDir = gameDir;
        const install = dirname(gameDir);
        const dlc = join(gameDir, 'dlc');
        this.engineRoots = [
            ...(existsSync(dlc) ? readdirSync(dlc, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dlc, d.name)) : []),
            join(install, 'jomini'),
            join(install, 'clausewitz')
        ].filter((p) => existsSync(p));
        this.sources = [{ index: 0, kind: 'game', name: 'Game', replacePaths: [] }];
        this.mods = [{ replace: new Set() }];

        for (const m of mods)
        {
            if (m.status !== 'ok')
                continue;

            let zip: ZipArchive | undefined;

            if (!m.root && m.archive)
            {
                try
                {
                    zip = new ZipArchive(m.archive);
                }
                catch
                {
                    continue;
                }
            }

            const replacePaths = m.replacePaths.map(norm);
            this.sources.push({ index: this.sources.length, kind: 'mod', name: m.name, modId: m.id, replacePaths });
            this.mods.push({ root: m.root, zip, replace: new Set(replacePaths.map(lc)) });
        }

        if (save)
        {
            this.sources.push({ index: this.sources.length, kind: 'save', name: save.name, modId: save.id, replacePaths: [] });
            this.mods.push({ replace: new Set(), save: { layer: save, byLc: new Map([...save.files.keys()].map((r) => [lc(r), r])) } });
        }
    }

    /** The loaded save's layer (undefined: none). */
    get save(): SaveLayer | undefined
    {
        return this.mods[this.mods.length - 1]?.save?.layer;
    }

    /** Identity of the layering (mods, locations, replace paths), part of cache fingerprints. */
    identity(): string
    {
        return JSON.stringify(this.sources.map((s, i) => [s.kind, s.modId ?? '', this.mods[i].root ?? this.mods[i].zip?.file ?? this.mods[i].save?.layer.file ?? '', s.replacePaths, this.mods[i].save?.layer.mtime ?? 0]));
    }

    private sourceFiles(i: number, dir: string, shallow: boolean): GameFile[]
    {
        const m = this.mods[i];

        if (i === 0)
        {
            const found: { rel: string; abs: string; }[] = [];
            walk(this.gameDir, dir, shallow, found);
            return found.map((f) => ({ rel: f.rel, abs: f.abs, source: 0 }));
        }

        if (m.root)
        {
            const found: { rel: string; abs: string; }[] = [];
            walk(m.root, dir, shallow, found);
            return found.map((f) => ({ rel: f.rel, abs: f.abs, source: i }));
        }

        const prefix = dir ? lc(dir) + '/' : '';
        const out: GameFile[] = [];

        if (m.save)
        {
            for (const [rel, data] of m.save.layer.files)
            {
                const l = lc(rel);

                if (l.startsWith(prefix) && !(shallow && l.slice(prefix.length).includes('/')))
                    out.push({ rel, source: i, data });
            }

            return out;
        }

        for (const e of m.zip!.files())
        {
            const l = lc(e.name);

            if (!l.startsWith(prefix))
                continue;

            if (shallow && l.slice(prefix.length).includes('/'))
                continue;

            out.push({ rel: e.name, source: i, zip: m.zip, entry: e });
        }

        return out;
    }

    private layered(dir: string, opts: ListOpts): { files: GameFile[]; hidden: HiddenFile[]; }
    {
        const d = norm(dir);
        const key = [lc(d), !!opts.shallow, !!opts.engine].join('|');
        let hit = this.listed.get(key);

        if (hit)
            return hit;

        const map = new Map<string, GameFile>();
        const hidden: HiddenFile[] = [];

        // the game: engine layers lowest first, then the game folder over them
        if (opts.engine)
        {
            for (const root of [...this.engineRoots].reverse())
            {
                const found: { rel: string; abs: string; }[] = [];
                walk(root, d, !!opts.shallow, found);

                for (const f of found)
                    map.set(lc(f.rel), { rel: f.rel, abs: f.abs, source: 0 });
            }
        }

        for (const f of this.sourceFiles(0, d, !!opts.shallow))
            map.set(lc(f.rel), f);

        // mods in load order: replace_path hides what came before in that folder, then same paths are replaced
        for (let i = 1; i < this.mods.length; i++)
        {
            const replace = this.mods[i].replace;

            if (replace.size)
            {
                for (const [k, f] of map)
                {
                    if (!replace.has(lc(parentOf(f.rel))))
                        continue;

                    hidden.push({ file: f, by: i, how: 'replace_path' });
                    map.delete(k);
                }
            }

            for (const f of this.sourceFiles(i, d, !!opts.shallow))
            {
                const k = lc(f.rel);
                const prev = map.get(k);

                if (prev)
                    hidden.push({ file: prev, by: i, how: 'file' });

                map.set(k, f);
            }
        }

        const files = [...map.values()].sort(byPath);
        hit = { files, hidden: hidden.sort(byHider) };
        this.listed.set(key, hit);
        this.hiddenKeys = null;
        return hit;
    }

    /** The files the game loads below a folder (recursive unless `shallow`), sorted by path (case-insensitive). */
    list(dir: string, opts: ListOpts = {}): GameFile[]
    {
        const files = this.layered(dir, opts).files;
        return opts.ext ? files.filter((f) => opts.ext!.test(f.rel)) : files;
    }

    /** Files below a folder that a mod hid (its file of the same path, or its replace_path). */
    hidden(dir: string, opts: ListOpts = {}): HiddenFile[]
    {
        const hidden = this.layered(dir, opts).hidden;
        return opts.ext ? hidden.filter((h) => opts.ext!.test(h.file.rel)) : hidden;
    }

    /**
     * The files directly in a folder that the mods before a source ship and load now: what a `replace_path` of that source
     * (or of a mod right behind it) would hide besides the game's: per mod (its index) its paths, a path under the last mod
     * that ships it, nothing of a mod before a mod that replaces the folder itself.
     */
    earlierFiles(source: number, dir: string): Map<number, string[]>
    {
        const d = norm(dir);
        const owner = new Map<string, number>();

        for (let i = 1; i <= source && i < this.mods.length; i++)
        {
            if (this.mods[i].replace.has(lc(d)))
                owner.clear();

            if (i < source)
                for (const f of this.sourceFiles(i, d, true))
                    owner.set(lc(f.rel), i);
        }

        const out = new Map<number, string[]>();

        for (const [path, i] of owner)
            out.set(i, [...(out.get(i) ?? []), path]);

        return out;
    }

    /** The file the game loads for a path, if any. */
    get(rel: string, opts: { engine?: boolean; } = {}): GameFile | undefined
    {
        return this.find(rel, opts, true);
    }

    /**
     * The file a path had before a mod's replace_path hid it: what get() gives without replace paths (a removed
     * picture shown in the gallery as removed). The file get() gives when nothing hid it.
     */
    former(rel: string, opts: { engine?: boolean; } = {}): GameFile | undefined
    {
        return this.find(rel, opts, false);
    }

    private find(rel: string, opts: { engine?: boolean; }, replacePaths: boolean): GameFile | undefined
    {
        const r = norm(rel);
        const parent = lc(parentOf(r));

        for (let i = this.mods.length - 1; i >= 1; i--)
        {
            const m = this.mods[i];

            if (m.root)
            {
                const abs = join(m.root, r);

                if (existsSync(abs) && statSync(abs).isFile())
                    return { rel: r, abs, source: i };
            }
            else if (m.zip)
            {
                const e = m.zip.get(r);

                if (e && !e.dir)
                    return { rel: e.name, source: i, zip: m.zip, entry: e };
            }
            else if (m.save)
            {
                const name = m.save.byLc.get(lc(r));

                if (name)
                    return { rel: name, source: i, data: m.save.layer.files.get(name) };
            }

            // this mod's replace_path hides everything before it in that folder
            if (replacePaths && m.replace.has(parent))
                return undefined;
        }

        for (const root of [this.gameDir, ...(opts.engine ? this.engineRoots : [])])
        {
            const abs = join(root, r);

            if (existsSync(abs) && statSync(abs).isFile())
                return { rel: r, abs, source: 0 };
        }

        return undefined;
    }

    read(f: GameFile | string, opts: { engine?: boolean; } = {}): Buffer | undefined
    {
        const file = typeof f === 'string' ? this.get(f, opts) : f;

        if (!file)
            return undefined;

        try
        {
            if (file.data)
                return file.data;

            if (file.abs)
                return readFileSync(file.abs);

            return file.zip && file.entry ? file.zip.readEntry(file.entry) : undefined;
        }
        catch
        {
            return undefined;
        }
    }

    /** UTF-8 text without a byte order mark (bytes that are no UTF-8 as `decodeText` keeps them). */
    readText(f: GameFile | string, opts: { engine?: boolean; } = {}): string | undefined
    {
        const buf = this.read(f, opts);
        return buf && decodeTextBody(buf);
    }

    /**
     * Size and modification time (cache fingerprints); `ctime` of disk files also changes when a file is overwritten
     * by a copy that keeps the old modification time (incremental updates, thumbnails).
     */
    stat(f: GameFile): { size: number; mtime: number; ctime?: number; }
    {
        if (f.entry)
            return { size: f.entry.size, mtime: f.entry.mtime };

        if (f.data)
            return { size: f.data.length, mtime: this.save?.mtime ?? 0 };

        try
        {
            const st = statSync(f.abs!);
            return { size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs };
        }
        catch
        {
            return { size: -1, mtime: -1 };
        }
    }

    /** A readable location: the disk path, or `archive.zip › entry`. */
    where(f: GameFile): string
    {
        return f.abs ?? (f.data ? `${this.save?.file ?? 'save'} › ${f.rel}` : `${f.zip?.file} › ${f.entry?.name}`);
    }

    /** Forget listings (files changed on disk). */
    refresh(): void
    {
        this.listed.clear();
        this.hiddenKeys = null;
    }

    /**
     * A loaded mod's replace paths changed (its descriptor): the layering takes the new ones, the listings are read again
     * (GameIndex.relayer). The paths it had (lower case); null when no loaded mod has that id.
     */
    setReplacePaths(modId: string, replacePaths: string[]): string[] | null
    {
        const i = this.sources.findIndex((s) => s.modId?.toLowerCase() === modId.toLowerCase());

        if (i < 1)
            return null;

        const before = [...this.mods[i].replace];
        const paths = replacePaths.map(norm);
        this.sources[i] = { ...this.sources[i], replacePaths: paths };
        this.mods[i].replace = new Set(paths.map(lc));
        this.refresh();
        return before;
    }

    /**
     * The loaded mod folder a disk path lies in: its source and the game-relative path ('' = the mod folder itself).
     * Undefined outside loaded mod folders (the game, zipped mods, anything else).
     */
    locate(abs: string): { source: number; rel: string; } | undefined
    {
        const full = resolve(abs);
        const a = lc(full);

        for (let i = this.mods.length - 1; i >= 1; i--)
        {
            const root = this.mods[i].root;

            if (!root)
                continue;

            const r = lc(resolve(root));

            if (a === r)
                return { source: i, rel: '' };

            if (a.startsWith(r + sep))
                return { source: i, rel: norm(full.slice(r.length + 1)) };
        }

        return undefined;
    }

    /** A path of a loaded mod folder on disk (undefined: the game, a zipped mod). The reverse of locate(). */
    diskPath(source: number, rel: string): string | undefined
    {
        const root = source > 0 ? this.mods[source]?.root : undefined;
        return root ? join(root, ...norm(rel).split('/')) : undefined;
    }

    /** Whether a loaded mod folder has a file at this path on disk now. */
    onDisk(source: number, rel: string): boolean
    {
        const abs = this.diskPath(source, rel);

        try
        {
            return !!abs && statSync(abs).isFile();
        }
        catch
        {
            return false;
        }
    }

    /** `source|path` (lower case) of every hidden file of the cached listings, for isListed(); dropped when they change */
    private hiddenKeys: Set<string> | null = null;

    /** Whether a cached listing has this source's file of a path (the one loaded, or hidden by a later source). */
    isListed(source: number, rel: string): boolean
    {
        const lr = lc(norm(rel));

        for (const l of this.listed.values())
        {
            const at = lowerBound(l.files, { rel: lr, source: 0 }, byPath);

            if (at < l.files.length && l.files[at].source === source && lc(l.files[at].rel) === lr)
                return true;
        }

        if (!this.hiddenKeys)
        {
            this.hiddenKeys = new Set();

            for (const l of this.listed.values())
                for (const h of l.hidden)
                    this.hiddenKeys.add(h.file.source + '|' + lc(h.file.rel));
        }

        return this.hiddenKeys.has(source + '|' + lr);
    }

    /**
     * The files behind a changed path of a mod folder: the path itself when it is a file (or gone), plus (when it is a
     * folder now, or was one) every file below it on disk and every file listed below it before (deleted or moved
     * away). Dot folders are skipped; for the mod folder itself only the top folders in `tops` are walked.
     */
    expand(source: number, rel: string, tops: string[]): string[]
    {
        const root = this.mods[source]?.root;

        if (!root)
            return [];

        const r = norm(rel);
        const out = new Map<string, string>();
        const add = (x: string): void =>
        {
            if (!out.has(lc(x)))
                out.set(lc(x), x);
        };
        let kind: 'file' | 'dir' | 'none' = 'none';

        try
        {
            kind = statSync(join(root, r)).isDirectory() ? 'dir' : 'file';
        }
        catch
        {
            /* gone */
        }

        if (kind === 'file')
            return [r];

        if (r && kind === 'none')
            add(r);

        if (kind === 'dir')
        {
            const found: { rel: string; abs: string; }[] = [];

            for (const d of r ? [r] : tops)
                walk(root, d, false, found, true);

            for (const f of found)
                add(f.rel);
        }

        const prefix = r ? lc(r) + '/' : '';
        const under = (f: GameFile): boolean => f.source === source && lc(f.rel).startsWith(prefix) && (!!r || tops.some((t) => lc(f.rel).startsWith(lc(t) + '/')));

        for (const l of this.listed.values())
        {
            for (const f of l.files)
                if (under(f))
                    add(f.rel);

            for (const h of l.hidden)
                if (under(h.file))
                    add(h.file.rel);
        }

        return [...out.values()];
    }

    /**
     * Files of a mod folder changed on disk (written, created, deleted): every cached listing covering a path takes it
     * in: the files of the other sources for that path stay, this source's is looked up again and the layering is
     * applied to that path alone, which gives the same listing as listing afresh (docs/indexer.md, "Incremental updates").
     */
    update(source: number, rels: string[]): void
    {
        const m = this.mods[source];
        this.hiddenKeys = null;

        if (!m?.root)
            return;

        for (const rel of rels)
        {
            const r = norm(rel);
            const lr = lc(r);
            let mine: GameFile | undefined;

            try
            {
                const abs = join(m.root, r);

                if (statSync(abs).isFile())
                    mine = { rel: r, abs, source };
            }
            catch
            {
                /* deleted */
            }

            for (const [key, l] of this.listed)
            {
                const [dir, shallow] = key.split('|');

                if (dir && !lr.startsWith(dir + '/'))
                    continue;

                if (shallow === 'true' && lc(parentOf(r)) !== dir)
                    continue;

                this.patch(l, lr, source, mine);
            }
        }
    }

    /**
     * A file of the loaded save's layer made anew (an edit of the save, docs/saves.md): its bytes replaced, the cached
     * listings patched (the index takes it in with refreshFiles' `virtual`). False without a save.
     */
    setSaveFile(rel: string, data: Buffer): boolean
    {
        const source = this.mods.length - 1;
        const s = this.mods[source]?.save;

        if (!s)
            return false;

        const r = norm(rel);
        const name = s.byLc.get(lc(r)) ?? r;
        s.layer.files.set(name, data);
        s.byLc.set(lc(r), name);
        this.hiddenKeys = null;
        const lr = lc(r);

        for (const [key, l] of this.listed)
        {
            const [dir, shallow] = key.split('|');

            if (dir && !lr.startsWith(dir + '/'))
                continue;

            if (shallow === 'true' && lc(parentOf(r)) !== dir)
                continue;

            this.patch(l, lr, source, { rel: name, source, data });
        }

        return true;
    }

    private patch(l: { files: GameFile[]; hidden: HiddenFile[]; }, lr: string, source: number, mine: GameFile | undefined): void
    {
        // every source's file of this path: the loaded one and the hidden ones
        const chain = new Map<number, GameFile>();
        const at = lowerBound(l.files, { rel: lr, source: 0 }, byPath);

        if (at < l.files.length && lc(l.files[at].rel) === lr)
        {
            chain.set(l.files[at].source, l.files[at]);
            l.files.splice(at, 1);
        }

        for (let k = l.hidden.length - 1; k >= 0; k--)
        {
            if (lc(l.hidden[k].file.rel) !== lr)
                continue;

            chain.set(l.hidden[k].file.source, l.hidden[k].file);
            l.hidden.splice(k, 1);
        }

        chain.delete(source);

        if (mine)
            chain.set(source, mine);

        // the layering of this path alone, as layered() does it for all
        const parent = lc(parentOf(lr));
        let win: GameFile | undefined;
        const hidden: HiddenFile[] = [];

        for (let s = 0; s < this.mods.length; s++)
        {
            if (s > 0 && win && this.mods[s].replace.has(parent))
            {
                hidden.push({ file: win, by: s, how: 'replace_path' });
                win = undefined;
            }

            const f = chain.get(s);

            if (!f)
                continue;

            if (win)
                hidden.push({ file: win, by: s, how: 'file' });

            win = f;
        }

        if (win)
            l.files.splice(lowerBound(l.files, win, byPath), 0, win);

        for (const h of hidden)
            l.hidden.splice(lowerBound(l.hidden, h, byHider), 0, h);
    }

    close(): void
    {
        for (const m of this.mods)
            m.zip?.close();
    }
}
