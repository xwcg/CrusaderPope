/**
 * The game's own shaders for WebGL2; see docs/shaders.md.
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

import { tr } from '../../shared/i18n.ts';
export interface CrossShader
{
    compile(src: string, input: { format: number; stage: number; es: boolean; glslVersion: number; }, output: { format: number; es: boolean; glslVersion: number; }): string;
    ShaderFormat: Record<string, number>;
    ShaderStage: Record<string, number>;
}

let crossShader: Promise<CrossShader> | null = null;

/**
 * The cross-shader Emscripten module, made from its factory with the .wasm bytes at hand (`wasmBinary`): the package's
 * own entry calls the factory bare, which first tries to stream-compile the file with fetch, failing in Node, logged
 * once per shader thread ("wasm streaming compile failed … falling back to ArrayBuffer instantiation").
 */
export function loadCrossShader(): Promise<CrossShader>
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
                m.onAbort = (e) => reject(e instanceof Error ? e : new Error(tr('cross-shader: {String}', { String: String(e) })));
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
     * The game's files with the loaded mods. FX files live in the engine layers: `game/gfx/FX` over `jomini/gfx/FX`
     * over `clausewitz/gfx/FX` (the game overrides some jomini headers), and a mod's `gfx/FX/…` file replaces them all.
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

    text(rel: string): string | undefined
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
    ordered(rel: string, seen = new Set<string>(), out: FxFile[] = []): FxFile[]
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
     * first), then the game's FX roots in their order: game, jomini, clausewitz.
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

    /** Every Effect a .shader file can use: its own and those of the files it includes (sweeps over all effects). */
    effectsWithIncludes(rel: string): string[]
    {
        return [...new Set(this.ordered(rel).flatMap((f) => f.effects.map((e) => e.name)))];
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
            throw new Error(tr('Effect {effect} not found in {file}', { effect: req.effect, file: req.file }));

        const { effect, files } = found;
        const defines = [...new Set([...effect.defines.filter((d) => !(req.remove ?? []).includes(d)), ...(req.defines ?? [])])];
        const vsMain = this.main(files, effect.vs, 'vs');
        const psMain = this.main(files, effect.ps, 'ps');

        if (!vsMain || !psMain)
            throw new Error(tr('Effect {name}: shader {value} not found', { name: effect.name, value: !vsMain ? effect.vs : effect.ps }));

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
            try
            {
                return glslToEs(xs, source, stage);
            }
            catch (err)
            {
                let msg = String((err as Error)?.message ?? err);

                // a vertex shader reading bone data itself (AGOT's particle cards) is compiled skinned, unless the request
                // removes PDX_MESH_SKINNED
                if (/'Bone(Index|Weight)' : no such field/.test(msg))
                    msg += '\n(needs GPU skinning: the request removes PDX_MESH_SKINNED)';

                const e = new Error(stage === 'vs' ? tr('{name} vertex shader: {msg}', { name: effect.name, msg }) : tr('{name} pixel shader: {msg}', { name: effect.name, msg }));
                (e as Error & { source?: string; }).source = (err as Error & { source?: string; }).source ?? source;
                throw e;
            }
        };
        const vertex = toEs(vs.source, 'vs');
        const fragment = toEs(ps.source, 'ps');
        // things GLSL ES 3.00 lacks would only fail at link time in the browser: fail here so the viewer falls back
        const unsupported = /\b[iu]?samplerBuffer\b|\btextureQueryLod\b|\b[iu]?sampler2DMS\b|\btextureSamples\b/.exec(vertex + fragment);

        if (unsupported)
            throw new Error(tr('{name}: uses {unsupported}, which WebGL2 lacks', { name: effect.name, unsupported: unsupported[0] }));

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

    main(files: FxFile[], name: string | undefined, stage: Stage): FxMain | undefined
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

        // array sizes the engine defines at compile time (PDX_MAX_DETAIL_TEXTURES …): small defaults, also inside size
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
        // same data: its members become aliases of the first declaration's members at the same place
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
        // a name built by token pasting (`AGOT_TerrainVariantIndexTexture##INDEX` in a macro) can't be traced: a sampler a
        // pasted fragment could build counts as used (prune.ts does the same for constants), if the code that pastes
        // survives the pruning below
        const pastes = pasteBuilds(body);
        const pastedOnly = new Set<string>();

        for (const f of files)
        {
            for (const s of f.samplers)
            {
                if ((s.stage !== 'both' && s.stage !== stage) || (s.main && s.main !== main.name) || seenSampler.has(s.name))
                    continue;

                // (a define can name it: `Defines = { "DIFFUSE_TEXTURE DiffuseTexture" }`, the code says DIFFUSE_TEXTURE)
                const named = new RegExp(`\\b${s.name}\\b`).test(body) || defines.some((d) => new RegExp(`^\\S+\\s+.*\\b${s.name}\\b`).test(d));

                if (!named && !pastes(s.name))
                    continue;

                if (!named)
                    pastedOnly.add(s.name);

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

            out.push(withMain(main.output + ' PdxMain( ' + main.input + ' Input )'));
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
            let signature = 'void' + ' PdxMain( ' + main.input + ' Input )';

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
        let source = hlslPasses(pruneUnreachable(out.join('\n')));

        // samplers only a pasted name could have used stay when the pasting code is still there
        if (pastedOnly.size)
        {
            const live = pasteBuilds(source.replace(/^[ \t]*uniform\b.*$/gm, ''));

            for (const name of pastedOnly)
            {
                if (live(name))
                    continue;

                source = source.replace(new RegExp(`^[ \\t]*uniform\\b[^\\n;]*\\b${name}\\s*;[^\\n]*\\n?`, 'm'), '');
                const at = samplers.findIndex((x) => x.name === name);

                if (at >= 0)
                    samplers.splice(at, 1);
            }
        }

        return { source, attributes, samplers, aliases };
    }
}

