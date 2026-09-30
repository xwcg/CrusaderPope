/**
 * The 3D map's terrain rasters (docs/map.md, "3D map"), built on a thread of their own (mapTerrainWorker.ts) and kept
 * in the map cache folder: `<key>-height.bin` (Uint16 heights), `<key>-rivers.bin` (a byte per pixel) and
 * `<key>-terrain.json` (their sizes).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pngHeader, pngRows } from './terrain-png.ts';

/** Bumped when the rasters change shape (old cache files are then not read). */
export const TERRAIN_VERSION = 1;

/** What the cache keeps of a build: the rasters' sizes (the settings from the defines are read on every request). */
export interface TerrainRasters
{
    key: string;
    width: number;
    height: number;
    rivers?: { width: number; height: number; };
}

/**
 * Heights: map_data/heightmap.png (16-bit grey; vanilla 18432 × 9216, twice the province map; AGOT 9216 × 6144, the
 * province map's size) averaged over `f` × `f` pixels — the whole factor that brings it closest to the province map's
 * width. Uint16, row-major, top row first; 8-bit greys are widened (× 257).
 */
export async function buildHeights(png: Uint8Array, mapWidth: number): Promise<{ width: number; height: number; data: Uint16Array; }>
{
    const hd = pngHeader(png);

    if (hd.type === 3)
        throw new Error('The heightmap is a palette image');

    const wide = hd.depth === 16;
    const step = hd.channels * (wide ? 2 : 1);
    const f = Math.max(1, Math.round(hd.width / mapWidth));
    const w = Math.floor(hd.width / f);
    const h = Math.floor(hd.height / f);
    const data = new Uint16Array(w * h);
    const sum = new Uint32Array(w);
    const n = f * f;
    await pngRows(png, (bytes, y) =>
    {
        const ty = Math.floor(y / f);

        if (ty >= h)
            return;

        if (f === 1)
        {
            for (let x = 0, s = 0; x < w; x++, s += step)
                data[y * w + x] = wide ? (bytes[s] << 8) | bytes[s + 1] : bytes[s] * 257;

            return;
        }

        for (let x = 0, s = 0; x < w; x++)
        {
            let acc = 0;

            for (let k = 0; k < f; k++, s += step)
                acc += wide ? (bytes[s] << 8) | bytes[s + 1] : bytes[s] * 257;

            sum[x] += acc;
        }

        if (y % f === f - 1)
        {
            for (let x = 0; x < w; x++)
                data[ty * w + x] = Math.round(sum[x] / n);

            sum.fill(0);
        }
    });
    return { width: w, height: h, data };
}

/**
 * Rivers: map_data/rivers.png, an 8-bit palette image (vanilla and AGOT the province map's size). Its indices: 0 a
 * river's source (green), 1 a tributary joining (red), 2 a split (yellow), 3 … 15 the river's width (3 narrowest,
 * light blue … 11 dark blue, 12 … 15 greens: wider still), 254 water, 255 land. Kept as a byte per pixel: 0 none,
 * 1 … 13 the width (index − 2); sources, joins and splits take their widest neighbour's width. Null when the image is
 * not an 8-bit palette image.
 */
export async function buildRivers(png: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array; } | null>
{
    const hd = pngHeader(png);

    if (hd.type !== 3 || hd.depth !== 8)
        return null;

    const { width: w, height: h } = hd;
    const data = new Uint8Array(w * h);
    const marks: number[] = [];
    await pngRows(png, (bytes, y) =>
    {
        const base = y * w;

        for (let x = 0; x < w; x++)
        {
            const v = bytes[x];

            if (v >= 3 && v <= 15)
                data[base + x] = v - 2;
            else if (v <= 2)
                marks.push(base + x);
        }
    });

    for (const i of marks)
    {
        const x = i % w;
        const y = (i - x) / w;
        let best = 0;

        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++)
            {
                const nx = x + dx;
                const ny = y + dy;

                if (nx >= 0 && ny >= 0 && nx < w && ny < h)
                    best = Math.max(best, data[ny * w + nx]);
            }

        data[i] = best || 1;
    }

    return { width: w, height: h, data };
}

/** Writes the rasters and `<key>-terrain.json` (last, through a temp file: its presence means all are complete). */
export function writeTerrain(dir: string, meta: TerrainRasters, heights: Uint16Array, rivers: Uint8Array | null): void
{
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, meta.key + '-height.bin'), new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength));

    if (rivers)
        writeFileSync(join(dir, meta.key + '-rivers.bin'), rivers);

    const tmp = join(dir, meta.key + '-terrain.json.tmp');
    writeFileSync(tmp, JSON.stringify(meta));
    renameSync(tmp, join(dir, meta.key + '-terrain.json'));
}

/** The rasters of a build on disk, or null when they were not built yet. */
export function readTerrain(dir: string, key: string): TerrainRasters | null
{
    const file = join(dir, key + '-terrain.json');

    if (!existsSync(file) || !existsSync(join(dir, key + '-height.bin')))
        return null;

    try
    {
        const meta = JSON.parse(readFileSync(file, 'utf8')) as TerrainRasters;
        return meta.rivers && !existsSync(join(dir, key + '-rivers.bin')) ? null : meta;
    }
    catch
    {
        return null;
    }
}
