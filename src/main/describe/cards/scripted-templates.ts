/**
 * Scripted character templates (common/scripted_character_templates; `create_character = { template = x }`): who gets
 * created — age, gender, dynasty, culture and faith (or `random_culture`: one of those whose trigger holds), traits
 * (fixed ones, `random_traits_list = { count = N <trait> = { weight trigger } … }`, `random_traits`), skills (a value or
 * `{ min max }`), what `after_creation` runs.
 */
import type { PNode } from '../../indexer/parser.ts';
import type { FollowUp, Line, Rich } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import { capitalize, formatNumber, humanize, rich } from '../text.ts';
import type { CardFn } from './types.ts';
import { blockOf, raw, scalarOf } from './scripted-common.ts';
import { conditional, constValue, operand, valueLines, weightLines } from './weight.ts';

const SKILLS = ['diplomacy', 'martial', 'stewardship', 'intrigue', 'learning', 'prowess', 'health'];

/** Keys the card shows its own way; any other scalar is listed under "Other settings". */
const SHOWN = new Set(['age', 'gender', 'gender_female_chance', 'dynasty', 'dynasty_house', 'culture', 'faith', 'random_culture', 'name', 'trait', 'random_traits', 'random_traits_list', 'after_creation', ...SKILLS]);

/** A value or a `{ min max }` range: "18–60" (script values that come to a constant as numbers). */
function range(b: StoryBuilder, n: PNode, ctx: Ctx): Rich
{
    if (typeof n.v === 'string')
        return [operand(b, n.v, ctx)];

    const ends = n.v.filter((x) => x.k === null && typeof x.v === 'string').map((x) => operand(b, x.v as string, ctx));
    return ends.length === 2 ? rich(ends[0], '–', ends[1]) : ['a calculated value'];
}

/** Whose culture / faith / house: a database entry (`culture:mongol`) as a link, else the scope ("your faith"; `head`: "Your faith"). */
function whose(b: StoryBuilder, v: string, ctx: Ctx, head = false): Rich
{
    return [/^(culture|faith|house|dynasty|religion):[\w-]+$/.test(v) ? b.d.valueSeg(v, ctx) : b.d.scopeSeg(v, ctx, head)];
}

/** `random_traits_list = { count = 2 <trait> = { weight = { … } trigger = { … } } … }`: "2 of these at random:" */
function randomTraits(b: StoryBuilder, n: PNode & { v: PNode[]; }, ctx: Ctx): Line
{
    const count = n.v.find((x) => x.k === 'count');
    const how = count ? range(b, count, ctx) : ['1'];
    const kids = n.v
        .filter((x) => x.k && x.k !== 'count')
        .map((x): Line =>
        {
            const body = Array.isArray(x.v) ? x.v : [];
            const weight = blockOf(body, 'weight');
            const base = weight && weight.v.length === 1 ? scalarOf(weight.v, 'base') : undefined;
            const t = blockOf(body, 'trigger');
            const head = rich(b.d.ref(x.k!, ['traits']), base ? rich(' — weight ', operand(b, base, ctx)) : '');
            const l: Line = { ...conditional(b, head, t ? b.d.triggers(t.v, ctx) : []), icon: 'trait', tip: raw(x, ctx), src: ctx.file && b.d.anchor(x, ctx, 'other', false) };

            if (weight && !base)
                l.children = [{ text: ['Weight:'], children: weightLines(b, weight.v, ctx) }];

            return l;
        });
    return { text: rich(how, kids.length > 1 ? ' of these at random:' : ':'), children: kids, icon: 'chance', tip: raw(n, ctx), src: ctx.file && b.d.anchor(n, ctx, 'other', false) };
}

export const templateCard: CardFn = (b, { body, card, ctx, own }) =>
{
    // at a glance: age, gender, dynasty, name (the lines below list what is not said here)
    const age = body.find((c) => c.k === 'age');

    if (age)
        card.facts.push(rich('Aged ', range(b, age, ctx)));

    const gender = scalarOf(body, 'gender');
    const female = scalarOf(body, 'gender_female_chance');
    const chance = female !== undefined ? constValue(b, female) : undefined;

    if (gender)
        card.facts.push([gender === 'female' ? 'A woman' : gender === 'male' ? 'A man' : capitalize(humanize(gender))]);
    else if (chance !== undefined)
        card.facts.push([chance >= 100 ? 'A woman' : chance <= 0 ? 'A man' : `${formatNumber(chance)}% chance to be a woman`]);

    const dynasty = scalarOf(body, 'dynasty');

    if (dynasty === 'none' || dynasty === 'generate')
        card.facts.push([dynasty === 'none' ? 'Lowborn' : 'Founds a new dynasty']);

    const name = scalarOf(body, 'name');

    if (name)
        card.facts.push(rich('Named ', b.d.loc(name) ?? [humanize(name)]));

    // where they come from: culture, faith, house, another dynasty, a gender chance by formula
    const origin: Line[] = [];

    for (const c of body)
    {
        if (!c.k)
            continue;

        const v = typeof c.v === 'string' ? c.v : undefined;
        const src = ctx.file && b.d.anchor(c, ctx, 'other', false);

        if ((c.k === 'culture' || c.k === 'faith' || c.k === 'dynasty_house' || (c.k === 'dynasty' && dynasty !== 'none' && dynasty !== 'generate')) && v)
            origin.push({ text: rich(c.k === 'dynasty_house' ? 'House' : capitalize(c.k), ': ', whose(b, v, ctx)), icon: 'scope', tip: `${c.k} = ${v}`, src });
        else if (c.k === 'gender_female_chance' && !gender && chance === undefined)
        {
            if (v)
                origin.push({ text: rich('Chance to be a woman: ', b.d.valueSeg(v, ctx)), tip: `${c.k} = ${v}`, src: ctx.file && b.fieldAnchor(c, ctx, 'scripted_character_templates') });
            else if (Array.isArray(c.v))
                origin.push({ text: ['Chance to be a woman (%):'], children: valueLines(b, c.v, ctx), tip: raw(c, ctx), src });
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
            origin.push({ text: ['Culture — one of these at random, among those that fit:'], children: kids, icon: 'chance', tip: raw(c, ctx), src });
        }
    }

    if (origin.length)
        card.sections.push({ title: 'Origin', lines: origin });

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
    card.sections.push({ title: 'Traits', lines: traits, src: own('field', 'scripted_character_templates') });

    const skills = body
        .filter((c) => c.k && SKILLS.includes(c.k))
        .map((c): Line => ({ text: rich(capitalize(c.k!), ' ', range(b, c, ctx)), icon: 'skill', tip: raw(c, ctx), src: ctx.file && b.d.anchor(c, ctx, 'other', false) }));

    if (skills.length)
        card.sections.push({ title: 'Skills', lines: skills });

    const other = body.filter((c) => c.k && !SHOWN.has(c.k) && typeof c.v === 'string');

    if (other.length)
        card.sections.push({ title: 'Other settings', lines: b.fieldLines('scripted_character_templates', other, ctx) });

    const after = blockOf(body, 'after_creation');

    if (after)
    {
        const fctx = { ...ctx, followUps: [] as FollowUp[] };
        card.sections.push({ title: 'After creation', lines: b.d.effects(after.v, fctx), followUps: fctx.followUps, src: b.blockSection(after, 'effect', ctx) });
    }

    return true;
};
