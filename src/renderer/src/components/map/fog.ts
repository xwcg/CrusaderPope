/**
 * The fog of war on the map (docs/map.md, "Fog of war"): whose view it is (a character or a title: their realm at the
 * map's date), which provinces are in sight (the realm plus one ring of neighbours) and the table of alphas the mask is
 * blurred from. The drawing is in gl2d.ts (2D) and map3d-fog.ts (3D); the settings are the game's NFogOfWar
 * (src/main/map/fog.ts).
 */
import type { MapFogInfo, MapInfo } from '../../../../shared/api';

/** Whose view: a title (its holder's realm) or a character (by id, a title holder). */
export interface Viewpoint
{
    kind: 'title' | 'character';
    key: string;
}

/** What the map draws: the alpha of each province (0 … 255, the table's texels) and its settings. */
export interface FogDraw
{
    /** changes with what the mask depends on (viewpoint's realm, the date's realms, the settings, the map) */
    key: string;
    /** per province id: the game's alpha × 255 (255 in sight, 0 hidden) */
    table: Uint8Array;
    def: MapFogInfo;
    /** how many provinces are in sight (the realm's, the ring's) of all */
    count: FogCount;
}

/** Province ids that touch (4-neighbours of the raster), as pairs a < b, per raster (kept: the scan reads 40 M pixels). */
const adjacency = new WeakMap<Uint16Array, Uint32Array>();

/** The pairs of provinces whose pixels touch: [a, b, a, b …], a < b, each once. */
export function neighbours(ids: Uint16Array, w: number, h: number): Uint32Array
{
    const known = adjacency.get(ids);

    if (known)
        return known;

    const seen = new Set<number>();

    for (let y = 0; y < h; y++)
    {
        const row = y * w;
        let last = -1;

        for (let x = 0; x < w; x++)
        {
            const a = ids[row + x];
            const right = x + 1 < w ? ids[row + x + 1] : a;
            const below = y + 1 < h ? ids[row + x + w] : a;

            if (right !== a)
            {
                const k = a < right ? a * 65536 + right : right * 65536 + a;

                if (k !== last)
                {
                    seen.add(k);
                    last = k;
                }
            }

            if (below !== a)
                seen.add(a < below ? a * 65536 + below : below * 65536 + a);
        }
    }

    const out = new Uint32Array(seen.size * 2);
    let i = 0;

    for (const k of seen)
    {
        out[i++] = Math.floor(k / 65536);
        out[i++] = k % 65536;
    }

    adjacency.set(ids, out);
    return out;
}

const titleIndex = new WeakMap<MapInfo, Map<string, number>>();

/** A title's index in `info.titles`, −1 for none. */
export function titleOf(info: MapInfo, key: string): number
{
    let m = titleIndex.get(info);

    if (!m)
    {
        m = new Map(info.titles.map((t, i) => [t.key, i]));
        titleIndex.set(info, m);
    }

    return m.get(key) ?? -1;
}

/**
 * The realm a viewpoint sees: the primary title of the top liege (index into `info.titles`, as `province.realm`) for
 * a title's holder, or the character who holds a title; −1 when it is nobody's (no holder at the date, a character
 * without a title).
 */
export function realmOf(info: MapInfo, vp: Viewpoint): number
{
    let t = -1;

    if (vp.kind === 'title')
        t = titleOf(info, vp.key);
    else
        t = info.titles.findIndex((x) => x.holder?.id === vp.key);

    if (t < 0 || !info.titles[t].holder)
        return -1;

    let cur = info.titles[t].primary ?? t;

    // (up to the top liege: a loop ends where it comes round)
    for (let n = 0; n < 12; n++)
    {
        const up = info.titles[cur].liege;

        if (up === undefined || up < 0 || up === cur)
            break;

        cur = up;
    }

    return cur;
}

/** The viewpoint of a title key: "the holder of …". */
export const titleView = (key: string): Viewpoint => ({ kind: 'title', key });

/**
 * The viewpoint to start with: a loaded save's played character (when they hold a title), else the realm of the
 * selected province (its top liege's primary title), else none.
 */
export function defaultViewpoint(info: MapInfo, sel: number | null): Viewpoint | null
{
    for (const id of info.save?.players ?? [])
    {
        const vp: Viewpoint = { kind: 'character', key: id };

        if (realmOf(info, vp) >= 0)
            return vp;
    }

    const r = sel !== null && sel > 0 ? info.province.realm[sel] : -1;
    return r !== undefined && r >= 0 ? titleView(info.titles[r].key) : null;
}

/** A name for the viewpoint (the button's text and tooltip). */
export function viewpointName(info: MapInfo, vp: Viewpoint): string
{
    if (vp.kind === 'title')
    {
        const t = info.titles[titleOf(info, vp.key)];
        return t ? (t.holder ? `${t.name} · ${t.holder.name}` : t.name) : vp.key;
    }

    return info.titles.find((x) => x.holder?.id === vp.key)?.holder?.name ?? vp.key;
}

/** How many provinces are in sight: the realm's and the ring around it. */
export interface FogCount
{
    realm: number;
    ring: number;
    total: number;
}

/**
 * The fog for a viewpoint: the province alpha table. The viewpoint's realm (the top liege's) is lit with REALM_ALPHA,
 * every province next to it (a pixel border, or the two ends of a sea crossing) with REALM_NEIGHBOR_ALPHA; the rest is
 * the base alpha 0 (the mask's ALPHA_MIN lifts it). Null when the viewpoint has no realm at the date.
 */
export function buildFog(info: MapInfo, ids: Uint16Array, def: MapFogInfo, vp: Viewpoint): FogDraw | null
{
    const realm = realmOf(info, vp);

    if (realm < 0)
        return null;

    const own = new Uint8Array(info.count);
    let nRealm = 0;

    for (let p = 1; p < info.count; p++)
        if (info.province.realm[p] === realm)
        {
            own[p] = 1;
            nRealm++;
        }

    const table = new Uint8Array(Math.ceil(info.count / 4096) * 4096);
    const a = Math.round(def.realmAlpha * 255);
    const b = Math.round(def.neighborAlpha * 255);
    let ring = 0;
    const touch = (x: number, y: number): void =>
    {
        if (x >= info.count || y >= info.count)
            return;

        if (own[x] && !own[y] && table[y] < b)
        {
            if (!table[y])
                ring++;

            table[y] = b;
        }
    };
    const pairs = neighbours(ids, info.width, info.height);

    for (let i = 0; i < pairs.length; i += 2)
    {
        touch(pairs[i], pairs[i + 1]);
        touch(pairs[i + 1], pairs[i]);
    }

    for (let i = 0; i < def.links.length; i += 2)
    {
        touch(def.links[i], def.links[i + 1]);
        touch(def.links[i + 1], def.links[i]);
    }

    for (let p = 1; p < info.count; p++)
        if (own[p])
            table[p] = a;

    return { key: `${info.key}|${info.date}|${realm}|${JSON.stringify({ ...def, links: def.links.length })}`, table, def, count: { realm: nRealm, ring, total: info.count - 1 } };
}
