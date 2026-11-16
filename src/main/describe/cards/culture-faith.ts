/**
 * Cards: faiths, religions, religion families, doctrine groups and doctrines (common/religion). A mod's faith, religion
 * or doctrine also shows what it still lacks as placeholders (docs/readable-view.md, "Culture, faith and dynasty"):
 * a doctrine group without a choice, missing tenets, names in game, colour, icon, a religion without faiths, a
 * doctrine in no group, each with the action that fills it in (LineAct).
 */
import type { PNode } from '../../indexer/parser.ts';
import type { Entity } from '../../indexer/gameIndex.ts';
import type { CardSection, EntityCard, Line, LineAct, LineSource, Rich, RichSeg, SectionSource } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import type { CardFn } from './types.ts';
import { capitalize, formatNumber, humanize, rich, titleCase } from '../text.ts';
import { block, bodyOf, colorSeg, dlcName, items, joined, paramLines, sample, scalar, specialParamLines, statementLine, word } from './culture-util.ts';
import { faithDetails, faithField, faithHolySites, faithReligion, religionFaiths, tenetGroupDoctrines, tenetsOf, tenetsOwnType } from '../../indexer/layouts.ts';
import { FAITH_DETAIL_KEYS, RELIGION_DETAIL_KEYS, oldParameter, parameterName, convertibleParameter } from '../../mods/modernize.ts';
import { descLines } from './life-shared.ts';
import { modifierScopeOf } from '../../../shared/scriptCatalog.ts';

import { tr } from '../../../shared/i18n.ts';
const DOCTRINE = ['religion/doctrine_types'];

/** Doctrine group categories (religion/doctrine_group_types `category`), in the order a faith shows them. */
const CATEGORIES: Record<string, string> = { core_tenets: tr('Tenets'), main_group: tr('Main'), marriage: tr('Marriage'), crimes: tr('Crimes'), clergy: tr('Clergy'), special: tr('Special'), not_creatable: tr('Not creatable') };
const CATEGORY_ORDER = Object.keys(CATEGORIES);
/** the categories whose groups a faith has one doctrine of each (the game's faith creation), with their sections */
const CREATABLE: Record<string, string> = { main_group: 'Doctrines', marriage: 'Marriage', crimes: 'Crimes', clergy: 'Clergy' };

export interface DoctrineGroup
{
    e: Entity;
    key: string;
    label: string;
    category: string;
    /** how many a faith holds (tenets: 3) */
    picks: number;
    /** offered to every new faith (no `is_available_on_create`: Islam's, Judaism's … groups are their religions') */
    everyFaith: boolean;
    doctrines: string[];
    /** where it is written (groups show in file order) */
    at: number;
}

/** The doctrine groups as the game lists them (category, then file order), and each doctrine's group. */
export function doctrineGroups(b: StoryBuilder): { list: DoctrineGroup[]; of: Map<string, DoctrineGroup>; }
{
    const list: DoctrineGroup[] = [];
    const of = new Map<string, DoctrineGroup>();

    for (const name of b.idx.names('religion/doctrine_group_types'))
    {
        const e = b.idx.get('religion/doctrine_group_types', name)!;
        const body = bodyOf(b, e);
        const g: DoctrineGroup = {
            e,
            key: name,
            label: b.idx.displayName(e) ?? titleCase(humanize(name.replace(/^doctrine_/, ''))),
            category: scalar(body, 'category') ?? '',
            picks: Number(scalar(body, 'number_of_picks') ?? 1) || 1,
            everyFaith: !body.some((c) => c.k === 'is_available_on_create'),
            doctrines: items(block(body, 'doctrine_types')).map((d) => d.v as string),
            at: b.idx.winningDef(e)?.start ?? 0
        };
        list.push(g);

        for (const d of g.doctrines)
            of.set(d, g);
    }

    // (1.20: the doctrine names its group; docs/game-structure.md, "Layouts that changed")
    const byKey = new Map(list.map((g) => [g.key, g]));

    for (const name of b.idx.names('religion/doctrine_types'))
    {
        const g = byKey.get(scalar(bodyOf(b, b.idx.get('religion/doctrine_types', name)), 'doctrine_group_type') ?? '');

        if (g && !of.has(name))
        {
            g.doctrines.push(name);
            of.set(name, g);
        }
    }

    const rank = (g: DoctrineGroup): number =>
    {
        const i = CATEGORY_ORDER.indexOf(g.category);
        return i < 0 ? 99 : i;
    };
    list.sort((x, y) => rank(x) - rank(y) || x.at - y.at);
    return { list, of };
}

/** A doctrine a faith or religion has: its statement, and for a DLC pair the flag and the doctrine without it. */
interface Held
{
    name: string;
    node: PNode;
    inherited: boolean;
    dlc?: string;
    fallback?: string;
    /** where an inherited one comes from ("its religion", "its main rite") */
    from?: string;
}

/**
 * `doctrine = x`, `doctrines = { x y }` (1.20) and `doctrine_selection_pair = { requires_dlc_flag = f doctrine = x
 * fallback_doctrine = y }`.
 */
function held(list: PNode[], inherited: boolean, from?: string): Held[]
{
    const out: Held[] = [];

    for (const c of list)
    {
        if (c.k === 'doctrine' && typeof c.v === 'string')
            out.push({ name: c.v, node: c, inherited, from });
        else if (c.k === 'doctrines' && Array.isArray(c.v))
            out.push(...c.v.filter((x) => x.k === null && typeof x.v === 'string').map((x) => ({ name: x.v as string, node: x, inherited, from })));
        else if (c.k === 'doctrine_selection_pair' && Array.isArray(c.v))
        {
            const d = scalar(c.v, 'doctrine');

            if (d)
                out.push({ name: d, node: c, inherited, dlc: scalar(c.v, 'requires_dlc_flag'), fallback: scalar(c.v, 'fallback_doctrine'), from });
        }
    }

    return out;
}

/** Where a faith's or religion's doctrines are added (a row's act), and whether the missing ones are marked. */
interface DoctrinePlace
{
    /** the entry's definition (the acts' `src`) */
    src?: LineSource;
    /** where a doctrine goes */
    at?: SectionSource;
    /** the field set of its doctrine statements */
    fields: string;
    /** a faith (tenets; each group needs a doctrine, its own or its religion's) or a religion (they are optional) */
    faith: boolean;
    /** mark what is missing (a mod's entry; the game's are as they are) */
    marks: boolean;
    /**
     * 1.20 (tenets are their own type): the rows of a core_tenets doctrine group a mod still has go here, into the
     * faith's one Tenets section (tenetSection: its placeholders too), instead of a section of their own
     */
    tenets?: Line[];
}

/**
 * Doctrines as sections, grouped by their doctrine group (religion_types/_religion_types.info; doctrine_group_types):
 * "Tenets" (a faith picks 3: the missing ones as placeholders), then per category (Doctrines, Marriage, Crimes,
 * Clergy) one row per group: its doctrine (a faith's own, or its religion's "from its religion"), a placeholder when
 * none, a warning on a second one of a group that takes one; "Special doctrines" last (and doctrines in no group).
 * Rows change within their group (`choices`); placeholders pick from it.
 */
