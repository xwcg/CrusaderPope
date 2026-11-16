/**
 * Facts of the game's own files, kept for the session (round 12): what a migration pass works out from one game file alone, never
 * from a mod's files, the playset or the index (the words of a script file, its top-level keys, the macro definitions it holds).
 * The passes of a plan and a run read the same game files again and again (the libraries query reads the game's ~4,300 script
 * files, ~200 MB, each time it is asked); a fact lets a pass skip a file that cannot matter to it, or take what it would work out.
 *
 * - **Key**: the file's absolute path (lower case on Windows) and the kind of fact; each fact is kept with the file's stamp (size,
 *   modification and change time) and made again when the stamp differs. Stamps are enough for the game's files: the app never
 *   writes them, and Steam writes each file it changes once per update, days after the file's last write, so a changed file has
 *   another modification time (the stamp collisions round 11 measured came from writes a few milliseconds apart). A file being
 *   written while it is read: its stamp before and after the read differ, and the fact is not kept.
 * - **Invalidation**: a game update, a DLC folder that appears or goes (the files of its folder are other paths: facts of their
 *   own), a file changed by hand: the stamp. The facts live in the memory of the thread whose passes use them (the migration
 *   worker's, the index worker's), and in a file of that thread's beside the index cache between sessions (`useFactStore`): an
 *   app update with other code that makes facts takes nothing of it.
 * - **Stamps are looked at once per scope**: inside a migration job (keptTexts.ts `keepingTexts`) or a `factScope` (a query of the
 *   index worker), the first fact of a file stats it, later ones take that stamp; outside, every fact stats its file.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { parse } from '../indexer/parser.ts';
import { gameRoots } from './gameLayers.ts';
import { inJob, jobMap } from './keptTexts.ts';
import { decodeTextBody } from './textCodec.ts';

/** A file's stamp, as `statSync` gives it. */
interface Stamp
{
    size: number;
    mtime: number;
    ctime: number;
}

const same = (a: Stamp, b: Stamp): boolean => a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;

function statOf(abs: string): Stamp | null
{
    try
    {
        const s = statSync(abs);
        return s.isFile() ? { size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs } : null;
    }
    catch
    {
        return null;
    }
}

/** The stamps looked at in a scope: a `factScope`, else a migration job. */
let scopes = 0;
const scopeStamps = new Map<string, Stamp | null>();
const jobStamps = jobMap<string, Stamp | null>();

/** Runs `work` (sync or async) with each file's stamp looked at once (scopes nest). */
export function factScope<T>(work: () => T): T
{
    scopes++;
    const end = (): void =>
    {
        if (--scopes === 0)
        {
            scopeStamps.clear();
            scopeBuilds.clear();
        }
    };
    let r: T;

    try
    {
        r = work();
    }
    catch (e)
    {
        end();
        throw e;
    }

    if (r instanceof Promise)
        return r.finally(end) as T;

    end();
    return r;
}

const keyOf = (abs: string): string => (process.platform === 'win32' ? resolve(abs).toLowerCase() : resolve(abs));

/** Whether a listed file is a file of the game on disk (GameFiles: source 0, its own path; not a zip entry or a save's file). */
export const onGameDisk = (f: { source: number; abs?: string; data?: unknown; zip?: unknown; }): boolean => f.source === 0 && !!f.abs && !f.data && !f.zip;

/** A file's stamp now (once per scope). */
function stampNow(key: string, abs: string): Stamp | null
{
    const map = scopes > 0 ? scopeStamps : inJob() ? jobStamps : undefined;
    let s = map?.get(key);

    if (s === undefined)
    {
        s = statOf(abs);
        map?.set(key, s);
    }

    return s;
}

interface Kept
{
    stamp: Stamp;
    value: unknown;
}

/** The facts by kind, then by file key. */
const facts = new Map<string, Map<string, Kept>>();

