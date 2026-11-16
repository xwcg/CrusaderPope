/**
 * Scripted character templates (common/scripted_character_templates; `create_character = { template = x }`): who gets
 * created: age, gender, dynasty, culture and faith (or `random_culture`: one of those whose trigger holds), traits
 * (fixed ones, `random_traits_list = { count = N <trait> = { weight trigger } … }`, `random_traits`), skills (a value or
 * `{ min max }`), what `after_creation` runs.
 */
import type { PNode } from '../../indexer/parser.ts';
import type { FollowUp, Line, Rich, SectionSource } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import { capitalize, formatNumber, humanize, rich } from '../text.ts';
import type { CardFn } from './types.ts';
import { blockOf, raw, scalarOf } from './scripted-common.ts';
import { conditional, constValue, operand, valueLines, weightLines } from './weight.ts';

import { tr } from '../../../shared/i18n.ts';
const SKILLS = ['diplomacy', 'martial', 'stewardship', 'intrigue', 'learning', 'prowess', 'health'];

/** Keys the card shows its own way; any other scalar is listed under "Other settings". */
const SHOWN = new Set(['template', 'save_scope_as', 'save_temporary_scope_as', 'rite', 'location', 'age', 'gender', 'gender_female_chance', 'dynasty', 'dynasty_house', 'culture', 'faith', 'random_culture', 'name', 'trait', 'random_traits', 'random_traits_list', 'after_creation', 'employer', 'mother', 'father', 'real_father', 'template_character', ...SKILLS]);

/**
 * The family and court a new character gets (_scripted_character_templates.info): `employer` the court they join, the
 * parents, `template_character` whom culture, faith, rite and house come from where not set; [you, someone else].
 */
const KIN: Record<string, [string, string]> = {
    employer: [tr('Joins your court'), tr('Joins the court of {who}')],
    mother: [tr('You are their mother'), tr('Their mother is {who}')],
    father: [tr('You are their father'), tr('Their father is {who}')],
    real_father: [tr('You are their real father'), tr('Their real father is {who}')],
    template_character: [tr('Culture, faith, rite and house come from you where not set'), tr('Culture, faith, rite and house come from {who} where not set')]
};

/** A value or a `{ min max }` range: "18–60" (script values that come to a constant as numbers). */
function range(b: StoryBuilder, n: PNode, ctx: Ctx): Rich
{
    if (typeof n.v === 'string')
        return [operand(b, n.v, ctx)];

    const ends = n.v.filter((x) => x.k === null && typeof x.v === 'string').map((x) => operand(b, x.v as string, ctx));
    return ends.length === 2 ? rich(ends[0], '–', ends[1]) : [tr('a calculated value')];
}

/** Whose culture / faith / house: a database entry (`culture:mongol`) as a link, else the scope ("your faith"; `head`: "Your faith"). */
function whose(b: StoryBuilder, v: string, ctx: Ctx, head = false): Rich
{
    return [/^(culture|faith|house|dynasty|religion):[\w-]+$/.test(v) ? b.d.valueSeg(v, ctx) : b.d.scopeSeg(v, ctx, head)];
}

/**
 * The chance of each entry to be among `k` picked by weight without repeats (the game's random_traits_list: "picks count
 * traits, weighted at random … a trait can't be picked twice", _scripted_character_templates.info): worked out exactly
 * (each first pick, then the rest from those left), undefined when that is too much work.
 */
export function pickChances(weights: number[], k: number): number[] | undefined
{
    const n = weights.length;

    if (k <= 0)
        return weights.map(() => 0);

    if (k >= n)
        return weights.map(() => 1);

    if (Math.pow(n, k) > 2_000_000)
        return undefined;

    const out = weights.map(() => 0);
    const pick = (left: number[], k: number, p: number): void =>
    {
        const total = left.reduce((a, i) => a + weights[i], 0);

        if (total <= 0)
            return;

        for (const i of left)
        {
            const q = (p * weights[i]) / total;

            if (q === 0)
                continue;

            out[i] += q;

            if (k > 1)
                pick(left.filter((j) => j !== i), k - 1, q);
        }
    };
    pick(weights.map((_, i) => i), k, 1);
    return out;
}

