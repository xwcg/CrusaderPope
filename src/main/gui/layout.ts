/**
 * The layout engine (docs/gui-designer.md, stage 2): an expanded window (expand.ts) given positions and sizes as the game
 * lays it out: boxes only, nothing drawn. Two passes like Qt's box layouts, which the game's keys follow
 * (`layoutpolicy_*` fixed / preferred / expanding / growing / shrinking): a preferred size bottom-up (`hint`), then the
 * space handed out top-down (`place`).
 *
 * Rules are derived from the game's files and checked by eye against screenshots only; each assumption is named where it
 * is made (ASSUMED) and listed in docs/gui-designer.md ("Layout rules").
 */
import type { XNode } from './expand.ts';
import { plainText, sampleFor } from './text.ts';

import { tr } from '../../shared/i18n.ts';
export interface LBox
{
    node: XNode;
    /** the engine's kind (vbox, icon, textbox …) */
    kind: string;
    name?: string;
    /** on screen, in pixels at UI scale 100% */
    x: number;
    y: number;
    w: number;
    h: number;
    children: LBox[];
    /** a textbox's text as shown (a binding as its function name) */
    text?: string;
    /** the text before its markup was taken out (formats, icons, data): the preview's runs */
    raw?: string;
    /** a box whose children are cut at its edges (a scroll area) */
    clip?: boolean;
    /** a row of a list drawn once as a sample (the game draws one per item of its data) */
    sample?: boolean;
    /** what the layout could not know: a size or position from a binding, an unknown constant */
    notes: string[];
}

export interface LayoutOptions
{
    /** the screen (the game's at UI scale 100%) */
    screen: { w: number; h: number; };
    /** widgets switched off (bound `visible`): no box, no space in boxes */
    hidden?: Set<XNode>;
    /** a text key's text */
    text?: (key: string) => string | undefined;
    /** a bound text's sample, typed by the user (else sampleFor) */
    samples?: Map<XNode, string>;
    /** how many rows a bound list (`datamodel` + `item`) shows (default 3) */
    rows?: number;
}

type Policy = 'fixed' | 'preferred' | 'expanding' | 'growing' | 'shrinking';
interface Size
{
    w: number;
    h: number;
}

const BOXES = new Set(['hbox', 'vbox']);
const GRIDS = new Set(['dynamicgridbox', 'fixedgridbox']);
/** kinds whose `item` is repeated for every row of their data (a dropDown's items are its menu: not drawn) */
const LISTS = new Set(['hbox', 'vbox', 'flowcontainer', 'dynamicgridbox', 'fixedgridbox', 'overlappingitembox', 'widget', 'container']);
/** ASSUMED: a text without a size of its own: the game's default font size */
const DEFAULT_FONT = 14;

// -- reading properties --

function prop(n: XNode, key: string): string | undefined
{
    let v: string | undefined;

    for (const c of n.children ?? [])
        if (c.key === key && c.value !== undefined)
            v = c.value;

    return v;
}

function blockOf(n: XNode, key: string): XNode | undefined
{
    return n.children?.find((c) => c.key === key && !c.kind && c.children);
}

/** `size = { 100 30 }` → ['100', '30'] */
function pair(n: XNode, key: string): [string, string] | undefined
{
    const b = blockOf(n, key);
    const v = b?.children?.filter((c) => c.value !== undefined && !c.key).map((c) => c.value!);
    return v && v.length >= 2 ? [v[0], v[1]] : undefined;
}

/** a number, a percentage of `ref`; undefined for a binding, `-1` (no size: from the content) or what can't be read */
function num(v: string | undefined, ref?: number): number | undefined
{
    if (v === undefined)
        return undefined;

    if (v.endsWith('%'))
        return ref === undefined ? undefined : (ref * parseFloat(v)) / 100;

    const x = parseFloat(v);
    return Number.isFinite(x) && x >= 0 ? x : undefined;
}