/**
 * A fact of a game file: `make` of its bytes, kept while the file has the stamp it was made at. Undefined: the file cannot be read
 * now (nothing is kept; the caller reads it as it would without facts).
 */
export function gameFact<T>(kind: string, abs: string, make: (data: Buffer) => T): T | undefined
{
    const key = keyOf(abs);
    const stamp = stampNow(key, abs);

    if (!stamp)
        return undefined;

    let byFile = facts.get(kind);

    if (!byFile)
        facts.set(kind, (byFile = new Map()));

    const have = byFile.get(key);

    if (have && same(have.stamp, stamp))
        return have.value as T;

    let data: Buffer;

    try
    {
        data = readFileSync(abs);
    }
    catch
    {
        return undefined;
    }

    const value = make(data);
    // (the stamp after the read: a file written meanwhile is not kept)
    const after = statOf(abs);

    if (after && same(after, stamp) && data.length === stamp.size)
    {
        byFile.set(key, { stamp, value });
        noteChange();
    }
    else
        byFile.delete(key);

    return value;
}

/**
 * A string of its own: a part of a text (a parse's key, a match) is a view into the whole text in V8, and a fact that keeps it would
 * keep the whole file's text alive (short ones are copies anyway).
 */
export const own = (s: string): string => (s.length > 12 ? (JSON.parse(JSON.stringify(s)) as string) : s);

/** The facts kept, per kind (a check's look; and for the memory notes). */
export function factCounts(): Record<string, number>
{
    return Object.fromEntries([...facts].map(([k, m]) => [k, m.size]));
}

/** Forgets every fact and the file (a check's reset: as a new thread). */
export function forgetFacts(): void
{
    facts.clear();
    scopeStamps.clear();
    changes = 0;
    opened = false;
    store = undefined;
}

// --- kept on disk between sessions ---

/**
 * A part of the file besides the per-file facts: a memo whose every use checks what it keeps anyway (inertWork.ts's rewrites: the
 * text's hash and the world's answers), as one structured-clone value.
 */
export interface StorePart
{
    give(): unknown;
    take(value: unknown): void;
}

const MAGIC = 'crusaderpope-game-facts-1';
const parts = new Map<string, StorePart>();
let changes = 0;
let store: { file: string; code: string; } | undefined;
let opened = false;

/** Something kept that the file does not hold yet. */
export const noteChange = (): void => void changes++;

/**
 * The value with every Uint32Array in one pool (`{ [U32]: [start, length] }` in its place): Node 22's `v8.deserialize` crashed the
 * process on values with thousands of typed arrays in them (one large one is fine), and a typed array it gives back is a view
 * into the file's bytes. Another kind of typed array is not kept (throws: nothing is written).
 */
const U32 = '\0u32';

function pack(v: unknown, pool: Uint32Array[], at: { n: number; }): unknown
{
    if (v instanceof Uint32Array)
    {
        pool.push(v);
        const marker = { [U32]: [at.n, v.length] };
        at.n += v.length;
        return marker;
    }

    // (caught by the save: nothing is written)
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer)
        throw new TypeError(v.constructor.name);

    if (Array.isArray(v))
        return v.map((x) => pack(x, pool, at));

    if (v instanceof Map)
        return new Map([...v].map(([k, x]) => [pack(k, pool, at), pack(x, pool, at)]));

    if (v instanceof Set)
        return new Set([...v].map((x) => pack(x, pool, at)));

    if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x, pool, at)]));

    return v;
}

/** The value back with its Uint32Arrays, each a copy of its part of the pool. */
function unpack(v: unknown, pool: Uint32Array): unknown
{
    if (Array.isArray(v))
        return v.map((x) => unpack(x, pool));

    if (v instanceof Map)
        return new Map([...v].map(([k, x]) => [unpack(k, pool), unpack(x, pool)]));

    if (v instanceof Set)
        return new Set([...v].map((x) => unpack(x, pool)));

    if (v && typeof v === 'object')
    {
        const u32 = (v as Record<string, unknown>)[U32];

        if (Array.isArray(u32) && Object.keys(v).length === 1)
            return pool.slice(u32[0] as number, (u32[0] as number) + (u32[1] as number));

        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x, pool)]));
    }

    return v;
}

