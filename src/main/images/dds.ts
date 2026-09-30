/**
 * DDS texture decoder → RGBA8.
 *
 * Formats seen in CK3's gfx/ (see docs/images.md): uncompressed BGRA/BGR/RGBA with bit masks, DXT1/3/5 (BC1–3),
 * BC4/BC5, and DX10 headers with BC7, BGRA8/RGBA8. BC1–BC5 are decoded here; BC6H/BC7 use the texture2ddecoder
 * WebAssembly module (loaded lazily, only when such a texture is requested).
 */

export interface DdsInfo
{
    width: number;
    height: number;
    mips: number;
    format: string;
    isCube: boolean;
    /** Offset of mip 0 in the file. */
    dataOffset: number;
    /** Bytes per 4x4 block for block-compressed formats, 0 otherwise. */
    blockBytes: number;
    /** Bits per pixel for uncompressed formats. */
    bpp: number;
    masks: [number, number, number, number];
}

const DXGI: Record<number, string> = {
    2: 'RGBA32F',
    10: 'RGBA16F',
    24: 'RGB10A2',
    28: 'RGBA8',
    29: 'RGBA8',
    61: 'R8',
    70: 'BC1',
    71: 'BC1',
    72: 'BC1',
    73: 'BC2',
    74: 'BC2',
    75: 'BC2',
    76: 'BC3',
    77: 'BC3',
    78: 'BC3',
    79: 'BC4',
    80: 'BC4',
    81: 'BC4S',
    82: 'BC5',
    83: 'BC5',
    84: 'BC5S',
    87: 'BGRA8',
    88: 'BGRX8',
    90: 'BGRA8',
    91: 'BGRA8',
    92: 'BGRX8',
    93: 'BGRX8',
    94: 'BC6H',
    95: 'BC6H',
    96: 'BC6H',
    97: 'BC7',
    98: 'BC7',
    99: 'BC7'
};

const BLOCK_BYTES: Record<string, number> = { BC1: 8, BC2: 16, BC3: 16, BC4: 8, BC4S: 8, BC5: 16, BC5S: 16, BC6H: 16, BC7: 16 };

export function parseDds(buf: Uint8Array): DdsInfo
{
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    if (buf.length < 128 || dv.getUint32(0, true) !== 0x20534444)
        throw new Error('Not a DDS file');

    const height = dv.getUint32(12, true);
    const width = dv.getUint32(16, true);
    const mips = Math.max(1, dv.getUint32(28, true));
    const pfFlags = dv.getUint32(80, true);
    const fourCC = String.fromCharCode(buf[84], buf[85], buf[86], buf[87]);
    const bpp = dv.getUint32(88, true);
    const masks: [number, number, number, number] = [dv.getUint32(92, true), dv.getUint32(96, true), dv.getUint32(100, true), dv.getUint32(104, true)];
    const isCube = (dv.getUint32(112, true) & 0x200) !== 0;
    let format = '';
    let dataOffset = 128;

    if (pfFlags & 4)
    {
        if (fourCC === 'DX10')
        {
            const dxgi = dv.getUint32(128, true);
            format = DXGI[dxgi] ?? 'DXGI_' + dxgi;
            dataOffset = 148;
        }
        else
        {
            format = { DXT1: 'BC1', DXT2: 'BC2', DXT3: 'BC2', DXT4: 'BC3', DXT5: 'BC3', ATI1: 'BC4', BC4U: 'BC4', BC4S: 'BC4S', ATI2: 'BC5', BC5U: 'BC5', BC5S: 'BC5S' }[fourCC] ??
                'FOURCC_' + fourCC.replace(/\0/g, '');
        }
    }
    else if (pfFlags & 0x40 || pfFlags & 0x20000 || pfFlags & 2)
    {
        format = 'MASKED';

        if (!(pfFlags & 1) && !(pfFlags & 2))
            masks[3] = 0; // no alpha
    }

    return { width, height, mips, format, isCube, dataOffset, blockBytes: BLOCK_BYTES[format] ?? 0, bpp, masks };
}

