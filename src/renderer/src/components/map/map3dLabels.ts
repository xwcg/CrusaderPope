/**
 * The 3D map's names (docs/map.md, "3D map"), laid on the ground as the game's are: each group's name along a curve
 * through its shape (pres-shape.ts, as the 2D map), letters spaced out over most of it, sized in map pixels by the
 * group's thickness — so they grow and shrink with the zoom — and draped letter by letter: each letter drawn through
 * the affine map of the ground at its place (its baseline along the curve, its up across it; foreshortened with the
 * view, tilted with the slope), the curve walked the other way when it would read right to left on screen. As the
 * game (NMapName LARGE_NAMES_ZOOM_STEP), the mode's names show from that zoom step on and county names below it,
 * barony names below a third of it (when the mode's groups are bigger than theirs); a name shows between a smallest and a largest size on
 * screen, fading at both ends; the biggest first, overlapping letters left out. Letters come from an atlas drawn once
 * per style. Terrain: the game's near-black ink with a faint light rim (gfx/FX mapname.shader); paper: ink with a
 * halo; plain: light names with a dark rim.
 */
import * as THREE from 'three';
import type { MapInfo } from '../../../../shared/api';
import { groupsOf, type Groups, type Style } from './model';
import { labelPaths, type LabelPath } from './pres-shape';

const font = (px: number): string => `small-caps 600 ${px}px Georgia, 'Palatino Linotype', serif`;
/** the font size letters are drawn at in the atlas (then scaled by their ground transform) */
const F = 72;
/** a letter cell's height in the atlas, the padding around a letter */
const CELL_H = Math.ceil(F * 1.35);
const PAD = Math.ceil(F * 0.14);

/**
 * A tier's names — the mode's, counties', baronies': shown from `min` to `max` CSS pixels tall; `scale`: their size
 * against the 2D map's (smaller names for the lower tiers, which crowd the near views).
 */
interface Look
{
    min: number;
    max: number;
    alpha: number;
    scale: number;
}
const TIERS: Look[] = [
    { min: 9, max: 130, alpha: 0.92, scale: 1 },
    { min: 10, max: 60, alpha: 0.86, scale: 0.8 },
    { min: 11, max: 40, alpha: 0.8, scale: 0.75 }
];
/** fill and rim per style */
const INK: Record<Style, { fill: string; rim: string; }> = {
    terrain: { fill: 'rgb(36, 29, 28)', rim: 'rgba(214, 200, 186, 0.45)' },
    paper: { fill: 'rgb(44, 30, 18)', rim: 'rgba(240, 228, 200, 0.7)' },
    plain: { fill: 'rgb(247, 239, 219)', rim: 'rgba(22, 16, 10, 0.7)' }
};

/** What the names are drawn with: the camera, its zoom step, the zoom step of the large names, the ground's height. */
export interface LabelScene
{
    camera: THREE.PerspectiveCamera;
    zoom: number;
    largeNames: number;
    surface: (x: number, z: number) => number;
}

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

/** Letters drawn once (rim, then fill) into cells of a canvas: placing an image is much faster than drawing text. */
class Atlas
{
    readonly canvas = document.createElement('canvas');
    private ctx: CanvasRenderingContext2D;
    private cells = new Map<string, [number, number, number] | null>();
    private x = 0;
    private y = 0;

    constructor(ink: (typeof INK)[Style])
    {
        this.canvas.width = this.canvas.height = 2048;
        this.ctx = this.canvas.getContext('2d')!;
        this.ctx.font = font(F);
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.lineJoin = 'round';
        this.ctx.lineWidth = F * 0.13;
        this.ctx.strokeStyle = ink.rim;
        this.ctx.fillStyle = ink.fill;
    }

