/**
 * Drawing coats of arms (CoaInfo, docs/map.md "Coats of arms") on 2D canvases the way the game's shaders compose them
 * (jomini/gfx/FX/coat_of_arms/*.fxh, gfx/FX/coat_of_arms/*.shader, gfx/FX/gui_coatofarms.shader):
 * - pattern: the fallback colour, then color1 by the texture's red, color2 by green, color3 by blue;
 * - colored emblem: color1, color2 by green, color3 by red, then an overlay with blue (shading; 0.5 is neutral); alpha
 *   is the shape. Placed by its instance: mirrored (negative scale), turned (clockwise), sized, centred;
 * - `mask = { 1 }`: the emblem only where the pattern shows that colour (red minus green and blue, green minus blue, blue);
 * - every emblem's alpha × gfx/coat_of_arms/coa_mask_texture.dds's green × 2 at its place in the arms (worn paint:
 *   the texture's dark specks, 9 % of it under 0.5, let the field show through);
 * - every layer: overlay with the mask texture's blue at 20 % — done once over the whole (the same: per pixel the
 *   overlay is affine in the colour, so it commutes with the layers' blending);
 * - framed: the gui's shape mask (alpha) cuts the arms, shifted and scaled inside it (offset / scale), then the frame
 *   (realms: their government's banner — a shadow behind, the tier's bar above).
 * Textures come as ck3://img PNGs (patterns without alpha: it may be data). Everything is cached — finished pictures
 * by what they show, so arms that stay the same at another date are not drawn again —; the caches are dropped when
 * the index revision changes (another mod list may show other files under the same paths).
 */
import type { CoaDesign, CoaEmblem, CoaFrame, CoaInfo, CoaKind } from '../../../shared/api';
import { api } from '../api';
import { track } from '../pending';
import { imgUrl } from '../img';

const FALLBACK = '#cccac8';
const MASK_TEXTURE = 'gfx/coat_of_arms/coa_mask_texture.dds';

let revision = -1;
/** asked infos by `kind:key@date`; those the same at every date also by `kind:key` */
const infos = new Map<string, Promise<CoaInfo | null>>();
const undated = new Map<string, CoaInfo>();
const images = new Map<string, Promise<HTMLImageElement | null>>();
const pixels = new Map<string, Promise<ImageData | null>>();
/** coloured patterns and emblems, pattern masks, wear: small canvases reused by every coat of arms */
const paints = new Map<string, Promise<HTMLCanvasElement | null>>();
/** finished pictures by what they show (design, frame) and size */
const pictures = new Map<string, Promise<HTMLCanvasElement | null>>();
const sigs = new WeakMap<CoaInfo, string>();

/** Drops everything drawn and loaded when the index changed. */
export function setCoaRevision(rev: number): void
{
    if (rev === revision)
        return;

    revision = rev;

    for (const m of [infos, undated, images, pixels, paints, pictures])
        m.clear();
}

/** Map with a bound: the oldest entries go first. */
function remember<T>(m: Map<string, T>, key: string, make: () => T, max: number): T
{
    let v = m.get(key);

    if (v === undefined)
    {
        m.set(key, v = make());

        if (m.size > max)
            m.delete(m.keys().next().value!);
    }

    return v;
}

/** An entry's arms at a history date (a title's; none: the first bookmark's) — asked once per date unless they never change. */
export function coaInfo(kind: CoaKind, name: string, date?: string): Promise<CoaInfo | null>
{
    const id = kind + ':' + name;
    const same = undated.get(id);

    if (same)
        return Promise.resolve(same);

    return remember(
        infos,
        `${id}@${date ?? ''}`,
        () =>
            api
                .coatOfArms(kind, name, date)
                .catch(() => null)
                .then((info) =>
                {
                    if (info && !info.dated)
                        remember(undated, id, () => info, 2000);

                    return info;
                }),
        2000
    );
}