/** Human readable format name (for the UI). */
export function formatLabel(info: DdsInfo): string
{
    if (info.format === 'MASKED')
        return info.masks[3] ? `${info.bpp}-bit RGBA` : `${info.bpp}-bit RGB`;

    const legacy: Record<string, string> = { BC1: 'BC1 (DXT1)', BC2: 'BC2 (DXT3)', BC3: 'BC3 (DXT5)' };
    return legacy[info.format] ?? info.format;
}

function levelSize(info: DdsInfo, w: number, h: number): number
{
    if (info.blockBytes)
        return Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * info.blockBytes;

    const bpp = info.format === 'MASKED' ? info.bpp : info.format === 'R8' ? 8 : info.format === 'RGBA16F' ? 64 : info.format === 'RGBA32F' ? 128 : 32;
    return Math.ceil((w * bpp) / 8) * h;
}

export interface Decoded
{
    width: number;
    height: number;
    rgba: Uint8Array;
}

/**
 * Decodes the mip level best matching `maxSize` (the smallest level whose longer side is ≥ maxSize;
 * mip 0 when maxSize is 0).
 */
/** `face` picks a cubemap face (+X, −X, +Y, −Y, +Z, −Z order, each with its own mip chain). */
export async function decodeDds(buf: Uint8Array, maxSize = 0, face = 0): Promise<Decoded>
{
    const { info, data, w, h } = selectLevel(buf, maxSize, face);

    if (info.format === 'BC6H' || info.format === 'BC7')
        return { width: w, height: h, rgba: bgraToRgba(await wasmDecode(info.format, data, w, h)) };

    return { width: w, height: h, rgba: decodeLevelSync(info, data, w, h) };
}

/** Synchronous decode for every format except BC6H/BC7 (those need the WebAssembly decoder). */
export function decodeDdsSync(buf: Uint8Array, maxSize = 0, face = 0): Decoded
{
    const { info, data, w, h } = selectLevel(buf, maxSize, face);
    return { width: w, height: h, rgba: decodeLevelSync(info, data, w, h) };
}

function selectLevel(buf: Uint8Array, maxSize: number, face = 0): { info: DdsInfo; data: Uint8Array; w: number; h: number; }
{
    const info = parseDds(buf);
    let level = 0;
    let w = info.width;
    let h = info.height;
    let offset = info.dataOffset;

    if (info.isCube && face > 0)
    {
        // faces are stored one after another, each with all its mips
        let faceSize = 0;

        for (let i = 0, fw = w, fh = h; i < Math.max(1, info.mips); i++, fw = Math.max(1, fw >> 1), fh = Math.max(1, fh >> 1))
            faceSize += levelSize(info, fw, fh);

        offset += Math.min(5, face) * faceSize;
    }

    if (maxSize > 0)
    {
        while (level + 1 < info.mips)
        {
            const nw = Math.max(1, w >> 1);
            const nh = Math.max(1, h >> 1);

            if (Math.max(nw, nh) < maxSize)
                break;

            offset += levelSize(info, w, h);
            w = nw;
            h = nh;
            level++;
        }
    }

    const size = levelSize(info, w, h);

    if (offset + size > buf.length)
        throw new Error(`Truncated DDS (${info.format} ${w}x${h})`);

    return { info, data: buf.subarray(offset, offset + size), w, h };
}

function decodeLevelSync(info: DdsInfo, data: Uint8Array, w: number, h: number): Uint8Array
{
    switch (info.format)
    {
        case 'BC1':
            return decodeBlocks(data, w, h, 8, decodeBc1Block);
        case 'BC2':
            return decodeBlocks(data, w, h, 16, decodeBc2Block);
        case 'BC3':
            return decodeBlocks(data, w, h, 16, decodeBc3Block);
        case 'BC4':
        case 'BC4S':
            return decodeBlocks(data, w, h, 8, decodeBc4Block);
        case 'BC5':
        case 'BC5S':
            return decodeBlocks(data, w, h, 16, decodeBc5Block);
        case 'RGBA8':
            return data.slice(0, w * h * 4);
        case 'BGRA8':
        case 'BGRX8':
        {
            const out = bgraToRgba(data.slice(0, w * h * 4));

            if (info.format === 'BGRX8')
            {
                for (let i = 3; i < out.length; i += 4)
                    out[i] = 255;
            }

            return out;
        }
        case 'R8':
        {
            const out = new Uint8Array(w * h * 4);

            for (let i = 0; i < w * h; i++)
            {
                out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i];
                out[i * 4 + 3] = 255;
            }

            return out;
        }
        case 'MASKED':
            return decodeMasked(data, w, h, info.bpp, info.masks);
        default:
            throw new Error('Unsupported DDS format ' + info.format);
    }
}