/** a signed number (positions, margins) */
function snum(v: string | undefined, ref?: number): number | undefined
{
    if (v === undefined)
        return undefined;

    if (v.endsWith('%'))
        return ref === undefined ? undefined : (ref * parseFloat(v)) / 100;

    const x = parseFloat(v);
    return Number.isFinite(x) ? x : undefined;
}

const bound = (v: string | undefined): boolean => !!v && v.startsWith('[');

function policy(n: XNode, axis: 'h' | 'v'): Policy
{
    const v = prop(n, axis === 'h' ? 'layoutpolicy_horizontal' : 'layoutpolicy_vertical')?.toLowerCase();
    // ASSUMED: without a policy a widget keeps its size in a box (the files write growing / expanding where they mean it)
    return v === 'preferred' || v === 'expanding' || v === 'growing' || v === 'shrinking' ? v : 'fixed';
}

interface Edges
{
    l: number;
    r: number;
    t: number;
    b: number;
}

/** `margin = { x y }` then `margin_left` … (the later wins) */
function margins(n: XNode): Edges
{
    const m: Edges = { l: 0, r: 0, t: 0, b: 0 };

    for (const c of n.children ?? [])
    {
        if (c.key === 'margin' && c.children)
        {
            const v = c.children.filter((x) => x.value !== undefined && !x.key).map((x) => snum(x.value) ?? 0);
            m.l = m.r = v[0] ?? 0;
            m.t = m.b = v[1] ?? v[0] ?? 0;
        }
        else if (c.key === 'margin' && c.value !== undefined)
            m.l =
                m.r =
                m.t =
                m.b =
                    snum(c.value) ?? 0;
        else if (c.key === 'margin_left')
            m.l = snum(c.value) ?? 0;
        else if (c.key === 'margin_right')
            m.r = snum(c.value) ?? 0;
        else if (c.key === 'margin_top')
            m.t = snum(c.value) ?? 0;
        else if (c.key === 'margin_bottom')
            m.b = snum(c.value) ?? 0;
    }

    return m;
}

/** `top|right` → fractions of the width and height (left/top 0, center 0.5, right/bottom 1) */
export function anchor(v: string | undefined): [number, number]
{
    let x = 0;
    let y = 0;

    for (const p of (v ?? '').toLowerCase().split('|'))
    {
        if (p === 'center')
            x = y = 0.5;
        else if (p === 'hcenter')
            x = 0.5;
        else if (p === 'vcenter')
            y = 0.5;
        else if (p === 'right')
            x = 1;
        else if (p === 'bottom')
            y = 1;
    }

    return [x, y];
}

export class GuiLayout
{
    private hints = new Map<XNode, Size>();
    /** a button's `buttonText` textbox: the button's `text` it shows */
    private given = new Map<XNode, string>();
    private opts: LayoutOptions;

    constructor(opts: LayoutOptions)
    {
        this.opts = opts;
    }

    /** A window or widget on the screen: where its `parentanchor` / `position` put it, at its size. */
    layout(root: XNode): LBox
    {
        const { w, h } = this.opts.screen;
        return this.anchored(root, { x: 0, y: 0, w, h });
    }

    private shown(n: XNode): boolean
    {
        return !this.opts.hidden?.has(n) && prop(n, 'visible') !== 'no';
    }

    /** The widgets directly inside (not those in a property block: a scroll area's content, a tooltip); a list's item once per sample row. */
    private kids(n: XNode): XNode[]
    {
        // (a window inside another, the character window's filter windows, is a popup of its own: previewed on its own)
        return [...(n.children ?? []).filter((c) => c.kind && c.kind !== 'window' && this.shown(c)), ...this.rowsOf(n)];
    }

    /** A bound list's `item` widgets, `rows` times (stage 4: sample rows; the game makes one per item of its data). */
    private rowsOf(n: XNode): XNode[]
    {
        if (!LISTS.has(n.kind!) || GRIDS.has(n.kind!))
            return [];

        const item = this.slot(n, 'item');
        const out: XNode[] = [];

        for (let i = 0; i < (item.length ? this.opts.rows ?? 3 : 0); i++)
            out.push(...item);

        return out;
    }

