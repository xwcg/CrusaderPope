/**
 * Formats Paradox script (docs/mods.md, "Formatting"): whitespace only: tabs by nesting depth, one statement per line,
 * `key = value` with single spaces, blocks written on one line kept so while short and free of comments (`limit = {
 * is_female = yes }`, `{ }`), longer ones broken up, comments kept where they are (on their own line, after a statement,
 * after a `{`), at most one blank line between statements and none at a block's start or end, the file's line
 * endings. Parameter blocks of scripted effects (`[[PARAM] … ]`) and inline maths (`@[ … ]`) are kept as blocks /
 * values. The result is checked: its tokens must be the text's, in the same order, else the text comes back
 * unchanged (unbalanced braces, anything the tokenizer does not know).
 * Also keepLayout(): a statement the picker changed keeps its written layout where the picker kept the script, and
 * keepWritten(): its comments too (they go with a statement the picker removed or replaced).
 */

/** A token: its kind, its text (inline maths with its spacing collapsed), its line, where it is in the text [s, e). */
type Tok =
    | { t: 'open' | 'close' | 'pclose'; v: string; line: number; s: number; e: number; }
    | { t: 'op' | 'word' | 'comment' | 'popen'; v: string; line: number; s: number; e: number; };

const OPS = ['==', '!=', '<=', '>=', '?=', '=', '<', '>'];

/** Characters that end a word: whitespace, braces, comment, quote, operators, a parameter block's end. */
const STOP = new Uint8Array(128);

for (const c of ' \t\r\n\f\v{}#"=<>]')
    STOP[c.charCodeAt(0)] = 1;

function tokenize(text: string): Tok[] | null
{
    const out: Tok[] = [];
    let i = 0;
    let line = 0;
    const n = text.length;

    while (i < n)
    {
        const c = text[i];

        if (c === '\n')
        {
            line++;
            i++;
            continue;
        }

        if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ')
        {
            i++;
            continue;
        }

        if (c === '#')
        {
            let j = i;

            while (j < n && text[j] !== '\n' && text[j] !== '\r')
                j++;

            out.push({ t: 'comment', v: text.slice(i, j).replace(/\s+$/, ''), line, s: i, e: j });
            i = j;
            continue;
        }

        if (c === '"')
        {
            let j = i + 1;

            while (j < n && text[j] !== '"')
            {
                if (text[j] === '\\')
                    j++;

                if (text[j] === '\n')
                    line++;

                j++;
            }

            if (j >= n)
                return null;

            out.push({ t: 'word', v: text.slice(i, j + 1), line, s: i, e: j + 1 });
            i = j + 1;
            continue;
        }

        if (c === '{' || c === '}')
        {
            out.push({ t: c === '{' ? 'open' : 'close', v: c, line, s: i, e: i + 1 });
            i++;
            continue;
        }

        // inline maths: @[ … ] as one value
        if (c === '@' && text[i + 1] === '[')
        {
            const j = text.indexOf(']', i);

            if (j < 0)
                return null;

            out.push({ t: 'word', v: text.slice(i, j + 1).replace(/\s+/g, ' '), line, s: i, e: j + 1 });
            i = j + 1;
            continue;
        }

        // a scripted effect's parameter block: [[PARAM] … ]
        if (c === '[' && text[i + 1] === '[')
        {
            const j = text.indexOf(']', i + 2);

            if (j < 0 || /[\s{}]/.test(text.slice(i + 2, j)))
                return null;

            out.push({ t: 'popen', v: text.slice(i, j + 1), line, s: i, e: j + 1 });
            i = j + 1;
            continue;
        }

        if (c === ']')
        {
            out.push({ t: 'pclose', v: ']', line, s: i, e: i + 1 });
            i++;
            continue;
        }

        const op = OPS.find((o) => text.startsWith(o, i));

        if (op && (c !== '!' && c !== '?' || op.length === 2))
        {
            out.push({ t: 'op', v: op, line, s: i, e: i + op.length });
            i += op.length;
            continue;
        }

        let j = i;

        while (j < n)
        {
            const d = text.charCodeAt(j);

            if ((d < 128 && STOP[d]) || d === 0xa0 || ((d === 33 || d === 63) && text.charCodeAt(j + 1) === 61))
                break;

            j++;
        }

        if (j === i)
            return null;

        out.push({ t: 'word', v: text.slice(i, j), line, s: i, e: j });
        i = j;
    }

    return out;
}

/**
 * Where an item is in its text: [at, end) from its first token to its last (its trailing comment not included), the
 * token range [t0, t1), and for a block the end of its opening token (`{`, `[[PARAM]`) and the start of its closing one.
 */
interface Span
{
    at: number;
    end: number;
    t0: number;
    t1: number;
    open?: number;
    close?: number;
    /** a block with a comment right after its opening token: where that comment ends */
    oend?: number;
    /** a comment after it on its line: where it starts and ends, its token's index */
    tat?: number;
    tend?: number;
    tt?: number;
}

interface Stmt extends Span
{
    kind: 'stmt';
    key?: string;
    op?: string;
    value?: string;
    /** a tagged block: `hsv { … }` */
    tag?: string;
    block?: Item[];
    /** its block was written on one line */
    inline?: boolean;
    /** a comment right after its `{` (on that line) */
    openComment?: string;
    /** comments between the operator and the value (`1215.1.1 = # was 1230` and the `{` on the next line) */
    between?: string[];
    /** a comment after it on its line */
    trailing?: string;
    blank: boolean;
    line: number;
    endLine: number;
}

interface Param extends Span
{
    kind: 'param';
    head: string;
    items: Item[];
    inline: boolean;
    openComment?: string;
    trailing?: string;
    blank: boolean;
    line: number;
    endLine: number;
}

interface Comment extends Span
{
    kind: 'comment';
    text: string;
    blank: boolean;
    line: number;
    endLine: number;
}

type Item = Stmt | Param | Comment;

