// The offline shader verification (src/main/shaders: hlsl.ts, hlslCheck.ts, d3d.ts): the HLSL the game's engine builds for an
// Effect stage from a layered FX tree, the static checks on it (a constant buffer member in two buffers, a sampler declared
// twice, a binding clash, a struct or function defined twice, a struct field nobody writes) and the Direct3D compiler's verdict.
//
//   1. unit cases on small synthetic effect files (static findings; with a compiler also the compile verdict they stand for)
//   2. the game's own effects: no finding on any of them (no false positives), a sample of them compiles
//   3. the game's shader cache, when there is one: the generated text equals the cached text, the verdict equals the game's
//      (a `.bin` next to the `.scache` means the game compiled it)
//   4. a run with mods, when given: every cached stage of it fails or passes like the game said, with the same messages
//      as its error.log, and the static checks find the builder errors the log names
//
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings scripts/shader-hlsl-check.ts
// Environment:
//   CK3_DIR / GAME   the install (default: the first one found); no install: parts 2 to 4 are left out
//   SHADERCACHE      the shader cache to compare with (default: Documents/Paradox Interactive/Crusader Kings III/shadercache/dx11);
//                    it holds the sources of every game version and mod set that ever ran, so only the entries the vanilla
//                    files reproduce byte for byte count (SAMPLE=n entries per stage, default 40)
//   HLSL_RUN         a folder of a game run with mods: shadercache/{vs,ps}_5_0, logs/error.log (optional), and HLSL_MODS =
//                    the mod folders in load order separated by ';' (the files the run loaded)
// Parts 3 and 4 and every compile are left out where there is no Direct3D compiler (not Windows).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { compileHlsl, d3dBackends } from '../src/main/shaders/d3d.ts';
import { generateHlsl, layeredLibrary, MESH_DEFINES, type HlslUnit } from '../src/main/shaders/hlsl.ts';
import { ShaderLibrary } from '../src/main/shaders/compile.ts';
import { staticFindings, verifyUnits, type HlslFinding } from '../src/main/shaders/hlslCheck.ts';
import { defaultInstall } from './ck3-install.ts';

let bad = 0;
let count = 0;
const report = (ok: boolean, name: string, detail = ''): void =>
{
    count++;

    if (!ok)
    {
        bad++;
        console.log(`FAIL ${name}${detail ? '\n' + detail : ''}`);
    }
};

/** a line of facts for the log, besides the pass / fail count */
const note = (text: string): void => console.log('  ' + text);
const compiler = d3dBackends().length > 0;
const tmp = mkdtempSync(join(tmpdir(), 'ckp-hlsl-check-'));
const cacheDir = join(tmp, 'verdicts');
const started = performance.now();

// ---------------------------------------------------------------------------------------------------------------------
// 1. Unit cases
// ---------------------------------------------------------------------------------------------------------------------

/** minimal engine macros so that the generated sources compile without the game's cw files */
const MACROS = `#define PDX_COLOR SV_Target
#define PDX_POSITION SV_Position
struct PdxTextureSampler2D { Texture2D Texture; SamplerState Sampler; };
#define PdxBufferFloat4 Buffer<float4>
`;

/** the standard pair of stages: a vertex main that writes OUT, a pixel main */
const STAGES = `
VertexStruct VS_IN { float3 Position : POSITION; }
VertexStruct VS_OUT { float4 Position : PDX_POSITION; }
VertexShader = {
	MainCode VS { Input = "VS_IN" Output = "VS_OUT" Code [[ PDX_MAIN { VS_OUT Out; Out.Position = float4( Input.Position, 1.0 ); return Out; } ]] }
}
PixelShader = {
	MainCode PS { Input = "VS_OUT" Output = "PDX_COLOR" Code [[ PDX_MAIN { return float4( 1.0, 1.0, 1.0, 1.0 ); } ]] }
}
Effect e { VertexShader = "VS" PixelShader = "PS" }
`;

let caseNo = 0;

