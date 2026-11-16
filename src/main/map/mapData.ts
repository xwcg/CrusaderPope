/**
 * What the map shows (docs/map.md), read through the index's file layering (mods included): the static part once
 * per index (title tree, province kinds and names, the history files as timelines, bookmark dates), then the state at
 * a history date: titles (titles.ts: holders, realms, names) and the layers (layers.ts: cultures, faiths, terrain …).
 * It goes to the renderer in two parts: MapStatic once, MapDated per date (compact: typed arrays, only what changes
 * with the date); shared/mapCompose.ts makes MapInfo of them. The last dates' parts are kept: scrubbing back and forth
 * is instant.
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { T_FAITH, T_TITLE } from '../indexer/schema.ts';
import type { MapDated, MapInfo, MapLayer, MapNamed, MapStatic } from '../../shared/api.ts';
import type { RasterMeta } from './raster.ts';
import { DATE_KEY, dateNum, HistoryBook, lastAt, scalarOf, type Dated } from './history.ts';
import { HolderBook, holderAt } from './history-characters.ts';
import { MAP_KINDS, readKinds } from './kinds.ts';
import { readTitleTree, titleState, type TitleEnv, type TitleState, type TitleTree } from './titles.ts';
import { readTimelines } from './titles-history.ts';
import { saveMapState, type BlockOf, type SaveMapState } from './save-state.ts';
import { T_SAVE_CHARACTER } from '../indexer/schema.ts';
import { entries, type Gamestate } from '../saves/gamestate.ts';
import { tr } from '../../shared/i18n.ts';
import { TitleNamer } from './titles-names.ts';
import { composeMapInfo } from '../../shared/mapCompose.ts';
import { buildLayers, type LayerCtx } from './layers.ts';
import { provinceNames } from './names.ts';
import { faithGfx, historyBuildings, holdingLevel, holdingLocators, holdingMesh, holdingRules, regionTester, wallsOf, type HoldingRules } from './holdings.ts';

export { MAP_KINDS };

/** dates kept (a MapDated is ~1 MB, mostly typed arrays) */
const KEEP = 24;
/** MapData instances made in this thread (a part of their version) */
let made = 0;

interface Base
{
    tree: TitleTree;
    kinds: number[];
    names: string[];
    titleHistory: HistoryBook;
    provinceHistory: HistoryBook;
    env: TitleEnv;
    /** per title: its loc name (the key made readable when it has none) */
    titleNames: string[];
    dates: { date: string; label: string; }[];
    range: { from: number; to: number; };
    /** per county: its provinces in title order */
    countyProvinces: Map<number, number[]>;
    /** the layers' data kept across dates */
    cache: Map<string, unknown>;
}

export class MapData
{
    private idx: GameIndex;
    private base: Base | undefined;
    /** the static part (per raster) and its layers by id */
    private stat: { meta: string; value: MapStatic; layers: Map<string, MapLayer>; } | undefined;
    private kept = new Map<string, MapDated>();
    /** display names of houses and dynasties (with their prefix) */
    private houses = new Map<string, string | null>();
    /** this map data's version: a new MapData comes with every index state */
    readonly version = `${Date.now().toString(36)}.${++made}`;
    /** the next date made ahead (prefetch) */
    private idle: ReturnType<typeof setTimeout> | undefined;

    /** a loaded save (docs/saves.md): the map shows its state at its date only */
    private readonly save?: Gamestate;
    private saveState?: SaveMapState;
    /** the save's blocks as changed (map edits: SaveSession.pathBlock) */
    private readonly blockOf?: BlockOf;

    constructor(idx: GameIndex, save?: Gamestate, blockOf?: BlockOf)
    {
        this.idx = idx;
        this.save = save;
        this.blockOf = blockOf;
    }

    /** The texts of a folder's .txt files, in load order. */
    texts(dir: string): string[]
    {
        return this.idx.vfs
            .list(dir, { ext: /\.txt$/i })
            .map((f) => this.idx.vfs.readText(f) ?? '')
            .filter(Boolean);
    }

