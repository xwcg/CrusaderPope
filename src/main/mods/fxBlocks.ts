/**
 * A block scanner for the game's effect files (`.shader` / `.fxh`, docs/shaders.md) that keeps the source offsets of what
 * it finds: the app's own parser (shaders/effect.ts) reads only the meaning, a merge (shaderMerge.ts) must cut definitions
 * out of one file and write them into another as they stand. Top level: `Includes`, `ConstantBuffer`, `VertexStruct`,
 * `Effect`, the render states, a plain `struct`, `Code [[ ]]`, and the `VertexShader` / `PixelShader` blocks with their
 * `TextureSampler`, `BufferTexture`, `Code` and `MainCode`. A `Code` block is split further into its defines, functions,
 * structs and variables, each with the preprocessor condition around it.
 *
 * `fxDefinitions` lists the definitions of a file with a key that says what it is for the merge: the same key in the mod's
 * and the game's file is the same definition (functions by name and parameter types, samplers and mains by name,
 * whatever the stage block they sit in).
 */

/** the shader stage a block compiles for: the vertex or the pixel shader, `both` outside a stage block */
export type FxStage = 'vs' | 'ps' | 'both';

export interface FxItem
{
    /** Includes ConstantBuffer VertexStruct Effect BlendState RasterizerState DepthStencilState struct Code Stage TextureSampler MainCode */
    kind: string;
    name: string;
    start: number;
    end: number;
    text: string;
    stage: FxStage;
    /** a stage block: what it holds */
    children?: FxItem[];
    /** a Code block: the code between `[[` and `]]` */
    codeText?: string;
}

export interface CodeItem
{
    kind: 'define' | 'function' | 'struct' | 'var' | 'pp' | 'other';
    /** what makes it the same definition in another file: `fn:Name(type,type)`, `def:NAME`, `struct:Name`, `var:Name` */
    key: string;
    name: string;
    start: number;
    end: number;
    text: string;
    /**
     * the preprocessor lines around it, one per open `#if`, joined by COND_SEPARATOR, each as the line that would be written
     * again without its `#`: `ifdef Y`, `if A && B`; an `#elif` or `#else` holds the negation of the branches before it
     * (`ifndef Y`, `if !(A) && (B)`)
     */
    cond: string;
    /** a function: the fewest arguments a call needs (the parameters after the first default value have one) */
    minArgs?: number;
}

export const COND_SEPARATOR = '~~COND~~';

/** One definition of a file, with the key under which the merge compares it. */
export interface FxDef
{
    /** `sampler:ps:Name`, `main:vs:Name`, `fn:Name(float4)@both`, `cbuffer:Name`, `vstruct:Name`, `effect:Name`, `BlendState:Name` … */
    key: string;
    /** sampler main cbuffer vstruct effect struct BlendState RasterizerState DepthStencilState, and c-define c-function c-struct c-var c-pp c-other for code */
    kind: string;
    name: string;
    /** the text without comments and white space (two definitions with the same one are the same) */
    norm: string;
    text: string;
    stage: FxStage;
    cond?: string;
    /** a function: the fewest arguments a call needs */
    minArgs?: number;
}

export interface FxFile
{
    defs: Map<string, FxDef[]>;
    /** the include paths as written (comments left out) */
    includes: string[];
    items: FxItem[];
}

