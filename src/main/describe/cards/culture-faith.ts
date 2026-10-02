/**
 * Cards: faiths, religions, religion families, doctrine groups and doctrines (common/religion). A mod's faith, religion
 * or doctrine also shows what it still lacks as placeholders (docs/readable-view.md, "Culture, faith and dynasty"):
 * a doctrine group without a choice, missing tenets, names in game, colour, icon, a religion without faiths, a
 * doctrine in no group — each with the action that fills it in (LineAct).
 */
import type { PNode } from '../../indexer/parser.ts';
import type { Entity } from '../../indexer/gameIndex.ts';
import type { CardSection, EntityCard, Line, LineAct, LineSource, Rich, RichSeg, SectionSource } from '../../../shared/api.ts';
import type { Ctx } from '../describer.ts';
import type { StoryBuilder } from '../stories.ts';
import type { CardFn } from './types.ts';
import { capitalize, formatNumber, humanize, rich, titleCase } from '../text.ts';
import { block, bodyOf, colorSeg, dlcName, items, joined, paramLines, sample, scalar, statementLine, word } from './culture-util.ts';
import { faithDetails, faithField, faithHolySites, faithReligion, religionFaiths, tenetsOf } from '../../indexer/layouts.ts';

const DOCTRINE = ['religion/doctrine_types'];

/** Doctrine group categories (religion/doctrine_group_types `category`), in the order a faith shows them. */
const CATEGORIES: Record<string, string> = { core_tenets: 'Tenets', main_group: 'Main', marriage: 'Marriage', crimes: 'Crimes', clergy: 'Clergy', special: 'Special', not_creatable: 'Not creatable' };
const CATEGORY_ORDER = Object.keys(CATEGORIES);
/** the categories whose groups a faith has one doctrine of each (the game's faith creation) — with their sections */
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

    // (1.20: the doctrine names its group — docs/game-structure.md, "Layouts that changed")
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
    /** mark what is missing (a mod's entry — the game's are as they are) */
    marks: boolean;
}

