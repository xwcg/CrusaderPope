/**
 * Round trip PDX → glTF → Blender → glTF → PDX (docs/blender.md): exports vanilla meshes for Blender, lets the
 * installed Blender import them (counts of objects, vertices, joints, materials, images) and export them back as GLB
 * and as glTF Separate, imports those into a temp mod and compares the result with the original mesh (shapes,
 * triangles, bounds, per-vertex positions / UVs / normals / weights). Nothing is written outside the output folder.
 *
 * Usage: node --experimental-strip-types --no-warnings --max-old-space-size=6000 scripts/blender-check.ts [out dir]
 * env: BLENDER=<blender.exe> (default: Blender 4.5), MESHES=<game path,…>, EDIT=1 (also the edit test: scale an
 * object, move vertices, paint the diffuse red — its mod is left in <out>/mod for the app)
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { PortraitBuilder } from '../src/main/portraits/portrait.ts';
import { ModelBrowser } from '../src/main/portraits/models.ts';
import { loadMesh, type MeshFile } from '../src/main/portraits/mesh.ts';
import { exportMesh } from '../src/main/blender/exportMesh.ts';
import { importMesh } from '../src/main/blender/importMesh.ts';
import { decodeTexture, normalFromGltf, normalToGltf, propertiesFromOrm, propertiesToOrm } from '../src/main/blender/textures.ts';
import { decodePng, encodePng } from '../src/main/images/png.ts';
import { encodeDds } from '../src/main/images/ddsEncode.ts';
import { defaultInstall } from './ck3-install.ts';

const install = defaultInstall();
const blender = process.env.BLENDER ?? 'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe';
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'ckp-blender-'));
mkdirSync(out, { recursive: true });
const MESHES = (
    process.env.MESHES ??
        [
            // static, two UV sets, LOD shapes, shared atlas textures
            'gfx/models/buildings/holdings/building_indian_castle_01.mesh',
            // several materials per shape
            'gfx/models/artifacts/ep2/ep2_western_brooch_01_a.mesh',
            // skinned animal, several materials, alpha-to-coverage
            'gfx/models/pets/horses/ep2_horse_01.mesh',
            // skinned clothing (portrait attachment with pattern)
            'gfx/models/portraits/m_clothes/byzantine/nob_01/m_clothing_secular_byzantine_nob_01.mesh',
            // several skinned shapes, each with its skeleton
            'gfx/models/pets/avians/falcons/ep2_falcon_peregrine_01.mesh'
        ].join(',')
)
    .split(',')
    .filter(Boolean);

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

console.log('building the vanilla index …');
const idx = new GameIndex(new GameFiles(gameDir), 'english');
idx.build();
const pb = new PortraitBuilder(idx);
const models = new ModelBrowser(idx, pb.lib);
const readGame = (path: string): Uint8Array | undefined => idx.vfs.read(path, { engine: true });

// ---------------------------------------------------------------------------
// 0. texture conversions and codecs on the first model's textures
// ---------------------------------------------------------------------------
{
    const plan = models.exportPlan(MESHES[0]);
    const tex = (role: string): string | undefined => plan?.parts.flatMap((p) => p.textures).find((t) => t.role === role && t.path)?.path;
    const psnr = (a: Uint8Array, b: Uint8Array): number =>
    {
        let se = 0;

        for (let i = 0; i < a.length; i++)
            se += (a[i] - b[i]) ** 2;

        return se ? 10 * Math.log10((255 * 255 * a.length) / se) : Infinity;
    };
    const same = (a: Uint8Array, b: Uint8Array, ch: number[]): boolean =>
    {
        for (let i = 0; i < a.length; i += 4)
            for (const c of ch)
                if (a[i + c] !== b[i + c])
                    return false;

        return true;
    };
    const normalPath = tex('normal');

    if (normalPath)
    {
        const n = (await decodeTexture(readGame(normalPath)!)).img;
        const back = normalFromGltf(normalToGltf(n), n);
        let red = 0;

        for (let i = 0; i < n.rgba.length; i += 4)
            red = Math.max(red, Math.abs(n.rgba[i] - back.rgba[i]));

        check(same(n.rgba, back.rgba, [1, 2, 3]), `normal map ${normalPath}: game → standard → game keeps green (x), alpha (y) and blue exactly; red ≈ x (Δ ≤ ${red})`);
    }

    const propsPath = tex('properties');

    if (propsPath)
    {
        const p = (await decodeTexture(readGame(propsPath)!)).img;
        check(same(p.rgba, propertiesFromOrm(propertiesToOrm(p), p).rgba, [0, 1, 2, 3]), `properties map ${propsPath}: → metallic-roughness → back is exact`);
    }

    const diffusePath = tex('diffuse');

    if (diffusePath)
    {
        const d = (await decodeTexture(readGame(diffusePath)!)).img;
        check(same(d.rgba, decodePng(encodePng(d.rgba, d.width, d.height)).rgba, [0, 1, 2, 3]), 'PNG encode → decode is exact');
        // (BC1 without punch-through alpha: the colours of an opaque copy)
        const opaque = { ...d, rgba: Uint8Array.from(d.rgba, (v, i) => (i % 4 === 3 ? 255 : v)) };

        for (const format of ['BC1', 'BC3', 'BGRA8'] as const)
        {
            const t0 = Date.now();
            const src = format === 'BC1' ? opaque : d;
            const back = await decodeTexture(encodeDds(src, { format, mips: true }));
            const q = psnr(src.rgba, back.img.rgba);
            check(back.img.width === d.width && back.mips === Math.floor(Math.log2(Math.max(d.width, d.height))) + 1 && (format === 'BGRA8' ? q === Infinity : q > 38), `DDS ${format} ${d.width}×${d.height} with ${back.mips} mips: PSNR ${q.toFixed(1)} dB, ${Date.now() - t0} ms`);
        }
    }
}

// ---------------------------------------------------------------------------
// 1. export
// ---------------------------------------------------------------------------
const exported: { mesh: string; dir: string; gltf: string; }[] = [];

for (const mesh of MESHES)
{
    const plan = models.exportPlan(mesh);

    if (!plan)
    {
        check(false, `${mesh}: no export plan`);
        continue;
    }

    const bytes = readGame(plan.mesh)!;
    const t0 = Date.now();
    const r = await exportMesh({ plan, meshBytes: bytes, meshWhere: plan.mesh, read: readGame, name: base(plan.mesh) });
    const dir = join(out, base(plan.mesh));
    mkdirSync(dir, { recursive: true });

    for (const f of r.files)
        writeFileSync(join(dir, f.name), f.data);

    const c = r.counts;
    console.log(
        `exported ${plan.mesh} in ${Date.now() - t0} ms: ${c.shapes} shapes, ${c.primitives} primitives, ${c.vertices} vertices, ${c.triangles} triangles, ${c.joints} joints, ${c.materials} materials, ${c.textures} textures${r.warnings.length ? '\n  ! ' + r.warnings.join('\n  ! ') : ''}`
    );
    exported.push({ mesh: plan.mesh, dir, gltf: join(dir, base(plan.mesh) + '.gltf') });
}

// ---------------------------------------------------------------------------
// 2. Blender: import, stats, export GLB + glTF Separate (+ the edit test)
// ---------------------------------------------------------------------------
const jobs = exported.map((e) => ({
    gltf: e.gltf,
    glb: join(e.dir, base(e.mesh) + '_rt.glb'),
    sep: join(e.dir, base(e.mesh) + '_rt_sep.gltf'),
    emb: join(e.dir, base(e.mesh) + '_rt_emb.gltf'),
    tangents: join(e.dir, base(e.mesh) + '_rt_tangents.glb'),
    // (meshes with blend shapes: also without shape keys)
    nomorph: models.exportPlan(e.mesh)?.blendShapes?.length ? join(e.dir, base(e.mesh) + '_rt_noshapekeys.glb') : undefined
}));
const editJob = process.env.EDIT
    ? (() =>
    {
        const e = exported[0];
        const m = loadMesh(readGame(e.mesh)!);
        const manifest = JSON.parse(readFileSync(join(e.dir, base(e.mesh) + '.crusaderpope.json'), 'utf8'));
        const diffuse = manifest.textures.find((t: { role: string; }) => t.role === 'diffuse');
        return { gltf: e.gltf, glb: join(e.dir, base(e.mesh) + '_edited.glb'), edit: { scale: [m.parts[0].shape, 1.5], move: [m.parts[0].shape, 3], red: diffuse?.file.replace(/\.png$/, '') } };
    })()
    : undefined;
const jobsFile = join(out, 'jobs.json');
writeFileSync(jobsFile, JSON.stringify(editJob ? [...jobs, editJob] : jobs));
console.log(`running ${blender} …`);
const run = spawnSync(blender, ['-b', '--factory-startup', '--python', join(import.meta.dirname, 'blender', 'roundtrip.py'), '--', jobsFile], { encoding: 'utf8', maxBuffer: 1 << 28 });
const log = (run.stdout ?? '') + (run.stderr ?? '');
writeFileSync(join(out, 'blender.log'), log);

if (run.status !== 0)
    console.log(log.slice(-4000));

check(run.status === 0, `Blender exited with ${run.status}`);
// warnings while importing (between IMPORT and RESULT) and while exporting; Blender's exporter warns about every
// metallic-roughness map ("More than one shader node tex image used for a texture": roughness and metallic are two
// sockets of the one image node) — harmless, counted apart
const importWarnings: string[] = [];
const exportWarnings: string[] = [];
let benign = 0;
let phase = '';

for (const line of log.split('\n'))
{
    if (line.startsWith('IMPORT '))
        phase = 'import';
    else if (line.startsWith('RESULT '))
    {
        phase = 'export';
        const r = JSON.parse(line.slice(7));
        const s = r.stats;
        console.log(
            `blender ${base(r.gltf)}: ${s.objects} objects, ${s.vertices} vertices, ${s.triangles} triangles, ${s.armatures} armatures / ${s.bones} bones, ${s.vertex_groups} vertex groups, ${s.materials.length} materials, ${s.images.length} images, ${s.empties} empties, ${s.shape_keys.length} shape keys`
        );
    }
    else if (/warning|error|traceback/i.test(line))
    {
        if (/More than one shader node tex image used for a texture/.test(line))
            benign++;
        else
            (phase === 'import' ? importWarnings : exportWarnings).push(line);
    }
}

check(!importWarnings.length, `Blender imports without warnings${importWarnings.length ? ':\n  ' + importWarnings.slice(0, 20).join('\n  ') : ''}`);
check(!exportWarnings.length, `Blender exports without warnings (${benign} × the metallic-roughness notice)${exportWarnings.length ? ':\n  ' + exportWarnings.slice(0, 20).join('\n  ') : ''}`);

// ---------------------------------------------------------------------------
// 3. import back and compare
// ---------------------------------------------------------------------------
interface Vtx
{
    p: number[];
    n: number[];
    uv: number[];
    uv2?: number[];
    w: Map<string, number>;
    /** tangent xyz and handedness */
    t?: number[];
}