    /** a widget that is a list's item (its boxes are samples) */
    private isItem(parent: XNode, k: XNode): boolean
    {
        return this.slot(parent, 'item').includes(k);
    }

    /** The widgets in a property block (`scrollwidget`, `item`, `scrollbar_vertical`). */
    private slot(n: XNode, key: string): XNode[]
    {
        return (blockOf(n, key)?.children ?? []).filter((c) => c.kind && this.shown(c));
    }

    // -- pass 1: preferred sizes --

    /** The explicit size, a percentage of the parent's (undefined where it comes from the content). */
    private ownSize(n: XNode, parent?: Size): { w?: number; h?: number; }
    {
        const s = pair(n, 'size');
        const w = num(s?.[0], parent?.w) ?? num(prop(n, 'width'), parent?.w);
        const h = num(s?.[1], parent?.h) ?? num(prop(n, 'height'), parent?.h);
        return { w, h };
    }

    private clamp(n: XNode, s: Size, parent?: Size): Size
    {
        const min = pair(n, 'minimumsize');
        const max = pair(n, 'maximumsize');
        let { w, h } = s;
        w = Math.max(w, num(min?.[0], parent?.w) ?? 0, num(prop(n, 'min_width'), parent?.w) ?? 0);
        h = Math.max(h, num(min?.[1], parent?.h) ?? 0);
        const mw = Math.min(num(max?.[0], parent?.w) ?? Infinity, num(prop(n, 'max_width'), parent?.w) ?? Infinity);
        const mh = num(max?.[1], parent?.h) ?? Infinity;
        return { w: Math.min(w, mw), h: Math.min(h, mh) };
    }

    /** The preferred size: its own where it has one, else from its content; `parent` for percentages. */
    hint(n: XNode, parent?: Size): Size
    {
        const known = this.hints.get(n);

        if (known && !parent)
            return known;

        const own = this.ownSize(n, parent);
        let s: Size;

        // a text that resizes to its text: the size written is where it starts (`size = { 0 23 }`)
        if (prop(n, 'autoresize') === 'yes' && (n.kind === 'textbox' || n.kind === 'editbox'))
        {
            const multi = prop(n, 'multiline') === 'yes';
            // a multiline text wraps at its maximum width (`max_width`, `maximumsize`), else the width its parent gives,
            // at least its `minimumsize`: the written size is only where it starts (text_multi's `{ 45 45 }`)
            const wrap = multi ? this.wrapWidth(n, parent) : undefined;
            const c = this.content(n, { w: parent?.w ?? 0, h: parent?.h ?? 0 }, wrap);
            s = { w: c.w, h: c.h };
        }
        else if (own.w !== undefined && own.h !== undefined)
            s = { w: own.w, h: own.h };
        else
        {
            const c = this.content(n, { w: own.w ?? parent?.w ?? 0, h: own.h ?? parent?.h ?? 0 }, own.w);
            s = { w: own.w ?? c.w, h: own.h ?? c.h };
        }

        s = this.clamp(n, s, parent);

        if (!parent)
            this.hints.set(n, s);

        return s;
    }

    /** The width an autoresized multiline text wraps at (see hint). */
    private wrapWidth(n: XNode, parent?: Size): number | undefined
    {
        const max = [num(prop(n, 'max_width'), parent?.w), num(pair(n, 'maximumsize')?.[0], parent?.w)].filter((x): x is number => x !== undefined && x > 0);
        let w = max.length ? Math.min(...max) : parent?.w || undefined;
        const min = num(pair(n, 'minimumsize')?.[0], parent?.w);

        if (min !== undefined && (w === undefined || w < min))
            w = min;

        return w;
    }

