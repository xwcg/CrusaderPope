/**
 * Realm cards: laws, law groups, succession elections and appointments (common/laws, common/law_groups,
 * succession_election, succession_appointment). Laws in either layout: blocks in their group, or (1.20) on their own
 * naming it (docs/game-structure.md, "Layouts that changed").
 */
import type { PNode } from '../../indexer/parser.ts';
import { groupLaws, lawGroupType } from '../../indexer/layouts.ts';
import type { Line } from '../../../shared/api.ts';
import { capitalize, humanize, rich } from '../text.ts';
import type { CardFn } from './types.ts';
import { RealmCard, isBlock, items, join, val } from './realm-kit.ts';

/** Law flags the game's code knows (common/laws/_laws.info, "Hardcoded Flags"); others are checked by script. */
const LAW_FLAGS: Record<string, string> = {
    titles_cannot_leave_realm_on_succession: 'Titles cannot leave the realm on succession — heirs outside it are passed over',
    men_can_have_multiple_spouses: 'Men may have several spouses (if their faith allows)',
    men_can_have_consorts: 'Men may have consorts (if their faith allows)',
    women_can_have_multiple_spouses: 'Women may have several spouses (if their faith allows)',
    women_can_have_consorts: 'Women may have consorts (if their faith allows)',
    // law groups: `flag = realm_law`
    realm_law: 'Shown in the My Realm window'
};

const LAW_TRIGGERS: [string, string][] = [
    ['potential', 'Available when'],
    ['can_have', 'Can be adopted when'],
    ['can_pass', 'Can be passed when'],
    ['requires_approve', 'Needs approval when'],
    ['can_keep', 'Kept while'],
    ['should_start_with', 'Rulers start with it when'],
    ['can_title_have', 'Titles can have it when'],
    ['can_realm_have', 'The whole realm can have it when'],
    ['should_show_for_title', 'Shown for titles when'],
    ['can_remove_from_title', 'Can be removed from a title when']
];

const LAW_EFFECTS: [string, string][] = [
    ['on_pass', 'When passed'],
    ['on_after_pass', 'Right after passing'],
    ['on_revoke', 'When revoked']
];

/** Blocks of a law group that are no laws (common/laws/_laws.info). */
const GROUP_BLOCKS = new Set(['can_change_law_group']);

/** Candidate and elector sets of an election (common/succession_election/_succession_election.info). */
const ELECTION_SETS: Record<string, string> = {
    title_claimants: 'Claimants of the title',
    title_dejure_vassals: 'De jure vassals of the title, down to counts',
    holder: 'The holder',
    holder_direct_vassals: 'The holder’s direct vassals',
    holder_spouses: 'The holder’s spouses',
    holder_close_family: 'The holder’s close family',
    holder_close_or_extended_family: 'The holder’s close or extended family',
    holder_dynasty: 'The holder’s dynasty',
    holder_council_members: 'The holder’s council',
    holder_tributaries: 'The holder’s tributaries'
};

/** Default candidates of an appointment (common/succession_appointment/_succession_appointment.info). */
const APPOINTMENT_SETS: Record<string, string> = {
    holder_close_family: 'the holder’s close family',
    holder_close_extended_family: 'the holder’s close and extended family',
    holder_house_member: 'the holder’s house',
    landed_vassal: 'landed vassals (the holder’s and their peers)',
    landed_vassal_close_family: 'close family of landed vassals',
    landed_vassal_close_extended_family: 'close and extended family of landed vassals',
    landed_vassal_house_member: 'houses of landed vassals',
    unlanded_noble_house_head: 'heads of landless noble houses',
    unlanded_noble_close_family: 'close family of landless noble house heads',
    unlanded_noble_close_extended_family: 'close and extended family of landless noble house heads',
    unlanded_noble_house_member: 'landless noble houses',
    holder_councilor: 'the holder’s councillors',
    holder_court_position: 'the holder’s court position holders',
    direct_subject: 'direct subjects'
};

/** A law or law group flag as a line (anchored as a field of the set). */
function flagLine(c: RealmCard, n: PNode, set: string): Line
{
    const f = n.v as string;
    return { text: [LAW_FLAGS[f] ?? capitalize(humanize(f))], icon: 'flag', tip: `flag = ${f}`, src: c.b.fieldAnchor(n, c.ctx, set) };
}

/**
 * A law (a block inside its law group, or — 1.20 — naming it with `law_group_type`; common/laws/_laws.info): its group
 * and place there, succession rules, the modifier on the ruler, its flags and settings, the conditions to have / pass /
 * keep it, costs, effects, the AI.
 */