/** Whether a name could be built by a token pasting (`Prefix##N`, `##Suffix`) in a text: the pasted fragments' heads and tails. */
function pasteBuilds(text: string): (name: string) => boolean
{
    const heads = new Set<string>();
    const tails = new Set<string>();

    for (const m of text.matchAll(/(\w*)\s*##\s*(\w*)/g))
    {
        if (m[1].length >= 3)
            heads.add(m[1]);

        if (m[2].length >= 3)
            tails.add(m[2]);
    }

    return (name) => [...heads].some((h) => name.startsWith(h)) || [...tails].some((t) => name.endsWith(t));
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

// the engine's PdxTex2DSize declares a variable of its own (\`ivec2 _size\`): used twice in a scope it is a redefinition
// (Elder Kings 2's glass shaders ask two textures); the size is assigned directly instead (ivec2 → the target's type)
#undef PdxTex2DSize
#define PdxTex2DSize(samp,size) (size) = textureSize((samp), 0)

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
 * One stage's desktop GLSL 4.50 source → GLSL ES 3.00 (glslang, then SPIRV-Cross). HLSL-only implicit conversions
 * glslang points at get patched line by line (`fixHlslisms`), then it compiles again. A failure throws glslang's
 * output as the message, with the last patched source on `source`; `patched` sees each patched version.
 */
export function glslToEs(xs: CrossShader, source: string, stage: Stage, patched?: (src: string) => void): string
{
    // the last result is kept: a patch found by compiling candidates (`fixByCompiling`) is the last one compiled
    let lastSource = '';
    let lastOut = '';
    const run = (src: string): string =>
    {
        if (src !== lastSource || !lastOut)
        {
            lastOut = xs.compile(src, { format: xs.ShaderFormat.GLSL, stage: stage === 'vs' ? xs.ShaderStage.Vertex : xs.ShaderStage.Fragment, es: false, glslVersion: 450 }, { format: xs.ShaderFormat.GLSL, es: true, glslVersion: 300 });
            lastSource = src;
        }

        return lastOut;
    };
    let src = source;

    for (let attempt = 0;; attempt++)
    {
        const out = run(src);

        // glslang errors come back as the output text
        if (!/^ERROR:/m.test(out))
            return out;

        const fixed = attempt < 40 ? fixHlslisms(src, out, run) : null;

        if (!fixed)
        {
            const e = new Error(out.trim());
            (e as Error & { source?: string; }).source = src;
            throw e;
        }

        src = fixed;
        patched?.(src);
    }
}

/**
 * Patches the line of the first glslang error when it is an implicit conversion HLSL allows:
 * - float array index (`Colors[Offset * 4 + i]`) → `[int(…)]`
 * - bool in arithmetic (`( a == b ) * Impact`) → `float( a == b )`
 * - float assigned to an int/uint variable → constructor around the right-hand side
 * - vector comparisons (`abs( a - b ) <= Tolerance` is a bool vector in HLSL) → `lessThanEqual( …, vec3( … ) )`
 * - arguments of the shader's own functions (`int` literal for a `bool` parameter …) → the parameter's constructor
 * - vectors of different sizes (assignments, operands, intrinsic arguments: `fixByCompiling`)
 * `compileAgain` (the compile step itself) lets the last kind try candidate lines.
 * Returns null when the error is of another kind.
 */
export function fixHlslisms(src: string, errors: string, compileAgain?: (src: string) => string): string | null
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

    // an int or float where a condition wants a bool (`!Axis.x`, `Count && Flag`, `if ( Mask )`): the places are found by compiling
    const logic = compileAgain && /^'(?:&&|\|\||!)' :|^'' : boolean expression expected/.test(msg) ? fixByCompiling(lines, lineNo, msg, compileAgain) : undefined;

    if (logic !== undefined)
        fixed = logic;
    else if (cmp && (vector(cmp[2]) || vector(cmp[3])))
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

                const inner = rewriteComparison(args[0], '==', (a, b) => 'equal( ' + a + ', ' + b + ' )');
                const out = inner !== args[0] ? inner : rewriteComparison(args[0], '!=', (a, b) => 'notEqual( ' + a + ', ' + b + ' )');
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
            // keep `if ( … )` conditions, existing bool() casts and what is a bool on purpose (`!( … )`, the condition of a
            // ?:, an operand of && / ||); a group with a ?: inside is no comparison (a vector may be its value, which
            // float() would cut to the first component)
            const before = whole.slice(0, off);
            const after = whole.slice(off + s.length);
            return /\b(?:if|while|bool)\s*$|!\s*$/.test(before) || /^\s*(?:\?|&&|\|\|)/.test(after) || /(?:&&|\|\|)$/.test(before.trimEnd()) || inner.includes('?') ? s : `float( ${inner} )`;
        });
    }
    else
    {
        // assignments HLSL converts implicitly: float/uint → int, float/int → uint, scalar → vector broadcast, a vector
        // cut to a smaller one. Which assignment of the line is meant is found by compiling the candidates; without
        // that, the first one is taken
        const verified = compileAgain && /cannot convert from/.test(msg) ? fixByCompiling(lines, lineNo, msg, compileAgain) : undefined;
        const conv = /cannot convert from ' (?:temp|global|const|uniform) (?:highp |mediump |lowp )?(?:float|u?int|bool)' to ' temp (?:highp |mediump |lowp )?(u?int|float|([234])-component vector of (float|int|uint))'/.exec(msg);
        const ctor = !conv ? undefined : conv[2] ? `${conv[3] === 'float' ? '' : conv[3] === 'int' ? 'i' : 'u'}vec${conv[2]}` : conv[1];

        if (verified)
            fixed = verified;
        else if (ctor)
            fixed = line.replace(/([^=!<>+\-*/]=)(?!=)\s*([^;]+);/, (_s, eq, rhs) => `${eq} ${ctor}( ${rhs} );`);
    }

    if (fixed === line && /'pow' : no matching overloaded function/.test(msg))
    {
        // pow( vector, scalar ): HLSL broadcasts the exponent: make it the base's type
        fixed = rewriteCalls(line, 'pow', (args) => (args.length === 2 ? 'pow( ' + args[0] + ', ' + args[1] + ' + 0.0 * ( ' + args[0] + ' ) )' : undefined));
    }
    else if (fixed === line && /'%' :\s+wrong operand types/.test(msg))
    {
        // float modulo: HLSL's fmod x - y · trunc( x / y ), written out (the fmod overloads were pruned before this runs)
        // (nothing called them yet); scalar and vector operands mix like in HLSL
        for (let k = line.indexOf('%'); k >= 0; k = line.indexOf('%', k + 1))
        {
            let a = line[k + 1] === '=' ? -1 : primaryBefore(line, k);

            // `x * y % z` is `( x * y ) % z`: the same precedence, left to right
            for (let m = a - 1; a > 0; m = a - 1)
            {
                while (m >= 0 && line[m] === ' ')
                    m--;

                // a unary sign on the factor belongs to it: `a * -b % c` is `( a * -b ) % c`
                if (m > 0 && (line[m] === '-' || line[m] === '+'))
                {
                    let p = m - 1;

                    while (p >= 0 && line[p] === ' ')
                        p--;

                    if (p > 0 && (line[p] === '*' || line[p] === '/') && !/[*/=]/.test(line[p - 1]))
                    {
                        a = m;
                        m = p;
                    }
                }

                const s = m > 0 && (line[m] === '*' || line[m] === '/') && !/[*/=]/.test(line[m - 1]) ? primaryBefore(line, m) : -1;

                if (s < 0)
                    break;

                a = s;
            }

            const b = a < 0 ? undefined : primaryAfter(line, k + 1);

            if (b)
            {
                const l = line.slice(a, k).trim();
                const r = line.slice(k + 1, b.end).trim();
                fixed = `${line.slice(0, a)}( ${l} - ( ${r} ) * trunc( ${l} / ( ${r} ) ) )${line.slice(b.end)}`;
                break;
            }
        }
    }
    else if (fixed === line && /'return' : (?:cannot convert return value|type does not match, or is not convertible to, the function's return type)/.test(msg))
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

    if (fixed === line && compileAgain)
        fixed = fixByCompiling(lines, lineNo, msg, compileAgain) ?? line;

    if (fixed === line)
        return null;

    lines[lineNo] = fixed;
    return lines.join('\n');
}

/** The first error of glslang's output: its line (1-based) and message. */
function firstError(out: string): { line: number; msg: string; } | undefined
{
    const m = /^ERROR: \d+:(\d+): (.*)$/m.exec(out);
    return m ? { line: Number(m[1]), msg: m[2] } : undefined;
}

/** A type as glslang words it (` uniform 4-component vector of float`, ` temp int`) → size and base type. */
export function glslangType(t: string): { n: number; base: string; } | undefined
{
    // (a matrix, `4X4 matrix of float`, is no scalar: no size conversion applies)
    if (/\bmatrix of\b/.test(t))
        return undefined;

    const m = /(?:(\d)-component vector of )?\b(float|int|uint|bool)\s*$/.exec(t);
    return m ? { n: m[1] ? Number(m[1]) : 1, base: m[2] } : undefined;
}

/** `vec3` / `ivec2` / `float` for a size and base type. */
function ctorOf(n: number, base: string): string
{
    return n === 1 ? base : `${{ float: 'vec', int: 'ivec', uint: 'uvec', bool: 'bvec' }[base]}${n}`;
}

/** Intrinsics that work component by component: HLSL brings all their vector arguments to the smallest size. */
const COMPONENTWISE: Record<string, string[]> = {
    min: ['min'],
    max: ['max'],
    clamp: ['clamp'],
    mix: ['mix', 'lerp'],
    step: ['step'],
    smoothstep: ['smoothstep'],
    pow: ['pow'],
    atan: ['atan', 'atan2'],
    distance: ['distance'],
    dot: ['dot'],
    cross: ['cross'],
    reflect: ['reflect'],
    fmod: ['fmod'],
    mad: ['mad']
};

/** Sampling calls (and the engine's macros for them) whose coordinate is the second argument. */
const TEXTURE_CALLS: Record<string, string[]> = {
    texture: ['texture', 'PdxTex2D', 'PdxTex2DBias', 'PdxTexCube', 'PdxTexCubeBias'],
    textureLod: ['textureLod', 'PdxTex2DLod', 'PdxTexCubeLod'],
    textureGrad: ['textureGrad', 'PdxTex2DGrad']
};

/**
 * HLSL brings vectors of different sizes to the smaller one (a vector assigned to a smaller type is cut off after the
 * components that fit, operands and intrinsic arguments of different sizes are cut to the smallest, a scalar is
 * broadcast) where GLSL refuses. glslang's message says which of the cases it is, but not which of several
 * occurrences on the line, and the types of the expressions are not known here: the candidate lines are compiled
 * again (`compileAgain`) and the first for which the line has no error any more wins. A line with two such places is
 * patched in two steps: a candidate also wins when the line's error has become another of these kinds.
 * - `vec3 c = Color4;`, `Color.rgb *= Tint4;`, `a.rg = b3;` → the right-hand side gets the target's constructor
 * - `Color4 * Tint3`, `a3 + b4`, `c ? a4 : b3` → the operand of the larger vector gets the smaller one's constructor
 * - `lerp( Color4, Tint3, T )`, `max( a4, b3 )`, `distance( s, v3 )` → every argument gets the constructor of the
 *   largest size all vectors reach (4, 3, 2 tried in turn)
 * - `PdxTex2D( Sampler, Uv3 )` → the coordinate gets the constructor of the sampler's size (2, 3, 4 tried in turn)
 * Returns the patched line, or undefined when the message is of another kind or no candidate helps.
 */
function fixByCompiling(lines: string[], lineNo: number, msg: string, compileAgain: (src: string) => string): string | undefined
{
    const candidates = conversionCandidates(msg);

    if (!candidates)
        return undefined;

    // a statement written over several lines: glslang reports a declaration at its first line and a call at its last.
    // The candidates are made from the whole statement, joined onto the reported line (the others are emptied, so line
    // numbers stay); an error anywhere inside the statement is still its error
    const open = (k: number): boolean => !!lines[k].trim() && !/[;{}]\s*$/.test(lines[k]) && !/^\s*#/.test(lines[k]);
    let first = lineNo;
    let last = lineNo;

    while (first > 0 && lineNo - first < 20 && open(first - 1))
        first--;

    while (last < lines.length - 1 && last - lineNo < 20 && open(last))
        last++;

    const line = first < last ? lines.slice(first, last + 1).join(' ') : lines[lineNo];
    let changed: string | undefined;
    const settle = (cand: string): string =>
    {
        lines.fill('', first, last + 1);
        return cand;
    };

    for (const cand of candidates(line))
    {
        if (cand === line)
            continue;

        const trial = lines.slice();
        trial.fill('', first, last + 1);
        trial[lineNo] = cand;
        const e = firstError(compileAgain(trial.join('\n')));

        // cleared the statement's error
        if (!e || e.line < first + 1 || e.line > last + 1)
            return settle(cand);

        // or turned it into another of these kinds (two places on one line are patched in two rounds) - the second best:
        // a candidate that wraps the wrong place also makes such an error, so a clearing candidate is looked for first
        if (!changed && e.msg !== msg && conversionCandidates(e.msg))
            changed = cand;
    }

    return changed === undefined ? undefined : settle(changed);
}

/** For a glslang message about vectors of different sizes, the function making the candidate lines; else undefined. */
function conversionCandidates(msg: string): ((line: string) => Iterable<string>) | undefined
{
    const conv = /^'(?:=|assign)' :\s+cannot convert from '([^']*)' to '([^']*)'/.exec(msg);
    const bin = /^'([-+*/:])' :\s+wrong operand types: no operation '[^']*' exists that takes a left-hand operand of type '([^']*)' and a right operand of type '([^']*)'/.exec(msg);
    const call = /^'(\w+)' : no matching overloaded function found/.exec(msg);

    if (conv)
    {
        const from = glslangType(conv[1]);
        const to = glslangType(conv[2]);

        // a vector cut to the target's size, or a scalar broadcast / converted (a larger target takes only a scalar)
        if (!from || !to || (from.n > 1 && from.n < to.n))
            return undefined;

        const ctor = ctorOf(to.n, to.base);
        return function* (line)
        {
            for (const m of line.matchAll(/(?<![=!<>+\-*/%&|^])[+\-*/%&|^]?=(?!=)/g))
            {
                const at = m.index + m[0].length;
                const end = expressionEnd(line, at);

                if (line.slice(at, end).trim())
                    yield `${line.slice(0, at)} ${ctor}( ${line.slice(at, end).trim()} )${line.slice(end)}`;
            }
        };
    }

    if (bin)
    {
        const l = glslangType(bin[2]);
        const r = glslangType(bin[3]);

        if (!l || !r || l.n === r.n)
            return undefined;

        const op = bin[1];
        // (a scalar branch of ?: is broadcast to the other branch's size; the other operators take a scalar themselves)
        const scalar = Math.min(l.n, r.n) === 1;

        if (scalar && op !== ':')
            return undefined;

        const left = scalar ? l.n === 1 : l.n > r.n;
        const ctor = scalar ? ctorOf(Math.max(l.n, r.n), (l.n > r.n ? l : r).base) : ctorOf(Math.min(l.n, r.n), (left ? l : r).base);
        return function* (line)
        {
            for (let i = line.indexOf(op); i >= 0; i = line.indexOf(op, i + 1))
            {
                if (op === ':')
                {
                    // the branches of a conditional expression: the larger one is cut to the smaller one's size
                    const q = conditionStart(line, i);

                    if (q >= 0)
                    {
                        const end = expressionEnd(line, i + 1);
                        yield left ?
                            `${line.slice(0, q + 1)} ${ctor}( ${line.slice(q + 1, i).trim()} ) ${line.slice(i)}` :
                            `${line.slice(0, i + 1)} ${ctor}( ${line.slice(i + 1, end).trim()} )${line.slice(end)}`;
                    }

                    continue;
                }

                // compound assignments, ++ / --, exponents (1e-3)
                if (line[i + 1] === '='|| line[i + 1] === op || line[i - 1] === op || /\d[eE]$/.test(line.slice(0, i)))
                    continue;

                if (left)
                {
                    const s = primaryBefore(line, i);

                    if (s >= 0)
                        yield `${line.slice(0, s)}${ctor}( ${line.slice(s, i).trim()} ) ${line.slice(i)}`;
                }
                else
                {
                    const p = primaryAfter(line, i + 1);

                    if (p)
                        yield `${line.slice(0, p.start)}${ctor}( ${line.slice(p.start, p.end)} )${line.slice(p.end)}`;
                }
            }
        };
    }

    if (call && COMPONENTWISE[call[1]])
    {
        return function* (line)
        {
            for (const name of COMPONENTWISE[call[1]])
            {
                let total = 0;
                rewriteCalls(line, name, () => (total++, undefined));

                for (let k = 0; k < total; k++)
                    for (const n of [4, 3, 2])
                    {
                        let seen = 0;
                        yield rewriteCalls(line, name, (args) => (seen++ === k ? `${name}( ${args.map((a) => `${ctorOf(n, 'float')}( ${a} )`).join(', ')} )` : undefined));
                    }
            }
        };
    }

    if (call && call[1] === 'mul')
    {
        // the engine has mul() for matching sizes only; HLSL cuts a 4x4 matrix to the size of the vector it multiplies
        // (Elder Kings 2: `mul( InvViewMatrix, WorldSpacePos )` with a float3) or the vector to the matrix's
        return function* (line)
        {
            let total = 0;
            rewriteCalls(line, 'mul', () => (total++, undefined));

            for (let k = 0; k < total; k++)
                for (const n of [3, 2])
                    for (const kind of ['mat', 'vec'])
                        for (const which of [0, 1])
                        {
                            let seen = 0;
                            yield rewriteCalls(line, 'mul', (args) => (seen++ === k && args.length === 2 ? `mul( ${args.map((a, i) => (i === which ? `${kind}${n}( ${a} )` : a)).join(', ')} )` : undefined));
                        }
        };
    }

    if (call && TEXTURE_CALLS[call[1]])
    {
        // a sampling call with more coordinates than the sampler has: HLSL cuts the coordinate to the sampler's size
        return function* (line)
        {
            for (const name of TEXTURE_CALLS[call[1]])
            {
                let total = 0;
                rewriteCalls(line, name, () => (total++, undefined));

                for (let k = 0; k < total; k++)
                    for (const n of [2, 3, 4])
                    {
                        let seen = 0;
                        yield rewriteCalls(line, name, (args) => (seen++ === k && args.length > 1 ? `${name}( ${args.map((a, i) => (i === 1 ? `${ctorOf(n, 'float')}( ${a} )` : a)).join(', ')} )` : undefined));
                    }
            }
        };
    }

    // HLSL takes an int or float where a condition wants a bool: non-zero is true
    const logical = /^'(&&|\|\|)' :\s+wrong operand types: no operation '[^']*' exists that takes a left-hand operand of type '([^']*)' and a right operand of type '([^']*)'/.exec(msg);

    if (/^'!' :\s+wrong operand type no operation '!'/.test(msg))
    {
        return function* (line)
        {
            for (let i = line.indexOf('!'); i >= 0; i = line.indexOf('!', i + 1))
            {
                const p = line[i + 1] === '=' ? undefined : primaryAfter(line, i + 1);

                if (p)
                    yield `${line.slice(0, p.start)}bool( ${line.slice(p.start, p.end)} )${line.slice(p.end)}`;
            }
        };
    }

    if (logical)
    {
        const wrapLeft = glslangType(logical[2])?.base !== 'bool';
        const wrapRight = glslangType(logical[3])?.base !== 'bool';
        const op = logical[1];
        return function* (line)
        {
            for (let i = line.indexOf(op); i >= 0; i = line.indexOf(op, i + 2))
            {
                const a = operandStart(line, i);
                const e = operandEnd(line, i + 2);
                const left = wrapLeft ? `${line.slice(0, a)}bool( ${line.slice(a, i).trim()} ) ` : line.slice(0, i);
                const right = wrapRight ? ` bool( ${line.slice(i + 2, e).trim()} )${line.slice(e)}` : line.slice(i + 2);
                yield left + op + right;
            }
        };
    }

    if (/^'' : boolean expression expected/.test(msg))
    {
        return function* (line)
        {
            for (const m of line.matchAll(/\b(?:if|while)\s*\(/g))
            {
                const open = m.index + m[0].length - 1;
                const close = closingBracket(line, open);

                if (close > 0)
                    yield `${line.slice(0, open + 1)} bool( ${line.slice(open + 1, close).trim()} ) ${line.slice(close)}`;
            }

            for (let q = line.indexOf('?'); q >= 0; q = line.indexOf('?', q + 1))
            {
                const s = operandStart(line, q);
                yield `${line.slice(0, s)}bool( ${line.slice(s, q).trim()} ) ${line.slice(q)}`;
            }
        };
    }

    return undefined;
}

