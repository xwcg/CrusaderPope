/**
 * Source-level cleanup before glslang, standing in for what HLSL compilers do implicitly: only code reachable from
 * the entry point is checked. The engine's shared Code blocks hold functions for other stages and effects (`ddx` in
 * code a vertex shader never calls, buffer reads of map objects …) that a GLSL compiler would reject.
 *
 * 1. `#if` / `#ifdef` / `#elif` … are resolved with the defines seen so far (#define / #undef lines are kept for
 *    glslang's own macro expansion).
 * 2. Top-level items are split into preprocessor lines, functions and declarations; functions, `uniform`
 *    declarations and global constants not reachable from `main` (through calls, references or macro bodies) are
 *    dropped.
 */

interface Item
{
    kind: 'pp' | 'func' | 'decl';
    text: string;
    /** function name, macro name or declared uniform name */
    name?: string;
    /** identifiers used (function bodies, macro bodies, initializers) */
    refs: Set<string>;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

function idents(s: string): Set<string>
{
    return new Set(s.match(IDENT) ?? []);
}

/** Removes comments, keeping line structure for directives. */
function stripComments(src: string): string
{
    let out = '';
    let i = 0;
    const n = src.length;

    while (i < n)
    {
        const c = src[i];

        if (c === '/' && src[i + 1] === '/')
        {
            while (i < n && src[i] !== '\n')
                i++;

            continue;
        }

        if (c === '/' && src[i + 1] === '*')
        {
            const e = src.indexOf('*/', i + 2);
            const chunk = src.slice(i, e < 0 ? n : e + 2);
            out += chunk.replace(/[^\n]/g, ' ');
            i = e < 0 ? n : e + 2;
            continue;
        }

        out += c;
        i++;
    }

    return out;
}

// ---------------------------------------------------------------------------
// #if expressions
// ---------------------------------------------------------------------------

function evalCondition(expr: string, defs: Map<string, string>): boolean
{
    // defined(X) / defined X
    let e = expr.replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)|defined\s+([A-Za-z_]\w*)/g, (_m, a, b) => (defs.has(a ?? b) ? '1' : '0'));

    // macros → their values (repeat for nested macros), unknown identifiers → 0
    for (let k = 0; k < 8; k++)
    {
        let changed = false;
        e = e.replace(/[A-Za-z_]\w*/g, (id) =>
        {
            changed = true;
            const v = defs.get(id);
            return v === undefined || v.trim() === '' ? '0' : `(${v})`;
        });

        if (!changed)
            break;
    }

    const toks = e.match(/\d+\.\d*|\d*\.\d+|\d+[uUlL]*|&&|\|\||==|!=|<=|>=|<<|>>|[-+*/%<>!()~&|^]/g) ?? [];
    let p = 0;
    const peek = (): string | undefined => toks[p];
    const take = (): string => toks[p++];
    const prec: Record<string, number> = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
    const unary = (): number =>
    {
        const t = take();

        if (t === '!')
            return unary() ? 0 : 1;

        if (t === '-')
            return -unary();

        if (t === '+')
            return unary();

        if (t === '~')
            return ~unary();

        if (t === '(')
        {
            const v = binary(0);

            if (peek() === ')')
                take();

            return v;
        }

        return parseFloat(t ?? '0') || 0;
    };
    const binary = (minPrec: number): number =>
    {
        let lhs = unary();

        for (;;)
        {
            const op = peek();

            if (op === undefined || prec[op] === undefined || prec[op] < minPrec)
                return lhs;

            take();
            const rhs = binary(prec[op] + 1);

            switch (op)
            {
                case '||':
                    lhs = lhs || rhs ? 1 : 0;
                    break;
                case '&&':
                    lhs = lhs && rhs ? 1 : 0;
                    break;
                case '|':
                    lhs = lhs | rhs;
                    break;
                case '^':
                    lhs = lhs ^ rhs;
                    break;
                case '&':
                    lhs = lhs & rhs;
                    break;
                case '==':
                    lhs = lhs === rhs ? 1 : 0;
                    break;
                case '!=':
                    lhs = lhs !== rhs ? 1 : 0;
                    break;
                case '<':
                    lhs = lhs < rhs ? 1 : 0;
                    break;
                case '>':
                    lhs = lhs > rhs ? 1 : 0;
                    break;
                case '<=':
                    lhs = lhs <= rhs ? 1 : 0;
                    break;
                case '>=':
                    lhs = lhs >= rhs ? 1 : 0;
                    break;
                case '<<':
                    lhs = lhs << rhs;
                    break;
                case '>>':
                    lhs = lhs >> rhs;
                    break;
                case '+':
                    lhs = lhs + rhs;
                    break;
                case '-':
                    lhs = lhs - rhs;
                    break;
                case '*':
                    lhs = lhs * rhs;
                    break;
                case '/':
                    lhs = rhs ? lhs / rhs : 0;
                    break;
                case '%':
                    lhs = rhs ? lhs % rhs : 0;
                    break;
            }
        }
    };

    try
    {
        return binary(0) !== 0;
    }
    catch
    {
        return false;
    }
}

