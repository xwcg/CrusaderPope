/**
 * Data calls (migrations.ts `dataCalls`): interface and localization text calls the game's data system
 * (`[ClearExploringRealms]`, `[GetFaithDoctrine('x').GetName( GetPlayer.GetFaith )]`), and a game version renamed a
 * function, moved it to another type, gave it other arguments or removed it. The rules work on the expressions in
 * brackets, not on the file's text: a gui file is parsed (the property's value, comments never seen, the blocks around
 * it known), a localization file is read per `key:N "text"` line; inside an expression the text is split into
 * identifiers, quoted strings and punctuation, a chain `A.B( x, y ).C` into its segments with their arguments. Only
 * what a rule matches is replaced: a name inside a string, a longer name that merely contains the word, a text outside
 * the brackets stay as written.
 *
 * A rule names a function or a chain of two (`Type.Method`), optionally its arguments, and says what replaces it
 * (`rename`: the names only, any arguments stay; `call`: the whole call, the arguments `$1` … reused), or says that the
 * site changed in a way no rewrite maps (`report`). Interface rules can be limited to the block they stand in (a
 * `blockoverride "faith_context"`), drop a property, or add a sibling. A few families that need what the files say
 * (a doctrine of the old API is a tenet or a doctrine now, by where it is defined) are coded here (`special`).
 */
import { tr } from '../../shared/i18n.ts';
import { parseGui, type GNode } from '../gui/parser.ts';

export interface DataCallRule
{
    /** the function, or the chain `Type.Method` of two or more consecutive segments (case matters) */
    name: string;
    /** only in interface files (`gui`) or only in localization (`loc`) */
    in?: 'gui' | 'loc';
    /** interface: the block the statement stands in directly (`blockoverride "x"`, `block "x"`, a widget's `name`) has this name (not a block nested in it) */
    inside?: string;
    /** the last segment is not called (`none`) or called with this many arguments */
    args?: number | 'none';
    /** the arguments, as written (trimmed), match these whole-text patterns (position by position) */
    argMatch?: string[];
    /** the matched segments get these names (a chain of any length); a call's arguments stay */
    rename?: string;
    /** the whole matched call is replaced by this text: `$1` … are the arguments as written */
    call?: string;
    /** interface: the property is dropped when this call is all of its value */
    dropProperty?: boolean;
    /** nothing is changed: the site is told with this reason */
    report?: string;
    /** a family coded here: the old doctrine API (`GetFaithDoctrine`, `FaithDoctrine`, `FAITH_DOCTRINE`) */
    special?: 'faithDoctrine';
}

/** In a `block` the interface statement `key = "[X.<from>]"` gets a sibling `key = "[X.<to>]"` unless one ends in `<to>`. */
export interface SiblingRule
{
    inside: string;
    key: string;
    from: string;
    to: string;
}

export interface DataCallGroup
{
    /** path patterns of the files it concerns (`**` any folders, `*` a name part) */
    files: string[];
    label: string;
    rules: DataCallRule[];
    siblings?: SiblingRule[];
    /** localization keys whose structure the version changed: the game's text of the key replaces the mod's (the key goes from the patch copy) */
    keepGame?: string[];
    /** localization: names the version removed with no replacement; a key calling one goes when the game defines it, else it is told */
    gone?: string[];
    /**
     * localization: the texts the game's program fills itself (`DataCallEnv.engineFilled`) whose data context the version replaced
     * (the mod's text names one context the game's text of the key does not, the game's one the mod's does not): the mod's is renamed
     * to the game's, the rest of its wording stays; where no rename is safe, the game's text of the key replaces the mod's
     * (`contextChange`). A key whose file keeps the game's current text as a comment is the mod's choice: left. No `rules` needed
     */
    contexts?: boolean;
}

/** A data context of a text the game fills itself, renamed (`DataCallGroup.contexts`), or (no safe rename, `why`) the game's text written instead. */
export interface ContextChange
{
    key: string;
    /** the context the mod's text names (more than one: joined with ", ") */
    from: string;
    /** what the game's text names instead: a context, or a chain from one (`FaithConversionWindow.GetFaith`) */
    to: string;
    /** no safe rename, why: the game's text of the key replaces the mod's */
    why?: string;
    /** the game has no text of the key in the file's language: its English text was written */
    english?: boolean;
    /** left as the mod wrote it: the file keeps the game's current text of the key as a comment (the mod's line is deliberate) */
    kept?: boolean;
}

/** What the rules read besides the file. */
export interface DataCallEnv
{
    /** the names of the tenets (a doctrine of the old API in this set is `GetTenetType`) */
    tenets: Set<string>;
    /** whether the game defines a localization key (English) */
    gameKey?(key: string): boolean;
    /** the doctrine scope the game's own text of a key uses: a tenet (`TENET_TYPE`), a doctrine (`DOCTRINE_TYPE`), else (or both) undefined */
    gameScope?(key: string): 'tenet' | 'doctrine' | undefined;
    /** whether the game's program fills a localization key itself: a string of its executable that no loaded script or interface file names */
    engineFilled?(key: string): boolean;
    /** the game's text of a localization key in a language (`english`, `french` …); undefined: the game has none in it */
    gameText?(key: string, language: string): string | undefined;
    /** whether the game's own texts call `method` on a chain starting with `root` (`Rite.GetAdherentNamePlural`) */
    gameCalls?(root: string, method: string): boolean;
}

