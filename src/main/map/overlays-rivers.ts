/**
 * Rivers as lines (docs/map.md, "Rivers and sea crossings"). map_data/rivers.png is an 8-bit palette image of the
 * province map's size; its indices: 0 a river's source, 1 a tributary's last pixel where it joins another river, 2 a
 * split, 3 … 15 the river's width (common/defines NRivers NUM_WIDTH_PIXEL_VALUES = 13, narrowest first), 254 water,
 * 255 land. Rivers are 1 pixel wide and 4-connected (a few diagonal steps; AGOT has some stray pixels).
 *
 * Traced from pixel to pixel between junctions and ends, joined through junctions where a river goes on (a branch that
 * starts with a join or split pixel ends there), smoothed along the way (the ends kept; a tributary ends where it meets
 * the river it joins), the widths too (a running median, then a Gaussian: steps become ramps), and simplified per level
 * of detail (Douglas–Peucker over x, y and the width).
 */
import { pngHeader, pngRows } from './terrain-png.ts';

/** the last index that is a river's width (3 + NUM_WIDTH_PIXEL_VALUES − 1) */
const LAST = 15;
/** the smoothing: a Gaussian along the chain (map pixels), cut off at K pixels; the widths' */
const SIGMA = 1.8;
const K = 5;
const WIDTH_SIGMA = 3;
const WIDTH_K = 9;
/** pixels along a chain that give its direction at a junction */
const LOOK = 5;
/** the widths' running median: pixels each side */
const MEDIAN = 4;
/** steps per width class in the files; map pixels a class counts as in the simplification's error */
const STEPS = 16;
const WIDTH_WEIGHT = 0.3;

/** One level of detail: points of all rivers, one river after another. */
export interface RiverLevel
{
    /** the simplification's tolerance (map pixels) */
    tolerance: number;
    /** x, y per point (map pixels; a pixel's centre is at .5) */
    points: Float32Array;
    /** per point: the width class (1 … 13, rivers.png index − 2; smoothed along the river) × STEPS */
    classes: Uint8Array;
    /** per river: its first point and its point count */
    rivers: Uint32Array;
}

/** rivers.png's indices (row-major, top row first), or null when it is not an 8-bit palette image. */
export async function riverPixels(png: Uint8Array): Promise<{ width: number; height: number; px: Uint8Array; } | null>
{
    const hd = pngHeader(png);

    if (hd.type !== 3 || hd.depth !== 8)
        return null;

    const px = new Uint8Array(hd.width * hd.height);
    await pngRows(png, (bytes, y) => px.set(bytes.subarray(0, hd.width), y * hd.width));
    return { width: hd.width, height: hd.height, px };
}

/**
 * The river pixels' neighbours: the 4-neighbours that are river pixels, and diagonal ones where neither pixel between
 * them is (a diagonal step; otherwise the corner would be a shortcut). Up to 8 per pixel in `nb` (compact indices).
 */
function graph(px: Uint8Array, w: number, h: number): { pix: Int32Array; nb: Int32Array; deg: Uint8Array; }
{
    const list: number[] = [];

    for (let i = 0; i < px.length; i++)
        if (px[i] <= LAST)
            list.push(i);

    const pix = Int32Array.from(list);
    const at = new Map<number, number>();
    pix.forEach((i, k) => at.set(i, k));
    const n = pix.length;
    const nb = new Int32Array(n * 8);
    const deg = new Uint8Array(n);
    const river = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && px[y * w + x] <= LAST;

    for (let k = 0; k < n; k++)
    {
        const i = pix[k];
        const x = i % w;
        const y = (i - x) / w;

        for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]])
            if (river(x + dx, y + dy))
                nb[k * 8 + deg[k]++] = at.get(i + dy * w + dx)!;

        for (const [dx, dy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]])
            if (river(x + dx, y + dy) && !river(x + dx, y) && !river(x, y + dy))
                nb[k * 8 + deg[k]++] = at.get(i + dy * w + dx)!;
    }

    return { pix, nb, deg };
}

/**
 * The rivers as sequences of pixels (compact indices): chains between pixels that are no plain line pixel (ends,
 * junctions), joined at junctions — the two ends that go on the straightest, not counting ends whose first pixel is a
 * source, join or split (a tributary or branch: it ends at the junction pixel, on the river it meets). A closed loop
 * repeats its first pixel at its end.
 */
