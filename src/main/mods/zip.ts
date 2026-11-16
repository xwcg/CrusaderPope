/**
 * Zip archives of packed mods (docs/mods.md): read entries on demand (central directory, stored/deflate, ZIP64
 * sizes), and write archives (deflate, streamed, ZIP64 when needed). Plain node:zlib, no dependency.
 */
import { closeSync, createReadStream, createWriteStream, openSync, readSync, fstatSync, readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { pipeline, Readable } from 'node:stream';
import { pipeline as pipe } from 'node:stream/promises';
import { constants as zlib, crc32, createDeflateRaw, createInflateRaw, deflateRawSync, inflateRawSync } from 'node:zlib';

import { tr } from '../../shared/i18n.ts';
export interface ZipEntry
{
    /** path inside the archive, forward slashes */
    name: string;
    method: number;
    compressedSize: number;
    size: number;
    /** offset of the local file header */
    offset: number;
    /** CRC-32 of the uncompressed bytes */
    crc: number;
    /** DOS date/time as ms since epoch */
    mtime: number;
    dir: boolean;
    /** general purpose flag bit 0: its bytes are encrypted */
    encrypted?: boolean;
}

/** Compression methods of zips the reader can't decode (stored 0 and deflate 8 it can), for messages. */
const METHODS: Record<number, string> = { 1: 'Shrink', 6: 'Implode', 9: 'Deflate64', 12: 'BZIP2', 14: 'LZMA', 93: 'Zstandard', 95: 'XZ', 98: 'PPMd', 99: tr('AES encryption') };

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

function dosTime(date: number, time: number): number
{
    const d = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
    return d.getTime();
}

function toDos(ms: number): { date: number; time: number; }
{
    const d = new Date(ms);
    const year = Math.max(1980, d.getFullYear());
    return { date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(), time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1) };
}

/** A zip archive opened for reading; entries are read on demand. */
export class ZipArchive
{
    readonly file: string;
    readonly entries = new Map<string, ZipEntry>();
    /** the central directory lists fewer records than its end record says (damaged): some entries are not known */
    incomplete = false;
    /** names listed again (case aside): only the last of each is in `entries` */
    readonly duplicates: string[] = [];
    /**
     * where the archive starts in the file: its offsets count from there (a game save (docs/saves.md) is a text
     * header and metadata with the zip after them)
     */
    readonly base: number;
    private fd: number | null;

    constructor(file: string, base = 0)
    {
        this.file = file;
        this.base = base;
        this.fd = openSync(file, 'r');

        try
        {
            this.readDirectory();
        }
        catch (e)
        {
            this.close();
            throw e;
        }
    }

    private read(pos: number, len: number): Buffer
    {
        const buf = Buffer.alloc(len);
        let done = 0;

        while (done < len)
        {
            const n = readSync(this.fd!, buf, done, len - done, pos + done);

            if (n <= 0)
                break;

            done += n;
        }

        return buf.subarray(0, done);
    }

