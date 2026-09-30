/**
 * Sea crossings (docs/map.md, "Rivers and sea crossings"): map_data/adjacencies.csv (default.map `adjacencies =`),
 * `From;To;Type;Through;start_x;start_y;stop_x;stop_y;Comment`. `#` starts a comment, the header and the closing
 * `-1;-1;;-1;…` line name no provinces. Type `sea` crosses the sea zone `Through` (vanilla 170, AGOT 259); `river_large`
 * crosses a major river province (vanilla 183, AGOT 32; not drawn). The coordinates are map pixels with y from the
 * bottom (vanilla Slemish–Arran `655;3608` lies on row 1000 of 4608); −1 means none (all of AGOT's, 2 of vanilla's):
 * the crossing then goes between the two provinces' nearest coast pixels.
 */

/** A crossing: its provinces, the sea zone, its line (map pixels, y down; x0 y0 at `from`) */
export interface Crossing
{
    from: number;
    to: number;
    through: number;
    line: [number, number, number, number];
}

/** The `sea` rows of adjacencies.csv; `at`: start and stop as written (y from the bottom), when all four are given. */
export function seaAdjacencies(csv: string): { from: number; to: number; through: number; at?: [number, number, number, number]; }[]
{
    const out: { from: number; to: number; through: number; at?: [number, number, number, number]; }[] = [];

    for (const raw of csv.replace(/^﻿/, '').split(/\r?\n/))
    {
        const f = raw.split('#')[0].split(';').map((s) => s.trim());
        const from = parseInt(f[0], 10);
        const to = parseInt(f[1], 10);

        if (!(from > 0) || !(to > 0) || f[2]?.toLowerCase() !== 'sea')
            continue;

        const at = [4, 5, 6, 7].map((i) => parseFloat(f[i] ?? ''));
        out.push({ from, to, through: parseInt(f[3], 10) || 0, ...(at.every((v) => v >= 0) ? { at: at as [number, number, number, number] } : {}) });
    }

    return out;
}

/**
 * A province's pixels next to another province (4-neighbours), those next to water first: `water` flags water
 * provinces by id. Scanned within its bounds (x0 y0 x1 y1).
 */
function edge(ids: Uint16Array, w: number, h: number, p: number, box: number[], water: Uint8Array): { coast: number[]; rim: number[]; }
{
    const coast: number[] = [];
    const rim: number[] = [];
    const [x0, y0, x1, y1] = [box[p * 4], box[p * 4 + 1], box[p * 4 + 2], box[p * 4 + 3]];

    if (x0 < 0)
        return { coast, rim };

    for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
        {
            const i = y * w + x;

            if (ids[i] !== p)
                continue;

            let other = false;
            let wet = false;

            for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1])
            {
                if (j < 0 || ids[j] === p)
                    continue;

                other = true;

                if (water[ids[j]])
                    wet = true;
            }

            if (wet)
                coast.push(x, y);
            else if (other)
                rim.push(x, y);
        }

    return { coast, rim };
}

/** The nearest pair of pixels between two lists (x, y pairs) — the second in a grid of cells, searched ring by ring. */
function nearestPair(a: number[], b: number[]): [number, number, number, number] | null
{
    if (!a.length || !b.length)
        return null;

    const C = 16;
    const grid = new Map<number, number[]>();

    for (let i = 0; i < b.length; i += 2)
    {
        const k = (Math.floor(b[i + 1] / C) << 16) | Math.floor(b[i] / C);
        const list = grid.get(k);

        if (list)
            list.push(i);
        else
            grid.set(k, [i]);
    }

    let best = Infinity;
    let pair: [number, number, number, number] | null = null;

    for (let i = 0; i < a.length; i += 2)
    {
        const cx = Math.floor(a[i] / C);
        const cy = Math.floor(a[i + 1] / C);

        for (let r = 0;; r++)
        {
            // (a ring's cells are at least (r − 1) cells away)
            if ((r - 1) * C > best || r > 4096 / C)
                break;

            for (let dy = -r; dy <= r; dy++)
                for (let dx = -r; dx <= r; dx++)
                {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r)
                        continue;

                    for (const j of grid.get(((cy + dy) << 16) | (cx + dx)) ?? [])
                    {
                        const d = Math.hypot(b[j] - a[i], b[j + 1] - a[i + 1]);

                        if (d < best)
                            [best, pair] = [d, [a[i], a[i + 1], b[j], b[j + 1]]];
                    }
                }
        }
    }

    return pair;
}

/**
 * The crossings between land provinces (`land` by id): as written, else between the nearest coast pixels (pixels next
 * to water — else next to anything else) of the two, made a pixel longer at both ends so that they reach the land.
 * `raster` gives the province ids and each id's bounds (x0 y0 x1 y1, −1 without pixels); asked for only when a row
 * has no coordinates.
 */
export function seaCrossings(
    rows: ReturnType<typeof seaAdjacencies>,
    height: number,
    land: Uint8Array,
    water: Uint8Array,
    raster: () => { ids: Uint16Array; width: number; box: number[]; }
): Crossing[]
{
    const out: Crossing[] = [];

    for (const r of rows)
    {
        if (!land[r.from] || !land[r.to])
            continue;

        if (r.at)
        {
            out.push({ from: r.from, to: r.to, through: r.through, line: [r.at[0], height - r.at[1], r.at[2], height - r.at[3]] });
            continue;
        }

        const { ids, width, box } = raster();
        const a = edge(ids, width, height, r.from, box, water);
        const b = edge(ids, width, height, r.to, box, water);
        const pair = nearestPair(a.coast.length ? a.coast : a.rim, b.coast.length ? b.coast : b.rim);

        if (!pair)
            continue;

        const [x0, y0, x1, y1] = pair.map((v) => v + 0.5);
        const len = Math.hypot(x1 - x0, y1 - y0) || 1;
        const ux = (x1 - x0) / len;
        const uy = (y1 - y0) / len;
        out.push({ from: r.from, to: r.to, through: r.through, line: [x0 - ux, y0 - uy, x1 + ux, y1 + uy] });
    }

    return out;
}
