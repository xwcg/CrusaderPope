/**
 * The map at a date from its two parts (docs/map.md, "History and realms"): MapStatic, the same at every date and
 * fetched once, and MapDated, per date (mapData.ts makes both). Plain code without Node: the renderer imports it
 * (components/map/mapLoad.ts), scripts/map-check.ts checks what it gives.
 */
import type { MapDated, MapInfo, MapLayer, MapStatic, MapTitle } from './api.ts';

/** MapInfo as MapData made it before the split: the same objects and values. */
export function composeMapInfo(s: MapStatic, d: MapDated): MapInfo
{
    const H = d.holders;
    const culture = H.cultures;
    const faith = H.faiths;
    // holders: one object per holder, shared by their titles
    const holders = H.id.map((id, h) =>
    {
        const out: NonNullable<MapTitle['holder']> = { id, name: H.name[h] };

        if (H.house[h] >= 0)
            out.house = H.houses[H.house[h]];

        if (H.age[h] >= 0)
            out.age = H.age[h];

        if (H.culture[h] >= 0)
            out.culture = culture[H.culture[h]];

        if (H.faith[h] >= 0)
            out.faith = faith[H.faith[h]];

        return out;
    });
    const names = new Map(d.titles.names.map(([t, name, base]) => [t, { name, base }]));
    const colors = new Map(d.titles.colors);
    const T = s.titles;
    const titles = T.key.map((key, i): MapTitle =>
    {
        const named = names.get(i);
        const out: MapTitle = { key, name: named?.name ?? T.name[i], tier: T.tier[i], color: colors.get(i) ?? T.color[i], parent: d.titles.parent[i] };

        if (named?.base !== undefined)
            out.baseName = named.base;

        const h = d.titles.holder[i];

        if (h >= 0)
        {
            out.holder = holders[h];
            out.primary = H.primary[h];

            if (H.liege[h] >= 0)
                out.liege = H.liege[h];
        }

        return out;
    });
    const statics = new Map(s.layers.map((l) => [l.id, l]));
    const layers = d.layers.map((x): MapLayer =>
    {
        const base = statics.get(x.id);

        if (!x.values)
            return base!;

        const out: MapLayer = { ...base!, ...x.layer, values: Array.from(x.values) };

        if (x.things)
            out.things = x.things;

        return out;
    });
    const P = s.province;
    return {
        key: s.key,
        width: s.width,
        height: s.height,
        count: s.count,
        date: d.date,
        dates: s.dates,
        range: s.range,
        kinds: s.kinds,
        titles,
        layers,
        province: { kind: P.kind, barony: P.barony, name: P.name, realm: Array.from(d.province.realm), vassal: Array.from(d.province.vassal), area: P.area, cx: P.cx, cy: P.cy, box: P.box },
        terrainImage: s.terrainImage,
        paperImage: s.paperImage
    };
}