/** a library over the given files (path below gfx/FX → text) and the unit of Effect `e` of x.shader */
function unitOf(files: Record<string, string>, stage: 'vs' | 'ps' = 'vs', mesh: string[] = []): HlslUnit
{
    const dir = join(tmp, 'case' + caseNo++);
    mkdirSync(join(dir, 'game', 'gfx', 'FX'), { recursive: true });
    mkdirSync(join(dir, 'clausewitz', 'gfx', 'FX', 'cw'), { recursive: true });
    writeFileSync(join(dir, 'clausewitz', 'gfx', 'FX', 'cw', 'defines_hlsl.fxh'), MACROS);
    writeFileSync(join(dir, 'clausewitz', 'gfx', 'FX', 'cw', 'defines_common.fxh'), '');

    for (const [rel, text] of Object.entries(files))
    {
        mkdirSync(dirname(join(dir, 'game', 'gfx', 'FX', rel)), { recursive: true });
        writeFileSync(join(dir, 'game', 'gfx', 'FX', rel), text);
    }

    const r = generateHlsl({ lib: new ShaderLibrary(join(dir, 'game')), file: 'x.shader', effect: 'e', stage, mesh });

    if ('error' in r)
        throw new Error(r.error);

    return r;
}

const kinds = (fs: HlslFinding[]): string => fs.map((f) => `${f.kind}:${f.name}`).join(', ');
const has = (fs: HlslFinding[], kind: string, name: string): boolean => fs.some((f) => f.kind === kind && f.name === name);

/** the compile verdict of a unit (null: no compiler) */
async function verdict(u: HlslUnit): Promise<{ ok: boolean | null; codes: string }>
{
    const [v] = await compileHlsl([{ source: u.source, stage: u.stage }], { cacheDir });
    return { ok: v.ok, codes: v.errors.map((e) => `${e.code} ${e.msg}`).join(' | ') };
}