function trace(px: Uint8Array, w: number, g: { pix: Int32Array; nb: Int32Array; deg: Uint8Array; }): number[][]
{
    const { pix, nb, deg } = g;
    const n = pix.length;
    const seen = new Uint8Array(n);
    const walk = (a: number, b: number): number[] =>
    {
        const c = [a];
        let prev = a;
        let cur = b;

        while (deg[cur] === 2 && !seen[cur])
        {
            seen[cur] = 1;
            c.push(cur);
            const next = nb[cur * 8] === prev ? nb[cur * 8 + 1] : nb[cur * 8];
            prev = cur;
            cur = next;
        }

        c.push(cur);
        return c;
    };
    const chains: number[][] = [];

    for (let k = 0; k < n; k++)
    {
        if (deg[k] === 2)
            continue;

        for (let j = 0; j < deg[k]; j++)
        {
            const b = nb[k * 8 + j];

            if (deg[b] === 2)
            {
                if (!seen[b])
                    chains.push(walk(k, b));
            }
            else if (k < b)
                chains.push([k, b]);
        }
    }

    for (let k = 0; k < n; k++)
        if (deg[k] === 2 && !seen[k])
        {
            seen[k] = 1;
            chains.push(walk(k, nb[k * 8]));
        }

    // junctions: which chain ends meet at each pixel of 3 or more neighbours
    const endsAt = new Map<number, number[]>();
    chains.forEach((c, ci) =>
    {
        if (c[0] === c[c.length - 1])
            return;

        for (const side of [0, 1])
        {
            const p = side ? c[c.length - 1] : c[0];

            if (deg[p] < 3)
                continue;

            const list = endsAt.get(p);

            if (list)
                list.push(ci * 2 + side);
            else
                endsAt.set(p, [ci * 2 + side]);
        }
    });
    const xy = (k: number): [number, number] => [pix[k] % w, Math.floor(pix[k] / w)];
    /** an end's pixel `i` steps into its chain */
    const step = (e: number, i: number): number =>
    {
        const c = chains[e >> 1];
        const s = Math.min(i, c.length - 1);
        return e & 1 ? c[c.length - 1 - s] : c[s];
    };
    const link = new Int32Array(chains.length * 2).fill(-1);

    for (const [p, ends] of endsAt)
    {
        const [px0, py0] = xy(p);
        const dir = (e: number): [number, number] =>
        {
            const [x, y] = xy(step(e, LOOK));
            const l = Math.hypot(x - px0, y - py0) || 1;
            return [(x - px0) / l, (y - py0) / l];
        };
        // (only two go on: they are the river, whatever the angle; of more, the straightest pairs)
        const open = ends.filter((e) => px[pix[step(e, 1)]] > 2);

        while (open.length >= 2)
        {
            let best = open.length === 2 ? -Infinity : 0;
            let pair: [number, number] | null = null;

            for (let a = 0; a < open.length; a++)
                for (let b = a + 1; b < open.length; b++)
                {
                    const [ax, ay] = dir(open[a]);
                    const [bx, by] = dir(open[b]);
                    const s = -(ax * bx + ay * by);

                    if (s > best)
                        [best, pair] = [s, [a, b]];
                }

            if (!pair)
                break;

            const [ea, eb] = [open[pair[0]], open[pair[1]]];
            link[ea] = eb;
            link[eb] = ea;
            open.splice(pair[1], 1);
            open.splice(pair[0], 1);
        }
    }

    // rivers: from an end without a link through the links; then what is left (loops)
    const used = new Uint8Array(chains.length);
    const follow = (e: number): number[] =>
    {
        const seq: number[] = [];

        for (;;)
        {
            const ci = e >> 1;
            used[ci] = 1;
            const c = e & 1 ? [...chains[ci]].reverse() : chains[ci];

            for (let i = seq.length ? 1 : 0; i < c.length; i++)
                seq.push(c[i]);

            const next = link[e ^ 1];

            if (next < 0 || used[next >> 1])
                return seq;

            e = next;
        }
    };
    const rivers: number[][] = [];

    for (let ci = 0; ci < chains.length; ci++)
    {
        if (used[ci])
            continue;

        if (link[ci * 2] < 0)
            rivers.push(follow(ci * 2));
        else if (link[ci * 2 + 1] < 0)
            rivers.push(follow(ci * 2 + 1));
    }

    for (let ci = 0; ci < chains.length; ci++)
        if (!used[ci])
            rivers.push(follow(ci * 2));

    return rivers;
}

