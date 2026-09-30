/**
 * PDX `.mesh` / `.anim` data extraction and the bit of 3D math needed to pose a skinned mesh on the CPU.
 * Coordinates stay in the game's space (Y up, left-handed); the renderer converts for three.js.
 */
import { parsePdx, find, type PdxNode } from './pdx.ts';

export interface MeshPart
{
    shape: string;
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    /** second UV set (clothes patterns) */
    uvs2?: Float32Array;
    /** tangent xyz + handedness w per vertex (game shaders build their TBN from it) */
    tangents?: Float32Array;
    indices: Uint32Array;
    /** bone indices / weights, `infs` per vertex */
    skin?: { infs: number; ix: Int32Array; w: Float32Array; };
    material: Record<string, string>;
}

export interface Bone
{
    name: string;
    index: number;
    parent: number;
    /** inverse bind matrix (column-major 4x4) */
    invBind: Float64Array;
}

export interface MeshFile
{
    parts: MeshPart[];
    bones: Bone[];
}

// ---------------------------------------------------------------------------
// 4x4 matrices (column-major, like three.js) and quaternions [x, y, z, w]
// ---------------------------------------------------------------------------

export type M4 = Float64Array;
export type Quat = [number, number, number, number];
export type V3 = [number, number, number];

export function m4(): M4
{
    const m = new Float64Array(16);
    m[0] =
        m[5] =
        m[10] =
        m[15] =
            1;
    return m;
}

