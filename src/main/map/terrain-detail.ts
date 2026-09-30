/**
 * The terrain's materials for the 3D map (docs/map.md, "3D map"), as the game's terrain shader blends them
 * (clausewitz cw/pdxterrain.fxh `CalculateDetails`): gfx/map/terrain/detail_index.tga and detail_intensity.tga give
 * each map pixel up to 4 materials and how much of each (RGBA8, the province map's size, bottom row first), the
 * materials are materials.settings' list (`diffuse`, `normal`, `material` DDS — BC3, vanilla 1024², AGOT 512² — and an
 * optional `tile_factor`), settings.terrain how they tile. Built once per version of the files on mapTerrainWorker.js
 * into the map cache folder: `<key>-detail.bin` (per pixel 4 × Uint16: layer | intensity << 8, bottom row first),
 * `<key>-materials.bin` (the diffuse, normal and properties arrays of the materials in use: BC3 blocks from 512² down
 * to 1², level by level, each level layer by layer) and `<key>-detail.json`.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { GameFiles } from '../mods/gamefiles.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { decodeDds, parseDds } from '../images/dds.ts';
import { encodeDds, halfSize, type RgbaImage } from '../images/ddsEncode.ts';

/** Bumped when the files change shape (old cache files are then not read). */
export const DETAIL_VERSION = 1;
/**
 * The materials' size in the arrays: vanilla's 1024² top level is left out — at the nearest zoom step a tile (27 map
 * pixels) spans ~270 screen pixels, so 256² already has a texel per pixel.
 */
export const MATERIAL_SIZE = 512;
export const MATERIAL_LEVELS = Math.log2(MATERIAL_SIZE) + 1;
/** the textures of a material in the arrays' order */
export const MATERIAL_MAPS = ['diffuse', 'normal', 'material'] as const;

/** settings.terrain */
export interface TerrainSettings
{
    /** how close two materials' heights (diffuse alpha) + intensities must be to blend (`detail_blend_range`) */
    blendRange: number;
    /** how often a material tiles across the map's width (`detail_tile_factor`) */
    tile: number;
    /** where the tiling starts (`detail_tile_offset_x/_y`, map pixels from the bottom left) */
    offset: [number, number];
    /** `normal_height_scale`: the relief's normals are computed from heights × this */
    normalScale: number;
}

/** A material of materials.settings (its index in the list is its number in detail_index.tga). */
export interface MaterialDef
{
    name: string;
    /** texture files by map (relative to gfx/map/terrain) */
    files: Record<(typeof MATERIAL_MAPS)[number], string | undefined>;
    /** its own `tile_factor` */
    tile?: number;
}

/** A material texture for the thread: its BC3 mip chain from MATERIAL_SIZE down, the whole file to convert, or none. */
export type MaterialTexture = { chain: Uint8Array; } | { file: Uint8Array; } | null;

/** What the thread needs to build the files. */
export interface DetailInput
{
    key: string;
    dir: string;
    index: Uint8Array;
    intensity: Uint8Array;
    /** per material: diffuse, normal, properties */
    textures: MaterialTexture[][];
}

/** What the cache keeps of a build: the detail maps' size and the materials in the arrays (their numbers). */
export interface DetailMeta
{
    key: string;
    width: number;
    height: number;
    layers: number[];
}

const num = (n: PNode | undefined, def: number): number =>
{
    const v = typeof n?.v === 'string' ? parseFloat(n.v) : NaN;
    return Number.isFinite(v) ? v : def;
};
const field = (list: PNode[], k: string): PNode | undefined => list.find((c) => c.k === k);

/** settings.terrain (vanilla: blend range 0.25, tile factor 337.5, offset 0 −512, normal height scale 0.8; AGOT 1, 450, 0.75). */
export function terrainSettings(vfs: GameFiles): TerrainSettings
{
    const list = parse(vfs.readText('gfx/map/terrain/settings.terrain') ?? '');
    return {
        blendRange: num(field(list, 'detail_blend_range'), 0.25),
        tile: num(field(list, 'detail_tile_factor'), 300),
        offset: [num(field(list, 'detail_tile_offset_x'), 0), num(field(list, 'detail_tile_offset_y'), 0)],
        normalScale: num(field(list, 'normal_height_scale'), 1)
    };
}

/**
 * materials.settings: the first block lists the masked materials (`{ name diffuse normal material mask id tile_factor }`,
 * in the order detail_index.tga numbers them; vanilla 105, AGOT 217); the second, unmasked ones, is empty.
 */
export function materialDefs(vfs: GameFiles): MaterialDef[]
{
    const top = parse(vfs.readText('gfx/map/terrain/materials.settings') ?? '').find((n) => n.k === null && Array.isArray(n.v));

    if (!top || !Array.isArray(top.v))
        return [];

    return top.v
        .filter((n) => n.k === null && Array.isArray(n.v))
        .map((n) =>
        {
            const list = n.v as PNode[];
            const str = (k: string): string | undefined =>
            {
                const v = field(list, k)?.v;
                return typeof v === 'string' && v ? v : undefined;
            };
            const tile = num(field(list, 'tile_factor'), NaN);
            return { name: str('name') ?? str('id') ?? '', files: { diffuse: str('diffuse'), normal: str('normal'), material: str('material') }, tile: Number.isFinite(tile) ? tile : undefined };
        });
}

