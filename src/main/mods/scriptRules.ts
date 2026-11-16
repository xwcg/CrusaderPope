/**
 * Statement rules (migrations.ts `statements`): a game version changed how script is written (a trigger or effect
 * renamed, a value that has to name something else now, a link whose type changed). The rules work on the parsed script, not
 * on its text: a statement `key = value` is found by its key, optionally by its value (a pattern, or a name of a set read
 * from the files: the tenets), by the blocks around it and by the scope it stands in; it is renamed, its value rewritten
 * or the statement dropped. The scope comes from the definition (the root scope of a tenet's `piety_cost` is a rite, of its
 * `can_pick` a faith: `roots`) and changes with the scope blocks (`faith = {`, `rite = {`, `scope:x.faith = {`,
 * `any_faith = {` …); logic blocks (`AND`, `limit`, `if` …) keep it, any other block makes it unknown.
 * Only the statements are edited (the parser's offsets): comments, spacing and everything else stay as written.
 */
import { parse, type PNode } from '../indexer/parser.ts';
import type { MacroArgs, MacroTarget } from './macroArgs.ts';

/** The scopes the rules tell apart. A scope that is none of them (or not known) is `undefined`. */
export type StatementScope = 'faith' | 'rite';

export interface StatementRule
{
    /** the statement's key (exact) */
    key?: string;
    /** instead of `key`: the key matches this pattern (a weight `1 = name`); `bare`: the bare words of a list (`{ a b }`) */
    keyPattern?: string;
    bare?: boolean;
    /** a text the file must hold for the rule to be tried at all (when there is no `key`) */
    contains?: string;
    /** only a top-level statement of the file (a definition's key: `faith_creation = { … }`) */
    top?: boolean;
    /** the value, whole, matches this regular expression (a scalar) */
    value?: string;
    /** the value is (`valueNotIn`: is not) a name of this set read from the files: `tenets` */
    valueIn?: string;
    valueNotIn?: string;
    /** one of these blocks is around the statement (anywhere above it) / none is */
    inside?: string[];
    notInside?: string[];
    /** the statement's scope is one of these / none of these (an unknown scope is none of them) */
    scope?: StatementScope[];
    notScope?: StatementScope[];
    /**
     * the statement is a block and its text (comments left out) matches none of this pattern: a name only the new reading
     * of the block has tells a block already written for it (`any_holy_site = { holy_site_county … }`) from an old one
     */
    bodyNot?: string;
    /**
     * the statement is an argument of a call of a macro (a scripted trigger or effect, `name = { PARAM = value }`) whose body passes
     * PARAM only as a target the group's `macroArgs` name (macroArgs.ts): the call site writes what the target takes now. A
     * parameter the body uses otherwise as well is not rewritten; a call with a value the rules do not map is told
     */
    macroArg?: boolean;
    /** the new key */
    rename?: string;
    /** the new value: the `value` pattern's replacement (`$1` …) */
    replace?: string;
    /** the value is a name of this map read from the files (`StatementEnv.maps`): the new value is its entry (no entry: the rule does not apply) */
    valueMap?: string;
    /** the statement goes */
    drop?: boolean;
    /**
     * statements the definition the rule works in gets besides (`key = value`, first in it) unless it has the key already:
     * what the dropped or renamed statement stood for in the old version, written the new way
     */
    alsoAdd?: { key: string; value: string; }[];
    /**
     * the statement is a block whose `child` statements (`add = holder`, `add = { type = x limit = { … } }`) are collected
     * into one block `into` of keyed blocks `<definition>_<block>_<type> = { type = x … }` (the first one's place; the
     * others go). Not applied when a child has no `type`
     */
    collect?: { child: string; into: string; type: string; };
    /**
     * the definition's own `key = word` statements (directly in it) become the bare words of one block `into`
     * (`flag = x` → `parameters = { x }`): the first one's place gets the block, the others go; a block `into` that the
     * definition has takes the words at its end. Only words (a statement with another value is left alone)
     */
    gather?: { into: string; };
    /** statements of its own block that go with it (each must be there and match: else the rule is not applied) */
    children?: StatementRule[];
    /** not applied when the mod defines the old (`old`) or the new (`new`) name in this folder: its own definition wins */
    unlessDefined?: { folder: string; name: 'old' | 'new'; };
    /**
     * when the key (and the conditions) match but no rule maps the value: say so in the result; it stays as written. A
     * pattern: values matching it are fine as they are (a target that is a rite already). A rule with nothing else to do
     * only notes.
     */
    note?: boolean | string;
}

