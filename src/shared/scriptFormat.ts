/**
 * Formats Paradox script (docs/mods.md, "Formatting"): whitespace only — tabs by nesting depth, one statement per line,
 * `key = value` with single spaces, blocks written on one line kept so while short and free of comments (`limit = {
 * is_female = yes }`, `{ }`), longer ones broken up, comments kept where they are (on their own line, after a statement,
 * after a `{`), at most one blank line between statements and none at a block's start or end, the file's line
 * endings. Parameter blocks of scripted effects (`[[PARAM] … ]`) and inline maths (`@[ … ]`) are kept as blocks /
 * values. The result is checked: its tokens must be the text's, in the same order — else the text comes back
 * unchanged (unbalanced braces, anything the tokenizer does not know).
 */

type Tok =
    | { t: 'open' | 'close' | 'pclose'; v: string; line: number; }
    | { t: 'op' | 'word' | 'comment' | 'popen'; v: string; line: number; };

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

            out.push({ t: 'comment', v: text.slice(i, j).replace(/\s+$/, ''), line });
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

            out.push({ t: 'word', v: text.slice(i, j + 1), line });
            i = j + 1;
            continue;
        }

        if (c === '{' || c === '}')
        {
            out.push({ t: c === '{' ? 'open' : 'close', v: c, line });
            i++;
            continue;
        }

        // inline maths: @[ … ] as one value
        if (c === '@' && text[i + 1] === '[')
        {
            const j = text.indexOf(']', i);

            if (j < 0)
                return null;

            out.push({ t: 'word', v: text.slice(i, j + 1).replace(/\s+/g, ' '), line });
            i = j + 1;
            continue;
        }

        // a scripted effect's parameter block: [[PARAM] … ]
        if (c === '[' && text[i + 1] === '[')
        {
            const j = text.indexOf(']', i + 2);

            if (j < 0 || /[\s{}]/.test(text.slice(i + 2, j)))
                return null;

            out.push({ t: 'popen', v: text.slice(i, j + 1), line });
            i = j + 1;
            continue;
        }

        if (c === ']')
        {
            out.push({ t: 'pclose', v: ']', line });
            i++;
            continue;
        }

        const op = OPS.find((o) => text.startsWith(o, i));

        if (op && (c !== '!' && c !== '?' || op.length === 2))
        {
            out.push({ t: 'op', v: op, line });
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

        out.push({ t: 'word', v: text.slice(i, j), line });
        i = j;
    }

    return out;
}

interface Stmt
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
    /** a comment after it on its line */
    trailing?: string;
    blank: boolean;
    line: number;
    endLine: number;
}

interface Param
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

interface Comment
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
                    (prev as Stmt | Param).trailing = t.v;
                else
                    items.push({ kind: 'comment', text: t.v, blank, line: t.line, endLine: t.line });

                lastLine = t.line;
                continue;
            }

            if (t.t === 'popen')
            {
                p++;
                const start = t.line;
                const open = toks[p]?.t === 'comment' && toks[p].line === start ? toks[p++].v : undefined;
                lastLine = start;
                const inner = block('pclose');

                if (!inner || toks[p]?.t !== 'pclose')
                    return null;

                const endLine = toks[p].line;
                p++;
                lastLine = endLine;
                items.push({ kind: 'param', head: t.v, items: inner, inline: start === endLine, openComment: open, blank, line: start, endLine });
                continue;
            }

            if (t.t === 'op')
                return null;

            // a statement: [key op] value | [key op] [tag] { … } | { … } | bare value
            const s: Stmt = { kind: 'stmt', blank, line: t.line, endLine: t.line };
            let valueTok: Tok | undefined = t;

            if (t.t === 'word' && toks[p + 1]?.t === 'op')
            {
                s.key = t.v;
                s.op = toks[p + 1].v;
                p += 2;
                valueTok = toks[p];

                if (!valueTok)
                    return null;
            }

            if (valueTok.t === 'word' && toks[p + 1]?.t === 'open' && s.key !== undefined)
            {
                // a tagged block (rgb { … }, hsv { … }) — the tag then its block
                s.tag = valueTok.v;
                p++;
                valueTok = toks[p];
            }

            if (valueTok.t === 'open')
            {
                const start = valueTok.line;
                p++;
                const open = toks[p]?.t === 'comment' && toks[p].line === start ? toks[p++].v : undefined;
                lastLine = start;
                const inner = block('close');

                if (!inner || toks[p]?.t !== 'close')
                    return null;

                s.endLine = toks[p].line;
                s.block = inner;
                s.inline = start === s.endLine;
                s.openComment = open;
                p++;
            }
            else if (valueTok.t === 'word')
            {
                s.value = valueTok.v;
                s.endLine = valueTok.line;
                p++;
            }
            else
                return null;

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
    if (it.kind === 'comment' || it.trailing || it.openComment)
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

        if (it.kind === 'stmt' && it.value !== undefined)
        {
            out.push(pad + (it.key !== undefined ? `${it.key} ${it.op} ` : '') + it.value + trailing);
            return;
        }

        // a block: on one line when written so, short and without comments
        const one = it.inline ? inlineText({ ...it, trailing: undefined }) : null;

        if (one !== null && depth * 4 + one.length + trailing.length <= INLINE_MAX)
        {
            out.push(pad + one + trailing);
            return;
        }

        const head = it.kind === 'param' ? it.head : `${it.key !== undefined ? `${it.key} ${it.op} ` : ''}${it.tag ? it.tag + ' ' : ''}{`;
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

/** The tokens without comments as one string (null: it does not tokenize) — what sameScript() compares, built. */
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
 * Whether two pieces of script say the same: the same tokens (words, strings, operators, braces) in the same order —
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
 * The text formatted (without a byte order mark: the caller keeps it) — or unchanged when it is no script this
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