// a clean effect
{
    const u = unitOf({ 'x.shader': 'ConstantBuffer( 5 ) { float4 Tint; }\nTextureSampler Tex { Ref = PdxTexture0 Index = 2 File = "a.dds" }\n' + STAGES });
    const f = staticFindings(u);
    report(f.length === 0, 'clean effect: no finding', kinds(f));
    report(/\/\/ Shader file: gfx\/FX\/x\.shader\n\/\/ Effect: e\n/.test(u.source), 'source: the shader info');
    report(/#define PDX_DIRECTX_11\n#define VERTEX_SHADER\n#define PDX_HLSL\n#define VENDOR_NVIDIA\n/.test(u.source), 'source: the defines of a vertex stage');
    report(/cbuffer pdx_hlsl_cb41\n\{\n\tfloat4 Tint;\n\}/.test(u.source), 'source: ConstantBuffer( 5 ) is slot 41');
    report(/Texture2D Tex_Texture;\nstatic PdxTextureSampler2D Tex = \{ Tex_Texture, _sampler_0_ \};/.test(u.source), 'source: a sampler is a texture and a static wrapper');
    report(/float4 main\( VS_IN Input \)/.test(u.source) === false && /VS_OUT main\( VS_IN Input \)/.test(u.source), 'source: the vertex main');
    const p = unitOf({ 'x.shader': STAGES }, 'ps');
    report(/float4 main\( VS_OUT Input, bool PDX_IsFrontFace : SV_IsFrontFace \) : PDX_COLOR/.test(p.source), 'source: the pixel main');

    if (compiler)
    {
        const v = await verdict(u);
        report(v.ok === true, 'clean effect: compiles', v.codes);
        const vp = await verdict(p);
        report(vp.ok === true, 'clean pixel stage: compiles', vp.codes);
    }
}

// X3003: a member in two constant buffers
{
    const u = unitOf({ 'x.shader': 'ConstantBuffer( 5 ) { float4 Lights[3]; }\nConstantBuffer( Other ) { float4 Lights[20]; }\n' + STAGES });
    const f = staticFindings(u);
    report(has(f, 'cbuffer-member', 'Lights') && f[0].code === 'X3003', 'X3003: a member declared in two buffers', kinds(f));
    report(f.length === 1 && !!f[0].partner, 'X3003: names the file on both sides', JSON.stringify(f));

    if (compiler)
    {
        const v = await verdict(u);
        report(v.ok === false && /X3003 redefinition of 'Lights'/.test(v.codes), 'X3003: the compiler says so too', v.codes);
    }
}

// a buffer name written twice with different members is fine; so is a member under an inactive @ifdef
{
    const u = unitOf({ 'x.shader': 'ConstantBuffer( 5 ) { float4 A; }\nConstantBuffer( 5 ) { float4 B; }\nConstantBuffer( 6 ) {\n@ifdef WIDE\n float4 A;\n@endif\n}\n' + STAGES });
    report(staticFindings(u).length === 0, 'cbuffer: the same buffer opened twice, and a member behind an @ifdef that is not set', kinds(staticFindings(u)));
    const w = unitOf({ 'x.shader': 'ConstantBuffer( 5 ) { float4 A; }\nConstantBuffer( 6 ) {\n@ifdef WIDE\n float4 A;\n@endif\n}\n' + STAGES.replace('Effect e { ', 'Effect e { Defines = { "WIDE" } ') });
    report(has(staticFindings(w), 'cbuffer-member', 'A'), 'cbuffer: the member behind an @ifdef that is set', kinds(staticFindings(w)));

    if (compiler)
    {
        const v = await verdict(u);
        report(v.ok === true, 'cbuffer: reopened buffer compiles', v.codes);
    }
}

// X3508: a field of an inout struct that nobody writes
{
    const struct = (extra: string): string => `VertexStruct VS_OUT { float4 Position : PDX_POSITION; uint Index : TEXCOORD0; ${extra} }\n`;
    const effect = (writes: string, call = 'Finish( Out, 1 );'): string => `
VertexStruct VS_IN { float3 Position : POSITION; }
VertexShader = {
	Code [[
		VS_OUT Convert( VS_IN In ) { VS_OUT Out; Out.Position = float4( In.Position, 1.0 ); return Out; }
		void Finish( inout VS_OUT Out, in uint I ) { Out.Index = I; ${writes} }
	]]
	MainCode VS { Input = "VS_IN" Output = "VS_OUT" Code [[ PDX_MAIN { VS_OUT Out = Convert( Input ); ${call} return Out; } ]] }
}
PixelShader = { MainCode PS { Input = "VS_OUT" Output = "PDX_COLOR" Code [[ PDX_MAIN { return float4( 1.0, 1.0, 1.0, 1.0 ); } ]] } }
Effect e { VertexShader = "VS" PixelShader = "PS" }
`;
    const missing = unitOf({ 'x.shader': struct('int Extra : TEXCOORD1;') + effect('') });
    const f = staticFindings(missing);
    report(has(f, 'unwritten-field', 'Extra') && f.length === 1 && f[0].code === 'X3508', 'X3508: a field of an inout struct that no code writes', kinds(f));

    const written = unitOf({ 'x.shader': struct('int Extra : TEXCOORD1;') + effect('Out.Extra = 3;') });
    report(staticFindings(written).length === 0, 'X3508: the field is written', kinds(staticFindings(written)));
    const swizzled = unitOf({ 'x.shader': struct('float3 Extra : TEXCOORD1;') + effect('Out.Extra.xy = float2( 1.0, 2.0 ); Out.Extra.z = 0.0;') });
    report(staticFindings(swizzled).length === 0, 'X3508: a swizzled write counts', kinds(staticFindings(swizzled)));
    const notCalled = unitOf({ 'x.shader': struct('int Extra : TEXCOORD1;') + effect('', '') });
    report(staticFindings(notCalled).length === 0, 'X3508: a function the main does not call does not count', kinds(staticFindings(notCalled)));
    const behind = unitOf({ 'x.shader': struct('\n@ifdef WIDE\n int Extra : TEXCOORD1;\n@endif\n') + effect('') });
    report(staticFindings(behind).length === 0, 'X3508: a field behind an @ifdef that is not set is not there', kinds(staticFindings(behind)));

    if (compiler)
    {
        const v = await verdict(missing);
        report(v.ok === false && /X3508/.test(v.codes), 'X3508: the compiler says so too', v.codes);
        const w = await verdict(written);
        report(w.ok === true, 'X3508: with the field written the compiler is content', w.codes);
    }
}

// samplers: declared twice in one stage, binding clashes
{
    const dup = unitOf({
        'x.shader': 'Includes = { "s.fxh" }\n' + STAGES.replace('VertexShader = {', 'VertexShader = {\n\tTextureSampler Tex { Index = 2 File = "a.dds" }\n\tBufferTexture Data { Ref = PdxData type = float4 }'),
        's.fxh': 'TextureSampler Tex { Index = 2 File = "a.dds" }\nBufferTexture Data { Ref = PdxData type = float4 }\n'
    });
    const f = staticFindings(dup);
    report(has(f, 'duplicate-declaration', 'Tex') && has(f, 'duplicate-declaration', 'Data'), 'sampler and buffer texture declared at file scope and again in the stage block', kinds(f));
    report(f.every((x) => !!x.partner && x.partner !== x.file), 'sampler duplicate: both files named', JSON.stringify(f));
    const pixel = unitOf({
        'x.shader': 'Includes = { "s.fxh" }\n' + STAGES.replace('VertexShader = {', 'VertexShader = {\n\tTextureSampler Tex { Index = 2 File = "a.dds" }'),
        's.fxh': 'TextureSampler Tex { Index = 2 File = "a.dds" }\n'
    }, 'ps');
    report(staticFindings(pixel).length === 0, 'a sampler of the vertex block is no duplicate in the pixel stage', kinds(staticFindings(pixel)));

    const index = unitOf({ 'x.shader': 'TextureSampler A { Index = 3 File = "a.dds" }\nTextureSampler B { Index = 3 File = "b.dds" }\n' + STAGES });
    report(has(staticFindings(index), 'binding', 'B'), 'two samplers on one Index', kinds(staticFindings(index)));
    const ref = unitOf({ 'x.shader': 'TextureSampler A { Ref = PdxTexture1 }\nTextureSampler B { Ref = PdxTexture1 }\n' + STAGES });
    report(has(staticFindings(ref), 'binding', 'B'), 'two samplers on one Ref', kinds(staticFindings(ref)));
    const apart = unitOf({ 'x.shader': 'TextureSampler A { Index = 3 File = "a.dds" }\nTextureSampler B { Index = 4 File = "b.dds" }\nTextureSampler C { Ref = PdxTexture1 }\n' + STAGES });
    report(staticFindings(apart).length === 0, 'different Index and Ref values are no clash', kinds(staticFindings(apart)));

    // the engine's ids: Index = n is the slot of Ref = PdxTexture<n>, Index = 32 the one of Ref = PdxShadowmap; the second one is named
    const shadow = unitOf({ 'x.shader': 'TextureSampler Terrain { Index = 32 File = "a.dds" }\nTextureSampler Shadow { Ref = PdxShadowmap }\n' + STAGES });
    const sf = staticFindings(shadow);
    const sfShadow = sf.find((x) => x.name === 'Shadow'), sfPast = sf.find((x) => x.name === 'Terrain');
    report(sf.length === 2 && sf.every((x) => x.kind === 'binding') && !!sfShadow && / 101 /.test(sfShadow.message) && !!sfPast && /Index 32/.test(sfPast.message), 'binding id: Index = 32 against Ref = PdxShadowmap (id 101), the second one is named; the texture file on Index 32 is past the file slots', kinds(sf) + ' ' + sf.map((x) => x.message).join(' | '));
    const texN = unitOf({ 'x.shader': 'TextureSampler A { Index = 5 File = "a.dds" }\nTextureSampler B { Ref = PdxTexture5 }\nTextureSampler C { Ref = JominiFogOfWar }\nTextureSampler D { Ref = NoSuchName }\nTextureSampler E { Ref = PdxTexture32 }\n' + STAGES });
    const tf = staticFindings(texN);
    report(tf.length === 1 && tf[0].name === 'B', 'binding id: Index = 5 is Ref = PdxTexture5; an unknown name and a digit out of the range have no id', kinds(tf));
    const far = unitOf({ 'x.shader': 'TextureSampler Far { Index = 60 File = "a.dds" }\nTextureSampler Far2 { Index = 59 File = "a.dds" }\nTextureSampler Fine { Index = 58 File = "a.dds" }\n' + STAGES });
    const ff = staticFindings(far);
    report(ff.length === 3 && ff.every((x) => x.kind === 'binding') && ff.filter((x) => x.name === 'Fine').length === 1, 'binding id: an Index past the ids the engine has room for; Index 58 has an id but is past the file slots', kinds(ff) + ' ' + ff.map((x) => x.name).join(','));

    if (compiler)
    {
        const v = await verdict(dup);
        report(v.ok === true, 'sampler duplicates: the compiler sees one declaration (it is the engine builder that refuses)', v.codes);
    }
}

// functions, structs and variables defined twice
{
    const two = unitOf({
        'x.shader': 'Includes = { "a.fxh" }\nCode [[\n float Twice( float x ) { return x * 2.0; }\n static const float K = 1.0;\n struct Pair { float a; float b; };\n]]\n' + STAGES,
        'a.fxh': 'Code [[\n float Twice( float x ) { return x + x; }\n static const float K = 1.0;\n struct Pair { float a; float b; };\n]]\n'
    });
    const f = staticFindings(two);
    report(has(f, 'duplicate-definition', 'Twice') && has(f, 'duplicate-definition', 'K') && has(f, 'duplicate-definition', 'Pair'), 'a function, a variable and a struct defined twice', kinds(f));
    const alt = unitOf({
        'x.shader': 'Includes = { "a.fxh" }\nCode [[\n #ifdef WIDE\n float Twice( float x ) { return x * 2.0; }\n #else\n float Twice( float x ) { return x + x; }\n #endif\n float Twice( int x ) { return x; }\n]]\n' + STAGES,
        'a.fxh': 'Code [[\n #ifndef WIDE\n float Other( float x ) { return x; }\n #endif\n]]\n'
    });
    report(staticFindings(alt).length === 0, '#if alternatives and overloads are no duplicate', kinds(staticFindings(alt)));

    if (compiler)
    {
        const v = await verdict(two);
        report(v.ok === false && /redefinition/.test(v.codes), 'duplicate definitions: the compiler refuses them too', v.codes);
    }
}

// a VertexStruct of the pixel block is not declared in the vertex stage; a plain struct outside Code is
{
    const u = unitOf({ 'x.shader': 'PixelShader = { VertexStruct PS_ONLY { float4 C : PDX_COLOR; } }\nstruct Plain { float a; };\n' + STAGES });
    report(!/PS_ONLY/.test(u.source) && /struct Plain/.test(u.source), 'source: a struct of the pixel block stays out of the vertex stage, a plain struct goes in');
    const p = unitOf({ 'x.shader': 'PixelShader = { VertexStruct PS_ONLY { float4 C : PDX_COLOR; } }\n' + STAGES }, 'ps');
    report(/struct PS_ONLY/.test(p.source), 'source: and is declared in the pixel stage');
    const m = unitOf({ 'x.shader': STAGES }, 'vs', MESH_DEFINES);
    report(/#define PDX_MESH_UV1\n#define PDX_MESH_UV2\n#define PDX_MESH_SKINNED\n/.test(m.source), 'source: the mesh defines come before the effect\'s');
}

// the verdict cache
if (compiler)
{
    const u = unitOf({ 'x.shader': STAGES });
    const [a] = await compileHlsl([{ source: u.source, stage: 'vs' }], { cacheDir });
    const [b] = await compileHlsl([{ source: u.source, stage: 'vs' }], { cacheDir });
    report(a.ok === true && b.ok === true && b.cached === true && b.ms === 0, 'verdict cache: a second run is answered from it');
    const [c] = await compileHlsl([{ source: u.source, stage: 'vs' }], { cacheDir, flags: 0 });
    report(c.cached !== true, 'verdict cache: other flags are another entry');
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. The game's own effects
// ---------------------------------------------------------------------------------------------------------------------

const install = (() =>
{
    try
    {
        return defaultInstall();
    }
    catch
    {
        return undefined;
    }
})();
const gameDir = install ? resolveGameDir(install) : undefined;

/** every Effect of every .shader file in both mesh variants */
function allUnits(lib: ShaderLibrary, only?: (rel: string) => boolean): HlslUnit[]
{
    const out: HlslUnit[] = [];

    for (const f of lib.vfs.list('gfx/FX', { engine: true, ext: /\.shader$/i }))
    {
        const rel = f.rel.replace(/^gfx\/FX\//, '');

        if (only && !only(rel))
            continue;

        for (const effect of lib.effectsWithIncludes(rel))
            for (const stage of ['vs', 'ps'] as const)
                for (const mesh of [[], MESH_DEFINES])
                {
                    const u = generateHlsl({ lib, file: rel, effect, stage, mesh, salt: 'check' });

                    if (!('error' in u))
                        out.push(u);
                }
    }

    return out;
}

if (gameDir)
{
    const lib = new ShaderLibrary(gameDir);
    const units = allUnits(lib);
    const found = units.flatMap((u) => staticFindings(u).map((f) => `${u.file}:${u.effect.name} ${u.stage} ${f.kind} ${f.name}`));
    report(found.length === 0, `the game's own effects: no static finding in ${units.length} stage sources`, found.slice(0, 8).join('\n'));

    if (compiler)
    {
        // a sample of the sources that compile in the game: every 6th distinct source of the mesh, terrain, water, portrait and tree files
        const wanted = /^(pdxmesh|court_scene|tree|pdxterrain|pdxwater|pdxborder|jomini\/portrait|pdxmesh_decal|river_surface)\.shader$/;
        const pool = allUnits(lib, (rel) => wanted.test(rel));
        const distinct = [...new Map(pool.map((u) => [u.sig, u])).values()];
        const sample = distinct.filter((_, i) => i % 6 === 0);
        const t = performance.now();
        const reports = await verifyUnits(sample, { cacheDir });
        const failing = reports.filter((r) => r.compile.ok !== true || r.findings.length);
        note(`game sample: ${sample.length} of ${distinct.length} distinct sources of ${pool.length} stage sources in the sampled files`);
        report(failing.length === 0, `the game's own effects: ${sample.length} sampled stage sources compile (${Math.round(performance.now() - t)} ms)`,
            failing.slice(0, 5).map((r) => `${r.unit.file}:${r.unit.effect.name} ${r.unit.stage}: ${r.compile.errors.map((e) => e.code + ' ' + e.msg).join('; ')} ${kinds(r.findings)}`).join('\n'));
    }
}
else
    console.log('(no game install found: the checks on the game\'s own effects were left out)');

// ---------------------------------------------------------------------------------------------------------------------
// 3 and 4. The shader cache of a game run
// ---------------------------------------------------------------------------------------------------------------------

/** the defines of a cached source that the effect (and the mesh) supplied, without the ones the engine always adds */
function cachedDefines(text: string): string[]
{
    const head = text.slice(0, text.indexOf('// === HLSL Macros'));
    return [...head.matchAll(/^#define (.+)$/gm)].map((m) => m[1])
        .filter((d) => !/^(PDX_DIRECTX_11|VERTEX_SHADER|PIXEL_SHADER|PDX_HLSL|VENDOR_NVIDIA|PDX_MAX_HEIGHTMAP_COMPRESS_LEVELS 5|PDX_MAX_DETAIL_TEXTURES 256|JOMINI_REFRACTION_ENABLED|PDX_WINDOWS)$/.test(d));
}

/** the text without blank lines, indentation and the comment line the model drops; buffer textures in name order */
function normalized(s: string): string[]
{
    const lines = s.split('\n').map((l) => l.trim()).filter((l) => l && l !== '// Winter;');
    const isBuf = (l: string): boolean => /^PdxBuffer\w+ \w+;$/.test(l);
    return [...lines.filter((l) => !isBuf(l)), ...lines.filter(isBuf).sort()];
}

interface Cached
{
    stage: 'vs' | 'ps';
    hex: string;
    text: string;
    file: string;
    effect: string;
    game: boolean;
}

function readCache(dir: string, per?: number): Cached[]
{
    const out: Cached[] = [];

    for (const stage of ['vs', 'ps'] as const)
    {
        const d = join(dir, `${stage}_5_0`);

        if (!existsSync(d))
            continue;

        const all = readdirSync(d).filter((n) => n.endsWith('.scache')).sort();
        const step = per ? Math.max(1, Math.floor(all.length / per)) : 1;

        for (let i = 0; i < all.length; i += step)
        {
            const text = readFileSync(join(d, all[i]), 'utf8');
            const file = /Shader file: (\S+)/.exec(text)?.[1];
            const effect = /Effect: (\S+)/.exec(text)?.[1];

            if (file && effect)
                out.push({ stage, hex: all[i].replace('.scache', ''), text, file, effect, game: existsSync(join(d, all[i].replace('.scache', '.bin'))) });
        }
    }

    return out;
}

/** the unit that reproduces a cached source, and whether its text is the cached text */
function reproduce(lib: ShaderLibrary, c: Cached): { unit?: HlslUnit; same: boolean; }
{
    const r = generateHlsl({ lib, file: c.file, effect: c.effect, stage: c.stage, defines: cachedDefines(c.text), salt: 'cache' });

    if ('error' in r)
        return { same: false };

    const a = normalized(c.text);
    const b = normalized(r.source);
    return { unit: r, same: a.length === b.length && a.every((l, i) => l === b[i]) };
}

if (gameDir && compiler)
{
    const cache = process.env.SHADERCACHE ?? join(homedir(), 'Documents', 'Paradox Interactive', 'Crusader Kings III', 'shadercache', 'dx11');
    const lib = new ShaderLibrary(gameDir);

    if (existsSync(cache))
    {
        const sample = readCache(cache, Number(process.env.SAMPLE ?? 40));
        const same = sample.map((c) => ({ c, r: reproduce(lib, c) })).filter((x) => x.r.same);
        console.log(`(shader cache ${cache}: ${same.length} of ${sample.length} sampled sources are reproduced by the game's files alone; the rest came from other game versions or mods)`);

        if (same.length)
        {
            const res = await compileHlsl(same.map((x) => ({ source: x.r.unit!.source, stage: x.c.stage })), { cacheDir });
            const wrong = same.filter((x, i) => res[i].ok !== x.c.game);
            report(wrong.length === 0, `the shader cache: the verdict equals the game's on ${same.length} reproduced sources`, wrong.slice(0, 5).map((x) => x.c.hex).join(' '));
        }
    }
    else
        console.log('(no shader cache: the comparison with the game\'s cache was left out)');
}

const runDir = process.env.HLSL_RUN;

if (gameDir && compiler && runDir && existsSync(join(runDir, 'shadercache')))
{
    const mods = (process.env.HLSL_MODS ?? '').split(';').filter(Boolean);
    const lib = layeredLibrary(gameDir, mods);
    const cached = readCache(join(runDir, 'shadercache'));
    const repro = cached.map((c) => ({ c, r: reproduce(lib, c) }));
    const differing = repro.filter((x) => !x.r.same);
    report(differing.length === 0, `the run: the generated text equals the cached text for ${cached.length - differing.length} of ${cached.length} sources`, differing.slice(0, 5).map((x) => `${x.c.stage} ${x.c.hex} ${x.c.effect}`).join('\n'));
    const res = await compileHlsl(repro.filter((x) => x.r.unit).map((x) => ({ source: x.r.unit!.source, stage: x.c.stage })), { cacheDir });
    const units = repro.filter((x) => x.r.unit);
    const wrong = units.filter((x, i) => res[i].ok !== x.c.game);
    const failing = units.filter((x) => !x.c.game).length;
    report(wrong.length === 0, `the run: the verdict equals the game's on ${units.length} sources (${failing} fail, ${units.length - failing} pass)`, wrong.slice(0, 5).map((x) => x.c.hex).join(' '));
    note(`run: ${units.length} cached stages, text equal ${cached.length - differing.length}, verdicts equal ${units.length - wrong.length}, failing in the game ${failing}, failing here ${res.filter((r) => r.ok === false).length}`);

    // the messages of the game's error.log: `<path>/<hex>.scache(line,col): error Xnnnn: message`
    const logFile = join(runDir, 'logs', 'error.log');

    if (existsSync(logFile))
    {
        const log = readFileSync(logFile, 'utf8');
        const inLog = new Map<string, Set<string>>();

        for (const m of log.matchAll(/([0-9A-F]{16})\.scache\(\d+,[\d-]+\): error (X\d+): ([^\r\n]*)/g))
            inLog.set(m[1], (inLog.get(m[1]) ?? new Set()).add(`${m[2]} ${m[3].trim()}`));

        let compared = 0;
        const mismatch: string[] = [];

        units.forEach((x, i) =>
        {
            const said = inLog.get(x.c.hex);

            if (!said)
                return;

            compared++;
            const mine = new Set(res[i].errors.map((e) => `${e.code} ${e.msg}`));

            if (![...said].every((s) => mine.has(s)))
                mismatch.push(`${x.c.hex}: log ${[...said].join(' | ')}; here ${[...mine].join(' | ')}`);
        });
        note(`run: error.log messages compared on ${compared} failing stages`);
        report(compared > 0 && mismatch.length === 0, `the run: the compiler's messages equal error.log's on ${compared} failing sources`, mismatch.slice(0, 5).join('\n'));

        // the builder's errors: "Texture Samplers have same binding index. 'Name: X', 'Ref Index: N'" while the engine builds a stage
        const pairs = new Set([...log.matchAll(/Texture Samplers have same binding index\. 'Name: (\w+)', 'Ref Index: (\d+)'/g)].map((m) => m[1] + '/' + m[2]));
        const t = performance.now();
        const merged = allUnits(lib, (rel) => !/^jomini\/(mapeditor|ssao)/.test(rel) && /(pdxmesh|court_scene|tree|pdxwater|pdxmesh_decal|river_surface|river_bottom)\.shader$/.test(rel));
        const found = merged.flatMap((u) => staticFindings(u));
        const builderPairs = new Set(found.filter((f) => f.id !== undefined).map((f) => f.name + '/' + f.id));
        const codes = new Set(found.map((f) => f.code));
        note(`run: ${[...pairs].join(' ')} in the engine builder's errors; ${builderPairs.size} name / id pairs found by the static checks, finding codes ${[...codes].join(' ')}`);
        const missed = [...pairs].filter((n) => !builderPairs.has(n));
        report(pairs.size > 0 && missed.length === 0, `the run: the static checks find all ${pairs.size} sampler / texture id pairs the engine's builder names (${Math.round(performance.now() - t)} ms over ${merged.length} stage sources)`, 'not found: ' + missed.join(', '));
        report(codes.has('X3003') && codes.has('X3508'), 'the run: the static checks find a member in two buffers and a field nobody writes', [...codes].join(' '));
    }

    // and the game's files alone give nothing
    const alone = allUnits(new ShaderLibrary(gameDir), (rel) => /(pdxmesh|court_scene|tree|pdxwater|pdxmesh_decal|river_surface|river_bottom)\.shader$/.test(rel));
    const aloneFound = alone.flatMap((u) => staticFindings(u));
    report(aloneFound.length === 0, `the same files from the game alone: no finding in ${alone.length} stage sources`, aloneFound.slice(0, 3).map((f) => f.message).join('\n'));
}

rmSync(tmp, { recursive: true, force: true });
console.log(`${count - bad} of ${count} checks passed${compiler ? '' : ' (no Direct3D compiler here: the compile checks were left out)'} in ${Math.round((performance.now() - started) / 1000)} s`);
process.exit(bad ? 1 : 0);
