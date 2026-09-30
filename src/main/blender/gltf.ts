/**
 * glTF 2.0 files (docs/blender.md): a writer for `.gltf` + `.bin` (external images) and a reader for everything
 * Blender's exporter writes — `.glb`, `.gltf` with a separate `.bin`, `.gltf` with embedded (data URI) buffers and
 * images. Plain Node.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface GltfAccessor
{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    normalized?: boolean;
    count: number;
    type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4' | string;
    min?: number[];
    max?: number[];
    sparse?: {
        count: number;
        indices: { bufferView: number; byteOffset?: number; componentType: number; };
        values: { bufferView: number; byteOffset?: number; };
    };
    name?: string;
}

export interface GltfPrimitive
{
    attributes: Record<string, number>;
    indices?: number;
    material?: number;
    mode?: number;
    targets?: Record<string, number>[];
    extensions?: Record<string, unknown>;
}

export interface GltfNode
{
    name?: string;
    children?: number[];
    mesh?: number;
    skin?: number;
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    extras?: Record<string, unknown>;
}

export interface GltfTextureInfo
{
    index: number;
    texCoord?: number;
    scale?: number;
    strength?: number;
    extensions?: Record<string, unknown>;
}

export interface GltfMaterial
{
    name?: string;
    pbrMetallicRoughness?: {
        baseColorFactor?: number[];
        baseColorTexture?: GltfTextureInfo;
        metallicFactor?: number;
        roughnessFactor?: number;
        metallicRoughnessTexture?: GltfTextureInfo;
    };
    normalTexture?: GltfTextureInfo;
    occlusionTexture?: GltfTextureInfo;
    emissiveTexture?: GltfTextureInfo;
    alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
    alphaCutoff?: number;
    doubleSided?: boolean;
    extras?: Record<string, unknown>;
}

export interface GltfDoc
{
    asset: { version: string; generator?: string; extras?: Record<string, unknown>; };
    extensionsUsed?: string[];
    extensionsRequired?: string[];
    scene?: number;
    scenes?: { name?: string; nodes?: number[]; extras?: Record<string, unknown>; }[];
    nodes?: GltfNode[];
    meshes?: { name?: string; primitives: GltfPrimitive[]; extras?: Record<string, unknown>; }[];
    skins?: { name?: string; joints: number[]; inverseBindMatrices?: number; skeleton?: number; }[];
    materials?: GltfMaterial[];
    textures?: { source?: number; sampler?: number; name?: string; extensions?: Record<string, { source?: number; }>; }[];
    images?: { uri?: string; bufferView?: number; mimeType?: string; name?: string; }[];
    samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number; }[];
    accessors?: GltfAccessor[];
    bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number; }[];
    buffers?: { uri?: string; byteLength: number; }[];
    extras?: Record<string, unknown>;
}

export const FLOAT = 5126;
export const UNSIGNED_BYTE = 5121;
export const UNSIGNED_SHORT = 5123;
export const UNSIGNED_INT = 5125;
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Collects a document and its binary buffer; accessors are packed into one buffer, 4-byte aligned. */
export class GltfBuilder
{
    doc: GltfDoc;
    private parts: Uint8Array[] = [];
    private size = 0;

    constructor(generator: string)
    {
        this.doc = { asset: { version: '2.0', generator }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], textures: [], images: [], samplers: [], accessors: [], bufferViews: [] };
    }

    private view(bytes: Uint8Array, target?: number): number
    {
        const pad = (4 - (this.size % 4)) % 4;

        if (pad)
        {
            this.parts.push(new Uint8Array(pad));
            this.size += pad;
        }

        this.parts.push(bytes);
        const i = this.doc.bufferViews!.push({ buffer: 0, byteOffset: this.size, byteLength: bytes.length, ...(target ? { target } : {}) }) - 1;
        this.size += bytes.length;
        return i;
    }

    /** An accessor over `data`; POSITION accessors need `minMax`. */
    accessor(data: Float32Array | Uint8Array | Uint16Array | Uint32Array, type: GltfAccessor['type'], opts: { target?: number; minMax?: boolean; } = {}): number
    {
        const componentType = data instanceof Float32Array ? FLOAT : data instanceof Uint8Array ? UNSIGNED_BYTE : data instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_INT;
        const n = COMPONENTS[type];
        const acc: GltfAccessor = { bufferView: this.view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), opts.target), componentType, count: data.length / n, type };

        if (opts.minMax)
        {
            const min = new Array(n).fill(Infinity);
            const max = new Array(n).fill(-Infinity);

            for (let i = 0; i < data.length; i++)
            {
                const k = i % n;

                if (data[i] < min[k])
                    min[k] = data[i];

                if (data[i] > max[k])
                    max[k] = data[i];
            }

            acc.min = min.map((x) => (Number.isFinite(x) ? Math.fround(x) : 0));
            acc.max = max.map((x) => (Number.isFinite(x) ? Math.fround(x) : 0));
        }

        return this.doc.accessors!.push(acc) - 1;
    }

    /** The finished document (buffer named `binName`) and the buffer's bytes. */
    finish(binName: string): { json: string; bin: Uint8Array; }
    {
        const bin = new Uint8Array(this.size);
        let pos = 0;

        for (const p of this.parts)
        {
            bin.set(p, pos);
            pos += p.length;
        }

        this.doc.buffers = [{ uri: encodeURI(binName), byteLength: this.size }];

        // empty arrays are not allowed by the schema
        for (const k of Object.keys(this.doc) as (keyof GltfDoc)[])
        {
            const v = this.doc[k];

            if (Array.isArray(v) && !v.length)
                delete this.doc[k];
        }

        return { json: JSON.stringify(this.doc, null, 1), bin };
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface GltfFile
{
    doc: GltfDoc;
    buffers: Uint8Array[];
    /** folder of the file (external buffers and images) */
    dir: string;
}

function dataUri(uri: string): Uint8Array | undefined
{
    const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(uri);

    if (!m)
        return undefined;

    return m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]), 'latin1');
}

