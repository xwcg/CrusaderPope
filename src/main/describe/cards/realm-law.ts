/**
 * Realm cards: laws, law groups, succession elections and appointments (common/laws, common/law_groups,
 * succession_election, succession_appointment). Laws in either layout: blocks in their group, or (1.20) on their own
 * naming it (docs/game-structure.md, "Layouts that changed").
 */
import type { PNode } from '../../indexer/parser.ts';
import { groupLaws, lawGroupType } from '../../indexer/layouts.ts';
import { updateSection } from './culture-faith.ts';
import type { Line } from '../../../shared/api.ts';
import { capitalize, humanize, rich } from '../text.ts';
import type { CardFn } from './types.ts';
import { RealmCard, isBlock, items, join, val } from './realm-kit.ts';

import { tr } from '../../../shared/i18n.ts';
/** Law flags the game's code knows (common/laws/_laws.info, "Hardcoded Flags"); others are checked by script. */
const LAW_FLAGS: Record<string, string> = {
    titles_cannot_leave_realm_on_succession: tr('Titles cannot leave the realm on succession — heirs outside it are passed over'),
    men_can_have_multiple_spouses: tr('Men may have several spouses (if their faith allows)'),
    men_can_have_consorts: tr('Men may have consorts (if their faith allows)'),
    women_can_have_multiple_spouses: tr('Women may have several spouses (if their faith allows)'),
    women_can_have_consorts: tr('Women may have consorts (if their faith allows)'),
    // law groups: `flag = realm_law`
    realm_law: tr('Shown in the My Realm window')
};

const LAW_TRIGGERS: [string, string][] = [
    ['potential', tr('Available when')],
    ['can_have', tr('Can be adopted when')],
    ['can_pass', tr('Can be passed when')],
    ['requires_approve', tr('Needs approval when')],
    ['can_keep', tr('Kept while')],
    ['should_start_with', tr('Rulers start with it when')],
    ['can_title_have', tr('Titles can have it when')],
    ['can_realm_have', tr('The whole realm can have it when')],
    ['should_show_for_title', tr('Shown for titles when')],
    ['can_remove_from_title', tr('Can be removed from a title when')]
];

const LAW_EFFECTS: [string, string][] = [
    ['on_pass', tr('When passed')],
    ['on_after_pass', tr('Right after passing')],
    ['on_revoke', tr('When revoked')]
];

/** Blocks of a law group that are no laws (common/laws/_laws.info). */
const GROUP_BLOCKS = new Set(['can_change_law_group']);

/** Candidate and elector sets of an election (common/succession_election/_succession_election.info). */
const ELECTION_SETS: Record<string, string> = {
    title_claimants: tr('Claimants of the title'),
    title_dejure_vassals: tr('De jure vassals of the title, down to counts'),
    holder: tr('The holder'),
    holder_direct_vassals: tr('The holder’s direct vassals'),
    holder_spouses: tr('The holder’s spouses'),
    holder_close_family: tr('The holder’s close family'),
    holder_close_or_extended_family: tr('The holder’s close or extended family'),
    holder_dynasty: tr('The holder’s dynasty'),
    holder_council_members: tr('The holder’s council'),
    holder_tributaries: tr('The holder’s tributaries')
};

/** Default candidates of an appointment (common/succession_appointment/_succession_appointment.info). */
const APPOINTMENT_SETS: Record<string, string> = {
    holder_close_family: tr('the holder’s close family'),
    holder_close_extended_family: tr('the holder’s close and extended family'),
    holder_house_member: tr('the holder’s house'),
    landed_vassal: tr('landed vassals (the holder’s and their peers)'),
    landed_vassal_close_family: tr('close family of landed vassals'),
    landed_vassal_close_extended_family: tr('close and extended family of landed vassals'),
    landed_vassal_house_member: tr('houses of landed vassals'),
    unlanded_noble_house_head: tr('heads of landless noble houses'),
    unlanded_noble_close_family: tr('close family of landless noble house heads'),
    unlanded_noble_close_extended_family: tr('close and extended family of landless noble house heads'),
    unlanded_noble_house_member: tr('landless noble houses'),
    holder_councilor: tr('the holder’s councillors'),
    holder_court_position: tr('the holder’s court position holders'),
    direct_subject: tr('direct subjects')
};