    /** The size the content asks for. `wrap`: a fixed width a text wraps in. */
    private content(n: XNode, ref: Size, wrap?: number): Size
    {
        const m = margins(n);
        const kind = n.kind!;

        if (BOXES.has(kind) || kind === 'flowcontainer')
        {
            const along = kind === 'vbox' || (kind === 'flowcontainer' && prop(n, 'direction') === 'vertical') ? 'h' : 'w';
            const cross = along === 'w' ? 'h' : 'w';
            const kids = this.kids(n);
            const spacing = snum(prop(n, 'spacing')) ?? 0;
            const inner = { w: ref.w - m.l - m.r, h: ref.h - m.t - m.b };
            let main = 0;
            let other = 0;

            for (const k of kids)
            {
                const s = this.hint(k, inner);
                main += s[along];
                other = Math.max(other, s[cross]);
            }

            main += Math.max(0, kids.length - 1) * spacing;
            const s = along === 'w' ? { w: main, h: other } : { w: other, h: main };
            return { w: s.w + m.l + m.r, h: s.h + m.t + m.b };
        }

        if (kind === 'textbox' || kind === 'editbox')
        {
            const t = this.textOf(n);
            const font = num(prop(n, 'fontsize')) ?? DEFAULT_FONT;
            // ASSUMED: an average character half the font size wide, a line 1.3 font sizes high
            const width = t.length * font * 0.5;
            const multi = prop(n, 'multiline') === 'yes';
            const maxw = wrap ?? num(prop(n, 'max_width'));

            if (multi && maxw)
            {
                const lines = Math.max(1, Math.ceil(width / Math.max(1, maxw - m.l - m.r)));
                return { w: Math.min(width + m.l + m.r, maxw), h: lines * font * 1.3 + m.t + m.b };
            }

            return { w: width + m.l + m.r, h: font * 1.3 + m.t + m.b };
        }

        if (kind === 'container' || kind === 'button_group')
        {
            // as big as what is in it (positions from the top left; a button_group: the decision window's checkbox row
            // takes its height in the column: the screenshot's buttons sit 30 px higher than without it)
            let w = 0;
            let h = 0;

            for (const k of this.kids(n))
            {
                const s = this.hint(k);
                const p = pair(k, 'position');
                w = Math.max(w, (snum(p?.[0]) ?? 0) + s.w);
                h = Math.max(h, (snum(p?.[1]) ?? 0) + s.h);
            }

            return { w, h };
        }

        if (GRIDS.has(kind))
        {
            const g = this.gridShape(n, ref);
            return { w: g.cols * g.cell.w, h: g.rows * g.cell.h };
        }

        // a widget, icon, button … without a size: nothing of its own (its children may stand out of it)
        return { w: 0, h: 0 };
    }

    private textOf(n: XNode): string
    {
        return plainText(this.rawTextOf(n));
    }

    /** A textbox's text as the game has it: typed sample, bound sample, the text key's text, or the text itself. */
    rawTextOf(n: XNode): string
    {
        const v = prop(n, 'text') ?? prop(n, 'raw_text') ?? this.given.get(n);

        if (!v)
            return '';

        const typed = this.opts.samples?.get(n);

        if (typed !== undefined)
            return typed;

        if (bound(v))
            return sampleFor(v, this.opts.text);

        // (a text key's text, its `$key$`s looked up once, measured as the runs show it)
        const t = this.opts.text?.(v) ?? v;
        return t.replace(/\$(\w+)\$/g, (m, k: string) => this.opts.text?.(k) ?? m);
    }

    // -- pass 2: placing --

