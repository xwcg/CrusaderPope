/**
 * The 3D map's terrain (docs/map.md, "3D map"): rasters of heights (map_data/heightmap.png) and rivers
 * (map_data/rivers.png) built once per version of the files (terrain-raster.ts), the terrain's materials
 * (terrain-detail.ts) and map objects (terrain-objects.ts) — each on a thread of its own (mapTerrainWorker.ts) into the
 * map cache folder, served as ck3://map/<key>-*.bin; the heights' scale, the water level and the camera's zoom steps
 * from common/defines; the water's colour map from gfx/map/water/water.settings; the light and post-processing from
 * gfx/map/environment/environment.txt and the map lighting shader's constants.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { GameFile, GameFiles } from '../mods/gamefiles.ts';
import type { MapTerrainInfo } from '../../shared/api.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { parseDds } from '../images/dds.ts';
import { pngHeader } from './terrain-png.ts';
import { TERRAIN_VERSION, readTerrain, type TerrainRasters } from './terrain-raster.ts';
import { DETAIL_VERSION, MATERIAL_LEVELS, MATERIAL_MAPS, MATERIAL_SIZE, materialDefs, materialTexture, readDetail, terrainSettings, type DetailMeta } from './terrain-detail.ts';
import { objectsInput, readObjects } from './terrain-objects.ts';

/** the builds of the loaded files (per kind: the current version's, once) */
const jobs = new Map<string, { key: string; job: Promise<unknown>; }>();

/** A build of `kind` for `key`: from the cache folder when there, else built once (a failed build is tried again next time). */
function once<T>(kind: string, key: string, cached: () => T | null, build: () => Promise<T>): Promise<T>
{
    let current = jobs.get(kind);

    if (current?.key !== key)
    {
        const hit = cached();
        const started = { key, job: hit ? Promise.resolve(hit) : build() };
        jobs.set(kind, current = started);
        started.job.catch(() =>
        {
            if (jobs.get(kind) === started)
                jobs.delete(kind);
        });
    }

    return current.job as Promise<T>;
}

/** A buffer that owns its whole ArrayBuffer (to hand it to a thread without copying). */
function own(b: Uint8Array): Uint8Array
{
    return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : new Uint8Array(b);
}

/** The first 16 hex digits of a hash of the files' locations, sizes and times (and `extra`). */
function keyOf(vfs: GameFiles, files: (GameFile | undefined)[], extra: unknown[]): string
{
    return createHash('sha1')
        .update(JSON.stringify([...extra, ...files.map((f) => f && [vfs.where(f), vfs.stat(f).size, vfs.stat(f).mtime])]))
        .digest('hex')
        .slice(0, 16);
}

/** Runs a build on mapTerrainWorker.js (`data.kind` picks it); `transfer`: buffers that move to the thread. */
function thread<T>(data: Record<string, unknown>, transfer: ArrayBuffer[]): Promise<T>
{
    return new Promise((resolve, reject) =>
    {
        const worker = new Worker(join(__dirname, 'mapTerrainWorker.js'), { workerData: data, transferList: transfer });
        worker.once('message', (m: { meta?: T; error?: string; }) =>
        {
            void worker.terminate();

            if (m.meta)
                resolve(m.meta);
            else
                reject(new Error(m.error ?? 'No result'));
        });
        worker.once('error', reject);
    });
}

/**
 * NJominiMap, NCamera, NMapName and NMapColors of common/defines — every file that has them, later ones win (vanilla
 * 00_defines.txt: `WORLD_EXTENTS_Y = 50`, `WATERLEVEL = 3`; graphic/00_graphics.txt: `FOV = 60`, `ZOOM_STEPS = { 70 …
 * 6500 }`, `LARGE_NAMES_ZOOM_STEP = 9`, `MAP_SHADOW_TINT_STRENGTH = 0.5` …).
 */
function readDefines(vfs: GameFiles): Map<string, PNode>
{
    const out = new Map<string, PNode>();
    const blocks = new Set(['NJominiMap', 'NCamera', 'NMapName', 'NMapColors']);

    for (const f of vfs.list('common/defines', { ext: /\.txt$/i }))
    {
        const text = vfs.readText(f);

        if (!text || !/\b(NJominiMap|NCamera|NMapName|NMapColors)\b/.test(text))
            continue;

        for (const top of parse(text))
            if (top.k && blocks.has(top.k) && Array.isArray(top.v))
            {
                for (const c of top.v)
                    if (c.k)
                        out.set(`${top.k}.${c.k}`, c);
            }
    }

    return out;
}

