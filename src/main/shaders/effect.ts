/**
 * PDX effect files (`.shader` / `.fxh` under gfx/FX of the game, jomini and clausewitz) — the block format around the
 * shader code: Includes, ConstantBuffer, VertexStruct, TextureSampler, Code [[ … ]], MainCode, Effect and render
 * states. See docs/shaders.md.
 *
 * Outside code blocks `#` starts a comment (even `#ifdef` inside a VertexStruct is a comment); `@ifdef` / `@ifndef` /
 * `@else` / `@endif` are effect-level conditions on struct fields.
 */

export type Stage = 'vs' | 'ps';

/** struct / constant buffer member */
export interface FxField
{
    type: string;
    name: string;
    /** array length as written: a number or an engine macro (`float4 Data[2]`, `[PDX_MAX_DETAIL_TEXTURES]`) */
    array?: string;
    semantic?: string;
    /** interpolation or packing qualifiers written before the type */
    qualifiers?: string[];
    /** `@ifdef` conditions around the field: all must hold */
    cond?: { define: string; negate: boolean; }[];
}

export interface FxStruct
{
    name: string;
    fields: FxField[];
    file: string;
}

export interface FxSampler
{
    name: string;
    /** TextureSampler, BufferTexture, RWBufferTexture … */
    kind: string;
    props: Record<string, string>;
    stage: Stage | 'both';
    file: string;
}

export interface FxCode
{
    stage: Stage | 'both';
    code: string;
    file: string;
}

export interface FxMain
{
    name: string;
    stage: Stage;
    input: string;
    output: string;
    code: string;
    file: string;
}

export interface FxEffect
{
    name: string;
    vs?: string;
    ps?: string;
    defines: string[];
    /** BlendState / RasterizerState / DepthStencilState names and other single values */
    props: Record<string, string>;
    file: string;
}

export interface FxFile
{
    path: string;
    includes: string[];
    cbuffers: FxStruct[];
    structs: FxStruct[];
    samplers: FxSampler[];
    codes: FxCode[];
    mains: FxMain[];
    effects: FxEffect[];
    /**
     * BlendState / RasterizerState / DepthStencilState blocks by kind and name (`BlendState:hair_alpha_blend`): the kinds
     * share names — portrait.shader has a BlendState and a DepthStencilState `hair_alpha_blend`; keyed by name alone the
     * depth block replaced the blend block and eyelashes were drawn opaque
     */
    states: Map<string, { kind: string; props: Record<string, string>; }>;
}

/** s / e: source offsets (top-level structs are taken as raw source) */
type Tok = { t: 'word' | 'str' | 'code' | 'dir' | 'p'; v: string; s: number; e: number; };

const PUNCT = new Set(['{', '}', '(', ')', '=', ';', ':', '[', ']', ',']);