    /** A widget placed by its anchors inside a rectangle (a plain widget's children, a window on the screen). */
    private anchored(n: XNode, r: { x: number; y: number; w: number; h: number; }): LBox
    {
        const notes: string[] = [];
        const own = this.ownSize(n, r);
        const hint = this.hint(n, r);
        // ASSUMED: an hbox / vbox without a size in a plain widget takes the parent's (the decision window's column reaches
        // its bottom edge: the buttons sit there)
        const fills = BOXES.has(n.kind!) && !pair(n, 'size');
        // (a text that resizes to its text: its preferred size, not the written one it starts from)
        const auto = prop(n, 'autoresize') === 'yes' && (n.kind === 'textbox' || n.kind === 'editbox');
        const w = auto ? hint.w : (own.w ?? (fills ? r.w : hint.w));
        const h = auto ? hint.h : (own.h ?? (fills ? r.h : hint.h));
        const pa = prop(n, 'parentanchor');
        // the widget's own anchor is its parent anchor unless written (a frame `parentanchor = bottom` sits inside the bottom edge)
        const wa = prop(n, 'widgetanchor') ?? pa;
        const pos = pair(n, 'position');
        const ps = prop(n, 'position');

        if (bound(ps))
            notes.push(tr('position from ') + ps);

        if (bound(prop(n, 'size')))
            notes.push(tr('size from ') + prop(n, 'size'));

        const [px, py] = anchor(pa);
        const [wx, wy] = anchor(wa);
        const x = r.x + px * r.w + (snum(pos?.[0], r.w) ?? 0) - wx * w;
        const y = r.y + py * r.h + (snum(pos?.[1], r.h) ?? 0) - wy * h;
        return this.place(n, x, y, w, h, notes);
    }

    /** A widget at its place and size: its children laid out inside. */
    private place(n: XNode, x: number, y: number, w: number, h: number, notes: string[] = []): LBox
    {
        const box: LBox = { node: n, kind: n.kind!, name: prop(n, 'name'), x, y, w, h, children: [], notes };
        const kind = n.kind!;

        if (kind === 'textbox' || kind === 'editbox')
        {
            box.text = this.textOf(n).trim();
            box.raw = this.rawTextOf(n);
        }

        if (BOXES.has(kind))
            box.children = this.boxed(n, x, y, w, h, kind === 'hbox' ? 'w' : 'h');
        else if (kind === 'flowcontainer')
            box.children = this.flow(n, x, y, w, h);
        else if (kind === 'scrollarea')
        {
            box.clip = true;
            box.children = this.scrolled(n, x, y, w, h);
        }
        else if (GRIDS.has(kind))
            box.children = this.grid(n, x, y, w, h);
        else if (kind === 'scrollbar')
            box.children = this.scrollbar(n, x, y, w, h);
        else if (kind === 'overlappingitembox')
            box.children = this.overlapping(n, x, y, w, h);
        else if (kind === 'dropDown')
        {
            // closed: its `active_item` (the chosen entry) in its box; the `list` (the open menu) is not drawn
            box.children = [...this.kids(n), ...this.slot(n, 'active_item')].map((k) => this.anchored(k, { x, y, w, h }));
        }
        else
        {
            const m = kind === 'margin_widget' ? margins(n) : { l: 0, r: 0, t: 0, b: 0 };
            const inner = { x: x + m.l, y: y + m.t, w: w - m.l - m.r, h: h - m.t - m.b };
            box.children = this.kids(n).map((k) => this.anchored(k, inner));

            // a button's text: its `buttonText` slot (a textbox) set with the button's `text`
            const label = prop(n, 'text') ?? prop(n, 'raw_text');

            for (const k of this.slot(n, 'buttonText'))
            {
                if (label && !prop(k, 'text') && !prop(k, 'raw_text'))
                    this.given.set(k, label);

                box.children.push(this.anchored(k, inner));
            }
        }

        // (a list's rows are samples)
        for (const c of box.children)
            if (this.isItem(n, c.node))
                c.sample = true;

        return box;
    }