function doctrineSections(b: StoryBuilder, own: Held[], inherited: Held[], ctx: Ctx, p: DoctrinePlace): CardSection[]
{
    const { list, of } = doctrineGroups(b);
    const by = (hs: Held[]): Map<string, Held[]> =>
    {
        const m = new Map<string, Held[]>();

        for (const h of hs)
        {
            const g = of.get(h.name);

            if (g)
                m.set(g.key, [...(m.get(g.key) ?? []), h]);
        }

        return m;
    };
    const ownBy = by(own);
    // (inherited from several places; 1.20: main rite, then religion: the first that fills the group wins)
    const inhBy = new Map([...by(inherited)].map(([g, hs]) => [g, hs.filter((h) => h.from === hs[0].from)]));
    const pick = (label: string, only: string[], title: string): LineAct | undefined => p.src && p.at ? { label, src: p.src, do: { kind: 'pick', at: p.at, fields: p.fields, field: 'doctrine', only, title } } : undefined;
    const gseg = (g: DoctrineGroup): RichSeg => b.d.entitySeg(g.e);
    const dseg = (h: Held): Rich =>
    {
        const t: Rich = [b.d.ref(h.name, DOCTRINE)];
        return h.dlc ? rich(t, tr(' with {dlcName}', { dlcName: dlcName(h.dlc) }), h.fallback ? rich(tr(', else '), b.d.ref(h.fallback, DOCTRINE)) : '') : t;
    };
    /** the owner's own doctrine: changed within its group (its other doctrines not held) */
    const ownLine = (h: Held, g: DoctrineGroup, label: boolean, others: Set<string>): Line =>
    {
        const l = statementLine(b, h.node, ctx, label ? rich(gseg(g), ': ', dseg(h)) : dseg(h), h.dlc ? undefined : p.fields);

        if (!h.dlc)
            l.choices = g.doctrines.filter((d) => d === h.name || !others.has(d));

        return l;
    };
    const extra = (l: Line, g: DoctrineGroup): void =>
    {
        l.tone = 'bad';
        l.text = rich(l.text, { text: g.picks === 1 ? tr(' · a faith holds one of the group — remove the others') : tr(' · only {picks} of the group count', { picks: g.picks }), kind: 'ph' });
    };
    const out: CardSection[] = [];

    // tenets: a faith picks `number_of_picks` of them
    for (const g of list.filter((x) => x.category === 'core_tenets'))
    {
        const have = ownBy.get(g.key) ?? [];

        if (!have.length && !(p.faith && p.marks))
            continue;

        const names = new Set(have.map((h) => h.name));
        const lines = have.map((h, i) =>
        {
            const l = ownLine(h, g, false, names);
            l.icon = 'piety';

            if (i >= g.picks && !p.tenets)
                extra(l, g);

            return l;
        });

        if (p.tenets)
        {
            p.tenets.push(...lines);
            continue;
        }

        if (p.faith && p.marks)
        {
            for (let i = have.length; i < g.picks; i++)
                lines.push({
                    text: [{ text: tr('Tenet {value} of {picks}', { value: i + 1, picks: g.picks }), kind: 'ph' }, tr(' — not chosen')],
                    placeholder: true,
                    tone: 'bad',
                    icon: 'piety',
                    tip: tr('A faith has {picks} tenets ({key})', { picks: g.picks, key: g.key }),
                    act: pick('choose', g.doctrines.filter((d) => !names.has(d)), tr('Tenet {value} of {picks}', { value: i + 1, picks: g.picks }))
                });
        }

        out.push({ title: tr('Tenets'), lines, noAdd: true });
    }

    // one row per group of the main categories
    for (const [cat, title] of Object.entries(CREATABLE))
    {
        const lines: Line[] = [];

        for (const g of list.filter((x) => x.category === cat))
        {
            const have = ownBy.get(g.key) ?? [];
            const inh = inhBy.get(g.key) ?? [];

            if (have.length)
            {
                const names = new Set(have.map((h) => h.name));
                have.forEach((h, i) =>
                {
                    const l = ownLine(h, g, true, names);

                    if (i >= g.picks)
                        extra(l, g);

                    lines.push(l);
                });
            }
            else if (inh.length)
            {
                for (const h of inh)
                    lines.push({ text: rich(gseg(g), ': ', dseg(h), { text: tr(' · from {value}', { value: h.from ?? 'its religion' }), kind: 'ph' }), tip: `doctrine = ${h.name}`, act: p.marks ? pick('change', g.doctrines, g.label) : undefined });
            }
            else if (p.marks && g.everyFaith)
            {
                lines.push({
                    text: rich(gseg(g), ': ', { text: p.faith ? tr('not chosen') : tr('not set — each faith chooses'), kind: 'ph' }),
                    placeholder: true,
                    tone: p.faith ? 'bad' : undefined,
                    tip: tr('One of: {join}', { join: g.doctrines.join(', ') }),
                    act: pick('choose', g.doctrines, g.label)
                });
            }
        }

        if (lines.length)
            out.push({ title, lines, noAdd: true });
    }

    // special doctrines, and what no group lists
    const special = list.filter((g) => !(g.category in CREATABLE) && g.category !== 'core_tenets');
    const lines: Line[] = [];

    for (const g of special)
    {
        const have = ownBy.get(g.key) ?? [];

        for (const h of have)
            lines.push(ownLine(h, g, true, new Set(have.map((x) => x.name))));

        if (!have.length)
        {
            for (const h of inhBy.get(g.key) ?? [])
                lines.push({ text: rich(gseg(g), ': ', dseg(h), { text: tr(' · from {value}', { value: h.from ?? 'its religion' }), kind: 'ph' }), tip: `doctrine = ${h.name}` });
        }
    }

    for (const h of own.filter((x) => !of.has(x.name)))
    {
        const l = statementLine(b, h.node, ctx, rich(dseg(h), { text: tr(' · in no doctrine group: it does nothing'), kind: 'ph' }), p.fields);
        l.tone = 'bad';
        lines.push(l);
    }

    const add = p.marks ? pick(tr('＋ special doctrine'), special.flatMap((g) => g.doctrines), tr('Special doctrine')) : undefined;

    if (lines.length || add)
        out.push({ title: tr('Special doctrines'), lines, acts: add && [add], noAdd: true });

    return out;
}

/**
 * The loc keys of the names in game: a faith's or religion's, a doctrine's: label, required, several lines, and the
 * text function the game's texts show it with (an example sentence).
 */
function nameKeys(e: Entity): [string, string, boolean, boolean, string?][]
{
    const k = e.name;

    if (e.type === 'religion/doctrine_types')
        return [
            [`${k}_name`, 'Name', true, false],
            [`${k}_desc`, 'Description', false, true]
        ];

    return [
        [k, 'Name', true, false, 'GetName'],
        [`${k}_adj`, 'Adjective', true, false, 'GetAdjective'],
        [`${k}_adherent`, 'Adherent', true, false, 'GetAdherentName'],
        [`${k}_adherent_plural`, 'Adherents', true, false, 'GetAdherentNamePlural'],
        [`${k}_desc`, 'Description', false, true]
    ];
}

/**
 * "Names in game": each written (✎ changes it), else a placeholder ("write"); only a mod's entry has the latter. The
 * name forms get an example sentence of the game's with the word in its place (the placeholder's label when unwritten).
 */
function nameLines(b: StoryBuilder, e: Entity, src: LineSource | undefined, marks: boolean): Line[]
{
    const out: Line[] = [];
    const owner = e.type === 'faith' ? 'faith' : 'religion';

    for (const [key, label, required, multiline, fn] of nameKeys(e))
    {
        const text = b.idx.plainLoc(key);
        const act = (l: string): LineAct | undefined => (src ? { label: l, src, do: { kind: 'loc', key, multiline } } : undefined);
        let line: Line;

        if (text)
            line = { text: rich(label, ': ', text.includes('[') ? (b.d.loc(key) ?? text) : text), tip: key, act: act('✎') };
        else if (marks)
            line = { text: rich(label, ': ', { text: tr('not written'), kind: 'ph' }), placeholder: true, tone: required ? 'bad' : undefined, tip: key, act: act('write') };
        else
            continue;

        const ex = fn && b.nameExample(owner, fn);

        if (ex)
        {
            const word = text ? (ex.cap ? text.charAt(0).toUpperCase() + text.slice(1) : text) : undefined;
            line.children = [
                {
                    text: rich({ text: 'e.g. ', kind: 'ph' }, '“', ex.before, word ? { text: word, kind: 'value' } : { text: `‹${label.toLowerCase()}›`, kind: 'ph' }, ex.after, '”'),
                    icon: 'note',
                    tip: tr('A text of the game ({key}) with the {toLowerCase} in its place', { key: ex.key, toLowerCase: label.toLowerCase() })
                }
            ];
        }

        out.push(line);
    }

    return out;
}

/**
 * `traits = { virtues = { brave generous = 0.5 stubborn = { scale = 2 weight = 2 } } sins = { … } }`
 * (religion_types/_religion_types.info; doctrines add theirs): virtue / sin lines, a scale other than 1 as "×2".
 */
function virtueLines(b: StoryBuilder, traits: PNode | undefined, ctx: Ctx, inherited = false): Line[]
{
    if (!traits || !Array.isArray(traits.v))
        return [];

    const out: Line[] = [];

    for (const kind of ['virtues', 'sins'] as const)
    {
        const n = traits.v.find((c) => c.k === kind && Array.isArray(c.v));

        if (!n)
            continue;

        const parts: Rich[] = (n.v as PNode[]).flatMap((c) =>
        {
            const name = c.k ?? (typeof c.v === 'string' ? c.v : undefined);

            if (!name)
                return [];

            const scale = c.k === null ? undefined : typeof c.v === 'string' ? c.v : scalar(c.v, 'scale');
            return [rich(b.d.ref(name, ['traits']), scale && scale !== '1' ? { text: ` ×${scale}`, kind: 'value' } : '')];
        });

        if (!parts.length)
            continue;

        const text = rich(kind === 'virtues' ? tr('Virtues: ') : tr('Sins: '), joined(parts), inherited ? { text: tr(' · from its religion'), kind: 'ph' } : '');
        const extra: Partial<Line> = { icon: 'trait', tone: kind === 'virtues' ? 'good' : 'bad' };

        // (a mod's own: a row per trait (changed with the trait picker), "＋" on the list adds one)
        if (!inherited && ctx.file?.mod)
        {
            const kids = (n.v as PNode[])
                .filter((c) => c.k ?? (typeof c.v === 'string' ? c.v : undefined))
                .map((c, i) => statementLine(b, c, ctx, parts[i] ?? [c.k ?? String(c.v)], 'religion_virtues', extra));
            out.push(statementLine(b, n, ctx, [kind === 'virtues' ? 'Virtues:' : 'Sins:'], 'religion_virtues', { ...extra, children: kids }));
            continue;
        }

        out.push(inherited ? { text, ...extra } : statementLine(b, n, ctx, text, undefined, extra));
    }

    // (a mod's own list of only one kind: the other added with its first trait)
    if (!inherited && ctx.file?.mod)
    {
        const at = b.fieldAnchor(traits, ctx, 'religion_virtues', true);

        for (const kind of ['virtues', 'sins'] as const)
        {
            if (at && !traits.v.some((c) => c.k === kind))
                out.push({
                    text: [{ text: kind === 'virtues' ? tr('Virtues: none') : tr('Sins: none'), kind: 'ph' }],
                    icon: 'trait',
                    placeholder: true,
                    act: { label: kind === 'virtues' ? tr('＋ virtue') : tr('＋ sin'), src: at, do: { kind: 'pick', at: { parent: at, key: kind, kind: 'field' }, fields: 'religion_virtues', field: 'trait', title: kind === 'virtues' ? tr('A virtue') : tr('A sin') } }
                });
        }
    }

    return out;
}

