/** Map layers of the land (docs/map.md): development and special buildings at the date, geographical regions. */
import { parse, type PNode } from '../../indexer/parser.ts';
import type { MapThing } from '../../../shared/api.ts';
import { unquote } from '../history.ts';
import { TIER_RANK } from '../titles.ts';
import { bodyOf, fieldOf, once, perCounty, Things, type LayerCtx, type LayerDef } from '../layers.ts';

/**
 * Development bands, the same at every date (vanilla: most counties 0–14 in 867, 0–29 in 1178, a few up to 60;
 * AGOT alike): narrow at the low end. Colours light to dark (magma's, reversed).
 */
const DEV_STEPS = [0, 3, 6, 10, 15, 20, 30, 40];
const DEV_COLORS = ['#fbe9b0', '#fec287', '#fb9b6a', '#ef6f5c', '#d1486a', '#a8327a', '#7a2380', '#4f1a73'];

/**
 * Development at the date. history/titles `change_development_level = N` *sets* the development (despite its name) of
 * a county, or of every de jure county below a higher title; per county the latest statement at or before the date
 * on it or a de jure liege wins, the lower title on the same date. Without one: `DEFAULT_COUNTY_DEVELOPMENT`
 * (common/defines, 0).
 */
const development: LayerDef = {
    id: 'development',
    build: (ctx) =>
    {
        const { stmts, fallback, max } = once(ctx, 'development', () =>
        {
            const stmts = new Map<number, { date: number; value: number; }[]>();
            let max = 0;
            ctx.tree.titles.forEach((t, i) =>
            {
                const list = (ctx.titleHistory.entries.get(t.key) ?? []).filter((s) => s.node.k === 'change_development_level' && typeof s.node.v === 'string' && Number.isFinite(+s.node.v));

                if (!list.length)
                    return;

                stmts.set(i, list.map((s) => ({ date: s.date, value: +s.node.v })));

                for (const s of list)
                    max = Math.max(max, +s.node.v);
            });
            let fallback = 0;

            for (const text of ctx.texts('common/defines'))
                for (const m of text.matchAll(/^\s*DEFAULT_COUNTY_DEVELOPMENT\s*=\s*(\d+)/gm))
                    fallback = +m[1];

            return { stmts, fallback, max: Math.max(max, fallback) };
        });
        const { titles } = ctx.tree;
        const values = perCounty(ctx, (ci) =>
        {
            let best: { date: number; rank: number; value: number; } | undefined;

            for (let t = ci, guard = 0; t >= 0 && guard < 10; t = ctx.state.parentOf[t], guard++)
            {
                const rank = TIER_RANK.indexOf(titles[t].tier);

                for (const s of stmts.get(t) ?? [])
                {
                    if (s.date > ctx.when)
                        break;

                    if (!best || s.date > best.date || (s.date === best.date && rank < best.rank))
                        best = { date: s.date, rank, value: s.value };
                }
            }

            return best?.value ?? fallback;
        }, NaN);
        return {
            id: 'development',
            label: 'Development',
            title: 'The counties’ development at the date',
            row: 'Development',
            historical: true,
            labels: false,
            values,
            scale: { min: 0, max: Math.max(max, DEV_STEPS[DEV_STEPS.length - 1]), colors: DEV_COLORS, steps: DEV_STEPS }
        };
    }
};

/** Colours of the special buildings by their `type` (common/buildings); empty slots pale. */
const BUILDING_COLORS: Record<string, string> = { special: '#e3a72f', duchy_capital: '#8f62c9', great_building: '#cf5b3a' };
const SLOT_COLOR = '#d8ceb0';

interface BuildingStmt
{
    date: number;
    kind: 'built' | 'slot' | 'duchy';
    key: string;
}

/** history/provinces keys of special buildings; `add_…` ones sit in `effect` blocks (TGP's, under a DLC check). */
const BUILDING_KEYS: Record<string, BuildingStmt['kind']> = {
    special_building: 'built',
    add_special_building: 'built',
    special_building_slot: 'slot',
    add_special_building_slot: 'slot',
    duchy_capital_building: 'duchy'
};