function vertices(m: MeshFile, shape: string): Vtx[]
{
    const out: Vtx[] = [];
    // (by index and name: rigs repeat bone names)
    const names = new Map(m.bones.map((b) => [b.index, `${b.index}:${b.name}`]));

    for (const part of m.parts.filter((p) => p.shape === shape))
    {
        const nv = part.positions.length / 3;
        const stride = part.skin ? Math.max(1, Math.round(part.skin.ix.length / nv)) : 0;

        for (let v = 0; v < nv; v++)
        {
            const w = new Map<string, number>();

            if (part.skin)
            {
                // weights as the engine reads them: three stored, the fourth influence gets the rest
                let sum = 0;

                for (let k = 0; k < Math.min(4, stride); k++)
                {
                    const ix = part.skin.ix[v * stride + k];

                    if (ix < 0)
                        continue;

                    const wt = k < 3 ? part.skin.w[v * stride + k] : 1 - sum;
                    sum += k < 3 ? wt : 0;
                    const n = names.get(ix) ?? String(ix);
                    w.set(n, (w.get(n) ?? 0) + wt);
                }
            }

            out.push({
                p: [part.positions[v * 3], part.positions[v * 3 + 1], part.positions[v * 3 + 2]],
                n: [part.normals[v * 3], part.normals[v * 3 + 1], part.normals[v * 3 + 2]],
                uv: [part.uvs[v * 2], part.uvs[v * 2 + 1]],
                uv2: part.uvs2 ? [part.uvs2[v * 2], part.uvs2[v * 2 + 1]] : undefined,
                w,
                t: part.tangents ? Array.from(part.tangents.subarray(v * 4, v * 4 + 4)) : undefined
            });
        }
    }

    return out;
}

