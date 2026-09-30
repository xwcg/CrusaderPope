/**
 * The province map (docs/map.md): every pixel of map_data/provinces.png has the colour of one province in
 * map_data/definition.csv (`id;r;g;b;name;x;`). Built once per version of those files (on a thread of its own:
 * mapWorker.ts) into a raster of province ids — Uint16, row-major, top row first — and each province's pixel count,
 * centre and bounds, kept on disk: `<key>.bin` (the ids, served to the renderer as ck3://map/<key>.bin) and
 * `<key>.json` (the rest).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { decodePng } from '../images/png.ts';

/** Bumped when the raster or its stats change shape (old cache files are then not read). */
export const RASTER_VERSION = 1;

export interface RasterMeta
{
    key: string;
    width: number;
    height: number;
    /** province ids are 0 … count − 1 (0: a colour definition.csv does not name) */
    count: number;
    /** per province id: pixel count, centre (x, y), bounds */
    area: number[];
    cx: number[];
    cy: number[];
    /** x0 y0 x1 y1 per id (inclusive; −1 without pixels) */
    box: number[];
}

/** Colour (r << 16 | g << 8 | b) → province id; commented lines (`#…`) and id 0 are left out. */
export function parseDefinitions(csv: string): {
    byColor: Map<number, number>;
    count: number;
}
{
    const byColor = new Map<number, number>();
    let count = 1;

    for (const line of csv.replace(/^﻿/, '').split(/\r?\n/))
    {
        if (!line || line.startsWith('#'))
            continue;

        const [id, r, g, b] = line.split(';');
        const n = parseInt(id, 10);

        if (!(n > 0) || n > 65535)
            continue;

        byColor.set((parseInt(r, 10) << 16) | (parseInt(g, 10) << 8) | parseInt(b, 10), n);

        if (n >= count)
            count = n + 1;
    }

    return { byColor, count };
}

/**
 * The rows of a PNG as RGB(A) bytes, one callback per row (8-bit RGB / RGBA without interlacing are unfiltered row by
 * row — provinces.png is 9216 × 4608 RGB; anything else is decoded whole).
 */
function eachRow(png: Uint8Array, init: (width: number, height: number) => void, row: (bytes: Uint8Array, y: number, channels: number) => void): void
{
    const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
    let pos = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let type = 0;
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
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8];
            type = data[9];
            interlace = data[12];
        }
        else if (kind === 'IDAT')
            idat.push(data);
        else if (kind === 'IEND')
            break;
    }

    if (depth !== 8 || (type !== 2 && type !== 6) || interlace)
    {
        const img = decodePng(png);
        init(img.width, img.height);

        for (let y = 0; y < img.height; y++)
            row(img.rgba.subarray(y * img.width * 4, (y + 1) * img.width * 4), y, 4);

        return;
    }

    init(width, height);
    const bpp = type === 6 ? 4 : 3;
    const stride = width * bpp;
    const raw = inflateSync(Buffer.concat(idat));
    let prev = new Uint8Array(stride);
    let cur = new Uint8Array(stride);

    for (let y = 0; y < height; y++)
    {
        const at = y * (stride + 1);
        const filter = raw[at];
        cur.set(raw.subarray(at + 1, at + 1 + stride));

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

        row(cur, y, bpp);
        [prev, cur] = [cur, prev];
    }
}

/** The raster of province ids and the stats of each province. */
export function buildRaster(png: Uint8Array, csv: string, key: string): { meta: RasterMeta; ids: Uint16Array; }
{
    const { byColor, count } = parseDefinitions(csv);
    let ids = new Uint16Array(0);
    const area = new Float64Array(count);
    const sx = new Float64Array(count);
    const sy = new Float64Array(count);
    const box = new Int32Array(count * 4);

    for (let i = 0; i < count; i++)
        box.set([1 << 30, 1 << 30, -1, -1], i * 4);

    let w = 0;
    let h = 0;
    eachRow(
        png,
        (width, height) =>
        {
            [w, h] = [width, height];
            ids = new Uint16Array(w * h);
        },
        (bytes, y, ch) =>
        {
            const base = y * w;
            // runs of one colour: one lookup and one stats update per run
            let x0 = 0;

            while (x0 < w)
            {
                const o = x0 * ch;
                const rgb = (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2];
                let x1 = x0 + 1;

                while (x1 < w)
                {
                    const q = x1 * ch;

                    if (bytes[q] !== bytes[o] || bytes[q + 1] !== bytes[o + 1] || bytes[q + 2] !== bytes[o + 2])
                        break;

                    x1++;
                }

                const id = byColor.get(rgb) ?? 0;
                ids.fill(id, base + x0, base + x1);
                const n = x1 - x0;
                area[id] += n;
                sx[id] += ((x0 + x1 - 1) * n) / 2;
                sy[id] += y * n;
                const b = id * 4;

                if (x0 < box[b])
                    box[b] = x0;

                if (y < box[b + 1])
                    box[b + 1] = y;

                if (x1 - 1 > box[b + 2])
                    box[b + 2] = x1 - 1;

                if (y > box[b + 3])
                    box[b + 3] = y;

                x0 = x1;
            }
        }
    );
    const meta: RasterMeta = {
        key,
        width: w,
        height: h,
        count,
        area: [],
        cx: [],
        cy: [],
        box: []
    };

    for (let i = 0; i < count; i++)
    {
        meta.area.push(area[i]);
        meta.cx.push(area[i] ? Math.round(sx[i] / area[i]) : -1);
        meta.cy.push(area[i] ? Math.round(sy[i] / area[i]) : -1);
        meta.box.push(...(area[i] ? box.subarray(i * 4, i * 4 + 4) : [-1, -1, -1, -1]));
    }

    return { meta, ids };
}

/** Writes `<key>.bin` and `<key>.json` (the json last, through a temp file: its presence means both are complete). */
export function writeRaster(dir: string, meta: RasterMeta, ids: Uint16Array): void
{
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, meta.key + '.bin'), new Uint8Array(ids.buffer, ids.byteOffset, ids.byteLength));
    const tmp = join(dir, meta.key + '.json.tmp');
    writeFileSync(tmp, JSON.stringify(meta));
    renameSync(tmp, join(dir, meta.key + '.json'));
}

/** The stats of a raster on disk, or null when it was not built yet. */
export function readRasterMeta(dir: string, key: string): RasterMeta | null
{
    const file = join(dir, key + '.json');

    if (!existsSync(file) || !existsSync(join(dir, key + '.bin')))
        return null;

    try
    {
        return JSON.parse(readFileSync(file, 'utf8')) as RasterMeta;
    }
    catch
    {
        return null;
    }
}