    private readDirectory(): void
    {
        const size = fstatSync(this.fd!).size;
        // end of central directory: the last 22 bytes plus up to 64 KB of comment
        const tail = this.read(Math.max(0, size - 65557), Math.min(size, 65557));
        let at = -1;

        for (let i = tail.length - 22; i >= 0; i--)
        {
            if (tail.readUInt32LE(i) === EOCD)
            {
                at = i;
                break;
            }
        }

        if (at < 0)
            throw new Error(tr('Not a zip archive: ') + this.file);

        let count = tail.readUInt16LE(at + 10);
        let cdSize = tail.readUInt32LE(at + 12);
        let cdOffset = tail.readUInt32LE(at + 16) + this.base;

        // ZIP64: the locator sits right before the classic record
        if (at >= 20 && tail.readUInt32LE(at - 20) === EOCD64_LOCATOR)
        {
            const rec = this.read(Number(tail.readBigUInt64LE(at - 12)) + this.base, 56);

            if (rec.readUInt32LE(0) === EOCD64)
            {
                count = Number(rec.readBigUInt64LE(32));
                cdSize = Number(rec.readBigUInt64LE(40));
                cdOffset = Number(rec.readBigUInt64LE(48)) + this.base;
            }
        }

        const cd = this.read(cdOffset, cdSize);
        let p = 0;
        let i = 0;

        for (; i < count && p + 46 <= cd.length; i++)
        {
            if (cd.readUInt32LE(p) !== CEN)
                break;

            const flags = cd.readUInt16LE(p + 8);
            const method = cd.readUInt16LE(p + 10);
            const time = cd.readUInt16LE(p + 12);
            const date = cd.readUInt16LE(p + 14);
            let compressedSize = cd.readUInt32LE(p + 20);
            let usize = cd.readUInt32LE(p + 24);
            const nameLen = cd.readUInt16LE(p + 28);
            const extraLen = cd.readUInt16LE(p + 30);
            const commentLen = cd.readUInt16LE(p + 32);
            let offset = cd.readUInt32LE(p + 42);
            const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
            // bit 11: UTF-8 names; older tools write code page 437, which is ASCII for the paths mods use
            const name = (flags & 0x800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1')).replace(/\\/g, '/');
            // ZIP64 extra field: the 0xFFFFFFFF sizes/offset follow in this order
            let e = p + 46 + nameLen;
            const end = e + extraLen;

            while (e + 4 <= end)
            {
                const id = cd.readUInt16LE(e);
                const len = cd.readUInt16LE(e + 2);

                if (id === 1)
                {
                    let q = e + 4;

                    if (usize === 0xffffffff)
                    {
                        usize = Number(cd.readBigUInt64LE(q));
                        q += 8;
                    }

                    if (compressedSize === 0xffffffff)
                    {
                        compressedSize = Number(cd.readBigUInt64LE(q));
                        q += 8;
                    }

                    if (offset === 0xffffffff)
                        offset = Number(cd.readBigUInt64LE(q));
                }

                e += 4 + len;
            }

            const entry: ZipEntry = { name, method, compressedSize, size: usize, offset: offset + this.base, crc: cd.readUInt32LE(p + 16), mtime: dosTime(date, time), dir: name.endsWith('/') };

            if (flags & 1)
                entry.encrypted = true;

            if (this.entries.has(name.toLowerCase()))
                this.duplicates.push(name);

            this.entries.set(name.toLowerCase(), entry);
            p += 46 + nameLen + extraLen + commentLen;
        }

        this.incomplete = i < count;
    }

    /** File entries (no directories), names as stored. */
    files(): ZipEntry[]
    {
        return [...this.entries.values()].filter((e) => !e.dir);
    }

    get(name: string): ZipEntry | undefined
    {
        return this.entries.get(name.replace(/\\/g, '/').toLowerCase());
    }

    /** Where an entry's (compressed) bytes start: after its local header, whose name and extra field may differ. */
    private dataStart(e: ZipEntry): number | undefined
    {
        const head = this.read(e.offset, 30);

        if (head.length < 30 || head.readUInt32LE(0) !== LOC)
            return undefined;

        return e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    }

    /**
     * Why an entry's bytes can't be read (encrypted, a compression method other than stored / deflate, no local header
     * where the directory says), or undefined.
     */
    entryProblem(e: ZipEntry): string | undefined
    {
        if (e.encrypted)
            return tr('it is encrypted');

        if (e.method !== 0 && e.method !== 8)
            return tr('it is compressed with a method the app can\'t read ({value})', { value: METHODS[e.method] ?? 'method ' + e.method });

        if (this.dataStart(e) === undefined)
            return tr('the zip is damaged there (no file header where its list says)');

        return undefined;
    }

    /**
     * The entry's bytes, or undefined if missing, encrypted or of an unsupported method. Inflating stops at its
     * declared size (a damaged or crafted entry can't inflate to gigabytes: it throws).
     */
    readEntry(entry: ZipEntry | string): Buffer | undefined
    {
        const e = typeof entry === 'string' ? this.get(entry) : entry;

        if (!e || e.dir || e.encrypted || this.fd === null)
            return undefined;

        const at = this.dataStart(e);

        if (at === undefined)
            return undefined;

        const raw = this.read(at, e.compressedSize);

        if (e.method === 0)
            return raw;

        if (e.method === 8)
            return inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) });

        return undefined;
    }

    /**
     * The first `n` bytes of the entry (a copy: nothing of the inflated entry stays alive), or undefined as readEntry. Reads
     * and inflates only as much of the entry as that takes: a texture of 20 MB is asked for its 148-byte header.
     */
    readHead(entry: ZipEntry | string, n: number): Buffer | undefined
    {
        const e = typeof entry === 'string' ? this.get(entry) : entry;

        if (!e || e.dir || e.encrypted || this.fd === null || n <= 0)
            return undefined;

        const at = this.dataStart(e);

        if (at === undefined)
            return undefined;

        const want = Math.min(n, e.size);

        if (e.method === 0)
            return Buffer.from(this.read(at, Math.min(want, e.compressedSize)));

        if (e.method !== 8)
            return undefined;

        // (a prefix of the deflate stream inflates up to where it was cut; the prefix grows until it holds enough)
        for (let take = Math.min(e.compressedSize, 1 << 14); ; take = Math.min(e.compressedSize, take * 4))
        {
            const out = inflateRawSync(this.read(at, take), { finishFlush: zlib.Z_SYNC_FLUSH, maxOutputLength: Math.max(1, e.size) });

            if (out.length >= want || take >= e.compressedSize)
                return Buffer.from(out.subarray(0, want));
        }
    }

    /** The entry's bytes as a stream (entries too big for memory), or undefined as readEntry. */
    stream(e: ZipEntry): Readable | undefined
    {
        const at = e.dir || e.encrypted || this.fd === null || (e.method !== 0 && e.method !== 8) ? undefined : this.dataStart(e);

        if (at === undefined)
            return undefined;

        const raw = e.compressedSize ? createReadStream(this.file, { start: at, end: at + e.compressedSize - 1, highWaterMark: 1 << 20 }) : Readable.from([]);

        if (e.method === 0)
            return raw;

        const inflate = createInflateRaw();
        // (an error of either ends up on the stream returned)
        pipeline(raw, inflate, () =>
        {});
        return inflate;
    }

    close(): void
    {
        if (this.fd !== null)
            closeSync(this.fd);

        this.fd = null;
    }
}