    /** hbox / vbox: along the main axis by preferred size and policy, across filled or centred. */
    private boxed(n: XNode, x: number, y: number, w: number, h: number, along: 'w' | 'h'): LBox[]
    {
        const m = margins(n);
        const inner = { x: x + m.l, y: y + m.t, w: w - m.l - m.r, h: h - m.t - m.b };
        const cross = along === 'w' ? 'h' : 'w';
        const axis = along === 'w' ? 'h' : 'v';
        const crossAxis = along === 'w' ? 'v' : 'h';
        const kids = this.kids(n);
        const spacing = snum(prop(n, 'spacing')) ?? 0;
        const sizes = kids.map((k) => this.hint(k, inner)[along]);
        const pol = kids.map((k) => policy(k, axis));
        let extra = inner[along] - sizes.reduce((a, b) => a + b, 0) - Math.max(0, kids.length - 1) * spacing;

        if (extra > 0)
        {
            // expanding first; else growing / preferred
            let takers = kids.map((_, i) => i).filter((i) => pol[i] === 'expanding');

            if (!takers.length)
                takers = kids.map((_, i) => i).filter((i) => pol[i] === 'growing' || pol[i] === 'preferred');

            if (takers.length)
            {
                // (stretch factors: `layoutstretchfactor_*`, default 1)
                const f = takers.map((i) => num(prop(kids[i], along === 'w' ? 'layoutstretchfactor_horizontal' : 'layoutstretchfactor_vertical')) || 1);
                const sum = f.reduce((a, b) => a + b, 0);
                takers.forEach((i, j) =>
                {
                    const max = this.clampMax(kids[i], along, inner);
                    sizes[i] = Math.min(max, sizes[i] + (extra * f[j]) / sum);
                });
                extra = inner[along] - sizes.reduce((a, b) => a + b, 0) - Math.max(0, kids.length - 1) * spacing;
            }
        }
        else if (extra < 0)
        {
            // ASSUMED: only a `shrinking` child gives up space; others keep their size and the content overflows (squeezing
            // them squashed a panel to nothing where the game shows one of two alternatives: tournament_contest_information)
            const takers = kids.map((_, i) => i).filter((i) => pol[i] === 'shrinking');
            const room = takers.reduce((a, i) => a + sizes[i], 0);

            if (room > 0)
            {
                for (const i of takers)
                    sizes[i] = Math.max(0, sizes[i] + (extra * sizes[i]) / room);
            }

            extra = 0;
        }

        // ASSUMED: space nobody takes goes around the items (the files end a column with `expand = { }` to push it up)
        let at = inner[along === 'w' ? 'x' : 'y'] + Math.max(0, extra) / 2;
        const out: LBox[] = [];

        kids.forEach((k, i) =>
        {
            const hint = this.hint(k, inner);
            const fill = policy(k, crossAxis) !== 'fixed';
            const c = fill ? Math.min(inner[cross], this.clampMax(k, cross, inner)) : hint[cross];
            // across: at the side its parentanchor names, else centred
            const [ax, ay] = prop(k, 'parentanchor') ? anchor(prop(k, 'parentanchor')) : [0.5, 0.5];
            const f = cross === 'w' ? ax : ay;
            const start = inner[cross === 'w' ? 'x' : 'y'] + (inner[cross] - c) * f;
            out.push(along === 'w' ? this.place(k, at, start, sizes[i], c) : this.place(k, start, at, c, sizes[i]));
            at += sizes[i] + spacing;
        });

        return out;
    }

    private clampMax(n: XNode, along: 'w' | 'h', parent: Size): number
    {
        const max = pair(n, 'maximumsize');
        const v = along === 'w' ? Math.min(num(max?.[0], parent.w) ?? Infinity, num(prop(n, 'max_width'), parent.w) ?? Infinity) : (num(max?.[1], parent.h) ?? Infinity);
        return v;
    }

