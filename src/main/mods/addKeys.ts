/**
 * Statements a game version requires and an older definition lacks (migrations.ts `adds`): the activity types of 1.20 name
 * their header picture (`header_background`), the 1.19 ones do not. Each definition of the files that lacks the key gets it,
 * first in the definition, from the first source that has one: a value the definition itself names elsewhere (a texture of
 * its `background` in the header folder), the game's definition of the same name (or of its name with one word left out:
 * a mod's prefix), a fixed fallback.
 */
import { parse, type PNode } from '../indexer/parser.ts';
import { insertFirst, type StatementEdit } from './scriptRules.ts';

export type AddSource =
    /** a block of the definition (`background`) with a `child` (`texture`) whose value matches the pattern: `key = "<value>"` */
    | { own: { block: string; child: string; value: string; }; }
    /** the game's definition of the same name has the key: its statements, as written */
    | { game: true; }
    /** `key = <text>` */
    | { text: string; };

export interface AddRule
{
    /** path patterns of the files it concerns */
    files: string[];
    key: string;
    label: string;
    /** where the statement comes from, in order */
    sources: AddSource[];
    /**
     * the game's statements that name something the loaded world lacks (a religion, a faith, a title, a family, a scripted
     * trigger) are not taken over: a block of the game's pilgrimage that tests `religion:islam_religion` is a scope error
     * in a mod without it. The names the statements refer to are asked of the index (`namedRefs`)
     */
    dropAbsent?: boolean;
}

/** The statements `key` of the game's definition of a name (as written), undefined when it has none. */
export type GameStatements = (name: string) => string[] | undefined;

/**
 * What a statement of the game's names, as `prefix:name`: the scope links (`religion:x`, `faith:x`, `culture:x`, `title:x`,
 * `rite:x`, `holy_site:x`, `trait:x`, `doctrine:x`, `tenet:x`), `family:rf_x` (`is_in_family`, `religion_family`), `trigger:x`
 * (a scripted trigger: a key ending in `_trigger`). Comments are not read.
 */
