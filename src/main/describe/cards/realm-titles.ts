/** Realm cards: landed titles, holdings and governments (common/landed_titles, holdings, governments). */
import type { PNode } from '../../indexer/parser.ts';
import type { Line } from '../../../shared/api.ts';
import { capitalize, humanize, rich } from '../text.ts';
import type { CardFn } from './types.ts';
import { RealmCard, isBlock, items, join, type Block } from './realm-kit.ts';

/** Title tiers by key prefix (common/landed_titles/_landed_titles.info: `h_` hegemony … `b_` barony). */
const TIERS: Record<string, [string, string]> = {
    h: ['Hegemony', 'hegemonies'],
    e: ['Empire', 'empires'],
    k: ['Kingdom', 'kingdoms'],
    d: ['Duchy', 'duchies'],
    c: ['County', 'counties'],
    b: ['Barony', 'baronies']
};

const TITLE_KEY = /^[hekdcb]_/;

/** The titles nested in a title: its de jure lands. */
const deJure = (list: PNode[]): Block[] => list.filter((n): n is Block => !!n.k && TITLE_KEY.test(n.k) && isBlock(n));

/** How many titles of each tier lie under a title, all levels down. */
function countTiers(list: PNode[], out: Record<string, number> = {}): Record<string, number>
{
    for (const n of deJure(list))
    {
        out[n.k![0]] = (out[n.k![0]] ?? 0) + 1;
        countTiers(n.v, out);
    }

    return out;
}

/** "5 counties, 23 baronies" */
function sizeText(counts: Record<string, number>, tiers: string): string
{
    return [...tiers]
        .filter((t) => counts[t])
        .map((t) => `${counts[t]} ${counts[t] === 1 ? TIERS[t][0].toLowerCase() : TIERS[t][1]}`)
        .join(', ');
}

/** Regnal names (`holding_regnal_male_names = { … }` …): who takes them and when. */
const REGNAL: [string, string][] = [
    ['holding_regnal_male_names', 'Male holders take one of the names'],
    ['holding_regnal_female_names', 'Female holders take one of the names'],
    ['posthumous_regnal_male_names', 'Male holders are remembered by one of the names'],
    ['posthumous_regnal_female_names', 'Female holders are remembered by one of the names']
];

/**
 * A landed title (common/landed_titles/_landed_titles.info): its tier, de jure liege (the block it is written in),
 * de jure lands (the titles nested in it), settings, cultural names, the conditions to create or destroy it.
 */
const title: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const tier = x.e.name[0];
    const kids = deJure(x.body);
    c.skip(...kids.map((n) => n.k!), 'color', 'color2');
    c.fact(TIERS[tier]?.[0] ?? 'Title');
    const liege = c.enclosing();
    const le = liege && TITLE_KEY.test(liege) ? b.idx.get('landed_titles', liege) : undefined;

    if (le)
        c.fact('De jure part of ', b.d.entitySeg(le));

    if (kids.length)
        c.fact(sizeText(countTiers(x.body), 'hekdcb'.slice('hekdcb'.indexOf(tier) + 1)));
    else if ('hekd'.includes(tier))
        c.fact('Titular — no de jure lands');

    // one line per de jure title, with its size (a barony: its province)
    const lines = kids.map((n): Line =>
    {
        const t = n.k![0];
        const province = n.v.find((p) => p.k === 'province')?.v;
        const size = t === 'b' ? (typeof province === 'string' ? `province ${province}` : '') : sizeText(countTiers(n.v), t === 'c' ? 'b' : 'c');
        return { text: rich(b.d.ref(n.k!, ['landed_titles']), size ? ` — ${size}` : ''), tip: n.k!, src: c.anchor(n, 'other') };
    });
    const kidTiers = new Set(kids.map((n) => n.k![0]));
    c.section(kidTiers.size === 1 ? capitalize(TIERS[[...kidTiers][0]][1]) : 'De jure lands', lines);
    c.settings('Settings', 'landed_titles');
    const names = c.block('cultural_names');

    if (names)
    {
        const rows = names.v
            .filter((n) => n.k && typeof n.v === 'string')
            .map((n): Line => ({ text: rich(b.d.ref(n.k!, ['culture/name_lists']), ': “', b.d.loc(n.v as string) ?? [humanize(n.v as string)], '”'), tip: `${n.k} = ${n.v}`, src: c.anchor(n, 'other'), locKey: n.v as string }));
        c.section('Cultural names', rows);
    }

    const regnal: Line[] = [];

    for (const [k, label] of REGNAL)
    {
        const n = c.block(k);

        if (n)
            regnal.push({ text: rich(label, ': ', items(n).map((i) => b.idx.plainLoc(i.v as string) ?? humanize(i.v as string)).join(', ')), tip: k, src: c.anchor(n, 'other') });
    }

    c.section('Regnal names', regnal);
    c.triggers('can_create', 'Can be created when', 'character');
    c.triggers('can_create_on_partition', 'Created on partition when', 'character');
    c.triggers('can_destroy', 'Can be destroyed when', 'character');
    c.triggers('personal_relation_vassal', 'The vassal named in its holder’s relations', 'character');
    c.skip('personal_relation_entry');
    c.ai('ai_primary_priority', 'How much the AI wants it as its primary title');
    return c.done();
};