function bgraToRgba(b: Uint8Array): Uint8Array
{
    for (let i = 0; i < b.length; i += 4)
    {
        const t = b[i];
        b[i] = b[i + 2];
        b[i + 2] = t;
    }

    return b;
}

// ---------------------------------------------------------------------------
// Uncompressed with channel masks
// ---------------------------------------------------------------------------

function maskInfo(mask: number): { shift: number; bits: number; }
{
    if (!mask)
        return { shift: 0, bits: 0 };

    let shift = 0;

    while (((mask >>> shift) & 1) === 0)
        shift++;

    let bits = 0;

    while (((mask >>> (shift + bits)) & 1) === 1)
        bits++;

    return { shift, bits };
}

function decodeMasked(data: Uint8Array, w: number, h: number, bpp: number, masks: [number, number, number, number]): Uint8Array
{
    const out = new Uint8Array(w * h * 4);
    const bytes = bpp / 8;
    const m = masks.map(maskInfo);
    const lum = masks[1] === 0 && masks[2] === 0 && masks[0] !== 0; // luminance (+alpha)

    // fast path: standard BGRA8
    if (bpp === 32 && masks[0] === 0xff0000 && masks[1] === 0xff00 && masks[2] === 0xff)
    {
        for (let i = 0; i < w * h; i++)
        {
            out[i * 4] = data[i * 4 + 2];
            out[i * 4 + 1] = data[i * 4 + 1];
            out[i * 4 + 2] = data[i * 4];
            out[i * 4 + 3] = masks[3] ? data[i * 4 + 3] : 255;
        }

        return out;
    }

    const pitch = Math.ceil((w * bpp) / 8);

    for (let y = 0; y < h; y++)
    {
        for (let x = 0; x < w; x++)
        {
            const p = y * pitch + x * bytes;
            let v = 0;

            for (let b = bytes - 1; b >= 0; b--)
                v = v * 256 + data[p + b];

            const ch = (i: number): number =>
            {
                const { shift, bits } = m[i];

                if (!bits)
                    return i === 3 ? 255 : 0;

                const raw = Math.floor(v / 2 ** shift) % 2 ** bits;
                return bits === 8 ? raw : Math.round((raw * 255) / (2 ** bits - 1));
            };
            const o = (y * w + x) * 4;
            const r = ch(0);
            out[o] = r;
            out[o + 1] = lum ? r : ch(1);
            out[o + 2] = lum ? r : ch(2);
            out[o + 3] = ch(3);
        }
    }

    return out;
}

// ---------------------------------------------------------------------------
// Block compressed (BC1–BC5)
// ---------------------------------------------------------------------------

type BlockDecoder = (data: Uint8Array, off: number, out: Uint8Array) => void;

/** Decodes all 4x4 blocks; each block decoder fills a 64-byte RGBA scratch block. */
function decodeBlocks(data: Uint8Array, w: number, h: number, blockBytes: number, dec: BlockDecoder): Uint8Array
{
    const out = new Uint8Array(w * h * 4);
    const bw = Math.max(1, Math.ceil(w / 4));
    const bh = Math.max(1, Math.ceil(h / 4));
    const block = new Uint8Array(64);
    let off = 0;

    for (let by = 0; by < bh; by++)
    {
        for (let bx = 0; bx < bw; bx++)
        {
            dec(data, off, block);
            off += blockBytes;

            for (let py = 0; py < 4; py++)
            {
                const y = by * 4 + py;

                if (y >= h)
                    break;

                for (let px = 0; px < 4; px++)
                {
                    const x = bx * 4 + px;

                    if (x >= w)
                        break;

                    const s = (py * 4 + px) * 4;
                    const d = (y * w + x) * 4;
                    out[d] = block[s];
                    out[d + 1] = block[s + 1];
                    out[d + 2] = block[s + 2];
                    out[d + 3] = block[s + 3];
                }
            }
        }
    }

    return out;
}

