/**
 * The HLSL text the game's engine builds for one Effect stage, from the app's own effect-file model (ShaderLibrary,
 * `parseEffectFile`): the layered FX tree as the game loads it (patch > mods > game > jomini > clausewitz), no glslang,
 * no pruning. The engine concatenates the blocks of the include closure and hands the text to the Direct3D compiler
 * (d3dcompiler_47, profile vs_5_0 / ps_5_0, entry `main`); it caches the text in
 * `Documents/Paradox Interactive/Crusader Kings III/shadercache/dx11/{vs,ps}_5_0/*.scache`. The layout below was read off
 * 135 of those files and reproduces them (comments and blank lines aside): docs/shaders.md, "Offline verification".
 *
 * A source is, in this order: Shader Info, Defines, HLSL Macros (cw/defines_hlsl.fxh + cw/defines_common.fxh), Vertex
 * Structs, Constant Buffers (all of the closure, none pruned), Samplers and Textures (all declared, used or not), Buffer
 * Textures, Shader Code (the top level's Code blocks of every file first, then the stage's own), Main Code.
 *
 * The checks on this text are in hlslCheck.ts (static, any platform) and d3d.ts (the Direct3D compiler, Windows).
 */
import type { FxCode, FxEffect, FxField, FxFile, FxMain, FxSampler, FxStruct, Stage } from './effect.ts';
import { ShaderLibrary } from './compile.ts';
import { GameFiles } from '../mods/gamefiles.ts';
import type { ModInfo } from '../../shared/api.ts';
import { tr } from '../../shared/i18n.ts';

/**
 * The FX tree as the game loads it: the game's own files (game, jomini, clausewitz) with the mod folders on top, in load
 * order (a later folder wins; a folder is a mod root, or the folder a merge is about to write as one).
 */
export function layeredLibrary(gameDir: string, modRoots: string[] = []): ShaderLibrary
{
    const mods: ModInfo[] = modRoots.map((root, i) => ({
        id: 'layer/' + i, name: root, tags: [], root, source: 'local', replacePaths: [], status: 'ok', editable: false
    }) as ModInfo);
    return new ShaderLibrary(new GameFiles(gameDir, mods));
}

export interface HlslSpan
{
    /** 1-based line range of the source */
    from: number;
    to: number;
    /** the effect file the text came from */
    file: string;
    block: string;
}

export interface HlslUnit
{
    /** the HLSL text (built when read) */
    readonly source: string;
    /** names the source: equal sigs give equal text up to the Effect comment */
    readonly sig: string;
    spans: HlslSpan[];
    stage: Stage;
    /** `gfx/FX/pdxmesh.shader` */
    file: string;
    effect: FxEffect;
    main: FxMain;
    /** the include closure in the engine's order */
    files: FxFile[];
    /** the defines of the source, with their values (`NUM_SAMPLES 4`) */
    defines: string[];
    /** every sampler / buffer texture declaration of the stage in the engine's order, duplicates included (the builder checks those) */
    declared: FxSampler[];
    /** every constant buffer of the closure */
    cbuffers: FxStruct[];
    /** the Code blocks of the stage in the engine's order, plain structs (`raw`) included */
    codes: FxCode[];
}

/** engine constant buffer slot of a ConstantBuffer( name ) */
export type CbSlots = (name: string) => string;

/** the properties of a block are read in any case (`type = "2darray"`, `Type = "Cube"`) */
export const prop = (s: { props: Record<string, string>; }, key: string): string | undefined =>
{
    const k = Object.keys(s.props).find((x) => x.toLowerCase() === key.toLowerCase());
    return k === undefined ? undefined : s.props[k];
};

const NAMED_SLOTS: Record<string, number> = {
    FlatMapLerpEnvironment: 0, SceneLightConstants: 1, SceneShadowConstants: 2, DiseaseConstants: 3, GameSharedConstants: 4,
    GradientBorders: 7, JominiColorMapConstants: 8, JominiFogOfWar: 9, JominiWater: 11, PdxTerrainConstants: 12,
    PdxHeightmapConstants: 13, JominiEnvironment: 17, PdxGuiConstants: 21, PdxGuiWidgetConstants: 22,
    PdxMeshInstanceData: 29, PdxMeshJointVertexInstanceData: 30, PdxMeshBlendShapeInstanceData: 31, PdxMeshBlendShapeConstants: 33,
    PdxShadowmap: 52, PdxCamera: 53
};
const madeSlots = new Map<string, number>();

