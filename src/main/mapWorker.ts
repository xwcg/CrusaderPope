/**
 * Builds the province raster on a thread of its own (map/raster.ts, docs/map.md): gets provinces.png and
 * definition.csv as bytes (read through the index's file layering, mods included), writes `<key>.bin` / `<key>.json`
 * into the map cache folder and answers with the stats.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { buildRaster, writeRaster } from './map/raster.ts';

const { png, csv, dir, key } = workerData as { png: Uint8Array; csv: string; dir: string; key: string; };

try
{
    const { meta, ids } = buildRaster(png, csv, key);
    writeRaster(dir, meta, ids);
    parentPort!.postMessage({ meta });
}
catch (err)
{
    parentPort!.postMessage({ error: (err as Error).message });
}
