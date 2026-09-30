/**
 * The 2D map's names (docs/map.md, "Presentation"): the mode's groups on a 2D canvas over the GL one, each name
 * along a curve through its group's shape (pres-shape.ts) as the game draws them — letters spaced out to span most of
 * the group, sized by its thickness. Zoomed in, county and then barony names come in between (smaller, when the
 * mode's groups are bigger than counties / baronies). Laid out once per group and mode (in map pixels); per frame
 * only moved, scaled, checked for overlaps (the mode's names first, the biggest first) and drawn letter by letter.
 */
import type { MapInfo } from '../../../../shared/api';
import { rasterOf, type View } from './gl2d';
import { groupsOf, type Groups, type Style } from './model';
import { labelPaths, type LabelPath } from './pres-shape';

const font = (px: number): string => `small-caps 600 ${px}px Georgia, 'Palatino Linotype', serif`;

/**
 * How a tier's names look — the mode's, counties', baronies': smaller than `min` (CSS pixels) they are left out,
 * bigger than `max` drawn at it, in their curve's middle.
 */
interface Look
{
    min: number;
    max: number;
    fill: string;
    stroke: string;
    alpha: number;
}
const LOOKS: Record<'light' | 'ink', Look[]> = {
    light: [
        { min: 9, max: 60, fill: '247, 239, 219', stroke: '22, 16, 10', alpha: 1 },
        { min: 10, max: 20, fill: '236, 228, 210', stroke: '22, 16, 10', alpha: 0.85 },
        { min: 11, max: 14, fill: '226, 218, 200', stroke: '22, 16, 10', alpha: 0.75 }
    ],
    ink: [
        { min: 9, max: 60, fill: '44, 30, 18', stroke: '240, 228, 200', alpha: 1 },
        { min: 10, max: 20, fill: '58, 42, 28', stroke: '240, 228, 200', alpha: 0.85 },
        { min: 11, max: 14, fill: '70, 54, 38', stroke: '240, 228, 200', alpha: 0.75 }
    ]
};

interface Label
{
    path: LabelPath;
    chars: string[];
    /** font size (map pixels) */
    size: number;
    /** each letter's centre along the path from its middle, its width (map pixels) */
    at: number[];
    widths: number[];
}

const layouts = new WeakMap<Groups, Map<number, Label[]>>();
/**
 * Layouts by a group's name and shape (its area, centre and box stand for its provinces): a realm that keeps its name
 * and provinces at another date, or a county in every mode, is laid out once
 */
const byShape = new Map<string, Label[]>();
const SHAPES_KEPT = 20000;
/** the map's counties and baronies as groups */
const titleTiers = new WeakMap<MapInfo, Groups[]>();
let measurer: CanvasRenderingContext2D | undefined;
const widths100 = new Map<string, number>();

/** a letter's width at 100 px */
function width100(ch: string): number
{
    let w = widths100.get(ch);

    if (w === undefined)
    {
        measurer ??= document.createElement('canvas').getContext('2d')!;
        measurer.font = font(100);
        w = measurer.measureText(ch).width;
        widths100.set(ch, w);
    }

    return w;
}

/** A name on a path: as big as the part's thickness allows, letters spaced out over most of the path's length. */
function layout(path: LabelPath, text: string): Label
{
    const chars = [...text];
    const w = chars.map(width100);
    const natural = w.reduce((a, b) => a + b, 0) / 100;
    const span = path.len[path.len.length - 1] * 0.86;
    const size = Math.min(path.thick * 0.6, span / natural);
    const gaps = Math.max(1, chars.length - 1);
    const space = Math.min(size * 0.9, Math.max(size * 0.04, (span - natural * size) / gaps));
    const total = natural * size + space * (chars.length - 1);
    const at: number[] = [];
    let x = -total / 2;

    for (const cw of w)
    {
        at.push(x + (cw * size) / 200);
        x += (cw * size) / 100 + space;
    }

    return { path, chars, size, at, widths: w.map((cw) => (cw * size) / 100) };
}

/** The point and direction at an arc length along a path. */
function pointAt(p: LabelPath, s: number): [number, number, number]
{
    const n = p.len.length;
    let i = 0;

    while (i < n - 2 && p.len[i + 1] < s)
        i++;

    const seg = p.len[i + 1] - p.len[i] || 1;
    const f = Math.max(0, Math.min(1, (s - p.len[i]) / seg));
    const dx = p.pts[i * 2 + 2] - p.pts[i * 2];
    const dy = p.pts[i * 2 + 3] - p.pts[i * 2 + 1];
    return [p.pts[i * 2] + dx * f, p.pts[i * 2 + 1] + dy * f, Math.atan2(dy, dx)];
}

/** Screen boxes of the names drawn so far, in a grid of cells for quick overlap checks. */
class Boxes
{
    private cells = new Map<number, number[]>();
    private boxes: number[] = [];
    private static CELL = 64;

    private keys(x0: number, y0: number, x1: number, y1: number, fn: (k: number) => boolean | void): boolean
    {
        const c = Boxes.CELL;

        for (let j = Math.floor(y0 / c); j <= Math.floor(y1 / c); j++)
            for (let i = Math.floor(x0 / c); i <= Math.floor(x1 / c); i++)
                if (fn(j * 4096 + i))
                    return true;

        return false;
    }

    hits(x0: number, y0: number, x1: number, y1: number): boolean
    {
        return this.keys(x0, y0, x1, y1, (k) =>
        {
            for (const b of this.cells.get(k) ?? [])
                if (x0 < this.boxes[b + 2] && x1 > this.boxes[b] && y0 < this.boxes[b + 3] && y1 > this.boxes[b + 1])
                    return true;
        });
    }