/**
 * Special buildings at the date (history/provinces): `special_building = X` (built; its slot too),
 * `special_building_slot = X` (only the slot), `duchy_capital_building = X`, and the same as effects in `effect`
 * blocks (taken as if their DLC checks pass). A province shows its special building, else its duchy capital
 * building, else its empty slot.
 */
const specialBuilding: LayerDef = {
    id: 'special_building',
    build: (ctx) =>
    {
        const perProvince = once(ctx, 'specialBuildings', () =>
        {
            const out = new Map<number, BuildingStmt[]>();
            const walk = (n: PNode, date: number, list: BuildingStmt[]): void =>
            {
                const kind = n.k ? BUILDING_KEYS[n.k] : undefined;

                if (kind && typeof n.v === 'string')
                    list.push({ date, kind, key: unquote(n.v) });
                else if (n.k === 'effect' || n.k === 'if' || n.k === 'else_if' || n.k === 'else')
                {
                    if (Array.isArray(n.v))
                    {
                        for (const c of n.v)
                            walk(c, date, list);
                    }
                }
            };

            for (const [id, stmts] of ctx.provinces.entries)
            {
                if (!/^\d+$/.test(id) || +id >= ctx.count)
                    continue;

                const list: BuildingStmt[] = [];

                for (const s of stmts)
                    walk(s.node, s.date, list);

                if (list.length)
                    out.set(+id, list);
            }

            return out;
        });
        const typeOf = once(ctx, 'buildingTypes', () => new Map<string, string | undefined>());
        const things = new Things();
        const values = new Array<number>(ctx.count).fill(-1);

        for (const [p, list] of perProvince)
        {
            const last: Partial<Record<BuildingStmt['kind'], string>> = {};

            for (const s of list)
                if (s.date <= ctx.when)
                    last[s.kind] = s.key;

            const [key, slot] = last.built ? [last.built, false] : last.duchy ? [last.duchy, false] : last.slot ? [last.slot, true] : [];

            if (!key)
                continue;

            const type = ctx.idx.get('buildings', key) ? 'buildings' : undefined;
            values[p] = things.of((slot ? 'slot:' : '') + key, (): Omit<MapThing, 'key'> & { key: string; } =>
            {
                if (!typeOf.has(key))
                    typeOf.set(key, fieldOf(bodyOf(ctx, 'buildings', key), 'type'));

                const name = ctx.name('buildings', key);
                return slot ? { key, name: `${name} (empty slot)`, color: SLOT_COLOR, type } : { key, name, color: BUILDING_COLORS[typeOf.get(key) ?? 'special'] ?? BUILDING_COLORS.special, type };
            });
        }

        return { id: 'special_building', label: 'Special buildings', title: 'Special and duchy capital buildings (and empty special building slots) at the date', row: 'Special building', historical: true, things: things.list, values };
    }
};

/** Keys of a region's lists that name landed titles (map_data/geographical_regions). */
const REGION_TITLES = ['hegemonies', 'empires', 'kingdoms', 'duchies', 'counties'];

/**
 * Geographical regions (map_data/geographical_regions: `<region> = { duchies = { … } counties = { … } provinces = { … }
 * regions = { … } }`, the lists' titles standing for their de jure provinces; subregions may be declared after their
 * region — AGOT does). A province is in many regions; the layer shows the "world regions" (`world_*`, which the
 * game's files say are "mutually exclusive on the same tier & should cover every part of the map"), the smallest one
 * a province is in. Other `world_*` regions cut across those (vanilla's world_atlantic, world_innovation_camels,
 * world_horse_buildings_in_hills_and_mountains): the ones overlapping others without containing them are dropped,
 * most overlaps first, until the rest nest.
 */