/**
 * Gaussian smoothing along a line of `dim` values per point (σ `sigma`, cut off at `k` points): the window shrinks
 * towards the ends, which stay; a closed line (its last point is its first) goes around.
 */
function smooth(p: Float64Array, dim: number, closed: boolean, sigma: number, k: number): Float64Array
{
    const n = p.length / dim;
    const wt = Array.from({ length: k + 1 }, (_, j) => Math.exp(-(j * j) / (2 * sigma * sigma)));
    const out = new Float64Array(p.length);
    const m = closed ? n - 1 : n;
    const sum = new Float64Array(dim);

    for (let i = 0; i < n; i++)
    {
        const half = closed ? Math.min(k, Math.floor((m - 1) / 2)) : Math.min(k, i, n - 1 - i);
        sum.fill(0);
        let sw = 0;

        for (let j = -half; j <= half; j++)
        {
            const q = closed ? (((i + j) % m) + m) % m : i + j;
            const f = wt[Math.abs(j)];

            for (let d = 0; d < dim; d++)
                sum[d] += p[q * dim + d] * f;

            sw += f;
        }

        for (let d = 0; d < dim; d++)
            out[i * dim + d] = sum[d] / sw;
    }

    return out;
}

/**
 * The widths along a river through a running median (MEDIAN pixels each side): the painted widths flicker between
 * neighbouring classes (vanilla `4334333343444346474777`) — the majority is kept, steps stay where they are.
 */
function median(cls: Uint8Array): Uint8Array
{
    const n = cls.length;
    const out = new Uint8Array(n);
    const count = new Uint16Array(256);

    for (let i = 0; i < n; i++)
    {
        const half = Math.min(MEDIAN, i, n - 1 - i);
        count.fill(0, 0, 16);

        for (let j = i - half; j <= i + half; j++)
            count[cls[j]]++;

        let c = 0;

        for (let seen = 0; seen <= half; c++)
            seen += count[c];

        out[i] = c - 1;
    }

    return out;
}

/** Douglas–Peucker over points of three values (x, y, weighted width): the points to keep (flags) to stay within `tol`. */
function simplify(p: Float64Array, tol: number): Uint8Array
{
    const n = p.length / 3;
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack = [0, n - 1];

    while (stack.length)
    {
        const b = stack.pop()!;
        const a = stack.pop()!;

        if (b - a < 2)
            continue;

        const ax = p[a * 3];
        const ay = p[a * 3 + 1];
        const aw = p[a * 3 + 2];
        const dx = p[b * 3] - ax;
        const dy = p[b * 3 + 1] - ay;
        const dw = p[b * 3 + 2] - aw;
        const len = Math.hypot(dx, dy, dw);
        let far = -1;
        let worst = tol;

        for (let i = a + 1; i < b; i++)
        {
            const ex = p[i * 3] - ax;
            const ey = p[i * 3 + 1] - ay;
            const ew = p[i * 3 + 2] - aw;
            // (the distance from the line a–b: the cross product's length over the line's)
            const d = len > 1e-9 ? Math.hypot(ey * dw - ew * dy, ew * dx - ex * dw, ex * dy - ey * dx) / len : Math.hypot(ex, ey, ew);

            if (d > worst)
            {
                worst = d;
                far = i;
            }
        }

        if (far < 0)
            continue;

        keep[far] = 1;
        stack.push(a, far, far, b);
    }

    return keep;
}