/** A law or law group flag as a line (anchored as a field of the set). */
function flagLine(c: RealmCard, n: PNode, set: string): Line
{
    const f = n.v as string;
    return { text: [LAW_FLAGS[f] ?? capitalize(humanize(f))], icon: 'flag', tip: `flag = ${f}`, src: c.b.fieldAnchor(n, c.ctx, set) };
}

/**
 * A law (a block inside its law group, or (1.20) naming it with `law_group_type`; common/laws/_laws.info): its group
 * and place there, succession rules, the modifier on the ruler, its flags and settings, the conditions to have / pass /
 * keep it, costs, effects, the AI.
 */
const law: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const name = x.e.name;
    const named = lawGroupType(x.body);
    const key = named ?? c.enclosing();
    const group = key ? b.idx.get('law_groups', key) : undefined;
    c.skip('law_group_type', 'index');
    // (written inside its group: the old layout; the group's "update" splits them)
    const update = !named && key ?
        updateSection(b, x.e, x.card.src, [{ text: tr('written inside its law group {key} — 1.20 reads laws that name their group (`law_group_type`), the groups from common/law_groups', { key }), tip: tr('Update (on the group): each law names it, the group moves to common/law_groups') }], {
            type: 'law_groups',
            name: key,
            fix: 'law-group',
            label: tr('update the group')
        }) :
        undefined;

    if (update)
        x.card.sections.push(update);

    // the in-game effects text (`<law>_effects`) when there is no description
    c.describe(`${name}_effects`);
    const gd = group && b.idx.defNode(group);

    if (group && gd)
    {
        const gb = b.body(gd.node);
        const laws = groupLaws(b.idx, group, gb, GROUP_BLOCKS);
        const i = laws.findIndex((n) => n.name === name);
        const cumulative = val(gb, 'cumulative') === 'yes';

        if (i < 0)
            c.fact(tr('Law of '), b.d.entitySeg(group));
        else if (cumulative)
            c.fact(b.d.entitySeg(group), tr(' level {value} of {length}', { value: i + 1, length: laws.length }));
        else
            c.fact(tr('One of {length} ', { length: laws.length }), b.d.entitySeg(group));

        if (val(gb, 'default') === name)
            c.fact(tr('The default law'));

        if (cumulative && i > 0)
            c.fact(tr('Also has the effects of '), b.d.ref(laws[i - 1].name, ['laws']));
    }

    const succession = c.block('succession');

    if (succession)
        c.section(tr('Succession'), c.fields('law_succession', succession.v), b.blockSection(succession, 'field', c.ctx, 'law_succession'));

    const stats = c.all('modifier').filter(isBlock);

    if (stats.length)
        c.section(tr('Modifiers'), stats.flatMap((m) => b.d.statsOf(m.v, c.ctx)), b.blockSection(stats[0], 'modifier', c.ctx));

    // flags (hardcoded ones in words), flags under conditions, the other settings
    const rules = c.all('flag')
        .filter((n) => typeof n.v === 'string')
        .map((n) => flagLine(c, n, 'laws'));

    for (const t of c.all('triggered_flag').filter(isBlock))
    {
        const f = val(t.v, 'flag');
        rules.push({ text: [(f ? (LAW_FLAGS[f] ?? capitalize(humanize(f))) : tr('A flag')) + tr(', when:')], icon: 'flag', conditions: c.conditions(t.v.find((n) => n.k === 'trigger'), 'character'), tip: `triggered_flag: ${f}`, src: c.anchor(t, 'other') });
    }

    c.settings(tr('Rules'), 'laws', rules, ['pass_phrase', 'confirmation_title', 'confirmation_button_text']);

    for (const [k, title] of LAW_TRIGGERS)
        c.triggers(k, title, k.includes('title') ? 'landed_title' : 'character');

    for (const [k, title] of [['pass_cost', tr('Cost to pass')], ['revoke_cost', tr('Cost to revoke')]])
    {
        const n = c.block(k);

        if (n)
            c.section(title, c.cost(n), b.blockSection(n, 'field', c.ctx, 'cost'));
    }

    for (const [k, title] of LAW_EFFECTS)
        c.effects(k, title, 'character');

    c.ai('ai_will_do', tr('Enacted by the AI above 0 (the best law wins)'));
    return c.done();
};

/**
 * A law group (common/laws/_laws.info; 1.20: common/law_groups, its laws naming it): its laws in order, the default,
 * whether they build on each other.
 */
