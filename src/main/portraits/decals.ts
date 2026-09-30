/**
 * Decals (eyebrows, stubble, complexion, wrinkles, baldness, makeup, scars …) baked into the head and body textures
 * on the CPU — the per-pixel work of jomini/portrait_decals.fxh done once: layers sorted by priority blend in UV space
 * with weight = decal strength × the decal's alpha, before or after the skin colour; normals are overlaid the same
 * way. See docs/portraits.md.
 */
import type { Decoded } from '../images/dds.ts';
import { encodePng } from '../images/png.ts';

export type BlendMode = 'overlay' | 'replace' | 'hard_light' | 'multiply';

export interface DecalLayer
{
    diffuse?: string;
    normal?: string;
    properties?: string;
    modes: { diffuse: BlendMode; normal: BlendMode; properties: BlendMode; };
    /** gene strength through alpha_curve and age preset (0..1) */
    weight: number;
    priority: number;
    /** decal_apply_order = post_skin_color */
    post: boolean;
    /** uv_tiling: the decal repeats, masked by its properties' red channel */
    tiling?: [number, number];
}

export interface Baked
{
    /** PNG data URLs */
    diffuse?: string;
    /** normal packed as x → R, y → G (unlike the game's RRxG layout, so PNG alpha handling can't touch it) */
    normal?: string;
}

type Loader = (rel: string) => Promise<Decoded | undefined>;

/** Normalized bounding box of the texels a decal changes (alpha > 0, or a non-flat normal); cached per image. */
const activeRects = new WeakMap<Decoded, [number, number, number, number]>();
function activeRect(img: Decoded, normal: boolean): [number, number, number, number]
{
    let r = activeRects.get(img);

    if (r)
        return r;

    let x0 = img.width;
    let y0 = img.height;
    let x1 = -1;
    let y1 = -1;

    for (let y = 0; y < img.height; y++)
    {
        for (let x = 0; x < img.width; x++)
        {
            const i = (y * img.width + x) * 4;
            const on = normal ? Math.abs(img.rgba[i + 1] - 128) > 3 || Math.abs(img.rgba[i + 3] - 128) > 3 : img.rgba[i + 3] > 0;

            if (!on)
                continue;

            if (x < x0)
                x0 = x;

            if (x > x1)
                x1 = x;

            if (y < y0)
                y0 = y;

            if (y > y1)
                y1 = y;
        }
    }

    r = x1 < 0 ? [0, 0, 0, 0] : [x0 / img.width, y0 / img.height, (x1 + 1) / img.width, (y1 + 1) / img.height];
    activeRects.set(img, r);
    return r;
}

/**
 * A decal image with no alpha anywhere changes no texel: the bake skips it. AGOT's control decals are such images and
 * carry colour codes in their 16×16 mip that its shaders read through the decal list (PortraitData.dataDecals).
 */
export function transparentDecal(img: Decoded): boolean
{
    const r = activeRect(img, false);
    return r[2] === 0 && r[3] === 0;
}

/**
 * Whether a texture's 16×16 mip is no picture of it: more than 10 of its texels depart from the 32×32 mip's box average
 * (by more than a quarter in some channel) — a mip painted over with values for shaders to read (docs/shaders.md,
 * "Data decals"). Pictures depart at 5 texels at most (sharp details, the mip filter: the game's 272 decal textures and
 * a total conversion's 558); painted mips at 16 or more.
 */
export function dataMip(small: Decoded, large: Decoded): boolean
{
    if (small.width !== 16 || small.height !== 16 || large.width !== 32 || large.height !== 32)
        return false;

    let off = 0;

    for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
            for (let c = 0; c < 4; c++)
            {
                const i = (y * 2 * 32 + x * 2) * 4 + c;
                const avg = (large.rgba[i] + large.rgba[i + 4] + large.rgba[i + 128] + large.rgba[i + 132]) / 4;

                if (Math.abs(avg - small.rgba[(y * 16 + x) * 4 + c]) > 64)
                {
                    off++;
                    break;
                }
            }

    return off > 10;
}