/** Parses tokens into items; null when they do not nest (the text is kept as it is). */
function parse(toks: Tok[]): Item[] | null
{
    let p = 0;
    let lastLine = -1;

    const block = (end: 'close' | 'pclose' | null): Item[] | null =>
    {
        const items: Item[] = [];

        while (p < toks.length)
        {
            const t = toks[p];

            if (t.t === 'close' || t.t === 'pclose')
            {
                if (t.t !== end)
                    return null;

                return items;
            }

            const blank = lastLine >= 0 && t.line > lastLine + 1;
            const prev = items[items.length - 1];

            if (t.t === 'comment')
            {
                p++;

                // (after a statement on its line: its trailing comment)
                if (prev && prev.kind !== 'comment' && !(prev as Stmt | Param).trailing && prev.endLine === t.line)
                    Object.assign(prev, { trailing: t.v, tat: t.s, tend: t.e, tt: p - 1 });
                else
                    items.push({ kind: 'comment', text: t.v, blank, line: t.line, endLine: t.line, at: t.s, end: t.e, t0: p - 1, t1: p });

                lastLine = t.line;
                continue;
            }

            if (t.t === 'popen')
            {
                const t0 = p;
                p++;
                const start = t.line;
                const ot = toks[p]?.t === 'comment' && toks[p].line === start ? toks[p++] : undefined;
                lastLine = start;
                const inner = block('pclose');

                if (!inner || toks[p]?.t !== 'pclose')
                    return null;

                const endLine = toks[p].line;
                const closeTok = toks[p];
                p++;
                lastLine = endLine;
                items.push({ kind: 'param', head: t.v, items: inner, inline: start === endLine, openComment: ot?.v, oend: ot?.e, blank, line: start, endLine, at: t.s, end: closeTok.e, t0, t1: p, open: t.e, close: closeTok.s });
                continue;
            }

            if (t.t === 'op')
                return null;

            // a statement: [key op] value | [key op] [tag] { … } | { … } | bare value
            const s: Stmt = { kind: 'stmt', blank, line: t.line, endLine: t.line, at: t.s, end: t.e, t0: p, t1: p + 1 };
            let valueTok: Tok | undefined = t;

            if (t.t === 'word' && toks[p + 1]?.t === 'op')
            {
                s.key = t.v;
                s.op = toks[p + 1].v;
                p += 2;

                // (comments before the value: kept in front of it)
                while (toks[p]?.t === 'comment')
                    (s.between ??= []).push(toks[p++].v);

                valueTok = toks[p];

                if (!valueTok)
                    return null;

                // (an operator as the value: `OPERATOR = >=` in a macro call)
                if (valueTok.t === 'op')
                    valueTok = { t: 'word', v: valueTok.v, line: valueTok.line, s: valueTok.s, e: valueTok.e };
            }

            if (valueTok.t === 'word' && toks[p + 1]?.t === 'open' && s.key !== undefined)
            {
                // a tagged block (rgb { … }, hsv { … }): the tag then its block
                s.tag = valueTok.v;
                p++;
                valueTok = toks[p];
            }

            if (valueTok.t === 'open')
            {
                const start = valueTok.line;
                p++;
                const ot = toks[p]?.t === 'comment' && toks[p].line === start ? toks[p++] : undefined;
                lastLine = start;
                const inner = block('close');

                if (!inner || toks[p]?.t !== 'close')
                    return null;

                s.endLine = toks[p].line;
                s.block = inner;
                s.inline = start === s.endLine;
                s.openComment = ot?.v;
                s.oend = ot?.e;
                s.open = valueTok.e;
                s.close = toks[p].s;
                s.end = toks[p].e;
                p++;
            }
            else if (valueTok.t === 'word')
            {
                s.value = valueTok.v;
                s.endLine = valueTok.line;
                s.end = valueTok.e;
                p++;
            }
            else
                return null;

            s.t1 = p;

            lastLine = s.endLine;
            items.push(s);
        }

        return end === null ? items : null;
    };

    return block(null);
}

/** Longest line a block written on one line keeps (with its indentation counted as 4 per level). */
const INLINE_MAX = 120;

function inlineText(it: Item): string | null
{
    if (it.kind === 'comment' || it.trailing || it.openComment || (it.kind === 'stmt' && it.between))
        return null;

    if (it.kind === 'param')
    {
        const parts = it.items.map(inlineText);
        return parts.some((x) => x === null) ? null : `${it.head} ${parts.join(' ')} ]`;
    }

    const head = it.key !== undefined ? `${it.key} ${it.op} ` : '';

    if (it.value !== undefined)
        return head + it.value;

    const parts = it.block!.map(inlineText);

    if (parts.some((x) => x === null))
        return null;

    return `${head}${it.tag ? it.tag + ' ' : ''}{${parts.length ? ' ' + parts.join(' ') + ' ' : ' '}}`;
}

function print(items: Item[], depth: number, out: string[]): void
{
    const pad = '\t'.repeat(depth);

    items.forEach((it, i) =>
    {
        // (at most one blank line; none at a block's start)
        if (it.blank && i > 0 && out[out.length - 1] !== '')
            out.push('');

        if (it.kind === 'comment')
        {
            out.push(pad + it.text);
            return;
        }

        const trailing = it.trailing ? ' ' + it.trailing : '';
        const between = it.kind === 'stmt' ? it.between : undefined;

        // comments between the operator and the value: the first after the operator, the value (the `{`) on its own line
        if (between && it.kind === 'stmt')
        {
            out.push(pad + `${it.key} ${it.op} ${between[0]}`);

            for (const c of between.slice(1))
                out.push(pad + c);
        }

        if (it.kind === 'stmt' && it.value !== undefined)
        {
            out.push(pad + (between ? '' : it.key !== undefined ? `${it.key} ${it.op} ` : '') + it.value + trailing);
            return;
        }

        // a block: on one line when written so, short and without comments
        const one = it.inline ? inlineText({ ...it, trailing: undefined }) : null;

        if (one !== null && depth * 4 + one.length + trailing.length <= INLINE_MAX)
        {
            out.push(pad + one + trailing);
            return;
        }

        const head = it.kind === 'param' ? it.head : `${it.key !== undefined && !between ? `${it.key} ${it.op} ` : ''}${it.tag ? it.tag + ' ' : ''}{`;
        out.push(pad + head + (it.openComment ? ' ' + it.openComment : ''));
        print(it.kind === 'param' ? it.items : it.block!, depth + 1, out);

        // (no blank line before the closing brace)
        while (out[out.length - 1] === '' && out.length > 1)
            out.pop();

        out.push(pad + (it.kind === 'param' ? ']' : '}') + trailing);
    });
}

