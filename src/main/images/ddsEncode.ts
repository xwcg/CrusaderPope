/**
 * DDS encoder for textures written into a mod (docs/blender.md): BC1 (DXT1) and BC3 (DXT5) with a mip chain, and
 * uncompressed 32-bit BGRA as the fallback for formats not encoded here (BC7, BC2, BC4/5 …). Block compression is a
 * range fit along the colours' principal axis with one least-squares refinement (after stb_dxt).
 */
import type { DdsInfo } from './dds.ts';

export interface RgbaImage
{
    width: number;
    height: number;
    rgba: Uint8Array;
}

export interface DdsTarget
{
    format: 'BC1' | 'BC3' | 'BGRA8';
    /** full mip chain down to 1×1 */
    mips: boolean;
    /** BGRA8 only: DX10 header with B8G8R8A8_UNORM_SRGB (the original was an sRGB format) */
    srgb?: boolean;
    /** BC1 only: pixels with alpha < 128 become transparent (1-bit alpha); else BC1 is opaque */
    alpha?: boolean;
}

/** DXGI formats with the _SRGB suffix */
const SRGB_DXGI = new Set([29, 72, 75, 78, 91, 93, 99]);

/**
 * What a texture replacing `original` is written as: its own format where encodable, else BGRA8. `pixels`: the
 * original decoded — a BC1 keeps 1-bit alpha only when the original had transparent pixels.
 */
export function ddsTargetFor(original: DdsInfo | undefined, buf?: Uint8Array, pixels?: RgbaImage): DdsTarget
{
    const mips = (original?.mips ?? 2) > 1;
    const dxgi = buf && buf.length >= 132 && buf[84] === 0x44 && buf[85] === 0x58 && buf[86] === 0x31 && buf[87] === 0x30 ? new DataView(buf.buffer, buf.byteOffset).getUint32(128, true) : 0;
    const srgb = SRGB_DXGI.has(dxgi);

    if (original?.format === 'BC1' && !srgb)
    {
        let alpha = false;

        for (let i = 3; pixels && i < pixels.rgba.length && !alpha; i += 4)
            alpha = pixels.rgba[i] < 128;

        return { format: 'BC1', mips, alpha };
    }

    if (original?.format === 'BC3' && !srgb)
        return { format: 'BC3', mips };

    return { format: 'BGRA8', mips, srgb };
}

/** Box-filtered half-size image (odd sizes: the last row/column repeats). */
export function halfSize(img: RgbaImage): RgbaImage
{
    const w = Math.max(1, img.width >> 1);
    const h = Math.max(1, img.height >> 1);
    const out = new Uint8Array(w * h * 4);
    const src = img.rgba;
    const sw = img.width;

    for (let y = 0; y < h; y++)
    {
        const y0 = Math.min(img.height - 1, y * 2);
        const y1 = Math.min(img.height - 1, y * 2 + 1);

        for (let x = 0; x < w; x++)
        {
            const x0 = Math.min(sw - 1, x * 2);
            const x1 = Math.min(sw - 1, x * 2 + 1);
            const a = (y0 * sw + x0) * 4;
            const b = (y0 * sw + x1) * 4;
            const c = (y1 * sw + x0) * 4;
            const d = (y1 * sw + x1) * 4;
            const o = (y * w + x) * 4;

            for (let k = 0; k < 4; k++)
                out[o + k] = (src[a + k] + src[b + k] + src[c + k] + src[d + k] + 2) >> 2;
        }
    }

    return { width: w, height: h, rgba: out };
}

export function encodeDds(img: RgbaImage, target: DdsTarget): Uint8Array
{
    const levels: RgbaImage[] = [img];

    if (target.mips)
    {
        while (levels[levels.length - 1].width > 1 || levels[levels.length - 1].height > 1)
            levels.push(halfSize(levels[levels.length - 1]));
    }

    const bodies = levels.map((l) => (target.format === 'BGRA8' ? toBgra(l) : encodeBlocks(l, target.format, !!target.alpha)));
    const dx10 = target.format === 'BGRA8' && !!target.srgb;
    const header = ddsHeader(img.width, img.height, levels.length, target, dx10);
    const size = header.length + bodies.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(size);
    out.set(header, 0);
    let pos = header.length;

    for (const b of bodies)
    {
        out.set(b, pos);
        pos += b.length;
    }

    return out;
}