/**
 * Doctrines as sections, grouped by their doctrine group (religion_types/_religion_types.info; doctrine_group_types):
 * "Tenets" (a faith picks 3: the missing ones as placeholders), then per category — Doctrines, Marriage, Crimes,
 * Clergy — one row per group: its doctrine (a faith's own, or its religion's "from its religion"), a placeholder when
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
    // (inherited from several places — 1.20: main rite, then religion: the first that fills the group wins)
    const inhBy = new Map([...by(inherited)].map(([g, hs]) => [g, hs.filter((h) => h.from === hs[0].from)]));
    const pick = (label: string, only: string[], title: string): LineAct | undefined => p.src && p.at ? { label, src: p.src, do: { kind: 'pick', at: p.at, fields: p.fields, field: 'doctrine', only, title } } : undefined;
    const gseg = (g: DoctrineGroup): RichSeg => b.d.entitySeg(g.e);
    const dseg = (h: Held): Rich =>
    {
        const t: Rich = [b.d.ref(h.name, DOCTRINE)];
        return h.dlc ? rich(t, ` with ${dlcName(h.dlc)}`, h.fallback ? rich(', else ', b.d.ref(h.fallback, DOCTRINE)) : '') : t;
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
        l.text = rich(l.text, { text: g.picks === 1 ? ' · a faith holds one of the group — remove the others' : ` · only ${g.picks} of the group count`, kind: 'ph' });
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

            if (i >= g.picks)
                extra(l, g);

            return l;
        });

        if (p.faith && p.marks)
        {
            for (let i = have.length; i < g.picks; i++)
                lines.push({
                    text: [{ text: `Tenet ${i + 1} of ${g.picks}`, kind: 'ph' }, ' — not chosen'],
                    placeholder: true,
                    tone: 'bad',
                    icon: 'piety',
                    tip: `A faith has ${g.picks} tenets (${g.key})`,
                    act: pick('choose', g.doctrines.filter((d) => !names.has(d)), `Tenet ${i + 1} of ${g.picks}`)
                });
        }

        out.push({ title: 'Tenets', lines, noAdd: true });
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
                    lines.push({ text: rich(gseg(g), ': ', dseg(h), { text: ` · from ${h.from ?? 'its religion'}`, kind: 'ph' }), tip: `doctrine = ${h.name}`, act: p.marks ? pick('change', g.doctrines, g.label) : undefined });
            }
            else if (p.marks && g.everyFaith)
            {
                lines.push({
                    text: rich(gseg(g), ': ', { text: p.faith ? 'not chosen' : 'not set — each faith chooses', kind: 'ph' }),
                    placeholder: true,
                    tone: p.faith ? 'bad' : undefined,
                    tip: `One of: ${g.doctrines.join(', ')}`,
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
                lines.push({ text: rich(gseg(g), ': ', dseg(h), { text: ` · from ${h.from ?? 'its religion'}`, kind: 'ph' }), tip: `doctrine = ${h.name}` });
        }
    }

    for (const h of own.filter((x) => !of.has(x.name)))
    {
        const l = statementLine(b, h.node, ctx, rich(dseg(h), { text: ' · in no doctrine group: it does nothing', kind: 'ph' }), p.fields);
        l.tone = 'bad';
        lines.push(l);
    }

    const add = p.marks ? pick('＋ special doctrine', special.flatMap((g) => g.doctrines), 'Special doctrine') : undefined;

    if (lines.length || add)
        out.push({ title: 'Special doctrines', lines, acts: add && [add], noAdd: true });

    return out;
}

/**
 * The loc keys of the names in game: a faith's or religion's, a doctrine's — label, required, several lines, and the
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
 * "Names in game": each written (✎ changes it), else a placeholder ("write") — only a mod's entry has the latter. The
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
            line = { text: rich(label, ': ', text), tip: key, act: act('✎') };
        else if (marks)
            line = { text: rich(label, ': ', { text: 'not written', kind: 'ph' }), placeholder: true, tone: required ? 'bad' : undefined, tip: key, act: act('write') };
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
                    tip: `A text of the game (${ex.key}) with the ${label.toLowerCase()} in its place`
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

        const text = rich(kind === 'virtues' ? 'Virtues: ' : 'Sins: ', joined(parts), inherited ? { text: ' · from its religion', kind: 'ph' } : '');
        const extra: Partial<Line> = { icon: 'trait', tone: kind === 'virtues' ? 'good' : 'bad' };
        out.push(inherited ? { text, ...extra } : statementLine(b, n, ctx, text, undefined, extra));
    }

    return out;
}

/** The faith's own terms (`localization = { HighGodName = key … }`, `[Faith.Custom('key')]` in loc) worth showing. */
const TERMS: [string, string][] = [
    ['HighGodName', 'High god'],
    ['CreatorName', 'Creator'],
    ['DevilName', 'Devil'],
    ['HouseOfWorship', 'House of worship'],
    ['ReligiousSymbol', 'Holy symbol'],
    ['ReligiousText', 'Holy text'],
    ['ReligiousHeadName', 'Head of faith'],
    ['PriestMale', 'Priest'],
    ['BishopMale', 'Bishop'],
    ['DevoteeMale', 'Devotee'],
    ['PositiveAfterLife', 'Afterlife'],
    ['NegativeAfterLife', 'Damnation'],
    ['GHWName', 'Holy war']
];

/**
 * Terms of a faith or religion (its own `localization`, else — a faith — its religion's: missing keys are inherited).
 * `owner` (a mod's entry): each term can be written for it (a text under a key of its own); missing ones are placeholders.
 */
