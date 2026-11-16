/**
 * The GUI tab's preview (docs/gui-designer.md, stage 2): a definition expanded (expand.ts) and laid out (layout.ts) as
 * plain data for the renderer: a box per widget with where it is written, the widgets with a bound `visible` to switch.
 * Widget ids are their order in the expanded tree, so the renderer's switched-off ids stay valid while the files don't
 * change (the expansion is cached per definition and dropped with the library).
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import type { GuiBlock, GuiBox, GuiFontFiles, GuiKind, GuiLayoutOptions, GuiLayoutView, GuiMask, GuiPaint, GuiPlace, GuiProp, GuiTextStyle, GuiToggle } from '../../shared/api.ts';
import type { GameFiles } from '../mods/gamefiles.ts';
import { GuiText } from './text.ts';
import { GuiExpander, type XNode } from './expand.ts';
import { anchor, GuiLayout, type LBox } from './layout.ts';
import type { GuiLibrary } from './library.ts';

/** the game's screen the preview lays out on (the owner's reference: 2560x1440, UI scale 100%) */
const SCREEN = { w: 2560, h: 1440 };

interface Expanded
{
    root: XNode;
    ids: Map<XNode, number>;
    byId: XNode[];
    /** widgets hidden unless switched on: alternatives the game shows one at a time (alternativesOf) */
    alt: Set<XNode>;
}

const boundVisible = (n: XNode): string | undefined =>
{
    const v = n.children?.findLast((c) => c.key === 'visible' && c.value !== undefined)?.value;
    return v?.startsWith('[') ? v.replace(/\s+/g, '') : undefined;
};

/**
 * Widgets the game shows one at a time, hidden by default (all drawn at once they cover each other: the tournament
 * window's two headers, its before / after panels, a portrait's 36 status icons): `Not(X)` beside a sibling `X`; among
 * bound siblings of the same kind (vbox, icon, …), all but the first.
 */
function alternativesOf(root: XNode): Set<XNode>
{
    const alt = new Set<XNode>();
    const walk = (n: XNode): void =>
    {
        const kids = (n.children ?? []).filter((c) => c.kind);
        const bound = kids.filter((c) => boundVisible(c));
        const conds = new Set(bound.map((c) => boundVisible(c)!));

        for (const c of bound)
        {
            const not = /^\[Not\((.*)\)\]$/.exec(boundVisible(c)!);

            if (not && conds.has('[' + not[1] + ']'))
                alt.add(c);
        }

        if (bound.length >= 2)
        {
            // (by the engine's kind: two headers, two panels, a stack of status icons, not a header and the content)
            const firstOf = new Map<string, XNode>();

            for (const c of bound)
            {
                const group = c.kind!;

                if (!firstOf.has(group) && !alt.has(c))
                    firstOf.set(group, c);
                else if (firstOf.get(group) !== c)
                    alt.add(c);
            }
        }

        for (const c of n.children ?? [])
            walk(c);
    };
    walk(root);
    return alt;
}

const cache = new WeakMap<GuiLibrary, { x: GuiExpander; trees: Map<string, Expanded>; text?: GuiText; }>();

function expanded(lib: GuiLibrary, kind: GuiKind, name: string): Expanded | undefined
{
    let c = cache.get(lib);

    if (!c)
        cache.set(lib, c = { x: new GuiExpander(lib), trees: new Map() });

    const k = kind + ':' + name;
    let t = c.trees.get(k);

    if (!t)
    {
        const e = lib.defs(kind, name)[0];
        const root = e && c.x.expand(e);

        if (!root)
            return undefined;

        t = { root, ids: new Map(), byId: [], alt: alternativesOf(root) };
        const walk = (n: XNode): void =>
        {
            if (n.kind)
            {
                t!.ids.set(n, t!.byId.length);
                t!.byId.push(n);
            }

            for (const ch of n.children ?? [])
                walk(ch);
        };
        walk(root);
        c.trees.set(k, t);
    }

    return t;
}

const prop = (n: XNode, key: string): string | undefined => n.children?.findLast((c) => c.key === key && c.value !== undefined)?.value;