/**
 * Start of the operand that ends before the operator at `at`: back to the delimiter around it (an opening
 * parenthesis, comma, `?`, `:`, assignment, `&&`, `||`). The operand of a logical operator or a condition can hold
 * arithmetic, which is why this is no `primaryBefore`.
 */
function operandStart(s: string, at: number): number
{
    let depth = 0;
    let start = at;

    for (let k = at - 1; k >= 0; k--)
    {
        const c = s[k];

        if (c === ')' || c === ']')
            depth++;
        else if (c === '(' || c === '[')
        {
            if (depth === 0)
                break;

            depth--;
        }
        else if (depth === 0 && (',;{?:'.includes(c) || (c === '&' && s[k - 1] === '&') || (c === '|' && s[k - 1] === '|') || (c === '=' && !'=!<>'.includes(s[k - 1] ?? ' ') && s[k + 1] !== '=')))
            break;

        start = k;
    }

    return start;
}

/** End of the operand that starts at `from`: on to the delimiter after it (see `operandStart`). */
function operandEnd(s: string, from: number): number
{
    let depth = 0;
    let end = from;

    for (let k = from; k < s.length; k++)
    {
        const c = s[k];

        if (c === '(' || c === '[')
            depth++;
        else if (c === ')' || c === ']')
        {
            if (depth === 0)
                break;

            depth--;
        }
        else if (depth === 0 && (',;}?:'.includes(c) || (c === '&' && s[k + 1] === '&') || (c === '|' && s[k + 1] === '|')))
            break;

        end = k + 1;
    }

    return end;
}

