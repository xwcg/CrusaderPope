/** Minimal PNG encoder (RGBA8, no filtering) and decoder (every standard PNG → RGBA8) using Node's zlib. */
import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() =>
{
    const t = new Uint32Array(256);

    for (let n = 0; n < 256; n++)
    {
        let c = n;

        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

        t[n] = c >>> 0;
    }

    return t;
})();

function crc32(buf: Uint8Array, start: number, end: number): number
{
    let c = 0xffffffff;

    for (let i = start; i < end; i++)
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);

    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer
{
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'latin1');
    b.set(data, 8);
    b.writeUInt32BE(crc32(b, 4, 8 + data.length), 8 + data.length);
    return b;
}

export function encodePng(rgba: Uint8Array, width: number, height: number, level = 3): Buffer
{
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);

    for (let y = 0; y < height; y++)
    {
        raw[y * (stride + 1)] = 0; // filter: none
        raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level })),
        chunk('IEND', new Uint8Array(0))
    ]);
}

export interface PngImage
{
    width: number;
    height: number;
    rgba: Uint8Array;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(buf: Uint8Array): boolean
{
    return buf.length > 8 && PNG_SIG.every((b, i) => buf[i] === b);
}

/** Adam7 passes: x/y start and step */
const ADAM7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2]
];

/**
 * Decodes a PNG to RGBA8: grey, grey+alpha, RGB, RGBA and palette images, 1–16 bits per sample (16-bit samples keep
 * their high byte), tRNS transparency, Adam7 interlacing. Gamma and colour profiles are ignored (the bytes are data).
 */
export function decodePng(input: Uint8Array): PngImage
{
    const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);

    if (!isPng(buf))
        throw new Error('Not a PNG file');

    let pos = 8;
    let width = 0;
    let height = 0;
    let depth = 8;
    let type = 6;
    let interlace = 0;
    let palette: Uint8Array | undefined;
    let trns: Buffer | undefined;
    const idat: Buffer[] = [];

    while (pos + 8 <= buf.length)
    {
        const len = buf.readUInt32BE(pos);
        const kind = buf.toString('latin1', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        pos += 12 + len;

        if (kind === 'IHDR')
        {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8];
            type = data[9];
            interlace = data[12];
        }
        else if (kind === 'PLTE')
            palette = data;
        else if (kind === 'tRNS')
            trns = data;
        else if (kind === 'IDAT')
            idat.push(data);
        else if (kind === 'IEND')
            break;
    }

    if (!width || !height)
        throw new Error('PNG without image header');

    const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];

    if (!channels)
        throw new Error(`Unsupported PNG colour type ${type}`);

    const raw = inflateSync(Buffer.concat(idat));
    const bitsPerPixel = channels * depth;
    const bpp = Math.max(1, bitsPerPixel >> 3);
    const out = new Uint8Array(width * height * 4);
    // (grey/RGB transparency: the one colour tRNS names, in the image's own sample depth)
    const key = trns && type !== 3 ? [0, 1, 2].map((i) => (trns!.length >= i * 2 + 2 ? trns!.readUInt16BE(i * 2) : -1)) : undefined;
    let offset = 0;

    /** one (sub-)image: unfilter its rows, then write its pixels at (x0 + x·dx, y0 + y·dy) */
    const pass = (w: number, h: number, x0: number, y0: number, dx: number, dy: number): void =>
    {
        if (!w || !h)
            return;

        const stride = Math.ceil((w * bitsPerPixel) / 8);
        let prev = new Uint8Array(stride);

        for (let y = 0; y < h; y++)
        {
            const filter = raw[offset];
            const row = new Uint8Array(raw.subarray(offset + 1, offset + 1 + stride));
            offset += 1 + stride;

            for (let i = 0; i < stride; i++)
            {
                const a = i >= bpp ? row[i - bpp] : 0;
                const b = prev[i];
                const c = i >= bpp ? prev[i - bpp] : 0;
                let v = row[i];

                if (filter === 1)
                    v += a;
                else if (filter === 2)
                    v += b;
                else if (filter === 3)
                    v += (a + b) >> 1;
                else if (filter === 4)
                {
                    const p = a + b - c;
                    const pa = Math.abs(p - a);
                    const pb = Math.abs(p - b);
                    const pc = Math.abs(p - c);
                    v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                }

                row[i] = v & 0xff;
            }

            prev = row;
            /** a sample at its full depth */
            const full = (x: number, ch: number): number =>
            {
                if (depth === 8)
                    return row[x * channels + ch];

                if (depth === 16)
                    return (row[(x * channels + ch) * 2] << 8) | row[(x * channels + ch) * 2 + 1];

                const bit = (x * channels + ch) * depth;
                return (row[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
            };
            /** a sample as 0..255 (16 bits: the high byte; below 8 bits: scaled) */
            const s8 = (x: number, ch: number): number =>
            {
                const v = full(x, ch);
                return depth === 16 ? v >> 8 : depth < 8 ? Math.round((v * 255) / ((1 << depth) - 1)) : v;
            };

            for (let x = 0; x < w; x++)
            {
                const o = ((y0 + y * dy) * width + x0 + x * dx) * 4;

                if (type === 3)
                {
                    const i = full(x, 0);
                    out[o] = palette?.[i * 3] ?? 0;
                    out[o + 1] = palette?.[i * 3 + 1] ?? 0;
                    out[o + 2] = palette?.[i * 3 + 2] ?? 0;
                    out[o + 3] = trns && i < trns.length ? trns[i] : 255;
                }
                else if (type === 0 || type === 4)
                {
                    out[o] = out[o + 1] = out[o + 2] = s8(x, 0);
                    out[o + 3] = type === 4 ? s8(x, 1) : key && full(x, 0) === key[0] ? 0 : 255;
                }
                else
                {
                    out[o] = s8(x, 0);
                    out[o + 1] = s8(x, 1);
                    out[o + 2] = s8(x, 2);
                    out[o + 3] = type === 6 ? s8(x, 3) : key && full(x, 0) === key[0] && full(x, 1) === key[1] && full(x, 2) === key[2] ? 0 : 255;
                }
            }
        }
    };

    if (interlace === 1)
    {
        for (const [x0, y0, dx, dy] of ADAM7)
            pass(Math.ceil((width - x0) / dx), Math.ceil((height - y0) / dy), x0, y0, dx, dy);
    }
    else
        pass(width, height, 0, 0, 1, 1);

    return { width, height, rgba: out };
}