/** Resolves conditional directives; keeps #define/#undef (and other directives) in place. */
export function preprocessConditionals(src: string): string
{
    const defs = new Map<string, string>();
    const out: string[] = [];
    // stack of { active: this branch emits, taken: some branch of this #if already emitted, parent: enclosing active }
    const stack: { active: boolean; taken: boolean; parent: boolean; }[] = [];
    const on = (): boolean => (stack.length ? stack[stack.length - 1].active : true);
    const lines = stripComments(src.replace(/\r\n?/g, '\n')).split('\n');

    for (let li = 0; li < lines.length; li++)
    {
        let line = lines[li];

        // directive continuation lines
        while (/\\\s*$/.test(line) && li + 1 < lines.length && /^\s*#/.test(lines[li] ?? ''))
            line = line.replace(/\\\s*$/, ' ') + lines[++li];

        const m = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);

        if (!m)
        {
            out.push(on() ? line : '');
            continue;
        }

        const [, dir, rest] = m;

        switch (dir)
        {
            case 'if':
            case 'ifdef':
            case 'ifndef':
            {
                const parent = on();
                let cond = false;

                if (parent)
                    cond = dir === 'if' ? evalCondition(rest, defs) : dir === 'ifdef' ? defs.has(rest.trim().split(/\s/)[0]) : !defs.has(rest.trim().split(/\s/)[0]);

                stack.push({ active: parent && cond, taken: parent && cond, parent });
                out.push('');
                break;
            }
            case 'elif':
            {
                const top = stack[stack.length - 1];

                if (top)
                {
                    const cond = top.parent && !top.taken && evalCondition(rest, defs);
                    top.active = cond;

                    if (cond)
                        top.taken = true;
                }

                out.push('');
                break;
            }
            case 'else':
            {
                const top = stack[stack.length - 1];

                if (top)
                {
                    top.active = top.parent && !top.taken;

                    if (top.active)
                        top.taken = true;
                }

                out.push('');
                break;
            }
            case 'endif':
                stack.pop();
                out.push('');
                break;
            case 'define':
            {
                if (on())
                {
                    const d = /^([A-Za-z_]\w*)(\([^)]*\))?\s*(.*)$/.exec(rest);

                    if (d)
                        defs.set(d[1], d[2] ? '1' : d[3]);

                    out.push(line);
                }
                else
                    out.push('');

                break;
            }
            case 'undef':
                if (on())
                {
                    defs.delete(rest.trim());
                    out.push(line);
                }
                else
                    out.push('');

                break;
            default:
                out.push(on() ? line : '');
        }
    }

    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Top-level items and reachability
// ---------------------------------------------------------------------------

/**
 * The name a global constant declares (`static const float2 X[4] = …;`, `const int N = 4;`) — one declarator only
 * (a top-level comma declares several: kept as they are).
 */