/** The faith's own terms (`localization = { HighGodName = key … }`, `[Faith.Custom('key')]` in loc) worth showing. */
const TERMS: [string, string][] = [
    [tr('HighGodName'), tr('High god')],
    ['CreatorName', 'Creator'],
    ['DevilName', 'Devil'],
    [tr('HouseOfWorship'), tr('House of worship')],
    [tr('ReligiousSymbol'), tr('Holy symbol')],
    [tr('ReligiousText'), tr('Holy text')],
    [tr('ReligiousHeadName'), tr('Head of faith')],
    ['PriestMale', 'Priest'],
    ['BishopMale', 'Bishop'],
    ['DevoteeMale', 'Devotee'],
    ['PositiveAfterLife', 'Afterlife'],
    ['NegativeAfterLife', 'Damnation'],
    [tr('GHWName'), tr('Holy war')]
];
/** More terms: shown where written (no placeholder where missing: most religions have them, not all faiths need them) */
const MORE_TERMS: [string, string][] = [
    ['PantheonTerm', 'Pantheon'],
    [tr('DivineRealm'), tr('Divine realm')],
    [tr('GoodGodNames'), tr('Good gods')],
    [tr('EvilGodNames'), tr('Evil gods')],
    [tr('HealthGodName'), tr('God of health')],
    [tr('FertilityGodName'), tr('God of fertility')],
    [tr('WealthGodName'), tr('God of wealth')],
    [tr('HouseholdGodName'), tr('Household god')],
    [tr('FateGodName'), tr('God of fate')],
    [tr('KnowledgeGodName'), tr('God of knowledge')],
    [tr('WarGodName'), tr('God of war')],
    [tr('TricksterGodName'), tr('Trickster god')],
    [tr('NightGodName'), tr('God of the night')],
    [tr('WaterGodName'), tr('God of water')],
    [tr('WitchGodName'), tr('God of witches')],
    [tr('DeathDeityName'), tr('God of death')]
];

/**
 * Terms of a faith or religion (its own `localization`, else (a faith) its religion's: missing keys are inherited).
 * `owner` (a mod's entry): each term can be written for it (a text under a key of its own); missing ones are placeholders.
 */
function termLines(b: StoryBuilder, own: PNode[] | undefined, inherited: PNode[] | undefined, ctx: Ctx, owner?: { e: Entity; src: LineSource; }): Line[]
{
    const out: Line[] = [];

    for (const [k, label, more] of [...TERMS, ...MORE_TERMS.map(([k, l]): [string, string, boolean] => [k, l, true])])
    {
        const mine = own?.find((c) => c.k === k);
        const c = mine ?? inherited?.find((x) => x.k === k);
        const key = typeof c?.v === 'string' ? c.v : c ? (items(c)[0]?.v as string | undefined) : undefined;
        const act = (l: string): LineAct | undefined => owner && { label: l, src: owner.src, do: { kind: 'term', term: k, owner: { type: owner.e.type, name: owner.e.name } } };
        // (a list (the good gods, the evil ones): all of them)
        const value = (): Rich =>
            c && Array.isArray(c.v) && items(c).length > 1
                ? joined(items(c).map((x) => b.d.loc(x.v as string) ?? [{ text: x.v as string, kind: 'code' as const }]).map((r) => rich(r)), ', ')
                : b.d.loc(key!) ?? [{ text: key!, kind: 'code' }];

        if (c && key)
        {
            const text = rich(label, ': ', value(), mine ? '' : { text: tr(' · from its religion'), kind: 'ph' });
            const l = mine ? statementLine(b, c, ctx, text) : { text, tip: `${k} = ${key}` };
            out.push({ ...l, act: act('✎') });
        }
        else if (owner && !more)
        {
            out.push({ text: rich(label, ': ', { text: tr('not written'), kind: 'ph' }), placeholder: true, tone: 'bad', tip: tr('{k} — texts use it as [Faith.{k}]', { k }), act: act('write') });
        }
    }

    return out;
}

/** Holy order names (`holy_order_names = { { name = key coat_of_arms = coa } … }`) and a religion's `holy_order_maa`. */
function holyOrderLines(b: StoryBuilder, body: PNode[], ctx: Ctx): Line[]
{
    const out: Line[] = [];
    const names = body.find((c) => c.k === 'holy_order_names' && Array.isArray(c.v));

    if (names)
    {
        const list = (names.v as PNode[]).map((o) => (Array.isArray(o.v) ? scalar(o.v, 'name') : undefined)).filter((x): x is string => !!x);

        if (list.length)
            out.push(statementLine(b, names, ctx, [tr('Names: {sample}', { sample: sample(list.map((x) => word(b, x)), 8) })]));
    }

    const maa = body.find((c) => c.k === 'holy_order_maa' && Array.isArray(c.v));

    if (maa)
        out.push(statementLine(b, maa, ctx, rich(tr('Men-at-arms: '), joined(items(maa).map((x) => b.d.ref(x.v as string, ['men_at_arms_types'])), ' or ')), undefined, { icon: 'modifier' }));

    return out;
}

/** `reserved_male_names = { … }` / `reserved_female_names`: base names other faiths don't pick at random. */
function reservedLines(b: StoryBuilder, body: PNode[], ctx: Ctx): Line[]
{
    return body
        .filter((c) => (c.k === 'reserved_male_names' || c.k === 'reserved_female_names') && Array.isArray(c.v))
        .map((c) => statementLine(b, c, ctx, [`${c.k === 'reserved_male_names' ? 'Men' : 'Women'}: ${sample(items(c).map((x) => word(b, x.v as string)), 10)}`]));
}

/**
 * The tenet banners (1.20: four keys, religion_family_types/_religion_family_types.info; a religion overrides its family's
 * with all four in `religion_details`) and 1.19's one `doctrine_background_icon`, which a mod written for it still has.
 */
const BANNER_KEY = 'tenet_background_icon';
const OLD_BANNER_KEY = 'doctrine_background_icon';
const BANNER_KEYS = [BANNER_KEY, 'tenet_heretical_background_icon', 'tenet_neutral_background_icon', 'tenet_unknown_background_icon'];

/** Graphics settings a faith falls back on from its religion and family (faith > religion > family). */
const LOOK_KEYS = ['graphical_faith', 'piety_icon_group', ...BANNER_KEYS, OLD_BANNER_KEY];

/**
 * A religion's settings as the cards read them: its top-level statements and those in `religion_details` (1.20 reads
 * family, graphical_faith, piety_icon_group, the tenet banners … only there; 1.19 wrote them at the top).
 */
function lookBody(body: PNode[]): PNode[]
{
    const details = body.find((c) => c.k === 'religion_details' && Array.isArray(c.v))?.v as PNode[] | undefined;
    return details ? [...body, ...details] : body;
}

/** A setting of a body, the tenet banner under either of its keys (1.20's, else 1.19's). */
const lookValue = (body: PNode[], k: string): string | undefined => scalar(body, k) ?? (k === BANNER_KEY ? scalar(body, OLD_BANNER_KEY) : undefined);

