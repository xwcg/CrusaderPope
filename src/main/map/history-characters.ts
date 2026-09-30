/**
 * Title holders as the map needs them (docs/map.md, "History and realms"): name, birth and death, and by date
 * their culture, faith, dynasty, house, capital and the primary title history sets (`set_primary_title_to`). Read from
 * the index's history/characters entries when a character holds a title at a shown date, then kept.
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import type { PNode } from '../indexer/parser.ts';
import { T_CHARACTER } from '../indexer/schema.ts';
import { dateNum, HISTORY_DATE, lastAt, scalarOf, type Dated } from './history.ts';

export interface Holder
{
    id: string;
    name: string;
    birth?: number;
    death?: number;
    culture: Dated<string>[];
    faith: Dated<string>[];
    dynasty: Dated<string>[];
    house: Dated<string>[];
    /** their capital county (`capital = c_samarra`: 105 in vanilla) */
    capital: Dated<string>[];
    /** title keys (`set_primary_title_to = title:k_east_francia`) */
    primary: Dated<string>[];
}

/** character history key → Holder field (`religion` holds the faith) */
const DATED: Record<string, 'culture' | 'faith' | 'dynasty' | 'house' | 'capital'> = { culture: 'culture', religion: 'faith', faith: 'faith', dynasty: 'dynasty', dynasty_house: 'house', capital: 'capital' };

export class HolderBook
{
    private idx: GameIndex;
    private read = new Map<string, Holder | null>();

    constructor(idx: GameIndex)
    {
        this.idx = idx;
    }

    /** Reads the characters not read yet — in file order, so each history file is read once. */
    load(ids: Iterable<string>): void
    {
        const todo: { id: string; file: number; start: number; }[] = [];

        for (const id of ids)
        {
            if (this.read.has(id))
                continue;

            const e = this.idx.get(T_CHARACTER, id);
            const d = e?.defs[e.defs.length - 1];

            if (d)
                todo.push({ id, file: d.file, start: d.start });
            else
                this.read.set(id, null);
        }

        todo.sort((a, b) => a.file - b.file || a.start - b.start);

        for (const { id } of todo)
            this.read.set(id, this.parse(id));
    }

    get(id: string): Holder | undefined
    {
        if (!this.read.has(id))
            this.load([id]);

        return this.read.get(id) ?? undefined;
    }

    private parse(id: string): Holder | null
    {
        const e = this.idx.get(T_CHARACTER, id)!;
        const node = this.idx.defNode(e)?.node;

        if (!node || !Array.isArray(node.v))
            return null;

        const h: Holder = { id, name: this.idx.displayName(e) ?? id, culture: [], faith: [], dynasty: [], house: [], capital: [], primary: [] };
        const take = (c: PNode, date: number): void =>
        {
            const v = scalarOf(c);
            const field = c.k ? DATED[c.k] : undefined;

            if (field && v)
                h[field].push({ date, v });
            else if (c.k === 'set_primary_title_to' && v)
                h.primary.push({ date, v: v.replace(/^title:/, '') });
            else if (c.k === 'birth' && date)
                h.birth ??= date;
            else if (c.k === 'death' && date)
                h.death ??= date;
            else if (c.k === 'effect' && Array.isArray(c.v))
            {
                for (const x of c.v)
                    if (x.k === 'set_primary_title_to')
                        take(x, date);
            }
        };

        for (const c of node.v)
        {
            if (c.k && HISTORY_DATE.test(c.k) && Array.isArray(c.v))
            {
                const date = dateNum(c.k);

                for (const x of c.v)
                    take(x, date);
            }
            else
                take(c, 0);
        }

        for (const f of ['culture', 'faith', 'dynasty', 'house', 'capital', 'primary'] as const)
            h[f].sort((a, b) => a.date - b.date);

        return h;
    }
}

/** A holder's culture, faith, dynasty and house at a date. */
export function holderAt(h: Holder, when: number): { culture?: string; faith?: string; dynasty?: string; house?: string; }
{
    return { culture: lastAt(h.culture, when), faith: lastAt(h.faith, when), dynasty: lastAt(h.dynasty, when), house: lastAt(h.house, when) };
}
