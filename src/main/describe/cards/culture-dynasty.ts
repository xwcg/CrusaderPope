/** Cards: dynasties and houses (history at game start), house mottos and their words, dynasty legacies, nicknames. */
import type { PNode } from '../../indexer/parser.ts';
import type { Entity } from '../../indexer/gameIndex.ts';
import type { CardSection, EntityCard, Line, Rich, RichSeg } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import type { CardFn } from './types.ts';
import { weightLines } from './weight.ts';
import { humanize, locToRich, rich } from '../text.ts';
import { block, bodyOf, dynastyWord, filledLoc, scalar, scalars, statementLine, word } from './culture-util.ts';

/** A dynasty's or house's name as the game writes it: prefix (`dynnp_de` → "de ") and name (`dynn_Villeneuve`), loc keys. */
function houseName(b: StoryBuilder, body: PNode[]): string | undefined
{
    const name = scalar(body, 'name');

    if (!name)
        return undefined;

    const prefix = scalar(body, 'prefix');
    return (prefix ? dynastyWord(b, prefix) : '') + dynastyWord(b, name);
}

/** A link to a dynasty or house by its name (their display names are ids: `25061`, `house_chiny`). */
function houseSeg(b: StoryBuilder, type: string, key: string): RichSeg
{
    const e = b.idx.get(type, key);

    if (!e)
        return { text: key, kind: 'code', tip: key };

    const seg = b.d.entitySeg(e);
    const name = houseName(b, bodyOf(b, e));
    return name && typeof seg !== 'string' ? { ...seg, text: name } : seg;
}

const COA_GROUPS: Record<string, string> = { christian: 'Christian', muslim: 'Muslim', zoroastrian_group: 'Zoroastrian' };

/** The settings of a dynasty or house (common/dynasties, common/dynasty_houses) as lines, anchored as fields of `fields`. */
function houseLines(b: StoryBuilder, body: PNode[], ctx: Ctx, fields: string): Line[]
{
    const out: Line[] = [];

    for (const c of body)
    {
        if (!c.k || typeof c.v !== 'string')
            continue;

        const v = c.v;
        let text: Rich | undefined;

        if (c.k === 'name')
            text = rich('Name: ', { text: dynastyWord(b, v), kind: 'value', tip: v });
        else if (c.k === 'prefix')
            text = rich('Prefix: ', { text: dynastyWord(b, v).trim(), kind: 'value', tip: v });
        else if (c.k === 'culture')
            text = rich('Culture: ', b.d.ref(v, ['culture/cultures']));
        else if (c.k === 'dynasty')
            text = rich('Dynasty: ', houseSeg(b, 'dynasties', v));
        else if (c.k === 'motto')
            text = rich('Motto: “', b.d.loc(v) ?? [{ text: v, kind: 'code' }], '”');
        else if (c.k === 'forced_coa_religiongroup')
            text = [`Coat of arms in the ${COA_GROUPS[v] ?? humanize(v)} style`];

        if (text)
            out.push(statementLine(b, c, ctx, text, fields));
    }

    return out;
}

/** Facts of a dynasty or house: its historical members, motto, coat of arms (common/coat_of_arms, keyed like it). */
function houseFacts(b: StoryBuilder, e: Entity, body: PNode[], card: EntityCard, type: 'dynasty' | 'dynasty_house'): void
{
    const members = b.idx.incomingSources(e).filter((s) => s.entity.type === 'characters' && s.contexts.some((c) => c === type || c.endsWith(' › ' + type))).length;

    if (members)
        card.facts.push([`${members} historical member${members === 1 ? '' : 's'}`]);

    const motto = scalar(body, 'motto');

    if (motto)
        card.facts.push(rich('“', b.d.loc(motto) ?? [motto], '”'));

    const coa = b.idx.get('coat_of_arms/coat_of_arms', e.name);

    if (coa)
        card.facts.push(rich({ ...(b.d.entitySeg(coa) as Exclude<RichSeg, string>), text: 'Coat of arms' }));
}

const HOUSE_SKIP = new Set(['name', 'prefix', 'culture', 'dynasty', 'motto', 'forced_coa_religiongroup']);

