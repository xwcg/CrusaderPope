/** Readings shared by the culture, faith and dynasty cards (cards/culture.ts, culture-faith.ts, culture-dynasty.ts). */
import type { PNode } from '../../indexer/parser.ts';
import type { Entity } from '../../indexer/gameIndex.ts';
import type { CardSection, Line, Rich, RichSeg } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import { capitalize, formatNumber, humanize, locToRich, rich, signed, titleCase } from '../text.ts';
import { weightLines } from './weight.ts';

/** A scalar statement's value. */
export function scalar(list: PNode[], k: string): string | undefined
{
    const c = list.find((x) => x.k === k);
    return typeof c?.v === 'string' ? c.v : undefined;
}

/** A block statement's statements. */
export function block(list: PNode[], k: string): PNode[] | undefined
{
    const c = list.find((x) => x.k === k && Array.isArray(x.v));
    return c ? (c.v as PNode[]) : undefined;
}

/** Every scalar statement of a key that may repeat (`doctrine = a  doctrine = b`). */
export function scalars(list: PNode[], k: string): PNode[]
{
    return list.filter((x) => x.k === k && typeof x.v === 'string');
}

/** The bare values of a list block (`traditions = { a b c }`). */
export function items(n: PNode | PNode[] | undefined): PNode[]
{
    const list = Array.isArray(n) ? n : n && Array.isArray(n.v) ? n.v : [];
    return list.filter((x) => x.k === null && typeof x.v === 'string');
}

/** "a, b and c" */
export function joined(parts: (Rich | RichSeg)[], last = ' and '): Rich
{
    return rich(...parts.flatMap((p, i) => (i ? [i === parts.length - 1 ? last : ', ', p] : [p])));
}

/** The raw script of a statement (a line's tip): `key = value`, a list item, or the block as written. */
function tipOf(c: PNode, ctx: Ctx): string
{
    if (typeof c.v === 'string')
        return c.k ? `${c.k} = ${c.v}` : c.v;

    const t = ctx.src.slice(c.s, c.e);
    return t.length > 400 ? t.slice(0, 400) + '\n…' : t;
}

/**
 * A line read from one of the definition's own statements: anchored as a field of the set `fields` (shared/fields/
 * culture.ts — the picker changes it), else as a statement of its own ('other': a list item, a block).
 */
export function statementLine(b: StoryBuilder, c: PNode, ctx: Ctx, text: Rich, fields?: string, extra: Partial<Line> = {}): Line
{
    const l: Line = { text, tip: tipOf(c, ctx), ...extra };
    const src = fields ? b.fieldAnchor(c, ctx, fields, Array.isArray(c.v)) : b.d.anchor(c, ctx, 'other', false);

    if (src)
        l.src = src;

    return l;
}

/** A loc key as plain text (a name, a word; data functions as "…"), else the key made readable. */
export function word(b: StoryBuilder, key: string): string
{
    return b.idx.plainLoc(key)
        ?.replace(/\[[^\]]*\]/g, '…')
        .trim() || titleCase(humanize(key));
}

/** A dynasty name part (loc keys `dynn_Pommern`, prefix `dynnp_von` → "von "), else the key made readable. */
export function dynastyWord(b: StoryBuilder, key: string): string
{
    return b.idx.plainLoc(key) ?? key.replace(/^dynnp?_/, '').replace(/_/g, ' ') + (key.startsWith('dynnp_') ? ' ' : '');
}

/** A DLC feature flag (`requires_dlc_flag = roads_to_power`) made readable. */
export function dlcName(flag: string): string
{
    return titleCase(humanize(flag));
}

/** AI weight blocks (`ai_will_do`, `ai_weight_for_fascination` … by label) as one compact section, read by cards/weight.ts. */
export function aiSection(b: StoryBuilder, body: PNode[], ctx: Ctx, labels: Record<string, string>): CardSection | undefined
{
    const lines = body
        .filter((c) => c.k && labels[c.k] && Array.isArray(c.v))
        .map((c) =>
        {
            const l: Line = { text: [labels[c.k!]], icon: 'chance', children: weightLines(b, c.v as PNode[], ctx), tip: c.k! };
            const src = b.fieldAnchor(c, ctx, 'script_value', true);

            if (src)
                l.src = src;

            return l;
        });
    return lines.length ? { title: 'AI', lines } : undefined;
}

/** Up to `n` names, then "and N more". */
export function sample(names: string[], n = 12): string
{
    return names.length > n ? `${names.slice(0, n).join(', ')} … and ${names.length - n} more` : names.join(', ');
}

/** A date written `862.1.1` → "1 January 862" (a bare year stays a year). */
export function dateText(v: string): string
{
    const [y, m, d] = v.split('.').map(Number);

    if (!m)
        return String(y);

    const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1] ?? String(m);
    return d ? `${d} ${month} ${y}` : `${month} ${y}`;
}