    /** The loaded save's played characters (`currently_played_characters`: ids), none without a save. */
    private players(): string[]
    {
        const g = this.save;
        const e = g?.section('currently_played_characters');
        return g && e?.block ? [...entries(g.buf, e.vs, e.ve)].map((x) => g.buf.subarray(x.vs, x.ve).toString('latin1').trim()).filter((s) => /^\d+$/.test(s)) : [];
    }

    /** The map files default.map names (`provinces = "provinces.png"` …), as game paths. */
    mapFiles(): { provinces: string; definitions: string; rivers: string; heightmap: string; }
    {
        const text = this.idx.vfs.readText('map_data/default.map') ?? '';
        const at = (k: string, d: string): string => 'map_data/' + (new RegExp(`^\\s*${k}\\s*=\\s*"([^"]+)"`, 'm').exec(text)?.[1] ?? d);
        return { provinces: at('provinces', 'provinces.png'), definitions: at('definitions', 'definition.csv'), rivers: at('rivers', 'rivers.png'), heightmap: 'map_data/heightmap.png' };
    }

    name(type: string, key: string): string
    {
        const e = this.idx.get(type, key);
        return (e && this.idx.displayName(e)) ?? key.replace(/^[hekdcb]_/, '').replace(/_/g, ' ');
    }

    private build(count: number): Base
    {
        const idx = this.idx;
        const tree = readTitleTree(this.texts('common/landed_titles'), count);
        const defined = new Array<boolean>(count).fill(false);
        const defNames = new Array<string>(count).fill('');

        for (const line of (idx.vfs.readText(this.mapFiles().definitions) ?? '').split(/\r?\n/))
        {
            if (!line || line.startsWith('#'))
                continue;

            const [id, , , , name] = line.split(';');
            const n = parseInt(id, 10);

            if (n > 0 && n < count)
            {
                defNames[n] = name ?? '';
                defined[n] = true;
            }
        }

        const kinds = readKinds(idx.vfs.readText('map_data/default.map') ?? '', defined);
        const countyProvinces = new Map<number, number[]>();
        tree.titles.forEach((t, i) =>
        {
            if (t.tier === 'c')
                countyProvinces.set(i, t.kids.map((k) => tree.titles[k].province).filter((p): p is number => p !== undefined && p < count));
        });

        // the bookmarks' start dates
        const byDate = new Map<string, string[]>();

        for (const key of idx.names('bookmarks/bookmarks'))
        {
            const e = idx.get('bookmarks/bookmarks', key);
            const node = e && idx.defNode(e)?.node;
            const d = Array.isArray(node?.v) ? node.v.find((c) => c.k === 'start_date' && typeof c.v === 'string') : undefined;

            if (d && DATE_KEY.test(d.v as string))
                byDate.set(d.v as string, [...(byDate.get(d.v as string) ?? []), this.name('bookmarks/bookmarks', key)]);
        }

        const dates = [...byDate]
            .sort((a, b) => dateNum(a[0]) - dateNum(b[0]))
            .map(([date, labels]) => ({ date, label: labels.length > 2 ? `${labels.slice(0, 2).join(', ')} …` : labels.join(', ') }));

        const titleHistory = new HistoryBook(this.texts('history/titles'));
        const provinceHistory = new HistoryBook(this.texts('history/provinces'));
        // a loaded save: its titles, holders, cultures and holdings at its date, the only date (no bookmarks)
        const ss = this.save ? (this.saveState = saveMapState(this.save, tree, this.blockOf)) : undefined;

        if (ss)
            dates.splice(0, dates.length, { date: ss.date, label: tr('Savegame') });

        const timelines = ss?.timelines ?? readTimelines(tree, titleHistory);
        const years = [...timelines.range, ...dates.map((d) => dateNum(d.date))].filter((d) => d > 0).map((d) => Math.floor(d / 10000));
        // a province's value of a key at the date (history/provinces), by its statements of that key (read on first use)
        const byKey = new Map<string, Dated<string>[]>();
        const valueAt = (p: number | undefined, key: string, when: number): string | undefined =>
        {
            if (p === undefined)
                return undefined;

            let list = byKey.get(key + p);

            if (!list)
            {
                list = (provinceHistory.entries.get(String(p)) ?? []).flatMap((s) => (s.node.k === key && scalarOf(s.node) ? [{ date: s.date, v: scalarOf(s.node)! }] : []));
                byKey.set(key + p, list);
            }

            return list.length ? lastAt(list, when) : undefined;
        };
        // history/province_mapping: `<province> = <source>`: a province without history of its own has its source's culture
        let mapped: Map<number, number> | undefined;
        const mappedFrom = (p: number): number | undefined =>
        {
            mapped ??= new Map(this.texts('history/province_mapping').flatMap((text) => parse(text).flatMap((n) => (n.k && typeof n.v === 'string' && /^\d+$/.test(n.k) ? [[+n.k, +n.v] as [number, number]] : []))));
            return mapped.get(p);
        };
        const env: TitleEnv = {
            timelines,
            holders: new HolderBook(idx, ss ? T_SAVE_CHARACTER : undefined),
            namer: new TitleNamer(idx, tree, this.texts('common/flavorization')),
            holding: (t, when) =>
            {
                const p = tree.titles[t].tier === 'b' ? tree.titles[t].province : countyProvinces.get(t)?.[0];
                return ss ? (p === undefined ? undefined : ss.holding.get(p)) : valueAt(p, 'holding', when);
            },
            culture: (county, when) =>
            {
                if (ss)
                    return ss.countyCulture.get(tree.titles[county].key);

                const provs = countyProvinces.get(county) ?? [];

                for (const p of provs)
                {
                    const v = valueAt(p, 'culture', when);

                    if (v)
                        return v;
                }

                for (const p of provs)
                {
                    const v = valueAt(mappedFrom(p), 'culture', when);

                    if (v)
                        return v;
                }

                return undefined;
            }
        };
        return {
            tree,
            kinds,
            names: provinceNames(idx, defNames, kinds),
            titleHistory,
            provinceHistory,
            env,
            titleNames: tree.titles.map((t) => this.name(T_TITLE, t.key)),
            dates,
            range: years.length ? { from: Math.min(...years), to: Math.max(...years) } : { from: 1, to: 1 },
            countyProvinces,
            cache: new Map()
        };
    }