    /** flowcontainer: one after the other at their preferred sizes (horizontal unless `direction = vertical`). */
    private flow(n: XNode, x: number, y: number, w: number, h: number): LBox[]
    {
        const m = margins(n);
        const vertical = prop(n, 'direction') === 'vertical';
        const spacing = snum(prop(n, 'spacing')) ?? 0;
        const inner = { w: w - m.l - m.r, h: h - m.t - m.b };
        let at = vertical ? y + m.t : x + m.l;
        const out: LBox[] = [];

        for (const k of this.kids(n))
        {
            const s = this.hint(k, inner);
            const [ax, ay] = anchor(prop(k, 'parentanchor'));
            out.push(vertical ? this.place(k, x + m.l + (inner.w - s.w) * ax, at, s.w, s.h) : this.place(k, at, y + m.t + (inner.h - s.h) * ay, s.w, s.h));
            at += (vertical ? s.h : s.w) + spacing;
        }

        return out;
    }

    /** scrollarea: the content (`scrollwidget`) at the area's width, as high as it asks; the vertical scrollbar at the right. */
    private scrolled(n: XNode, x: number, y: number, w: number, h: number): LBox[]
    {
        const out: LBox[] = [];
        const bar = this.slot(n, 'scrollbar_vertical')[0];
        const policyV = prop(n, 'scrollbarpolicy_vertical') ?? 'as_needed';
        const barW = bar ? this.hint(bar).w : 0;
        const content = this.slot(n, 'scrollwidget');
        let tall = 0;

        for (const k of content)
        {
            const s = this.hint(k, { w, h });
            tall = Math.max(tall, s.h);
        }

        const showBar = !!bar && policyV !== 'always_off' && (policyV === 'always_on' || tall > h);
        const cw = w - (showBar ? barW : 0);

        for (const k of content)
        {
            const s = this.hint(k, { w: cw, h });
            // (the content fills the width; at least the area's height when it grows)
            const kh = policy(k, 'v') === 'fixed' ? s.h : Math.max(s.h, h);
            out.push(this.place(k, x, y, policy(k, 'h') === 'fixed' ? s.w : cw, kh));
        }

        if (showBar)
            out.push(this.place(bar, x + w - barW, y, barW, h));

        // (widgets written straight into the area, beside its scrollwidget: a fade, an overlay, one just added)
        for (const k of this.kids(n))
            out.push(this.anchored(k, { x, y, w, h }));

        return out;
    }

    /** dynamicgridbox / fixedgridbox: the item once, as a sample (the game draws one per row of its data). */
    /**
     * scrollbar: its `dec_button` at the start, `inc_button` at the end (at their own sizes), the `track` between them, the
     * `slider` at the track's start, along `direction` (vertical unless horizontal).
     */
    private scrollbar(n: XNode, x: number, y: number, w: number, h: number): LBox[]
    {
        const vertical = prop(n, 'direction') !== 'horizontal';
        const out: LBox[] = [];
        const one = (key: string): XNode | undefined => this.slot(n, key)[0];
        const dec = one('dec_button');
        const inc = one('inc_button');
        const ds = dec ? this.hint(dec, { w, h }) : { w: 0, h: 0 };
        const is = inc ? this.hint(inc, { w, h }) : { w: 0, h: 0 };
        // (the track and the slider: between the buttons)
        const t0 = vertical ? y + ds.h : x + ds.w;
        const len = Math.max(0, vertical ? h - ds.h - is.h : w - ds.w - is.w);

        if (dec)
            out.push(vertical ? this.place(dec, x, y, w, ds.h) : this.place(dec, x, y, ds.w, h));

        const track = one('track');

        if (track)
            out.push(vertical ? this.place(track, x, t0, w, len) : this.place(track, t0, y, len, h));

        const slider = one('slider');

        if (slider)
        {
            const ss = this.hint(slider, { w, h });
            const sl = Math.min(len, vertical ? ss.h || len / 3 : ss.w || len / 3);
            out.push(vertical ? this.place(slider, x, t0, w, sl) : this.place(slider, t0, y, sl, h));
        }

        if (inc)
            out.push(vertical ? this.place(inc, x, y + h - is.h, w, is.h) : this.place(inc, x + w - is.w, y, is.w, h));

        return out;
    }