/** `random_traits_list = { count = 2 <trait> = { weight = { … } trigger = { … } } … }`: "2 of these at random:" */
function randomTraits(b: StoryBuilder, n: PNode & { v: PNode[]; }, ctx: Ctx): Line
{
    const count = n.v.find((x) => x.k === 'count');
    const how = count ? range(b, count, ctx) : ['1'];
    const entries = n.v.filter((x) => x.k && x.k !== 'count');
    // (each entry's chance to be picked: its weight (`base`, 1 when not written) against the others'; "~" when a
    // trigger may leave entries out, a weight has modifiers, or the count is a range (taken as evenly spread))
    const weightOf = (x: PNode): { n?: number; variable: boolean; } =>
    {
        const w = Array.isArray(x.v) ? blockOf(x.v, 'weight') : undefined;

        if (!w)
            return { n: 1, variable: false };

        const base = scalarOf(w.v, 'base');
        return { n: base === undefined ? 1 : constValue(b, base), variable: w.v.some((c) => c.k !== 'base') };
    };
    const ws = entries.map(weightOf);
    const counts = (() =>
    {
        if (!count)
            return [1];

        if (typeof count.v === 'string')
        {
            const c = constValue(b, count.v);
            return c === undefined ? undefined : [Math.round(c)];
        }

        const ends = count.v.filter((x) => x.k === null && typeof x.v === 'string').map((x) => constValue(b, x.v as string));
        return ends.length === 2 && ends[0] !== undefined && ends[1] !== undefined && ends[1] - ends[0] <= 10 ? Array.from({ length: Math.round(ends[1]) - Math.round(ends[0]) + 1 }, (_, i) => Math.round(ends[0]!) + i) : undefined;
    })();
    const chances = (() =>
    {
        if (!counts || ws.some((w) => w.n === undefined))
            return undefined;

        const sum = entries.map(() => 0);

        for (const k of counts)
        {
            const c = pickChances(ws.map((w) => w.n!), k);

            if (!c)
                return undefined;

            c.forEach((x, i) => (sum[i] += x / counts.length));
        }

        return sum;
    })();
    const approx = counts !== undefined && (counts.length > 1 || ws.some((w) => w.variable) || entries.some((x) => Array.isArray(x.v) && blockOf(x.v, 'trigger')));
    const kids = entries
        .map((x, i): Line =>
        {
            const body = Array.isArray(x.v) ? x.v : [];
            const weight = blockOf(body, 'weight');
            const base = weight && weight.v.length === 1 ? scalarOf(weight.v, 'base') : undefined;
            const t = blockOf(body, 'trigger');
            const pct = chances ? { text: `${approx ? '~' : ''}${formatNumber(Math.round(chances[i] * 1000) / 10)}%`, kind: 'value' as const, tip: approx ? tr('The chance if every entry fits and the weights are as written (a trigger or a modifier changes it)') : tr('The chance to be picked') } : undefined;
            const head = rich(b.d.ref(x.k!, ['traits']), base ? rich(tr(' — weight '), operand(b, base, ctx)) : '', pct ? rich(base ? ' · ' : ' — ', pct) : '');
            const l: Line = { ...conditional(b, head, t ? b.d.triggers(t.v, ctx) : []), icon: 'trait', tip: raw(x, ctx), src: ctx.file && b.fieldAnchor(x, ctx, 'random_traits_list') };

            if (weight && !base)
                l.children = [{ text: [tr('Weight:')], children: weightLines(b, weight.v, ctx) }];

            return l;
        });
    // (a block row of the template's set: ✎ opens the list's menu in the picker, ⤷＋ adds a trait to pick from)
    const src = ctx.file ? b.fieldAnchor(n, ctx, 'scripted_character_templates', true) : undefined;
    return { text: rich(how, kids.length > 1 ? tr(' of these at random:') : ':'), children: kids, icon: 'chance', tip: raw(n, ctx), src: src && { ...src, innerFields: 'random_traits_list' } };
}

/** What a template or a `create_character` block says: facts at a glance, then sections (empty ones left out). */
interface TemplateParts
{
    facts: Rich[];
    sections: { title: string; lines: Line[]; followUps?: FollowUp[]; src?: SectionSource; }[];
}