const palette = new Uint8Array(16);

function colorBlock(data: Uint8Array, off: number, out: Uint8Array, forceFour: boolean): void
{
    const c0 = data[off] | (data[off + 1] << 8);
    const c1 = data[off + 2] | (data[off + 3] << 8);
    const r0 = ((c0 >> 11) & 31) * 255 / 31;
    const g0 = ((c0 >> 5) & 63) * 255 / 63;
    const b0 = (c0 & 31) * 255 / 31;
    const r1 = ((c1 >> 11) & 31) * 255 / 31;
    const g1 = ((c1 >> 5) & 63) * 255 / 63;
    const b1 = (c1 & 31) * 255 / 31;
    palette[0] = r0;
    palette[1] = g0;
    palette[2] = b0;
    palette[3] = 255;
    palette[4] = r1;
    palette[5] = g1;
    palette[6] = b1;
    palette[7] = 255;

    if (c0 > c1 || forceFour)
    {
        palette[8] = (2 * r0 + r1) / 3;
        palette[9] = (2 * g0 + g1) / 3;
        palette[10] = (2 * b0 + b1) / 3;
        palette[11] = 255;
        palette[12] = (r0 + 2 * r1) / 3;
        palette[13] = (g0 + 2 * g1) / 3;
        palette[14] = (b0 + 2 * b1) / 3;
        palette[15] = 255;
    }
    else
    {
        palette[8] = (r0 + r1) / 2;
        palette[9] = (g0 + g1) / 2;
        palette[10] = (b0 + b1) / 2;
        palette[11] = 255;
        palette[12] =
            palette[13] =
            palette[14] =
            palette[15] =
                0;
    }

    const idx = (data[off + 4] | (data[off + 5] << 8) | (data[off + 6] << 16) | (data[off + 7] << 24)) >>> 0;

    for (let i = 0; i < 16; i++)
    {
        const p = ((idx >>> (2 * i)) & 3) * 4;
        out[i * 4] = palette[p];
        out[i * 4 + 1] = palette[p + 1];
        out[i * 4 + 2] = palette[p + 2];
        out[i * 4 + 3] = palette[p + 3];
    }
}

const alphaPalette = new Uint8Array(8);

/** BC3-style interpolated single channel block (8 bytes) → 16 values written with stride. */
function channelBlock(data: Uint8Array, off: number, out: Uint8Array, channel: number): void
{
    const a0 = data[off];
    const a1 = data[off + 1];
    alphaPalette[0] = a0;
    alphaPalette[1] = a1;

    if (a0 > a1)
    {
        for (let i = 1; i < 7; i++)
            alphaPalette[i + 1] = ((7 - i) * a0 + i * a1) / 7;
    }
    else
    {
        for (let i = 1; i < 5; i++)
            alphaPalette[i + 1] = ((5 - i) * a0 + i * a1) / 5;

        alphaPalette[6] = 0;
        alphaPalette[7] = 255;
    }

    // 48 bits of 3-bit indices, little endian
    let lo = data[off + 2] | (data[off + 3] << 8) | (data[off + 4] << 16);
    let hi = data[off + 5] | (data[off + 6] << 8) | (data[off + 7] << 16);

    for (let i = 0; i < 8; i++)
    {
        out[i * 4 + channel] = alphaPalette[lo & 7];
        lo >>= 3;
    }

    for (let i = 8; i < 16; i++)
    {
        out[i * 4 + channel] = alphaPalette[hi & 7];
        hi >>= 3;
    }
}

function decodeBc1Block(data: Uint8Array, off: number, out: Uint8Array): void
{
    colorBlock(data, off, out, false);
}

