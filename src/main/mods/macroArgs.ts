/**
 * Macro arguments (migrations.ts `statements` with `macroArgs`, scriptRules.ts): a scripted trigger or effect that passes its
 * parameter on as the target of a statement a rule of the migration rewrites (`num_sinful_traits = { target = $FAITH$ }`: a
 * rite now) has its call sites decide: `FAITH = host.faith` is written for the old target. This finds the parameters whose every
 * use in the body is such a target (or the argument of another macro whose parameter is one), so the rules can rewrite the
 * call sites. A parameter that is used otherwise as well (`$FAITH$ = { … }`) is told, not converted: the call site passes one
 * thing for both uses. Plain Node.
 */
import type { PNode } from '../indexer/parser.ts';
import { eachWord, isWordName, pastFastPath, wordSet } from './wordRuns.ts';

/** A statement a macro parameter is the value of: `key = $P$` inside a block of one of `inside`. */
export interface MacroTarget
{
    key: string;
    inside: string[];
}

/** A definition of a scripted trigger or effect: its name and the parsed block. */
export interface MacroDef
{
    name: string;
    node: PNode;
}

/** The parameters of the macros that pass them on as a target; `left`: the ones that do, and are used otherwise too. */
export interface MacroArgs
{
    /** whether `macro = { PARAM = … }` passes PARAM only as a target */
    has(macro: string, param: string): boolean;
    /** whether PARAM is a target and also used in another way */
    left(macro: string, param: string): boolean;
    /** whether a text calls one of the macros that have such a parameter */
    mentions(text: string): boolean;
}

const PARAM = /\$([A-Za-z_][A-Za-z0-9_]*)\$/g;

/**
 * The definitions in a parsed script file: the top-level blocks of the scripted trigger and effect files (`scripted`), and the
 * `scripted_trigger name = { }` / `scripted_effect name = { }` of any file (events define them in their own files).
 */
export function macroDefinitions(nodes: PNode[], scripted: boolean): MacroDef[]
{
    const out: MacroDef[] = [];

    nodes.forEach((n, i) =>
    {
        if (!n.k || !Array.isArray(n.v) || n.k.startsWith('@'))
            return;

        const before = nodes[i - 1];

        if (before && before.k === null && (before.v === 'scripted_trigger' || before.v === 'scripted_effect'))
            out.push({ name: n.k, node: n });
        else if (scripted)
            out.push({ name: n.k, node: n });
    });

    return out;
}

/**
 * What `macroArgs` reads of a definition, without its parse tree (round 12: the game's are kept for the session, gameFacts.ts): every
 * use of each `$P$` in its body (`all`), and the statements whose whole unquoted value is one (`key = $P$` inside the block `parent`),
 * in the order the body has them.
 */
export interface MacroShape
{
    name: string;
    all: Map<string, number>;
    sites: { param: string; key: string; parent: string; }[];
}

/** The shape of a definition (its body walked once). */
export function macroShape(def: MacroDef): MacroShape
{
    const all = new Map<string, number>();
    const sites: MacroShape['sites'] = [];
    const count = (k: string): void => void all.set(k, (all.get(k) ?? 0) + 1);
    const walk = (nodes: PNode[], parent: string | undefined): void =>
    {
        for (const n of nodes)
        {
            for (const m of (n.k ?? '').matchAll(PARAM))
                count(m[1]);

            const v = typeof n.v === 'string' ? n.v : undefined;

            if (v !== undefined)
            {
                for (const m of v.matchAll(PARAM))
                    count(m[1]);

                const whole = /^\$([A-Za-z_][A-Za-z0-9_]*)\$$/.exec(v);

                if (whole && !n.q && n.k && parent)
                    sites.push({ param: whole[1], key: n.k, parent });
            }
            else if (Array.isArray(n.v))
                walk(n.v, n.k ?? parent);
        }
    };

    walk(Array.isArray(def.node.v) ? def.node.v : [], undefined);
    return { name: def.name, all, sites };
}

/** The uses of `$P$` in a macro's body: every occurrence, and those that stand as a target (or as an argument in `pairs`). */
function usesOf(def: MacroShape, targets: MacroTarget[], pairs: Set<string>): { all: Map<string, number>; ok: Map<string, number>; }
{
    const ok = new Map<string, number>();

    for (const s of def.sites)
        if (targets.some((t) => t.key === s.key && t.inside.includes(s.parent)) || pairs.has(`${s.parent}|${s.key}`))
            ok.set(s.param, (ok.get(s.param) ?? 0) + 1);

    return { all: def.all, ok };
}

/** The macro parameters of the definitions that stand only for a target of `targets` (and the ones that do so among other uses). */
export function macroArgs(defs: Iterable<MacroDef | MacroShape>, targets: MacroTarget[]): MacroArgs
{
    const list = [...defs].map((d) => ('node' in d ? macroShape(d) : d));
    const pairs = new Set<string>();
    const leftOver = new Set<string>();

    // (an argument handed on to another macro's target parameter makes the parameter one: until nothing is added)
    for (let grew = true; grew;)
    {
        grew = false;
        leftOver.clear();

        for (const d of list)
        {
            const { all, ok } = usesOf(d, targets, pairs);

            for (const [p, n] of ok)
            {
                if (n === all.get(p))
                {
                    if (!pairs.has(`${d.name}|${p}`))
                    {
                        pairs.add(`${d.name}|${p}`);
                        grew = true;
                    }
                }
                else
                    leftOver.add(`${d.name}|${p}`);
            }
        }
    }

    const names = [...new Set([...pairs, ...leftOver].map((p) => p.slice(0, p.indexOf('|'))))];
    const re = names.length ? new RegExp(`(?:^|[^\\w])(?:${names.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*=`) : undefined;
    // (past V8's fast path, names of word characters only: a whole word of them followed by `=` (wordRuns.ts, one pass), what the
    // expression finds)
    const words = pastFastPath(names) && names.every(isWordName) ? wordSet(names) : undefined;
    const assigned = /\s*=/y;

    return {
        has: (macro, param) => pairs.has(`${macro}|${param}`),
        left: (macro, param) => leftOver.has(`${macro}|${param}`) && !pairs.has(`${macro}|${param}`),
        mentions: (text) => (words ? eachWord(text, words, (_, from, to) => ((assigned.lastIndex = to), assigned.test(text))) : !!re && re.test(text))
    };
}