    add(x0: number, y0: number, x1: number, y1: number): void
    {
        const b = this.boxes.length;
        this.boxes.push(x0, y0, x1, y1);
        this.keys(x0, y0, x1, y1, (k) =>
        {
            const list = this.cells.get(k);

            if (list)
                list.push(b);
            else
                this.cells.set(k, [b]);
        });
    }
}

/** Draws a name when it is big enough, on screen and clear of the names drawn before. */
function place(ctx: CanvasRenderingContext2D, l: Label, view: View, w: number, h: number, placed: Boxes, look: Look): void
{
    const px = l.size / view.scale;

    if (px < look.min)
        return;

    const k = Math.min(1, look.max / px);
    const size = px * k;
    const mid = l.path.len[l.path.len.length - 1] / 2;
    const letters: [number, number, number][] = l.at.map((a) =>
    {
        const [x, y, angle] = pointAt(l.path, mid + a * k);
        return [(x - view.x) / view.scale, (y - view.y) / view.scale, angle];
    });
    const r = size * 0.5;
    const boxes = letters.map(([x, y], i): [number, number, number, number] =>
    {
        const hw = Math.max((l.widths[i] * k) / view.scale / 2, r * 0.6) + 1;
        return [x - hw, y - r, x + hw, y + r];
    });

    if (!boxes.some((b) => b[2] > 0 && b[0] < w && b[3] > 0 && b[1] < h))
        return;

    if (boxes.some((b) => placed.hits(b[0], b[1], b[2], b[3])))
        return;

    for (const b of boxes)
        placed.add(b[0], b[1], b[2], b[3]);

    // (fading in as it grows past the smallest size)
    const alpha = look.alpha * Math.min(1, 0.35 + (px - look.min) / 6);
    ctx.font = font(size);
    ctx.lineWidth = Math.max(2, Math.min(5, size * 0.13));
    ctx.strokeStyle = `rgba(${look.stroke}, ${0.7 * alpha})`;
    ctx.fillStyle = `rgba(${look.fill}, ${0.96 * alpha})`;
    const dpr = window.devicePixelRatio || 1;

    for (const pass of [0, 1])
    {
        letters.forEach(([x, y, angle], i) =>
        {
            const cos = Math.cos(angle) * dpr;
            const sin = Math.sin(angle) * dpr;
            ctx.setTransform(cos, sin, -sin, cos, x * dpr, y * dpr);

            if (pass === 0)
                ctx.strokeText(l.chars[i], 0, 0);
            else
                ctx.fillText(l.chars[i], 0, 0);
        });
    }
}

/** the mean area of a mode's groups */
function meanArea(groups: Groups): number
{
    let a = 0;

    for (const g of groups.bySize)
        a += groups.area[g];

    return a / Math.max(1, groups.bySize.length);
}

/**
 * The names of the mode's groups (when it has them), then of the counties and baronies smaller than its groups: the
 * biggest first, overlapping ones left out. On the paper map in ink, else light with a dark rim.
 */
export function drawLabels(canvas: HTMLCanvasElement, view: View, info: MapInfo, groups: Groups, style: Style = 'terrain'): void
{
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr))
    {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }

    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const ids = rasterOf(info);

    if (!ids)
        return;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    let tiers = titleTiers.get(info);

    if (!tiers)
    {
        tiers = ['c', 'b'].filter((t) => info.titles.some((x) => x.tier === t)).map((t) => groupsOf(info, t));
        titleTiers.set(info, tiers);
    }

    const size = meanArea(groups);
    const shown: [Groups, number][] = [...(groups.labels ? [[groups, 0] as [Groups, number]] : []), ...tiers.map((t, i): [Groups, number] => [t, i + 1]).filter(([t]) => size > meanArea(t) * 1.5)];
    const looks = LOOKS[style === 'paper' ? 'ink' : 'light'];
    const placed = new Boxes();

    for (const [gs, tier] of shown)
    {
        let cache = layouts.get(gs);

        if (!cache)
            layouts.set(gs, cache = new Map());

        for (const g of gs.bySize)
        {
            if (Math.sqrt(gs.area[g]) / view.scale < looks[tier].min * 2)
                break;

            const b = g * 4;

            if ((gs.box[b + 2] - view.x) / view.scale < 0 || (gs.box[b] - view.x) / view.scale > w || (gs.box[b + 3] - view.y) / view.scale < 0 || (gs.box[b + 1] - view.y) / view.scale > h)
                continue;

            let labels = cache.get(g);

            if (!labels)
            {
                const name = gs.name(g);
                // (a barony named as its county — the county's capital — has its name there already)
                const parent = tier && info.titles[g].tier === 'b' ? info.titles[info.titles[g].parent] : undefined;
                const named = !!name && parent?.name !== name;
                const shape = `${named ? name : ''}|${gs.area[g]}|${gs.cx[g]}|${gs.cy[g]}|${gs.box.subarray(b, b + 4).join(',')}`;
                labels = byShape.get(shape);

                if (!labels)
                {
                    labels = named ? labelPaths(ids, info.width, info.height, gs, g).map((p) => layout(p, name)) : [];

                    if (byShape.size >= SHAPES_KEPT)
                        byShape.clear();

                    byShape.set(shape, labels);
                }

                cache.set(g, labels);
            }

            for (const l of labels)
                place(ctx, l, view, w, h, placed, looks[tier]);
        }
    }
}