function decodeBc2Block(data: Uint8Array, off: number, out: Uint8Array): void
{
    colorBlock(data, off + 8, out, true);

    for (let i = 0; i < 8; i++)
    {
        const b = data[off + i];
        out[(i * 2) * 4 + 3] = (b & 15) * 17;
        out[(i * 2 + 1) * 4 + 3] = (b >> 4) * 17;
    }
}

function decodeBc3Block(data: Uint8Array, off: number, out: Uint8Array): void
{
    colorBlock(data, off + 8, out, true);
    channelBlock(data, off, out, 3);
}

function decodeBc4Block(data: Uint8Array, off: number, out: Uint8Array): void
{
    channelBlock(data, off, out, 0);

    for (let i = 0; i < 16; i++)
    {
        out[i * 4 + 1] = out[i * 4 + 2] = out[i * 4];
        out[i * 4 + 3] = 255;
    }
}

function decodeBc5Block(data: Uint8Array, off: number, out: Uint8Array): void
{
    channelBlock(data, off, out, 0);
    channelBlock(data, off + 8, out, 1);

    // reconstruct Z of a tangent-space normal so normal maps look like normal maps
    for (let i = 0; i < 16; i++)
    {
        const x = out[i * 4] / 127.5 - 1;
        const y = out[i * 4 + 1] / 127.5 - 1;
        out[i * 4 + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5 + 0.5) * 255);
        out[i * 4 + 3] = 255;
    }
}

// ---------------------------------------------------------------------------
// BC6H / BC7 via WebAssembly
// ---------------------------------------------------------------------------

type WasmModule = typeof import('texture2ddecoder-wasm');
let wasm: Promise<WasmModule> | null = null;

async function wasmDecode(format: string, data: Uint8Array, w: number, h: number): Promise<Uint8Array>
{
    if (!wasm)
        wasm = import('texture2ddecoder-wasm');

    const m = await wasm;
    // the decoder works on whole 4x4 blocks
    const pw = Math.ceil(w / 4) * 4;
    const ph = Math.ceil(h / 4) * 4;
    const out = format === 'BC7' ? await m.decode_bc7(data, pw, ph) : await m.decode_bc6(data, pw, ph);

    if (!out)
        throw new Error('BC decode failed');

    if (pw === w && ph === h)
        return out;

    const cropped = new Uint8Array(w * h * 4);

    for (let y = 0; y < h; y++)
        cropped.set(out.subarray(y * pw * 4, y * pw * 4 + w * 4), y * w * 4);

    return cropped;
}

// ---------------------------------------------------------------------------
// Resizing
// ---------------------------------------------------------------------------

/** Area-average downscale (alpha weighted) so that the longer side is at most `max`. */
export function downscale(img: Decoded, max: number): Decoded
{
    const { width: sw, height: sh, rgba: src } = img;

    if (max <= 0 || Math.max(sw, sh) <= max)
        return img;

    const scale = max / Math.max(sw, sh);
    const dw = Math.max(1, Math.round(sw * scale));
    const dh = Math.max(1, Math.round(sh * scale));
    const out = new Uint8Array(dw * dh * 4);

    for (let dy = 0; dy < dh; dy++)
    {
        const y0 = Math.floor((dy * sh) / dh);
        const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * sh) / dh));

        for (let dx = 0; dx < dw; dx++)
        {
            const x0 = Math.floor((dx * sw) / dw);
            const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * sw) / dw));
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let n = 0;

            for (let y = y0; y < y1; y++)
            {
                for (let x = x0; x < x1; x++)
                {
                    const s = (y * sw + x) * 4;
                    const al = src[s + 3];
                    r += src[s] * al;
                    g += src[s + 1] * al;
                    b += src[s + 2] * al;
                    a += al;
                    n++;
                }
            }

            const d = (dy * dw + dx) * 4;

            if (a > 0)
            {
                out[d] = r / a;
                out[d + 1] = g / a;
                out[d + 2] = b / a;
            }

            out[d + 3] = a / n;
        }
    }

    return { width: dw, height: dh, rgba: out };
}