    /** A letter's cell: x, y (top left) and width; null when the atlas is full. */
    cell(ch: string): [number, number, number] | null
    {
        let c = this.cells.get(ch);

        if (c !== undefined)
            return c;

        const w = Math.ceil((width100(ch) * F) / 100) + PAD * 2;

        if (this.x + w > this.canvas.width)
        {
            this.x = 0;
            this.y += CELL_H;
        }

        c = this.y + CELL_H > this.canvas.height ? null : [this.x, this.y, w];

        if (c)
        {
            this.ctx.strokeText(ch, c[0] + w / 2, c[1] + CELL_H / 2);
            this.ctx.fillText(ch, c[0] + w / 2, c[1] + CELL_H / 2);
            this.x += w;
        }

        this.cells.set(ch, c);
        return c;
    }
}
const atlases = new Map<Style, Atlas>();

/**
 * A name on a path: as big as the part's thickness allows (× `scale`), letters spaced out over most of the path's
 * length (as labels.ts).
 */
function layout(path: LabelPath, text: string, scale: number): Label
{
    const chars = [...text];
    const w = chars.map(width100);
    const natural = w.reduce((a, b) => a + b, 0) / 100;
    const span = path.len[path.len.length - 1] * 0.86;
    const size = Math.min(path.thick * 0.6, span / natural) * scale;
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

/** The point and unit direction at an arc length along a path (map pixels). */
function pointAt(p: LabelPath, s: number): [number, number, number, number]
{
    const n = p.len.length;
    let i = 0;

    while (i < n - 2 && p.len[i + 1] < s)
        i++;

    const seg = p.len[i + 1] - p.len[i] || 1;
    const f = Math.max(0, Math.min(1, (s - p.len[i]) / seg));
    const dx = p.pts[i * 2 + 2] - p.pts[i * 2];
    const dy = p.pts[i * 2 + 3] - p.pts[i * 2 + 1];
    const l = Math.hypot(dx, dy) || 1;
    return [p.pts[i * 2] + dx * f, p.pts[i * 2 + 1] + dy * f, dx / l, dy / l];
}

/** Screen boxes of the letters drawn so far, in a grid of cells for quick overlap checks (as labels.ts). */
class Boxes
{
    private cells = new Map<number, number[]>();
    private boxes: number[] = [];
    private static CELL = 64;

    private keys(b: number[], fn: (k: number) => boolean | void): boolean
    {
        const c = Boxes.CELL;

        for (let j = Math.floor(b[1] / c); j <= Math.floor(b[3] / c); j++)
            for (let i = Math.floor(b[0] / c); i <= Math.floor(b[2] / c); i++)
                if (fn(j * 4096 + i))
                    return true;

        return false;
    }

    hits(b: number[]): boolean
    {
        return this.keys(b, (k) =>
        {
            for (const o of this.cells.get(k) ?? [])
                if (b[0] < this.boxes[o + 2] && b[2] > this.boxes[o] && b[1] < this.boxes[o + 3] && b[3] > this.boxes[o + 1])
                    return true;
        });
    }

    add(b: number[]): void
    {
        const o = this.boxes.length;
        this.boxes.push(b[0], b[1], b[2], b[3]);
        this.keys(b, (k) =>
        {
            const list = this.cells.get(k);

            if (list)
                list.push(o);
            else
                this.cells.set(k, [o]);
        });
    }
}

/** Projecting map points on the ground to the canvas (CSS pixels). */
class Ground
{
    private v = new THREE.Vector3();
    private ahead = new THREE.Vector3();
    private camera: THREE.PerspectiveCamera;
    private surface: (x: number, z: number) => number;
    private w: number;
    private h: number;
    /** CSS pixels per world unit at depth 1 */
    readonly k: number;

    constructor(scene: LabelScene, w: number, h: number)
    {
        this.camera = scene.camera;
        this.surface = scene.surface;
        this.w = w;
        this.h = h;
        this.camera.getWorldDirection(this.ahead);
        this.k = h / 2 / Math.tan((this.camera.fov * Math.PI) / 360);
    }

    /** The depth of a map point on the ground (≤ near: behind the eye). */
    depth(x: number, z: number): number
    {
        return this.v.set(x, this.surface(x, z), z)
            .sub(this.camera.position)
            .dot(this.ahead);
    }

    /** A map point on the ground on the canvas, or null behind the eye. */
    screen(x: number, z: number): [number, number] | null
    {
        if (this.depth(x, z) <= this.camera.near)
            return null;

        this.v.set(x, this.surface(x, z), z).project(this.camera);
        return [((this.v.x + 1) / 2) * this.w, ((1 - this.v.y) / 2) * this.h];
    }
}

/**
 * A name on the ground when its size on screen is in its tier's range, on screen and clear of the letters drawn
 * before: every letter's transform (the ground's affine map at the letter) and box, then the letters from the atlas.
 */
function place(ctx: CanvasRenderingContext2D, l: Label, ground: Ground, w: number, h: number, placed: Boxes, look: Look, atlas: Atlas, fade: number): void
{
    const mid = l.path.len[l.path.len.length - 1] / 2;
    const [mx, mz, tx, tz] = pointAt(l.path, mid);
    const depth = ground.depth(mx, mz);

    if (depth <= 0)
        return;

    const px = (l.size * ground.k) / depth;

    if (px < look.min || px > look.max * 1.25)
        return;

    const c = ground.screen(mx, mz);

    if (!c || c[0] < -w * 0.5 || c[0] > w * 1.5 || c[1] < -h * 0.5 || c[1] > h * 1.5)
        return;

    // (walk the curve the other way when it reads right to left on screen)
    const t = ground.screen(mx + tx * l.size, mz + tz * l.size);

    if (!t)
        return;

    const dir = t[0] >= c[0] ? 1 : -1;
    const unit = l.size / F;
    const letters: { m: number[]; box: number[]; cell: [number, number, number] | null; }[] = [];

    for (let i = 0; i < l.chars.length; i++)
    {
        const [x, z, ux, uz] = pointAt(l.path, mid + dir * l.at[i]);
        const dx = ux * dir;
        const dz = uz * dir;
        const e = l.widths[i] / 2 + l.size * 0.25;
        const s = ground.screen(x, z);
        // (along the baseline, and up — across the curve, to its left)
        const a = ground.screen(x + dx * e, z + dz * e);
        const b = ground.screen(x + dz * e, z - dx * e);

        if (!s || !a || !b)
            return;

        const ax = ((a[0] - s[0]) / e) * unit;
        const ay = ((a[1] - s[1]) / e) * unit;
        const bx = -((b[0] - s[0]) / e) * unit;
        const by = -((b[1] - s[1]) / e) * unit;
        // the letter's box (glyph ±half width, ±0.42 of the font size) through the transform
        const hw = (l.widths[i] / unit / 2) * 0.9;
        const hh = F * 0.42;
        const xs = [s[0] - ax * hw - bx * hh, s[0] + ax * hw - bx * hh, s[0] - ax * hw + bx * hh, s[0] + ax * hw + bx * hh];
        const ys = [s[1] - ay * hw - by * hh, s[1] + ay * hw - by * hh, s[1] - ay * hw + by * hh, s[1] + ay * hw + by * hh];
        letters.push({ m: [ax, ay, bx, by, s[0], s[1]], box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], cell: atlas.cell(l.chars[i]) });
    }

    if (!letters.some((q) => q.box[2] > 0 && q.box[0] < w && q.box[3] > 0 && q.box[1] < h))
        return;

    if (letters.some((q) => placed.hits(q.box)))
        return;

    for (const q of letters)
        placed.add(q.box);

    // (fading in from the smallest size, out towards the largest)
    ctx.globalAlpha = fade * look.alpha * Math.min(1, 0.35 + (px - look.min) / 6) * Math.min(1, Math.max(0, (look.max * 1.25 - px) / (look.max * 0.25)));
    const dpr = window.devicePixelRatio || 1;
    letters.forEach((q, i) =>
    {
        const [ax, ay, bx, by, sx, sy] = q.m;
        ctx.setTransform(ax * dpr, ay * dpr, bx * dpr, by * dpr, sx * dpr, sy * dpr);

        if (q.cell)
            ctx.drawImage(atlas.canvas, q.cell[0], q.cell[1], q.cell[2], CELL_H, -q.cell[2] / 2, -CELL_H / 2, q.cell[2], CELL_H);
        else
        {
            // (a full atlas: as text)
            ctx.font = font(F);
            ctx.fillText(l.chars[i], 0, 0);
        }
    });
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
 * The names of the mode's groups (when it has them), then of the counties and baronies smaller than its groups (below
 * the large names' zoom step): the biggest first, overlapping ones left out.
 */
export function drawLabels3d(canvas: HTMLCanvasElement, scene: LabelScene, info: MapInfo, ids: Uint16Array, groups: Groups, style: Style): void
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
    ctx.imageSmoothingQuality = 'high';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = INK[style].fill;
    let tiers = titleTiers.get(info);

    if (!tiers)
    {
        tiers = ['c', 'b'].filter((t) => info.titles.some((x) => x.tier === t)).map((t) => groupsOf(info, t));
        titleTiers.set(info, tiers);
    }

    const size = meanArea(groups);
    const smaller = tiers.map((t, i): [Groups, number] => [t, i + 1]).filter(([t]) => size > meanArea(t) * 1.5);
    // (the game: the large names from LARGE_NAMES_ZOOM_STEP on, the small ones below it — baronies' only within the
    // nearest third of that, fading over a step)
    const below = (step: number): number => Math.min(1, Math.max(0, step - scene.zoom));
    const large = smaller.length ? 1 - below(scene.largeNames) : 1;
    const fades = [below(scene.largeNames), below(scene.largeNames / 3)];
    const shown: [Groups, number, number][] = [
        ...(groups.labels ? [[groups, 0, large] as [Groups, number, number]] : []),
        ...smaller.map(([t, i]): [Groups, number, number] => [t, i, fades[i - 1]])
    ];
    const ground = new Ground(scene, w, h);
    const placed = new Boxes();
    let atlas = atlases.get(style);

    if (!atlas)
        atlases.set(style, atlas = new Atlas(INK[style]));

    for (const [gs, tier, fade] of shown)
    {
        if (fade <= 0)
            continue;

        let cache = layouts.get(gs);

        if (!cache)
            layouts.set(gs, cache = new Map());

        const look = TIERS[tier];

        for (const g of gs.bySize)
        {
            // (groups too small where they are on screen, or off it, are passed over before their shape is looked at)
            const depth = ground.depth(gs.cx[g], gs.cy[g]);

            if (depth <= scene.camera.near)
                continue;

            const r = (Math.sqrt(gs.area[g]) * ground.k) / depth;

            if (r < look.min * 2)
                continue;

            const c = ground.screen(gs.cx[g], gs.cy[g]);

            if (!c || c[0] < -r * 1.5 || c[0] > w + r * 1.5 || c[1] < -r * 1.5 || c[1] > h + r * 1.5)
                continue;

            let labels = cache.get(g);

            if (!labels)
            {
                const name = gs.name(g);
                // (a barony named as its county — the county's capital — has its name there already)
                const parent = tier && info.titles[g].tier === 'b' ? info.titles[info.titles[g].parent] : undefined;
                labels = name && parent?.name !== name ? labelPaths(ids, info.width, info.height, gs, g).map((p) => layout(p, name, look.scale)) : [];
                cache.set(g, labels);
            }

            for (const l of labels)
                place(ctx, l, ground, w, h, placed, look, atlas, fade);
        }
    }

    ctx.globalAlpha = 1;
}