/** The winning definition's statements of an entry. */
export function bodyOf(b: StoryBuilder, e: Entity | undefined): PNode[]
{
    const d = e && b.idx.defNode(e);
    return d && Array.isArray(d.node.v) ? d.node.v : [];
}

/**
 * A colour: a named colour (common/named_colors) as a link, `{ r g b }` (0–1, or 0–255 when a part is above 1),
 * `rgb { }`, `hsv { h s v }` (0–1), `hsv360 { h s v }` (0–360, 0–100) as #rrggbb.
 */
export function colorSeg(b: StoryBuilder, c: PNode): RichSeg
{
    if (typeof c.v === 'string')
    {
        const named = b.idx.get('named_colors', c.v);
        return named ? b.d.entitySeg(named) : { text: c.v, kind: 'value', tip: `${c.k} = ${c.v}` };
    }

    const n = items(c.v).map((x) => parseFloat(x.v as string));
    const tip = `${c.k} = ${c.tag ? c.tag + ' ' : ''}{ ${n.join(' ')} }`;

    if (n.length < 3 || n.some(Number.isNaN))
        return { text: tip, kind: 'value' };

    let rgb: number[];

    if (c.tag === 'hsv' || c.tag === 'hsv360')
    {
        const [h, s, v] = c.tag === 'hsv360' ? [n[0] / 360, n[1] / 100, n[2] / 100] : n;
        const f = (k: number): number => v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
        rgb = [f((5 + h * 6) % 6), f((3 + h * 6) % 6), f((1 + h * 6) % 6)];
    }
    else
        rgb = n.slice(0, 3).some((x) => x > 1) ? n.slice(0, 3).map((x) => x / 255) : n.slice(0, 3);

    return {
        text: '#' + rgb.map((x) =>
            Math.round(Math.max(0, Math.min(1, x)) * 255)
                .toString(16)
                .padStart(2, '0')
        ).join(''),
        kind: 'color',
        tip
    };
}

/** Hostility level names, by level (common/defines HOSTILITY_LEVEL_NAMES). */
const HOSTILITY = ['FAITH_HOSTILITY_RIGHTEOUS', 'FAITH_HOSTILITY_ASTRAY', 'FAITH_HOSTILITY_HOSTILE', 'FAITH_HOSTILITY_EVIL'];

/**
 * The texts of a customizable localization (common/customizable_localization) when nothing is known about the scope:
 * its fallback, else all of a few ("King/Queen").
 */
function customKeys(b: StoryBuilder, name: string): string[]
{
    const texts = bodyOf(b, b.idx.get('customizable_localization', name)).filter((c) => c.k === 'text' && Array.isArray(c.v));
    const fallback = texts.find((x) => scalar(x.v as PNode[], 'fallback') === 'yes');
    const keys = (fallback ? [fallback] : texts.length <= 3 ? texts : []).map((t) => scalar(t.v as PNode[], 'localization_key'));
    return keys.filter((k): k is string => !!k);
}

/**
 * Loc text with what the game fills in at runtime read statically: `$VALUE$` and a parameter's value
 * (TOKEN_PARAMETER), script values, hostility level names, the text a SelectLocalization / AddLocalizationIf picks
 * with the DLC, a customizable localization's text (customKeys); list bullets (`\n$EFFECT_LIST_BULLET$`) joined with "; ".
 */
function fill(b: StoryBuilder, t: string, value: string | undefined, depth = 0): string
{
    const sub = (k: string | undefined): string => (k && depth < 2 ? fill(b, b.idx.plainLoc(k, 0, true) ?? '', value, depth + 1) : '');
    const level = (n: string): string => b.idx.plainLoc(HOSTILITY[Number(n)] ?? '', 0, true) ?? n;
    return t
        .replace(/\[(?:SelectLocalization|AddLocalizationIf)\([^,\]]+,\s*'(\w*)'[^\]]*\]/g, (_m, a: string) => sub(a))
        .replace(/\[[^\]]*\.Custom2?\(\s*'(\w+)'[^\]]*\]/g, (m, name: string) =>
            customKeys(b, name)
                .map(sub)
                .filter(Boolean)
                .join('/') || m)
        .replace(/\[GetHostilityLevelName\(\s*(?:'\(int32\)(\d)'|TOKEN_PARAMETER\.GetIntValue)\s*\)(?:\|\w*)?\]/g, (_m, n: string | undefined) => level(n ?? value ?? ''))
        .replace(/\[[^\]]*TOKEN_PARAMETER[^\]]*\]/g, (m) => value ?? m)
        .replace(/\[[^\]]*ScriptValue\(\s*'(\w+)'\s*\)(?:\|([^\]]*))?\]/g, (m, sv: string, fmt: string | undefined) =>
        {
            const n = b.d.evalValue(sv);
            return n === undefined ? m : fmt?.includes('+') ? signed(n) : formatNumber(n);
        })
        .replace(/\$VALUE(?:\|[^$]*)?\$/g, () => (value === undefined ? '' : /^-?[\d.]+$/.test(value) ? formatNumber(parseFloat(value)) : value))
        .replace(/\s*\n\s*(\$[A-Z_]+\$)?/g, '; ')
        .replace(/\$[A-Z_]+\$/g, '')
        .trim();
}

