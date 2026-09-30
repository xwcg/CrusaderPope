/**
 * PNG rows of any bit depth for the 3D map's terrain (docs/map.md, "3D map"). The sources are big —
 * map_data/heightmap.png is 16-bit grey 18432 × 9216, 340 MB unpacked — so the pixels are inflated as a stream and
 * unfiltered row by row; only two rows are kept.
 */
import { createInflate } from 'node:zlib';

export interface PngHeader
{
    width: number;
    height: number;
    /** bits per sample (1 2 4 8 16) */
    depth: number;
    /** 0 grey, 2 RGB, 3 palette, 4 grey + alpha, 6 RGBA */
    type: number;
    channels: number;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** The chunks of a PNG: its header and the compressed pixel data. */
function chunks(png: Uint8Array): { header: PngHeader; idat: Buffer[]; interlace: number; }
{
    const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);

    if (buf.readUInt32BE(0) !== 0x89504e47)
        throw new Error('Not a PNG file');

    let pos = 8;
    let header: PngHeader | null = null;
    let interlace = 0;
    const idat: Buffer[] = [];

    while (pos + 8 <= buf.length)
    {
        const len = buf.readUInt32BE(pos);
        const kind = buf.toString('latin1', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        pos += 12 + len;

        if (kind === 'IHDR')
        {
            const type = data[9];
            header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], type, channels: CHANNELS[type] ?? 1 };
            interlace = data[12];
        }
        else if (kind === 'IDAT')
            idat.push(data);
        else if (kind === 'IEND')
            break;
    }

    if (!header)
        throw new Error('PNG without a header');

    return { header, idat, interlace };
}

/** A PNG's size and pixel format. */
export function pngHeader(png: Uint8Array): PngHeader
{
    return chunks(png).header;
}

/**
 * Calls `row` with each row's unfiltered bytes, top row first (samples as stored: 16-bit ones big-endian, palette
 * images give indices). The bytes are reused for the next row.
 */
export function pngRows(png: Uint8Array, row: (bytes: Uint8Array, y: number) => void): Promise<PngHeader>
{
    const { header, idat, interlace } = chunks(png);

    if (interlace)
        return Promise.reject(new Error('Interlaced PNGs are not supported'));

    const { width, height, depth, channels } = header;
    const bpp = Math.max(1, (channels * depth) >> 3);
    const stride = Math.ceil((width * channels * depth) / 8);
    let prev = new Uint8Array(stride);
    let cur = new Uint8Array(stride);
    // the row being filled: its filter byte, then the bytes
    const pending = Buffer.alloc(stride + 1);
    let fill = 0;
    let y = 0;
    const unfilter = (): void =>
    {
        const filter = pending[0];
        cur.set(pending.subarray(1));

        if (filter === 1)
        {
            for (let i = bpp; i < stride; i++)
                cur[i] += cur[i - bpp];
        }
        else if (filter === 2)
        {
            for (let i = 0; i < stride; i++)
                cur[i] += prev[i];
        }
        else if (filter === 3)
        {
            for (let i = 0; i < stride; i++)
                cur[i] += ((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1;
        }
        else if (filter === 4)
        {
            for (let i = 0; i < stride; i++)
            {
                const a = i >= bpp ? cur[i - bpp] : 0;
                const b = prev[i];
                const c = i >= bpp ? prev[i - bpp] : 0;
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                cur[i] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
        }

        row(cur, y++);
        [prev, cur] = [cur, prev];
    };
    return new Promise((resolve, reject) =>
    {
        const inflate = createInflate();
        inflate.on('data', (chunk: Buffer) =>
        {
            let at = 0;

            while (at < chunk.length && y < height)
            {
                const n = Math.min(stride + 1 - fill, chunk.length - at);
                chunk.copy(pending, fill, at, at + n);
                fill += n;
                at += n;

                if (fill === stride + 1)
                {
                    try
                    {
                        unfilter();
                    }
                    catch (err)
                    {
                        inflate.destroy();
                        return reject(err as Error);
                    }

                    fill = 0;
                }
            }
        });
        inflate.on('error', reject);
        inflate.on('end', () => (y === height ? resolve(header) : reject(new Error(`The PNG ends after ${y} of ${height} rows`))));

        for (const d of idat)
            inflate.write(d);

        inflate.end();
    });
}