/** A faith's, religion's or family's settings: head of faith, family, temple models, piety icons, tenet banner. */
function settingLines(b: StoryBuilder, body: PNode[], ctx: Ctx, fields: string): Line[]
{
    const out: Line[] = [];

    for (const c of body)
    {
        if (!c.k || typeof c.v !== 'string')
            continue;

        const v = c.v;
        let text: Rich | undefined;

        if (c.k === 'religious_head')
            text = rich(tr('Head of faith: '), b.d.ref(v, ['landed_titles']));
        else if (c.k === 'family')
            text = rich(tr('Family: '), b.d.ref(v, ['religion/religion_family_types']));
        else if (c.k === 'hostility_doctrine')
            text = rich(tr('Hostility levels shown with '), b.d.ref(v, DOCTRINE));
        else if (c.k === 'pagan_roots')
            text = [v === 'yes' ? 'Pagan roots: faiths without the Unreformed doctrine count as reformed' : 'No pagan roots'];
        else if (c.k === 'reformed_icon')
            text = rich(tr('Icon once reformed: '), { text: v, kind: 'code' });
        else if (c.k === 'graphical_faith')
            text = rich(tr('3D models (temples): '), { text: titleCase(humanize(v.replace(/_gfx$/, ''))), kind: 'value', tip: v });
        else if (c.k === 'piety_icon_group')
            text = rich(tr('Piety icons: '), { text: titleCase(humanize(v)), kind: 'value', tip: v });
        else if (c.k === BANNER_KEY || c.k === OLD_BANNER_KEY)
            text = rich(tr('Tenet banner: '), { text: v, kind: 'code' });
        else if (c.k === 'tenet_heretical_background_icon')
            text = rich(tr('Tenet banner (prohibited): '), { text: v, kind: 'code' });
        else if (c.k === 'tenet_neutral_background_icon')
            text = rich(tr('Tenet banner (known): '), { text: v, kind: 'code' });
        else if (c.k === 'tenet_unknown_background_icon')
            text = rich(tr('Tenet banner (unknown): '), { text: v, kind: 'code' });
        else if (c.k === 'theocracy_government_type')
            text = rich(tr('Theocratic government: '), b.d.ref(v, ['governments']));
        else if (c.k === 'theocracy_lease_contract_type')
            text = rich(tr('Theocratic lease contract: '), { text: v, kind: 'code' });

        if (text)
            out.push(statementLine(b, c, ctx, text, fields));
    }

    return out;
}

/** `#rrggbb` of a colour segment → 0–1 parts. */
function rgbOf(seg: RichSeg): [number, number, number] | undefined
{
    const m = typeof seg !== 'string' && seg.kind === 'color' ? /^#(..)(..)(..)$/.exec(seg.text) : null;
    return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : undefined;
}

/** A faith's colour (`color = { r g b }`): changed with a colour picker; missing, a placeholder (a mod's faith). */
function colorLines(b: StoryBuilder, body: PNode[], ctx: Ctx, src: LineSource | undefined, at: SectionSource | undefined, marks: boolean): Line[]
{
    const c = body.find((x) => x.k === 'color');

    if (c)
    {
        const seg = colorSeg(b, c);
        const l = statementLine(b, c, ctx, rich(tr('Colour: '), seg));

        if (src && l.src)
            l.act = { label: 'change', src, do: { kind: 'color', replace: l.src, now: rgbOf(seg) } };

        return [l];
    }

    if (!marks)
        return [];

    return [{ text: rich(tr('Colour: '), { text: tr('not set'), kind: 'ph' }), placeholder: true, tone: 'bad', tip: 'color = { r g b }: the faith on the map and in the interface', act: src && at ? { label: 'choose', src, do: { kind: 'color', at } } : undefined }];
}

/**
 * The icon (`icon = x`, else the entry's key: `<folder>/<x>.dds`): shown when set; a missing file is marked, with an
 * act choosing one of the icons there (field `icon` of the set `fields`).
 */
function iconLines(b: StoryBuilder, e: Entity, body: PNode[], ctx: Ctx, folder: string, fields: string, src: LineSource | undefined, at: SectionSource | undefined, marks: boolean): Line[]
{
    const c = body.find((x) => x.k === 'icon' && typeof x.v === 'string');
    const name = typeof c?.v === 'string' ? c.v : e.name;
    const path = `${folder}/${name}.dds`;
    const img = b.idx.imageAt(path);
    const found = !!img;

    if (c)
    {
        // (the picture itself where the file is there)
        const l = statementLine(b, c, ctx, rich(tr('Icon: '), img ? { text: img.name, kind: 'image', tip: name } : { text: name, kind: 'code' }, found ? '' : { text: tr(' — {path} is missing', { path }), kind: 'ph' }), fields);

        if (!found && marks)
            l.tone = 'bad';

        return [l];
    }

    if (found || !marks)
        return [];

    return [{ text: rich(tr('Icon: '), { text: tr('none — {path} is missing', { path }), kind: 'ph' }), placeholder: true, tone: 'bad', tip: `icon = <name>: ${folder}/<name>.dds`, act: src && at ? { label: 'choose', src, do: { kind: 'pick', at, fields, field: 'icon', title: tr('Icon') } } : undefined }];
}

/** Graphics a faith / religion does not set itself: its religion's or family's (shown as such). */
function inheritedLook(body: PNode[], fromBody: PNode[], what: string): Line[]
{
    // (the banner under either key; of the other three only the main one is told)
    return ['graphical_faith', 'piety_icon_group', BANNER_KEY].filter((k) => !lookValue(body, k) && lookValue(fromBody, k)).map((k) =>
    {
        const v = lookValue(fromBody, k)!;
        const label = k === 'graphical_faith' ? tr('3D models (temples)') : k === 'piety_icon_group' ? tr('Piety icons') : tr('Tenet banner');
        const shown = k === BANNER_KEY ? v : titleCase(humanize(v.replace(/_gfx$/, '')));
        return { text: rich(label, ': ', { text: shown, kind: 'value', tip: v }, { text: tr(' · from its {what}', { what }), kind: 'ph' }), tip: `${k} = ${v}` };
    });
}

/** "N to fill in" among the facts when the card has required placeholders. */
function missingFact(card: EntityCard): void
{
    let n = 0;
    const walk = (lines: Line[]): void =>
    {
        for (const l of lines)
        {
            if (l.placeholder && l.tone === 'bad')
                n++;

            if (l.children)
                walk(l.children);
        }
    };

    for (const s of card.sections)
        walk(s.lines);

    if (n)
        card.facts.push([{ text: tr('{n} to fill in', { n }), kind: 'bad', tip: tr('Marked below — each with what fills it in') }]);
}

const FAITH_SKIP = new Set([
    'doctrine',
    'doctrine_selection_pair',
    'holy_site',
    'religious_head',
    'color',
    'icon',
    'reformed_icon',
    'localization',
    'holy_order_names',
    'reserved_male_names',
    'reserved_female_names',
    ...LOOK_KEYS,
    // (1.20)
    'faith_details',
    'doctrines',
    'tenets',
    'tenet_selection_pair',
    'holy_sites',
    'eminent_holy_sites',
    'main_rite',
    'origin'
]);

/** An old-layout part of a mod's entry the 1.20 game no longer reads (docs/game-structure.md, "Layouts that changed"). */
export interface Obsolete
{
    text: string;
    /** what it is in 1.20 */
    tip: string;
}

/**
 * "Update for 1.20": what of a mod's entry the 1.20 game no longer reads, one line each, with the fix (modernize.ts)
 * on the first when it is the active mod's (`src`); marked on any mod's entry. Nothing on the game's own entries or
 * with a game before 1.20.
 */
export function updateSection(b: StoryBuilder, e: Entity, src: LineSource | undefined, items: Obsolete[], fix?: { type: string; name: string; fix: string; label: string; }): CardSection | undefined
{
    const d = b.idx.winningDef(e);

    if (!items.length || !d || !b.idx.files[d.file] || b.idx.files[d.file].source === 0 || !tenetsOwnType(b.idx))
        return undefined;

    const act: LineAct | undefined = fix && src?.mod ? { label: fix.label, src, do: { kind: 'modernize', type: fix.type, name: fix.name, fix: fix.fix } } : undefined;
    return {
        title: tr('Update for 1.20'),
        // (`code` in the texts as code; a placeholder each, its fix in view, counted among what is to fill in)
        lines: items.map((o, i): Line => ({
            text: rich({ text: tr('Obsolete: '), kind: 'bad' }, ...o.text.split('`').map((t, j): RichSeg => (j % 2 ? { text: t, kind: 'code' } : t))),
            tone: 'bad',
            placeholder: true,
            icon: 'note',
            tip: o.tip,
            act: i === 0 ? act : undefined
        })),
        noAdd: true
    };
}

