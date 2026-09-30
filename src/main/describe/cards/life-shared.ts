/** Helpers of the life cards (cards/life*.ts): settings lines, dynamic descriptions, durations, lists, lookups. */
import type { PNode } from '../../indexer/parser.ts';
import type { Entity } from '../../indexer/gameIndex.ts';
import type { EntityCard, Line, Rich, RichSeg, SectionSource } from '../../../shared/api.ts';
import { fieldOf, fieldText, type FieldDef } from '../../../shared/fieldCatalog.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import { capitalize, formatNumber, humanize, rich } from '../text.ts';
import type { CardInput } from './types.ts';

/** A plain value written in a block. */
export function str(list: PNode[], k: string): string | undefined
{
    const c = list.find((x) => x.k === k);
    return typeof c?.v === 'string' ? c.v : undefined;
}

/** The first block of that key written in a block. */
export function blockOf(list: PNode[], k: string): PNode | undefined
{
    return list.find((x) => x.k === k && Array.isArray(x.v));
}

/** The statements of a block node. */
export function kids(n: PNode | undefined): PNode[]
{
    return n && Array.isArray(n.v) ? n.v : [];
}

/** The words of a list block: `{ a b "c" }`. */
export function words(n: PNode | undefined): string[]
{
    return kids(n)
        .filter((x) => x.k === null && typeof x.v === 'string')
        .map((x) => x.v as string);
}

/** "a, b and c" */
export function joined(parts: (Rich | RichSeg)[], last = ' and '): Rich
{
    return rich(...parts.flatMap((p, i) => (i ? [i === parts.length - 1 ? last : ', ', p] : [p])));
}

/** Loc text without the line breaks and spaces around it. */
export function trimmed(r: Rich): Rich
{
    const out = [...r];

    if (typeof out[0] === 'string')
        out[0] = out[0].trimStart();

    const last = out[out.length - 1];

    if (typeof last === 'string')
        out[out.length - 1] = last.trimEnd();

    return out.filter((s) => s !== '');
}

/** Loc text in quotes, or the key humanized. */
export function quoted(b: StoryBuilder, key: string): Rich
{
    return rich('“', trimmed(b.d.loc(key) ?? [humanize(key)]), '”');
}

/** A section when it has lines, or a place to add them. */
export function addSection(card: EntityCard, title: string, lines: Line[], src?: SectionSource): void
{
    if (lines.length || src)
        card.sections.push({ title, lines, src });
}

/** Every live entry of a type with its definition's statements (entries a mod removed have none). */
export function* entries(b: StoryBuilder, type: string): Generator<{ e: Entity; body: PNode[]; }>
{
    for (const name of b.idx.names(type))
    {
        const e = b.idx.get(type, name);
        const d = e && b.idx.defNode(e);

        if (e && d && Array.isArray(d.node.v))
            yield { e, body: d.node.v };
    }
}

/** How a card shows a setting's value (undefined: as the field reads it). */
export type SettingValue = (v: string, f: FieldDef) => RichSeg | undefined;

/**
 * One of a definition's settings (its field set in shared/fields/life.ts) as a line anchored for editing: how the field
 * reads, with the entry it names as a link — or what `value` makes of the value (dates, names …).
 */
function settingLine(b: StoryBuilder, type: string, c: PNode, ctx: Ctx, value?: SettingValue): Line | undefined
{
    if (!c.k || typeof c.v !== 'string')
        return undefined;

    const f = fieldOf(type, c.k);

    if (!f)
        return undefined;

    const l: Line = { text: [], tip: `${c.k} = ${c.v}`, src: b.fieldAnchor(c, ctx, type) };
    const read = typeof f.read === 'string' && f.read.includes('$') ? f.read : undefined;
    const seg = read ? (value?.(c.v, f) ?? (f.kind === 'ref' ? b.d.ref(c.v, f.ref ? [f.ref] : undefined) : undefined)) : undefined;

    if (read && seg)
    {
        const [pre, post] = read.split('$');
        l.text = rich(pre, seg, post);
    }
    else
    {
        const t = fieldText(type, c.k, c.v)!;
        l.text = t.tone ? [{ text: t.text, kind: t.tone }] : [t.text];
        l.tone = t.tone;
    }

    return l;
}