const numOf = (n: PNode | undefined, def: number): number =>
{
    const v = typeof n?.v === 'string' ? parseFloat(n.v) : NaN;
    return Number.isFinite(v) ? v : def;
};

/** A colour of a settings file: `hsv{ h s v }`, `hex{ rrggbb }` or `{ r g b }` (0–1) → sRGB 0–1. */
function colorOf(n: PNode | undefined, def: [number, number, number]): [number, number, number]
{
    if (!n || !Array.isArray(n.v))
        return def;

    const vals = n.v.map((c) => (typeof c.v === 'string' ? c.v : ''));

    if (n.tag === 'hex')
    {
        const h = parseInt(vals[0] ?? '', 16);
        return Number.isFinite(h) ? [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255] : def;
    }

    const [a, b, c] = vals.map(parseFloat);

    if (![a, b, c].every(Number.isFinite))
        return def;

    if (n.tag !== 'hsv')
        return [a, b, c];

    const f = (k: number): number => c - c * b * Math.max(0, Math.min(k, 4 - k, 1));
    return [f((5 + a * 6) % 6), f((3 + a * 6) % 6), f((1 + a * 6) % 6)];
}

/**
 * The map's light: environment.txt (`terrain_sunny_sun_azimuth = 0.1` …, `cubemap_intensity`, `exposure`, `contrast`,
 * `pivot`, `tonemap_function`, `fog_color` …) and map_lighting.fxh's `#define TERRAIN_SUNNY_SUN_COLOR float3( 1.0f,
 * 0.9f, 0.8f )`, `…_SUN_INTENSITY 8.0f`, `…_IBL_SCALE 0.25f` (MAP_OBJECTS_SUNNY_* for objects; AGOT has its own).
 */
function look(vfs: GameFiles, dir: string): Omit<MapTerrainInfo['look'], 'shadowTint'>
{
    const env = new Map(parse(vfs.readText('gfx/map/environment/environment.txt', { engine: true }) ?? '').map((n) => [n.k ?? '', n]));
    const n = (k: string, def: number): number => numOf(env.get(k), def);
    const fx = vfs.readText('gfx/FX/jomini/map_lighting.fxh', { engine: true }) ?? '';
    const define = (name: string): number[] | undefined =>
    {
        const m = new RegExp(`#define\\s+${name}\\s+(?:float3\\s*\\(([^)]*)\\)|([-\\d.]+))`).exec(fx);
        const nums = (m?.[1] ?? m?.[2] ?? '').split(',').map((s) => parseFloat(s));
        return m && nums.every(Number.isFinite) ? nums : undefined;
    };
    const sun = (prefix: string, key: string, def: [number, number, number, number, number]): MapTerrainInfo['look']['sun'] =>
    {
        const color = define(`${prefix}_SUN_COLOR`);
        return {
            azimuth: n(`${key}_sunny_sun_azimuth`, def[0]),
            elevation: n(`${key}_sunny_sun_elevation`, def[1]),
            color: color?.length === 3 ? (color as [number, number, number]) : [1, 0.9, 0.8],
            intensity: define(`${prefix}_SUN_INTENSITY`)?.[0] ?? def[2],
            ibl: define(`${prefix}_IBL_SCALE`)?.[0] ?? def[3]
        };
    };
    const cube = env.get('cubemap')?.v;
    return {
        sun: sun('TERRAIN_SUNNY', 'terrain', [0.1, 0.4, 8, 0.25, 0]),
        objectSun: sun('MAP_OBJECTS_SUNNY', 'map_objects', [0.3, 0.4, 10, 1.5, 0]),
        cubemap: typeof cube === 'string' && cube ? cube : undefined,
        cubemapIntensity: n('cubemap_intensity', 20),
        exposure: n('exposure', 2),
        contrast: n('contrast', 1),
        pivot: n('pivot', 0.18),
        tonemap: (typeof env.get('tonemap_function')?.v === 'string' && (env.get('tonemap_function')!.v as string)) || 'TonyMcMapface',
        lut: tonemapLut(vfs, dir),
        fog: { color: colorOf(env.get('fog_color'), [0.31, 0.47, 0.61]), begin: n('fog_begin', 20), end: n('fog_end', 500), max: n('fog_max', 0.2) }
    };
}

/**
 * TonyMcMapface's lookup table (jomini/gfx/FX/jomini/post_effect/tony_mc_mapface_2d.dds: 2304 × 48, the 48 blue
 * slices side by side, RGBA half floats — D3DFMT_A16B16G16R16F): its top level as `<key>-tonemap.bin`.
 */
