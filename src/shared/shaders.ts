/**
 * How the viewers ask for one of the game's Effects (docs/shaders.md). One place for the request shape: programs
 * compiled ahead of time during indexing are found under exactly the key a viewer asks with.
 */
import type { ShaderRequest } from './api';

/** Effect file of a material that names no `shader_file`, by the shader's family. */
export function defaultEffectFile(shader: string | undefined): string
{
    if (shader?.startsWith('portrait'))
        return 'gfx/FX/jomini/portrait.shader';

    if (shader?.startsWith('court'))
        return 'gfx/FX/court_scene.shader';

    if (shader?.startsWith('decal'))
        return 'gfx/FX/pdxmesh_decal.shader';

    return 'gfx/FX/pdxmesh.shader';
}

/**
 * Joints a skinned program holds (`JointVertexMatrices`, 3 float4 per joint; the engine declares a placeholder of
 * one): Effects whose vertex code reads the bone streams are compiled skinned (AGOT's particle rigs: 129 joints).
 */
export const MAX_JOINTS = 256;

/** map-only paths (map lighting, winter, map object data) and blend shapes (applied on the CPU) */
const REMOVE = ['MAP_LIGHTING_HACK', 'APPLY_WINTER', 'JOMINI_MAP_OBJECT', 'PDX_MESH_BLENDSHAPES'];

/**
 * The request for one mesh part; `uv1` = the mesh has a second UV set (atlas buildings, pattern clothes); `extra` =
 * the meshsettings' `additional_shader_defines` (the engine compiles the Effect with them: `SECOND_COLOR_MASK`,
 * AGOT's `DRAGON_BODYPART_MARKER float3(…)` …), minus the paths a preview leaves out.
 */
export function viewerShaderRequest(file: string, effect: string, uv1: boolean, extra: string[] = []): ShaderRequest
{
    return {
        file,
        effect,
        // engine-set per mesh; map-only paths (fog of war, map lighting, snow) left out in previews
        defines: [...(uv1 ? ['PDX_MESH_UV1'] : []), 'NO_FOG', ...extra.filter((d) => !REMOVE.includes(d.split(/\s/)[0]))],
        // blend shapes and bone morphs are applied on the CPU (PDX_MESH_BLENDSHAPES would read a buffer we don't fill)
        remove: REMOVE,
        // Data[]: world matrix, constants, user data — portraits keep variation, colour mask interval and body part
        // index up to user offset + 25
        arrays: { Data: 48 },
        post: true
    };
}

/** The `additional_shader_defines` entries of a meshsettings block (quoted strings, values after a space). */
export function shaderDefinesOf(values: (string | undefined)[]): string[] | undefined
{
    const list = values.map((v) => (v ?? '').trim()).filter(Boolean);
    return list.length ? list : undefined;
}