/** The `?` belonging to the `:` at `colon` (same nesting level), or -1. */
function conditionStart(s: string, colon: number): number
{
    let depth = 0;

    for (let i = colon - 1; i >= 0; i--)
    {
        const c = s[i];

        if (c === ')' || c === ']')
            depth++;
        else if (c === '(' || c === '[')
        {
            if (depth === 0)
                return -1;

            depth--;
        }
        else if (c === ';' || c === '{')
            return -1;
        else if (depth === 0 && c === ':')
            return -1;
        else if (depth === 0 && c === '?')
            return i;
    }

    return -1;
}

/** End of the expression starting at `from`: the `;` or `,` after it, or the bracket closing around it. */
function expressionEnd(s: string, from: number): number
{
    let depth = 0;

    for (let i = from; i < s.length; i++)
    {
        const c = s[i];

        if (c === '(' || c === '[' || c === '{')
            depth++;
        else if (c === ')' || c === ']' || c === '}')
        {
            if (depth === 0)
                return i;

            depth--;
        }
        else if ((c === ';' || c === ',') && depth === 0)
            return i;
    }

    return s.length;
}

/** The bracket opening the one that closes at `close` (or -1). */
function openingBracket(s: string, close: number): number
{
    let depth = 0;

    for (let i = close; i >= 0; i--)
    {
        if (s[i] === ')' || s[i] === ']')
            depth++;
        else if ((s[i] === '(' || s[i] === '[') && --depth === 0)
            return i;
    }

    return -1;
}

