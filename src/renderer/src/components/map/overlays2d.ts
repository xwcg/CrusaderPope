/**
 * Lines over the 2D map (docs/map.md, "Rivers and sea crossings"), on a 2D canvas between the GL map and the names:
 * the rivers as quadratic B-splines through their points (overlay-data.ts) — the level of detail by the zoom, only
 * runs in view, one path per look (width on screen, strength) — as wide as they are on the map, thin ones fading out
 * when zoomed out, wide ones with a lighter middle; the sea crossings as dashed arcs (the game's strait: rounded olive
 * dashes, gfx/map/adjacencies/strait_diffuse.dds).
 */
import type { MapInfo } from '../../../../shared/api';
import type { View } from './gl2d';
import type { Style } from './model';
import { CLASS_STEPS, overlaysNow, riverWidth, type Overlays } from './overlay-data';

/**
 * The rivers per style (rgb): the water — the 2D map's river provinces, a little bluer; on paper ink — and the middle
 * of wide ones, lighter (on paper the paper's pale water between ink banks, as it paints its big rivers): `share` of
 * what the river is wider than `from` CSS pixels. Opaque: overlapping ends of paths would show.
 */
const RIVER: Record<Style, { water: string; core?: { rgb: string; from: number; share: number; }; }> = {
    terrain: { water: '58, 94, 118', core: { rgb: '79, 117, 140', from: 5, share: 0.55 } },
    paper: { water: '72, 80, 80', core: { rgb: '158, 164, 150', from: 4, share: 1 } },
    plain: { water: '56, 92, 120' }
};
/** the crossings' dashes and their rim (rgb) */
const STRAIT = { fill: '156, 138, 74', rim: '28, 24, 12' };

/** the last frame's arguments (drawn again when the overlays arrive) */
let last: [HTMLCanvasElement, View, MapInfo, Style] | null = null;

/**
 * The rivers in view: per look (width on screen and strength) a path of the B-spline segments of its points. Below
 * ~0.7 CSS pixels a line fades (drawn 0.75 wide), below 0.2 it is gone.
 */
