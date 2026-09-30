/**
 * glTF (as Blender exports it) → PDX `.mesh` + changed textures for the active mod (docs/blender.md).
 *
 * Geometry: every mesh node becomes a shape — matched to the original by node (or mesh) name, Blender's `.001`
 * suffixes tolerated; others are new shapes. Primitives become sub-meshes by material: materials match the export's
 * by name (the manifest's, or the names the export would give); other materials take the first shape's. Node
 * transforms (an object moved or scaled in Blender) are applied to the vertices; skinned meshes are evaluated in
 * the glTF's rest pose. Back to the game's space: z mirrored, winding flipped. The original skeleton is kept (joint
 * names, order, inverse binds: the game's animations need its rest orientations) and vertex joints are remapped by
 * name; ≤ 4 influences, weights normalized. Tangents are recomputed when the file has none; aabb and bounding sphere
 * are recomputed. Locators and the object's LOD settings are kept from the original.
 *
 * Textures: a texture is written only when its data channels differ from what the export wrote (manifest hashes, or
 * the game's current texture converted the same way), in the original's DDS format where it can be encoded.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parsePdx, writePdx, find, type PdxNode, type PdxValue } from '../portraits/pdx.ts';
import { invert, mul, type M4 } from '../portraits/mesh.ts';
import { decodePng, isPng } from '../images/png.ts';
import { encodeDds, ddsTargetFor, type RgbaImage } from '../images/ddsEncode.ts';
import { imageBytes, readAccessor, readGltf, textureImage, worldMatrices, type GltfFile, type GltfNode } from './gltf.ts';
import { bonesOf, strProps, subMeshMaterials, txMatrix, type PdxBone, type SubMeshMaterial } from './exportMesh.ts';
import { channelHashes, decodeTexture, normalFromGltf, normalToGltf, opaque, propertiesFromOrm, propertiesToOrm, withAlpha } from './textures.ts';
import type { BlenderManifest, ImportOutcome, ImportWrite, ManifestTexture, ModelExportPlan } from './types.ts';

export interface ImportInput
{
    plan: ModelExportPlan;
    /** the mesh as the game loads it now */
    meshBytes: Uint8Array;
    gltfPath: string;
    /** a game texture's bytes as the game loads it now */
    read: (path: string) => Uint8Array | undefined;
}

const lc = (s: string): string => s.toLowerCase();
/** Blender's duplicate-name suffix */
const unsuffixed = (s: string): string => s.replace(/\.\d{3}$/, '');

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function readManifest(file: string): BlenderManifest | undefined
{
    try
    {
        const m = JSON.parse(readFileSync(file, 'utf8')) as BlenderManifest;
        return m?.crusaderpope === 'blender-export' && typeof m.mesh === 'string' ? m : undefined;
    }
    catch
    {
        return undefined;
    }
}

/**
 * The export's manifest for this import: `<file>.crusaderpope.json`, else one in the same folder made for this mesh.
 * Refuses a file that belongs to another model (its own manifest or the glTF's extras name another mesh).
 */