// ---------------------------------------------------------------------------
// Archives kept open while a job reads many entries (a migration plans a mod file by file: opening the archive per
// file parses its whole central directory again, 16 ms at 12,000 entries, 86 s for a plan of 6,000 files)
// ---------------------------------------------------------------------------

const held = new Map<string, ZipArchive>();
let holds = 0;

/** Runs `work` with the archives `withZip` opens kept open until the last such job ends (jobs may nest and overlap). */
export async function holdingZips<T>(work: () => Promise<T>): Promise<T>
{
    holds++;

    try
    {
        return await work();
    }
    finally
    {
        if (--holds === 0)
        {
            for (const z of held.values())
                z.close();

            held.clear();
        }
    }
}

/**
 * Uses the archive `file`: the one kept open when a job holds archives (`holdingZips`; the archive must not change in the
 * meantime), else opened for this call alone.
 */
export function withZip<T>(file: string, use: (zip: ZipArchive) => T): T
{
    if (holds > 0)
    {
        const key = process.platform === 'win32' ? file.toLowerCase() : file;
        let z = held.get(key);

        if (!z)
            held.set(key, z = new ZipArchive(file));

        return use(z);
    }

    const z = new ZipArchive(file);

    try
    {
        return use(z);
    }
    finally
    {
        z.close();
    }
}