export interface StatementGroup
{
    /** path patterns of the files it concerns (`**` any folders, `*` a name part) */
    files: string[];
    label: string;
    rules: StatementRule[];
    /** `from:name` links (as key or value) whose name is in the set: `to:name` */
    links?: { from: string; to: string; valueIn: string; }[];
    /** the statements (`key = $P$` inside one of `inside`) whose macro parameter the `macroArg` rules rewrite at the call sites */
    macroArgs?: MacroTarget[];
}

/** The scope at the top of the blocks of a definition's folder (`blocks`: the child key → the scope its statements run in). */
export interface DefinitionRoot
{
    folder: string;
    blocks: Record<string, StatementScope>;
}

/** What a run of the rules reads besides the file. */
export interface StatementEnv
{
    /** the names of the sets rules refer to (`valueIn`) */
    sets: Record<string, Set<string>>;
    /** the maps rules refer to (`valueMap`): old name → new name, built when first needed */
    maps?: Record<string, () => Map<string, string>>;
    /** the macro parameters of a group's `macroArgs` (built when first needed) */
    macroArgs?(targets: MacroTarget[]): MacroArgs;
    /** whether the mod defines a top-level entry `key` in a folder (`unlessDefined`) */
    defined(folder: string, key: string): boolean;
    roots: DefinitionRoot[];
}

export interface StatementEdit
{
    s: number;
    e: number;
    text: string;
}

export interface StatementResult
{
    edits: StatementEdit[];
    /** statements the rules name but could not map, as `line N: key = value`; they stay */
    unmapped: string[];
}

/** Blocks that keep the scope they stand in (logic and control, the script values' operations). */
const KEEP = new Set([
    'AND', 'OR', 'NOT', 'NOR', 'NAND', 'if', 'else', 'else_if', 'limit', 'trigger', 'trigger_if', 'trigger_else', 'trigger_else_if',
    'first_valid', 'triggered_desc', 'desc', 'value', 'add', 'subtract', 'multiply', 'divide', 'min', 'max', 'modifier', 'weight',
    'text', 'hidden_effect', 'custom_tooltip', 'custom_description', 'show_as_tooltip', 'random', 'random_list', 'while'
]);

/**
 * The scope inside a block of this key, standing in `scope`. The scope links end a chain (`scope:x.faith`, `root.faith.main_rite`),
 * `faith:x` / `rite:x` name one, the iterators go over them.
 */
export function scopeAfter(scope: StatementScope | undefined, key: string): StatementScope | undefined
{
    if (KEEP.has(key) || /^\d+(?:\.\d+)?$/.test(key))
        return scope;

    const last = key.slice(key.lastIndexOf('.') + 1);

    if (last === 'faith' || last.startsWith('faith:') || /^(?:any|every|random|ordered)_faith$/.test(key))
        return 'faith';

    if (last === 'rite' || last === 'main_rite' || last === 'state_rite' || last.startsWith('rite:') || /^(?:any|every|random|ordered)_(?:faith_)?rite$/.test(key))
        return 'rite';

    return undefined;
}

/** The scope a definition's block starts in (`roots`), by the file's path and the block's key. */
function rootScope(roots: DefinitionRoot[], rel: string, key: string): StatementScope | undefined
{
    const r = roots.find((x) => rel.toLowerCase().startsWith(x.folder.toLowerCase() + '/'));
    return r?.blocks[key];
}

const asRegExp = (pattern: string): RegExp => new RegExp(`^(?:${pattern})$`);