const lawGroup: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const laws = groupLaws(b.idx, x.e, x.body, GROUP_BLOCKS);
    c.skip(...laws.map((n) => n.name));
    // (laws written inside it: the old layout)
    const inside = laws.filter((l) => l.node).length;
    const update = updateSection(
        b,
        x.e,
        x.card.src,
        inside ? [{ text: tr('{inside} laws written inside the group — 1.20 reads laws that name their group (`law_group_type`), the groups from common/law_groups', { inside }), tip: tr('Update: each law names the group (and its place: index), the group moves to common/law_groups') }] : [],
        {
            type: 'law_groups',
            name: x.e.name,
            fix: 'law-group',
            label: 'update'
        }
    );

    if (update)
        x.card.sections.push(update);

    const def = val(x.body, 'default');

    if (laws.length)
        c.fact(tr('{length} laws', { length: laws.length }));

    c.section(
        tr('Laws'),
        laws.map((n, i) => ({ text: rich(`${i + 1}. `, b.d.ref(n.name, ['laws']), n.name === def ? tr(' — the default') : ''), tip: n.name, src: n.node && c.anchor(n.node, 'other') }))
    );
    const flags = c.all('flag')
        .filter((n) => typeof n.v === 'string')
        .map((n) => flagLine(c, n, 'law_groups'));
    c.settings(tr('Rules'), 'law_groups', flags);
    c.triggers('can_change_law_group', tr('Can be changed when'), 'character');
    return c.done();
};

/** Candidate / elector sets: `add = holder`, `add = { type = … limit = { … } }`, `limit`, `max`, `priority`. */
function electionSets(c: RealmCard, n: PNode | undefined, who: string): Line[]
{
    if (!isBlock(n))
        return [];

    const out: Line[] = [];

    for (const s of n.v)
    {
        if (s.k === 'add')
        {
            const type = typeof s.v === 'string' ? s.v : val(s.v, 'type');
            const limit = isBlock(s) ? s.v.find((x) => x.k === 'limit') : undefined;
            out.push({ text: [(type && ELECTION_SETS[type]) ?? capitalize(humanize(type ?? 'someone'))], icon: 'scope', conditions: c.conditions(limit, 'character'), tip: type, src: c.anchor(s, 'other') });
        }
        else if (s.k === 'limit')
            out.push({ text: [tr('Every one of the {who}:', { who })], conditions: c.conditions(s, 'character'), src: c.anchor(s, 'trigger', true) });
        else if (s.k === 'max' && typeof s.v === 'string')
            out.push({ text: [Number(s.v) < 0 ? tr('Any number of {who}', { who }) : tr('At most {v} {who}', { v: s.v, who })], tip: `max = ${s.v}`, src: c.anchor(s, 'other') });
        else if (s.k === 'priority')
            out.push(c.weight(s, tr('Who comes first when there are more {who}', { who })));
    }

    return out;
}

/** An election (common/succession_election): who can be elected, who votes and how strongly, how the AI votes. */
const election: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const name = x.e.name;
    c.title(`${name}_succession_law`);
    c.describe(`${name}_succession_law_effects`);

    for (const [k, label] of [['candidates', tr('Candidates: ')], ['electors', tr('Electors: ')]])
    {
        const r = b.d.loc(`${name}_${k}`);

        if (r)
            c.fact(label, r);
    }

    c.section(tr('Candidates'), electionSets(c, c.node('candidates'), 'candidates'));
    c.section(tr('Electors'), electionSets(c, c.node('electors'), 'electors'));
    const strength = c.node('elector_vote_strength');

    if (strength)
        c.section(tr('Vote strength'), [c.weight(strength, tr('Each elector’s votes'))]);

    c.ai('candidate_score', tr('AI electors vote for the candidate with the highest score'));
    return c.done();
};

/** An appointment (common/succession_appointment): the default candidates and how they are scored. */
const appointment: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const lines: Line[] = [];
    const cands = c.node('default_candidates');

    if (cands)
    {
        const names = items(cands).map((n) => APPOINTMENT_SETS[n.v as string] ?? humanize(n.v as string));
        lines.push({ text: rich(tr('Candidates: '), join(names)), icon: 'scope', src: c.anchor(cands, 'other') });
    }

    c.settings(tr('Candidates'), 'succession_appointment', lines);
    const score = c.block('candidate_score');

    if (score)
        c.section(tr('Candidate score'), c.value(score), b.blockSection(score, 'field', c.ctx, 'script_value'));

    return c.done();
};

export const LAW_CARDS: Record<string, CardFn> = {
    laws: law,
    law_groups: lawGroup,
    succession_election: election,
    succession_appointment: appointment
};