/**
 * The slot the engine gives a ConstantBuffer (`cbuffer pdx_hlsl_cb<slot>`): `36 + N` for `ConstantBuffer( N )` and
 * PdxConstantBufferN, fixed numbers for the named engine buffers (read off the cache; game 1.20.1.2). The slot only names
 * the buffer for the D3D compiler; a name this table does not know gets a made-up slot (it cannot clash with the engine's).
 */
export function cbSlot(name: string): string
{
    const n = name.replace(/,.*$/, '').trim();

    if (/^\d+$/.test(n))
        return String(36 + Number(n));

    const m = /^PdxConstantBuffer(\d+)$/.exec(n);

    if (m)
        return String(36 + Number(m[1]));

    if (n in NAMED_SLOTS)
        return String(NAMED_SLOTS[n]);

    if (!madeSlots.has(n))
        madeSlots.set(n, 1000 + madeSlots.size);

    return String(madeSlots.get(n));
}

const TEX: Record<string, { tex: string; wrap: string; }> = {
    '2d': { tex: 'Texture2D', wrap: 'PdxTextureSampler2D' },
    '2darray': { tex: 'Texture2DArray', wrap: 'PdxTextureSampler2DArray' },
    '3d': { tex: 'Texture3D', wrap: 'PdxTextureSampler3D' },
    'cube': { tex: 'TextureCube', wrap: 'PdxTextureSamplerCube' },
    '2dms': { tex: 'Texture2DMS<float4>', wrap: 'PdxTextureSampler2DMS' }
};

/** properties of a TextureSampler that make up the engine's sampler state (the rest binds or loads the texture) */
const STATE_KEYS = ['MagFilter', 'MinFilter', 'MipFilter', 'SampleModeU', 'SampleModeV', 'SampleModeW', 'CompareFunction', 'MaxAnisotropy', 'MipLodBias', 'BorderColor', 'MinLod', 'MaxLod'];

/** the defines the engine adds to a mesh with UVs and joints (the asset's `additional_shader_defines` come on top) */
export const MESH_DEFINES = ['PDX_MESH_UV1', 'PDX_MESH_UV2', 'PDX_MESH_SKINNED'];

/** the engine takes the code out of its [[ ]] without the common indentation and without trailing blanks */
export function dedent(code: string): string
{
    const lines = code.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
    const ind = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0]);
    let common = ind[0] ?? '';

    for (const i of ind)
        while (!i.startsWith(common))
            common = common.slice(0, -1);

    return lines.map((l) => l.slice(common.length)).join('\n').replace(/^\n/, '').replace(/\n$/, '');
}

type Cond = { define: string; negate: boolean; }[];

function fieldLines(fields: FxField[]): string[]
{
    const out: string[] = [];
    let open: Cond = [];
    const same = (a: Cond, b: Cond): boolean => a.length === b.length && a.every((c, i) => c.define === b[i].define && c.negate === b[i].negate);

    for (const fl of fields)
    {
        const conds = fl.cond ?? [];

        if (!same(conds, open))
        {
            out.push(...open.map(() => '#endif'));
            out.push(...conds.map((c) => `#${c.negate ? 'ifndef' : 'ifdef'} ${c.define}`));
            open = conds;
        }

        out.push(`\t${[...(fl.qualifiers ?? []), fl.type, fl.name].join(' ')}${fl.array ? `[${fl.array}]` : ''}${fl.semantic ? ' : ' + fl.semantic : ''};`);
    }

    out.push(...open.map(() => '#endif'));
    return out;
}

interface Body
{
    lines: string[];
    spans: HlslSpan[];
    declared: FxSampler[];
    cbuffers: FxStruct[];
    codes: FxCode[];
    text?: string;
    lineCount?: number;
}

