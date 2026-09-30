/**
 * Data passed between the index worker (what a model is made of), the main process and the Blender worker
 * (conversion), and the manifest written next to an export — docs/blender.md.
 */

export interface PlanTexture
{
    role: string;
    /** the reference as written (asset or .mesh material) */
    ref: string;
    /** game path it resolves to; absent = not found */
    path?: string;
}

/** One sub-mesh of the .mesh file (file order: shapes, then their meshes) with the material the game gives it. */
export interface PlanPart
{
    shape: string;
    /** position within its shape (meshsettings pair up by shape name and index) */
    index: number;
    shader?: string;
    textures: PlanTexture[];
}

export interface ModelExportPlan
{
    /** the model page's file (.mesh or .asset) */
    model: string;
    /** the .mesh file (game path) */
    mesh: string;
    /** the declaration giving the textures (an .asset's pdxmesh), if any */
    asset?: string;
    pdxmesh?: string;
    parts: PlanPart[];
    /** texture path → number of pdxmesh materials using it (shared atlases: a change shows on other models too) */
    textureUsers: Record<string, number>;
    /** the pdxmesh's blend shapes: morph target .mesh files with the base's vertex order */
    blendShapes?: { id: string; file: string; }[];
}

export interface ManifestTexture
{
    /** game path (the DDS) */
    path: string;
    role: string;
    /** DDS format as read (BC1, BC3, BC7, MASKED …), mips and size */
    format: string;
    width: number;
    height: number;
    mips: number;
    /** PNG next to the glTF, the hash of its pixels as written and of each channel (R, G, B, A) */
    file: string;
    hash: string;
    channels: string[];
    /** properties maps: the metallic-roughness PNG bound in the glTF */
    orm?: { file: string; hash: string; channels: string[]; };
    /** pdxmesh materials using this texture */
    users?: number;
}

export interface ManifestMaterial
{
    /** glTF / Blender material name */
    name: string;
    shader?: string;
    /** the .mesh file's own material block (shader, diff, n, spec), written back as it was */
    pdx: Record<string, string>;
    textures: PlanTexture[];
}

export interface BlenderManifest
{
    crusaderpope: 'blender-export';
    version: 1;
    /** .mesh game path the export was made from (an import must target the same) */
    mesh: string;
    model: string;
    asset?: string;
    pdxmesh?: string;
    /** where the mesh was read (disk path or `archive.zip › entry`) */
    source: string;
    exported: string;
    gltf: string;
    notes: string[];
    shapes: { name: string; meshes: { material: string; vertices: number; triangles: number; skinned: boolean; uvSets: number; }[]; }[];
    materials: ManifestMaterial[];
    textures: ManifestTexture[];
    bones?: string[];
    /** blend shapes exported as morph targets (Blender shape keys named by id) */
    blendShapes?: { id: string; file: string; }[];
}

/** A file an import writes into the active mod (game-relative path). */
export interface ImportWrite
{
    rel: string;
    data: Uint8Array;
    what: string;
}

export interface ImportOutcome
{
    writes: ImportWrite[];
    notes: string[];
    warnings: string[];
    /** shapes of the result with their triangle counts */
    shapes: { name: string; triangles: number; vertices: number; status: 'matched' | 'new'; }[];
    removed: string[];
}