/** BC3 bytes of a level */
const bc3Level = (w: number, h: number): number => Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * 16;
/** BC3 bytes of a mip chain from MATERIAL_SIZE down to 1 × 1 */
export const CHAIN_BYTES = Array.from({ length: MATERIAL_LEVELS }, (_, l) => bc3Level(MATERIAL_SIZE >> l, MATERIAL_SIZE >> l)).reduce((a, b) => a + b, 0);

/**
 * A material texture as the thread takes it: a square BC3 of at least MATERIAL_SIZE with its whole mip chain gives
 * the chain from that size down (no decoding); anything else goes whole, to be converted.
 */
export function materialTexture(buf: Uint8Array | undefined): MaterialTexture
{
    if (!buf)
        return null;

    try
    {
        const d = parseDds(buf);
        const full = Math.log2(d.width) + 1;

        if (d.format === 'BC3' && !d.isCube && d.width === d.height && d.width >= MATERIAL_SIZE && Number.isInteger(full) && d.mips >= full)
        {
            let at = d.dataOffset;

            for (let s = d.width; s > MATERIAL_SIZE; s >>= 1)
                at += bc3Level(s, s);

            if (at + CHAIN_BYTES <= buf.length)
                return { chain: new Uint8Array(buf.subarray(at, at + CHAIN_BYTES)) };
        }
    }
    catch
    {
        return null;
    }

    return { file: buf };
}

/** A TGA's pixels (8-bit per channel, BGRA as stored), bottom row first. Uncompressed and RLE, 32 bits per pixel. */
export function tgaPixels(tga: Uint8Array): { width: number; height: number; data: Uint8Array; }
{
    const type = tga[2];
    const width = tga[12] | (tga[13] << 8);
    const height = tga[14] | (tga[15] << 8);
    const depth = tga[16];
    const topFirst = (tga[17] & 0x20) !== 0;

    if ((type !== 2 && type !== 10) || depth !== 32)
        throw new Error(`Unsupported TGA (type ${type}, ${depth} bits)`);

    const start = 18 + tga[0] + (tga[1] ? (tga[5] | (tga[6] << 8)) * Math.ceil(tga[7] / 8) : 0);
    const n = width * height * 4;
    let data: Uint8Array;

    if (type === 2)
        data = tga.subarray(start, start + n);
    else
    {
        data = new Uint8Array(n);
        let i = start;
        let o = 0;

        while (o < n && i < tga.length)
        {
            const c = tga[i++];
            const count = (c & 0x7f) + 1;

            if (c & 0x80)
            {
                for (let k = 0; k < count && o < n; k++, o += 4)
                    data.set(tga.subarray(i, i + 4), o);

                i += 4;
            }
            else
            {
                const len = Math.min(count * 4, n - o);
                data.set(tga.subarray(i, i + len), o);
                i += count * 4;
                o += len;
            }
        }
    }

    if (data.length < n)
        throw new Error('Truncated TGA');

    if (topFirst)
    {
        const flipped = new Uint8Array(n);
        const row = width * 4;

        for (let y = 0; y < height; y++)
            flipped.set(data.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);

        data = flipped;
    }

    return { width, height, data };
}

/** A square image of MATERIAL_SIZE: box-halved from bigger ones, bilinear from smaller or other shapes. */
function resized(img: RgbaImage): RgbaImage
{
    let out = img;

    while (out.width >= MATERIAL_SIZE * 2 && out.height >= MATERIAL_SIZE * 2)
        out = halfSize(out);

    if (out.width === MATERIAL_SIZE && out.height === MATERIAL_SIZE)
        return out;

    const s = MATERIAL_SIZE;
    const rgba = new Uint8Array(s * s * 4);

    for (let y = 0; y < s; y++)
    {
        const fy = Math.max(0, ((y + 0.5) * out.height) / s - 0.5);
        const y0 = Math.min(out.height - 1, Math.floor(fy));
        const y1 = Math.min(out.height - 1, y0 + 1);
        const ay = fy - y0;

        for (let x = 0; x < s; x++)
        {
            const fx = Math.max(0, ((x + 0.5) * out.width) / s - 0.5);
            const x0 = Math.min(out.width - 1, Math.floor(fx));
            const x1 = Math.min(out.width - 1, x0 + 1);
            const ax = fx - x0;

            for (let c = 0; c < 4; c++)
            {
                const p = (i: number, j: number): number => out.rgba[(j * out.width + i) * 4 + c];
                const top = p(x0, y0) + (p(x1, y0) - p(x0, y0)) * ax;
                const bottom = p(x0, y1) + (p(x1, y1) - p(x0, y1)) * ax;
                rgba[(y * s + x) * 4 + c] = Math.round(top + (bottom - top) * ay);
            }
        }
    }

    return { width: s, height: s, rgba };
}