function templateParts(b: StoryBuilder, body: PNode[], ctx: Ctx, own?: SectionSource): TemplateParts
{
    const facts: Rich[] = [];
    const sections: TemplateParts['sections'] = [];
    // at a glance: age, gender, dynasty, name (the lines below list what is not said here)
    const age = body.find((c) => c.k === 'age');

    if (age)
        facts.push(rich(tr('Aged '), range(b, age, ctx)));

    const gender = scalarOf(body, 'gender');
    const female = scalarOf(body, 'gender_female_chance');
    const chance = female !== undefined ? constValue(b, female) : undefined;

    if (gender)
        facts.push([gender === 'female' ? tr('A woman') : gender === 'male' ? tr('A man') : capitalize(humanize(gender))]);
    else if (chance !== undefined)
        facts.push([chance >= 100 ? tr('A woman') : chance <= 0 ? tr('A man') : tr('{formatNumber}% chance to be a woman', { formatNumber: formatNumber(chance) })]);

    // (`dynasty` only says what to do when no `dynasty_house` is given: next to one it does nothing)
    const house = body.some((c) => c.k === 'dynasty_house');
    const dynasty = house ? undefined : scalarOf(body, 'dynasty');

    if (dynasty === 'none' || dynasty === 'generate')
        facts.push([dynasty === 'none' ? tr('Lowborn') : tr('Founds a new dynasty')]);

    const name = scalarOf(body, 'name');

    if (name)
        facts.push(rich(tr('Named '), b.d.loc(name) ?? [humanize(name)]));

    // where they come from: culture, faith, rite, house, another dynasty, where they appear, a gender chance by formula
    const origin: Line[] = [];

    for (const c of body)
    {
        if (!c.k)
            continue;

        const v = typeof c.v === 'string' ? c.v : undefined;
        const src = ctx.file && b.d.anchor(c, ctx, 'other', false);

        if ((c.k === 'culture' || c.k === 'faith' || c.k === 'rite' || c.k === 'dynasty_house' || (c.k === 'dynasty' && !house && dynasty !== 'none' && dynasty !== 'generate')) && v)
            origin.push({ text: rich(c.k === 'dynasty_house' ? tr('House') : capitalize(c.k), ': ', whose(b, v, ctx)), icon: 'scope', tip: `${c.k} = ${v}`, src: c.k === 'culture' || c.k === 'faith' || c.k === 'dynasty_house' ? ctx.file && b.fieldAnchor(c, ctx, 'scripted_character_templates') : src });
        else if (c.k === 'location' && v)
            origin.push({ text: rich(tr('Appears in '), b.d.scopeSeg(v, ctx)), icon: 'scope', tip: `location = ${v}`, src });
        else if (KIN[c.k] && v)
        {
            const seg = b.d.scopeSeg(v, ctx);
            const you = /^you$/i.test(typeof seg === 'string' ? seg : seg.text);
            const [mine, theirs] = KIN[c.k];
            const at = theirs.indexOf('{who}');
            origin.push({ text: you ? [mine] : rich(theirs.slice(0, at), seg, theirs.slice(at + 5)), icon: 'scope', tip: `${c.k} = ${v}`, src });
        }
        else if (c.k === 'gender_female_chance' && !gender && chance === undefined)
        {
            if (v)
                origin.push({ text: rich(tr('Chance to be a woman: '), b.d.valueSeg(v, ctx)), tip: `${c.k} = ${v}`, src: ctx.file && b.fieldAnchor(c, ctx, 'scripted_character_templates') });
            else if (Array.isArray(c.v))
                origin.push({ text: [tr('Chance to be a woman (%):')], children: valueLines(b, c.v, ctx), tip: raw(c, ctx), src });
        }
        else if (c.k === 'random_culture' && Array.isArray(c.v))
        {
            const kids = c.v
                .filter((x) => x.k)
                .map((x): Line =>
                {
                    const t = Array.isArray(x.v) ? blockOf(x.v, 'trigger') : undefined;
                    return { ...conditional(b, whose(b, x.k!, ctx, true), t ? b.d.triggers(t.v, ctx) : []), tip: raw(x, ctx), src: ctx.file && b.d.anchor(x, ctx, 'other', false) };
                });
            origin.push({ text: [tr('Culture — one of these at random, among those that fit:')], children: kids, icon: 'chance', tip: raw(c, ctx), src });
        }
    }

    // (the template's own block: culture, faith, house … are added there too, through the template's field set)
    if (origin.length || own)
        sections.push({ title: tr('Origin'), lines: origin, src: own });

    const traits: Line[] = [];

    for (const c of body)
    {
        if (c.k === 'trait' && typeof c.v === 'string')
            traits.push({ text: [b.d.ref(c.v, ['traits'])], icon: 'trait', tip: `trait = ${c.v}`, src: ctx.file && b.fieldAnchor(c, ctx, 'scripted_character_templates') });
        else if (c.k === 'random_traits_list' && Array.isArray(c.v))
            traits.push(randomTraits(b, c as PNode & { v: PNode[]; }, ctx));
        else if (c.k === 'random_traits' && typeof c.v === 'string')
            traits.push(...b.fieldLines('scripted_character_templates', [c], ctx));
    }

    // (the template's own block: traits and the other settings are added there)
    if (traits.length || own)
        sections.push({ title: tr('Traits'), lines: traits, src: own });

    // (a skill written as one number changes in the picker; a range `{ min max }` as script)
    const skills = body
        .filter((c) => c.k && SKILLS.includes(c.k))
        .map((c): Line => ({ text: rich(capitalize(c.k!), ' ', range(b, c, ctx)), icon: 'skill', tip: raw(c, ctx), src: ctx.file && (typeof c.v === 'string' ? b.fieldAnchor(c, ctx, 'scripted_character_templates') : b.d.anchor(c, ctx, 'other', false)) }));

    if (skills.length || own)
        sections.push({ title: tr('Skills'), lines: skills, src: own });

    const other = body.filter((c) => c.k && !SHOWN.has(c.k) && typeof c.v === 'string');

    if (other.length)
        sections.push({ title: tr('Other settings'), lines: b.fieldLines('scripted_character_templates', other, ctx) });

    const after = blockOf(body, 'after_creation');

    if (after)
    {
        const fctx = { ...ctx, followUps: [] as FollowUp[] };
        sections.push({ title: tr('After creation'), lines: b.d.effects(after.v, fctx), followUps: fctx.followUps, src: b.blockSection(after, 'effect', ctx) });
    }

    return { facts, sections };
}