/** What of a faith the 1.20 game no longer reads (written inside its religion, settings outside faith_details …). */
function faithObsolete(b: StoryBuilder, body: PNode[], nested: boolean): Obsolete[]
{
    const out: Obsolete[] = [];
    const tenetNames = new Set([...b.idx.names('religion/tenet_types'), ...tenetGroupDoctrines(b.idx)]);

    if (nested)
        out.push({ text: 'written inside its religion (`faiths = { }`): 1.20 reads faiths from common/religion/faith_types', tip: 'Update: moved there, with `faith_details = { religion = … }`' });

    const top = body.filter((c) => c.k && FAITH_DETAIL_KEYS.has(c.k)).map((c) => c.k!);

    if (top.length)
        out.push({ text: `${top.join(', ')} at the faith's top: 1.20 reads them from \`faith_details = { }\``, tip: 'Update: moved into faith_details' });

    if (body.some((c) => c.k === 'holy_site'))
        out.push({ text: '`holy_site = …`: 1.20 lists them in `holy_sites = { }` / `eminent_holy_sites = { }`', tip: 'Update: collected into holy_sites' });

    const doctrines = body.filter((c) => c.k === 'doctrine' && typeof c.v === 'string').map((c) => c.v as string);
    // (tenets among the doctrines: written `doctrine = x`, or in a 1.20 `doctrines = { }` list)
    const listed = items(block(body, 'doctrines')).map((c) => c.v as string);
    const tenets = [...doctrines, ...listed].filter((d) => tenetNames.has(d));

    if (tenets.length)
        out.push({ text: `tenets written as doctrines (${tenets.join(', ')}): 1.20 has tenets of their own (\`tenets = { }\`)`, tip: tr('Update: moved into tenets (a tenet the mod wrote as a doctrine: update that doctrine too)') });

    if (doctrines.some((d) => !tenetNames.has(d)))
        out.push({ text: "`doctrine = …`: 1.20 lists a faith's doctrines in `doctrines = { }`", tip: tr('Update: collected into doctrines') });

    // (1.19's DLC pair of doctrines, tenets now: `tenet_selection_pair`; a pair of plain doctrines has no 1.20 form)
    const oldPair = body.some((c) => c.k === 'doctrine_selection_pair' && Array.isArray(c.v)
        && c.v.some((x) => (x.k === 'doctrine' || x.k === 'fallback_doctrine') && typeof x.v === 'string')
        && c.v.filter((x) => (x.k === 'doctrine' || x.k === 'fallback_doctrine') && typeof x.v === 'string').every((x) => tenetNames.has(x.v as string)));

    if (oldPair)
        out.push({ text: '`doctrine_selection_pair` of tenets: 1.20 writes `tenet_selection_pair = { requires_dlc_flag tenet fallback_tenet }`', tip: tr('Update: the pair is written as a tenet pair') });

    return out;
}

/** How many tenets a faith picks (the game's faith creation). */
const TENET_PICKS = 3;

/**
 * A faith's tenets (1.20) as one section: its own `tenets = { … }` (each changed among every tenet type (the game's
 * and the mods', field set `faith_tenets`), removed, "＋ tenet" another (the block made when missing)), DLC pairs and
 * `older` (tenets a mod still writes as doctrines of a tenet group: doctrineSections' `tenets`); a mod's faith with
 * fewer than 3 gets placeholders picking any tenet; without tenets of its own, its main rite's (the game takes the
 * rite's when it has some), shown as such.
 */
function tenetSection(b: StoryBuilder, body: PNode[], rite: PNode[] | undefined, ctx: Ctx, src: LineSource | undefined, older: Line[]): CardSection | undefined
{
    const seg = (t: { name: string; dlc?: string; fallback?: string; }): Rich => rich(b.d.ref(t.name, ['religion/tenet_types']), t.dlc ? rich(tr(' with {dlcName}', { dlcName: dlcName(t.dlc) }), t.fallback ? rich(tr(', else '), b.d.ref(t.fallback, ['religion/tenet_types'])) : '') : '');
    const list = body.find((c) => c.k === 'tenets' && Array.isArray(c.v));
    // (where a tenet goes: the list, or (a mod's faith without one) the list made with it)
    const at: SectionSource | undefined = list ? b.blockSection(list, 'field', ctx, 'faith_tenets') : src?.mod ? { parent: { ...src, kind: 'field', fields: 'faith_tenets' }, key: 'tenets', kind: 'field' } : undefined;
    const own = [
        ...(list ? b.fieldLines('faith_tenets', list.v as PNode[], ctx).map((l) => ({ ...l, icon: 'piety' as const })) : []),
        ...tenetsOf(body)
            .filter((t) => t.node.k === 'tenet_selection_pair')
            .map((t) => statementLine(b, t.node, ctx, seg(t), undefined, { icon: 'piety' }))
    ];
    own.push(...older);
    const fromRite = !own.length && rite ? tenetsOf(rite) : [];
    const lines = own.length ? own : fromRite.map((t): Line => ({ text: rich(seg(t), { text: tr(' · from its main rite'), kind: 'ph' }), icon: 'piety', tip: t.name }));

    // (a mod's faith: the tenets still to choose: any tenet type not held yet)
    if (src?.mod && at && !fromRite.length)
    {
        const heldNames = new Set([...tenetsOf(body).map((t) => t.name), ...older.map((l) => l.tip ?? '')]);
        const only = b.idx.names('religion/tenet_types').filter((t) => !heldNames.has(t));

        for (let i = own.length; i < TENET_PICKS; i++)
            lines.push({
                text: [{ text: tr('Tenet {value} of {TENET_PICKS}', { value: i + 1, TENET_PICKS }), kind: 'ph' }, tr(' — not chosen')],
                placeholder: true,
                tone: 'bad',
                icon: 'piety',
                tip: tr('A faith has {TENET_PICKS} tenets', { TENET_PICKS }),
                act: { label: 'choose', src, do: { kind: 'pick', at, fields: 'faith_tenets', field: 'tenet', only, title: tr('Tenet {value} of {TENET_PICKS}', { value: i + 1, TENET_PICKS }) } }
            });
    }

    if (!lines.length && !at)
        return undefined;

    return { title: tr('Tenets'), lines, src: at, addLabel: 'tenet' };
}

/**
 * A faith (religion_types/_religion_types.info, `faiths = { … }`): its religion and head of faith, names in game,
 * tenets, doctrines by group (its religion's where it has none of the group), holy sites, its religion's virtues and
 * sins, its terms, holy orders, settings.
 */
const faith: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const religion = faithReligion(b.idx, e);
    const rbody = bodyOf(b, religion);
    const src = card.src;
    const marks = !!src?.mod;
    // (1.20: settings in `faith_details`, a main rite with tenets and doctrines of its own)
    const details = faithDetails(body);
    const fbody = details ? [...body, ...details.v] : body;
    const riteKey = scalar(body, 'main_rite');
    const rite = riteKey ? bodyOf(b, b.idx.get('religion/rite_types', riteKey)) : undefined;

    if (religion)
        card.facts.push(rich(tr('Religion: '), b.d.entitySeg(religion)));

    if (riteKey)
        card.facts.push(rich(tr('Main rite: '), b.d.ref(riteKey, ['religion/rite_types'])));

    const head = faithField(body, 'religious_head');

    if (typeof head?.v === 'string')
        card.facts.push(rich(tr('Head of faith: '), b.d.ref(head.v, ['landed_titles'])));

    const origin = scalar(body, 'origin');

    if (origin)
        card.facts.push(rich(tr('Grew out of '), b.d.ref(origin, ['faith'])));

    const sites = faithHolySites(body);

    if (sites.length)
        card.facts.push([tr('{length} holy site{value}', { length: sites.length, value: sites.length === 1 ? '' : 's' })]);

    // (1.20: the settings go into `faith_details`, doctrines into `doctrines = { }`, holy sites into `holy_sites = { }`,
    // each the existing block, else made with the first item; a faith of the older layout: statements at its top)
    const place = (k: string, fields: string): SectionSource | undefined =>
    {
        const n = body.find((c) => c.k === k && Array.isArray(c.v));
        return n ? b.blockSection(n, 'field', ctx, fields) : src?.mod ? { parent: { ...src, kind: 'field', fields }, key: k, kind: 'field' } : undefined;
    };
    const settings = details ? place('faith_details', 'faith_details') : own('field', 'faith');
    const detailSet = details ? 'faith_details' : 'faith';
    // (a faith found by the block it is written in (no faith_details religion): nested the old way)
    const update = updateSection(b, e, src, faithObsolete(b, body, !!religion && !faithField(body, 'religion')), { type: 'faith', name: e.name, fix: 'faith', label: 'update' });

    if (update)
        card.sections.push(update);

    card.sections.push({ title: tr('Names in game'), lines: nameLines(b, e, src, marks), noAdd: true });
    // (a group's doctrine: the faith's own, else its main rite's, else its religion's; 1.20: tenets are their own type;
    // tenets a mod still writes as doctrines of a tenet group join them in one section)
    const inherited = [...(rite ? held(rite, true, tr('its main rite')) : []), ...held(rbody, true)];
    const newTenets = b.idx.names('religion/tenet_types').length > 0;
    const older: Line[] = [];
    const doctrineSecs = doctrineSections(b, held(body, false), inherited, ctx, { src, at: details ? place('doctrines', 'faith_doctrines') : settings, fields: details ? 'faith_doctrines' : 'faith', faith: true, marks, tenets: newTenets ? older : undefined });
    const tenets = newTenets ? tenetSection(b, body, rite, ctx, src, older) : undefined;

    if (tenets)
        card.sections.push(tenets);

    card.sections.push(...doctrineSecs);
    const siteLines = sites.map((h) => statementLine(b, h.node, ctx, rich(holySiteSeg(b, h.name), h.eminent ? { text: tr(' · eminent: global bonuses too'), kind: 'ph' } : ''), 'faith', { icon: 'piety', locKey: `holy_site_${h.name}_name` }));

    if (!sites.length && marks)
        siteLines.push({ text: [{ text: tr('No holy sites yet'), kind: 'ph' }], placeholder: true, icon: 'piety', tip: tr('Faiths usually have 5: they give their holders’ modifiers and are what great holy wars are for') });

    // (`holy_site = x` is the old layout's: a 1.20 faith lists them)
    const siteAt = details ? place('holy_sites', 'faith_holy_sites') : settings;
    const siteAdd: LineAct | undefined = src && siteAt ? { label: tr('＋ holy site'), src, do: { kind: 'pick', at: siteAt, fields: details ? 'faith_holy_sites' : 'faith', field: 'holy_site', title: tr('Holy site') } } : undefined;
    card.sections.push({ title: tr('Holy sites'), lines: siteLines, src: siteAt, acts: siteAdd && [siteAdd], noAdd: true });
    const virtues = virtueLines(b, rbody.find((c) => c.k === 'traits'), ctx, true);

    if (virtues.length)
        card.sections.push({ title: tr('Virtues and sins'), lines: virtues });

    const terms = termLines(b, block(body, 'localization'), block(rbody, 'localization'), ctx, src && marks ? { e, src } : undefined);

    if (terms.length)
        card.sections.push({ title: tr('Terms'), lines: terms, noAdd: true });

    const orders = holyOrderLines(b, body, ctx);

    if (orders.length)
        card.sections.push({ title: tr('Holy orders'), lines: orders });

    const reserved = reservedLines(b, body, ctx);

    if (reserved.length)
        card.sections.push({ title: tr('Reserved names'), lines: reserved });

    // (the religion's settings: 1.20 in `religion_details`)
    const rlook = lookBody(rbody);
    const family = religion ? b.idx.get('religion/religion_family_types', scalar(rlook, 'family') ?? '') : undefined;
    const look = [...colorLines(b, fbody, ctx, src, settings, marks), ...iconLines(b, e, fbody, ctx, 'gfx/interface/icons/faith', detailSet, src, settings, marks), ...settingLines(b, fbody, ctx, 'faith'), ...inheritedLook(fbody, rlook, 'religion')];

    if (family)
        look.push(...inheritedLook([...fbody, ...rlook], bodyOf(b, family), 'family'));

    card.sections.push({ title: tr('Settings'), lines: look, src: settings });
    missingFact(card);
    b.genericSections(e, body, card, ctx, own, FAITH_SKIP);
    return true;
};