function ddsHeader(width: number, height: number, mips: number, target: DdsTarget, dx10: boolean): Uint8Array
{
    const b = new Uint8Array(128 + (dx10 ? 20 : 0));
    const dv = new DataView(b.buffer);
    const u32 = (off: number, v: number): void => dv.setUint32(off, v >>> 0, true);
    const compressed = target.format !== 'BGRA8';
    u32(0, 0x20534444); // 'DDS '
    u32(4, 124);
    // CAPS | HEIGHT | WIDTH | PIXELFORMAT, + MIPMAPCOUNT, + LINEARSIZE or PITCH
    u32(8, 0x1 | 0x2 | 0x4 | 0x1000 | (mips > 1 ? 0x20000 : 0) | (compressed ? 0x80000 : 0x8));
    u32(12, height);
    u32(16, width);
    u32(20, compressed ? Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * (target.format === 'BC1' ? 8 : 16) : width * 4);
    u32(28, mips);
    // pixel format
    u32(76, 32);

    if (dx10)
    {
        u32(80, 0x4);
        u32(84, 0x30315844); // 'DX10'
    }
    else if (compressed)
    {
        u32(80, 0x4);
        u32(84, target.format === 'BC1' ? 0x31545844 : 0x35545844); // 'DXT1' / 'DXT5'
    }
    else
    {
        u32(80, 0x40 | 0x1); // RGB | ALPHAPIXELS
        u32(88, 32);
        u32(92, 0x00ff0000);
        u32(96, 0x0000ff00);
        u32(100, 0x000000ff);
        u32(104, 0xff000000);
    }

    // TEXTURE, + COMPLEX | MIPMAP
    u32(108, 0x1000 | (mips > 1 ? 0x8 | 0x400000 : 0));

    if (dx10)
    {
        u32(128, 91); // DXGI_FORMAT_B8G8R8A8_UNORM_SRGB
        u32(132, 3); // TEXTURE2D
        u32(136, 0);
        u32(140, 1);
        u32(144, 0);
    }

    return b;
}

function toBgra(img: RgbaImage): Uint8Array
{
    const out = new Uint8Array(img.width * img.height * 4);
    const s = img.rgba;

    for (let i = 0; i < out.length; i += 4)
    {
        out[i] = s[i + 2];
        out[i + 1] = s[i + 1];
        out[i + 2] = s[i];
        out[i + 3] = s[i + 3];
    }

    return out;
}

// ---------------------------------------------------------------------------
// BC1 / BC3 blocks
// ---------------------------------------------------------------------------

function encodeBlocks(img: RgbaImage, format: 'BC1' | 'BC3', punchThrough: boolean): Uint8Array
{
    const bw = Math.max(1, Math.ceil(img.width / 4));
    const bh = Math.max(1, Math.ceil(img.height / 4));
    const blockBytes = format === 'BC1' ? 8 : 16;
    const out = new Uint8Array(bw * bh * blockBytes);
    const block = new Uint8Array(64);
    const { width, height, rgba } = img;
    let off = 0;

    for (let by = 0; by < bh; by++)
    {
        for (let bx = 0; bx < bw; bx++)
        {
            // pixels outside the image repeat the edge
            for (let py = 0; py < 4; py++)
            {
                const y = Math.min(height - 1, by * 4 + py);

                for (let px = 0; px < 4; px++)
                {
                    const x = Math.min(width - 1, bx * 4 + px);
                    const s = (y * width + x) * 4;
                    const d = (py * 4 + px) * 4;
                    block[d] = rgba[s];
                    block[d + 1] = rgba[s + 1];
                    block[d + 2] = rgba[s + 2];
                    block[d + 3] = rgba[s + 3];
                }
            }

            if (format === 'BC3')
            {
                alphaBlock(block, out, off);
                colorBlock(block, out, off + 8, false);
            }
            else
                colorBlock(block, out, off, punchThrough);

            off += blockBytes;
        }
    }

    return out;
}

const to565 = (r: number, g: number, b: number): number => (Math.max(0, Math.min(31, Math.round((r * 31) / 255))) << 11) | (Math.max(0, Math.min(63, Math.round((g * 63) / 255))) << 5) | Math.max(0, Math.min(31, Math.round((b * 31) / 255)));

const from565 = (c: number, out: Float64Array, o: number): void =>
{
    out[o] = (((c >> 11) & 31) * 255) / 31;
    out[o + 1] = (((c >> 5) & 63) * 255) / 63;
    out[o + 2] = ((c & 31) * 255) / 31;
};

