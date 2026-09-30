/**
 * 3D model files for the browser — see docs/images.md.
 *
 * `.asset` files are read for display (pdxmesh / entity declarations, textures, animations, attachments), `.mesh`
 * files are summarized and turned into viewer geometry (bind pose) with the textures of the pdxmesh that declares
 * them. A lazy scan of every .asset file links meshes, blend shape targets and textures back to their declarations.
 * Files are read through the portrait AssetLibrary: the file the game loads for a path, a mod's (also zipped) included.
 */
import { parse, type PNode } from '../indexer/parser.ts';
import type { GameIndex } from '../indexer/gameIndex.ts';
import { T_MODEL } from '../indexer/schema.ts';
import { scalar, field, kids, type AssetLibrary } from './assets.ts';
import { defaultEffectFile, shaderDefinesOf } from '../../shared/shaders.ts';
import { partKind } from './portrait.ts';
import { compose, invert, mul, sampleJoint, type AnimFile, type Bone, type M4, type MeshFile, type MeshPart } from './mesh.ts';
import type { ModelExportPlan } from '../blender/types.ts';
import type { AssetFileInfo, LinkSpan, MeshFileInfo, ModelEntityDecl, ModelFolderItem, ModelGeometry, ModelInfo, ModelMeshSettings, ModelPdxMesh, ModelTexture, PartSkin, PortraitDecal, PortraitPart } from '../../shared/api.ts';

/** pdxmesh as the scan keeps it */
interface ScanMesh
{
    asset: string;
    pdxmesh: string;
    file?: string;
    settings: ModelMeshSettings[];
    /** the pdxmesh `scale` (GPU-skinned parts) */
    scale?: number;
}

interface Scan
{
    /** lower-case mesh path → pdxmesh declarations using it */
    byMeshFile: Map<string, ScanMesh[]>;
    /** lower-case mesh path → blend shape declarations with it as target */
    byBlendFile: Map<string, { asset: string; pdxmesh: string; id: string; }[]>;
    /** lower-case image path → materials using it */
    byTexture: Map<string, { asset: string; pdxmesh: string; role: string; }[]>;
    pdxmeshAsset: Map<string, string>;
    entityAsset: Map<string, string>;
    assetSummary: Map<string, { meshes: number; entities: number; thumb?: string; }>;
}

const TEXTURE_KEYS: [string, string][] = [
    ['texture_diffuse', 'diffuse'],
    ['texture_normal', 'normal'],
    ['texture_specular', 'properties']
];
/** embedded .mesh materials name their textures too (often older names than the asset's) */
const MATERIAL_KEYS: [string, string][] = [
    ['diff', 'diffuse'],
    ['n', 'normal'],
    ['spec', 'properties']
];

/** neutral palette colours for portrait skin/hair/eye shaders shown without a character */
const DEFAULT_COLORS: Partial<Record<PortraitPart['kind'], [number, number, number]>> = {
    skin: [0.82, 0.64, 0.52],
    hair: [0.32, 0.21, 0.12],
    eye: [0.36, 0.46, 0.56]
};

const dirOf = (p: string): string => p.slice(0, p.lastIndexOf('/') + 1);

/** Effect file of a shader when no asset names it (meshes nobody declares). */
const lodOf = (shape: string): number | undefined =>
{
    const m = /_lod(\d+)/i.exec(shape);
    return m && m[1] !== '0' ? parseInt(m[1], 10) : undefined;
};

/** The decal list of a mesh creatures show — the portrait builder's first character showing it (docs/portraits.md, "Creatures"). */
type DecalSource = (mesh: string) => Promise<{ decals: PortraitDecal[]; from: string; } | undefined>;

export class ModelBrowser
{
    private idx: GameIndex;
    private lib: AssetLibrary;
    private scan: Scan | null = null;
    private decalSource?: DecalSource;

    constructor(idx: GameIndex, lib: AssetLibrary, decalSource?: DecalSource)
    {
        this.idx = idx;
        this.lib = lib;
        this.decalSource = decalSource;
    }

    // -------------------------------------------------------------------------
    // Resolution helpers
    // -------------------------------------------------------------------------

