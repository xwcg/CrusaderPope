/**
 * Loading the map's data at a date (docs/map.md, "History and realms"): what is the same at every date (MapStatic)
 * once per version of the map data, then per date only what changes (MapDated, small) — composed into MapInfo
 * (shared/mapCompose.ts). The last dates' maps are kept: going back to one gives the same MapInfo again.
 */
import type { MapDated, MapInfo, MapStatic } from '../../../../shared/api';
import { composeMapInfo } from '../../../../shared/mapCompose';
import { api } from '../../api';

/** composed maps kept (by version and date) */
const KEEP = 6;

let stat: Promise<MapStatic | null> | null = null;
const kept = new Map<string, MapInfo>();

/** The map at a date (default: the first bookmark's). */
export async function loadMapInfo(date?: string): Promise<MapInfo | null>
{
    try
    {
        let [s, d] = await Promise.all([stat ??= api.mapStatic(), api.mapDated(date)]);

        // the map data changed since (a new index, an edit): its static part again
        if (d && s?.version !== d.version)
            [s, d] = await Promise.all([stat = api.mapStatic(), api.mapDated(date)]);

        if (!s || !d || s.version !== d.version)
        {
            stat = null;
            return null;
        }

        return compose(s, d);
    }
    catch (e)
    {
        stat = null;
        throw e;
    }
}

function compose(s: MapStatic, d: MapDated): MapInfo
{
    const key = d.version + '@' + d.date;
    let info = kept.get(key);

    if (info)
        kept.delete(key);
    else
        info = composeMapInfo(s, d);

    kept.set(key, info);

    if (kept.size > KEEP)
        kept.delete(kept.keys().next().value!);

    return info;
}