/** `spriteborder = { 18 0 }` → numbers */
function list(n: XNode, key: string): number[] | undefined
{
    const b = n.children?.findLast((c) => c.key === key && c.children);
    const v = b?.children?.filter((c) => c.value !== undefined && !c.key).map((c) => parseFloat(c.value!));
    return v && v.length && v.every((x) => Number.isFinite(x)) ? v : undefined;
}

function num(v: string | undefined): number | undefined
{
    const x = v === undefined ? NaN : parseFloat(v);
    return Number.isFinite(x) ? x : undefined;
}

/** A texture's drawing: `n` a widget with `texture` or a `background` block; `w` × `h` the widget's box. */
function paintOf(n: XNode, w: number, h: number, isBackground: boolean): GuiPaint | undefined
{
    const tex = prop(n, 'texture');

    if (!tex)
        return undefined;

    const p: GuiPaint = { x: 0, y: 0, w, h };

    if (tex.startsWith('['))
        p.bound = tex;
    else
        p.texture = tex;

    // a background's margin grows its rectangle (negative: inset; Window_Background's { -23 -17 } matches the screenshot)
    if (isBackground)
    {
        const m = list(n, 'margin');
        const l = num(prop(n, 'margin_left')) ?? m?.[0] ?? 0;
        const r = num(prop(n, 'margin_right')) ?? m?.[0] ?? 0;
        const t = num(prop(n, 'margin_top')) ?? m?.[1] ?? m?.[0] ?? 0;
        const b = num(prop(n, 'margin_bottom')) ?? m?.[1] ?? m?.[0] ?? 0;
        Object.assign(p, { x: -l, y: -t, w: w + l + r, h: h + t + b });
    }

    Object.assign(p, sprite(n));

    const fs = list(n, 'framesize');

    if (fs && fs.length >= 2)
    {
        // (a button shows its `upframe` when nothing happens to it)
        const k = num(prop(n, 'upframe')) ?? num(prop(n, 'frame')) ?? 1;
        p.frame = { w: fs[0], h: fs[1], n: Math.max(1, k) };
    }

    const a = num(prop(n, 'alpha'));

    if (a !== undefined && a !== 1)
        p.alpha = a;

    const mirror = prop(n, 'mirror');

    if (mirror)
        p.mirror = mirror;

    const fit = prop(n, 'fittype');

    if (fit)
        p.fit = fit;

    const color = list(n, 'tintcolor') ?? list(n, 'color');

    if (color && color.length >= 3)
        p.color = [color[0], color[1], color[2], color[3] ?? 1];

    // masks: `modify_texture` with blend_mode alphamultiply: one at partial alpha only lessens the cut, left out
    const masks: GuiMask[] = [];

    for (const c of n.children ?? [])
    {
        const t = c.key === 'modify_texture' && c.children ? prop(c, 'texture') : undefined;

        if (t && !t.startsWith('[') && prop(c, 'blend_mode')?.toLowerCase() === 'alphamultiply' && (num(prop(c, 'alpha')) ?? 1) >= 1)
            masks.push({ texture: t, ...sprite(c) });
    }

    if (masks.length)
        p.masks = masks;

    return p;
}

/** `spriteType = Corneredtiled` + `spriteborder` + `texture_density` of a texture or a mask. */
function sprite(n: XNode): { sprite?: 'tiled' | 'stretched'; border?: [number, number, number, number]; density?: number; }
{
    const out: { sprite?: 'tiled' | 'stretched'; border?: [number, number, number, number]; density?: number; } = {};
    const st = prop(n, 'spriteType')?.toLowerCase();

    if (st === 'corneredtiled' || st === 'corneredstretched')
    {
        out.sprite = st === 'corneredtiled' ? 'tiled' : 'stretched';
        const sb = list(n, 'spriteborder');
        const x = sb?.[0] ?? 0;
        const y = sb?.[1] ?? x;
        out.border = [num(prop(n, 'spriteborder_left')) ?? x, num(prop(n, 'spriteborder_top')) ?? y, num(prop(n, 'spriteborder_right')) ?? x, num(prop(n, 'spriteborder_bottom')) ?? y];
    }

    const d = num(prop(n, 'texture_density'));

    if (d && d !== 1)
        out.density = d;

    return out;
}

