/** The first map layers (docs/map.md): cultures, faiths, holdings at the date, terrain. */
import { parse } from '../../indexer/parser.ts';
import { T_FAITH } from '../../indexer/schema.ts';
import type { MapThing } from '../../../shared/api.ts';
import { colorOf } from '../color.ts';
import { scalarOf } from '../history.ts';
import { MAP_KINDS } from '../kinds.ts';
import { lastOf, once, perDate, Things, type LayerCtx, type LayerDef } from '../layers.ts';

/** Fixed colours of the usual holdings (others get one from HOLDING_FALLBACK). */
const HOLDING_COLORS: Record<string, string> = {
    castle_holding: '#b8483a',
    city_holding: '#3f7fc4',
    church_holding: '#e0c050',
    tribal_holding: '#8a5a32',
    nomad_holding: '#c49a5a',
    herder_holding: '#9aa05a',
    none: '#6e6e6e'
};
const HOLDING_FALLBACK = ['#5aa878', '#a060b0', '#50b0b0', '#d08040', '#7070d0'];

/** The entries of a type with their colour (a colour, or a named colour: common/named_colors); hidden ones left out. */
export function thingsOf(ctx: LayerCtx, type: string): { list: MapThing[]; at: Map<string, number>; }
{
    return once(ctx, 'things:' + type, () =>
    {
        const idx = ctx.idx;
        const list: MapThing[] = [];
        const at = new Map<string, number>();

        for (const key of idx.names(type))
        {
            const e = idx.get(type, key);
            const node = e && idx.defNode(e)?.node;

            // (entries a mod's replace_path hid have no definition)
            if (!node)
                continue;

            const c = Array.isArray(node.v) ? node.v.find((x) => x.k === 'color') : undefined;
            let color = colorOf(c);

            if (!color && typeof c?.v === 'string')
            {
                const named = idx.get('named_colors', c.v);
                color = colorOf(named && idx.defNode(named)?.node);
            }

            at.set(key, list.length);
            list.push({ key, name: ctx.name(type, key), color, type });
        }

        return { list, at };
    });
}

/**
 * history/province_mapping: `<province> = <source>` — the province takes the source's culture and faith ("mapped
 * history", history/_provinces.info); vanilla maps 325 baronies (Guinea, Arabia, Sápmi …) that have no history of
 * their own.
 */
export function mappedFrom(ctx: LayerCtx): Map<string, string>
{
    return once(ctx, 'mappedFrom', () =>
    {
        const out = new Map<string, string>();

        for (const text of ctx.texts('history/province_mapping'))
            for (const n of parse(text))
                if (n.k && typeof n.v === 'string' && /^\d+$/.test(n.k))
                    out.set(n.k, n.v);

        return out;
    });
}

/** history/provinces keys of a county's culture and faith (`religion`, rarely `faith` — a later one of either wins) */
const COUNTY_KEYS = { culture: ['culture'], faith: ['religion', 'faith'] };

/**
 * Per province at the date: its county's culture or faith key — of the county's first barony that has one, its own or
 * mapped (history/provinces writes them on the county's capital, which comes first); every barony of the county gets
 * it.
 */
export function countyKeys(ctx: LayerCtx, what: 'culture' | 'faith'): (string | undefined)[]
{
    return perDate(ctx, 'county:' + what, () =>
    {
        const mapped = mappedFrom(ctx);
        const valueOf = (p: string): string | undefined => scalarOf(lastOf(ctx.provinces, p, COUNTY_KEYS[what], ctx.when)?.node);
        const out = new Array<string | undefined>(ctx.count).fill(undefined);
        ctx.tree.titles.forEach((t, ci) =>
        {
            if (t.tier !== 'c')
                return;

            const provs = ctx.countyProvinces(ci);
            let v: string | undefined;

            for (const p of provs)
                if ((v = valueOf(String(p))))
                    break;

            if (!v)
            {
                for (const p of provs)
                    if (mapped.has(String(p)) && (v = valueOf(mapped.get(String(p))!)))
                        break;
            }

            for (const p of provs)
                out[p] = v;
        });
        return out;
    });
}

const culture: LayerDef = {
    id: 'culture',
    build: (ctx) =>
    {
        const { list, at } = thingsOf(ctx, 'culture/cultures');
        return { id: 'culture', label: 'Cultures', title: 'The counties’ cultures at the date', row: 'Culture', historical: true, things: list, values: countyKeys(ctx, 'culture').map((k) => (k ? (at.get(k) ?? -1) : -1)) };
    }
};

const faith: LayerDef = {
    id: 'faith',
    build: (ctx) =>
    {
        const { list, at } = thingsOf(ctx, T_FAITH);
        return { id: 'faith', label: 'Faiths', title: 'The counties’ faiths at the date', row: 'Faith', historical: true, things: list, values: countyKeys(ctx, 'faith').map((k) => (k ? (at.get(k) ?? -1) : -1)) };
    }
};