    /** overlappingitembox: its items side by side (`spacing`), pushed together to overlap when they don't fit (`righttoleft`). */
    private overlapping(n: XNode, x: number, y: number, w: number, h: number): LBox[]
    {
        const kids = this.kids(n);
        const sizes = kids.map((k) => this.hint(k, { w, h }));
        const spacing = snum(prop(n, 'spacing')) ?? 0;
        const total = sizes.reduce((a, s) => a + s.w, 0) + Math.max(0, kids.length - 1) * spacing;
        // (the step between items: their width and spacing, less when the row is wider than the box)
        const squeeze = kids.length > 1 && total > w ? (total - w) / (kids.length - 1) : 0;
        const rtl = prop(n, 'righttoleft') === 'yes';
        let at = rtl ? x + w : x;
        const out: LBox[] = [];

        kids.forEach((k, i) =>
        {
            const s = sizes[i];

            if (rtl)
                at -= s.w;

            out.push(this.place(k, at, y + (h - s.h) / 2, s.w, s.h));
            at += rtl ? -(spacing - squeeze) : s.w + spacing - squeeze;
        });

        return out;
    }

    /**
     * A grid's sample rows: the cell (fixedgridbox: `addcolumn` × `addrow`; dynamicgridbox: the item's size), how many go
     * in a line before the next (`datamodel_wrap`, else `maxhorizontalslots` / `maxverticalslots`), across first with
     * `flipdirection = yes`, else down first. ASSUMED from the files (no screenshot of a grid yet).
     */
    private gridShape(n: XNode, ref: Size): { cell: Size; cols: number; rows: number; flip: boolean; count: number; wrap: number; }
    {
        const item = this.slot(n, 'item')[0];
        const count = item ? this.opts.rows ?? 3 : 0;
        const cell = n.kind === 'fixedgridbox' ? { w: num(prop(n, 'addcolumn'), ref.w) ?? 0, h: num(prop(n, 'addrow'), ref.h) ?? 0 } : item ? this.hint(item, ref) : { w: 0, h: 0 };
        const flip = prop(n, 'flipdirection') === 'yes';
        const wrap = Math.max(1, num(prop(n, 'datamodel_wrap')) ?? num(prop(n, flip ? 'maxhorizontalslots' : 'maxverticalslots')) ?? Infinity);
        const lines = Math.ceil(count / wrap);
        const along = Math.min(count, wrap);
        return { cell, flip, count, wrap, cols: count ? (flip ? along : lines) : 0, rows: count ? (flip ? lines : along) : 0 };
    }

    private grid(n: XNode, x: number, y: number, w: number, h: number): LBox[]
    {
        const item = this.slot(n, 'item')[0];

        if (!item)
            return [];

        const g = this.gridShape(n, { w, h });
        const out: LBox[] = [];

        for (let i = 0; i < g.count; i++)
        {
            const a = i % g.wrap;
            const b = Math.floor(i / g.wrap);
            const [col, row] = g.flip ? [a, b] : [b, a];
            const own = this.ownSize(item, g.cell);
            const box = this.place(item, x + col * g.cell.w, y + row * g.cell.h, own.w ?? g.cell.w, own.h ?? g.cell.h);
            box.sample = true;
            out.push(box);
        }

        return out;
    }
}

/** A laid-out tree as text (kind, name, x y w h) for checks and the CLI. */
export function ltext(b: LBox, indent = ''): string[]
{
    const r = (v: number): number => Math.round(v);
    const lines = [`${indent}${b.node.key}${b.name ? ' "' + b.name + '"' : ''}  ${r(b.x)},${r(b.y)} ${r(b.w)}x${r(b.h)}${b.text ? '  «' + b.text + '»' : ''}${b.sample ? '  (sample)' : ''}${b.notes.length ? '  notes: ' + b.notes.join('; ') : ''}`];

    for (const c of b.children)
        lines.push(...ltext(c, indent + '  '));

    return lines;
}
