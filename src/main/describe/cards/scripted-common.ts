/** Small helpers of the scripted cards (cards/scripted.ts, cards/scripted-templates.ts). */
import type { PNode } from '../../indexer/parser.ts';
import type { Rich } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import { capitalize, rich } from '../text.ts';

/** "a", "a and b", "a, b and c" (`last`: the last joint) */
export function joinRich(parts: Rich[], last = ' and '): Rich
{
    return rich(...parts.flatMap((p, i) => (i ? [i === parts.length - 1 ? last : ', ', ...p] : p)));
}

export function blockOf(list: PNode[], k: string): (PNode & { v: PNode[]; }) | undefined
{
    return list.find((c): c is PNode & { v: PNode[]; } => c.k === k && Array.isArray(c.v));
}

export function scalarOf(list: PNode[], k: string): string | undefined
{
    const c = list.find((x) => x.k === k);
    return typeof c?.v === 'string' ? c.v : undefined;
}

/** The bare values of a list block (`{ rival grudge }`). */
export function listOf(n: PNode | undefined): string[]
{
    return n && Array.isArray(n.v) ? n.v.filter((x) => typeof x.v === 'string').map((x) => x.v as string) : [];
}

/** Plural of a list's item: vassal → vassals, county → counties, child → children. */
export function plural(w: string): string
{
    if (/child$/.test(w))
        return w + 'ren';

    if (/[^aeiou]y$/.test(w))
        return w.slice(0, -1) + 'ies';

    return /(s|x|z|ch|sh)$/.test(w) ? w + 'es' : w + 's';
}

export function capFirst(r: Rich): Rich
{
    const [first, ...rest] = r;
    return typeof first === 'string' ? [capitalize(first), ...rest] : r;
}

/** The statement as written (a line's tooltip). */
export function raw(n: PNode, ctx: Ctx): string
{
    const t = ctx.src.slice(n.s, n.e);
    return t.length > 600 ? t.slice(0, 600) + '\n…' : t;
}