function tonemapLut(vfs: GameFiles, dir: string): MapTerrainInfo['look']['lut']
{
    const f = vfs.get('gfx/FX/jomini/post_effect/tony_mc_mapface_2d.dds', { engine: true });

    if (!f)
        return undefined;

    const key = keyOf(vfs, [f], ['lut']);
    const out = join(dir, key + '-tonemap.bin');
    const buf = vfs.read(f);

    if (!buf)
        return undefined;

    let d;

    try
    {
        d = parseDds(buf);
    }
    catch
    {
        return undefined;
    }

    if (d.format !== 'FOURCC_q' && d.format !== 'RGBA16F')
        return undefined;

    const size = d.width * d.height * 8;

    if (!existsSync(out))
    {
        if (d.dataOffset + size > buf.length)
            return undefined;

        mkdirSync(dir, { recursive: true });
        writeFileSync(out + '.tmp', buf.subarray(d.dataOffset, d.dataOffset + size));
        renameSync(out + '.tmp', out);
    }

    return { key, width: d.width, height: d.height };
}

/** The terrain's settings (from the defines, water.settings and the environment), read on every request: a mod's change shows without a rebuild. */
function settings(vfs: GameFiles, dir: string): Omit<MapTerrainInfo, 'key' | 'width' | 'height' | 'rivers' | 'detail' | 'objects'>
{
    const d = readDefines(vfs);
    const nums = (k: string, def: number[]): number[] =>
    {
        const v = d.get(k)?.v;
        const list = Array.isArray(v) ? v.map((c) => (typeof c.v === 'string' ? parseFloat(c.v) : NaN)).filter(Number.isFinite) : [];
        return list.length ? list : def;
    };
    const water = vfs.readText('gfx/map/water/water.settings', { engine: true });
    return {
        heightScale: numOf(d.get('NJominiMap.WORLD_EXTENTS_Y'), 50),
        waterLevel: numOf(d.get('NJominiMap.WATERLEVEL'), 3),
        camera: {
            fov: numOf(d.get('NCamera.FOV'), 60),
            heights: nums('NCamera.ZOOM_STEPS', [70, 6500]),
            tilts: nums('NCamera.ZOOM_STEPS_TILT', [50, 85]),
            minTilts: nums('NCamera.ZOOM_STEPS_MIN_TILT', [40, 55]),
            maxTilts: nums('NCamera.ZOOM_STEPS_MAX_TILT', [70, 89]),
            largeNames: numOf(d.get('NMapName.LARGE_NAMES_ZOOM_STEP'), 9)
        },
        waterImage: (water && /"WaterColorTexturePath"\s*=\s*"([^"]+)"/.exec(water)?.[1]) || undefined,
        look: { ...look(vfs, dir), shadowTint: shadowTint(vfs, d, nums) }
    };
}

/**
 * The shadow tint: its texture from shadow_tint.fxh's ShadowNoiseTexture (`File = "gfx/map/textures/shadow_color.dds"`),
 * the rest from NMapColors (vanilla `MAP_SHADOW_TINT_STRENGTH = 0.5`, `…_THRESHOLD_MIN = 0.1`, `…_THRESHOLD_MAX = 0.4`,
 * `…_NOISE_UV_TILING = { 500 500 }`).
 */
function shadowTint(vfs: GameFiles, d: Map<string, PNode>, nums: (k: string, def: number[]) => number[]): MapTerrainInfo['look']['shadowTint']
{
    const fx = vfs.readText('gfx/FX/shadow_tint.fxh', { engine: true }) ?? '';
    const tiling = nums('NMapColors.MAP_SHADOW_TINT_NOISE_UV_TILING', [500, 500]);
    return {
        texture: /ShadowNoiseTexture\s*\{[^}]*?File\s*=\s*"([^"]+)"/.exec(fx)?.[1] ?? 'gfx/map/textures/shadow_color.dds',
        strength: numOf(d.get('NMapColors.MAP_SHADOW_TINT_STRENGTH'), 0.5),
        min: numOf(d.get('NMapColors.MAP_SHADOW_TINT_THRESHOLD_MIN'), 0.1),
        max: numOf(d.get('NMapColors.MAP_SHADOW_TINT_THRESHOLD_MAX'), 0.4),
        tiling: [tiling[0], tiling[1] ?? tiling[0]]
    };
}