export const templateCard: CardFn = (b, { body, card, ctx, own }) =>
{
    const parts = templateParts(b, body, ctx, own('field', 'scripted_character_templates'));
    card.facts.push(...parts.facts);
    card.sections.push(...parts.sections);
    return true;
};

/**
 * `create_character = { template = x age = … trait = … save_scope_as = … }` as an effect line: who appears (the
 * template linked), the facts in its text, its origin, traits, skills and after-creation effects below.
 */
export function createCharacterLine(b: StoryBuilder, n: PNode, ctx: Ctx): Line | null
{
    if (!Array.isArray(n.v))
        return null;

    const body = n.v;
    const template = scalarOf(body, 'template');
    const saved = scalarOf(body, 'save_scope_as') ?? scalarOf(body, 'save_temporary_scope_as');
    const parts = templateParts(b, body, ctx);

    // (events the after-creation effects lead to belong to the caller's follow-ups as well, not only to the collapsed lines)
    // (through the describer: an expansion around that is kept for the same call records them)
    for (const s of parts.sections)
        b.d.leadAll(ctx, s.followUps ?? []);

    const kids: Line[] = parts.sections.map((s) => ({ text: [s.title + ':'], children: s.lines, icon: 'note' }));
    const facts = parts.facts.map((f) => rich(...f.map((x) => (typeof x === 'string' ? x.toLowerCase() : x))));
    return {
        text: rich(
            tr('A new character appears'),
            template ? rich(' (', b.d.ref(template, ['scripted_character_templates']), ')') : '',
            facts.length ? rich(': ', ...facts.flatMap((f, i) => (i ? [', ', ...f] : f))) : '',
            saved ? rich(tr(', saved as '), { text: `“${humanize(saved)}”`, kind: 'value', tip: `scope:${saved}` }) : ''
        ),
        icon: 'note',
        children: kids.length ? kids : undefined,
        collapsed: kids.length > 0
    };
}
