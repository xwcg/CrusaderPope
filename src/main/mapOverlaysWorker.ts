/**
 * Builds the map's overlays on a thread of their own (map/overlays-build.ts, docs/map.md "Rivers and sea crossings"):
 * gets rivers.png, provinces.png, definition.csv, default.map and adjacencies.csv (read through the index's file
 * layering, mods included), writes `<key>-riverlines.bin` and `<key>-overlays.json` into the map cache folder and
 * answers with what the json holds.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { buildOverlays, type OverlaysInput } from './map/overlays-build.ts';

buildOverlays(workerData as OverlaysInput).then(
    (meta) => parentPort!.postMessage({ meta }),
    (err: Error) => parentPort!.postMessage({ error: err.message })
);
