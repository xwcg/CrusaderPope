/**
 * The game's own shaders for WebGL2 — see docs/shaders.md.
 *
 * An Effect (e.g. `standard_atlas` in gfx/FX/pdxmesh.shader) is assembled like the engine does for its OpenGL target:
 * the engine's GLSL layer (clausewitz cw/defines_glsl4.fxh maps float3 → vec3, lerp → mix, PdxTex2D → texture …),
 * constant buffers as loose uniforms, samplers, VertexStructs as structs, the Code blocks of every include in order,
 * and the stage's MainCode behind a generated main() that moves attributes/varyings in and out of the structs.
 * That desktop GLSL 4.50 is compiled with glslang and turned into GLSL ES 3.00 by SPIRV-Cross (both WebAssembly, via
 * the cross-shader package): implicit int → float conversions and the like become explicit, names stay intact.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { parseEffectFile, type FxEffect, type FxField, type FxFile, type FxMain, type FxSampler, type FxStruct, type Stage } from './effect.ts';
import { pruneUnreachable } from './prune.ts';
import { GameFiles, type GameFile } from '../mods/gamefiles.ts';
import { MAX_JOINTS } from '../../shared/shaders.ts';
import type { ShaderProgram, ShaderRequest } from '../../shared/api.ts';

interface CrossShader
{
    compile(src: string, input: { format: number; stage: number; es: boolean; glslVersion: number; }, output: { format: number; es: boolean; glslVersion: number; }): string;
    ShaderFormat: Record<string, number>;
    ShaderStage: Record<string, number>;
}

let crossShader: Promise<CrossShader> | null = null;

/**
 * The cross-shader Emscripten module, made from its factory with the .wasm bytes at hand (`wasmBinary`): the package's
 * own entry calls the factory bare, which first tries to stream-compile the file with fetch — failing in Node, logged
 * once per shader thread ("wasm streaming compile failed … falling back to ArrayBuffer instantiation").
 */
function loadCrossShader(): Promise<CrossShader>
{
    if (!crossShader)
    {
        crossShader = new Promise<CrossShader>((resolve, reject) =>
        {
            try
            {
                const req = createRequire(import.meta.url);
                const factory = req('cross-shader/bin/CrossShader.js') as (opts: { wasmBinary: Uint8Array; }) => CrossShader & { onRuntimeInitialized?: () => void; onAbort?: (e: unknown) => void; };
                const m = factory({ wasmBinary: new Uint8Array(readFileSync(req.resolve('cross-shader/bin/CrossShader.wasm'))) });
                m.onAbort = (e) => reject(e instanceof Error ? e : new Error(`cross-shader: ${String(e)}`));
                m.onRuntimeInitialized = () => resolve({ ShaderFormat: m.ShaderFormat, ShaderStage: m.ShaderStage, compile: m.compile });
            }
            catch (e)
            {
                reject(e);
            }
        });
    }

    return crossShader;
}

const INT_TYPES = /^(u?int|bool)[234]?$|^[iu]vec[234]$/;

/** HLSL-style type name → GLSL (the engine's #defines would do it too; needed for generated declarations). */
function glslType(t: string): string
{
    const m: Record<string, string> = {
        float4: 'vec4',
        float3: 'vec3',
        float2: 'vec2',
        int4: 'ivec4',
        int3: 'ivec3',
        int2: 'ivec2',
        uint4: 'uvec4',
        uint3: 'uvec3',
        uint2: 'uvec2',
        bool4: 'bvec4',
        bool3: 'bvec3',
        bool2: 'bvec2',
        float4x4: 'mat4',
        float3x3: 'mat3',
        float2x2: 'mat2',
        half: 'float',
        half2: 'vec2',
        half3: 'vec3',
        half4: 'vec4'
    };
    return m[t] ?? t;
}

/** Zero value of a GLSL type for synthesized inputs. */
function zero(t: string): string
{
    const g = glslType(t);

    if (g === 'float')
        return '0.0';

    if (g === 'int')
        return '0';

    if (g === 'uint')
        return '0u';

    if (g === 'bool')
        return 'false';

    if (/^uvec/.test(g))
        return `${g}(0u)`;

    if (/^ivec/.test(g))
        return `${g}(0)`;

    return `${g}(0.0)`;
}

export class ShaderLibrary
{
    /**
     * The game's files with the loaded mods. FX files live in the engine layers — `game/gfx/FX` over `jomini/gfx/FX`
     * over `clausewitz/gfx/FX` (the game overrides some jomini headers) — and a mod's `gfx/FX/…` file replaces them all.
     */
    readonly vfs: GameFiles;
    private files = new Map<string, FxFile | null>();
    private cache = new Map<string, Promise<ShaderProgram>>();

    /** @param files the layered game files, or the `game` folder alone (scripts) */
    constructor(files: GameFiles | string)
    {
        this.vfs = typeof files === 'string' ? new GameFiles(files) : files;
    }