function constName(text: string): string | undefined
{
    const t = text.trim();

    if (!/^(static\s+)?const\b/.test(t))
        return undefined;

    let depth = 0;

    for (const c of t)
    {
        if (c === '(' || c === '[' || c === '{')
            depth++;
        else if (c === ')' || c === ']' || c === '}')
            depth--;
        else if (c === ',' && depth === 0)
            return undefined;
    }

    return /^(?:static\s+)?const\s+(?:\w+\s+)*?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*[=;]/.exec(t)?.[1];
}

function splitItems(src: string): Item[]
{
    const items: Item[] = [];
    let i = 0;
    const n = src.length;
    let start = 0;
    const flushDecl = (end: number): void =>
    {
        const text = src.slice(start, end);

        if (text.trim())
        {
            const u = /^\s*uniform\s+[\w]+\s+([A-Za-z_]\w*)/.exec(text);
            // uniforms and global constants are dropped when unused, like an HLSL compiler does: a mod's header may hold
            // constants only its own effects can compile (AGOT's `(float2[N])Packed` array cast in cw/pdxterrain.fxh)
            items.push({ kind: 'decl', text, name: u ? u[1] : constName(text), refs: idents(text) });
        }

        start = end;
    };

    while (i < n)
    {
        const c = src[i];

        // preprocessor line at the start of a line
        if (c === '#' && /(^|\n)[ \t]*$/.test(src.slice(Math.max(0, i - 200), i)))
        {
            flushDecl(i);
            let e = src.indexOf('\n', i);

            if (e < 0)
                e = n;

            const text = src.slice(i, e);
            const d = /^#\s*define\s+([A-Za-z_]\w*)(\([^)]*\))?\s*(.*)$/.exec(text.trim());
            // directives own their line break: consecutive ones must stay on separate lines
            items.push({ kind: 'pp', text: '\n' + text + '\n', name: d?.[1], refs: d ? idents(d[3]) : new Set() });
            i = e + 1;
            start = i;
            continue;
        }

        if (c === ';')
        {
            flushDecl(i + 1);
            i++;
            continue;
        }

        if (c === '{')
        {
            // function definition: "… name ( … ) {"  — anything else with braces (structs, initializers) ends at ';'
            const head = src.slice(start, i);
            const fm = /([A-Za-z_]\w*)\s*\(([^()]|\([^()]*\))*\)\s*$/.exec(head);
            let depth = 0;
            let e = i;

            for (; e < n; e++)
            {
                if (src[e] === '{')
                    depth++;
                else if (src[e] === '}' && --depth === 0)
                    break;
            }

            if (fm && !/^\s*(struct|uniform)\b/.test(head) && !/=\s*$/.test(head))
            {
                const text = src.slice(start, e + 1);
                items.push({ kind: 'func', text, name: fm[1], refs: idents(text) });
                i = e + 1;
                start = i;
                continue;
            }

            // a struct or initializer list: skip to its closing brace, the ';' ends the declaration
            i = e + 1;
            continue;
        }

        i++;
    }

    flushDecl(n);
    return items;
}

/** Splits a parameter list at top-level commas. */
function splitParams(s: string): string[]
{
    const out: string[] = [];
    let depth = 0;
    let cur = '';

    for (const c of s)
    {
        if (c === '(' || c === '[')
            depth++;
        else if (c === ')' || c === ']')
            depth--;

        if (c === ',' && depth === 0)
        {
            out.push(cur);
            cur = '';
        }
        else
            cur += c;
    }

    if (cur.trim())
        out.push(cur);

    return out;
}

/**
 * HLSL default parameter values (`float Harshness = 0.0f`) → the function without defaults plus overloads that
 * leave the defaulted parameters out and forward their values.
 */
