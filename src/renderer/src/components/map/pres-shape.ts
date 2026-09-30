/**
 * Where a group's name goes (docs/map.md, "Presentation"): the group's pixels sampled on a grid over its bounds (up
 * to ~8k cells), its big connected parts, and per part a gentle curve through its middle — along the principal axis
 * (horizontal for roundish parts), the offset of the part's middle across it fitted with a parabola — with the part's
 * thickness around it. In map pixels; computed once per group and mode.
 */
import type { Groups } from './model';

export interface LabelPath
{
    /** points along the curve, from its left end (x y …) */
    pts: Float32Array;
    /** arc length at each point (map pixels) */
    len: Float32Array;
    /** the part's thickness across the curve (map pixels) */
    thick: number;
    /** the part's area (map pixels²) */
    area: number;
}

const CELLS = 8000;
/** bins along the axis; points on the curve */
const BINS = 20;
const POINTS = 25;
/** parts smaller than this share of the biggest get no name of their own; at most MAX_PARTS */
const PART_SHARE = 0.35;
const MAX_PARTS = 3;

/** The paths of a group's name: one per big part, the biggest first. */
export function labelPaths(ids: Uint16Array, width: number, height: number, groups: Groups, g: number): LabelPath[]
{
    const x0 = Math.max(0, groups.box[g * 4]);
    const y0 = Math.max(0, groups.box[g * 4 + 1]);
    const x1 = Math.min(width - 1, groups.box[g * 4 + 2]);
    const y1 = Math.min(height - 1, groups.box[g * 4 + 3]);

    if (x1 < x0 || y1 < y0)
        return [];

    const step = Math.max(1, Math.ceil(Math.sqrt(((x1 - x0 + 1) * (y1 - y0 + 1)) / CELLS)));
    const gw = Math.ceil((x1 - x0 + 1) / step);
    const gh = Math.ceil((y1 - y0 + 1) / step);
    const at = (i: number, j: number): [number, number] => [Math.min(x1, x0 + i * step + (step >> 1)), Math.min(y1, y0 + j * step + (step >> 1))];
    // the grid: −1 not the group's, else unvisited (0) / its part + 1
    const part = new Int32Array(gw * gh);

    for (let j = 0; j < gh; j++)
    {
        for (let i = 0; i < gw; i++)
        {
            const [x, y] = at(i, j);
            part[j * gw + i] = groups.of[ids[y * width + x]] === g ? 0 : -1;
        }
    }

    // connected parts (8 neighbours)
    const sizes: number[] = [];
    const queue = new Int32Array(gw * gh);

    for (let c = 0; c < part.length; c++)
    {
        if (part[c] !== 0)
            continue;

        const id = sizes.length + 1;
        let head = 0;
        let tail = 0;
        queue[tail++] = c;
        part[c] = id;

        while (head < tail)
        {
            const q = queue[head++];
            const qi = q % gw;
            const qj = (q - qi) / gw;

            for (let dj = -1; dj <= 1; dj++)
            {
                for (let di = -1; di <= 1; di++)
                {
                    const i = qi + di;
                    const j = qj + dj;

                    if (i < 0 || j < 0 || i >= gw || j >= gh)
                        continue;

                    const n = j * gw + i;

                    if (part[n] === 0)
                    {
                        part[n] = id;
                        queue[tail++] = n;
                    }
                }
            }
        }

        sizes.push(tail);
    }

    const order = sizes.map((_, k) => k).sort((a, b) => sizes[b] - sizes[a]);
    const out: LabelPath[] = [];

    for (const k of order.slice(0, MAX_PARTS))
    {
        if (sizes[k] < sizes[order[0]] * PART_SHARE)
            break;

        const cells: number[] = [];

        for (let c = 0; c < part.length; c++)
            if (part[c] === k + 1)
                cells.push(c);

        out.push(pathOf(cells.map((c) => at(c % gw, Math.floor(c / gw))), step));
    }

    return out;
}

