/**
 * PDX `.mesh` → glTF 2.0 for Blender (docs/blender.md): every shape a node + mesh named after it (LODs and decal
 * planes too), one primitive per sub-mesh, both UV sets, normals, tangents, skin (joints named like the PDX bones,
 * hierarchy from their parents, inverse bind matrices). The game is Y-up left-handed: z is mirrored (positions,
 * normals, tangent xyz, joint matrices conjugated) and the triangle winding flipped; tangent w stays (the mirror
 * already flips the bitangent's cross product — see the doc). UVs are the game's as they are: glTF and the game both
 * put (0, 0) at the image's top left. Textures become PNGs next to the glTF; a manifest records where everything came
 * from. Plain Node (runs in the Blender worker).
 */
import { parsePdx, find, type PdxNode } from '../portraits/pdx.ts';
import { compose, decompose, invert, mul, type M4 } from '../portraits/mesh.ts';
import { encodePng } from '../images/png.ts';
import type { RgbaImage } from '../images/ddsEncode.ts';
import { GltfBuilder, UNSIGNED_INT, type GltfDoc, type GltfMaterial, type GltfNode, type GltfPrimitive } from './gltf.ts';
import { channelHashes, decodeTexture, normalToGltf, pixelHash, propertiesToOrm } from './textures.ts';
import type { BlenderManifest, ManifestMaterial, ManifestTexture, ModelExportPlan, PlanPart, PlanTexture } from './types.ts';

export const GENERATOR = 'CrusaderPope';

export interface ExportInput
{
    plan: ModelExportPlan;
    meshBytes: Uint8Array;
    /** where the mesh was read (for the manifest) */
    meshWhere: string;
    /** a texture's bytes by game path (undefined: missing) */
    read: (path: string) => Uint8Array | undefined;
    /** file names: `<name>.gltf`, `<name>.bin`, `<name>.crusaderpope.json` */
    name: string;
}

export interface ExportOutput
{
    files: { name: string; data: Uint8Array | string; }[];
    manifest: BlenderManifest;
    warnings: string[];
    counts: { shapes: number; primitives: number; vertices: number; triangles: number; joints: number; materials: number; textures: number; blendShapes: number; };
}

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

/** Game ↔ glTF: conjugate a column-major 4×4 by the z mirror (negate entries with exactly one z index). */
export function mirrorMatrix(m: ArrayLike<number>): M4
{
    const o = new Float64Array(16);

    for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++)
            o[c * 4 + r] = (r === 2) !== (c === 2) ? -m[c * 4 + r] : m[c * 4 + r];

    return o;
}

/** A bone's inverse bind matrix from its 12 `tx` floats (3 columns + translation). */
export function txMatrix(tx: ArrayLike<number>): M4
{
    const m = new Float64Array(16);
    m.set([tx[0], tx[1], tx[2], 0, tx[3], tx[4], tx[5], 0, tx[6], tx[7], tx[8], 0, tx[9], tx[10], tx[11], 1]);
    return m;
}

export interface PdxBone
{
    name: string;
    ix: number;
    pa: number;
    tx: Float32Array;
}

export function bonesOf(skeleton: PdxNode): PdxBone[]
{
    return skeleton.children.map((b) => ({ name: b.name, ix: (b.props.ix as Int32Array)[0], pa: b.props.pa ? (b.props.pa as Int32Array)[0] : -1, tx: b.props.tx as Float32Array }));
}

export function strProps(node: PdxNode | undefined): Record<string, string>
{
    const out: Record<string, string> = {};

    for (const [k, v] of Object.entries(node?.props ?? {}))
        if (Array.isArray(v) && typeof v[0] === 'string')
            out[k] = v[0];

    return out;
}

const finite = (x: number): number => (Number.isFinite(x) ? x : 0);

function normalize3(x: number, y: number, z: number): [number, number, number]
{
    const l = Math.hypot(x, y, z);
    return l > 1e-12 && Number.isFinite(l) ? [x / l, y / l, z / l] : [0, 1, 0];
}

