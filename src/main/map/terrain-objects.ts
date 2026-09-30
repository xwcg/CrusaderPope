/**
 * Trees and other map objects for the 3D map (docs/map.md, "3D map"). gfx/map/map_object_data/**.txt lists them:
 * `object={ name layer pdxmesh clamp_to_water_level count transform="x y z qx qy qz qw sx sy sz …" }` — one line per
 * instance in game coordinates (x east, z north from the map's bottom edge; y an offset over the ground; rotations
 * about y only), generated forests in generated/ (vanilla ~550 k instances of 43 meshes, AGOT ~2.1 M of 226 with its
 * roads, ports and cities). Layers (layers.txt, game_object_layers.txt) fade out at a zoom step (`fade_out`: vanilla
 * trees 9, AGOT 16). A pdxmesh is declared in some .asset (`file`, `scale`, `meshsettings` per shape: textures,
 * shader); its first level of detail is used. Built once per version of the files on mapTerrainWorker.js into
 * `<key>-objects.bin` (vertices, indices, instances sorted by cell, the cells) and `<key>-objects.json`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameFiles } from '../mods/gamefiles.ts';
import type { MapTerrainInfo } from '../../shared/api.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { loadMesh } from '../portraits/mesh.ts';

type ObjectsInfo = NonNullable<MapTerrainInfo['objects']>;

/** Bumped when the files change shape. */
export const OBJECTS_VERSION = 4;
/** map pixels per side of an instance cell (what the renderer culls by) */
const CELL = 128;
/** floats per vertex: position, normal, tangent (xyz + handedness), uv */
const VERTEX = 12;
/** floats per instance: x, y (over the ground), z (game: from the bottom), yaw, scale */
const INSTANCE = 5;
/** layers that are not drawn: lake surfaces (water: the map's own), table props of the zoomed-out map */
const SKIP_LAYER = /^(lake_layer|map_table_layer)/;
/** shaders not drawn as meshes: water surfaces, decal planes (bridges' dirt on the ground) */
const SKIP_SHADER = /water|lake|river|^decal/i;

/** A mesh part for the thread: vertex streams and its material. */
export interface PartInput
{
    positions: Float32Array;
    normals: Float32Array;
    tangents?: Float32Array;
    uvs: Float32Array;
    indices: Uint32Array;
    textures: ObjectsInfo['parts'][number]['textures'];
    tree: boolean;
    /** `snap_to_terrain*` shaders: every vertex set on the ground (its own height above it) */
    snap: boolean;
    /** `*alpha_to_coverage*` shaders: the diffuse alpha cuts the shape out */
    coverage: boolean;
}

export interface ObjectsInput
{
    key: string;
    dir: string;
    /** the map_object_data files */
    files: Uint8Array[];
    /** by pdxmesh name: its parts (pdxmesh scale applied) */
    models: Record<string, PartInput[]>;
    /** layer → the zoom step it fades out at */
    fades: Record<string, number>;
}

const kids = (n: PNode | undefined): PNode[] => (n && Array.isArray(n.v) ? n.v : []);
const str = (list: PNode[], k: string): string | undefined =>
{
    const v = list.find((c) => c.k === k)?.v;
    return typeof v === 'string' && v ? v : undefined;
};

/** layers.txt and game_object_layers.txt: `layer={ name fade_in fade_out … }` → name → fade_out (a zoom step). */
function layerFades(vfs: GameFiles): Record<string, number>
{
    const out: Record<string, number> = {};

    for (const f of ['layers.txt', 'game_object_layers.txt'])
        for (const n of parse(vfs.readText('gfx/map/map_object_data/' + f) ?? ''))
            if (n.k === 'layer')
            {
                const name = str(kids(n), 'name');
                const fade = parseFloat(str(kids(n), 'fade_out') ?? '');

                if (name && Number.isFinite(fade))
                    out[name] = fade;
            }

    return out;
}