/**
 * `blend`: blend shape targets — judged on positions and normals (what the engine morphs); their UVs and tangents are
 * the new base's (vanilla targets differ from their base there: byzantine clothes in u1, 26 of the male head's in u0
 * with tangents flipped).
 */
function compare(a: MeshFile, b: MeshFile, blend = false): { ok: boolean; lines: string[]; }
{
    const lines: string[] = [];
    let ok = true;
    const shapesA = [...new Set(a.parts.map((p) => p.shape))];
    const shapesB = [...new Set(b.parts.map((p) => p.shape))];

    if (shapesA.join('|') !== shapesB.join('|'))
    {
        ok = false;
        lines.push(`shapes differ: ${shapesA.join(', ')} → ${shapesB.join(', ')}`);
    }

    if (a.bones.map((x) => x.name).join('|') !== b.bones.map((x) => x.name).join('|'))
    {
        ok = false;
        lines.push('joint names differ');
    }

    for (const shape of shapesA.filter((s) => shapesB.includes(s)))
    {
        const tris = (m: MeshFile): number => m.parts.filter((p) => p.shape === shape).reduce((n, p) => n + p.indices.length / 3, 0);
        const va = vertices(a, shape);
        const vb = vertices(b, shape);
        const bounds = (vs: Vtx[]): number[] => [0, 1, 2].flatMap((k) => [vs.reduce((m, v) => Math.min(m, v.p[k]), Infinity), vs.reduce((m, v) => Math.max(m, v.p[k]), -Infinity)]);
        const ba = bounds(va);
        const bb = bounds(vb);
        const size = Math.max(...[0, 1, 2].map((k) => ba[k * 2 + 1] - ba[k * 2]), 1e-6);
        const boundsDiff = Math.max(...ba.map((x, i) => Math.abs(x - bb[i]))) / size;
        // each result vertex against the closest original vertex at the same place (Blender re-splits and re-orders)
        const grid = new Map<string, Vtx[]>();
        const q = (x: number): number => Math.round(x / (size * 1e-4));

        for (const v of va)
        {
            const k = `${q(v.p[0])},${q(v.p[1])},${q(v.p[2])}`;
            (grid.get(k) ?? grid.set(k, []).get(k)!).push(v);
        }

        let maxP = 0;
        let maxUv = 0;
        let maxUv2 = 0;
        let maxN = 0;
        let maxW = 0;
        let unmatched = 0;
        // tangent frames: same handedness and a tangent in the same half-space as the original's
        let tPairs = 0;
        let tSame = 0;

        for (const v of vb)
        {
            const cand: Vtx[] = [];

            for (let dx = -1; dx <= 1; dx++)
                for (let dy = -1; dy <= 1; dy++)
                    for (let dz = -1; dz <= 1; dz++)
                        cand.push(...(grid.get(`${q(v.p[0]) + dx},${q(v.p[1]) + dy},${q(v.p[2]) + dz}`) ?? []));

            if (!cand.length)
            {
                unmatched++;
                continue;
            }

            const d = (o: Vtx): number => Math.hypot(o.uv[0] - v.uv[0], o.uv[1] - v.uv[1]) + (o.uv2 && v.uv2 && !blend ? Math.hypot(o.uv2[0] - v.uv2[0], o.uv2[1] - v.uv2[1]) : 0) + (1 - (o.n[0] * v.n[0] + o.n[1] * v.n[1] + o.n[2] * v.n[2])) * (blend ? 0.01 : 1);
            const o = cand.reduce((best, c) => (d(c) < d(best) ? c : best));
            maxP = Math.max(maxP, Math.hypot(o.p[0] - v.p[0], o.p[1] - v.p[1], o.p[2] - v.p[2]) / size);
            maxUv = Math.max(maxUv, Math.hypot(o.uv[0] - v.uv[0], o.uv[1] - v.uv[1]));

            if (o.uv2 && v.uv2)
                maxUv2 = Math.max(maxUv2, Math.hypot(o.uv2[0] - v.uv2[0], o.uv2[1] - v.uv2[1]));

            maxN = Math.max(maxN, 1 - (o.n[0] * v.n[0] + o.n[1] * v.n[1] + o.n[2] * v.n[2]));

            for (const name of new Set([...o.w.keys(), ...v.w.keys()]))
                maxW = Math.max(maxW, Math.abs((o.w.get(name) ?? 0) - (v.w.get(name) ?? 0)));

            if (o.t && v.t)
            {
                tPairs++;

                if (Math.sign(o.t[3]) === Math.sign(v.t[3]) && o.t[0] * v.t[0] + o.t[1] * v.t[1] + o.t[2] * v.t[2] > 0)
                    tSame++;
            }
        }

        const tShare = tPairs ? tSame / tPairs : 1;
        // (blend shape targets: positions and normals — the engine's morph; vanilla targets' UVs and tangents are not
        // always the base's, the import writes the base's UVs and tangents for the target's shape)
        const good = tris(a) === tris(b) && boundsDiff < 1e-4 && !unmatched && maxP < 1e-4 && maxN < 1e-3 && maxW < 0.02 && (blend || (maxUv < 1e-3 && maxUv2 < 1e-3 && tShare > 0.9));

        if (!good)
            ok = false;

        const parts = [
            `triangles ${tris(a)} → ${tris(b)}`,
            `vertices ${va.length} → ${vb.length}`,
            `bounds Δ ${boundsDiff.toExponential(1)}`,
            `position Δ ${maxP.toExponential(1)}`,
            `uv Δ ${maxUv.toExponential(1)}`
        ];

        if (va[0]?.uv2)
            parts.push(`uv2 Δ ${maxUv2.toExponential(1)}`);

        parts.push(`normal 1−cos ${maxN.toExponential(1)}`);

        if (tPairs)
            parts.push(`tangent frames alike ${(tShare * 100).toFixed(1)} %`);

        if (va[0]?.w.size)
            parts.push(`weight Δ ${maxW.toFixed(4)}`);

        if (unmatched)
            parts.push(`${unmatched} vertices unmatched`);

        lines.push(`${good ? '  ' : '! '}${shape}: ${parts.join(', ')}`);
    }

    return { ok, lines };
}