    /** The map at a date (default: the first bookmark's), for a built raster, both parts composed. */
    info(meta: RasterMeta, date?: string): MapInfo
    {
        return composeMapInfo(this.static(meta), this.dated(meta, date));
    }

    /** What is the same at every date: once per raster. */
    static(meta: RasterMeta): MapStatic
    {
        if (this.stat?.meta === meta.key)
            return this.stat.value;

        const b = (this.base ??= this.build(meta.count));
        this.kept.clear();
        const at = this.dateOf(b);
        const { state, layers } = this.state(b, meta, at);
        const { tree } = b;
        const images = (paths: string[]): string | undefined => paths.find((p) => this.idx.vfs.get(p, { engine: true }));
        const value: MapStatic = {
            version: `${meta.key}.${this.version}`,
            key: meta.key,
            width: meta.width,
            height: meta.height,
            count: meta.count,
            dates: b.dates,
            range: b.range,
            ...(this.saveState ? { save: { date: this.saveState.date, players: this.players() } } : {}),
            kinds: MAP_KINDS,
            titles: { key: tree.titles.map((t) => t.key), name: b.titleNames, tier: tree.titles.map((t) => t.tier).join(''), color: tree.titles.map((t) => t.color) },
            province: { kind: b.kinds, barony: tree.baronyOf, name: b.names, area: meta.area, cx: meta.cx, cy: meta.cy, box: meta.box },
            layers,
            terrainImage: images(['gfx/map/terrain/colormap.dds']),
            paperImage: images(['gfx/map/terrain/flat_maps/flatmap.dds'])
        };
        this.stat = { meta: meta.key, value, layers: new Map(layers.map((l) => [l.id, l])) };
        this.keep(this.compact(b, meta, at, state, layers));
        return value;
    }