const KEYWORDS = new Map(['Includes', 'PixelShader', 'VertexShader', 'Code', 'MainCode', 'VertexStruct', 'ConstantBuffer', 'Effect', 'BlendState', 'RasterizerState', 'DepthStencilState', 'struct'].map((k) => [k.toLowerCase(), k]));
/** what ends a word outside code */
const DELIMITER = /[\s{}()=;:[\],"#]/;

/** After white space and comments (`#` and `//` to the line's end, block comments). */
function skipWs(src: string, from: number): number
{
    const n = src.length;
    let i = from;

    for (;;)
    {
        while (i < n && /\s/.test(src[i]))
            i++;

        if (src[i] === '#' || (src[i] === '/' && src[i + 1] === '/'))
        {
            while (i < n && src[i] !== '\n')
                i++;
        }
        else if (src[i] === '/' && src[i + 1] === '*')
        {
            const e = src.indexOf('*/', i + 2);
            i = e < 0 ? n : e + 2;
        }
        else
            return i;
    }
}

/** After the brace that closes the one at `from`; code blocks (`[[ ]]`), strings and comments are skipped over. */
function matchBrace(src: string, from: number): number
{
    const n = src.length;
    let depth = 0;
    let i = from;

    while (i < n)
    {
        const c = src[i];

        if (c === '[' && src[i + 1] === '[')
        {
            const e = src.indexOf(']]', i + 2);
            i = e < 0 ? n : e + 2;
            continue;
        }

        if (c === '"')
        {
            const e = src.indexOf('"', i + 1);
            i = e < 0 ? n : e + 1;
            continue;
        }

        if (c === '#' || (c === '/' && src[i + 1] === '/'))
        {
            while (i < n && src[i] !== '\n')
                i++;

            continue;
        }

        if (c === '/' && src[i + 1] === '*')
        {
            const e = src.indexOf('*/', i + 2);
            i = e < 0 ? n : e + 2;
            continue;
        }

        if (c === '{')
            depth++;
        else if (c === '}')
        {
            depth--;

            if (depth === 0)
                return i + 1;
        }

        i++;
    }

    return n;
}

/** The end of a word at `from`. */
function wordEnd(src: string, from: number, until: number): number
{
    let k = from;

    while (k < until && !DELIMITER.test(src[k]))
        k++;

    return k;
}

/** The blocks of an effect file (or of the range `from`…`until` of one: a stage block's inside). */
export function scanFx(src: string, stage: FxStage = 'both', from = 0, until = src.length): FxItem[]
{
    const out: FxItem[] = [];
    let i = from;

    while (i < until)
    {
        i = skipWs(src, i);

        if (i >= until)
            break;

        if (src[i] === '}')
        {
            i++;
            continue;
        }

        const start = i;
        const e = wordEnd(src, i, until);

        if (e === i)
        {
            i++;
            continue;
        }

        const word = src.slice(i, e);
        const kw = KEYWORDS.get(word.toLowerCase());
        i = e;

        if (!kw)
        {
            // (TextureSampler Name { }, BufferTexture Name { }, or a setting `Key = value` / `Key = { }`)
            let j = skipWs(src, i);

            if (/Sampler$|BufferTexture$|^Texture/.test(word))
            {
                const k = wordEnd(src, j, until);
                const b = skipWs(src, k);

                if (src[b] === '{')
                {
                    const end = matchBrace(src, b);
                    out.push({ kind: 'TextureSampler', name: src.slice(j, k), start, end, text: src.slice(start, end), stage });
                    i = end;
                    continue;
                }
            }

            if (src[j] === '=')
            {
                j = skipWs(src, j + 1);

                if (src[j] === '{')
                    i = matchBrace(src, j);
                else if (src[j] === '"')
                {
                    const q = src.indexOf('"', j + 1);
                    i = q < 0 ? until : q + 1;
                }
                else
                {
                    let k = j;

                    while (k < until && !/\s/.test(src[k]))
                        k++;

                    i = k;
                }
            }
            else if (src[j] === '{')
                i = matchBrace(src, j);

            continue;
        }

        if (kw === 'Includes')
        {
            let j = skipWs(src, i);

            if (src[j] === '=')
                j = skipWs(src, j + 1);

            const end = matchBrace(src, j);
            out.push({ kind: 'Includes', name: '', start, end, text: src.slice(start, end), stage });
            i = end;
            continue;
        }

        if (kw === 'PixelShader' || kw === 'VertexShader')
        {
            let j = skipWs(src, i);

            if (src[j] === '=')
                j = skipWs(src, j + 1);

            if (src[j] !== '{')
                continue;

            const end = matchBrace(src, j);
            const inner: FxStage = kw === 'PixelShader' ? 'ps' : 'vs';
            out.push({ kind: 'Stage', name: kw, start, end, text: src.slice(start, end), stage: inner, children: scanFx(src, inner, j + 1, end - 1) });
            i = end;
            continue;
        }

        if (kw === 'Code')
        {
            let j = skipWs(src, i);

            if (src[j] === '=')
                j = skipWs(src, j + 1);

            if (src[j] === '[' && src[j + 1] === '[')
            {
                const ce = src.indexOf(']]', j + 2);
                const end = ce < 0 ? until : ce + 2;
                out.push({ kind: 'Code', name: '', start, end, text: src.slice(start, end), stage, codeText: src.slice(j + 2, ce < 0 ? until : ce) });
                i = end;
            }

            continue;
        }

        // (a named block: MainCode Name { }, VertexStruct Name { }, Effect Name { }, a state, ConstantBuffer( Name ) { }, struct Name { })
        let j = skipWs(src, i);
        let name = '';

        if (kw === 'ConstantBuffer')
        {
            if (src[j] === '(')
            {
                const ce = src.indexOf(')', j);
                name = src.slice(j + 1, ce).replace(/\s+/g, '').split(',')[0];
                j = skipWs(src, ce + 1);
            }
        }
        else
        {
            const k = wordEnd(src, j, until);
            name = src.slice(j, k);
            j = skipWs(src, k);
        }

        if (src[j] === '=')
            j = skipWs(src, j + 1);

        if (src[j] !== '{')
            continue;

        let end = matchBrace(src, j);

        // (a plain struct ends with `;`)
        if (kw === 'struct' && src[skipWs(src, end)] === ';')
            end = skipWs(src, end) + 1;

        out.push({ kind: kw, name, start, end, text: src.slice(start, end), stage });
        i = end;
    }

    return out;
}

/** A comment-free copy of code (white space kept; strings do not occur in code that matters here). */
const withoutComments = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/** `a, b( c, d ), e` split at the commas outside brackets. */
function splitTop(t: string): string[]
{
    const out: string[] = [];
    let depth = 0;
    let from = 0;

    for (let i = 0; i < t.length; i++)
    {
        const c = t[i];

        if (c === '(' || c === '[' || c === '{')
            depth++;
        else if (c === ')' || c === ']' || c === '}')
            depth--;
        else if (c === ',' && depth === 0)
        {
            out.push(t.slice(from, i));
            from = i + 1;
        }
    }

    out.push(t.slice(from));
    return out;
}

/** A `#if` open in a code text: the line to write for the branch it is in now, and what its branches were. */
interface CondLevel
{
    line: string;
    /** the directive and condition of the `#if` itself */
    first: { directive: string; rest: string; };
    /** the conditions of the branches so far, as expressions */
    branches: string[];
}

/** A condition as an expression (`#ifdef X` tests `defined(X)`). */
const condExpr = (directive: string, rest: string): string => (directive === 'ifdef' ? `defined(${rest})` : directive === 'ifndef' ? `!defined(${rest})` : rest);

/**
 * The declarations of a `Code [[ ]]` text: `#define`s, functions, structs, variables; the other preprocessor lines only
 * keep the condition stack (`#if` … `#endif`) that each item records.
 */
export function codeItems(code: string): CodeItem[]
{
    const out: CodeItem[] = [];
    const n = code.length;
    const cond: CondLevel[] = [];
    const condText = (): string => cond.map((l) => l.line).join(COND_SEPARATOR);
    // (white space and comments)
    const skip = (from: number): number =>
    {
        let p = from;

        for (;;)
        {
            while (p < n && /\s/.test(code[p]))
                p++;

            if (code[p] === '/' && code[p + 1] === '/')
            {
                while (p < n && code[p] !== '\n')
                    p++;
            }
            else if (code[p] === '/' && code[p + 1] === '*')
            {
                const e = code.indexOf('*/', p + 2);
                p = e < 0 ? n : e + 2;
            }
            else
                return p;
        }
    };
    let i = 0;

    while (i < n)
    {
        i = skip(i);

        if (i >= n)
            break;

        const s = i;

        if (code[i] === '#')
        {
            // (a preprocessor line, with its backslash continuations)
            let e = i;

            for (;;)
            {
                const le = code.indexOf('\n', e);

                if (le < 0)
                {
                    e = n;
                    break;
                }

                if (/\\\s*$/.test(code.slice(e, le).replace(/\r$/, '')))
                {
                    e = le + 1;
                    continue;
                }

                e = le;
                break;
            }

            const text = code.slice(s, e);
            const m = /^#\s*(\w+)\s*(.*)$/s.exec(text.replace(/\/\/.*$/gm, ''));
            const directive = m?.[1] ?? '';
            const rest = (m?.[2] ?? '').trim();

            if (directive === 'define')
            {
                const name = /^(\w+)/.exec(rest)?.[1] ?? '';
                out.push({ kind: 'define', key: 'def:' + name, name, start: s, end: e, text, cond: condText() });
            }
            else if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef')
            {
                const r = rest.replace(/\s+/g, ' ');
                cond.push({ line: directive + ' ' + r, first: { directive, rest: r }, branches: [condExpr(directive, r)] });
            }
            else if (directive === 'elif' || directive === 'else')
            {
                // (a branch after another holds when the ones before it do not: their conditions are negated, so the line written
                // again for a carried definition is true in the builds that take this branch and in no other)
                const level = cond[cond.length - 1];
                const r = rest.replace(/\s+/g, ' ');

                if (level)
                {
                    const earlier = level.branches.map((b) => `!(${b})`);

                    if (directive === 'elif')
                    {
                        level.line = 'if ' + [...earlier, `(${r})`].join(' && ');
                        level.branches.push(r);
                    }
                    else if (level.branches.length === 1 && level.first.directive !== 'if')
                        level.line = (level.first.directive === 'ifdef' ? 'ifndef ' : 'ifdef ') + level.first.rest;
                    else
                        level.line = 'if ' + earlier.join(' && ');
                }
            }
            else if (directive === 'endif')
                cond.pop();
            else
                out.push({ kind: 'pp', key: 'pp:' + directive + ' ' + rest, name: directive, start: s, end: e, text, cond: condText() });

            i = e;
            continue;
        }

        // (a declaration: up to the `;` at depth 0, or the brace group of a function or struct)
        let p = i;
        let depth = 0;
        let paren = 0;
        let sawBrace = false;
        let end = n;

        while (p < n)
        {
            const c = code[p];

            if (c === '/' && code[p + 1] === '/')
            {
                while (p < n && code[p] !== '\n')
                    p++;

                continue;
            }

            if (c === '/' && code[p + 1] === '*')
            {
                const e2 = code.indexOf('*/', p + 2);
                p = e2 < 0 ? n : e2 + 2;
                continue;
            }

            // (a preprocessor line inside a declaration ends it before the line)
            if (c === '#' && depth === 0 && /^\s*$/.test(code.slice(code.lastIndexOf('\n', p - 1) + 1, p)))
            {
                end = p;
                break;
            }

            if (c === '(')
                paren++;
            else if (c === ')')
                paren--;
            else if (c === '{')
            {
                depth++;
                sawBrace = true;
            }
            else if (c === '}')
            {
                depth--;

                if (depth === 0)
                {
                    end = p + 1;
                    const q = skip(end);

                    if (code[q] === ';')
                        end = q + 1;

                    break;
                }
            }
            else if (c === ';' && depth === 0 && paren === 0)
            {
                end = p + 1;
                break;
            }

            p++;
        }

        if (end <= s)
        {
            i = s + 1;
            continue;
        }

        const text = code.slice(s, end);
        const brace = text.indexOf('{');
        const head = withoutComments(brace < 0 ? text : text.slice(0, brace));
        let kind: CodeItem['kind'] = 'other';
        let name = '';
        let key = '';
        let minArgs: number | undefined;
        // (a `=` before the first parenthesis makes a variable; one inside the parentheses is a parameter's default value)
        const open = head.indexOf('(');

        if (/^\s*struct\s+(\w+)/.test(head) && !head.includes('='))
        {
            name = /^\s*struct\s+(\w+)/.exec(head)![1];
            kind = 'struct';
            key = 'struct:' + name;
        }
        else if (sawBrace && open > 0 && /\)\s*(:\s*\w+\s*)?$/.test(head.trim()) && !head.slice(0, open).includes('='))
        {
            // (a function: name(parameter types); the parameters' names and default values do not matter for what it is)
            const m = /(\w+)\s*\(([\s\S]*)\)\s*(?::\s*\w+\s*)?$/.exec(head.trim());

            if (m)
            {
                const params = splitTop(m[2]).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
                const types = params.map((x) => x.split('=')[0].trim())
                    .map((x) => x.replace(/\b(in|out|inout|const)\b\s*/g, (q) => (q.trim() === 'const' ? '' : q)).split(' ').slice(0, -1).join(' '));
                const firstDefault = params.findIndex((x) => x.includes('='));
                name = m[1];
                kind = 'function';
                key = `fn:${name}(${types.join(',')})`;
                minArgs = firstDefault < 0 ? params.length : firstDefault;
            }
        }
        else
        {
            // (a variable: the last word before `=` or `[`)
            const m = /(\w+)\s*(:\s*\w+)?\s*;?$/.exec(head.split('=')[0].replace(/\[[^\]]*\]/g, '').trim());

            if (m)
            {
                name = m[1];
                kind = 'var';
                key = 'var:' + name;
            }
        }

        out.push({ kind, key: key || 'other:' + text.slice(0, 40), name, start: s, end, text, cond: condText(), ...(minArgs === undefined ? {} : { minArgs }) });
        i = end;
    }

    return out;
}

