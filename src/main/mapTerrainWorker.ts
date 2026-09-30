/**
 * Builds the 3D map's terrain files on a thread of its own (docs/map.md, "3D map"), from bytes the index worker read
 * through its file layering (mods included) — `kind` picks the build: `heights` (map/terrain-raster.ts:
 * heightmap.png and rivers.png → `<key>-height.bin`, `<key>-rivers.bin`, `<key>-terrain.json`), `detail`
 * (map/terrain-detail.ts: the detail maps and material textures → `<key>-detail.bin`, `<key>-materials.bin`,
 * `<key>-detail.json`), `objects` (map/terrain-objects.ts: map_object_data and meshes → `<key>-objects.bin`,
 * `<key>-objects.json`). Writes them into the map cache folder and answers with what the cache keeps of the build.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { buildHeights, buildRivers, writeTerrain, type TerrainRasters } from './map/terrain-raster.ts';
import { buildDetail, type DetailInput } from './map/terrain-detail.ts';
import { buildObjects, type ObjectsInput } from './map/terrain-objects.ts';

async function heights(data: { heightmap: Uint8Array; rivers?: Uint8Array; mapWidth: number; dir: string; key: string; }): Promise<TerrainRasters>
{
    const h = await buildHeights(data.heightmap, data.mapWidth);
    const r = data.rivers ? await buildRivers(data.rivers) : null;
    const meta: TerrainRasters = { key: data.key, width: h.width, height: h.height, ...(r ? { rivers: { width: r.width, height: r.height } } : {}) };
    writeTerrain(data.dir, meta, h.data, r?.data ?? null);
    return meta;
}

const data = workerData as { kind: 'heights' | 'detail' | 'objects'; };
const run = (): Promise<unknown> =>
    data.kind === 'detail'
        ? buildDetail(workerData as DetailInput)
        : data.kind === 'objects'
        ? Promise.resolve(buildObjects(workerData as ObjectsInput))
        : heights(workerData as Parameters<typeof heights>[0]);

run().then(
    (meta) => parentPort!.postMessage({ meta }),
    (err: Error) => parentPort!.postMessage({ error: err.message })
);