    /** Model file referenced from an asset (relative to its folder unless game-relative) → model entity name. */
    private meshPath(ref: string | undefined, dir: string): string | undefined
    {
        if (!ref)
            return undefined;

        const r = ref.replace(/\\/g, '/');
        return (this.idx.modelByPath(/^gfx\//i.test(r) ? r : dir + r) ?? this.idx.modelByPath(r))?.name;
    }

    private texture(role: string, ref: string, dirs: string[]): ModelTexture
    {
        return { role, ref, path: this.idx.findTexture(ref, dirs)?.name };
    }

    private settingsOf(n: PNode, dir: string): ModelMeshSettings
    {
        const list = kids(n);
        const textures: ModelTexture[] = [];

        for (const [key, role] of TEXTURE_KEYS)
        {
            const ref = scalar(field(list, key));

            if (ref)
                textures.push(this.texture(role, ref, [dir]));
        }

        // extra textures: texture = { file = "…_unique.dds" index = 5 }
        for (const t of list.filter((c) => c.k === 'texture' && Array.isArray(c.v)))
        {
            const ref = scalar(field(kids(t), 'file'));

            if (ref)
                textures.push(this.texture(`texture ${scalar(field(kids(t), 'index')) ?? ''}`.trim(), ref, [dir]));
        }

        return {
            shape: scalar(field(list, 'name')) ?? '',
            index: parseInt(scalar(field(list, 'index')) ?? '0', 10) || 0,
            shader: scalar(field(list, 'shader')),
            shaderFile: scalar(field(list, 'shader_file')),
            defines: shaderDefinesOf(kids(field(list, 'additional_shader_defines')).map(scalar)),
            textures
        };
    }

    /** Every pdxmesh / entity block of a parsed .asset, at any depth (a few sit inside other blocks). */
    private blocks(nodes: PNode[], out: { meshes: PNode[]; entities: PNode[]; other: Map<string, number>; }, depth = 0): void
    {
        for (const n of nodes)
        {
            if (!n.k)
                continue;

            if (n.k === 'pdxmesh' && Array.isArray(n.v))
                out.meshes.push(n);
            else if (n.k === 'entity' && Array.isArray(n.v))
                out.entities.push(n);
            else if (Array.isArray(n.v) && depth === 0 && n.k !== 'pdxmesh')
            {
                out.other.set(n.k, (out.other.get(n.k) ?? 0) + 1);
                this.blocks(n.v, out, depth + 1);
            }
        }
    }

    /** A model file's text through the layering of game and mods (packed mods: from the zip). */
    private readText(path: string): string | undefined
    {
        return this.lib.readText(path);
    }

    /** Where a model file is (disk path or `archive.zip › entry`) and its size. */
    private located(path: string): { abs: string; bytes: number; }
    {
        const f = this.lib.file(path);
        return { abs: this.lib.where(path), bytes: f ? Math.max(0, this.lib.vfs.stat(f).size) : 0 };
    }

    // -------------------------------------------------------------------------
    // Scan of all .asset files (on first use, ~2 s)
    // -------------------------------------------------------------------------

    private ensureScan(): Scan
    {
        if (this.scan)
            return this.scan;

        const s: Scan = { byMeshFile: new Map(), byBlendFile: new Map(), byTexture: new Map(), pdxmeshAsset: new Map(), entityAsset: new Map(), assetSummary: new Map() };
        const push = <T>(m: Map<string, T[]>, k: string, v: T): void =>
        {
            const l = m.get(k);

            if (l)
                l.push(v);
            else
                m.set(k, [v]);
        };

        for (const asset of this.idx.names(T_MODEL))
        {
            if (!asset.toLowerCase().endsWith('.asset'))
                continue;

            const text = this.readText(asset);

            if (!text)
                continue;

            let nodes: PNode[];

            try
            {
                nodes = parse(text);
            }
            catch
            {
                continue;
            }

            const dir = dirOf(asset);
            const found = { meshes: [] as PNode[], entities: [] as PNode[], other: new Map<string, number>() };
            this.blocks(nodes, found);
            let thumb: string | undefined;

            for (const m of found.meshes)
            {
                const list = kids(m);
                const name = scalar(field(list, 'name')) ?? '';

                if (name && !s.pdxmeshAsset.has(name))
                    s.pdxmeshAsset.set(name, asset);

                const file = this.meshPath(scalar(field(list, 'file')), dir);
                const settings = list.filter((c) => c.k === 'meshsettings').map((c) => this.settingsOf(c, dir));
                const scale = parseFloat(scalar(field(list, 'scale')) ?? '');

                if (file)
                    push(s.byMeshFile, file.toLowerCase(), { asset, pdxmesh: name, file, settings, scale: Number.isFinite(scale) ? scale : undefined });

                for (const st of settings)
                {
                    for (const t of st.textures)
                    {
                        if (!t.path)
                            continue;

                        push(s.byTexture, t.path.toLowerCase(), { asset, pdxmesh: name, role: t.role });

                        if (!thumb && t.role === 'diffuse')
                            thumb = t.path;
                    }
                }

                for (const b of list.filter((c) => c.k === 'blend_shape'))
                {
                    const target = this.meshPath(scalar(field(kids(b), 'type')), dir);

                    if (target)
                        push(s.byBlendFile, target.toLowerCase(), { asset, pdxmesh: name, id: scalar(field(kids(b), 'id')) ?? '' });
                }
            }

            for (const e of found.entities)
            {
                const name = scalar(field(kids(e), 'name'));

                if (name && !s.entityAsset.has(name))
                    s.entityAsset.set(name, asset);
            }

            s.assetSummary.set(asset, { meshes: found.meshes.length, entities: found.entities.length, thumb });
        }

        this.scan = s;
        return s;
    }

    // -------------------------------------------------------------------------
    // Queries
    // -------------------------------------------------------------------------

    folder(folder: string): ModelFolderItem[]
    {
        const s = this.ensureScan();
        return this.idx.filesIn(T_MODEL, folder).map(({ name, file, mod, touch }) =>
        {
            if (file.toLowerCase().endsWith('.asset'))
            {
                const sum = s.assetSummary.get(name);
                const parts = sum ? [sum.meshes && `${sum.meshes} mesh${sum.meshes === 1 ? '' : 'es'}`, sum.entities && `${sum.entities} entit${sum.entities === 1 ? 'y' : 'ies'}`].filter(Boolean) : [];
                return { name, file, kind: 'asset', thumb: sum?.thumb, summary: parts.join(' · ') || undefined, mod, touch };
            }

            const decl = s.byMeshFile.get(name.toLowerCase())?.[0];
            const blend = s.byBlendFile.get(name.toLowerCase())?.[0];
            return {
                name,
                file,
                kind: 'mesh',
                thumb: decl?.settings.flatMap((x) => x.textures).find((t) => t.role === 'diffuse' && t.path)?.path,
                summary: blend ? `blend shape ${blend.id}` : decl ? undefined : 'not declared',
                mod,
                touch
            };
        });
    }

    info(path: string): ModelInfo | null
    {
        const e = this.idx.modelByPath(path);

        if (!e)
            return null;

        return e.name.toLowerCase().endsWith('.asset') ? this.assetInfo(e.name) : this.meshInfo(e.name);
    }

    textureUsers(path: string): { asset: string; pdxmesh: string; role: string; }[]
    {
        return this.ensureScan().byTexture.get(path.toLowerCase()) ?? [];
    }

    private assetInfo(path: string): AssetFileInfo
    {
        const s = this.ensureScan();
        const { abs, bytes } = this.located(path);
        const text = this.readText(path) ?? '';
        const dir = dirOf(path);
        let nodes: PNode[] = [];

        try
        {
            nodes = parse(text);
        }
        catch
        {
            /* shown as source only */
        }

        const found = { meshes: [] as PNode[], entities: [] as PNode[], other: new Map<string, number>() };
        this.blocks(nodes, found);
        const textures: ModelTexture[] = [];
        const seenTex = new Set<string>();
        const addTex = (t: ModelTexture): void =>
        {
            const k = (t.path ?? t.ref).toLowerCase();

            if (!seenTex.has(k))
            {
                seenTex.add(k);
                textures.push(t);
            }
        };

        const meshes: ModelPdxMesh[] = found.meshes.map((m) =>
        {
            const list = kids(m);
            const fileRef = scalar(field(list, 'file')) ?? '';
            const settings = list.filter((c) => c.k === 'meshsettings').map((c) => this.settingsOf(c, dir));
            settings.forEach((st) => st.textures.forEach(addTex));
            const scale = parseFloat(scalar(field(list, 'scale')) ?? '');
            return {
                name: scalar(field(list, 'name')) ?? '',
                fileRef,
                file: this.meshPath(fileRef, dir),
                scale: Number.isFinite(scale) ? scale : undefined,
                settings,
                blendShapes: list
                    .filter((c) => c.k === 'blend_shape')
                    .map((b) =>
                    {
                        const ref = scalar(field(kids(b), 'type')) ?? '';
                        return { id: scalar(field(kids(b), 'id')) ?? '', ref, file: this.meshPath(ref, dir) };
                    }),
                animations: list
                    .filter((c) => (c.k === 'animation' || c.k === 'additive_animation') && Array.isArray(c.v))
                    .map((a) => ({ id: scalar(field(kids(a), 'id')) ?? '', ref: scalar(field(kids(a), 'type')) ?? '', additive: a.k === 'additive_animation' })),
                line: m.line
            };
        });

        const entities: ModelEntityDecl[] = found.entities.map((n) =>
        {
            const list = kids(n);
            const pdxmesh = scalar(field(list, 'pdxmesh'));
            const acc = kids(field(kids(field(kids(field(list, 'game_data')), 'portrait_entity_user_data')), 'portrait_accessory'));
            const mask = scalar(field(acc, 'pattern_mask'));
            const patternMask = mask ? this.texture('pattern mask', mask, [dir]) : undefined;

            if (patternMask)
                addTex(patternMask);

            const scale = parseFloat(scalar(field(list, 'scale')) ?? '');
            const pdxAsset = pdxmesh ? s.pdxmeshAsset.get(pdxmesh) : undefined;
            return {
                name: scalar(field(list, 'name')) ?? '',
                pdxmesh,
                pdxmeshAsset: pdxAsset && pdxAsset !== path ? pdxAsset : undefined,
                defaultState: scalar(field(list, 'default_state')),
                states: list.filter((c) => c.k === 'state' && Array.isArray(c.v)).map((st) => ({ name: scalar(field(kids(st), 'name')) ?? '', animation: scalar(field(kids(st), 'animation')) })),
                attaches: list
                    .filter((c) => c.k === 'attach' && Array.isArray(c.v))
                    .flatMap((a) => kids(a))
                    .filter((c) => c.k && typeof c.v === 'string')
                    .map((c) => ({ node: c.k!, entity: c.v as string, asset: s.entityAsset.get(c.v as string) })),
                attributes: list.filter((c) => c.k === 'attribute').length,
                scale: Number.isFinite(scale) ? scale : undefined,
                patternMask,
                variation: scalar(field(acc, 'variation')),
                line: n.line
            };
        });

        // clickable file names in the source: textures and meshes (relative to the asset or game paths)
        const links: LinkSpan[] = [];
        const re = /"([^"\n]+\.(dds|png|tga|mesh))"/gi;

        for (let m = re.exec(text); m; m = re.exec(text))
        {
            const ref = m[1];
            const target = /\.mesh$/i.test(ref) ? this.meshPath(ref, dir) : this.idx.findTexture(ref, [dir])?.name;

            if (target)
                links.push({ start: m.index + 1, end: m.index + 1 + ref.length, targets: [{ type: /\.mesh$/i.test(ref) ? T_MODEL : 'images', name: target }] });
        }

        return {
            kind: 'asset',
            path,
            abs,
            bytes,
            meshes,
            entities,
            other: [...found.other].filter(([k]) => k !== 'entity').map(([key, count]) => ({ key, count })),
            textures,
            accessories: [...new Set(entities.flatMap((e) => this.lib.accessoriesUsing(e.name)))].sort(),
            source: { file: path, absPath: abs, line: 1, endLine: text.split('\n').length, source: text, links }
        };
    }

