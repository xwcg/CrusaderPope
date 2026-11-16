/**
 * On-disk cache of a built GameIndex (docs/indexer.md, "Index cache").
 *
 * Layout: 4-byte header length, a JSON header (magic, fingerprint, column table), then the columns, each 8-byte
 * aligned: typed arrays as their raw bytes (views on load, no parsing), string arrays as one NUL-joined UTF-8 run
 * (split natively on load), anything else as JSON. A cache with another fingerprint is rejected after reading only
 * the header. (v8.serialize of the whole state crashed the process natively, with no exception, hence this format.)
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, utimesSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { threadId, Worker } from 'node:worker_threads';
import type { IndexState } from './gameIndex.ts';
import { onWorkerGone } from '../workerGuard.ts';

import { tr } from '../../shared/i18n.ts';
const MAGIC = 'crusaderpope-index-3';

interface Column
{
    key: string;
    /** typed array constructor name, `strings:<count>` or `json` */
    kind: string;
    off: number;
    len: number;
}

interface Header
{
    magic?: string;
    fingerprint?: string;
    /** the code the cache was written by (CacheOptions.code: indexer, app version, language): another can never hit */
    code?: string;
    /** the layering key the file is named by (cacheFileFor) */
    layer?: string;
    columns?: Column[];
}

/** What a write puts into the header beside the fingerprint (the prune reads it). */
export interface CacheMeta
{
    code: string;
    layer: string;
}

const TYPED: Record<string, { new(buf: ArrayBufferLike, off: number, len: number): ArrayBufferView; BYTES_PER_ELEMENT: number; }> = {
    Int8Array,
    Uint8Array,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array
};

const align8 = (n: number): number => (n + 7) & ~7;

/** One column before encoding: raw bytes of a typed array, or text (pre-joined strings / JSON). */
export interface CachePart
{
    key: string;
    kind: string;
    data: Uint8Array | string;
}

/**
 * The state as parts for the writer thread (cacheWriter.ts): typed arrays as their bytes (`transfer` lists their
 * buffers, so they move without a copy), string arrays joined with NUL and encoded to UTF-8 here (bytes outside the
 * heap that all threads share, transferred too: as strings they were a 160 MB copy in this heap, and another in the
 * writer's, with AGOT), the rest JSON.
 */
export function cacheParts(state: IndexState): { parts: CachePart[]; transfer: ArrayBuffer[]; }
{
    const parts: CachePart[] = [];
    const transfer: ArrayBuffer[] = [];
    const visit = (key: string, v: unknown): void =>
    {
        if (ArrayBuffer.isView(v))
        {
            parts.push({ key, kind: v.constructor.name, data: new Uint8Array(v.buffer, v.byteOffset, v.byteLength) });

            if (!transfer.includes(v.buffer as ArrayBuffer))
                transfer.push(v.buffer as ArrayBuffer);
        }
        else if (Array.isArray(v) && v.every((x) => typeof x === 'string'))
        {
            const list = v as string[];

            if (list.some((s) => s.includes('\0')))
                parts.push({ key, kind: 'json', data: JSON.stringify(list) });
            else
            {
                const data = encodeStrings(list);
                parts.push({ key, kind: 'strings:' + list.length, data });
                transfer.push(data.buffer as ArrayBuffer);
            }
        }
        else if (v && typeof v === 'object' && !Array.isArray(v))
        {
            for (const [k, x] of Object.entries(v))
                visit(key ? key + '.' + k : k, x);
        }
        else
            parts.push({ key, kind: 'json', data: JSON.stringify(v) });
    };
    visit('', state);
    return { parts, transfer };
}

/** The strings joined with NUL, as UTF-8 in a buffer of its own (never a slice of Node's shared pool: it gets transferred). */
function encodeStrings(list: string[]): Uint8Array
{
    // (in pieces: the whole joined string would be the big copy this avoids)
    const STEP = 16384;
    const pieces: Buffer[] = [];
    let total = 0;

    for (let i = 0; i < list.length; i += STEP)
    {
        const b = Buffer.from(list.slice(i, i + STEP).join('\0') + (i + STEP < list.length ? '\0' : ''), 'utf8');
        pieces.push(b);
        total += b.length;
    }

    const out = new Uint8Array(total);
    let at = 0;

    for (const b of pieces)
    {
        out.set(b, at);
        at += b.length;
    }

    return out;
}

/**
 * The columns as the state's object tree. Throws on a column outside the file or of the wrong shape (a file cut short,
 * a corrupt header): typed views would throw anyway, but `buf.toString` clamps its range, so a short string column
 * would load silently with fewer entries than the state's other columns expect.
 */