const modDir = join(out, 'mod');

for (const e of exported)
{
    const plan = models.exportPlan(e.mesh)!;
    const original = loadMesh(readGame(e.mesh)!);
    const files = [
        ['GLB', join(e.dir, base(e.mesh) + '_rt.glb')],
        ['glTF Separate', join(e.dir, base(e.mesh) + '_rt_sep.gltf')],
        ['glTF Embedded', join(e.dir, base(e.mesh) + '_rt_emb.gltf')],
        ['GLB without shape keys', join(e.dir, base(e.mesh) + '_rt_noshapekeys.glb')],
        ['GLB with Blender’s tangents', join(e.dir, base(e.mesh) + '_rt_tangents.glb')],
        ['as exported', e.gltf]
    ];

    for (const [kind, file] of files)
    {
        if (!existsSync(file))
        {
            // (Blender 4.2+ writes glTF Embedded only when the add-on's preferences allow it)
            if (kind === 'glTF Embedded')
                console.log(`     (${base(e.mesh)}: this Blender wrote no glTF Embedded)`);
            else if (kind !== 'GLB without shape keys' || plan.blendShapes?.length)
                check(false, `${base(e.mesh)} ${kind}: Blender wrote no file`);

            continue;
        }

        const t0 = Date.now();
        const r = await importMesh({ plan, meshBytes: readGame(e.mesh)!, gltfPath: file, read: readGame });
        const mesh = r.writes.find((w) => w.rel === plan.mesh)!;
        const cmp = compare(original, loadMesh(mesh.data));
        const textures = r.writes.filter((w) => /\.(dds|png)$/i.test(w.rel));
        // blend shape targets in the new vertex order: compared with the original targets like the mesh
        const blends = (plan.blendShapes ?? []).map((b) =>
        {
            const w = r.writes.find((x) => x.rel === b.file);
            const target = loadMesh(readGame(b.file)!);
            // (targets with other vertices than the base in the game already are left alone)
            const fits = target.parts.length === original.parts.length && target.parts.every((p, i) => p.positions.length === original.parts[i].positions.length);

            if (!w)
                return { id: b.id, what: undefined, skipped: !fits, cmp: { ok: !fits, lines: fits ? ['not written'] : [] } };

            return { id: b.id, what: w.what, skipped: false, cmp: fits ? compare(target, loadMesh(w.data), true) : { ok: false, lines: ['written although the original does not fit'] } };
        });
        const blendOk = blends.every((b) => b.cmp.ok);
        const skipped = blends.filter((b) => b.skipped).length;
        const written = textures.length ? `, textures written: ${textures.map((t) => t.rel).join(', ')}` : ', no texture changed';
        const fits = blends.length ? `, ${blends.filter((b) => b.cmp.ok && !b.skipped).length}/${blends.length - skipped} blend shapes fit${skipped ? ` (${skipped} left as they are: other vertices in the game)` : ''}` : '';
        const warned = r.warnings.length ? '\n    warnings: ' + r.warnings.join('\n      ') : '';
        check(cmp.ok && blendOk && !textures.length && !r.removed.length, `${base(e.mesh)} ${kind} → PDX in ${Date.now() - t0} ms${written}${fits}${warned}`);

        for (const l of cmp.lines)
            console.log('     ' + l);

        for (const b of blends)
            for (const l of b.cmp.lines)
                console.log(`     blend ${b.id} (${b.what}): ${l.trim()}`);
    }
}