/** A part the file holds by `name` (registered once, by the module that keeps it). */
export const storePart = (name: string, part: StorePart): void => void parts.set(name, part);

/** The code version the app was built with (electron.vite.config.ts `__FACTS_CODE__`); none in the scripts. */
declare const __FACTS_CODE__: string | undefined;
export const factsCode = (): string | undefined => (typeof __FACTS_CODE__ === 'string' ? __FACTS_CODE__ : undefined);

/**
 * The facts of this thread kept in `file` between sessions (round 12; docs/mods.md "The game's own files"): the per-file facts, each
 * checked by its file's stamp when it is used, and the registered parts. Taken from the file once, at the first call, into memos
 * that are still empty, when it was written for `code` (the code that makes the facts; another code, a file that cannot be read:
 * nothing is taken); `saveFactStore` writes what is new. Not the memos of whole folders (`GameMemo`): their files' stamps are not
 * looked at.
 */
export function useFactStore(file: string, code: string): void
{
    store = { file, code };

    if (opened)
        return;

    opened = true;
    let data: Buffer;

    try
    {
        data = readFileSync(file);
    }
    catch
    {
        return;
    }

    try
    {
        const v = deserialize(data) as { magic: string; code: string; pool: Uint32Array; facts: [string, [string, Kept][]][]; parts: Record<string, unknown>; };

        // (only into memos that are still empty: nothing kept by this thread yet)
        if (v?.magic !== MAGIC || v.code !== code || changes)
            return;

        for (const [kind, list] of unpack(v.facts, v.pool) as [string, [string, Kept][]][])
            facts.set(kind, new Map(list));

        for (const [name, part] of parts)
            if (v.parts[name] !== undefined)
                part.take(unpack(v.parts[name], v.pool));
    }
    catch
    {
        // (a file of another layout, cut short: nothing of it)
        facts.clear();
    }
}

/** Writes this thread's facts to its file (`useFactStore`) when something was kept since: through a .tmp file and a rename. */
export function saveFactStore(): void
{
    if (!store || !changes)
        return;

    const { file, code } = store;
    const tmp = `${file}.tmp`;

    try
    {
        const arrays: Uint32Array[] = [];
        const at = { n: 0 };
        const packed = { facts: pack([...facts].map(([kind, m]) => [kind, [...m]]), arrays, at), parts: Object.fromEntries([...parts].map(([name, p]) => [name, pack(p.give(), arrays, at)])) };
        const pool = new Uint32Array(at.n);
        arrays.reduce((o, a) => (pool.set(a, o), o + a.length), 0);
        const data = serialize({ magic: MAGIC, code, pool, ...packed });
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(tmp, data);
        renameSync(tmp, file);
        changes = 0;
    }
    catch
    {
        // (no room, no rights: the facts stay in memory, the next save tries again)
        rmSync(tmp, { force: true });
    }
}

/** No file for the facts any more (the index cache turned off): they stay in memory. */
export function stopFactStore(): void
{
    store = undefined;
}

/** Removes the facts files of a folder (the index cache turned off). */
export function deleteFactStores(dir: string): void
{
    for (const name of ['game-facts-index.bin', 'game-facts-migration.bin'])
        rmSync(join(dir, name), { force: true });
}

// --- the game's build: what the memos of whole folders are kept for ---

/** The builds looked at in a scope (as the stamps). */
const scopeBuilds = new Map<string, string>();
const jobBuilds = jobMap<string, string>();
const recentBuilds = new Map<string, { build: string; at: number; }>();

/** A small file's text, or '' (none, unreadable). */
function smallText(file: string): string
{
    try
    {
        return statSync(file).size < 65536 ? readFileSync(file, 'latin1') : '';
    }
    catch
    {
        return '';
    }
}