    /**
     * Texture set of a mesh part: its pdxmesh's meshsettings for (shape, sub-mesh index), else the material embedded
     * in the .mesh file. Shape names in .mesh files are cut at 64 characters, so a prefix match counts.
     */
    private shapeTextures(
        decl: ScanMesh | undefined,
        parts: { shape: string; }[],
        i: number,
        material: Record<string, string>,
        meshDir: string
    ): { shader?: string; shaderFile?: string; defines?: string[]; textures: ModelTexture[]; }
    {
        const shape = parts[i].shape;
        const sub = parts.slice(0, i).filter((p) => p.shape === shape).length;
        const same = (x: ModelMeshSettings): boolean => x.shape === shape || (shape.length >= 60 && x.shape.startsWith(shape));
        const st = decl && (decl.settings.find((x) => same(x) && x.index === sub) ?? decl.settings.find(same) ?? decl.settings[i]);

        if (st)
            return { shader: st.shader ?? material.shader, shaderFile: st.shaderFile, defines: st.defines, textures: st.textures };

        const textures: ModelTexture[] = [];

        for (const [key, role] of MATERIAL_KEYS)
            if (material[key])
                textures.push(this.texture(role, material[key], [meshDir]));

        return { shader: material.shader, textures };
    }

    private meshInfo(path: string): MeshFileInfo
    {
        const s = this.ensureScan();
        const { abs, bytes } = this.located(path);
        const declaredIn = (s.byMeshFile.get(path.toLowerCase()) ?? []).map((d) => ({ asset: d.asset, pdxmesh: d.pdxmesh }));
        const blendShapeOf = s.byBlendFile.get(path.toLowerCase()) ?? [];
        const info: MeshFileInfo = { kind: 'mesh', path, abs, bytes, shapes: [], bones: [], declaredIn, blendShapeOf };
        let file;

        try
        {
            file = this.lib.mesh(path);
        }
        catch (err)
        {
            info.error = String((err as Error).message ?? err);
            return info;
        }

        if (!file)
        {
            info.error = 'Could not read the file.';
            return info;
        }

        const decl = s.byMeshFile.get(path.toLowerCase())?.[0];
        info.bones = file.bones.map((b) => b.name.slice(b.name.lastIndexOf(':') + 1));
        info.shapes = file.parts.map((p, i) =>
        {
            const min: [number, number, number] = [Infinity, Infinity, Infinity];
            const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

            for (let k = 0; k < p.positions.length; k++)
            {
                if (p.positions[k] < min[k % 3])
                    min[k % 3] = p.positions[k];

                if (p.positions[k] > max[k % 3])
                    max[k % 3] = p.positions[k];
            }

            const { shader, textures } = this.shapeTextures(decl, file.parts, i, p.material, dirOf(path));
            return {
                name: p.shape,
                vertices: p.positions.length / 3,
                triangles: p.indices.length / 3,
                skinned: !!p.skin,
                uvSets: p.uvs2 ? 2 : 1,
                shader,
                lod: lodOf(p.shape),
                decal: shader?.startsWith('decal') || undefined,
                min,
                max,
                textures
            };
        });
        return info;
    }

