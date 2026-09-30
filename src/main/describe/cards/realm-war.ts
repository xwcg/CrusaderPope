/** Realm cards: men-at-arms, casus belli groups, AI war stances (common/men_at_arms_types, casus_belli_groups, ai_war_stances). */
import type { Line, Rich, RichSeg } from '../../../shared/api.ts';
import { capitalize, formatNumber, humanize, rich, signed } from '../text.ts';
import type { CardFn } from './types.ts';
import { RealmCard, isBlock, join, ownValue, val, type Block } from './realm-kit.ts';

/** The stats of a men-at-arms type, in the order a player reads them (common/men_at_arms_types/_men_at_arms_types.info). */
const MAA_STATS = ['damage', 'toughness', 'pursuit', 'screen', 'siege_value', 'siege_tier', 'stack', 'hired_stack_size', 'max', 'max_regiments', 'max_sub_regiments'];

/** A men-at-arms base type (`type = skirmishers`, a counter): its loc text (a concept link), else the key made readable. */
function baseType(c: RealmCard, key: string): Rich
{
    return c.d.loc(key) ?? [capitalize(humanize(key))];
}

/** A bonus block's stats in one line: "+4 damage, +6 toughness". */
function bonusText(c: RealmCard, n: Block): Rich
{
    const parts = n.v
        .filter((s) => s.k && typeof s.v === 'string')
        .map((s): RichSeg =>
        {
            const v = c.num(s.v as string);
            return v !== undefined ? { text: `${signed(v)} ${humanize(s.k!)}`, kind: v >= 0 ? 'good' : 'bad', tip: `${s.k} = ${s.v}` } : { text: `${humanize(s.k!)} ${s.v}`, kind: 'value' };
        });
    return join(parts, ', ');
}

/** Bonus blocks (`forest = { damage = 4 }`) by what they apply to: terrain, winter, holding. */
function bonusLines(c: RealmCard, n: Block | undefined, name: (key: string) => RichSeg | Rich): Line[]
{
    return (n?.v ?? []).filter(isBlock).map((t): Line => ({ text: rich(name(t.k!), ': ', bonusText(c, t)), tip: t.k!, src: c.b.fieldAnchor(t, c.ctx, 'maa_bonus', true) }));
}

const WINTER: Record<string, string> = { normal_winter: 'In winter', harsh_winter: 'In harsh winter' };

/**
 * A men-at-arms type: its base type, stats, costs, what it counters, terrain / winter / holding bonuses, when it can
 * be recruited, how the AI values it.
 */
const menAtArms: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    c.skip('icon', 'illustration');
    const type = c.val('type');

    if (type)
        c.fact('Type: ', baseType(c, type));

    if (val(x.body, 'special_recruit_only') === 'yes')
        c.fact('Never recruited — only made by events');

    // the stats first, then the other settings
    const provisions = c.node('provision_cost');
    c.settings('Stats', 'men_at_arms_types', c.fields('men_at_arms_types', MAA_STATS.flatMap((k) => c.all(k))));
    const costs: Line[] = [];

    for (const [k, label] of [['buy_cost', 'To recruit'], ['low_maintenance_cost', 'Upkeep while unraised and at full strength'], ['high_maintenance_cost', 'Upkeep while raised or reinforcing']])
    {
        const n = c.block(k);

        if (n)
            costs.push({ text: [label + ':'], children: c.cost(n), icon: 'gold', src: b.fieldAnchor(n, c.ctx, 'cost', true) });
    }

    if (provisions)
        costs.push(c.field('men_at_arms_types', provisions));

    c.section('Costs', costs);
    const counters = c.block('counters');
    c.section(
        'Counters',
        (counters?.v ?? [])
            .filter((n) => n.k && typeof n.v === 'string')
            .map((n): Line =>
            {
                const v = c.num(n.v as string);
                return { text: rich('Counters ', baseType(c, n.k!), v !== undefined && v !== 1 ? ` ×${formatNumber(v)}` : ''), tip: `${n.k} = ${n.v} (sub-regiments countered by one)`, src: c.anchor(n, 'other') };
            })
    );
    const bonuses = [
        ...bonusLines(c, c.block('terrain_bonus'), (k) => b.d.ref(k, ['terrain_types'])),
        ...bonusLines(c, c.block('winter_bonus'), (k) => [WINTER[k] ?? capitalize(humanize(k))]),
        ...bonusLines(c, c.block('holding_bonus'), (k) => rich('In a ', b.d.ref(k, ['holdings'])))
    ];
    c.section('Bonuses', bonuses);
    c.triggers('can_recruit', 'Can be recruited when', 'character');
    c.triggers('should_show_when_unavailable', 'Shown while unavailable when', 'character');
    c.triggers('access_through_subject', 'Available through subjects when', 'character');
    c.ai('ai_quality', 'How much the AI values it (besides its stats)');
    return c.done();
};