function decode(buf: Buffer, body: number, columns: Column[]): Record<string, unknown>
{
    const out: Record<string, unknown> = {};

    for (const c of columns)
    {
        if (!c || typeof c.key !== 'string' || typeof c.kind !== 'string' || !Number.isSafeInteger(c.off) || !Number.isSafeInteger(c.len) || c.off < 0 || c.len < 0)
            throw new Error(tr('Bad cache column {column}', { column: JSON.stringify(c) }));

        const start = body + c.off;

        if (start + c.len > buf.length)
            throw new Error(tr('Cache column {column} runs past the end of the file', { column: c.key }));

        let v: unknown;

        if (c.kind.startsWith('strings:'))
        {
            const count = Number(c.kind.slice(8));

            if (!Number.isSafeInteger(count) || count < 0)
                throw new Error(tr('Bad string count in cache column {column}', { column: c.key }));

            const list = count ? buf.toString('utf8', start, start + c.len).split('\0') : [];

            if (list.length !== count || (!count && c.len))
                throw new Error(tr('Cache column {column} holds {found} strings, not {count}', { column: c.key, found: list.length, count }));

            v = list;
        }
        else if (c.kind === 'json')
            v = JSON.parse(buf.toString('utf8', start, start + c.len));
        else
        {
            const T = TYPED[c.kind];

            if (!T)
                throw new Error(tr('Unknown column kind ') + c.kind);

            if (c.len % T.BYTES_PER_ELEMENT)
                throw new Error(tr('Cache column {column} is not a whole number of {kind} elements', { column: c.key, kind: c.kind }));

            const abs = buf.byteOffset + start;
            // a view on the file buffer when aligned, else a copy
            v = abs % T.BYTES_PER_ELEMENT === 0 ? new T(buf.buffer, abs, c.len / T.BYTES_PER_ELEMENT) : new T(buf.buffer.slice(abs, abs + c.len), 0, c.len / T.BYTES_PER_ELEMENT);
        }

        const path = c.key.split('.');
        let o = out;

        for (const p of path.slice(0, -1))
            o = (o[p] ??= {}) as Record<string, unknown>;

        o[path[path.length - 1]] = v;
    }

    return out;
}

function readHeader(file: string): { size: number; header: Header; } | null
{
    const fd = openSync(file, 'r');

    try
    {
        const len = Buffer.alloc(4);

        if (readSync(fd, len, 0, 4, 0) !== 4)
            return null;

        const size = len.readUInt32LE(0);

        if (size > 1 << 20)
            return null;

        const buf = Buffer.alloc(size);

        if (readSync(fd, buf, 0, size, 4) !== size)
            return null;

        return { size, header: JSON.parse(buf.toString('utf8')) as Header };
    }
    finally
    {
        closeSync(fd);
    }
}

/** The cached state if the file exists and was written for this fingerprint, else null. */
export function readIndexCache(file: string, fingerprint: string): IndexState | null
{
    try
    {
        if (!existsSync(file))
            return null;

        const h = readHeader(file);

        if (!h || h.header.magic !== MAGIC || h.header.fingerprint !== fingerprint || !h.header.columns)
            return null;

        return decode(readFileSync(file), align8(4 + h.size), h.header.columns) as unknown as IndexState;
    }
    catch
    {
        return null;
    }
}

/** Writes via a temporary file and a rename, so an interrupted write never leaves a half cache behind. */
export function writeIndexCache(file: string, fingerprint: string, state: IndexState, meta?: CacheMeta): Promise<void>
{
    return writeCacheParts(file, fingerprint, cacheParts(state).parts, meta);
}

/** Encodes the parts (UTF-8, 8-byte aligned columns) and writes header + columns, in the writer thread. */
export async function writeCacheParts(file: string, fingerprint: string, parts: CachePart[], meta?: CacheMeta): Promise<void>
{
    const columns: Column[] = [];
    const chunks: Buffer[] = [];
    let off = 0;

    for (const p of parts)
    {
        const buf = typeof p.data === 'string' ? Buffer.from(p.data, 'utf8') : Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength);
        const pad = align8(off) - off;

        if (pad)
            chunks.push(Buffer.alloc(pad));

        off += pad;
        columns.push({ key: p.key, kind: p.kind, off, len: buf.length });
        chunks.push(buf);
        off += buf.length;
    }

    const header = Buffer.from(JSON.stringify({ magic: MAGIC, fingerprint, code: meta?.code, layer: meta?.layer, written: new Date().toISOString(), columns }), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(header.length, 0);
    mkdirSync(dirname(file), { recursive: true });
    // (a name of this write's own: two writers never share a temporary file; leftovers are removed below)
    const tmp = `${file}.${process.pid}.${threadId}.${++tmpCount}.tmp`;
    const fh = await open(tmp, 'w');

    try
    {
        try
        {
            await fh.write(len);
            await fh.write(header);
            const pad = align8(4 + header.length) - (4 + header.length);

            if (pad)
                await fh.write(Buffer.alloc(pad));

            for (const c of chunks)
                await fh.write(c);
        }
        finally
        {
            await fh.close();
        }

        await rename(tmp, file);
    }
    catch (e)
    {
        rmSync(tmp, { force: true });
        throw e;
    }

    // (the file is written: a dead process's leftover another process holds must not make it a failed write)
    try
    {
        removeLeftovers(file, false);
    }
    catch
    {
        // (kept until a later run finds it free)
    }
}

