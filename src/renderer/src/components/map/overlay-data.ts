/**
 * The map's overlays in the renderer (docs/map.md, "Rivers and sea crossings"): api.mapOverlays() and the river lines
 * of ck3://map/<key>-riverlines.bin as typed arrays per level of detail, with the boxes of runs of points for culling.
 * Asked again for a MapInfo of another province raster or after the index changed (a build or update; another date of
 * the same map keeps them); shared by the 2D and 3D maps.
 */
import type { IndexStatus, MapInfo, MapOverlaysInfo } from '../../../../shared/api';
import { api } from '../../api';
import { track } from '../../pending';

/** points per run (the 2D map culls runs by their box) */
const RUN = 32;
/** steps per width class in the file's classes */
export const CLASS_STEPS = 16;

/** A level of detail of the rivers (MapOverlaysInfo.rivers). */
export interface RiverLevel
{
    tolerance: number;
    /** x, y per point (map pixels) */
    points: Float32Array;
    /** per point: the width class × CLASS_STEPS (fractional classes: smoothed along the river) */
    classes: Uint8Array;
    /** per river: its first point, its point count */
    rivers: Uint32Array;
    /** runs of up to RUN points of one river: first point, count, the river's first and last point, the widest class */
    runs: Uint32Array;
    /** per run: the box of its lines (x0 y0 x1 y1, map pixels) */
    boxes: Float32Array;
}

export interface Overlays
{
    info: MapOverlaysInfo;
    levels: RiverLevel[];
}

/** A river's width (map pixels) at a point's class value (× CLASS_STEPS): NRivers' widths, even steps between. */
export function riverWidth(rivers: NonNullable<MapOverlaysInfo['rivers']>, value: number): number
{
    const c = Math.min(rivers.classes, Math.max(1, value / CLASS_STEPS));
    return rivers.widths[0] + ((rivers.widths[1] - rivers.widths[0]) * (c - 1)) / (rivers.classes - 1);
}

/** A level of the file: views of its block, and its runs. */
function level(buf: ArrayBuffer, l: NonNullable<MapOverlaysInfo['rivers']>['levels'][number]): RiverLevel
{
    const points = new Float32Array(buf, l.at, l.points * 2);
    const rivers = new Uint32Array(buf, l.at + l.points * 8, l.rivers * 2);
    const classes = new Uint8Array(buf, l.at + l.points * 8 + l.rivers * 8, l.points);
    const runs: number[] = [];
    const boxes: number[] = [];

    for (let r = 0; r < l.rivers; r++)
    {
        const first = rivers[r * 2];
        const last = first + rivers[r * 2 + 1] - 1;

        for (let s = first; s <= last; s += RUN)
        {
            const e = Math.min(last, s + RUN - 1);
            let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];

            // (a point's curve reaches halfway to the points around it)
            for (let i = Math.max(first, s - 1); i <= Math.min(last, e + 1); i++)
            {
                x0 = Math.min(x0, points[i * 2]);
                y0 = Math.min(y0, points[i * 2 + 1]);
                x1 = Math.max(x1, points[i * 2]);
                y1 = Math.max(y1, points[i * 2 + 1]);
            }

            let wide = 0;

            for (let i = s; i <= e; i++)
                wide = Math.max(wide, classes[i]);

            runs.push(s, e - s + 1, first, last, wide);
            boxes.push(x0, y0, x1, y1);
        }
    }

    return { tolerance: l.tolerance, points, classes, rivers, runs: Uint32Array.from(runs), boxes: Float32Array.from(boxes) };
}

/** the index's revision: a build or update may bring other map files or defines */
let revision = 0;
const onStatus = (s: IndexStatus): void =>
{
    if (s.state === 'ready' && s.revision !== undefined)
        revision = s.revision;
};
void api.status().then(onStatus);
api.onStatus(onStatus);

/** the last overlays loaded, the province raster and index revision they came with (another date of it keeps them) */
let kept: { map: string; revision: number; data: Overlays; } | null = null;
const asked = new WeakMap<MapInfo, Promise<Overlays | null>>();
const ready = new WeakMap<MapInfo, Overlays | null>();
const waited = new WeakSet<MapInfo>();

/** The overlays of a map (null: none — no rivers.png nor adjacencies.csv, or they could not be read). */
export function overlaysOf(info: MapInfo): Promise<Overlays | null>
{
    let p = asked.get(info);

    if (!p)
    {
        const at = revision;
        const keep = (data: Overlays): Overlays => (kept = { map: info.key, revision: at, data }).data;
        p = (
            kept && kept.map === info.key && kept.revision === at
                ? Promise.resolve(kept.data)
                : api.mapOverlays().then(async (o) =>
                {
                    if (!o)
                        return null;

                    if (kept?.data.info.key === o.key)
                        return keep({ ...kept.data, info: o });

                    const res = o.rivers ? await track(fetch(`ck3://map/${o.key}-riverlines.bin`)) : null;

                    if (res && !res.ok)
                        throw new Error(`The map file ${o.key}-riverlines.bin could not be loaded (${res.status})`);

                    const buf = res && (await res.arrayBuffer());
                    return keep({ info: o, levels: buf && o.rivers ? o.rivers.levels.map((l) => level(buf, l)) : [] });
                })
        )
            .catch((e: Error) =>
            {
                console.warn('Map overlays:', e.message);
                return null;
            })
            .then((o) =>
            {
                ready.set(info, o);
                return o;
            });
        asked.set(info, p);
    }

    return p;
}

/**
 * The overlays of a map when they are here (null: none) — meanwhile those loaded before for the same province raster
 * (a new date), else undefined; asks for them, `onReady` runs once when they come.
 */
export function overlaysNow(info: MapInfo, onReady?: () => void): Overlays | null | undefined
{
    if (ready.has(info))
        return ready.get(info);

    const p = overlaysOf(info);

    if (onReady && !waited.has(info))
    {
        waited.add(info);
        void p.then(onReady);
    }

    return kept?.map === info.key ? kept.data : undefined;
}
