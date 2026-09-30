/**
 * The map's overlays (docs/map.md, "Rivers and sea crossings"), built on a thread of their own (mapOverlaysWorker.ts):
 * the rivers of rivers.png as lines at a few levels of detail (overlays-rivers.ts) and the sea crossings of
 * adjacencies.csv (overlays-crossings.ts), kept in the map cache folder as `<key>-riverlines.bin` (the lines, served
 * to the renderer) and `<key>-overlays.json` (the rest).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MapOverlaysInfo } from '../../shared/api.ts';
import { MAP_KINDS, readKinds } from './kinds.ts';
import { buildRaster, parseDefinitions } from './raster.ts';
import { pngHeader } from './terrain-png.ts';
import { riverLines, riverPixels } from './overlays-rivers.ts';
import { seaAdjacencies, seaCrossings } from './overlays-crossings.ts';

/** Bumped when the files change shape (old cache files are then not read). */
export const OVERLAYS_VERSION = 1;
/** the rivers' levels of detail: how far a simplified line may be from the smoothed one (map pixels) */
const TOLERANCES = [0.08, 0.5, 2];
const WATER_KINDS = new Set(['sea', 'lake', 'river', 'impassable_sea']);

/** What a build keeps: the overlays without the rivers' widths (common/defines, read on every request). */
export type OverlaysMeta = Omit<MapOverlaysInfo, 'rivers'> & { rivers?: Pick<NonNullable<MapOverlaysInfo['rivers']>, 'levels'>; };

/** The files' contents (read through the index's layering) and where the build goes. */
export interface OverlaysInput
{
    rivers?: Uint8Array;
    provinces: Uint8Array;
    definitions: string;
    defaultMap: string;
    adjacencies?: string;
    dir: string;
    key: string;
}

/** Builds the overlays and writes their files. */
export async function buildOverlays(input: OverlaysInput): Promise<OverlaysMeta>
{
    const { width, height } = pngHeader(input.provinces);
    // the rivers: per level a block of points, rivers and classes (4-byte aligned)
    const blocks: Uint8Array[] = [];
    let rivers: OverlaysMeta['rivers'];
    const r = input.rivers && (await riverPixels(input.rivers));

    if (r)
    {
        const levels: NonNullable<OverlaysMeta['rivers']>['levels'] = [];
        let at = 0;

        for (const l of riverLines(r.px, r.width, r.height, TOLERANCES))
        {
            // (the game's rivers.png is the province map's size; another size is scaled to it)
            if (r.width !== width || r.height !== height)
            {
                for (let i = 0; i < l.points.length; i++)
                    l.points[i] *= i % 2 ? height / r.height : width / r.width;
            }

            const n = l.classes.length;
            const nr = l.rivers.length / 2;
            const block = new Uint8Array(n * 8 + nr * 8 + Math.ceil(n / 4) * 4);
            block.set(new Uint8Array(l.points.buffer), 0);
            block.set(new Uint8Array(l.rivers.buffer), n * 8);
            block.set(l.classes, n * 8 + nr * 8);
            levels.push({ tolerance: l.tolerance, points: n, rivers: nr, at });
            blocks.push(block);
            at += block.length;
        }

        rivers = { levels };
    }

    // the crossings between land provinces
    let crossings: MapOverlaysInfo['crossings'] = [];

    if (input.adjacencies)
    {
        const { byColor, count } = parseDefinitions(input.definitions);
        const defined = new Array<boolean>(count).fill(false);

        for (const id of byColor.values())
            defined[id] = true;

        const kinds = readKinds(input.defaultMap, defined).map((k) => MAP_KINDS[k]);
        const land = Uint8Array.from(kinds, (k) => (k === 'land' ? 1 : 0));
        const water = Uint8Array.from(kinds, (k) => (WATER_KINDS.has(k) ? 1 : 0));
        let raster: { ids: Uint16Array; width: number; box: number[]; } | undefined;
        const provinces = (): { ids: Uint16Array; width: number; box: number[]; } =>
        {
            if (!raster)
            {
                const b = buildRaster(input.provinces, input.definitions, input.key);
                raster = { ids: b.ids, width: b.meta.width, box: b.meta.box };
            }

            return raster;
        };
        crossings = seaCrossings(seaAdjacencies(input.adjacencies), height, land, water, provinces);
    }

    const meta: OverlaysMeta = { key: input.key, width, height, ...(rivers ? { rivers } : {}), crossings };
    mkdirSync(input.dir, { recursive: true });

    if (blocks.length)
        writeFileSync(join(input.dir, input.key + '-riverlines.bin'), Buffer.concat(blocks));

    // (the json last, through a temp file: its presence means all is complete)
    const tmp = join(input.dir, input.key + '-overlays.json.tmp');
    writeFileSync(tmp, JSON.stringify(meta));
    renameSync(tmp, join(input.dir, input.key + '-overlays.json'));
    return meta;
}

/** The overlays of a build on disk, or null when they were not built yet. */
export function readOverlays(dir: string, key: string): OverlaysMeta | null
{
    const file = join(dir, key + '-overlays.json');

    if (!existsSync(file))
        return null;

    try
    {
        const meta = JSON.parse(readFileSync(file, 'utf8')) as OverlaysMeta;
        return meta.rivers && !existsSync(join(dir, key + '-riverlines.bin')) ? null : meta;
    }
    catch
    {
        return null;
    }
}
