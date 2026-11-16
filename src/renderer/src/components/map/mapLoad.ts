/**
 * Loading the map's data at a date (docs/map.md, "History and realms"): what is the same at every date (MapStatic)
 * once per version of the map data, then per date only what changes (MapDated, small), composed into MapInfo
 * (shared/mapCompose.ts). The last dates' maps are kept: going back to one gives the same MapInfo again.
 */
import type { MapDated, MapInfo, MapStatic } from '../../../../shared/api';
import { composeMapInfo } from '../../../../shared/mapCompose';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { onIndexChange } from '../../revision';
import { usePreviewDate } from '../../viewState';

/** composed maps kept (by version and date) */
const KEEP = 6;

let stat: Promise<MapStatic | null> | null = null;
const kept = new Map<string, MapInfo>();

// (another mod list or game folder: the bookmarks may differ; the static part is loaded again)
onIndexChange((files) =>
{
    if (!files || files.some((f) => /^(map_data|common\/bookmarks|history)\//i.test(f)))
        stat = null;
});

/** The bookmarks' start dates (the character pages' date bar): the map's static part, loaded once. */
export async function bookmarkDates(): Promise<MapStatic['dates']>
{
    try
    {
        return (await (stat ??= api.mapStatic()))?.dates ?? [];
    }
    catch
    {
        stat = null;
        return [];
    }
}

/**
 * The date shown: the preview date (viewState.ts), else (not chosen yet) the first bookmark's, as the map shows it
 * then (the character pages' bar and portrait alike).
 */
export function useShownDate(): string | undefined
{
    const chosen = usePreviewDate();
    const [first, setFirst] = useState<string | undefined>(undefined);
    useEffect(() =>
    {
        if (chosen === undefined && first === undefined)
            void bookmarkDates().then((d) => setFirst(d[0]?.date));
    }, [chosen, first]);
    return chosen ?? first;
}

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