/** The settings a definition writes (the scalars of its field set), in order: a "Settings" section to add more to. */
export function settingsSection(b: StoryBuilder, x: CardInput, value?: SettingValue): void
{
    const lines = x.body.map((c) => settingLine(b, x.e.type, c, x.ctx, value)).filter((l): l is Line => !!l);
    addSection(x.card, 'Settings', lines, x.own('field', x.e.type));
}

/** A trigger block read with a character as root (a scope hint for adding statements). */
export function charTriggers(b: StoryBuilder, n: PNode, ctx: Ctx): Line[]
{
    return b.d.triggers(kids(n), { ...ctx, scopeType: 'character' });
}

/** A trigger block as a section (character root), also when empty — an empty block always passes. */
export function triggerSection(b: StoryBuilder, card: EntityCard, n: PNode | undefined, title: string, ctx: Ctx, empty?: string): void
{
    if (!n || !Array.isArray(n.v))
        return;

    const lines = charTriggers(b, n, ctx);

    if (!lines.length && empty)
        lines.push({ text: [empty], icon: 'note' });

    addSection(card, title, lines, b.blockSection(n, 'trigger', { ...ctx, scopeType: 'character' }));
}

/**
 * A dynamic description as lines: `desc = key`, or blocks of `first_valid` (the first variant whose trigger passes;
 * an unconditional one after conditional ones is the fallback), `random_valid` (one at random of those whose trigger
 * passes) and `triggered_desc = { trigger = { … } desc = key }` — each variant's text in quotes with its conditions.
 */
export function descLines(b: StoryBuilder, n: PNode, ctx: Ctx, fill: (r: Rich) => Rich = (r) => r): Line[]
{
    const text = (key: string, node: PNode, conditions?: Line[], otherwise = false): Line =>
    {
        const l: Line = { text: rich(otherwise ? 'Otherwise: ' : '', '“', fill(trimmed(b.d.loc(key) ?? [humanize(key)])), '”'), icon: 'note', tip: key, locKey: key };

        if (conditions?.length)
            l.conditions = conditions;

        if (ctx.file)
            l.src = b.d.anchor(node, ctx, 'other', false);

        return l;
    };
    const walk = (list: PNode[], firstValid: boolean): Line[] =>
    {
        const out: Line[] = [];
        let conditional = false;

        for (const c of list)
        {
            if (c.k === 'triggered_desc' && Array.isArray(c.v))
            {
                const t = blockOf(c.v, 'trigger');
                const d = c.v.find((x) => x.k === 'desc');
                const conds = t ? b.d.triggers(kids(t), ctx) : [];

                if (conds.length)
                    conditional = true;

                if (typeof d?.v === 'string')
                    out.push(text(d.v, c, conds));
                else if (d)
                    out.push(...walk(kids(d), false).map((l) => (conds.length ? { ...l, conditions: [...conds, ...(l.conditions ?? [])] } : l)));
            }
            else if ((c.k === 'desc' || c.k === null) && typeof c.v === 'string')
            {
                if (c.v)
                    out.push(text(c.v, c, undefined, firstValid && conditional));
            }
            else if ((c.k === 'first_valid' || c.k === 'random_valid' || c.k === 'desc') && Array.isArray(c.v))
            {
                const inner = walk(c.v, c.k === 'first_valid');

                if (c.k === 'random_valid' && inner.length > 1)
                {
                    const g: Line = { text: ['One of these, at random:'], icon: 'chance', children: inner };

                    if (ctx.file)
                        g.src = b.d.anchor(c, ctx, 'other', true);

                    out.push(g);
                }
                else
                    out.push(...inner);
            }
        }

        return out;
    };
    return typeof n.v === 'string' ? (n.v ? [text(n.v, n)] : []) : walk(n.v, false);
}