function expandDefaultParams(text: string, name: string): string
{
    const open = text.indexOf('(', text.search(new RegExp(`\\b${name}\\s*\\(`)));

    if (open < 0)
        return text;

    let depth = 0;
    let close = open;

    for (; close < text.length; close++)
    {
        if (text[close] === '(')
            depth++;
        else if (text[close] === ')' && --depth === 0)
            break;
    }

    const params = splitParams(text.slice(open + 1, close));

    if (!params.some((p) => p.includes('=')))
        return text;

    const parsed = params.map((p) =>
    {
        const [decl, def] = p.split('=');
        const words = decl.trim().split(/\s+/);
        return { decl: decl.trim(), name: words[words.length - 1], def: def?.trim() };
    });
    const head = text.slice(0, open);
    const returnType = head.slice(0, head.search(new RegExp(`\\b${name}\\s*$`))).trim();
    const full = head + '(' + parsed.map((p) => p.decl).join(', ') + text.slice(close);
    const firstDefault = parsed.findIndex((p) => p.def !== undefined);
    const overloads: string[] = [];

    for (let n = firstDefault; n < parsed.length; n++)
    {
        const kept = parsed.slice(0, n);
        const args = [...kept.map((p) => p.name), ...parsed.slice(n).map((p) => p.def ?? '0')];
        const call = `${name}( ${args.join(', ')} )`;
        overloads.push(`\n${returnType} ${name}( ${kept.map((p) => p.decl).join(', ')} ) { ${/\bvoid$/.test(returnType) ? '' : 'return '}${call}; }\n`);
    }

    return full + overloads.join('');
}

/** Drops functions, uniform declarations and global constants that `main` never reaches. */
export function pruneUnreachable(src: string): string
{
    const pre = preprocessConditionals(src);
    const items = splitItems(pre);
    const funcs = new Map<string, Item[]>();
    const macros = new Map<string, Item>();
    const declared = new Map<string, Item>();

    for (const it of items)
    {
        if (it.kind === 'func' && it.name)
            funcs.set(it.name, [...(funcs.get(it.name) ?? []), it]);
        else if (it.kind === 'pp' && it.name)
            macros.set(it.name, it);
        else if (it.kind === 'decl' && it.name)
            declared.set(it.name, it);
    }

    const reached = new Set<string>();
    const queue: string[] = ['main'];

    // other declarations (structs, variables) are kept and may call functions in initializers
    for (const it of items)
        if (it.kind === 'decl' && !it.name)
        {
            for (const r of it.refs)
                queue.push(r);
        }

    // names built by token pasting (`AGOT_FOW_CLOUDS_##TO##_HEIGHT_MIN`) can't be traced: whatever a pasted fragment
    // could build stays
    const heads = new Set<string>();
    const tails = new Set<string>();

    for (const m of pre.matchAll(/(\w*)\s*##\s*(\w*)/g))
    {
        if (m[1].length >= 3)
            heads.add(m[1]);

        if (m[2].length >= 3)
            tails.add(m[2]);
    }

    if (heads.size || tails.size)
    {
        for (const name of declared.keys())
            if ([...heads].some((h) => name.startsWith(h)) || [...tails].some((t) => name.endsWith(t)))
                queue.push(name);
    }

    while (queue.length)
    {
        const name = queue.pop()!;

        if (reached.has(name))
            continue;

        reached.add(name);

        for (const f of funcs.get(name) ?? [])
            for (const r of f.refs)
                if (!reached.has(r))
                    queue.push(r);

        const m = macros.get(name);

        if (m)
        {
            for (const r of m.refs)
                if (!reached.has(r))
                    queue.push(r);
        }

        const d = declared.get(name);

        if (d)
        {
            for (const r of d.refs)
                if (!reached.has(r))
                    queue.push(r);
        }
    }

    return items
        .filter((it) => (it.kind === 'func' ? reached.has(it.name!) : it.kind === 'decl' && it.name ? reached.has(it.name) : true))
        .map((it) => (it.kind === 'func' ? expandDefaultParams(it.text, it.name!) : it.text))
        .join('');
}