/** A holy site by its name in game (`holy_site_<key>_name`, religion/holy_site_types). */
function holySiteSeg(b: StoryBuilder, key: string): RichSeg
{
    const seg = b.d.ref(key, ['religion/holy_site_types']);
    const name = b.idx.plainLoc(`holy_site_${key}_name`);
    return name && typeof seg !== 'string' ? { ...seg, text: name } : seg;
}

/**
 * A holy site (holy_site_types/_holy_site_types.info): its modifiers, and the scaled ones: 1.20.1's
 * `faith_character_modifier_scaled` / `county_modifier_scaled` blocks hold modifiers plus a `scale` (a script value with
 * the holy site as scope) the modifiers are multiplied by; shown as a group naming the scale, not `scale` as a modifier.
 */
const holySite: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const isScaled = (c: PNode): boolean => !!c.k && /_modifier_scaled$/.test(c.k) && Array.isArray(c.v);
    const scaled = body.filter(isScaled);
    // (its name in game: `holy_site_<key>_name`, no name candidate of the type; "✎" on the title changes it)
    card.titleKey = `holy_site_${e.name}_name`;
    const shown = b.idx.plainLoc(card.titleKey)?.trim();

    if (shown)
        card.title = b.d.plainText(shown).trim();
    b.genericSections(e, body.filter((c) => !isScaled(c)), card, ctx, own, undefined, true);
    const lines: Line[] = [];

    for (const c of scaled)
    {
        const kids = c.v as PNode[];
        const scale = scalar(kids, 'scale');
        const who = capitalize(humanize(c.k!.replace(/_modifier_scaled$/, '')));
        // (one sentence for the translators: the parts are cut out at the markers)
        const sentence = scale ? tr('{who} modifiers, times {scale}:', { who: '\u0001', scale: '\u0002' }) : tr('{who} modifiers, times a scale not written:', { who: '\u0001' });
        const label = rich(...sentence.split(/([\u0001\u0002])/).filter((p) => p).map((p) => p === '\u0001' ? who : p === '\u0002' ? b.d.ref(scale!, ['script_values']) : p));
        const l: Line = { text: label, children: b.d.statsOf(kids.filter((x) => x.k !== 'scale'), ctx), icon: 'modifier', tip: `${c.k}: ${tr('the modifiers multiplied by the scale (a script value evaluated with the holy site as scope)')}` };

        if (ctx.file)
        {
            const src = b.d.anchor(c, ctx, 'modifier', true);
            const applies = modifierScopeOf(c.k!.replace(/_scaled$/, ''));
            l.src = src && applies ? { ...src, innerScope: applies } : src;
        }

        lines.push(l);
    }

    if (lines.length)
        card.sections.push({ title: tr('Scaled modifiers'), lines, noAdd: true });

    return true;
};

const RELIGION_SKIP = new Set([...FAITH_SKIP, 'family', 'faiths', 'traits', 'pagan_roots', 'custom_faith_icons', 'holy_order_maa', 'religion_details', 'theocracy_government_type', 'theocracy_lease_contract_type']);

/**
 * A religion (religion_types/_religion_types.info): names in game, faiths ("＋ faith"), the doctrines every faith
 * starts with (by group, added before `faiths`, where the game reads them), virtues and sins, terms, holy orders,
 * reserved names, settings, custom faith icons.
 */