/** `years = N` / `months` / `weeks` / `days` in words: "5 years", "‹Memory default duration› years" (a script value). */
export function durationText(b: StoryBuilder, list: PNode[], ctx: Ctx): Rich | undefined
{
    for (const unit of ['years', 'months', 'weeks', 'days'])
    {
        const v = str(list, unit);

        if (v === undefined)
            continue;

        const n = b.d.evalValue(v);
        return n !== undefined ? [`${formatNumber(n)} ${n === 1 ? unit.slice(0, -1) : unit}`] : rich(b.d.valueSeg(v, ctx), ` ${unit}`);
    }

    return undefined;
}

/** The statements with `@name` values replaced by the file's constants (`@accolade_maa_maint_4` → -0.25); offsets kept. */
function withConsts(list: PNode[], consts: Map<string, string>): PNode[]
{
    return list.map((c) =>
    {
        if (Array.isArray(c.v))
            return { ...c, v: withConsts(c.v, consts) };

        const v = c.v.startsWith('@') ? consts.get(c.v.slice(1)) : undefined;
        return v === undefined ? c : { ...c, v };
    });
}

/** A block of stat modifiers as a group line with its own label ("The liege:"), anchored as a block of modifiers. */
export function modifierGroup(b: StoryBuilder, n: PNode, label: Rich | string, ctx: Ctx, consts?: Map<string, string>): Line
{
    const l: Line = { text: typeof label === 'string' ? [label] : label, icon: 'modifier', children: b.d.statsOf(consts ? withConsts(kids(n), consts) : kids(n), ctx), tip: n.k ?? undefined };

    if (ctx.file)
        l.src = b.d.anchor(n, ctx, 'modifier', true);

    return l;
}

/** A cost block (`gold = 50`, `gold = { value = … if = { … } }`): plain costs as the card's cost lines, formulas with their steps. */
export function costLines(b: StoryBuilder, list: PNode[], ctx: Ctx): Line[]
{
    return list.flatMap((c) =>
    {
        if (!c.k || c.k === 'round')
            return [];

        if (typeof c.v === 'string' || (c.v.length === 1 && (c.v[0].k === 'value' || c.v[0].k === 'add')))
            return b.cost([c], ctx);

        return [{ text: [capitalize(humanize(c.k)) + ':'], icon: c.k, children: b.formula(c.v, ctx), src: b.fieldAnchor(c, ctx, 'cost') }];
    });
}

/**
 * The comments about a definition that holds nothing else (`key = {} # what it is`): above it, inside its block, after
 * it on its last line — as note lines.
 */
export function commentLines(b: StoryBuilder, e: Entity): Line[]
{
    const d = b.idx.winningDef(e);

    if (!d)
        return [];

    const src = b.idx.readFile(d.file);
    const end = src.indexOf('\n', d.end);
    const inner = [...src.slice(d.start, d.end).matchAll(/#+[ \t]*(\S.*?)\s*$/gm)].map((m) => m[1]);
    const after = /^[ \t]*#+[ \t]*(\S.*?)\s*$/.exec(src.slice(d.end, end < 0 ? undefined : end))?.[1];
    return [...(d.doc ? [d.doc] : []), ...inner, ...(after ? [after] : [])].map((t) => ({ text: [t], icon: 'note' }));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A dynasty or house by its `name`'s loc (their entries are named by id): "Saffarid dynasty", "House Samanid". */
export function familySeg(b: StoryBuilder, type: 'dynasties' | 'dynasty_houses', id: string): RichSeg
{
    const seg = b.d.ref(id, [type]);
    const e = b.idx.get(type, id);
    const d = e && b.idx.defNode(e);
    const key = d && str(kids(d.node), 'name');
    const name = key && b.idx.plainLoc(key);
    return name && typeof seg !== 'string' ? { ...seg, text: type === 'dynasties' ? `${name} dynasty` : `House ${name}` } : seg;
}

/** A script date in words: `1066.9.15` → "15 September 1066". */
export function dateSeg(v: string): RichSeg
{
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
    return { text: m && +m[2] >= 1 && +m[2] <= 12 ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : v, kind: 'value', tip: v };
}