/** everything between the HLSL macros and the main code: the same for all effects of one shader file, stage and main */
function buildBody(stage: Stage, files: FxFile[], main: FxMain, slot: CbSlots): Body
{
    const out: string[] = [];
    const spans: HlslSpan[] = [];
    const push = (...s: string[]): void => { out.push(...s.flatMap((x) => x.split('\n'))); };

    // --- vertex structs of the stage: a later definition of a name replaces an earlier one; a struct inside the other
    // stage's block is not declared (PixelShader = { VertexStruct … })
    push('// === Vertex Structs === ', '');
    const structs = new Map<string, string[]>();
    const structFile = new Map<string, string>();

    for (const pick of ['both', stage])
        for (const f of files)
        {
            for (const s of f.structs)
                if ((s.stage ?? 'both') === pick)
                {
                    structs.set(s.name, [`struct ${s.name}`, '{', ...fieldLines(s.fields), '};']);
                    structFile.set(s.name, f.path);
                }

            // (a plain `struct` outside any Code block is declared here too)
            for (const c of f.codes)
                if (pick === 'both' && c.raw && (c.stage === 'both' || c.stage === stage))
                    structs.set('raw:' + f.path + ':' + c.code.slice(0, 40), [dedent(c.code)]);
        }

    for (const [key, lines] of structs)
    {
        const from = out.length + 1;
        push(...lines);
        spans.push({ from, to: out.length, file: structFile.get(key) ?? key.replace(/^raw:([^:]*):.*$/s, '$1'), block: lines[0] });
    }

    push('', '');

    // --- constant buffers: every buffer of every file (a buffer name declared twice stays two buffers)
    push('// === Constant Buffers === ', '');
    const cbuffers: FxStruct[] = [];

    for (const f of files)
        for (const cb of f.cbuffers)
        {
            if (cb.main && cb.main !== main.name)
                continue;

            const from = out.length + 1;
            push(`cbuffer pdx_hlsl_cb${slot(cb.name)}`, '{', ...fieldLines(cb.fields), '}');
            spans.push({ from, to: out.length, file: f.path, block: `ConstantBuffer( ${cb.name} )` });
            cbuffers.push(cb);
        }

    push('', '');

    // --- samplers of the stage
    const mine = (s: FxSampler): boolean => (s.stage === 'both' || s.stage === stage) && (!s.main || s.main === main.name);
    const states: string[] = [];
    const stateOf = (s: FxSampler): number =>
    {
        const key = STATE_KEYS.map((k) => `${k}=${(prop(s, k) ?? '').toLowerCase()}`).join(';');
        let i = states.indexOf(key);

        if (i < 0)
            i = states.push(key) - 1;

        return i;
    };
    const textures: FxSampler[] = [];
    const bufferTex: FxSampler[] = [];
    const seen = new Set<string>();
    const declared: FxSampler[] = [];

    // like the code: the declarations of the top level (both stages) of all files first, then the stage's own blocks
    for (const pick of ['both', stage])
        for (const f of files)
            for (const s of f.samplers)
            {
                if (!mine(s) || s.stage !== pick)
                    continue;

                declared.push(s);

                if (seen.has(s.name))
                    continue; // one HLSL declaration per name

                seen.add(s.name);
                (s.kind === 'BufferTexture' ? bufferTex : textures).push(s);
            }

    const texLines: string[] = [];

    for (const s of textures)
    {
        const ty = TEX[(prop(s, 'Type') ?? '2d').toLowerCase()] ?? TEX['2d'];
        const cmp = !!prop(s, 'CompareFunction');
        const st = stateOf(s);
        const wrap = cmp && ty === TEX['2d'] ? 'PdxTextureSampler2DCmp' : ty.wrap;
        texLines.push(`${ty.tex} ${s.name}_Texture;`, `static ${wrap} ${s.name} = { ${s.name}_Texture, _sampler_${st}_ };`);
    }

    push('// === Samplers === ', '');
    states.forEach((k, i) => push(`${/CompareFunction=[a-z]/i.test(k) ? 'SamplerComparisonState' : 'SamplerState'} _sampler_${i}_ : register(s${i});`));
    push('', '', '// === Textures === ', '', ...texLines, '', '', '// === RW Textures === ', '', '', '', '// === Buffer Textures === ', '');

    for (const s of bufferTex)
    {
        const ty = (prop(s, 'Type') ?? 'float').toLowerCase();
        const n = /(\d)$/.exec(ty)?.[1] ?? '';
        const base = ty.replace(/\d$/, '');
        push(`PdxBuffer${base[0].toUpperCase() + base.slice(1)}${n} ${s.name};`);
    }

    push('', '', '// === RW Buffer Textures === ', '', '', '', '// === Shader Code === ', '');

    // the engine puts the code shared by both stages first (top level of every file), then the stage's own blocks
    const codes: FxCode[] = [];

    for (const pick of ['both', stage])
        for (const f of files)
            for (const c of f.codes)
            {
                if (c.stage !== pick)
                    continue;

                codes.push(c);

                if (c.raw)
                    continue;

                const from = out.length + 1;
                push(dedent(c.code), ...(pick === 'both' ? [] : ['']));
                spans.push({ from, to: out.length, file: f.path, block: 'Code' });
            }

    return { lines: out, spans, declared, cbuffers, codes };
}

const bodyCache = new WeakMap<object, Map<string, Body>>();
const macroCache = new WeakMap<object, { text: string; lines: number; }>();