const stampText = (file: string): string =>
{
    const s = statOf(file);
    return s ? `${s.size}:${s.mtime}:${s.ctime}` : '-';
};

/**
 * Which build of the game a game folder (`…/game`) holds, looked at once per scope: the DLC folders (their list), the executable's and
 * the launcher settings' stamps, the revisions the install keeps beside them (`titus_rev.txt`, `clausewitz_rev.txt`), and on Steam
 * the build id of the game's app manifest (`steamapps/appmanifest_1158310.acf`; Steam writes it with every update). A game update
 * changes some of these; a game file changed by hand does not (the per-file facts above see that by their stamps; the index does
 * not watch the game folder either).
 */
export function gameBuild(gameDir: string): string
{
    const map = scopes > 0 ? scopeBuilds : inJob() ? jobBuilds : undefined;
    const have = map?.get(gameDir);

    if (have !== undefined)
        return have;

    // (outside a scope, a look of the last two seconds: a memo asked for each word of a text must not stat files each time)
    const recent = map ? undefined : recentBuilds.get(gameDir);

    if (recent && Date.now() - recent.at < 2000)
        return recent.build;

    const install = dirname(resolve(gameDir));
    // (Steam: `steamapps/common/<game>`, the manifest in `steamapps`)
    const acf = /^common$/i.test(basename(dirname(install))) ? smallText(join(dirname(dirname(install)), 'appmanifest_1158310.acf')) : '';
    const build = JSON.stringify([
        gameRoots(gameDir),
        stampText(join(install, 'binaries', 'ck3.exe')), stampText(join(install, 'binaries', 'ck3')), stampText(join(install, 'launcher', 'launcher-settings.json')),
        smallText(join(install, 'titus_rev.txt')), smallText(join(install, 'clausewitz_rev.txt')),
        /"buildid"\s+"(\d+)"/.exec(acf)?.[1] ?? ''
    ]);

    if (map)
        map.set(gameDir, build);
    else
        recentBuilds.set(gameDir, { build, at: Date.now() });

    return build;
}

/**
 * A memo of what a pass works out from whole folders of the game's files (keyed by the game folder and more): kept while the game's
 * build is the one it was made for (`gameBuild`), emptied for that game folder when it is another (a Steam update while the app runs,
 * a DLC added or taken).
 */
export class GameMemo<V>
{
    private readonly byGame = new Map<string, { build: string; map: Map<string, V>; }>();

    get(gameDir: string, key: string): V | undefined
    {
        const g = this.byGame.get(gameDir);

        if (!g)
            return undefined;

        if (g.build !== gameBuild(gameDir))
        {
            this.byGame.delete(gameDir);
            return undefined;
        }

        return g.map.get(key);
    }

    set(gameDir: string, key: string, value: V): void
    {
        const build = gameBuild(gameDir);
        let g = this.byGame.get(gameDir);

        if (!g || g.build !== build)
            this.byGame.set(gameDir, (g = { build, map: new Map() }));

        g.map.set(key, value);
    }
}

// --- the words of a script file ---

/** [A-Za-z0-9_] and [A-Za-z_] by character code */
const WORD = new Uint8Array(128);
const HEAD = new Uint8Array(128);

for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_')
    WORD[c.charCodeAt(0)] = 1;

for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_')
    HEAD[c.charCodeAt(0)] = 1;

/** A word's hash (`h * 31 + c`, 32 bits, as wordRuns.ts). */
export function wordHash(s: string): number
{
    let h = 0;

    for (let i = 0; i < s.length; i++)
        h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;

    return h;
}

/** Whether a name is one word of the shape `/[A-Za-z_][A-Za-z0-9_]*\/g` takes whole. */
export const isTokenName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