// ---------------------------------------------------------------------------
// Writing: entries streamed one after the other (a file is never read whole unless small), ZIP64 records where
// sizes, offsets or the entry count do not fit the classic fields
// ---------------------------------------------------------------------------

/** A file to put into a zip: bytes in memory, a file on disk, or a stream of `size` bytes (opened again when needed). */
export interface ZipSource
{
    /** path inside the archive (forward slashes) */
    name: string;
    data?: Buffer;
    file?: string;
    open?: () => Iterable<Buffer> | AsyncIterable<Buffer> | Readable;
    /** bytes (`open` sources; files: their size now) */
    size?: number;
    mtime?: number;
    /** stored without trying to compress (already compressed formats) */
    store?: boolean;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** files up to this size are read and compressed in one go (faster for the many small files of a mod) */
const SMALL = 4 << 20;
/** formats that are compressed already: deflating them costs time and gains nothing */
const COMPRESSED = /\.(png|jpe?g|webp|gif|ogg|mp3|wem|bank|bk2|bik|zip|7z|rar|gz|xz|bz2)$/i;

/** Little-endian record writer. */
class Rec
{
    readonly buf: Buffer;
    private at = 0;

    constructor(size: number)
    {
        this.buf = Buffer.alloc(size);
    }

    u16(v: number): this
    {
        this.buf.writeUInt16LE(v, this.at);
        this.at += 2;
        return this;
    }

    u32(v: number): this
    {
        this.buf.writeUInt32LE(v >>> 0, this.at);
        this.at += 4;
        return this;
    }

    u64(v: number): this
    {
        this.buf.writeBigUInt64LE(BigInt(v), this.at);
        this.at += 8;
        return this;
    }