    /** What changes with the date (default: the first bookmark's); the years next to it are made after, when idle. */
    dated(meta: RasterMeta, date?: string): MapDated
    {
        // (a loaded save: its date, whatever was asked)
        if (this.save)
            date = undefined;

        const at = date && DATE_KEY.test(date) ?
            date.split('.')
                .map(Number)
                .join('.') :
            this.dateOf(this.base ??= this.build(meta.count));
        const d = this.datedAt(meta, at);
        this.prefetch(meta, at);
        return d;
    }

    private datedAt(meta: RasterMeta, at: string): MapDated
    {
        const s = this.static(meta);
        const hit = this.kept.get(at);

        if (hit?.version === s.version)
            return hit;

        const b = this.base!;
        const { state, layers } = this.state(b, meta, at);
        return this.keep(this.compact(b, meta, at, state, layers));
    }

    /**
     * The year after and the year before a date asked for, made one by one when the thread has nothing else to do:
     * stepping through the years (the date control's ← →, a slow drag) finds them made. A new request drops the rest.
     */
    private prefetch(meta: RasterMeta, at: string): void
    {
        clearTimeout(this.idle);
        const [y, m, d] = at.split('.').map(Number);
        const { from, to } = this.base!.range;
        const todo = [y + 1, y - 1].filter((x) => x >= from && x <= to).map((x) => `${x}.${m}.${d}`);
        const next = (): void =>
        {
            const x = todo.shift();

            if (!x)
                return;

            if (!this.kept.has(x))
                this.datedAt(meta, x);

            this.idle = setTimeout(next, 0).unref();
        };
        this.idle = setTimeout(next, 0).unref();
    }

    private dateOf(b: Base): string
    {
        return b.dates[0]?.date ?? '1066.1.1';
    }

    private keep(d: MapDated): MapDated
    {
        this.kept.delete(d.date);
        this.kept.set(d.date, d);

        if (this.kept.size > KEEP)
            this.kept.delete(this.kept.keys().next().value!);

        return d;
    }

    /** The titles and layers at a date. */
    /** the last date's state and layers (the 3D map's holdings ask for the date the map was just made at) */
    private lastState?: { b: Base; at: string; out: { state: TitleState; layers: MapLayer[]; }; };

    private state(b: Base, meta: RasterMeta, at: string): { state: TitleState; layers: MapLayer[]; }
    {
        if (this.lastState?.b === b && this.lastState.at === at)
            return this.lastState.out;

        const out = this.stateAt(b, meta, at);
        this.lastState = { b, at, out };
        return out;
    }

    private stateAt(b: Base, meta: RasterMeta, at: string): { state: TitleState; layers: MapLayer[]; }
    {
        const when = dateNum(at);
        const state = titleState(b.tree, b.env, when);
        const ctx: LayerCtx = {
            idx: this.idx,
            count: meta.count,
            when,
            tree: b.tree,
            state,
            kinds: b.kinds,
            provinces: b.provinceHistory,
            titleHistory: b.titleHistory,
            countyProvinces: (ci) => b.countyProvinces.get(ci) ?? [],
            name: (type, key) => this.name(type, key),
            texts: (dir) => this.texts(dir),
            cache: b.cache,
            ...(this.saveState ? { save: { culture: this.saveState.countyCulture, faith: this.saveState.countyFaith, development: this.saveState.development, holding: this.saveState.holding, special: this.saveState.special, duchy: this.saveState.duchy } } : {})
        };
        return { state, layers: buildLayers(ctx) };
    }

