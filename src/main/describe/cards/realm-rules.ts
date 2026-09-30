/** Realm cards: game rules and their settings, diarchy mandates, house relations and house unity (common/game_rules, diarchies/diarchy_mandates, house_relation_types, house_unities). */
import type { PNode } from '../../indexer/parser.ts';
import type { Line, Rich } from '../../../shared/api.ts';
import { capitalize, humanize, rich } from '../text.ts';
import type { CardFn } from './types.ts';
import { RealmCard, isBlock, items, val, type Block } from './realm-kit.ts';

/** Game rule setting flags with an effect in code (common/game_rules/_game_rules.info, "Flags"). */
const RULE_FLAGS: Record<string, string> = {
    no_end_date: 'No end date',
    no_diplomatic_range: 'No diplomatic range',
    restricted_diplomatic_range: 'Restricted diplomatic range',
    blocks_achievements: 'Disables achievements'
};

/** `apply_modifier = <who>:<modifier>` of a game rule setting. */
const RULE_WHO: Record<string, string> = { player: 'The player gets ', ai: 'AI rulers get ', all: 'Everyone gets ' };

/** What a game rule setting does: its modifiers and flags. */
function ruleEffects(c: RealmCard, list: PNode[]): Line[]
{
    const out: Line[] = [];

    for (const n of list)
    {
        if (typeof n.v !== 'string')
            continue;

        if (n.k === 'apply_modifier')
        {
            const [who, mod] = n.v.includes(':') ? n.v.split(':') : ['all', n.v];
            out.push({ text: rich(RULE_WHO[who] ?? `${capitalize(humanize(who))} get `, c.d.ref(mod, ['modifiers'])), icon: 'modifier', tip: `apply_modifier = ${n.v}`, src: c.anchor(n, 'other') });
        }
        else if (n.k === 'flag')
        {
            const adv = /^advantage_damage_effect_(\d+)$/.exec(n.v);
            out.push({ text: [adv ? `Each point of advantage adds ${adv[1]}% damage` : (RULE_FLAGS[n.v] ?? capitalize(humanize(n.v)))], icon: 'flag', tip: `flag = ${n.v}`, src: c.anchor(n, 'other') });
        }
    }

    return out;
}

/** A game rule (common/game_rules/_game_rules.info): its categories, the default and every setting with what it does. */
const gameRule: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const name = x.e.name;
    c.title(`rule_${name}`);
    c.describe(`rule_${name}_desc`);
    const cats = items(c.block('categories')).map((n) => b.idx.plainLoc(`game_rule_category_${n.v}`) ?? capitalize(humanize(n.v as string)));

    if (cats.length)
        c.fact(cats.join(' · '));

    const options = x.body.filter((n): n is Block => !!n.k && n.k !== 'categories' && isBlock(n));
    c.skip(...options.map((n) => n.k!));
    const def = c.node('default');
    const lines: Line[] = typeof def?.v === 'string' ? [c.field('game_rules', def)] : [];

    for (const o of options)
        lines.push({ text: [b.d.ref(o.k!, ['game_rule_options'])], children: ruleEffects(c, o.v), tip: o.k!, src: c.anchor(o, 'other') });

    c.section('Settings', lines, x.own('field', 'game_rules'));
    return c.done();
};

/** A game rule setting: which rule it belongs to, whether it is the default, what it does. */
const gameRuleOption: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const name = x.e.name;
    c.title(`setting_${name}`);
    c.describe(`setting_${name}_desc`);
    const key = c.enclosing();
    const rule = key ? b.idx.get('game_rules', key) : undefined;

    if (rule)
    {
        c.fact('Setting of ', b.d.entitySeg(rule));
        const rd = b.idx.defNode(rule);

        if (rd && val(b.body(rd.node), 'default') === name)
            c.fact('The default');
    }

    c.skip('apply_modifier', 'flag');
    c.section('Effects', ruleEffects(c, x.body));
    return c.done();
};

/** A diarchy mandate: how suited a diarch is for it, how likely the liege picks it. */
const mandate: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const name = x.e.name;
    c.title(`${name}_mandate`);
    c.describe(`${name}_mandate_desc`);
    const q = c.block('qualification_score');

    if (q)
        c.section('Aptitude of a diarch', c.value(q), b.blockSection(q, 'field', c.ctx, 'script_value'));

    c.ai('ai_score', 'How likely the liege picks it');
    return c.done();
};