export interface HlslRequest
{
    lib: ShaderLibrary;
    /** `gfx/FX/pdxmesh.shader` or `pdxmesh.shader` */
    file: string;
    effect: string;
    stage: Stage;
    /** defines the mesh adds in front of the effect's (MESH_DEFINES, the asset's additional_shader_defines …) */
    mesh?: string[];
    /** the full define list instead of mesh + the effect's defines (comparisons with the cache) */
    defines?: string[];
    cbSlot?: CbSlots;
    /** names the layering: part of `sig`, since the same file name can hold other text in another layering */
    salt?: string;
}

/** The HLSL source of one stage of an Effect, or why there is none. */
export function generateHlsl(req: HlslRequest): HlslUnit | { error: string; }
{
    const { lib, stage } = req;
    const found = lib.effect(req.file, req.effect);

    if (!found)
        return { error: tr('Effect {effect} not found in {file}', { effect: req.effect, file: req.file }) };

    const { effect, files } = found;
    const mainName = stage === 'vs' ? effect.vs : effect.ps;
    const main = lib.main(files, mainName, stage);

    if (!main)
        return { error: tr('Effect {name}: shader {value} not found', { name: effect.name, value: mainName ?? '' }) };

    const defines = req.defines ?? [...(req.mesh ?? []), ...effect.defines];

    // header: Shader Info + Defines (the only parts that differ between the effects of one shader file besides the main)
    const header = [
        '', '', '// === Shader Info === ', '', `// Shader file: gfx/FX/${req.file.replace(/^gfx\/FX\//, '')}`, `// Effect: ${effect.name}`, '', '', '',
        '// === Defines === ', '',
        '#define PDX_DIRECTX_11', stage === 'vs' ? '#define VERTEX_SHADER' : '#define PIXEL_SHADER', '#define PDX_HLSL', '#define VENDOR_NVIDIA',
        ...defines.map((d) => '#define ' + d),
        '#define PDX_MAX_HEIGHTMAP_COMPRESS_LEVELS 5', '#define PDX_MAX_DETAIL_TEXTURES 256', '#define JOMINI_REFRACTION_ENABLED', '#define PDX_WINDOWS', '', '',
        '// === HLSL Macros === ', ''
    ];
    let macros = macroCache.get(lib);

    if (!macros)
    {
        const t = (rel: string): string => (lib.text(rel) ?? '').replace(/\r\n/g, '\n');
        // (the engine puts a blank line between the two files and one after them)
        const text = t('cw/defines_hlsl.fxh') + '\n' + t('cw/defines_common.fxh');
        macroCache.set(lib, (macros = { text: text + '\n\n\n', lines: text.split('\n').length + 3 }));
    }

    const key = `${req.file}|${stage}|${main.name}`;
    let body = bodyCache.get(lib)?.get(key);

    if (!body)
    {
        body = buildBody(stage, files, main, req.cbSlot ?? cbSlot);
        body.text = body.lines.join('\n') + '\n\n\n// === Main Code === \n\n';
        body.lineCount = body.lines.length + 4;

        if (!bodyCache.has(lib))
            bodyCache.set(lib, new Map());

        bodyCache.get(lib)!.set(key, body);
    }

    const colorOut = main.output === 'PDX_COLOR';
    const sigMain = stage === 'vs'
        ? [main.output, 'main(', main.input, 'Input )'].join(' ')
        : [colorOut ? 'float4' : main.output, 'main(', main.input, 'Input, bool PDX_IsFrontFace : SV_IsFrontFace )', colorOut ? ': PDX_COLOR' : ''].join(' ').trim();
    const mainText = dedent(main.code).replace(/\bPDX_MAIN\b/, sigMain);
    const offset = header.length + macros.lines;
    const spans = body.spans.map((sp) => ({ ...sp, from: sp.from + offset, to: sp.to + offset }));
    const mainFrom = offset + body.lineCount! + 1;
    spans.push({ from: mainFrom, to: mainFrom + mainText.split('\n').length - 1, file: main.file, block: 'MainCode ' + main.name });
    const fixed = macros;
    const fixedBody = body;

    return {
        // the same sources compile to the same result: (file, stage, main, defines) names a source (the effect's name is only in a comment)
        sig: `${req.salt ?? ''}|${key}|${defines.join(',')}`,
        get source(): string { return header.join('\n') + '\n' + fixed.text + fixedBody.text + mainText; },
        spans,
        stage,
        file: 'gfx/FX/' + req.file.replace(/^gfx\/FX\//, ''),
        effect,
        main,
        files,
        defines,
        declared: body.declared,
        cbuffers: body.cbuffers,
        codes: body.codes
    };
}