/** The chain of a solid colour (a missing texture). */
function solidChain(r: number, g: number, b: number, a: number): Uint8Array
{
    const block = new Uint8Array(16);
    block[0] = block[1] = a;
    const c565 = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    block[8] = block[10] = c565 & 0xff;
    block[9] = block[11] = c565 >> 8;
    const out = new Uint8Array(CHAIN_BYTES);

    for (let o = 0; o < out.length; o += 16)
        out.set(block, o);

    return out;
}

/** stand-ins for missing textures: mid grey, a flat normal (x in G, y in A), rough and not metallic */
const MISSING = [solidChain(128, 128, 128, 128), solidChain(128, 128, 0, 128), solidChain(0, 0, 0, 255)];

/** A texture's BC3 chain from MATERIAL_SIZE down: as it is, converted, or the map's stand-in. */
async function chainOf(t: MaterialTexture, map: number): Promise<Uint8Array>
{
    if (!t)
        return MISSING[map];

    if ('chain' in t)
        return t.chain;

    try
    {
        const dds = encodeDds(resized(await decodeDds(t.file)), { format: 'BC3', mips: true });
        const at = parseDds(dds).dataOffset;
        return dds.subarray(at, at + CHAIN_BYTES);
    }
    catch
    {
        return MISSING[map];
    }
}

/** Writes a file in pieces through a temp file (renamed when complete). */
function writeParts(file: string, parts: (write: (b: Uint8Array) => void) => void): void
{
    const tmp = file + '.tmp';
    const fd = openSync(tmp, 'w');

    try
    {
        parts((b) =>
        {
            for (let at = 0; at < b.length;)
                at += writeSync(fd, b, at, b.length - at);
        });
    }
    finally
    {
        closeSync(fd);
    }

    renameSync(tmp, file);
}

/** Builds `<key>-detail.bin`, `<key>-materials.bin` and `<key>-detail.json` (last: its presence means all are complete). */
export async function buildDetail(input: DetailInput): Promise<DetailMeta>
{
    const { key, dir } = input;
    const index = tgaPixels(input.index);
    const intensity = tgaPixels(input.intensity);

    if (index.width !== intensity.width || index.height !== intensity.height)
        throw new Error('detail_index.tga and detail_intensity.tga differ in size');

    const n = index.width * index.height * 4;
    const ix = index.data;
    const w = intensity.data;
    // the materials in use, in their order: the arrays' layers
    const used = new Uint8Array(256);

    for (let i = 0; i < n; i++)
        if (w[i])
            used[ix[i]] = 1;

    const layers: number[] = [];

    for (let m = 0; m < input.textures.length; m++)
        if (used[m])
            layers.push(m);

    if (!layers.length)
        throw new Error('No terrain material is used');

    const layerOf = new Uint8Array(256).fill(255);
    layers.forEach((m, l) => (layerOf[m] = l));
    mkdirSync(dir, { recursive: true });
    const rowBytes = index.width * 4;
    const band = Math.max(1, Math.floor((16 << 20) / (rowBytes * 2)));
    writeParts(join(dir, key + '-detail.bin'), (write) =>
    {
        const out = new Uint16Array(band * rowBytes);

        for (let y0 = 0; y0 < index.height; y0 += band)
        {
            const rows = Math.min(band, index.height - y0);
            const base = y0 * rowBytes;

            for (let i = 0; i < rows * rowBytes; i++)
            {
                const v = w[base + i];
                const l = layerOf[ix[base + i]];
                out[i] = v && l !== 255 ? l | (v << 8) : 255;
            }

            write(new Uint8Array(out.buffer, 0, rows * rowBytes * 2));
        }
    });
    const chains: Uint8Array[][] = [];

    for (const m of layers)
        chains.push(await Promise.all(MATERIAL_MAPS.map((_, k) => chainOf(input.textures[m][k], k))));

    writeParts(join(dir, key + '-materials.bin'), (write) =>
    {
        for (let k = 0; k < MATERIAL_MAPS.length; k++)
        {
            let at = 0;

            for (let l = 0; l < MATERIAL_LEVELS; l++)
            {
                const size = bc3Level(MATERIAL_SIZE >> l, MATERIAL_SIZE >> l);

                for (const c of chains)
                    write(c[k].subarray(at, at + size));

                at += size;
            }
        }
    });
    const meta: DetailMeta = { key, width: index.width, height: index.height, layers };
    const tmp = join(dir, key + '-detail.json.tmp');
    writeFileSync(tmp, JSON.stringify(meta));
    renameSync(tmp, join(dir, key + '-detail.json'));
    return meta;
}

/** A build on disk, or null when it was not made yet. */
export function readDetail(dir: string, key: string): DetailMeta | null
{
    const file = join(dir, key + '-detail.json');

    if (!existsSync(file) || !existsSync(join(dir, key + '-detail.bin')) || !existsSync(join(dir, key + '-materials.bin')))
        return null;

    try
    {
        return JSON.parse(readFileSync(file, 'utf8')) as DetailMeta;
    }
    catch
    {
        return null;
    }
}