/** A holding type (common/holdings/_holdings.info): its buildings, settings, who may inherit it, parameters. */
const holding: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const heirs = c.block('required_heir_government_types');
    const lines: Line[] = [];

    if (heirs)
        lines.push({ text: rich('Heirs to a county with it as capital must be ', join(items(heirs).map((n) => b.d.ref(n.v as string, ['governments'])), ' or ')), icon: 'note', tip: 'required_heir_government_types', src: c.anchor(heirs, 'other') });

    c.settings('Settings', 'holdings', lines);
    const buildings = c.block('buildings');

    if (buildings)
        c.section('Buildings', items(buildings).map((n): Line => ({ text: [b.d.ref(n.v as string, ['buildings'])], tip: n.v as string, src: c.anchor(n, 'other') })));

    const params = c.block('parameters');

    if (params)
        c.section('Parameters', items(params).map((n): Line => ({ text: [capitalize(humanize(n.v as string))], icon: 'flag', tip: n.v as string, src: c.anchor(n, 'other') })));

    return c.done();
};

/** Lists of a government: what they name and how they read. */
const GOVERNMENT_LISTS: [string, string, string[]][] = [
    ['valid_holdings', 'Can also hold ', ['holdings']],
    ['required_county_holdings', 'Needed in a county before more can be built: ', ['holdings']],
    ['primary_heritages', 'Preferred by the heritages ', ['culture/pillars']],
    ['preferred_religions', 'Preferred by the religions ', ['religion/religion_types']],
    ['blocked_subject_courts', 'No royal court for subjects with ', ['governments']],
    ['compatible_government_type_succession', 'Also takes heirs with ', ['governments']]
];

/** Opinion script values of a government (`opinion_of_liege` …) and who has the opinion. */
const GOVERNMENT_OPINIONS: [string, string][] = [
    ['opinion_of_liege', 'Vassals’ opinion of their liege'],
    ['opinion_of_suzerain', 'Tributaries’ opinion of their suzerain'],
    ['opinion_of_overlord', 'Subjects’ opinion of their overlord']
];

/**
 * A government (common/governments/_governments.info): settings, holdings, what it offers (its flags, read with the
 * game's texts for them), its rules, the ruler's modifiers, who gets it, the AI's behaviour.
 */
const government: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    c.skip('color', 'realm_mask_offset', 'realm_mask_scale', 'opinion_of_liege_desc', 'opinion_of_suzerain_desc', 'opinion_of_overlord_desc');
    // the primary holding first, then the other holdings and lists, then the other settings
    const primary = c.node('primary_holding');
    const lines: Line[] = typeof primary?.v === 'string' ? [c.field('governments', primary)] : [];

    for (const [k, label, types] of GOVERNMENT_LISTS)
    {
        const n = c.block(k);

        if (n && items(n).length)
            lines.push({ text: rich(label, join(items(n).map((i) => b.d.ref(i.v as string, types)))), tip: k, src: c.anchor(n, 'other') });
    }

    const caps = c.block('currency_levels_cap');

    if (caps)
        lines.push({
            text: rich(
                'Highest levels: ',
                caps.v.filter((n) => n.k && typeof n.v === 'string')
                    .map((n) => `${humanize(n.k!)} ${n.v}`)
                    .join(', ')
            ),
            tip: 'currency_levels_cap (0-based)',
            src: c.anchor(caps, 'other')
        });

    const prestige = c.block('prestige_opinion_override');

    if (prestige)
        lines.push({ text: rich('Opinion from prestige levels: ', items(prestige).map((n) => n.v).join(', ')), tip: 'prestige_opinion_override', src: c.anchor(prestige, 'other') });

    c.settings('Settings', 'governments', lines);
    const flags = c.block('flags');

    // (the game's government tooltip lists the flags with a loc text of the same key)
    if (flags)
        c.section('Features', items(flags).map((n): Line => ({ text: c.text(n.v as string) ?? [capitalize(humanize(n.v as string))], icon: 'flag', tip: `flags: ${n.v}`, src: c.anchor(n, 'other') })));

    const rules = c.block('government_rules');

    if (rules)
        c.section('Rules', c.fields('government_rules', rules.v), b.blockSection(rules, 'field', c.ctx, 'government_rules'));

    for (const [k, title] of [['character_modifier', 'Ruler modifiers'], ['top_liege_character_modifier', 'Independent ruler modifiers']])
    {
        const n = c.block(k);

        if (n)
            c.section(title, b.d.statsOf(n.v, c.ctx), b.blockSection(n, 'modifier', c.ctx));
    }

    for (const [k, title] of GOVERNMENT_OPINIONS)
    {
        const n = c.block(k);

        if (n)
            c.section(title, c.value(n), b.blockSection(n, 'field', c.ctx, 'script_value'));
    }

    c.triggers('can_get_government', 'Rulers get it when', 'character');
    c.triggers('can_move_realm_capital', 'Can move the realm capital when', 'character');
    const ai = c.block('ai');

    if (ai)
        c.aiMore(c.fields('government_ai', ai.v));

    c.ai('ai_ruler_desired_kingdom_titles', 'Kingdoms the AI keeps (below 0: all)');
    c.ai('ai_ruler_desired_empire_titles', 'Empires the AI keeps (below 0: all)');
    const council = c.block('ai_can_reassign_council_positions');

    if (council)
        c.aiMore([{ text: ['The AI may reassign council positions when:'], conditions: c.conditions(council, 'character'), src: c.anchor(council, 'trigger', true) }]);

    return c.done();
};

export const TITLE_CARDS: Record<string, CardFn> = {
    landed_titles: title,
    holdings: holding,
    governments: government
};