export interface CallEdit
{
    s: number;
    e: number;
    text: string;
}

export interface CallResult
{
    edits: CallEdit[];
    /** sites a rule names but cannot map, `line N: …` */
    left: string[];
    /** localization keys that go (the game's text wins) */
    dropped: string[];
    /** localization (`contexts`): per text the data context renamed, or the game's text written instead with the reason */
    contexts?: ContextChange[];
}

interface Tok
{
    t: 'id' | 'str' | 'num' | 'p';
    s: number;
    e: number;
    x: string;
}

interface Arg
{
    s: number;
    e: number;
    path?: Seg[];
}

interface Seg
{
    name: string;
    /** the name's offsets */
    s: number;
    ne: number;
    /** the end of the segment, its call included */
    e: number;
    call?: { args: Arg[]; };
}

/** Identifiers, numbers, quoted strings, single characters; blanks are skipped. Between `from` and `to` (the offsets are the text's). */
function tokenize(src: string, from = 0, to = src.length): Tok[]
{
    const out: Tok[] = [];
    let i = from;

    while (i < to)
    {
        const c = src[i];

        if (/\s/.test(c))
        {
            i++;
            continue;
        }

        const s = i;

        if (/[A-Za-z_]/.test(c))
        {
            while (i < to && /[A-Za-z0-9_]/.test(src[i]))
                i++;

            out.push({ t: 'id', s, e: i, x: src.slice(s, i) });
        }
        else if (/[0-9]/.test(c))
        {
            while (i < to && /[0-9.]/.test(src[i]))
                i++;

            out.push({ t: 'num', s, e: i, x: src.slice(s, i) });
        }
        else if (c === "'" || c === '"')
        {
            i++;

            while (i < to && src[i] !== c)
                i++;

            i = Math.min(to, i + 1);
            out.push({ t: 'str', s, e: i, x: src.slice(s, i) });
        }
        else
        {
            i++;
            out.push({ t: 'p', s, e: i, x: c });
        }
    }

    return out;
}

/** The index of the `)` closing the `(` at `open` (within `end`), else -1. */
function closing(toks: Tok[], open: number, end: number): number
{
    let depth = 0;

    for (let i = open; i < end; i++)
    {
        if (toks[i].t !== 'p')
            continue;

        if (toks[i].x === '(')
            depth++;
        else if (toks[i].x === ')' && --depth === 0)
            return i;
    }

    return -1;
}

/** The arguments between the tokens `a` and `b` (exclusive), split at the commas outside brackets. */
function splitArgs(toks: Tok[], a: number, b: number): Arg[]
{
    const out: Arg[] = [];

    if (a >= b)
        return out;

    let from = a;
    let depth = 0;

    for (let i = a; i <= b; i++)
    {
        const t = i < b ? toks[i] : undefined;

        if (t?.t === 'p' && (t.x === '(' || t.x === '['))
            depth++;
        else if (t?.t === 'p' && (t.x === ')' || t.x === ']'))
            depth--;

        if (i === b || (t?.t === 'p' && t.x === ',' && depth === 0))
        {
            if (i > from)
            {
                const p = parsePath(toks, from, i);
                out.push({ s: toks[from].s, e: toks[i - 1].e, path: p && p.next === i ? p.segs : undefined });
            }
            else
                out.push({ s: toks[Math.min(from, toks.length - 1)].s, e: toks[Math.min(from, toks.length - 1)].s });

            from = i + 1;
        }
    }

    return out;
}

/** A chain `A.B( x ).C` starting at token `i`: its segments and the token after it. */
function parsePath(toks: Tok[], i: number, end: number): { segs: Seg[]; next: number; } | undefined
{
    const segs: Seg[] = [];

    while (i < end && toks[i].t === 'id')
    {
        const seg: Seg = { name: toks[i].x, s: toks[i].s, ne: toks[i].e, e: toks[i].e };
        i++;

        if (i < end && toks[i].t === 'p' && toks[i].x === '(')
        {
            const close = closing(toks, i, end);

            if (close < 0)
                return segs.length ? { segs, next: i } : undefined;

            seg.call = { args: splitArgs(toks, i + 1, close) };
            seg.e = toks[close].e;
            i = close + 1;
        }

        segs.push(seg);

        if (i + 1 < end && toks[i].t === 'p' && toks[i].x === '.' && toks[i + 1].t === 'id')
        {
            i++;
            continue;
        }

        break;
    }

    return segs.length ? { segs, next: i } : undefined;
}

/** The text of an argument as written (trimmed). */
const argText = (src: string, a: Arg): string => src.slice(a.s, a.e).trim();