/**
 * A casus belli group: the casus belli in it (their `group = …`, read from their text: the group is no link of the
 * index) and when a character may use them.
 */
const casusBelliGroup: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const name = x.e.name;
    const members: Line[] = [];

    for (const cb of b.idx.names('casus_belli_types'))
    {
        const e = b.idx.get('casus_belli_types', cb)!;
        const d = b.idx.winningDef(e);

        if (!d)
            continue;

        const text = b.idx.readFile(d.file).slice(d.start, d.end);

        if (text.includes(name) && ownValue(text, 'group') === name)
            members.push({ text: [b.d.entitySeg(e)], tip: cb });
    }

    if (members.length)
        c.fact(`${members.length} casus belli`);

    c.section('Casus belli', members);
    c.triggers('allowed_for_character', 'Allowed when', 'character');
    c.settings('Settings', 'casus_belli_groups');
    return c.done();
};

/** Objectives of a war stance (common/ai_war_stances/_ai_war_stances.info). */
const OBJECTIVES: Record<string, string> = {
    wargoal_province: 'War goal provinces',
    enemy_unit_province: 'Enemy armies',
    enemy_capital_province: 'The enemy’s capital',
    capital_province: 'Its own capital',
    enemy_province: 'Enemy provinces',
    enemy_ally_province: 'Provinces of the enemy’s allies',
    province: 'Its own provinces',
    defend_wargoal_province: 'Defending the war goal'
};

const AREAS: Record<string, string> = {
    wargoal: 'the war goal',
    primary_attacker: 'the attacker’s lands',
    primary_attacker_ally: 'the attacker’s allies’ lands',
    primary_defender: 'the defender’s lands',
    primary_defender_ally: 'the defender’s allies’ lands'
};

/** One `objectives` block: its targets by priority (`enemy_unit_province = { priority area … }` in areas). */
function objectiveLines(c: RealmCard, n: Block): Line[]
{
    return n.v
        .filter((o) => o.k)
        .map((o): Line =>
        {
            const what = OBJECTIVES[o.k!] ?? capitalize(humanize(o.k!));

            if (typeof o.v === 'string')
                return { text: rich({ text: o.v, kind: 'value' }, ' — ', what), tip: `${o.k} = ${o.v}`, src: c.anchor(o, 'other') };

            const areas = o.v.filter((a) => a.k === 'area' && typeof a.v === 'string').map((a) => AREAS[a.v as string] ?? humanize(a.v as string));
            return { text: rich({ text: val(o.v, 'priority') ?? '?', kind: 'value' }, ' — ', what, areas.length ? rich(' in ', join(areas, ' or ')) : ''), tip: o.k!, src: c.anchor(o, 'other') };
        });
}

/** An AI war stance: which side, when it is considered, its objectives by priority, its weight. */
const warStance: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const side = val(x.body, 'side');

    if (side)
        c.fact(capitalize(side));

    const when = c.block('behaviour_attributes');

    if (when)
    {
        const on = when.v.filter((n) => n.k && n.v === 'yes').map((n) => n.k!);

        if (on.length)
            c.fact('When ', join(on, ' or '));
    }

    c.all('objectives')
        .filter(isBlock)
        .forEach((n, i) => c.section(i ? 'Then' : 'Objectives (priority — target)', objectiveLines(c, n)));
    c.settings('Settings', 'ai_war_stances', when ? c.fields('war_stance_behaviour', when.v) : []);
    c.triggers('can_be_picked', 'Picked when', 'war');
    c.ai('ai_will_do', 'Weight of this stance');
    return c.done();
};

export const WAR_CARDS: Record<string, CardFn> = {
    men_at_arms_types: menAtArms,
    casus_belli_groups: casusBelliGroup,
    ai_war_stances: warStance
};