/** A loc text in the game's words, links kept (see fill); undefined without loc. */
export function gameText(b: StoryBuilder, key: string, value?: string): Rich | undefined
{
    const t = filledLoc(b, key, value);
    return t ? locToRich(t, b.d.lookupDisplay, (inner) => b.idx.bracketRef(inner)) : undefined;
}

/** A loc text with what the game fills in (see fill), still with its [links]. */
export function filledLoc(b: StoryBuilder, key: string, value?: string): string | undefined
{
    const raw = b.idx.plainLoc(key, 0, true);
    return raw === undefined ? undefined : fill(b, raw, value);
}

/**
 * A doctrine / culture parameter in the game's own words (religion/doctrine_types/_doctrine_types.info,
 * "Localisation"): the loc key `<prefix><param>`, `…_disabled` for `no`, `…_<n>` for a whole number when that key
 * exists, the value filled in. Undefined without loc.
 */
function paramText(b: StoryBuilder, prefix: string, key: string, value: string): Rich | undefined
{
    const base = prefix + key;
    return gameText(b, value === 'no' ? base + '_disabled' : /^\d+$/.test(value) && b.idx.locRaw(`${base}_${value}`) !== undefined ? `${base}_${value}` : base, value);
}

/**
 * A parameter without loc of its own: the special ones of _doctrine_types.info — `opinion_of_<parameter> = 10`
 * (opinion of those whose faith has the parameter), `hostility_override_<doctrine> = 1` (how faiths with the doctrine
 * are seen) —, else "Name: value".
 */
function paramFallback(b: StoryBuilder, key: string, v: string): Rich
{
    const n = Number(v);
    const opinion = /^opinion_of_(\w+)$/.exec(key);

    if (opinion && !Number.isNaN(n))
        return rich({ text: signed(n), kind: n >= 0 ? 'good' : 'bad' }, ' opinion of ', b.idx.locRaw('doctrine_parameter_' + opinion[1]) !== undefined ? `those whose faith has “${humanize(opinion[1])}”` : humanize(opinion[1]));

    const hostility = /^hostility_override_(\w+)$/.exec(key);

    if (hostility && HOSTILITY[n])
        return rich('Faiths with ', b.d.ref(hostility[1], ['religion/doctrine_types']), ' are seen as ', locToRich(b.idx.plainLoc(HOSTILITY[n], 0, true) ?? v, b.d.lookupDisplay, (inner) => b.idx.bracketRef(inner)));

    return rich(capitalize(humanize(key)), v === 'yes' ? '' : v === 'no' ? ': no' : rich(': ', b.d.valueSeg(v)));
}

/** A `parameters = { … }` block as lines: each parameter in the game's words (paramText), else paramFallback. */
export function paramLines(b: StoryBuilder, list: PNode[], ctx: Ctx, prefix: string, fields?: string): Line[]
{
    return list
        .filter((c) => c.k && typeof c.v === 'string')
        .map((c) => statementLine(b, c, ctx, paramText(b, prefix, c.k!, c.v as string) ?? paramFallback(b, c.k!, c.v as string), fields, { icon: 'note' }));
}

/**
 * `doctrine_character_modifier = { doctrine = x <modifiers> }` (culture/_cultural_traits.info, doctrine types): the
 * modifiers characters get when their faith has the doctrine.
 */
export function doctrineModifierLines(b: StoryBuilder, list: PNode[], ctx: Ctx): Line[]
{
    return list
        .filter((c) => c.k === 'doctrine_character_modifier' && Array.isArray(c.v))
        .map((c) =>
        {
            const kids = c.v as PNode[];
            const doctrine = scalar(kids, 'doctrine');
            const l: Line = { text: rich('If their faith has ', doctrine ? b.d.ref(doctrine, ['religion/doctrine_types']) : 'the doctrine', ':'), children: b.d.statsOf(kids, ctx), icon: 'modifier', tip: tipOf(c, ctx) };
            const src = b.d.anchor(c, ctx, 'modifier', true);

            if (src)
                l.src = src;

            return l;
        });
}