    /** Viewer geometry in bind pose: a .mesh file, or one pdxmesh of an .asset (default: the first). */
    async geometry(path: string, pdxmesh?: string): Promise<ModelGeometry | null>
    {
        const s = this.ensureScan();
        const e = this.idx.modelByPath(path);

        if (!e)
            return null;

        let meshFile = e.name;
        let decl: ScanMesh | undefined;

        if (e.name.toLowerCase().endsWith('.asset'))
        {
            const info = this.assetInfo(e.name);
            const m = info.meshes.find((x) => x.name === pdxmesh) ?? info.meshes.find((x) => x.file);

            if (!m?.file)
                return null;

            meshFile = m.file;
            decl = { asset: e.name, pdxmesh: m.name, file: m.file, settings: m.settings, scale: m.scale };
        }
        else
        {
            decl = s.byMeshFile.get(e.name.toLowerCase())?.[0];
        }

        const file = this.lib.mesh(meshFile);

        if (!file)
            return null;

        const pose = file.bones.length && file.parts.some((p) => p.skin) ? this.skinPose(decl, file) : undefined;
        const parts: PortraitPart[] = file.parts.map((p, i) =>
        {
            const { shader, shaderFile, defines, textures } = this.shapeTextures(decl, file.parts, i, p.material, dirOf(meshFile));
            const tex = (role: string): string | undefined => textures.find((t) => t.role === role)?.path;
            const byRole: Record<string, string> = {};

            for (const t of textures)
                if (t.path)
                    byRole[t.role] = t.path;

            const kind: PortraitPart['kind'] = shader?.startsWith('portrait') ? partKind(shader) : 'prop';
            return {
                name: p.shape,
                kind,
                shader,
                cutout: /alpha|^portrait_hair/.test(shader ?? ''),
                shaderFile: shaderFile ?? defaultEffectFile(shader),
                shaderDefines: defines,
                positions: p.positions,
                normals: p.normals,
                tangents: p.tangents,
                uvs: p.uvs,
                uvs2: p.uvs2,
                indices: p.indices,
                textures: byRole,
                diffuse: tex('diffuse'),
                normal: tex('normal'),
                properties: tex('properties'),
                color: DEFAULT_COLORS[kind],
                lod: lodOf(p.shape),
                decal: shader?.startsWith('decal') || undefined,
                skin: p.skin && pose ? partSkin(p, pose.joints, pose.scale) : undefined
            };
        });
        const geo: ModelGeometry = { parts, mesh: meshFile, pdxmesh: decl?.pdxmesh, bones: file.bones.length, pose: pose?.animation };

        // a mesh creatures show: their shaders may take its colours from the decal list
        if (this.decalSource)
        {
            const d = await this.decalSource(meshFile);

            if (d)
            {
                geo.decals = d.decals;
                geo.decalsFrom = d.from;
            }
        }

        return geo;
    }