/**
 * The hashes of the words of a text, sorted, each once: the matches of `/[A-Za-z_][A-Za-z0-9_]*\/g` in order (libraries.ts `TOKEN`; a
 * run that starts with digits yields its part from the first letter on, as the expression does).
 */
export function wordHashes(text: string): Uint32Array
{
    const seen = new Set<number>();
    const n = text.length;
    let i = 0;

    while (i < n)
    {
        let c = text.charCodeAt(i);

        if (c >= 128 || HEAD[c] === 0)
        {
            i++;
            continue;
        }

        let h = c;

        while (++i < n && (c = text.charCodeAt(i)) < 128 && WORD[c] === 1)
            h = (Math.imul(h, 31) + c) | 0;

        seen.add(h >>> 0);
    }

    return Uint32Array.from(seen).sort();
}

/** The hashes of the words of a file's bytes, sorted, each once: the runs of [A-Za-z0-9_] bytes (any other byte ends one). */
export function byteWordHashes(data: Uint8Array): Uint32Array
{
    const seen = new Set<number>();
    const n = data.length;
    let i = 0;

    while (i < n)
    {
        let c = data[i];

        if (c >= 128 || WORD[c] === 0)
        {
            i++;
            continue;
        }

        let h = c;

        while (++i < n && (c = data[i]) < 128 && WORD[c] === 1)
            h = (Math.imul(h, 31) + c) | 0;

        seen.add(h >>> 0);
    }

    return Uint32Array.from(seen).sort();
}

/** The words of a game file's bytes (`byteWordHashes`, kept per file). */
export const byteWords = (abs: string): Uint32Array | undefined => gameFact('byteWords', abs, byteWordHashes);

/** Whether sorted word hashes hold a hash (`wordHash(name) >>> 0`). */
export function holdsHash(words: Uint32Array, h: number): boolean
{
    let lo = 0;
    let hi = words.length - 1;

    while (lo <= hi)
    {
        const mid = (lo + hi) >> 1;

        if (words[mid] === h)
            return true;

        if (words[mid] < h)
            lo = mid + 1;
        else
            hi = mid - 1;
    }

    return false;
}

/** What the libraries query's pass knows of a game script file without reading it: whether its text is empty, its words. */
export interface ScriptWords
{
    empty: boolean;
    words: Uint32Array;
}

/** The words of a game script file as `GameFiles.readText` reads it (kept per file). */
export const scriptWords = (abs: string): ScriptWords | undefined =>
    gameFact('words', abs, (data) =>
    {
        const text = decodeTextBody(data);
        return { empty: !text, words: text ? wordHashes(text) : new Uint32Array(0) };
    });

/**
 * Words a file must hold one of (by hash): `holds` is false only for a file that has none of them (a hash shared with another word
 * only makes a file read that need not be).
 */
export class WordGate
{
    private readonly hashes: Set<number>;

    constructor(names: Iterable<string>)
    {
        this.hashes = new Set([...names].map((n) => wordHash(n) >>> 0));
    }

    get size(): number
    {
        return this.hashes.size;
    }

    holds(words: Uint32Array): boolean
    {
        if (!this.hashes.size)
            return false;

        // (few names: each looked up in the file's sorted words; else each word of the file in the names)
        if (this.hashes.size * 16 < words.length)
        {
            for (const h of this.hashes)
                if (holdsHash(words, h))
                    return true;

            return false;
        }

        for (let i = 0; i < words.length; i++)
            if (this.hashes.has(words[i]))
                return true;

        return false;
    }
}

// --- the top-level keys of a script file ---

/** The keys of a game script file's top-level statements (`parse` of its text as `GameFiles.readText` reads it), each once, in order. */
export const topKeysOf = (abs: string): string[] | undefined =>
    gameFact('topKeys', abs, (data) =>
    {
        const keys = new Set<string>();

        for (const n of parse(decodeTextBody(data)))
            if (n.k && !keys.has(n.k))
                keys.add(own(n.k));

        return [...keys];
    });