    /** `gfx/FX/pdxmesh.shader` or `cw/pdxmesh.fxh` (include paths are below the FX roots) → the file the game loads. */
    resolve(rel: string): GameFile | undefined
    {
        const r = rel.replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .replace(/^gfx\/FX\//i, '');
        return this.vfs.get('gfx/FX/' + r, { engine: true });
    }

    private text(rel: string): string | undefined
    {
        const f = this.resolve(rel);
        return f ? this.vfs.readText(f) : undefined;
    }

    file(rel: string): FxFile | null
    {
        const key = rel.replace(/\\/g, '/')
            .replace(/^gfx\/FX\//i, '')
            .toLowerCase();
        let f = this.files.get(key);

        if (f === undefined)
        {
            const text = this.text(rel);
            f = text !== undefined ? parseEffectFile(key, text) : null;
            this.files.set(key, f);
        }

        return f;
    }

    /** The file and its includes, depth first, each once (includes come before the files using them). */
    private ordered(rel: string, seen = new Set<string>(), out: FxFile[] = []): FxFile[]
    {
        const f = this.file(rel);

        if (!f || seen.has(f.path))
            return out;

        seen.add(f.path);

        for (const inc of f.includes)
            this.ordered(inc, seen, out);

        out.push(f);
        return out;
    }

    effect(rel: string, name: string, fallback = true): { effect: FxEffect; files: FxFile[]; } | undefined
    {
        const files = this.ordered(rel);

        for (let i = files.length - 1; i >= 0; i--)
        {
            const e = files[i].effects.find((x) => x.name === name);

            if (e)
                return { effect: e, files };
        }

        // assets sometimes name another file (tree_lod "in" pdxmesh.shader): the engine finds effects by name
        const other = fallback ? this.effectFile(name) : undefined;
        return other && other !== rel ? this.effect(other, name, false) : undefined;
    }

    private effectFiles: Map<string, string> | null = null;

    /**
     * Effect name → the .shader file defining it (scanned once, first wins): the mods' files first (the last mod
     * first), then the game's FX roots in their order — game, jomini, clausewitz.
     */
    private effectFile(name: string): string | undefined
    {
        if (!this.effectFiles)
        {
            const map = (this.effectFiles = new Map<string, string>());
            const install = dirname(this.vfs.gameDir);
            const roots = [join(this.vfs.gameDir, 'gfx', 'FX'), join(install, 'jomini', 'gfx', 'FX'), join(install, 'clausewitz', 'gfx', 'FX')].map((r) => r.toLowerCase());
            const rank = (f: GameFile): number =>
            {
                if (f.source > 0)
                    return -f.source;

                const i = roots.findIndex((r) => (f.abs ?? '').toLowerCase().startsWith(r));
                return i < 0 ? roots.length : i;
            };
            const shaders = this.vfs.list('gfx/FX', { engine: true, ext: /\.shader$/i });

            for (const f of [...shaders].sort((a, b) => rank(a) - rank(b)))
            {
                for (const m of (this.vfs.readText(f) ?? '').matchAll(/^Effect\s+(\w+)/gm))
                    if (!map.has(m[1]))
                        map.set(m[1], f.rel);
            }
        }

        return this.effectFiles.get(name);
    }

    /** Names of the effects a file defines (for the shader browser and fallbacks). */
    effects(rel: string): string[]
    {
        return this.file(rel)?.effects.map((e) => e.name) ?? [];
    }

    compile(req: ShaderRequest): Promise<ShaderProgram>
    {
        const key = JSON.stringify(req);
        let p = this.cache.get(key);

        if (!p)
        {
            p = this.build(req);
            this.cache.set(key, p);
        }

        return p;
    }

    private async build(req: ShaderRequest): Promise<ShaderProgram>
    {
        const found = this.effect(req.file, req.effect);

        if (!found)
            throw new Error(`Effect ${req.effect} not found in ${req.file}`);

        const { effect, files } = found;
        const defines = [...new Set([...effect.defines.filter((d) => !(req.remove ?? []).includes(d)), ...(req.defines ?? [])])];
        const vsMain = this.main(files, effect.vs, 'vs');
        const psMain = this.main(files, effect.ps, 'ps');

        if (!vsMain || !psMain)
            throw new Error(`Effect ${effect.name}: shader ${!vsMain ? effect.vs : effect.ps} not found`);

        const structs = new Map<string, FxStruct>();

        for (const f of files)
            for (const s of f.structs)
                structs.set(s.name, s);

        const active = (fl: FxField): boolean => (fl.cond ?? []).every((c) => defines.includes(c.define) !== c.negate);

        let vs = this.stageSource(files, 'vs', vsMain, structs, defines, active, req);
        // The engine compiles a skinned mesh with PDX_MESH_SKINNED; the viewers pose on the CPU and ask without. Vertex
        // code reading the bone streams itself (AGOT's particle cards: each card placed from its bone's matrix) can't do
        // without: compiled skinned, with room for MAX_JOINTS joint matrices unless the request sizes them
        let stageReq = req;

        if (!defines.includes('PDX_MESH_SKINNED') && !(req.remove ?? []).includes('PDX_MESH_SKINNED') && readsBones(vs.source))
        {
            defines.push('PDX_MESH_SKINNED');
            stageReq = { ...req, arrays: { JointVertexMatrices: 3 * MAX_JOINTS, ...req.arrays } };
            vs = this.stageSource(files, 'vs', vsMain, structs, defines, active, stageReq);
        }

        const ps = this.stageSource(files, 'ps', psMain, structs, defines, active, stageReq);
        const xs = await loadCrossShader();
        const toEs = (source: string, stage: Stage): string =>
        {
            let src = source;

            try
            {
                // HLSL-only implicit conversions glslang points at get patched line by line, then it compiles again
                for (let attempt = 0;; attempt++)
                {
                    const out = xs.compile(src, { format: xs.ShaderFormat.GLSL, stage: stage === 'vs' ? xs.ShaderStage.Vertex : xs.ShaderStage.Fragment, es: false, glslVersion: 450 }, { format: xs.ShaderFormat.GLSL, es: true, glslVersion: 300 });

                    // glslang errors come back as the output text
                    if (!/^ERROR:/m.test(out))
                        return out;

                    const fixed = attempt < 40 ? fixHlslisms(src, out) : null;

                    if (!fixed)
                        throw new Error(out.trim());

                    src = fixed;
                }
            }
            catch (err)
            {
                let msg = String((err as Error)?.message ?? err);

                // a vertex shader reading bone data itself (AGOT's particle cards) is compiled skinned — unless the request
                // removes PDX_MESH_SKINNED
                if (/'Bone(Index|Weight)' : no such field/.test(msg))
                    msg += '\n(needs GPU skinning: the request removes PDX_MESH_SKINNED)';

                const e = new Error(`${effect.name} ${stage === 'vs' ? 'vertex' : 'pixel'} shader: ${msg}`);
                (e as Error & { source?: string; }).source = src;
                throw e;
            }
        };
        const vertex = toEs(vs.source, 'vs');
        const fragment = toEs(ps.source, 'ps');
        // things GLSL ES 3.00 lacks would only fail at link time in the browser: fail here so the viewer falls back
        const unsupported = /\b[iu]?samplerBuffer\b|\btextureQueryLod\b|\b[iu]?sampler2DMS\b|\btextureSamples\b/.exec(vertex + fragment);

        if (unsupported)
            throw new Error(`${effect.name}: uses ${unsupported[0]}, which WebGL2 lacks`);

        const states: ShaderProgram['states'] = {};
        const state = (kind: string): Record<string, string> | undefined =>
        {
            const name = effect.props[kind];

            if (!name)
                return undefined;

            for (let i = files.length - 1; i >= 0; i--)
            {
                const s = files[i].states.get(`${kind}:${name}`);

                if (s)
                    return s.props;
            }

            return undefined;
        };
        states.blend = state('BlendState');
        states.raster = state('RasterizerState');
        states.depth = state('DepthStencilState');

        // renamed constant buffer members the compiled code still uses
        const aliases = Object.fromEntries(Object.entries({ ...vs.aliases, ...ps.aliases }).filter(([a]) => new RegExp(`\\b${a}\\b`).test(vertex + fragment)));
        return {
            file: req.file,
            effect: effect.name,
            defines,
            vertex: vertex.replace(/^#version[^\n]*\n/, ''),
            fragment: fragment.replace(/^#version[^\n]*\n/, ''),
            attributes: vs.attributes,
            // samplers the compiled code still uses (pruning drops many)
            samplers: [...vs.samplers, ...ps.samplers.filter((s) => !vs.samplers.some((v) => v.name === s.name))].filter((s) => new RegExp(`\\b${s.name}\\b`).test(vertex + fragment)),
            states,
            ...(Object.keys(aliases).length ? { aliases } : {})
        };
    }

    private main(files: FxFile[], name: string | undefined, stage: Stage): FxMain | undefined
    {
        if (!name)
            return undefined;

        for (let i = files.length - 1; i >= 0; i--)
        {
            const m = files[i].mains.find((x) => x.name === name && x.stage === stage);

            if (m)
                return m;
        }

        return undefined;
    }

    private stageSource(
        files: FxFile[],
        stage: Stage,
        main: FxMain,
        structs: Map<string, FxStruct>,
        defines: string[],
        active: (f: FxField) => boolean,
        req: ShaderRequest
    ): { source: string; attributes: ShaderProgram['attributes']; samplers: ShaderProgram['samplers']; aliases: Record<string, string>; }
    {
        const cw = (name: string): string => this.text('cw/' + name) ?? '';
        const code: string[] = [];

        for (const f of files)
            for (const c of f.codes)
                if (c.stage === 'both' || c.stage === stage)
                    code.push(`// ${f.path}\n${c.code}`);

        const shared = code.join('\n');
        const body = shared + '\n' + main.code;
        // the entry function: PDX_MAIN becomes a named function the generated main() calls
        const withMain = (signature: string): string => `${shared}\n// ${main.file} ${main.name}\n${main.code.replace(/\bPDX_MAIN\b/, signature)}`;

        const out: string[] = ['#version 450'];
        out.push('#define PDX_GLSL', '#define PDX_OPENGL', stage === 'vs' ? '#define VERTEX_SHADER' : '#define PIXEL_SHADER');

        for (const d of defines)
            out.push('#define ' + d);

        // WebGL2 has no buffer textures: the engine's buffer types become 2D textures (4096 texels per row)
        const glslLayer = cw('defines_glsl4.fxh')
            .split(/\r?\n/)
            .filter((l) => !/PdxBuffer|PdxReadBuffer/.test(l))
            .join('\n');
        out.push(glslLayer, BUFFER_EMULATION, cw('defines_common.fxh'));

        // array sizes the engine defines at compile time (PDX_MAX_DETAIL_TEXTURES …): small defaults — also inside size
        // expressions (`[PDX_MAX_DETAIL_TEXTURES/2]` in AGOT's cw/pdxterrain.fxh); `4*6` needs nothing
        const sizeMacros = new Set<string>();

        for (const f of files)
            for (const s of [...f.cbuffers, ...f.structs])
                for (const fl of s.fields)
                    for (const m of fl.array?.match(/[A-Za-z_]\w*/g) ?? [])
                        sizeMacros.add(m);

        for (const m of sizeMacros)
            out.push(`#ifndef ${m}\n#define ${m} 8\n#endif`);

        // constant buffers → loose uniforms (sizes of the engine's placeholder arrays raised to what we fill). The engine
        // fills a buffer by its layout, not by member names: a buffer declared again under the same name with renamed
        // members (AGOT's cw/agot_camera.fxh copies PdxCamera as Camera_Position, Shadow_Map_Texture_Matrix …) gets the
        // same data — its members become aliases of the first declaration's members at the same place
        const declared = new Set<string>();
        const buffers = new Map<string, FxField[]>();
        const aliases: Record<string, string> = {};

        for (const f of files)
        {
            for (const cb of f.cbuffers)
            {
                const fields = cb.fields.filter(active);
                const first = buffers.get(cb.name);

                if (!first)
                    buffers.set(cb.name, fields);

                // the layouts agree as long as types and array sizes do
                let same = !!first;
                fields.forEach((fl, i) =>
                {
                    same &&= !!first![i] && glslType(first![i].type) === glslType(fl.type) && (first![i].array ?? '') === (fl.array ?? '');

                    if (same && first![i].name !== fl.name && !declared.has(fl.name))
                        aliases[fl.name] = first![i].name;

                    if (declared.has(fl.name))
                        return;

                    declared.add(fl.name);
                    const size = req.arrays?.[fl.name] ?? fl.array;
                    out.push(`uniform ${glslType(fl.type)} ${fl.name}${size ? `[${size}]` : ''};`);
                });
            }
        }

        // samplers of this stage that the code uses
        const samplers: ShaderProgram['samplers'] = [];
        const seenSampler = new Set<string>();

        for (const f of files)
        {
            for (const s of f.samplers)
            {
                if ((s.stage !== 'both' && s.stage !== stage) || seenSampler.has(s.name))
                    continue;

                if (!new RegExp(`\\b${s.name}\\b`).test(body))
                    continue;

                seenSampler.add(s.name);

                if (s.kind === 'BufferTexture')
                {
                    // declared for the desktop compile (functions using it may never be called); WebGL2 has no buffer textures
                    out.push(`uniform ${bufferType(s.props.type ?? 'float')} ${s.name};`);
                    continue;
                }

                const type = samplerType(s);

                if (!type)
                    continue;

                out.push(`uniform ${type} ${s.name};`);
                samplers.push({ name: s.name, type, index: s.props.Index !== undefined ? Number(s.props.Index) : undefined, ref: s.props.Ref, file: s.props.File, props: s.props });
            }
        }

        // VertexStructs → GLSL structs (semantics dropped)
        for (const s of structs.values())
        {
            const fields = s.fields.filter(active);

            if (!fields.length)
                continue;

            out.push(`struct ${s.name} {\n${fields.map((fl) => `  ${glslType(fl.type)} ${fl.name}${fl.array ? `[${fl.array}]` : ''};`).join('\n')}\n};`);
        }

        // stage interface
        const attributes: ShaderProgram['attributes'] = [];
        const input = structs.get(main.input);
        const output = structs.get(main.output);
        const pre: string[] = [];
        const post: string[] = [];
        const inputFields = input?.fields.filter(active) ?? [];
        const outputFields = output?.fields.filter(active) ?? [];

        if (stage === 'vs')
        {
            let loc = 0;

            for (const fl of inputFields)
            {
                const sem = (fl.semantic ?? '').toUpperCase();

                if (sem === 'PDX_VERTEXID' || sem === 'SV_VERTEXID')
                    pre.push(`  Input.${fl.name} = ${glslType(fl.type)}(gl_VertexID);`);
                else if (sem === 'PDX_INSTANCEID' || sem === 'SV_INSTANCEID')
                    pre.push(`  Input.${fl.name} = ${glslType(fl.type)}(gl_InstanceID);`);
                else if (/^Instance/i.test(fl.name))
                    pre.push(`  Input.${fl.name} = ${zero(fl.type)};`); // one object at index 0
                else
                {
                    const name = 'a_' + fl.name;
                    out.push(`layout(location = ${loc}) in ${glslType(fl.type)} ${name};`);
                    attributes.push({ name, field: fl.name, type: glslType(fl.type), semantic: fl.semantic, location: loc });
                    loc++;
                    pre.push(`  Input.${fl.name} = ${name};`);
                }
            }

            for (const fl of outputFields)
            {
                const sem = (fl.semantic ?? '').toUpperCase();

                if (sem === 'PDX_POSITION' || sem === 'SV_POSITION')
                    post.push(`  gl_Position = Out.${fl.name};`);
                else
                {
                    out.push(`${INT_TYPES.test(fl.type) ? 'flat ' : ''}out ${glslType(fl.type)} v_${fl.name};`);
                    post.push(`  v_${fl.name} = Out.${fl.name};`);
                }
            }

            out.push(withMain(`${main.output} PdxMain( ${main.input} Input )`));
            out.push(`void main() {\n  ${main.input} Input;\n${pre.join('\n')}\n  ${main.output} Out = PdxMain( Input );\n${post.join('\n')}\n}`);
        }
        else
        {
            for (const fl of inputFields)
            {
                const sem = (fl.semantic ?? '').toUpperCase();

                if (sem === 'PDX_POSITION' || sem === 'SV_POSITION')
                    pre.push(`  Input.${fl.name} = gl_FragCoord;`);
                else if (sem === 'PDX_ISFRONTFACE' || sem === 'SV_ISFRONTFACE')
                    pre.push(`  Input.${fl.name} = gl_FrontFacing;`);
                else
                {
                    out.push(`${INT_TYPES.test(fl.type) ? 'flat ' : ''}in ${glslType(fl.type)} v_${fl.name};`);
                    pre.push(`  Input.${fl.name} = v_${fl.name};`);
                }
            }

            let call = `  PdxMain( Input );`;
            let signature = `void PdxMain( ${main.input} Input )`;

            if (req.post)
                out.push(VIEWER_POST);

            const post = (expr: string): string => (req.post ? `PdxViewerPost( ${expr} )` : expr);

            if (main.output === 'PDX_COLOR')
            {
                out.push('layout(location = 0) out vec4 PdxColor0;');
                signature = `vec4 PdxMain( ${main.input} Input )`;
                call = `  PdxColor0 = ${post('PdxMain( Input )')};`;
            }
            else if (output)
            {
                const lines: string[] = [];
                outputFields.forEach((fl, i) =>
                {
                    const m = /(\d+)$/.exec(fl.semantic ?? '');
                    const loc = m ? Number(m[1]) : i;
                    out.push(`layout(location = ${loc}) out ${glslType(fl.type)} PdxColor${loc};`);
                    lines.push(`  PdxColor${loc} = ${loc === 0 && glslType(fl.type) === 'vec4' ? post(`Out.${fl.name}`) : `Out.${fl.name}`};`);
                });
                signature = `${main.output} PdxMain( ${main.input} Input )`;
                call = `  ${main.output} Out = PdxMain( Input );\n${lines.join('\n')}`;
            }

            out.push(withMain(signature));
            out.push(`void main() {\n  ${main.input} Input;\n${pre.join('\n')}\n${call}\n}`);
        }

        // like an HLSL compiler, only what main() reaches is compiled
        return { source: hlslAttributes(hlslCasts(hlslImplicitInts(pruneUnreachable(out.join('\n'))))), attributes, samplers, aliases };
    }
}

/**
 * Buffer textures (instance data, decal lists, blend shapes) as 2D textures for WebGL2: element i sits at
 * (i % 4096, i / 4096); int and uint buffers are integer textures.
 */
const BUFFER_EMULATION = `
#define PdxBufferFloat  sampler2D
#define PdxBufferFloat2 sampler2D
#define PdxBufferFloat3 sampler2D
#define PdxBufferFloat4 sampler2D
#define PdxBufferInt    isampler2D
#define PdxBufferInt2   isampler2D
#define PdxBufferInt3   isampler2D
#define PdxBufferInt4   isampler2D
#define PdxBufferUint   usampler2D
#define PdxBufferUint2  usampler2D
#define PdxBufferUint3  usampler2D
#define PdxBufferUint4  usampler2D
ivec2 PdxBufferCoord( int Index ) { return ivec2( Index % 4096, Index / 4096 ); }
float  PdxReadBuffer( in sampler2D Buf, int Index )   { return texelFetch( Buf, PdxBufferCoord( Index ), 0 ).r; }
vec2   PdxReadBuffer2( in sampler2D Buf, int Index )  { return texelFetch( Buf, PdxBufferCoord( Index ), 0 ).rg; }
vec3   PdxReadBuffer3( in sampler2D Buf, int Index )  { return texelFetch( Buf, PdxBufferCoord( Index ), 0 ).rgb; }
vec4   PdxReadBuffer4( in sampler2D Buf, int Index )  { return texelFetch( Buf, PdxBufferCoord( Index ), 0 ); }
int    PdxReadBuffer( in isampler2D Buf, int Index )  { return texelFetch( Buf, PdxBufferCoord( Index ), 0 ).r; }
ivec2  PdxReadBuffer2( in isampler2D Buf, int Index ) { return texelFetch( Buf, PdxBufferCoord( Index ), 0 ).rg; }
ivec3  PdxReadBuffer3( in isampler2D Buf, int Index ) { return texelFetch( Buf, PdxBufferCoord( Index ), 0 ).rgb; }
ivec4  PdxReadBuffer4( in isampler2D Buf, int Index ) { return texelFetch( Buf, PdxBufferCoord( Index ), 0 ); }
uint   PdxReadBuffer( in usampler2D Buf, int Index )  { return texelFetch( Buf, PdxBufferCoord( Index ), 0 ).r; }
uvec2  PdxReadBuffer2( in usampler2D Buf, int Index ) { return texelFetch( Buf, PdxBufferCoord( Index ), 0 ).rg; }
uvec3  PdxReadBuffer3( in usampler2D Buf, int Index ) { return texelFetch( Buf, PdxBufferCoord( Index ), 0 ).rgb; }
uvec4  PdxReadBuffer4( in usampler2D Buf, int Index ) { return texelFetch( Buf, PdxBufferCoord( Index ), 0 ); }
${
    ['sampler2D', 'isampler2D', 'usampler2D']
        .flatMap((s) =>
            ['', '2', '3', '4'].map((n) =>
            {
                const t = { sampler2D: ['float', 'vec'], isampler2D: ['int', 'ivec'], usampler2D: ['uint', 'uvec'] }[s]!;
                return `${n ? t[1] + n : t[0]} PdxReadBuffer${n}( in ${s} Buf, uint Index ) { return PdxReadBuffer${n}( Buf, int( Index ) ); }`;
            })
        )
        .join('\n')
}

// HLSL intrinsics the engine's GLSL layer doesn't cover
#define rsqrt inversesqrt
#define countbits bitCount
#define firstbithigh findMSB
#define firstbitlow findLSB
#define reversebits bitfieldReverse
${
    ['float', 'vec2', 'vec3', 'vec4']
        .map(
            (t) =>
                `${t} fmod( ${t} x, ${t} y ) { return x - y * trunc( x / y ); }
${t} rcp( ${t} x ) { return 1.0 / x; }
${t} mad( ${t} a, ${t} b, ${t} c ) { return a * b + c; }`
        )
        .join('\n')
}
`;

/**
 * Viewer post step appended to pixel shaders on request: the game runs exposure, tone mapping and sRGB output in a
 * separate post pass; a preview renders straight to the canvas. Exposure times the Uncharted 2 (Hable) curve with the
 * portrait environment's parameters, then linear → sRGB.
 */
const VIEWER_POST = `
uniform float PdxViewerExposure;
uniform float PdxViewerKeepAlpha;
vec3 PdxViewerHable( vec3 x )
{
  const float A = 0.22; const float B = 0.3; const float C = 0.1; const float D = 0.2; const float E = 0.01; const float F = 0.3;
  return ( ( x * ( A * x + C * B ) + D * E ) / ( x * ( A * x + B ) + D * F ) ) - E / F;
}
vec4 PdxViewerPost( vec4 Color )
{
  vec3 Mapped = clamp( PdxViewerHable( Color.rgb * PdxViewerExposure ) / PdxViewerHable( vec3( 11.2 ) ), 0.0, 1.0 );
  vec3 Encoded = mix( Mapped * 12.92, 1.055 * pow( Mapped, vec3( 1.0 / 2.4 ) ) - 0.055, step( vec3( 0.0031308 ), Mapped ) );
  return vec4( Encoded, mix( 1.0, Color.a, PdxViewerKeepAlpha ) );
}
`;

/**
 * Patches the line of the first glslang error when it is an implicit conversion HLSL allows:
 * - float array index (`Colors[Offset * 4 + i]`) → `[int(…)]`
 * - bool in arithmetic (`( a == b ) * Impact`) → `float( a == b )`
 * - float assigned to an int/uint variable → constructor around the right-hand side
 * - vector comparisons (`abs( a - b ) <= Tolerance` is a bool vector in HLSL) → `lessThanEqual( …, vec3( … ) )`
 * - arguments of the shader's own functions (`int` literal for a `bool` parameter …) → the parameter's constructor
 * Returns null when the error is of another kind.
 */
function fixHlslisms(src: string, errors: string): string | null
{
    const m = /^ERROR: \d+:(\d+): (.*)$/m.exec(errors);

    if (!m)
        return null;

    const lineNo = Number(m[1]) - 1;
    const msg = m[2];
    const lines = src.split('\n');
    const line = lines[lineNo];

    if (line === undefined)
        return null;

    let fixed = line;
    const cmp = /no operation '(<=|>=|<|>|==|!=)' exists that takes a left-hand operand of type '([^']*)' and a right operand of type '([^']*)'/.exec(msg);
    const vector = (t: string): { n: string; base: string; } | undefined =>
    {
        const v = /([234])-component vector of (float|int|uint|bool)/.exec(t);
        return v ? { n: v[1], base: v[2] } : undefined;
    };

    if (cmp && (vector(cmp[2]) || vector(cmp[3])))
    {
        // HLSL compares vectors per component (a bool vector); GLSL has functions for that, the scalar side broadcast
        const v = (vector(cmp[2]) ?? vector(cmp[3]))!;
        const ctor = { float: 'vec', int: 'ivec', uint: 'uvec', bool: 'bvec' }[v.base] + v.n;
        const fn = { '<': 'lessThan', '<=': 'lessThanEqual', '>': 'greaterThan', '>=': 'greaterThanEqual', '==': 'equal', '!=': 'notEqual' }[cmp[1]]!;
        fixed = rewriteComparison(line, cmp[1], (a, b) => `${fn}( ${vector(cmp[2]) ? a : `${ctor}( ${a} )`}, ${vector(cmp[3]) ? b : `${ctor}( ${b} )`} )`);
    }
    else if (/'(all|any)' : no matching overloaded function/.test(msg))
    {
        // all( a == b ) of two vectors: HLSL's == is per component, GLSL's compares whole vectors
        for (const f of ['all', 'any'])
            fixed = rewriteCalls(fixed, f, (args) =>
            {
                if (args.length !== 1)
                    return undefined;

                const inner = rewriteComparison(args[0], '==', (a, b) => `equal( ${a}, ${b} )`);
                const out = inner !== args[0] ? inner : rewriteComparison(args[0], '!=', (a, b) => `notEqual( ${a}, ${b} )`);
                return out !== args[0] ? `${f}( ${out} )` : undefined;
            });
    }
    else if (/scalar integer expression required/.test(msg))
    {
        fixed = line.replace(/([\w\]])\[(?!\s*int\()([^[\]]+)\]/g, (_s, pre, idx) => (/^\s*\d+\s*$/.test(idx) ? `${pre}[${idx}]` : `${pre}[int( ${idx} )]`));
    }
    else if (/bool/.test(msg) && /wrong operand types|cannot convert/.test(msg))
    {
        fixed = line.replace(/\(\s*([^()]*?(?:==|!=|<=|>=|<|>)[^()]*?)\s*\)/g, (s, inner, off, whole: string) =>
        {
            // keep `if ( … )` conditions and existing bool() casts
            const before = whole.slice(0, off);
            return /\b(if|while|bool)\s*$/.test(before) ? s : `float( ${inner} )`;
        });
    }
    else
    {
        // assignments HLSL converts implicitly: float/uint → int, float/int → uint, scalar → vector broadcast
        const conv = /cannot convert from ' (?:temp|global|const|uniform) (?:highp |mediump |lowp )?(?:float|u?int|bool)' to ' temp (?:highp |mediump |lowp )?(u?int|float|([234])-component vector of (float|int|uint))'/.exec(msg);
        const ctor = !conv ? undefined : conv[2] ? `${conv[3] === 'float' ? '' : conv[3] === 'int' ? 'i' : 'u'}vec${conv[2]}` : conv[1];

        if (ctor)
            fixed = line.replace(/([^=!<>+\-*/]=)(?!=)\s*([^;]+);/, (_s, eq, rhs) => `${eq} ${ctor}( ${rhs} );`);
    }

    if (fixed === line && /'pow' : no matching overloaded function/.test(msg))
    {
        // pow( vector, scalar ): HLSL broadcasts the exponent — make it the base's type
        fixed = rewriteCalls(line, 'pow', (args) => (args.length === 2 ? `pow( ${args[0]}, ${args[1]} + 0.0 * ( ${args[0]} ) )` : undefined));
    }
    else if (fixed === line && /'%' :\s+wrong operand types/.test(msg))
    {
        // float modulo: HLSL's fmod x - y · trunc( x / y ), written out — the fmod overloads were pruned before this runs
        // (nothing called them yet); scalar and vector operands mix like in HLSL
        fixed = line.replace(/([\w.[\]]+|\([^()]*\))\s*%\s*([\w.[\]]+|\([^()]*\))/, (_s, a, b) => `( ${a} - ( ${b} ) * trunc( ${a} / ( ${b} ) ) )`);
    }
    else if (fixed === line && /'return' : cannot convert return value/.test(msg))
    {
        // implicit conversion of the return value: the enclosing function's return type as constructor
        for (let k = lineNo; k >= 0 && k > lineNo - 200; k--)
        {
            const head = /^\s*(?:static\s+)?(?:inline\s+)?([A-Za-z_]\w*)\s+[A-Za-z_]\w*\s*\([^;]*$/.exec(lines[k]);

            if (head && !/^(return|else|if|for|while)$/.test(head[1]))
            {
                fixed = line.replace(/\breturn\s+([^;]+);/, (_s, e) => `return ${head[1]}( ${e} );`);
                break;
            }
        }
    }
    else if (fixed === line && /'\w+' : no matching overloaded function found/.test(msg))
    {
        // a call of the shader's own function: HLSL converts arguments implicitly (int → bool, float → int, vector
        // truncation, scalar broadcast); with one definition of that many parameters, each by-value argument of a
        // built-in type gets the parameter's constructor (a no-op where the types already agree)
        const name = /'(\w+)' : no matching/.exec(msg)![1];
        const defs = signatures(src, name);
        fixed = rewriteCalls(line, name, (args) =>
        {
            const fit = defs.filter((d) => d.length === args.length);

            if (fit.length !== 1)
                return undefined;

            const out = args.map((a, i) =>
            {
                const p = fit[0][i];
                return p.byRef || p.array || !BUILTIN_TYPE.test(p.type) || a.startsWith(p.type + '(') ? a : `${p.type}( ${a} )`;
            });
            return out.some((a, i) => a !== args[i]) ? `${name}( ${out.join(', ')} )` : undefined;
        });
    }

    if (fixed === line)
        return null;

    lines[lineNo] = fixed;
    return lines.join('\n');
}

/** Scalar, vector and matrix types (HLSL and GLSL spellings) — the ones a constructor converts. */
const BUILTIN_TYPE = /^(bool|int|uint|float|half|(bool|int|uint|float|half)[1-4](x[1-4])?|[biu]?vec[2-4]|mat[2-4](x[2-4])?)$/;

/** Parameters of every definition of `name` in the source (`type name( params ) {`). */
function signatures(src: string, name: string): { type: string; byRef: boolean; array: boolean; }[][]
{
    const out: { type: string; byRef: boolean; array: boolean; }[][] = [];

    for (const m of src.matchAll(new RegExp(`\\b([A-Za-z_]\\w*)\\s+${name}\\s*\\(`, 'g')))
    {
        if (/^(return|else|case)$/.test(m[1]))
            continue;

        const open = m.index + m[0].length - 1;
        let depth = 0;
        let close = open;

        for (; close < src.length; close++)
        {
            if (src[close] === '(')
                depth++;
            else if (src[close] === ')' && --depth === 0)
                break;
        }

        // a definition, not a call or a prototype
        if (!/^\s*\{/.test(src.slice(close + 1, close + 40)))
            continue;

        const params = splitParams(src.slice(open + 1, close)).map((p) =>
        {
            const words = p.replace(/:\s*\w+\s*$/, '')
                .replace(/\[[^\]]*\]/g, ' [] ')
                .trim()
                .split(/\s+/);
            const array = words.includes('[]');
            const plain = words.filter((w) => w !== '[]' && !/^(in|const|precise|uniform|lowp|mediump|highp|nointerpolation|linear|centroid|noperspective)$/.test(w));
            return { type: plain[plain.length - 2] ?? '', byRef: words.includes('out') || words.includes('inout'), array };
        });
        out.push(params.length === 1 && !params[0].type ? [] : params);
    }

    return out;
}

/** Splits an argument or parameter list at top-level commas. */
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
 * Rewrites the first comparison `a op b` on a line whose operands can be delimited there: the operands extend over
 * everything that binds tighter than a comparison (names, calls, brackets, member access, arithmetic).
 */
function rewriteComparison(line: string, op: string, fn: (a: string, b: string) => string): string
{
    const esc = op.replace(/[<>=!]/g, (c) => '\\' + c);
    const re = new RegExp(`(?<![<>=!])${esc}(?![<>=])`, 'g');
    const stop = /[,;{}?:=<>&|^!]/;

    for (const m of line.matchAll(re))
    {
        // left operand: back to an unmatched opening bracket or a delimiter
        let depth = 0;
        let s = m.index;

        for (let k = m.index - 1; k >= 0; k--)
        {
            const c = line[k];

            if (c === ')' || c === ']')
                depth++;
            else if (c === '(' || c === '[')
            {
                if (depth === 0)
                    break;

                depth--;
            }
            else if (depth === 0 && stop.test(c))
                break;

            s = k;
        }

        // right operand: on to an unmatched closing bracket or a delimiter
        depth = 0;
        let e = m.index + op.length;

        for (let k = e; k < line.length; k++)
        {
            const c = line[k];

            if (c === '(' || c === '[')
                depth++;
            else if (c === ')' || c === ']')
            {
                if (depth === 0)
                    break;

                depth--;
            }
            else if (depth === 0 && stop.test(c))
                break;

            e = k + 1;
        }

        const left = line.slice(s, m.index);
        const kw = /^\s*(?:return|else)\b\s*/.exec(left)?.[0] ?? /^\s*/.exec(left)![0];
        const a = left.slice(kw.length).trim();
        const b = line.slice(m.index + op.length, e).trim();

        if (!a || !b || depth !== 0)
            continue;

        const trail = /\s*$/.exec(line.slice(m.index + op.length, e))![0];
        return line.slice(0, s) + kw + fn(a, b) + trail + line.slice(e);
    }

    return line;
}

/** Rewrites calls `name( a, b )` on one line (arguments split at top-level commas); undefined keeps a call as is. */
function rewriteCalls(line: string, name: string, fn: (args: string[]) => string | undefined): string
{
    let out = '';
    let i = 0;
    const re = new RegExp(`\\b${name}\\s*\\(`, 'g');

    for (let m = re.exec(line); m; m = re.exec(line))
    {
        let depth = 0;
        let j = m.index + m[0].length - 1;
        const argStart = j + 1;
        const args: string[] = [];
        let cur = argStart;

        for (; j < line.length; j++)
        {
            const c = line[j];

            if (c === '(' || c === '[')
                depth++;
            else if (c === ')' || c === ']')
            {
                if (--depth === 0)
                    break;
            }
            else if (c === ',' && depth === 1)
            {
                args.push(line.slice(cur, j).trim());
                cur = j + 1;
            }
        }

        if (j >= line.length)
            break;

        args.push(line.slice(cur, j).trim());
        const replacement = fn(args);

        if (replacement !== undefined)
        {
            out += line.slice(i, m.index) + replacement;
            i = j + 1;
            re.lastIndex = j + 1;
        }
    }

    return out + line.slice(i);
}

/**
 * C-style casts (`(int)Data._Channel`, `(float3)x`) → constructor calls. The operand is a parenthesized expression
 * or a name / number with its member accesses, indexing and call arguments.
 */
function hlslCasts(src: string): string
{
    const re = /\(\s*(int|uint|float|bool|half|u?int[234]|float[234]|bool[234]|half[234])\s*\)\s*(?=[\w(-])/g;
    let out = '';
    let last = 0;

    for (let m = re.exec(src); m; m = re.exec(src))
    {
        // not a cast when the parenthesis follows a name (a call like `foo(int)` never appears; `vec3(int)` neither)
        if (/[\w\]]\s*$/.test(src.slice(Math.max(0, m.index - 40), m.index)))
            continue;

        let i = m.index + m[0].length;
        const start = i;
        const balanced = (open: string, close: string): void =>
        {
            let d = 0;

            for (; i < src.length; i++)
            {
                if (src[i] === open)
                    d++;
                else if (src[i] === close && --d === 0)
                {
                    i++;
                    return;
                }
            }
        };

        if (src[i] === '-')
            i++;

        if (src[i] === '(')
            balanced('(', ')');
        else
        {
            const w = /^[\w.]+/.exec(src.slice(i));

            if (!w)
                continue;

            i += w[0].length;
        }

        for (;;)
        {
            if (src[i] === '[')
                balanced('[', ']');
            else if (src[i] === '(')
                balanced('(', ')');
            else if (src[i] === '.' && /\w/.test(src[i + 1] ?? ''))
            {
                i++;
                i += /^\w+/.exec(src.slice(i))![0].length;
            }
            else
                break;
        }

        out += src.slice(last, m.index) + `${m[1]}( ${src.slice(start, i)} )`;
        last = i;
        re.lastIndex = i;
    }

    return out + src.slice(last);
}

/**
 * HLSL flow control attributes (`[unroll]`, `[loop]`, `[branch]` …) are compiler hints GLSL has no syntax for. Mods
 * normally hide them behind macros that are empty on PDX_OPENGL; AGOT's dragon decals write one literally.
 */
function hlslAttributes(src: string): string
{
    return src.replace(/(^|[\s;{})])\[\s*(?:unroll|loop|branch|flatten|fastopt|allow_uav_condition|call|forcecase)\s*(?:\(\s*\w*\s*\))?\s*\](?=\s*(?:for|while|do|if|switch)\b)/g, '$1');
}

/**
 * HLSL converts float to int implicitly (`int Index = UV.x * 255.0;`), GLSL doesn't: integer declarations get an
 * explicit constructor around their initializer (a no-op when it already is an integer).
 */
function hlslImplicitInts(src: string): string
{
    return src.replace(/\b(u?int[234]?)(\s+)([A-Za-z_]\w*)(\s*)=(\s*)([^;,{}]+?)(\s*);/g, (_m, type, s1, name, s2, s3, expr, s4) => `${type}${s1}${name}${s2}=${s3}${type}( ${expr} )${s4};`);
}

/**
 * Whether prepared vertex code reads bone streams (`Input.BoneIndex[0]`) that no struct declares: the engine
 * declares them only for skinned meshes (`@ifdef PDX_MESH_SKINNED`), and its own skinning code sits under that
 * condition too — whatever still reads them without it needs a skinned mesh.
 */
function readsBones(src: string): boolean
{
    return ['BoneIndex', 'BoneWeight'].some((f) => new RegExp(`\\.\\s*${f}\\b`).test(src) && !new RegExp(`\\b\\w+\\s+${f}\\s*(\\[[^\\]]*\\])?\\s*;`).test(src));
}

/** BufferTexture `type = float4` → the engine's GLSL buffer type name (PdxBufferFloat4 = samplerBuffer). */
function bufferType(t: string): string
{
    const m = /^(float|int|uint)([234])?$/.exec(t.trim());

    if (!m)
        return 'PdxBufferFloat';

    return `PdxBuffer${m[1] === 'float' ? 'Float' : m[1] === 'int' ? 'Int' : 'Uint'}${m[2] ?? ''}`;
}

function samplerType(s: FxSampler): string | undefined
{
    if (s.kind !== 'TextureSampler')
        return undefined; // buffer textures have no WebGL2 equivalent

    const type = (s.props.Type ?? s.props.type ?? '').toLowerCase();

    if (type === 'cube')
        return 'samplerCube';

    if (type === '3d')
        return 'sampler3D';

    if (type === '2darray')
        return 'sampler2DArray';

    if ((s.props.SamplerType ?? '').toLowerCase() === 'compare')
        return 'sampler2DShadow';

    return 'sampler2D';
}