export interface SubMeshMaterial
{
    /** identity: shader, the .mesh material block and the textures */
    key: string;
    /** glTF / Blender material name (the diffuse texture's file name, unique per key) */
    name: string;
    shader?: string;
    pdx: Record<string, string>;
    textures: PlanTexture[];
}

/**
 * The material of every sub-mesh (per shape, per mesh; file order) with the names the export gives them — the same
 * names come out for the same file and plan, so an import without manifest still finds them.
 */
export function subMeshMaterials(object: PdxNode, plan: ModelExportPlan): SubMeshMaterial[][]
{
    const byKey = new Map<string, SubMeshMaterial>();
    const names = new Set<string>();
    let partNo = 0;
    return object.children.map((shape) =>
        shape.children
            .filter((c) => c.name === 'mesh')
            .map((mesh, mi) =>
            {
                const planned = plan.parts[partNo++];
                const part: PlanPart = planned?.shape === shape.name ? planned : { shape: shape.name, index: mi, textures: [] };
                const pdx = strProps(find(mesh, 'material'));
                const shader = part.shader ?? pdx.shader;
                const key = JSON.stringify([shader, pdx, part.textures.map((t) => [t.role, (t.path ?? t.ref).toLowerCase()])]);
                let m = byKey.get(key);

                if (m)
                    return m;

                const diffuse = part.textures.find((t) => t.role === 'diffuse');
                const stem = (diffuse ? base(diffuse.path ?? diffuse.ref) : shader || shape.name).slice(0, 60);
                let name = stem;

                for (let k = 2; names.has(name.toLowerCase()); k++)
                    name = `${stem}_${k}`;

                names.add(name.toLowerCase());
                m = { key, name, shader, pdx, textures: part.textures };
                byKey.set(key, m);
                return m;
            })
    );
}

/** Cut-out and blended shaders (alpha as opacity). */
export function alphaModeOf(shader: string | undefined): GltfMaterial['alphaMode']
{
    if (!shader)
        return 'OPAQUE';

    if (/alpha|hair|cutout|leaves|foliage/i.test(shader))
        return 'MASK';

    if (/^decal|transparen|blend/i.test(shader))
        return 'BLEND';

    return 'OPAQUE';
}