function findManifest(gltfPath: string, f: GltfFile, plan: ModelExportPlan, meshNames: string[]): { manifest?: BlenderManifest; dir?: string; }
{
    const dir = dirname(gltfPath);
    const own = join(dir, basename(gltfPath).replace(/\.(gltf|glb)$/i, '') + '.crusaderpope.json');
    const others: { file: string; m: BlenderManifest; }[] = [];
    let names: string[] = [];

    try
    {
        names = readdirSync(dir).filter((n) => /\.crusaderpope\.json$/i.test(n));
    }
    catch
    {
        /* no folder listing */
    }

    for (const n of names)
    {
        const m = readManifest(join(dir, n));

        if (m)
            others.push({ file: join(dir, n), m });
    }

    const other = (mesh: string): string => `This file was exported from ${mesh}, not from ${plan.mesh}. Open ${mesh} to import it there.`;
    // decisive: the glTF's own record (when Blender kept it) and the manifest named like the file
    const extras = (f.doc.asset.extras?.crusaderpope ?? f.doc.scenes?.[f.doc.scene ?? 0]?.extras?.crusaderpope) as { mesh?: string; } | undefined;

    if (extras?.mesh && lc(extras.mesh) !== lc(plan.mesh))
        throw new Error(other(extras.mesh));

    const ownM = existsSync(own) ? readManifest(own) : undefined;

    if (ownM && lc(ownM.mesh) !== lc(plan.mesh))
        throw new Error(other(ownM.mesh));

    if (ownM)
        return { manifest: ownM, dir };

    // else the export in the folder whose shapes the file's objects fit best (several exports may share a folder)
    const nodeNames = new Set((f.doc.nodes ?? []).filter((n) => n.mesh !== undefined).map((n) => unsuffixed(n.name ?? '')));
    const fits = (shapes: string[]): number => shapes.filter((s) => nodeNames.has(s)).length;
    const ranked = others.map((o) => ({ o, n: fits(o.m.shapes.map((s) => s.name)) })).sort((a, b) => b.n - a.n);
    const best = ranked[0];

    if (best && best.n > 0)
    {
        if (lc(best.o.m.mesh) === lc(plan.mesh))
            return { manifest: best.o.m, dir };

        // (another export fits better than this model's own shapes)
        if (fits(meshNames) < best.n)
            throw new Error(other(best.o.m.mesh));
    }

    const mine = others.find((o) => lc(o.m.mesh) === lc(plan.mesh))?.m;
    return mine ? { manifest: mine, dir } : {};
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** One sub-mesh being collected (game space). */
export interface SubMesh
{
    material: SubMeshMaterial;
    p: number[];
    n: number[];
    t: number[];
    hasT: boolean;
    uv: number[][];
    tri: number[];
    /** per vertex: bone index → weight */
    skin: Map<number, number>[] | null;
    /** blend shape id (lower case) → the target's positions from the file's morph targets (game space) */
    morph: Map<string, number[]>;
}

interface BoneMap
{
    bones: PdxBone[];
    root: number;
    /** bone index of a joint name */
    find(name: string): number | undefined;
}

interface ShapeOut
{
    name: string;
    /** index of the original shape, -1 = new */
    original: number;
    subs: SubMesh[];
}

/** A shape as written, with each sub-mesh's PDX node and the original sub-mesh it replaces (blend shape targets). */
interface BuiltShape
{
    name: string;
    original: number;
    props: Record<string, PdxValue>;
    subs: { sub: SubMesh; mesh: PdxNode; origMesh: number; origNode?: PdxNode; }[];
}

const det3 = (m: ArrayLike<number>): number => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

function transformPoint(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number]
{
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

function transformDir(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number]
{
    return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}

function normalize(v: [number, number, number], fallback: [number, number, number]): [number, number, number]
{
    const l = Math.hypot(v[0], v[1], v[2]);
    return l > 1e-12 && Number.isFinite(l) ? [v[0] / l, v[1] / l, v[2] / l] : fallback;
}

/** inverse transpose of the upper 3×3 (normals) as a 4×4 without translation */
function normalMatrix(m: M4): M4
{
    const lin = new Float64Array(16);
    lin.set([m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1]);
    const inv = invert(lin);
    const o = new Float64Array(16);

    for (let r = 0; r < 4; r++)
        for (let c = 0; c < 4; c++)
            o[c * 4 + r] = inv[r * 4 + c];

    return o;
}

const isIdentity = (m: ArrayLike<number>, eps: number): boolean =>
{
    for (let i = 0; i < 16; i++)
        if (Math.abs(m[i] - (i % 5 === 0 ? 1 : 0)) > eps)
            return false;

    return true;
};

/**
 * Per-vertex tangents in game space (u0): T along +u, w = sign of cross(N, T) · dP/dv — the relation the game's
 * files show (docs/blender.md).
 */
function computeTangents(s: SubMesh): void
{
    const nv = s.p.length / 3;
    const uv = s.uv[0];
    const tan = new Float64Array(nv * 3);
    const bit = new Float64Array(nv * 3);

    if (uv)
    {
        for (let i = 0; i + 2 < s.tri.length; i += 3)
        {
            const [a, b, c] = [s.tri[i], s.tri[i + 1], s.tri[i + 2]];
            const e1 = [s.p[b * 3] - s.p[a * 3], s.p[b * 3 + 1] - s.p[a * 3 + 1], s.p[b * 3 + 2] - s.p[a * 3 + 2]];
            const e2 = [s.p[c * 3] - s.p[a * 3], s.p[c * 3 + 1] - s.p[a * 3 + 1], s.p[c * 3 + 2] - s.p[a * 3 + 2]];
            const du1 = uv[b * 2] - uv[a * 2];
            const dv1 = uv[b * 2 + 1] - uv[a * 2 + 1];
            const du2 = uv[c * 2] - uv[a * 2];
            const dv2 = uv[c * 2 + 1] - uv[a * 2 + 1];
            const r = du1 * dv2 - du2 * dv1;

            if (!r || !Number.isFinite(r))
                continue;

            const f = 1 / r;

            for (let k = 0; k < 3; k++)
            {
                const t = (e1[k] * dv2 - e2[k] * dv1) * f;
                const bb = (e2[k] * du1 - e1[k] * du2) * f;

                for (const v of [a, b, c])
                {
                    tan[v * 3 + k] += t;
                    bit[v * 3 + k] += bb;
                }
            }
        }
    }

    s.t = [];

    for (let v = 0; v < nv; v++)
    {
        const n: [number, number, number] = [s.n[v * 3], s.n[v * 3 + 1], s.n[v * 3 + 2]];
        let t: [number, number, number] = [tan[v * 3], tan[v * 3 + 1], tan[v * 3 + 2]];
        // Gram-Schmidt against the normal
        const d = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
        t = [t[0] - n[0] * d, t[1] - n[1] * d, t[2] - n[2] * d];
        const any: [number, number, number] = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const fallback = normalize([any[0] - n[0] * (any[0] * n[0] + any[1] * n[1] + any[2] * n[2]), any[1] - n[1] * (any[0] * n[0] + any[1] * n[1] + any[2] * n[2]), any[2] - n[2] * (any[0] * n[0] + any[1] * n[1] + any[2] * n[2])], [1, 0, 0]);
        t = normalize(t, fallback);
        const cx = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
        const w = cx[0] * bit[v * 3] + cx[1] * bit[v * 3 + 1] + cx[2] * bit[v * 3 + 2] < 0 ? -1 : 1;
        s.t.push(t[0], t[1], t[2], w);
    }

    s.hasT = true;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export async function importMesh(input: ImportInput): Promise<ImportOutcome>
{
    const { plan } = input;
    const notes: string[] = [];
    const warnings: string[] = [];
    const f = readGltf(input.gltfPath);
    const doc = f.doc;
    const root = parsePdx(input.meshBytes);
    const object = find(root, 'object');

    if (!object)
        throw new Error(`${plan.mesh} has no objects.`);

    const origShapes = object.children;
    const { manifest, dir: manifestDir } = findManifest(input.gltfPath, f, plan, origShapes.map((s) => s.name));

    if (!manifest)
        warnings.push('No manifest of the export found next to the file: shapes and materials are matched by name, textures compared with the game’s current files.');

    // ---- materials ----
    const subs = subMeshMaterials(object, plan);
    const known = new Map<string, SubMeshMaterial>();

    for (const s of subs.flat())
        if (!known.has(lc(s.name)))
            known.set(lc(s.name), s);

    for (const m of manifest?.materials ?? [])
        if (!known.has(lc(m.name)))
            known.set(lc(m.name), { key: 'manifest:' + m.name, name: m.name, shader: m.shader, pdx: m.pdx, textures: m.textures });

    const firstMaterial: SubMeshMaterial = subs.flat()[0] ?? { key: 'default', name: 'default', shader: 'PdxMeshStandard', pdx: { shader: 'PdxMeshStandard' }, textures: [] };
    const fallbackUsed = new Set<string>();
    const materialOf = (i: number | undefined): { m: SubMeshMaterial; matched: boolean; } =>
    {
        const g = i !== undefined ? doc.materials?.[i] : undefined;
        const extra = (g?.extras?.crusaderpope as { name?: string; } | undefined)?.name;

        for (const n of [g?.name, g?.name && unsuffixed(g.name), extra])
        {
            const m = n ? known.get(lc(n)) : undefined;

            if (m)
                return { m, matched: true };
        }

        fallbackUsed.add(g?.name ?? '(no material)');
        return { m: firstMaterial, matched: false };
    };

    // ---- scene ----
    const nodes = doc.nodes ?? [];
    const toM4 = (a: ArrayLike<number>): M4 => Float64Array.from(a);
    const { world, parent } = worldMatrices(doc, (a, b) => Array.from(mul(toM4(a), toM4(b))));
    const jointSet = new Set((doc.skins ?? []).flatMap((s) => s.joints));
    // nodes in scene order (depth first from the scene roots), then any others
    const order: number[] = [];
    const seen = new Set<number>();
    const visit = (i: number): void =>
    {
        if (seen.has(i) || !nodes[i])
            return;

        seen.add(i);
        order.push(i);

        for (const c of nodes[i].children ?? [])
            visit(c);
    };

    for (const r of doc.scenes?.[doc.scene ?? 0]?.nodes ?? [])
        visit(r);

    const meshNodes = order.filter((i) => nodes[i].mesh !== undefined && !jointSet.has(i));

    if (!meshNodes.length)
        throw new Error('The file has no meshes.');

    // ---- skeletons of the original (kept as they are) ----
    const skeletonOf = new Map<number, PdxNode>();
    origShapes.forEach((s, i) =>
    {
        const sk = find(s, 'skeleton');

        if (sk?.children.length)
            skeletonOf.set(i, sk);
    });
    const firstSkeleton = [...skeletonOf.values()][0];
    const boneMaps = new Map<PdxNode, BoneMap>();
    const boneMap = (sk: PdxNode): BoneMap =>
    {
        let m = boneMaps.get(sk);

        if (!m)
        {
            const bones = bonesOf(sk);
            const byName = new Map<string, number[]>();
            const add = (k: string, ix: number): void => void (byName.get(k) ?? byName.set(k, []).get(k)!).push(ix);

            for (const b of [...bones].sort((x, y) => x.ix - y.ix))
            {
                add(lc(b.name), b.ix);

                // (Blender and other tools may drop the rig prefix `rig:`)
                if (b.name.includes(':'))
                    add(lc(b.name.slice(b.name.lastIndexOf(':') + 1)), b.ix);
            }

            m = {
                bones,
                root: bones.find((b) => b.pa < 0 || b.pa === b.ix)?.ix ?? 0,
                // a repeated bone name: the export (like Blender) calls the second one `name.001`
                find: (name: string) =>
                {
                    const exact = byName.get(lc(name));

                    if (exact)
                        return exact[0];

                    const m = /^(.*)\.(\d{3})$/.exec(name);
                    const list = m ? byName.get(lc(m[1])) : undefined;
                    return list?.[Math.min(list.length - 1, parseInt(m![2], 10))];
                }
            };
            boneMaps.set(sk, m);
        }

        return m;
    };

    // ---- shapes ----
    const taken = new Set<number>();
    const usedNames = new Set(origShapes.map((s) => s.name));
    const hasMeshes = (s: PdxNode): boolean => s.children.some((c) => c.name === 'mesh');
    const resolveShape = (node: GltfNode): { name: string; original: number; } =>
    {
        const meshName = doc.meshes?.[node.mesh!]?.name;

        for (const cand of [node.name, meshName, node.name && unsuffixed(node.name), meshName && unsuffixed(meshName)])
        {
            if (!cand)
                continue;

            const i = origShapes.findIndex((s, k) => !taken.has(k) && s.name === cand && hasMeshes(s));

            if (i >= 0)
            {
                taken.add(i);
                return { name: origShapes[i].name, original: i };
            }
        }

        // (PDX names are Latin-1 and shorter than 64 characters)
        const stem = (node.name || meshName || 'shape').replace(/[^\x20-\x7e]/g, '_').slice(0, 63);
        let name = stem;

        for (let k = 2; usedNames.has(name); k++)
            name = `${stem.slice(0, 58)}_${k}`;

        usedNames.add(name);
        return { name, original: -1 };
    };

    const shapesOut: ShapeOut[] = [];
    const blendIds = new Set((plan.blendShapes ?? []).map((b) => lc(b.id)));
    const unknownJoints = new Set<string>();
    const unweighted = new Set<string>();
    const IDENTITY = toM4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

    for (const ni of meshNodes)
    {
        const node = nodes[ni];
        const gmesh = doc.meshes?.[node.mesh!];

        if (!gmesh)
            continue;

        const { name, original } = resolveShape(node);
        const shape: ShapeOut = { name, original, subs: [] };
        const origSkinned = original >= 0 && origShapes[original].children.some((m) => m.name === 'mesh' && find(m, 'skin'));
        const nodeWorld = toM4(world[ni] ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        // skin: the joint matrices of the rest pose as the file has it (Blender: identity products → vertices as they are)
        const skin = node.skin !== undefined ? doc.skins?.[node.skin] : undefined;
        let jointMats: M4[] | undefined;
        let jointBone: number[] | undefined;
        const skeleton = (original >= 0 ? skeletonOf.get(original) : undefined) ?? firstSkeleton;

        if (skin)
        {
            const ibm = skin.inverseBindMatrices !== undefined ? readAccessor(f, skin.inverseBindMatrices).values : undefined;
            jointMats = skin.joints.map((j, k) =>
            {
                const jw = toM4(world[j] ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
                const ib = ibm ? toM4(ibm.subarray(k * 16, k * 16 + 16)) : toM4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
                return mul(jw, ib);
            });

            if (skeleton)
            {
                const bm = boneMap(skeleton);
                // joint → bone index by name; unknown joints go to their nearest known ancestor
                jointBone = skin.joints.map((j) =>
                {
                    for (let n = j, depth = 0; n >= 0 && depth < 256; n = parent[n], depth++)
                    {
                        const nm = nodes[n]?.name ?? '';

                        for (const cand of [nm, nm.slice(nm.lastIndexOf(':') + 1)])
                        {
                            const b = bm.find(cand);

                            if (b !== undefined)
                            {
                                if (n !== j)
                                    unknownJoints.add(nodes[j]?.name ?? String(j));

                                return b;
                            }
                        }
                    }

                    unknownJoints.add(nodes[j]?.name ?? String(j));
                    return bm.root;
                });
            }
        }

        const allRest = !jointMats || jointMats.every((m) => isIdentity(m, 1e-4));

        for (const prim of gmesh.primitives)
        {
            if (prim.mode !== undefined && prim.mode !== 4)
            {
                warnings.push(`${name}: a primitive of mode ${prim.mode} (not triangles) is left out.`);
                continue;
            }

            if (prim.attributes.POSITION === undefined)
                continue;

            const P = readAccessor(f, prim.attributes.POSITION);
            const N = prim.attributes.NORMAL !== undefined ? readAccessor(f, prim.attributes.NORMAL) : undefined;
            const T = prim.attributes.TANGENT !== undefined ? readAccessor(f, prim.attributes.TANGENT) : undefined;
            const UV: Float64Array[] = [];

            for (let k = 0; prim.attributes[`TEXCOORD_${k}`] !== undefined; k++)
                UV.push(readAccessor(f, prim.attributes[`TEXCOORD_${k}`]).values);

            const joints: Float64Array[] = [];
            const weights: Float64Array[] = [];

            for (let k = 0; prim.attributes[`JOINTS_${k}`] !== undefined && prim.attributes[`WEIGHTS_${k}`] !== undefined; k++)
            {
                joints.push(readAccessor(f, prim.attributes[`JOINTS_${k}`]).values);
                weights.push(readAccessor(f, prim.attributes[`WEIGHTS_${k}`]).values);
            }

            const count = P.count;
            const idx = prim.indices !== undefined ? readAccessor(f, prim.indices).values : Float64Array.from({ length: count }, (_, i) => i);
            // morph targets named like the model's blend shapes (Blender's shape keys, names in extras.targetNames)
            const targetNames = (gmesh.extras?.targetNames as string[] | undefined) ?? [];
            const morphs: { id: string; dp: Float64Array; }[] = [];
            prim.targets?.forEach((t, k) =>
            {
                const id = lc(targetNames[k] ?? '');

                if (blendIds.has(id) && t.POSITION !== undefined)
                    morphs.push({ id, dp: readAccessor(f, t.POSITION).values });
            });
            const { m: material } = materialOf(prim.material);
            const weighted = !!skeleton && joints.length > 0;

            if (skeleton && origSkinned && !weighted)
                unweighted.add(name);

            let sub = shape.subs.find((s) => s.material === material);

            if (!sub)
            {
                sub = { material, p: [], n: [], t: [], hasT: !!T, uv: [], tri: [], skin: weighted || (skeleton && origSkinned) ? [] : null, morph: new Map() };
                shape.subs.push(sub);
            }
            else if (!T)
                sub.hasT = false;

            // (a blend shape an earlier primitive of the sub-mesh lacked: flat there)
            for (const m of morphs)
                if (!sub.morph.has(m.id))
                    sub.morph.set(m.id, sub.p.slice());

            if (!sub.skin && weighted)
            {
                // (an earlier primitive of this material had no weights: its vertices follow the root bone)
                sub.skin = Array.from({ length: sub.p.length / 3 }, () => new Map<number, number>());
            }

            const offset = sub.p.length / 3;
            // per-vertex transform: skinned — the joints' rest-pose matrices blended by weight (Blender: identity, the
            // vertices are as they are); else the node's world matrix (an object moved or scaled in Blender)
            const skinnedPrim = !!jointMats && joints.length > 0;
            const cm: M4 | undefined = !skinnedPrim ? nodeWorld : allRest ? IDENTITY : undefined;
            const vertexMatrix = (v: number): M4 =>
            {
                const m = new Float64Array(16);

                for (let s = 0; s < joints.length; s++)
                {
                    for (let k = 0; k < 4; k++)
                    {
                        const w = weights[s][v * 4 + k];
                        const jm = w ? jointMats![joints[s][v * 4 + k]] : undefined;

                        if (jm)
                        {
                            for (let e = 0; e < 16; e++)
                                m[e] += jm[e] * w;
                        }
                    }
                }

                return m;
            };
            const cn = cm ? normalMatrix(cm) : undefined;
            const cdet = cm ? det3(cm) : 1;
            let flipped = 0;

            for (let v = 0; v < count; v++)
            {
                const m = cm ?? vertexMatrix(v);
                const nm = cn ?? normalMatrix(m);
                const d = cm ? cdet : det3(m);

                if (d < 0)
                    flipped++;

                const p = transformPoint(m, P.values[v * 3], P.values[v * 3 + 1], P.values[v * 3 + 2]);
                sub.p.push(p[0], p[1], -p[2]);
                const n = N ? normalize(transformDir(nm, N.values[v * 3], N.values[v * 3 + 1], N.values[v * 3 + 2]), [0, 1, 0]) : ([0, 1, 0] as [number, number, number]);
                sub.n.push(n[0], n[1], -n[2]);

                for (const mo of morphs)
                {
                    const q = transformPoint(m, P.values[v * 3] + mo.dp[v * 3], P.values[v * 3 + 1] + mo.dp[v * 3 + 1], P.values[v * 3 + 2] + mo.dp[v * 3 + 2]);
                    sub.morph.get(mo.id)!.push(q[0], q[1], -q[2]);
                }

                if (T)
                {
                    const t = normalize(transformDir(m, T.values[v * 4], T.values[v * 4 + 1], T.values[v * 4 + 2]), [1, 0, 0]);
                    // the z mirror keeps w (docs/blender.md); a mirroring node transform flips it
                    const w = (T.values[v * 4 + 3] < 0 ? -1 : 1) * (d < 0 ? -1 : 1);
                    sub.t.push(t[0], t[1], -t[2], w);
                }

                for (let k = 0; k < UV.length; k++)
                {
                    (sub.uv[k] ??= new Array(offset * 2).fill(0)).push(UV[k][v * 2], UV[k][v * 2 + 1]);
                }

                if (sub.skin)
                {
                    const inf = new Map<number, number>();

                    if (jointBone)
                    {
                        for (let s = 0; s < joints.length; s++)
                        {
                            for (let k = 0; k < 4; k++)
                            {
                                const w = weights[s][v * 4 + k];

                                if (!(w > 0))
                                    continue;

                                const b = jointBone[joints[s][v * 4 + k]];

                                if (b === undefined)
                                    continue;

                                inf.set(b, (inf.get(b) ?? 0) + w);
                            }
                        }
                    }

                    sub.skin.push(inf);
                }
            }

            // UV sets this primitive lacks (another primitive of the sub-mesh has them)
            for (let k = UV.length; k < sub.uv.length; k++)
                for (let v = 0; v < count; v++)
                    sub.uv[k].push(0, 0);

            // blend shapes this primitive lacks: flat (the base's positions)
            for (const [id, out] of sub.morph)
            {
                if (morphs.some((m) => m.id === id))
                    continue;

                for (let i = offset * 3; i < sub.p.length; i++)
                    out.push(sub.p[i]);
            }

            if (!N)
                warnings.push(`${name}: no normals in the file — flat up-normals written; export with Normals on.`);

            // a mirroring transform turns the faces inside out: flip them back (on top of the z mirror's flip)
            const flipAgain = flipped > count / 2;

            for (let i = 0; i + 2 < idx.length; i += 3)
            {
                const a = idx[i] + offset;
                const b = idx[i + 1] + offset;
                const c = idx[i + 2] + offset;

                if (flipAgain)
                    sub.tri.push(a, b, c);
                else
                    sub.tri.push(a, c, b);
            }
        }

        if (shape.subs.length)
            shapesOut.push(shape);
    }

    if (fallbackUsed.size)
        warnings.push(`Materials that are not the model’s (${[...fallbackUsed].slice(0, 5).join(', ')}) took ${firstMaterial.name} — assign one of the exported materials in Blender to choose.`);

    if (unknownJoints.size)
        warnings.push(`Joints not in the game skeleton (${[...unknownJoints].slice(0, 5).join(', ')}): their weights moved to the nearest bone that is.`);

    if (unweighted.size)
        warnings.push(`${[...unweighted].join(', ')}: skinned in the game, but without weights in the file — bound to the root bone.`);

    // ---- PDX tree ----
    const removed = origShapes.filter((s, i) => s.children.some((c) => c.name === 'mesh') && !taken.has(i)).map((s) => s.name);
    const outShapes: PdxNode[] = [];
    const built: BuiltShape[] = [];
    const shapeInfo: ImportOutcome['shapes'] = [];
    const origSub = (shapeIndex: number, m: SubMeshMaterial): PdxNode | undefined =>
    {
        // the original sub-mesh of this material: in the same shape, else anywhere
        const inShape = (si: number): PdxNode | undefined =>
        {
            const meshes = origShapes[si]?.children.filter((c) => c.name === 'mesh') ?? [];
            const k = subs[si]?.findIndex((x) => x === m) ?? -1;
            return k >= 0 ? meshes[k] : undefined;
        };

        if (shapeIndex >= 0)
        {
            const hit = inShape(shapeIndex);

            if (hit)
                return hit;
        }

        for (let si = 0; si < origShapes.length; si++)
        {
            const hit = inShape(si);

            if (hit)
                return hit;
        }

        return undefined;
    };
    const buildShape = (s: ShapeOut): PdxNode =>
    {
        const orig = s.original >= 0 ? origShapes[s.original] : undefined;
        // sub-meshes in the original's order of materials, new ones after
        const rank = (m: SubMeshMaterial): number =>
        {
            const k = s.original >= 0 ? (subs[s.original]?.indexOf(m) ?? -1) : -1;
            return k >= 0 ? k : 1000;
        };
        s.subs.sort((a, b) => rank(a.material) - rank(b.material));
        const skeleton = (s.original >= 0 ? skeletonOf.get(s.original) : undefined) ?? firstSkeleton;
        const children: PdxNode[] = [];
        let vertices = 0;
        let triangles = 0;
        const entry: BuiltShape = { name: s.name, original: s.original, props: orig ? { ...orig.props } : {}, subs: [] };

        for (const sub of s.subs)
        {
            const o = origSub(s.original, sub.material);
            const mesh = buildMesh(sub, o, skeleton ? boneMap(skeleton) : undefined, warnings, s.name);
            children.push(mesh);
            vertices += sub.p.length / 3;
            triangles += sub.tri.length / 3;
            // (for blend shapes: the original sub-mesh of this shape it replaces)
            const origMeshes = orig?.children.filter((c) => c.name === 'mesh') ?? [];
            entry.subs.push({ sub, mesh, origMesh: o ? origMeshes.indexOf(o) : -1, origNode: o && origMeshes.includes(o) ? o : undefined });
        }

        built.push(entry);
        const skinned = s.subs.some((x) => x.skin);
        const ownSkeleton = s.original >= 0 ? skeletonOf.get(s.original) : undefined;

        if (ownSkeleton)
            children.push(ownSkeleton);
        else if (skinned && firstSkeleton)
            children.push(firstSkeleton);

        shapeInfo.push({ name: s.name, vertices, triangles, status: s.original >= 0 ? 'matched' : 'new' });
        return { name: s.name, props: orig ? { ...orig.props } : {}, children };
    };
    const byOriginal = new Map(shapesOut.filter((s) => s.original >= 0).map((s) => [s.original, s]));
    let orphanSkeleton: PdxNode | undefined;
    origShapes.forEach((orig, i) =>
    {
        const out = byOriginal.get(i);

        if (out)
            outShapes.push(buildShape(out));
        else if (!orig.children.some((c) => c.name === 'mesh'))
            outShapes.push(orig); // a skeleton-only shape stays as it is
        else if (skeletonOf.has(i) && skeletonOf.get(i) === firstSkeleton)
            orphanSkeleton = skeletonOf.get(i);
    });

    for (const s of shapesOut.filter((x) => x.original < 0))
        outShapes.push(buildShape(s));

    // the removed shape held the file's skeleton: the first shape without one takes it
    if (orphanSkeleton && !outShapes.some((s) => s.children.includes(orphanSkeleton!)))
    {
        const host = outShapes.find((s) => !s.children.some((c) => c.name === 'skeleton'));

        if (host)
            host.children.push(orphanSkeleton);
    }

    const newObject: PdxNode = { name: 'object', props: { ...object.props }, children: outShapes };
    const newRoot: PdxNode = { name: root.name, props: { ...root.props }, children: root.children.map((c) => (c === object ? newObject : c)) };

    if (!newRoot.children.includes(newObject))
        newRoot.children.unshift(newObject);

    const writes: ImportWrite[] = [{ rel: plan.mesh, data: writePdx(newRoot), what: `mesh: ${shapeInfo.length} shape${shapeInfo.length === 1 ? '' : 's'}, ${shapeInfo.reduce((n, s) => n + s.triangles, 0).toLocaleString('en')} triangles` }];
    const newShapes = shapeInfo.filter((s) => s.status === 'new').map((s) => s.name);

    if (newShapes.length)
        notes.push(
            `New shape${newShapes.length === 1 ? '' : 's'} ${newShapes.join(', ')}${plan.asset ? ` — ${plan.asset} has no meshsettings for ${newShapes.length === 1 ? 'it' : 'them'} yet (the game gives shapes their textures and shader by name there)` : ''}.`
        );

    if (removed.length)
        notes.push(`Not in the file, so removed: ${removed.join(', ')}.`);

    if (removed.length && !shapeInfo.some((s) => s.status === 'matched'))
        warnings.push(`None of the file's objects is named like a shape of ${plan.mesh}: all of them are new shapes and the model's own are gone — is this the right file?`);

    // ---- blend shapes: new targets in the new vertex order ----
    const lost: string[] = [];
    const unfit: string[] = [];

    for (const b of plan.blendShapes ?? [])
    {
        const bytes = input.read(b.file);
        let troot: PdxNode | undefined;

        try
        {
            troot = bytes ? parsePdx(bytes) : undefined;
        }
        catch
        {
            troot = undefined;
        }

        const tobj = troot && find(troot, 'object');
        // a target without the base's vertices in the game already (some vanilla head targets have another topology)
        // is left as it is: there is nothing to carry over
        const fits = !!tobj && origShapes.every((s, si) =>
        {
            const tm = tobj.children[si]?.children.filter((c) => c.name === 'mesh') ?? [];
            return s.children.filter((c) => c.name === 'mesh').every((m, mi) => (tm[mi]?.props.p as Float32Array | undefined)?.length === (m.props.p as Float32Array).length);
        });

        if (!fits)
        {
            unfit.push(b.id);
            continue;
        }

        const id = lc(b.id);
        let fromFile = 0;
        let retargeted = 0;
        const shapes: PdxNode[] = built.map((bs) =>
        {
            const tShape = bs.original >= 0 ? tobj?.children[bs.original] : undefined;
            const tMeshes = tShape?.children.filter((c) => c.name === 'mesh') ?? [];
            const meshes = bs.subs.map((e) =>
            {
                const tMesh = e.origMesh >= 0 ? tMeshes[e.origMesh] : undefined;
                const m = e.sub.morph.get(id);
                let pn: { p: number[]; n: number[]; } = { p: e.sub.p, n: e.sub.n };

                if (m)
                {
                    // positions from the shape key; normals: the original target's where the vertex is the original's
                    // (same place in base and target), else turned with the surface (Blender recomputes shape key normals from
                    // the faces, which flips the custom normals of double-layered cloth)
                    pn = { p: m, n: targetNormals(e.sub, m, e.origNode, tMesh) };
                    fromFile++;
                }
                else if (tMesh && e.origNode)
                {
                    pn = retarget(e.sub, e.origNode, tMesh);
                    retargeted++;
                }

                return targetMesh(e.mesh, pn, tMesh);
            });
            return { name: tShape?.name ?? bs.name, props: tShape ? { ...tShape.props } : { ...bs.props }, children: meshes };
        });
        const target: PdxNode = {
            name: troot?.name ?? 'file',
            props: troot ? { ...troot.props } : { ...root.props },
            children: [{ name: 'object', props: tobj ? { ...tobj.props } : {}, children: shapes }, ...(troot?.children.filter((c) => c !== tobj) ?? [])]
        };

        if (!fromFile)
            lost.push(b.id);

        writes.push({ rel: b.file, data: writePdx(target), what: `blend shape ${b.id}${fromFile ? ' (from its shape key)' : retargeted ? ' (re-targeted by nearest vertex)' : ' (flat)'}` });
    }

    if (lost.length)
        warnings.push(
            `${lost.length === plan.blendShapes!.length - unfit.length ? 'No blend shape' : `Blend shape${lost.length === 1 ? '' : 's'} ${lost.join(', ')}`} came as a shape key (export from Blender with Shape Keys on): re-targeted to the new vertex order by nearest vertex.`
        );

    if (unfit.length)
        notes.push(
            `${unfit.length} blend shape target${unfit.length === 1 ? '' : 's'} left as ${unfit.length === 1 ? 'it is' : 'they are'}: ${unfit.length === 1 ? 'it has' : 'they have'} other vertices than the mesh in the game already (${unfit.slice(0, 4).join(', ')}${unfit.length > 4 ? ' …' : ''}).`
        );

    // ---- textures ----
    await importTextures(input, f, manifest, manifestDir, known, doc.materials ?? [], writes, notes, warnings);
    return { writes, notes, warnings, shapes: shapeInfo, removed };
}

/** A PDX `mesh` node from a collected sub-mesh; attribute set, UV count and `sfs` follow the original sub-mesh. */
function buildMesh(sub: SubMesh, orig: PdxNode | undefined, bones: BoneMap | undefined, warnings: string[], shape: string): PdxNode
{
    const nv = sub.p.length / 3;
    const props: Record<string, PdxValue> = {};
    const f32 = (a: number[]): Float32Array => Float32Array.from(a, (x) => (Number.isFinite(x) ? x : 0));
    props.p = f32(sub.p);
    const hasN = !orig || orig.props.n !== undefined;
    const hasTa = !orig || orig.props.ta !== undefined;
    const origUv = orig ? ['u0', 'u1', 'u2', 'u3'].filter((k) => orig.props[k] !== undefined).length : Math.max(1, sub.uv.length);

    if (hasN)
        props.n = f32(sub.n);

    if (hasTa && origUv > 0)
    {
        if (!sub.hasT || sub.t.length !== nv * 4)
            computeTangents(sub);

        props.ta = f32(sub.t);
    }

    for (let k = 0; k < origUv; k++)
    {
        const uv = sub.uv[k] ?? sub.uv[0];

        if (!sub.uv[k])
            warnings.push(`${shape}: UV set ${k + 1} missing — a copy of the first written (the game's material reads ${origUv}).`);

        props['u' + k] = uv ? f32(uv) : new Float32Array(nv * 2);
    }

    if (sub.uv.length > origUv)
        warnings.push(`${shape}: ${sub.uv.length - origUv} extra UV set${sub.uv.length - origUv === 1 ? '' : 's'} left out (the original has ${origUv}).`);

    props.tri = Int32Array.from(sub.tri);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];

    for (let i = 0; i < props.p.length; i++)
    {
        const v = (props.p as Float32Array)[i];

        if (v < min[i % 3])
            min[i % 3] = v;

        if (v > max[i % 3])
            max[i % 3] = v;
    }

    if (!nv)
    {
        min.fill(0);
        max.fill(0);
    }

    const sfs = orig?.props.sfs;

    if (sfs)
        props.sfs = sfs;

    if (!orig || orig.props.boundingsphere)
    {
        const c = [0, 1, 2].map((k) => Math.fround((min[k] + max[k]) / 2));
        let r = 0;
        const p = props.p as Float32Array;

        for (let i = 0; i < p.length; i += 3)
            r = Math.max(r, Math.hypot(p[i] - c[0], p[i + 1] - c[1], p[i + 2] - c[2]));

        props.boundingsphere = Float32Array.of(c[0], c[1], c[2], r);
    }

    const children: PdxNode[] = [
        { name: 'aabb', props: { min: Float32Array.from(min), max: Float32Array.from(max) }, children: [] },
        { name: 'material', props: Object.fromEntries(Object.entries(sub.material.pdx).map(([k, v]) => [k, [v]])), children: [] }
    ];

    if (!children[1].props.shader)
        children[1].props = { shader: [sub.material.shader ?? 'PdxMeshStandard'], ...children[1].props };

    if (sub.skin && bones)
    {
        const ix = new Int32Array(nv * 4).fill(-1);
        const w = new Float32Array(nv * 4);
        let most = 1;

        for (let v = 0; v < nv; v++)
        {
            const inf = [...sub.skin[v].entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);

            if (!inf.length)
                inf.push([bones.root, 1]);

            const sum = inf.reduce((s, x) => s + x[1], 0) || 1;
            most = Math.max(most, inf.length);
            inf.forEach(([b, wt], k) =>
            {
                ix[v * 4 + k] = b;
                w[v * 4 + k] = wt / sum;
            });
        }

        const origBones = (orig && find(orig, 'skin')?.props.bones as Int32Array | undefined)?.[0];
        children.push({ name: 'skin', props: { bones: Int32Array.of(Math.min(4, Math.max(most, origBones ?? 0))), ix, w }, children: [] });
    }

    return { name: 'mesh', props, children };
}

// ---------------------------------------------------------------------------
// Blend shapes
// ---------------------------------------------------------------------------

/**
 * A blend shape target for a sub-mesh the file brought no shape key for: each vertex takes the offset (position,
 * normal) of its original vertex — the one with the same UV nearest in position, else the nearest one.
 */
/** new vertex → original vertex, per sub-mesh and original (one search serves every blend shape) */
const correspondences = new WeakMap<SubMesh, { base: PdxNode; map: Int32Array; }>();

/** For each vertex of `sub` its original vertex in `base`: same UV and nearest in position, else nearest (grid). */
function correspondence(sub: SubMesh, base: PdxNode): Int32Array
{
    const hit = correspondences.get(sub);

    if (hit?.base === base)
        return hit.map;

    const bp = base.props.p as Float32Array;
    const bu = base.props.u0 as Float32Array | undefined;
    const count = bp.length / 3;
    const uvKey = (u: number, v: number): string => `${Math.round(u * 4096)},${Math.round(v * 4096)}`;
    const byUv = new Map<string, number[]>();

    if (bu)
    {
        for (let i = 0; i < count; i++)
            (byUv.get(uvKey(bu[i * 2], bu[i * 2 + 1])) ?? byUv.set(uvKey(bu[i * 2], bu[i * 2 + 1]), []).get(uvKey(bu[i * 2], bu[i * 2 + 1]))!).push(i);
    }

    // uniform grid over the original positions (about one vertex per cell) for the nearest search
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];

    for (let i = 0; i < bp.length; i++)
    {
        lo[i % 3] = Math.min(lo[i % 3], bp[i]);
        hi[i % 3] = Math.max(hi[i % 3], bp[i]);
    }

    const cell = Math.max(1e-6, Math.cbrt(((hi[0] - lo[0] || 1) * (hi[1] - lo[1] || 1) * (hi[2] - lo[2] || 1)) / Math.max(1, count)));
    const cellOf = (x: number, k: number): number => Math.floor((x - lo[k]) / cell);
    const grid = new Map<string, number[]>();

    for (let i = 0; i < count; i++)
    {
        const k = `${cellOf(bp[i * 3], 0)},${cellOf(bp[i * 3 + 1], 1)},${cellOf(bp[i * 3 + 2], 2)}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    }

    const span = Math.max(...[0, 1, 2].map((k) => cellOf(hi[k], k))) + 1;
    const nv = sub.p.length / 3;
    const map = new Int32Array(nv);
    const d2 = (v: number, i: number): number => (sub.p[v * 3] - bp[i * 3]) ** 2 + (sub.p[v * 3 + 1] - bp[i * 3 + 1]) ** 2 + (sub.p[v * 3 + 2] - bp[i * 3 + 2]) ** 2;

    for (let v = 0; v < nv; v++)
    {
        const uv = sub.uv[0];
        const cands = uv ? byUv.get(uvKey(uv[v * 2], uv[v * 2 + 1])) : undefined;
        let best = 0;
        let bestD = Infinity;

        if (cands?.length)
        {
            for (const i of cands)
            {
                const d = d2(v, i);

                if (d < bestD)
                    (bestD = d), (best = i);
            }
        }
        else
        {
            // growing shells of cells around the vertex until one found can't be beaten by a farther shell
            const c = [0, 1, 2].map((k) => cellOf(sub.p[v * 3 + k], k));

            for (let r = 0; r <= span + Math.max(0, ...c.map((x) => -x), ...c.map((x) => x - span)); r++)
            {
                for (let dx = -r; dx <= r; dx++)
                    for (let dy = -r; dy <= r; dy++)
                        for (let dz = -r; dz <= r; dz++)
                        {
                            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r)
                                continue;

                            for (const i of grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? [])
                            {
                                const d = d2(v, i);

                                if (d < bestD)
                                    (bestD = d), (best = i);
                            }
                        }

                if (bestD <= (r * cell) ** 2)
                    break;
            }
        }

        map[v] = best;
    }

    correspondences.set(sub, { base, map });
    return map;
}

export function retarget(sub: SubMesh, base: PdxNode, target: PdxNode): { p: number[]; n: number[]; }
{
    const bp = base.props.p as Float32Array;
    const tp = target.props.p as Float32Array | undefined;
    const bn = base.props.n as Float32Array | undefined;
    const tn = target.props.n as Float32Array | undefined;

    if (!tp || tp.length !== bp.length)
        return { p: sub.p, n: sub.n };

    const map = correspondence(sub, base);
    const nv = sub.p.length / 3;
    const p: number[] = new Array(nv * 3);
    const n: number[] = new Array(nv * 3);

    for (let v = 0; v < nv; v++)
    {
        const best = map[v];

        for (let k = 0; k < 3; k++)
            p[v * 3 + k] = sub.p[v * 3 + k] + (tp[best * 3 + k] - bp[best * 3 + k]);

        const nn = bn && tn ? normalize([sub.n[v * 3] + tn[best * 3] - bn[best * 3], sub.n[v * 3 + 1] + tn[best * 3 + 1] - bn[best * 3 + 1], sub.n[v * 3 + 2] + tn[best * 3 + 2] - bn[best * 3 + 2]], [sub.n[v * 3], sub.n[v * 3 + 1], sub.n[v * 3 + 2]]) : [sub.n[v * 3], sub.n[v * 3 + 1], sub.n[v * 3 + 2]];
        n[v * 3] = nn[0];
        n[v * 3 + 1] = nn[1];
        n[v * 3 + 2] = nn[2];
    }

    return { p, n };
}

/** Area-weighted face normals summed per vertex. */
function vertexFaceNormals(p: ArrayLike<number>, tri: ArrayLike<number>, nv: number): Float64Array
{
    const out = new Float64Array(nv * 3);

    for (let i = 0; i + 2 < tri.length; i += 3)
    {
        const [a, b, c] = [tri[i], tri[i + 1], tri[i + 2]];
        const e1 = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
        const e2 = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];

        for (const v of [a, b, c])
            for (let k = 0; k < 3; k++)
                out[v * 3 + k] += n[k];
    }

    return out;
}

/**
 * Normals of a blend shape target: each base normal turned by the rotation that takes the vertex's surface normal
 * in the base to the one in the target (same triangles) — custom and flipped normals keep their relation.
 */
function deformNormals(base: SubMesh, target: number[]): number[]
{
    const nv = base.p.length / 3;
    const gb = vertexFaceNormals(base.p, base.tri, nv);
    const gt = vertexFaceNormals(target, base.tri, nv);
    const out: number[] = new Array(nv * 3);

    for (let v = 0; v < nv; v++)
    {
        const n: [number, number, number] = [base.n[v * 3], base.n[v * 3 + 1], base.n[v * 3 + 2]];
        const a = normalize([gb[v * 3], gb[v * 3 + 1], gb[v * 3 + 2]], [0, 0, 0]);
        const b = normalize([gt[v * 3], gt[v * 3 + 1], gt[v * 3 + 2]], [0, 0, 0]);
        const r = (a[0] || a[1] || a[2]) && (b[0] || b[1] || b[2]) ? turn(n, a, b) : n;
        const u = normalize([r[0], r[1], r[2]], n);
        out[v * 3] = u[0];
        out[v * 3 + 1] = u[1];
        out[v * 3 + 2] = u[2];
    }

    return out;
}

/** `v` turned by the rotation that takes unit vector `a` to unit vector `b` (Rodrigues; opposite: mirrored). */
function turn(v: number[], a: number[], b: number[]): number[]
{
    const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const axis = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const s = Math.hypot(axis[0], axis[1], axis[2]);

    if (s > 1e-9)
    {
        const k = [axis[0] / s, axis[1] / s, axis[2] / s];
        const kv = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
        const kx = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
        return [0, 1, 2].map((i) => v[i] * c + kx[i] * s + k[i] * kv * (1 - c));
    }

    if (c >= 0)
        return v;

    const d = v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
    return [v[0] - 2 * d * a[0], v[1] - 2 * d * a[1], v[2] - 2 * d * a[2]];
}

const positionGrids = new WeakMap<PdxNode, { q: number; grid: Map<string, number[]>; }>();
const candidates = new WeakMap<SubMesh, { base: PdxNode; lists: number[][]; }>();

/**
 * Normals of a blend shape target from a shape key: a vertex found in the original (same place in base and target,
 * same UV) turns its normal like the original target's did; the others like their surface (deformNormals).
 */
function targetNormals(base: SubMesh, target: number[], origBase: PdxNode | undefined, origTarget: PdxNode | undefined): number[]
{
    const out = deformNormals(base, target);
    const bp = origBase?.props.p as Float32Array | undefined;
    const bn = origBase?.props.n as Float32Array | undefined;
    const bu = origBase?.props.u0 as Float32Array | undefined;
    const tp = origTarget?.props.p as Float32Array | undefined;
    const tn = origTarget?.props.n as Float32Array | undefined;

    if (!bp || !bn || !tp || !tn || tp.length !== bp.length || tn.length !== bn.length)
        return out;

    // (one grid of the original base's positions for all its targets)
    let cached = positionGrids.get(origBase!);

    if (!cached)
    {
        let size = 0;

        for (let i = 0; i < bp.length; i++)
            size = Math.max(size, Math.abs(bp[i]));

        const q = Math.max(size, 1e-6) * 1e-5;
        const grid = new Map<string, number[]>();

        for (let i = 0; i < bp.length / 3; i++)
        {
            const k = `${Math.round(bp[i * 3] / q)},${Math.round(bp[i * 3 + 1] / q)},${Math.round(bp[i * 3 + 2] / q)}`;
            (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
        }

        cached = { q, grid };
        positionGrids.set(origBase!, cached);
    }

    const { q, grid } = cached;
    const nv = base.p.length / 3;
    // per vertex the original vertices at the same place with the same UV and a similar normal (one search per
    // sub-mesh, whatever the target)
    let found = candidates.get(base);

    if (!found || found.base !== origBase)
    {
        const lists: number[][] = [];
        const uv = base.uv[0];

        for (let v = 0; v < nv; v++)
        {
            const [x, y, z] = [base.p[v * 3], base.p[v * 3 + 1], base.p[v * 3 + 2]];
            const list: number[] = [];

            for (let dx = -1; dx <= 1; dx++)
                for (let dy = -1; dy <= 1; dy++)
                    for (let dz = -1; dz <= 1; dz++)
                    {
                        for (const i of grid.get(`${Math.round(x / q) + dx},${Math.round(y / q) + dy},${Math.round(z / q) + dz}`) ?? [])
                        {
                            const near = Math.abs(bp[i * 3] - x) + Math.abs(bp[i * 3 + 1] - y) + Math.abs(bp[i * 3 + 2] - z) < q * 6;
                            const sameUv = !bu || !uv || Math.abs(bu[i * 2] - uv[v * 2]) + Math.abs(bu[i * 2 + 1] - uv[v * 2 + 1]) < 1e-4;
                            const sameN = bn[i * 3] * base.n[v * 3] + bn[i * 3 + 1] * base.n[v * 3 + 1] + bn[i * 3 + 2] * base.n[v * 3 + 2] > 0.5;

                            if (near && sameUv && sameN)
                                list.push(i);
                        }
                    }

            lists.push(list);
        }

        found = { base: origBase!, lists };
        candidates.set(base, found);
    }

    const lists = found.lists;

    for (let v = 0; v < nv; v++)
    {
        // the original vertex that also has this vertex's place in the target
        const hit = lists[v].find((i) => Math.abs(tp[i * 3] - target[v * 3]) + Math.abs(tp[i * 3 + 1] - target[v * 3 + 1]) + Math.abs(tp[i * 3 + 2] - target[v * 3 + 2]) < q * 6) ?? -1;

        if (hit < 0)
            continue;

        const a = normalize([bn[hit * 3], bn[hit * 3 + 1], bn[hit * 3 + 2]], [0, 0, 0]);
        const b = normalize([tn[hit * 3], tn[hit * 3 + 1], tn[hit * 3 + 2]], [0, 0, 0]);
        const r = normalize(turn([base.n[v * 3], base.n[v * 3 + 1], base.n[v * 3 + 2]], a, b) as [number, number, number], [0, 1, 0]);
        out[v * 3] = r[0];
        out[v * 3 + 1] = r[1];
        out[v * 3 + 2] = r[2];
    }

    return out;
}

/**
 * A target sub-mesh: the new base's triangles and UVs with the target's positions and normals, tangents for that
 * shape, bounds recomputed; properties in the original target's order, its material block.
 */
function targetMesh(base: PdxNode, pn: { p: number[]; n: number[]; }, orig: PdxNode | undefined): PdxNode
{
    const f32 = (a: number[]): Float32Array => Float32Array.from(a, (x) => (Number.isFinite(x) ? x : 0));
    const p = f32(pn.p);
    const keys = Object.keys(orig?.props ?? base.props);

    for (const k of ['p', 'tri'])
        if (!keys.includes(k))
            keys.push(k);

    const props: Record<string, PdxValue> = {};
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];

    for (let i = 0; i < p.length; i++)
    {
        min[i % 3] = Math.min(min[i % 3], p[i]);
        max[i % 3] = Math.max(max[i % 3], p[i]);
    }

    if (!p.length)
    {
        min.fill(0);
        max.fill(0);
    }

    for (const k of keys)
    {
        if (k === 'p')
            props.p = p;
        else if (k === 'n')
            props.n = f32(pn.n);
        else if (k === 'ta' && base.props.ta)
        {
            const s: SubMesh = { material: undefined!, p: pn.p, n: pn.n, t: [], hasT: false, uv: base.props.u0 ? [Array.from(base.props.u0 as Float32Array)] : [], tri: Array.from(base.props.tri as Int32Array), skin: null, morph: new Map() };
            computeTangents(s);
            props.ta = f32(s.t);
        }
        else if (k === 'boundingsphere')
        {
            const c = [0, 1, 2].map((a) => Math.fround((min[a] + max[a]) / 2));
            let r = 0;

            for (let i = 0; i < p.length; i += 3)
                r = Math.max(r, Math.hypot(p[i] - c[0], p[i + 1] - c[1], p[i + 2] - c[2]));

            props.boundingsphere = Float32Array.of(c[0], c[1], c[2], r);
        }
        else if (k === 'sfs' && orig?.props.sfs)
            props.sfs = orig.props.sfs;
        else if (base.props[k] !== undefined)
            props[k] = base.props[k];
    }

    const material = (orig && find(orig, 'material')) ?? find(base, 'material')!;
    return { name: 'mesh', props, children: [{ name: 'aabb', props: { min: Float32Array.from(min), max: Float32Array.from(max) }, children: [] }, material] };
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

/** Which channels carry data per exported image kind: R G B A. */
const DATA_CHANNELS: Record<string, boolean[]> = {
    diffuse: [true, true, true, true],
    normal: [true, true, false, false],
    orm: [false, true, true, false],
    raw: [true, true, true, true]
};

async function importTextures(
    input: ImportInput,
    f: GltfFile,
    manifest: BlenderManifest | undefined,
    manifestDir: string | undefined,
    known: Map<string, SubMeshMaterial>,
    gltfMaterials: NonNullable<GltfFile['doc']['materials']>,
    writes: ImportWrite[],
    notes: string[],
    warnings: string[]
): Promise<void>
{
    // reference: what the export wrote (manifest), else the game's texture converted the same way now
    const reference = new Map<string, ManifestTexture>();

    for (const t of manifest?.textures ?? [])
        reference.set(t.role + '|' + lc(t.path), t);

    const originals = new Map<string, Promise<Awaited<ReturnType<typeof decodeTexture>> | undefined>>();
    const original = (path: string): Promise<Awaited<ReturnType<typeof decodeTexture>> | undefined> =>
    {
        let p = originals.get(lc(path));

        if (!p)
        {
            const bytes = input.read(path);
            p = bytes ? decodeTexture(bytes).catch(() => undefined) : Promise.resolve(undefined);
            originals.set(lc(path), p);
        }

        return p;
    };
    const refOf = async (path: string, role: string): Promise<ManifestTexture | undefined> =>
    {
        const hit = reference.get(role + '|' + lc(path));

        if (hit)
            return hit;

        const o = await original(path);

        if (!o)
            return undefined;

        const shown = role === 'normal' ? normalToGltf(o.img) : o.img;
        const t: ManifestTexture = { path, role, format: o.format, width: o.img.width, height: o.img.height, mips: o.mips, file: '', hash: '', channels: channelHashes(shown) };

        if (role === 'properties')
            t.orm = { file: '', hash: '', channels: channelHashes(propertiesToOrm(o.img)) };

        reference.set(role + '|' + lc(path), t);
        return t;
    };
    const changed = (img: RgbaImage, kind: string, channels: string[] | undefined, w: number, h: number): boolean =>
    {
        if (!channels || img.width !== w || img.height !== h)
            return true;

        const now = channelHashes(img);
        // an opaque diffuse: the exporter may have dropped the alpha — compared on colour only
        const noAlpha = kind === 'diffuse' && opaque(img);
        return DATA_CHANNELS[kind].some((use, c) => use && !(noAlpha && c === 3) && now[c] !== channels[c]);
    };
    const decodeImage = (i: number): RgbaImage | undefined =>
    {
        const { bytes, mime, uri, name } = imageBytes(f, i);

        if (!isPng(bytes))
        {
            warnings.push(`Image ${uri ?? name ?? i} is ${mime.replace('image/', '').toUpperCase()}, not PNG — not imported (export from Blender with Images: PNG).`);
            return undefined;
        }

        return decodePng(bytes);
    };
    const fileImage = (name: string): RgbaImage | undefined =>
    {
        for (const d of new Set([dirname(input.gltfPath), manifestDir].filter(Boolean) as string[]))
        {
            const p = join(d, name);

            if (!name || !existsSync(p))
                continue;

            try
            {
                return decodePng(readFileSync(p));
            }
            catch
            {
                return undefined;
            }
        }

        return undefined;
    };

    // candidates per texture (path|role): images bound in the glTF's materials, PNG files next to it
    const results = new Map<string, { path: string; role: string; img: RgbaImage; via: string; }>();
    const conflict = new Set<string>();
    const take = (path: string, role: string, img: RgbaImage, via: string): void =>
    {
        const key = role + '|' + lc(path);
        const prev = results.get(key);

        if (prev && (prev.img.width !== img.width || prev.img.height !== img.height || Buffer.compare(Buffer.from(prev.img.rgba), Buffer.from(img.rgba)) !== 0))
        {
            conflict.add(`${path} (${prev.via} and ${via} differ — ${prev.via} taken)`);
            return;
        }

        if (!prev)
            results.set(key, { path, role, img, via });
    };

    for (const gm of gltfMaterials)
    {
        const m = [gm.name, gm.name && unsuffixed(gm.name)].map((n) => (n ? known.get(lc(n)) : undefined)).find(Boolean);

        if (!m)
            continue;

        for (const t of m.textures)
        {
            if (!t.path)
                continue;

            const slot = t.role === 'diffuse' ? gm.pbrMetallicRoughness?.baseColorTexture : t.role === 'normal' ? gm.normalTexture : t.role === 'properties' ? gm.pbrMetallicRoughness?.metallicRoughnessTexture : undefined;
            const imgIndex = textureImage(f, slot);

            if (imgIndex === undefined)
                continue;

            const ref = await refOf(t.path, t.role);
            const img = decodeImage(imgIndex);

            if (!img || !ref)
                continue;

            const kind = t.role === 'properties' ? 'orm' : t.role;

            if (!changed(img, kind, kind === 'orm' ? ref.orm?.channels : ref.channels, ref.width, ref.height))
                continue;

            take(t.path, t.role + (kind === 'orm' ? '/orm' : ''), img, `${gm.name}'s ${t.role === 'properties' ? 'metallic-roughness' : t.role} image`);
        }
    }

    // PNG files next to the export: edited in an image editor (the raw properties map and textures Blender doesn't bind)
    for (const t of manifest?.textures ?? [])
    {
        const img = fileImage(t.file);

        if (!img)
            continue;

        const kind = t.role === 'diffuse' || t.role === 'normal' ? t.role : 'raw';

        if (!changed(img, kind, t.channels, t.width, t.height))
            continue;

        if (results.has(t.role + '|' + lc(t.path)))
            continue;

        take(t.path, t.role, img, t.file);
    }

    for (const c of conflict)
        warnings.push(`Texture ${c}.`);

    // back to the game's layout and DDS
    const done = new Set<string>();

    for (const r of results.values())
    {
        const role = r.role.replace(/\/orm$/, '');
        const key = role + '|' + lc(r.path);

        if (done.has(key))
            continue;

        // a raw properties file wins over the metallic-roughness image
        const direct = results.get(key);
        const use = direct ?? r;

        if (direct && results.has(role + '/orm|' + lc(r.path)))
            warnings.push(`${r.path}: both ${direct.via} and the metallic-roughness image changed — ${direct.via} taken.`);

        done.add(key);
        const o = await original(r.path);
        let img = use.img;
        let how = '';

        if (role === 'normal')
            img = normalFromGltf(img, o?.img);
        else if (role === 'properties' && use.role.endsWith('/orm'))
        {
            if (!o)
            {
                warnings.push(`${r.path}: the original properties map could not be read — its roughness/metalness edit is left out.`);
                continue;
            }

            img = propertiesFromOrm(img, o.img);
            how = ' (roughness and metalness from the metallic-roughness map)';
        }
        else if (role === 'diffuse' && o && opaque(img) && !opaque(o.img))
        {
            img = withAlpha(img, o.img);
            how = ' (alpha kept from the original: the file had none)';
        }

        const target = ddsTargetFor(o?.info, input.read(r.path), o?.img);
        const data = encodeDds(img, target);
        const users = input.plan.textureUsers[lc(r.path)] ?? 0;
        writes.push({ rel: r.path, data, what: `${role} texture ${img.width}×${img.height} ${target.format}${target.mips ? ' with mips' : ''}${how}` });

        if (users > 1)
            notes.push(`${r.path} is used by ${users} materials of the game’s models — the change shows on all of them.`);

        if (o?.format && !/^BC[13]|RGBA|MASKED/.test(o.format) && target.format === 'BGRA8')
            notes.push(`${r.path} was ${o.format}; it is written uncompressed (BGRA8), which the game reads but is larger.`);
    }
}
