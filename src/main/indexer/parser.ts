/**
 * Tolerant parser for the Paradox "Jomini" script format used by CK3.
 *
 * Handles: key/value pairs with operators (= == != < <= > >= ?=), nested blocks,
 * bare values (arrays), implicit objects (`foo{...}`), tagged blocks (`rgb { }`, `hsv { }`, `LIST { }`, `RANGE { }`),
 * comments, quoted strings with escapes, inline math `@[ ... ]`, parameter blocks
 * (`[[PARAM] ... ]`, flattened into the surrounding block), stray `}` and missing `}`.
 */

export interface PNode
{
    /** Key, or null for bare values and anonymous blocks. */
    k: string | null;
    /** Operator, or null for bare values / anonymous blocks. */
    op: string | null;
    /** Scalar value or child nodes. */
    v: string | PNode[];
    /** Tag in front of a block, e.g. `rgb` in `color = rgb { 1 2 3 }`. */
    tag?: string;
    /** True when the scalar value was quoted. */
    q?: boolean;
    /** 1-based line of the node's first token. */
    line: number;
    /** Offset of the node's first token (key, or the value for bare nodes). */
    s: number;
    /** Offset just past the node's last token. */
    e: number;
    /** Offset of the value token (scalars) or the opening brace (blocks). */
    vs: number;
    /** Length of the key token in the source (includes quotes when quoted). */
    kl: number;
}

// token types (Token.t)
export const TK_EOF = 0;
export const TK_STR = 1;
export const TK_OP = 2;
export const TK_LBRACE = 3;
export const TK_RBRACE = 4;
export const TK_PARAM_OPEN = 5;
export const TK_PARAM_CLOSE = 6;

export interface Token
{
    t: number;
    text: string;
    q: boolean;
    s: number;
    e: number;
    line: number;
}

const BLOCK_TAGS = new Set(['rgb', 'hsv', 'hsv360', 'hex', 'LIST', 'list', 'RANGE', 'cylindrical']);

function isScalarDelimiter(c: number, next: number): boolean
{
    switch (c)
    {
        case 32: // space
        case 9: // tab
        case 10: // \n
        case 13: // \r
        case 123: // {
        case 125: // }
        case 61: // =
        case 60: // <
        case 62: // >
        case 34: // "
        case 35: // #
        case 93: // ]
        case 59: // ;
            return true;
        case 33: // !
        case 63: // ?
            return next === 61;
        default:
            return c !== c; // NaN (end of input)
    }
}

export class Lexer
{
    readonly src: string;
    pos: number;
    line: number;
    private pushed: Token | null = null;
    private paramDepth = 0;

    constructor(src: string)
    {
        this.src = src;
        this.pos = src.charCodeAt(0) === 0xfeff ? 1 : 0;
        this.line = 1;
    }

    unread(tok: Token): void
    {
        this.pushed = tok;
    }

    peek(): Token
    {
        const t = this.next();
        this.pushed = t;
        return t;
    }