export async function exportMesh(input: ExportInput): Promise<ExportOutput>
{
    const { plan } = input;
    const warnings: string[] = [];
    const root = parsePdx(input.meshBytes);
    const object = find(root, 'object');

    if (!object)
        throw new Error(`${plan.mesh} has no objects.`);

    const g = new GltfBuilder(GENERATOR);
    const doc = g.doc;
    const files: ExportOutput['files'] = [];
    const counts = { shapes: 0, primitives: 0, vertices: 0, triangles: 0, joints: 0, materials: 0, textures: 0, blendShapes: 0 };

    // ---- skeletons: identical copies (one per skinned shape) share one skin; each distinct one has its joint nodes ----
    const skeletons: { shape: number; bones: PdxBone[]; key: string; }[] = [];
    object.children.forEach((shape, si) =>
    {
        const sk = find(shape, 'skeleton');

        if (!sk?.children.length)
            return;

        const bones = bonesOf(sk);
        skeletons.push({ shape: si, bones, key: bones.map((b) => `${b.name}|${b.ix}|${b.pa}|${Array.from(b.tx).join(',')}`).join(';') });
    });
    /** per distinct skeleton: its joint node by bone index */
    const jointSets = new Map<string, Map<number, number>>();
    /** bone name → joint node (the first skeleton's; locators hang on them) */
    const jointNode = new Map<string, number>();
    /** scene roots: shape nodes (file order), then root joints and locators */
    const shapeNodes: number[] = [];
    const otherRoots: number[] = [];

    for (const s of skeletons)
    {
        if (jointSets.has(s.key))
            continue;

        const nodesByIx = new Map<number, number>();
        jointSets.set(s.key, nodesByIx);
        const byIx = new Map(s.bones.map((b) => [b.ix, b]));
        const world = new Map(s.bones.map((b) => [b.ix, invert(txMatrix(b.tx))]));
        // bone names repeat in some rigs (a horse's four hooves): later ones get Blender's own `.001` suffixes
        const seen = new Map<string, number>();

        for (const b of s.bones)
        {
            const k = seen.get(b.name) ?? 0;
            seen.set(b.name, k + 1);
            const name = k ? `${b.name}.${String(k).padStart(3, '0')}` : b.name;
            const n = doc.nodes!.push({ name }) - 1;
            nodesByIx.set(b.ix, n);

            if (!jointNode.has(b.name))
                jointNode.set(b.name, n);
        }

        for (const b of s.bones)
        {
            const parent = b.pa >= 0 && b.pa !== b.ix ? byIx.get(b.pa) : undefined;
            setTransform(doc.nodes![nodesByIx.get(b.ix)!], mirrorMatrix(parent ? mul(invert(world.get(parent.ix)!), world.get(b.ix)!) : world.get(b.ix)!));

            if (parent)
                (doc.nodes![nodesByIx.get(parent.ix)!].children ??= []).push(nodesByIx.get(b.ix)!);
            else
                otherRoots.push(nodesByIx.get(b.ix)!);
        }

        counts.joints += s.bones.length;
    }

    const skinOf = new Map<string, number>();
    const skinFor = (shapeIndex: number): number | undefined =>
    {
        const s = skeletons.find((x) => x.shape === shapeIndex) ?? skeletons[0];

        if (!s)
            return undefined;

        let i = skinOf.get(s.key);

        if (i !== undefined)
            return i;

        const nodesByIx = jointSets.get(s.key)!;
        const count = s.bones.reduce((n, b) => Math.max(n, b.ix + 1), 0);
        const joints: number[] = [];
        const ibm = new Float32Array(count * 16);

        for (let k = 0; k < count; k++)
        {
            const b = s.bones.find((x) => x.ix === k);

            if (b)
            {
                joints.push(nodesByIx.get(k)!);
                ibm.set(mirrorMatrix(txMatrix(b.tx)), k * 16);
            }
            else
            {
                // an index no bone has: a placeholder joint at the origin
                const n = doc.nodes!.push({ name: `crusaderpope_unused_joint_${k}` }) - 1;
                otherRoots.push(n);
                joints.push(n);
                ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], k * 16);
                warnings.push(`Bone index ${k} is not used by the skeleton: a placeholder joint stands in.`);
            }
        }

        doc.skins ??= [];
        const top = s.bones.find((b) => b.pa < 0 || b.pa === b.ix);
        const skin = { name: 'skeleton' + (skinOf.size ? '_' + (skinOf.size + 1) : ''), joints, inverseBindMatrices: g.accessor(ibm, 'MAT4'), ...(top ? { skeleton: nodesByIx.get(top.ix) } : {}) };
        i = doc.skins.push(skin) - 1;
        skinOf.set(s.key, i);
        return i;
    };

    // ---- textures: PNGs next to the glTF, one per game texture and role ----
    const usedNames = new Set<string>([input.name.toLowerCase()]);
    const fileName = (wanted: string): string =>
    {
        let n = wanted;

        for (let k = 2; usedNames.has(n.toLowerCase()); k++)
            n = wanted.replace(/(\.png)$/i, `_${k}$1`);

        usedNames.add(n.toLowerCase());
        return n;
    };
    const textures: ManifestTexture[] = [];
    const images = new Map<string, { image?: number; orm?: number; } | null>();
    const addImage = (file: string): number =>
    {
        const img = doc.images!.push({ uri: encodeURI(file), name: file.replace(/\.png$/i, '') }) - 1;
        return doc.textures!.push({ source: img, sampler: 0 }) - 1;
    };
    const textureFor = async (path: string, role: string): Promise<{ image?: number; orm?: number; } | null> =>
    {
        const key = role + '|' + path.toLowerCase();

        if (images.has(key))
            return images.get(key)!;

        images.set(key, null);
        const bytes = input.read(path);

        if (!bytes)
        {
            warnings.push(`Texture not found: ${path}`);
            return null;
        }

        let img: RgbaImage;
        let format: string;
        let mips: number;

        try
        {
            ({ img, format, mips } = await decodeTexture(bytes));
        }
        catch (e)
        {
            warnings.push(`${path}: ${(e as Error).message} — not exported`);
            return null;
        }

        const out: { image?: number; orm?: number; } = {};
        const shown = role === 'normal' ? normalToGltf(img) : img;
        const file = fileName(base(path) + '.png');
        files.push({ name: file, data: encodePng(shown.rgba, shown.width, shown.height) });
        const t: ManifestTexture = { path, role, format, width: img.width, height: img.height, mips, file, hash: pixelHash(shown), channels: channelHashes(shown), users: plan.textureUsers[path.toLowerCase()] };

        if (role === 'diffuse' || role === 'normal')
            out.image = addImage(file);

        if (role === 'properties')
        {
            const orm = propertiesToOrm(img);
            const ormFile = fileName(base(path) + '_orm.png');
            files.push({ name: ormFile, data: encodePng(orm.rgba, orm.width, orm.height) });
            t.orm = { file: ormFile, hash: pixelHash(orm), channels: channelHashes(orm) };
            out.orm = addImage(ormFile);
        }

        textures.push(t);
        counts.textures++;
        images.set(key, out);
        return out;
    };
    doc.samplers!.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });

    // ---- materials: one per distinct shader + .mesh material block + textures ----
    const materials: ManifestMaterial[] = [];
    const materialIndex = new Map<string, number>();
    const subMaterials = subMeshMaterials(object, plan);
    const materialFor = async (sub: SubMeshMaterial, shapeName: string): Promise<number> =>
    {
        const known = materialIndex.get(sub.key);

        if (known !== undefined)
            return known;

        const { name, shader, pdx } = sub;
        const m: GltfMaterial = { name, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.8 } };

        for (const t of sub.textures)
        {
            if (!t.path)
            {
                warnings.push(`${shapeName}: ${t.role} texture ${t.ref} not found`);
                continue;
            }

            const out = await textureFor(t.path, t.role);

            if (!out)
                continue;

            if (t.role === 'diffuse' && out.image !== undefined)
                m.pbrMetallicRoughness!.baseColorTexture = { index: out.image };

            if (t.role === 'normal' && out.image !== undefined)
                m.normalTexture = { index: out.image };

            if (t.role === 'properties' && out.orm !== undefined)
            {
                m.pbrMetallicRoughness!.metallicRoughnessTexture = { index: out.orm };
                m.pbrMetallicRoughness!.metallicFactor = 1;
                m.pbrMetallicRoughness!.roughnessFactor = 1;
            }
        }

        const alpha = alphaModeOf(shader);

        if (alpha !== 'OPAQUE')
            m.alphaMode = alpha;

        if (alpha === 'MASK')
            m.alphaCutoff = 0.5;

        if (alpha !== 'OPAQUE')
            m.doubleSided = true;

        const entry: ManifestMaterial = { name, shader, pdx, textures: sub.textures };
        m.extras = { crusaderpope: entry };
        materials.push(entry);
        const i = doc.materials!.push(m) - 1;
        materialIndex.set(sub.key, i);
        return i;
    };

    // ---- blend shapes: target .mesh files with the base's vertex order → glTF morph targets (Blender shape keys) ----
    const blendShapes: { id: string; file: string; shapes: PdxNode[]; }[] = [];
    const unfit = new Set<string>();

    for (const b of plan.blendShapes ?? [])
    {
        const bytes = input.read(b.file);

        if (!bytes)
        {
            warnings.push(`Blend shape ${b.id}: ${b.file} not found`);
            continue;
        }

        let shapes: PdxNode[];

        try
        {
            shapes = find(parsePdx(bytes), 'object')?.children ?? [];
        }
        catch (e)
        {
            warnings.push(`Blend shape ${b.id}: ${(e as Error).message}`);
            continue;
        }

        // only targets with the base's vertices (some vanilla head targets have another topology: useless to the game too)
        const fits = object.children.every((s, si) =>
        {
            const tm = shapes[si]?.children.filter((c) => c.name === 'mesh') ?? [];
            return s.children.filter((c) => c.name === 'mesh').every((m, mi) => (tm[mi]?.props.p as Float32Array | undefined)?.length === (m.props.p as Float32Array).length);
        });

        if (fits)
            blendShapes.push({ id: b.id, file: b.file, shapes });
        else
            unfit.add(b.id);
    }

    // ---- shapes ----
    const manifestShapes: BlenderManifest['shapes'] = [];

    for (let si = 0; si < object.children.length; si++)
    {
        const shape = object.children[si];
        const meshes = shape.children.filter((c) => c.name === 'mesh');

        if (!meshes.length)
            continue;

        const skinned = meshes.some((m) => find(m, 'skin'));
        const skin = skinned ? skinFor(si) : undefined;

        if (skinned && skin === undefined)
            warnings.push(`${shape.name}: skinned, but the file has no skeleton — exported without skin`);

        const primitives: NonNullable<GltfDoc['meshes']>[number]['primitives'] = [];
        const entry: BlenderManifest['shapes'][number] = { name: shape.name, meshes: [] };

        for (let mi = 0; mi < meshes.length; mi++)
        {
            const mesh = meshes[mi];
            const p = mesh.props.p as Float32Array;
            const nv = p.length / 3;
            const attributes: Record<string, number> = {};
            const pos = new Float32Array(p.length);

            for (let i = 0; i < p.length; i += 3)
            {
                pos[i] = finite(p[i]);
                pos[i + 1] = finite(p[i + 1]);
                pos[i + 2] = -finite(p[i + 2]);
            }

            attributes.POSITION = g.accessor(pos, 'VEC3', { target: 34962, minMax: true });
            const n = mesh.props.n as Float32Array | undefined;

            if (n && n.length === p.length)
            {
                const out = new Float32Array(n.length);

                for (let i = 0; i < n.length; i += 3)
                {
                    const x = finite(n[i]);
                    const y = finite(n[i + 1]);
                    const z = -finite(n[i + 2]);
                    const l = Math.hypot(x, y, z);

                    if (l > 1e-12)
                        out.set([x / l, y / l, z / l], i);
                    else
                        out.set([0, 1, 0], i);
                }

                attributes.NORMAL = g.accessor(out, 'VEC3', { target: 34962 });
                const ta = mesh.props.ta as Float32Array | undefined;

                if (ta && ta.length === nv * 4)
                {
                    const t = new Float32Array(ta.length);

                    for (let i = 0; i < ta.length; i += 4)
                    {
                        const x = finite(ta[i]);
                        const y = finite(ta[i + 1]);
                        const z = -finite(ta[i + 2]);
                        const l = Math.hypot(x, y, z);

                        if (l > 1e-12)
                            t.set([x / l, y / l, z / l], i);
                        else
                            t.set([1, 0, 0], i);

                        t[i + 3] = ta[i + 3] < 0 ? -1 : 1;
                    }

                    attributes.TANGENT = g.accessor(t, 'VEC4', { target: 34962 });
                }
            }

            let uvSets = 0;

            for (const [k, key] of ['u0', 'u1', 'u2', 'u3'].entries())
            {
                const uv = mesh.props[key] as Float32Array | undefined;

                if (!uv || uv.length !== nv * 2)
                    continue;

                attributes[`TEXCOORD_${k}`] = g.accessor(Float32Array.from(uv, finite), 'VEC2', { target: 34962 });
                uvSets++;
            }

            const skinNode = find(mesh, 'skin');

            if (skin !== undefined)
            {
                const joints = doc.skins![skin].joints.length;
                const J = joints > 256 ? new Uint16Array(nv * 4) : new Uint8Array(nv * 4);
                const W = new Float32Array(nv * 4);
                const ix = skinNode?.props.ix as Int32Array | undefined;
                const w = skinNode?.props.w as Float32Array | undefined;
                const stride = ix ? Math.max(1, Math.round(ix.length / Math.max(1, nv))) : 0;

                for (let v = 0; v < nv; v++)
                {
                    let sum = 0;

                    for (let k = 0; k < Math.min(4, stride); k++)
                    {
                        const b = ix![v * stride + k];

                        if (b < 0 || b >= joints)
                            continue;

                        // the engine reads three weights and gives the fourth influence the rest
                        const wt = k < 3 ? Math.max(0, finite(w![v * stride + k])) : Math.max(0, 1 - W[v * 4] - W[v * 4 + 1] - W[v * 4 + 2]);
                        J[v * 4 + k] = b;
                        W[v * 4 + k] = wt;
                        sum += wt;
                    }

                    if (sum > 0)
                    {
                        for (let k = 0; k < 4; k++)
                            W[v * 4 + k] /= sum;
                    }
                    else
                        W[v * 4] = 1; // no influence: follows joint 0 (the rest pose is unchanged)
                }

                attributes.JOINTS_0 = g.accessor(J, 'VEC4', { target: 34962 });
                attributes.WEIGHTS_0 = g.accessor(W, 'VEC4', { target: 34962 });
            }

            // left-handed → right-handed: flip the winding
            const tri = mesh.props.tri as Int32Array;
            const idx = nv > 65535 ? new Uint32Array(tri.length) : new Uint16Array(tri.length);

            for (let i = 0; i + 2 < tri.length; i += 3)
            {
                idx[i] = tri[i];
                idx[i + 1] = tri[i + 2];
                idx[i + 2] = tri[i + 1];
            }

            const indices = g.accessor(idx, 'SCALAR', { target: 34963 });

            if (idx instanceof Uint32Array)
                doc.accessors![indices].componentType = UNSIGNED_INT;

            const material = await materialFor(subMaterials[si][mi], shape.name);
            const primitive: GltfPrimitive = { attributes, indices, material, mode: 4 };

            if (blendShapes.length)
            {
                // morph targets: position and normal offsets from the base (a target's shape and sub-mesh at the same index)
                primitive.targets = blendShapes.map((b) =>
                {
                    const tm = b.shapes[si]?.children.filter((c) => c.name === 'mesh')[mi];
                    // (checked above: the target has this sub-mesh's vertices)
                    const tp = tm!.props.p as Float32Array;
                    const tn = tm!.props.n as Float32Array | undefined;
                    const dp = new Float32Array(p.length);
                    const dn = new Float32Array(p.length);

                    for (let i = 0; i < p.length; i += 3)
                    {
                        for (let k = 0; k < 3; k++)
                            dp[i + k] = (k === 2 ? -1 : 1) * (finite(tp[i + k]) - finite(p[i + k]));

                        if (n && tn && tn.length === n.length)
                        {
                            const a = normalize3(n[i], n[i + 1], n[i + 2]);
                            const t = normalize3(tn[i], tn[i + 1], tn[i + 2]);

                            for (let k = 0; k < 3; k++)
                                dn[i + k] = (k === 2 ? -1 : 1) * (t[k] - a[k]);
                        }
                    }

                    const target: Record<string, number> = { POSITION: g.accessor(dp, 'VEC3', { target: 34962, minMax: true }) };

                    if (attributes.NORMAL !== undefined)
                        target.NORMAL = g.accessor(dn, 'VEC3', { target: 34962 });

                    return target;
                });
            }

            primitives.push(primitive);
            entry.meshes.push({ material: doc.materials![material].name!, vertices: nv, triangles: tri.length / 3, skinned: !!skinNode, uvSets });
            counts.primitives++;
            counts.vertices += nv;
            counts.triangles += tri.length / 3;
        }

        const meshIndex = doc.meshes!.push({
            name: shape.name,
            primitives,
            // (Blender names the shape keys after targetNames)
            ...(blendShapes.length ? { weights: blendShapes.map(() => 0), extras: { targetNames: blendShapes.map((b) => b.id) } } : {})
        }) - 1;
        const node: GltfNode = { name: shape.name, mesh: meshIndex };

        if (skin !== undefined)
            node.skin = skin;

        shapeNodes.push(doc.nodes!.push(node) - 1);
        manifestShapes.push(entry);
        counts.shapes++;
    }

    // ---- locators: empties for reference (parented to their bone) ----
    for (const loc of find(root, 'locator')?.children ?? [])
    {
        const p = loc.props.p as Float32Array | undefined;
        const q = loc.props.q as Float32Array | undefined;
        const node: GltfNode = { name: loc.name, extras: { crusaderpope: 'locator' } };

        if (p)
            node.translation = [finite(p[0]), finite(p[1]), -finite(p[2])];

        if (q)
            node.rotation = [-finite(q[0]), -finite(q[1]), finite(q[2]), finite(q[3])];

        const i = doc.nodes!.push(node) - 1;
        const pa = (loc.props.pa as string[] | undefined)?.[0];

        if (pa && jointNode.has(pa))
            (doc.nodes![jointNode.get(pa)!].children ??= []).push(i);
        else
            otherRoots.push(i);
    }

    doc.scenes![0] = { name: base(plan.mesh), nodes: [...shapeNodes, ...otherRoots] };
    counts.materials = materials.length;
    counts.blendShapes = blendShapes.length;

    if (unfit.size)
        warnings.push(`${unfit.size} blend shape${unfit.size === 1 ? '' : 's'} left out — the target has other vertices than this mesh in the game already: ${[...unfit].slice(0, 6).join(', ')}${unfit.size > 6 ? ' …' : ''}`);

    const manifest: BlenderManifest = {
        crusaderpope: 'blender-export',
        version: 1,
        mesh: plan.mesh,
        model: plan.model,
        asset: plan.asset,
        pdxmesh: plan.pdxmesh,
        source: input.meshWhere,
        exported: new Date().toISOString(),
        gltf: input.name + '.gltf',
        notes: [
            'Exported by CrusaderPope for Blender. Import the .gltf in Blender (File > Import > glTF 2.0), edit, export as glTF (.glb or .gltf) and bring it back with “Import from Blender…” on the model page.',
            'Coordinates: the game is Y-up left-handed; z is mirrored here. 1 game unit = 1 Blender metre.',
            'Normal maps are standard tangent-space maps here (the game packs x in green and y in alpha).',
            'Properties maps: the *_orm.png (roughness in G, metalness in B) is bound in Blender; the full map (r = SSS/AO, g = specular, b = metalness, a = roughness) is the PNG named like the game texture — edit either.',
            'Keep this file next to the export: it tells the importer which textures were changed.'
        ],
        shapes: manifestShapes,
        materials,
        textures,
        bones: skeletons[0]?.bones.map((b) => b.name),
        blendShapes: blendShapes.map((b) => ({ id: b.id, file: b.file }))
    };
    doc.asset.extras = { crusaderpope: { mesh: plan.mesh, model: plan.model, asset: plan.asset, pdxmesh: plan.pdxmesh, manifest: input.name + '.crusaderpope.json' } };
    const { json, bin } = g.finish(input.name + '.bin');
    files.unshift({ name: input.name + '.gltf', data: json }, { name: input.name + '.bin', data: bin });
    files.push({ name: input.name + '.crusaderpope.json', data: JSON.stringify(manifest, null, 2) });
    return { files, manifest, warnings, counts };
}

/** A node's transform: TRS when the matrix decomposes exactly, else the matrix. */
function setTransform(node: GltfNode, m: M4): void
{
    const { t, q, s } = decompose(m);
    const back = compose(t, q, s);
    let err = 0;

    for (let i = 0; i < 16; i++)
        err = Math.max(err, Math.abs(back[i] - m[i]));

    const scale = Math.max(1, ...Array.from(m).map(Math.abs));

    if (err > 1e-5 * scale)
    {
        node.matrix = Array.from(m);
        return;
    }

    const ql = Math.hypot(...q) || 1;

    if (t.some((x) => Math.abs(x) > 0))
        node.translation = t.map(finite);

    if (Math.abs(q[3] / ql) < 1 - 1e-12)
        node.rotation = q.map((x) => finite(x / ql));

    if (s.some((x) => Math.abs(x - 1) > 1e-7))
        node.scale = s.map(finite);
}
