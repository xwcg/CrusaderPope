/**
 * Readings shared by the presentation cards (cards/presentation.ts): comments beside statements, colours, pictures and
 * sounds, settings lines, "the first that fits" entries, the entries naming another by a key.
 */
import type { PNode } from '../../indexer/parser.ts';
import type { Entity } from '../../indexer/gameIndex.ts';
import type { Line, Rich, RichSeg, SectionSource } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import { fieldOf } from '../../../shared/fieldCatalog.ts';
import { capitalize, humanize, rich, titleCase } from '../text.ts';

/** The statements of a block (none for a scalar). */
export const kids = (n: PNode | undefined): PNode[] => (n && Array.isArray(n.v) ? n.v : []);

/** A scalar statement's value. */
export function str(list: PNode[], k: string): string | undefined
{
    const c = list.find((x) => x.k === k);
    return typeof c?.v === 'string' ? c.v : undefined;
}

/** The bare values of a list block (`{ a b c }`). */
export function values(n: PNode | undefined): string[]
{
    return kids(n)
        .filter((x) => x.k === null && typeof x.v === 'string')
        .map((x) => x.v as string);
}

/** "a, b and c" */
export function join(parts: (RichSeg | Rich)[], last = ' and '): Rich
{
    return rich(...parts.flatMap((p, i) => (i ? [i === parts.length - 1 ? last : ', ', p] : [p])));
}

