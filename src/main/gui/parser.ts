/**
 * Parser for the game's `.gui` files (docs/gui-designer.md): the Jomini dialect of widgets and properties, with the
 * statements script has no use for: `block "name" { }`, `blockoverride "name" { }`, `types Group { type x = widget { } }`,
 * `template Name { }`. Tolerant like the script parser (indexer/parser.ts, whose lexer it uses): a missing `}` ends at
 * the end of the text, a stray one is skipped.
 */
import { Lexer, TK_EOF, TK_LBRACE, TK_OP, TK_PARAM_CLOSE, TK_PARAM_OPEN, TK_RBRACE, TK_STR, type Token } from '../indexer/parser.ts';

/** keywords followed by a name and a block (or, `type`, `name = base { }`) */
const NAMED = new Set(['block', 'blockoverride', 'types', 'Types', 'template', 'local_template', 'type', 'local_type', 'layer']);
const TYPES = new Set(['type', 'local_type']);

export interface GNode
{
    /** a widget kind, a property, a keyword of NAMED; '' for a bare value or an anonymous block */
    key: string;
    /** `block "x"`, `types X`, `template X`, `type x = …` */
    name?: string;
    /** `type x = widget { }`, `foo = bar { }`: what the block is based on */
    base?: string;
    /** a scalar's value (absent for a block) */
    value?: string;
    quoted?: boolean;
    children?: GNode[];
    line: number;
    /** the statement's text in the file: [s, e) */
    s: number;
    e: number;
    /** inside the braces: [s, e) */
    inner?: [number, number];
}

export function parseGui(src: string): GNode[]
{
    const lex = new Lexer(src);
    const out: GNode[] = [];
    list(lex, src, out, true);
    return out;
}

/** The statements up to the closing brace (taken); the offset just past it, or the end of the text. */
function list(lex: Lexer, src: string, out: GNode[], top: boolean): number
{
    for (;;)
    {
        const t = take(lex, src, lex.next());

        switch (t.t)
        {
            case TK_EOF:
                return t.s;
            case TK_RBRACE:
                if (top)
                    continue;

                return t.e;
            case TK_PARAM_OPEN:
            case TK_PARAM_CLOSE:
            case TK_OP:
                continue;
            case TK_LBRACE:
            {
                const children: GNode[] = [];
                const end = list(lex, src, children, false);
                out.push({ key: '', children, line: t.line, s: t.s, e: end, inner: innerOf(src, t.e, end) });
                continue;
            }
            case TK_STR:
            {
                const n = statement(lex, src, t);

                if (n)
                    out.push(n);
            }
        }
    }
}

const innerOf = (src: string, open: number, end: number): [number, number] => [open, src.charCodeAt(end - 1) === 125 ? end - 1 : end];

/**
 * A data function written without quotes (`onclick = [Window.OnClick]`, `[GetX('a b')]`) is one value: the lexer stops
 * at its `]`, so the token is made whole here and the lexer moved past it.
 */
function take(lex: Lexer, src: string, t: Token): Token
{
    if (t.t !== TK_STR || t.q || t.text.charCodeAt(0) !== 91)
        return t;

    let depth = 0;
    let quote = 0;
    let i = t.s;

    for (; i < src.length; i++)
    {
        const c = src.charCodeAt(i);

        if (quote)
            quote = c === quote ? 0 : quote;
        else if (c === 39 || c === 34)
            quote = c;
        else if (c === 91)
            depth++;
        else if (c === 93 && --depth === 0)
            break;
        else if (c === 10)
            break;
    }

    const end = src.charCodeAt(i) === 93 ? i + 1 : t.e;
    lex.pos = end;
    return { ...t, text: src.slice(t.s, end), e: end };
}

/** A block's statements, `open` its brace token (taken). */
function block(lex: Lexer, src: string, open: { e: number; }): { children: GNode[]; end: number; inner: [number, number]; }
{
    const children: GNode[] = [];
    const end = list(lex, src, children, false);
    return { children, end, inner: innerOf(src, open.e, end) };
}

function statement(lex: Lexer, src: string, t: { text: string; q: boolean; s: number; e: number; line: number; }): GNode | undefined
{
    const n: GNode = { key: t.text, line: t.line, s: t.s, e: t.e };
    const next = lex.peek();

    // `block "x" { }`, `types X { }`, `type x = base { }`: the keyword, a name, the block
    if (!t.q && NAMED.has(t.text) && next.t === TK_STR)
    {
        lex.next();
        n.name = next.text;
        n.e = next.e;
        let after = lex.peek();

        if (TYPES.has(t.text) && after.t === TK_OP)
        {
            lex.next();
            const base = lex.peek();

            if (base.t === TK_STR)
            {
                lex.next();
                n.base = base.text;
                n.e = base.e;
            }

            after = lex.peek();
        }

        if (after.t === TK_LBRACE)
        {
            lex.next();
            const b = block(lex, src, after);
            n.children = b.children;
            n.inner = b.inner;
            n.e = b.end;
        }

        return n;
    }

    if (next.t === TK_OP)
    {
        lex.next();
        const v = take(lex, src, lex.next());

        if (v.t === TK_LBRACE)
        {
            const b = block(lex, src, v);
            n.children = b.children;
            n.inner = b.inner;
            n.e = b.end;
        }
        else if (v.t === TK_STR)
        {
            const after = lex.peek();

            // `foo = bar { }`
            if (!v.q && after.t === TK_LBRACE)
            {
                lex.next();
                n.base = v.text;
                const b = block(lex, src, after);
                n.children = b.children;
                n.inner = b.inner;
                n.e = b.end;
            }
            else
            {
                n.value = v.text;
                n.quoted = v.q;
                n.e = v.e;
            }
        }
        else
        {
            // (nothing after the operator: `}` or the end, left for the list)
            lex.unread(v);
            n.value = '';
        }

        return n;
    }

    // `widget { }`
    if (next.t === TK_LBRACE && !t.q)
    {
        lex.next();
        const b = block(lex, src, next);
        n.children = b.children;
        n.inner = b.inner;
        n.e = b.end;
        return n;
    }

    // a bare value (an item of a list: `size = { 100 30 }`)
    return { key: '', value: t.text, quoted: t.q, line: t.line, s: t.s, e: t.e };
}

/** The first statement with a key. */
export function gchild(list: GNode[] | undefined, key: string): GNode | undefined
{
    return list?.find((n) => n.key === key);
}

/** A scalar property's value. */
export function gvalue(list: GNode[] | undefined, key: string): string | undefined
{
    return gchild(list, key)?.value;
}

/** Every statement below, depth first. */
export function gwalk(nodes: GNode[], visit: (n: GNode, parents: GNode[]) => void, parents: GNode[] = []): void
{
    for (const n of nodes)
    {
        visit(n, parents);

        if (n.children)
            gwalk(n.children, visit, [...parents, n]);
    }
}