export function mul(a: M4, b: M4): M4
{
    const o = new Float64Array(16);

    for (let c = 0; c < 4; c++)
    {
        for (let r = 0; r < 4; r++)
        {
            o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    }

    return o;
}

export function invert(m: M4): M4
{
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;

    if (!det)
        return m4();

    det = 1 / det;
    const o = new Float64Array(16);
    o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return o;
}

export function compose(t: V3, q: Quat, s: V3): M4
{
    const [x, y, z, w] = q;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    const o = new Float64Array(16);
    o[0] = (1 - (yy + zz)) * s[0];
    o[1] = (xy + wz) * s[0];
    o[2] = (xz - wy) * s[0];
    o[4] = (xy - wz) * s[1];
    o[5] = (1 - (xx + zz)) * s[1];
    o[6] = (yz + wx) * s[1];
    o[8] = (xz + wy) * s[2];
    o[9] = (yz - wx) * s[2];
    o[10] = (1 - (xx + yy)) * s[2];
    o[12] = t[0];
    o[13] = t[1];
    o[14] = t[2];
    o[15] = 1;
    return o;
}

export function decompose(m: M4): { t: V3; q: Quat; s: V3; }
{
    let sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    const sz = Math.hypot(m[8], m[9], m[10]);
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);

    if (det < 0)
        sx = -sx;

    const r00 = m[0] / sx;
    const r10 = m[1] / sx;
    const r20 = m[2] / sx;
    const r01 = m[4] / sy;
    const r11 = m[5] / sy;
    const r21 = m[6] / sy;
    const r02 = m[8] / sz;
    const r12 = m[9] / sz;
    const r22 = m[10] / sz;
    const trace = r00 + r11 + r22;
    let q: Quat;

    if (trace > 0)
    {
        const s = 0.5 / Math.sqrt(trace + 1);
        q = [(r21 - r12) * s, (r02 - r20) * s, (r10 - r01) * s, 0.25 / s];
    }
    else if (r00 > r11 && r00 > r22)
    {
        const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
        q = [0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
    }
    else if (r11 > r22)
    {
        const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
        q = [(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s];
    }
    else
    {
        const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
        q = [(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s];
    }

    return { t: [m[12], m[13], m[14]], q, s: [sx, sy, sz] };
}

export function qmul(a: Quat, b: Quat): Quat
{
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [ax * bw + aw * bx + ay * bz - az * by, ay * bw + aw * by + az * bx - ax * bz, az * bw + aw * bz + ax * by - ay * bx, aw * bw - ax * bx - ay * by - az * bz];
}

export function qinv(q: Quat): Quat
{
    const n = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] || 1;
    return [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n];
}

export function qslerp(a: Quat, b: Quat, t: number): Quat
{
    let [bx, by, bz, bw] = b;
    let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;

    if (cos < 0)
    {
        cos = -cos;
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
    }

    let k0 = 1 - t;
    let k1 = t;

    if (cos < 0.9995)
    {
        const theta = Math.acos(cos);
        const sin = Math.sin(theta);
        k0 = Math.sin((1 - t) * theta) / sin;
        k1 = Math.sin(t * theta) / sin;
    }

    const q: Quat = [a[0] * k0 + bx * k1, a[1] * k0 + by * k1, a[2] * k0 + bz * k1, a[3] * k0 + bw * k1];
    const n = Math.hypot(...q) || 1;
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

// ---------------------------------------------------------------------------
// .mesh
// ---------------------------------------------------------------------------

function strProps(node: PdxNode | undefined): Record<string, string>
{
    const out: Record<string, string> = {};

    if (!node)
        return out;

    for (const [k, v] of Object.entries(node.props))
        if (Array.isArray(v) && typeof v[0] === 'string')
            out[k] = v[0];

    return out;
}

export function loadMesh(buf: Uint8Array): MeshFile
{
    const root = parsePdx(buf);
    const object = find(root, 'object');
    const parts: MeshPart[] = [];
    let bones: Bone[] = [];

    for (const shape of object?.children ?? [])
    {
        const skeleton = find(shape, 'skeleton');

        if (skeleton && !bones.length)
        {
            bones = skeleton.children.map((b) =>
            {
                const tx = b.props.tx as Float32Array;
                const m = m4();
                // 12 floats: 3x3 rotation/scale columns followed by translation (see io_pdx_mesh create_skeleton)
                m[0] = tx[0];
                m[1] = tx[1];
                m[2] = tx[2];
                m[4] = tx[3];
                m[5] = tx[4];
                m[6] = tx[5];
                m[8] = tx[6];
                m[9] = tx[7];
                m[10] = tx[8];
                m[12] = tx[9];
                m[13] = tx[10];
                m[14] = tx[11];
                return { name: b.name, index: (b.props.ix as Int32Array)[0], parent: b.props.pa ? (b.props.pa as Int32Array)[0] : -1, invBind: m };
            });
            bones.sort((a, b) => a.index - b.index);
        }

        for (const mesh of shape.children.filter((c) => c.name === 'mesh'))
        {
            const p = mesh.props.p as Float32Array;
            const skinNode = find(mesh, 'skin');
            parts.push({
                shape: shape.name,
                positions: p,
                normals: (mesh.props.n as Float32Array) ?? new Float32Array(p.length),
                uvs: (mesh.props.u0 as Float32Array) ?? new Float32Array((p.length / 3) * 2),
                uvs2: mesh.props.u1 as Float32Array | undefined,
                tangents: mesh.props.ta as Float32Array | undefined,
                indices: Uint32Array.from(mesh.props.tri as Int32Array),
                skin: skinNode
                    ? { infs: (skinNode.props.bones as Int32Array)[0], ix: skinNode.props.ix as Int32Array, w: skinNode.props.w as Float32Array }
                    : undefined,
                material: strProps(find(mesh, 'material'))
            });
        }
    }

    return { parts, bones };
}

// ---------------------------------------------------------------------------
// .anim
// ---------------------------------------------------------------------------

export interface AnimJoint
{
    name: string;
    channels: string;
    t: V3;
    q: Quat;
    s: V3;
    /** per frame samples of the animated channels */
    tS?: V3[];
    qS?: Quat[];
    sS?: V3[];
}

export interface AnimFile
{
    frames: number;
    joints: AnimJoint[];
}

export function loadAnim(buf: Uint8Array): AnimFile
{
    const root = parsePdx(buf);
    const info = find(root, 'info')!;
    const samples = find(root, 'samples');
    const frames = (info.props.sa as Int32Array)[0];
    const joints: AnimJoint[] = info.children.map((j) =>
    {
        const t = j.props.t as Float32Array;
        const q = j.props.q as Float32Array;
        const s = j.props.s as Float32Array;
        return {
            name: j.name.slice(j.name.lastIndexOf(':') + 1),
            channels: ((j.props.sa as string[]) ?? [''])[0] ?? '',
            t: [t[0], t[1], t[2]],
            q: [q[0], q[1], q[2], q[3]],
            s: s.length >= 3 ? [s[0], s[1], s[2]] : [s[0], s[0], s[0]]
        };
    });

    if (samples)
    {
        const T = samples.props.t as Float32Array | undefined;
        const Q = samples.props.q as Float32Array | undefined;
        const S = samples.props.s as Float32Array | undefined;
        let ti = 0;
        let qi = 0;
        let si = 0;
        // scale samples are 1 (uniform) or 3 floats per joint and frame, depending on the file
        const scaled = joints.filter((j) => j.channels.includes('s')).length;
        const sLen = S && scaled ? Math.round(S.length / (frames * scaled)) : 1;

        for (let f = 0; f < frames; f++)
        {
            for (const j of joints)
            {
                if (j.channels.includes('s') && S)
                {
                    (j.sS ??= []).push(sLen >= 3 ? [S[si], S[si + 1], S[si + 2]] : [S[si], S[si], S[si]]);
                    si += sLen;
                }

                if (j.channels.includes('q') && Q)
                {
                    (j.qS ??= []).push([Q[qi], Q[qi + 1], Q[qi + 2], Q[qi + 3]]);
                    qi += 4;
                }

                if (j.channels.includes('t') && T)
                {
                    (j.tS ??= []).push([T[ti], T[ti + 1], T[ti + 2]]);
                    ti += 3;
                }
            }
        }
    }

    return { frames, joints };
}

/** Transform of an animated joint at normalized time `u` (0..1 over all frames). */
export function sampleJoint(j: AnimJoint, frames: number, u: number): { t: V3; q: Quat; s: V3; }
{
    const f = Math.max(0, Math.min(frames - 1, u * (frames - 1)));
    const i0 = Math.floor(f);
    const i1 = Math.min(frames - 1, i0 + 1);
    const k = f - i0;
    const lerp3 = (a: V3, b: V3): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    return {
        t: j.tS ? lerp3(j.tS[i0], j.tS[i1]) : j.t,
        q: j.qS ? qslerp(j.qS[i0], j.qS[i1], k) : j.q,
        s: j.sS ? lerp3(j.sS[i0], j.sS[i1]) : j.s
    };
}