/** The bracket closing the one that opens at `open` (or -1). */
function closingBracket(s: string, open: number): number
{
    let depth = 0;

    for (let i = open; i < s.length; i++)
    {
        if (s[i] === '(' || s[i] === '[')
            depth++;
        else if ((s[i] === ')' || s[i] === ']') && --depth === 0)
            return i;
    }

    return -1;
}

/**
 * Start of the operand (a name or number with its calls, indexing and member accesses, or a parenthesized
 * expression) that ends before `at`; -1 when there is none (a unary sign, a keyword).
 */
function primaryBefore(s: string, at: number): number
{
    let k = at - 1;
    let start = -1;

    for (;;)
    {
        while (k >= 0 && s[k] === ' ')
            k--;

        if (k < 0)
            return -1;

        if (s[k] === ')' || s[k] === ']')
        {
            const open = openingBracket(s, k);

            if (open < 0)
                return -1;

            start = open;
            k = open - 1;

            // a call or index continues to the left in a name (or another call / index)
            let j = k;

            while (j >= 0 && s[j] === ' ')
                j--;

            if (j >= 0 && (/\w/.test(s[j]) || s[j] === ')' || s[j] === ']'))
                continue;

            return start;
        }

        if (!/\w/.test(s[k]))
            return -1;

        let j = k;

        while (j >= 0 && /\w/.test(s[j]))
            j--;

        const word = s.slice(j + 1, k + 1);

        if (/^(return|else|case|in|out|inout|const|uniform)$/.test(word))
            return -1;

        start = j + 1;
        let m = j;

        while (m >= 0 && s[m] === ' ')
            m--;

        // `a.b`, `f( x ).y`, `2.0`, and `.5`, whose dot belongs to the number
        if (m >= 0 && s[m] === '.')
        {
            k = m - 1;

            while (k >= 0 && s[k] === ' ')
                k--;

            if (k >= 0 && (/\w/.test(s[k]) || s[k] === ')' || s[k] === ']'))
                continue;

            return m;
        }

        return start;
    }
}