    bytes(b: Buffer): this
    {
        b.copy(this.buf, this.at);
        this.at += b.length;
        return this;
    }
}

/** The ZIP64 extra field (id 1) with the values given, in the order the format wants them (size, compressed, offset). */
function zip64Extra(values: number[]): Buffer
{
    const r = new Rec(4 + 8 * values.length).u16(1).u16(8 * values.length);

    for (const v of values)
        r.u64(v);

    return r.buf;
}

function localHeader(name: Buffer, method: number, time: number, date: number, crc: number, csize: number, usize: number, zip64: boolean): Buffer
{
    const extra = zip64 ? zip64Extra([usize, csize]) : Buffer.alloc(0);
    return new Rec(30 + name.length + extra.length)
        .u32(LOC)
        .u16(zip64 ? 45 : 20)
        .u16(0x800)
        .u16(method)
        .u16(time)
        .u16(date)
        .u32(crc)
        .u32(zip64 ? MAX32 : csize)
        .u32(zip64 ? MAX32 : usize)
        .u16(name.length)
        .u16(extra.length)
        .bytes(name)
        .bytes(extra).buf;
}

function centralHeader(name: Buffer, method: number, time: number, date: number, crc: number, csize: number, usize: number, offset: number): Buffer
{
    const big = [usize, csize, offset].map((v) => v >= MAX32);
    const extra = big.some(Boolean) ? zip64Extra([usize, csize, offset].filter((_, i) => big[i])) : Buffer.alloc(0);
    const version = extra.length ? 45 : 20;
    return new Rec(46 + name.length + extra.length)
        .u32(CEN)
        .u16(version)
        .u16(version)
        .u16(0x800)
        .u16(method)
        .u16(time)
        .u16(date)
        .u32(crc)
        .u32(big[1] ? MAX32 : csize)
        .u32(big[0] ? MAX32 : usize)
        .u16(name.length)
        .u16(extra.length)
        .u16(0)
        .u16(0)
        .u16(0)
        .u32(0)
        .u32(big[2] ? MAX32 : offset)
        .bytes(name)
        .bytes(extra).buf;
}

/** The end records: ZIP64 end of central directory + locator when the count, size or offset overflow, then the classic one. */
function endRecords(count: number, cdSize: number, cdOffset: number): Buffer
{
    const zip64 = count >= MAX16 || cdSize >= MAX32 || cdOffset >= MAX32;
    const parts: Buffer[] = [];

    if (zip64)
    {
        const at = cdOffset + cdSize;
        parts.push(
            new Rec(56)
                .u32(EOCD64)
                .u64(44)
                .u16(45)
                .u16(45)
                .u32(0)
                .u32(0)
                .u64(count)
                .u64(count)
                .u64(cdSize)
                .u64(cdOffset).buf,
            new Rec(20)
                .u32(EOCD64_LOCATOR)
                .u32(0)
                .u64(at)
                .u32(1).buf
        );
    }

    parts.push(
        new Rec(22)
            .u32(EOCD)
            .u16(0)
            .u16(0)
            .u16(Math.min(count, MAX16))
            .u16(Math.min(count, MAX16))
            .u32(Math.min(cdSize, MAX32))
            .u32(Math.min(cdOffset, MAX32))
            .u16(0).buf
    );
    return Buffer.concat(parts);
}

/** The bytes of a source, in chunks. */
function chunksOf(src: ZipSource): AsyncIterable<Buffer> | Iterable<Buffer>
{
    if (src.data)
        return [src.data];

    if (src.file)
        return createReadStream(src.file, { highWaterMark: 1 << 20 });

    if (src.open)
        return src.open();

    throw new Error(tr('No data for ') + src.name);
}

/**
 * Writes a zip: each entry deflated (stored when that is not smaller, or when its format is compressed already).
 * Small files are read whole and written complete, gathered into ~1 MB writes; larger ones are streamed in 1 MB
 * chunks (their local header is written first and completed after the data: CRC, sizes), so memory stays flat for
 * any size. ZIP64 fields for entries of 4 GB or more, offsets past 4 GB and more than 65,534 entries. Names with
 * forward slashes, UTF-8.
 */
export async function writeZip(outFile: string, sources: ZipSource[]): Promise<{ bytes: number; }>
{
    mkdirSync(dirname(outFile), { recursive: true });
    const fh = await open(outFile, 'w');
    const central: Buffer[] = [];
    // `pos`: the end of what is written or waiting in `queued`
    let pos = 0;
    let bytes = 0;
    const queued: Buffer[] = [];
    let queuedBytes = 0;
    const writeAt = async (b: Buffer, at: number): Promise<void> =>
    {
        let done = 0;

        while (done < b.length)
            done += (await fh.write(b, done, b.length - done, at + done)).bytesWritten;
    };
    const flush = async (): Promise<void> =>
    {
        if (!queuedBytes)
            return;

        const b = queued.length === 1 ? queued[0] : Buffer.concat(queued);
        const at = pos - queuedBytes;
        queued.length = 0;
        queuedBytes = 0;
        await writeAt(b, at);
    };
    const append = async (b: Buffer): Promise<void> =>
    {
        queued.push(b);
        queuedBytes += b.length;
        pos += b.length;

        if (queuedBytes >= 1 << 20)
            await flush();
    };
    // (streamed entries: straight to the file)
    const put = async (b: Buffer): Promise<void> =>
    {
        await writeAt(b, pos);
        pos += b.length;
    };

    try
    {
        for (const src of sources)
        {
            const name = Buffer.from(src.name.replace(/\\/g, '/'), 'utf8');
            const size = src.data?.length ?? src.size ?? (src.file ? statSync(src.file).size : 0);
            const { date, time } = toDos(src.mtime ?? (src.file ? statSync(src.file).mtimeMs : Date.now()));
            const localAt = pos;
            let method = src.store || COMPRESSED.test(src.name) ? 0 : 8;

            if (size <= SMALL && (src.data || src.file))
            {
                const data = src.data ?? readFileSync(src.file!);
                const crc = crc32(data) >>> 0;
                const deflated = method === 8 ? deflateRawSync(data, { level: 6 }) : undefined;

                if (!deflated || deflated.length >= data.length)
                    method = 0;

                const body = method === 8 ? deflated! : data;
                await append(localHeader(name, method, time, date, crc, body.length, data.length, false));
                await append(body);
                central.push(centralHeader(name, method, time, date, crc, body.length, data.length, localAt));
                bytes += data.length;
                continue;
            }

            await flush();
            // the local header's size must be known before the data: ZIP64 when the entry is 4 GB or more (stored
            // when deflating does not make it smaller, so the compressed size never exceeds the size)
            const zip64 = size >= MAX32;
            await put(localHeader(name, 0, time, date, 0, 0, 0, zip64));
            const dataAt = pos;
            let crc = 0;
            let usize = 0;
            const run = async (how: number): Promise<void> =>
            {
                pos = dataAt;
                crc = 0;
                usize = 0;

                if (how === 0)
                {
                    for await (const c of chunksOf(src))
                    {
                        crc = crc32(c, crc);
                        usize += c.length;
                        await put(c);
                    }

                    return;
                }

                const deflate = createDeflateRaw({ level: 6 });
                const feed = (async (): Promise<void> =>
                {
                    for await (const c of chunksOf(src))
                    {
                        crc = crc32(c, crc);
                        usize += c.length;

                        if (!deflate.write(c))
                            await once(deflate, 'drain');
                    }

                    deflate.end();
                })().catch((e: unknown) =>
                {
                    deflate.destroy(e as Error);
                });

                for await (const out of deflate)
                    await put(out as Buffer);

                await feed;
            };
            await run(method);

            // not smaller: stored after all (the source read again, written over the deflated bytes)
            if (method === 8 && pos - dataAt >= usize)
            {
                method = 0;
                await run(0);
            }

            const csize = pos - dataAt;

            if (usize >= MAX32 && !zip64)
                throw new Error(tr('{name} grew while it was packed.', { name: src.name }));

            await writeAt(localHeader(name, method, time, date, crc >>> 0, csize, usize, zip64), localAt);
            central.push(centralHeader(name, method, time, date, crc >>> 0, csize, usize, localAt));
            bytes += usize;
        }

        const cdOffset = pos;
        let cdSize = 0;

        for (const c of central)
        {
            await append(c);
            cdSize += c.length;
        }

        await append(endRecords(central.length, cdSize, cdOffset));
        await flush();
        // (a stored rewrite may have left bytes beyond the end)
        await fh.truncate(pos);
    }
    finally
    {
        await fh.close();
    }

    return { bytes };
}

function walk(dir: string, out: string[] = []): string[]
{
    for (const d of readdirSync(dir, { withFileTypes: true }))
    {
        const p = join(dir, d.name);

        if (d.isDirectory())
            walk(p, out);
        else if (d.isFile())
            out.push(p);
    }

    return out;
}

/** Packs a mod folder into a zip (paths relative to the folder), file by file. `skip` filters relative paths out. */
export async function packFolder(dir: string, outFile: string, skip?: (rel: string) => boolean): Promise<{ files: number; bytes: number; }>
{
    const files = walk(dir)
        .map((abs) => ({ abs, rel: relative(dir, abs).split(sep).join('/') }))
        .filter((f) => !skip?.(f.rel))
        .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const { bytes } = await writeZip(outFile, files.map((f) => ({ name: f.rel, file: f.abs })));
    return { files: files.length, bytes };
}

/** Windows' reserved device names (a file `nul` or `con.txt` would be the device, not a file). */
const DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/**
 * Why an entry's name can't be a file inside the folder it is unpacked to, or undefined: a `..` segment, an absolute
 * path or drive letter, a colon (an alternate data stream on Windows), characters or names Windows can't hold.
 * (`..foo/x` is a name like any other.)
 */
export function entryNameProblem(name: string): string | undefined
{
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name))
        return tr('an absolute path');

    const parts = name.split('/').filter((p) => p !== '' && p !== '.');

    if (parts.includes('..'))
        return tr('a path that leads out of the folder (..)');

    if (name.includes(':'))
        return tr('a colon in its name');

    if (/[<>"|?*\u0000-\u001f]/.test(name))
        return tr('characters Windows does not allow in file names');

    if (parts.some((p) => DEVICE.test(p) || /[. ]$/.test(p)))
        return tr('a name Windows does not allow');

    return parts.length ? undefined : tr('no file name');
}

/**
 * Unpacks a zip into a folder (created if needed), entry by entry, large ones streamed. All or nothing: every entry
 * must be read and written; one it can't (a name that would leave the folder or Windows can't hold, encryption, a
 * compression method other than stored / deflate, no local header, more or fewer bytes than declared, a checksum
 * that does not match, an incomplete directory, a name listed twice) fails the unpack with the reason; the caller
 * removes what was written (manager.ts unpackMod).
 */
export async function unpackZip(file: string, dir: string): Promise<{ files: number; }>
{
    const zip = new ZipArchive(file);
    const where = (e: ZipEntry): string => tr('{name} in {basename}', { name: e.name, basename: basename(file) });
    let n = 0;

    try
    {
        if (zip.incomplete)
            throw new Error(tr('{basename} is damaged: its list of files is incomplete.', { basename: basename(file) }));

        if (zip.duplicates.length)
            throw new Error(tr('{basename} lists {value} twice (letter case aside): one would overwrite the other.', { basename: basename(file), value: zip.duplicates[0] }));

        const entries = zip.files();

        // (checked before anything is written)
        for (const e of entries)
        {
            const bad = entryNameProblem(e.name);

            if (bad)
                throw new Error(tr('{where} can\'t be unpacked: {bad}.', { where: where(e), bad }));

            const unreadable = zip.entryProblem(e);

            if (unreadable)
                throw new Error(tr('{where} can\'t be unpacked: {unreadable}.', { where: where(e), unreadable }));
        }

        for (const e of entries)
        {
            const target = join(dir, ...e.name.split('/'));
            mkdirSync(dirname(target), { recursive: true });
            let crc = 0;
            let size = 0;

            if (e.size <= SMALL)
            {
                let data: Buffer | undefined;

                try
                {
                    data = zip.readEntry(e);
                }
                catch (x)
                {
                    const over = (x as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE';
                    throw new Error(tr('{where} is damaged ({value}).', { where: where(e), value: over ? 'more bytes than its size' : (x as Error).message }));
                }

                if (!data)
                    throw new Error(tr('{where} can\'t be read.', { where: where(e) }));

                crc = crc32(data);
                size = data.length;
                writeFileSync(target, data);
            }
            else
            {
                const s = zip.stream(e);

                if (!s)
                    throw new Error(tr('{where} can\'t be read.', { where: where(e) }));

                await pipe(
                    s,
                    async function*(chunks: AsyncIterable<Buffer>)
                    {
                        for await (const c of chunks)
                        {
                            size += c.length;

                            // (a damaged or crafted entry inflating past its size stops here)
                            if (size > e.size)
                                throw new Error(tr('{where} is damaged (more bytes than its size).', { where: where(e) }));

                            crc = crc32(c, crc);
                            yield c;
                        }
                    },
                    createWriteStream(target)
                );
            }

            if (size !== e.size)
                throw new Error(tr('{where} is damaged ({size} bytes instead of {size2}).', { where: where(e), size, size2: e.size }));

            if (crc >>> 0 !== e.crc >>> 0)
                throw new Error(tr('{where} is damaged (its checksum does not match).', { where: where(e) }));

            n++;
        }
    }
    finally
    {
        zip.close();
    }

    return { files: n };
}