const religion: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const src = card.src;
    const marks = !!src?.mod;
    // (1.20: in `religion_details`)
    const looks = lookBody(body);
    const family = scalar(looks, 'family');

    if (family)
        card.facts.push(rich(tr('Family: '), b.d.ref(family, ['religion/religion_family_types'])));

    const faithsNode = body.find((c) => c.k === 'faiths' && Array.isArray(c.v));
    const nested = faithsNode ? (faithsNode.v as PNode[]).filter((c) => c.k && Array.isArray(c.v)) : [];
    // (1.20: the faiths naming it in religion/faith_types)
    const named = religionFaiths(b.idx, e).filter((f) => !nested.some((n) => n.k === f.name));
    const count = nested.length + named.length;
    card.facts.push([tr('{count} faith{value}', { count, value: count === 1 ? '' : 's' })]);

    if (scalar(body, 'pagan_roots') === 'yes')
        card.facts.push([tr('Pagan roots')]);

    // (1.20 reads the settings of a religion only inside `religion_details`; a religion with faiths written inside it has both
    // to move, its update does both. The old banner alone has no fix of the card: the migration brings the keys in)
    const atTop = body.filter((c) => c.k && RELIGION_DETAIL_KEYS.includes(c.k) && typeof c.v === 'string').map((c) => c.k!);
    const oldBanner = looks.some((c) => c.k === OLD_BANNER_KEY);
    const obsolete: Obsolete[] = [];

    if (nested.length)
        obsolete.push({ text: tr('{length} faith{value} written inside the religion (`faiths = { }`) — 1.20 reads faiths from common/religion/faith_types', { length: nested.length, value: nested.length === 1 ? '' : 's' }), tip: tr('Update: moved there, each with `faith_details = { religion = … }`') });

    if (atTop.length)
        obsolete.push({ text: tr('{list} at the religion’s top — 1.20 reads them from `religion_details = { }` (without a family the religion has no hostility, piety icons or temple models)', { list: atTop.join(', ') }), tip: tr('Update: moved into religion_details') });

    if (oldBanner)
        obsolete.push({ text: tr('`doctrine_background_icon` — 1.20 has four tenet banner keys, all four in `religion_details` to override the family’s'), tip: tr('The migration brings the keys in with the banner the mod ships; without one the key goes and the family’s banners apply') });

    const update = updateSection(
        b,
        e,
        src,
        obsolete,
        nested.length || atTop.length ? { type: 'religion/religion_types', name: e.name, fix: nested.length ? 'religion-faiths' : 'religion-details', label: 'update' } : undefined
    );

    if (update)
        card.sections.push(update);

    card.sections.push({ title: tr('Names in game'), lines: nameLines(b, e, src, marks), noAdd: true });
    const faithText = (name: string, fb: PNode[]): Rich =>
    {
        const head = faithField(fb, 'religious_head');
        return rich(b.d.ref(name, ['faith']), typeof head?.v === 'string' ? rich({ text: tr(' · head of faith: '), kind: 'ph' }, b.d.ref(head.v, ['landed_titles'])) : '');
    };
    const faithLines: Line[] = [
        ...nested.map((f) => statementLine(b, f, ctx, faithText(f.k!, f.v as PNode[]), undefined, { icon: 'piety' })),
        ...named.map((f): Line => ({ text: faithText(f.name, bodyOf(b, f)), icon: 'piety', tip: f.name }))
    ];

    if (!count && marks)
        faithLines.push({ text: [{ text: tr('No faith yet — a religion needs at least one'), kind: 'ph' }], placeholder: true, tone: 'bad', icon: 'piety' });

    card.sections.push({ title: tr('Faiths'), lines: faithLines, acts: src ? [{ label: tr('＋ faith'), src, do: { kind: 'faith', religion: e.name } }] : undefined, noAdd: true });
    // (a religion's doctrines stand before its faiths: the game reads none after them)
    const settings = own('field', 'religion/religion_types');
    // (1.20: family, temple models, piety icons and banners go into `religion_details`: the block, else made with the first one;
    // pagan_roots and the doctrines stay at the top)
    const detailsNode = body.find((c) => c.k === 'religion_details' && Array.isArray(c.v));
    const lookAt: SectionSource | undefined = detailsNode ? b.blockSection(detailsNode, 'field', ctx, 'religion/religion_details') : src?.mod && tenetsOwnType(b.idx) ? { parent: { ...src, kind: 'field', fields: 'religion/religion_details' }, key: 'religion_details', kind: 'field' } : undefined;
    const before = faithsNode && b.fieldAnchor(faithsNode, ctx, 'religion/religion_types');
    const at: SectionSource | undefined = before ? { before, key: '', kind: 'field' } : settings;
    card.sections.push(...doctrineSections(b, held(body, false), [], ctx, { src, at, fields: 'religion/religion_types', faith: false, marks }));
    const virtues = virtueLines(b, body.find((c) => c.k === 'traits'), ctx);

    if (virtues.length)
        card.sections.push({ title: tr('Virtues and sins'), lines: virtues });

    const terms = termLines(b, block(body, 'localization'), undefined, ctx, src && marks ? { e, src } : undefined);

    if (terms.length)
        card.sections.push({ title: tr('Terms'), lines: terms, noAdd: true });

    const orders = holyOrderLines(b, body, ctx);

    if (orders.length)
        card.sections.push({ title: tr('Holy orders'), lines: orders });

    const reserved = reservedLines(b, body, ctx);

    if (reserved.length)
        card.sections.push({ title: tr('Reserved names'), lines: reserved });

    const look = settingLines(b, looks, ctx, 'religion/religion_types');

    if (!family && marks)
        look.unshift({ text: rich(tr('Family: '), { text: tr('not set'), kind: 'ph' }), placeholder: true, tone: 'bad', tip: 'family = rf_… (religion/religion_family_types)', act: src && (lookAt ?? at) ? { label: 'choose', src, do: { kind: 'pick', at: (lookAt ?? at)!, fields: lookAt ? 'religion/religion_details' : 'religion/religion_types', field: 'family', title: tr('Family') } } : undefined });

    const fam = family ? b.idx.get('religion/religion_family_types', family) : undefined;

    if (fam)
        look.push(...inheritedLook(looks, bodyOf(b, fam), 'family'));

    const icons = body.find((c) => c.k === 'custom_faith_icons' && Array.isArray(c.v));

    if (icons)
        look.push(statementLine(b, icons, ctx, [tr('{length} icons to choose from for new faiths', { length: items(icons).length })]));

    // (pagan_roots stays at the top: its own "＋", the details block's ones are the look)
    const roots: LineAct | undefined = lookAt && src && settings && scalar(body, 'pagan_roots') === undefined ? { label: tr('＋ pagan roots'), src, do: { kind: 'pick', at: settings, fields: 'religion/religion_types', field: 'pagan_roots', title: tr('Pagan roots') } } : undefined;
    card.sections.push({ title: tr('Settings'), lines: look, src: lookAt ?? settings, acts: roots && [roots] });
    missingFact(card);
    b.genericSections(e, body, card, ctx, own, RELIGION_SKIP);
    return true;
};

/** A religion family (religion_family_types/_religion_family_types.info): its religions, hostility doctrine, graphics. */
const family: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const religions = b.idx.incomingSources(e).filter((s) => s.entity.type === 'religion/religion_types' && s.contexts.includes('family'));
    card.facts.push([tr('{length} religion{value}', { length: religions.length, value: religions.length === 1 ? '' : 's' })]);
    // (1.20: four tenet banner keys instead of the one; the game logs "needs complete icon setup" for a family without all four)
    const obsolete: Obsolete[] = [];

    const hasOld = body.some((c) => c.k === OLD_BANNER_KEY);

    if (hasOld)
        obsolete.push({ text: tr('`doctrine_background_icon` — 1.20 reads four tenet banner keys instead'), tip: tr('The migration replaces it with the four keys: the banner the mod ships carried over, the game’s values for the rest') });

    const lacking = BANNER_KEYS.filter((k) => !body.some((c) => c.k === k));

    if (lacking.length && !hasOld)
        obsolete.push({ text: tr('{list} missing — 1.20 needs all four tenet banner keys ("needs complete icon setup")', { list: lacking.join(', ') }), tip: tr('The migration adds them with the game’s values') });

    const update = updateSection(b, e, card.src, obsolete);

    if (update)
        card.sections.push(update);

    card.sections.push({ title: tr('Religions'), lines: religions.map((s) => ({ text: [b.d.entitySeg(s.entity)], icon: 'piety' })) });
    card.sections.push({ title: tr('Settings'), lines: settingLines(b, body, ctx, 'religion/religion_family_types'), src: own('field', 'religion/religion_family_types') });
    b.genericSections(e, body, card, ctx, own, new Set(['hostility_doctrine', ...LOOK_KEYS]));
    return true;
};

/** A doctrine group (doctrine_group_types/_doctrine_group_types.info): category, picks, doctrines, when it is offered. */
const doctrineGroup: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const category = scalar(body, 'category');

    if (category)
        card.facts.push([tr('{value} doctrines', { value: CATEGORIES[category] ?? capitalize(humanize(category)) })]);

    const picks = Number(scalar(body, 'number_of_picks') ?? 1);
    card.facts.push([picks === 1 ? tr('A faith has one of them') : tr('A faith picks {formatNumber} of them', { formatNumber: formatNumber(picks) })]);
    const list = body.find((c) => c.k === 'doctrine_types' && Array.isArray(c.v));
    const obsolete: Obsolete[] = [];

    if (list)
        obsolete.push({ text: 'lists its doctrines (`doctrine_types = { }`): in 1.20 a doctrine names its group (`doctrine_group_type`)', tip: tr('Update: the mod\'s listed doctrines name the group, the list goes') });

    if (category === 'core_tenets')
        obsolete.push({ text: tr('a tenet group — 1.20 has tenets of their own type (common/religion/tenet_types)'), tip: tr('Its doctrines: “update” on each makes it a tenet') });

    // (a tenet group without its list (a patch mod of an older run took it out) is removed by the same fix)
    const update = updateSection(b, e, card.src, obsolete, list || category === 'core_tenets' ? { type: 'religion/doctrine_group_types', name: e.name, fix: 'doctrine-group', label: 'update' } : undefined);

    if (update)
        card.sections.push(update);

    if (list)
        card.sections.push({ title: tr('Doctrines'), lines: items(list).map((c) => statementLine(b, c, ctx, [b.d.ref(c.v as string, DOCTRINE)], undefined, { icon: 'piety' })), src: b.blockSection(list, 'other', ctx) });

    const avail = body.find((c) => c.k === 'is_available_on_create' && Array.isArray(c.v));

    if (avail)
        card.sections.push({ title: tr('Offered when creating a faith if'), lines: b.d.triggers(avail.v as PNode[], ctx), src: b.blockSection(avail, 'trigger', ctx) });

    const settings = b.fieldLines('religion/doctrine_group_types', body.filter((c) => c.k === 'category' || c.k === 'main_rite' || c.k === 'divergence' || c.k === 'doctrine_lock'), ctx);
    card.sections.push({ title: tr('Settings'), lines: settings, src: own('field', 'religion/doctrine_group_types') });
    b.genericSections(e, body, card, ctx, own, new Set(['category', 'main_rite', 'divergence', 'doctrine_lock', 'number_of_picks', 'doctrine_types', 'is_available_on_create']));
    return true;
};