/** A dynasty (common/dynasties: name, prefix, culture, motto, coat of arms style): its houses and members. */
const dynasty: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const name = houseName(b, body);

    if (name)
        card.title = name;

    const culture = scalar(body, 'culture');

    if (culture)
        card.facts.push(rich('Culture: ', b.d.ref(culture, ['culture/cultures'])));

    houseFacts(b, e, body, card, 'dynasty');
    const houses = b.idx.incomingSources(e).filter((s) => s.entity.type === 'dynasty_houses' && s.contexts.includes('dynasty'));

    if (houses.length)
        card.sections.push({ title: 'Houses', lines: houses.map((s) => ({ text: [houseSeg(b, 'dynasty_houses', s.entity.name)], icon: 'note' })) });

    card.sections.push({ title: 'Settings', lines: houseLines(b, body, ctx, 'dynasties'), src: own('field', 'dynasties') });
    b.genericSections(e, body, card, ctx, own, HOUSE_SKIP);
    return true;
};

/** A house (common/dynasty_houses: name, prefix, dynasty, motto): a branch of its dynasty. */
const house: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const name = houseName(b, body);

    if (name)
        card.title = name;

    const dyn = scalar(body, 'dynasty');

    if (dyn)
        card.facts.push(rich('House of the dynasty ', houseSeg(b, 'dynasties', dyn)));

    houseFacts(b, e, body, card, 'dynasty_house');
    card.sections.push({ title: 'Settings', lines: houseLines(b, body, ctx, 'dynasty_houses'), src: own('field', 'dynasty_houses') });
    b.genericSections(e, body, card, ctx, own, HOUSE_SKIP);
    return true;
};

/** A few of a motto word group's words (`motto_<key>`), for "e.g.". */
function examples(b: StoryBuilder, group: string, n = 3): string[]
{
    const body = bodyOf(b, b.idx.get('dynasty_house_motto_inserts', group));
    return body.filter((c) => c.k && Array.isArray(c.v))
        .slice(0, n)
        .map((c) => word(b, 'motto_' + c.k));
}

/**
 * A house motto (dynasty_house_mottos/_mottos.info): its text (`motto_<key>`, `$1$` … the inserts in order), who
 * can get it (the house founder's conditions) and how likely (a script value; 1000 when not set).
 */
const motto: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const inserts = scalars(body, 'insert');
    const raw = filledLoc(b, 'motto_' + e.name);

    if (raw)
    {
        const parts = raw.split(/\$(\d+)(?:\|\w*)?\$/);
        const text: Rich = parts.flatMap((p, i) =>
        {
            if (i % 2 === 0)
                return locToRich(p, b.d.lookupDisplay, (inner) => b.idx.bracketRef(inner));

            const g = inserts[Number(p) - 1]?.v as string | undefined;
            return [g ? { ...(b.d.ref(g, ['dynasty_house_motto_inserts']) as Exclude<RichSeg, string>), text: `‹${humanize(g)}›` } : '…'];
        });
        // (the title: the words as "…", the founder's data as placeholders)
        card.title = b.d.plainText(parts.map((p, i) => (i % 2 ? '…' : p)).join('')).trim();
        card.facts.push(rich('“', text, '”'));
    }

    card.sections.push({
        title: 'Words filled in',
        lines: inserts.map((c, i) =>
        {
            const ex = examples(b, c.v as string);
            return statementLine(b, c, ctx, rich(`${i + 1}: `, b.d.ref(c.v as string, ['dynasty_house_motto_inserts']), ex.length ? { text: ` — e.g. ${ex.join(', ')}`, kind: 'ph' } : ''), 'dynasty_house_mottos', { icon: 'note' });
        }),
        src: own('field', 'dynasty_house_mottos')
    });
    const trigger = body.find((c) => c.k === 'trigger' && Array.isArray(c.v));

    if (trigger)
        card.sections.push({ title: 'Only for house founders who', lines: b.d.triggers(trigger.v as PNode[], ctx), src: b.blockSection(trigger, 'trigger', ctx) });

    card.sections.push(weightSection(b, body, ctx));
    b.genericSections(e, body, card, ctx, own, new Set(['insert', 'trigger', 'weight']));
    return true;
};

