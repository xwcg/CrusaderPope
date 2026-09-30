/**
 * The map's layers (docs/map.md): every map mode other than realms and de jure titles — cultures, faiths, terrain,
 * holdings … Each is a LayerDef building a MapLayer (shared/api.ts) for the map's date; the renderer shows every layer
 * it gets as a mode (buttons, colours, borders, labels, side panel row).
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import type { PNode } from '../indexer/parser.ts';
import type { MapLayer, MapThing } from '../../shared/api.ts';
import type { HistoryBook, Stmt } from './history.ts';
import type { TitleState, TitleTree } from './titles.ts';
import { BASIC_LAYERS } from './layers/basic.ts';
import { CULTURE_LAYERS } from './layers/culture.ts';
import { FAITH_LAYERS } from './layers/faith.ts';
import { LAND_LAYERS } from './layers/land.ts';
import { RULER_LAYERS } from './layers/rulers.ts';

export interface LayerCtx
{
    idx: GameIndex;
    /** province ids 0 … count − 1 */
    count: number;
    /** the date (dateNum) */
    when: number;
    tree: TitleTree;
    state: TitleState;
    /** per province: index into MAP_KINDS (mapData.ts) */
    kinds: number[];
    /** history/provinces */
    provinces: HistoryBook;
    /** history/titles */
    titleHistory: HistoryBook;
    /** a county's provinces in title order (its capital barony first) */
    countyProvinces(county: number): number[];
    /** an index entry's display name (the key made readable when it has none) */
    name(type: string, key: string): string;
    /** the texts of a folder's .txt files, in load order */
    texts(dir: string): string[];
    /** data a layer computes once per index (not per date): kept across dates */
    cache: Map<string, unknown>;
}

export interface LayerDef
{
    id: string;
    build(ctx: LayerCtx): MapLayer | null;
}

const byId = new Map([...BASIC_LAYERS, ...RULER_LAYERS, ...CULTURE_LAYERS, ...FAITH_LAYERS, ...LAND_LAYERS].map((l) => [l.id, l]));

/** In the order of the mode buttons: the layers read at the date first, then the static ones. */
export const LAYERS: LayerDef[] = [
    'dynasty',
    'house',
    'government',
    'culture',
    'heritage',
    'language',
    'faith',
    'religion',
    'religion_family',
    'holding',
    'development',
    'special_building',
    'holy_site',
    'region',
    'terrain'
].map((id) => byId.get(id)!);

export function buildLayers(ctx: LayerCtx): MapLayer[]
{
    const out: MapLayer[] = [];

    for (const def of LAYERS)
    {
        const layer = def.build(ctx);

        if (layer)
            out.push(layer);
    }

    return out;
}

/** A value computed once per index (ctx.cache). */
export function once<T>(ctx: LayerCtx, key: string, make: () => T): T
{
    if (!ctx.cache.has(key))
        ctx.cache.set(key, make());

    return ctx.cache.get(key) as T;
}

const dated = new WeakMap<LayerCtx, Map<string, unknown>>();

/** A value computed once per date (a LayerCtx is made per date) that several layers share: the counties' cultures … */
export function perDate<T>(ctx: LayerCtx, key: string, make: () => T): T
{
    let m = dated.get(ctx);

    if (!m)
        dated.set(ctx, m = new Map());

    if (!m.has(key))
        m.set(key, make());

    return m.get(key) as T;
}

/** An entry's statements (its winning definition's block), [] without one (a mod's replace_path hid it). */
export function bodyOf(ctx: LayerCtx, type: string, key: string): PNode[]
{
    const e = ctx.idx.get(type, key);
    const node = e && ctx.idx.defNode(e)?.node;
    return node && Array.isArray(node.v) ? node.v : [];
}

/** A block's first scalar of a key, unquoted. */
export function fieldOf(body: PNode[], key: string): string | undefined
{
    const n = body.find((c) => c.k === key && typeof c.v === 'string');
    return n ? (n.v as string).replace(/^"(.*)"$/, '$1') : undefined;
}

/** The last statement of one of the keys at or before the date (province history names the faith `religion` or `faith`). */
export function lastOf(book: HistoryBook, entry: string, keys: string[], when: number): Stmt | undefined
{
    let out: Stmt | undefined;

    for (const s of book.entries.get(entry) ?? [])
    {
        if (s.date > when)
            break;

        if (keys.includes(s.node.k!))
            out = s;
    }

    return out;
}

/** Per province: the value of its county (`none` for provinces without one). */
export function perCounty(ctx: LayerCtx, value: (county: number) => number, none = -1): number[]
{
    const out = new Array<number>(ctx.count).fill(none);
    ctx.tree.titles.forEach((t, ci) =>
    {
        if (t.tier !== 'c')
            return;

        const provs = ctx.countyProvinces(ci);

        if (!provs.length)
            return;

        const v = value(ci);

        for (const p of provs)
            out[p] = v;
    });
    return out;
}

/** Things in order of first use, one per key; `of` adds one on its first use and gives its index. */
export class Things
{
    readonly list: MapThing[] = [];
    private at = new Map<string, number>();

    /** (`make` may give the thing another key than the one it is found by: a link's entry key) */
    of(key: string, make: () => Omit<MapThing, 'key'> & { key?: string; }): number
    {
        let i = this.at.get(key);

        if (i === undefined)
        {
            i = this.list.length;
            this.at.set(key, i);
            this.list.push({ key, ...make() });
        }

        return i;
    }
}
