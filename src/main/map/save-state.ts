/**
 * The map from a loaded save (docs/saves.md, "The map"): the titles' holders, lieges and colours, the counties'
 * cultures, faiths and development and the baronies' holdings as the save has them, at its date only (no timeline).
 * The title timelines get one entry each at the save's date, so the map's usual state at a date (titles.ts
 * `titleState`) reads them unchanged; the holders are the save's characters (type savegame/characters, written like
 * history characters, saves/project.ts). Blocks changed by map edits are read as changed (`blockOf`: the session's).
 */
import { parse } from '../indexer/parser.ts';
import type { Gamestate } from '../saves/gamestate.ts';
import { entries } from '../saves/gamestate.ts';
import { colorOf } from './color.ts';
import { dateNum, type Dated } from './history.ts';
import type { TitleTimelines } from './titles-history.ts';
import type { TitleTree } from './titles.ts';

export interface SaveMapState
{
    date: string;
    timelines: TitleTimelines;
    /** county key → culture key */
    countyCulture: Map<string, string>;
    /** county key → faith key (a game faith's; a reformed one: its template) */
    countyFaith: Map<string, string>;
    /** county key → development */
    development: Map<string, number>;
    /** province id → holding type */
    holding: Map<number, string>;
    /** province id → its buildings (types, the great building's too), the 3D map's */
    buildings: Map<number, string[]>;
    /** province id → its special building (`special_building = { type }`, the older `great_building_type`) */
    special: Map<number, string>;
    /** province id → its duchy capital building (`duchy_capital_building = { type }`) */
    duchy: Map<number, string>;
}

/** A block path's bytes as changed (map edits, SaveSession.pathBlock), else undefined. */
export type BlockOf = (path: string) => Buffer | undefined;

/** A block's scalar fields (its own level); `color` as a node (a tagged block). */
function fields(b: Buffer): { f: Map<string, string>; color?: string; }
{
    const f = new Map<string, string>();
    let color: string | undefined;
    const open = b.indexOf(123);

    for (const x of entries(b, open))
    {
        if (!x.key)
            continue;

        if (x.key === 'color')
            color = colorOf(parse('color = ' + b.subarray(x.vs, x.ve).toString('latin1'))[0]);
        else if (!x.block)
            f.set(x.key, b.subarray(x.vs, x.ve).toString('latin1').replace(/^"|"$/g, ''));
    }

    return { f, color };
}

