/**
 * Title history as timelines (docs/map.md, "History and realms"): per title its holders, de facto lieges, de jure
 * lieges, names, colours and governments by date — read once per index from history/titles, looked up by binary
 * search at any date.
 */
import type { PNode } from '../indexer/parser.ts';
import { colorOf } from './color.ts';
import { scalarOf, type Dated, type HistoryBook } from './history.ts';
import type { TitleTree } from './titles.ts';

export interface TitleTimelines
{
    /** per title: its holder's character id ('' from `holder = 0` on) */
    holder: Dated<string>[][];
    /** per title: its de facto liege title (−1: `liege = 0`) */
    liege: Dated<number>[][];
    /** per title: its de jure liege (−1: `de_jure_liege = 0`) — else the landed_titles parent */
    dejure: Dated<number>[][];
    /** per title: the loc key of its name ('': its own name again — `reset_name`, `reset_title_name`) */
    name: Dated<string>[][];
    /** per title: `set_title_color` */
    color: Dated<string>[][];
    /** per title: the government its holder gets at that date (`government = x`, `holder = { change_government = x }`) */
    government: Dated<string>[][];
    /** the span the history covers: from when a tenth of the counties has had a holder to the last holder changes (99.5th
     *  percentile of their dates) */
    range: [number, number];
}

/** A `limit`'s conditions as far as history needs them: DLC features are owned, a holder exists; else unknown. */
function limitHolds(list: PNode[]): boolean | undefined
{
    let out: boolean | undefined = true;

    for (const c of list)
    {
        let v: boolean | undefined;

        if (c.k === 'has_dlc_feature' || c.k === 'exists')
            v = true;
        else if (c.k === 'NOT' && Array.isArray(c.v))
        {
            const inner = limitHolds(c.v);
            v = inner === undefined ? undefined : !inner;
        }
        else if (c.k === 'AND' && Array.isArray(c.v))
            v = limitHolds(c.v);

        if (v === false)
            return false;

        if (v === undefined)
            out = undefined;
    }

    return out;
}

/** Title history → timelines. Effects may name other titles (`title:b_x = { set_title_name = … }`): theirs too. */
export function readTimelines(tree: TitleTree, book: HistoryBook): TitleTimelines
{
    const n = tree.titles.length;
    const make = <T>(): Dated<T>[][] => Array.from({ length: n }, () => []);
    const tl: TitleTimelines = { holder: make(), liege: make(), dejure: make(), name: make(), color: make(), government: make(), range: [0, 0] };
    const titleOf = (v: string | undefined): number => (v === undefined || v === '0' ? -1 : (tree.byKey.get(v.replace(/^title:/, '')) ?? -2));
    // effects: renames, de jure changes, colours and governments, followed into `title:x`, `holder` and `if` blocks
    const effect = (list: PNode[], t: number, date: number, holder: boolean): void =>
    {
        let taken = true;

        for (const c of list)
        {
            const v = scalarOf(c);
            const block = Array.isArray(c.v) ? c.v : undefined;

            if (c.k === 'if' || c.k === 'else_if' || c.k === 'else')
            {
                if (c.k !== 'if' && taken)
                    continue;

                const limit = block?.find((x) => x.k === 'limit');
                // (an unknown condition counts as met: the branch the game takes with every DLC)
                taken = c.k === 'else' || !limit || !Array.isArray(limit.v) || limitHolds(limit.v) !== false;

                if (taken && block)
                    effect(block, t, date, holder);
            }
            else if (block && c.k?.startsWith('title:'))
            {
                const o = titleOf(c.k);

                if (o >= 0)
                    effect(block, o, date, false);
            }
            else if (block && c.k === 'holder')
                effect(block, t, date, true);
            else if (holder)
            {
                if (c.k === 'change_government' && v)
                    tl.government[t].push({ date, v });
            }
            else if (c.k === 'set_title_name' && v)
                tl.name[t].push({ date, v });
            else if (c.k === 'reset_title_name')
                tl.name[t].push({ date, v: '' });
            else if (c.k === 'set_de_jure_liege_title')
            {
                const o = titleOf(v);

                if (o >= -1)
                    tl.dejure[t].push({ date, v: o });
            }
            else if (c.k === 'set_title_color')
            {
                const col = colorOf(c);

                if (col)
                    tl.color[t].push({ date, v: col });
            }
        }
    };
    const holderDates: number[] = [];

    for (const [key, stmts] of book.entries)
    {
        const t = tree.byKey.get(key);

        if (t === undefined)
            continue;

        for (const { date, node } of stmts)
        {
            const v = scalarOf(node);

            switch (node.k)
            {
                case 'holder':
                // (a holder the head of faith requirements do not apply to: 45 in vanilla, on d_sunni, d_shiite, d_imami …)
                case 'holder_ignore_head_of_faith_requirement':
                    if (v === undefined)
                        break;

                    tl.holder[t].push({ date, v: v === '0' ? '' : v });

                    if (date)
                        holderDates.push(date);

                    break;
                case 'liege':
                case 'de_jure_liege':
                {
                    const o = titleOf(v);

                    if (o >= -1)
                        (node.k === 'liege' ? tl.liege : tl.dejure)[t].push({ date, v: o });

                    break;
                }
                case 'name':
                    if (v)
                        tl.name[t].push({ date, v });

                    break;
                case 'reset_name':
                    if (v === 'yes')
                        tl.name[t].push({ date, v: '' });

                    break;
                case 'government':
                    if (v)
                        tl.government[t].push({ date, v });

                    break;
                case 'effect':
                    if (Array.isArray(node.v))
                        effect(node.v, t, date, false);
            }
        }
    }

    // (effects on other titles come in out of order; the sort is stable: a later statement of one date stays later)
    for (const lists of [tl.name, tl.dejure, tl.color, tl.government])
        for (const l of lists)
            if (l.length > 1)
                l.sort((a, b) => a.date - b.date);

    // the range: from when a tenth of the counties has had a holder, to the last holder changes
    const firstHeld = tl.holder.flatMap((l, t) => (tree.titles[t].tier === 'c' ?
        l.filter((x) => x.date && x.v)
            .slice(0, 1)
            .map((x) => x.date) :
        [])
    ).sort((a, b) => a - b);
    holderDates.sort((a, b) => a - b);

    if (firstHeld.length)
        tl.range = [firstHeld[Math.floor(firstHeld.length * 0.1)], holderDates[Math.floor((holderDates.length - 1) * 0.995)]];

    return tl;
}