/** Whether a rule's text could be in the file at all (the prefilter before parsing). */
export function mayHaveStatements(text: string, group: StatementGroup, env?: StatementEnv): boolean
{
    // (a rule needs its key, and one of the blocks it stands in; a macro argument, a call of one of the macros)
    return group.rules.some((r) => (r.macroArg ? !!group.macroArgs && !!env?.macroArgs?.(group.macroArgs).mentions(text) : text.includes(r.contains ?? r.key ?? '')) && (!r.inside || r.inside.some((k) => text.includes(k)))) || (group.links ?? []).some((l) => text.includes(l.from + ':'));
}

/** Whether a statement is the argument of a call a `macroArg` rule rewrites: `yes`; `left`: of a macro that uses the parameter otherwise as well. */
function argState(r: StatementRule, group: StatementGroup, n: PNode, anc: string[], env: StatementEnv): 'yes' | 'left' | undefined
{
    if (!r.macroArg)
        return 'yes';

    const args = group.macroArgs ? env.macroArgs?.(group.macroArgs) : undefined;
    const call = anc[anc.length - 1];

    if (!args || !n.k || !call)
        return undefined;

    return args.has(call, n.k) ? 'yes' : args.left(call, n.k) ? 'left' : undefined;
}

/** Whether a node is what the rule's key part names: its key, a key matching the pattern, a bare word of a list. */
function keyMatches(r: StatementRule, n: PNode): boolean
{
    if (r.bare)
        return n.k === null && typeof n.v === 'string';

    if (r.keyPattern)
        return n.k !== null && asRegExp(r.keyPattern).test(n.k);

    return r.key === n.k;
}

/** A statement's value as the rules see it: a scalar's text; undefined for a block. */
const scalarOf = (n: PNode): string | undefined => (typeof n.v === 'string' ? n.v : undefined);

/** Whether the value part of a rule holds for a node. */
function valueMatches(r: StatementRule, n: PNode, env: StatementEnv): boolean
{
    const v = scalarOf(n);

    if (r.value !== undefined && (v === undefined || !asRegExp(r.value).test(v)))
        return false;

    if (r.valueIn !== undefined && (v === undefined || !env.sets[r.valueIn]?.has(v)))
        return false;

    if (r.valueNotIn !== undefined && (v === undefined || env.sets[r.valueNotIn]?.has(v)))
        return false;

    if (r.valueMap !== undefined && (v === undefined || !env.maps?.[r.valueMap]?.().has(v)))
        return false;

    return true;
}