    /**
     * What an export to Blender needs (src/main/blender, docs/blender.md): the .mesh file of a mesh page or of an
     * .asset's pdxmesh (default: the first with a file) and the material of each sub-mesh, in file order.
     */
    exportPlan(path: string, pdxmesh?: string): ModelExportPlan | null
    {
        const s = this.ensureScan();
        const e = this.idx.modelByPath(path);

        if (!e)
            return null;

        let meshFile = e.name;
        let decl: ScanMesh | undefined;

        if (e.name.toLowerCase().endsWith('.asset'))
        {
            const info = this.assetInfo(e.name);
            const m = info.meshes.find((x) => x.name === pdxmesh && x.file) ?? info.meshes.find((x) => x.file);

            if (!m?.file)
                return null;

            meshFile = m.file;
            decl = { asset: e.name, pdxmesh: m.name, file: m.file, settings: m.settings, scale: m.scale };
        }
        else
            decl = s.byMeshFile.get(e.name.toLowerCase())?.[0];

        const file = this.lib.mesh(meshFile);

        if (!file)
            return null;

        const parts = file.parts.map((p, i) =>
        {
            const { shader, textures } = this.shapeTextures(decl, file.parts, i, p.material, dirOf(meshFile));
            return { shape: p.shape, index: file.parts.slice(0, i).filter((x) => x.shape === p.shape).length, shader, textures };
        });
        const textureUsers: Record<string, number> = {};

        for (const t of parts.flatMap((p) => p.textures))
            if (t.path)
                textureUsers[t.path.toLowerCase()] = this.textureUsers(t.path).length;

        // blend shape targets: .mesh files with the same vertex order (they travel as glTF morph targets)
        const pdx = decl ? this.assetInfo(decl.asset).meshes.find((m) => m.name === decl!.pdxmesh) : undefined;
        const blendShapes = (pdx?.blendShapes ?? []).filter((b) => b.file).map((b) => ({ id: b.id, file: b.file! }));
        return { model: e.name, mesh: this.idx.modelByPath(meshFile)?.name ?? meshFile, asset: decl?.asset, pdxmesh: decl?.pdxmesh, parts, textureUsers, blendShapes };
    }

