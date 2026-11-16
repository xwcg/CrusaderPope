// The shader merge's rules on small files (no game needed): which copies of a mod stay as they are, what a kept copy means for
// the others, vertex struct fields, texture ids and sampler slots, and the check of the merged files with its repairs
// (shaderRule.ts verifiedShaderWork, shaders/mergeVerify.ts). The check runs with the static rules here (`compile: false`);
// the Direct3D compile is proven on the game's files and AGOT by scripts/shader-hlsl-check.ts and docs/shaders.md.
//
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings scripts/shader-merge-check.ts
import { addedDeclarations as added, isDeclarationNeutral } from '../src/main/mods/currency.ts';
import { disabledLines, mergeShaders, type FxMerged, type FxMergeResult } from '../src/main/mods/shaderMerge.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModInfo } from '../src/shared/api.ts';
import { fileRules } from '../src/main/mods/migrate.ts';
import type { Migration } from '../src/main/mods/migrations.ts';
import { adaptShaderCalls, callsToAdapt, definedWithOldParams } from '../src/main/mods/shaderCalls.ts';
import { borderEffectKeys, mergedAfterAll, shaderNotes, verifiedShaderWork, type ShaderInput } from '../src/main/mods/shaderRule.ts';
import type { EngineStrings } from '../src/main/mods/engineStrings.ts';
import { parseErrors } from '../src/main/shaders/d3d.ts';
import { textureIdOf, textureIdsKnownFor } from '../src/main/shaders/textureIds.ts';
import { samplerBindings } from '../src/main/shaders/hlslCheck.ts';

let bad = 0;
let count = 0;
const check = (ok: boolean, name: string, detail = ''): void =>
{
    count++;

    if (!ok)
    {
        bad++;
        console.log(`FAIL ${name}${detail ? '\n' + detail : ''}`);
    }
};

// ---------------------------------------------------------------------------------------------------------------------
// the engine's texture ids
// ---------------------------------------------------------------------------------------------------------------------

check(textureIdOf('0', undefined) === 69 && textureIdOf('31', undefined) === 100, 'Index n is the id 69 + n');
check(textureIdOf('32', undefined) === 101 && textureIdOf(undefined, 'PdxShadowmap') === 101, 'Index 32 is the id of PdxShadowmap');
check(textureIdOf(undefined, 'PdxTexture3') === 72 && textureIdOf(undefined, 'JominiRiver2') === 12, 'Ref names are ranges: PdxTexture3, JominiRiver2');
check(textureIdOf(undefined, 'JominiRiver3') === undefined && textureIdOf(undefined, 'Nothing') === undefined, 'a digit out of the range and an unknown name give no id');
check(textureIdOf('59', undefined) === undefined && textureIdOf('58', undefined) === 127, 'ids from 128 up are none (Index 59), 127 is the last (Index 58)');

// ---------------------------------------------------------------------------------------------------------------------
// the files
// ---------------------------------------------------------------------------------------------------------------------

/** minimal engine macros, so that the units built from these files are plain HLSL */
const MACROS = `#define PDX_COLOR SV_Target
#define PDX_POSITION SV_Position
struct PdxTextureSampler2D { Texture2D Texture; SamplerState Sampler; };
`;

const STRUCTS = `VertexStruct VS_IN
{
	float3 Position : POSITION;
};

VertexStruct VS_OUT
{
	float4 Position : PDX_POSITION;
};
`;

const MAIN_VS = `
VertexShader =
{
	MainCode VS
	{
		Input = "VS_IN"
		Output = "VS_OUT"
		Code
		[[
			PDX_MAIN
			{
				VS_OUT Out;
				Out.Position = float4( Input.Position, 1.0 );
				return Out;
			}
		]]
	}
}
`;

const PS = (name: string, body = 'return float4( 1.0, 1.0, 1.0, 1.0 );'): string => `	MainCode ${name}
	{
		Input = "VS_OUT"
		Output = "PDX_COLOR"
		Code
		[[
			PDX_MAIN
			{
				${body}
			}
		]]
	}
`;

const effect = (name: string, ps: string): string => `\nEffect ${name}\n{\n\tVertexShader = "VS"\n\tPixelShader = "${ps}"\n}\n`;

type Files = Record<string, string>;
const merge = (game: Files, mod: Files, restore: string[], opts: Parameters<typeof mergeShaders>[3] = {}, own: string[] = []): FxMergeResult => mergeShaders({ game: (k) => game[k], mod: (k) => mod[k] }, restore, own, opts);

const addedDeclarations = (g: string, m: string): string[] => added(g, m).map((x) => `${x.kind}:${x.name}`);

// ---------------------------------------------------------------------------------------------------------------------
// 1. a copy of the mod stays as it is only when it declares nothing the game's file does not
// ---------------------------------------------------------------------------------------------------------------------

