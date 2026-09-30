/**
 * Texture conversions between the game's packed maps and what Blender (glTF) reads — docs/blender.md, "Textures".
 *
 * - normal maps ("RRxG": x in green, y in alpha, red ≈ x, blue free for masks) ↔ standard tangent-space RGB normal
 *   maps: R = x (game green), G = y (game alpha — +Y is up in the image for both, see docs/blender.md), B = z
 *   reconstructed. Exact both ways for x and y; red and blue of the game map come back from the original.
 * - properties maps (r = SSS/AO mask, g = specular, b = metalness, a = roughness) → glTF metallic-roughness
 *   ("ORM": G = roughness, B = metalness, R = the game's red); on the way back only G and B are taken from it.
 */
import { createHash } from 'node:crypto';
import type { RgbaImage } from '../images/ddsEncode.ts';
import { decodeDds, formatLabel, parseDds, type DdsInfo } from '../images/dds.ts';
import { decodePng, isPng } from '../images/png.ts';

/** A game texture (DDS, or PNG) at full size, with its format. */
export async function decodeTexture(bytes: Uint8Array): Promise<{ img: RgbaImage; format: string; mips: number; info?: DdsInfo; }>
{
    if (isPng(bytes))
        return { img: decodePng(bytes), format: 'PNG', mips: 1 };

    const info = parseDds(bytes);
    return { img: await decodeDds(bytes), format: formatLabel(info), mips: info.mips, info };
}

/** Identity of an image's pixels: sha1 over size and RGBA bytes. */
export function pixelHash(img: RgbaImage): string
{
    const h = createHash('sha1');
    h.update(`${img.width}x${img.height}:`);
    h.update(img.rgba);
    return h.digest('hex');
}

/**
 * Hashes of the four channels (with the size): exporters drop or rebuild channels they don't use (an opaque
 * material's alpha, the red of a metallic-roughness map), so "changed" is decided on the channels that carry data.
 */
export function channelHashes(img: RgbaImage): string[]
{
    const n = img.width * img.height;
    const ch = new Uint8Array(n);
    return [0, 1, 2, 3].map((c) =>
    {
        for (let i = 0; i < n; i++)
            ch[i] = img.rgba[i * 4 + c];

        return createHash('sha1')
            .update(`${img.width}x${img.height}:`)
            .update(ch)
            .digest('hex')
            .slice(0, 20);
    });
}

export function normalToGltf(img: RgbaImage): RgbaImage
{
    const s = img.rgba;
    const out = new Uint8Array(s.length);

    for (let i = 0; i < s.length; i += 4)
    {
        const x = s[i + 1] / 127.5 - 1;
        const y = s[i + 3] / 127.5 - 1;
        out[i] = s[i + 1];
        out[i + 1] = s[i + 3];
        out[i + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5 + 0.5) * 255);
        out[i + 3] = 255;
    }

    return { width: img.width, height: img.height, rgba: out };
}

/** Nearest-neighbour resample (channels kept from an original of another size). */
export function resizeNearest(img: RgbaImage, width: number, height: number): RgbaImage
{
    if (img.width === width && img.height === height)
        return img;

    const out = new Uint8Array(width * height * 4);

    for (let y = 0; y < height; y++)
    {
        const sy = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / height));

        for (let x = 0; x < width; x++)
        {
            const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / width));
            out.set(img.rgba.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), (y * width + x) * 4);
        }
    }

    return { width, height, rgba: out };
}

/** Share of pixels whose red is within 8 of green: the game's usual "RRxG" layout keeps x in red too. */
function redIsX(img: RgbaImage): boolean
{
    let n = 0;
    const s = img.rgba;

    for (let i = 0; i < s.length; i += 4)
        if (Math.abs(s[i] - s[i + 1]) <= 8)
            n++;

    return n >= (s.length / 4) * 0.9;
}

/**
 * A standard normal map back to the game's layout: green = R, alpha = G; red = x again where the original kept x in
 * red (else the original's red), blue from the original (0 without one).
 */
export function normalFromGltf(img: RgbaImage, original?: RgbaImage): RgbaImage
{
    const o = original ? resizeNearest(original, img.width, img.height) : undefined;
    const xInRed = !o || redIsX(o);
    const s = img.rgba;
    const out = new Uint8Array(s.length);

    for (let i = 0; i < s.length; i += 4)
    {
        out[i] = xInRed ? s[i] : o!.rgba[i];
        out[i + 1] = s[i];
        out[i + 2] = o ? o.rgba[i + 2] : 0;
        out[i + 3] = s[i + 1];
    }

    return { width: img.width, height: img.height, rgba: out };
}

export function propertiesToOrm(img: RgbaImage): RgbaImage
{
    const s = img.rgba;
    const out = new Uint8Array(s.length);

    for (let i = 0; i < s.length; i += 4)
    {
        out[i] = s[i];
        out[i + 1] = s[i + 3];
        out[i + 2] = s[i + 2];
        out[i + 3] = 255;
    }

    return { width: img.width, height: img.height, rgba: out };
}

/** Roughness (G) and metalness (B) of an edited ORM map into the original properties map (red and green kept). */
export function propertiesFromOrm(orm: RgbaImage, original: RgbaImage): RgbaImage
{
    const o = resizeNearest(original, orm.width, orm.height);
    const out = new Uint8Array(o.rgba);
    const s = orm.rgba;

    for (let i = 0; i < s.length; i += 4)
    {
        out[i + 3] = s[i + 1];
        out[i + 2] = s[i + 2];
    }

    return { width: orm.width, height: orm.height, rgba: out };
}

/** Alpha that is 255 everywhere (an editor or exporter dropped the channel). */
export function opaque(img: RgbaImage): boolean
{
    const s = img.rgba;

    for (let i = 3; i < s.length; i += 4)
        if (s[i] !== 255)
            return false;

    return true;
}

/** The colour of `img` with the alpha channel of `from` (resampled to its size). */
export function withAlpha(img: RgbaImage, from: RgbaImage): RgbaImage
{
    const a = resizeNearest(from, img.width, img.height);
    const out = new Uint8Array(img.rgba);

    for (let i = 3; i < out.length; i += 4)
        out[i] = a.rgba[i];

    return { width: img.width, height: img.height, rgba: out };
}