/** The tokens as the check compares them (comments by their text). */
const sig = (toks: Tok[]): string => toks.map((t) => t.t + '\u0001' + t.v).join('\u0002');

/**
 * Whether the statement `before` is still in `after` (docs/picker.md, "Comments"): its tokens, comments aside, run on
 * unbroken inside the other text (the statement wrapped in an `if` / `random` / `NOT` / `hidden_effect` / iterator),
 * or the other text, a statement of its own (three tokens or more), runs on inside `before` (a wrapper taken off). What
 * tells a statement the picker kept in a new place from one it replaced by another: the comments of the first stay.
 * False for a text that does not tokenize.
 */
export function keepsStatement(before: string, after: string): boolean
{
    const b = tokenize(before)?.filter((t) => t.t !== 'comment').map((t) => t.t + '\u0001' + t.v);
    const a = tokenize(after)?.filter((t) => t.t !== 'comment').map((t) => t.t + '\u0001' + t.v);

    if (!b || !a || !b.length || !a.length)
        return false;

    const within = (small: string[], big: string[]): boolean =>
    {
        for (let i = 0; i + small.length <= big.length; i++)
            if (small.every((x, j) => big[i + j] === x))
                return true;

        return false;
    };

    return within(b, a) || (a.length >= 3 && within(a, b));
}

/** The key a script text starts with (`add_gold` of `add_gold = 5`, comment lines before it skipped; a value alone is its own head). */
export function firstKeyOf(text: string): string
{
    return /^(?:\s*#[^\n]*\n)*\s*("[^"]*"|[^\s=<>!?{}"#]+)/.exec(text)?.[1] ?? '';
}

/**
 * Whether the picker's Change put another statement in place of `before` (the comments next to the old one go with
 * it, ScriptEditRequest.withComments): its first key differs and the old statement is not still in the new text
 * (keepsStatement()). The same statement with other values, one wrapped (`if`, `random`, `NOT`, `hidden_effect`, an
 * iterator) and one unwrapped keep their comments. An iterator or a mode changed (`every_child` to `every_vassal`)
 * is another statement.
 */
export function replacesStatement(before: string, after: string): boolean
{
    return firstKeyOf(before) !== firstKeyOf(after) && !keepsStatement(before, after);
}

/** The tokens without comments as one string (null: it does not tokenize): what sameScript() compares, built. */
export function scriptSignature(text: string): string | null
{
    const toks = tokenize(text);
    return toks ? sig(toks.filter((t) => t.t !== 'comment')) : null;
}

/** Past whitespace and comments. */
function skipSpace(s: string, i: number): number
{
    const n = s.length;

    while (i < n)
    {
        const c = s.charCodeAt(i);

        if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 0xa0)
            i++;
        else if (c === 35)
        {
            while (i < n && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13)
                i++;
        }
        else
            break;
    }

    return i;
}

/** The end of the token at `i` (as tokenize() splits them). */
function tokenEnd(s: string, i: number): number
{
    const n = s.length;
    const c = s.charCodeAt(i);

    // "string"
    if (c === 34)
    {
        let j = i + 1;

        while (j < n && s.charCodeAt(j) !== 34)
            j += s.charCodeAt(j) === 92 ? 2 : 1;

        return Math.min(n, j + 1);
    }

    // braces, a parameter block's end
    if (c === 123 || c === 125 || c === 93)
        return i + 1;

    // @[ … ] and [[PARAM]
    if ((c === 64 || c === 91) && s.charCodeAt(i + 1) === 91)
    {
        const j = s.indexOf(']', i + 2);
        return j < 0 ? n : j + 1;
    }

    // operators: == != <= >= ?= = < >
    if (c === 61 || c === 60 || c === 62 || ((c === 33 || c === 63) && s.charCodeAt(i + 1) === 61))
        return s.charCodeAt(i + 1) === 61 ? i + 2 : i + 1;

    let j = i;

    while (j < n)
    {
        const d = s.charCodeAt(j);

        if ((d < 128 && STOP[d]) || d === 0xa0 || ((d === 33 || d === 63) && s.charCodeAt(j + 1) === 61))
            break;

        j++;
    }

    return j === i ? i + 1 : j;
}

/**
 * Whether two pieces of script say the same: the same tokens (words, strings, operators, braces) in the same order,
 * spacing, line breaks and comments aside; inline maths (`@[ … ]`) with its spacing collapsed, as tokenize() keeps it
 * (docs/mods.md, "Same as the game"). Walks both texts together, stops at the first difference and builds nothing
 * (a mod's copies of the game's definitions are compared by the ten thousand).
 */
export function sameScript(a: string, b: string): boolean
{
    if (a === b)
        return true;

    let i = 0;
    let j = 0;

    for (;;)
    {
        i = skipSpace(a, i);
        j = skipSpace(b, j);

        if (i >= a.length || j >= b.length)
            return i >= a.length && j >= b.length;

        const ei = tokenEnd(a, i);
        const ej = tokenEnd(b, j);

        if (a.charCodeAt(i) === 64 && a.charCodeAt(i + 1) === 91)
        {
            if (a.slice(i, ei).replace(/\s+/g, ' ') !== b.slice(j, ej).replace(/\s+/g, ' '))
                return false;
        }
        else
        {
            if (ei - i !== ej - j)
                return false;

            for (let k = 0; k < ei - i; k++)
                if (a.charCodeAt(i + k) !== b.charCodeAt(j + k))
                    return false;
        }

        i = ei;
        j = ej;
    }
}

/**
 * The text formatted (without a byte order mark: the caller keeps it), or unchanged when it is no script this
 * formatter can prove it only re-spaced.
 */
export function formatScript(text: string): string
{
    const toks = tokenize(text);

    if (!toks)
        return text;

    const items = parse(toks);

    if (!items)
        return text;

    const lines: string[] = [];
    print(items, 0, lines);

    while (lines.length && lines[lines.length - 1] === '')
        lines.pop();

    const crlf = (text.match(/\r\n/g)?.length ?? 0) * 2 > (text.match(/\n/g)?.length ?? 0);
    const out = lines.join(crlf ? '\r\n' : '\n') + (lines.length ? (crlf ? '\r\n' : '\n') : '');
    const again = tokenize(out);

    // (only whitespace may change)
    if (!again || sig(again) !== sig(toks))
        return text;

    return out;
}