/** Whether the block's text holds none of the rule's `bodyNot` pattern (comments left out); a rule without one holds anywhere. */
function bodyMatches(r: StatementRule, n: PNode, text: string): boolean
{
    if (r.bodyNot === undefined)
        return true;

    return !new RegExp(r.bodyNot).test(text.slice(n.vs, n.e).replace(/#[^\r\n]*/g, ''));
}

/** Whether the rule's place conditions hold: top level, the blocks around, the scope. */
function placeMatches(r: StatementRule, top: boolean, scope: StatementScope | undefined, anc: string[]): boolean
{
    return !!r.top === top &&
        (!r.inside || r.inside.some((k) => anc.includes(k))) &&
        (!r.notInside || !r.notInside.some((k) => anc.includes(k))) &&
        (!r.scope || (!!scope && r.scope.includes(scope))) &&
        (!r.notScope || !scope || !r.notScope.includes(scope));
}

/** The edits of one rule at a node (renaming the key, the value, the children's), or undefined when it does not apply. */
function ruleEdits(r: StatementRule, n: PNode, text: string, env: StatementEnv, scope: StatementScope | undefined, anc: string[]): StatementEdit[] | undefined
{
    const out: StatementEdit[] = [];

    if (r.children)
    {
        if (!Array.isArray(n.v))
            return undefined;

        // (every child rule finds its statement, else the block would be half-renamed)
        for (const c of r.children)
        {
            const hit = n.v.find((x) => keyMatches(c, x) && valueMatches(c, x, env));
            const e = hit ? ruleEdits(c, hit, text, env, scope, [...anc, n.k ?? '']) : undefined;

            if (!e)
                return undefined;

            out.push(...e);
        }
    }

    if (r.drop)
        return [dropRange(text, n)];

    if (r.rename)
        out.push({ s: n.s, e: n.s + n.kl, text: r.rename });

    if (r.replace !== undefined)
    {
        const v = scalarOf(n);

        if (v === undefined)
            return undefined;

        const next = r.value === undefined ? r.replace : v.replace(asRegExp(r.value), r.replace);
        out.push({ s: n.vs, e: n.e, text: n.q ? `"${next}"` : next });
    }

    if (r.valueMap !== undefined)
    {
        const v = scalarOf(n);
        const next = v === undefined ? undefined : env.maps?.[r.valueMap]?.().get(v);

        if (next === undefined)
            return undefined;

        out.push({ s: n.vs, e: n.e, text: n.q ? `"${next}"` : next });
    }

    return out;
}

/** A line's leading white space. */
export const indentAt = (text: string, at: number): string => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', at - 1) + 1))![0];

/**
 * Statements (text, a statement may span lines) put first in a definition: one line each, with the indentation of its
 * first statement, in the file's line ends.
 */
export function insertFirst(entry: PNode, text: string, statements: string[]): StatementEdit
{
    const kids = Array.isArray(entry.v) ? entry.v : [];
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const indent = kids.length ? indentAt(text, kids[0].s) : '\t';
    // (after the brace, or after the comment that closes its line: `x = { # why`)
    const lineEnd = text.indexOf('\n', entry.vs);
    const rest = text.slice(entry.vs + 1, lineEnd < 0 ? text.length : lineEnd).trim();
    const at = lineEnd >= 0 && (!rest || rest.startsWith('#')) ? (text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd) : entry.vs + 1;
    return { s: at, e: at, text: statements.map((s) => eol + indent + s.replace(/\r?\n/g, eol)).join('') };
}

/**
 * The statements a rule adds to the definition (`alsoAdd`), first in it; none the definition has already (or an earlier
 * rule adds to it).
 */
function addEdits(r: StatementRule, entry: PNode, text: string, added: Set<string>): StatementEdit[]
{
    const kids = Array.isArray(entry.v) ? entry.v : [];
    const lines: string[] = [];

    for (const a of r.alsoAdd ?? [])
    {
        const id = `${entry.s}|${a.key}`;

        if (kids.some((c) => c.k === a.key) || added.has(id))
            continue;

        added.add(id);
        lines.push(`${a.key} = ${a.value}`);
    }

    return lines.length ? [insertFirst(entry, text, lines)] : [];
}

/**
 * The comments that belong to a statement of a block (`kids`: its statements, `open`: where the block's brace is): the
 * comment lines right above it (up to the statement before it), trimmed, with where the first one starts, and the comment
 * after it on its line; `end` is the end of the statement with that comment.
 */
export function statementNote(text: string, x: PNode, kids: PNode[], open: number): { lead: string[]; leadStart?: number; trail?: string; end: number; }
{
    const le = text.indexOf('\n', x.e);
    const tail = text.slice(x.e, le < 0 ? text.length : le).replace(/\r$/, '');
    const trail = tail.trim().startsWith('#') ? tail.trim() : undefined;
    const end = trail ? x.e + tail.trimEnd().length : x.e;
    const prev = kids[kids.indexOf(x) - 1];
    const floor = text.indexOf('\n', prev ? prev.e : open);
    const lead: string[] = [];
    let leadStart: number | undefined;
    let top = text.lastIndexOf('\n', x.s - 1) + 1;

    while (floor >= 0 && top - 1 > floor)
    {
        const ps = text.lastIndexOf('\n', top - 2) + 1;
        const line = text.slice(ps, top - 1).replace(/\r$/, '').trim();

        if (!line.startsWith('#') || ps <= floor)
            break;

        lead.unshift(line);
        leadStart = ps + (/^[ \t]*/.exec(text.slice(ps))![0].length);
        top = ps;
    }

    return { lead, leadStart, trail, end };
}

/**
 * A block's `child` statements as one block of keyed sets (`collect`): the first child's place gets it, the others go. The
 * keys are `<definition>_<block>_<type>` (numbered when a type repeats); a block that has the `into` block already gets the
 * sets added to it. Undefined when a child has no type.
 */
function collectEdits(r: StatementRule, n: PNode, text: string, entry: string): StatementEdit[] | undefined
{
    const c = r.collect!;
    const kids = Array.isArray(n.v) ? n.v : [];
    const children = kids.filter((x) => x.k === c.child);
    const typeOf = (x: PNode): string | undefined =>
    {
        const t = typeof x.v === 'string' ? x.v : x.v.find((y) => y.k === c.type && typeof y.v === 'string')?.v;
        return typeof t === 'string' && /^[A-Za-z_]\w*$/.test(t) ? t : undefined;
    };

    if (!children.length || children.some((x) => !typeOf(x)))
        return undefined;

    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const existing = kids.find((x) => x.k === c.into && Array.isArray(x.v));
    const taken = new Set((existing && Array.isArray(existing.v) ? existing.v : []).map((x) => x.k));
    const base = indentAt(text, existing ? existing.s : children[0].s);
    const inner = base + '\t';
    const sets: string[] = [];
    const seen = new Map<string, number>();
    // (a child's comments go with it: the comment lines right above it, and the one after it on its line. The first child's
    // comment lines above stay where they are: the block takes its place)
    const notes = new Map(children.map((x) => [x, statementNote(text, x, kids, n.vs)]));

    for (const x of children)
    {
        const note = notes.get(x)!;
        const type = typeOf(x)!;
        const nth = (seen.get(type) ?? 0) + 1;
        seen.set(type, nth);
        let key = `${entry}_${n.k}_${type}${nth > 1 ? `_${nth}` : ''}`;

        for (let i = nth + 1; taken.has(key); i++)
            key = `${entry}_${n.k}_${type}_${i}`;

        taken.add(key);
        // (a block keeps its statements, one level deeper; a bare type gets the statement `type = …`)
        const body = typeof x.v === 'string'
            ? `{${eol}${inner}\t${c.type} = ${x.v}${eol}${inner}}`
            : text.slice(x.vs, x.e).replace(/\r?\n/g, (m) => m + '\t');
        const lead = existing || x !== children[0] ? note.lead.map((l) => `${inner}${l}${eol}`).join('') : '';
        sets.push(`${lead}${inner}${key} = ${body}${note.trail ? ' ' + note.trail : ''}`);
    }

    const out: StatementEdit[] = [];

    if (existing)
    {
        // (before the closing brace of the block there is: its line's indentation stays in front of it)
        const close = existing.e - 1;
        const ls = text.lastIndexOf('\n', close - 1) + 1;
        const own = !text.slice(ls, close).trim();
        out.push({ s: own ? ls : close, e: own ? ls : close, text: sets.join(eol) + eol + (own ? '' : base) });
    }
    else
    {
        const block = `${c.into} = {${eol}${sets.join(eol)}${eol}${base}}`;
        out.push({ s: children[0].s, e: notes.get(children[0])!.end, text: block });
    }

    for (const x of existing ? children : children.slice(1))
    {
        const note = notes.get(x)!;
        out.push(dropRange(text, { ...x, s: note.leadStart ?? x.s, e: note.end }));
    }

    return out;
}

/**
 * A definition's `key = word` statements (the rule's key) as the bare words of one block (`gather`): the first one's place
 * gets the block, the others go; a block of that name the definition has takes the words at its end. Comments go with
 * their statement (the lines right above it, the one after it on its line). Undefined when `n` is no word statement; empty
 * for the later ones (the first made the whole edit).
 */
function gatherEdits(r: StatementRule, n: PNode, text: string, entry: PNode): StatementEdit[] | undefined
{
    const g = r.gather!;
    const kids = Array.isArray(entry.v) ? entry.v : [];
    const word = (x: PNode): boolean => x.k === r.key && typeof x.v === 'string' && /^[A-Za-z_][\w.:-]*$/.test(x.v);
    const mine = kids.filter(word);

    if (!word(n))
        return undefined;

    if (n !== mine[0])
        return [];

    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const existing = kids.find((x) => x.k === g.into && Array.isArray(x.v));
    const base = indentAt(text, existing ? existing.s : n.s);
    const first = existing && Array.isArray(existing.v) ? existing.v[0] : undefined;
    const inner = first && text.lastIndexOf('\n', first.s) > existing!.vs ? indentAt(text, first.s) : base + '\t';
    const notes = new Map(mine.map((x) => [x, statementNote(text, x, kids, entry.vs)]));
    const lines = mine.map((x) =>
    {
        const note = notes.get(x)!;
        const lead = existing || x !== mine[0] ? note.lead.map((l) => `${inner}${l}${eol}`).join('') : '';
        return `${lead}${inner}${x.v as string}${note.trail ? ' ' + note.trail : ''}`;
    });
    const out: StatementEdit[] = [];

    if (existing)
    {
        const close = existing.e - 1;
        const ls = text.lastIndexOf('\n', close - 1) + 1;
        const own = !text.slice(ls, close).trim();

        // (a block on one line takes the words there)
        if (!text.slice(existing.vs, close).includes('\n'))
            out.push({ s: close, e: close, text: `${/\s/.test(text[close - 1]) ? '' : ' '}${mine.map((x) => x.v as string).join(' ')} ` });
        else
            out.push({ s: own ? ls : close, e: own ? ls : close, text: lines.join(eol) + eol + (own ? '' : base) });
    }
    else
        out.push({ s: n.s, e: notes.get(n)!.end, text: `${g.into} = {${eol}${lines.join(eol)}${eol}${base}}` });

    for (const x of existing ? mine : mine.slice(1))
    {
        const note = notes.get(x)!;
        out.push(dropRange(text, { ...x, s: note.leadStart ?? x.s, e: note.end }));
    }

    return out;
}

/** The text a dropped statement takes: its line too when nothing else is on it. */
export function dropRange(text: string, n: PNode): StatementEdit
{
    const ls = text.lastIndexOf('\n', n.s - 1) + 1;
    const le = text.indexOf('\n', n.e);
    const alone = !text.slice(ls, n.s).trim() && !text.slice(n.e, le < 0 ? text.length : le).trim();
    return alone ? { s: ls, e: le < 0 ? text.length : le + 1, text: '' } : { s: n.s, e: n.e, text: '' };
}

/** The `from:name` link, as the scalar's text, with the name in the set: `to:name`. */
function linkEdit(text: string, links: NonNullable<StatementGroup['links']>, env: StatementEnv, at: number, len: number): StatementEdit | undefined
{
    const word = text.slice(at, at + len);

    for (const l of links)
    {
        if (word.startsWith(l.from + ':') && env.sets[l.valueIn]?.has(word.slice(l.from.length + 1)))
            return { s: at, e: at + l.from.length, text: l.to };
    }

    return undefined;
}

/**
 * The edits of a group's rules over a file's text (`rel`: its path, for the definitions' roots). `memo`: the parsed file,
 * shared by the groups run over the same text.
 */
export function statementEdits(text: string, rel: string, group: StatementGroup, env: StatementEnv, memo: { nodes?: PNode[]; } = {}): StatementResult
{
    const edits: StatementEdit[] = [];
    const unmapped: string[] = [];

    if (!mayHaveStatements(text, group, env))
        return { edits, unmapped };

    // depth 0: the file's top level (the definitions); 1: a definition's own statements, whose blocks start in the scope
    // the folder says; deeper: scope blocks and the like
    const added = new Set<string>();
    const walk = (nodes: PNode[], scope: StatementScope | undefined, anc: string[], depth: number, entry?: PNode): void =>
    {
        for (const n of nodes)
        {
            let dropped = false;

            if (group.links?.length)
            {
                // (as a key; as a value, and as a bare word of a list)
                const k = n.k ? linkEdit(text, group.links, env, n.s, n.kl) : undefined;
                const v = typeof n.v === 'string' && !n.q ? linkEdit(text, group.links, env, n.vs, n.e - n.vs) : undefined;

                if (k)
                    edits.push(k);

                if (v)
                    edits.push(v);
            }

            if (n.k || (n.k === null && typeof n.v === 'string'))
            {
                const mine = group.rules.filter((r) => keyMatches(r, n) && placeMatches(r, depth === 0, scope, anc) && argState(r, group, n, anc, env) !== undefined);
                let done = false;
                // (a name the mod defines itself keeps its calls on purpose: nothing to say about them)
                let kept = false;

                for (const r of mine)
                {
                    if (!r.rename && r.replace === undefined && !r.drop && r.valueMap === undefined && !r.collect && !r.gather)
                        continue;

                    // (a definition's own statements only)
                    if (r.gather && (depth !== 1 || !entry))
                        continue;

                    // (an argument of a macro that uses the parameter otherwise as well: it stays, and the result says so)
                    if (r.macroArg && argState(r, group, n, anc, env) === 'left')
                    {
                        if (valueMatches(r, n, env))
                        {
                            unmapped.push(`${rel}:${n.line} ${anc[anc.length - 1]} = { ${n.k} ${n.op ?? '='} ${scalarOf(n) ?? '{ … }'} } (the macro uses the parameter otherwise as well)`);
                            kept = true;
                        }

                        continue;
                    }

                    if (r.unlessDefined && env.defined(r.unlessDefined.folder, r.unlessDefined.name === 'old' ? n.k ?? '' : r.rename ?? n.k ?? ''))
                    {
                        kept = true;
                        continue;
                    }

                    if (!valueMatches(r, n, env) || !bodyMatches(r, n, text))
                        continue;

                    // (a statement an `alsoAdd` key replaces stays when the definition has that key with another value already:
                    // dropping it would lose what it said, and the result tells it)
                    const clash = r.drop && r.alsoAdd && entry && Array.isArray(entry.v)
                        ? entry.v.find((c) => r.alsoAdd!.some((a) => c.k === a.key && scalarOf(c) !== a.value))
                        : undefined;

                    if (clash)
                    {
                        unmapped.push(`${rel}:${n.line} ${n.k} ${n.op ?? '='} ${scalarOf(n) ?? '{ … }'} (${clash.k} = ${scalarOf(clash) ?? '{ … }'})`);
                        kept = true;
                        continue;
                    }

                    const e = r.collect ? collectEdits(r, n, text, entry?.k ?? '') : r.gather ? gatherEdits(r, n, text, entry!) : ruleEdits(r, n, text, env, scope, anc);

                    if (!e)
                        continue;

                    edits.push(...e);

                    if (r.alsoAdd && entry)
                        edits.push(...addEdits(r, entry, text, added));

                    // (a collected block is replaced whole: nothing inside it is looked at)
                    dropped = !!r.drop || !!r.collect;
                    done = true;
                    break;
                }

                // (the key is the rule's, the value is not one it can map: it stays, and the result says so)
                const v = scalarOf(n);

                if (!done && !kept && mine.some((r) => r.note && !(typeof r.note === 'string' && v !== undefined && asRegExp(r.note).test(v))))
                    unmapped.push(`${rel}:${n.line} ${n.k} ${n.op ?? '='} ${v ?? '{ … }'}`);
            }

            if (dropped || !Array.isArray(n.v))
                continue;

            // (the entry's own key is no block around its statements)
            if (depth === 0)
                walk(n.v, undefined, [], 1, n);
            else
                walk(n.v, n.k === null ? undefined : (depth === 1 ? rootScope(env.roots, rel, n.k) : undefined) ?? scopeAfter(scope, n.k), n.k === null ? anc : [...anc, n.k], depth + 1, entry);
        }
    };

    memo.nodes ??= parse(text);
    walk(memo.nodes, undefined, [], 0);
    return { edits, unmapped };
}

/** A text with the edits made (from the end, so earlier offsets stay right). */
export function applyStatementEdits(text: string, edits: StatementEdit[]): string
{
    let out = text;
    let limit = text.length + 1;

    for (const e of [...edits].sort((a, b) => b.s - a.s || b.e - a.e))
    {
        // (an edit inside one made already (a dropped block's) is gone with it)
        if (e.e > limit)
            continue;

        out = out.slice(0, e.s) + e.text + out.slice(e.e);
        limit = e.s;
    }

    return out;
}