    /** The date's part: titles and holders, realms, the layers that are not the static part's. */
    private compact(b: Base, meta: RasterMeta, at: string, state: TitleState, layers: MapLayer[]): MapDated
    {
        const idx = this.idx;
        const when = dateNum(at);
        const n = meta.count;

        const realm = new Int32Array(n).fill(-1);
        const vassal = new Int32Array(n).fill(-1);

        for (const [ci, provs] of b.countyProvinces)
        {
            for (const p of provs)
            {
                realm[p] = state.realmOf[ci];
                vassal[p] = state.vassalOf[ci];
            }
        }

        // holders: name, house, age, culture and faith at the date
        const H = state.holders.length;
        const table = (): { list: MapNamed[]; at: Map<string, number>; } => ({ list: [], at: new Map() });
        const [cultures, faiths] = [table(), table()];
        const houses = { list: [] as string[], at: new Map<string, number>() };
        const indexOf = (t: { list: MapNamed[]; at: Map<string, number>; }, type: string, key: string | undefined): number =>
        {
            if (!key)
                return -1;

            let i = t.at.get(key);

            if (i === undefined)
            {
                t.at.set(key, i = t.list.length);
                t.list.push({ key, name: this.name(type, key) });
            }

            return i;
        };
        const holders: MapDated['holders'] = {
            id: state.holders,
            name: new Array<string>(H),
            house: new Int32Array(H).fill(-1),
            houses: houses.list,
            age: new Int16Array(H).fill(-1),
            culture: new Int32Array(H).fill(-1),
            faith: new Int32Array(H).fill(-1),
            cultures: cultures.list,
            faiths: faiths.list,
            primary: state.primary,
            liege: new Int32Array(H).fill(-1)
        };
        state.holders.forEach((id, i) =>
        {
            const h = b.env.holders.get(id);
            holders.name[i] = h?.name ?? id;

            if (state.liege[i] >= 0)
                holders.liege[i] = state.primary[state.liege[i]];

            if (!h)
                return;

            const f = holderAt(h, when);
            const house = f.house ? this.houseName('dynasty_houses', f.house) : f.dynasty ? this.houseName('dynasties', f.dynasty) : undefined;

            if (house)
            {
                let k = houses.at.get(house);

                if (k === undefined)
                    houses.at.set(house, k = houses.list.push(house) - 1);

                holders.house[i] = k;
            }

            if (h.birth !== undefined && h.birth <= when)
                holders.age[i] = Math.floor((Math.min(when, h.death ?? when) - h.birth) / 10000);

            holders.culture[i] = indexOf(cultures, 'culture/cultures', f.culture);
            holders.faith[i] = indexOf(faiths, T_FAITH, f.faith);
        });

        const names: MapDated['titles']['names'] = [];
        const colors: MapDated['titles']['colors'] = [];

        for (let i = 0; i < state.nameOf.length; i++)
        {
            const name = state.nameOf[i];

            if (name !== undefined)
                names.push(state.baseNameOf[i] ? [i, name, state.baseNameOf[i]] : [i, name]);

            const color = state.colorOf[i];

            if (color !== undefined)
                colors.push([i, color]);
        }

        // the layers: MapStatic's as they are, else their values (and things, the rest when not the static layer's)
        const statics = this.stat!.layers;
        const metaOf = (l: MapLayer): Omit<MapLayer, 'values' | 'things'> => Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'values' && k !== 'things')) as Omit<MapLayer, 'values' | 'things'>;
        const dated = layers.map((l): MapDated['layers'][number] =>
        {
            const s = statics.get(l.id);

            if (l === s)
                return { id: l.id };

            const out: MapDated['layers'][number] = { id: l.id, values: l.things ? Int32Array.from(l.values) : Float64Array.from(l.values) };

            if (l.things !== s?.things)
                out.things = l.things;

            const meta = metaOf(l);

            if (!s || JSON.stringify(meta) !== JSON.stringify(metaOf(s)))
                out.layer = meta;

            return out;
        });

        return {
            version: this.stat!.value.version,
            date: at,
            titles: { parent: state.parentOf, holder: state.holderIx, names, colors },
            holders,
            province: { realm, vassal },
            layers: dated
        };
    }

    private houseName(type: 'dynasty_houses' | 'dynasties', key: string): string | undefined
    {
        const k = type + ':' + key;
        let v = this.houses.get(k);

        if (v === undefined)
        {
            const e = this.idx.get(type, key);
            v = (e && this.idx.displayName(e)) || null;
            this.houses.set(k, v);
        }

        return v ?? undefined;
    }

    /** holdings' rules, locators and region tests, read on first use (holdings.ts) */
    private holdingData?: { rules: HoldingRules; locs: Map<number, [number, number, number, number]>; special: Map<number, [number, number, number, number]>; built: Map<number, { date: number; keys: string[]; }[]>; capitals: Set<number>; inRegion: (r: string, p: number) => boolean; gfx: Map<string, string | undefined>; faith: Map<string, string>; };

    /**
     * The holdings at a date for the 3D map (holdings.ts): per mesh its instances (x, y (0), z (game: from the bottom),
     * yaw, scale) at the provinces' `buildings` locators. The holding type, culture and faith are the map's own layers'.
     */
    holdings(meta: RasterMeta, date?: string): Record<string, number[]>
    {
        const b = (this.base ??= this.build(meta.count));
        const at = date && DATE_KEY.test(date) ? date : this.dateOf(b);
        const vfs = this.idx.vfs;
        const h = (this.holdingData ??= {
            rules: holdingRules(vfs),
            locs: holdingLocators(vfs),
            special: holdingLocators(vfs, 'special_building'),
            // (a loaded save: its provinces' buildings, at its date)
            built: this.saveState ?
                new Map([...this.saveState.buildings].map(([p, keys]) => [p, [{ date: dateNum(this.saveState!.date), keys }]])) :
                historyBuildings(b.provinceHistory, meta.count),
            capitals: new Set([...b.countyProvinces.values()].map((list) => list[0]).filter((p) => p !== undefined)),
            inRegion: regionTester(this.texts('map_data/geographical_regions'), b.tree, meta.count),
            gfx: new Map(),
            faith: faithGfx(vfs)
        });
        const { layers } = this.state(b, meta, at);
        const when = dateNum(at);
        const layer = (id: string): MapLayer | undefined => layers.find((l) => l.id === id);
        const holding = layer('holding');
        const culture = layer('culture');
        const faith = layer('faith');
        const special = layer('special_building');
        // a culture's `building_gfx`, a faith's `graphical_faith` (in faith_details on 1.20), read once
        const field = (cache: Map<string, string | undefined>, type: string, key: string, k: string): string | undefined =>
        {
            if (!cache.has(key))
            {
                const e = this.idx.get(type, key);
                let v: string | undefined;
                const find = (list: PNode[]): void =>
                {
                    for (const c of list)
                    {
                        if (v)
                            return;

                        // (a value, or a list's first word: `building_gfx = { western_building_gfx }`)
                        if (c.k === k && typeof c.v === 'string')
                            v = c.v.replace(/"/g, '');
                        else if (c.k === k && Array.isArray(c.v))
                            v = c.v.find((x) => !x.k && typeof x.v === 'string')?.v
                                .toString()
                                .replace(/"/g, '');
                        else if (Array.isArray(c.v))
                            find(c.v);
                    }
                };
                const node = e && this.idx.defNode(e)?.node;

                if (node && Array.isArray(node.v))
                    find(node.v);

                cache.set(key, v);
            }

            return cache.get(key);
        };
        const out: Record<string, number[]> = {};

        for (let p = 1; p < meta.count; p++)
        {
            const hi = holding?.values[p] ?? -1;
            const loc = h.locs.get(p);
            // its special building, built (the layer's `slot:` things are empty slots), at its own locator
            const si = special?.values[p] ?? -1;
            const sl = h.special.get(p);
            const sk = si >= 0 && special?.things ? special.things[si].key : undefined;
            const own = sk && !sk.startsWith('slot:') && sl ? sk : undefined;

            if ((hi < 0 || !loc || !holding?.things) && !own)
                continue;

            const ck = culture?.things && (culture.values[p] ?? -1) >= 0 ? culture.things[culture.values[p]].key : undefined;
            const fk = faith?.things && (faith.values[p] ?? -1) >= 0 ? faith.things[faith.values[p]].key : undefined;
            const gfx = ck ? field(h.gfx, 'culture/cultures', ck, 'building_gfx') : undefined;
            const fg = fk ? h.faith.get(fk) : undefined;
            // the province's buildings at the date: its holding's primary building, history's, its special building
            const type = hi >= 0 && holding?.things ? holding.things[hi].key : undefined;
            const primary = type ? h.rules.primary.get(type) : undefined;
            const built = new Set<string>(primary ? [primary] : []);

            for (const e of h.built.get(p) ?? [])
                if (e.date <= when)
                    for (const k of e.keys)
                        built.add(k);

            if (own)
                built.add(own);

            // the holding at its level (history's castle_02 …)
            const mesh = type && loc ? holdingMesh(h.rules, type, p, gfx, fg, h.inRegion, holdingLevel(h.rules, primary, built)) : undefined;

            if (mesh && loc)
                (out[mesh] ??= []).push(loc[0], 0, loc[1], loc[2], loc[3]);

            // its walls (a background building) at the same place
            if (mesh && loc && type)
            {
                const walls = wallsOf(h.rules.walls, built, h.capitals.has(p), !!primary && h.rules.fortified.has(primary), type === 'tribal_holding', type === 'herder_holding');
                const wm = walls ? holdingMesh(h.rules, '', p, gfx, fg, h.inRegion, walls) : undefined;

                if (wm)
                    (out[wm] ??= []).push(loc[0], 0, loc[1], loc[2], loc[3]);
            }

            const sm = own ? holdingMesh(h.rules, '', p, gfx, fg, h.inRegion, own) : undefined;

            if (sm && sl)
                (out[sm] ??= []).push(sl[0], 0, sl[1], sl[2], sl[3]);
        }

        return out;
    }

    /**
     * A character as a bookmark would start them (docs/map.md, "Open items", bookmarks): at the date their primary
     * title and its government (history/titles), dynasty or house, culture, faith (history/characters), birth, sex.
     */
    bookmarkFacts(meta: RasterMeta, id: string, date: string): BookmarkFacts
    {
        const b = (this.base ??= this.build(meta.count));
        const when = dateNum(date);
        const out: BookmarkFacts = { id, name: id };
        b.env.holders.load([id]);
        const h = b.env.holders.get(id);

        if (h)
        {
            out.name = h.name;
            const f = holderAt(h, when);
            // (1.20: a rite is written as the `religion`; the game's own bookmarks: `religion = shafii`)
            const rite = lastAt(h.rite, when);
            Object.assign(out, f.house ? { house: f.house } : f.dynasty ? { dynasty: f.dynasty } : {}, f.culture ? { culture: f.culture } : {}, rite ? { faith: rite } : f.faith ? { faith: f.faith } : {});

            if (h.birth !== undefined)
                out.birth = `${Math.floor(h.birth / 10000)}.${Math.floor(h.birth / 100) % 100}.${h.birth % 100}`;
        }

        const e = this.idx.get('characters', id);
        const node = e && this.idx.defNode(e)?.node;

        if (Array.isArray(node?.v) && node.v.some((c) => c.k === 'female' && c.v === 'yes'))
            out.female = true;

        // their primary title at the date, and the government history gives its holder
        const state = titleState(b.tree, b.env, when);
        const hi = state.holders.indexOf(id);

        if (hi >= 0 && state.primary[hi] >= 0)
        {
            const t = state.primary[hi];
            out.title = b.tree.titles[t].key;
            const gov = lastAt(b.env.timelines.government[t], when);

            if (gov)
                out.government = gov;
        }

        return out;
    }
}

/** What a bookmark character block is filled from (MapData.bookmarkFacts). */
export interface BookmarkFacts
{
    id: string;
    name: string;
    female?: boolean;
    birth?: string;
    dynasty?: string;
    house?: string;
    culture?: string;
    faith?: string;
    /** their primary title at the date (absent: they hold none) */
    title?: string;
    government?: string;
}