function tokenize(src: string): Tok[]
{
    const out: Tok[] = [];
    let i = 0;
    const n = src.length;

    while (i < n)
    {
        const c = src[i];

        if (c === ' ' || c === '\t' || c === '\r' || c === '\n')
        {
            i++;
            continue;
        }

        if (c === '#')
        {
            while (i < n && src[i] !== '\n')
                i++;

            continue;
        }

        if (c === '/' && src[i + 1] === '/')
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

        if (c === '[' && src[i + 1] === '[')
        {
            const e = src.indexOf(']]', i + 2);
            out.push({ t: 'code', v: src.slice(i + 2, e < 0 ? n : e), s: i, e: e < 0 ? n : e + 2 });
            i = e < 0 ? n : e + 2;
            continue;
        }

        if (c === '"')
        {
            const e = src.indexOf('"', i + 1);
            out.push({ t: 'str', v: src.slice(i + 1, e < 0 ? n : e), s: i, e: e < 0 ? n : e + 1 });
            i = e < 0 ? n : e + 1;
            continue;
        }

        if (c === '@')
        {
            let e = i + 1;

            while (e < n && /[A-Za-z_]/.test(src[e]))
                e++;

            const dir = src.slice(i + 1, e);
            let arg = '';

            if (dir === 'ifdef' || dir === 'ifndef')
            {
                while (e < n && (src[e] === ' ' || src[e] === '\t'))
                    e++;

                const s = e;

                while (e < n && /[A-Za-z0-9_]/.test(src[e]))
                    e++;

                arg = src.slice(s, e);
            }

            out.push({ t: 'dir', v: dir + (arg ? ' ' + arg : ''), s: i, e });
            i = e;
            continue;
        }

        if (PUNCT.has(c))
        {
            out.push({ t: 'p', v: c, s: i, e: i + 1 });
            i++;
            continue;
        }

        let e = i;

        while (e < n && !/[\s{}()=;:[\],"#]/.test(src[e]))
            e++;

        if (e === i)
            e++; // stray character

        out.push({ t: 'word', v: src.slice(i, e), s: i, e });
        i = e;
    }

    return out;
}

class Parser
{
    private toks: Tok[];
    private src: string;
    private i = 0;
    readonly file: FxFile;

    constructor(path: string, src: string)
    {
        this.toks = tokenize(src);
        this.src = src;
        this.file = { path, includes: [], cbuffers: [], structs: [], samplers: [], codes: [], mains: [], effects: [], states: new Map() };
    }

    private peek(o = 0): Tok | undefined
    {
        return this.toks[this.i + o];
    }

    private next(): Tok | undefined
    {
        return this.toks[this.i++];
    }

    private isP(v: string, o = 0): boolean
    {
        const t = this.peek(o);
        return t?.t === 'p' && t.v === v;
    }

    /** Skips a balanced `{ … }` (the opening brace is next). */
    private skipBlock(): void
    {
        if (!this.isP('{'))
            return;

        let depth = 0;

        while (this.i < this.toks.length)
        {
            const t = this.next()!;

            if (t.t === 'p' && t.v === '{')
                depth++;
            else if (t.t === 'p' && t.v === '}' && --depth === 0)
                return;
        }
    }

    /** `{ key = value key = value … }` with scalar values (nested blocks kept as their raw word list). */
    private kvBlock(): Record<string, string>
    {
        const props: Record<string, string> = {};

        if (!this.isP('{'))
            return props;

        this.next();

        while (this.i < this.toks.length && !this.isP('}'))
        {
            const k = this.next()!;

            if (k.t !== 'word')
                continue;

            if (this.isP('='))
            {
                this.next();

                if (this.isP('{'))
                {
                    const vals: string[] = [];
                    this.next();

                    while (this.i < this.toks.length && !this.isP('}'))
                    {
                        const t = this.next()!;

                        if (t.t === 'str' || t.t === 'word')
                            vals.push(t.v);
                    }

                    this.next();
                    // list values keep their entries apart: defines may carry values ("NUM_SAMPLES 4")
                    props[k.v] = vals.join(LIST_SEP);
                }
                else
                {
                    const v = this.next();
                    props[k.v] = v?.v ?? '';
                }
            }
            else if (this.isP('{'))
                this.skipBlock();
        }

        this.next();
        return props;
    }

    /** C-like field list of a VertexStruct / ConstantBuffer body. */
    private fields(): FxField[]
    {
        const out: FxField[] = [];

        if (!this.isP('{'))
            return out;

        this.next();
        const cond: { define: string; negate: boolean; }[] = [];
        let words: string[] = [];
        let array: string | undefined;
        let semantic: string | undefined;
        let inSemantic = false;
        const flush = (): void =>
        {
            if (words.length >= 2)
            {
                const name = words[words.length - 1];
                const type = words[words.length - 2];
                out.push({ type, name, array, semantic, qualifiers: words.slice(0, -2), cond: cond.length ? cond.map((c) => ({ ...c })) : undefined });
            }

            words = [];
            array = undefined;
            semantic = undefined;
            inSemantic = false;
        };

        while (this.i < this.toks.length && !this.isP('}'))
        {
            const t = this.next()!;

            if (t.t === 'dir')
            {
                flush();
                const [d, arg] = t.v.split(' ');

                if (d === 'ifdef' || d === 'ifndef')
                    cond.push({ define: arg, negate: d === 'ifndef' });
                else if (d === 'else' && cond.length)
                    cond[cond.length - 1].negate = !cond[cond.length - 1].negate;
                else if (d === 'endif')
                    cond.pop();

                continue;
            }

            if (t.t === 'p' && t.v === ';')
            {
                flush();
                continue;
            }

            if (t.t === 'p' && t.v === ':')
            {
                inSemantic = true;
                continue;
            }

            if (t.t === 'p' && t.v === '[')
            {
                const len = this.next();
                array = len?.v;

                if (this.isP(']'))
                    this.next();

                continue;
            }

            if (t.t !== 'word')
                continue;

            if (inSemantic)
            {
                semantic = t.v;
                // fields may lack their semicolon: a semantic ends the field
                flush();
                continue;
            }

            // a new type word after a complete "type name" without semicolon starts the next field
            if (words.length >= 2 && !QUALIFIERS.has(words[words.length - 1]))
                flush();

            words.push(t.v);
        }

        flush();
        this.next();

        if (this.isP(';'))
            this.next();

        return out;
    }

    parse(): FxFile
    {
        this.items('both');
        return this.file;
    }

    /** `ConstantBuffer( Name [, register …] ) { fields }` after its keyword. */
    private cbuffer(): FxFile['cbuffers'][number]
    {
        let name = '';

        if (this.isP('('))
        {
            this.next();

            while (this.i < this.toks.length && !this.isP(')'))
                name += this.next()!.v;

            this.next();
        }

        return { name, fields: this.fields(), file: this.file.path };
    }

    private items(stage: Stage | 'both'): void
    {
        while (this.i < this.toks.length)
        {
            if (this.isP('}'))
                return;

            const t = this.next()!;

            if (t.t !== 'word')
                continue;

            const f = this.file;

            switch (KEYWORDS.get(t.v.toLowerCase()) ?? t.v)
            {
                case 'Includes':
                {
                    if (this.isP('='))
                        this.next();

                    if (!this.isP('{'))
                        break;

                    this.next();

                    while (this.i < this.toks.length && !this.isP('}'))
                    {
                        const s = this.next()!;

                        if (s.t === 'str')
                            f.includes.push(s.v);
                    }

                    this.next();
                    break;
                }
                case 'PixelShader':
                case 'VertexShader':
                {
                    if (this.isP('='))
                        this.next();

                    if (!this.isP('{'))
                        break;

                    this.next();
                    this.items(/^pixel/i.test(t.v) ? 'ps' : 'vs');
                    this.next();
                    break;
                }
                case 'Code':
                {
                    // `Code [[ … ]]`, also written `Code = [[ … ]]` (AGOT)
                    if (this.isP('='))
                        this.next();

                    const c = this.next();

                    if (c?.t === 'code')
                        f.codes.push({ stage, code: c.v, file: f.path });

                    break;
                }
                case 'MainCode':
                {
                    const name = this.next()?.v ?? '';
                    const m: FxMain = { name, stage: stage === 'both' ? 'ps' : stage, input: '', output: '', code: '', file: f.path };

                    if (!this.isP('{'))
                        break;

                    this.next();

                    while (this.i < this.toks.length && !this.isP('}'))
                    {
                        const k = this.next()!;

                        if (k.t !== 'word')
                            continue;

                        if (/^code$/i.test(k.v))
                        {
                            if (this.isP('='))
                                this.next();

                            const c = this.next();

                            if (c?.t === 'code')
                                m.code = c.v;
                        }
                        else if (KEYWORDS.get(k.v.toLowerCase()) === 'ConstantBuffer')
                        {
                            // a constant buffer declared inside the MainCode (jomini entity_editor/grid.shader): its fields are
                            // uniforms like any other — read as a block, or its closing brace would end the MainCode (and the
                            // file: the Effect after it was never seen)
                            f.cbuffers.push(this.cbuffer());
                        }
                        else if (this.isP('='))
                        {
                            this.next();
                            const v = this.next();

                            if (k.v === 'Input')
                                m.input = v?.v ?? '';
                            else if (k.v === 'Output')
                                m.output = v?.v ?? '';
                        }
                        else if (this.isP('{'))
                            this.skipBlock();
                    }

                    this.next();
                    f.mains.push(m);
                    break;
                }
                case 'VertexStruct':
                {
                    const name = this.next()?.v ?? '';
                    f.structs.push({ name, fields: this.fields(), file: f.path });
                    break;
                }
                case 'ConstantBuffer':
                {
                    f.cbuffers.push(this.cbuffer());
                    break;
                }
                case 'Effect':
                {
                    const name = this.next()?.v ?? '';
                    const props = this.kvBlock();
                    const e: FxEffect = { name, defines: (props.Defines ?? '').split(LIST_SEP).filter(Boolean), props, file: f.path };
                    e.vs = props.VertexShader;
                    e.ps = props.PixelShader;
                    f.effects.push(e);
                    break;
                }
                case 'BlendState':
                case 'RasterizerState':
                case 'DepthStencilState':
                {
                    const name = this.next()?.v ?? '';
                    const kind = KEYWORDS.get(t.v.toLowerCase())!;
                    f.states.set(`${kind}:${name}`, { kind, props: this.kvBlock() });
                    break;
                }
                case 'struct':
                {
                    // a plain HLSL struct outside any Code block (province_effects.fxh): its source goes in as code
                    const nameTok = this.next();

                    if (!nameTok || !this.isP('{'))
                        break;

                    let depth = 0;
                    let end = nameTok.e;

                    while (this.i < this.toks.length)
                    {
                        const x = this.next()!;

                        if (x.t === 'p' && x.v === '{')
                            depth++;
                        else if (x.t === 'p' && x.v === '}' && --depth === 0)
                        {
                            end = x.e;
                            break;
                        }
                    }

                    if (this.isP(';'))
                        end = this.next()!.e;

                    f.codes.push({ stage, code: this.src.slice(t.s, end), file: f.path });
                    break;
                }
                default:
                {
                    // samplers and buffers: `TextureSampler Name { … }`
                    if (/Sampler$|BufferTexture$|^Texture/.test(t.v) && this.peek()?.t === 'word' && this.isP('{', 1))
                    {
                        const name = this.next()!.v;
                        f.samplers.push({ name, kind: t.v, props: this.kvBlock(), stage, file: f.path });
                        break;
                    }

                    // anything else: `Key = value`, `Key = { … }`, `Key Name { … }`
                    if (this.isP('='))
                    {
                        this.next();

                        if (this.isP('{'))
                            this.skipBlock();
                        else
                            this.next();
                    }
                    else if (this.peek()?.t === 'word' && this.isP('{', 1))
                    {
                        this.next();
                        this.skipBlock();
                    }
                    else if (this.isP('{'))
                        this.skipBlock();
                }
            }
        }
    }
}

/** separator of list values in kvBlock props (entries may contain spaces) */
const LIST_SEP = '\u0001';

/** block keywords by lower case: the engine reads them in any case (AGOT's jomini/portrait_decals.fxh: `includes`) */
const KEYWORDS = new Map(
    ['Includes', 'PixelShader', 'VertexShader', 'Code', 'MainCode', 'VertexStruct', 'ConstantBuffer', 'Effect', 'BlendState', 'RasterizerState', 'DepthStencilState'].map((k) => [k.toLowerCase(), k])
);

const QUALIFIERS = new Set(['nointerpolation', 'linear', 'centroid', 'noperspective', 'sample', 'row_major', 'column_major', 'precise']);

export function parseEffectFile(path: string, src: string): FxFile
{
    return new Parser(path, src).parse();
}