/** What a picture shows: equal for arms drawn the same (the cache key of finished pictures). */
export function coaSignature(info: CoaInfo): string
{
    let s = sigs.get(info);

    if (s === undefined)
        sigs.set(info, s = JSON.stringify([info.design, info.frame]));

    return s;
}

/** The texture size to ask for: a power of two covering `px`, 64–512. */
const texSize = (px: number): number => Math.min(512, Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, px)))));

function load(url: string): Promise<HTMLImageElement | null>
{
    return track(
        new Promise((resolve) =>
        {
            const img = new Image();
            // (reading its pixels needs an untainted canvas)
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = url;
        })
    );
}

/** An image drawn as it is (textured emblems, frames). */
function image(url: string): Promise<HTMLImageElement | null>
{
    return remember(images, url, () => load(url), 150);
}

function canvas(w: number, h: number): HTMLCanvasElement
{
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
}

const ctx2d = (c: HTMLCanvasElement): CanvasRenderingContext2D => c.getContext('2d', { willReadFrequently: true })!;

/** A texture's pixels at the size it came in. */
function texels(path: string, size: number, ch?: string): Promise<ImageData | null>
{
    const url = imgUrl(path, size, ch);
    return remember(
        pixels,
        url,
        async () =>
        {
            const img = await load(url);

            if (!img || !img.naturalWidth)
                return null;

            const c = canvas(img.naturalWidth, img.naturalHeight);
            const g = ctx2d(c);
            g.drawImage(img, 0, 0);
            return g.getImageData(0, 0, c.width, c.height);
        },
        150
    );
}