/**
 * A doctrine or tenet (doctrine_types/_doctrine_types.info): its group ("＋ put it in a group" when none lists it),
 * names in game, what its parameters do in the game's words (`doctrine_parameter_<name>`; added and changed with the
 * picker: field set `doctrine_parameters`), its special values (`special_parameters`: numbers, hostility, opinion
 * overrides, holdings; field set `special_parameters`, its blocks' entries with their own sets), the virtues and sins it
 * adds, its piety cost, icon; conditions and modifiers follow.
 */
const doctrine: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const src = card.src;
    const marks = !!src?.mod;
    // (1.20: a tenet (no group): `tenets = { … }` and tenet pairs hold it, its icons in faith_tenets)
    const tenet = e.type === 'religion/tenet_types';
    const g = tenet ? undefined : doctrineGroups(b).of.get(e.name);
    const dlc = scalar(body, 'requires_dlc_flag');

    if (g)
        card.facts.push(rich(tr('Group: '), b.d.entitySeg(g.e)));

    if (dlc)
        card.facts.push([tr('Needs {dlcName}', { dlcName: dlcName(dlc) })]);

    // (a tenet a mod still writes as a doctrine of a tenet group, or as a doctrine of no group at all, named as the
    // game names its tenets: `tenet_…`)
    const update = !tenet && (tenetGroupDoctrines(b.idx).includes(e.name) || (!g && e.name.startsWith('tenet_') && tenetsOwnType(b.idx))) ?
        updateSection(b, e, src, [{ text: tr('a tenet written as a doctrine of a tenet group — 1.20 has tenets of their own type (common/religion/tenet_types)'), tip: tr('Update: its definition moves there (faiths holding it: their “Update for 1.20” moves it into their tenets)') }], {
            type: 'religion/doctrine_types',
            name: e.name,
            fix: 'tenet-doctrine',
            label: 'update'
        }) :
        undefined;

    if (update)
        card.sections.push(update);
    else
    {
        // (values 1.20 reads from `special_parameters`: number_of_spouses, the hostility numbers …)
        const oldNodes = (body.find((c) => c.k === 'parameters' && Array.isArray(c.v))?.v as PNode[] | undefined)?.filter(oldParameter) ?? [];
        const old = oldNodes.map((c) => parameterName(c)!);
        // (a bare name that needs a value has none to move: marked, but there is nothing for a fix to do)
        const params = old.length ?
            updateSection(b, e, src, [{
                text: tr('{list} in `parameters` — 1.20 reads them from `special_parameters` (hostility as level names: `hostility_levels`)', { list: old.join(', ') }),
                tip: oldNodes.some(convertibleParameter) ? tr('Update: moved there, the hostility numbers as righteous / astray / hostile / evil') : tr('Written bare, without the value 1.20 needs there: give each its value in special_parameters by hand')
            }], oldNodes.some(convertibleParameter) ?
                {
                    type: e.type,
                    name: e.name,
                    fix: tenet ? 'tenet-parameters' : 'doctrine-parameters',
                    label: 'update'
                } :
                undefined) :
            undefined;

        if (params)
            card.sections.push(params);
    }

    // (1.20: `doctrines = { … }` lists; rites hold doctrines too)
    const holdsIt = (c: string): boolean => (tenet ? c === 'tenets' || /tenet_selection_pair › (fallback_)?tenet$/.test(c) : c === 'doctrine' || c === 'doctrines' || c.endsWith('doctrine_selection_pair › doctrine'));
    const holders = b.idx.incomingSources(e).filter((s) => ['faith', 'religion/religion_types', 'religion/rite_types'].includes(s.entity.type) && s.contexts.some(holdsIt));
    const holding = (type: string, word: string): string | 0 =>
    {
        const n = holders.filter((s) => s.entity.type === type).length;
        return n && `${n} ${word}${n === 1 ? '' : 's'}`;
    };

    if (holders.length)
        card.facts.push([tr('Held by {join} at the start', { join: [holding('faith', 'faith'), holding('religion/religion_types', 'religion'), holding('religion/rite_types', 'rite')].filter(Boolean).join(' and ') })]);

    if (scalar(body, 'visible') === 'no')
        card.facts.push([tr('Hidden in the interface')]);

    if (!g && !tenet && marks)
        card.sections.push({
            title: tr('Group'),
            lines: [{
                text: [{ text: tr('In no doctrine group — no faith can hold it'), kind: 'ph' }],
                placeholder: true,
                tone: 'bad',
                tip: tr('A doctrine group lists it in its doctrine_types (religion/doctrine_group_types)'),
                act: src ? { label: tr('＋ put it in a group'), src, do: { kind: 'group', doctrine: e.name } } : undefined
            }],
            noAdd: true
        });

    // (a `name = { … }` / `desc = { … }` of its own replaces the loc keys: its texts, each with when it is shown)
    const named = body.filter((c) => (c.k === 'name' || c.k === 'desc') && c.v !== undefined);

    if (!named.length)
        card.sections.push({ title: tr('Names in game'), lines: nameLines(b, e, src, marks), noAdd: true });

    for (const n of named)
        card.sections.push({ title: n.k === 'name' ? tr('Name in game') : tr('Description'), lines: descLines(b, n, ctx), noAdd: true });

    const params = body.find((c) => c.k === 'parameters' && Array.isArray(c.v));
    const paramsAt: SectionSource | undefined = params ? b.blockSection(params, 'field', ctx, 'doctrine_parameters') : src && { parent: { ...src, kind: 'field', fields: 'doctrine_parameters' }, key: 'parameters', kind: 'field' };
    card.sections.push({ title: tr('What it does'), lines: params ? paramLines(b, params.v as PNode[], ctx, 'doctrine_parameter_', 'doctrine_parameters') : [], src: paramsAt, addLabel: 'parameter' });
    // (1.20: the numbers and the hostility sit in `special_parameters`: a section of its own, its ＋ adds a setting there
    // (the block made when missing, a hostility block with its first entry in the same write))
    const special = body.find((c) => c.k === 'special_parameters' && Array.isArray(c.v));
    const specialAt: SectionSource | undefined = special ? b.blockSection(special, 'field', ctx, 'special_parameters') : src && { parent: { ...src, kind: 'field', fields: 'special_parameters' }, key: 'special_parameters', kind: 'field' };

    // (the blocks it writes already: its ＋ leaves them out, a block row's ⤷＋ adds to them; the hint's common)
    const writtenBlocks = special ? (special.v as PNode[]).filter((c) => c.k && Array.isArray(c.v)).map((c) => c.k!) : [];

    if (special || marks)
        card.sections.push({ title: tr('Special values'), lines: special ? specialParamLines(b, special.v as PNode[], ctx) : [], src: specialAt && writtenBlocks.length ? { ...specialAt, hint: { ...specialAt.hint, common: writtenBlocks } } : specialAt, addLabel: 'setting' });
    const virtues = virtueLines(b, body.find((c) => c.k === 'traits'), ctx);

    if (virtues.length)
        card.sections.push({ title: tr('Virtues and sins'), lines: virtues });

    const cost = body.find((c) => c.k === 'piety_cost');

    if (cost)
    {
        const lines = Array.isArray(cost.v) ? b.formula(cost.v, ctx) : [statementLine(b, cost, ctx, rich(b.d.valueSeg(cost.v, ctx), tr(' piety')), undefined, { icon: 'piety' })];
        card.sections.push({ title: tr('Piety cost'), lines, src: Array.isArray(cost.v) ? b.blockSection(cost, 'field', ctx, 'script_value') : undefined });
    }

    const settingsAt = own('field', e.type);
    // (a tenet's icon can be a triggered list: then it shows as written, below)
    const plainIcon = !body.some((c) => c.k === 'icon' && Array.isArray(c.v));
    const settings = [...(plainIcon ? iconLines(b, e, body, ctx, tenet ? 'gfx/interface/icons/faith_tenets' : 'gfx/interface/icons/faith_doctrines', e.type, src, settingsAt, marks) : []), ...b.fieldLines('religion/doctrine_types', body.filter((c) => c.k === 'visible'), ctx)];

    if (settings.length || marks)
        card.sections.push({ title: tr('Settings'), lines: settings, src: settingsAt });

    missingFact(card);
    // (its group and place in it (1.20: `doctrine_group_type`, `index`) are read through the index: layouts.ts)
    b.genericSections(e, body, card, ctx, own, new Set(['parameters', 'special_parameters', 'traits', 'piety_cost', 'visible', 'name', 'desc', 'requires_dlc_flag', 'doctrine_group_type', 'index', ...(plainIcon ? ['icon'] : [])]));
    return true;
};

export const FAITH_CARDS: Record<string, CardFn> = {
    faith,
    'religion/holy_site_types': holySite,
    'religion/religion_types': religion,
    'religion/religion_family_types': family,
    'religion/doctrine_group_types': doctrineGroup,
    'religion/doctrine_types': doctrine,
    'religion/tenet_types': doctrine
};