function external(dir: string, uri: string): Uint8Array
{
    const data = dataUri(uri);

    if (data)
        return data;

    let rel: string;

    try
    {
        rel = decodeURIComponent(uri);
    }
    catch
    {
        rel = uri;
    }

    return readFileSync(join(dir, rel));
}

/** Parses a .glb or .gltf file with its buffers. */
export function readGltf(file: string, bytes?: Uint8Array): GltfFile
{
    const buf = Buffer.from(bytes ?? readFileSync(file));
    const dir = dirname(file);
    let doc: GltfDoc;
    let glbBin: Uint8Array | undefined;

    if (buf.length >= 12 && buf.readUInt32LE(0) === 0x46546c67)
    {
        // GLB: header, JSON chunk, optional BIN chunk
        let pos = 12;
        let json = '';

        while (pos + 8 <= buf.length)
        {
            const len = buf.readUInt32LE(pos);
            const type = buf.readUInt32LE(pos + 4);
            const data = buf.subarray(pos + 8, pos + 8 + len);

            if (type === 0x4e4f534a)
                json = data.toString('utf8');
            else if (type === 0x004e4942)
                glbBin = data;

            pos += 8 + len;
        }

        doc = JSON.parse(json);
    }
    else
    {
        doc = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
    }

    if (!doc?.asset || String(doc.asset.version).split('.')[0] !== '2')
        throw new Error('Not a glTF 2.0 file.');

    const unsupported = (doc.extensionsRequired ?? []).filter((e) => e !== 'KHR_mesh_quantization' && e !== 'KHR_texture_transform');

    if (unsupported.length)
        throw new Error(
            `The file needs ${unsupported.join(', ')}${unsupported.includes('KHR_draco_mesh_compression') ? ' (Draco compression: export again with Compression off)' : ''}, which is not supported.`
        );

    const buffers = (doc.buffers ?? []).map((b, i) =>
    {
        if (b.uri === undefined)
        {
            if (i !== 0 || !glbBin)
                throw new Error('A glTF buffer has no data.');

            return glbBin;
        }

        return external(dir, b.uri);
    });
    return { doc, buffers, dir };
}

function viewBytes(f: GltfFile, index: number): { bytes: Uint8Array; stride?: number; }
{
    const v = f.doc.bufferViews?.[index];

    if (!v)
        throw new Error(`glTF bufferView ${index} is missing.`);

    const b = f.buffers[v.buffer];
    return { bytes: b.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength), stride: v.byteStride };
}

function readComponent(dv: DataView, off: number, type: number): number
{
    switch (type)
    {
        case 5120:
            return dv.getInt8(off);
        case 5121:
            return dv.getUint8(off);
        case 5122:
            return dv.getInt16(off, true);
        case 5123:
            return dv.getUint16(off, true);
        case 5125:
            return dv.getUint32(off, true);
        case 5126:
            return dv.getFloat32(off, true);
    }

    throw new Error(`Unknown glTF component type ${type}.`);
}

/** value of a normalized integer component */
function denormalize(v: number, type: number): number
{
    switch (type)
    {
        case 5120:
            return Math.max(v / 127, -1);
        case 5121:
            return v / 255;
        case 5122:
            return Math.max(v / 32767, -1);
        case 5123:
            return v / 65535;
    }

    return v;
}

/**
 * An accessor's values as numbers (normalized integers converted to floats), `size` components per element;
 * sparse substitutions applied.
 */