const region: LayerDef = {
    id: 'region',
    build: (ctx) =>
        once(ctx, 'layer:region', () =>
        {
            const defs = new Map<string, PNode[]>();

            for (const text of ctx.texts('map_data/geographical_regions'))
                for (const n of parse(text))
                    if (n.k && Array.isArray(n.v))
                        defs.set(n.k, n.v);

            const words = (block: PNode[], key: string): string[] => block.filter((c) => c.k === key && Array.isArray(c.v)).flatMap((c) => (c.v as PNode[]).filter((x) => !x.k && typeof x.v === 'string').map((x) => unquote(x.v as string)));
            const W = (ctx.count + 31) >>> 5;
            const sets = new Map<string, Uint32Array>();
            const add = (set: Uint32Array, p: number): void =>
            {
                if (p > 0 && p < ctx.count)
                    set[p >>> 5] |= 1 << (p & 31);
            };
            const addTitle = (set: Uint32Array, t: number): void =>
            {
                const node = ctx.tree.titles[t];

                if (node.province !== undefined)
                    add(set, node.province);

                for (const k of node.kids)
                    addTitle(set, k);
            };
            const setOf = (key: string, seen: Set<string>): Uint32Array =>
            {
                let set = sets.get(key);

                if (set)
                    return set;

                set = new Uint32Array(W);
                const block = defs.get(key);

                if (block && !seen.has(key))
                {
                    seen.add(key);

                    for (const list of REGION_TITLES)
                        for (const t of words(block, list))
                            if (ctx.tree.byKey.has(t))
                                addTitle(set, ctx.tree.byKey.get(t)!);

                    for (const p of words(block, 'provinces'))
                        add(set, +p);

                    for (const r of words(block, 'regions'))
                    {
                        const sub = setOf(r, seen);

                        for (let i = 0; i < W; i++)
                            set[i] |= sub[i];
                    }
                }

                sets.set(key, set);
                return set;
            };
            const keys = [...defs.keys()].filter((k) => k.startsWith('world_'));
            const size = new Map<string, number>();

            for (const k of keys)
            {
                let n = 0;

                for (const w of setOf(k, new Set()))
                    for (let x = w; x; x &= x - 1)
                        n++;

                size.set(k, n);
            }

            // overlapping regions that do not nest: drop the one with the most such overlaps (the later one on a tie)
            const regions = keys.filter((k) => size.get(k)! > 0);
            const clash = (a: Uint32Array, b: Uint32Array): boolean =>
            {
                let both = false;
                let onlyA = false;
                let onlyB = false;

                for (let i = 0; i < W; i++)
                {
                    if (a[i] & b[i])
                        both = true;

                    if (a[i] & ~b[i])
                        onlyA = true;

                    if (b[i] & ~a[i])
                        onlyB = true;
                }

                return both && onlyA && onlyB;
            };
            const clashes = regions.map((a) => new Set(regions.filter((b) => b !== a && clash(sets.get(a)!, sets.get(b)!))));
            const alive = new Set(regions.keys());

            for (;;)
            {
                let worst = -1;

                for (const i of alive)
                    if (clashes[i].size && (worst < 0 || clashes[i].size >= clashes[worst].size))
                        worst = i;

                if (worst < 0)
                    break;

                alive.delete(worst);

                for (const i of alive)
                    clashes[i].delete(regions[worst]);
            }

            const kept = [...alive].map((i) => regions[i]).sort((a, b) => size.get(a)! - size.get(b)!);
            const things = new Things();
            const values = new Array<number>(ctx.count).fill(-1);

            for (const k of kept)
            {
                const set = sets.get(k)!;
                let g = -1;

                for (let p = 1; p < ctx.count; p++)
                {
                    if (values[p] >= 0 || !(set[p >>> 5] & (1 << (p & 31))))
                        continue;

                    if (g < 0)
                    {
                        const name = ctx.idx.plainLoc(k) ?? k.replace(/^world_/, '').replace(/_/g, ' ');
                        g = things.of(k, () => ({ name: name.charAt(0).toUpperCase() + name.slice(1) }));
                    }

                    values[p] = g;
                }
            }

            return { id: 'region', label: 'Regions', title: 'The geographical world regions (the smallest one of each province)', row: 'Region', things: things.list, values };
        })
};

export const LAND_LAYERS: LayerDef[] = [development, specialBuilding, region];
