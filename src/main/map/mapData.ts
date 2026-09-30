/**
 * What the map shows (docs/map.md), read through the index's file layering (mods included): the static part once
 * per index (title tree, province kinds and names, the history files as timelines, bookmark dates), then the state at
 * a history date — titles (titles.ts: holders, realms, names) and the layers (layers.ts: cultures, faiths, terrain …).
 * It goes to the renderer in two parts: MapStatic once, MapDated per date (compact: typed arrays, only what changes
 * with the date) — shared/mapCompose.ts makes MapInfo of them. The last dates' parts are kept: scrubbing back and forth
 * is instant.
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import { parse } from '../indexer/parser.ts';
import { T_FAITH, T_TITLE } from '../indexer/schema.ts';
import type { MapDated, MapInfo, MapLayer, MapNamed, MapStatic } from '../../shared/api.ts';
import type { RasterMeta } from './raster.ts';
import { DATE_KEY, dateNum, HistoryBook, lastAt, scalarOf, type Dated } from './history.ts';
import { HolderBook, holderAt } from './history-characters.ts';
import { MAP_KINDS, readKinds } from './kinds.ts';
import { readTitleTree, titleState, type TitleEnv, type TitleState, type TitleTree } from './titles.ts';
import { readTimelines } from './titles-history.ts';
import { TitleNamer } from './titles-names.ts';
import { composeMapInfo } from '../../shared/mapCompose.ts';
import { buildLayers, type LayerCtx } from './layers.ts';
import { provinceNames } from './names.ts';

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

    constructor(idx: GameIndex)
    {
        this.idx = idx;
    }

    /** The texts of a folder's .txt files, in load order. */
    texts(dir: string): string[]
    {
        return this.idx.vfs
            .list(dir, { ext: /\.txt$/i })
            .map((f) => this.idx.vfs.readText(f) ?? '')
            .filter(Boolean);
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
        const timelines = readTimelines(tree, titleHistory);
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
        // history/province_mapping: `<province> = <source>` — a province without history of its own has its source's culture
        let mapped: Map<number, number> | undefined;
        const mappedFrom = (p: number): number | undefined =>
        {
            mapped ??= new Map(this.texts('history/province_mapping').flatMap((text) => parse(text).flatMap((n) => (n.k && typeof n.v === 'string' && /^\d+$/.test(n.k) ? [[+n.k, +n.v] as [number, number]] : []))));
            return mapped.get(p);
        };
        const env: TitleEnv = {
            timelines,
            holders: new HolderBook(idx),
            namer: new TitleNamer(idx, tree, this.texts('common/flavorization')),
            holding: (t, when) => valueAt(tree.titles[t].tier === 'b' ? tree.titles[t].province : countyProvinces.get(t)?.[0], 'holding', when),
            culture: (county, when) =>
            {
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

    /** The map at a date (default: the first bookmark's), for a built raster — both parts composed. */
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
    private state(b: Base, meta: RasterMeta, at: string): { state: TitleState; layers: MapLayer[]; }
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
            cache: b.cache
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
}