const holding: LayerDef = {
    id: 'holding',
    build: (ctx) =>
    {
        const things = new Things();
        const values = new Array<number>(ctx.count).fill(-1);

        for (const t of ctx.tree.titles)
        {
            if (t.province === undefined || t.province >= ctx.count)
                continue;

            const key = scalarOf(lastOf(ctx.provinces, String(t.province), ['holding'], ctx.when)?.node);

            if (!key)
                continue;

            values[t.province] = things.of(key, () => ({
                name: key === 'none' ? 'No holding' : key === 'auto' ? 'Automatic' : ctx.name('holdings', key),
                color: HOLDING_COLORS[key] ?? HOLDING_FALLBACK[things.list.length % HOLDING_FALLBACK.length],
                type: ctx.idx.get('holdings', key) ? 'holdings' : undefined
            }));
        }

        return { id: 'holding', label: 'Holdings', title: 'The baronies’ holdings at the date', row: 'Holding', historical: true, labels: false, things: things.list, values };
    }
};

/**
 * Readable colours of the terrains: common/terrain_types' own `color`s are debug colours for the game's terrain map
 * mode (farmlands pure red, desert pure yellow). Terrains not listed keep the game's.
 */
const TERRAIN_COLORS: Record<string, string> = {
    plains: '#c8c27e',
    farmlands: '#8fbf5a',
    floodplains: '#6fae7a',
    steppe: '#d8bf78',
    drylands: '#cfa26a',
    desert: '#ecd9a0',
    oasis: '#5bb89c',
    hills: '#b38e62',
    terraced_hills: '#a39a5c',
    highlands: '#9c9470',
    mountains: '#8c8580',
    desert_mountains: '#a57e62',
    canyon: '#b8704e',
    forest: '#4f8f4c',
    cloudforest: '#3e8a70',
    jungle: '#2d6e3c',
    taiga: '#4d7a68',
    taiga_bog: '#5d7760',
    wetlands: '#6c9a8e',
    the_bog: '#5f6e4c',
    frozen_flats: '#dfe7ec',
    glacier: '#f3f7fa',
    hotsprings: '#c98a78',
    urban: '#8e7a8e',
    sea: '#3b6690',
    coastal_sea: '#5a88b4'
};
/**
 * A terrain's readable colour: its own (TERRAIN_COLORS), else that of a listed terrain with the same game colour — a
 * terrain the game paints like another (a road across plains) — else the game's.
 */
function terrainColor(key: string, game: string | undefined, gameOf: (key: string) => string | undefined): string | undefined
{
    if (TERRAIN_COLORS[key])
        return TERRAIN_COLORS[key];

    const like = game ? Object.keys(TERRAIN_COLORS).find((k) => gameOf(k) === game) : undefined;
    return like ? TERRAIN_COLORS[like] : game;
}

/**
 * common/province_terrain: `<id> = <terrain>`, default_land / default_sea / default_coastal_sea. (history/provinces
 * has 95 `terrain = …` lines too, listed in _provinces.info; 72 differ from province_terrain and 24 name `mountain`,
 * no terrain type — left aside.)
 */
const terrain: LayerDef = {
    id: 'terrain',
    build: (ctx) =>
        once(ctx, 'layer:terrain', () =>
        {
            const idx = ctx.idx;
            const things = new Things();
            const gameColors = new Map<string, string | undefined>();
            const gameOf = (key: string): string | undefined =>
            {
                if (!gameColors.has(key))
                {
                    const d = idx.get('terrain_types', key);
                    const node = d && idx.defNode(d)?.node;
                    gameColors.set(key, Array.isArray(node?.v) ? colorOf(node.v.find((c) => c.k === 'color')) : undefined);
                }

                return gameColors.get(key);
            };
            const of = (key: string): number => things.of(key, () => ({ name: ctx.name('terrain_types', key), color: terrainColor(key, gameOf(key), gameOf), type: idx.get('terrain_types', key) ? 'terrain_types' : undefined }));
            const values = new Array<number>(ctx.count).fill(-1);
            const defaults: Record<string, string> = {};

            for (const text of ctx.texts('common/province_terrain'))
            {
                for (const n of parse(text))
                {
                    if (!n.k || typeof n.v !== 'string')
                        continue;

                    if (/^default_/.test(n.k))
                        defaults[n.k] = n.v;
                    else if (/^\d+$/.test(n.k) && +n.k < ctx.count)
                        values[+n.k] = of(n.v);
                }
            }

            for (let p = 1; p < ctx.count; p++)
            {
                if (values[p] >= 0 || !ctx.kinds[p])
                    continue;

                const k = MAP_KINDS[ctx.kinds[p]];
                const d = k === 'sea' || k === 'impassable_sea' ? defaults.default_sea : k === 'land' || k === 'impassable' ? defaults.default_land : undefined;

                if (d)
                    values[p] = of(d);
            }

            return { id: 'terrain', label: 'Terrain', title: 'The provinces’ terrain', row: 'Terrain', water: true, labels: false, things: things.list, values };
        })
};

export const BASIC_LAYERS: LayerDef[] = [culture, faith, terrain, holding];