export function namedRefs(statement: string): string[]
{
    const text = statement.replace(/#[^\r\n]*/g, '');
    const out = new Set<string>();

    for (const m of text.matchAll(/\b(religion|faith|culture|title|rite|holy_site|trait|doctrine|tenet):([A-Za-z0-9_]+)/g))
        out.add(`${m[1]}:${m[2]}`);

    for (const m of text.matchAll(/\b(?:is_in_family|religion_family)\s*=\s*([A-Za-z0-9_]+)/g))
        out.add(`family:${m[1]}`);

    for (const m of text.matchAll(/\b([A-Za-z0-9_]+_trigger)\s*=/g))
        out.add(`trigger:${m[1]}`);

    return [...out];
}

const namesAbsent = (text: string, absent: Set<string>): boolean => namedRefs(text).some((r) => absent.has(r));

/** The text ranges to cut from a node so that it names nothing absent, null when no such node can be left (nothing can match). */
function absentCuts(n: PNode, text: string, absent: Set<string>): [number, number][] | null
{
    if (!namesAbsent(text.slice(n.s, n.e), absent))
        return [];

    if (!Array.isArray(n.v))
        return null;

    // (a negation of an absent name has no alternative to cut: its statement goes whole)
    if (n.k && /^(?:NOT|NOR|NAND)$/i.test(n.k))
        return null;

    const cuts: [number, number][] = [];
    const left: [number, number][][] = [];

    for (const c of n.v)
    {
        const r = absentCuts(c, text, absent);

        if (r)
            left.push(r);
        else if (n.k && /^OR$/i.test(n.k))
            cuts.push(lineRange(text, c));
        else
            return null;
    }

    // (an OR without an alternative left matches nothing)
    if (n.k && /^OR$/i.test(n.k) && !left.length)
        return null;

    return [...cuts, ...left.flat()];
}

/** A node's range with the whole line when it stands alone on it (the indent before, the line break after). */
function lineRange(text: string, n: PNode): [number, number]
{
    let s = n.s;
    let e = n.e;

    while (s > 0 && /[ \t]/.test(text[s - 1]))
        s--;

    while (e < text.length && /[ \t]/.test(text[e]))
        e++;

    // (a comment after it on the line goes with it)
    if (text[e] === '#')
        while (e < text.length && !/[\r\n]/.test(text[e]))
            e++;

    if ((s === 0 || text[s - 1] === '\n') && (e >= text.length || /[\r\n]/.test(text[e])))
        return [s, e < text.length ? e + (text.startsWith('\r\n', e) ? 2 : 1) : e];

    return [n.s, n.e];
}

/**
 * The statements of a game definition without what names something in `absent` (`prefix:name`, as namedRefs reads): an
 * alternative of an `OR` that names it is cut and the others stay (the game's steppe header tests four religions: a mod with
 * one of them keeps the block with that one); a statement that cannot be satisfied without it (it sits outside an `OR`, under
 * a `NOT`, or is the last alternative) is left out whole.
 */
export function withoutAbsent(statements: string[], absent: Set<string>): string[]
{
    if (!absent.size)
        return statements;

    const out: string[] = [];

    for (const s of statements)
    {
        if (!namesAbsent(s, absent))
        {
            out.push(s);
            continue;
        }

        const nodes = parse(s);
        const cuts = nodes.length === 1 ? absentCuts(nodes[0], s, absent) : null;

        if (!cuts)
            continue;

        let text = s;

        for (const [a, b] of [...cuts].sort((x, y) => y[0] - x[0]))
            text = text.slice(0, a) + text.slice(b);

        out.push(text);
    }

    return out;
}

/** A name and the names with one `_`-separated word left out ("activity_x_coronation" → "activity_coronation"). */
function nameVariants(name: string): string[]
{
    const words = name.split('_');
    return [name, ...(words.length > 1 ? words.map((_, i) => words.filter((_w, j) => j !== i).join('_')) : [])];
}

/** The statements one definition gets: from the first source that has one (none: nothing). */
function statementsFor(rule: AddRule, n: PNode, text: string, game: GameStatements): string[]
{
    for (const s of rule.sources)
    {
        if ('own' in s)
        {
            const re = new RegExp(`^(?:${s.own.value})$`);

            for (const b of Array.isArray(n.v) ? n.v : [])
            {
                const hit = b.k === s.own.block && Array.isArray(b.v) ? b.v.find((c) => c.k === s.own.child && typeof c.v === 'string' && re.test(c.v)) : undefined;

                if (hit)
                    return [`${rule.key} = "${hit.v as string}"`];
            }
        }
        else if ('game' in s)
        {
            for (const name of nameVariants(n.k!))
            {
                const found = game(name);

                if (found?.length)
                    return found;
            }
        }
        else
            return [`${rule.key} = ${s.text}`];
    }

    return [];
}

/** The insertions that give each definition of a text the key (none the definition has already). */
export function addKeyEdits(text: string, rule: AddRule, game: GameStatements): StatementEdit[]
{
    const out: StatementEdit[] = [];

    for (const n of parse(text))
    {
        if (!n.k || !Array.isArray(n.v) || n.v.some((c) => c.k === rule.key))
            continue;

        const lines = statementsFor(rule, n, text, game);

        if (lines.length)
            out.push(insertFirst(n, text, lines));
    }

    return out;
}

/** The game's statements `key` per definition name, from the text of one of its files. */
export function gameKeyStatements(gameText: string, key: string, into: Map<string, string[]>): void
{
    if (!gameText.includes(key))
        return;

    for (const n of parse(gameText))
    {
        const found = n.k && Array.isArray(n.v) ? n.v.filter((c) => c.k === key).map((c) => gameText.slice(c.s, c.e)) : [];

        if (found.length)
            into.set(n.k!, found);
    }
}