/** Traces, smooths and simplifies the rivers of rivers.png's indices (one level per tolerance, finest first). */
export function riverLines(px: Uint8Array, w: number, h: number, tolerances: number[]): RiverLevel[]
{
    const g = graph(px, w, h);
    const seqs = trace(px, w, g).filter((s) => s.length >= 2);
    // the pixels inside each river: a tributary ends on one of them (its junction)
    const inner = new Map<number, [number, number]>();
    seqs.forEach((s, r) =>
    {
        for (let i = 1; i < s.length - 1; i++)
            inner.set(s[i], [r, i]);
    });
    // per river: its points smoothed and its widths — an end on another river's pixel left out (joined below)
    const own = seqs.map((seq) =>
    {
        const closed = seq[0] === seq[seq.length - 1];
        const joins = (k: number): [number, number] | undefined => (closed || seq.length < 4 ? undefined : inner.get(k));
        const head = joins(seq[0]);
        const tail = joins(seq[seq.length - 1]);
        const part = seq.slice(head ? 1 : 0, tail ? -1 : undefined);
        const n = part.length;
        const raw = new Float64Array(n * 2);
        const cls = new Uint8Array(n);
        part.forEach((k, i) =>
        {
            const at = g.pix[k];
            raw[i * 2] = (at % w) + 0.5;
            raw[i * 2 + 1] = Math.floor(at / w) + 0.5;
            cls[i] = px[at] >= 3 ? px[at] - 2 : 0;
        });

        // (sources, joins and splits: the narrower of the widths next to them along the river)
        for (let i = 0; i < n; i++)
        {
            if (cls[i])
                continue;

            let c = 0;

            for (let d = 1; d < n && !c; d++)
            {
                const a = i - d >= 0 ? cls[i - d] : 0;
                const b = i + d < n ? cls[i + d] : 0;
                c = a && b ? Math.min(a, b) : a || b;
            }

            cls[i] = c || 1;
        }

        const loop = closed && n > 3;
        return { from: head ? 1 : 0, pts: smooth(raw, 2, loop, SIGMA, K), cls: smooth(Float64Array.from(median(cls)), 1, loop, WIDTH_SIGMA, WIDTH_K), head, tail };
    });
    /** the point of a river's smoothed line nearest to (x, y), within LOOK pixels of its pixel `at` (index in its sequence) */
    const nearest = ([r, at]: [number, number], x: number, y: number): [number, number] =>
    {
        const o = own[r];
        const n = o.cls.length;
        const i0 = Math.max(0, Math.min(n - 1, at - o.from - LOOK));
        const i1 = Math.max(0, Math.min(n - 1, at - o.from + LOOK));
        let best: [number, number] = [o.pts[i0 * 2], o.pts[i0 * 2 + 1]];
        let bd = Infinity;

        for (let i = i0; i <= i1; i++)
        {
            const ax = o.pts[i * 2];
            const ay = o.pts[i * 2 + 1];
            const dx = i < i1 ? o.pts[i * 2 + 2] - ax : 0;
            const dy = i < i1 ? o.pts[i * 2 + 3] - ay : 0;
            const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
            const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);

            if (d < bd)
                [bd, best] = [d, [ax + dx * t, ay + dy * t]];
        }

        return best;
    };
    // a tributary's end: where it meets the river it joins
    const lines = own.map((l) =>
    {
        const n = l.cls.length;
        const head = l.head ? nearest(l.head, l.pts[0], l.pts[1]) : null;
        const tail = l.tail ? nearest(l.tail, l.pts[n * 2 - 2], l.pts[n * 2 - 1]) : null;
        // x, y and the width (weighted for the simplification) per point
        const m = n + (head ? 1 : 0) + (tail ? 1 : 0);
        const p = new Float64Array(m * 3);
        const at = head ? 1 : 0;

        for (let i = 0; i < n; i++)
            p.set([l.pts[i * 2], l.pts[i * 2 + 1], l.cls[i] * WIDTH_WEIGHT], (i + at) * 3);

        if (head)
            p.set([head[0], head[1], l.cls[0] * WIDTH_WEIGHT], 0);

        if (tail)
            p.set([tail[0], tail[1], l.cls[n - 1] * WIDTH_WEIGHT], (m - 1) * 3);

        return p;
    });
    return tolerances.map((tolerance) =>
    {
        const xs: number[] = [];
        const cs: number[] = [];
        const rivers: number[] = [];

        for (const p of lines)
        {
            const keep = simplify(p, tolerance);
            rivers.push(cs.length);
            let count = 0;

            for (let i = 0; i < keep.length; i++)
                if (keep[i])
                {
                    xs.push(p[i * 3], p[i * 3 + 1]);
                    cs.push(Math.max(STEPS, Math.min(255, Math.round((p[i * 3 + 2] / WIDTH_WEIGHT) * STEPS))));
                    count++;
                }

            rivers.push(count);
        }

        return { tolerance, points: Float32Array.from(xs), classes: Uint8Array.from(cs), rivers: Uint32Array.from(rivers) };
    });
}
