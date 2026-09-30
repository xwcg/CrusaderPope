/**
 * On-disk cache of a built GameIndex (docs/indexer.md, "Index cache").
 *
 * Layout: 4-byte header length, a JSON header (magic, fingerprint, column table), then the columns, each 8-byte
 * aligned: typed arrays as their raw bytes (views on load, no parsing), string arrays as one NUL-joined UTF-8 run
 * (split natively on load), anything else as JSON. A cache with another fingerprint is rejected after reading only
 * the header. (v8.serialize of the whole state crashed the process natively — no exception — hence this format.)
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IndexState } from './gameIndex.ts';

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
    columns?: Column[];
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
 * The state as parts for the writer thread (cacheWriter.ts): typed arrays as their bytes — `transfer` lists their
 * buffers, so they move without a copy — string arrays joined with NUL (one big string clones fast), the rest JSON.
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
                parts.push({ key, kind: 'strings:' + list.length, data: list.join('\0') });
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

function decode(buf: Buffer, body: number, columns: Column[]): Record<string, unknown>
{
    const out: Record<string, unknown> = {};

    for (const c of columns)
    {
        const start = body + c.off;
        let v: unknown;

        if (c.kind.startsWith('strings:'))
            v = Number(c.kind.slice(8)) ? buf.toString('utf8', start, start + c.len).split('\0') : [];
        else if (c.kind === 'json')
            v = JSON.parse(buf.toString('utf8', start, start + c.len));
        else
        {
            const T = TYPED[c.kind];

            if (!T)
                throw new Error('Unknown column kind ' + c.kind);

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
export function writeIndexCache(file: string, fingerprint: string, state: IndexState): Promise<void>
{
    return writeCacheParts(file, fingerprint, cacheParts(state).parts);
}

/** Encodes the parts (UTF-8, 8-byte aligned columns) and writes header + columns — in the writer thread. */
export async function writeCacheParts(file: string, fingerprint: string, parts: CachePart[]): Promise<void>
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

    const header = Buffer.from(JSON.stringify({ magic: MAGIC, fingerprint, written: new Date().toISOString(), columns }), 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(header.length, 0);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    const fh = await open(tmp, 'w');

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

export function deleteIndexCache(file: string): void
{
    rmSync(file, { force: true });
    rmSync(file + '.tmp', { force: true });
}