export function readAccessor(f: GltfFile, index: number): { values: Float64Array; size: number; count: number; }
{
    const acc = f.doc.accessors?.[index];

    if (!acc)
        throw new Error(`glTF accessor ${index} is missing.`);

    const size = COMPONENTS[acc.type];
    const bytes = BYTES[acc.componentType];

    if (!size || !bytes)
        throw new Error(`Unsupported glTF accessor type ${acc.type}/${acc.componentType}.`);

    const out = new Float64Array(acc.count * size);

    if (acc.bufferView !== undefined)
    {
        const { bytes: data, stride } = viewBytes(f, acc.bufferView);
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const step = stride || size * bytes;
        const base = acc.byteOffset ?? 0;

        for (let i = 0; i < acc.count; i++)
        {
            for (let k = 0; k < size; k++)
            {
                const v = readComponent(dv, base + i * step + k * bytes, acc.componentType);
                out[i * size + k] = acc.normalized ? denormalize(v, acc.componentType) : v;
            }
        }
    }

    if (acc.sparse)
    {
        const s = acc.sparse;
        const iv = viewBytes(f, s.indices.bufferView).bytes;
        const vv = viewBytes(f, s.values.bufferView).bytes;
        const idv = new DataView(iv.buffer, iv.byteOffset, iv.byteLength);
        const vdv = new DataView(vv.buffer, vv.byteOffset, vv.byteLength);
        const ib = BYTES[s.indices.componentType];

        for (let j = 0; j < s.count; j++)
        {
            const at = readComponent(idv, (s.indices.byteOffset ?? 0) + j * ib, s.indices.componentType);

            for (let k = 0; k < size; k++)
            {
                const v = readComponent(vdv, (s.values.byteOffset ?? 0) + (j * size + k) * bytes, acc.componentType);
                out[at * size + k] = acc.normalized ? denormalize(v, acc.componentType) : v;
            }
        }
    }

    return { values: out, size, count: acc.count };
}

/** An image's bytes (embedded in a buffer, a data URI or a file next to the glTF) and its type. */
export function imageBytes(f: GltfFile, index: number): { bytes: Uint8Array; mime: string; name?: string; uri?: string; }
{
    const img = f.doc.images?.[index];

    if (!img)
        throw new Error(`glTF image ${index} is missing.`);

    const bytes = img.bufferView !== undefined ? viewBytes(f, img.bufferView).bytes : external(f.dir, img.uri ?? '');
    const mime = img.mimeType ?? (/\.jpe?g$/i.test(img.uri ?? '') ? 'image/jpeg' : /\.webp$/i.test(img.uri ?? '') ? 'image/webp' : 'image/png');
    return { bytes, mime, name: img.name, uri: img.uri && !img.uri.startsWith('data:') ? img.uri : undefined };
}

/** The image a texture reference shows (also through EXT_texture_webp and the like). */
export function textureImage(f: GltfFile, info: GltfTextureInfo | undefined): number | undefined
{
    if (!info)
        return undefined;

    const t = f.doc.textures?.[info.index];

    if (!t)
        return undefined;

    if (t.source !== undefined)
        return t.source;

    for (const ext of Object.values(t.extensions ?? {}))
        if (ext?.source !== undefined)
            return ext.source;

    return undefined;
}

// ---------------------------------------------------------------------------
// Node transforms (column-major 4x4, like glTF)
// ---------------------------------------------------------------------------

export function nodeMatrix(n: GltfNode): number[]
{
    if (n.matrix)
        return n.matrix.slice();

    const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = n.scale ?? [1, 1, 1];
    const [tx, ty, tz] = n.translation ?? [0, 0, 0];
    return [
        (1 - 2 * (y * y + z * z)) * sx,
        2 * (x * y + z * w) * sx,
        2 * (x * z - y * w) * sx,
        0,
        2 * (x * y - z * w) * sy,
        (1 - 2 * (x * x + z * z)) * sy,
        2 * (y * z + x * w) * sy,
        0,
        2 * (x * z + y * w) * sz,
        2 * (y * z - x * w) * sz,
        (1 - 2 * (x * x + y * y)) * sz,
        0,
        tx,
        ty,
        tz,
        1
    ];
}

/** World matrices of all nodes (scene roots and everything below them). */
export function worldMatrices(doc: GltfDoc, mul: (a: number[], b: number[]) => number[]): { world: (number[] | undefined)[]; parent: number[]; }
{
    const nodes = doc.nodes ?? [];
    const parent = new Array(nodes.length).fill(-1);
    nodes.forEach((n, i) => n.children?.forEach((c) => (parent[c] = i)));
    const world: (number[] | undefined)[] = new Array(nodes.length);
    const visit = (i: number, m: number[], depth: number): void =>
    {
        if (depth > 512 || world[i])
            return;

        world[i] = mul(m, nodeMatrix(nodes[i]));

        for (const c of nodes[i].children ?? [])
            visit(c, world[i]!, depth + 1);
    };
    const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    nodes.forEach((_, i) => parent[i] < 0 && visit(i, I, 0));
    return { world, parent };
}