const pal = new Float64Array(12);
const idx = new Uint8Array(16);

/** Palette indices for endpoints c0/c1 (4-colour mode, or 3 colours + transparent for BC1 punch-through). */
function matchIndices(block: Uint8Array, c0: number, c1: number, three: boolean, transparent: boolean[] | null): number
{
    from565(c0, pal, 0);
    from565(c1, pal, 3);

    if (three)
    {
        for (let k = 0; k < 3; k++)
            pal[6 + k] = (pal[k] + pal[3 + k]) / 2;
    }
    else
    {
        for (let k = 0; k < 3; k++)
        {
            pal[6 + k] = (2 * pal[k] + pal[3 + k]) / 3;
            pal[9 + k] = (pal[k] + 2 * pal[3 + k]) / 3;
        }
    }

    let err = 0;

    for (let i = 0; i < 16; i++)
    {
        if (transparent?.[i])
        {
            idx[i] = 3;
            continue;
        }

        const r = block[i * 4];
        const g = block[i * 4 + 1];
        const b = block[i * 4 + 2];
        let best = 0;
        let bestD = Infinity;

        for (let p = 0; p < (three ? 3 : 4); p++)
        {
            const dr = r - pal[p * 3];
            const dg = g - pal[p * 3 + 1];
            const db = b - pal[p * 3 + 2];
            const d = dr * dr + dg * dg + db * db;

            if (d < bestD)
            {
                bestD = d;
                best = p;
            }
        }

        idx[i] = best;
        err += bestD;
    }

    return err;
}

/** weights of endpoint 0 per 4-colour index (index 0 = c0, 1 = c1, 2 = 2/3 c0, 3 = 1/3 c0) */
const W0 = [1, 0, 2 / 3, 1 / 3];

function colorBlock(block: Uint8Array, out: Uint8Array, off: number, punchThrough: boolean): void
{
    // BC1 punch-through: pixels with alpha < 128 become transparent (3-colour mode)
    let transparent: boolean[] | null = null;

    if (punchThrough)
    {
        for (let i = 0; i < 16; i++)
            if (block[i * 4 + 3] < 128)
                (transparent ??= new Array(16).fill(false))[i] = true;
    }

    const use = (i: number): boolean => !transparent?.[i];
    // mean and covariance of the used colours
    let n = 0;
    const mean = [0, 0, 0];

    for (let i = 0; i < 16; i++)
    {
        if (!use(i))
            continue;

        n++;
        mean[0] += block[i * 4];
        mean[1] += block[i * 4 + 1];
        mean[2] += block[i * 4 + 2];
    }

    let c0 = 0;
    let c1 = 0;

    if (n === 0)
    {
        // fully transparent block
        writeColor(out, off, 0, 0xffff, new Uint8Array(16).fill(3));
        return;
    }

    mean[0] /= n;
    mean[1] /= n;
    mean[2] /= n;
    const cov = [0, 0, 0, 0, 0, 0];

    for (let i = 0; i < 16; i++)
    {
        if (!use(i))
            continue;

        const r = block[i * 4] - mean[0];
        const g = block[i * 4 + 1] - mean[1];
        const b = block[i * 4 + 2] - mean[2];
        cov[0] += r * r;
        cov[1] += r * g;
        cov[2] += r * b;
        cov[3] += g * g;
        cov[4] += g * b;
        cov[5] += b * b;
    }

    // principal axis by power iteration
    let v = [0.9, 1, 0.7];

    for (let it = 0; it < 8; it++)
    {
        const x = cov[0] * v[0] + cov[1] * v[1] + cov[2] * v[2];
        const y = cov[1] * v[0] + cov[3] * v[1] + cov[4] * v[2];
        const z = cov[2] * v[0] + cov[4] * v[1] + cov[5] * v[2];
        const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));

        if (m < 1e-9)
            break;

        v = [x / m, y / m, z / m];
    }

    let minD = Infinity;
    let maxD = -Infinity;
    let minI = 0;
    let maxI = 0;

    for (let i = 0; i < 16; i++)
    {
        if (!use(i))
            continue;

        const d = block[i * 4] * v[0] + block[i * 4 + 1] * v[1] + block[i * 4 + 2] * v[2];

        if (d < minD)
        {
            minD = d;
            minI = i;
        }

        if (d > maxD)
        {
            maxD = d;
            maxI = i;
        }
    }

    c0 = to565(block[maxI * 4], block[maxI * 4 + 1], block[maxI * 4 + 2]);
    c1 = to565(block[minI * 4], block[minI * 4 + 1], block[minI * 4 + 2]);
    const three = !!transparent;
    const order = (a: number, b: number): [number, number] => (three ? (a <= b ? [a, b] : [b, a]) : a >= b ? [a, b] : [b, a]);
    [c0, c1] = order(c0, c1);
    let err = matchIndices(block, c0, c1, three, transparent);
    let bestIdx = idx.slice();

    // one least-squares refinement of the endpoints for the chosen indices (4-colour mode)
    if (!three && c0 !== c1)
    {
        let aa = 0;
        let bb = 0;
        let ab = 0;
        const ax = [0, 0, 0];
        const bx = [0, 0, 0];

        for (let i = 0; i < 16; i++)
        {
            const a = W0[idx[i]];
            const b = 1 - a;
            aa += a * a;
            bb += b * b;
            ab += a * b;

            for (let k = 0; k < 3; k++)
            {
                ax[k] += a * block[i * 4 + k];
                bx[k] += b * block[i * 4 + k];
            }
        }

        const det = aa * bb - ab * ab;

        if (Math.abs(det) > 1e-9)
        {
            const e0 = [0, 1, 2].map((k) => (ax[k] * bb - bx[k] * ab) / det);
            const e1 = [0, 1, 2].map((k) => (bx[k] * aa - ax[k] * ab) / det);
            const [r0, r1] = order(to565(e0[0], e0[1], e0[2]), to565(e1[0], e1[1], e1[2]));

            if (r0 !== r1)
            {
                const err2 = matchIndices(block, r0, r1, false, null);

                if (err2 < err)
                {
                    err = err2;
                    c0 = r0;
                    c1 = r1;
                    bestIdx = idx.slice();
                }
            }
        }
    }

    if (c0 === c1 && !three)
    {
        // one colour: all index 0 (c0 > c1 is not needed then — both decode as 4-colour equal endpoints)
        bestIdx.fill(0);
    }

    writeColor(out, off, c0, c1, bestIdx);
}