const isString = (src: string, a: Arg): boolean => /^(?:'[^']*'|"[^"]*")$/.test(argText(src, a));

const unquote = (s: string): string => s.replace(/^['"]|['"]$/g, '');

interface Ctx
{
    kind: 'gui' | 'loc';
    /** interface: the names of the blocks around */
    ancestors: string[];
    /** interface: the names of the block the statement stands in */
    parent?: string[];
    /** localization: the key */
    key?: string;
}

/** Whether `rule` matches the chain `path` at segment `k`; the offsets of what it covers. */
function matchAt(src: string, path: Seg[], k: number, rule: DataCallRule, ctx: Ctx): { s: number; e: number; names: number; } | undefined
{
    if (rule.in && rule.in !== ctx.kind)
        return undefined;

    if (rule.inside && !(ctx.parent ?? ctx.ancestors).includes(rule.inside))
        return undefined;

    const names = rule.name.split('.');

    for (let j = 0; j < names.length; j++)
    {
        const seg = path[k + j];

        if (!seg || seg.name !== names[j] || (j < names.length - 1 && seg.call))
            return undefined;
    }

    const last = path[k + names.length - 1];

    if (rule.args === 'none' && last.call)
        return undefined;

    if (typeof rule.args === 'number' && (!last.call || last.call.args.length !== rule.args))
        return undefined;

    for (const [i, re] of (rule.argMatch ?? []).entries())
    {
        const a = last.call?.args[i];

        if (!a || !new RegExp(`^(?:${re})$`).test(argText(src, a)))
            return undefined;
    }

    return { s: path[k].s, e: last.e, names: names.length };
}

/** The template of a `call` rule with the arguments of the matched call. */
function renderCall(template: string, src: string, last: Seg): string
{
    const args = last.call?.args.map((a) => argText(src, a)) ?? [];
    return template.replace(/\$(\d)/g, (_, d: string) => args[Number(d) - 1] ?? '');
}

/**
 * The argument of a function that takes a rite now, as a rite: `X.GetFaith` is `X.GetRite`, `Faith.Self` the rite in
 * scope (`Rite.Self`, as the game writes it where it has one: a key of the game's own) else the faith's main rite,
 * `FAITH.Self` its main rite. Undefined: it cannot be told.
 */
function toRite(text: string, ctx: Ctx, env: DataCallEnv): string | undefined
{
    let m = /^(.+)\.GetFaith$/.exec(text);

    if (m)
        return `${m[1]}.GetRite`;

    if (/^(?:.+\.)?(?:GetRite|GetMainRite|Rite\.Self|RITE\.Self)$/.test(text) || /^Rite\.Self$/.test(text))
        return text;

    m = /^(Faith|FAITH)\.Self$/.exec(text);

    if (m)
        return m[1] === 'Faith' && ctx.kind === 'loc' && ctx.key && env.gameKey?.(ctx.key) ? 'Rite.Self' : `${m[1]}.GetMainRite`;

    return undefined;
}

/**
 * A doctrine of the old API is a tenet (the game's `GetTenetType`) when its name is one: defined in tenet_types, or named as
 * the game names tenets (`tenet_preservation_trigger`, which the game passes to GetTenetType and defines nowhere).
 */
const isTenet = (env: DataCallEnv, name: string): boolean => env.tenets.has(name) || name.startsWith('tenet_');

interface Report
{
    at: number;
    why: string;
    name: string;
    /** found when a rule rewrote the site (an argument it could not map): later passes do not see it again */
    once?: boolean;
}

/** The edits one pass finds in a chain and the chains inside its arguments. */
function collect(src: string, path: Seg[], rules: DataCallRule[], env: DataCallEnv, ctx: Ctx, edits: CallEdit[], reports: Report[]): void
{
    const free = (s: number, e: number): boolean => !edits.some((x) => s < x.e && x.s < e);

    for (let k = 0; k < path.length; k++)
    {
        for (const rule of rules)
        {
            if (rule.special)
            {
                if (rule.in && rule.in !== ctx.kind)
                    continue;

                special(src, path, k, rule, env, ctx, edits, reports, free);
                continue;
            }

            const m = matchAt(src, path, k, rule, ctx);

            if (!m)
                continue;

            const last = path[k + m.names - 1];

            if (rule.report)
            {
                reports.push({ at: m.s, why: rule.report, name: rule.name });
                continue;
            }

            // (a call the version removed that is only part of a value; the whole-value case never gets here: its property went)
            if (rule.dropProperty)
            {
                reports.push({ at: m.s, why: tr('removed by the game version with no replacement; it is part of a larger expression, so it stays as written'), name: rule.name });
                continue;
            }

            if (rule.rename !== undefined)
            {
                // (the names only: from the first matched name to the end of the last name; its call stays)
                if (!free(m.s, last.ne))
                    continue;

                edits.push({ s: m.s, e: last.ne, text: rule.rename });
                break;
            }

            if (rule.call !== undefined && free(m.s, m.e))
            {
                edits.push({ s: m.s, e: m.e, text: renderCall(rule.call, src, last) });
                break;
            }
        }
    }

    for (const seg of path)
        for (const a of seg.call?.args ?? [])
            if (a.path)
                collect(src, a.path, rules, env, ctx, edits, reports);
}

/** The functions of the old doctrine API that take a rite now (`GetEffectsDescription`; a tenet's `GetName`). */
const takesRite = (name: string, tenet: boolean): boolean => name === 'GetEffectsDescription' || (tenet && (name === 'GetName' || name === 'GetNameNoTooltip'));

/** `GetFaithDoctrine`, `FaithDoctrine` and the localization scope `FAITH_DOCTRINE`: the type, and the rite its functions take. */
function special(src: string, path: Seg[], k: number, rule: DataCallRule, env: DataCallEnv, ctx: Ctx, edits: CallEdit[], reports: Report[], free: (s: number, e: number) => boolean): void
{
    const seg = path[k];

    if (seg.name !== rule.name)
        return;

    let to: string;
    let tenet = false;

    if (rule.name === 'GetFaithDoctrine')
    {
        const a = seg.call?.args;

        // (a doctrine not named by a string: tenet or doctrine cannot be told)
        if (!a || a.length !== 1 || !isString(src, a[0]))
        {
            reports.push({ at: seg.s, why: tr('the doctrine is not a string, so whether it is a tenet or a doctrine cannot be told'), name: rule.name });
            return;
        }

        tenet = isTenet(env, unquote(argText(src, a[0])));
        to = tenet ? 'GetTenetType' : 'GetDoctrineType';
    }
    else if (rule.name === 'FaithDoctrine')
        to = 'DoctrineType';
    else
    {
        // (a key the game has: the scope its own text uses; the tenet keys write TENET_TYPE)
        tenet = ctx.kind === 'loc' && !!ctx.key && env.gameScope?.(ctx.key) === 'tenet';
        to = tenet ? 'TENET_TYPE' : 'DOCTRINE_TYPE';
    }

    if (!free(seg.s, seg.ne))
        return;

    const next = path[k + 1];
    const takes = !!next && takesRite(next.name, tenet);
    const arg = takes && next.call?.args.length === 1 ? next.call.args[0] : undefined;
    const rite = arg ? toRite(argText(src, arg), ctx, env) : undefined;

    // (the name, and the argument that is a faith and has to be a rite, both or nothing: a half-converted call is no better)
    if (arg && rite !== undefined && rite !== argText(src, arg) && !free(arg.s, arg.e))
        return;

    edits.push({ s: seg.s, e: seg.ne, text: to });

    if (arg && rite !== undefined && rite !== argText(src, arg))
        edits.push({ s: arg.s, e: arg.e, text: rite });
    else if (arg && rite === undefined)
        reports.push({ at: arg.s, why: tr('the argument is a faith and the function takes a rite now'), name: next!.name, once: true });

    // (a call that gives no rite, or not one argument: nothing to convert)
    if (takes && !arg)
        reports.push({ at: next!.s, why: tr('the function takes a rite now and the call gives none'), name: next!.name, once: true });
}

/** The edits of one pass over an expression's text, with the sites to report. */
function pass(expr: string, rules: DataCallRule[], env: DataCallEnv, ctx: Ctx): { edits: CallEdit[]; reports: Report[]; }
{
    const toks = tokenize(expr);
    const p = toks.length && toks[0].t === 'id' ? parsePath(toks, 0, toks.length) : undefined;
    const edits: CallEdit[] = [];
    const reports: Report[] = [];

    if (p)
        collect(expr, p.segs, rules, env, ctx, edits, reports);

    return { edits, reports };
}

export function applyCallEdits(text: string, edits: CallEdit[]): string
{
    let out = text;

    for (const x of [...edits].sort((a, b) => b.s - a.s))
        out = out.slice(0, x.s) + x.text + out.slice(x.e);

    return out;
}

/** An expression rewritten by the rules, until nothing changes (a replacement can bring a rule's work into an argument). */
export function rewriteExpression(expr: string, rules: DataCallRule[], env: DataCallEnv, ctx: Ctx): { text: string; reports: Report[]; }
{
    let cur = expr;
    // (the sites told while rewriting are told once; the sites a rule only names are those of the last pass)
    const told: Report[] = [];

    for (let i = 0; i < 8; i++)
    {
        const r = pass(cur, rules, env, ctx);
        const next = applyCallEdits(cur, r.edits);
        told.push(...r.reports.filter((x) => x.once));

        if (next === cur)
            return { text: cur, reports: [...told.filter((x, j) => told.findIndex((y) => y.name === x.name && y.why === x.why) === j), ...r.reports.filter((x) => !x.once)] };

        cur = next;
    }

    return { text: cur, reports: [...told, ...pass(cur, rules, env, ctx).reports.filter((x) => !x.once)] };
}

/** The spans of the expressions in `[ ]` of a text between `from` and `to` (the offsets inside the brackets). */
export function expressionSpans(text: string, from: number, to: number): { s: number; e: number; }[]
{
    const out: { s: number; e: number; }[] = [];
    let i = from;

    while (i < to)
    {
        if (text[i] !== '[')
        {
            i++;
            continue;
        }

        let depth = 0;
        let quote = '';
        let j = i;

        for (; j < to; j++)
        {
            const c = text[j];

            if (c === '\n')
                break;

            if (quote)
            {
                if (c === quote)
                    quote = '';
            }
            else if (c === "'")
                quote = c;
            else if (c === '[')
                depth++;
            else if (c === ']' && --depth === 0)
                break;
        }

        if (j < to && text[j] === ']')
        {
            out.push({ s: i + 1, e: j });
            i = j + 1;
        }
        else
            i++;
    }

    return out;
}

const lineOf = (text: string, at: number): number =>
{
    let n = 1;

    for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1))
        n++;

    return n;
};