/** Whether a mod file is script the formatter takes: .txt outside localization (not a descriptor, not .gui / .yml). */
export function isScriptFile(path: string): boolean
{
    const p = path.replace(/\\/g, '/').toLowerCase();
    return p.endsWith('.txt') && !/(^|\/)localization\//.test(p);
}

/** Where a position of the text (a statement's start) is in its formatted form: the same non-space character. */
export function mapPosition(before: string, after: string, at: number): number
{
    let k = 0;

    for (let i = 0; i < at && i < before.length; i++)
        if (!/\s/.test(before[i]))
            k++;

    let i = 0;

    for (; i < after.length && k > 0; i++)
        if (!/\s/.test(after[i]))
            k--;

    while (i < after.length && /\s/.test(after[i]))
        i++;

    return i;
}

// ---------------------------------------------------------------------------
// A written block's layout kept through the picker (docs/picker.md, "Changing written effects and conditions")
// ---------------------------------------------------------------------------

/** One text keepLayout() reads: its tokens and items. */
interface Side
{
    text: string;
    toks: Tok[];
    items: Item[];
}

/**
 * What keepLayout() works with: the written text, the picker's, the file's indentation unit and line end; `notes`
 * when the written text's comments are kept (keepWritten).
 */
interface Keep
{
    b: Side;
    a: Side;
    unit: string;
    eol: string;
    notes?: Notes;
}

/**
 * The written text's comments, as keepWritten() keeps them (docs/mods.md, "Comments next to a statement"). A block's
 * items are read as units: a statement with its comment lines directly above it (`doc`; no blank line between, at
 * most 40, up to the first commented-out script, only while the statement has its line(s) to itself) and its comment
 * after it on its line (when it starts its line), from `xat` to `xend`; a comment no statement owns is a unit of its
 * own (one between statements, at a block's end, after a statement that shares its line). This is the main side's
 * rule for removing a statement (src/main/mods/scriptEdit.ts removalRange / docStart).
 */
interface Notes
{
    units: Map<Item[], Item[]>;
    doc: Map<Item, Item[]>;
    xat: Map<Item, number>;
    xend: Map<Item, number>;
    /** the written comments (token indexes) that go with a statement the picker removed or replaced */
    gone: Set<number>;
    /** a comment that can't be kept: one inside a statement the picker replaced, or between a changed `key =` and its value */
    lost: boolean;
    /** a written statement with comments went elsewhere in its block (the picker moved it): the check takes the comments in any order */
    moved: boolean;
}

/**
 * A comment line that is commented-out script (`# add_gold = 100`, `# limit = { is_adult = yes }`, `# }`) rather
 * than words about the statement below it. Words may hold an `=` too, but not as the whole line (`# Weight = 50 means
 * often` is words).
 */