/** What a widget draws: its backgrounds, then its own texture: a progressbar its bar, a portrait or coat of arms a stand-in. */
function paintsOf(n: XNode, w: number, h: number): GuiPaint[]
{
    const out: GuiPaint[] = [];

    for (const c of n.children ?? [])
        if (c.key === 'background' && c.children && !c.kind)
        {
            const p = paintOf(c, w, h, true);

            if (p)
                out.push(p);
        }

    // a portrait (portrait_button: the character's, from the game's data): a silhouette
    if (n.kind === 'portrait_button')
    {
        out.push({ x: 0, y: 0, w, h, stand: 'portrait' });
        return out;
    }

    // a coat of arms (an icon drawn by coatofarmsgfx from the game's data): a sample shield cut by its mask
    if (prop(n, 'gfxtype') === 'coatofarmsgfx')
    {
        const mask = prop(n, 'coat_of_arms_mask');
        out.push({ x: 0, y: 0, w, h, stand: 'coa', ...(mask && !mask.startsWith('[') ? { mask } : {}) });
        return out;
    }

    // a progressbar: the empty bar, the full one over it to its value (a bound value: 60 %)
    if (n.kind === 'progressbar' && prop(n, 'progresstexture'))
    {
        const base = { ...n, children: (n.children ?? []).map((c) => (c.key === 'noprogresstexture' ? { ...c, key: 'texture' } : c.key === 'texture' ? { ...c, key: '_texture' } : c)) };
        const full = { ...n, children: (n.children ?? []).map((c) => (c.key === 'progresstexture' ? { ...c, key: 'texture' } : c.key === 'texture' ? { ...c, key: '_texture' } : c)) };
        const empty = paintOf(base, w, h, false);
        const bar = paintOf(full, w, h, false);
        const v = num(prop(n, 'value'));
        const min = num(prop(n, 'min')) ?? 0;
        const max = num(prop(n, 'max')) ?? 100;
        const part = v === undefined ? 0.6 : Math.max(0, Math.min(1, (v - min) / (max - min || 1)));

        if (empty)
            out.push(empty);

        if (bar)
            out.push({ ...bar, fill: { part, ...(prop(n, 'direction') === 'vertical' ? { vertical: true } : {}) } });

        return out;
    }

    const own = paintOf(n, w, h, false);

    if (own)
        out.push(own);

    return out;
}

/** kinds that place their children themselves (`position` does nothing in them) */
const PLACING = new Set(['hbox', 'vbox', 'flowcontainer', 'dynamicgridbox', 'fixedgridbox', 'overlappingitembox']);

/** How a widget moves and resizes on the canvas (GuiPlace). */
function placeOf(n: XNode, parentKind: string | undefined): GuiPlace
{
    const pa = prop(n, 'parentanchor');
    const wa = anchor(prop(n, 'widgetanchor') ?? pa);
    const p: GuiPlace = { wa };

    if (parentKind && PLACING.has(parentKind))
        p.inBox = true;

    const ps = prop(n, 'position');

    if (!ps?.startsWith('['))
    {
        const v = list(n, 'position');
        p.pos = [v?.[0] ?? 0, v?.[1] ?? 0];
    }

    if (prop(n, 'size')?.startsWith('['))
        p.boundSize = true;

    return p;
}

/** blocks that are not properties of the grid (drawn or run, edited in the source) */
const NOT_PROPS = new Set(['background', 'state', 'modify_texture', 'tooltipwidget', 'block', 'blockoverride']);

/** A widget's properties: scalars and lists, its own (written in its statement) first, then those from its types. */
function propsOf(n: XNode): GuiProp[]
{
    const out: GuiProp[] = [];

    for (const c of n.children ?? [])
    {
        if (c.kind || !c.key || NOT_PROPS.has(c.key))
            continue;

        const list = !!c.children?.length && c.children.every((x) => x.value !== undefined && !x.key);

        if (c.value === undefined && !list)
            continue;

        const value = c.value !== undefined ? (c.quoted ? JSON.stringify(c.value) : c.value) : `{ ${c.children!.map((x) => x.value).join(' ')} }`;
        // (written in the statement itself: the same file and the same chain of what brought it in)
        const own = c.file === n.file && c.via.length === n.via.length;
        const p: GuiProp = { key: c.key, value, own };

        if (!own)
            p.from = c.via.slice(n.via.length).join(' › ') || `${c.file.rel}:${c.line}`;

        out.push(p);
    }

    return out.sort((a, b) => Number(b.own) - Number(a.own));
}