/** Words of the rules a file must hold for them to be tried at all. */
const needleMemo = new WeakMap<DataCallGroup, string[]>();

function needles(group: DataCallGroup): string[]
{
    let n = needleMemo.get(group);

    if (!n)
    {
        n = [...new Set([
            ...group.rules.map((r) => r.name.split('.').reduce((a, b) => (b.length > a.length ? b : a))),
            ...(group.siblings ?? []).map((s) => s.from),
            ...(group.keepGame ?? []),
            ...(group.gone ?? []),
            // (a context rule names no function: any text with an expression)
            ...(group.contexts ? ['['] : [])
        ])];
        needleMemo.set(group, n);
    }

    return n;
}

/** Whether a file's text can hold a site of the group (a cheap test before parsing it). */
export function mayHaveCalls(text: string, group: DataCallGroup): boolean
{
    return needles(group).some((w) => text.includes(w));
}

/** The property of a statement `key = "value"` whose value is exactly one expression. */
function wholeExpression(text: string, n: GNode): { s: number; e: number; } | undefined
{
    const spans = valueSpans(text, n);
    return spans.length === 1 && spans[0].whole ? spans[0] : undefined;
}

/** The expressions in a property's value (`whole`: the value is nothing but that expression). */
function valueSpans(text: string, n: GNode): { s: number; e: number; whole: boolean; }[]
{
    const eq = text.indexOf('=', n.s);

    if (eq < 0 || eq >= n.e)
        return [];

    let vs = eq + 1;

    while (vs < n.e && /\s/.test(text[vs]))
        vs++;

    const quoted = text[vs] === '"' && n.quoted;
    const from = quoted ? vs + 1 : vs;
    const to = quoted ? n.e - 1 : n.e;
    return expressionSpans(text, from, to).map((x) => ({ ...x, whole: x.s - 1 === from && x.e + 1 === to }));
}