/** A level's name (house relations, house unity stages): its loc, else the key made readable. */
function levelName(c: RealmCard, key: string): Rich
{
    return c.d.loc(key) ?? [capitalize(humanize(key))];
}

/** Parameters of a level or stage (`parameters = { a b }` or `{ a = yes }`) in one line. */
function paramsLine(c: RealmCard, n: Block): Line
{
    const names = n.v.filter((p) => (p.k ? p.v === 'yes' : typeof p.v === 'string')).map((p) => humanize((p.k ?? p.v) as string));
    return { text: [`Parameters: ${names.join(', ')}`], icon: 'flag', tip: 'parameters', src: c.anchor(n, 'other') };
}

/** A house relation type: its levels (opinion, bloc cohesion, parameters), the neutral one, when houses get one. */
const houseRelation: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const neutral = val(x.body, 'neutral_level');
    const levels = (c.block('levels')?.v ?? []).filter(isBlock);
    c.section(
        'Levels',
        levels.map((lv): Line =>
        {
            const params = lv.v.find((p) => p.k === 'parameters');
            const kids = c.fields('house_relation_level', lv.v);

            if (isBlock(params) && params.v.length)
                kids.push(paramsLine(c, params));

            return { text: rich(levelName(c, lv.k!), lv.k === neutral ? ' — neutral' : ''), children: kids, tip: lv.k!, src: b.fieldAnchor(lv, c.ctx, 'house_relation_level', true) };
        })
    );
    c.settings('Settings', 'house_relation_types');
    c.triggers('is_valid_to_start', 'Houses get one when');
    c.triggers('is_valid_to_keep', 'Kept while');
    return c.done();
};

/** House unity (common/house_unities/_house_unities.info): its range, and each stage — points, modifiers, parameters, decisions, effects. */
const houseUnity: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    c.settings('Settings', 'house_unities');
    let from = Number(val(x.body, 'min_value') ?? 0);

    for (const st of x.body.filter((n): n is Block => !!n.k && isBlock(n)))
    {
        c.skip(st.k!);
        const lines = c.fields('house_unity_stage', st.v.filter((n) => n.k !== 'icon'));
        const mods = st.v.find((n) => n.k === 'modifiers');
        const stats = isBlock(mods) ? b.d.statsOf(mods.v, c.ctx) : [];

        // (AI-only modifiers are hidden)
        if (mods && stats.length)
            lines.push({ text: ['Modifiers for the house members:'], children: stats, icon: 'modifier', src: c.anchor(mods, 'modifier', true) });

        const params = st.v.find((n) => n.k === 'parameters');

        if (isBlock(params) && params.v.length)
            lines.push(paramsLine(c, params));

        const decisions = st.v.find((n) => n.k === 'decisions');

        if (isBlock(decisions))
            lines.push({ text: ['Decisions:'], children: items(decisions).map((d) => ({ text: [b.d.ref(d.v as string, ['decisions'])], tip: d.v as string, src: c.anchor(d, 'other') })), src: c.anchor(decisions, 'other') });

        for (const [k, label] of [['on_start', 'When it begins:'], ['on_end', 'When it ends:']])
        {
            const n = st.v.find((e) => e.k === k);

            if (isBlock(n))
                lines.push({ text: [label], children: b.d.effects(n.v, { ...c.ctx, followUps: [] }), icon: 'event', src: c.anchor(n, 'effect', true) });
        }

        const points = Number(val(st.v, 'points') ?? 0);
        c.section(`${b.d.richString(levelName(c, st.k!))} (${from}–${from + points})`, lines, b.blockSection(st, 'field', c.ctx, 'house_unity_stage'));
        from += points;
    }

    return c.done();
};

export const RULE_CARDS: Record<string, CardFn> = {
    game_rules: gameRule,
    game_rule_options: gameRuleOption,
    'diarchies/diarchy_mandates': mandate,
    house_relation_types: houseRelation,
    house_unities: houseUnity
};