/** "How likely": a `weight` script value (1000 when not set: dynasty_house_mottos/_mottos.info, _inserts.info). */
function weightSection(b: StoryBuilder, body: PNode[], ctx: Ctx): CardSection
{
    const w = body.find((c) => c.k === 'weight');

    if (!w)
        return { title: 'How likely', lines: [{ text: ['Weight 1000 (not set)'], icon: 'chance' }] };

    if (typeof w.v === 'string')
        return { title: 'How likely', lines: [statementLine(b, w, ctx, rich('Weight ', b.d.valueSeg(w.v, ctx)), undefined, { icon: 'chance' })] };

    return { title: 'How likely', lines: weightLines(b, w.v, ctx), src: b.blockSection(w, 'field', ctx, 'script_value') };
}

/** A group of motto words (dynasty_house_motto_inserts/_inserts.info): each word (`motto_<key>`) with its founder's conditions and weight. */
const mottoInsert: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const words = body.filter((c) => c.k && Array.isArray(c.v));
    card.facts.push([`${words.length} word${words.length === 1 ? '' : 's'}`]);
    card.sections.push({
        title: 'Words',
        lines: words.map((c) =>
        {
            const kids = c.v as PNode[];
            const trigger = block(kids, 'trigger');
            const l: Line = { text: [word(b, 'motto_' + c.k)], icon: 'note', tip: c.k!, conditions: trigger ? b.d.triggers(trigger, ctx) : undefined };

            if (kids.some((x) => x.k === 'weight'))
                l.children = [{ text: ['How likely:'], icon: 'chance', children: weightSection(b, kids, ctx).lines, collapsed: true }];

            const src = b.d.anchor(c, ctx, 'other', false);

            if (src)
                l.src = src;

            return l;
        })
    });
    b.genericSections(e, body, card, ctx, own, new Set(words.map((c) => c.k!)));
    return true;
};

/** A dynasty legacy track (dynasty_legacies/_dynasty_legacies.info: a container of perks — dynasty_perks `legacy = <key>`). */
const legacy: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const perks = b.idx
        .incomingSources(e)
        .filter((s) => s.entity.type === 'dynasty_perks' && s.contexts.includes('legacy'))
        .map((s) => s.entity)
        .sort((x, y) => (b.idx.winningDef(x)?.file ?? 0) - (b.idx.winningDef(y)?.file ?? 0) || (b.idx.winningDef(x)?.start ?? 0) - (b.idx.winningDef(y)?.start ?? 0));
    card.facts.push([`${perks.length} perk${perks.length === 1 ? '' : 's'}`]);
    card.sections.push({
        title: 'Perks',
        lines: perks.map((p, i) =>
        {
            const stats = b.d.modifierStats(p);
            return { text: rich(`${i + 1}. `, b.d.entitySeg(p)), icon: 'modifier', children: stats.length ? stats : undefined, collapsed: true };
        })
    });
    b.genericSections(e, body, card, ctx, own);
    return true;
};

/** A nickname (nicknames/_nicknames.info: `is_prefix`, `is_bad`; its text is the loc of its key). */
const nickname: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const nick = b.d.loc(e.name) ?? [humanize(e.name.replace(/^nick_/, ''))];
    const name: RichSeg = { text: 'Name', kind: 'ph' };
    card.facts.push(scalar(body, 'is_prefix') === 'yes' ? rich('Reads “', nick, ' ', name, '”') : rich('Reads “', name, ' ', nick, '”'));

    if (scalar(body, 'is_bad') === 'yes')
        card.facts.push([{ text: 'A bad nickname', kind: 'bad' }]);

    const lines = b.fieldLines('nicknames', body, ctx);
    const src = own('field', 'nicknames');

    if (lines.length || src)
        card.sections.push({ title: 'Settings', lines, src });

    b.genericSections(e, body, card, ctx, own, new Set(['is_prefix', 'is_bad']));
    return true;
};

export const DYNASTY_CARDS: Record<string, CardFn> = {
    dynasties: dynasty,
    dynasty_houses: house,
    dynasty_house_mottos: motto,
    dynasty_house_motto_inserts: mottoInsert,
    dynasty_legacies: legacy,
    nicknames: nickname
};