/** Code without comments and white space (preprocessor lines other than defines and conditions are comments too). */
function normCode(t: string): string
{
    return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
        .replace(/#[^\n]*/g, (m) => (/^#(define|if|el|endif|undef|include)/.test(m) ? m : ''))
        .replace(/\s+/g, ' ').trim();
}

/** A block without comments and white space; its code parts as `normCode`. */
function normBlock(t: string): string
{
    return t.split(/(\[\[[\s\S]*?\]\])/)
        .map((p, i) => (i % 2 ? normCode(p) : p.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/#[^\n]*/g, '')))
        .join(' ').replace(/\s+/g, ' ').trim();
}

/** The definitions of an effect file's text, by key (a key can have several: `#if` variants, a stage block written twice). */
export function fxDefinitions(src: string): FxFile
{
    const items = scanFx(src);
    const defs = new Map<string, FxDef[]>();
    const includes: string[] = [];
    const add = (d: FxDef): void =>
    {
        const list = defs.get(d.key);

        if (list)
            list.push(d);
        else
            defs.set(d.key, [d]);
    };
    const walk = (list: FxItem[], stage: FxStage): void =>
    {
        for (const it of list)
        {
            switch (it.kind)
            {
                case 'Includes':
                    for (const m of it.text.matchAll(/"([^"]+)"/g))
                    {
                        // (a path after a `#` on its line is commented out)
                        const before = it.text.slice(0, m.index);

                        if (!before.slice(before.lastIndexOf('\n') + 1).includes('#'))
                            includes.push(m[1]);
                    }

                    break;
                case 'Stage':
                    walk(it.children ?? [], it.stage);
                    break;
                case 'TextureSampler':
                    add({ key: `sampler:${stage}:${it.name}`, kind: 'sampler', name: it.name, norm: normBlock(it.text), text: it.text, stage });
                    break;
                case 'MainCode':
                    add({ key: `main:${stage}:${it.name}`, kind: 'main', name: it.name, norm: normBlock(it.text), text: it.text, stage });
                    break;
                case 'Code':
                    for (const c of codeItems(it.codeText ?? ''))
                        add({ key: `${c.key}@${stage}`, kind: 'c-' + c.kind, name: c.name, norm: normCode(c.text), text: c.text, stage, cond: c.cond, ...(c.minArgs === undefined ? {} : { minArgs: c.minArgs }) });

                    break;
                case 'ConstantBuffer':
                    add({ key: `cbuffer:${it.name}`, kind: 'cbuffer', name: it.name, norm: normBlock(it.text), text: it.text, stage });
                    break;
                case 'VertexStruct':
                    add({ key: `vstruct:${it.name}`, kind: 'vstruct', name: it.name, norm: normBlock(it.text), text: it.text, stage });
                    break;
                case 'Effect':
                    add({ key: `effect:${it.name}`, kind: 'effect', name: it.name, norm: normBlock(it.text), text: it.text, stage });
                    break;
                case 'BlendState':
                case 'RasterizerState':
                case 'DepthStencilState':
                    add({ key: `${it.kind}:${it.name}`, kind: it.kind, name: it.name, norm: normBlock(it.text), text: it.text, stage });
                    break;
                case 'struct':
                    add({ key: `plainstruct:${it.name}`, kind: 'struct', name: it.name, norm: normBlock(it.text), text: it.text, stage });
                    break;
                default:
                    break;
            }
        }
    };
    walk(items, 'both');
    return { defs, includes, items };
}

/** A definition's key without the stage: what it is, whichever stage block it sits in. */
export const keyNoStage = (d: FxDef): string => d.key.replace(/@(ps|vs|both)$/, '').replace(/^(sampler|main):(vs|ps|both):/, '$1:');

/** The members of a constant buffer, a vertex struct or a struct: the names before a `;` (and an array size or semantic). */
export const FIELD_NAMES = /([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*(:\s*\w+)?\s*;/g;

/** A vertex struct field line: indent, qualifiers and type, name, semantic and its index. */
const VERTEX_FIELD = /^(\s*)((?:\w+\s+)*?\w+)\s+(\w+)\s*(?:\[[^\]]*\])?\s*:\s*([A-Za-z_]+)(\d*)\s*;?\s*$/;

/**
 * The game's text with the fields of the mod's VertexStructs it lacks appended to its struct of the same name: the mod
 * only ever adds fields (a mod's code writes `Out.Field`, the game's struct needs it). A semantic's index moves on to the
 * next free one when the game's struct uses it. A field under an `@ifdef` of the mod's struct is not added (`skipped`:
 * its struct and name; code reading it stays out of the merge). `refuse` names the fields that must not be added all the same
 * (`refused`): the game's code takes the struct as `out` / `inout` (fxc then demands every field to be written (X3508) and
 * the game's mains never write the mod's), or no code the merge carries writes the field.
 */
export function unionVertexStructs(gameSrc: string, modSrc: string, eol: string, refuse?: (struct: string, field: string) => boolean): { text: string; added: string[]; skipped: string[]; refused: string[]; }
{
    const mods = scanFx(modSrc).filter((i) => i.kind === 'VertexStruct');
    const edits: { at: number; insert: string; }[] = [];
    const added: string[] = [];
    const skipped: string[] = [];
    const refused: string[] = [];
    const lines = (t: string): string[] => t.split(/\r?\n/);
    const mark = '# MOD-MERGE: fields of the mod\'s copy';

    for (const g of scanFx(gameSrc).filter((i) => i.kind === 'VertexStruct'))
    {
        const m = mods.find((x) => x.name === g.name);

        if (!m)
            continue;

        const have = lines(g.text).map((l) => VERTEX_FIELD.exec(l.replace(/#.*$/, '')));
        const names = new Set(have.filter(Boolean).map((x) => x![3]));
        const used = new Map<string, Set<number>>();

        for (const x of have)
        {
            if (!x)
                continue;

            const set = used.get(x[4]) ?? used.set(x[4], new Set()).get(x[4])!;
            set.add(+x[5] || 0);
        }

        const add: string[] = [];
        // (`@ifdef` … `@endif` around fields: how deep the line is in them)
        let conditional = 0;

        for (const l of lines(m.text))
        {
            if (/^\s*@(ifdef|ifndef)\b/.test(l))
                conditional++;
            else if (/^\s*@endif\b/.test(l))
                conditional = Math.max(0, conditional - 1);

            if (/^\s*@/.test(l))
                continue;

            const x = VERTEX_FIELD.exec(l.replace(/#.*$/, ''));

            if (!x || names.has(x[3]))
                continue;

            if (conditional > 0)
            {
                skipped.push(`${g.name}.${x[3]}`);
                continue;
            }

            if (refuse?.(g.name, x[3]))
            {
                refused.push(`${g.name}.${x[3]}`);
                continue;
            }

            const set = used.get(x[4]) ?? used.set(x[4], new Set()).get(x[4])!;
            const indexed = x[5] !== '';
            let idx = +x[5] || 0;

            if (indexed)
            {
                while (set.has(idx))
                    idx++;

                set.add(idx);
            }

            add.push(`\t${x[2]} ${x[3]} : ${x[4]}${indexed ? idx : ''};`);
            added.push(`${g.name}.${x[3]}`);
        }

        if (add.length)
            edits.push({ at: g.end - 1, insert: eol + '\t' + mark + eol + add.join(eol) + eol });
    }

    let text = gameSrc;

    for (const e of edits.sort((a, b) => b.at - a.at))
        text = text.slice(0, e.at).replace(/\s*$/, '') + e.insert + text.slice(e.at);

    return { text, added, skipped, refused };
}