function termLines(b: StoryBuilder, own: PNode[] | undefined, inherited: PNode[] | undefined, ctx: Ctx, owner?: { e: Entity; src: LineSource; }): Line[]
{
    const out: Line[] = [];

    for (const [k, label] of TERMS)
    {
        const mine = own?.find((c) => c.k === k);
        const c = mine ?? inherited?.find((x) => x.k === k);
        const key = typeof c?.v === 'string' ? c.v : c ? (items(c)[0]?.v as string | undefined) : undefined;
        const act = (l: string): LineAct | undefined => owner && { label: l, src: owner.src, do: { kind: 'term', term: k, owner: { type: owner.e.type, name: owner.e.name } } };

        if (c && key)
        {
            const text = rich(label, ': ', b.d.loc(key) ?? [{ text: key, kind: 'code' }], mine ? '' : { text: ' · from its religion', kind: 'ph' });
            const l = mine ? statementLine(b, c, ctx, text) : { text, tip: `${k} = ${key}` };
            out.push({ ...l, act: act('✎') });
        }
        else if (owner)
        {
            out.push({ text: rich(label, ': ', { text: 'not written', kind: 'ph' }), placeholder: true, tone: 'bad', tip: `${k} — texts use it as [Faith.${k}]`, act: act('write') });
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
            out.push(statementLine(b, names, ctx, [`Names: ${sample(list.map((x) => word(b, x)), 8)}`]));
    }

    const maa = body.find((c) => c.k === 'holy_order_maa' && Array.isArray(c.v));

    if (maa)
        out.push(statementLine(b, maa, ctx, rich('Men-at-arms: ', joined(items(maa).map((x) => b.d.ref(x.v as string, ['men_at_arms_types'])), ' or ')), undefined, { icon: 'modifier' }));

    return out;
}

/** `reserved_male_names = { … }` / `reserved_female_names`: base names other faiths don't pick at random. */
function reservedLines(b: StoryBuilder, body: PNode[], ctx: Ctx): Line[]
{
    return body
        .filter((c) => (c.k === 'reserved_male_names' || c.k === 'reserved_female_names') && Array.isArray(c.v))
        .map((c) => statementLine(b, c, ctx, [`${c.k === 'reserved_male_names' ? 'Men' : 'Women'}: ${sample(items(c).map((x) => word(b, x.v as string)), 10)}`]));
}

/** Graphics settings a faith falls back on from its religion and family (faith > religion > family). */
const LOOK_KEYS = ['graphical_faith', 'piety_icon_group', 'doctrine_background_icon'];

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
            text = rich('Head of faith: ', b.d.ref(v, ['landed_titles']));
        else if (c.k === 'family')
            text = rich('Family: ', b.d.ref(v, ['religion/religion_family_types']));
        else if (c.k === 'hostility_doctrine')
            text = rich('Hostility levels shown with ', b.d.ref(v, DOCTRINE));
        else if (c.k === 'pagan_roots')
            text = [v === 'yes' ? 'Pagan roots: faiths without the Unreformed doctrine count as reformed' : 'No pagan roots'];
        else if (c.k === 'reformed_icon')
            text = rich('Icon once reformed: ', { text: v, kind: 'code' });
        else if (c.k === 'graphical_faith')
            text = rich('3D models (temples): ', { text: titleCase(humanize(v.replace(/_gfx$/, ''))), kind: 'value', tip: v });
        else if (c.k === 'piety_icon_group')
            text = rich('Piety icons: ', { text: titleCase(humanize(v)), kind: 'value', tip: v });
        else if (c.k === 'doctrine_background_icon')
            text = rich('Tenet banner: ', { text: v, kind: 'code' });

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
        const l = statementLine(b, c, ctx, rich('Colour: ', seg));

        if (src && l.src)
            l.act = { label: 'change', src, do: { kind: 'color', replace: l.src, now: rgbOf(seg) } };

        return [l];
    }

    if (!marks)
        return [];

    return [{ text: rich('Colour: ', { text: 'not set', kind: 'ph' }), placeholder: true, tone: 'bad', tip: 'color = { r g b } — the faith on the map and in the interface', act: src && at ? { label: 'choose', src, do: { kind: 'color', at } } : undefined }];
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
    const found = !!b.idx.imageAt(path);

    if (c)
    {
        const l = statementLine(b, c, ctx, rich('Icon: ', { text: name, kind: 'code' }, found ? '' : { text: ` — ${path} is missing`, kind: 'ph' }), fields);

        if (!found && marks)
            l.tone = 'bad';

        return [l];
    }

    if (found || !marks)
        return [];

    return [{ text: rich('Icon: ', { text: `none — ${path} is missing`, kind: 'ph' }), placeholder: true, tone: 'bad', tip: `icon = <name>: ${folder}/<name>.dds`, act: src && at ? { label: 'choose', src, do: { kind: 'pick', at, fields, field: 'icon', title: 'Icon' } } : undefined }];
}