/** The line (with its ending) a statement stands on, when nothing else is on it, else the statement alone. */
function statementRange(text: string, n: GNode): { s: number; e: number; }
{
    const ls = text.lastIndexOf('\n', n.s - 1) + 1;
    const le = text.indexOf('\n', n.e);
    const end = le < 0 ? text.length : le + 1;
    return !text.slice(ls, n.s).trim() && !text.slice(n.e, le < 0 ? text.length : le).trim() ? { s: ls, e: end } : { s: n.s, e: n.e };
}

/** The names a block goes by: its own (`blockoverride "x"`), its `name` property, its key. */
const namesOf = (n: GNode): string[] => [n.name, n.children?.find((c) => c.key === 'name')?.value, n.key].filter((x): x is string => !!x);

/** The edits of the rules in an interface file. */
export function guiCallEdits(text: string, group: DataCallGroup, env: DataCallEnv): CallResult
{
    const res: CallResult = { edits: [], left: [], dropped: [] };

    // (the context rule is one of localization)
    if (group.contexts || !mayHaveCalls(text, group))
        return res;

    const rules = group.rules.filter((r) => r.in !== 'loc');
    const siblings = group.siblings ?? [];

    const visit = (nodes: GNode[], ancestors: string[], parent: string[]): void =>
    {
        for (const n of nodes)
        {
            if (n.children)
            {
                const names = namesOf(n);
                visit(n.children, [...ancestors, ...names], names);
                continue;
            }

            if (!n.key || n.value === undefined || !n.value.includes('['))
                continue;

            const ctx: Ctx = { kind: 'gui', ancestors, parent };
            const whole = wholeExpression(text, n);

            // (a property that is nothing but a call the version removed: it goes with its line)
            if (whole && matchesWhole(text.slice(whole.s, whole.e), rules.filter((r) => r.dropProperty), ctx))
            {
                res.edits.push({ ...statementRange(text, n), text: '' });
                continue;
            }

            for (const sp of valueSpans(text, n))
            {
                const expr = text.slice(sp.s, sp.e);
                const r = rewriteExpression(expr, rules, env, ctx);

                if (r.text !== expr)
                    res.edits.push({ s: sp.s, e: sp.e, text: r.text });

                for (const x of r.reports)
                    res.left.push(tr('line {n}: {name} — {why}', { n: lineOf(text, sp.s), name: x.name, why: x.why }));
            }
        }
    };

    visit(parseGui(text), [], []);

    // (a sibling statement: in a block, `datacontext = "[X.GetFaith]"` also gets the rite)
    if (siblings.length)
        res.edits.push(...siblingEdits(text, parseGui(text), siblings, res.edits));

    return res;
}