// another model's file is refused (the export of the second mesh imported on the first's page)
if (exported.length > 1)
{
    const [a, b] = exported;
    const file = join(b.dir, base(b.mesh) + '_rt.glb');
    const refused = await importMesh({ plan: models.exportPlan(a.mesh)!, meshBytes: readGame(a.mesh)!, gltfPath: file, read: readGame }).then(
        () => '',
        (err: Error) => err.message
    );
    check(refused.includes(b.mesh), `${base(b.mesh)}_rt.glb on ${base(a.mesh)}'s page is refused: ${refused}`);
}

// ---------------------------------------------------------------------------
// 4. the edit test: scaled object, moved vertices, red quarter in the diffuse → a mod for the app
// ---------------------------------------------------------------------------
if (editJob)
{
    const e = exported[0];
    const plan = models.exportPlan(e.mesh)!;
    const r = await importMesh({ plan, meshBytes: readGame(e.mesh)!, gltfPath: editJob.glb, read: readGame });
    const root = join(modDir, 'blender_test');

    for (const w of r.writes)
    {
        mkdirSync(dirname(join(root, w.rel)), { recursive: true });
        writeFileSync(join(root, w.rel), w.data);
    }

    const a = loadMesh(readGame(e.mesh)!);
    const b = loadMesh(r.writes.find((w) => w.rel === plan.mesh)!.data);
    const shape = editJob.edit.scale[0] as string;
    /** extent of the edited shape (`first`: of the file's first shape — blend shape targets name theirs otherwise) */
    const ext = (m: MeshFile, first = false): number[] =>
    {
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];

        for (const p of m.parts.filter((x) => (first ? x.shape === m.parts[0].shape : x.shape === shape)))
        {
            p.positions.forEach((v, i) =>
            {
                lo[i % 3] = Math.min(lo[i % 3], v);
                hi[i % 3] = Math.max(hi[i % 3], v);
            });
        }

        return [0, 1, 2].map((k) => hi[k] - lo[k]);
    };
    const ea = ext(a);
    const eb = ext(b);
    console.log(`edit: ${shape} extent ${ea.map((x) => x.toFixed(2)).join(' × ')} → ${eb.map((x) => x.toFixed(2)).join(' × ')}; writes: ${r.writes.map((w) => `${w.rel} (${w.what})`).join('; ')}`);
    check(Math.abs(eb[0] / ea[0] - 1.5) < 0.01 && Math.abs(eb[2] / ea[2] - 1.5) < 0.01 && eb[1] > ea[1] * 1.5, 'edit: the object is 1.5× wider and deeper, and taller than 1.5× (vertices moved up)');

    // blend shape targets follow the edit (the shape keys were scaled with the object)
    for (const b of plan.blendShapes ?? [])
    {
        const w = r.writes.find((x) => x.rel === b.file);

        if (!w)
        {
            check(false, `edit: blend shape ${b.id} written`);
            continue;
        }

        const ta = ext(loadMesh(readGame(b.file)!), true);
        const tb = ext(loadMesh(w.data), true);
        check(Math.abs(tb[0] / ta[0] - 1.5) < 0.02 && Math.abs(tb[2] / ta[2] - 1.5) < 0.02, `edit: blend shape ${b.id} extent ${ta.map((x) => x.toFixed(1)).join(' × ')} → ${tb.map((x) => x.toFixed(1)).join(' × ')} (${w.what})`);
    }

    const tex = r.writes.find((w) => w.rel !== plan.mesh && /diffuse/i.test(w.rel));

    if (tex)
    {
        const d = await decodeTexture(tex.data);
        const px = (x: number, y: number): number[] => Array.from(d.img.rgba.subarray((y * d.img.width + x) * 4, (y * d.img.width + x) * 4 + 4));
        const tl = px(Math.floor(d.img.width / 8), Math.floor(d.img.height / 8));
        check(tl[0] > 240 && tl[1] < 16 && tl[2] < 16, `edit: the diffuse's top-left quarter is red (${tl.join(',')}), ${d.format} ${d.img.width}×${d.img.height}, ${d.mips} mips`);
    }
    else
        check(false, 'edit: the diffuse texture was written');

    console.log(`mod for the app: ${root}`);
}

console.log(failures ? `${failures} FAILED` : 'all ok', '— output in', out);
process.exitCode = failures ? 1 : 0;