const law: CardFn = (b, x) =>
{
    const c = new RealmCard(b, x);
    const name = x.e.name;
    const key = lawGroupType(x.body) ?? c.enclosing();
    const group = key ? b.idx.get('law_groups', key) : undefined;
    c.skip('law_group_type', 'index');
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
            c.fact('Law of ', b.d.entitySeg(group));
        else if (cumulative)
            c.fact(b.d.entitySeg(group), ` level ${i + 1} of ${laws.length}`);
        else
            c.fact(`One of ${laws.length} `, b.d.entitySeg(group));

        if (val(gb, 'default') === name)
            c.fact('The default law');

        if (cumulative && i > 0)
            c.fact('Also has the effects of ', b.d.ref(laws[i - 1].name, ['laws']));
    }

    const succession = c.block('succession');

    if (succession)
        c.section('Succession', c.fields('law_succession', succession.v), b.blockSection(succession, 'field', c.ctx, 'law_succession'));

    const stats = c.all('modifier').filter(isBlock);

    if (stats.length)
        c.section('Modifiers', stats.flatMap((m) => b.d.statsOf(m.v, c.ctx)), b.blockSection(stats[0], 'modifier', c.ctx));

    // flags (hardcoded ones in words), flags under conditions, the other settings
    const rules = c.all('flag')
        .filter((n) => typeof n.v === 'string')
        .map((n) => flagLine(c, n, 'laws'));

    for (const t of c.all('triggered_flag').filter(isBlock))
    {
        const f = val(t.v, 'flag');
        rules.push({ text: [(f ? (LAW_FLAGS[f] ?? capitalize(humanize(f))) : 'A flag') + ', when:'], icon: 'flag', conditions: c.conditions(t.v.find((n) => n.k === 'trigger'), 'character'), tip: `triggered_flag: ${f}`, src: c.anchor(t, 'other') });
    }

    c.settings('Rules', 'laws', rules, ['pass_phrase', 'confirmation_title', 'confirmation_button_text']);

    for (const [k, title] of LAW_TRIGGERS)
        c.triggers(k, title, k.includes('title') ? 'landed_title' : 'character');

    for (const [k, title] of [['pass_cost', 'Cost to pass'], ['revoke_cost', 'Cost to revoke']])
    {
        const n = c.block(k);

        if (n)
            c.section(title, c.cost(n), b.blockSection(n, 'field', c.ctx, 'cost'));
    }

    for (const [k, title] of LAW_EFFECTS)
        c.effects(k, title, 'character');

    c.ai('ai_will_do', 'Enacted by the AI above 0 (the best law wins)');
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
    const def = val(x.body, 'default');

    if (laws.length)
        c.fact(`${laws.length} laws`);

    c.section(
        'Laws',
        laws.map((n, i) => ({ text: rich(`${i + 1}. `, b.d.ref(n.name, ['laws']), n.name === def ? ' — the default' : ''), tip: n.name, src: n.node && c.anchor(n.node, 'other') }))
    );
    const flags = c.all('flag')
        .filter((n) => typeof n.v === 'string')
        .map((n) => flagLine(c, n, 'law_groups'));
    c.settings('Rules', 'law_groups', flags);
    c.triggers('can_change_law_group', 'Can be changed when', 'character');
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
            out.push({ text: [`Every one of the ${who}:`], conditions: c.conditions(s, 'character'), src: c.anchor(s, 'trigger', true) });
        else if (s.k === 'max' && typeof s.v === 'string')
            out.push({ text: [Number(s.v) < 0 ? `Any number of ${who}` : `At most ${s.v} ${who}`], tip: `max = ${s.v}`, src: c.anchor(s, 'other') });
        else if (s.k === 'priority')
            out.push(c.weight(s, `Who comes first when there are more ${who}`));
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

    for (const [k, label] of [['candidates', 'Candidates: '], ['electors', 'Electors: ']])
    {
        const r = b.d.loc(`${name}_${k}`);

        if (r)
            c.fact(label, r);
    }

    c.section('Candidates', electionSets(c, c.node('candidates'), 'candidates'));
    c.section('Electors', electionSets(c, c.node('electors'), 'electors'));
    const strength = c.node('elector_vote_strength');

    if (strength)
        c.section('Vote strength', [c.weight(strength, 'Each elector’s votes')]);

    c.ai('candidate_score', 'AI electors vote for the candidate with the highest score');
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
        lines.push({ text: rich('Candidates: ', join(names)), icon: 'scope', src: c.anchor(cands, 'other') });
    }

    c.settings('Candidates', 'succession_appointment', lines);
    const score = c.block('candidate_score');

    if (score)
        c.section('Candidate score', c.value(score), b.blockSection(score, 'field', c.ctx, 'script_value'));

    return c.done();
};

export const LAW_CARDS: Record<string, CardFn> = {
    laws: law,
    law_groups: lawGroup,
    succession_election: election,
    succession_appointment: appointment
};