/** Whether the expression is, whole, a call one of the rules names. */
function matchesWhole(expr: string, rules: DataCallRule[], ctx: Ctx): boolean
{
    const toks = tokenize(expr);
    const p = toks.length && toks[0].t === 'id' ? parsePath(toks, 0, toks.length) : undefined;

    if (!p || p.next !== toks.length)
        return false;

    return rules.some((r) => !r.special && matchAt(expr, p.segs, 0, r, ctx)?.e === toks[toks.length - 1].e);
}

/** The siblings to add: after a statement of the rule's key in the block, unless one of the block ends so already. */
function siblingEdits(text: string, nodes: GNode[], rules: SiblingRule[], done: CallEdit[]): CallEdit[]
{
    const out: CallEdit[] = [];

    const visit = (list: GNode[]): void =>
    {
        for (const n of list)
        {
            if (n.children)
            {
                visit(n.children);

                for (const r of rules)
                {
                    // (the statements of the block itself, not of a block nested in it)
                    if (!namesOf(n).includes(r.inside))
                        continue;

                    const mine = n.children.filter((c) => c.key === r.key && c.value !== undefined);
                    const ends = (c: GNode, w: string): boolean => new RegExp(`^\\[(.+)\\.${w}\\]$`).test(c.value!.trim());

                    if (mine.some((c) => ends(c, r.to)))
                        continue;

                    for (const c of mine.filter((x) => ends(x, r.from)))
                    {
                        // (what the value becomes after this run's other edits: a rewritten one is not this rule's)
                        if (done.some((x) => x.s >= c.s && x.e <= c.e))
                            continue;

                        const m = new RegExp(`^\\[(.+)\\.${r.from}\\]$`).exec(c.value!.trim())!;
                        const le = text.indexOf('\n', c.e);
                        const lineEnd = le < 0 ? text.length : le;
                        const eol = le > 0 && text[le - 1] === '\r' ? '\r\n' : '\n';
                        const indent = /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', c.s - 1) + 1, c.s))![0];
                        const insertAt = text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
                        const statement = `${r.key} = "[${m[1]}.${r.to}]"`;
                        const rest = text.slice(c.e, insertAt).trim();

                        // (more on the line than a comment, the block closes there: the sibling follows the statement)
                        if (rest && !rest.startsWith('#'))
                            out.push({ s: c.e, e: c.e, text: ` ${statement}` });
                        else
                            out.push({ s: insertAt, e: insertAt, text: `${eol}${indent}${statement}` });

                        break;
                    }
                }
            }
        }
    };

    visit(nodes);
    return out;
}

/** The identifiers of an expression. */
const identifiers = (expr: string): string[] => tokenize(expr).filter((t) => t.t === 'id').map((t) => t.x);