    next(): Token
    {
        if (this.pushed)
        {
            const t = this.pushed;
            this.pushed = null;
            return t;
        }

        const src = this.src;
        const len = src.length;
        let pos = this.pos;
        let line = this.line;

        // skip whitespace, comments and stray semicolons
        for (;;)
        {
            if (pos >= len)
                break;

            const c = src.charCodeAt(pos);

            if (c === 10)
            {
                line++;
                pos++;
            }
            else if (c <= 32 || c === 59 || c === 0xfeff)
            {
                pos++;
            }
            else if (c === 35)
            {
                while (pos < len && src.charCodeAt(pos) !== 10)
                    pos++;
            }
            else
                break;
        }

        const start = pos;

        if (pos >= len)
        {
            this.pos = pos;
            this.line = line;
            return { t: TK_EOF, text: '', q: false, s: pos, e: pos, line };
        }

        const c = src.charCodeAt(pos);
        const n = src.charCodeAt(pos + 1);
        let tok: Token;

        if (c === 123)
        {
            tok = { t: TK_LBRACE, text: '{', q: false, s: start, e: pos + 1, line };
            pos++;
        }
        else if (c === 125)
        {
            tok = { t: TK_RBRACE, text: '}', q: false, s: start, e: pos + 1, line };
            pos++;
        }
        else if (c === 34)
        {
            // quoted string
            pos++;
            let hasEscape = false;
            const tokLine = line;

            while (pos < len)
            {
                const d = src.charCodeAt(pos);

                if (d === 92 /* \ */ && pos + 1 < len)
                {
                    const d2 = src.charCodeAt(pos + 1);

                    if (d2 === 34 || d2 === 92)
                    {
                        hasEscape = true;
                        pos += 2;
                        continue;
                    }
                }

                if (d === 34)
                    break;

                if (d === 10)
                    line++;

                pos++;
            }

            let text = src.slice(start + 1, pos);

            if (hasEscape)
                text = text.replace(/\\(["\\])/g, '$1');

            pos = Math.min(pos + 1, len);
            tok = { t: TK_STR, text, q: true, s: start, e: pos, line: tokLine };
        }
        else if (c === 61)
        {
            const op = n === 61 ? '==' : '=';
            pos += op.length;
            tok = { t: TK_OP, text: op, q: false, s: start, e: pos, line };
        }
        else if (c === 60 || c === 62)
        {
            const op = n === 61 ? (c === 60 ? '<=' : '>=') : c === 60 ? '<' : '>';
            pos += op.length;
            tok = { t: TK_OP, text: op, q: false, s: start, e: pos, line };
        }
        else if ((c === 33 || c === 63) && n === 61)
        {
            pos += 2;
            tok = { t: TK_OP, text: c === 33 ? '!=' : '?=', q: false, s: start, e: pos, line };
        }
        else if (c === 91 && n === 91)
        {
            // [[PARAM] or [[!PARAM]
            pos += 2;

            while (pos < len && src.charCodeAt(pos) !== 93 && src.charCodeAt(pos) !== 10)
                pos++;

            if (src.charCodeAt(pos) === 93)
                pos++;

            this.paramDepth++;
            tok = { t: TK_PARAM_OPEN, text: src.slice(start, pos), q: false, s: start, e: pos, line };
        }
        else if (c === 93 && this.paramDepth > 0)
        {
            this.paramDepth--;
            pos++;
            tok = { t: TK_PARAM_CLOSE, text: ']', q: false, s: start, e: pos, line };
        }
        else if (c === 64 && n === 91)
        {
            // inline math @[ ... ]
            pos += 2;
            let depth = 1;

            while (pos < len && depth > 0)
            {
                const d = src.charCodeAt(pos);

                if (d === 91)
                    depth++;
                else if (d === 93)
                    depth--;
                else if (d === 10)
                    line++;

                pos++;
            }

            tok = { t: TK_STR, text: src.slice(start, pos), q: false, s: start, e: pos, line: this.line };
        }
        else
        {
            // plain scalar
            pos++;

            while (pos < len && !isScalarDelimiter(src.charCodeAt(pos), src.charCodeAt(pos + 1)))
                pos++;

            tok = { t: TK_STR, text: src.slice(start, pos), q: false, s: start, e: pos, line };
        }

        this.pos = pos;
        this.line = line;
        return tok;
    }
}

function parseList(lex: Lexer, out: PNode[], topLevel: boolean): number
{
    for (;;)
    {
        const tok = lex.next();

        switch (tok.t)
        {
            case TK_EOF:
                return tok.s;
            case TK_RBRACE:
                if (topLevel)
                    continue; // extraneous closing brace

                return tok.e;
            case TK_PARAM_OPEN:
            case TK_PARAM_CLOSE:
                continue;
            case TK_LBRACE:
            {
                const children: PNode[] = [];
                const end = parseList(lex, children, false);
                out.push({ k: null, op: null, v: children, line: tok.line, s: tok.s, e: end, vs: tok.s, kl: 0 });
                continue;
            }
            case TK_OP:
            {
                // operator without key, e.g. `= bar`. Parse and attach to an empty key.
                const node = parseValue(lex, '', tok, tok);

                if (node)
                    out.push(node);

                continue;
            }
            case TK_STR:
            {
                const nxt = lex.peek();

                if (nxt.t === TK_OP)
                {
                    lex.next();
                    const node = parseValue(lex, tok.text, tok, nxt);

                    if (node)
                        out.push(node);
                }
                else if (nxt.t === TK_LBRACE && !tok.q)
                {
                    // implicit object: key{...}
                    lex.next();
                    const children: PNode[] = [];
                    const end = parseList(lex, children, false);
                    out.push({ k: tok.text, op: '=', v: children, line: tok.line, s: tok.s, e: end, vs: nxt.s, kl: tok.e - tok.s });
                }
                else
                {
                    out.push({ k: null, op: null, v: tok.text, q: tok.q, line: tok.line, s: tok.s, e: tok.e, vs: tok.s, kl: 0 });
                }

                continue;
            }
        }
    }
}

function parseValue(lex: Lexer, key: string, keyTok: Token, opTok: Token): PNode | null
{
    let val = lex.next();

    while (val.t === TK_OP || val.t === TK_PARAM_OPEN || val.t === TK_PARAM_CLOSE)
        val = lex.next(); // `a = = b`

    const kl = key === '' ? 0 : keyTok.e - keyTok.s;

    if (val.t === TK_LBRACE)
    {
        const children: PNode[] = [];
        const end = parseList(lex, children, false);
        return { k: key, op: opTok.text, v: children, line: keyTok.line, s: keyTok.s, e: end, vs: val.s, kl };
    }

    if (val.t === TK_STR)
    {
        if (!val.q && BLOCK_TAGS.has(val.text))
        {
            const nxt = lex.peek();

            if (nxt.t === TK_LBRACE)
            {
                lex.next();
                const children: PNode[] = [];
                const end = parseList(lex, children, false);
                return { k: key, op: opTok.text, v: children, tag: val.text, line: keyTok.line, s: keyTok.s, e: end, vs: nxt.s, kl };
            }
        }

        return { k: key, op: opTok.text, v: val.text, q: val.q, line: keyTok.line, s: keyTok.s, e: val.e, vs: val.s, kl };
    }

    // EOF or `}` right after operator
    lex.unread(val);
    return { k: key, op: opTok.text, v: '', line: keyTok.line, s: keyTok.s, e: opTok.e, vs: opTok.e, kl };
}

export function parse(src: string): PNode[]
{
    const lex = new Lexer(src);
    const out: PNode[] = [];
    parseList(lex, out, true);
    return out;
}

/** Returns the first child node with the given key. */
export function child(node: PNode | PNode[], key: string): PNode | undefined
{
    const list = Array.isArray(node) ? node : Array.isArray(node.v) ? node.v : null;

    if (!list)
        return undefined;

    for (const c of list)
        if (c.k === key)
            return c;

    return undefined;
}

/** Returns all child nodes with the given key. */
export function children(node: PNode | PNode[], key: string): PNode[]
{
    const list = Array.isArray(node) ? node : Array.isArray(node.v) ? node.v : null;

    if (!list)
        return [];

    return list.filter((c) => c.k === key);
}

export function scalar(node: PNode | undefined): string | undefined
{
    return node && typeof node.v === 'string' ? node.v : undefined;
}