const TO_LINEAR = new Float32Array(256).map((_, i) =>
{
    const c = i / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const TO_SRGB = new Uint8Array(4096).map((_, i) =>
{
    const v = i / 4095;
    return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255);
});
const srgbByte = (v: number): number => TO_SRGB[Math.max(0, Math.min(4095, Math.round(v * 4095)))];

/**
 * Nearest-texel lookup of `img` for a w×h target, optionally tiled: index = (rows[y] + cols[x]) * 4. Precomputed per
 * layer so the per-pixel loop does no float math.
 */
function texelMap(img: Decoded, w: number, h: number, tx = 1, ty = 1): { rows: Int32Array; cols: Int32Array; }
{
    const cols = new Int32Array(w);
    const rows = new Int32Array(h);

    for (let x = 0; x < w; x++)
        cols[x] = Math.min(img.width - 1, Math.floor(((((x + 0.5) / w) * tx) % 1) * img.width));

    for (let y = 0; y < h; y++)
        rows[y] = Math.min(img.height - 1, Math.floor(((((y + 0.5) / h) * ty) % 1) * img.height)) * img.width;

    return { rows, cols };
}

/**
 * Bakes the layers into the base diffuse (and normal) map. `skin` is the raw palette colour applied between the pre-
 * and post-skin-colour layers with the base diffuse alpha as mask (the viewer then must not apply it again).
 */
/** `loadBase` decodes the part's own textures (bake resolution), `loadDecal` the decal textures (may be smaller). */
export async function bakeDecals(
    loadBase: Loader,
    loadDecal: Loader,
    baseDiffuse: string,
    baseNormal: string | undefined,
    layers: DecalLayer[],
    skin: [number, number, number]
): Promise<Baked>
{
    const base = await loadBase(baseDiffuse);

    if (!base || !layers.length)
        return {};

    const { width: w, height: h } = base;
    const n = w * h;
    const rgb = new Float32Array(n * 3);

    for (let i = 0; i < n; i++)
    {
        rgb[i * 3] = TO_LINEAR[base.rgba[i * 4]];
        rgb[i * 3 + 1] = TO_LINEAR[base.rgba[i * 4 + 1]];
        rgb[i * 3 + 2] = TO_LINEAR[base.rgba[i * 4 + 2]];
    }

    const nb = baseNormal ? await loadBase(baseNormal) : undefined;
    const useNormals = !!nb && nb.width === w && nb.height === h && layers.some((l) => l.normal);
    const nx = useNormals ? new Float32Array(n) : null;
    const ny = useNormals ? new Float32Array(n) : null;
    const nz = useNormals ? new Float32Array(n) : null;

    if (nb && nx && ny && nz)
    {
        for (let i = 0; i < n; i++)
        {
            nx[i] = (nb.rgba[i * 4 + 1] / 255) * 2 - 1;
            ny[i] = (nb.rgba[i * 4 + 3] / 255) * 2 - 1;
            nz[i] = Math.sqrt(Math.max(0, 1 - nx[i] * nx[i] - ny[i] * ny[i]));
        }
    }

    const apply = async (layer: DecalLayer): Promise<void> =>
    {
        const [tx, ty] = layer.tiling ?? [1, 1];
        const tiled = tx !== 1 || ty !== 1;
        const dif = layer.diffuse ? await loadDecal(layer.diffuse) : undefined;
        const nrm = layer.normal && nx ? await loadDecal(layer.normal) : undefined;
        const mask = tiled && layer.properties ? await loadDecal(layer.properties) : undefined;

        if (!dif && !nrm)
            return;

        // only the area the decal touches (the diffuse alpha gates everything when there is a diffuse)
        const [rx0, ry0, rx1, ry1] = tiled ? [0, 0, 1, 1] : dif ? activeRect(dif, false) : activeRect(nrm!, true);
        const xs = Math.max(0, Math.floor(rx0 * w));
        const xe = Math.min(w, Math.ceil(rx1 * w));
        const ys = Math.max(0, Math.floor(ry0 * h));
        const ye = Math.min(h, Math.ceil(ry1 * h));
        // hot loop: everything hoisted into locals, the blend mode chosen per layer
        const drgba = dif?.rgba;
        const drows = dif ? texelMap(dif, w, h, tx, ty) : null;
        const nrgba = nrm?.rgba;
        const nmap = nrm ? texelMap(nrm, w, h, tx, ty) : null;
        const mrgba = mask?.rgba;
        const mmap = mask ? texelMap(mask, w, h) : null;
        const mode = layer.modes.diffuse;
        const blendFn: (t: number, b: number) => number = mode === 'multiply'
            ? (t, b) => t * b
            : mode === 'replace'
            ? (_t, b) => b
            : mode === 'hard_light'
            ? (t, b) => (b > 0.5 ? 1 - 2 * (1 - t) * (1 - b) : 2 * t * b)
            : (t, b) => (t > 0.5 ? 1 - 2 * (1 - t) * (1 - b) : 2 * t * b);
        const replaceNormal = layer.modes.normal === 'replace';
        const w0 = layer.weight;

        for (let y = ys; y < ye; y++)
        {
            const drow = drows ? drows.rows[y] : 0;
            const nrow = nmap ? nmap.rows[y] : 0;
            const mrow = mmap ? mmap.rows[y] : 0;

            for (let x = xs; x < xe; x++)
            {
                const p = y * w + x;
                let weight = w0;

                if (mrgba)
                    weight *= mrgba[(mrow + mmap!.cols[x]) * 4] / 255;

                // the diffuse alpha scales the weight for everything the decal does (AddDecals)
                if (drgba)
                {
                    const d = (drow + drows!.cols[x]) * 4;
                    const a = drgba[d + 3];

                    if (a === 0)
                        continue;

                    weight *= a / 255;
                    const q = p * 3;
                    const r = rgb[q];
                    const g = rgb[q + 1];
                    const b = rgb[q + 2];
                    rgb[q] = r + (blendFn(r, TO_LINEAR[drgba[d]]) - r) * weight;
                    rgb[q + 1] = g + (blendFn(g, TO_LINEAR[drgba[d + 1]]) - g) * weight;
                    rgb[q + 2] = b + (blendFn(b, TO_LINEAR[drgba[d + 2]]) - b) * weight;
                }

                if (nrgba && nx && ny && nz && weight > 0)
                {
                    const d = (nrow + nmap!.cols[x]) * 4;
                    let dx = nrgba[d + 1] / 127.5 - 1;
                    let dy = nrgba[d + 3] / 127.5 - 1;
                    // weak normals are compression noise (UnpackDecalNormal's filter)
                    const sq = dx * dx + dy * dy;

                    if (sq <= 0.0004)
                        continue;

                    const f = sq >= 0.0029 ? weight : ((sq - 0.0004) / 0.0025) * weight;
                    dx *= f;
                    dy *= f;
                    const dz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));

                    if (replaceNormal)
                    {
                        nx[p] += (dx - nx[p]) * weight;
                        ny[p] += (dy - ny[p]) * weight;
                        nz[p] += (dz - nz[p]) * weight;
                    }
                    else
                    {
                        nx[p] += dx * weight;
                        ny[p] += dy * weight;
                        nz[p] += (nz[p] * dz - nz[p]) * weight;
                    }
                }
            }
        }
    };

    const sorted = [...layers].sort((a, b) => a.priority - b.priority);

    for (const l of sorted)
        if (!l.post)
            await apply(l);

    // skin colour: lerp(Diffuse, Diffuse · palette, Diffuse.a) with the raw palette value
    for (let i = 0; i < n; i++)
    {
        const a = base.rgba[i * 4 + 3] / 255;

        for (let c = 0; c < 3; c++)
            rgb[i * 3 + c] *= 1 + (skin[c] - 1) * a;
    }

    for (const l of sorted)
        if (l.post)
            await apply(l);

    const out = new Uint8Array(n * 4);

    for (let i = 0; i < n; i++)
    {
        out[i * 4] = srgbByte(rgb[i * 3]);
        out[i * 4 + 1] = srgbByte(rgb[i * 3 + 1]);
        out[i * 4 + 2] = srgbByte(rgb[i * 3 + 2]);
        out[i * 4 + 3] = 255;
    }

    const result: Baked = { diffuse: 'data:image/png;base64,' + encodePng(out, w, h, 1).toString('base64') };

    if (nx && ny && nz)
    {
        const nout = new Uint8Array(n * 4);

        for (let i = 0; i < n; i++)
        {
            const len = Math.hypot(nx[i], ny[i], nz[i]) || 1;
            nout[i * 4] = Math.round(((nx[i] / len) * 0.5 + 0.5) * 255);
            nout[i * 4 + 1] = Math.round(((ny[i] / len) * 0.5 + 0.5) * 255);
            nout[i * 4 + 2] = 255;
            nout[i * 4 + 3] = 255;
        }

        result.normal = 'data:image/png;base64,' + encodePng(nout, w, h, 1).toString('base64');
    }

    return result;
}
