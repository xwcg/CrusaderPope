/**
 * The map's overlays (docs/map.md, "Rivers and sea crossings"): the rivers of map_data/rivers.png as smooth lines and
 * the sea crossings of map_data/adjacencies.csv, built once per version of the files (overlays-build.ts, on a thread
 * of its own: mapOverlaysWorker.ts) into the map cache folder; the lines are served as ck3://map/<key>-riverlines.bin.
 * The rivers' widths come from common/defines (NRivers), read on every request.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { GameFiles } from '../mods/gamefiles.ts';
import type { MapOverlaysInfo } from '../../shared/api.ts';
import { parse } from '../indexer/parser.ts';
import { OVERLAYS_VERSION, readOverlays, type OverlaysInput, type OverlaysMeta } from './overlays-build.ts';

/** the overlays of the loaded map files (built once per version of them) */
let job: { key: string; job: Promise<OverlaysMeta>; } | null = null;

/** A buffer that owns its whole ArrayBuffer (to hand it to a thread without copying). */
function own(b: Uint8Array): Uint8Array
{
    return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : new Uint8Array(b);
}

/**
 * The rivers' width classes and the widths of the narrowest and widest (map pixels): common/defines NRivers — every
 * file that has it, later ones win (vanilla jomini/rivers.txt: `NUM_WIDTH_PIXEL_VALUES = 13`, `WIDTH_MIN = 1.0`,
 * `WIDTH_MAX = 4.0`).
 */
function riverWidths(vfs: GameFiles): { classes: number; widths: [number, number]; }
{
    const d = new Map<string, number>();

    for (const f of vfs.list('common/defines', { ext: /\.txt$/i }))
    {
        const text = vfs.readText(f);

        if (!text || !/\bNRivers\b/.test(text))
            continue;

        for (const top of parse(text))
            if (top.k === 'NRivers' && Array.isArray(top.v))
            {
                for (const c of top.v)
                {
                    const n = typeof c.v === 'string' ? parseFloat(c.v) : NaN;

                    if (c.k && Number.isFinite(n))
                        d.set(c.k, n);
                }
            }
    }

    return { classes: Math.max(2, Math.round(d.get('NUM_WIDTH_PIXEL_VALUES') ?? 13)), widths: [d.get('WIDTH_MIN') ?? 1, d.get('WIDTH_MAX') ?? 4] };
}

/** Builds the overlays on mapOverlaysWorker.js from the files' contents. */
function build(input: OverlaysInput): Promise<OverlaysMeta>
{
    return new Promise((resolve, reject) =>
    {
        // (rivers.png and provinces.png move to the thread)
        const worker = new Worker(join(__dirname, 'mapOverlaysWorker.js'), { workerData: input, transferList: [input.provinces.buffer, ...(input.rivers ? [input.rivers.buffer] : [])] as ArrayBuffer[] });
        worker.once('message', (m: { meta?: OverlaysMeta; error?: string; }) =>
        {
            void worker.terminate();

            if (m.meta)
                resolve(m.meta);
            else
                reject(new Error(m.error ?? 'No map overlays'));
        });
        worker.once('error', reject);
    });
}

/** The overlays (built on first use), or null when the loaded files have no map, or neither rivers nor adjacencies. */
export async function mapOverlays(vfs: GameFiles, files: { provinces: string; definitions: string; rivers: string; heightmap: string; }, dir: string): Promise<MapOverlaysInfo | null>
{
    const defaultMap = vfs.readText('map_data/default.map') ?? '';
    const pf = vfs.get(files.provinces);
    const df = vfs.get(files.definitions);
    const rf = vfs.get(files.rivers);
    const af = vfs.get('map_data/' + (/^\s*adjacencies\s*=\s*"([^"]+)"/m.exec(defaultMap)?.[1] ?? 'adjacencies.csv'));
    const mf = vfs.get('map_data/default.map');

    if (!pf || !df || (!rf && !af))
        return null;

    const key = createHash('sha1')
        .update(JSON.stringify([OVERLAYS_VERSION, ...[rf, af, pf, df, mf].map((f) => f && [vfs.where(f), vfs.stat(f).size, vfs.stat(f).mtime])]))
        .digest('hex')
        .slice(0, 16);
    let current = job?.key === key ? job : null;

    if (!current)
    {
        const cached = readOverlays(dir, key);
        let run: Promise<OverlaysMeta>;

        if (cached)
            run = Promise.resolve(cached);
        else
        {
            const provinces = vfs.read(pf);
            const rivers = rf && vfs.read(rf);
            run = provinces
                ? build({ provinces: own(provinces), ...(rivers ? { rivers: own(rivers) } : {}), definitions: vfs.readText(df) ?? '', defaultMap, ...(af ? { adjacencies: vfs.readText(af) ?? '' } : {}), dir, key })
                : Promise.reject(new Error('Cannot read the province map'));
        }

        const started = { key, job: run };
        job = current = started;
        // (a failed build is tried again on the next request)
        run.catch(() =>
        {
            if (job === started)
                job = null;
        });
    }

    const { rivers, ...meta } = await current.job;
    return { ...meta, ...(rivers ? { rivers: { ...rivers, ...riverWidths(vfs) } } : {}) };
}