/** A name read as words: `ce_lion_rampant` → "Lion rampant" (`strip`: a prefix to drop). */
export function words(name: string, strip?: RegExp): string
{
    return capitalize(humanize(
        name.replace(/^.*\//, '')
            .replace(/\.\w+$/, '')
            .replace(strip ?? /^$/, '')
    ));
}

/** Placeholder segment (italic): a comment, a derived note. */
export const note = (text: string, tip?: string): RichSeg => ({ text, kind: 'ph', tip });

/**
 * The comment at the end of a statement's line (`LAG_PAUSE_DAYS = 30 # how many days …`); for a block, the one after
 * its `{` (`background = { # Nomads`). Nothing when another statement stands between.
 */
export function lineComment(src: string, n: PNode): string | undefined
{
    const from = Array.isArray(n.v) ? n.vs + 1 : n.e;
    const eol = src.indexOf('\n', from);
    const m = /^\s*#+\s*(.*?)\s*$/.exec(src.slice(from, eol < 0 ? src.length : eol));
    return m?.[1] || undefined;
}

/** The comment lines right above a statement (`# Random range for number of characters per pool …`). */
export function commentAbove(src: string, n: PNode): string | undefined
{
    let pos = n.s;

    while (pos > 0 && src.charCodeAt(pos - 1) !== 10)
        pos--;

    const lines: string[] = [];
    pos--;

    while (pos > 0 && lines.length < 12)
    {
        let ls = pos;

        while (ls > 0 && src.charCodeAt(ls - 1) !== 10)
            ls--;

        const line = src.slice(ls, pos).trim();

        if (!line.startsWith('#'))
            break;

        lines.unshift(line.replace(/^#+\s?/, ''));
        pos = ls - 1;
    }

    const text = lines.filter((l) => !/^[#=\-*\s]*$/.test(l)).join(' ');
    return text || undefined;
}

// ---------------------------------------------------------------------------
// Pictures, sounds, colours
// ---------------------------------------------------------------------------

/** A picture named in script (game path or bare file name) as a link to the image; a video or a missing file as its name. */
export function pictureSeg(b: StoryBuilder, path: string, type: string, strip?: RegExp): RichSeg
{
    const img = /\.(dds|png|tga)$/i.test(path) ? b.idx.resolveImagePath(path, type) : undefined;
    const text = words(path, strip);
    return img ? { text, kind: 'entity', ref: { type: img.type, name: img.name }, tip: img.name } : { text, kind: 'code', tip: path };
}

/** A sound event (`event:/SFX/Events/Themes/sfx_event_theme_type_martial`) by its last part: "Martial". */
export function soundSeg(path: string): RichSeg
{
    return { text: words(path, /^sfx_(event_theme_type_)?/i), kind: 'code', tip: path };
}

/** A value written as a file constant (`@generic_event_theme_sound`) read as what it stands for. */
export function constant(b: StoryBuilder, e: Entity, v: string): string
{
    return v.startsWith('@') ? (b.idx.fileConstants(e).get(v.slice(1)) ?? v) : v;
}

const HUES: [number, string][] = [
    [15, 'red'],
    [40, 'orange'],
    [65, 'yellow'],
    [80, 'lime'],
    [160, 'green'],
    [190, 'teal'],
    [215, 'sky blue'],
    [255, 'blue'],
    [285, 'purple'],
    [330, 'magenta'],
    [360, 'red']
];

/**
 * A colour block as 0–255 RGB: `rgb { r g b }` and untagged `{ r g b }` (0–1, or 0–255 when a value is above 1; a 4th
 * value is alpha), `hsv { h s v }` (0–1), `hsv360 { h s v }` (0–360 and 0–100), `hex { rrggbb }`.
 */
function colorRgb(n: PNode): [number, number, number] | undefined
{
    const nums = values(n);

    if (n.tag === 'hex')
    {
        const h = /([0-9a-f]{6})/i.exec(nums[0] ?? '')?.[1];
        return h ? [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)] : undefined;
    }

    const v = nums.map(Number);

    if (v.length < 3 || v.slice(0, 3).some((x) => !Number.isFinite(x)))
        return undefined;

    if (n.tag === 'hsv' || n.tag === 'hsv360')
    {
        const [h, s, l] = n.tag === 'hsv360' ? [v[0] / 360, v[1] / 100, v[2] / 100] : v;
        const f = (k: number): number =>
        {
            const x = (k + h * 6) % 6;
            return l - l * s * Math.max(0, Math.min(x, 4 - x, 1));
        };
        return [f(5), f(3), f(1)].map((x) => Math.round(x * 255)) as [number, number, number];
    }

    const scale = v.slice(0, 3).some((x) => x > 1) ? 1 : 255;
    return v.slice(0, 3).map((x) => Math.round(Math.min(255, Math.max(0, x * scale)))) as [number, number, number];
}

/** "dark red", "light grey" — a rough name for a colour. */
function colorName(rgb: [number, number, number]): string
{
    const [r, g, b] = rgb.map((x) => x / 255);
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    const s = max ? d / max : 0;

    if (max < 0.16)
        return 'black';

    const shade = max < 0.45 ? 'dark ' : max > 0.85 && s < 0.5 ? 'light ' : '';

    if (s < 0.15)
        return max > 0.85 ? 'white' : shade + 'grey';

    const h = ((max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
    const hue = HUES.find(([top]) => h < top)![1];
    // (dark orange reads brown)
    return hue === 'orange' && max < 0.6 ? 'brown' : shade + hue;
}

/** A colour as "#cc3333 (dark red)", the written block in its tip. */
export function colorText(n: PNode, src: string): Rich | undefined
{
    const rgb = colorRgb(n);

    if (!rgb)
        return undefined;

    const hex = '#' + rgb.map((x) => x.toString(16).padStart(2, '0')).join('');
    return rich({ text: hex, kind: 'color', tip: src.slice(n.vs - (n.tag ? n.tag.length + 1 : 0), n.e) }, ` (${colorName(rgb)})`);
}

// ---------------------------------------------------------------------------
// Settings, members, entries of which the first that fits is used
// ---------------------------------------------------------------------------

/**
 * A definition's scalar settings as lines — how each field of the set reads (shared/fields/presentation.ts; an entry
 * it names as a link), "Key: value" for others; `show` reads a key its own way (a picture, a text) —, anchored as
 * fields of `set` (changed and added with the picker).
 */
export function settingLines(b: StoryBuilder, set: string, list: PNode[], ctx: Ctx, show?: (k: string, v: string) => Rich | undefined): Line[]
{
    const out: Line[] = [];

    for (const c of list)
    {
        if (!c.k || typeof c.v !== 'string')
            continue;

        const f = fieldOf(set, c.k);
        let text = show?.(c.k, c.v);

        if (!text && f?.kind === 'ref' && typeof f.read === 'string')
        {
            const [before, after] = f.read.split('$');
            text = rich(capitalize(before), b.d.ref(c.v, f.ref ? [f.ref] : undefined), after);
        }

        if (!text)
        {
            out.push(...b.fieldLines(set, [c], ctx));
            continue;
        }

        const l: Line = { text, tip: `${c.k} = ${c.v}` };

        if (ctx.file)
            l.src = b.fieldAnchor(c, ctx, set);

        out.push(l);
    }

    return out;
}

const scans = new WeakMap<StoryBuilder, Map<string, Map<string, Entity[]>>>();

/**
 * The entries of `type` whose definition says `key = <value>` at its top level, by value (decisions by
 * `decision_group_type`, interactions by `category`, concepts by `parent`): one pass over the type's texts per story
 * builder — a new one comes with every index update. For links the index does not make (the groups are context-only
 * types without a context rule).
 */
export function membersBy(b: StoryBuilder, type: string, key: string): Map<string, Entity[]>
{
    let all = scans.get(b);

    if (!all)
        scans.set(b, all = new Map());

    const id = `${type} ${key}`;
    let m = all.get(id);

    if (m)
        return m;

    m = new Map();
    all.set(id, m);
    const re = new RegExp(`${key}\\s*=\\s*"?([\\w.:-]+)`, 'y');

    for (const name of b.idx.names(type))
    {
        const e = b.idx.get(type, name);
        const d = e && b.idx.winningDef(e);

        if (!e || !d)
            continue;

        const text = b.idx.readFile(d.file);
        let depth = 0;

        for (let i = d.start; i < d.end; i++)
        {
            const c = text.charCodeAt(i);

            if (c === 35)
            {
                // (a comment to its line's end)
                i = text.indexOf('\n', i);

                if (i < 0)
                    break;
            }
            else if (c === 34)
                i = Math.max(i, text.indexOf('"', i + 1));
            else if (c === 123)
                depth++;
            else if (c === 125)
                depth--;
            else if (depth === 1 && c === key.charCodeAt(0) && !/\w/.test(text[i - 1]))
            {
                re.lastIndex = i;
                const r = re.exec(text);

                if (!r)
                    continue;

                const l = m.get(r[1]);

                if (l)
                    l.push(e);
                else
                    m.set(r[1], [e]);

                i = re.lastIndex - 1;
            }
        }
    }

    return m;
}

/** Entries as linked lines, at most `max` (then "… and N more"); names that repeat get their key read as words. */
export function entryLines(b: StoryBuilder, list: Entity[], icon?: string, max = 40): Line[]
{
    const segs = list.slice(0, max).map((x) => b.d.entitySeg(x) as Exclude<RichSeg, string>);
    const twice = new Set(segs.filter((s, i) => segs.findIndex((o) => o.text === s.text) !== i).map((s) => s.text));
    const out: Line[] = segs.map((s, i) => ({ text: twice.has(s.text) ? [s, ' ', note(`(${humanize(list[i].name)})`)] : [s], icon }));

    if (list.length > max)
        out.push({ text: [`… and ${list.length - max} more`] });

    return out;
}

/**
 * Where conditions of an entry go ("＋ if"): its `trigger` block, or — none yet — where one is made (before its first
 * statement).
 */
function triggerPlace(b: StoryBuilder, n: PNode, ctx: Ctx): SectionSource | undefined
{
    const t = kids(n).find((c) => c.k === 'trigger' && Array.isArray(c.v));
    const scope = ctx.scopeType ? { scope: ctx.scopeType } : {};

    if (t)
    {
        const src = b.d.anchor(t, ctx, 'trigger', true);
        return src && { src, key: 'trigger', kind: 'trigger', ...scope };
    }

    const first = kids(n).find((c) => c.k);
    const before = first && b.d.anchor(first, ctx, 'other', false);
    const parent = b.d.anchor(n, ctx, 'other', true);

    if (!before && !parent)
        return undefined;

    return { ...(before ? { before } : { parent }), key: 'trigger', kind: 'trigger', ...scope };
}

/**
 * Entries of which the game uses the first whose `trigger` passes (event backgrounds, a theme's icons and sounds,
 * customizable localization texts; `random`: one of those that pass): one line each — `show` gives its text and
 * details —, the trigger as its conditions; an unconditional entry after conditional ones reads "Otherwise:".
 * Anchored to the entry's block.
 */
export function firstValidLines(b: StoryBuilder, entries: PNode[], ctx: Ctx, show: (list: PNode[]) => { text: Rich; children?: Line[]; tip?: string; }, random = false): Line[]
{
    let conditional = false;
    return entries.map((n) =>
    {
        const list = kids(n);
        const t = list.find((c) => c.k === 'trigger');
        const conds = t && Array.isArray(t.v) ? b.d.triggers(t.v, ctx) : [];
        const s = show(list);
        const label = lineComment(ctx.src, n);
        // (at random every entry that passes can be picked: none is the others' fallback)
        const l: Line = { text: rich(!conds.length && conditional && !random ? 'Otherwise: ' : '', s.text, label ? rich(' ', note(`— ${label}`)) : ''), icon: conds.length ? 'if' : 'note', tip: s.tip };

        if (conds.length)
        {
            conditional = true;
            l.conditions = conds;
        }

        if (s.children?.length)
        {
            l.children = s.children;
            l.collapsed = true;
        }

        if (ctx.file)
        {
            l.src = b.d.anchor(n, ctx, 'other', true);
            l.limitSrc = triggerPlace(b, n, ctx);
        }

        return l;
    });
}

/** A key read as a title: `NCharacterOpinion` → "Character Opinion", `NAI` → "AI", `hair_color` → "Hair Color". */
export function keyTitle(k: string): string
{
    const s = k.replace(/^N(?=[A-Z])/, '');
    return /^[A-Z]+$/.test(s) ? s : titleCase(humanize(s));
}