/** property blocks a widget can have (others with keyed statements are listed too; `tooltipwidget` is built when shown) */
const NOT_BLOCKS = new Set(['tooltipwidget', 'block', 'blockoverride']);

/** A widget's (or a block's) property blocks, its own first: each with where it is written, its properties and inner blocks. */
function blocksOf(n: XNode): GuiBlock[]
{
    const out: GuiBlock[] = [];

    for (const c of n.children ?? [])
    {
        // (a block: keyed statements inside, or none; a list like `size = { 100 30 }` is a property)
        if (c.kind || !c.key || !c.children || NOT_BLOCKS.has(c.key) || (c.children.length && c.children.every((x) => x.value !== undefined && !x.key)))
            continue;

        const own = c.file === n.file && c.via.length === n.via.length;
        const b: GuiBlock = { key: c.key, file: c.file.rel, where: c.file.where, line: c.line, own, props: propsOf(c), blocks: blocksOf(c) };

        if (c.file.mod)
            b.mod = c.file.mod;

        if (!own)
            b.from = c.via.slice(n.via.length).join(' › ') || `${c.file.rel}:${c.line}`;

        const name = prop(c, 'name');

        if (name)
            b.name = name;

        out.push(b);
    }

    return out.sort((a, b) => Number(b.own) - Number(a.own));
}

/** A textbox's (or a button's) text style: font, size, alignment, `default_format` over `fontcolor`, padding, eliding. */
function textStyleOf(n: XNode, texts: GuiText, box?: { w: number; text: string; }): GuiTextStyle
{
    const s: GuiTextStyle = { size: num(prop(n, 'fontsize')) ?? 14 };

    // the textbox's margin: padding around the text (`margin = { x y }`, then `margin_left` …)
    const m = list(n, 'margin');
    const pad: [number, number, number, number] = [
        num(prop(n, 'margin_top')) ?? m?.[1] ?? m?.[0] ?? 0,
        num(prop(n, 'margin_right')) ?? m?.[0] ?? 0,
        num(prop(n, 'margin_bottom')) ?? m?.[1] ?? m?.[0] ?? 0,
        num(prop(n, 'margin_left')) ?? m?.[0] ?? 0
    ];

    if (pad.some((x) => x))
        s.pad = pad;

    // (only a text of a fixed width is cut: an autoresized one grows to its text in the game; the layout's measure of
    // it is rough, eliding there would cut what the game shows whole)
    const elide = prop(n, 'elide');

    if (elide && prop(n, 'autoresize') !== 'yes')
        s.elide = elide;

    // a single line too long for its box shrinks toward `fontsize_min` (the layout's measure: half the size a character)
    const min = num(prop(n, 'fontsize_min'));

    if (box && min && min < s.size && prop(n, 'multiline') !== 'yes')
    {
        const room = box.w - pad[1] - pad[3];
        const need = box.text.length * s.size * 0.5;

        if (need > room && room > 0)
            s.size = Math.max(min, Math.floor((s.size * room) / need));
    }

    const font = prop(n, 'font');

    if (font)
        s.font = font;

    const align = prop(n, 'align');

    if (align)
        s.align = align;

    const fc = list(n, 'fontcolor');

    if (fc && fc.length >= 3)
        s.color = [fc[0], fc[1], fc[2]];

    const f = texts.style(prop(n, 'default_format'));

    if (f.color)
        s.color = f.color;

    if (f.italic)
        s.italic = true;

    if (f.bold)
        s.bold = true;

    if (prop(n, 'multiline') === 'yes')
        s.multiline = true;

    return s;
}