/** The curve through a part's cells (their centres, `step` map pixels apart). */
function pathOf(cells: [number, number][], step: number): LabelPath
{
    const n = cells.length;
    let mx = 0;
    let my = 0;

    for (const [x, y] of cells)
    {
        mx += x;
        my += y;
    }

    mx /= n;
    my /= n;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;

    for (const [x, y] of cells)
    {
        sxx += (x - mx) ** 2;
        syy += (y - my) ** 2;
        sxy += (x - mx) * (y - my);
    }

    // the principal axis; roundish parts (the minor axis over 0.6 of the major, by variance) read horizontally
    const tr = (sxx + syy) / 2;
    const det = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
    const ratio = tr + det > 0 ? (tr - det) / (tr + det) : 1;
    let angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    angle *= Math.max(0, Math.min(1, (0.6 - ratio) / 0.3));
    let ux = Math.cos(angle);
    let uy = Math.sin(angle);

    // (left to right; a vertical one reads upwards)
    if (ux < -1e-6 || (Math.abs(ux) <= 1e-6 && uy > 0))
    {
        ux = -ux;
        uy = -uy;
    }

    const nx = -uy;
    const ny = ux;
    let tMin = Infinity;
    let tMax = -Infinity;
    const ts = new Float64Array(n);
    const ss = new Float64Array(n);
    cells.forEach(([x, y], i) =>
    {
        ts[i] = (x - mx) * ux + (y - my) * uy;
        ss[i] = (x - mx) * nx + (y - my) * ny;
        tMin = Math.min(tMin, ts[i]);
        tMax = Math.max(tMax, ts[i]);
    });
    tMin -= step / 2;
    tMax += step / 2;
    // (bins at least a cell wide)
    const bins = Math.max(1, Math.min(BINS, Math.floor((tMax - tMin) / step)));
    const bw = (tMax - tMin) / bins;
    const count = new Float64Array(bins);
    const sum = new Float64Array(bins);

    for (let i = 0; i < n; i++)
    {
        const b = Math.min(bins - 1, Math.floor((ts[i] - tMin) / bw));
        count[b]++;
        sum[b] += ss[i];
    }

    // thickness per bin (map pixels across the axis); the name spans the bins at least a third of the thickest
    const thick = Array.from(count, (c) => (c * step * step) / bw);
    const maxThick = Math.max(...thick);
    let first = 0;
    let last = bins - 1;

    while (thick[first] < maxThick / 3)
        first++;

    while (thick[last] < maxThick / 3)
        last--;

    // the middle's offset: s = a t² + b t + c, least squares weighted by the cells
    const m = new Float64Array(9);
    const r = new Float64Array(3);

    for (let b = first; b <= last; b++)
    {
        if (!count[b])
            continue;

        const t = tMin + (b + 0.5) * bw;
        const s = sum[b] / count[b];
        const w = count[b];
        const p = [t * t, t, 1];

        for (let i = 0; i < 3; i++)
        {
            r[i] += w * p[i] * s;

            for (let j = 0; j < 3; j++)
                m[i * 3 + j] += w * p[i] * p[j];
        }
    }

    let [a, b, c] = solve3(m, r) ?? [0, 0, 0];
    const t0 = tMin + first * bw;
    const t1 = tMin + (last + 1) * bw;
    const half = (t1 - t0) / 2;
    // (gently: the bow at most a tenth of the length, the tilt at most 25°)
    const bow = Math.abs(a) * half * half;

    if (bow > half * 0.2)
        a *= (half * 0.2) / bow;

    const tilt = Math.tan((25 * Math.PI) / 180);
    const tm = (t0 + t1) / 2;
    const slope = 2 * a * tm + b;

    if (Math.abs(slope) > tilt)
    {
        // (through the same middle)
        const sm = a * tm * tm + b * tm + c;
        b -= slope - Math.sign(slope) * tilt;
        c = sm - a * tm * tm - b * tm;
    }

    const pts = new Float32Array(POINTS * 2);
    const len = new Float32Array(POINTS);

    for (let i = 0; i < POINTS; i++)
    {
        const t = t0 + ((t1 - t0) * i) / (POINTS - 1);
        const s = a * t * t + b * t + c;
        pts[i * 2] = mx + ux * t + nx * s;
        pts[i * 2 + 1] = my + uy * t + ny * s;

        if (i)
            len[i] = len[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    }

    // the thickness: the mean over the middle half of the span
    const q0 = first + Math.floor((last - first + 1) / 4);
    const q1 = last - Math.floor((last - first + 1) / 4);
    let tk = 0;

    for (let b = q0; b <= q1; b++)
        tk += thick[b];

    return { pts, len, thick: tk / (q1 - q0 + 1), area: n * step * step };
}

/** 3 × 3 linear system (row-major), undefined when singular. */
function solve3(m: Float64Array, r: Float64Array): [number, number, number] | undefined
{
    const det = (a: ArrayLike<number>): number => a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
    const d = det(m);

    if (Math.abs(d) < 1e-9 * Math.max(1, Math.abs(m[0] * m[4] * m[8])))
    {
        // too few bins for a parabola: a straight line (or a constant) through them
        const d2 = m[4] * m[8] - m[5] * m[7];

        if (Math.abs(d2) > 1e-9)
            return [0, (r[1] * m[8] - m[5] * r[2]) / d2, (m[4] * r[2] - r[1] * m[7]) / d2];

        return m[8] ? [0, 0, r[2] / m[8]] : undefined;
    }

    const col = (k: number): number =>
    {
        const x = Array.from(m);

        for (let i = 0; i < 3; i++)
            x[i * 3 + k] = r[i];

        return det(x) / d;
    };
    return [col(0), col(1), col(2)];
}