const rgbOf = (hex: string | undefined): [number, number, number] =>
{
    const n = parseInt((hex ?? FALLBACK).slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const clamp = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** cw/utility.fxh Overlay(base, blend) per channel, 0–1 */
const overlay = (base: number, blend: number): number => (base < 0.5 ? 2 * base * blend : 1 - 2 * (1 - base) * (1 - blend));

/** The pattern in its colours (coat_of_arms_pattern.fxh: Pattern). */
function patternPaint(d: CoaDesign, size: number): Promise<HTMLCanvasElement | null>
{
    return remember(
        paints,
        `p|${d.pattern}|${size}|${d.colors.slice(0, 3).join()}`,
        async () =>
        {
            const t = await texels(d.pattern, size, 'rgb');

            if (!t)
                return null;

            const [f, c1, c2, c3] = [FALLBACK, ...d.colors].map(rgbOf);
            const c = canvas(t.width, t.height);
            const out = new ImageData(t.width, t.height);
            const s = t.data;
            const o = out.data;

            for (let i = 0; i < s.length; i += 4)
            {
                const r = s[i] / 255;
                const g = s[i + 1] / 255;
                const b = s[i + 2] / 255;

                for (let k = 0; k < 3; k++)
                {
                    let v = f[k];
                    v += (c1[k] - v) * r;
                    v += (c2[k] - v) * g;
                    v += (c3[k] - v) * b;
                    o[i + k] = v;
                }

                o[i + 3] = 255;
            }

            ctx2d(c).putImageData(out, 0, 0);
            return c;
        },
        300
    );
}

/** Where the pattern shows the given colours, as alpha (coat_of_arms_textured_emblem.fxh, USE_PATTERN_MASK). */
function patternMask(pattern: string, mask: number[], size: number): Promise<HTMLCanvasElement | null>
{
    return remember(
        paints,
        `m|${pattern}|${size}|${mask.join()}`,
        async () =>
        {
            const t = await texels(pattern, size, 'rgb');

            if (!t)
                return null;

            const c = canvas(t.width, t.height);
            const out = new ImageData(t.width, t.height);
            const s = t.data;
            const on = [1, 2, 3].map((m) => (mask.includes(m) ? 1 : 0));

            for (let i = 0; i < s.length; i += 4)
            {
                const b = s[i + 2] / 255;
                const g = clamp(s[i + 1] / 255 - b);
                const r = clamp(s[i] / 255 - s[i + 1] / 255 - b);
                out.data[i + 3] = clamp(r * on[0] + g * on[1] + b * on[2]) * 255;
            }

            ctx2d(c).putImageData(out, 0, 0);
            return c;
        },
        300
    );
}

/** A colored emblem in its colours, or a textured one as it is. */
function emblemPaint(e: CoaEmblem, size: number): Promise<HTMLCanvasElement | HTMLImageElement | null>
{
    if (!e.colors)
        return image(imgUrl(e.texture, size));

    return remember(
        paints,
        `e|${e.texture}|${size}|${e.colors.join()}`,
        async () =>
        {
            const t = await texels(e.texture, size);

            if (!t)
                return null;

            const [c1, c2, c3] = e.colors!.map(rgbOf);
            const c = canvas(t.width, t.height);
            const out = new ImageData(t.width, t.height);
            const s = t.data;
            const o = out.data;

            for (let i = 0; i < s.length; i += 4)
            {
                const r = s[i] / 255;
                const g = s[i + 1] / 255;
                const b = s[i + 2] / 255;

                for (let k = 0; k < 3; k++)
                {
                    let v = c1[k];
                    v += (c2[k] - v) * g;
                    v += (c3[k] - v) * r;
                    o[i + k] = overlay(b, v / 255) * 255;
                }

                o[i + 3] = s[i + 3];
            }

            ctx2d(c).putImageData(out, 0, 0);
            return c;
        },
        300
    );
}

/** One design drawn into a square of `px` pixels: pattern, sub-arms, emblems. */
async function drawDesign(d: CoaDesign, px: number): Promise<HTMLCanvasElement>
{
    const out = canvas(px, px);
    const g = ctx2d(out);
    g.imageSmoothingQuality = 'high';
    const pattern = await patternPaint(d, texSize(px));

    if (pattern)
        g.drawImage(pattern, 0, 0, px, px);
    else
    {
        g.fillStyle = d.colors[0] ?? FALLBACK;
        g.fillRect(0, 0, px, px);
    }

    for (const s of d.subs)
    {
        const size = Math.max(...s.at.map(([, , w, h]) => Math.max(w, h))) * px;
        const sub = await drawDesign(s.design, Math.max(4, Math.round(size)));

        for (const [x, y, w, h] of s.at)
            g.drawImage(sub, x * px, y * px, w * px, h * px);
    }

    const [pics, masks, wear] = await Promise.all([
        Promise.all(d.emblems.map((e) => emblemPaint(e, texSize(px * Math.max(Math.abs(e.sx), Math.abs(e.sy)))))),
        Promise.all(d.emblems.map((e) => (e.mask ? patternMask(d.pattern, e.mask, texSize(px)) : null))),
        wearMask(texSize(px))
    ]);
    // each emblem drawn alone, its alpha cut by the pattern's colours (mask) and the wear, then laid on
    const layer = canvas(px, px);
    const lg = ctx2d(layer);
    d.emblems.forEach((e, i) =>
    {
        const p = pics[i];

        if (!p)
            return;

        lg.clearRect(0, 0, px, px);
        lg.save();
        lg.imageSmoothingQuality = 'high';
        lg.translate(e.x * px, e.y * px);
        lg.scale(Math.abs(e.sx) * px, Math.abs(e.sy) * px);
        lg.rotate((e.rotation * Math.PI) / 180);
        lg.scale(Math.sign(e.sx) || 1, Math.sign(e.sy) || 1);
        lg.drawImage(p, -0.5, -0.5, 1, 1);
        lg.restore();
        lg.globalCompositeOperation = 'destination-in';

        for (const m of [masks[i], wear])
            if (m)
                lg.drawImage(m, 0, 0, px, px);

        lg.globalCompositeOperation = 'source-over';
        g.drawImage(layer, 0, 0);
    });
    return out;
}

/** The emblems' wear as alpha (coat_of_arms_textured_emblem.shader: alpha × the mask texture's green × 2, at uvPattern). */
function wearMask(size: number): Promise<HTMLCanvasElement | null>
{
    return remember(
        paints,
        `w|${size}`,
        async () =>
        {
            const t = await texels(MASK_TEXTURE, size);

            if (!t)
                return null;

            const c = canvas(t.width, t.height);
            const out = new ImageData(t.width, t.height);

            for (let i = 0; i < t.data.length; i += 4)
                out.data[i + 3] = Math.min(255, t.data[i + 1] * 2);

            ctx2d(c).putImageData(out, 0, 0);
            return c;
        },
        300
    );
}

/** Bilinear sample of RGBA data (clamped to the edges) at u, v in 0–1 (pixel centres at (i + 0.5) / size). */
function sample(t: ImageData, u: number, v: number, out: number[]): void
{
    const x = Math.min(t.width - 1, Math.max(0, u * t.width - 0.5));
    const y = Math.min(t.height - 1, Math.max(0, v * t.height - 0.5));
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, t.width - 1);
    const y1 = Math.min(y0 + 1, t.height - 1);
    const fx = x - x0;
    const fy = y - y0;
    const d = t.data;

    for (let k = 0; k < 4; k++)
    {
        const a = d[(y0 * t.width + x0) * 4 + k] * (1 - fx) + d[(y0 * t.width + x1) * 4 + k] * fx;
        const b = d[(y1 * t.width + x0) * 4 + k] * (1 - fx) + d[(y1 * t.width + x1) * 4 + k] * fx;
        out[k] = a * (1 - fy) + b * fy;
    }
}

/** A strip's cell (square cells side by side; the last one when there are fewer) drawn into a square. */
function drawCell(g: CanvasRenderingContext2D, strip: HTMLImageElement, index: number, x: number, y: number, size: number): void
{
    if (!strip.naturalHeight)
        return;

    const cells = Math.max(1, Math.round(strip.naturalWidth / strip.naturalHeight));
    const cell = strip.naturalWidth / cells;
    g.imageSmoothingQuality = 'high';
    g.drawImage(strip, Math.min(index, cells - 1) * cell, 0, cell, strip.naturalHeight, x, y, size, size);
}

/**
 * The arms at `px` pixels: the design, the mask texture's shading, and — with a frame — cut to the frame's shape with
 * the frame over it (gui_coatofarms.shader: uv = (p − 0.5) / scale + 0.5 + offset, clamped; alpha × the mask's alpha;
 * modify_texture overlay; the frame cell drawn over its square), in a `box`-pixel square: the frame's, or — with a bar
 * on top (realms) — the frame's at the bottom and the bar above it; a shadow (`under`) behind.
 */
async function paint(info: CoaInfo, box: number): Promise<HTMLCanvasElement>
{
    const f: CoaFrame | undefined = info.frame;
    const fs = box / (1 - (f?.top?.dy ?? 0));
    const [fx, fy] = [(box - fs) / 2, box - fs];
    const px = Math.max(8, Math.round(fs / (f?.ratio ?? 1)));
    const strip = (path: string | undefined): Promise<HTMLImageElement | null> | null => (path ? image(imgUrl(path, Math.min(2048, texSize(box) * 8))) : null);
    const [arms, shade, mask, over, frame, under, top] = await Promise.all([
        drawDesign(info.design, px),
        texels(MASK_TEXTURE, texSize(px)),
        f ? texels(f.mask, texSize(px)) : null,
        f?.overlay ? texels(f.overlay, texSize(px)) : null,
        strip(f?.frame),
        strip(f?.under),
        strip(f?.top?.texture)
    ]);
    const a = ctx2d(arms).getImageData(0, 0, px, px);
    const out = canvas(box, box);
    const g = ctx2d(out);
    const res = new ImageData(px, px);
    const c = [0, 0, 0, 0];
    const s = [0, 0, 0, 0];

    for (let y = 0; y < px; y++)
    {
        for (let x = 0; x < px; x++)
        {
            // p, q: the place in the shape; u, v: in the arms (the shading belongs to the arms)
            const p = (x + 0.5) / px;
            const q = (y + 0.5) / px;
            const u = f ? clamp((p - 0.5) / f.scale[0] + 0.5 + f.offset[0]) : p;
            const v = f ? clamp((q - 0.5) / f.scale[1] + 0.5 + f.offset[1]) : q;
            sample(a, u, v, c);

            if (shade)
            {
                sample(shade, u, v, s);

                for (let k = 0; k < 3; k++)
                    c[k] += (overlay(s[2] / 255, c[k] / 255) * 255 - c[k]) * 0.2;
            }

            if (over)
            {
                sample(over, p, q, s);

                for (let k = 0; k < 3; k++)
                    c[k] += (overlay(c[k] / 255, s[k] / 255) * 255 - c[k]) * 0.4;
            }

            if (mask)
            {
                sample(mask, p, q, s);
                c[3] = (c[3] * s[3]) / 255;
            }

            for (let k = 0; k < 4; k++)
                res.data[(y * px + x) * 4 + k] = c[k];
        }
    }

    if (under)
        drawCell(g, under, 0, fx, fy, fs);

    const shaped = canvas(px, px);
    ctx2d(shaped).putImageData(res, 0, 0);
    g.drawImage(shaped, Math.round(fx + (fs - px) / 2), Math.round(fy + (fs - px) / 2));

    if (frame)
        drawCell(g, frame, f!.index, fx, fy, fs);

    if (top)
        drawCell(g, top, f!.top!.index, fx, fy + f!.top!.dy * fs, fs);

    return out;
}

/** The finished picture of arms in a `box`-pixel square (shared: copy it, don't mount it). */
export function coaPicture(info: CoaInfo, box: number): Promise<HTMLCanvasElement | null>
{
    return remember(pictures, `${box}|${coaSignature(info)}`, () => paint(info, box), 400);
} /**
 * Test hook (scripts/drive.mjs `eval`, then a shot of `#coa-sheet`): a sheet of arms over the page —
 * `__coaSheet(['title:k_france', 'title:k_england@1178.10.1', 'dynasty:699'], 160)` (`@date`: a title's at that
 * history date); resolves with the time it took and what was missing.
 */

(window as unknown as { __coaSheet: unknown; }).__coaSheet = async (ids: string[], size: number): Promise<string> =>
{
    const t0 = performance.now();
    document.getElementById('coa-sheet')?.remove();
    const sheet = document.createElement('div');
    sheet.id = 'coa-sheet';
    sheet.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;display:flex;flex-wrap:wrap;gap:6px;padding:8px;max-width:100vw;background:#26272d;font:11px sans-serif;color:#ccc';
    document.body.append(sheet);
    const box = Math.round(size * (window.devicePixelRatio || 1));
    const pics = await Promise.all(
        ids.map(async (id) =>
        {
            const [what, date] = id.split('@');
            const info = await coaInfo(what.slice(0, what.indexOf(':')) as CoaKind, what.slice(what.indexOf(':') + 1), date);
            return info ? coaPicture(info, box) : null;
        })
    );
    const missing: string[] = [];
    ids.forEach((id, i) =>
    {
        const cell = document.createElement('div');
        cell.style.cssText = `width:${size}px;text-align:center;overflow:hidden;white-space:nowrap`;
        const pic = pics[i];

        if (pic)
        {
            const c = canvas(box, box);
            c.getContext('2d')!.drawImage(pic, 0, 0);
            c.style.cssText = `width:${size}px;height:${size}px;display:block`;
            cell.append(c);
        }
        else
            missing.push(id);

        cell.append(id.slice(id.indexOf(':') + 1));
        sheet.append(cell);
    });
    return `${ids.length} arms in ${Math.round(performance.now() - t0)} ms; none: ${missing.join(' ') || '-'}`;
};
