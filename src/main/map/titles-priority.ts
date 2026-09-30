/**
 * landed_titles `ai_primary_priority` (docs/map.md, "History and realms"): the script value a ruler weighs their titles
 * by when picking the primary one (root: the holder) — `add`s, also inside `if` / `else_if` / `else` whose `limit`
 * holds for the holder at the date. Vanilla (1515 titles: 1354 `add = @never_primary_score`, 15
 * `@always_primary_score`, the rest by culture) tests only `culture = culture:x`, `culture = { has_cultural_pillar =
 * heritage_x }`, `religion = religion:x`, `faith = faith:x`, `OR`, `AND`, `NOT`; a branch with other conditions is not
 * taken.
 */
import type { PNode } from '../indexer/parser.ts';
import { scalarOf } from './history.ts';

/** What the conditions test: the holder at the date. */
export interface PriorityFacts
{
    culture?: string;
    /** their culture's pillars (heritage, language, martial custom, ethos …) */
    pillars?: ReadonlySet<string>;
    faith?: string;
    religion?: string;
}

/** A title's priority: the same for everyone, or by holder. */
export type Priority = number | ((f: PriorityFacts) => number);

/** a condition: true, false, undefined (not known here) */
type Test = (f: PriorityFacts) => boolean | undefined;

const UNKNOWN: Test = () => undefined;

/** A trigger block: all its conditions (`any`: one of them), three-valued. */
function testOf(list: PNode[], any: boolean): Test
{
    const tests = list.map(conditionOf);
    return (f) =>
    {
        let out: boolean | undefined = !any;

        for (const t of tests)
        {
            const r = t(f);

            if (r === any)
                return any;

            if (r === undefined)
                out = undefined;
        }

        return out;
    };
}

function conditionOf(c: PNode): Test
{
    const v = scalarOf(c);
    const block = Array.isArray(c.v) ? c.v : undefined;

    switch (c.k)
    {
        case 'AND':
        case 'OR':
            return block ? testOf(block, c.k === 'OR') : UNKNOWN;
        case 'NOT':
        {
            const inner = block ? testOf(block, false) : UNKNOWN;
            return (f) =>
            {
                const r = inner(f);
                return r === undefined ? undefined : !r;
            };
        }
        case 'culture':
            if (v?.startsWith('culture:'))
                return (f) => f.culture === v.slice(8);

            if (block?.length === 1 && block[0].k === 'has_cultural_pillar')
            {
                const pillar = scalarOf(block[0]);
                return (f) => !!pillar && !!f.pillars?.has(pillar);
            }

            return UNKNOWN;
        case 'religion':
            return v?.startsWith('religion:') ? (f) => f.religion === v.slice(9) : UNKNOWN;
        case 'faith':
            return v?.startsWith('faith:') ? (f) => f.faith === v.slice(6) : UNKNOWN;
        default:
            return UNKNOWN;
    }
}

/** A title's `ai_primary_priority` block → its priority; `num` reads a value (the file's `@constants`). */
export function readPriority(block: PNode | undefined, num: (v: string | undefined) => number): Priority
{
    if (!block || !Array.isArray(block.v))
        return 0;

    let fixed = 0;
    const parts: { test: Test; add: number; chain: boolean; }[] = [];

    for (const c of block.v)
    {
        if (c.k === 'add')
            fixed += num(scalarOf(c));
        else if ((c.k === 'if' || c.k === 'else_if' || c.k === 'else') && Array.isArray(c.v))
        {
            const limit = c.v.find((x) => x.k === 'limit');
            const test: Test = c.k !== 'else' && limit && Array.isArray(limit.v) ? testOf(limit.v, false) : () => true;
            const add = c.v.reduce((s, x) => s + (x.k === 'add' ? num(scalarOf(x)) : 0), 0);
            parts.push({ test, add, chain: c.k !== 'if' });
        }
    }

    if (!parts.length)
        return fixed;

    return (f) =>
    {
        let sum = fixed;
        // (an else_if / else is tried only when the branches before it were not taken)
        let taken = false;

        for (const p of parts)
        {
            if (p.chain && taken)
                continue;

            taken = p.test(f) === true;

            if (taken)
                sum += p.add;
        }

        return sum;
    };
}

/** A title's priority for a holder. */
export const priorityFor = (p: Priority, f: PriorityFacts): number => (typeof p === 'number' ? p : p(f));
