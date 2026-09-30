/** The map's rasters fetched from ck3://map/ (docs/map.md), kept while the page is closed. */
import { track } from '../../pending';

const rasters = new Map<string, Promise<ArrayBuffer>>();

/** A raster file by name (`<key>.bin`, `<key>-height.bin` …); the last few stay in memory. */
export function fetchRaster(name: string): Promise<ArrayBuffer>
{
    let r = rasters.get(name);

    if (!r)
    {
        r = track(
            fetch(`ck3://map/${name}`).then((res) =>
            {
                if (!res.ok)
                    throw new Error(`The map file ${name} could not be loaded (${res.status})`);

                return res.arrayBuffer();
            })
        );

        // (the last few stay: the province raster, the terrain's heights and rivers; another map's replace them)
        while (rasters.size >= 3)
            rasters.delete(rasters.keys().next().value!);

        rasters.set(name, r);
        r.catch(() => rasters.delete(name));
    }

    return r;
}

const views = new WeakMap<ArrayBuffer, Uint16Array>();

/** The province ids (ck3://map/<key>.bin) — the same array each time (a new date keeps the 2D drawing). */
export function provinceRaster(key: string): Promise<Uint16Array>
{
    return fetchRaster(`${key}.bin`).then((b) =>
    {
        let v = views.get(b);

        if (!v)
            views.set(b, v = new Uint16Array(b));

        return v;
    });
}
