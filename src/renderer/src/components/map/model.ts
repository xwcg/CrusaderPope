/**
 * The map's modes and groups (docs/map.md): what each province belongs to in a mode — realm, a de jure title, a
 * layer's thing (culture, faith …) or a numeric layer's band — with names, colours, links and each group's area.
 */
import type { MapInfo, MapLayer } from '../../../../shared/api';

/** 'realm', 'vassal', a tier letter (h e k d c b) or a layer's id */
export type Mode = string;
export type Style = 'terrain' | 'paper' | 'plain';

export const TIER_NAMES: Record<string, [string, string]> = {
    h: ['Hegemony', 'Hegemonies'],
    e: ['Empire', 'Empires'],
    k: ['Kingdom', 'Kingdoms'],
    d: ['Duchy', 'Duchies'],
    c: ['County', 'Counties'],
    b: ['Barony', 'Baronies']
};
export const WATER = new Set(['sea', 'lake', 'river', 'impassable_sea']);

export interface ModeDef
{
    id: Mode;
    label: string;
    title?: string;
    /** read at the map's date */
    historical: boolean;
}

/** The modes of a map: realms, vassals and the layers read at the date, then the de jure tiers it has, then the other layers. */
export function modesOf(info: MapInfo): ModeDef[]
{
    const tiers = ['h', 'e', 'k', 'd', 'c', 'b'].filter((t) => info.titles.some((x) => x.tier === t));
    const layer = (l: MapLayer): ModeDef => ({ id: l.id, label: l.label, title: l.title, historical: !!l.historical });
    return [
        { id: 'realm', label: 'Realms', title: 'Independent realms at the date', historical: true },
        { id: 'vassal', label: 'Vassals', title: "The realms' direct vassals at the date", historical: true },
        ...info.layers.filter((l) => l.historical).map(layer),
        ...tiers.map((t) => ({ id: t, label: TIER_NAMES[t][1], title: `De jure ${TIER_NAMES[t][1].toLowerCase()} at the date`, historical: true })),
        ...info.layers.filter((l) => !l.historical).map(layer)
    ];
}

export interface Groups
{
    /** per province: group index, −1 none */
    of: Int32Array;
    name: (g: number) => string;
    color: (g: number) => string | undefined;
    link: (g: number) => { type: string; name: string; } | undefined;
    /** a line about the group beside its name (MapThing.note) */
    note: (g: number) => string | undefined;
    /** per group: area and area-weighted centre, bounds */
    area: Float64Array;
    cx: Float64Array;
    cy: Float64Array;
    box: Int32Array;
    /** groups with land, the biggest first */
    bySize: number[];
    /** the mode's layer, if it is one */
    layer?: MapLayer;
    /** names are drawn on the map */
    labels: boolean;
}

/** A colour for things without one (stable per key; hue, saturation and lightness from the key's hash). */
export function hashColor(key: string): string
{
    let h = 2166136261;

    for (let i = 0; i < key.length; i++)
        h = Math.imul(h ^ key.charCodeAt(i), 16777619);

    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    return `hsl(${h % 360} ${38 + ((h >>> 9) % 5) * 7}% ${40 + ((h >>> 12) % 4) * 6}%)`;
}