/** The level of detail of a mesh shape (`…|LOD_1|…`, `…_LOD1`), 0 without one. */
const lodOf = (shape: string): number => Number(/LOD_?(\d+)/i.exec(shape)?.[1] ?? 0);

/**
 * Where the objects' pdxmeshes are declared: every .asset under gfx/models whose pdxmesh names are wanted, parsed.
 * Texture and mesh references are relative to the asset's folder or game paths, else found by file name.
 */
function resolveModels(vfs: GameFiles, wanted: Set<string>): Record<string, PartInput[]>
{
    const models: Record<string, PartInput[]> = {};
    let byName: Map<string, string> | undefined;
    const find = (ref: string, dir: string): string | undefined =>
    {
        const r = ref.replace(/\\/g, '/');

        for (const p of [dir + r, r])
            if (vfs.get(p, { engine: true }))
                return p;

        if (!byName)
        {
            byName = new Map();

            for (const f of vfs.list('gfx/models', { ext: /\.dds$/i, engine: true }))
            {
                const n = f.rel.slice(f.rel.lastIndexOf('/') + 1).toLowerCase();

                if (!byName.has(n))
                    byName.set(n, f.rel);
            }
        }

        return byName.get(r.slice(r.lastIndexOf('/') + 1).toLowerCase());
    };

    for (const f of vfs.list('gfx/models', { ext: /\.asset$/i, engine: true }))
    {
        const text = vfs.readText(f);

        if (!text || ![...text.matchAll(/name\s*=\s*"([^"]+)"/g)].some((m) => wanted.has(m[1]) && !models[m[1]]))
            continue;

        const dir = f.rel.slice(0, f.rel.lastIndexOf('/') + 1);
        let nodes: PNode[];

        try
        {
            nodes = parse(text);
        }
        catch
        {
            continue;
        }

        for (const m of nodes.filter((n) => n.k === 'pdxmesh'))
        {
            const list = kids(m);
            const name = str(list, 'name');
            const file = str(list, 'file');

            if (!name || !file || !wanted.has(name) || models[name])
                continue;

            const meshRel = find(file, dir);
            const bytes = meshRel && vfs.read(meshRel, { engine: true });

            if (!bytes)
                continue;

            const scale = parseFloat(str(list, 'scale') ?? '') || 1;
            const settings = list.filter((c) => c.k === 'meshsettings').map(kids);
            let parts;

            try
            {
                parts = loadMesh(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).parts;
            }
            catch
            {
                continue;
            }

            const out: PartInput[] = [];
            const seen = new Map<string, number>();

            for (const p of parts)
            {
                const index = seen.get(p.shape) ?? 0;
                seen.set(p.shape, index + 1);

                if (lodOf(p.shape) !== 0)
                    continue;

                // meshsettings pair up with a shape by name and index (a shape's sub-meshes)
                const s = settings.find((x) => str(x, 'name') === p.shape && (parseInt(str(x, 'index') ?? '0', 10) || 0) === index) ?? settings.find((x) => str(x, 'name') === p.shape);
                const shader = (s && str(s, 'shader')) ?? p.material.shader ?? '';

                if (SKIP_SHADER.test(shader))
                    continue;

                const tex = (ref: string | undefined): string | undefined => (ref ? find(ref, dir) : undefined);
                // (the tree shader's tint strip: `texture = { file = "…_tint.dds" index = 3 }`)
                const tint = s && str(kids(s.find((c) => c.k === 'texture' && str(kids(c), 'index') === '3')), 'file');
                const positions = new Float32Array(p.positions.length);

                for (let i = 0; i < positions.length; i++)
                    positions[i] = p.positions[i] * scale;

                out.push({
                    positions,
                    normals: p.normals,
                    tangents: p.tangents,
                    // (atlas shaders — `standard_atlas`: bridges, buildings — read their textures at the second UV set)
                    uvs: /atlas/i.test(shader) && p.uvs2 ? p.uvs2 : p.uvs,
                    indices: p.indices,
                    textures: {
                        diffuse: tex((s && str(s, 'texture_diffuse')) ?? p.material.diff),
                        normal: tex((s && str(s, 'texture_normal')) ?? p.material.n),
                        properties: tex((s && str(s, 'texture_specular')) ?? p.material.spec),
                        tint: tex(tint)
                    },
                    tree: /^tree/.test(shader),
                    snap: /snap_to_terrain/i.test(shader),
                    coverage: /alpha_to_coverage/i.test(shader)
                });
            }

            if (out.length)
                models[name] = out;
        }
    }

    return models;
}

/** The objects' input for the thread and the key of their build (the object files and the meshes they use). */
export function objectsInput(vfs: GameFiles, dir: string): { key: string; input: () => ObjectsInput; } | null
{
    const files = vfs.list('gfx/map/map_object_data', { ext: /\.txt$/i });

    if (!files.length)
        return null;

    const key = createHash('sha1')
        .update(JSON.stringify([OBJECTS_VERSION, ...files.map((f) => [vfs.where(f), vfs.stat(f).size, vfs.stat(f).mtime])]))
        .digest('hex')
        .slice(0, 16);
    return {
        key,
        input: () =>
        {
            const texts = files.map((f) => vfs.read(f)).filter((b): b is Buffer => !!b);
            const wanted = new Set<string>();

            for (const b of texts)
                for (const m of b.toString('latin1').matchAll(/pdxmesh\s*=\s*"([^"]+)"/g))
                    wanted.add(m[1]);

            const models = resolveModels(vfs, wanted);
            return { key, dir, files: texts.map((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)), models, fades: layerFades(vfs) };
        }
    };
}

/** The decimals of a transform string between `at` and `end` (`737.544373 -0.000000 1e-3 …`). */
function numbers(text: string, at: number, end: number): Float64Array
{
    const out: number[] = [];
    let i = at;

    while (i < end)
    {
        let c = text.charCodeAt(i);

        if (c <= 32)
        {
            i++;
            continue;
        }

        const neg = c === 45;

        if (neg || c === 43)
            c = text.charCodeAt(++i);

        let v = 0;

        while (c >= 48 && c <= 57)
        {
            v = v * 10 + c - 48;
            c = text.charCodeAt(++i);
        }

        if (c === 46)
        {
            let f = 0.1;
            c = text.charCodeAt(++i);

            while (c >= 48 && c <= 57)
            {
                v += (c - 48) * f;
                f /= 10;
                c = text.charCodeAt(++i);
            }
        }

        if (c === 101 || c === 69)
        {
            const s = i;

            while (i < end && text.charCodeAt(i) > 32)
                i++;

            v *= Math.pow(10, Number(text.slice(s + 1, i)));
        }
        else
            while (i < end && text.charCodeAt(i) > 32)
                i++;

        out.push(neg ? -v : v);
    }

    return Float64Array.from(out);
}

/**
 * The object blocks of a map_object_data file with a pdxmesh and a transform (blocks hold no other braces). Commented
 * out ones are skipped: an `object={` after a `#` on its line (mods switch the game's objects off so — AGOT's
 * changan_building.txt, whose transform's closing `"}` stays uncommented on the next line), and commented lines inside a
 * block count for nothing.
 */
function objectsOf(text: string): { mesh: string; layer: string; clamp: boolean; t: Float64Array; }[]
{
    const out: { mesh: string; layer: string; clamp: boolean; t: Float64Array; }[] = [];
    const re = /\bobject\s*=\s*\{/g;
    const tr = /transform\s*=\s*"/g;

    while (re.exec(text))
    {
        const start = re.lastIndex;
        const lineStart = text.lastIndexOf('\n', start) + 1;

        if (text.slice(lineStart, start).includes('#'))
            continue;

        const close = text.indexOf('}', start);
        tr.lastIndex = start;
        const t = tr.exec(text);

        if (close < 0 || !t || t.index > close)
            continue;

        const tEnd = text.indexOf('"', tr.lastIndex);
        const head = text.slice(start, t.index).replace(/#[^\n]*/g, '');
        const mesh = /pdxmesh\s*=\s*"([^"]*)"/.exec(head)?.[1];
        re.lastIndex = tEnd < 0 ? text.length : tEnd;

        if (!mesh || tEnd < 0)
            continue;

        out.push({ mesh, layer: /layer\s*=\s*"([^"]*)"/.exec(head)?.[1] ?? '', clamp: /clamp_to_water_level\s*=\s*yes/.test(head), t: numbers(text, tr.lastIndex, tEnd) });
    }

    return out;
}

/** Builds `<key>-objects.bin` and `<key>-objects.json` (last) on the thread. */
export function buildObjects(input: ObjectsInput): ObjectsInfo
{
    const { key, dir, models, fades } = input;
    const decoder = new TextDecoder('latin1');
    // instances per (model, layer, clamp)
    const groups = new Map<string, { model: string; fade: number; clamp: boolean; data: number[]; }>();
    let maxX = 0;
    let maxZ = 0;

    for (const bytes of input.files)
    {
        for (const o of objectsOf(decoder.decode(bytes)))
        {
            if (SKIP_LAYER.test(o.layer) || !models[o.mesh])
                continue;

            const id = `${o.mesh}|${o.layer}|${o.clamp}`;
            let g = groups.get(id);

            if (!g)
                groups.set(id, g = { model: o.mesh, fade: fades[o.layer] ?? 16, clamp: o.clamp, data: [] });

            for (let i = 0; i + 9 < o.t.length; i += 10)
            {
                const [x, y, z, , qy, , qw, sx, sy, sz] = o.t.subarray(i, i + 10);

                if (!Number.isFinite(x + y + z + qy + qw + sx))
                    continue;

                g.data.push(x, y, z, 2 * Math.atan2(qy, qw), (sx + sy + sz) / 3);
                maxX = Math.max(maxX, x);
                maxZ = Math.max(maxZ, z);
            }
        }
    }

    // (an instance reaching over a quarter of the map is no object on it: a sky dome around the whole map)
    const span = Math.max(maxX, maxZ) / 4;
    const radii = new Map<string, number>();
    const radiusOf = (model: string): number =>
    {
        let r = radii.get(model);

        if (r === undefined)
        {
            r = 0;

            for (const p of models[model])
                for (let i = 0; i + 2 < p.positions.length; i += 3)
                    r = Math.max(r, Math.hypot(p.positions[i], p.positions[i + 1], p.positions[i + 2]));

            radii.set(model, r);
        }

        return r;
    };

    for (const [id, g] of groups)
    {
        const r = radiusOf(g.model);
        let over = false;

        for (let i = 4; i < g.data.length && !over; i += INSTANCE)
            over = r * g.data[i] > span;

        if (!over)
            continue;

        const kept: number[] = [];

        for (let i = 0; i + 4 < g.data.length; i += INSTANCE)
            if (r * g.data[i + 4] <= span)
                kept.push(...g.data.slice(i, i + INSTANCE));

        if (kept.length)
            g.data = kept;
        else
            groups.delete(id);
    }

    const cols = Math.max(1, Math.ceil((maxX + 1) / CELL));
    const rows = Math.max(1, Math.ceil((maxZ + 1) / CELL));
    // the models in use, their parts' vertices and indices
    const names = [...new Set([...groups.values()].map((g) => g.model))];
    const parts: ObjectsInfo['parts'] = [];
    const vertexChunks: Float32Array[] = [];
    const indexChunks: Uint32Array[] = [];
    let vertexCount = 0;
    let indexCount = 0;
    const modelList: ObjectsInfo['models'] = names.map((name) =>
    {
        const ids: number[] = [];
        let height = 0;
        let radius = 0;

        for (const p of models[name])
        {
            const n = p.positions.length / 3;
            const v = new Float32Array(n * VERTEX);

            for (let i = 0; i < n; i++)
            {
                const o = i * VERTEX;
                v.set(p.positions.subarray(i * 3, i * 3 + 3), o);
                v.set(p.normals.subarray(i * 3, i * 3 + 3), o + 3);

                if (p.tangents)
                    v.set(p.tangents.subarray(i * 4, i * 4 + 4), o + 6);
                else
                    v.set([1, 0, 0, 1], o + 6);

                v.set(p.uvs.subarray(i * 2, i * 2 + 2), o + 10);
                height = Math.max(height, p.positions[i * 3 + 1]);
                radius = Math.max(radius, Math.hypot(p.positions[i * 3], p.positions[i * 3 + 2]));
            }

            ids.push(parts.length);
            parts.push({ vertexStart: vertexCount, vertexCount: n, indexStart: indexCount, indexCount: p.indices.length, textures: p.textures, tree: p.tree, snap: p.snap, coverage: p.coverage });
            vertexChunks.push(v);
            indexChunks.push(p.indices);
            vertexCount += n;
            indexCount += p.indices.length;
        }

        return { name, parts: ids, height, radius };
    });
    // instances sorted by cell, per group
    const groupList: ObjectsInfo['groups'] = [];
    const instanceChunks: Float32Array[] = [];
    const cells = new Uint32Array(groups.size * cols * rows * 2);
    let instanceCount = 0;
    let g = 0;

    for (const grp of groups.values())
    {
        const n = grp.data.length / INSTANCE;
        const cellOf = new Uint32Array(n);
        const counts = new Uint32Array(cols * rows);

        for (let i = 0; i < n; i++)
        {
            const c = Math.min(rows - 1, Math.max(0, Math.floor(grp.data[i * INSTANCE + 2] / CELL))) * cols + Math.min(cols - 1, Math.max(0, Math.floor(grp.data[i * INSTANCE] / CELL)));
            cellOf[i] = c;
            counts[c]++;
        }

        const base = g * cols * rows * 2;
        let at = 0;

        for (let c = 0; c < cols * rows; c++)
        {
            cells[base + c * 2] = at;
            cells[base + c * 2 + 1] = counts[c];
            at += counts[c];
        }

        const fill = new Uint32Array(cols * rows);
        const sorted = new Float32Array(n * INSTANCE);

        for (let i = 0; i < n; i++)
        {
            const c = cellOf[i];
            const to = (cells[base + c * 2] + fill[c]++) * INSTANCE;

            for (let k = 0; k < INSTANCE; k++)
                sorted[to + k] = grp.data[i * INSTANCE + k];
        }

        groupList.push({ model: names.indexOf(grp.model), fade: grp.fade, clamp: grp.clamp, start: instanceCount, count: n, cells: g * cols * rows });
        instanceChunks.push(sorted);
        instanceCount += n;
        g++;
    }

    const info: ObjectsInfo = { key, vertices: vertexCount, indices: indexCount, instances: instanceCount, cell: CELL, cols, rows, parts, models: modelList, groups: groupList };
    mkdirSync(dir, { recursive: true });
    const out = Buffer.allocUnsafe((vertexCount * VERTEX + indexCount + instanceCount * INSTANCE) * 4 + cells.byteLength);
    let pos = 0;

    for (const a of [...vertexChunks, ...indexChunks, ...instanceChunks, cells])
    {
        out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), pos);
        pos += a.byteLength;
    }

    writeFileSync(join(dir, key + '-objects.bin'), out);
    const tmp = join(dir, key + '-objects.json.tmp');
    writeFileSync(tmp, JSON.stringify(info));
    renameSync(tmp, join(dir, key + '-objects.json'));
    return info;
}

/** A build on disk, or null. */
export function readObjects(dir: string, key: string): ObjectsInfo | null
{
    const file = join(dir, key + '-objects.json');

    if (!existsSync(file) || !existsSync(join(dir, key + '-objects.bin')))
        return null;

    try
    {
        return JSON.parse(readFileSync(file, 'utf8')) as ObjectsInfo;
    }
    catch
    {
        return null;
    }
}
