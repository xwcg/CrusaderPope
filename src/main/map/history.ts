/**
 * Dated history files (history/titles, history/provinces … — docs/map.md): per entry (`c_paris = { … }`,
 * `2333 = { … }`) its statements with their dates — undated ones count from the start.
 */
import { parse, type PNode } from '../indexer/parser.ts';

export const DATE_KEY = /^\d+\.\d+\.\d+$/;

/**
 * A history block's date as the game reads it: y.m.d, also y and y.m, and with a dot after — vanilla writes
 * `867.1.1. = {` (e_khmer.txt: 25 counties' holders), `999 = {` (k_andhra.txt), `1084 = {` (k_pontus.txt), `895.1 = {`
 * (k_sulawesi.txt).
 */
export const HISTORY_DATE = /^\d+(\.\d+){0,2}\.?$/;

/** y.m.d (or y, y.m, a dot after) → a sortable number (y × 10000 + m × 100 + d) */
export function dateNum(d: string): number
{
    // (`895.1.`: the part after the last dot is empty — a missing month or day is the first)
    const [y, m, day] = d.split('.').map(Number);
    return y * 10000 + (m || 1) * 100 + (day || 1);
}

/** A value from a date on. */
export interface Dated<T>
{
    date: number;
    v: T;
}

/** The index of the last entry at or before the date in a list sorted by date (−1: none) — binary search. */
export function lastIndexAt(list: Dated<unknown>[], when: number): number
{
    let lo = 0;
    let hi = list.length;

    while (lo < hi)
    {
        const mid = (lo + hi) >> 1;

        if (list[mid].date <= when)
            lo = mid + 1;
        else
            hi = mid;
    }

    return lo - 1;
}

/** The value of the last entry at or before the date (a later entry of the same date wins). */
export function lastAt<T>(list: Dated<T>[] | undefined, when: number): T | undefined
{
    const i = list ? lastIndexAt(list, when) : -1;
    return i >= 0 ? list![i].v : undefined;
}

/** `"e_byzantium"` → e_byzantium (history writes some values quoted) */
export const unquote = (v: string): string => (v.startsWith('"') ? v.slice(1, -1) : v);

/** A statement's scalar value, unquoted (undefined for blocks). */
export const scalarOf = (n: PNode | undefined): string | undefined => (n && typeof n.v === 'string' ? unquote(n.v) : undefined);

export interface Stmt
{
    /** dateNum, 0: undated */
    date: number;
    node: PNode;
}

export class HistoryBook
{
    /** per entry: its statements, undated first, then by date (a later file's statements of one date after) */
    readonly entries = new Map<string, Stmt[]>();

    /** @param texts the files' texts in load order */
    constructor(texts: string[])
    {
        for (const text of texts)
        {
            for (const top of parse(text))
            {
                if (!top.k || !Array.isArray(top.v))
                    continue;

                const list = this.entries.get(top.k) ?? [];

                for (const c of top.v)
                {
                    if (!c.k)
                        continue;

                    if (HISTORY_DATE.test(c.k) && Array.isArray(c.v))
                    {
                        for (const x of c.v)
                            x.k && list.push({ date: dateNum(c.k), node: x });
                    }
                    else
                        list.push({ date: 0, node: c });
                }

                list.sort((a, b) => a.date - b.date);
                this.entries.set(top.k, list);
            }
        }
    }

    /** Each key's last statement at or before the date. */
    at(entry: string, when: number): Map<string, PNode>
    {
        const out = new Map<string, PNode>();

        for (const s of this.entries.get(entry) ?? [])
        {
            if (s.date > when)
                break;

            out.set(s.node.k!, s.node);
        }

        return out;
    }

    /** Every statement of a key up to the date, in order (effects that add up: `change_development_level`). */
    all(entry: string, key: string, when: number): Stmt[]
    {
        const out: Stmt[] = [];

        for (const s of this.entries.get(entry) ?? [])
        {
            if (s.date > when)
                break;

            if (s.node.k === key)
                out.push(s);
        }

        return out;
    }
}