/** The operand starting at or after `at` (unary signs skipped): its span, or undefined. */
function primaryAfter(s: string, at: number): { start: number; end: number; } | undefined
{
    let i = at;

    while (i < s.length && /[\s\-+!~]/.test(s[i]))
        i++;

    const start = i;

    if (s[i] === '(')
    {
        const close = closingBracket(s, i);

        if (close < 0)
            return undefined;

        i = close + 1;
    }
    else
    {
        const w = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?[fFuU]?|^\w+/.exec(s.slice(i));

        if (!w)
            return undefined;

        i += w[0].length;
    }

    for (;;)
    {
        if (s[i] === '(' || s[i] === '[')
        {
            const close = closingBracket(s, i);

            if (close < 0)
                return undefined;

            i = close + 1;
        }
        else if (s[i] === '.' && /[A-Za-z_]/.test(s[i + 1] ?? ''))
            i += 1 + /^\w+/.exec(s.slice(i + 1))![0].length;
        else
            break;
    }

    return { start, end: i };
}

/** Scalar, vector and matrix types (HLSL and GLSL spellings), the ones a constructor converts. */
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
export function rewriteComparison(line: string, op: string, fn: (a: string, b: string) => string): string
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
export function rewriteCalls(line: string, name: string, fn: (args: string[]) => string | undefined): string
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
export function hlslCasts(src: string): string
{
    const re = /\(\s*(int|uint|float|bool|half|u?int[234]|float[234]|bool[234]|half[234])\s*\)\s*(?=[\w(!~-])/g;
    let out = '';
    let last = 0;

    for (let m = re.exec(src); m; m = re.exec(src))
    {
        // not a cast when the parenthesis follows a name (a call like `foo(int)` never appears; `vec3(int)` neither)
        const prev = /([\w\]]+)\s*$/.exec(src.slice(Math.max(0, m.index - 40), m.index));

        if (prev && !/^(?:return|else|case|do)$/.test(prev[1]))
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

        // (unary signs: `(int)-x`, `(float)!b`, `(uint)~m`)
        while (src[i] === '-' || src[i] === '!' || src[i] === '~')
            i++;

        if (src[i] === '(')
            balanced('(', ')');
        else
        {
            const w = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?[fFuU]?(?![\w.])|^[\w.]+/.exec(src.slice(i));

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
 * A global array made by casting another array (`static const float2 Factors[N] = (float2[N])Packed;`, Packed being a
 * `float4 Packed[N / 2]` of a constant buffer: AGOT's pdxterrain.fxh). HLSL casts the components in order; GLSL has no
 * such cast, and the array is no constant. The declaration becomes an accessor (`Factors_ArrayCast( i )`) that picks
 * the components of the source array, and `Factors[ i ]` calls it. Left alone when the source array is not declared
 * here, the element types differ, or the array is used in another way than indexed.
 */
export function hlslArrayCasts(src: string): string
{
    // (types as HLSL or the engine's GLSL names them: float4, vec4)
    const type = (t: string): { base: string; n: number; } | undefined =>
    {
        const v = /^(float|int|uint|half|bool)([1-4])?$/.exec(t) ?? /^([biu]?)vec([2-4])$/.exec(t);
        return v ? { base: ({ '': 'float', b: 'bool', i: 'int', u: 'uint' } as Record<string, string>)[v[1]] ?? v[1], n: Number(v[2] ?? 1) } : undefined;
    };
    const decl = /(?:\b(?:static|const)\s+)*\b(\w+)\s+(\w+)\s*\[[^\]]*\]\s*=\s*\(\s*(\w+)\s*\[[^\]]*\]\s*\)\s*(\w+)\s*;/g;
    let out = src;

    for (const m of src.matchAll(decl))
    {
        const [whole, destType, name, castType, from] = m;
        const dest = type(destType);
        const source = new RegExp(String.raw`\b(\w+)\s+${from}\s*\[`).exec(src);
        const have = source ? type(source[1]) : undefined;

        if (destType !== castType || !dest || !have || have.base !== dest.base)
            continue;

        const base = destType;
        const wd = dest.n;
        const ws = have.n;
        const fn = `${name}_ArrayCast`;
        let body: string;

        if (wd < ws && ws % wd === 0)
        {
            // a part of a source element: its components from (i % r) * wd on
            const r = ws / wd;
            const at = (k: number): string => `${from}[ i / ${r} ][ ( i % ${r} ) * ${wd}${k ? ` + ${k}` : ''} ]`;
            body = wd === 1 ? at(0) : `${base}( ${Array.from({ length: wd }, (_v, k) => at(k)).join(', ')} )`;
        }
        else if (wd > ws && wd % ws === 0)
        {
            // several source elements make one
            const r = wd / ws;
            body = `${base}( ${Array.from({ length: r }, (_v, k) => `${from}[ i * ${r}${k ? ` + ${k}` : ''} ]`).join(', ')} )`;
        }
        else
            continue;

        // every use must be an index
        const rest = out.replace(whole, '');
        const uses = new RegExp(String.raw`\b${name}\b`, 'g');
        let indexed = true;
        let text = '';
        let last = 0;

        for (let u = uses.exec(rest); u && indexed; u = uses.exec(rest))
        {
            const open = /^\s*\[/.exec(rest.slice(u.index + u[0].length));
            const at = open ? u.index + u[0].length + open[0].length - 1 : -1;
            const close = at >= 0 ? closingBracket(rest, at) : -1;

            if (close < 0)
            {
                indexed = false;
                break;
            }

            text += `${rest.slice(last, u.index)}${fn}( int( ${rest.slice(at + 1, close).trim()} ) )`;
            last = close + 1;
            uses.lastIndex = last;
        }

        if (!indexed)
            continue;

        // (the accessor takes the place of the declaration: the source array is declared before it)
        const accessor = `${base} ${fn}( int i ) { return ${body}; }`;
        const declAt = out.indexOf(whole);
        out = text + rest.slice(last);
        out = out.slice(0, declAt) + accessor + out.slice(declAt);
    }

    return out;
}

/**
 * HLSL flow control attributes (`[unroll]`, `[loop]`, `[branch]` …) are compiler hints GLSL has no syntax for. Mods
 * normally hide them behind macros that are empty on PDX_OPENGL; AGOT's dragon decals write one literally.
 */
export function hlslAttributes(src: string): string
{
    return src.replace(/(^|[\s;{})])\[\s*(?:unroll|loop|branch|flatten|fastopt|allow_uav_condition|call|forcecase)\s*(?:\(\s*\w*\s*\))?\s*\](?=\s*(?:for|while|do|if|switch)\b)/g, '$1');
}

/**
 * The source passes that stand in for what HLSL compilers do, in order (each is tested on its own by
 * scripts/shader-check.ts): integer declarations, casts of arrays, C-style casts, flow control attributes, matrix
 * initializers, matrix constructors. What glslang still rejects is patched afterwards, error by error (`fixHlslisms`).
 */
export function hlslPasses(src: string): string
{
    return hlslMatrixRows(hlslMatrixInitializers(hlslAttributes(hlslCasts(hlslArrayCasts(hlslImplicitInts(src))))));
}

/** Splits at the top-level commas (parentheses, brackets and braces nest); a trailing comma adds nothing. */
function splitTopLevel(s: string): string[]
{
    const out: string[] = [];
    let depth = 0;
    let cur = '';

    for (const c of s)
    {
        if (c === '(' || c === '[' || c === '{')
            depth++;
        else if (c === ')' || c === ']' || c === '}')
            depth--;

        if (c === ',' && depth === 0)
        {
            out.push(cur.trim());
            cur = '';
        }
        else
            cur += c;
    }

    if (cur.trim())
        out.push(cur.trim());

    return out;
}

/**
 * Brace initializers of square matrices → the constructor form, which hlslMatrixRows then reorders rows → columns.
 * GLSL has no such initializer for a matrix (it wants one list per column). Forms: N*N flat values (`const float4x4
 * ThresholdMatrix = { 1, 9, … };`, the dithered opacity tables), N rows in braces (`{ { 1, 2, 3 }, { 4, 5, 6 }, … }`),
 * N row vectors (`{ float3( … ), … }`, taken apart into the N*N flat values: `( float3( … ) ).x` is a constant
 * expression where a transpose() of the rows would not be) and an array of matrices
 * (`float4x4 M[2] = { { … }, { … } };` → `float4x4 M[2] = float4x4[2]( float4x4( … ), float4x4( … ) );`).
 */
export function hlslMatrixInitializers(src: string): string
{
    const re = /\b(float([234])x\2)(\s+[A-Za-z_]\w*)(\s*\[[^\]]*\])?(\s*=\s*)\{/g;
    let out = '';
    let last = 0;

    for (let m = re.exec(src); m; m = re.exec(src))
    {
        const open = m.index + m[0].length - 1;
        let depth = 0;
        let close = open;

        for (; close < src.length; close++)
        {
            if (src[close] === '{')
                depth++;
            else if (src[close] === '}' && --depth === 0)
                break;
        }

        if (close >= src.length)
            break;

        // (a second declarator after a comma is not handled: the declaration is left as it is)
        if (/^\s*,/.test(src.slice(close + 1)))
            continue;

        const type = m[1];
        const n = Number(m[2]);
        const elements = splitTopLevel(src.slice(open + 1, close));
        const braced = (e: string): string[] => splitTopLevel(e.slice(1, -1));
        // the constructor arguments of one matrix: flat values, rows in braces, or row vectors
        const matrix = (items: string[]): string | undefined =>
        {
            if (items.length === n * n && !items.some((e) => e.startsWith('{')))
                return `${type}( ${items.join(', ')} )`;

            if (items.length === n && items.every((e) => e.startsWith('{') && braced(e).length === n))
                return `${type}( ${items.flatMap(braced).join(', ')} )`;

            // row vectors (not number literals): taken apart into the flat form (a transpose() call would be no constant expression)
            if (items.length === n && !items.some((e) => e.startsWith('{') || /^[-+]?[\d.]+(?:[eE][-+]?\d+)?[fFhH]?$/.test(e)))
                return `${type}( ${items.flatMap((e) => 'xyzw'.slice(0, n).split('').map((c) => `( ${e} ).${c}`)).join(', ')} )`;

            return undefined;
        };
        let init: string | undefined;

        if (m[4])
        {
            // an array: one matrix per element, in braces or a constructor call of its own
            let list = elements;

            // one flat list of values for all the matrices: regrouped N*N at a time
            if (list.length > n * n && list.length % (n * n) === 0 && !list.some((e) => e.startsWith('{')))
            {
                const groups: string[] = [];

                for (let i = 0; i < list.length; i += n * n)
                    groups.push(`{ ${list.slice(i, i + n * n).join(', ')} }`);

                list = groups;
            }

            const each = list.map((e) => (e.startsWith('{') ? matrix(braced(e)) : e));
            init = each.every((e) => e !== undefined) ? `${type}${m[4].trim()}( ${each.join(', ')} )` : undefined;
        }
        else
            init = matrix(elements);

        if (init === undefined)
            continue;

        out += `${src.slice(last, m.index)}${type}${m[3]}${m[4] ?? ''}${m[5]}${init}`;
        last = close + 1;
        re.lastIndex = close + 1;
    }

    return out + src.slice(last);
}

/**
 * HLSL's `float3x3( a, b, c )` takes rows, GLSL's `mat3( a, b, c )` (the engine's float3x3 on PDX_OPENGL) columns:
 * the engine's portable code builds matrices with Create2x2/3x3/4x4 (cw/defines_glsl4.fxh), but some writes the
 * constructor (jomini/shader_utility.fxh `BuildTangentFrame`: the pattern normals of clothes variations came out
 * rotated, dark patches on the cloth). Constructors of several values outside the Create* helpers get a transpose.
 */
export function hlslMatrixRows(src: string): string
{
    // the Create* helpers' bodies (they know the GLSL order)
    const skip: [number, number][] = [];
    const def = /\bfloat[234]x[234]\s+Create[234]x[234]\s*\([^)]*\)\s*\{/g;
    let d: RegExpExecArray | null;

    while ((d = def.exec(src)))
    {
        let depth = 1;
        let i = d.index + d[0].length;

        while (i < src.length && depth > 0)
        {
            if (src[i] === '{')
                depth++;
            else if (src[i] === '}')
                depth--;

            i++;
        }

        skip.push([d.index, i]);
    }

    const re = /\b(float[234]x[234])\s*\(/g;
    let out = '';
    let last = 0;
    let m: RegExpExecArray | null;

    while ((m = re.exec(src)))
    {
        if (skip.some(([a, b]) => m!.index >= a && m!.index < b))
            continue;

        // the arguments up to the matching parenthesis, split at the top-level commas
        const start = m.index + m[0].length;
        const args: string[] = [];
        let depth = 1;
        let from = start;
        let i = start;

        while (i < src.length && depth > 0)
        {
            const c = src[i];

            if (c === '(')
                depth++;
            else if (c === ')')
                depth--;

            if ((c === ',' && depth === 1) || depth === 0)
            {
                args.push(src.slice(from, i));
                from = i + 1;
            }

            i++;
        }

        if (args.length < 2)
            continue;

        // one value per element (a constant table, `static const float4x4 Dither = float4x4( 0, 8, 2, 10, … )`):
        // the values reordered rows → columns, still a constant expression (a transpose() call is none: global const
        // initializers must be constant); vectors (rows): transpose()
        const n = Number(m[1].slice(-1));
        out += src.slice(last, m.index) + (args.length === n * n ?
            `${m[1]}(${Array.from({ length: n * n }, (_, k) => args[(k % n) * n + Math.floor(k / n)]).join(',')} )` :
            `transpose( ${src.slice(m.index, i)} )`);
        last = i;
        re.lastIndex = i;
    }

    return out + src.slice(last);
}

/**
 * HLSL converts float to int implicitly (`int Index = UV.x * 255.0;`), GLSL doesn't: integer declarations get an
 * explicit constructor around their initializer (a no-op when it already is an integer).
 */
export function hlslImplicitInts(src: string): string
{
    return src.replace(/\b(u?int[234]?)(\s+)([A-Za-z_]\w*)(\s*)=(\s*)([^;,{}]+?)(\s*);/g, (_m, type, s1, name, s2, s3, expr, s4) => `${type}${s1}${name}${s2}=${s3}${type}( ${expr} )${s4};`);
}

/**
 * Whether prepared vertex code reads bone streams (`Input.BoneIndex[0]`) that no struct declares: the engine
 * declares them only for skinned meshes (`@ifdef PDX_MESH_SKINNED`), and its own skinning code sits under that
 * condition too: whatever still reads them without it needs a skinned mesh.
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
