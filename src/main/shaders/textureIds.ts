/**
 * The engine's texture ids (ck3.exe 1.20.1.2, read off its static registrations and checked against the live process): each
 * name of a `Ref = Name` is a range of ids `[base, count]`, written `Name<k>` for k below count (a count of 1 has no
 * digits). The ids are the order of the engine's static initializers, so another game build can number them differently:
 * `TEXTURE_IDS_1_20` is the known-good entry for 1.20.1.2. Kept apart from hlslCheck.ts so that the merge (mods/shaderMerge.ts)
 * can use the rule without the compiler front end.
 */

export type TextureIdTable = Record<string, [base: number, count: number]>;

export const TEXTURE_IDS_1_20: TextureIdTable = {
    TerrainFlatMap: [0, 1], WinterTexture: [1, 1], SurroundFlatMapMask: [2, 1], FlatMapEnvironmentMap: [3, 1], EditorTerrainOverlayTexture: [4, 1],
    TerrainDetailErrorTexture: [5, 1], JominiProvinceColorIndirection: [6, 1], JominiProvinceColor: [7, 1], JominiBorderDistance: [8, 1], JominiFogOfWar: [9, 1],
    JominiRiver: [10, 3], JominiWaterTexture: [13, 9], JominiVerticalBordersMask: [22, 4], PdxHeightmap: [26, 2], PdxTerrainTextures: [28, 5],
    PdxTerrainColorMap: [33, 1], JominiPortraitDecalDiffuseArray: [34, 1], JominiPortraitDecalNormalArray: [35, 1], JominiPortraitDecalPropertiesArray: [36, 1],
    JominiEmblemTexture: [37, 1], JominiPatternMap: [38, 1], JominiRefraction: [39, 1], JominiEnvironmentMap: [40, 1], ToneMapTonyMcMapfaceMap: [41, 1],
    JominiDepthBuffer: [42, 1], JominiDepthBufferMultiSampled: [43, 1], SSAO: [44, 1], JominiSSAOColor: [45, 1], JominiSSAOColorMultisampled: [46, 1],
    PdxGuiModifyTexture: [47, 10], ScreenGrabTexture: [57, 4], PdxTextureAtlasFrame: [61, 1], PdxMeshCustomTexture: [62, 6], PdxMeshDecalsTexture: [68, 1],
    PdxTexture: [69, 32], PdxShadowmap: [101, 1]
};

/**
 * The game versions `TEXTURE_IDS_1_20` was read from and checked against: the 1.20 line (read from 1.20.1.2). The table is not
 * in any game file, so nothing can tell that another version numbers the ids differently, except the version itself: for any
 * other, a merge and its check still use the table, say so (`textureIdsKnownFor`), and a new version means reading the ids
 * of its ck3.exe again (docs/shaders.md).
 */
export const TEXTURE_IDS_VERSIONS = '1.20.';

/** Whether the table is the one of this game version (the launcher's `rawVersion`; unknown version: not known). */
export function textureIdsKnownFor(version: string | undefined): boolean
{
    return !!version && version.startsWith(TEXTURE_IDS_VERSIONS);
}

/** the ids the engine's builder has room for (its used-array has 128 entries and no bounds check) */
export const TEXTURE_ID_LIMIT = 128;

/**
 * The engine's slots for a sampler's texture file: `Index = n` names `PdxTexture<n>`, and the table has `PdxTexture[1]` of them
 * (1.20.1.2: Index 0 to 31). An Index past them still gives an id below 128 (`Index = 36` is 105), but one of another range or of
 * no name at all: the builder accepts it, but the file does not reach the stage as it should; 1.19's table had more room, so a
 * mod written for it may use such an Index (a mod's fog-of-war cloud texture on Index 36: moved below the slots, the fog
 * function's clouds got their texture in the next game test). The merge moves such a sampler below the slots' end. (The flat pink
 * strips of the same game tests were the province borders, not the rivers, and stayed after the move: shaderMerge.ts
 * `FxMergeOptions.borders`.)
 */
export function fileSlotCount(table: TextureIdTable = TEXTURE_IDS_1_20): number
{
    return table.PdxTexture[1];
}

/** Whether `Index = n` is one of the engine's file texture slots (`fileSlotCount`). */
export function isFileSlot(index: string, table: TextureIdTable = TEXTURE_IDS_1_20): boolean
{
    return /^\d+$/.test(index) && Number(index) < fileSlotCount(table);
}

/**
 * BINDING RULE (gfx_dx_hlsl_builder.cpp). Every TextureSampler (and plain Texture) of a stage gets one texture id in 0..127:
 * `Index = n` is `base(PdxTexture) + n` (69 + n in 1.20.1.2; there is no range check, `Index = n` is the slot of
 * `Ref = PdxTexture<n>`) and `Ref = Name` is the base of its range plus the digits. A name or digits the table does not
 * know, and an id of 128 or more, give no id (the sampler is not compared). The builder refuses a stage in which two
 * declarations have the same id: "Texture Samplers have same binding index. 'Name: <the second one>', 'Ref Index: <id>'"; so
 * `Index = 32` is the id of `Ref = PdxShadowmap` (101). BufferTextures have a registry of their own.
 */
export function textureIdOf(index: string | undefined, ref: string | undefined, table: TextureIdTable = TEXTURE_IDS_1_20): number | undefined
{
    let id: number | undefined;

    if (index !== undefined && /^-?\d+$/.test(index))
        id = table.PdxTexture[0] + Number(index);
    else if (ref !== undefined)
    {
        const m = /^(.*?)(\d*)$/.exec(ref)!;
        const range = table[m[1]];
        const k = m[2] === '' ? 0 : Number(m[2]);

        if (range && k < range[1])
            id = range[0] + k;
    }

    return id !== undefined && id >= 0 && id < TEXTURE_ID_LIMIT ? id : undefined;
}