/** The height and river rasters (built on first use). */
function rasters(vfs: GameFiles, files: { provinces: string; rivers: string; heightmap: string; }, dir: string): Promise<TerrainRasters> | null
{
    const hf = vfs.get(files.heightmap);
    const pf = vfs.get(files.provinces);
    const rf = vfs.get(files.rivers);

    if (!hf || !pf)
        return null;

    const key = keyOf(vfs, [hf, pf, rf], [TERRAIN_VERSION]);
    return once('heights', key, () => readTerrain(dir, key), () =>
    {
        const provinces = vfs.read(pf);
        const heightmap = vfs.read(hf);
        const rivers = rf && vfs.read(rf);

        if (!provinces || !heightmap)
            return Promise.reject(new Error('Cannot read the heightmap'));

        // (the files' bytes move to the thread: the heightmap is 122 MB in vanilla)
        const data = { kind: 'heights', heightmap: own(heightmap), rivers: rivers ? own(rivers) : undefined, mapWidth: pngHeader(provinces).width, dir, key };
        return thread<TerrainRasters>(data, [data.heightmap.buffer, ...(data.rivers ? [data.rivers.buffer] : [])] as ArrayBuffer[]);
    });
}

/** The terrain's materials (built on first use), or undefined without detail maps. */
async function detail(vfs: GameFiles, dir: string): Promise<MapTerrainInfo['detail']>
{
    const index = vfs.get('gfx/map/terrain/detail_index.tga');
    const intensity = vfs.get('gfx/map/terrain/detail_intensity.tga');
    const defs = materialDefs(vfs);

    if (!index || !intensity || !defs.length)
        return undefined;

    const files = defs.map((m) => MATERIAL_MAPS.map((k) => (m.files[k] ? vfs.get('gfx/map/terrain/' + m.files[k]) : undefined)));
    const key = keyOf(vfs, [index, intensity, vfs.get('gfx/map/terrain/materials.settings'), ...files.flat()], [DETAIL_VERSION, MATERIAL_SIZE]);
    const meta = await once('detail', key, () => readDetail(dir, key), () =>
    {
        const ix = vfs.read(index);
        const it = vfs.read(intensity);

        if (!ix || !it)
            return Promise.reject(new Error('Cannot read the detail maps'));

        const textures = files.map((list) => list.map((f) => materialTexture(f && vfs.read(f))));
        const buffers = textures.flat().map((t) => (t && ('chain' in t ? (t.chain = own(t.chain)) : (t.file = own(t.file)))));
        const data = { kind: 'detail', key, dir, index: own(ix), intensity: own(it), textures };
        return thread<DetailMeta>(data, [data.index.buffer, data.intensity.buffer, ...buffers.filter((b) => !!b).map((b) => b!.buffer)] as ArrayBuffer[]);
    });
    const ts = terrainSettings(vfs);
    return {
        key,
        width: meta.width,
        height: meta.height,
        size: MATERIAL_SIZE,
        levels: MATERIAL_LEVELS,
        layers: meta.layers.map((m) => ({ name: defs[m]?.name ?? '', tile: defs[m]?.tile ?? ts.tile })),
        offset: ts.offset,
        blendRange: ts.blendRange,
        normalScale: ts.normalScale
    };
}

/** The map objects (built on first use), or undefined without map_object_data. */
function objects(vfs: GameFiles, dir: string): Promise<MapTerrainInfo['objects']> | undefined
{
    const o = objectsInput(vfs, dir);

    if (!o)
        return undefined;

    return once('objects', o.key, () => readObjects(dir, o.key), () =>
    {
        const input = o.input();
        const texts = input.files.map(own);
        return thread<NonNullable<MapTerrainInfo['objects']>>({ kind: 'objects', ...input, files: texts }, texts.map((b) => b.buffer) as ArrayBuffer[]);
    });
}

/** Logs a part that could not be built and goes on without it. */
const without = (what: string) => (err: Error): undefined =>
{
    console.error(`3D map: no ${what}:`, err.message);
    return undefined;
};

/** The terrain's rasters (built on first use), materials, objects and settings, or null when the loaded files have no heightmap. */
export async function mapTerrain(vfs: GameFiles, files: { provinces: string; definitions: string; rivers: string; heightmap: string; }, dir: string): Promise<MapTerrainInfo | null>
{
    const heights = rasters(vfs, files, dir);

    if (!heights)
        return null;

    const [r, d, o] = await Promise.all([heights, detail(vfs, dir).catch(without('terrain materials')), objects(vfs, dir)?.catch(without('map objects'))]);
    return { ...r, ...settings(vfs, dir), detail: d, objects: o };
}