export function isCodeComment(line: string): boolean
{
    const t = line.trim().replace(/^#+\s*/, '');
    return /^[{}]/.test(t) || /^[\w.:@$'-]+\s*(=|==|!=|<=|>=|<|>|\?=)\s*(\{.*|"[^"]*"|[^\s{}#"]+)\s*(\}\s*)*(#.*)?$/.test(t);
}

/** The units of a written block's items (see Notes); the items themselves when comments are not kept. */
function unitsOf(k: Keep, list: Item[]): Item[]
{
    const n = k.notes;

    if (!n)
        return list;

    const known = n.units.get(list);

    if (known)
        return known;

    const T = k.b.text;
    const absorbed = new Set<Item>();

    list.forEach((it, i) =>
    {
        if (it.kind === 'comment')
            return;

        const next = list[i + 1];
        // (alone on its line(s): nothing else starts on its last line)
        const alone = !next || next.kind === 'comment' || next.line > it.endLine;
        const doc: Item[] = [];

        for (let j = i - 1; alone && j >= 0 && doc.length < 40; j--)
        {
            const c = list[j];

            if (c.kind !== 'comment' || list[j + 1].blank || isCodeComment(c.text))
                break;

            doc.unshift(c);
        }

        for (const c of doc)
            absorbed.add(c);

        n.doc.set(it, doc);
        n.xat.set(it, doc.length ? doc[0].at : it.at);
    });

    const units: Item[] = [];

    for (const it of list)
    {
        if (absorbed.has(it))
            continue;

        units.push(it);

        if (it.kind === 'comment' || it.tend === undefined)
            continue;

        // (its comment after it: its own when it starts its line, else the line's, a unit of its own)
        if (startsLine(T, it.at))
            n.xend.set(it, it.tend);
        else
            units.push({ kind: 'comment', text: it.trailing!, blank: false, line: it.endLine, endLine: it.endLine, at: it.tat!, end: it.tend, t0: it.tt!, t1: it.tt! + 1 });
    }

    n.units.set(list, units);
    return units;
}

/** Where a written unit starts and ends (its comment lines above it and its comment after it included). */
const xat = (k: Keep, it: Item): number => k.notes?.xat.get(it) ?? it.at;
const xend = (k: Keep, it: Item): number => k.notes?.xend.get(it) ?? it.end;
/** Whether a blank line stands above a written unit (above its comment lines). */
const blankOf = (k: Keep, it: Item): boolean => (k.notes?.doc.get(it)?.[0] ?? it).blank;

/** The written comments (token indexes) of a unit: those above it, inside it, the one after it when it is its own. */
function commentsOfUnit(k: Keep, it: Item): { inner: number[]; next: number[]; }
{
    const inner: number[] = [];

    for (let t = it.t0; t < it.t1; t++)
        if (k.b.toks[t].t === 'comment')
            inner.push(t);

    const next = (k.notes?.doc.get(it) ?? []).map((c) => c.t0);

    if (it.kind !== 'comment' && it.tt !== undefined && k.notes?.xend.get(it) === it.tend)
        next.push(it.tt);

    return { inner, next };
}

/** A written unit's text with its comments around it: `core` in place of the unit itself (default: as written). */
function withNotes(k: Keep, it: Item, core?: string): string
{
    const T = k.b.text;
    return T.slice(xat(k, it), it.at) + (core ?? T.slice(it.at, it.end)) + T.slice(it.end, xend(k, it));
}

/**
 * A piece of a block's new content. `from`: the written item whose place it takes (kept as written, or a changed block
 * of it rebuilt: `text`, in the written text's indentation). `printed`: the picker's item whose text it is (a new
 * one, or a changed `key op value` in the written one's place), re-indented where it lands.
 */
interface Piece
{
    text: string;
    from?: Item;
    printed?: Item;
}

function sideOf(text: string): Side | null
{
    const toks = tokenize(text);
    const items = toks && parse(toks);
    return toks && items ? { text, toks, items } : null;
}

const kidsOf = (it: Item): Item[] => (it.kind === 'param' ? it.items : it.kind === 'stmt' ? it.block ?? [] : []);

/**
 * What a changed item keeps of the written one: a block its head (key, operator, tag; a parameter block's
 * `[[PARAM]`), a `key op value` its place (key and operator), a bare value the place of a written bare value (`1 2 3`
 * of an rgb, a list of names); undefined for a comment.
 */
function headOf(it: Item): string | undefined
{
    if (it.kind === 'param')
        return 'p\u0001' + it.head;

    if (it.kind === 'stmt' && it.block)
        return ['b', it.key ?? '', it.op ?? '', it.tag ?? ''].join('\u0001');

    if (it.kind === 'stmt' && it.key !== undefined)
        return ['v', it.key, it.op ?? ''].join('\u0001');

    if (it.kind === 'stmt')
        return 'w';

    return undefined;
}

/** A bare value (no key, no block). */
const bare = (it: Item | undefined): boolean => !!it && headOf(it) === 'w';

/** The pairs [i, j] of a longest common subsequence of a and b (the same ends taken first); null when too big. */
function lcs(a: string[], b: string[]): [number, number][] | null
{
    let lo = 0;

    while (lo < a.length && lo < b.length && a[lo] === b[lo])
        lo++;

    let hi = 0;

    while (hi < a.length - lo && hi < b.length - lo && a[a.length - 1 - hi] === b[b.length - 1 - hi])
        hi++;

    const n = a.length - lo - hi;
    const m = b.length - lo - hi;

    if ((n + 1) * (m + 1) > 1_000_000)
        return null;

    const w = m + 1;
    const len = new Uint32Array((n + 1) * w);

    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            len[i * w + j] = a[lo + i] === b[lo + j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);

    const out: [number, number][] = [];

    for (let i = 0; i < lo; i++)
        out.push([i, i]);

    for (let i = 0, j = 0; i < n && j < m;)
    {
        if (a[lo + i] === b[lo + j])
        {
            out.push([lo + i, lo + j]);
            i++;
            j++;
        }
        else if (len[(i + 1) * w + j] >= len[i * w + j + 1])
            i++;
        else
            j++;
    }

    for (let k = hi; k > 0; k--)
        out.push([a.length - k, b.length - k]);

    return out;
}

/** How many comments a written unit has (above it, inside it, after it on its line). */
function noted(k: Keep, it: Item): number
{
    const c = commentsOfUnit(k, it);
    return c.inner.length + c.next.length;
}

/**
 * Twins (written statements with the same tokens, their comments aside, next to each other) of which the picker's text
 * keeps fewer: its text does not say which twin went, so the alignment keeps those with the most comments and drops one
 * with the fewest (`pairs` changed in place; only where the picker's twins are next to each other too); between twins
 * with as many, as lcs() paired them.
 */
function preferCommented(k: Keep, units: Item[], sigs: string[], pairs: [number, number][]): void
{
    const pairOf = new Map(pairs.map((p, x) => [p[0], x]));
    const has = (i: number): number => noted(k, units[i]);

    for (let r0 = 0; r0 < units.length;)
    {
        let r1 = r0 + 1;

        if (units[r0].kind !== 'comment')
            while (r1 < units.length && sigs[r1] === sigs[r0])
                r1++;

        const run = Array.from({ length: r1 - r0 }, (_, x) => r0 + x);
        const paired = run.filter((i) => pairOf.has(i));
        const js = paired.map((i) => pairs[pairOf.get(i)!][1]);
        r0 = r1;

        if (!paired.length || paired.length === run.length || !js.every((j, x) => j === js[0] + x) || !run.some((i) => has(i) > 0))
            continue;

        // (those with the most comments first, then the ones lcs() paired, in the written order)
        const pick = [...run].sort((x, y) => has(y) - has(x) || Number(pairOf.has(y)) - Number(pairOf.has(x)) || x - y).slice(0, paired.length).sort((x, y) => x - y);
        const at = paired.map((i) => pairOf.get(i)!);
        at.forEach((x, n) => (pairs[x] = [pick[n], js[n]]));
    }
}

/** The indentation of the line holding `pos`. */
function lineIndent(text: string, pos: number): string
{
    const ls = text.lastIndexOf('\n', pos - 1) + 1;
    let i = ls;

    while (i < text.length && (text[i] === ' ' || text[i] === '\t'))
        i++;

    return text.slice(ls, i);
}

/** Whether only indentation stands before `pos` on its line. */
function startsLine(text: string, pos: number): boolean
{
    return /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', pos - 1) + 1, pos));
}

/** How wide the line is up to `pos` (a tab counted as 4). */
const column = (text: string, pos: number): number => text.slice(text.lastIndexOf('\n', pos - 1) + 1, pos).replace(/\t/g, '    ').length;

/**
 * Text whose first line sat on a line indented with `from`, moved to a line indented with `to`: its later lines get
 * `to` in place of `from`. `tabs`: the picker's tab levels become the file's unit. Unmoved written text stays as it is.
 */
function moved(text: string, from: string, to: string, k: Keep, tabs: boolean): string
{
    if (from === to && !tabs)
        return text;

    return text
        .split(/\r?\n/)
        .map((l, i) =>
        {
            if (i === 0)
                return l;

            let rel = l.startsWith(from) ? l.slice(from.length) : l.replace(/^[ \t]+/, '');

            if (tabs)
                rel = rel.replace(/^\t+/, (m) => k.unit.repeat(m.length));

            return rel ? to + rel : '';
        })
        .join(k.eol);
}

/**
 * The new content of a block: the picker's items, each written item it kept (the same tokens: an LCS over the items'
 * token strings) as written, each block it changed (the same head, between two kept items) rebuilt, a changed `key op
 * value` in the written one's place, the rest as the picker printed it. Null: too big to align.
 */
function pieces(k: Keep, bList: Item[], aItems: Item[]): Piece[] | null
{
    const bItems = unitsOf(k, bList);
    // (a statement by its tokens, its comments aside; a comment unit matches nothing the picker printed)
    const sigOf = (sd: Side, it: Item): string => (it.kind === 'comment' ? '\u0003' : sig(sd.toks.slice(it.t0, it.t1).filter((t) => t.t !== 'comment')));
    const sigs = bItems.map((it) => sigOf(k.b, it));
    const pairs = lcs(sigs, aItems.map((it) => sigOf(k.a, it)));

    if (!pairs)
        return null;

    if (k.notes)
        preferCommented(k, bItems, sigs, pairs);

    const out: Piece[] = [];
    const n = k.notes;
    // (a written statement with comments the picker put elsewhere in the block (the same tokens, not lined up): it goes
    // where the picker has it, as written, with its comments; the picker's item `ai` takes the written unit)
    const moves = new Map<number, number>();

    if (n)
    {
        const pairedB = new Set(pairs.map((p) => p[0]));
        const pairedA = new Set(pairs.map((p) => p[1]));
        const free = new Map<string, number[]>();

        bItems.forEach((it, x) =>
        {
            if (!pairedB.has(x) && it.kind !== 'comment' && noted(k, it) > 0)
                free.set(sigs[x], [...(free.get(sigs[x]) ?? []), x]);
        });

        if (free.size)
            aItems.forEach((it, y) =>
            {
                const l = pairedA.has(y) ? undefined : free.get(sigOf(k.a, it));

                if (l?.length)
                    moves.set(y, l.shift()!);
            });
    }

    const movedAway = new Set(moves.values());
    let bi = 0;
    let ai = 0;

    for (const [pi, pj] of [...pairs, [bItems.length, aItems.length]])
    {
        // (the picker's items before the next kept one: a block takes the next written block with its head in the gap)
        let cursor = bi;
        const taken = new Set<number>();
        let added = 0;
        // (a written comment no statement owns stays, in the written order: right after the written unit before it,
        // so before what the picker put in that place)
        let flushed = bi;
        const flush = (to: number): void =>
        {
            for (; flushed < to; flushed++)
                if (bItems[flushed].kind === 'comment')
                    out.push({ text: k.b.text.slice(bItems[flushed].at, bItems[flushed].end), from: bItems[flushed] });
        };

        for (; ai < pj; ai++)
        {
            const a = aItems[ai];
            const head = headOf(a);
            const move = moves.get(ai);
            let found = -1;

            if (head !== undefined && move === undefined)
                for (let x = cursor; x < pi && found < 0; x++)
                    if (!movedAway.has(x) && headOf(bItems[x]) === head)
                        found = x;

            if (move !== undefined)
            {
                let next = cursor;

                while (next < pi && bItems[next].kind === 'comment')
                    next++;

                flush(next);
                out.push({ text: withNotes(k, bItems[move]), from: bItems[move] });
                n!.moved = true;
                continue;
            }

            if (found < 0)
            {
                let next = cursor;

                while (next < pi && bItems[next].kind === 'comment')
                    next++;

                flush(next);
                out.push({ text: '', printed: a });
                added++;
                continue;
            }

            flush(found);
            flushed = found + 1;
            cursor = found + 1;
            taken.add(found);

            // (a changed `key op value` or bare value: the picker's text in the written one's place; a comment between
            // its operator and its value can't be kept)
            if (head === 'w' || head!.startsWith('v'))
            {
                if (n && commentsOfUnit(k, bItems[found]).inner.length)
                    n.lost = true;

                out.push({ text: '', from: bItems[found], printed: a });
                continue;
            }

            const text = rebuilt(k, bItems[found], a);

            if (text === null)
                return null;

            out.push({ text: withNotes(k, bItems[found], text), from: bItems[found] });
        }

        flush(pi);

        // (the written statements the picker left out: their comments go with them; one inside a statement the picker
        // put something else in place of can't be kept)
        if (n)
            for (let x = bi; x < pi; x++)
            {
                if (taken.has(x) || movedAway.has(x) || bItems[x].kind === 'comment')
                    continue;

                const c = commentsOfUnit(k, bItems[x]);

                if (added && c.inner.length)
                    n.lost = true;

                for (const t of [...c.inner, ...c.next])
                    n.gone.add(t);
            }

        if (pi < bItems.length)
            out.push({ text: withNotes(k, bItems[pi]), from: bItems[pi] });

        bi = pi + 1;
        ai = pj + 1;
    }

    return out;
}

/**
 * A written block the picker changed: its head and closing brace as written, its kept items as written (where they
 * were: the whitespace between two items that were neighbours is kept), the new ones on lines of their own at the
 * block's indentation (a bare value next to the written bare value before it, when that one shares its line with
 * another); written on one line it stays on one line while its items do and the line is not over INLINE_MAX (or the
 * length it was written with, when longer: the column counted in the statement's text, without the indentation it
 * has in the file), with the written spacing between former neighbours and single spaces elsewhere.
 */
function rebuilt(k: Keep, b: Item, a: Item): string | null
{
    const ps = pieces(k, kidsOf(b), kidsOf(a));

    if (!ps)
        return null;

    const T = k.b.text;
    const kids = unitsOf(k, kidsOf(b));
    const index = new Map(kids.map((x, i) => [x, i]));
    // (the written head, with a comment after its `{`)
    const open = b.oend ?? b.open!;
    const head = T.slice(b.at, open);
    const close = T.slice(b.close!, b.end);
    const indent = lineIndent(T, b.at);
    const own = kids.find((x) => startsLine(T, xat(k, x)));
    const kidIndent = own ? lineIndent(T, own.at) : indent + k.unit;
    const closeIndent = startsLine(T, b.close!) ? lineIndent(T, b.close!) : indent;
    const inline = b.kind !== 'comment' && b.inline;

    // (neighbours in the written block keep the whitespace between them as written: they stay where they were)
    const next = (x: Item | undefined, y: Item | undefined): boolean => !!x && !!y && index.get(x)! + 1 === index.get(y);
    const stays = ps.map((p, i) => !inline && !!p.from && (i === 0 ? p.from === kids[0] : next(ps[i - 1].from, p.from)));
    // (where each piece lands: a written one that stays or started its line at its own indentation)
    const where = ps.map((p, i) => (p.from && (stays[i] || (!inline && startsLine(T, xat(k, p.from)))) ? lineIndent(T, p.from.at) : kidIndent));
    const texts = ps.map((p, i) => pieceText(k, p, where[i]));

    // (the written whitespace from `s` to `e` where it is on one line, else one space)
    const gap = (s: number, e: number): string => (/[\r\n]/.test(T.slice(s, e)) ? ' ' : T.slice(s, e));

    if (inline && texts.every((x) => !/[\r\n]/.test(x)))
    {
        // (on one line: the written spacing between former neighbours and at the ends, single spaces elsewhere)
        const last = ps[ps.length - 1];
        let one = head;

        ps.forEach((p, i) =>
        {
            one += i === 0
                ? (p.from && p.from === kids[0] ? gap(open, xat(k, p.from)) : ' ')
                : next(ps[i - 1].from, p.from) ? gap(xend(k, ps[i - 1].from!), xat(k, p.from!)) : ' ';
            one += texts[i];
        });

        one += !ps.length ? ' ' : last.from && last.from === kids[kids.length - 1] ? gap(xend(k, last.from), b.close!) : ' ';
        one += close;

        // (a line written longer than that may stay as long)
        if (column(T, b.at) + one.length <= Math.max(INLINE_MAX, column(T, b.at) + b.end - b.at))
            return one;
    }

    if (!ps.length)
        return head + ' ' + close;

    // (bare values written several to a line, `1 2 3` or a list of names: a new or moved one that did not start its line
    // goes on the line of the bare value before it)
    const shared = (x: Item): boolean =>
    {
        const i = index.get(x)!;
        return !startsLine(T, x.at) || (i + 1 < kids.length && !startsLine(T, kids[i + 1].at));
    };
    const joins: boolean[] = [];
    let anchor: Item | undefined;

    ps.forEach((p, i) =>
    {
        const isBare = p.printed ? bare(p.printed) : bare(p.from);
        joins.push(i > 0 && !stays[i] && isBare && (!p.from || !startsLine(T, p.from.at)) && !!anchor && shared(anchor));
        // (the written bare value the next one may join: this one, or for a new one joined, the one it joined)
        anchor = !isBare ? undefined : p.from ?? (joins[i] ? anchor : undefined);
    });

    let out = head;

    ps.forEach((p, i) =>
    {
        if (stays[i])
            out += T.slice(i === 0 ? open : xend(k, ps[i - 1].from!), xat(k, p.from!));
        else if (joins[i])
            out += ' ';
        else
            out += (i > 0 && p.from && blankOf(k, p.from) ? k.eol : '') + k.eol + where[i];

        out += texts[i];
    });

    const last = ps[ps.length - 1];
    out += !inline && last.from && last.from === kids[kids.length - 1] ? T.slice(xend(k, last.from), b.close!) : k.eol + closeIndent;
    return out + close;
}

/**
 * A piece's text where it lands (`where`: the indentation of its line): a written one re-based, the picker's
 * re-indented (its tabs the file's unit), a changed `key op value` with the written one's comments around it.
 */
function pieceText(k: Keep, p: Piece, where: string): string
{
    const T = k.b.text;

    if (!p.printed)
        return moved(p.text, lineIndent(T, p.from!.at), where, k, false);

    const own = moved(k.a.text.slice(p.printed.at, p.printed.end), lineIndent(k.a.text, p.printed.at), p.from ? lineIndent(T, p.from.at) : where, k, true);
    return p.from ? moved(withNotes(k, p.from, own), lineIndent(T, p.from.at), where, k, false) : own;
}

/** The indentation unit a text uses: a tab, or the smallest run of spaces a line starts with (a tab when none). */
function unitOf(text: string): string
{
    let min = 0;

    for (const m of text.matchAll(/\n([ \t]+)\S/g))
    {
        if (m[1].startsWith('\t'))
            return '\t';

        if (!min || m[1].length < min)
            min = m[1].length;
    }

    return min ? ' '.repeat(min) : '\t';
}

/**
 * The picker's text for a written statement it changed (`after`, printed: tabs, short blocks on one line), with the
 * written layout (`before`: the statement as the file has it, its later lines without the statement's own
 * indentation) kept wherever the picker kept the script:
 * - an item the picker left as it was (the same tokens) is the written text, byte for byte, with the whitespace
 *   around it where its neighbours stayed;
 * - a block it changed inside (the same head) keeps its head, its closing brace and its one-line or multi-line style,
 *   and the same holds for its items, down the tree;
 * - new and changed items are the picker's text, re-indented to where they land (`unit`: the file's indentation,
 *   default the one `before` uses), the line ends `before`'s.
 * Only whitespace may differ from `after`: the result is checked to have `after`'s tokens, else `after` comes back.
 * `after` also comes back when either text does not parse, nothing was kept, or `before` has a comment (the picker's
 * Change path uses keepWritten, which keeps them).
 */
export function keepLayout(before: string, after: string, unit?: string): string
{
    return layoutKept(before, after, unit) ?? after;
}

/** keepLayout()'s result, or null where it gives `after` back (scripts/script-format-check.ts counts those). */
export function layoutKept(before: string, after: string, unit?: string): string | null
{
    if (!before.trim() || !after.trim())
        return null;

    const b = sideOf(before);
    const a = sideOf(after);

    if (!b || !a || b.toks.some((t) => t.t === 'comment'))
        return null;

    const r = kept(b, a, unit, false);
    return typeof r === 'string' ? null : r.text;
}

/**
 * Why keepWritten() gave no text: a comment inside a statement the picker replaced (`inside`), the texts could not be
 * aligned (`unaligned`: too big, or a changed block not rebuilt), the result failed its check (`check`), or a text does
 * not parse (`parse`).
 */
export type NotKept = 'inside' | 'unaligned' | 'check' | 'parse';

/** keepWritten()'s answer: the text to write, or null (a comment would be lost: the script editor opens instead). */
export interface WrittenKept
{
    text: string | null;
    /** the written comments that go with a statement the picker removed or replaced (their text: `# …`) */
    gone: string[];
    /** text null: why */
    why?: NotKept;
}

/**
 * keepLayout() that keeps the written text's comments too (the picker's Change path; docs/mods.md, "Comments next to
 * a statement"): a comment stays with the statement it is next to while the picker keeps or changes that statement
 * (the comment lines directly above it, the one after it on its line, a comment after its `{`, the comments inside
 * it), and goes with a statement the picker removed or replaced (`gone`: the change bar names them); a comment no
 * statement owns stays where it was. `text` is null where a comment can't be kept: one inside a statement the picker
 * replaced by another (or the whole statement replaced), one between a changed `key =` and its value, or a result
 * whose comments are not the written ones less those that go, in the written order (the check), or that does not
 * parse. Without comments in `before`: keepLayout().
 */
export function keepWritten(before: string, after: string, unit?: string): WrittenKept
{
    const b = before.trim() ? sideOf(before) : null;

    // (written text that does not parse: its comments can't be placed)
    if (!b && before.trim() && commentsOf(before).length)
        return { text: null, gone: [], why: 'parse' };

    if (!b || !b.toks.some((t) => t.t === 'comment'))
        return { text: keepLayout(before, after, unit), gone: [] };

    // (all of it removed: its comments go with it)
    if (!after.trim())
        return { text: after, gone: b.toks.filter((t) => t.t === 'comment').map((t) => t.v) };

    const a = sideOf(after);
    const r = a ? kept(b, a, unit, true) : 'parse';
    return typeof r === 'string' ? { text: null, gone: [], why: r } : { text: r.text, gone: r.gone };
}

/**
 * A statement the app rewrote from its parsed form (printScript: an event's text versions, scenes, portraits) with
 * the written one's comments kept where keepWritten() keeps them: `after` as it is when `before` has no comment (the
 * rewrite's own layout, as before); else keepWritten()'s answer (text null: nothing should be written).
 */
export function rewrittenKept(before: string, after: string, unit?: string): WrittenKept
{
    return commentsOf(before).length ? keepWritten(before, after, unit) : { text: after, gone: [] };
}

/** The work of layoutKept() and keepWritten(): why not where nothing was kept, a comment can't be kept or the check fails. */
function kept(b: Side, a: Side, unit: string | undefined, comments: boolean): { text: string; gone: string[]; } | NotKept
{
    const before = b.text;
    const crlf = (before.match(/\r\n/g)?.length ?? 0) * 2 > (before.match(/\n/g)?.length ?? 0);
    const k: Keep = { b, a, unit: unit || unitOf(before), eol: crlf ? '\r\n' : '\n' };

    if (comments)
        k.notes = { units: new Map(), doc: new Map(), xat: new Map(), xend: new Map(), gone: new Set(), lost: false, moved: false };

    const ps = pieces(k, b.items, a.items);

    // (nothing kept: the statement replaced by another; with comments in it, they would be lost)
    if (!ps)
        return 'unaligned';

    if (!ps.some((p) => p.from && p.from.kind !== 'comment') || k.notes?.lost)
        return 'inside';

    // (the top level: neighbours as written, the others each on a line of its own, unindented)
    const units = unitsOf(k, b.items);
    const index = new Map(units.map((x, i) => [x, i]));
    let out = '';

    ps.forEach((p, i) =>
    {
        const prev = ps[i - 1];
        const stays = i > 0 && !!prev.from && !!p.from && index.get(prev.from)! + 1 === index.get(p.from);

        if (i > 0)
            out += stays ? before.slice(xend(k, prev.from!), xat(k, p.from!)) : (p.from && blankOf(k, p.from) ? k.eol : '') + k.eol;

        out += pieceText(k, p, !p.printed && (stays || i === 0) ? lineIndent(before, p.from!.at) : '');
    });

    const toks = tokenize(out);

    if (!toks)
        return 'check';

    if (!k.notes)
        return sig(toks) === sig(a.toks) ? { text: out, gone: [] } : 'check';

    // (the check: the picker's script, and the written comments less those that go, in the written order)
    const plain = (ts: Tok[]): string => sig(ts.filter((t) => t.t !== 'comment'));
    const gone = k.notes.gone;
    const want = b.toks.filter((t, i) => t.t === 'comment' && !gone.has(i)).map((t) => t.v);
    const got = toks.filter((t) => t.t === 'comment').map((t) => t.v);

    // (a statement the picker moved takes its comments along: then in any order)
    const order = (l: string[]): string => (k.notes!.moved ? [...l].sort() : l).join('\u0002');

    if (plain(toks) !== plain(a.toks) || order(want) !== order(got))
        return 'check';

    return { text: out, gone: b.toks.filter((t, i) => t.t === 'comment' && gone.has(i)).map((t) => t.v) };
}

/** The comments of a script text (`# …`, in order; outside quoted strings). */
export function commentsOf(text: string): string[]
{
    const toks = tokenize(text);

    if (toks)
        return toks.filter((t) => t.t === 'comment').map((t) => t.v);

    // (text the tokenizer refuses (an unclosed quote): a `#` outside quotes on its line)
    const out: string[] = [];

    for (const line of text.split(/\r?\n/))
    {
        const m = /^(?:[^"#]|"[^"]*")*(#.*)$/.exec(line);

        if (m)
            out.push(m[1].replace(/\s+$/, ''));
    }

    return out;
}

/** A script text with its comments taken out (the rest as it is); unchanged when the tokenizer does not read it. */
export function withoutComments(text: string): string
{
    const toks = tokenize(text);

    if (!toks)
        return text;

    let out = '';
    let at = 0;

    for (const t of toks)
        if (t.t === 'comment')
        {
            out += text.slice(at, t.s);
            at = t.e;
        }

    return out + text.slice(at);
}

/** The comments of `before` that `after` does not have (each as often as it is missing): what an edit took away. */
export function lostComments(before: string, after: string): string[]
{
    const left = new Map<string, number>();

    for (const c of commentsOf(after))
        left.set(c, (left.get(c) ?? 0) + 1);

    return commentsOf(before).filter((c) =>
    {
        const n = left.get(c) ?? 0;

        if (n)
            left.set(c, n - 1);

        return !n;
    });
}