    /**
     * Joint matrices for GPU-skinned parts (docs/shaders.md, "GPU skinning"): the first frame of the animation of the
     * default state of the entity showing this pdxmesh (AGOT's particle rigs sit at the origin in bind pose), else the
     * bind pose.
     */
    private skinPose(decl: ScanMesh | undefined, file: MeshFile): { joints: Float32Array; scale: number; animation?: string; }
    {
        const scale = decl?.scale ?? 1;
        const asset = decl ? this.lib.asset(decl.asset) : undefined;
        const entity = asset && [...asset.entities.values()].find((x) => x.pdxmesh === decl!.pdxmesh);
        const id = entity?.defaultState ? entity.states.get(entity.defaultState) : undefined;
        const path = id ? asset!.animations.get(id) : undefined;
        const anim = path ? this.lib.anim(path) : undefined;
        return { joints: jointMatrices(file, anim, scale), scale, animation: anim ? id : undefined };
    }
}

/**
 * The engine's joint vertex matrices (posed world · inverse bind) in bone index order, 12 floats per joint as
 * JointVertexMatrices packs them: x, y, z axis, translation. Local transforms come from the animation's first frame
 * (absolute, per joint name), else from the bind pose. The pdxmesh `scale` scales the rig's space: translations only.
 */
function jointMatrices(file: MeshFile, anim: AnimFile | undefined, scale: number): Float32Array
{
    const byIndex = new Map(file.bones.map((b) => [b.index, b]));
    const bind = new Map(file.bones.map((b) => [b.index, invert(b.invBind)]));
    const animated = new Map((anim?.joints ?? []).map((j) => [j.name, j]));
    const world = new Map<number, M4>();
    const worldOf = (b: Bone, depth = 0): M4 =>
    {
        let w = world.get(b.index);

        if (w)
            return w;

        const parent = b.parent >= 0 && b.parent !== b.index && depth < 256 ? byIndex.get(b.parent) : undefined;
        const j = animated.get(b.name.slice(b.name.lastIndexOf(':') + 1));
        const sample = j && anim ? sampleJoint(j, anim.frames, 0) : undefined;
        const local = sample ? compose(sample.t, sample.q, sample.s) : parent ? mul(invert(bind.get(parent.index)!), bind.get(b.index)!) : bind.get(b.index)!;
        w = parent ? mul(worldOf(parent, depth + 1), local) : local;
        world.set(b.index, w);
        return w;
    };
    const count = file.bones.reduce((n, b) => Math.max(n, b.index + 1), 0);
    const out = new Float32Array(count * 12);

    // indices no bone has: identity
    for (let i = 0; i < count; i++)
        out.set([1, 0, 0, 0, 1, 0, 0, 0, 1], i * 12);

    for (const b of file.bones)
    {
        const m = mul(worldOf(b), b.invBind);
        out.set([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10], m[12] * scale, m[13] * scale, m[14] * scale], b.index * 12);
    }

    return out;
}

/** A part's skin as the engine's vertex streams: 4 bone indices and the first 3 weights per vertex. */
function partSkin(p: MeshPart, joints: Float32Array, scale: number): PartSkin
{
    const n = p.positions.length / 3;
    const skin = p.skin!;
    // `infs` is the influence count, but the arrays can use a stride of 4 anyway (docs/portraits.md)
    const stride = Math.max(1, Math.round(skin.ix.length / Math.max(1, n)));
    const bones = new Uint16Array(n * 4);
    const weights = new Float32Array(n * 3);

    for (let v = 0; v < n; v++)
    {
        for (let k = 0; k < Math.min(4, stride); k++)
        {
            const ix = skin.ix[v * stride + k];

            // unused influences are -1 in the file
            if (ix < 0)
                continue;

            bones[v * 4 + k] = ix;

            if (k < 3)
                weights[v * 3 + k] = skin.w[v * stride + k] ?? 0;
        }
    }

    return { bones, weights, joints, scale };
}