const rgbCache = new Map<string, [number, number, number]>();
/** #rrggbb or any CSS colour → rgb bytes */
export function rgbOf(c: string): [number, number, number]
{
    let v = rgbCache.get(c);

    if (v)
        return v;

    if (/^#[0-9a-f]{6}$/i.test(c))
        v = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    else
    {
        const cv = document.createElement('canvas').getContext('2d')!;
        cv.fillStyle = c;
        const s = cv.fillStyle as string;
        v = /^#/.test(s) ? [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)] : [128, 128, 128];
    }

    rgbCache.set(c, v);
    return v;
}

/** The title of a tier above (or at) a province's barony. */
export function ancestorAt(info: MapInfo, p: number, tier: string): number
{
    let t = info.province.barony[p];

    while (t >= 0 && info.titles[t].tier !== tier)
        t = info.titles[t].parent;

    return t;
}

export function groupsOf(info: MapInfo, mode: Mode): Groups
{
    const P = info.province;
    const n = info.count;
    const of = new Int32Array(n).fill(-1);
    let size = 0;
    let name: Groups['name'] = () => '';
    let color: Groups['color'] = () => undefined;
    let link: Groups['link'] = () => undefined;
    let note: Groups['note'] = () => undefined;
    let labels = true;
    const layer = info.layers.find((l) => l.id === mode);

    if (mode === 'realm' || mode === 'vassal' || TIER_NAMES[mode])
    {
        size = info.titles.length;
        name = (g) => info.titles[g].name;
        color = (g) => info.titles[g].color ?? hashColor(info.titles[g].key);
        link = (g) => ({ type: 'landed_titles', name: info.titles[g].key });
        const per = mode === 'realm' ? P.realm : mode === 'vassal' ? P.vassal : null;

        for (let p = 0; p < n; p++)
            of[p] = per ? per[p] : ancestorAt(info, p, mode);
    }
    else if (layer?.things)
    {
        const list = layer.things;
        size = list.length;

        for (let p = 0; p < n; p++)
            of[p] = layer.values[p];

        name = (g) => list[g].name;
        color = (g) => list[g].color ?? hashColor(list[g].key);
        link = (g) => (list[g].type ? { type: list[g].type!, name: list[g].key } : undefined);
        note = (g) => list[g].note;
        labels = layer.labels !== false;
    }
    else if (layer?.scale)
    {
        // numeric: one group per colour band of the scale; whole numbers name their band by its first and last value
        // ("3–5"), the last band takes what lies above ("40+")
        const { min, max, colors, unit } = layer.scale;
        size = colors.length;
        const band = (max - min) / size || 1;
        const steps = layer.scale.steps ?? colors.map((_, g) => min + g * band);

        for (let p = 0; p < n; p++)
        {
            const v = layer.values[p];
            let g = -1;

            if (Number.isFinite(v))
            {
                for (g = 0; g + 1 < size && v >= steps[g + 1];)
                    g++;
            }

            of[p] = g;
        }

        const whole = steps.every(Number.isInteger);
        name = (g) =>
        {
            const [lo, hi] = [steps[g], g + 1 < size ? steps[g + 1] : max];
            const range = !whole ? `${Math.round(lo * 10) / 10}–${Math.round(hi * 10) / 10}` : g === size - 1 ? `${lo}+` : hi - lo === 1 ? `${lo}` : `${lo}–${hi - 1}`;
            return range + (unit ? ' ' + unit : '');
        };
        color = (g) => colors[g];
        labels = layer.labels === true;
    }

    // water has no group, except in layers that colour it (terrain)
    if (!layer?.water)
    {
        for (let p = 0; p < n; p++)
            if (WATER.has(info.kinds[P.kind[p]]))
                of[p] = -1;
    }

    const area = new Float64Array(size);
    const cx = new Float64Array(size);
    const cy = new Float64Array(size);
    const box = new Int32Array(size * 4);

    for (let g = 0; g < size; g++)
        box.set([1 << 30, 1 << 30, -1, -1], g * 4);

    for (let p = 0; p < n; p++)
    {
        const g = of[p];
        const a = P.area[p];

        if (g < 0 || !a)
            continue;

        area[g] += a;
        cx[g] += P.cx[p] * a;
        cy[g] += P.cy[p] * a;
        const b = g * 4;
        box[b] = Math.min(box[b], P.box[p * 4]);
        box[b + 1] = Math.min(box[b + 1], P.box[p * 4 + 1]);
        box[b + 2] = Math.max(box[b + 2], P.box[p * 4 + 2]);
        box[b + 3] = Math.max(box[b + 3], P.box[p * 4 + 3]);
    }

    const bySize: number[] = [];

    for (let g = 0; g < size; g++)
    {
        if (!area[g])
            continue;

        cx[g] /= area[g];
        cy[g] /= area[g];
        bySize.push(g);
    }

    bySize.sort((a, b) => area[b] - area[a]);
    return { of, name, color, link, note, area, cx, cy, box, bySize, layer, labels };
}

/** The province of a group nearest its centre (what a search or "Show on map" selects). */
export function centralProvince(info: MapInfo, groups: Groups, g: number): number
{
    let best = -1;
    let bestD = Infinity;

    for (let p = 0; p < info.count; p++)
    {
        if (groups.of[p] !== g)
            continue;

        const d = (info.province.cx[p] - groups.cx[g]) ** 2 + (info.province.cy[p] - groups.cy[g]) ** 2;

        if (d < bestD)
            [best, bestD] = [p, d];
    }

    return best;
}

/** The mode and group that show an index entry ("Show on map": route name `type:key`). */
export function focusOf(info: MapInfo, type: string, key: string): { mode: Mode; group: number; } | undefined
{
    if (type === 'landed_titles')
    {
        const g = info.titles.findIndex((t) => t.key === key);
        return g >= 0 ? { mode: info.titles[g].tier, group: g } : undefined;
    }

    for (const l of info.layers)
    {
        const g = l.things?.findIndex((t) => t.type === type && t.key === key) ?? -1;

        if (g >= 0)
            return { mode: l.id, group: g };
    }

    return undefined;
}

/** A province's name: its barony's, else the map's (seas, wastelands: sea_bay_biscay → Sea bay biscay). */
export function provinceName(info: MapInfo, p: number): string
{
    const b = info.province.barony[p];
    const n = info.province.name[p]?.replace(/_/g, ' ');
    return b >= 0 ? info.titles[b].name : n ? n.charAt(0).toUpperCase() + n.slice(1) : `Province ${p}`;
}