{
    const game = `Includes = {\n\t"cw/a.fxh"\n}\n\nConstantBuffer( 5 )\n{\n\tfloat4 Tint;\n};\n\n${STRUCTS}\nPixelShader =\n{\n\tTextureSampler Tex\n\t{\n\t\tIndex = 1\n\t\tFile = "t.dds"\n\t}\n}\n`;
    const fn = game + '\nCode\n[[\n\tfloat ModFn( float x ) { return x; }\n]]\n';
    check(addedDeclarations(game, game).length === 0 && isDeclarationNeutral(game, game), 'the game’s own file adds nothing');
    check(addedDeclarations(game, fn).length === 0 && isDeclarationNeutral(game, fn), 'a function the copy adds is no declaration');
    check(addedDeclarations(game, game.replace('"cw/a.fxh"', '"cw/a.fxh"\n\t"mod_only.fxh"')).join() === 'include:mod_only.fxh', 'an include the game’s file lacks');
    check(addedDeclarations(game, game.replace('"cw/a.fxh"', '"CW/A.fxh"')).length === 0, 'the same include in other case is none');
    check(addedDeclarations(game, game + '\nConstantBuffer( 6 )\n{\n\tfloat4 Other;\n};\n').join() === 'cbuffer:6', 'a constant buffer the game’s file lacks');
    check(addedDeclarations(game, game.replace('PixelShader =\n{', 'PixelShader =\n{\n\tTextureSampler New\n\t{\n\t\tIndex = 2\n\t}\n')).join() === 'sampler:New', 'a texture sampler the game’s file lacks');
    check(addedDeclarations(game, game.replace('float3 Position : POSITION;', 'float3 Position : POSITION;\n\tfloat Extra : TEXCOORD0;')).join() === 'field:VS_IN.Extra', 'a field of a vertex struct the game’s has');
    check(!isDeclarationNeutral(game, game.replace('"cw/a.fxh"', '"cw/a.fxh"\n\t"mod_only.fxh"')), 'a copy that adds an include is not neutral');
    check(!isDeclarationNeutral(game, game.replace('ConstantBuffer( 5 )', 'ConstantBuffer( 7 )')), 'a copy lacking a definition of the game’s is not neutral either');
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. a kept copy is the file the engine loads
// ---------------------------------------------------------------------------------------------------------------------

{
    const gameInc = 'Code\n[[\n\tfloat GameFn( float x ) { return x; }\n]]\n';
    const modInc = gameInc + '\nCode\n[[\n\tfloat ModFn( float x ) { return x * 2.0; }\n]]\n';
    const gameShader = `Includes = {\n\t"inc.fxh"\n}\n\n${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${PS('PS')}}\n${effect('e', 'PS')}`;
    const modShader = gameShader.replace('PixelShader =\n{\n', `PixelShader =\n{\n${PS('PS_m', 'return float4( ModFn( 1.0 ), 0.0, 0.0, 1.0 );')}\n`) + effect('m', 'PS_m');
    const game = { 'game.shader': gameShader, 'inc.fxh': gameInc };
    const mod = { 'game.shader': modShader, 'inc.fxh': modInc };
    const kept = merge(game, mod, ['game.shader', 'inc.fxh'], { keep: ['inc.fxh'] });
    const g = kept.files.get('game.shader')!;
    check(g.notes.effects.join() === 'm' && !/float ModFn/.test(g.text), 'a kept copy’s function counts as present: the effect is carried, the function not again', g.text.slice(-400));
    check(kept.files.get('inc.fxh')!.text === modInc, 'a kept copy is the mod’s text as it is');
    const merged = merge(game, mod, ['game.shader', 'inc.fxh']);
    check(/float ModFn/.test(merged.files.get('inc.fxh')!.text) && !/float ModFn/.test(merged.files.get('game.shader')!.text), 'merged instead, the include carries the function (the other file demands it there)');
}

// ---------------------------------------------------------------------------------------------------------------------
// 3. a field of the mod’s vertex struct is added only when carried code writes it and no game function takes the struct as out / inout
// ---------------------------------------------------------------------------------------------------------------------

{
    const withExtra = STRUCTS.replace('float4 Position : PDX_POSITION;', 'float4 Position : PDX_POSITION;\n\tfloat Extra : TEXCOORD0;');
    const mainWrites = MAIN_VS.replace('Out.Position = float4( Input.Position, 1.0 );', 'Out.Position = float4( Input.Position, 1.0 );\n\t\t\t\tOut.Extra = 1.0;');
    const fin = '\nCode\n[[\n\tvoid Finalize( inout VS_OUT Out )\n\t{\n\t\tOut.Position = float4( 0.0, 0.0, 0.0, 1.0 );\n\t}\n]]\n';
    const base = (structs: string, vs: string, code = ''): string => `${structs}${code}${vs}\nPixelShader =\n{\n${PS('PS')}}\n${effect('e', 'PS')}`;
    // (the mod’s effect m has its own vertex main, which writes the field)
    const modVs = (vs: string): string => vs.replace('MainCode VS\n', 'MainCode VS_m\n') + '\n';
    const mod = (structs: string, vs: string): string => base(structs, vs) + `\nVertexShader =\n{\n${modVs(vs).replace(/^VertexShader =\n\{\n/, '').replace(/\}\n$/, '')}}\n\nPixelShader =\n{\n${PS('PS_m')}}\nEffect m\n{\n\tVertexShader = "VS_m"\n\tPixelShader = "PS_m"\n}\n`;

    // written by carried code: appended
    const a = merge({ 'g.shader': base(STRUCTS, MAIN_VS) }, { 'g.shader': mod(withExtra, mainWrites) }, ['g.shader']).files.get('g.shader')!;
    check(a.notes.fields.join() === 'VS_OUT.Extra' && /Extra : TEXCOORD0/.test(a.text) && a.notes.effects.join() === 'm', 'a field carried code writes is appended', JSON.stringify(a.notes));
    // not written by anything carried: left out
    const b = merge({ 'g.shader': base(STRUCTS, MAIN_VS) }, { 'g.shader': mod(withExtra, MAIN_VS) }, ['g.shader']).files.get('g.shader')!;
    check(b.notes.fields.length === 0 && b.notes.refused.join() === 'VS_OUT.Extra' && !/Extra/.test(b.text), 'a field no carried code writes is not appended', JSON.stringify(b.notes));
    // a game function takes the struct as inout: not appended, and the effect that writes it is left out
    const c = merge({ 'g.shader': base(STRUCTS, MAIN_VS, fin) }, { 'g.shader': mod(withExtra, mainWrites) }, ['g.shader']).files.get('g.shader')!;
    check(c.notes.fields.length === 0 && c.notes.refused.join() === 'VS_OUT.Extra' && !/Extra/.test(c.text), 'a field of a struct the game passes as inout is not appended', JSON.stringify(c.notes));
    check(c.notes.dropped.length === 1 && c.notes.dropped[0].name === 'm' && c.notes.dropped[0].reason.kind === 'field' && c.notes.dropped[0].reason.name === 'Extra', 'the effect that writes it is left out, with the field as the reason', JSON.stringify(c.notes.dropped));
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. samplers: the engine’s texture id (Index 32 is the shadow map), moving a File-bound one
// ---------------------------------------------------------------------------------------------------------------------

{
    const shadow = '\tTextureSampler ShadowTexture\n\t{\n\t\tRef = PdxShadowmap\n\t}\n';
    const game = `${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${shadow}${PS('PS')}}\n${effect('e', 'PS')}`;
    const modWith = (sampler: string): string => game.replace('PixelShader =\n{\n', `PixelShader =\n{\n${sampler}${PS('PS_m', 'return Mod.Texture.Sample( Mod.Sampler, float2( 0.0, 0.0 ) );')}\n`) + effect('m', 'PS_m');
    const file = merge({ 'g.shader': game }, { 'g.shader': modWith('\tTextureSampler Mod\n\t{\n\t\tIndex = 32\n\t\tFile = "mod.dds"\n\t}\n') }, ['g.shader']).files.get('g.shader')!;
    check(file.notes.effects.join() === 'm' && file.notes.moved.length === 1 && /Index = 31/.test(file.text) && !/Index = 32/.test(file.text), 'a File-bound sampler on Index 32 moves to the highest free Index', JSON.stringify(file.notes) + file.text.slice(-500));
    const free = merge({ 'g.shader': game }, { 'g.shader': modWith('\tTextureSampler Mod\n\t{\n\t\tIndex = 4\n\t\tFile = "mod.dds"\n\t}\n') }, ['g.shader']).files.get('g.shader')!;
    check(free.notes.effects.join() === 'm' && free.notes.moved.length === 0 && /Index = 4/.test(free.text), 'a sampler on a free Index stays');
    const fed = merge({ 'g.shader': game }, { 'g.shader': modWith('\tTextureSampler Mod\n\t{\n\t\tIndex = 32\n\t}\n') }, ['g.shader']).files.get('g.shader')!;
    check(fed.notes.effects.length === 0 && fed.notes.dropped[0]?.reason.kind === 'binding' && fed.notes.dropped[0].reason.name === 'Mod', 'a sampler the material feeds cannot move: its effect is left out (binding)', JSON.stringify(fed.notes.dropped));
    const ref = merge({ 'g.shader': game }, { 'g.shader': modWith('\tTextureSampler Mod\n\t{\n\t\tRef = PdxShadowmap\n\t}\n') }, ['g.shader']).files.get('g.shader')!;
    check(ref.notes.effects.length === 0 && ref.notes.dropped[0]?.reason.kind === 'binding', 'a Ref sampler on the game’s id cannot move either', JSON.stringify(ref.notes.dropped));
    const out = merge({ 'g.shader': game }, { 'g.shader': modWith('\tTextureSampler Mod\n\t{\n\t\tIndex = 70\n\t\tFile = "mod.dds"\n\t}\n') }, ['g.shader']).files.get('g.shader')!;
    check(out.notes.moved.length === 1 && /Index = 31/.test(out.text), 'an Index outside the engine’s ids moves too', JSON.stringify(out.notes));
    const crowded = merge({ 'g.shader': game }, { 'g.shader': modWith('\tTextureSampler Mod\n\t{\n\t\tIndex = 32\n\t\tFile = "mod.dds"\n\t}\n\tTextureSampler Other\n\t{\n\t\tIndex = 31\n\t\tFile = "other.dds"\n\t}\n') }, ['g.shader']).files.get('g.shader')!;
    check(crowded.notes.moved.length === 1 && /Index = 30/.test(crowded.text) && !/Index = 31/.test(crowded.text), 'a free slot the mod’s other samplers have is not taken', crowded.text.slice(-600));

    // past the engine's file slots (1.20.1.2: 32 of them, Index 0 to 31): a texture file on Index 36 has an id (105), but of no slot
    const past = merge({ 'g.shader': game }, { 'g.shader': modWith('\tTextureSampler Mod\n\t{\n\t\tIndex = 36\n\t\tFile = "mod.dds"\n\t}\n') }, ['g.shader']).files.get('g.shader')!;
    check(past.notes.effects.join() === 'm' && past.notes.moved.length === 0 && past.notes.movedPast.join() === 'Mod: 36 -> 31' && /Index = 31/.test(past.text) && !/Index = 36/.test(past.text), 'a texture file on an Index past the engine’s file slots (36) moves below them, with its own note', JSON.stringify(past.notes) + past.text.slice(-400));
    const last = merge({ 'g.shader': game }, { 'g.shader': modWith('\tTextureSampler Mod\n\t{\n\t\tIndex = 31\n\t\tFile = "mod.dds"\n\t}\n') }, ['g.shader']).files.get('g.shader')!;
    check(last.notes.effects.join() === 'm' && last.notes.moved.length + last.notes.movedPast.length === 0 && /Index = 31/.test(last.text), 'the last file slot (Index 31) stays');
    const fedPast = merge({ 'g.shader': game }, { 'g.shader': modWith('\tTextureSampler Mod\n\t{\n\t\tIndex = 36\n\t}\n') }, ['g.shader']).files.get('g.shader')!;
    check(fedPast.notes.effects.join() === 'm' && fedPast.notes.movedPast.length === 0 && /Index = 36/.test(fedPast.text), 'a sampler without a File on such an Index (the material feeds it) stays as before', JSON.stringify(fedPast.notes));
    const refFree = merge({ 'g.shader': game }, { 'g.shader': modWith('\tTextureSampler Mod\n\t{\n\t\tRef = PdxTexture5\n\t}\n') }, ['g.shader']).files.get('g.shader')!;
    check(refFree.notes.effects.join() === 'm' && refFree.notes.movedPast.length + refFree.notes.moved.length === 0 && /Ref = PdxTexture5/.test(refFree.text), 'a sampler bound by Ref on a free id stays as before');
    const unitOf = (...declared: { name: string; props: Record<string, string>; }[]): Parameters<typeof samplerBindings>[0] =>
        ({ declared: declared.map((d) => ({ ...d, kind: 'TextureSampler', stage: 'ps', file: 'g.shader' })) }) as unknown as Parameters<typeof samplerBindings>[0];
    const findings = samplerBindings(unitOf({ name: 'A', props: { Index: '36', File: 'a.dds' } }, { name: 'B', props: { Index: '31', File: 'b.dds' } }, { name: 'C', props: { Index: '37' } }));
    check(findings.length === 1 && findings[0].kind === 'binding' && findings[0].name === 'A', 'the check reports a texture file past the file slots as a binding (not the last slot, not one without a File)', JSON.stringify(findings));
}

// ---------------------------------------------------------------------------------------------------------------------
// 4b. value carry: the mod's value of a define or a sampler's File / Index goes into the game's text
// ---------------------------------------------------------------------------------------------------------------------

{
    const sampler = (file: string, index: number): string => `\tTextureSampler Env\n\t{\n\t\tIndex = ${index}\n\t\tFile = "${file}"\n\t}\n`;
    const body = (defs: string, smp: string): string => `${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${smp}\tCode\n\t[[\n${defs}\t]]\n${PS('PS')}}\n${effect('e', 'PS')}`;
    const game = body('\t\t#define Opacity 1.0f\t// the cloud opacity\n\t\t#define Tint float3( 0.4f, 0.4f, 0.7f )\n\t\t#define Same 2.0f\n', sampler('env_shadow.dds', 3));
    const mod = body('\t\t// #define Opacity 1.0f\n\t\t#define Opacity 0.0f\n\t\t#define Tint ModOnly * 2.0f\n\t\t#define ModOnly 5.0f\n\t\t#define Same 2.0f\n', sampler('env_sunny.dds', 3));
    const r = merge({ 'g.shader': game }, { 'g.shader': mod }, ['g.shader']).files.get('g.shader')!;
    check(/#define Opacity 0\.0f\s*\/\/ the cloud opacity \/\/ MOD-MERGE/.test(r.text) && r.notes.values.some((v) => v.name === 'Opacity' && v.mod === '0.0f' && v.game === '1.0f'), 'a define’s value of the mod goes into the game’s line', r.text);
    check(/#define Tint float3\( 0\.4f, 0\.4f, 0\.7f \)/.test(r.text) && !r.notes.values.some((v) => v.name === 'Tint') && r.notes.lost.includes('Tint'), 'a value naming something only the mod has is not carried (stays the game’s, listed)', JSON.stringify(r.notes));
    check(/File = "env_sunny\.dds"/.test(r.text) && !/env_shadow/.test(r.text.replace(/MOD-MERGE[^\n]*/g, '')) && r.notes.values.some((v) => v.name === 'Env File'), 'a sampler’s File of the mod goes into the game’s sampler', r.text);
    check(!r.notes.lost.includes('Opacity') && !r.notes.lost.includes('Env'), 'a carried value is not lost');
    const again = merge({ 'g.shader': r.text }, { 'g.shader': mod }, ['g.shader']).files.get('g.shader')!;
    check(again.notes.values.length === 0 && again.text.replace(/\n# MOD-MERGE: defin[\s\S]*$/, '') === r.text.replace(/\n# MOD-MERGE: defin[\s\S]*$/, '') && again.text === r.text.replace(/ \/\/ MOD-MERGE[^\n]*/g, (x) => x), 'merging the merged text again changes nothing', again.text);
    const idx = merge({ 'g.shader': game }, { 'g.shader': mod.replace('Index = 3', 'Index = 4') }, ['g.shader']).files.get('g.shader')!;
    check(/Index = 4/.test(idx.text) && idx.notes.values.some((v) => v.name === 'Env Index'), 'a free Index of the mod is carried');
}

// ---------------------------------------------------------------------------------------------------------------------
// 4c. the macros of an include of the mod’s own that overlay the game’s names: an early block in the game’s file, the functions
// they name carried, the include itself not added (what it brings along would declare the game’s names again)
// ---------------------------------------------------------------------------------------------------------------------

{
    const cam = 'ConstantBuffer( PdxCamera )\n{\n\tfloat3 CamPos;\n};\n';
    // (the mod's include: a copy of the camera buffer under other names, the macro at the top level and again in the pixel stage, and
    // an include of its own that declares the game's sampler a second time)
    const zoom = (top: string, ps = '\t#ifdef WIDGET\n\t\t#undef CamPos\n\t\t#define CamPos ZoomPosPixel()\n\t#endif\n'): string =>
        `Includes = {\n\t"cw/cam.fxh"\n\t"zoom_data.fxh"\n}\n\nConstantBuffer( PdxCamera )\n{\n\tfloat3 Cam_Pos;\n};\n\nCode\n[[\n${top}\tfloat3 ZoomPos() { return Cam_Pos * ZoomScale(); }\n]]\n\nPixelShader =\n{\n\tCode\n\t[[\n${ps}\t\tfloat3 ZoomPosPixel() { return ZoomPos(); }\n\t]]\n}\n`;
    const zoomData = 'PixelShader =\n{\n\tTextureSampler Shared\n\t{\n\t\tIndex = 3\n\t\tFile = "s.dds"\n\t}\n}\n\nCode\n[[\n\tfloat ZoomScale() { return 2.0; }\n]]\n';
    const flagged = '\t#ifdef WIDGET\n\t\t#define CamPos ZoomPos()\n\t#endif\n';
    const vs = MAIN_VS.replace('Out.Position = float4( Input.Position, 1.0 );', 'Out.Position = float4( Input.Position + CamPos, 1.0 );');
    const body = (inc: string, psCode = '', defines = ''): string => `Includes = {\n\t"cw/cam.fxh"\n${inc}\t"cw/other.fxh"\n}\n\n${STRUCTS}${vs}\nPixelShader =\n{\n\tTextureSampler Shared\n\t{\n\t\tIndex = 3\n\t\tFile = "g.dds"\n\t}\n${psCode}${PS('PS', 'return float4( CamPos, 1.0 );')}}\n\nEffect e\n{\n\tVertexShader = "VS"\n\tPixelShader = "PS"\n${defines}}\n`;
    const gameFiles: Files = { 'g.shader': body(''), 'cw/cam.fxh': cam, 'cw/other.fxh': 'Code\n[[\n\tfloat Other() { return 1.0; }\n]]\n' };
    const modFiles = (top: string, ps?: string): Files => ({ ...gameFiles, 'g.shader': body('\t"cw/zoom.fxh"\n', '', '\tDefines = { "WIDGET" }\n'), 'cw/zoom.fxh': zoom(top, ps), 'zoom_data.fxh': zoomData });
    const withMod = (top: string, ps?: string, gameShader = gameFiles['g.shader']): FxMergeResult => merge({ ...gameFiles, 'g.shader': gameShader }, modFiles(top, ps), ['g.shader']);
    const at = (t: string, s: string): number => t.indexOf(s);
    const over = withMod(flagged).files.get('g.shader')!;
    const early = over.text.slice(at(over.text, '# MOD-MERGE: the macros'), at(over.text, ']]') + 2);
    check(!/zoom\.fxh"/.test(over.text.slice(0, at(over.text, '}'))) && over.notes.overlays.join() === 'cw/zoom.fxh', 'the include itself is not added to the game’s Includes', over.text);
    check(at(over.text, '# MOD-MERGE: the macros') > at(over.text, '"cw/other.fxh"') && at(over.text, '# MOD-MERGE: the macros') < at(over.text, 'VertexStruct'), 'the macros are in an early block right after the Includes', over.text);
    check(/#ifndef PIXEL_SHADER\n\t#ifdef WIDGET\n\tfloat3 ZoomPos\(\);\n\t#define CamPos ZoomPos\(\)\n\t#endif\n\t#endif/.test(early), 'the vertex stage: the prototype and the macro, under the mod’s flag', early);
    check(/#ifdef PIXEL_SHADER\n\t#ifdef WIDGET\n\tfloat3 ZoomPosPixel\(\);\n\t#define CamPos ZoomPosPixel\(\)\n\t#endif\n\t#endif/.test(early) && !/ZoomPos\(\)\n[^]*#ifdef PIXEL_SHADER[^]*#define CamPos ZoomPos\(\)/.test(early), 'the pixel stage: the stage block’s redefinition is the one it sees (one macro per name and stage)', early);
    check(over.notes.macros.map((m) => `${m.name}:${m.stages.join('+')}`).join() === 'CamPos:vs+ps', 'the notes name the macro and its stages', JSON.stringify(over.notes.macros));
    const tail = over.text.slice(at(over.text, '# MOD-MERGE: definitions'));
    check(/float3 Cam_Pos;/.test(tail) && /float3 ZoomPos\(\) \{/.test(tail) && /float ZoomScale\(\) \{/.test(tail) && /float3 ZoomPosPixel\(\) \{/.test(tail), 'the functions the macros name, and what they need (the buffer copy, a function of the include’s own include), are carried below', tail);
    check(!/s\.dds/.test(over.text) && (over.text.match(/TextureSampler Shared/g) ?? []).length === 1, 'nothing the include’s own include declares that the game has is carried (the sampler stays once)', over.text);
    check(over.notes.flagged.join() === 'e' && over.notes.flags.join() === 'WIDGET' && /Effect e\n\{[^}]*Defines = \{ "WIDGET" \} # MOD-MERGE/.test(over.text), 'the game’s effect whose copy sets the flag gets it in its Defines', over.text.slice(at(over.text, 'Effect e')));
    check(!over.notes.lost.includes('e'), 'an effect that differed only by the flag lost nothing', JSON.stringify(over.notes.lost));

    // a clash: the game's code after the block declares the name in the pixel stage (a parameter of a function in a file the merge
    // writes): the parameter is renamed there, and the macro is written in that stage too
    const param = '\tCode\n\t[[\n\t\tfloat3 Light( in float3 CamPos ) { return CamPos; }\n\t]]\n';
    const renamed = withMod(flagged, undefined, body('', param)).files.get('g.shader')!;
    check(renamed.notes.macros.map((m) => `${m.name}:${m.stages.join('+')}`).join() === 'CamPos:vs+ps' && renamed.notes.macrosLeft.length === 0 && JSON.stringify(renamed.notes.renamed) === '[{"def":"Light","name":"CamPos","to":"CamPos_MOD_MERGE","kind":"parameter"}]', 'a parameter of the game’s function that declares the macro’s name is renamed, and the macro is written in that stage', JSON.stringify(renamed.notes));
    check(renamed.text.includes('float3 Light( in float3 CamPos_MOD_MERGE ) { return CamPos_MOD_MERGE; }') && /#ifdef PIXEL_SHADER\n\t#ifdef WIDGET\n\tfloat3 ZoomPosPixel\(\);\n\t#define CamPos ZoomPosPixel\(\)/.test(renamed.text), '... in its parameter list and body only (the whole word), the pixel stage’s macro in the early block', renamed.text.slice(0, 900));
    const renamedAgain = merge({ ...gameFiles, 'g.shader': renamed.text }, modFiles(flagged), ['g.shader']).files.get('g.shader')!;
    check(renamedAgain.text === renamed.text && renamedAgain.notes.renamed.length === 0 && renamedAgain.notes.macros.length === 0, 'merging the renamed text again changes nothing', renamedAgain.text.slice(0, 900));

    // what still blocks: a struct field (and the member access), a local declared after a use of the global, a declaration in a file the
    // merge does not write: not written in that stage, the vertex stage keeps it, and told
    const blocks = (psCode: string, extra: Files = {}): FxMerged => merge({ ...gameFiles, ...extra, 'g.shader': body('', psCode) }, { ...modFiles(flagged), ...extra }, ['g.shader']).files.get('g.shader')!;
    const field = blocks('\tCode\n\t[[\n\t\tstruct LightIn { float3 CamPos; };\n\t\tfloat3 Light( LightIn i ) { return i.CamPos; }\n\t]]\n');
    const late = blocks('\tCode\n\t[[\n\t\tfloat3 Light() { float3 a = CamPos; float3 CamPos = a * 2.0; return CamPos; }\n\t]]\n');
    const other = blocks('', { 'cw/other.fxh': 'PixelShader =\n{\n\tCode\n\t[[\n\t\tfloat3 Light( in float3 CamPos ) { return CamPos; }\n\t]]\n}\n' });

    for (const [label, x] of [['a struct field', field], ['a local declared after a use of the global', late], ['a parameter in a file the merge does not write', other]] as const)
        check(x.notes.macros.map((m) => `${m.name}:${m.stages.join('+')}`).join() === 'CamPos:vs' && x.notes.renamed.length === 0 && x.notes.macrosLeft.some((m) => m.name === 'CamPos' && m.stage === 'ps' && m.why === 'declared') && !/_MOD_MERGE/.test(x.text) && !/#ifdef PIXEL_SHADER/.test(x.text) && /#ifdef WIDGET\n\tfloat3 ZoomPos\(\);\n\t#define CamPos ZoomPos\(\)/.test(x.text), `${label} still blocks the macro in that stage (told), the other stage gets it`, JSON.stringify(x.notes.macrosLeft) + x.text.slice(0, 700));

    // only the pixel stage spells the name: its redefinition is written; merged again, the include's earlier macro (present only as
    // the shadowed one) does not take the pixel stage over
    const psOnlyGame = body('').replace('Input.Position + CamPos', 'Input.Position');
    const psOnly = withMod(flagged, undefined, psOnlyGame).files.get('g.shader')!;
    const psOnlyAgain = merge({ ...gameFiles, 'g.shader': psOnly.text }, modFiles(flagged), ['g.shader']).files.get('g.shader')!;
    check(psOnly.notes.macros.map((m) => `${m.name}:${m.stages.join('+')}`).join() === 'CamPos:ps' && /#define CamPos ZoomPosPixel\(\)/.test(psOnly.text) && psOnlyAgain.text === psOnly.text && psOnlyAgain.notes.macros.length === 0, 'a macro written for the pixel stage only: merging again changes nothing (the earlier macro of the name stays shadowed)', psOnlyAgain.text.slice(0, 900));

    // the same parameter in an include the merge writes too: renamed there (asked of that file; the passes repeat), the macro written
    const incText = 'PixelShader =\n{\n\tCode\n\t[[\n\t\tfloat3 Light( in float3 CamPos ) { return CamPos; }\n\t]]\n}\n';
    const both = merge({ ...gameFiles, 'cw/other.fxh': incText }, { ...modFiles(flagged), 'cw/other.fxh': incText.replace(/CamPos/g, 'Cam') }, ['g.shader', 'cw/other.fxh']);
    const inc = both.files.get('cw/other.fxh')!;
    const top = both.files.get('g.shader')!;
    check(inc.text === incText.replace(/CamPos/g, 'CamPos_MOD_MERGE') && JSON.stringify(inc.notes.renamed) === '[{"def":"Light","name":"CamPos","to":"CamPos_MOD_MERGE","kind":"parameter"}]' && top.notes.macros.map((m) => `${m.name}:${m.stages.join('+')}`).join() === 'CamPos:vs+ps' && top.notes.macrosLeft.length === 0, 'a parameter in an include the merge writes is renamed there (only the name), and the macro is written in that stage', inc.text + '\n' + JSON.stringify(top.notes));
    const bothAgain = merge({ ...gameFiles, 'cw/other.fxh': inc.text, 'g.shader': top.text }, { ...modFiles(flagged), 'cw/other.fxh': incText.replace(/CamPos/g, 'Cam') }, ['g.shader', 'cw/other.fxh']);
    check(bothAgain.files.get('cw/other.fxh')!.text === inc.text && bothAgain.files.get('g.shader')!.text === top.text, 'merging both written files again changes nothing');

    // no macro: no block; a macro without a condition that is no hook: no overlay
    const plain = withMod('', '').files.get('g.shader')!;
    check(plain.notes.overlays.length === 0 && !/MOD-MERGE: the macros/.test(plain.text) && plain.notes.flagged.length === 0, 'an include without such a macro gives no block (its definitions are carried by need only)');
    const unflagged = withMod('\t#define CamPos ZoomPos()\n', '').files.get('g.shader')!;
    check(unflagged.notes.overlays.length === 0, 'a macro without a condition is no overlay: it would change the game’s code in every build');

    // idempotence: the merged text merged again
    const again = merge({ ...gameFiles, 'g.shader': over.text }, modFiles(flagged), ['g.shader']).files.get('g.shader')!;
    check(again.notes.macros.length === 0 && again.notes.flagged.length === 0 && again.text === over.text, 'merging the merged text again changes nothing', again.text);

    // a define of the mod's that the game's side has as it is (a merged file has the mod's own defines carried in it) is no overlay
    const same = withMod(flagged, '', body('').replace('VertexStruct VS_IN', 'Code\n[[\n#ifdef WIDGET\n\t#define CamPos ZoomPos()\n#endif\n\tfloat3 ZoomPos() { return float3( 0.0, 0.0, 0.0 ); }\n]]\n\nVertexStruct VS_IN')).files.get('g.shader')!;
    check(same.notes.macros.length === 0 && same.notes.overlays.length === 0 && !/MOD-MERGE: the macros/.test(same.text), 'a macro the game’s side already defines the same way is no overlay', JSON.stringify(same.notes.macros));

    // a hook the game offers (#ifndef NAME / #define NAME …) pointed at the mod's function, without a condition: an overlay
    const hookGame = 'PixelShader =\n{\n\tCode\n\t[[\n\t\tfloat3 GameFog( float3 c ) { return c; }\n\t\t#ifndef ApplyFog\n\t\t#define ApplyFog GameFog\n\t\t#endif\n\t]]\n}\n';
    const fogInc = 'PixelShader =\n{\n\tCode\n\t[[\n\t\tfloat3 ModFog( float3 c, float s = 1.0 ) { return c * s; }\n\t\t#undef ApplyFog\n\t\t#define ApplyFog ModFog\n\t]]\n}\n';
    const fogBody = (inc: string): string => `Includes = {\n\t"fog.fxh"\n${inc}}\n\n${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${PS('PS', 'return float4( ApplyFog( float3( 1.0, 1.0, 1.0 ) ), 1.0 );')}}\n${effect('e', 'PS')}`;
    const hook = merge({ 'g.shader': fogBody(''), 'fog.fxh': hookGame }, { 'g.shader': fogBody('\t"modfog.fxh"\n'), 'fog.fxh': hookGame, 'modfog.fxh': fogInc }, ['g.shader']).files.get('g.shader')!;
    check(hook.notes.macros.map((m) => `${m.name}:${m.stages.join('+')}`).join() === 'ApplyFog:ps' && /#ifdef PIXEL_SHADER\n\tfloat3 ModFog\( float3 c, float s = 1\.0 \);\n\t#undef ApplyFog\n\t#define ApplyFog ModFog\n\t#endif/.test(hook.text) && /float3 ModFog\( float3 c, float s \) \{/.test(hook.text), 'a hook of the game’s pointed at the mod’s function: undefined first, the function carried, its default value in the prototype only (HLSL takes it in the first declaration only)', hook.text);

    // a hook the mod's copy no longer calls: its main calls a function of its own in that place, which reaches another hook of the
    // overlay: the game's call goes to that hook's target (if it fits); nothing in its place: the mod's macro is not written
    const twoHooks = 'PixelShader =\n{\n\tCode\n\t[[\n\t\tfloat3 GameFog( float3 c ) { return c; }\n\t\tfloat3 GameFogMS( float3 c ) { return c; }\n\t\t#ifndef ApplyFog\n\t\t#define ApplyFog GameFog\n\t\t#endif\n\t\t#ifndef ApplyFogMS\n\t\t#define ApplyFogMS GameFogMS\n\t\t#endif\n\t]]\n}\n';
    const modHooks = (fogType = 'float3'): string => `PixelShader =\n{\n\tCode\n\t[[\n\t\t${fogType} ModFog( ${fogType} c, float s = 1.0 ) { return c * s; }\n\t\tfloat3 ModFogMS( float3 c ) { return c * 0.5; }\n\t\t#undef ApplyFog\n\t\t#define ApplyFog ModFog\n\t\t#undef ApplyFogMS\n\t\t#define ApplyFogMS ModFogMS\n\t\tfloat3 ModWrap( float3 c, float k ) { return ApplyFog( c, k ); }\n\t]]\n}\n`;
    const msBody = (inc: string, step: string): string => `Includes = {\n\t"fog.fxh"\n${inc}}\n\n${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${PS('PS', `float3 x = float3( 1.0, 1.0, 1.0 );\n\t\t\t\t#ifdef FOG\n\t\t\t\t${step}\n\t\t\t\t#endif\n\t\t\t\tx = saturate( x );\n\t\t\t\treturn float4( x, 1.0 );`)}}\n${effect('e', 'PS')}`;
    const gameMs = msBody('', 'x = ApplyFogMS( x );');
    const withStep = (step: string, fogType?: string, gameShader = gameMs): FxMerged => merge({ 'g.shader': gameShader, 'fog.fxh': twoHooks }, { 'g.shader': msBody('\t"modfog.fxh"\n', step), 'fog.fxh': twoHooks, 'modfog.fxh': modHooks(fogType) }, ['g.shader']).files.get('g.shader')!;
    const mapped = withStep('x = ModWrap( x, 0.4 );');
    check(mapped.notes.macros.map((m) => `${m.name}:${m.stages.join('+')}`).join() === 'ApplyFogMS:ps' && /#ifdef PIXEL_SHADER\n\tfloat3 ModFog\( float3 c, float s = 1\.0 \);\n\t#undef ApplyFogMS\n\t#define ApplyFogMS ModFog\n\t#endif/.test(mapped.text) && /float3 ModFog\( float3 c, float s \) \{/.test(mapped.text) && !/ModFogMS|ModWrap/.test(mapped.text) && JSON.stringify(mapped.notes.remapped) === '[{"name":"ApplyFogMS","stage":"ps","target":"ModFog","via":"ModWrap","hook":"ApplyFog"}]', 'a hook the mod’s copy replaced with a call of its own function is pointed at the target of the hook that function reaches (and told)', JSON.stringify(mapped.notes) + mapped.text);
    const mappedAgain = withStep('x = ModWrap( x, 0.4 );', undefined, mapped.text);
    check(mappedAgain.text === mapped.text && mappedAgain.notes.macros.length === 0, 'merging the mapped text again changes nothing', mappedAgain.text);
    const still = withStep('x = ApplyFogMS( x );');
    check(still.notes.macros.map((m) => m.name).join() === 'ApplyFogMS' && /#define ApplyFogMS ModFogMS/.test(still.text) && still.notes.remapped.length === 0, 'a hook the mod’s copy still calls keeps the mod’s own target', still.text);
    const unfit = withStep('x = ModWrap( x, 0.4 );', 'float4');
    check(unfit.notes.macros.length === 0 && !/MOD-MERGE: the macros/.test(unfit.text) && unfit.notes.macrosLeft.some((m) => m.name === 'ApplyFogMS' && m.why === 'unfit' && m.def === 'ModWrap' && m.detail === 'ModFog'), 'a reached target that does not fit the game’s call (other types) gets no macro, and is told', JSON.stringify(unfit.notes));
    const dead = withStep('x = x * 0.5;');
    check(dead.notes.macros.length === 0 && !/MOD-MERGE: the macros/.test(dead.text) && dead.notes.macrosLeft.some((m) => m.name === 'ApplyFogMS' && m.why === 'unused' && m.detail === 'replaced'), 'a hook the mod’s copy dropped with nothing of its own in its place: the mod’s macro is not written, and told', JSON.stringify(dead.notes));
}

// ---------------------------------------------------------------------------------------------------------------------
// 4d. code for both stages that uses code written in one stage block only (the game's side has it in the other stage)
// ---------------------------------------------------------------------------------------------------------------------

{
    const inc = 'PixelShader =\n{\n\tCode\n\t[[\n\t\tfloat Base1( float x ) { return x; }\n\t]]\n}\n';
    const game = `Includes = {\n\t"inc.fxh"\n}\n\n${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${PS('PS')}}\n${effect('e', 'PS')}`;
    const vsM = MAIN_VS.replace('MainCode VS', 'MainCode VS_m').replace('float4( Input.Position, 1.0 )', 'float4( Input.Position * Use1( 1.0 ), 1.0 )');
    const mod = game.replace('VertexStruct VS_IN', 'Code\n[[\n\tfloat Base1( float x ) { return x; }\n\tfloat Use1( float x ) { return Base1( x ); }\n]]\n\nVertexStruct VS_IN') + vsM + `\nPixelShader =\n{\n${PS('PS_m', 'return float4( Use1( 1.0 ), 0.0, 0.0, 1.0 );')}}\n\nEffect m\n{\n\tVertexShader = "VS_m"\n\tPixelShader = "PS_m"\n}\n`;
    const r = merge({ 'g.shader': game, 'inc.fxh': inc }, { 'g.shader': mod, 'inc.fxh': inc }, ['g.shader']).files.get('g.shader')!;
    const tail = r.text.slice(r.text.indexOf('# MOD-MERGE: definitions'));
    const vsBlock = tail.slice(tail.indexOf('VertexShader ='), tail.indexOf('PixelShader ='));
    check(r.notes.effects.join() === 'm' && (tail.match(/float Use1\(/g) ?? []).length === 2 && vsBlock.indexOf('float Base1(') >= 0 && vsBlock.indexOf('float Base1(') < vsBlock.indexOf('float Use1(') && !/^Code\n\[\[[^\]]*Use1/m.test(tail), 'a function for both stages that uses one written in the vertex block only (the pixel stage has it from an include) is written in each stage block, after it', tail);
}

// ---------------------------------------------------------------------------------------------------------------------
// 4e. a file the game's border renderer draws with keeps the game's text (no overlay, no carried code, sampler or effect); the
// border settings name the files
// ---------------------------------------------------------------------------------------------------------------------

{
    const hookGame = 'PixelShader =\n{\n\tCode\n\t[[\n\t\tfloat3 GameFog( float3 c ) { return c; }\n\t\t#ifndef ApplyFog\n\t\t#define ApplyFog GameFog\n\t\t#endif\n\t]]\n}\n';
    const fogInc = 'PixelShader =\n{\n\tTextureSampler FogNoise\n\t{\n\t\tIndex = 30\n\t\tFile = "noise.dds"\n\t}\n\tCode\n\t[[\n\t\tfloat3 ModFog( float3 c ) { return c * FogNoise.Texture.Sample( FogNoise.Sampler, float2( 0.0, 0.0 ) ).rgb; }\n\t\t#undef ApplyFog\n\t\t#define ApplyFog ModFog\n\t]]\n}\n';
    const body = (inc: string, extra = ''): string => `Includes = {\n\t"fog.fxh"\n${inc}}\n\n${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${PS('PS', 'return float4( ApplyFog( float3( 1.0, 1.0, 1.0 ) ), 1.0 );')}}\n${effect('e', 'PS')}${extra}`;
    const modEffect = `\nPixelShader =\n{\n${PS('PS_m')}}\n${effect('m', 'PS_m')}`;
    const game: Files = { 'pdxborder.shader': body(''), 'terrain.shader': body(''), 'fog.fxh': hookGame };
    const mod: Files = { 'pdxborder.shader': body('\t"modfog.fxh"\n', modEffect), 'terrain.shader': body('\t"modfog.fxh"\n'), 'fog.fxh': hookGame, 'modfog.fxh': fogInc };
    const both = ['pdxborder.shader', 'terrain.shader'];
    const r = merge(game, mod, both, { borders: new Set(['pdxborder.shader']) });
    const border = r.files.get('pdxborder.shader')!;
    const terrain = r.files.get('terrain.shader')!;
    check(border.text === game['pdxborder.shader'] && border.text === border.game, 'a border file keeps the game’s text (no early block, no fog code, no sampler, no effect of the mod)', border.text);
    check(JSON.stringify(border.notes.border) === '{"macros":["ApplyFog"],"overlays":["modfog.fxh"],"effects":["m"],"others":1}' && border.notes.macros.length === 0 && border.notes.effects.length === 0 && border.notes.carried.length === 0, 'its notes tell what the mod’s copy would have brought: the macro, its include, the effect (its main counts as another definition)', JSON.stringify(border.notes));
    check(terrain.notes.macros.map((m) => m.name).join() === 'ApplyFog' && /#define ApplyFog ModFog/.test(terrain.text) && /TextureSampler FogNoise/.test(terrain.text) && !terrain.notes.border, 'a terrain file of the same merge still gets the overlay (macro, function, sampler)', terrain.text);
    const plain = merge(game, mod, both).files.get('pdxborder.shader')!;
    check(plain.notes.macros.map((m) => m.name).join() === 'ApplyFog' && plain.notes.effects.join() === 'm' && !plain.notes.border, 'without the border option the same file gets the overlay and the effect (the control)', JSON.stringify(plain.notes));
    const again = merge({ ...game, 'pdxborder.shader': border.text, 'terrain.shader': terrain.text }, mod, both, { borders: new Set(['pdxborder.shader']) });
    check(again.files.get('pdxborder.shader')!.text === border.text && again.files.get('terrain.shader')!.text === terrain.text, 'merging the written files again changes nothing');

    // which files: the default when a type has no `shader = …`, a `shader = …` override, an `effect = …` the type's file does not
    // define (found in another file), the vertical borders' shader_file; a vertical type adds nothing itself
    const effects: Record<string, string[]> = { 'pdxborder.shader': ['PdxBorder', 'PdxBorderWar'], 'myborder.shader': ['MyBorder'], 'other.shader': ['Elsewhere'], 'pdxverticalborder.shader': ['legend_vertical_border'] };
    const defines = (k: string, e: string): boolean => (effects[k] ?? []).includes(e);
    const find = (e: string): string | undefined => Object.keys(effects).find((k) => defines(k, e));
    const settings = '# comment = { shader = "gfx/FX/no.shader" }\nprovince = { texture = "p.dds" zoom_max = 10 }\nmy_realm = "r.dds"\nat_war = {\n\ttexture = "w.dds"\n\teffect = "PdxBorderWar"\n}\nlegend = {\n\tvertical = yes\n}\n';
    const vertical = '@height = 80.0\nlegend = {\n\theight = @height\n\tshader_file = "gfx/FX/pdxverticalborder.shader"\n\teffectname = "legend_vertical_border"\n}\n';
    check(borderEffectKeys(settings, vertical, defines, find).join() === 'pdxborder.shader,pdxverticalborder.shader', 'the game’s settings: the default file and the vertical borders’ file', borderEffectKeys(settings, vertical, defines, find).join());
    const over = settings + 'mod_type = { texture = "m.dds" shader = "gfx/FX/myborder.shader" effect = "MyBorder" }\nlost = { texture = "l.dds" effect = "Elsewhere" }\n';
    check(borderEffectKeys(over, undefined, defines, find).join() === 'myborder.shader,other.shader,pdxborder.shader', 'a shader = override is a border file; an effect its file lacks is looked for elsewhere', borderEffectKeys(over, undefined, defines, find).join());
    check(borderEffectKeys(undefined, undefined, defines, find).join() === 'pdxborder.shader' && borderEffectKeys('only = { texture = "o.dds" shader = "gfx/FX/myborder.shader" }\n', undefined, defines, find).join() === 'myborder.shader', 'no settings: the default; every type with its own file: not the default');
}

// ---------------------------------------------------------------------------------------------------------------------
// 4f. disabled-line carry: in a definition that stays the game's, the statements the mod's copy commented out are commented out in
// the game's text too: not a replacement, not a declaration whose name stays in use, not a line with other tokens
// ---------------------------------------------------------------------------------------------------------------------

{
    const main = (lines: string[]): string => `${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${PS('PS', lines.join('\n\t\t\t\t'))}}\n${effect('e', 'PS')}`;
    const gameLines = ['float3 c = float3( 1.0, 1.0, 1.0 );', 'float2 UV2 = float2( 0.5, 0.5 );', 'c *= 0.1;', 'UV2 += 0.25;', 'return float4( c * UV2.x, 1.0 );'];
    const game = main(gameLines);
    const one = (modLines: string[]): FxMerged => merge({ 'g.shader': game }, { 'g.shader': main(modLines) }, ['g.shader']).files.get('g.shader')!;
    // (the mod's copy also adds a line of its own, so that the definition stays the game's)
    const carried = one(['float3 c = float3( 1.0, 1.0, 1.0 );', 'float k = 2.0;', 'float2 UV2 = float2( 0.5, 0.5 );', '// MOD(x)', '//c *= 0.1;', '// END MOD', 'UV2 += 0.25;', 'return float4( c * UV2.x, 1.0 );']);
    check(carried.text.includes("\t\t\t\t// MOD-MERGE: the mod's copy disables this line: `c *= 0.1;`\n") && !/^\s*c \*= 0\.1;/m.test(carried.text) && JSON.stringify(carried.notes.disabled) === '[{"def":"PS","key":"main:ps:PS","lines":["c *= 0.1;"]}]' && carried.notes.lost.includes('PS'), 'a statement the mod’s copy commented out is commented out in the game’s definition too (with the marker; the definition’s other change stays lost)', carried.text + JSON.stringify(carried.notes));
    check(carried.text.replace(/\t\t\t\t\/\/ MOD-MERGE: [^\n]*\n/, '\t\t\t\tc *= 0.1;\n') === game, 'nothing else of the game’s text changes');
    const again = merge({ 'g.shader': carried.text }, { 'g.shader': main(['float3 c = float3( 1.0, 1.0, 1.0 );', 'float k = 2.0;', 'float2 UV2 = float2( 0.5, 0.5 );', '//c *= 0.1;', 'UV2 += 0.25;', 'return float4( c * UV2.x, 1.0 );']) }, ['g.shader']).files.get('g.shader')!;
    check(again.text === carried.text && again.notes.disabled.length === 0, 'merging the written text again changes nothing', again.text);
    const only = one(['float3 c = float3( 1.0, 1.0, 1.0 );', 'float2 UV2 = float2( 0.5, 0.5 );', '//c *= 0.1;', 'UV2 += 0.25;', 'return float4( c * UV2.x, 1.0 );']);
    check(only.notes.disabled.length === 1 && !only.notes.lost.includes('PS'), 'a definition that differed only by the disabled line is no longer lost', JSON.stringify(only.notes));

    // a declaration whose name a line the game's keeps still uses (the mod changed that line): it and the carried lines that use it stay
    const used = one(['float3 c = float3( 1.0, 1.0, 1.0 );', '//float2 UV2 = float2( 0.5, 0.5 );', 'c *= 0.1;', '//UV2 += 0.25;', 'return float4( c, 1.0 );']);
    check(used.text === game && used.notes.disabled.length === 0 && JSON.stringify(used.notes.disabledLeft.map((x) => `${x.why}:${x.name}:${x.line}`)) === '["used:UV2:float2 UV2 = float2( 0.5, 0.5 );","used:UV2:UV2 += 0.25;"]', 'a disabled declaration whose name a live line of the game’s uses is not carried, nor its uses (told)', JSON.stringify(used.notes.disabledLeft) + used.text);
    check(shaderNotes({ files: new Map([['gfx/FX/g.shader', { data: Buffer.alloc(0), hash: '', game: '', carries: true, notes: used.notes }]]), mod: '', unserved: [] }).some((n) => n.startsWith('gfx/FX/g.shader: 2 lines the mod’s copy disabled stay live') && n.includes('`UV2 += 0.25;` (UV2)')), 'the notes say why they stay live');

    // a game line with other tokens, a replacement of the mod's own, control flow: untouched
    const other = one(['float3 c = float3( 1.0, 1.0, 1.0 );', 'float k = 2.0;', 'float2 UV2 = float2( 0.5, 0.5 );', '//c *= 0.2;', 'UV2 += 0.25;', 'return float4( c * UV2.x, 1.0 );']);
    check(other.text === game && other.notes.disabled.length === 0, 'a game line with other tokens than the disabled one is not touched', other.text);
    const replaced = one(['float3 c = float3( 1.0, 1.0, 1.0 );', 'float2 UV2 = float2( 0.5, 0.5 );', '//c *= 0.1;', 'c *= 0.5;', 'UV2 += 0.25;', 'return float4( c * UV2.x, 1.0 );']);
    check(replaced.text === game && replaced.notes.disabled.length === 0 && replaced.notes.disabledLeft.map((x) => `${x.why}:${x.name}`).join() === 'replaced:c', 'a disabled line the mod replaced with one of its own (the same target) is not carried: the game’s line stays', JSON.stringify(replaced.notes.disabledLeft));
    const before = one(['float3 c = float3( 1.0, 1.0, 1.0 );', 'float2 UV2 = float2( 0.5, 0.5 );', 'c = c * 0.5 +', '\t0.1;', '//c *= 0.1;', 'UV2 += 0.25;', 'return float4( c * UV2.x, 1.0 );']);
    check(before.text === game && before.notes.disabledLeft.map((x) => x.why).join() === 'replaced', 'so is one the mod replaced just before it (a statement over two lines)', before.text);
    const ret = disabledLines(main(['float3 c = 1.0;', 'return float4( c, 1.0 );']), main(['float3 c = 1.0;', '//return float4( c, 1.0 );', 'return float4( c, 0.5 );']));
    const twice = disabledLines(main(['c *= 0.1;', 'c *= 0.1;']), main(['//c *= 0.1;', 'c *= 0.1;']));
    check(ret.lines.length === 0 && twice.lines.length === 0, 'a disabled return, and a line the game has twice (or the mod keeps live), are not carried', JSON.stringify([ret, twice]));
}

// ---------------------------------------------------------------------------------------------------------------------
// 4g. a border file's vertex-stage additions: the plain statements the mod's copy adds to a vertex main on the game's own names are
// carried into the game's text; a field or function only the mod has, a preprocessor condition, an unclear place: not; pixel mains stay
// ---------------------------------------------------------------------------------------------------------------------

{
    const cam = 'ConstantBuffer( Cam )\n{\n\tfloat3 CameraPosition;\n};\n\n';
    const vsMain = (lines: string[]): string => `\nVertexShader =\n{\n\tMainCode VS\n\t{\n\t\tInput = "VS_IN"\n\t\tOutput = "VS_OUT"\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t\t${lines.join('\n\t\t\t\t')}\n\t\t\t}\n\t\t]]\n\t}\n}\n`;
    const file = (structs: string, vs: string[], ps: string, extra = ''): string => `${cam}${structs}${extra}${vsMain(vs)}\nPixelShader =\n{\n${PS('PS', ps)}}\n${effect('e', 'PS')}`;
    const gameVs = ['VS_OUT Out;', 'float3 position = Input.Position;', 'position.y += 1.0;', 'Out.Position = float4( position, 1.0 );', 'return Out;'];
    const lift = ['// MOD(x)', 'position += 5.0f*normalize(CameraPosition - position);', 'position.y += 0.5f;', '// END MOD'];
    const modStructs = STRUCTS.replace('float4 Position : PDX_POSITION;', 'float4 Position : PDX_POSITION;\n\tfloat Extra : TEXCOORD0;');
    const modFn = '\nVertexShader =\n{\n\tCode\n\t[[\n\t\tfloat ModLift( float x ) { return x * 2.0; }\n\t]]\n}\n';
    const game = file(STRUCTS, gameVs, 'return float4( 1.0, 1.0, 1.0, 1.0 );');
    const modVs = ['VS_OUT Out;', 'float3 position = Input.Position;', 'position.x += ModLift( 1.0 );', 'position.y += 1.0;', ...lift, 'Out.Position = float4( position, 1.0 );', 'Out.Extra = ModLift( position.x );', 'return Out;'];
    const mod = file(modStructs, modVs, 'return float4( 0.5, 0.5, 0.5, 1.0 );', modFn);
    const border = (g: string, m: string): FxMerged => merge({ 'pdxborder.shader': g }, { 'pdxborder.shader': m }, ['pdxborder.shader'], { borders: new Set(['pdxborder.shader']) }).files.get('pdxborder.shader')!;
    const b = border(game, mod);
    const marker = (l: string): string => `\t\t\t\t// MOD-MERGE: the mod's line carried: \`${l}\`\n\t\t\t\t${l}\n`;
    check(b.text.includes('\t\t\t\tposition.y += 1.0;\n' + marker('position += 5.0f*normalize(CameraPosition - position);') + marker('position.y += 0.5f;') + '\t\t\t\tOut.Position') && JSON.stringify(b.notes.vertexLines) === '[{"def":"VS","key":"main:vs:VS","lines":["position += 5.0f*normalize(CameraPosition - position);","position.y += 0.5f;"]}]', 'a border file: the two statements the mod’s copy adds to the vertex main on the game’s names are carried after the line before them, with markers', b.text + JSON.stringify(b.notes.vertexLines));
    check(b.text.replace(marker('position += 5.0f*normalize(CameraPosition - position);') + marker('position.y += 0.5f;'), '') === game, 'the written file is the game’s plus the carried lines: the pixel main, the struct and everything else stay the game’s', b.text);
    check(JSON.stringify(b.notes.vertexLeft.map((x) => `${x.why}:${x.name}`)) === '["name:ModLift","field:Extra"]' && b.notes.lost.includes('VS') && !!b.notes.border, 'a statement naming a function or a field only the mod has is not carried, and told why', JSON.stringify(b.notes.vertexLeft));
    const again = border(b.text, mod);
    check(again.text === b.text && again.notes.vertexLines.length === 0, 'merging the written file again changes nothing', again.text);
    const only = border(game, file(STRUCTS, ['VS_OUT Out;', 'float3 position = Input.Position;', 'position.y += 1.0;', ...lift, 'Out.Position = float4( position, 1.0 );', 'return Out;'], 'return float4( 1.0, 1.0, 1.0, 1.0 );'));
    check(only.notes.vertexLines.length === 1 && !only.notes.lost.includes('VS'), 'a vertex main that differed only by the carried lines is no longer lost', JSON.stringify(only.notes));
    const plain = merge({ 'pdxborder.shader': game }, { 'pdxborder.shader': mod }, ['pdxborder.shader']).files.get('pdxborder.shader')!;
    check(plain.notes.vertexLines.length === 0 && !plain.notes.border, 'not in a file that is no border file (the merge keeps the game’s main there, as before)', JSON.stringify(plain.notes.vertexLines));

    // under a preprocessor condition of the mod's; a run with a line that cannot be carried; a new local; a place the game has twice
    const vs = (add: string[], at = 2, base = gameVs): string => file(STRUCTS, [...base.slice(0, at + 1), ...add, ...base.slice(at + 1)], 'return float4( 1.0, 1.0, 1.0, 1.0 );');
    const pp = border(game, vs(['#ifdef DEMO', 'position.y += 0.5f;', '#endif']));
    const run = border(game, vs(['position.y += 0.5f;', 'position.z += ModLift( 1.0 );']));
    const local = border(game, vs(['float lift = 0.5f;']));
    const twiceVs = [...gameVs.slice(0, 3), 'position.y += 1.0;', ...gameVs.slice(3)];
    const twice = border(file(STRUCTS, twiceVs, 'return float4( 1.0, 1.0, 1.0, 1.0 );'), vs(['position.y += 0.5f;'], 3, twiceVs));
    check([pp, run, local, twice].every((x) => x.notes.vertexLines.length === 0 && x.text === x.game) && JSON.stringify([pp, run, local, twice].map((x) => x.notes.vertexLeft.map((y) => `${y.why}:${y.name}`).join())) === '["preprocessor:","with:,name:ModLift","target:lift","place:"]', 'not carried: a line under the mod’s #ifdef, a passing line beside one that fails (the place goes whole or not at all), a new local, a line after one the game has twice', JSON.stringify([pp, run, local, twice].map((x) => x.notes.vertexLeft)));
    const notes = shaderNotes({ files: new Map([['gfx/FX/pdxborder.shader', { data: Buffer.alloc(0), hash: '', game: '', carries: true, notes: b.notes }]]), mod: '', unserved: [] });
    check(notes.some((n) => n.startsWith('gfx/FX/pdxborder.shader: 2 lines the mod’s copy adds to the vertex stage are carried into the game’s file') && n.includes('`position.y += 0.5f;`')) && notes.some((n) => n.startsWith('gfx/FX/pdxborder.shader: the game’s border renderer draws with this file') && n.includes('2 lines the mod’s copy adds to the vertex stage — VS: `position.x += ModLift( 1.0 );` (ModLift, which the game’s vertex stage does not have there)') && n.includes('(the field Extra, which the game’s structs lack)')), 'the notes name the lines carried, and in the border note those not carried with the reason', notes.join(' | '));
}

// ---------------------------------------------------------------------------------------------------------------------
// 5. skip and leave (what the check asks of the merge)
// ---------------------------------------------------------------------------------------------------------------------

{
    const game = `${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${PS('PS')}}\n${effect('e', 'PS')}`;
    const mod = game.replace('PixelShader =\n{\n', `PixelShader =\n{\n\tCode\n\t[[\n\t\tfloat ModFn( float x ) { return x; }\n\t]]\n${PS('PS_m', 'return float4( ModFn( 1.0 ), 0.0, 0.0, 1.0 );')}\n`) + effect('m', 'PS_m');
    const plain = merge({ 'g.shader': game }, { 'g.shader': mod }, ['g.shader']).files.get('g.shader')!;
    check(plain.notes.effects.join() === 'm' && /float ModFn/.test(plain.text) && plain.notes.needs.ModFn?.join() === 'm', 'a carried function is written and the effect that needs it is known', JSON.stringify(plain.notes.needs));
    const skipped = merge({ 'g.shader': game }, { 'g.shader': mod }, ['g.shader'], { skip: new Set(['g.shader|ModFn']) }).files.get('g.shader')!;
    check(skipped.notes.effects.join() === 'm' && !/float ModFn/.test(skipped.text), 'a skipped definition is not written');
    const left = merge({ 'g.shader': game }, { 'g.shader': mod }, ['g.shader'], { leave: new Map([['g.shader|m', { kind: 'verify', def: 'm', name: 'ps', detail: 'x' }]]) }).files.get('g.shader')!;
    check(left.notes.effects.length === 0 && left.notes.dropped[0]?.reason.kind === 'verify' && !/Effect m/.test(left.text), 'an effect left out by the check is not written and has its reason', JSON.stringify(left.notes.dropped));

    // the word of a preprocessor line inside a function (`#undef T`) names no definition: the mod's `#undef Flag` elsewhere is not pulled in
    const flagGame = game.replace('PixelShader =\n{\n', 'PixelShader =\n{\n\tCode\n\t[[\n\t\t#define Flag 1\n\t\tfloat GameFn() { return Flag; }\n\t]]\n');
    const undefMod = flagGame.replace('#define Flag 1\n', '#define Flag 1\n\t\t#undef Flag\n\t\t#define Flag 2\n').replace('float GameFn() { return Flag; }\n', 'float GameFn() { return Flag; }\n\t\tfloat ModFn( float x )\n\t\t{\n\t\t#define T 2.0\n\t\t\tfloat y = x * T;\n\t\t#undef T\n\t\t\treturn y;\n\t\t}\n') + `\nPixelShader =\n{\n${PS('PS_m', 'return float4( ModFn( 1.0 ), 0.0, 0.0, 1.0 );')}}\n${effect('m', 'PS_m')}`;
    const pp = merge({ 'g.shader': flagGame }, { 'g.shader': undefMod }, ['g.shader']).files.get('g.shader')!;
    check(pp.notes.effects.join() === 'm' && /float ModFn/.test(pp.text) && !/#undef Flag/.test(pp.text), 'a #undef inside a carried function does not pull the mod’s other #undef lines in (nor their clash)', JSON.stringify(pp.notes.dropped) + pp.text.slice(-400));

    // names a function-like macro pastes together (`Level_##A##_Max`) are found: the definitions they match are carried
    const pasteMod = game.replace('PixelShader =\n{\n', 'PixelShader =\n{\n\tCode\n\t[[\n\t\tstatic const float Level_LOW_Max = 1.0;\n\t\tstatic const float Level_HIGH_Max = 2.0;\n\t\tstatic const float Unrelated = 3.0;\n\t\tfloat ModFn( float x )\n\t\t{\n\t\t\t#define PICK(A) Level_##A##_Max\n\t\t\tfloat y = x * PICK(LOW) + PICK(HIGH);\n\t\t\t#undef PICK\n\t\t\treturn y;\n\t\t}\n\t]]\n') + `\nPixelShader =\n{\n${PS('PS_m', 'return float4( ModFn( 1.0 ), 0.0, 0.0, 1.0 );')}}\n${effect('m', 'PS_m')}`;
    const paste = merge({ 'g.shader': game }, { 'g.shader': pasteMod }, ['g.shader']).files.get('g.shader')!;
    check(paste.notes.effects.join() === 'm' && /Level_LOW_Max = 1\.0/.test(paste.text) && /Level_HIGH_Max = 2\.0/.test(paste.text) && !/Unrelated/.test(paste.text), 'the definitions a pasted name matches are carried (and no other)', paste.text.slice(-500));
}

// ---------------------------------------------------------------------------------------------------------------------
// 6. the check of the merged files and its repairs
// ---------------------------------------------------------------------------------------------------------------------

/** shader work over in-memory files (paths below gfx/FX; `other`: the game's files elsewhere by their path, the border settings) */
function input(game: Files, mod: Files, files: string[], keep: string[], gameShaders: string[], other: Files = {}): ShaderInput
{
    const gf = { 'cw/defines_hlsl.fxh': MACROS, 'cw/defines_common.fxh': '', ...game };
    const fx = (rel: string): string | undefined => (rel.startsWith('gfx/FX/') ? rel.slice(7) : undefined);
    return {
        files: files.map((f) => 'gfx/FX/' + f),
        keep: keep.map((f) => 'gfx/FX/' + f),
        modFiles: Object.keys(mod).map((f) => 'gfx/FX/' + f),
        readMod: (rel) => (fx(rel) === undefined || mod[fx(rel)!] === undefined ? undefined : Buffer.from(mod[fx(rel)!])),
        readGame: (rel) => (fx(rel) === undefined ? (other[rel] === undefined ? undefined : Buffer.from(other[rel])) : gf[fx(rel) as keyof typeof gf] === undefined ? undefined : Buffer.from(gf[fx(rel) as keyof typeof gf])),
        gameShaders: gameShaders.map((f) => 'gfx/FX/' + f),
        compile: false
    };
}

// a kept copy of the mod brings a file in whose constant buffer has a member the game's buffer has (X3003 in every effect of the game's file)
{
    const cb = 'ConstantBuffer( 5 )\n{\n\tfloat4 Tint;\n};\n';
    const gameInc = 'Code\n[[\n\tfloat GameFn( float x ) { return x; }\n]]\n';
    const keptInc = 'Includes = {\n\t"modonly.fxh"\n}\n\n' + gameInc;
    const modOnly = 'ConstantBuffer( 6 )\n{\n\tfloat4 Tint;\n};\n';
    const gameShader = `Includes = {\n\t"inc.fxh"\n}\n\n${cb}${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${PS('PS')}}\n${effect('e', 'PS')}`;
    const modShader = gameShader + `\nPixelShader =\n{\n${PS('PS_m')}}\n${effect('m', 'PS_m')}`;
    const w = await verifiedShaderWork(input({ 'game.shader': gameShader, 'inc.fxh': gameInc }, { 'game.shader': modShader, 'inc.fxh': keptInc, 'modonly.fxh': modOnly }, ['game.shader'], ['inc.fxh'], ['game.shader']));
    const c = w.check!;
    check(!!c && c.merged.length === 1 && c.merged[0].rel === 'gfx/FX/inc.fxh', 'the kept copy that brings the second buffer in is merged after all', JSON.stringify(c));
    check(w.files.has('gfx/FX/inc.fxh') && !/modonly/.test(Buffer.from(w.files.get('gfx/FX/inc.fxh')!.data).toString()), '... and written as the game’s file (the include is not added: nothing carried needs it)');
    check(c.failing.length === 0 && c.units > 0 && !c.compiled, 'nothing fails after that; the static rules ran', JSON.stringify({ ...c, merged: undefined }));
    check(w.files.get('gfx/FX/game.shader')!.notes.effects.join() === 'm', 'the mod’s effect is still carried');
    check(shaderNotes(w).some((n) => n.includes('merged with the game’s after all')), 'the notes say so');

    // the same without a mod copy that causes anything: nothing is repaired
    const quiet = await verifiedShaderWork(input({ 'game.shader': gameShader, 'inc.fxh': gameInc }, { 'game.shader': modShader, 'inc.fxh': gameInc }, ['game.shader'], ['inc.fxh'], ['game.shader']));
    check(quiet.check!.merged.length === 0 && quiet.check!.failing.length === 0 && quiet.check!.rounds === 0, 'a clean merge needs no repair', JSON.stringify(quiet.check));

    // the job's Cancel at the check's yields (`stop`, the migration worker's): its error goes on, it is no failed check, and nothing
    // of the stopped check is kept (the last result is the clean merge's: the first input is checked anew)
    const first = (): ShaderInput => input({ 'game.shader': gameShader, 'inc.fxh': gameInc }, { 'game.shader': modShader, 'inc.fxh': keptInc, 'modonly.fxh': modOnly }, ['game.shader'], ['inc.fxh'], ['game.shader']);
    const stopped = await verifiedShaderWork({ ...first(), stop: () => { throw new Error('stopped by the job'); } }).then(() => undefined, (e: Error) => e);
    check(stopped?.message === 'stopped by the job', 'a stop at the check\'s yields goes on as the error, not as a failed check', String(stopped));
    const again = await verifiedShaderWork(first());
    check(!!again.check && !again.check.failed && again.check.merged.length === 1 && again.check.merged[0].rel === 'gfx/FX/inc.fxh', 'the next ask makes the check anew (nothing of the stopped one kept)', JSON.stringify(again.check));
}

// a carried sampler collides with a sampler of another game file that includes the merged one: the mod’s effect that needs it goes
{
    const gameX = `${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${PS('PS')}}\n`;
    const modX = gameX.replace('PixelShader =\n{\n', `PixelShader =\n{\n\tTextureSampler B\n\t{\n\t\tIndex = 3\n\t\tFile = "b.dds"\n\t}\n${PS('PS_mx', 'return B.Texture.Sample( B.Sampler, float2( 0.0, 0.0 ) );')}\n`) + effect('mx', 'PS_mx');
    const gameY = `Includes = {\n\t"x.fxh"\n}\n\nPixelShader =\n{\n\tTextureSampler A\n\t{\n\t\tIndex = 3\n\t\tFile = "a.dds"\n\t}\n${PS('PS_y')}}\n${effect('y_eff', 'PS_y')}`;
    const w = await verifiedShaderWork(input({ 'x.fxh': gameX, 'y.shader': gameY }, { 'x.fxh': modX }, ['x.fxh'], [], ['y.shader']));
    const x = w.files.get('gfx/FX/x.fxh')!;
    check(x.notes.dropped.length === 1 && x.notes.dropped[0].name === 'mx' && x.notes.dropped[0].reason.kind === 'verify', 'the mod’s effect whose sampler shares a texture id with another file’s sampler is left out by the check', JSON.stringify({ d: x.notes.dropped, c: w.check }));
    check(w.check!.failing.length === 0 && w.check!.rounds >= 1, 'and nothing fails after that', JSON.stringify(w.check));
    check(!/Effect mx/.test(Buffer.from(x.data).toString()), 'the effect is not in the written file');
}

// the border settings name an effect file of their own (`shader = …`): the rule writes the game's text for it, the default border file
// too, and a terrain file of the same mod still gets the mod's fog
{
    const hookGame = 'PixelShader =\n{\n\tCode\n\t[[\n\t\tfloat3 GameFog( float3 c ) { return c; }\n\t\t#ifndef ApplyFog\n\t\t#define ApplyFog GameFog\n\t\t#endif\n\t]]\n}\n';
    const fogInc = 'PixelShader =\n{\n\tTextureSampler FogNoise\n\t{\n\t\tIndex = 30\n\t\tFile = "noise.dds"\n\t}\n\tCode\n\t[[\n\t\tfloat3 ModFog( float3 c ) { return c * FogNoise.Texture.Sample( FogNoise.Sampler, float2( 0.0, 0.0 ) ).rgb; }\n\t\t#undef ApplyFog\n\t\t#define ApplyFog ModFog\n\t]]\n}\n';
    const body = (inc: string, name: string): string => `Includes = {\n\t"fog.fxh"\n${inc}}\n\n${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${PS('PS', 'return float4( ApplyFog( float3( 1.0, 1.0, 1.0 ) ), 1.0 );')}}\n${effect(name, 'PS')}`;
    const names = ['myborder.shader', 'pdxborder.shader', 'terrain.shader'];
    const game: Files = { 'fog.fxh': hookGame, ...Object.fromEntries(names.map((n, i) => [n, body('', 'e' + i)])) };
    const mod: Files = { 'fog.fxh': hookGame, 'modfog.fxh': fogInc, ...Object.fromEntries(names.map((n, i) => [n, body('\t"modfog.fxh"\n', 'e' + i)])) };
    const settings = { 'gfx/map/borders/settings.txt': '﻿province = { texture = "p.dds" }\nmine = { texture = "m.dds" shader = "gfx/FX/myborder.shader" effect = "e0" }\n' };
    const w = await verifiedShaderWork(input(game, mod, names, [], names, settings));
    const f = (n: string) => w.files.get('gfx/FX/' + n)!;
    check(!f('myborder.shader').carries && Buffer.from(f('myborder.shader').data).toString() === game['myborder.shader'] && !!f('myborder.shader').notes.border, 'a file the settings’ shader = names is written as the game’s file', Buffer.from(f('myborder.shader').data).toString());
    check(!f('pdxborder.shader').carries && !!f('pdxborder.shader').notes.border && f('terrain.shader').carries && f('terrain.shader').notes.macros.length === 1 && !f('terrain.shader').notes.border, 'the default border file too; the terrain file gets the mod’s macro', JSON.stringify(f('terrain.shader').notes.macros));
    check(w.check!.failing.length === 0 && shaderNotes(w).some((n) => n.startsWith('gfx/FX/myborder.shader: the game’s border renderer draws with this file') && n.includes('ApplyFog') && n.includes('modfog.fxh')), 'nothing fails, and the notes say why the border file keeps the game’s version and what is not written', shaderNotes(w).join(' | '));
    const none = await verifiedShaderWork(input(game, mod, names, [], names, { 'gfx/map/borders/settings.txt': 'province = { texture = "p.dds" }\n' }));
    check(none.files.get('gfx/FX/myborder.shader')!.carries && !none.files.get('gfx/FX/myborder.shader')!.notes.border, 'without the override the same file is merged as usual', JSON.stringify(none.files.get('gfx/FX/myborder.shader')!.notes.macros));
}

// disabled lines the check finds the game's effects failing with stay live: here the mod's copy of a function that fills an `out` struct
// disabled the write of a field (the static rule: X3508, a field no code writes); the repair writes the game's line again, and says so
{
    const structs = 'VertexStruct VS_IN\n{\n\tfloat3 Position : POSITION;\n};\n\nVertexStruct VS_OUT\n{\n\tfloat4 Position : PDX_POSITION;\n\tfloat Extra : TEXCOORD0;\n};\n';
    const vs = (fill: string): string => `\nVertexShader =\n{\n\tCode\n\t[[\n\t\tvoid Fill( out VS_OUT Out, float3 P )\n\t\t{\n\t\t\tOut.Position = float4( P, 1.0 );\n\t\t\t${fill}\n\t\t}\n\t]]\n\n\tMainCode VS\n\t{\n\t\tInput = "VS_IN"\n\t\tOutput = "VS_OUT"\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t\tVS_OUT Out;\n\t\t\t\tFill( Out, Input.Position );\n\t\t\t\treturn Out;\n\t\t\t}\n\t\t]]\n\t}\n}\n`;
    const file = (fill: string): string => `${structs}${vs(fill)}\nPixelShader =\n{\n${PS('PS')}}\n${effect('e', 'PS')}`;
    const game = file('Out.Extra = 1.0;');
    const w = await verifiedShaderWork(input({ 'g.shader': game }, { 'g.shader': file('//Out.Extra = 1.0;') }, ['g.shader'], [], ['g.shader']));
    const g = w.files.get('gfx/FX/g.shader')!;
    check(w.check!.noDisabled.length === 1 && w.check!.noDisabled[0].def === 'Fill' && w.check!.failing.length === 0 && Buffer.from(g.data).toString() === game && g.notes.disabled.length === 0, 'a disabled line the game’s effects fail without (a field of an out struct no longer written) stays live: the check’s repair', JSON.stringify(w.check) + Buffer.from(g.data).toString());
    check(shaderNotes(w).some((n) => n.startsWith('gfx/FX/g.shader: the lines the mod’s copy disabled stay live in the game’s Fill, because effects failed with them disabled — e (vertex)')), 'the notes say so', shaderNotes(w).join(' | '));
    const fine = await verifiedShaderWork(input({ 'g.shader': game }, { 'g.shader': file('//Out.Extra = 1.0;\n\t\t\tOut.Extra = 2.0;') }, ['g.shader'], [], ['g.shader']));
    check(fine.check!.noDisabled.length === 0 && fine.files.get('gfx/FX/g.shader')!.notes.disabled.length === 0, 'a replaced line is not carried in the first place (no repair needed)', JSON.stringify(fine.check));
}

// a border file with a vertex line of the mod's carried is written in the game file's style (line ends, byte order mark), not the copy's:
// the engine caches a stage by its source text, so the pixel stages stay the entries of the game's own file
{
    const cam = 'ConstantBuffer( Cam )\n{\n\tfloat3 CameraPosition;\n};\n\n';
    const vs = (extra: string): string => `\nVertexShader =\n{\n\tMainCode VS\n\t{\n\t\tInput = "VS_IN"\n\t\tOutput = "VS_OUT"\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t\tVS_OUT Out;\n\t\t\t\tfloat3 position = Input.Position;${extra}\n\t\t\t\tOut.Position = float4( position, 1.0 );\n\t\t\t\treturn Out;\n\t\t\t}\n\t\t]]\n\t}\n}\n`;
    const file = (extra: string): string => `${cam}${STRUCTS}${vs(extra)}\nPixelShader =\n{\n${PS('PS')}}\n${effect('e', 'PS')}`;
    const game = file('');
    const mod = '﻿' + file('\n\t\t\t\tposition.y += 0.5f;').replace(/\n/g, '\r\n');
    const w = await verifiedShaderWork(input({ 'pdxborder.shader': game }, { 'pdxborder.shader': mod }, ['pdxborder.shader'], [], ['pdxborder.shader']));
    const f = w.files.get('gfx/FX/pdxborder.shader')!;
    const t = Buffer.from(f.data).toString();
    check(f.carries && f.data[0] !== 0xEF && !t.includes('\r') && t === game.replace('Input.Position;\n', 'Input.Position;\n\t\t\t\t// MOD-MERGE: the mod\'s line carried: `position.y += 0.5f;`\n\t\t\t\tposition.y += 0.5f;\n') && w.check!.failing.length === 0 && w.check!.noAdditions.length === 0, 'a border file with a carried vertex line keeps the game file’s line ends and byte order mark (here: LF, none; the copy has CRLF and one), and nothing fails', JSON.stringify(w.check) + t);
}

// effects of the mod the game does not draw: in a file the executable names whose game effects are all strings of the executable and named
// by no data file, an added effect that is neither is told as not drawn; the written file stays the same
{
    const fileOf = (effects: string[]): string => `${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${effects.map((e) => PS('PS_' + e)).join('')}}\n${effects.map((e) => effect(e, 'PS_' + e)).join('')}`;
    const game = fileOf(['surround', 'surround_flat']);
    const engine = (path: string, extra: string[] = []): EngineStrings => ({ names: new Set(['surround', 'surround_flat', ...extra]), paths: new Set([path]), runs: new Set() });
    // (each case its own file name: the rule keeps its last result by the files)
    const run = async (name: string, added: string[], opts: { engine?: EngineStrings | 'none'; named?: string[]; game?: string; version?: string; } = {}) =>
    {
        const asked: string[][] = [];
        const w = await verifiedShaderWork({
            ...input({ [name]: opts.game ?? game }, { [name]: fileOf([...['surround', 'surround_flat'], ...added]) }, [name], [], [name]),
            gameVersion: opts.version ?? '1.20.1.2',
            engine: () => (opts.engine === 'none' ? undefined : opts.engine ?? engine('gfx/fx/' + name)),
            dataNames: async (names) =>
            {
                asked.push(names);
                return new Set(names.filter((n) => opts.named?.includes(n)));
            }
        });
        return { w, asked, f: w.files.get('gfx/FX/' + name)!, notes: shaderNotes(w).filter((n) => n.startsWith('gfx/FX/' + name)) };
    };
    const a = await run('a.shader', ['surround_shadow']);
    const plain = await verifiedShaderWork(input({ 'a2.shader': game }, { 'a2.shader': fileOf(['surround', 'surround_flat', 'surround_shadow']) }, ['a2.shader'], [], ['a2.shader']));
    check(JSON.stringify(a.f.undrawn) === '{"effects":["surround_shadow"],"fixed":["surround","surround_flat"],"version":"1.20"}' && a.notes[0] === 'gfx/FX/a.shader: 1 effect of the mod added that 1.20 does not draw (1 other definition needed) — surround_shadow: the game draws this file only with the effects its program names (surround, surround_flat), and no loaded file asks for this one, so it is carried but has no effect' && a.f.notes.effects.join() === 'surround_shadow', 'an added effect the executable does not name, in a file it draws by fixed names only, is told as not drawn: the count line says so', JSON.stringify(a.notes) + JSON.stringify(a.f.undrawn));
    check(Buffer.from(a.f.data).equals(Buffer.from(plain.files.get('gfx/FX/a2.shader')!.data)) && JSON.stringify(a.asked) === '[["surround","surround_flat","surround_shadow"]]' && a.w.check!.failing.length === 0, 'the written file is the same as without the signal (the effect stays); the loaded files are asked once, for the game’s names and the candidate', JSON.stringify(a.asked));
    const b = await run('b.shader', ['surround_shadow', 'drawn_too'], { engine: engine('gfx/fx/b.shader', ['drawn_too']) });
    check(b.notes[0] === 'gfx/FX/b.shader: 2 effects of the mod added (2 other definitions needed)' && b.notes[1] === 'gfx/FX/b.shader: 1 of these effects 1.20 does not draw — surround_shadow: the game draws this file only with the effects its program names (surround, surround_flat), and no loaded file asks for it', 'when some of the added effects are drawn, the count stays and a line names those not drawn', JSON.stringify(b.notes));
    const named = await run('c.shader', ['surround_shadow'], { named: ['surround_shadow'] });
    const byData = await run('d.shader', ['surround_shadow'], { named: ['surround_flat'] });
    check(!named.f.undrawn && !byData.f.undrawn && named.notes[0] === 'gfx/FX/c.shader: 1 effect of the mod added (1 other definition needed)', 'no note when a loaded file names the effect, nor in a file whose effects a data file chooses', JSON.stringify([named.notes, byData.notes]));
    const noExe = await run('e.shader', ['surround_shadow'], { engine: 'none' });
    const noPath = await run('f.shader', ['surround_shadow'], { engine: engine('gfx/fx/other.shader') });
    const composed = await run('g.shader', ['surround_shadow'], { game: fileOf(['surround', 'surround_flat', 'surroundSkirt']) });
    const noVersion = await run('h.shader', ['surround_shadow'], { version: '' });
    check([noExe, noPath, composed, noVersion].every((x) => !x.f.undrawn && x.asked.length === 0), 'no note and no scan without the executable, when it does not name the file, when a game effect of the file is no string of it, or without the game’s version', JSON.stringify([noExe, noPath, composed, noVersion].map((x) => [x.f.undrawn, x.asked])));
}

// ---------------------------------------------------------------------------------------------------------------------
// 7. calls of game functions the version gave another parameter list (shaderCalls.ts)
// ---------------------------------------------------------------------------------------------------------------------

{
    const call = (args: string, name = 'GetBorderColorAndBlendGame'): string => `\t${name}( ${args} );`;
    const five = 'Input.WorldSpacePos.xz, FlatMap, BorderColor, BorderPreLightingBlend, BorderPostLightingBlend';
    const a = adaptShaderCalls(call(five));
    check(a.calls.length === 1 && a.text === `\tGetBorderColorAndBlendGame( ${five}, 0.0f );`, 'a call with the old argument count gets the neutral argument', a.text);
    check(adaptShaderCalls(call(five + ', 0.0f')).calls.length === 0, 'a call with the new count is left alone');
    check(adaptShaderCalls(call('a, b, c')).calls.length === 0, 'a call with another count is left alone');
    check(adaptShaderCalls(call('float2( a, b ), saturate( c, d ), e, f[ 1 ], g')).text === '\tGetBorderColorAndBlendGame( float2( a, b ), saturate( c, d ), e, f[ 1 ], g, 0.0f );', 'commas inside parentheses and brackets are no arguments');
    check(adaptShaderCalls(call('a, b, c, d, e', 'GetBorderColorAndBlendGameLerp')).calls.length === 0 && adaptShaderCalls(call('a, b, c, d, e, f', 'GetBorderColorAndBlendGameLerp')).text.endsWith('f, 0.0f );'), 'the Lerp function has one argument more than the plain one: the names do not mix');
    check(adaptShaderCalls('\tGetProvinceOverlayAndBlend( p, c, a, b );').text === '\tGetProvinceOverlayAndBlend( p, c, a, b, 0.0f );', 'GetProvinceOverlayAndBlend, four arguments before');
    check(adaptShaderCalls('void GetBorderColorAndBlendGame( float2 P, float3 F, out float3 C, out float A, out float B )\n{\n}\n').calls.length === 0, 'a definition is no call');
    check(adaptShaderCalls(`// ${call(five)}\n/* ${call(five)} */\nfloat s = "${call(five)}";`).calls.length === 0, 'a comment and a string are no calls');
    check(adaptShaderCalls(`if ( x )\n\tGetBorderColorAndBlendGame( ${five} );\nelse\n\tGetBorderColorAndBlendGame( ${five} );`).calls.length === 2, 'a call after if and else is a call');
    check(adaptShaderCalls(`x.GetBorderColorAndBlendGame( ${five} );`).calls.length === 0, 'a member call is not the game’s function');
    const crlf = '\r\n\tGetBorderColorAndBlendGame( a, b,\r\n\t\tc, d, e // last\r\n\t);\r\n';
    const c = adaptShaderCalls(crlf);
    check(c.text === '\r\n\tGetBorderColorAndBlendGame( a, b,\r\n\t\tc, d, e, 0.0f // last\r\n\t);\r\n' && c.calls[0].line === 2, 'a call over several lines: the argument goes behind the last one, line ends stay', JSON.stringify(c));
    check(adaptShaderCalls(call(five) + '\n' + call(five)).calls.map((x) => x.line).join() === '1,2', 'every call, with its line');
    check(adaptShaderCalls(adaptShaderCalls(call(five)).text).calls.length === 0, 'a second pass changes nothing');
    check(definedWithOldParams('void GetBorderColorAndBlendGame( float2 P, float3 F, out float3 C, out float A, out float B )\n{\n}\n').has('GetBorderColorAndBlendGame') && !definedWithOldParams(call(five)).size, 'a definition with the old parameter count is found, a call is not');
    check(adaptShaderCalls(call(five), new Set(['GetBorderColorAndBlendGame'])).calls.length === 0 && callsToAdapt(call(five)) && !callsToAdapt(call(five), new Set(['GetBorderColorAndBlendGame'])), 'a name the mod defines itself is skipped');
    const pe = parseErrors(String.raw`C:\tmp\3.hlsl(12,5-9): error X3013: 'F': no matching 5 parameter function` + '\n' + `shader.hlsl: error X3501: 'main': entry point not found` + '\n' + String.raw`C:\tmp\3.hlsl(1,1): warning X3206: implicit truncation`);
    check(pe.length === 2 && pe[0].line === 12 && pe[0].code === 'X3013' && pe[1].line === 0 && pe[1].code === 'X3501', 'compiler messages: with a position, without one, and a warning is none', JSON.stringify(pe));
    check(textureIdsKnownFor('1.20.1.2') && textureIdsKnownFor('1.20.3') && !textureIdsKnownFor('1.21.0.1') && !textureIdsKnownFor(undefined), 'the texture id table is known for the 1.20 line only');
}

{
    // the game's include has the 1.20 function; the mod's effect, written for 1.19, calls it with the old list
    const bc = 'Code\n[[\n\tvoid GetBorderColorAndBlendGame( float2 Pos, float3 Flat, out float3 BorderColor, out float Pre, out float Post, float Skip )\n\t{\n\t\tBorderColor = Flat;\n\t\tPre = Pos.x;\n\t\tPost = Skip;\n\t}\n]]\n';
    const body = 'float3 C; float A; float B; GetBorderColorAndBlendGame( float2( 0.0, 0.0 ), float3( 1.0, 1.0, 1.0 ), C, A, B ); return float4( C, A );';
    const gameShader = `Includes = {\n\t"bc.fxh"\n}\n\n${STRUCTS}${MAIN_VS}\nPixelShader =\n{\n${PS('PS')}}\n${effect('e', 'PS')}`;
    const withEffect = gameShader + `\nPixelShader =\n{\n${PS('PS_m', body)}}\n${effect('m', 'PS_m')}`;
    const game = { 'game.shader': gameShader, 'bc.fxh': bc };
    const text = (b: Buffer): string => b.toString('utf8');

    // merged: the carried effect has the argument, the written file the mod's copy's byte order mark and line ends
    const modCrlf = '﻿' + withEffect.replace(/\n/g, '\r\n');
    const w = await verifiedShaderWork(input({ 'game.shader': '﻿' + gameShader, 'bc.fxh': bc }, { 'game.shader': modCrlf, 'bc.fxh': bc }, ['game.shader'], [], ['game.shader']));
    const f = w.files.get('gfx/FX/game.shader')!;
    const t = text(f.data);
    check(f.notes.effects.join() === 'm' && f.notes.dropped.length === 0 && t.includes('C, A, B, 0.0f )'), 'a merged effect that calls the game function with the old list is carried with the new argument', t.slice(-500));
    check(f.data[0] === 0xEF && f.data[1] === 0xBB && t.includes('\r\n') && !/[^\r]\n/.test(t), 'a merged file has the mod copy’s byte order mark and line ends (here: with, and CRLF; the game’s was LF with a mark)');
    check(f.adapted?.length === 1 && shaderNotes(w).some((n) => n.startsWith('gfx/FX/game.shader: 1 call of a game function') && n.includes('GetBorderColorAndBlendGame (line') && n.includes('0.0f')), 'the notes tell the adapted call', shaderNotes(w).join(' | '));

    // merged: a mod copy without a mark and with LF replaces a game file with a mark and CRLF
    const w2 = await verifiedShaderWork(input({ 'game.shader': '﻿' + gameShader.replace(/\n/g, '\r\n'), 'bc.fxh': bc }, { 'game.shader': withEffect, 'bc.fxh': bc }, ['game.shader'], [], ['game.shader']));
    const f2 = w2.files.get('gfx/FX/game.shader')!;
    check(f2.data[0] !== 0xEF && !text(f2.data).includes('\r'), 'a merged file follows the mod copy, not the game’s: no mark, LF');

    // kept: the copy stays the mod's, with the call adapted; it is written to the patch mod
    const keptIn = input(game, { 'game.shader': withEffect, 'bc.fxh': bc }, [], ['game.shader'], ['game.shader']);
    const wk = await verifiedShaderWork(keptIn);
    const k = wk.files.get('gfx/FX/game.shader');
    check(!!k && k.carries && text(k.data) === withEffect.replace('C, A, B )', 'C, A, B, 0.0f )'), 'a kept copy with an old call is written with the call adapted and nothing else changed', k ? text(k.data).slice(-300) : 'not written');
    check(mergedAfterAll(wk, keptIn).join() === 'gfx/FX/game.shader', 'the rule takes it among its files (as a copy merged after all)');
    check(shaderNotes(wk).some((n) => n.includes('1 call of a game function')), 'the notes tell it');

    // kept without an old call: nothing is written
    const clean = withEffect.replace('C, A, B )', 'C, A, B, 0.0f )');
    const wc = await verifiedShaderWork(input(game, { 'game.shader': clean, 'bc.fxh': bc }, [], ['game.shader'], ['game.shader']));
    check(wc.files.size === 0, 'a kept copy that calls the new list is written nowhere', JSON.stringify({ files: [...wc.files.keys()], check: wc.check }));

    // a function the mod defines itself (a file without a game counterpart) keeps its calls
    const own = 'Code\n[[\n\tvoid GetBorderColorAndBlendGame( float2 Pos, float3 Flat, out float3 BorderColor, out float Pre, out float Post )\n\t{\n\t\tBorderColor = Flat;\n\t\tPre = Pos.x;\n\t\tPost = 0.0;\n\t}\n]]\n';
    const wo = await verifiedShaderWork(input(game, { 'game.shader': withEffect, 'bc.fxh': bc, 'own.fxh': own }, [], ['game.shader'], ['game.shader']));
    check(wo.files.size === 0, 'a mod that defines the function with the old list itself keeps its calls');

    // the rule exists for a mod whose copies all stay, when one of them calls the old list (migrate.ts fileRules)
    const dir = mkdtempSync(join(tmpdir(), 'ckp-shcalls-'));

    try
    {
        const put = (root: string, rel: string, data: string): string =>
        {
            const f = join(dir, root, ...rel.split('/'));
            mkdirSync(join(f, '..'), { recursive: true });
            writeFileSync(f, data);
            return f;
        };
        put('game', 'gfx/FX/pdxmesh.shader', gameShader);
        const step: Migration = { from: '1.19', to: '1.20', label: '', changes: [], types: [], section: '', order: [], newFolders: {}, mergeShaders: [{ files: ['gfx/FX/**'], label: 'merge' }] };
        const rules = (modText: string, extra: Record<string, string> = {}): string =>
        {
            const files = new Map<string, { file?: string; }>([['gfx/FX/pdxmesh.shader', { file: put('mod', 'gfx/FX/pdxmesh.shader', modText) }]]);

            for (const [rel, data] of Object.entries(extra))
                files.set(rel, { file: put('mod', rel, data) });

            return fileRules({} as ModInfo, [step], join(dir, 'game'), files).map((r) => `${r.kind}:${r.files.join('+')}|${(r.keep ?? []).join('+')}`).join(' ');
        };
        check(rules(withEffect) === 'mergefx:|gfx/FX/pdxmesh.shader', 'a copy that stays and calls the old list makes a rule that has it as a kept copy', rules(withEffect));
        check(rules(clean) === '', 'a copy that stays and calls the new list makes none', rules(clean));
        check(rules(withEffect, { 'gfx/FX/own.fxh': own }) === '', 'nor does one whose function the mod defines itself', rules(withEffect, { 'gfx/FX/own.fxh': own }));
    }
    finally
    {
        rmSync(dir, { recursive: true, force: true });
    }
}

console.log(bad ? `${bad} of ${count} checks failed` : `all ${count} checks ok`);
process.exit(bad ? 1 : 0);