/** Graphics a faith / religion does not set itself: its religion's or family's (shown as such). */
function inheritedLook(body: PNode[], fromBody: PNode[], what: string): Line[]
{
    return LOOK_KEYS.filter((k) => !scalar(body, k) && scalar(fromBody, k)).map((k) =>
    {
        const v = scalar(fromBody, k)!;
        const label = k === 'graphical_faith' ? '3D models (temples)' : k === 'piety_icon_group' ? 'Piety icons' : 'Tenet banner';
        const shown = k === 'doctrine_background_icon' ? v : titleCase(humanize(v.replace(/_gfx$/, '')));
        return { text: rich(label, ': ', { text: shown, kind: 'value', tip: v }, { text: ` · from its ${what}`, kind: 'ph' }), tip: `${k} = ${v}` };
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
        card.facts.push([{ text: `${n} to fill in`, kind: 'bad', tip: 'Marked below — each with what fills it in' }]);
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

/** A faith's tenets (1.20): its main rite's when the rite has some (the game takes those), else its own. */
function tenetLines(b: StoryBuilder, body: PNode[], rite: PNode[] | undefined, ctx: Ctx): Line[]
{
    const seg = (t: { name: string; dlc?: string; fallback?: string; }): Rich => rich(b.d.ref(t.name, ['religion/tenet_types']), t.dlc ? rich(` with ${dlcName(t.dlc)}`, t.fallback ? rich(', else ', b.d.ref(t.fallback, ['religion/tenet_types'])) : '') : '');
    const fromRite = rite ? tenetsOf(rite) : [];

    if (fromRite.length)
        return fromRite.map((t) => ({ text: rich(seg(t), { text: ' · from its main rite', kind: 'ph' }), icon: 'piety', tip: t.name }));

    return tenetsOf(body).map((t) => statementLine(b, t.node, ctx, seg(t), undefined, { icon: 'piety' }));
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
        card.facts.push(rich('Religion: ', b.d.entitySeg(religion)));

    if (riteKey)
        card.facts.push(rich('Main rite: ', b.d.ref(riteKey, ['religion/rite_types'])));

    const head = faithField(body, 'religious_head');

    if (typeof head?.v === 'string')
        card.facts.push(rich('Head of faith: ', b.d.ref(head.v, ['landed_titles'])));

    const origin = scalar(body, 'origin');

    if (origin)
        card.facts.push(rich('Grew out of ', b.d.ref(origin, ['faith'])));

    const sites = faithHolySites(body);

    if (sites.length)
        card.facts.push([`${sites.length} holy site${sites.length === 1 ? '' : 's'}`]);

    const settings = own('field', 'faith');
    card.sections.push({ title: 'Names in game', lines: nameLines(b, e, src, marks), noAdd: true });
    const tenets = tenetLines(b, body, rite, ctx);

    if (tenets.length)
        card.sections.push({ title: 'Tenets', lines: tenets, noAdd: true });

    // (a group's doctrine: the faith's own, else its main rite's, else its religion's)
    const inherited = [...(rite ? held(rite, true, 'its main rite') : []), ...held(rbody, true)];
    card.sections.push(...doctrineSections(b, held(body, false), inherited, ctx, { src, at: settings, fields: 'faith', faith: true, marks }));
    const siteLines = sites.map((h) => statementLine(b, h.node, ctx, rich(holySiteSeg(b, h.name), h.eminent ? { text: ' · eminent: global bonuses too', kind: 'ph' } : ''), 'faith', { icon: 'piety' }));

    if (!sites.length && marks)
        siteLines.push({ text: [{ text: 'No holy sites yet', kind: 'ph' }], placeholder: true, icon: 'piety', tip: 'Faiths usually have 5: they give their holders’ modifiers and are what great holy wars are for' });

    // (`holy_site = x` is the old layout's: a 1.20 faith lists them)
    const siteAdd: LineAct | undefined = src && settings && !details ? { label: '＋ holy site', src, do: { kind: 'pick', at: settings, fields: 'faith', field: 'holy_site', title: 'Holy site' } } : undefined;
    card.sections.push({ title: 'Holy sites', lines: siteLines, src: settings, acts: siteAdd && [siteAdd], noAdd: true });
    const virtues = virtueLines(b, rbody.find((c) => c.k === 'traits'), ctx, true);

    if (virtues.length)
        card.sections.push({ title: 'Virtues and sins', lines: virtues });

    const terms = termLines(b, block(body, 'localization'), block(rbody, 'localization'), ctx, src && marks ? { e, src } : undefined);

    if (terms.length)
        card.sections.push({ title: 'Terms', lines: terms, noAdd: true });

    const orders = holyOrderLines(b, body, ctx);

    if (orders.length)
        card.sections.push({ title: 'Holy orders', lines: orders });

    const reserved = reservedLines(b, body, ctx);

    if (reserved.length)
        card.sections.push({ title: 'Reserved names', lines: reserved });

    const family = religion ? b.idx.get('religion/religion_family_types', scalar(rbody, 'family') ?? '') : undefined;
    const look = [...colorLines(b, fbody, ctx, src, settings, marks), ...iconLines(b, e, fbody, ctx, 'gfx/interface/icons/faith', 'faith', src, settings, marks), ...settingLines(b, fbody, ctx, 'faith'), ...inheritedLook(fbody, rbody, 'religion')];

    if (family)
        look.push(...inheritedLook([...fbody, ...rbody], bodyOf(b, family), 'family'));

    card.sections.push({ title: 'Settings', lines: look, src: settings });
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

const RELIGION_SKIP = new Set([...FAITH_SKIP, 'family', 'faiths', 'traits', 'pagan_roots', 'custom_faith_icons', 'holy_order_maa']);

/**
 * A religion (religion_types/_religion_types.info): names in game, faiths ("＋ faith"), the doctrines every faith
 * starts with (by group — added before `faiths`, where the game reads them), virtues and sins, terms, holy orders,
 * reserved names, settings, custom faith icons.
 */
const religion: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const src = card.src;
    const marks = !!src?.mod;
    const family = scalar(body, 'family');

    if (family)
        card.facts.push(rich('Family: ', b.d.ref(family, ['religion/religion_family_types'])));

    const faithsNode = body.find((c) => c.k === 'faiths' && Array.isArray(c.v));
    const nested = faithsNode ? (faithsNode.v as PNode[]).filter((c) => c.k && Array.isArray(c.v)) : [];
    // (1.20: the faiths naming it in religion/faith_types)
    const named = religionFaiths(b.idx, e).filter((f) => !nested.some((n) => n.k === f.name));
    const count = nested.length + named.length;
    card.facts.push([`${count} faith${count === 1 ? '' : 's'}`]);

    if (scalar(body, 'pagan_roots') === 'yes')
        card.facts.push(['Pagan roots']);

    card.sections.push({ title: 'Names in game', lines: nameLines(b, e, src, marks), noAdd: true });
    const faithText = (name: string, fb: PNode[]): Rich =>
    {
        const head = faithField(fb, 'religious_head');
        return rich(b.d.ref(name, ['faith']), typeof head?.v === 'string' ? rich({ text: ' · head of faith: ', kind: 'ph' }, b.d.ref(head.v, ['landed_titles'])) : '');
    };
    const faithLines: Line[] = [
        ...nested.map((f) => statementLine(b, f, ctx, faithText(f.k!, f.v as PNode[]), undefined, { icon: 'piety' })),
        ...named.map((f): Line => ({ text: faithText(f.name, bodyOf(b, f)), icon: 'piety', tip: f.name }))
    ];

    if (!count && marks)
        faithLines.push({ text: [{ text: 'No faith yet — a religion needs at least one', kind: 'ph' }], placeholder: true, tone: 'bad', icon: 'piety' });

    card.sections.push({ title: 'Faiths', lines: faithLines, acts: src ? [{ label: '＋ faith', src, do: { kind: 'faith', religion: e.name } }] : undefined, noAdd: true });
    // (a religion's doctrines stand before its faiths: the game reads none after them)
    const settings = own('field', 'religion/religion_types');
    const before = faithsNode && b.fieldAnchor(faithsNode, ctx, 'religion/religion_types');
    const at: SectionSource | undefined = before ? { before, key: '', kind: 'field' } : settings;
    card.sections.push(...doctrineSections(b, held(body, false), [], ctx, { src, at, fields: 'religion/religion_types', faith: false, marks }));
    const virtues = virtueLines(b, body.find((c) => c.k === 'traits'), ctx);

    if (virtues.length)
        card.sections.push({ title: 'Virtues and sins', lines: virtues });

    const terms = termLines(b, block(body, 'localization'), undefined, ctx, src && marks ? { e, src } : undefined);

    if (terms.length)
        card.sections.push({ title: 'Terms', lines: terms, noAdd: true });

    const orders = holyOrderLines(b, body, ctx);

    if (orders.length)
        card.sections.push({ title: 'Holy orders', lines: orders });

    const reserved = reservedLines(b, body, ctx);

    if (reserved.length)
        card.sections.push({ title: 'Reserved names', lines: reserved });

    const look = settingLines(b, body, ctx, 'religion/religion_types');

    if (!family && marks)
        look.unshift({ text: rich('Family: ', { text: 'not set', kind: 'ph' }), placeholder: true, tone: 'bad', tip: 'family = rf_… (religion/religion_family_types)', act: src && at ? { label: 'choose', src, do: { kind: 'pick', at, fields: 'religion/religion_types', field: 'family', title: 'Family' } } : undefined });

    const fam = family ? b.idx.get('religion/religion_family_types', family) : undefined;

    if (fam)
        look.push(...inheritedLook(body, bodyOf(b, fam), 'family'));

    const icons = body.find((c) => c.k === 'custom_faith_icons' && Array.isArray(c.v));

    if (icons)
        look.push(statementLine(b, icons, ctx, [`${items(icons).length} icons to choose from for new faiths`]));

    card.sections.push({ title: 'Settings', lines: look, src: settings });
    missingFact(card);
    b.genericSections(e, body, card, ctx, own, RELIGION_SKIP);
    return true;
};

/** A religion family (religion_family_types/_religion_family_types.info): its religions, hostility doctrine, graphics. */
const family: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const religions = b.idx.incomingSources(e).filter((s) => s.entity.type === 'religion/religion_types' && s.contexts.includes('family'));
    card.facts.push([`${religions.length} religion${religions.length === 1 ? '' : 's'}`]);
    card.sections.push({ title: 'Religions', lines: religions.map((s) => ({ text: [b.d.entitySeg(s.entity)], icon: 'piety' })) });
    card.sections.push({ title: 'Settings', lines: settingLines(b, body, ctx, 'religion/religion_family_types'), src: own('field', 'religion/religion_family_types') });
    b.genericSections(e, body, card, ctx, own, new Set(['hostility_doctrine', ...LOOK_KEYS]));
    return true;
};

/** A doctrine group (doctrine_group_types/_doctrine_group_types.info): category, picks, doctrines, when it is offered. */
const doctrineGroup: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const category = scalar(body, 'category');

    if (category)
        card.facts.push([`${CATEGORIES[category] ?? capitalize(humanize(category))} doctrines`]);

    const picks = Number(scalar(body, 'number_of_picks') ?? 1);
    card.facts.push([picks === 1 ? 'A faith has one of them' : `A faith picks ${formatNumber(picks)} of them`]);
    const list = body.find((c) => c.k === 'doctrine_types' && Array.isArray(c.v));

    if (list)
        card.sections.push({ title: 'Doctrines', lines: items(list).map((c) => statementLine(b, c, ctx, [b.d.ref(c.v as string, DOCTRINE)], undefined, { icon: 'piety' })), src: b.blockSection(list, 'other', ctx) });

    const avail = body.find((c) => c.k === 'is_available_on_create' && Array.isArray(c.v));

    if (avail)
        card.sections.push({ title: 'Offered when creating a faith if', lines: b.d.triggers(avail.v as PNode[], ctx), src: b.blockSection(avail, 'trigger', ctx) });

    const settings = b.fieldLines('religion/doctrine_group_types', body.filter((c) => c.k === 'category' || c.k === 'number_of_picks'), ctx);
    card.sections.push({ title: 'Settings', lines: settings, src: own('field', 'religion/doctrine_group_types') });
    b.genericSections(e, body, card, ctx, own, new Set(['category', 'number_of_picks', 'doctrine_types', 'is_available_on_create']));
    return true;
};

/**
 * A doctrine or tenet (doctrine_types/_doctrine_types.info): its group ("＋ put it in a group" when none lists it),
 * names in game, what its parameters do in the game's words (`doctrine_parameter_<name>`; added and changed with the
 * picker: field set `doctrine_parameters`), the virtues and sins it adds, its piety cost, icon; conditions and
 * modifiers follow.
 */
const doctrine: CardFn = (b, { e, body, card, ctx, own }) =>
{
    const src = card.src;
    const marks = !!src?.mod;
    const g = doctrineGroups(b).of.get(e.name);

    if (g)
        card.facts.push(rich('Group: ', b.d.entitySeg(g.e)));

    // (1.20: `doctrines = { … }` lists; rites hold doctrines too)
    const holders = b.idx.incomingSources(e).filter((s) => ['faith', 'religion/religion_types', 'religion/rite_types'].includes(s.entity.type) && s.contexts.some((c) => c === 'doctrine' || c === 'doctrines' || c.endsWith('doctrine_selection_pair › doctrine')));
    const holding = (type: string, word: string): string | 0 =>
    {
        const n = holders.filter((s) => s.entity.type === type).length;
        return n && `${n} ${word}${n === 1 ? '' : 's'}`;
    };

    if (holders.length)
        card.facts.push([`Held by ${[holding('faith', 'faith'), holding('religion/religion_types', 'religion'), holding('religion/rite_types', 'rite')].filter(Boolean).join(' and ')} at the start`]);

    if (scalar(body, 'visible') === 'no')
        card.facts.push(['Hidden in the interface']);

    if (!g && marks)
        card.sections.push({
            title: 'Group',
            lines: [{
                text: [{ text: 'In no doctrine group — no faith can hold it', kind: 'ph' }],
                placeholder: true,
                tone: 'bad',
                tip: 'A doctrine group lists it in its doctrine_types (religion/doctrine_group_types)',
                act: src ? { label: '＋ put it in a group', src, do: { kind: 'group', doctrine: e.name } } : undefined
            }],
            noAdd: true
        });

    // (a `name = { … }` / `desc = { … }` of its own replaces the loc keys)
    if (!body.some((c) => c.k === 'name' || c.k === 'desc'))
        card.sections.push({ title: 'Names in game', lines: nameLines(b, e, src, marks), noAdd: true });

    const params = body.find((c) => c.k === 'parameters' && Array.isArray(c.v));
    const paramsAt: SectionSource | undefined = params ? b.blockSection(params, 'field', ctx, 'doctrine_parameters') : src && { parent: { ...src, kind: 'field', fields: 'doctrine_parameters' }, key: 'parameters', kind: 'field' };
    card.sections.push({ title: 'What it does', lines: params ? paramLines(b, params.v as PNode[], ctx, 'doctrine_parameter_', 'doctrine_parameters') : [], src: paramsAt, addLabel: 'parameter' });
    const virtues = virtueLines(b, body.find((c) => c.k === 'traits'), ctx);

    if (virtues.length)
        card.sections.push({ title: 'Virtues and sins', lines: virtues });

    const cost = body.find((c) => c.k === 'piety_cost');

    if (cost)
    {
        const lines = Array.isArray(cost.v) ? b.formula(cost.v, ctx) : [statementLine(b, cost, ctx, rich(b.d.valueSeg(cost.v, ctx), ' piety'), undefined, { icon: 'piety' })];
        card.sections.push({ title: 'Piety cost', lines, src: Array.isArray(cost.v) ? b.blockSection(cost, 'field', ctx, 'script_value') : undefined });
    }

    const settingsAt = own('field', 'religion/doctrine_types');
    const settings = [...iconLines(b, e, body, ctx, 'gfx/interface/icons/faith_doctrines', 'religion/doctrine_types', src, settingsAt, marks), ...b.fieldLines('religion/doctrine_types', body.filter((c) => c.k === 'visible'), ctx)];

    if (settings.length || marks)
        card.sections.push({ title: 'Settings', lines: settings, src: settingsAt });

    missingFact(card);
    b.genericSections(e, body, card, ctx, own, new Set(['parameters', 'traits', 'piety_cost', 'visible', 'icon', 'name', 'desc']));
    return true;
};

export const FAITH_CARDS: Record<string, CardFn> = {
    faith,
    'religion/religion_types': religion,
    'religion/religion_family_types': family,
    'religion/doctrine_group_types': doctrineGroup,
    'religion/doctrine_types': doctrine
};