function drawRivers(ctx: CanvasRenderingContext2D, o: Overlays, view: View, style: Style, dpr: number, w: number, h: number): void
{
    const r = o.info.rivers;

    if (!r || !o.levels.length)
        return;

    const s = view.scale;
    // the coarsest level within a third of a CSS pixel of the smoothed line
    let L = o.levels[0];

    for (const l of o.levels)
        if (l.tolerance <= s * 0.35)
            L = l;

    // per class value its look (−1: hidden); looks by width in half device pixels and alpha in fifteenths
    const look = new Int32Array(256).fill(-1);
    const looks: { width: number; alpha: number; }[] = [];
    const byKey = new Map<number, number>();

    for (let v = CLASS_STEPS; v < 256; v++)
    {
        const css = riverWidth(r, v) / s;
        const alpha = Math.round(Math.min(1, Math.max(0, (css - 0.2) / 0.5)) * 15);

        if (!alpha)
            continue;

        const half = Math.round(Math.max(css, 0.75) * dpr * 2);
        const key = half * 16 + alpha;
        let b = byKey.get(key);

        if (b === undefined)
        {
            byKey.set(key, b = looks.length);
            looks.push({ width: half / 2, alpha: alpha / 15 });
        }

        look[v] = b;
    }

    const m = r.widths[1];
    const [vx0, vy0, vx1, vy1] = [view.x - m, view.y - m, view.x + (w / dpr) * s + m, view.y + (h / dpr) * s + m];
    const k = dpr / s;
    const P = L.points;
    const paths: (Path2D | undefined)[] = [];
    // the last segment each path got (a gap starts a new subpath)
    const after = new Int32Array(looks.length).fill(-2);

    for (let q = 0; q < L.boxes.length / 4; q++)
    {
        const b = q * 4;

        if (L.boxes[b] > vx1 || L.boxes[b + 2] < vx0 || L.boxes[b + 1] > vy1 || L.boxes[b + 3] < vy0 || look[L.runs[q * 5 + 4]] < 0)
            continue;

        const s0 = L.runs[q * 5];
        const first = L.runs[q * 5 + 2];
        const lastPt = L.runs[q * 5 + 3];

        for (let i = s0; i < s0 + L.runs[q * 5 + 1]; i++)
        {
            const c = look[L.classes[i]];

            if (c < 0)
                continue;

            const p = (paths[c] ??= new Path2D());
            const x = (P[i * 2] - view.x) * k;
            const y = (P[i * 2 + 1] - view.y) * k;

            // segment i: from the midpoint before point i (the river's first point) to the one after it (its last point)
            if (after[c] !== i - 1 || i === first)
            {
                if (i === first)
                    p.moveTo(x, y);
                else
                    p.moveTo(((P[i * 2 - 2] - view.x) * k + x) / 2, ((P[i * 2 - 1] - view.y) * k + y) / 2);
            }

            if (i === lastPt)
                p.lineTo(x, y);
            else
            {
                const mx = ((P[i * 2 + 2] - view.x) * k + x) / 2;
                const my = ((P[i * 2 + 3] - view.y) * k + y) / 2;

                if (i === first)
                    p.lineTo(mx, my);
                else
                    p.quadraticCurveTo(x, y, mx, my);
            }

            after[c] = i;
        }
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // (the narrow first: a wider river stays on top where a tributary joins; the middles after all of them — a width step
    // along a river would cut them)
    const order = looks.map((_, i) => i).sort((a, b) => looks[a].width - looks[b].width);
    const { water, core } = RIVER[style];

    for (const c of order)
    {
        const p = paths[c];

        if (!p)
            continue;

        ctx.lineWidth = looks[c].width;
        ctx.strokeStyle = `rgba(${water}, ${looks[c].alpha})`;
        ctx.stroke(p);
    }

    if (!core)
        return;

    ctx.strokeStyle = `rgb(${core.rgb})`;

    for (const c of order)
    {
        const p = paths[c];
        const width = (looks[c].width - core.from * dpr) * core.share;

        if (!p || width <= 0)
            continue;

        ctx.lineWidth = width;
        ctx.stroke(p);
    }
}

/** The sea crossings in view: dashed arcs (a bulge of an eighth of their length), rounded dashes on a dark rim. */
function drawCrossings(ctx: CanvasRenderingContext2D, o: Overlays, view: View, dpr: number, w: number, h: number): void
{
    const s = view.scale;
    const k = dpr / s;
    // (the strait's width: 3 map pixels, 2 … 7 CSS pixels)
    const lw = Math.min(7, Math.max(2, 3 / s)) * dpr;
    const path = new Path2D();

    for (const c of o.info.crossings)
    {
        const [x0, y0, x1, y1] = c.line.map((v, i) => (v - (i % 2 ? view.y : view.x)) * k);
        const pad = Math.hypot(x1 - x0, y1 - y0) / 4 + lw;

        if (Math.max(x0, x1) < -pad || Math.min(x0, x1) > w + pad || Math.max(y0, y1) < -pad || Math.min(y0, y1) > h + pad)
            continue;

        path.moveTo(x0, y0);
        path.quadraticCurveTo((x0 + x1) / 2 + (y1 - y0) / 4, (y0 + y1) / 2 - (x1 - x0) / 4, x1, y1);
    }

    ctx.lineCap = 'round';
    // dashes 1.6 widths long with their round caps, gaps of 1.2
    ctx.setLineDash([0.6 * lw, 2.2 * lw]);
    ctx.lineWidth = lw + 1.6 * dpr;
    ctx.strokeStyle = `rgba(${STRAIT.rim}, 0.6)`;
    ctx.stroke(path);
    ctx.lineWidth = lw;
    ctx.strokeStyle = `rgb(${STRAIT.fill})`;
    ctx.stroke(path);
    ctx.setLineDash([]);
}

/** Draws the overlays for the view (called with every frame of the 2D map; again when the overlays arrive). */
export function drawOverlays2d(canvas: HTMLCanvasElement, view: View, info: MapInfo, style: Style): void
{
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);

    if (canvas.width !== w || canvas.height !== h)
    {
        canvas.width = w;
        canvas.height = h;
    }

    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    last = [canvas, view, info, style];
    const o = overlaysNow(info, () =>
    {
        if (last?.[2] === info)
            drawOverlays2d(...last);
    });

    if (!o)
        return;

    drawRivers(ctx, o, view, style, dpr, w, h);
    drawCrossings(ctx, o, view, dpr, w, h);
}