const LOC_LINE = /^([ \t]*)([^\s:#"]+):\d*[ \t]+"/;

/**
 * The index of the closing quote of a localization line whose text starts at `from`: the last quote of the line (a text can
 * hold quotes of its own), unless a quote is followed by a comment (` # "note"`): then the first such quote.
 */
function textEnd(line: string, from: number): number
{
    const last = line.lastIndexOf('"');

    for (let i = line.indexOf('"', from); i >= 0 && i < last; i = line.indexOf('"', i + 1))
        if (/^[ \t]+#/.test(line.slice(i + 1)))
            return i;

    return last;
}

/** The keys of a localization file with their texts, read as `locCallEdits` reads them (a later line of a key wins). */
export function locValues(text: string): Map<string, string>
{
    const out = new Map<string, string>();

    for (const line of text.split('\n'))
    {
        const m = LOC_LINE.exec(line);
        const q = m ? textEnd(line, m[0].length) : -1;

        if (m && q >= m[0].length)
            out.set(m[2], line.slice(m[0].length, q));
    }

    return out;
}

/**
 * The texts of a localization file's commented-out lines per key: `#KEY:0 "text"`, `# KEY: "text"` (leading blanks, blanks after
 * the `#`, any version number); the text between the quotes as `locCallEdits` reads a live one (exactly, nothing normalised).
 */
function commentedTexts(text: string): Map<string, Set<string>>
{
    const out = new Map<string, Set<string>>();

    for (const line of text.split('\n'))
    {
        const m = /^[ \t]*#[ \t]*([^\s:#"]+):\d*[ \t]*"/.exec(line);
        const q = m ? textEnd(line, m[0].length) : -1;

        if (m && q >= m[0].length)
            out.set(m[1], (out.get(m[1]) ?? new Set()).add(line.slice(m[0].length, q)));
    }

    return out;
}

/** The language of a localization file: its header (`l_french:`), else its name (`…_l_french.yml`), else English. */
export function languageOf(text: string, rel = ''): string
{
    const m = /^﻿?(?:[ \t]*(?:#[^\n]*)?\r?\n)*[ \t]*l_([A-Za-z_]+)[ \t]*:/.exec(text) ?? /_l_([A-Za-z_]+)\.yml$/i.exec(rel);
    return m ? m[1].toLowerCase() : 'english';
}

/**
 * A name a text calls as a function valid anywhere, not as a data context it is given: `GetPlayer`, `GetNullCharacter`,
 * `Select_CString`, `IsLocalPlayer`, `CanAnyoneUnpause`, `JominiIsHostOrLocal`, `EmptyScope`, `GuiScope`; a heuristic on the names,
 * as guiWork.ts `dataRoots` (a name that is called, `AddLocalizationIf( … )` / `Concept( … )`, is a function anyway).
 */
const GLOBAL_NAME = /^(?:(?:Get|Is|Has|Can|Select|Localize|Concatenate)(?![a-z])|Jomini)|Scope$/;

/**
 * The chains of a text's expressions between `from` and `to` that start from a data context: the first segment capitalised, not
 * called and no global function by its name (`FAITH` in `[FAITH.GetName]`, `Rite` in `[X.GetName( Rite.Self )]`), the
 * chains in arguments too. Offsets are the text's.
 */
function contextSites(text: string, from: number, to: number): Seg[][]
{
    const out: Seg[][] = [];
    const visit = (path: Seg[]): void =>
    {
        if (!path[0].call && /^[A-Z]/.test(path[0].name) && !GLOBAL_NAME.test(path[0].name))
            out.push(path);

        for (const seg of path)
            for (const a of seg.call?.args ?? [])
                if (a.path)
                    visit(a.path);
    };

    for (const sp of expressionSpans(text, from, to))
    {
        const toks = tokenize(text, sp.s, sp.e);
        const p = toks.length && toks[0].t === 'id' ? parsePath(toks, 0, toks.length) : undefined;

        if (p)
            visit(p.segs);
    }

    return out;
}

/**
 * A text the game fills itself (`DataCallGroup.contexts`): the mod's text (between `from` and `to` of `text`) against the game's
 * text of the key. When the mod's names exactly one data context the game's does not and the game's exactly one the mod's does
 * not, the mod's is renamed wherever it starts a chain: to the game's context, or to the chain the game's text reaches the same
 * calls through (`FAITH.GetNameNoTooltip` ↔ `FaithConversionWindow.GetFaith.GetNameNoTooltip`: the calls after the context are
 * compared from the end). A call after the old context that the game's text does not make after the new one must be one the game's
 * texts make on it somewhere (`Rite.GetAdherentNamePlural`): renaming `Character.GetBirthDate` to `DATE` would break the text.
 * Where no rename is safe (several contexts either way, a call the game never makes on the new one, several chains), the game's
 * text of the key replaces the mod's (the owner's choice, 2026-11-05: no broken line, though that key loses the mod's wording);
 * the key's `:N` and anything after the closing quote stay.
 */
function contextChange(key: string, text: string, vs: number, ve: number, game: string, env: DataCallEnv): { edits: CallEdit[]; change?: ContextChange; }
{
    const mine = contextSites(text, vs, ve);
    const theirs = contextSites(game, 0, game.length);
    const m = new Set(mine.map((p) => p[0].name));
    const g = new Set(theirs.map((p) => p[0].name));
    const old = [...m].filter((n) => !g.has(n));
    const now = [...g].filter((n) => !m.has(n));

    // (no context of the mod's the game's text lacks, or none the game's text has instead: nothing to say which one replaced it)
    if (!old.length || !now.length)
        return { edits: [] };

    // (no safe rename: the game's text in place of the mod's)
    const told = (why: string, into = now.join(', ')): { edits: CallEdit[]; change: ContextChange; } => ({ edits: [{ s: vs, e: ve, text: game }], change: { key, from: old.join(', '), to: into, why } });

    if (old.length > 1 || now.length > 1)
        return told(tr('not one context each way: which replaces which cannot be told'));

    const uses = mine.filter((p) => p[0].name === old[0]);
    const prefixes = new Set<string>();
    const matched = new Set<Seg[]>();

    // (the calls after the old context, found at the end of a chain of the game's text from the new one: what stands before them replaces it)
    for (const u of uses)
    {
        const tail = u.slice(1).map((x) => x.name);

        if (!tail.length)
            continue;

        for (const t of theirs.filter((p) => p[0].name === now[0]))
        {
            const k = t.length - tail.length;

            if (k >= 1 && tail.every((n, i) => t[k + i].name === n))
            {
                prefixes.add(k === 1 ? now[0] : game.slice(t[0].s, t[k - 1].e));
                matched.add(u);
            }
        }
    }

    if (prefixes.size > 1)
        return told(tr('the game’s text reaches the same calls in more than one way'), [...prefixes].join(', '));

    const into = prefixes.size ? [...prefixes][0] : now[0];

    // (a chain from the new context only where the game's text has every call the mod's makes on the old one after it)
    if (into !== now[0] && uses.some((u) => !matched.has(u)))
        return told(tr('the game’s text reaches it through a chain, but not for every call the mod’s text makes on it'), into);

    const missing = into === now[0] ? [...new Set(uses.filter((u) => !matched.has(u) && u.length > 1 && !env.gameCalls?.(now[0], u[1].name)).map((u) => `${now[0]}.${u[1].name}`))] : [];

    if (missing.length)
        return told(tr('the game’s texts never call {calls}', { calls: missing.join(', ') }));

    return { edits: uses.map((u) => ({ s: u[0].s, e: u[0].ne, text: into })), change: { key, from: old[0], to: into } };
}

/** The edits of the rules in a localization file: per line `key:N "text"`, in the brackets of its text. `rel`: the file's path (its language, for `contexts`). */
export function locCallEdits(text: string, group: DataCallGroup, env: DataCallEnv, rel = ''): CallResult
{
    const res: CallResult = { edits: [], left: [], dropped: [] };

    if (!mayHaveCalls(text, group))
        return res;

    const rules = group.rules.filter((r) => r.in !== 'gui');
    const keepGame = new Set(group.keepGame ?? []);
    const gone = new Set(group.gone ?? []);
    const language = group.contexts ? languageOf(text, rel) : '';
    // (the context rule: the file's commented-out texts per key, read when first needed)
    let comments: Map<string, Set<string>> | undefined;
    let pos = 0;

    while (pos < text.length)
    {
        const nl = text.indexOf('\n', pos);
        const end = nl < 0 ? text.length : nl;
        const lineStart = pos;
        pos = nl < 0 ? text.length : nl + 1;
        const line = text.slice(lineStart, end);
        const m = LOC_LINE.exec(line);

        if (!m)
            continue;

        const key = m[2];
        const vs = lineStart + m[0].length;
        const q = textEnd(line, m[0].length);
        const ve = lineStart + q;

        // (no closing quote)
        if (q < m[0].length)
            continue;

        // (a text the game's program fills itself: its data context against the game's text of the key, in the file's language,
        // else English: a working line in English rather than a broken one)
        if (group.contexts)
        {
            const own = env.engineFilled?.(key) ? env.gameText?.(key, language) : undefined;
            const game = own ?? (env.engineFilled?.(key) ? env.gameText?.(key, 'english') : undefined);
            const c = game === undefined ? undefined : contextChange(key, text, vs, ve, game, env);

            // (the file keeps the game's current text of the key as a comment (AGOT's `#BIRTH_DATE:0 "Born on [DATE.GetStringShort|V]"`
            // above its own line): the key did not change since the mod was written, the mod's line is its choice (the owner,
            // 2026-11-05: no rename, no game text))
            if (c?.change && (comments ??= commentedTexts(text)).get(key)?.has(game!))
            {
                (res.contexts ??= []).push({ key, from: c.change.from, to: c.change.to, kept: true });
                continue;
            }

            if (c?.change)
                (res.contexts ??= []).push(c.change.why && own === undefined && language !== 'english' ? { ...c.change, english: true } : c.change);

            res.edits.push(...(c?.edits ?? []));
            continue;
        }

        // (the key the version restructured: the game's text replaces the mod's)
        if (keepGame.has(key) && env.gameKey?.(key))
        {
            res.edits.push({ s: lineStart, e: pos, text: '' });
            res.dropped.push(key);
            continue;
        }

        const ctx: Ctx = { kind: 'loc', ancestors: [], key };
        const edits: CallEdit[] = [];
        let removed = false;

        for (const sp of expressionSpans(text, vs, ve))
        {
            const expr = text.slice(sp.s, sp.e);
            const r = rewriteExpression(expr, rules, env, ctx);

            if (r.text !== expr)
                edits.push({ s: sp.s, e: sp.e, text: r.text });

            for (const x of r.reports)
                res.left.push(tr('{key}: {name} — {why}', { key, name: x.name, why: x.why }));

            // (a name the version removed, still there after the rules)
            if (gone.size && identifiers(r.text).some((id) => gone.has(id)))
                removed = true;
        }

        if (removed && env.gameKey?.(key))
        {
            // (the renames in a key that goes are no edits)
            res.edits.push({ s: lineStart, e: pos, text: '' });
            res.dropped.push(key);
            continue;
        }

        if (removed)
            res.left.push(tr('{key}: calls a function the game version removed, and the game has no such text', { key }));

        res.edits.push(...edits);
    }

    return res;
}

/** The edits of the rules in a file, by its kind. */
export function dataCallEdits(text: string, rel: string, group: DataCallGroup, env: DataCallEnv): CallResult
{
    return /\.gui$/i.test(rel) ? guiCallEdits(text, group, env) : /\.yml$/i.test(rel) ? locCallEdits(text, group, env, rel) : { edits: [], left: [], dropped: [] };
}