export function saveMapState(g: Gamestate, tree: TitleTree, blockOf: BlockOf = () => undefined): SaveMapState
{
    const b = g.buf;
    const date = g.date();
    const when = dateNum(date);
    const n = tree.titles.length;
    const empty = <T>(): Dated<T>[][] => Array.from({ length: n }, () => []);
    const timelines: TitleTimelines = { holder: empty(), liege: empty(), dejure: empty(), name: empty(), color: empty(), government: empty(), range: [when, when] };
    const db = g.sub(g.section('landed_titles'), 'landed_titles');
    // save title id → its key, and each title's fields
    const keyOf = new Map<number, string>();
    const rows: { key: string; holder?: string; liege?: number; dejure?: number; color?: string; }[] = [];

    if (db?.block)
    {
        for (const x of entries(b, db.vs, db.ve))
        {
            if (!x.block || !x.key || !/^\d+$/.test(x.key))
                continue;

            const { f, color } = fields(blockOf(`landed_titles/landed_titles/${x.key}`) ?? b.subarray(x.s, x.ve));
            const key = f.get('key');

            if (!key)
                continue;

            keyOf.set(Number(x.key), key);
            rows.push({
                key,
                holder: f.get('holder'),
                liege: f.has('de_facto_liege') ? Number(f.get('de_facto_liege')) : undefined,
                dejure: f.has('de_jure_liege') ? Number(f.get('de_jure_liege')) : undefined,
                color
            });
        }
    }

    const index = (id: number | undefined): number => (id === undefined ? -1 : tree.byKey.get(keyOf.get(id) ?? '') ?? -1);

    for (const r of rows)
    {
        const i = tree.byKey.get(r.key);

        if (i === undefined)
            continue;

        // (every title gets the save's word on its holder: none is "no holder", not "as in history")
        timelines.holder[i].push({ date: when, v: r.holder && r.holder !== '4294967295' ? r.holder : '' });

        if (r.liege !== undefined)
            timelines.liege[i].push({ date: when, v: index(r.liege) });

        if (r.dejure !== undefined)
            timelines.dejure[i].push({ date: when, v: index(r.dejure) });

        if (r.color)
            timelines.color[i].push({ date: when, v: r.color });
    }

    // titles the save doesn't have (never created, destroyed): unheld
    for (let i = 0; i < n; i++)
        if (!timelines.holder[i].length)
            timelines.holder[i].push({ date: when, v: '' });

    const cultures = g.cultures();
    // (a reformed faith: its template, since the map's faith colours are the game's; 1.20 saves: `faith_type`)
    const faithKeys = g.faithGameKeys();

    const countyCulture = new Map<string, string>();
    const countyFaith = new Map<string, string>();
    const development = new Map<string, number>();
    const counties = g.sub(g.section('county_manager'), 'counties');

    for (const x of counties?.block ? entries(b, counties.vs, counties.ve) : [])
    {
        if (!x.block || !x.key)
            continue;

        const { f } = fields(blockOf(`county_manager/counties/${x.key}`) ?? b.subarray(x.s, x.ve));
        const c = cultures.get(Number(f.get('culture')));
        // (1.18 / 1.19: `faith = <id>`; 1.20: `rite = <id>`, the rite's faith)
        const faithId = g.faithOf(f.get('faith'), f.get('rite'));
        const fa = faithId === undefined ? undefined : faithKeys.get(faithId);

        if (c)
            countyCulture.set(x.key, c);

        if (fa)
            countyFaith.set(x.key, fa);

        if (f.has('development'))
            development.set(x.key, Number(f.get('development')));
    }

    const holding = new Map<number, string>();
    const buildings = new Map<number, string[]>();
    const special = new Map<number, string>();
    const duchy = new Map<number, string>();
    const provinces = g.section('provinces');

    for (const x of provinces?.block ? entries(b, provinces.vs, provinces.ve) : [])
    {
        if (!x.block || !x.key || !/^\d+$/.test(x.key))
            continue;

        for (const f of entries(b, x.vs, x.ve))
        {
            if (f.key !== 'holding' || !f.block)
                continue;

            const built: string[] = [];
            const id = Number(x.key);
            const str = (e: { vs: number; ve: number; }): string => b.subarray(e.vs, e.ve).toString('latin1').replace(/^"|"$/g, '');
            // (a block's `type`: `special_building = { type = the_red_keep_03 }`)
            const typeIn = (e: { vs: number; ve: number; }): { vs: number; ve: number; } | undefined => [...entries(b, e.vs, e.ve)].find((t) => t.key === 'type' && !t.block);

            for (const h of entries(b, f.vs, f.ve))
            {
                if (h.key === 'type' && !h.block)
                    holding.set(id, str(h));
                // the special building (its built level: the block's `type`; `special_building_type` may name the level
                // being built), the duchy capital building; the older form `great_building_type`
                else if ((h.key === 'special_building' || h.key === 'duchy_capital_building') && h.block)
                {
                    const t = typeIn(h);

                    if (t)
                    {
                        built.push(str(t));
                        (h.key === 'special_building' ? special : duchy).set(id, str(t));
                    }
                }
                else if ((h.key === 'special_building_type' || h.key === 'great_building_type') && !h.block && !special.has(id))
                {
                    built.push(str(h));
                    special.set(id, str(h));
                }
                // (each slot a block: `{ type = x }`, empty ones `{ }`)
                else if (h.key === 'buildings' && h.block)
                {
                    for (const slot of entries(b, h.vs, h.ve))
                        for (const t of slot.block ? entries(b, slot.vs, slot.ve) : [])
                            if (t.key === 'type' && !t.block)
                                built.push(b.subarray(t.vs, t.ve).toString('latin1'));
                }
            }

            if (built.length)
                buildings.set(Number(x.key), built);

            break;
        }
    }

    return { date, timelines, countyCulture, countyFaith, development, holding, buildings, special, duchy };
}