/** writes made by this thread (part of the temporary file's name) */
let tmpCount = 0;

/** `<file>.<pid>.<thread>.<n>.tmp`, and `<file>.tmp` of older versions */
function tmpFiles(file: string): { path: string; pid: number | null; thread?: number; }[]
{
    const base = basename(file);
    const out: { path: string; pid: number | null; thread?: number; }[] = [];
    let names: string[];

    try
    {
        names = readdirSync(dirname(file));
    }
    catch
    {
        return out;
    }

    for (const n of names)
    {
        if (n === base + '.tmp')
            out.push({ path: join(dirname(file), n), pid: null });
        else if (n.startsWith(base + '.') && n.endsWith('.tmp'))
        {
            const m = /^(\d+)\.(\d+)\.\d+\.tmp$/.exec(n.slice(base.length + 1));

            if (m)
                out.push({ path: join(dirname(file), n), pid: Number(m[1]), thread: Number(m[2]) });
        }
    }

    return out;
}

function running(pid: number): boolean
{
    try
    {
        process.kill(pid, 0);
        return true;
    }
    catch (e)
    {
        // (EPERM: it runs under another user)
        return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * Removes temporary files of interrupted writes: `all` every one (the cache is being deleted, after the writes queued
 * before), else only those of processes no longer running (a crash mid-write; the files are as big as the cache).
 * This process's own are kept here (another of its threads may be writing one): the owner of the writer threads
 * removes a writer's own once it ended without writing (removeWriterLeftovers). A pid Windows gave to a new process
 * keeps a dead one's file until that process ends too, or the cache is deleted.
 */
function removeLeftovers(file: string, all: boolean): void
{
    for (const t of tmpFiles(file))
    {
        if (all || t.pid === null || (t.pid !== process.pid && !running(t.pid)))
            rmSync(t.path, { force: true });
    }
}

/**
 * The temporary files of one writer thread of this process (its threadId) that ended without a write (an uncaught
 * error, an exit, a failed write: the catch in writeCacheParts may not have run). Never throws: one another process
 * holds (EBUSY / EPERM on Windows, a virus scan of the ~100 MB file) stays until the cache is deleted or a later run
 * of the app finds its pid ended (removeLeftovers).
 */
export function removeWriterLeftovers(file: string, thread: number): void
{
    for (const t of tmpFiles(file))
    {
        if (t.pid !== process.pid || t.thread !== thread)
            continue;

        try
        {
            rmSync(t.path, { force: true });
        }
        catch
        {
            // (kept: see above)
        }
    }
}

/** The cache file and every temporary file of a write to it. */
export function deleteIndexCache(file: string): void
{
    rmSync(file, { force: true });
    removeLeftovers(file, true);
}

// ---------------------------------------------------------------------------
// One cache per layering (docs/indexer.md, "Index cache", "One per mod list")
// ---------------------------------------------------------------------------

/** `index-<key>.bin`: the index of one layering (game folder, language, the mods' identity; GameIndex.layerKey) */
const INDEX_NAME = /^index-([0-9a-f]{16})\.bin$/;
/** a write's temporary file of an index file, this version's or an older one's (`index.bin.tmp`) */
const INDEX_TMP = /^(index(?:-[0-9a-f]{16})?\.bin)\.(?:(\d+)\.\d+\.\d+\.)?tmp$/;
/** the files of the one-file cache of older versions */
const LEGACY_NAMES = ['index.bin', 'script-keys.json', 'shaders.json', 'shaders.json.tmp'];
/** what is kept per layering beside its index, by the same key */
export type CacheSiblingKind = 'script-keys' | 'shaders';
const SIBLING_NAME = /^(script-keys|shaders)-([0-9a-f]{16})\.json(\.tmp)?$/;

/**
 * The index file of a layering: `index-<key>.bin` in the folder of `anchor` (CacheOptions.file, which names the
 * cache folder; its own name is the one file of older versions).
 */
export function cacheFileFor(anchor: string, key: string): string
{
    return join(dirname(anchor), `index-${key}.bin`);
}

/** The layering key of an index file's name, or null (the legacy `index.bin`, another file). */
export function cacheKeyOf(file: string): string | null
{
    return INDEX_NAME.exec(basename(file))?.[1] ?? null;
}

/** A file kept per layering beside an index file (`script-keys-<key>.json`, `shaders-<key>.json`). */
export function cacheSibling(indexFile: string, kind: CacheSiblingKind): string
{
    const key = cacheKeyOf(indexFile);
    return join(dirname(indexFile), key ? `${kind}-${key}.json` : `${kind}.json`);
}

/** A cache hit: the file becomes the most recently used (the prune goes by modification time). */
export function touchIndexCache(file: string): void
{
    try
    {
        const now = new Date();
        utimesSync(file, now, now);
    }
    catch
    {
        // (gone or held: it only ranks lower in the next prune)
    }
}

/** Removes a file; false when it could not be removed (held by another process: kept for a later prune). */
function tryRemove(file: string): boolean
{
    try
    {
        rmSync(file, { force: true });
        return true;
    }
    catch
    {
        return false;
    }
}

/**
 * An index file, every temporary file of a write to it, and its siblings. Never throws: a file another process holds
 * (EBUSY / EPERM, a virus scan of the ~100 MB file) stays, and the next prune tries again. True when the index file
 * is gone.
 */
function deleteLayer(dir: string, key: string): boolean
{
    const file = join(dir, `index-${key}.bin`);

    try
    {
        deleteIndexCache(file);
    }
    catch
    {
        // (held: see above)
    }

    for (const kind of ['script-keys', 'shaders'])
    {
        tryRemove(join(dir, `${kind}-${key}.json`));
        tryRemove(join(dir, `${kind}-${key}.json.tmp`));
    }

    return !existsSync(file);
}

function listDir(dir: string): string[]
{
    try
    {
        return readdirSync(dir);
    }
    catch
    {
        return [];
    }
}

/**
 * The header's code of an index file: null when it has none (written before the header had it, not an index file, a
 * broken header); undefined when the file could not be read this time (held by another process, a virus scan …), so
 * the prune keeps it instead of taking it for another code's file.
 */
function headerCode(file: string): string | null | undefined
{
    try
    {
        const h = readHeader(file);
        return h && h.header.magic === MAGIC && typeof h.header.code === 'string' ? h.header.code : null;
    }
    catch (e)
    {
        // (an error of the file system has a code; a broken header (JSON) has none)
        return typeof (e as NodeJS.ErrnoException | null)?.code === 'string' ? undefined : null;
    }
}

/**
 * Keeps the `keep` most recently used index files of the folder (their modification time: a write or a hit) and their
 * siblings, and never the ones of the keys in `inUse` (the index loaded now, the one being written: kept beyond `keep`
 * if older). Removed at once whatever `keep` says: index files another code wrote (an app update, another app language
 * or an indexer change: they can never hit again; also ones whose header has no code; one that cannot be read at the
 * moment stays, headerCode), the one-file cache of older versions
 * (`index.bin`, `script-keys.json`, `shaders.json`), temporary files of processes no longer running, and siblings whose
 * index is gone (not of a key in use: its index may be on the way). Other files of the folder (the game facts) stay.
 * Run it in the index worker's CacheFileQueue, so it never races a write of the same folder.
 */
export function pruneIndexCaches(dir: string, keep: number, code: string, inUse: string[] = []): { removed: string[]; kept: string[]; }
{
    const removed: string[] = [];
    const used = new Set(inUse);
    const names = listDir(dir);
    const live: { key: string; mtime: number; }[] = [];

    for (const n of names)
    {
        const key = INDEX_NAME.exec(n)?.[1];

        if (!key)
            continue;

        const file = join(dir, n);
        const fileCode = headerCode(file);

        // (another code's file never hits again: removed whatever `keep` says; one that could not be read now counts as
        // a list of its own and is tried again by the next prune)
        if (!used.has(key) && fileCode !== undefined && fileCode !== code)
        {
            if (deleteLayer(dir, key))
                removed.push(key);

            continue;
        }

        let mtime: number;

        try
        {
            mtime = statSync(file).mtimeMs;
        }
        catch
        {
            // (gone meanwhile, or held: left alone this time, not ranked last and dropped)
            continue;
        }

        live.push({ key, mtime });
    }

    // (newest first; the keys in use count towards `keep`, and stay even when older)
    live.sort((a, b) => b.mtime - a.mtime || (a.key < b.key ? -1 : 1));
    const kept: string[] = [];
    const max = Math.max(1, Math.floor(keep) || 1);

    for (const l of live)
    {
        if (used.has(l.key) || kept.length < max)
            kept.push(l.key);
        else if (deleteLayer(dir, l.key))
            removed.push(l.key);
    }

    for (const n of LEGACY_NAMES)
    {
        if (names.includes(n))
            tryRemove(join(dir, n));
    }

    // (temporary files: those of a dead process, any index file's; a live process's write is its own business)
    for (const n of listDir(dir))
    {
        const t = INDEX_TMP.exec(n);

        if (t && (!t[2] || (Number(t[2]) !== process.pid && !running(Number(t[2])))))
            tryRemove(join(dir, n));

        const s = SIBLING_NAME.exec(n);

        if (s && !kept.includes(s[2]) && !used.has(s[2]))
            tryRemove(join(dir, n));
    }

    return { removed, kept };
}

/**
 * Every index cache of the folder (the setting turned off): each layering's index file with its siblings, the one-file
 * cache of older versions, and every temporary file of a write to any of them. Other files of the folder stay.
 */
export function deleteAllIndexCaches(dir: string): void
{
    for (const n of listDir(dir))
    {
        // (one file held by another process does not stop the others)
        if (INDEX_NAME.test(n) || INDEX_TMP.test(n) || SIBLING_NAME.test(n) || LEGACY_NAMES.includes(n))
            tryRemove(join(dir, n));
    }
}

/** What the index caches of the folder take on disk (Settings, "Index caches kept"): bytes, and how many lists. */
export function indexCacheDiskUse(dir: string): { bytes: number; caches: number; }
{
    let bytes = 0;
    let caches = 0;

    for (const n of listDir(dir))
    {
        if (!(INDEX_NAME.test(n) || INDEX_TMP.test(n) || SIBLING_NAME.test(n) || LEGACY_NAMES.includes(n)))
            continue;

        try
        {
            bytes += statSync(join(dir, n)).size;
            caches += INDEX_NAME.test(n) || n === 'index.bin' ? 1 : 0;
        }
        catch
        {
            // (gone meanwhile)
        }
    }

    return { bytes, caches };
}

/**
 * Runs one writer thread (`script`: cacheWriter.ts, which calls writeCacheParts and answers {ok} or {error}) and
 * resolves when it is over, however it ends: its answer (true: written), an uncaught error or an exit without an
 * answer (false; a writer that never answered would hold every later write and delete of a CacheFileQueue). A writer
 * that did not write leaves no temporary file behind (removeWriterLeftovers: removeLeftovers keeps this process's own).
 */
export function runCacheWriter(script: string, job: { file: string; fingerprint: string; parts: CachePart[]; meta?: CacheMeta; }, transfer: ArrayBuffer[] = []): Promise<boolean>
{
    return new Promise((resolve) =>
    {
        const w = new Worker(script);
        // (taken now: a thread that is over has threadId -1)
        const tid = w.threadId;
        let over = false;
        const done = (ok: boolean): void =>
        {
            if (over)
                return;

            over = true;

            // (this runs in the thread's listeners: nothing here may throw past the resolve, or the queue stalls and
            // the index worker ends on an uncaught error)
            try
            {
                if (!ok)
                    removeWriterLeftovers(job.file, tid);

                void w.terminate().catch(() =>
                {});
            }
            finally
            {
                resolve(ok);
            }
        };
        w.once('message', (m: { ok?: boolean; }) => done(!!m?.ok));
        onWorkerGone(w, () => done(false));
        w.postMessage(job, transfer);
    });
}

/**
 * The cache writes and deletes of one file, one after the other: a delete queued behind a write that has started
 * runs after its rename, so a cache turned off never comes back from a writer still running (`job` errors are
 * swallowed: a failed write leaves the queue going).
 */
export class CacheFileQueue
{
    private tail: Promise<void> = Promise.resolve();

    run(job: () => void | Promise<void>): Promise<void>
    {
        const p = this.tail.then(job).catch(() => undefined);
        this.tail = p;
        return p;
    }

    /** Deletes the cache now and again after the writes queued so far. */
    delete(file: string): Promise<void>
    {
        deleteIndexCache(file);
        return this.run(() => deleteIndexCache(file));
    }

    /** Deletes every index cache of the folder now and again after the writes queued so far (deleteAllIndexCaches). */
    deleteAll(dir: string): Promise<void>
    {
        deleteAllIndexCaches(dir);
        return this.run(() => deleteAllIndexCaches(dir));
    }
}