export function guiLayout(lib: GuiLibrary, vfs: GameFiles, idx: GameIndex, kind: GuiKind, name: string, hidden: number[], opts: GuiLayoutOptions = {}): GuiLayoutView | null
{
    const t = expanded(lib, kind, name);

    if (!t)
        return null;

    const c = cache.get(lib)!;
    const texts = (c.text ??= new GuiText(lib, vfs));
    const fonts: Record<string, GuiFontFiles> = {};

    // switched off: the alternatives hidden by default and those switched off, less those switched on
    const on = new Set((opts.shown ?? []).map((i) => t.byId[i]).filter((n) => n));
    const off = new Set([...t.alt, ...hidden.map((i) => t.byId[i]).filter((n) => n)].filter((n) => !on.has(n)));
    const samples = new Map<XNode, string>();

    for (const [id, text] of Object.entries(opts.samples ?? {}))
        if (t.byId[Number(id)])
            samples.set(t.byId[Number(id)], text);

    const lay = new GuiLayout({ screen: SCREEN, hidden: off, text: (k) => idx.locRaw(k), samples, rows: opts.rows });
    const root = lay.layout(t.root);

    const bounds = { x: root.x, y: root.y, r: root.x + root.w, b: root.y + root.h };
    const view = (b: LBox, parentKind?: string): GuiBox =>
    {
        bounds.x = Math.min(bounds.x, b.x);
        bounds.y = Math.min(bounds.y, b.y);
        bounds.r = Math.max(bounds.r, b.x + b.w);
        bounds.b = Math.max(bounds.b, b.y + b.h);
        const n = b.node;
        const g: GuiBox = { id: t.ids.get(n) ?? -1, key: n.key, kind: b.kind, x: b.x, y: b.y, w: b.w, h: b.h, file: n.file.rel, where: n.file.where, line: n.line, children: b.children.map((c) => view(c, b.kind)) };
        g.place = placeOf(n, parentKind);

        if (b.name)
            g.name = b.name;

        if (n.types && n.types.length)
            g.types = n.types;

        if (n.via.length)
            g.via = n.via;

        if (b.text)
            g.text = b.text;

        if (b.clip)
            g.clip = true;

        if (b.sample)
            g.sample = true;

        if (b.notes.length)
            g.notes = b.notes;

        const v = prop(n, 'visible');

        if (v?.startsWith('['))
            g.visible = v;

        const tv = prop(n, 'text') ?? prop(n, 'raw_text');

        if (g.text !== undefined && tv?.startsWith('['))
            g.bound = tv;

        if (n.file.mod)
            g.mod = n.file.mod;

        const props = propsOf(n);

        if (props.length)
            g.props = props;

        const blocks = blocksOf(n);

        if (blocks.length)
            g.blocks = blocks;

        const paint = paintsOf(n, b.w, b.h);

        if (paint.length)
            g.paint = paint;

        // (a button's text is drawn by its `buttonText` textbox; layout.ts gives it the button's text)
        if (g.text !== undefined)
        {
            g.textStyle = textStyleOf(n, texts, { w: b.w, text: g.text });

            // (inline formats, text icons, data, concepts, keys, breaks: in runs)
            if (b.raw && /[#@[$]|\\n/.test(b.raw))
                g.runs = texts.runs(b.raw, (k) => idx.locRaw(k));

            const f = g.textStyle.font ?? 'StandardGameFont';
            const files = texts.fonts.get(f);

            if (files)
                fonts[f] = files;
        }

        return g;
    };
    const box = view(root);

    // every widget with a bound `visible` (also those switched off, which have no box)
    const toggles: GuiToggle[] = [];

    t.byId.forEach((n, id) =>
    {
        const v = prop(n, 'visible');

        if (v?.startsWith('['))
            toggles.push({ id, label: prop(n, 'name') ?? n.key, visible: v, line: n.line, file: n.file.rel, off: off.has(n), ...(t.alt.has(n) ? { alt: true } : {}) });
    });

    return { root: box, bounds: { x: bounds.x, y: bounds.y, w: bounds.r - bounds.x, h: bounds.b - bounds.y }, screen: SCREEN, toggles, fonts };
}
