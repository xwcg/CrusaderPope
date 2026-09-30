/** Colours of script (`color = …`) as #rrggbb, for the map (docs/map.md). */
import type { PNode } from '../indexer/parser.ts';

const hex = (rgb: number[]): string =>
    '#' + rgb.map((x) =>
        Math.round(Math.max(0, Math.min(1, x)) * 255)
            .toString(16)
            .padStart(2, '0')
    ).join('');

/**
 * A colour as #rrggbb: `{ r g b }` (0–1, or 0–255 when a part is above 1), `rgb { }`, `hsv { h s v }` (0–1; hues above
 * 1 are degrees — terrain_types writes `hsv { 29 0.867 0.353 }`), `hsv360 { }` (0–360, 0–100), `hex { rrggbb }`.
 */
export function colorOf(n: PNode | undefined): string | undefined
{
    if (!n || !Array.isArray(n.v))
        return undefined;

    const parts = n.v.filter((c) => !c.k && typeof c.v === 'string').map((c) => c.v as string);

    if (n.tag === 'hex')
        return /^[0-9a-f]{6}/i.test(parts[0] ?? '') ? '#' + parts[0].slice(0, 6).toLowerCase() : undefined;

    const v = parts.map(Number);

    if (v.length < 3 || v.slice(0, 3).some((x) => !Number.isFinite(x)))
        return undefined;

    if (n.tag === 'hsv' || n.tag === 'hsv360')
    {
        let [h, s, l] = n.tag === 'hsv360' ? [v[0] / 360, v[1] / 100, v[2] / 100] : v;

        if (h > 1)
            h /= 360;

        const f = (k: number): number =>
        {
            const x = (k + h * 6) % 6;
            return l - l * s * Math.max(0, Math.min(x, 4 - x, 1));
        };
        return hex([f(5), f(3), f(1)]);
    }

    return hex(v.slice(0, 3).some((x) => x > 1) ? v.slice(0, 3).map((x) => x / 255) : v.slice(0, 3));
}