function writeColor(out: Uint8Array, off: number, c0: number, c1: number, indices: Uint8Array): void
{
    out[off] = c0 & 0xff;
    out[off + 1] = c0 >> 8;
    out[off + 2] = c1 & 0xff;
    out[off + 3] = c1 >> 8;
    let bits = 0;

    for (let i = 15; i >= 0; i--)
        bits = (bits * 4 + indices[i]) >>> 0;

    out[off + 4] = bits & 0xff;
    out[off + 5] = (bits >>> 8) & 0xff;
    out[off + 6] = (bits >>> 16) & 0xff;
    out[off + 7] = (bits >>> 24) & 0xff;
}

/** BC3 alpha: the 8-value mode between the block's min and max alpha. */
function alphaBlock(block: Uint8Array, out: Uint8Array, off: number): void
{
    let lo = 255;
    let hi = 0;

    for (let i = 0; i < 16; i++)
    {
        const a = block[i * 4 + 3];

        if (a < lo)
            lo = a;

        if (a > hi)
            hi = a;
    }

    out[off] = hi;
    out[off + 1] = lo;
    const values = [hi, lo];

    for (let i = 1; i < 7; i++)
        values.push(((7 - i) * hi + i * lo) / 7);

    // 48 bits of 3-bit indices, little endian: two 24-bit halves
    let half = 0;
    let shift = 0;

    for (let i = 0; i < 16; i++)
    {
        const a = block[i * 4 + 3];
        let best = 0;

        if (hi !== lo)
        {
            let bestD = Infinity;

            for (let p = 0; p < 8; p++)
            {
                const d = Math.abs(a - values[p]);

                if (d < bestD)
                {
                    bestD = d;
                    best = p;
                }
            }
        }

        half |= best << shift;
        shift += 3;

        if (i === 7 || i === 15)
        {
            const o = off + 2 + (i === 7 ? 0 : 3);
            out[o] = half & 0xff;
            out[o + 1] = (half >> 8) & 0xff;
            out[o + 2] = (half >> 16) & 0xff;
            half = 0;
            shift = 0;
        }
    }
}
