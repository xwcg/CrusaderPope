// Checks the statement picker's catalog (src/shared/scriptCatalog.ts) against the game's script: every effect,
// trigger and iterator it writes must be used by the game in the same role (effect / trigger block), and fills the
// templates of every statement. Also prints the most used keys the catalog does not cover (candidates to add).
// Then the key scan's incremental rescan: an editable mod's files changed, added and removed are taken in like a full
// scan would (scripts/picker-check.ts … prints "rescan: ok"). Then the menus (picker/model.ts): paths of rows chosen by
// their labels against the script they must build ("menus: N scenarios ok").
// Usage: node --experimental-strip-types scripts/picker-check.ts [installDir] [top]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameFiles, type GameFile } from '../src/main/mods/gamefiles.ts';
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { ScriptKeyScanner } from '../src/main/describe/scriptKeys.ts';
import { ITERATORS, LINKS, SCOPE_TYPES, STATEMENTS, fillTemplate, findStatement, parseSnippet, printScript, statementsFor, type StatementDef } from '../src/shared/scriptCatalog.ts';
import { FIELDS, fieldText } from '../src/shared/fieldCatalog.ts';
import type { EntryCreate, ModInfo, ModifierKeyInfo, ScriptKeyInfo, ScriptKeys } from '../src/shared/api.ts';
import { Describer } from '../src/main/describe/describer.ts';
import { parse } from '../src/main/indexer/parser.ts';
import { canPickEdit, chainType, createdNames, menuOf, modGroupOf, scopeInReach, usedCreates, resultText, setScriptedLists, startStates, valueScope, type Item, type Next, type PickerData, type RefEntry, type State } from '../src/renderer/src/picker/model.ts';
import { modifierAreaOf, modifierScopeOf, scopeOf, type ScopeType } from '../src/shared/scriptCatalog.ts';
import { firstSelectable, rowsOf } from '../src/renderer/src/picker/rows.ts';
import { defaultEntryName, plainLabel } from '../src/shared/entryName.ts';
import { setAwayTargets } from '../src/renderer/src/picker/targets.ts';
// (wave 11, lane T: the prev stack and a guessed scope)
import { setPlaceScopes } from '../src/renderer/src/picker/targets.ts';
import { keepWritten } from '../src/shared/scriptFormat.ts';
import { defaultInstall } from './ck3-install.ts';
// (lane F3: the title triple and the `+` key; wave 10: read back as one)
import { inPrev, outOfPrev } from '../src/shared/scriptCatalog.ts';
import { freeScopeName, plusRow, type Menu } from '../src/renderer/src/picker/model.ts';
// (lane G2: the field catalog's open sets)
import { valueKindOf } from '../src/renderer/src/picker/model.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import type { Line } from '../src/shared/api.ts';
// (lane H1: Other setting for the card builders' types)
import { CARD_SETS, OPEN_SETS } from '../src/shared/fieldCatalog.ts';
import { TYPE_CARDS } from '../src/main/describe/cards/index.ts';
// (lane U: written field blocks, named tracks)
import type { SectionSource } from '../src/shared/api.ts';
// (lane V: a doctrine's special values)
import { isOpenSet } from '../src/shared/fieldCatalog.ts';
import { applyRepoScriptFacts } from './script-facts.ts';
// (the script database on every pick: the documented scopes "Other…" judges by)
import { scriptFacts } from '../src/shared/scriptFacts.ts';

const gameDir = resolveGameDir(process.argv[2] ?? defaultInstall());

if (!gameDir)
    throw new Error('No CK3 game folder');

const TOP = Number(process.argv[3] ?? 40);

// (the script database's facts, as the app applies them; HAND=1 checks the hand-written tables alone)
const withFacts = !process.env.HAND && applyRepoScriptFacts();
console.log(withFacts ? 'tables: with the script database facts' : 'tables: hand-written');

const t0 = performance.now();
const scan = new ScriptKeyScanner().scan(new GameFiles(gameDir));
console.log(`scanned in ${Math.round(performance.now() - t0)} ms: ${scan.effect.length} effect keys, ${scan.trigger.length} trigger keys`);
const known = { effect: new Map(scan.effect.map((k) => [k.key, k.count])), trigger: new Map(scan.trigger.map((k) => [k.key, k.count])) };

/** The keys a statement writes (a choice filling the key gives one per option). */
function keysOf(d: StatementDef): string[]
{
    const k = /^[\w$]+/.exec(d.script)?.[0] ?? '';
    const c = d.params.find((p) => p.kind === 'choice' && k.includes(`$${p.name}$`));
    return c && c.kind === 'choice' ? c.options.map((o) => k.replace(`$${c.name}$`, o.value)) : [k];
}

let bad = 0;
const covered = new Set<string>();

for (const d of STATEMENTS)
{
    for (const k of keysOf(d))
    {
        covered.add(d.kind + ':' + k);

        if (d.subjectValue || known[d.kind].has(k))
            continue;

        console.log(`NOT USED BY THE GAME as ${d.kind}: ${k} (${d.id})`);
        bad++;
    }

    // the template with sample values parses and prints
    const values: Record<string, string> = {};

    for (const p of d.params)
        values[p.name] = p.kind === 'choice' ? p.options[0].value : p.kind === 'compare' ? '>=' : p.kind === 'duration' ? 'years = 5' : p.kind === 'number' ? '10' : 'x';

    values.subject = 'liege';
    const text = printScript(parseSnippet(fillTemplate(d, values)));

    if (!text || /\$\w+\$|[[\]]/.test(text))
    {
        console.log(`BAD TEMPLATE ${d.id}: ${text}`);
        bad++;
    }
}

for (const i of ITERATORS)
{
    // (a list some game scripts only pick from, `random_living_character`, has effects too)
    if (i.effect && !['every_', 'random_', 'ordered_'].some((p) => known.effect.has(p + i.list)))
        (console.log(`NOT USED: every_${i.list}`), bad++);

    if (i.trigger && !known.trigger.has('any_' + i.list))
        (console.log(`NOT USED: any_${i.list}`), bad++);
}

const effects = STATEMENTS.filter((s) => s.kind === 'effect' && !s.hidden).length;
const triggers = STATEMENTS.filter((s) => s.kind === 'trigger').length;
console.log(`catalog: ${effects} effects, ${triggers} triggers, ${ITERATORS.length} iterators: ${bad ? bad + ' problems' : 'all used by the game'}`);

for (const kind of ['effect', 'trigger'] as const)
{
    const miss = scan[kind].filter((k) => !k.scripted && !covered.has(kind + ':' + k.key) && !/^(every|random|ordered|any)_/.test(k.key)).slice(0, TOP);
    console.log(`\nmost used ${kind}s not in the catalog (reachable through "Other…"):\n` + miss.map((k) => `${k.key}:${k.count}`).join('  '));
}

// ---------------------------------------------------------------------------
// Statements read back as the 1.20 game writes them, and the field sets' keys (the layouts of 1.20.1.2)
// ---------------------------------------------------------------------------

{
    let wrong = 0;
    const fail = (what: string): void =>
    {
        console.log('STATEMENTS ' + what);
        wrong++;
    };
    // the stress block's `base` is not a trait; a trait's experience track is kept and written
    const stress = findStatement('effect', 'stress_and_fulfillment_impact = { base = 5 zealous = 10 }', 'character');

    if (stress?.def.id !== 'e.add.stress_if_trait' || stress.values.trait !== 'zealous' || stress.values.value !== '10' || stress.values.base !== '5' || stress.rest?.length)
        fail(`stress block: ${JSON.stringify(stress)}`);

    const xp = findStatement('effect', 'add_trait_xp = { trait = tourney_participant track = foot value = 5 }', 'character');
    const xpDef = xp?.def;

    if (xpDef?.id !== 'e.add.trait_xp' || xp?.values.track !== 'foot' || xp.rest?.length || !xpDef || fillTemplate(xpDef, xp.values) !== 'add_trait_xp = { trait = tourney_participant track = foot value = 5 }')
        fail(`add_trait_xp with a track: ${JSON.stringify(xp)}`);

    const xp2 = findStatement('trigger', 'has_trait_xp = { trait = tourney_participant track = horse value >= 50 }', 'character');

    if (xp2?.def.id !== 't.trait_xp' || xp2.values.track !== 'horse' || xp2.values.cmp !== '>=' || xp2.rest?.length)
        fail(`has_trait_xp with a track: ${JSON.stringify(xp2)}`);

    if (!findStatement('effect', 'add_trait_xp = { trait = brave value = 5 }', 'character'))
        fail('add_trait_xp without a track is no longer read');

    // a rite named by a chain leading to a rite (or a saved scope alone): set_character_rite read, not a chain leading elsewhere
    for (const [text, want] of [['set_character_rite = scope:x.rite', 'e.set.rite'], ['set_character_rite = scope:new_rite', 'e.set.rite'], ['set_character_rite = top_liege.primary_title.state_rite', 'e.set.rite'], ['set_character_rite = rite:hanafi', 'e.set.rite'], ['set_character_rite = scope:x.faith', undefined], ['set_character_rite = scope:x.d1_unknown_link', undefined]] as [string, string | undefined][])
    {
        const got = findStatement('effect', text, 'character')?.def.id;

        if (got !== want)
            fail(`${text}: ${got ?? 'no statement'} (expected ${want ?? 'none'})`);
    }

    // change_title_holder needs a `change`: read and changed where the game wrote it, never offered when building
    const holder = findStatement('effect', 'change_title_holder = { holder = root change = scope:change }', 'landed_title');

    if (holder?.def.id !== 'e.title.holder' || !holder.rest?.length)
        fail(`change_title_holder with a change: ${JSON.stringify(holder)}`);

    if (statementsFor('effect', 'landed_title').some((d) => d.script.startsWith('change_title_holder')))
        fail('change_title_holder is offered when building');

    // the other written forms of an effect (a bare value, a legend's chapter with its text) are read and changed where written, not offered twice when building
    for (const d of STATEMENTS)
        if (/_(bare|text)$/.test(d.id) && !d.noBuild)
            fail(`${d.id} is an alternative form but is offered when building`);

    // field sets: the 1.20 keys are there, the 1.19 ones the game ignores are not (common/**/_*.info of 1.20.1.2)
    const keys = (set: string): string[] => (FIELDS[set] ?? []).map((x) => x.key);
    const expect = (set: string, want: string[], gone: string[]): void =>
    {
        const have = keys(set);

        for (const k of want)
            if (!have.includes(k))
                fail(`field set ${set} lacks ${k}`);

        for (const k of gone)
            if (have.includes(k))
                fail(`field set ${set} still has ${k}`);
    };
    const BANNERS = ['tenet_background_icon', 'tenet_heretical_background_icon', 'tenet_neutral_background_icon', 'tenet_unknown_background_icon'];
    expect('succession_appointment', ['allowed_candidate_tier', 'cooldown', 'allow_children'], ['allow_same_tier_candidates']);
    expect('religion/doctrine_group_types', ['category', 'main_rite', 'divergence', 'doctrine_lock'], ['number_of_picks']);
    expect('religion/religion_family_types', ['hostility_doctrine', 'graphical_faith', 'piety_icon_group', ...BANNERS], ['doctrine_background_icon']);
    expect('religion/religion_details', ['family', 'graphical_faith', 'piety_icon_group', ...BANNERS, 'theocracy_government_type', 'theocracy_lease_contract_type'], ['doctrine', 'pagan_roots', 'doctrine_background_icon']);
    expect('religion/religion_types', ['doctrine', 'pagan_roots', 'family'], ['doctrine_background_icon']);
    expect('faith_details', ['religious_head', 'icon', 'reformed_icon', 'graphical_faith', 'theocracy_government_type'], ['doctrine', 'holy_site', 'piety_icon_group', 'doctrine_background_icon', ...BANNERS]);
    expect('faith_doctrines', ['doctrine'], ['holy_site']);
    expect('faith_holy_sites', ['holy_site'], ['doctrine']);
    expect('faith', ['doctrine', 'holy_site', 'icon'], ['doctrine_background_icon', ...BANNERS]);
    expect('governments', ['administrative_title_maa_setup'], ['title_maa_setup']);
    expect('subject_contracts/groups', ['is_tributary'], ['joins_suzerain_wars']);
    expect('men_at_arms_types', ['holy_order_fallback'], ['mercenary_fallback']);
    const cats = (FIELDS['religion/doctrine_group_types'].find((x) => x.key === 'category') as { options?: [string, string][]; } | undefined)?.options?.map((o) => o[0]) ?? [];

    if (cats.includes('core_tenets'))
        fail('doctrine group categories still offer core_tenets');

    // the statements for the 1.20 rites and tenets and the scope types of their own: found again as the game writes them, in the scope they run in
    const reads: [string, string, ScopeType, string, Record<string, string>][] = [
        ['trigger', 'rite_has_doctrine = doctrine_gender_equal', 'rite', 't.rite.doctrine', { doctrine: 'doctrine_gender_equal' }],
        ['trigger', 'rite_has_tenet = tenet_pacifism', 'rite', 't.rite.tenet', { tenet: 'tenet_pacifism' }],
        ['trigger', 'has_tenet_status = { tenet = prev status = prohibited }', 'rite', 't.rite.tenet_status', { tenet: 'prev', status: 'prohibited' }],
        ['trigger', 'has_tenet = tenet_aniconism', 'faith', 't.faith.tenet', { tenet: 'tenet_aniconism' }],
        ['effect', 'set_character_rite = rite:hanafi', 'character', 'e.set.rite', { rite: 'rite:hanafi' }],
        ['effect', 'set_county_rite = root.rite', 'landed_title', 'e.title.rite', { rite: 'root.rite' }],
        ['effect', 'set_order_tenet = tenet:tenet_simony', 'holy_order', 'e.order.tenet', { tenet: 'tenet:tenet_simony' }],
        ['effect', 'add_to_guest_subset = { name = supporter target = prev }', 'activity', 'e.activity.add_guest', { name: 'supporter', target: 'prev' }],
        ['effect', 'delay_travel_plan = { days = 14 }', 'travel_plan', 'e.travel.delay', { duration: 'days = 14' }],
        ['effect', 'activate_struggle_catalyst = { catalyst = catalyst_passing_of_time character = root }', 'struggle', 'e.struggle.catalyst', { catalyst: 'catalyst_passing_of_time', character: 'root' }],
        ['trigger', 'has_activity_option = { category = special_type option = hunt_type_falconry }', 'activity', 't.activity.option', { category: 'special_type', option: 'hunt_type_falconry' }],
        ['trigger', 'faction_power > 110', 'faction', 't.faction.power', { cmp: '>', value: '110' }],
        ['trigger', 'is_domicile_type = estate', 'domicile', 't.domicile.type', { type: 'estate' }],
        // (review of the 1.20.1 catalog: weeks are a duration unit; a legend's chapters are free names, `extra_deed` and `hunt` among the game's, and the block form of the trigger;
        // the bare forms of the struggle, regiment and catalyst effects; `county` in a situation catalyst; the hostility triggers and the rite's gender / doctrine triggers)
        ['effect', 'progress_activity_phase_after = { weeks = 8 }', 'activity', 'e.activity.next_phase', { duration: 'weeks = 8' }],
        ['effect', 'delay_travel_plan = { weeks = 1 }', 'travel_plan', 'e.travel.delay', { duration: 'weeks = 1' }],
        ['effect', 'add_destination_progress = { weeks = 2 }', 'travel_plan', 'e.travel.progress', { duration: 'weeks = 2' }],
        ['effect', 'set_legend_chapter = { name = extra_deed localization_key = legend_chapter_extra_deed_recent_siege }', 'legend', 'e.legend.chapter', { name: 'extra_deed', key: 'legend_chapter_extra_deed_recent_siege' }],
        ['trigger', 'has_legend_chapter = hunt', 'legend', 't.legend.chapter', { name: 'hunt' }],
        ['trigger', 'has_legend_chapter = { name = extra_deed localization_key = legend_chapter_extra_deed_recent_siege }', 'legend', 't.legend.chapter_text', { name: 'extra_deed', key: 'legend_chapter_extra_deed_recent_siege' }],
        ['trigger', 'has_legend_chapter = { name = extra_deed }', 'legend', 't.legend.chapter_text', { name: 'extra_deed' }],
        ['effect', 'change_struggle_phase = struggle_iberia_phase_hostility', 'struggle', 'e.struggle.phase_bare', { phase: 'struggle_iberia_phase_hostility' }],
        ['effect', 'change_struggle_phase = { struggle_phase = struggle_iberia_phase_hostility }', 'struggle', 'e.struggle.phase', { phase: 'struggle_iberia_phase_hostility' }],
        ['effect', 'activate_struggle_catalyst = catalyst_passing_of_time', 'struggle', 'e.struggle.catalyst_bare', { catalyst: 'catalyst_passing_of_time' }],
        ['effect', 'change_maa_regiment_size = -1', 'regiment', 'e.regiment.size_bare', { size: '-1' }],
        ['effect', 'change_maa_regiment_size = { size = 1 reinforce = yes }', 'regiment', 'e.regiment.size', { size: '1' }],
        ['effect', 'change_maa_troops_count = maa_max_troops_count', 'regiment', 'e.regiment.troops_change', { value: 'maa_max_troops_count' }],
        ['effect', 'trigger_situation_catalyst = { catalyst = catalyst_silk_road_raided county = scope:county_temp character = scope:raider }', 'situation', 'e.situation.catalyst_by', { catalyst: 'catalyst_silk_road_raided', county: 'scope:county_temp', character: 'scope:raider' }],
        ['trigger', 'rite_hostility_level = { target = scope:recipient.rite value <= faith_astray_level }', 'rite', 't.rite.hostility', { target: 'scope:recipient.rite', cmp: '<=', value: 'faith_astray_level' }],
        ['trigger', 'faith_hostility_level = { target = scope:host.faith value >= faith_hostile_level }', 'faith', 't.faith.hostility', { target: 'scope:host.faith', cmp: '>=', value: 'faith_hostile_level' }],
        ['trigger', 'rite_has_dominant_ruling_gender = prev', 'rite', 't.rite.ruling_gender', { who: 'prev' }],
        ['trigger', 'rite_has_allowed_gender_for_clergy = scope:recipient', 'rite', 't.rite.clergy_gender', { who: 'scope:recipient' }],
        ['trigger', 'rite_can_choose_doctrine = doctrine:doctrine_theocracy_temporal', 'rite', 't.rite.choose_doctrine', { doctrine: 'doctrine:doctrine_theocracy_temporal' }],
        ['trigger', 'can_convert_to_rite = yes', 'rite', 't.rite.convertible', { on: 'yes' }]
    ];

    for (const [kind, text, scope, id, values] of reads)
    {
        const f = findStatement(kind as 'effect' | 'trigger', text, scope);

        if (f?.def.id !== id || f.rest?.length || Object.entries(values).some(([k, v]) => f.values[k] !== v))
            fail(`${text} read as ${JSON.stringify(f && { id: f.def.id, values: f.values, rest: f.rest?.length })}`);
    }

    // a mod's extra field (`phase`) on a guest-group statement is kept, not lost
    const guest = findStatement('effect', 'add_to_guest_subset = { name = winner target = prev phase = tournament_phase_joust }', 'activity');

    if (guest?.def.id !== 'e.activity.add_guest' || guest.rest?.length !== 1)
        fail(`add_to_guest_subset with a phase: ${JSON.stringify(guest && { id: guest.def.id, rest: guest.rest?.length })}`);

    // each scope type of the 1.20.1 audit has statements of its own (its menu is more than "Other…"), and no id is used twice
    const ids = new Set<string>();

    for (const d of STATEMENTS)
    {
        if (ids.has(d.id))
            fail(`statement id ${d.id} is used twice`);

        ids.add(d.id);
    }

    for (const t of ['rite', 'activity', 'travel_plan', 'struggle', 'situation', 'sub_region', 'participant_group', 'faction', 'holy_order', 'domicile', 'story', 'epidemic', 'great_holy_war', 'task_contract', 'legend', 'inspiration', 'accolade', 'army', 'regiment', 'memory', 'great_project', 'confederation'] as ScopeType[])
        if (!statementsFor('effect', t).length && !statementsFor('trigger', t).length)
            fail(`no statements for ${t}`);

    // the scope names the menus build their sentences from are all texts for translation (a bare literal stays English in every language)
    const labels = /export const SCOPE_LABELS[^{]*\{([^}]*)\}/.exec(readFileSync(new URL('../src/shared/scriptCatalog.ts', import.meta.url), 'utf8'))?.[1] ?? '';
    const bare = labels.split(/\r?\n/).filter((l) => /^\s*\w+:/.test(l) && !/:\s*tr\('[^']*'\),?\s*$/.test(l));

    if (!labels || bare.length)
        fail(`SCOPE_LABELS has labels outside tr(): ${bare.join(' | ').trim()}`);

    // every scope type is reached by a link or a list, and the links the audit added are there
    for (const k of ['faction_target', 'side_commander', 'scheme_target_title', 'obedience_target', 'diarchy_successor', 'task_contract_target', 'combat_attacker'])
        if (!LINKS.some((l) => l.key === k))
            fail(`link ${k} is missing`);

    if (!LINKS.some((l) => l.key === 'religion' && l.from.includes('character') && l.from.includes('province')))
        fail('the religion link is not offered from a character and a province');

    if (SCOPE_TYPES.length < 53)
        fail(`only ${SCOPE_TYPES.length} scope types`);

    console.log(`statements and field sets of 1.20: ${wrong ? wrong + ' wrong' : 'ok'}`);
    bad += wrong;
}

// ---------------------------------------------------------------------------
// The key scan's rescan (an incremental index update): an editable mod's files changed, added, removed
// ---------------------------------------------------------------------------

{
    const tmp = mkdtempSync(join(tmpdir(), 'ckp-keys-'));
    const root = join(tmp, 'keys_test');
    const write = (rel: string, text: string): void =>
    {
        mkdirSync(join(root, rel, '..'), { recursive: true });
        writeFileSync(join(root, rel), text);
    };
    const EV = 'events/keys_test_events.txt';
    const SE = 'common/scripted_effects/keys_test_effects.txt';
    write(EV, 'namespace = keys_test\nkeys_test.1 = {\n\timmediate = {\n\t\tkeys_test_first_effect = yes\n\t\tadd_gold = 7\n\t}\n}\n');
    const mod: ModInfo = { id: 'mod/keys_test.mod', name: 'Keys Test', tags: [], root, source: 'local', replacePaths: [], status: 'ok', editable: true };
    const own = (files: GameFiles) => (g: GameFile): boolean => g.source > 0 && files.sources[g.source]?.modId === mod.id;
    /** what a full scan of the files as they are now gives: count and shapes per key */
    const full = (): ScriptKeys =>
    {
        const files = new GameFiles(gameDir!, [mod]);
        return new ScriptKeyScanner().scan(files, undefined, own(files));
    };
    const sig = (k: ScriptKeys): string =>
        (['effect', 'trigger'] as const).map((kind) =>
            k[kind]
                .map((x) => `${x.key}:${x.count}:${JSON.stringify(Object.entries(x.shapes).sort())}`)
                .sort()
                .join('\n')
        ).join('\n--\n');
    const files = new GameFiles(gameDir, [mod]);
    const scanner = new ScriptKeyScanner();
    let t = performance.now();
    const first = scanner.scan(files, undefined, own(files));
    const ms0 = Math.round(performance.now() - t);
    let problems = 0;
    const has = (k: ScriptKeys, kind: 'effect' | 'trigger', key: string): boolean => k[kind].some((x) => x.key === key);

    if (!has(first, 'effect', 'keys_test_first_effect'))
        (console.log("RESCAN: the mod's key is missing after the first scan"), problems++);

    // a changed file, a new file (a scripted effect with a condition), then the first file removed
    const steps: [string, () => string[], (k: ScriptKeys) => boolean][] = [
        ['changed', () => (write(EV, 'namespace = keys_test\nkeys_test.1 = {\n\timmediate = {\n\t\tkeys_test_second_effect = 3\n\t\tadd_gold = 8\n\t}\n}\n'), [EV]), (k) => has(k, 'effect', 'keys_test_second_effect') && !has(k, 'effect', 'keys_test_first_effect')],
        ['added', () => (write(SE, 'keys_test_effect = {\n\tif = {\n\t\tlimit = { keys_test_condition = yes }\n\t\tadd_prestige = 5\n\t}\n}\n'), [SE]), (k) => has(k, 'trigger', 'keys_test_condition')],
        ['removed', () => (unlinkSync(join(root, EV)), [EV]), (k) => !has(k, 'effect', 'keys_test_second_effect')]
    ];

    for (const [what, change, ok] of steps)
    {
        const rels = change();
        t = performance.now();
        const done = scanner.rescan(files, rels);
        const got = scanner.keys();
        const ms = Math.round(performance.now() - t);
        const want = full();

        if (!done || !ok(got) || sig(got) !== sig(want))
            (console.log(`RESCAN (${what}): ${!done ? 'refused' : !ok(got) ? 'the change is not in the keys' : 'differs from a full scan'}`), problems++);
        else
            console.log(`rescan (${what}): ${ms} ms, same as a full scan`);
    }

    // a vanilla file's path: only a full scan takes it in
    if (scanner.rescan(files, ['common/traits/00_traits.txt']))
        (console.log('RESCAN: a summed-up file was taken in without a full scan'), problems++);

    files.close();
    rmSync(tmp, { recursive: true, force: true });
    console.log(`rescan: ${problems ? problems + ' problems' : 'ok'} (first scan ${ms0} ms)`);
}

// ---------------------------------------------------------------------------
// The menus (picker/model.ts): paths of rows chosen by their labels, and the script they build
// ---------------------------------------------------------------------------

{
    const entry = (name: string, refs = 1, display?: string): RefEntry => ({ name, refs, display });
    const LISTS: Record<string, RefEntry[]> = {
        traits: [entry('brave', 90, 'Brave'), entry('craven', 80, 'Craven'), entry('shy', 70, 'Shy')],
        opinion_modifiers: [entry('respect_opinion', 50, 'Respect')],
        scripted_relations: [entry('friend', 40, 'Friend'), entry('rival', 30, 'Rival')],
        secret_types: [entry('secret_lover', 10, 'Lover')],
        modifiers: [entry('my_modifier', 5)],
        events: [entry('my_events.1', 3)],
        // (1.20: a rite, its doctrines and tenets; the catalysts of a struggle)
        'religion/doctrine_types': [entry('doctrine_gender_equal', 30, 'Gender equal')],
        'religion/tenet_types': [entry('tenet_pacifism', 20, 'Pacifism')],
        'religion/rite_types': [entry('hanafi', 9, 'Hanafi')],
        'struggle/catalysts': [entry('catalyst_passing_of_time', 4, 'Passing of time')]
    };
    // (stat modifiers and where the game puts them)
    const MODS: ModifierKeyInfo[] = [
        { key: 'diplomacy', label: 'Diplomacy', percent: false, color: 'good', count: 90, kinds: { character: 90 } },
        { key: 'tax_mult', label: 'Tax', percent: true, color: 'good', count: 40, kinds: { landed_title: 30, province: 20, character: 1 } },
        { key: 'fort_level', label: 'Fort level', percent: false, color: 'good', count: 20, kinds: { province: 20 } },
        // (the game's area files: a scheme's and an army's own; one of the general file a scheme block uses too)
        { key: 'scheme_power', label: 'Scheme power', percent: false, color: 'good', count: 12, kinds: { scheme: 12 }, area: 'scheme' },
        { key: 'raid_speed', label: 'Raid speed', percent: true, color: 'good', count: 3, kinds: { army: 3 }, area: 'unit' },
        { key: 'travel_speed', label: 'Travel speed', percent: false, color: 'good', count: 17, kinds: { travel_plan: 17 }, area: 'travel' },
        { key: 'monthly_prestige', label: 'Monthly prestige', percent: false, color: 'good', count: 30, kinds: { character: 30, scheme: 1 } }
    ];
    const data: PickerData = {
        list: (t) => LISTS[t] ?? [],
        loaded: async () => undefined,
        big: (t) => t === 'characters',
        search: async () => [],
        keys: (k) => scan[k],
        keysLoaded: async () => undefined,
        modifiers: () => MODS,
        modifiersLoaded: async () => undefined,
        // (the values the game writes for a key, the keys a type writes)
        suggestions: (source) =>
            source === 'values:buildings:construction_time'
                ? [{ value: 'slow_construction_time', count: 397, label: '397×' }, { value: '730', count: 4, label: '4×' }]
                : source === 'keys:buildings'
                ? [{ value: 'construction_time', count: 963, label: '963×' }, { value: 'ai_value', count: 12, label: '12×' }]
                : [],
        suggestionsLoaded: async () => undefined,
        activeMod: () => undefined,
        locCodes: () => undefined,
        locCodesLoaded: async () => undefined
    };
    type Step = string | { n: number; } | { input: string; };
    /** a row by its label (exactly, else the first starting with it), a typed number, or the typed text's row */
    const choose = (s: State, p: Step): Next =>
    {
        const m = menuOf(s, data);
        const item: Item | null | undefined = typeof p === 'string'
            ? (m.items.find((i) => i.label === p) ?? m.items.find((i) => i.label.startsWith(p)))
            : 'n' in p
            ? m.number?.(p.n, String(p.n))[0]
            : m.input?.(p.input);

        if (!item?.go)
            throw new Error(`no row ${JSON.stringify(p)} in “${m.title}”: ${m.items.map((i) => i.label).join(' | ')}`);

        return item.go();
    };
    const run = (req: Req, path: Step[]): string =>
    {
        const starts = startStates(req.kind, scopeOf(req.scope), undefined, req.type, req.edit, undefined, undefined, undefined, undefined, { modScope: req.kind === 'modifier' && req.scope ? scopeOf(req.scope) : undefined, elseAfter: req.elseAfter });
        // (a menu further up taking the result (a block's field) is the model's `back`: the state goes on the same)
        let s = starts[starts.length - 1].state;

        for (const p of path)
        {
            const n = choose(s, p);

            if ('finish' in n)
                return resultText(n.state ?? s);

            s = n.state;
        }

        return resultText(s);
    };
    // (the effect root: "Effect on…" first, then the type)
    const ON = 'Effect on…';
    const E = 'Effect on character…';
    const T = 'You (self) are…';
    type Req = { kind: 'effect' | 'trigger' | 'modifier' | 'field'; edit?: string; scope?: string; type?: string; elseAfter?: boolean; };
    const gold = [ON, E, 'You (self)', 'Add…', 'Gold', { n: 100 }];
    const prestige = [ON, E, 'You (self)', 'Add…', 'Prestige', { n: 50 }];
    const scenarios: [string, Req, Step[], string][] = [
        // settings: a trait's opposites (values alone), compatibility (any trait, a number), track levels; a type's own
        // settings with the named values the game writes; "Other setting…"
        ['Trait: an opposite', { kind: 'field', type: 'trait_opposites' }, ['Craven', 'Done'], 'craven'],
        // a formula's blocks: an if kept, an if without its conditions, a weight's modifier changed field by field
        ['Formula: keep an if', { kind: 'field', type: 'script_value', edit: 'if = {\n\tlimit = { is_adult = yes }\n\tadd = 5\n}' }, ['Keep it as it is'], 'if = {\n\tlimit = { is_adult = yes }\n\tadd = 5\n}'],
        ['Formula: an if made unconditional', { kind: 'field', type: 'script_value', edit: 'if = {\n\tlimit = { is_adult = yes }\n\tadd = 5\n}' }, ['Always — without its conditions', 'Done'], 'add = 5'],
        ['Cost: an if made unconditional', { kind: 'field', type: 'cost', edit: 'if = {\n\tlimit = { is_adult = yes }\n\tgold = 50\n}' }, ['Always — without its conditions', 'Done'], 'gold = 50'],
        // a religion's virtues and sins: a trait, a trait with a scale; changing one
        ['Religion: a virtue', { kind: 'field', type: 'religion_virtues' }, ['Trait…', 'Brave', 'Done'], 'brave'],
        ['Religion: a virtue with a scale', { kind: 'field', type: 'religion_virtues' }, ['Trait with a scale…', 'Brave', { n: 2 }, 'Done'], 'brave = 2'],
        ['Religion: change a sin', { kind: 'field', type: 'religion_virtues', edit: 'craven' }, ['Shy', 'Done'], 'shy'],
        ['Trait: change an opposite', { kind: 'field', type: 'trait_opposites', edit: 'craven' }, ['Shy', 'Done'], 'shy'],
        ['Trait: a compatibility', { kind: 'field', type: 'trait_compatibility' }, ['Brave', { n: 15 }, 'Done'], 'brave = 15'],
        ['Trait: change a compatibility', { kind: 'field', type: 'trait_compatibility', edit: 'brave = @pos_compat_high' }, ['-30', 'Done'], 'brave = -30'],
        ['Trait: a track level', { kind: 'field', type: 'trait_track' }, ['50', 'Done'], '50 = { }'],
        ['Building: construction time by its named value', { kind: 'field', type: 'buildings' }, ['Construction time (days)', 'Slow construction time', 'Done'], 'construction_time = slow_construction_time'],
        ['Building: another setting', { kind: 'field', type: 'buildings' }, ['Other setting…', 'ai_value', { input: '5' }, 'Done'], 'ai_value = 5'],
        // a doctrine's parameters: a bare name (1.20's form) kept, turned off; a written `= yes` made bare; a new one bare
        ['Doctrine: keep a bare parameter', { kind: 'field', type: 'doctrine_parameters', edit: 'doctrine_polygamy' }, ['Keep: on (written bare)', 'Done'], 'doctrine_polygamy'],
        ['Doctrine: a bare parameter off', { kind: 'field', type: 'doctrine_parameters', edit: 'doctrine_polygamy' }, ['No', 'Done'], 'doctrine_polygamy = no'],
        ['Doctrine: a parameter = yes written bare', { kind: 'field', type: 'doctrine_parameters', edit: 'doctrine_polygamy = yes' }, ['On', 'Done'], 'doctrine_polygamy'],
        ['Doctrine: a new parameter', { kind: 'field', type: 'doctrine_parameters' }, [{ input: 'd1_new_flag' }, 'On', 'Done'], 'd1_new_flag'],
        // a doctrine's hostility (special_parameters): a level, an override by doctrine (written, new), the head of faith's
        ['Hostility: a level changed', { kind: 'field', type: 'hostility_levels', edit: 'same_family = hostile' }, ['Evil', 'Done'], 'same_family = evil'],
        ['Hostility: a level added', { kind: 'field', type: 'hostility_levels' }, ['Faiths of other families…', 'Astray', 'Done'], 'unrelated = astray'],
        ['Hostility: an override changed', { kind: 'field', type: 'hostility_level_override', edit: 'muhammad_succession_sunni_doctrine = astray' }, ['Hostile', 'Done'], 'muhammad_succession_sunni_doctrine = hostile'],
        ['Hostility: a new override', { kind: 'field', type: 'hostility_level_override' }, [{ input: 'd1_doctrine' }, 'Evil', 'Done'], 'd1_doctrine = evil'],
        ['Hostility: a tenet from the list', { kind: 'field', type: 'hostility_level_override' }, ['Pacifism', 'Hostile', 'Done'], 'tenet_pacifism = hostile'],
        ['Hostility: a doctrine from the same list', { kind: 'field', type: 'hostility_level_override' }, ['Gender equal', 'Astray', 'Done'], 'doctrine_gender_equal = astray'],
        ['Hostility: head of faith', { kind: 'field', type: 'special_parameters', edit: 'same_hof_hostility_override = righteous' }, ['Astray', 'Done'], 'same_hof_hostility_override = astray'],
        ['Character: female', { kind: 'field', type: 'characters' }, ['Female', 'Done'], 'female = yes'],
        ['Character: a name with a space, quoted', { kind: 'field', type: 'characters' }, ['Name…', { input: 'Abu Abdallah' }, 'Done'], 'name = "Abu Abdallah"'],
        ['Character: a name with other letters, quoted', { kind: 'field', type: 'characters' }, ['Name…', { input: 'Þórir' }, 'Done'], 'name = "Þórir"'],
        ['Character: change a written name', { kind: 'field', type: 'characters', edit: 'name = "Harald"' }, [{ input: 'Guðrøðr' }, 'Done'], 'name = "Guðrøðr"'],
        ['Character: change the faith', { kind: 'field', type: 'characters', edit: 'religion = catholic' }, [{ input: 'orthodox' }, 'Done'], 'religion = orthodox'],
        // modifiers: a county's block offers the county modifiers; every one is still reachable
        ['County modifiers', { kind: 'modifier', scope: 'landed_title' }, ['All county modifiers…', 'Tax %', { n: 10 }, 'Done'], 'tax_mult = 0.1'],
        ['County block: diplomacy only under Every modifier', { kind: 'modifier', scope: 'landed_title' }, ['Every modifier…', 'Diplomacy', { n: 2 }, 'Done'], 'diplomacy = 2'],
        ['Province modifiers', { kind: 'modifier', scope: 'province' }, ['All province modifiers…', 'Fort level', { n: 1 }, 'Done'], 'fort_level = 1'],
        // a scheme's and an army's blocks have lists of their own; the game's area files are groups of their own
        ['Scheme modifiers', { kind: 'modifier', scope: 'scheme' }, ['All scheme modifiers…', 'Scheme power', { n: 5 }, 'Done'], 'scheme_power = 5'],
        ['Scheme modifiers: the Schemes area', { kind: 'modifier', scope: 'scheme' }, ['Schemes…', 'Scheme power', { n: 5 }, 'Done'], 'scheme_power = 5'],
        ['Travel plan modifiers (a travel option travel_modifier block)', { kind: 'modifier', scope: 'travel_plan' }, ['All travel plan modifiers…', 'Travel speed', { n: 5 }, 'Done'], 'travel_speed = 5'],
        ['Army modifiers: the Units area', { kind: 'modifier', scope: 'army' }, ['Units…', 'Raid speed %', { n: 10 }, 'Done'], 'raid_speed = 0.1'],
        ['When… on the last one only', { kind: 'effect' }, [...gold, 'And also…', ...prestige, 'When…', 'Only the last', T, 'Adult', 'Done'], 'add_gold = 100\nif = {\n\tlimit = { is_adult = yes }\n\tadd_prestige = 50\n}'],
        ['When… on everything', { kind: 'effect' }, [...gold, 'And also…', ...prestige, 'When…', 'Everything here', T, 'Adult', 'Done'], 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n\tadd_prestige = 50\n}'],
        ['Otherwise…', { kind: 'effect' }, [...gold, 'When…', T, 'Adult', 'Back to the effects', 'Otherwise…', ...prestige, 'Done'], 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n}\nelse = { add_prestige = 50 }'],
        ['Otherwise, when…', { kind: 'effect' }, [...gold, 'When…', T, 'Adult', 'Back to the effects', 'Otherwise, when…', T, 'Male', 'Then…', ...prestige, 'Done'], 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n}\nelse_if = {\n\tlimit = { is_male = yes }\n\tadd_prestige = 50\n}'],
        ['Random list', { kind: 'effect' }, [...gold, 'One of several outcomes…', 'Weight 75', 'Another outcome…', 'Weight 25', ...prestige, 'Done'], 'random_list = {\n\t75 = { add_gold = 100 }\n\t25 = { add_prestige = 50 }\n}'],
        // the effect root's "If, chance, outcomes…": the condition, chance or weight first, then the effects inside it
        ['Root: When… first, then the effects', { kind: 'effect' }, ['If, chance, outcomes…', 'When…', T, 'Adult', 'Then…', ...gold, 'Done'], 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n}'],
        ['Root: When…, then Otherwise…', { kind: 'effect' }, ['If, chance, outcomes…', 'When…', T, 'Adult', 'Then…', ...gold, 'Back out', 'Otherwise…', ...prestige, 'Done'], 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n}\nelse = { add_prestige = 50 }'],
        ['Root: Chance…', { kind: 'effect' }, ['If, chance, outcomes…', 'Chance…', '25%', ...gold, 'Done'], 'random = { chance = 25 add_gold = 100 }'],
        ['Root: outcomes', { kind: 'effect' }, ['If, chance, outcomes…', 'One of several outcomes…', 'Weight 75', ...gold, 'Back out', 'Another outcome…', 'Weight 25', ...prestige, 'Done'], 'random_list = {\n\t75 = { add_gold = 100 }\n\t25 = { add_prestige = 50 }\n}'],
        ['Root: hidden', { kind: 'effect' }, ['If, chance, outcomes…', 'Hidden (no tooltip)…', ...gold, 'Done'], 'hidden_effect = { add_gold = 100 }'],
        // "Other effect…" › if / random_list: the same steps, not a value step with whole blocks of the game's script
        ['Other effect: if', { kind: 'effect' }, ['Other effect…', 'if', T, 'Adult', 'Then…', ...gold, 'Done'], 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 100\n}'],
        ['Other effect: random_list', { kind: 'effect' }, ['Other effect…', 'random_list', 'Weight 50', ...gold, 'Done'], 'random_list = {\n\t50 = { add_gold = 100 }\n}'],
        // a text key's value: "Write a new text…" (the text typed, a key of the shown entry; here none is shown: new_text)
        ['Other effect: custom_tooltip, a new text', { kind: 'effect' }, ['Other effect…', 'custom_tooltip', 'Write a new text…', { input: 'You feel braver' }, 'Done'], 'custom_tooltip = new_text_tt'],
        ['Decision: a new tooltip text', { kind: 'field', type: 'decisions' }, ['Tooltip in the list…', 'Write a new text…', { input: 'Only for the brave' }, 'Done'], 'selection_tooltip = new_text_tooltip'],
        // a character template: a random trait list (how many, then each trait with its weight), its origin and skills
        ['Template: a random trait list', { kind: 'field', type: 'scripted_character_templates' }, ['Traits at random from a list…', { n: 1 }, 'A trait…', 'Brave', { n: 10 }, 'A trait…', 'Craven', { n: 5 }, 'Done', 'Done'], 'random_traits_list = {\n\tcount = 1\n\tbrave = {\n\t\tweight = { base = 10 }\n\t}\n\tcraven = {\n\t\tweight = { base = 5 }\n\t}\n}'],
        ['Template: a trait into a written list', { kind: 'field', type: 'random_traits_list' }, ['A trait…', 'Brave', { n: 20 }, 'Done'], 'brave = {\n\tweight = { base = 20 }\n}'],
        ['Template: a skill', { kind: 'field', type: 'scripted_character_templates' }, ['Stewardship…', { n: 12 }, 'Done'], 'stewardship = 12'],
        ['Template: a culture', { kind: 'field', type: 'scripted_character_templates' }, ['Culture…', { input: 'norse' }, 'Done'], 'culture = norse'],
        [
            'Switch',
            { kind: 'effect' },
            [...gold, 'Depending on…', 'Trait (has)', 'Brave', ...prestige, 'Back out', 'Another case…', 'Craven', ON, E, 'You (self)', 'Add…', 'Stress', { n: 10 }, 'Back out', 'In no case (fallback)…', ON, E, 'You (self)', 'Add…', 'Piety', { n: 5 }, 'Done'],
            'add_gold = 100\nswitch = {\n\ttrigger = has_trait\n\tbrave = { add_prestige = 50 }\n\tcraven = { add_stress = 10 }\n\tfallback = { add_piety = 5 }\n}'
        ],
        ['Chance on a part', { kind: 'effect' }, [...gold, 'And also…', ...prestige, 'Chance…', 'Only the last', '50%', 'Done'], 'add_gold = 100\nrandom = { chance = 50 add_prestige = 50 }'],
        ['Only when (trigger_if)', { kind: 'trigger' }, [T, 'Adult', 'Only when…', T, 'Male', 'Done'], 'trigger_if = {\n\tlimit = { is_male = yes }\n\tis_adult = yes\n}'],
        ['Only when, otherwise', { kind: 'trigger' }, [T, 'Adult', 'Only when…', T, 'Male', 'Back out', 'Otherwise…', T, 'AI', 'Done'], 'trigger_if = {\n\tlimit = { is_male = yes }\n\tis_adult = yes\n}\ntrigger_else = { is_ai = yes }'],
        ['At least some (calc_true_if)', { kind: 'trigger' }, [T, 'Adult', 'And also…', T, 'Male', 'And also…', T, 'AI', 'At least some of these…', 'Everything here', 'At least 2 of the 3', 'Done'], 'calc_true_if = { amount >= 2 is_adult = yes is_male = yes is_ai = yes }'],
        ['Every relation of a type', { kind: 'effect' }, [ON, E, 'Every…', 'Every relation…', 'Friend', 'Add…', 'Prestige', { n: 10 }, 'Done'], 'every_relation = { type = friend add_prestige = 10 }'],
        ['Any relation, how many', { kind: 'trigger' }, ['Any of their…', 'Any relation…', 'Rival', 'Adult', 'How many of them…', 'At least 2', 'Done'], 'any_relation = { type = rival count >= 2 is_adult = yes }'],
        ['Any child, all of them', { kind: 'trigger' }, ['Any of their…', 'Any child', 'Adult', 'How many of them…', 'All of them', 'Done'], 'any_child = { count = all is_adult = yes }'],
        // (lists that need a key inside: a pool character's province, a region's counties, an activity's guest group, asked when the list is chosen)
        ['A pool character, its province', { kind: 'effect' }, [ON, E, 'Every…', 'Every pool character…', 'Root’s location', 'Add…', 'Prestige', { n: 10 }, 'Done'], 'every_pool_character = { province = root.location add_prestige = 10 }'],
        ['A pool character, a province by link', { kind: 'trigger' }, ['Any of their…', 'Any pool character…', 'Your capital province', 'Adult', 'Done'], 'any_pool_character = { province = capital_province is_adult = yes }'],
        ['The counties of a region', { kind: 'trigger' }, ['Any of their…', 'Any region county…', { input: 'world_africa' }, 'Coastal county', 'Done'], 'any_county_in_region = { region = world_africa is_coastal_county = yes }'],
        ['An activity’s guests of a group', { kind: 'trigger', scope: 'activity' }, ['Any of their…', 'Any subset guest…', { input: 'supporter' }, 'Adult', 'Done'], 'any_guest_subset = { name = supporter is_adult = yes }'],
        // (1.20 and the scope types of their own: statements run in a rite, an activity, a journey …, a menu that offered only "Other…" before)
        ['A rite’s doctrine', { kind: 'trigger', scope: 'rite' }, ['You (self) are…', 'Doctrine', 'Gender equal'], 'rite_has_doctrine = doctrine_gender_equal'],
        ['A rite’s tenet and its status', { kind: 'trigger', scope: 'rite' }, ['You (self) are…', 'Tenet status', 'Pacifism', 'Core'], 'has_tenet_status = { tenet = tenet_pacifism status = core }'],
        ['A character’s rite', { kind: 'effect' }, [ON, E, 'You (self)', 'Set / change…', 'Rite', 'Hanafi'], 'set_character_rite = rite:hanafi'],
        ['A county’s rite', { kind: 'effect', scope: 'landed_title' }, [ON, 'Effect on title…', 'You (self)', 'Set / change…', 'Rite (county)', 'Hanafi'], 'set_county_rite = rite:hanafi'],
        ['An activity’s next phase', { kind: 'effect', scope: 'activity' }, [ON, 'Effect on activity…', 'You (self)', 'Move to the next phase after…', '3 days'], 'progress_activity_phase_after = { days = 3 }'],
        ['An activity’s next phase in weeks', { kind: 'effect', scope: 'activity' }, [ON, 'Effect on activity…', 'You (self)', 'Move to the next phase after…', '8 weeks'], 'progress_activity_phase_after = { weeks = 8 }'],
        ['A rite’s hostility to the recipient’s', { kind: 'trigger', scope: 'rite' }, ['You (self) are…', 'Hostility to another rite', 'Recipient’s rite', 'At most', 'Faith astray level'], 'rite_hostility_level = { target = scope:recipient.rite value <= faith_astray_level }'],
        ['A journey is paused', { kind: 'trigger', scope: 'travel_plan' }, ['You (self) are…', 'Paused', 'Yes'], 'is_paused = yes'],
        ['Takes part in an activity', { kind: 'trigger' }, [T, 'More…', 'Takes part in an activity', 'Your activity they are in'], 'is_participant_in_activity = involved_activity'],
        ['A struggle’s catalyst', { kind: 'effect', scope: 'struggle' }, [ON, 'Effect on struggle…', 'You (self)', 'Activate a catalyst', 'Passing of time', 'Root'], 'activate_struggle_catalyst = { catalyst = catalyst_passing_of_time character = root }'],
        ['A court position holder, any position', { kind: 'effect' }, [ON, E, 'A random…', 'A random court position holder…', 'Any court position', 'Add…', 'Prestige', { n: 5 }, 'Done'], 'random_court_position_holder = { add_prestige = 5 }'],
        ['Change: a pool character’s province', { kind: 'trigger', edit: 'any_pool_character = { province = root.location is_adult = yes }' }, ['In which province', 'Your capital province', 'Done'], 'any_pool_character = { province = capital_province is_adult = yes }'],
        ['Change: a child to a pool character asks the province', { kind: 'effect', edit: 'every_child = { add_gold = 5 }' }, ['Another list…', 'Every pool character', 'Root’s capital province', 'Done'], 'every_pool_character = { province = root.capital_province add_gold = 5 }'],
        ['The child with the highest age', { kind: 'effect' }, [ON, E, 'The one with the highest…', 'The child with the highest…', 'Highest age', 'Add…', 'Prestige', { n: 10 }, 'Done'], 'ordered_child = { order_by = age add_prestige = 10 }'],
        ['Only those who (a typed relation)', { kind: 'effect' }, [ON, E, 'A random…', 'A random relation…', 'Friend', 'Add…', 'Gold', { n: 5 }, 'Only those who…', 'A random friend is…', 'Adult', 'Done'], 'random_relation = {\n\ttype = friend\n\tlimit = { is_adult = yes }\n\tadd_gold = 5\n}'],
        ['Relation with a reason', { kind: 'effect' }, [ON, E, 'You (self)', 'Set / change…', 'Relation…', 'Friend', 'Root', { input: 'friend_saved_my_life' }, 'Done'], 'set_relation_friend = { target = root reason = friend_saved_my_life }'],
        ['Relation without a reason', { kind: 'effect' }, [ON, E, 'You (self)', 'Set / change…', 'Relation…', 'Rival', 'Root', 'No reason given', 'Done'], 'set_relation_rival = root'],
        // changing written statements
        ['Change: an opinion with years', { kind: 'effect', edit: 'add_opinion = { target = root modifier = respect_opinion opinion = 30 years = 5 }' }, ['Keep', 'Keep', 'Keep', '10 years', 'Done'], 'add_opinion = { target = root modifier = respect_opinion opinion = 30 years = 10 }'],
        ['Change: an opinion without a value', { kind: 'effect', edit: 'add_opinion = { modifier = respect_opinion target = liege }' }, ['Keep', 'Root', 'Keep', 'Keep', 'Done'], 'add_opinion = { target = root modifier = respect_opinion }'],
        ['Change: other fields kept', { kind: 'effect', edit: 'add_character_modifier = { modifier = my_modifier years = 5 desc = my_desc }' }, ['Keep', '2 years', 'Done'], 'add_character_modifier = { modifier = my_modifier years = 2 desc = my_desc }'],
        // (a typed number takes the unit the statement writes: the first row, so ⏎ keeps years / months, not days)
        ['Change: a typed duration keeps years', { kind: 'effect', edit: 'add_character_modifier = { modifier = my_modifier years = 5 desc = my_desc }' }, ['Keep', { n: 3 }, 'Done'], 'add_character_modifier = { modifier = my_modifier years = 3 desc = my_desc }'],
        ['Change: a typed duration keeps months', { kind: 'effect', edit: 'add_character_modifier = { modifier = my_modifier months = 6 desc = my_desc }' }, ['Keep', { n: 3 }, 'Done'], 'add_character_modifier = { modifier = my_modifier months = 3 desc = my_desc }'],
        ['Change: a typed duration keeps days', { kind: 'effect', edit: 'add_character_modifier = { modifier = my_modifier days = 30 desc = my_desc }' }, ['Keep', { n: 3 }, 'Done'], 'add_character_modifier = { modifier = my_modifier days = 3 desc = my_desc }'],
        ['Change: a condition in NOT', { kind: 'trigger', edit: 'NOT = { has_trait = brave }' }, ['Craven', 'Done'], 'NOT = { has_trait = craven }'],
        ['Change: OR into NOR', { kind: 'trigger', edit: 'OR = { is_adult = yes is_male = yes }' }, ['None of these', 'Done'], 'NOR = { is_adult = yes is_male = yes }'],
        ['Change: an if, another condition', { kind: 'effect', edit: 'if = { limit = { is_adult = yes } add_gold = 5 }' }, ['Another condition…', T, 'Male', 'Done'], 'if = {\n\tlimit = { is_adult = yes is_male = yes }\n\tadd_gold = 5\n}'],
        // (if / else chains stay together: a part never starts at an else; a written chain's member is not wrapped)
        ['Chance on an if and its else', { kind: 'effect' }, [...gold, 'When…', T, 'Adult', 'Back to the effects', 'Otherwise…', ...prestige, 'Back out', 'Chance…', '50%', 'Done'], 'random = {\n\tchance = 50\n\tif = {\n\t\tlimit = { is_adult = yes }\n\t\tadd_gold = 100\n\t}\n\telse = { add_prestige = 50 }\n}'],
        [
            'When… from the if on (its else along)',
            { kind: 'effect' },
            [...prestige, 'And also…', ...gold, 'When…', 'Only the last', T, 'Adult', 'Back to the effects', 'Otherwise…', ...prestige, 'Back out', 'When…', 'From “if', T, 'Male', 'Done'],
            'add_prestige = 50\nif = {\n\tlimit = { is_male = yes }\n\tif = {\n\t\tlimit = { is_adult = yes }\n\t\tadd_gold = 100\n\t}\n\telse = { add_prestige = 50 }\n}'
        ],
        ['Change: an else, another effect inside', { kind: 'effect', edit: 'else = { add_gold = 5 }' }, ['Another effect inside…', ...gold, 'Done'], 'else = { add_gold = 5 add_gold = 100 }'],
        ['Change: an if, then otherwise', { kind: 'effect', edit: 'if = { limit = { is_adult = yes } add_gold = 5 }' }, ['What next…', 'Otherwise…', ON, E, 'You (self)', 'Add…', 'Gold', { n: 1 }, 'Done'], 'if = {\n\tlimit = { is_adult = yes }\n\tadd_gold = 5\n}\nelse = { add_gold = 1 }'],
        ['Change: an iterator, another list', { kind: 'effect', edit: 'every_child = { add_gold = 5 }' }, ['Another list…', 'Every vassal', 'Done'], 'every_vassal = { add_gold = 5 }'],
        // (conversions keep only what the new list / mode takes: its kind, its mode's parameters)
        ['Change: a relation list to children drops its kind', { kind: 'effect', edit: 'every_relation = { type = friend add_gold = 5 }' }, ['Another list…', 'Every child', 'Done'], 'every_child = { add_gold = 5 }'],
        ['Change: a random child with weight to every child', { kind: 'effect', edit: 'random_child = { weight = { base = 1 } add_gold = 5 }' }, ['Every / a random', 'Every child', 'Done'], 'every_child = { add_gold = 5 }'],
        ['Change: the highest child to a random one', { kind: 'effect', edit: 'ordered_child = { order_by = age max = 2 position = 1 add_gold = 5 }' }, ['Every / a random', 'A random child', 'Done'], 'random_child = { add_gold = 5 }'],
        ['Change: an iterator, a random one', { kind: 'effect', edit: 'every_child = { add_gold = 5 }' }, ['Every / a random', 'A random child', 'Done'], 'random_child = { add_gold = 5 }'],
        ['Change: a relation iterator, its kind', { kind: 'trigger', edit: 'any_relation = { type = friend is_adult = yes }' }, ['Which relation', 'Rival', 'How many of them…', 'All of them', 'Done'], 'any_relation = { type = rival count = all is_adult = yes }'],
        ['Change: a scope switch, someone else', { kind: 'effect', edit: 'liege = { add_gold = 5 }' }, ['Someone (something) else instead…', 'Your primary spouse', 'Done'], 'primary_spouse = { add_gold = 5 }'],
        ['Change: a chance', { kind: 'effect', edit: 'random = { chance = 50 add_gold = 5 }' }, ['Another chance', '25%', 'Done'], 'random = { chance = 25 add_gold = 5 }'],
        // iterator options (P7): a random one's weight and alternative_limit, the dead, an ordered one's position / max, the lowest
        ['Change: a random child, weighted', { kind: 'effect', edit: 'random_child = { add_gold = 5 }' }, ['Weighted by…', 'Add', { n: 10 }, 'Done'], 'random_child = {\n\tweight = { base = 1 add = 10 }\n\tadd_gold = 5\n}'],
        ['Change: a random child, weighted with a condition', { kind: 'effect', edit: 'random_child = { add_gold = 5 }' }, ['Weighted by…', 'Add', { n: 10 }, 'When…', 'A random child is…', 'Adult', 'Done'], 'random_child = {\n\tweight = {\n\t\tbase = 1\n\t\tmodifier = { add = 10 is_adult = yes }\n\t}\n\tadd_gold = 5\n}'],
        ['Change: a random child, if none fit', { kind: 'effect', edit: 'random_child = { add_gold = 5 }' }, ['If none fit…', 'A random child is…', 'Adult', 'Done'], 'random_child = {\n\talternative_limit = { is_adult = yes }\n\tadd_gold = 5\n}'],
        ['Change: a written weight is entered, not added again', { kind: 'effect', edit: 'random_child = { weight = { base = 2 } add_gold = 5 }' }, ['Weighted by…', 'Add', { n: 5 }, 'Done'], 'random_child = {\n\tweight = { base = 2 add = 5 }\n\tadd_gold = 5\n}'],
        ['Change: also the dead', { kind: 'effect', edit: 'random_child = { add_gold = 5 }' }, ['Also the dead', 'Done'], 'random_child = { even_if_dead = yes add_gold = 5 }'],
        ['Change: only the living again', { kind: 'effect', edit: 'every_child = { even_if_dead = yes add_gold = 5 }' }, ['Only the living', 'Done'], 'every_child = { add_gold = 5 }'],
        ['Change: an ordered one, the second', { kind: 'effect', edit: 'ordered_child = { order_by = age add_gold = 5 }' }, ['Which one of them…', 'The second', 'Done'], 'ordered_child = { position = 1 order_by = age add_gold = 5 }'],
        ['Change: an ordered one, up to 4 (typed)', { kind: 'effect', edit: 'ordered_child = { order_by = age add_gold = 5 }' }, ['Up to how many…', { n: 4 }, 'Done'], 'ordered_child = { max = 4 check_range_bounds = no order_by = age add_gold = 5 }'],
        ['Change: an ordered one, all of them again', { kind: 'effect', edit: 'ordered_child = { order_by = age max = 2 check_range_bounds = no position = 1 add_gold = 5 }' }, ['Up to how many…', 'All of them', 'Done'], 'ordered_child = { order_by = age position = 1 add_gold = 5 }'],
        ['Change: an ordered one, the lowest', { kind: 'effect', edit: 'ordered_child = { order_by = age add_gold = 5 }' }, ['Ordered by…', 'Lowest age', 'Done'], 'ordered_child = { order_by = { value = age multiply = -1 } add_gold = 5 }'],
        ['Change: an ordered one, the lowest of a typed value', { kind: 'effect', edit: 'ordered_child = { order_by = age add_gold = 5 }' }, ['Ordered by…', { input: 'lowest my_value' }, 'Done'], 'ordered_child = { order_by = { value = my_value multiply = -1 } add_gold = 5 }'],
        ['The child with the lowest age', { kind: 'effect' }, [ON, E, 'The one with the highest…', 'The child with the highest…', 'Lowest age', 'Add…', 'Prestige', { n: 10 }, 'Done'], 'ordered_child = {\n\torder_by = { value = age multiply = -1 }\n\tadd_prestige = 10\n}'],
        // a field that is a block opens as a block of its own (P3 stage C); its text goes back into the field
        ['Change: a nested block, one of its fields', { kind: 'effect', edit: 'create_character = { age = 16 inner = { x = 1 y = yes deep = { z = 3 } } gender = male }' }, ['inner', 'x', { input: '2' }, 'Done with inner', 'Done'], 'create_character = {\n\tage = 16\n\tinner = {\n\t\tx = 2\n\t\ty = yes\n\t\tdeep = { z = 3 }\n\t}\n\tgender = male\n}'],
        ['Change: a block two levels down, then a field beside it', { kind: 'effect', edit: 'create_character = { age = 16 inner = { x = 1 y = yes deep = { z = 3 } } gender = male }' }, ['inner', 'deep', 'z', { input: '9' }, 'Done with deep', 'Add a field…', { input: 'w' }, { input: '5' }, 'Done with inner', 'age', { input: '18' }, 'Done'], 'create_character = {\n\tage = 18\n\tinner = {\n\t\tx = 1\n\t\ty = yes\n\t\tdeep = { z = 9 }\n\t\tw = 5\n\t}\n\tgender = male\n}'],
        ['Change: a nested block, a field removed', { kind: 'effect', edit: 'create_character = { age = 16 inner = { x = 1 y = yes } gender = male }' }, ['inner', 'y', 'Remove this field', 'Done with inner', 'Done'], 'create_character = {\n\tage = 16\n\tinner = { x = 1 }\n\tgender = male\n}'],
        ['Change: a nested block as text (the old way)', { kind: 'effect', edit: 'create_character = { age = 16 inner = { x = 1 y = yes } gender = male }' }, ['inner as text', { input: '{ q = 1 }' }, 'Done'], 'create_character = {\n\tage = 16\n\tinner = { q = 1 }\n\tgender = male\n}'],
        ['Change: any block, field by field', { kind: 'effect', edit: 'create_character = { age = 16 gender = male }' }, ['age', { input: '18' }, 'Add a field…', { input: 'dynasty' }, { input: 'generate' }, 'Done'], 'create_character = { age = 18 gender = male dynasty = generate }'],
        ['A scripted effect, parameter by parameter', { kind: 'effect' }, ['Other effect…', 'had_sex_with_effect', { input: 'scope:lover' }, 'pregnancy_chance', 'Done'], 'had_sex_with_effect = { CHARACTER = scope:lover PREGNANCY_CHANCE = pregnancy_chance }']
    ];
    let bad = 0;

    for (const [name, req, path, want] of scenarios)
    {
        let got: string;

        try
        {
            got = run(req, path);
        }
        catch (e)
        {
            got = 'ERROR ' + (e as Error).message;
        }

        if (got !== want)
        {
            bad++;
            console.log(`MENUS ${name}:\n${got}\n  wanted:\n${want}`);
        }
    }

    // (typed chains: their type from the links and the saved scopes in reach; a warning where another type is wanted)
    {
        const s0 = startStates('effect', 'character')[0].state;
        const s: State = { ...s0, targets: [{ key: 'scope:my_title', label: 'My title', type: 'landed_title' }, { key: 'scope:friend', label: 'Friend' }] };
        const checks: [string, string | undefined, boolean][] = [
            ['scope:my_title.holder', 'character', false],
            ['scope:my_title', 'landed_title', false],
            ['liege.faith', 'faith', false],
            ['scope:friend.primary_title', 'landed_title', false],
            ['faith.liege', undefined, true],
            ['scope:unknown.liege', undefined, false],
            // (the two ways vanilla reaches a situation's sub-region and group, 64 and 618 uses; a domicile's rite and faith, 36 and 11)
            ['situation:dynastic_cycle.situation_top_sub_region', 'sub_region', false],
            ['situation:dynastic_cycle.situation_top_sub_region.situation_center_province', undefined, true],
            ['top_participant_group:dynastic_cycle', 'participant_group', false],
            ['domicile.domicile_rite', 'rite', false],
            ['domicile.domicile_faith', 'faith', false]
        ];

        for (const [expr, type, problem] of checks)
        {
            const c = chainType(s, expr, 'character');

            if (c.type !== type || !!c.problem !== problem)
                (console.log(`MENUS chain ${expr}: ${JSON.stringify(c)}`), bad++);
        }

        // a part the catalog does not know at all: unknown (a neutral note), not a problem; a known part stays checked
        {
            const sd: State = { ...s, targets: [...(s.targets ?? []), { key: 'scope:dom', label: 'Domicile', type: 'domicile' }] };
            const un: [string, string | undefined, string | undefined][] = [
                ['scope:friend.zzz_no_such_link', undefined, 'zzz_no_such_link'],
                ['liege.zzz_no_such_link.faith', undefined, 'zzz_no_such_link'],
                ['zzz_no_such_link', undefined, 'zzz_no_such_link'],
                ['zzz_nobody:abc.liege', undefined, 'zzz_nobody:abc'],
                ['scope:nobody_listed', undefined, 'scope:nobody_listed'],
                ['scope:dom.owner', 'character', undefined],
                ['prev', undefined, undefined],
                ['var:x.liege', undefined, undefined]
            ];

            for (const [expr, type, unknown] of un)
            {
                const c = chainType(sd, expr, 'character');

                if (c.type !== type || c.unknown !== unknown || c.problem)
                    (console.log(`MENUS chain unknown ${expr}: ${JSON.stringify(c)}`), bad++);
            }

            // free: the open scope is no part of the answer (the values the game wrote for a key, wherever the picker is open)
            const fr: [string, string | undefined][] = [
                ['court_owner', 'character'],
                ['primary_title', 'landed_title'],
                ['primary_title.holder', 'character'],
                ['scope:dom.owner', 'character'],
                ['root.faith', 'faith'],
                ['title:k_france', 'landed_title'],
                ['owner', 'character'],
                ['zzz_no_such_link', undefined]
            ];

            for (const [expr, type] of fr)
            {
                const a = chainType(sd, expr, 'landed_title', true);
                const b = chainType(sd, expr, 'faith', true);

                if (a.type !== type || b.type !== type || a.problem || b.problem)
                    (console.log(`MENUS chain free ${expr}: ${JSON.stringify(a)} / ${JSON.stringify(b)}`), bad++);
            }

            // (not free: `court_owner` is a link of a character only, so from a title it leads nowhere)
            if (!chainType(sd, 'court_owner', 'landed_title').problem)
                (console.log('MENUS chain court_owner from a title is no problem'), bad++);

            // valueScope: the values' type does not depend on the scope the picker is open in
            const info = (vals: string[]): ScriptKeyInfo => ({ key: 'k', count: 9, shapes: {}, values: vals.map((v) => [v, 3] as [string, number]) });
            const at = (scope: ScopeType): State => ({ ...startStates('effect', scope)[0].state });

            for (const scope of ['character', 'landed_title', 'faith'] as ScopeType[])
            {
                const v1 = valueScope(at(scope), info(['court_owner', 'player_heir']));
                const v2 = valueScope(at(scope), info(['primary_title', 'capital_county']));
                const v3 = valueScope(at(scope), info(['court_owner', 'primary_title']));

                if (v1 !== 'character' || v2 !== 'landed_title' || v3 !== undefined)
                    (console.log(`MENUS valueScope in ${scope}: ${v1} ${v2} ${v3}`), bad++);

                // (`root` in free mode is of unknown type: the open entry's root is not the one the values were written in)
                const v4 = valueScope({ ...at(scope), rootScope: 'landed_title' }, info(['root', 'liege']));

                if (v4 === 'landed_title')
                    (console.log(`MENUS valueScope root in ${scope}: ${v4}`), bad++);
            }
        }

        // "Also the dead" only on the lists vanilla writes even_if_dead in; "Weighted by…" keeps its "When…" row
        {
            for (const [edit, want] of [['every_child = { add_gold = 5 }', true], ['every_vassal = { add_gold = 5 }', false], ['every_living_character = { add_gold = 5 }', false], ['every_child = { even_if_dead = yes add_gold = 5 }', true]] as [string, boolean][])
            {
                const starts0 = startStates('effect', 'character', undefined, undefined, edit, undefined, undefined, undefined, undefined, {});
                const st0 = starts0[starts0.length - 1].state;
                const labels = menuOf(st0, data).items.map((i) => i.label);
                const has = labels.includes('Also the dead') || labels.includes('Only the living');

                if (has !== want)
                    (console.log(`MENUS dead row on ${edit}: ${labels.join(' | ')}`), bad++);
            }

        }

        // the describer reads the order turned round as "lowest" (value times -1, or taken from zero), nothing else
        {
            const stub = new Proxy({}, { get: (_t, p) => (p === 'named' ? () => [] : () => undefined) }) as never;
            const dsc = new Describer(stub);
            const head = (src: string): string =>
            {
                const ctx = { scope: 'you', when: [], hidden: false, followUps: [], expand: 2, stack: [], src, scopeType: 'character' };
                return JSON.stringify(dsc.effects(parse(src), ctx as never).map((l) => l.text));
            };
            const want: [string, string][] = [
                ['ordered_child = { order_by = age add_gold = 5 }', 'For the child with the highest age:'],
                ['ordered_child = { order_by = { value = age multiply = -1 } add_gold = 5 }', 'For the child with the lowest age:'],
                ['ordered_child = { order_by = { value = 0 subtract = age } add_gold = 5 }', 'For the child with the lowest age:'],
                ['ordered_child = { order_by = { value = age add = 3 } add_gold = 5 }', 'For the best child:']
            ];

            for (const [src, text] of want)
            {
                const got = head(src);

                if (got !== JSON.stringify([[text]]) && got !== JSON.stringify([text]))
                    (console.log(`MENUS describer ${src}: ${got}`), bad++);
            }

            // a written `prev.prev` (the game refuses it) is marked where it is a scope, a value or part of a chain, once
            // per line; a plain prev and prev.liege are not
            const marks = (src: string, kind: 'effects' | 'triggers'): string[] =>
            {
                const ctx = { scope: 'you', when: [], hidden: false, followUps: [], expand: 2, stack: [], src, scopeType: 'character' };
                const all = (ls: Line[]): Line[] => ls.flatMap((l) => [l, ...all(l.children ?? [])]);
                return all(dsc[kind](parse(src), ctx as never)).map((l) => l.text.filter((x) => typeof x !== 'string' && x.kind === 'bad').map((x) => (x as { text: string; }).text).join('+')).filter(Boolean);
            };

            for (const [src, kind, want] of [
                ['every_child = { prev.prev = { add_gold = 5 } }', 'effects', ['prev.prev (refused by the game)']],
                ['every_child = { every_child = { add_gold = prev.prev.gold } }', 'effects', ['(refused by the game: prev.prev.gold)']],
                ['every_child = { add_opinion = { target = prev.prev modifier = friendly_opinion } }', 'effects', ['prev.prev (refused by the game)']],
                ['any_child = { prev.prev = { is_adult = yes } }', 'triggers', ['prev.prev (refused by the game)']],
                ['every_child = { prev = { add_gold = 5 } prev.liege = { add_gold = 1 } }', 'effects', []]
            ] as [string, 'effects' | 'triggers', string[]][])
            {
                const got = marks(src, kind);

                if (JSON.stringify(got) !== JSON.stringify(want))
                    (console.log(`MENUS prev.prev mark in ${src}: ${JSON.stringify(got)}`), bad++);
            }
        }

        // a new entry in the preview and summary: by the name given (createdNames → describeScript `names`), not its key made readable
        {
            const stub = new Proxy({}, { get: (_t, p) => (p === 'named' ? () => [] : () => undefined) }) as never;
            const dsc = new Describer(stub);
            const flat = (src: string, kind: 'effects' | 'triggers'): string =>
            {
                const ctx = { scope: 'you', when: [], hidden: false, followUps: [], expand: 2, stack: [], src, scopeType: 'character' };
                return dsc[kind](parse(src), ctx as never).map((l) => l.text.map((x) => (typeof x === 'string' ? x : x.text)).join('')).join(' | ');
            };
            const st: State = { ...startStates('effect', 'character')[0].state, creates: [{ what: 'entry', key: 'd1_bold', fields: [['type', 'traits']], loc: 'Bold One' }, { what: 'entry', key: 'd1_law', fields: [['type', 'laws'], ['newHolder', 'd1_group'], ['newHolderName', 'New Laws']], loc: 'A Law' }, { what: 'loc', key: 'd1_text', fields: [], loc: 'not an entry' }, { what: 'opinion_modifiers', key: 'd1_friendly', fields: [], loc: 'Old Friends' }, { what: 'doctrine_parameter', key: 'd1_flag', fields: [], loc: 'A sentence about the flag' }] };
            const names = createdNames(st);

            if (JSON.stringify(names) !== JSON.stringify({ d1_bold: 'Bold One', d1_law: 'A Law', d1_group: 'New Laws', d1_friendly: 'Old Friends' }))
                (console.log(`MENUS createdNames: ${JSON.stringify(names)}`), bad++);

            for (const [src, kind, want] of [['add_trait = d1_bold', 'effects', 'Gains the trait Bold One'], ['has_trait = d1_bold', 'triggers', 'Has the trait Bold One'], ['add_character_modifier = { modifier = d1_bold years = 5 }', 'effects', 'Gains Bold One for 5 years']] as [string, 'effects' | 'triggers', string][])
            {
                dsc.pendingNames = undefined;
                const plain = flat(src, kind);
                dsc.pendingNames = names;
                const named = flat(src, kind);
                dsc.pendingNames = undefined;

                if (named !== want || !/D1 Bold/i.test(plain))
                    (console.log(`MENUS new entry's name in ${src}: "${named}" (without names: "${plain}")`), bad++);
            }

            // (a new opinion modifier: its name in an add_opinion; the exact sentence is the describer's, only the name is checked)
            {
                const src = 'add_opinion = { target = root modifier = d1_friendly }';
                dsc.pendingNames = undefined;
                const plain = flat(src, 'effects');
                dsc.pendingNames = names;
                const named = flat(src, 'effects');
                dsc.pendingNames = undefined;

                if (!named.includes('Old Friends') || !/D1 Friendly/i.test(plain))
                    (console.log(`MENUS new opinion modifier's name: "${named}" (without names: "${plain}")`), bad++);
            }
        }

        // a typed number in a duration asks for the unit: days, weeks, months or years
        {
            let sd: State = startStates('effect', 'activity')[0].state;

            for (const p of [ON, 'Effect on activity…', 'You (self)', 'Move to the next phase after…'])
                sd = (choose(sd, p) as { state: State; }).state;

            const units = menuOf(sd, data).number?.(6, '6').map((i) => i.label).join(' | ');

            if (units !== '6 days | 6 weeks | 6 months | 6 years')
                (console.log(`MENUS duration units: ${units}`), bad++);
        }

        // a duration setting changed (a field set, not a statement): a typed number keeps the unit written now
        {
            const base: State = startStates('effect', 'activity')[0].state;
            const field = (unit: string): string | undefined =>
                menuOf({ ...base, type: 'opinion_modifiers', view: { v: 'fieldValue', key: 'duration', now: '2', unit } } as State, data).number?.(3, '3').map((i) => i.label).join(' | ');
            const months = field('months');
            const days = field('days');

            if (!months?.startsWith('3 months') || !days?.startsWith('3 days'))
                (console.log(`MENUS field duration unit first: ${months} / ${days}`), bad++);
        }

        // "Towards whom?" typed a title: written, with a warning
        let st: State = s;

        for (const p of [ON, E, 'You (self)', 'Set / change…', 'Designated heir'])
            st = (choose(st, p) as { state: State; }).state;

        const typed = menuOf(st, data).input?.('scope:my_title');

        if (!typed?.warn || typed.label !== 'Use “scope:my_title”')
            (console.log(`MENUS typed chain warning: ${JSON.stringify(typed)}`), bad++);

        // a rite typed as a chain: fits (no note), its last link leads elsewhere (a warning), the link is unknown (not checked)
        {
            const rite = startStates('effect', 'character', undefined, undefined, 'set_character_rite = scope:x.rite').at(-1)!.state;
            const at = (text: string): Item | null | undefined => menuOf(rite, data).input?.(text);
            const fitsRow = at('scope:y.rite');
            const elsewhere = at('scope:y.liege');
            const unknown = at('scope:y.d1_unknown_link');

            if (fitsRow?.warn || fitsRow?.hint !== 'as typed' || elsewhere?.warn !== 'Leads to a character, not a rite' || unknown?.warn || unknown?.hint !== 'as typed, not checked')
                (console.log(`MENUS rite chain rows: ${JSON.stringify([fitsRow, elsewhere, unknown].map((r) => r && { label: r.label, hint: r.hint, warn: r.warn }))}`), bad++);
        }

        // a typed subject of a known type: its statements
        st = s;

        for (const p of [ON, E, 'Someone else…'])
            st = (choose(st, p) as { state: State; }).state;

        const subject = menuOf(st, data).input?.('scope:my_title');
        const next = subject?.go?.();

        if (!next || 'finish' in next || !menuOf(next.state, data).items.some((i) => i.label === 'County modifier' || i.label.startsWith('Add')))
            (console.log(`MENUS typed title subject: ${next && !('finish' in next) ? menuOf(next.state, data).items.map((i) => i.label).join(' | ') : 'none'}`), bad++);

        // an "Other…" key whose values the game writes are characters: a typed title is flagged, a typed character not
        const key = { key: 'test_key', count: 10, shapes: { scope: 10 }, values: [['root', 5], ['liege', 3], ['primary_spouse', 2]] as [string, number][] };
        const other = menuOf({ ...s, view: { v: 'otherValue', key } }, data);

        if (!other.input?.('primary_title')?.warn || other.input?.('scope:friend')?.warn || other.input?.('yes')?.warn)
            (console.log(`MENUS Other… value check: ${JSON.stringify([other.input?.('primary_title'), other.input?.('scope:friend')])}`), bad++);
    }

    // an exact match comes first whatever the rank: the active mod's entries (rank -3) and made-on-the-way rows (-5)
    // must not outrank the key that was typed ("brave" picks Brave, not brave_copy)
    {
        const mk = (label: string, match: string, rank?: number): Item => ({ label, match, rank, go: () => ({ finish: true }) as unknown as Next });
        const menu = { title: 't', items: [mk('Brave Copy', 'brave_copy', -3), mk('Bravery', 'bravery', -5), mk('Brave', 'brave'), mk('Craven', 'craven')] };
        const order = rowsOf(menu as never, 'brave', undefined).map((r) => r.item.label).join(' | ');

        if (order !== 'Brave | Bravery | Brave Copy')
            (console.log(`MENUS exact match first: ${order}`), bad++);

        // (by the key too, and the rank still orders the rest)
        const byKey = rowsOf({ title: 't', items: [mk('Copy of it', 'brave_copy', -3), mk('A brave one', 'brave')] } as never, 'brave', undefined).map((r) => r.item.label).join(' | ');

        if (byKey !== 'A brave one | Copy of it')
            (console.log(`MENUS exact key first: ${byKey}`), bad++);

        // a positive rank pushes a row down on purpose (the `/` search's raw key scan, rank 3): typing the key of a
        // catalog statement keeps the statement ("Add gold", hint add_gold) before the raw key row
        const raw = rowsOf({ title: 't', items: [{ label: 'Add gold', hint: 'add_gold', match: 'money add_gold = 5', go: () => ({ finish: true }) as unknown as Next }, mk('add_gold', 'add_gold', 3)] } as never, 'add_gold', undefined).map((r) => r.item.label).join(' | ');

        if (raw !== 'Add gold | add_gold')
            (console.log(`MENUS exact key vs raw key row: ${raw}`), bad++);

        // (an exact match with a positive rank (3) does not jump ahead of a row that starts with the word)
        const dim = rowsOf({ title: 't', items: [mk('Brave', 'brave', 3), mk('Bravely', 'bravely_x')] } as never, 'brave', undefined).map((r) => r.item.label).join(' | ');

        if (dim !== 'Bravely | Brave')
            (console.log(`MENUS exact match with a positive rank: ${dim}`), bad++);
    }

    // saved scopes out of reach (docs/picker.md, "Scopes in reach"): with the entry's scopes known (an event without
    // an actor) the common saved scopes are not offered, only `prev`; nothing known offers them all, as before
    {
        const base = startStates('effect', 'character')[0].state;
        const hints = (st: State, path: Step[]): string[] =>
        {
            for (const p of path)
                st = (choose(st, p) as { state: State; }).state;

            return menuOf(st, data).items.map((i) => i.hint ?? '');
        };
        const mine = [{ key: 'scope:friend', label: 'Friend', type: 'character' }];
        const knownS: State = { ...base, targets: mine, targetsKnown: true };
        const knownEmpty: State = { ...base, targets: [], targetsKnown: true };
        const unknownS: State = { ...base };
        const paths: [string, Step[]][] = [
            ['Someone else', [ON, E, 'Someone else…']],
            ['whom?', [ON, E, 'You (self)', 'Set / change…', 'Designated heir']]
        ];

        for (const [name, path] of paths)
        {
            const k = hints(knownS, path);
            const e = hints(knownEmpty, path);
            const u = hints(unknownS, path);

            if (k.includes('scope:actor') || k.includes('scope:recipient') || !k.includes('prev') || !k.includes('scope:friend'))
                (console.log(`MENUS known targets ${name}: ${k.join(', ')}`), bad++);

            if (e.includes('scope:actor') || !e.includes('prev'))
                (console.log(`MENUS known empty targets ${name}: ${e.join(', ')}`), bad++);

            if (!u.includes('scope:actor') || !u.includes('scope:recipient') || !u.includes('prev'))
                (console.log(`MENUS unknown targets ${name}: ${u.join(', ')}`), bad++);
        }

        // "Instead of …" (a scope switch changed to another)
        const insteadOf = (st: State): string[] =>
        {
            const starts = startStates('effect', 'character', undefined, undefined, 'liege = { add_gold = 5 }');
            const first = starts[starts.length - 1].state;
            return hints({ ...first, targets: st.targets, targetsKnown: st.targetsKnown }, ['Someone (something) else instead…']);
        };
        const ik = insteadOf(knownS);
        const iu = insteadOf(unknownS);
        const ie = insteadOf(knownEmpty);

        // (an event without an actor: nothing of its own, only prev)
        if (ie.includes('scope:actor') || ie.includes('scope:recipient') || !ie.includes('prev'))
            (console.log(`MENUS known empty targets Instead of: ${ie.join(', ')}`), bad++);

        // a common value that is a chain from a saved scope follows its head (scope:actor.faith needs scope:actor)
        if (scopeInReach(knownS, 'scope:actor.faith') || !scopeInReach(knownS, 'scope:friend.faith') || scopeInReach(knownEmpty, 'scope:recipient') || !scopeInReach(knownS, 'liege') || !scopeInReach(unknownS, 'scope:actor.faith'))
            (console.log('MENUS scopeInReach chain values'), bad++);

        if (ik.includes('scope:actor') || !ik.includes('prev') || !ik.includes('scope:friend'))
            (console.log(`MENUS known targets Instead of: ${ik.join(', ')}`), bad++);

        if (!iu.includes('scope:actor') || !iu.includes('prev'))
            (console.log(`MENUS unknown targets Instead of: ${iu.join(', ')}`), bad++);

        // a typed saved scope: a problem only while the scopes in reach are known
        const typedProblem = (st: State, expr: string): boolean => !!chainType(st, expr, 'character').problem;

        if (!typedProblem(knownS, 'scope:actor') || !typedProblem(knownEmpty, 'scope:actor') || typedProblem(knownS, 'scope:friend') || typedProblem(unknownS, 'scope:actor'))
            (console.log('MENUS chainType scope:actor known / unknown'), bad++);

        // (the typed row of "Someone else…" shows it)
        let st = knownEmpty;

        for (const p of [ON, E, 'Someone else…'])
            st = (choose(st, p) as { state: State; }).state;

        if (!menuOf(st, data).input?.('scope:actor')?.warn)
            (console.log('MENUS typed scope:actor without a warning in known targets'), bad++);
    }

    // ---- lane F1 (round 13): scopes in reach at the place (docs/picker.md "Scopes in reach"): a view's scope left out
    // where the statement goes (picker/targets.ts awayTargets, set by pickStatement) is warned about when typed, with
    // why; one in reach, or with nothing away, is not
    {
        const base = startStates('effect', 'character')[0].state;
        const inReachHere: State = { ...base, targets: [{ key: 'scope:friend', label: 'Friend' }], targetsKnown: true };
        const unknownHere: State = { ...base };
        const problem = (st: State, expr: string): string | undefined => chainType(st, expr, 'character').problem;
        setAwayTargets([{ key: 'scope:boss', why: 'elsewhere' }, { key: 'scope:helper', why: 'later' }]);

        if (!problem(inReachHere, 'scope:boss')?.includes('another part') || !problem(unknownHere, 'scope:boss')?.includes('another part'))
            (console.log(`MENUS away scope:boss (another option): ${problem(inReachHere, 'scope:boss')} / ${problem(unknownHere, 'scope:boss')}`), bad++);

        if (!problem(inReachHere, 'scope:helper.liege')?.includes('only later'))
            (console.log(`MENUS away scope:helper.liege (saved later): ${problem(inReachHere, 'scope:helper.liege')}`), bad++);

        if (problem(inReachHere, 'scope:friend') || problem(unknownHere, 'scope:other'))
            (console.log('MENUS away: a scope in reach, or one not saved anywhere while nothing is known, got a problem'), bad++);

        // (the typed row of "Someone else…" shows it)
        let st = inReachHere;

        for (const p of [ON, E, 'Someone else…'])
            st = (choose(st, p) as { state: State; }).state;

        if (!menuOf(st, data).input?.('scope:boss')?.warn)
            (console.log('MENUS typed scope:boss (saved in another option) without a warning'), bad++);

        setAwayTargets([]);

        if (problem(unknownHere, 'scope:boss'))
            (console.log('MENUS nothing away: scope:boss still warned about'), bad++);
    }

    // ---- round 13 wave 11, lane T: the picker's own `prev` typed (the request's stack, picker/targets.ts placeScopes,
    // with the draft's nesting and the subject chain on top, as describer.ts pushPrev), and a scope typed by a guess
    // from its block's use (never warned about)
    {
        const base = startStates('effect', 'character')[0].state;
        const ty = (st: State, expr: string, from: ScopeType = 'character'): string => JSON.stringify(chainType(st, expr, from));
        const sw = (k: string, scope: ScopeType, wrap: 'scope' | 'iter' = 'scope'): State => ({ ...base, draft: { top: [{ k, op: '=', kids: [], meta: { wrap, label: k, scope } }], loc: { path: [0], kind: 'effect', scope, label: k } } });

        setPlaceScopes({ prev: ['landed_title'] });

        if (chainType(base, 'prev', 'character').type !== 'landed_title' || chainType(base, 'prev.holder', 'character').type !== 'character')
            (console.log(`MENUS T prev from the line's stack: ${ty(base, 'prev')} / ${ty(base, 'prev.holder')}`), bad++);

        setPlaceScopes({ prev: ['faith', 'landed_title'] });

        // (prev after prev: the game refuses it (round 13's second in-game test), a problem instead of a type)
        const prevPrev = (st: State): boolean => /prev after prev/.test(chainType(st, 'prev.prev', 'character').problem ?? '') && !chainType(st, 'prev.prev', 'character').type;

        if (!prevPrev(base))
            (console.log(`MENUS T prev.prev: ${ty(base, 'prev.prev')}`), bad++);

        setPlaceScopes({});

        if (ty(base, 'prev') !== '{}' || ty(base, 'prev.holder') !== '{}')
            (console.log(`MENUS T empty stack: prev not unknown: ${ty(base, 'prev')}`), bad++);

        // (a draft with `liege = { … }` open: prev is the scope around it, prev.prev the line's)
        setPlaceScopes({ scope: 'landed_title', prev: ['faith'] });
        const inLiege = sw('holder', 'character');

        if (chainType(inLiege, 'prev', 'character').type !== 'landed_title' || !prevPrev(inLiege))
            (console.log(`MENUS T draft nesting: ${ty(inLiege, 'prev')} / ${ty(inLiege, 'prev.prev')}`), bad++);

        // (a chain of links and a switch to prev push "not known"; so does a request without a scope)
        if (ty(sw('liege.primary_title', 'landed_title'), 'prev') !== '{}' || ty(sw('prev', 'character'), 'prev') !== '{}')
            (console.log('MENUS T a link chain or prev switch: prev not unknown'), bad++);

        setPlaceScopes({ prev: ['faith'] });

        if (ty(sw('liege', 'character'), 'prev') !== '{}' || !prevPrev(sw('every_vassal', 'character', 'iter')))
            (console.log('MENUS T no request scope: the push not known; prev after prev refused'), bad++);

        // (the subject chain: an iterator pushes the place's scope)
        setPlaceScopes({ scope: 'character' });
        const chained: State = { ...base, chain: [{ kind: 'iter', key: 'every_held_title', label: 'each held title', to: 'landed_title' }] };

        if (chainType(chained, 'prev', 'landed_title').type !== 'character')
            (console.log(`MENUS T subject chain: ${ty(chained, 'prev', 'landed_title')}`), bad++);

        // (a wrong prev type is a warning, never a refusal: the typed row still goes on)
        setPlaceScopes({ prev: ['landed_title'] });
        let st = base;

        for (const p of [ON, E, 'Someone else…'])
            st = (choose(st, p) as { state: State; }).state;

        const row = menuOf(st, data).input?.('prev');

        if (!row?.go || !row.warn || !/title/i.test(row.hint ?? ''))
            (console.log(`MENUS T typed prev (a title) in Someone else: ${JSON.stringify({ hint: row?.hint, warn: row?.warn, go: !!row?.go })}`), bad++);

        // (the "Previous scope" row of the characters is not offered while prev is known to be a title)
        const prevRow = (): boolean => menuOf(st, data).items.some((it) => it.hint === 'prev');
        const asTitle = prevRow();
        setPlaceScopes({ prev: ['character'] });
        const asCharacter = prevRow();
        setPlaceScopes({});
        const asUnknown = prevRow();
        setPlaceScopes({ prev: ['landed_title'] });

        if (asTitle || !asCharacter || !asUnknown)
            (console.log(`MENUS T the prev row among the characters: title ${asTitle}, character ${asCharacter}, unknown ${asUnknown}`), bad++);

        if (!chainType(base, 'prev.primary_spouse', 'character').problem)
            (console.log(`MENUS T prev.primary_spouse from a title: no warning: ${ty(base, 'prev.primary_spouse')}`), bad++);

        // (a guessed scope: marked in its root menu, nothing resting on it warned about; a link from it neither)
        const titleBase = startStates('effect', 'landed_title')[0].state;
        setPlaceScopes({ scope: 'landed_title', guessed: true });

        if (chainType(titleBase, 'primary_spouse', 'landed_title').problem || !chainType(titleBase, 'holder', 'landed_title').guessed)
            (console.log(`MENUS T guessed: ${ty(titleBase, 'primary_spouse', 'landed_title')} / ${ty(titleBase, 'holder', 'landed_title')}`), bad++);

        if (!/guessed from its use/.test(menuOf(titleBase, data).note ?? ''))
            (console.log(`MENUS T guessed: root note ${menuOf(titleBase, data).note}`), bad++);

        if (chainType(titleBase, 'root.primary_spouse', 'landed_title').guessed || ty(sw('liege', 'character'), 'prev') !== '{}')
            (console.log('MENUS T guessed: root is no guess; a guessed scope is not pushed'), bad++);

        setPlaceScopes({ scope: 'landed_title' });

        if (!chainType(titleBase, 'primary_spouse', 'landed_title').problem || /guessed/.test(menuOf(titleBase, data).note ?? ''))
            (console.log('MENUS T not guessed: the warning and no note'), bad++);

        setPlaceScopes({});
    }

    // "Only with <DLC>": a faith's tenet of a DLC (its flag and a fallback, `tenet_selection_pair` written next to the
    // list, PickResult.outside), an effect naming a trait of a DLC (`if = { limit = { has_dlc_feature } }`), the same
    // with another trait in its `else`
    {
        const d3: PickerData = {
            ...data,
            list: (t) => (t === 'religion/tenet_types' ? [entry('tenet_dulia', 5, 'Dulia'), entry('tenet_communion', 9, 'Communion')] : (LISTS[t] ?? [])),
            dlcFlags: (t): Record<string, { flag: string; dlc: string; }> => (t === 'religion/tenet_types' ? { tenet_dulia: { flag: 'by_god_alone', dlc: 'By God Alone' } } : t === 'traits' ? { shy: { flag: 'royal_court', dlc: 'The Royal Court' } } : {}),
            dlcFlagsLoaded: async () => undefined
        };
        const run = (st: State, path: Step[]): { st: State; done: boolean; } =>
        {
            for (const p of path)
            {
                const m = menuOf(st, d3);
                const item = typeof p === 'string' ? (m.items.find((i) => i.label === p) ?? m.items.find((i) => i.label.startsWith(p))) : undefined;

                if (!item?.go)
                    throw new Error(`no row ${JSON.stringify(p)} in “${m.title}”: ${m.items.map((i) => i.label).join(' | ')}`);

                const n = item.go();

                if ('finish' in n)
                    return { st: n.state ?? st, done: true };

                st = n.state;
            }

            return { st, done: false };
        };

        try
        {
            const tenet = startStates('field', 'character', undefined, 'faith_tenets', undefined, undefined, undefined, undefined, undefined, { field: 'tenet', once: true }).at(-1)!.state;
            const pair = run(tenet, ['Dulia', 'With By God Alone, otherwise…', 'Communion']);
            const want = 'tenet_selection_pair = {\n\trequires_dlc_flag = by_god_alone\n\ttenet = tenet_dulia\n\tfallback_tenet = tenet_communion\n}';

            if (!pair.done || !pair.st.outside || resultText(pair.st) !== want)
                (console.log(`MENUS tenet with a fallback: ${pair.done} ${pair.st.outside}\n${resultText(pair.st)}`), bad++);

            const always = run(tenet, ['Dulia', 'Always']);

            if (!always.done || always.st.outside || resultText(always.st) !== 'tenet_dulia')
                (console.log(`MENUS tenet always: ${resultText(always.st)}`), bad++);

            const plain = run(tenet, ['Communion']);

            if (!plain.done || resultText(plain.st) !== 'tenet_communion')
                (console.log(`MENUS tenet of every game: ${resultText(plain.st)}`), bad++);

            const eff = startStates('effect', 'character')[0].state;
            const wrapped = run(eff, [ON, E, 'You (self)', 'Add…', 'Trait', 'Shy', 'Only with The Royal Court…', 'With The Royal Court, otherwise…', 'Brave']);
            const wantEff = 'if = {\n\tlimit = { has_dlc_feature = royal_court }\n\tadd_trait = shy\n}\nelse = { add_trait = brave }';

            if (resultText(wrapped.st) !== wantEff)
                (console.log(`MENUS effect with a DLC fallback:\n${resultText(wrapped.st)}`), bad++);

            // (a trait of every game: no offer)
            const free = run(eff, [ON, E, 'You (self)', 'Add…', 'Trait', 'Brave']);

            if (menuOf(free.st, d3).items.some((i) => i.label.startsWith('Only with')))
                (console.log('MENUS DLC offer for a trait of every game'), bad++);
        }
        catch (e)
        {
            console.log(`MENUS only with a DLC: ${(e as Error).message}`);
            bad++;
        }
    }

    // "＋ New trait…" / "＋ New event…": the key (events: the next free id) and the name asked, the key used, the entry
    // remembered for making (PickResult.creates); only where the caller makes them (PickRequest.newEntries)
    {
        const d2: PickerData = {
            ...data,
            activeMod: () => 'mod/test.mod',
            newPlan: (type) => ({ type, label: type === 'events' ? 'Events' : 'Traits', mod: 'Test', rel: `common/${type}/test_${type}.txt`, key: type === 'events' ? 'test.0001' : undefined, name: true }),
            newPlanLoaded: async () => undefined
        };
        const walk = (newEntries: boolean, path: Step[]): State =>
        {
            let st = startStates('effect', 'character', undefined, undefined, undefined, undefined, undefined, undefined, undefined, { newEntries })[0].state;

            for (const p of path)
            {
                const m = menuOf(st, d2);
                const item = typeof p === 'string' ? (m.items.find((i) => i.label === p) ?? m.items.find((i) => i.label.startsWith(p))) : 'n' in p ? m.number?.(p.n, String(p.n))[0] : m.input?.(p.input);

                if (!item?.go)
                    throw new Error(`no row ${JSON.stringify(p)} in “${m.title}”: ${m.items.map((i) => i.label).join(' | ')}`);

                const n = item.go();

                if ('finish' in n)
                    break;

                st = n.state;
            }

            return st;
        };
        const entry = (st: State, type: string): EntryCreate | undefined => st.creates?.find((c) => c.what === 'entry' && c.fields.some(([k, v]) => k === 'type' && v === type));

        try
        {
            const t = walk(true, [ON, E, 'You (self)', 'Add…', 'Trait', '＋ New trait…', { input: 'my_bold' }, { input: 'Bold' }]);
            const ev = walk(true, ['Trigger an event…', '＋ New event…', 'test.0001', { input: 'A surprise' }, 'Right away']);

            if (resultText(t) !== 'add_trait = my_bold' || entry(t, 'traits')?.key !== 'my_bold' || entry(t, 'traits')?.loc !== 'Bold')
                (console.log(`MENUS new trait: ${resultText(t)} ${JSON.stringify(t.creates)}`), bad++);

            if (resultText(ev) !== 'trigger_event = test.0001' || entry(ev, 'events')?.loc !== 'A surprise')
                (console.log(`MENUS new event: ${resultText(ev)} ${JSON.stringify(ev.creates)}`), bad++);

            // (a new trait inside a statement Ctrl+⏎ then drops, half built: not made)
            const half = walk(true, [ON, E, 'You (self)', 'Add…', 'Gold', { n: 100 }, 'And also…', ON, E, 'You (self)', 'Add…', 'Trait experience', '＋ New trait…', { input: 'my_unused' }, { input: 'Unused' }]);

            if (resultText(half) !== 'add_gold = 100' || usedCreates(half) || usedCreates(t)?.[0]?.key !== 'my_bold')
                (console.log(`MENUS new entry of a dropped statement: ${resultText(half)} ${JSON.stringify(usedCreates(half))}`), bad++);

            // (a key written behind a prefix, set_character_faith = faith:<key>, is still the key: its create is kept)
            const fa = walk(true, [ON, E, 'You (self)', 'Set / change…', 'Faith', '＋ New', { input: 'my_faith' }, { input: 'My Faith' }]);

            if (resultText(fa) !== 'set_character_faith = faith:my_faith' || usedCreates(fa)?.[0]?.key !== 'my_faith')
                (console.log(`MENUS new faith behind a prefix: ${resultText(fa)} ${JSON.stringify(usedCreates(fa))}`), bad++);
        }
        catch (e)
        {
            console.log(`MENUS new entries: ${(e as Error).message}`);
            bad++;
        }

        // key presses as the picker takes them (rows.ts: mnemonics, filter, the row selected): "＋ New …" is never the
        // row ⏎ chooses; the docs' key sequences work in the in-place editor (which makes new entries) as documented
        const press = (keys: string[]): string =>
        {
            let st = startStates('effect', 'character', undefined, undefined, undefined, undefined, undefined, undefined, undefined, { newEntries: true })[0].state;
            let filter = '';
            let sel = firstSelectable(rowsOf(menuOf(st, d2), '', undefined));

            for (const k of keys)
            {
                const menu = menuOf(st, d2);
                const rows = rowsOf(menu, filter, undefined);
                let ri = -1;

                if (k === '⏎')
                    ri = sel;
                else if (!menu.typeahead && !filter && rows.some((r) => r.key === k))
                    ri = rows.findIndex((r) => r.key === k);
                else
                {
                    filter += k;
                    sel = firstSelectable(rowsOf(menu, filter, undefined), true);
                    continue;
                }

                const n = rows[ri]?.item.go?.();

                if (!n)
                    return `nothing chosen at “${menu.title}” (${k})`;

                if ('finish' in n)
                    return resultText(n.state ?? st) + (usedCreates(n.state ?? st) ? ' + new entries' : '');

                st = n.state;
                filter = '';
                sel = firstSelectable(rowsOf(menuOf(st, d2), '', undefined));
            }

            return resultText(st);
        };
        const typedKeys = (s: string): string[] => s.split(' ').flatMap((w) => (w === '⏎' || w.length === 1 ? [w] : [...w]));
        const docs = press(typedKeys('o c s a o 3 0 ⏎ ⏎ ⏎ w s a u 1 8 ⏎ ⏎'));
        const newTrait = press(['o', 'c', 's', 'a', 't', '+', '⏎', ...'my_bold', '⏎', ...'Bold', '⏎', '⏎']);

        if (docs !== 'if = {\n\tlimit = { age < 18 }\n\tadd_opinion = { target = root modifier = respect_opinion opinion = 30 }\n}')
            (console.log(`MENUS the docs' key sequence with new entries offered: ${docs}`), bad++);

        if (newTrait !== 'add_trait = my_bold + new entries')
            (console.log(`MENUS “+ ⏎” for a new trait: ${newTrait}`), bad++);

        // (a caller that does not make them: no such row)
        const plain = walk(false, [ON, E, 'You (self)', 'Add…', 'Trait']);

        if (menuOf(plain, d2).items.some((i) => i.label.startsWith('＋ New')))
            (console.log('MENUS new entries offered to a caller that does not make them'), bad++);

        // a scripted effect's parameters (from "Other…"): each asked with the values of the key its definition writes it
        // after (`add_gold = $AMOUNT$`: what the game gives add_gold; a field of a block: that block's values for it); one
        // nothing passes and no key is known for is typed, never offered as yes
        try
        {
            const sc = new ScriptKeyScanner();
            sc.file('common/scripted_effects/pc_effects.txt', 'pc_gold_effect = {\n\tadd_gold = $AMOUNT$\n\tadd_trait_xp = { trait = $TRAIT$ value = 5 }\n\tadd_prestige = x_$ODD$\n\tif = { limit = { age > $AGE$ } add_gold = $AMOUNT$ }\n}\n');
            sc.file('events/pc_events.txt', 'namespace = pc\npc.1 = { immediate = { add_gold = 100 add_gold = 100 add_gold = 50 add_trait_xp = { trait = brave value = 1 } } }\n');
            const pc = sc.keys();
            const def = pc.effect.find((k) => k.key === 'pc_gold_effect');
            const want = '{"AMOUNT":{"key":"add_gold"},"TRAIT":{"key":"trait","block":"add_trait_xp"},"AGE":{"key":"age","block":"limit"}}';

            if (JSON.stringify(def?.params) !== '["AMOUNT","TRAIT","ODD","AGE"]' || JSON.stringify(def?.paramKeys) !== want)
                (console.log(`MENUS scanner paramKeys: ${JSON.stringify(def?.params)} ${JSON.stringify(def?.paramKeys)}`), bad++);

            const d5: PickerData = { ...data, keys: (k) => (k === 'effect' ? pc.effect : pc.trigger) };
            const at = (field: string, fields: { k: string; op: string; v: string; }[], ask: string[]): State => ({ ...startStates('effect', 'character')[0].state, view: { v: 'kfield', key: 'pc_gold_effect', field, fields, ask } as State['view'] });
            const amount = menuOf(at('AMOUNT', [], ['TRAIT', 'ODD', 'AGE']), d5);
            const labels = amount.items.map((i) => i.label).join('|');
            const typed = amount.input?.('25');
            const next = typed?.go?.();

            if (labels !== '100|50' || !next || 'finish' in next || (next.state.view as { field?: string; }).field !== 'TRAIT' || JSON.stringify((next.state.view as { fields?: unknown; }).fields) !== '[{"k":"AMOUNT","op":"=","v":"25"}]')
                (console.log(`MENUS scripted parameter AMOUNT: ${labels} ${JSON.stringify(next && 'state' in next ? next.state?.view : next)}`), bad++);

            const trait = menuOf(at('TRAIT', [], ['ODD', 'AGE']), d5).items.map((i) => i.label).join('|');
            const odd = menuOf(at('ODD', [], ['AGE']), d5);

            if (trait !== 'brave' || odd.items.length || odd.items.some((i) => i.label === 'yes') || !odd.input?.('3')?.go)
                (console.log(`MENUS scripted parameters: trait ${trait} / unused ${odd.items.map((i) => i.label).join('|')}`), bad++);

            // (a field of a plain block still offers yes / no when nothing is known)
            const plainField = menuOf({ ...at('zzz', [], []), view: { v: 'kfield', key: 'add_gold', field: 'zzz', fields: [] } as State['view'] }, d5).items.map((i) => i.label).join('|');

            if (plainField !== 'yes|no')
                (console.log(`MENUS a block's unknown field: ${plainField}`), bad++);
        }
        catch (e)
        {
            console.log(`MENUS scripted parameters: ${(e as Error).message}`);
            bad++;
        }

        // the name step's default (an event: its namespace made readable and the number without zeros), the key hint (the
        // keys the game and main take: `-` and `.` too), a label's ellipsis in a crumb (only a trailing one goes)
        try
        {
            const evName = menuOf(walk(true, ['Trigger an event…', '＋ New event…', { input: 'test.0003' }]), d2).items[0]?.label;
            const evName2 = menuOf(walk(true, ['Trigger an event…', '＋ New event…', { input: 'my_mod.0100' }]), d2).items[0]?.label;
            const trName = menuOf(walk(true, [ON, E, 'You (self)', 'Add…', 'Trait', '＋ New trait…', { input: 'my_bold' }]), d2).items[0]?.label;

            if (evName !== 'Keep: Test 3' || evName2 !== 'Keep: My mod 100' || trName !== 'Keep: My bold')
                (console.log(`MENUS default names: ${evName} | ${evName2} | ${trName}`), bad++);

            if (defaultEntryName('events', 'test.0003') !== 'Test 3' || defaultEntryName('traits', 'a.b_c') !== 'B c' || defaultEntryName('events', 'x.abc') !== 'Abc' || defaultEntryName('events', 'my_trait_opinion') !== 'My trait')
                (console.log(`MENUS defaultEntryName: ${defaultEntryName('events', 'test.0003')} ${defaultEntryName('traits', 'a.b_c')} ${defaultEntryName('events', 'x.abc')}`), bad++);

            const keyMenu = menuOf(walk(true, [ON, E, 'You (self)', 'Add…', 'Trait', '＋ New trait…']), d2);
            const bad1 = keyMenu.input?.('a:b');
            const good1 = keyMenu.input?.('my-trait.x');

            if (bad1?.go || bad1?.label !== '“a:b”: letters, digits, _, . and - only' || !good1?.go)
                (console.log(`MENUS new key hint: ${JSON.stringify(bad1?.label)} ${JSON.stringify(good1?.label)}`), bad++);

            const decisions = startStates('field', 'character', undefined, 'decisions')[0].state;
            const row = menuOf(decisions, data).items.find((i) => i.label === 'AI checks it every … months');
            const crumb = row?.go ? (row.go() as { crumb?: string; }).crumb : undefined;

            if (crumb !== 'AI checks it every … months' || plainLabel('Name…') !== 'Name' || plainLabel('Where to … ?…') !== 'Where to … ?' || plainLabel('Plain') !== 'Plain')
                (console.log(`MENUS plainLabel: ${crumb} ${plainLabel('Name…')} ${plainLabel('Where to … ?…')}`), bad++);
        }
        catch (e)
        {
            console.log(`MENUS default names and labels: ${(e as Error).message}`);
            bad++;
        }

        // a nested type (written inside a holder, a fake plan here): the holder asked after the key, an existing one (the
        // mod's first) or a new one with its key and name; it travels in the entry's fields (create.ts reads them)
        {
            const holders: RefEntry[] = [{ name: 'game_group', refs: 4, display: 'Game Group' }, { name: 'my_group', refs: 1, display: 'My Group', mod: { state: 'added', mods: ['mod/test.mod'] } }];
            const d3: PickerData = {
                ...d2,
                list: (t) => (t === 'trait_groups' ? holders : (LISTS[t] ?? [])),
                newPlan: (type) => ({ type, label: 'Traits', mod: 'Test', name: true, nested: { holderType: 'trait_groups', holderLabel: 'Trait Groups', within: ['traits'], newHolder: true } })
            };
            const walk3 = (path: Step[]): State =>
            {
                let st = startStates('effect', 'character', undefined, undefined, undefined, undefined, undefined, undefined, undefined, { newEntries: true })[0].state;

                for (const p of path)
                {
                    const m = menuOf(st, d3);
                    const item = typeof p === 'string' ? (m.items.find((i) => i.label === p) ?? m.items.find((i) => i.label.startsWith(p))) : 'n' in p ? m.number?.(p.n, String(p.n))[0] : m.input?.(p.input);

                    if (!item?.go)
                        throw new Error(`no row ${JSON.stringify(p)} in “${m.title}”: ${m.items.map((i) => i.label).join(' | ')}`);

                    const n = item.go();

                    if ('finish' in n)
                        break;

                    st = n.state;
                }

                return st;
            };
            const pre: Step[] = [ON, E, 'You (self)', 'Add…', 'Trait', '＋ New trait…', { input: 'my_bold' }];

            try
            {
                const inGame = walk3([...pre, 'Game Group', { input: 'Bold' }]);
                const fieldsOf = (st: State): string => JSON.stringify(entry(st, 'traits')?.fields);

                if (resultText(inGame) !== 'add_trait = my_bold' || fieldsOf(inGame) !== '[["type","traits"],["holder","game_group"]]' || entry(inGame, 'traits')?.loc !== 'Bold')
                    (console.log(`MENUS new nested entry in a game holder: ${resultText(inGame)} ${JSON.stringify(inGame.creates)}`), bad++);

                const holderRows = menuOf(walk3(pre), d3).items.map((i) => i.label);

                // (the mod's holder first, then the game's; "＋ New …" at the top)
                if (holderRows.join('|') !== '＋ New trait group…|My Group|Game Group')
                    (console.log(`MENUS nested entry's holder rows: ${holderRows.join(' | ')}`), bad++);

                const mine = walk3([...pre, 'My Group', { input: 'Bold' }]);

                if (fieldsOf(mine) !== '[["type","traits"],["holder","my_group"]]')
                    (console.log(`MENUS new nested entry in the mod's holder: ${fieldsOf(mine)}`), bad++);

                const fresh = walk3([...pre, '＋ New trait group…', { input: 'my_new_group' }, { input: 'My new group' }, { input: 'Bold' }]);

                if (fieldsOf(fresh) !== '[["type","traits"],["newHolder","my_new_group"],["newHolderName","My new group"]]' || entry(fresh, 'traits')?.loc !== 'Bold')
                    (console.log(`MENUS new nested entry in a new holder: ${fieldsOf(fresh)} ${entry(fresh, 'traits')?.loc}`), bad++);

                // (the new holder's name kept: no name field)
                const kept = walk3([...pre, '＋ New trait group…', { input: 'my_new_group' }, 'Keep', { input: 'Bold' }]);

                if (fieldsOf(kept) !== '[["type","traits"],["newHolder","my_new_group"]]')
                    (console.log(`MENUS new nested entry, new holder's name kept: ${fieldsOf(kept)}`), bad++);

                // (a holder key a game holder has is taken; another new entry's too)
                const taken = menuOf(walk3([...pre, '＋ New trait group…']), d3).input?.('game_group');

                if (!taken || taken.go)
                    (console.log(`MENUS new holder key taken: ${JSON.stringify(taken)}`), bad++);

                // (a second new entry of the same statement: the new holder the first one makes is its first row, "… · new",
                // and its go gives the same holder fields (create.ts puts both into the one holder); its key typed again
                // under "＋ New …" is still refused)
                const firstMade: Step[] = [...pre, '＋ New trait group…', { input: 'my_new_group' }, { input: 'My new group' }, { input: 'Bold' }];
                const second: Step[] = [...firstMade, 'And also…', ON, E, 'You (self)', 'Add…', 'Trait', '＋ New trait…', { input: 'my_calm' }];
                const rows2 = menuOf(walk3(second), d3).items;

                if (rows2.map((i) => i.label).join('|') !== 'My new group|＋ New trait group…|My Group|Game Group' || rows2[0].hint !== 'my_new_group · new')
                    (console.log(`MENUS a pending new holder's row: ${rows2.map((i) => `${i.label} [${i.hint}]`).join(' | ')}`), bad++);

                const both = walk3([...second, 'My new group', { input: 'Calm' }]);
                const calm = both.creates?.find((c) => c.key === 'my_calm');
                const bold = both.creates?.find((c) => c.key === 'my_bold');
                const sameFields = '[["type","traits"],["newHolder","my_new_group"],["newHolderName","My new group"]]';

                if (JSON.stringify(calm?.fields) !== sameFields || JSON.stringify(bold?.fields) !== sameFields || calm?.loc !== 'Calm' || usedCreates(both)?.length !== 2 || !/add_trait = my_bold[\s\S]*add_trait = my_calm/.test(resultText(both)))
                    (console.log(`MENUS two new entries into one new holder: ${resultText(both)} ${JSON.stringify(both.creates)}`), bad++);

                const again = menuOf(walk3([...second, '＋ New trait group…']), d3).input?.('my_new_group');

                if (!again || again.go || again.label !== '“my_new_group” exists already')
                    (console.log(`MENUS a pending new holder's key typed again: ${JSON.stringify(again)}`), bad++);

                // (its name kept by the first entry: the row reads the key made readable, the go has no name field)
                const keptFirst: Step[] = [...pre, '＋ New trait group…', { input: 'my_kept_group' }, 'Keep', { input: 'Bold' }, 'And also…', ON, E, 'You (self)', 'Add…', 'Trait', '＋ New trait…', { input: 'my_calm' }];
                const keptRow = menuOf(walk3(keptFirst), d3).items[0];
                const keptBoth = walk3([...keptFirst, 'My kept group', { input: 'Calm' }]);

                if (keptRow?.label !== 'My kept group' || JSON.stringify(keptBoth.creates?.find((c) => c.key === 'my_calm')?.fields) !== '[["type","traits"],["newHolder","my_kept_group"]]')
                    (console.log(`MENUS a pending new holder, name kept: ${keptRow?.label} ${JSON.stringify(keptBoth.creates)}`), bad++);

                // (a nested type the plan has no holder type for keeps its problem: no row)
                const d4: PickerData = { ...d3, newPlan: (type) => ({ type, label: 'Traits', name: false, problem: 'Not written on their own' }) };
                const noRow = menuOf(walk3([ON, E, 'You (self)', 'Add…', 'Trait']), d4).items.some((i) => i.label.startsWith('＋ New'));

                if (noRow)
                    (console.log('MENUS nested type with a problem offers a new entry'), bad++);
            }
            catch (e)
            {
                console.log(`MENUS new nested entries: ${(e as Error).message}`);
                bad++;
            }
        }
    }

    // (a county's modifiers: no character-only one in its groups)
    {
        const s = startStates('modifier', 'landed_title', undefined, undefined, undefined, undefined, undefined, undefined, undefined, { modScope: 'landed_title' })[0].state;
        const shown = menuOf({ ...s, view: { v: 'modGroup', group: '' } }, data).items.map((i) => i.label);

        if (shown.includes('Diplomacy') || !shown.includes('Tax %'))
            (console.log(`MENUS county modifiers: ${shown.join(' | ')}`), bad++);
    }

    // (the kinds and groups of P4: a raid intent's top-level modifier is a character's (modifiers.log 1.20.1.2: raid_speed, character), the area files' stems, the groups of keys)
    {
        const scopes: [string, string | undefined, string | undefined][] = [['modifier', 'raids/intents', 'character'], ['modifier', 'laws', 'character'], ['modifier', undefined, 'character'], ['county_modifier', 'raids/intents', 'landed_title'], ['travel_modifier', 'travel/travel_options', 'travel_plan'], ['owner_modifier', 'travel/travel_options', 'character'], ['travel_modifier', 'raids/intents', undefined]];

        for (const [key, type, want] of scopes)
            if (modifierScopeOf(key, type) !== want)
                (console.log(`MENUS modifierScopeOf(${key}, ${type}): ${modifierScopeOf(key, type)}`), bad++);

        const areas: [string, string | undefined][] = [['common/modifier_definition_formats/00_scheme_definitions.txt', 'scheme'], ['common/modifier_definition_formats/00_vassal_stance_definitions.txt', 'vassal_stance'], ['common/modifier_definition_formats/00_definitions.txt', undefined], ['common/modifier_definition_formats/mymod_definitions.txt', undefined]];

        for (const [file, want] of areas)
            if (modifierAreaOf(file) !== want)
                (console.log(`MENUS modifierAreaOf(${file}): ${modifierAreaOf(file)}`), bad++);

        const groups: [Pick<ModifierKeyInfo, 'key' | 'area'>, string][] = [[{ key: 'scheme_power', area: 'scheme' }, 'area:scheme'], [{ key: 'diplomacy' }, 'skills'], [{ key: 'scheme_secrecy' }, 'schemes'], [{ key: 'x', area: 'not_an_area' }, 'other']];

        for (const [m, want] of groups)
            if (modGroupOf(m) !== want)
                (console.log(`MENUS modGroupOf(${JSON.stringify(m)}): ${modGroupOf(m)}`), bad++);

        // (a scheme's block: the themed group of a general modifier it uses, the Schemes area, no character-only one)
        const s = startStates('modifier', 'scheme', undefined, undefined, undefined, undefined, undefined, undefined, undefined, { modScope: 'scheme' })[0].state;
        const root = menuOf(s, data).items.map((i) => i.label);

        if (root.join(' | ') !== 'Prestige, piety & renown… | Schemes… | All scheme modifiers… | Every modifier…')
            (console.log(`MENUS scheme root: ${root.join(' | ')}`), bad++);
    }

    // (if / else: no part starts at an else; a written member of a chain is not wrapped, nothing goes after an if its else follows)
    {
        const labels = (req: Req, path: Step[]): string[] =>
        {
            let s = startStates(req.kind, scopeOf(req.scope), undefined, undefined, req.edit, undefined, undefined, undefined, undefined, { elseAfter: req.elseAfter }).at(-1)!.state;

            for (const p of path)
                s = (choose(s, p) as { state: State; }).state;

            return menuOf(s, data).items.map((i) => i.label);
        };
        const parts = labels({ kind: 'effect' }, [...gold, 'When…', T, 'Adult', 'Back to the effects', 'Otherwise…', ...prestige, 'Back out', 'And also…', ON, E, 'You (self)', 'Add…', 'Piety', { n: 5 }, 'When…']);
        const ifHead = labels({ kind: 'effect', edit: 'if = { limit = { is_adult = yes } add_gold = 5 }', elseAfter: true }, []);
        const ifNext = labels({ kind: 'effect', edit: 'if = { limit = { is_adult = yes } add_gold = 5 }', elseAfter: true }, ['What next…']);
        const elseNext = labels({ kind: 'effect', edit: 'else = { add_gold = 5 }' }, ['What next…']);

        if (parts.some((l) => /else/.test(l)) || parts.length !== 2)
            (console.log(`MENUS if/else parts: ${parts.join(' | ')}`), bad++);

        if (ifHead.some((l) => l.startsWith('Always')) || ifNext.some((l) => ['When…', 'Chance…', 'Hidden (no tooltip)', 'And also…', 'Otherwise…', 'One of several outcomes…'].includes(l)) || !ifNext.includes('Otherwise, when…'))
            (console.log(`MENUS an if its else follows: ${ifHead.join(' | ')} // ${ifNext.join(' | ')}`), bad++);

        if (elseNext.some((l) => ['When…', 'Chance…', 'Hidden (no tooltip)', 'One of several outcomes…'].includes(l)) || !elseNext.includes('And also…'))
            (console.log(`MENUS an else: ${elseNext.join(' | ')}`), bad++);
    }

    // (script the picker would print otherwise opens the script editor; comments inside are read past since round 13,
    // the Change path keeps them: the comments section below)
    {
        const cases: [string, 'effect' | 'trigger', boolean][] = [
            ['add_character_modifier = {\n\tmodifier = my_modifier # the reward\n\tyears = 5\n\tdesc = my_desc\n}', 'effect', true],
            ['NOT = {\n\t# only the brave\n\thas_trait = brave\n}', 'trigger', true],
            ['if = { limit = { always = yes } add_gold = @[x + 1] }', 'effect', false],
            ['if = { limit = { always = yes } color = hsv { 0.1 0.2 0.3 } }', 'effect', false],
            ['if = { limit = { always = yes } custom_tooltip = "50 # of them" }', 'effect', true],
            ['add_character_modifier = { modifier = my_modifier years = 5 desc = my_desc }', 'effect', true],
            ['NOT = { has_trait = brave }', 'trigger', true]
        ];

        // (another list: only lists of the same kind of items)
        let st = startStates('effect', 'character', undefined, undefined, 'every_child = { add_gold = 5 }').at(-1)!.state;
        st = (choose(st, 'Another list…') as { state: State; }).state;
        const lists = menuOf(st, data).items.map((i) => i.label);
        const others = menuOf(st, data).items.filter((i) => ITERATORS.find((x) => 'every_' + x.list === i.hint)?.to !== 'character').map((i) => i.label);

        if (others.length || !lists.includes('Every vassal'))
            (console.log(`MENUS another list: ${lists.join(' | ')}`), bad++);

        // (a scope type the catalog has no statements for yet, like a struggle: the list's key is in the chain, the key scan's "Other…" is offered)
        let sg = startStates('trigger', 'character').at(-1)!.state;

        for (const row of ['Any of their…', 'Any struggle…', 'Interloper'])
            sg = (choose(sg, row) as { state: State; }).state;

        const step = sg.chain.at(-1);

        if (step?.to !== 'struggle' || JSON.stringify(step.params) !== '[["involvement","interloper"]]' || !menuOf(sg, data).items.some((i) => i.label === 'Other condition…'))
            (console.log(`MENUS struggle list: ${JSON.stringify(step)}`), bad++);

        for (const [text, kind, want] of cases)
            if (canPickEdit(kind, text) !== want)
                (console.log(`MENUS canPickEdit ${JSON.stringify(text)}: ${!want}`), bad++);

        // (the hostility sets read like the card's lines)
        for (const [type, key, value, want] of [['hostility_levels', 'same_family', 'evil', 'Faiths of the same religion family are seen as Evil'], ['hostility_level_override', 'tenet_x', 'astray', 'Faiths with tenet x are seen as Astray'], ['special_parameters', 'same_hof_hostility_override', 'righteous', 'Faiths sharing its head of faith are seen as Righteous']])
            if (fieldText(type, key, value)?.text !== want)
                (console.log(`MENUS fieldText ${type} ${key} = ${value}: ${fieldText(type, key, value)?.text}`), bad++);

        // (a field set's written lines the picker changes: a bare doctrine parameter; a hostility level; not a block of them)
        for (const [text, type, want] of [['doctrine_polygamy', 'doctrine_parameters', true], ['doctrine_polygamy = yes', 'doctrine_parameters', true], ['same_family = hostile', 'hostility_levels', true], ['muhammad_succession_sunni_doctrine = astray', 'hostility_level_override', true], ['same_hof_hostility_override = righteous', 'special_parameters', true], ['doctrine_polygamy', 'religion/doctrine_types', false]] as [string, string, boolean][])
            if (canPickEdit('field', text, type) !== want)
                (console.log(`MENUS canPickEdit field ${type} ${JSON.stringify(text)}: ${!want}`), bad++);
    }

    // --- round 13 (P3 stage B): written statements with comments. The picker opens on them (canPickEdit), its result goes
    // through the Change path's keepWritten (InPlaceEdit.tsx): a comment next to a statement it kept or changed stays,
    // one next to a statement it removed goes with it (`gone`: main's note names it), one inside a statement it
    // replaced by another opens the script editor (null)
    {
        const cases: [string, Req, Step[], string | null, string[]][] = [
            [
                'an if, another condition: every comment stays',
                { kind: 'effect', edit: 'if = {\n\t# grown-ups only\n\tlimit = { is_adult = yes } # the age\n\t# the reward\n\tadd_gold = 5 # five\n}' },
                ['Another condition…', T, 'Male', 'Done'],
                'if = {\n\t# grown-ups only\n\tlimit = { is_adult = yes is_male = yes } # the age\n\t# the reward\n\tadd_gold = 5 # five\n}',
                []
            ],
            [
                'a nested block, a field removed: its comments go with it, the others stay',
                { kind: 'effect', edit: 'create_character = {\n\tage = 16\n\tinner = {\n\t\tx = 1\n\t\t# why y\n\t\ty = yes # yes\n\t}\n\tgender = male # the sex\n}' },
                ['inner', 'y', 'Remove this field', 'Done with inner', 'Done'],
                'create_character = {\n\tage = 16\n\tinner = {\n\t\tx = 1\n\t}\n\tgender = male # the sex\n}',
                ['# why y', '# yes']
            ],
            [
                'an opinion with years changed: the comment inside on a kept field stays',
                { kind: 'effect', edit: 'add_opinion = {\n\ttarget = root # who\n\tmodifier = respect_opinion\n\topinion = 30\n\tyears = 5\n}' },
                ['Keep', 'Keep', 'Keep', '10 years', 'Done'],
                'add_opinion = {\n\ttarget = root # who\n\tmodifier = respect_opinion\n\topinion = 30\n\tyears = 10\n}',
                []
            ],
            [
                'an iterator on another list (another head): a comment inside, the script editor',
                { kind: 'effect', edit: 'every_child = {\n\t# pay them\n\tadd_gold = 5\n}' },
                ['Another list…', 'Every vassal', 'Done'],
                null,
                []
            ],
            [
                'an if made unconditional (replaced by its effect): a comment inside, the script editor',
                { kind: 'field', type: 'script_value', edit: 'if = {\n\tlimit = { is_adult = yes } # adults\n\tadd = 5\n}' },
                ['Always — without its conditions', 'Done'],
                null,
                []
            ]
        ];

        for (const [what, req, path, want, wantGone] of cases)
        {
            if (!canPickEdit(req.kind, req.edit!, req.type))
            {
                console.log(`MENUS comments, ${what}: canPickEdit says the script editor`);
                bad++;
                continue;
            }

            const got = keepWritten(req.edit!, run(req, path));

            if (got.text !== want || got.gone.join('\n') !== wantGone.join('\n'))
                (console.log(`MENUS comments, ${what}: ${JSON.stringify(got)}`), bad++);
        }

        // (a statement whose comment holds a quote or a brace reads the same; inline maths still opens the script editor)
        for (const [text, want] of [['NOT = {\n\thas_trait = brave # "the { brave\n}', true], ['if = {\n\tlimit = { always = yes } # x\n\tadd_gold = @[x + 1]\n}', false]] as [string, boolean][])
            if (canPickEdit(text.startsWith('NOT') ? 'trigger' : 'effect', text) !== want)
                (console.log(`MENUS comments, canPickEdit ${JSON.stringify(text)}: ${!want}`), bad++);

        console.log(`comments: ${cases.length} picker walks through keepWritten and 2 canPickEdit cases checked`);
    }

    // (round 13 lane F3: "Give a title to someone" writes the game's create / change / resolve triple, the shape vanilla
    // 1.20.1.2 writes (docs/picker.md); the change's name avoids one in reach and one the draft saves; a holder relative to
    // the subject is written through prev inside the title's block; `+` selects the "＋ New …" row)
    {
        // (failures and cases of their own: the menus line counts the scenarios list only)
        let f3bad = 0;
        let f3n = 0;
        const give = [ON, E, 'You (self)', 'Do…', 'Give a title to someone'];
        const walk = (path: Step[], targets?: State['targets'], edit?: string): string =>
        {
            let s = startStates('effect', 'character', undefined, undefined, edit).at(-1)!.state;

            if (targets)
                s = { ...s, targets, targetsKnown: true };

            for (const p of path)
            {
                const n = choose(s, p);

                if ('finish' in n)
                    return resultText(n.state ?? s);

                s = n.state;
            }

            return resultText(s);
        };
        const triple = (type: string, name: string, title: string, holder: string, claim = '', baronies = ''): string =>
            `create_title_and_vassal_change = { type = ${type} save_scope_as = ${name}${claim ? ' add_claim_on_loss = ' + claim : ''} }\n${title} = {\n\tchange_title_holder = { holder = ${holder} change = scope:${name}${baronies ? ' take_baronies = ' + baronies : ''} }\n}\nresolve_title_and_vassal_change = scope:${name}`;
        const cases: [string, Step[], State['targets'], string][] = [
            ['granted, root, no claim', [...give, { input: 'k_france' }, 'Root', 'Granted', 'No claim', 'Not written'], undefined, triple('granted', 'change', 'title:k_france', 'root', 'no')],
            ['usurped, themselves, with baronies, `change` in reach', [...give, 'Root’s primary title', 'You (yourself)', 'Usurped', 'Not written', 'Take them too'], [{ key: 'scope:change', label: 'Change' }], triple('usurped', 'change_2', 'root.primary_title', 'prev', '', 'yes')],
            ['a liege (relative to the subject) through prev; change and change_2 taken', [...give, 'Liege’s primary title', 'Your liege', 'Conquest', 'Keeps a claim', 'Their holders become vassals'], [{ key: 'scope:change', label: 'Change' }, { key: 'scope:change_2', label: 'Change 2' }], triple('conquest', 'change_3', 'liege.primary_title', 'prev.liege', 'yes', 'no')],
            ['a second title in a row gets change_2', [...give, { input: 'k_france' }, 'Root', 'Granted', 'Not written', 'Not written', 'And also…', ...give, { input: 'd_paris' }, 'Root', 'Returned', 'Not written', 'Not written'], undefined, triple('granted', 'change', 'title:k_france', 'root') + '\n' + triple('returned', 'change_2', 'title:d_paris', 'root')],
            ['through "Other effect…" and its key', ['Other effect…', 'create_title_and_vassal_change', 'Give a title to someone…', { input: 'k_france' }, 'Root', 'Granted', 'Not written', 'Not written'], undefined, triple('granted', 'change', 'title:k_france', 'root')]
        ];

        for (const [name, path, targets, want] of cases)
        {
            let got: string;

            f3n++;

            try
            {
                got = walk(path, targets);
            }
            catch (e)
            {
                got = 'ERROR ' + (e as Error).message;
            }

            // (the script, not where printScript breaks a long block into lines)
            if (got.replace(/\s+/g, ' ') !== want.replace(/\s+/g, ' '))
                (console.log(`MENUS give a title, ${name}:\n${got}\n  wanted:\n${want}`), f3bad++);
        }

        // (the change types: granted first, then by their use in vanilla)
        const types = (() =>
        {
            let s = startStates('effect', 'character').at(-1)!.state;

            for (const p of [...give, { input: 'k_france' }, 'Root'] as Step[])
                s = (choose(s, p) as { state: State; }).state;

            return menuOf(s, data).items.map((i) => i.hint).join(' ');
        })();

        f3n++;

        if (!types.startsWith('granted created conquest independency swear_fealty revoked usurped returned'))
            (console.log(`MENUS give a title, the change types: ${types}`), f3bad++);

        // (the holder helper and the name helper, alone; a written triple's parts stay what they are when changed)
        for (const [v, want] of [['root', 'root'], ['root.liege', 'root.liege'], ['scope:actor', 'scope:actor'], ['character:163110', 'character:163110'], ['this', 'prev'], ['liege', 'prev.liege'], ['this.liege', 'prev.liege'], ['prev', 'prev.prev'], ['var:x', 'prev.var:x'], ['‹who›', '‹who›'], ['$TARGET$', '$TARGET$'], ['$TARGET$.liege', '$TARGET$.liege']])
            if (f3n++, inPrev(v) !== want)
                (console.log(`MENUS inPrev(${v}): ${inPrev(v)}`), f3bad++);

        f3n++;

        if (findStatement('effect', 'create_title_and_vassal_change = { type = granted save_scope_as = change }', 'character')?.def.id === 'e.do.give_title')
            (console.log('MENUS a written create_title_and_vassal_change alone is read as the whole triple'), f3bad++);

        // (round 13 wave 10, P11r(a): a written triple read back as one statement: each triple the cases above write, with
        // the values the walk gave; every "Keep" row taken writes it again token-equal; a changed type changes only that)
        {
            const keepAll = (text: string, change?: [string, string]): string =>
            {
                let s = startStates('effect', 'character', undefined, undefined, text).at(-1)!.state;

                for (let i = 0; i < 8; i++)
                {
                    const m = menuOf(s, data);
                    const row = (change && m.title === change[0] ? m.items.find((x) => x.label === change[1]) : undefined) ?? m.items.find((x) => x.label.startsWith('Keep'));

                    if (!row?.go)
                        break;

                    const n = row.go();

                    if ('finish' in n)
                        return resultText(n.state ?? s);

                    s = n.state;
                }

                return resultText(s);
            };
            const one = (x: string): string => x.replace(/\s+/g, ' ').trim();
            const read: [string, Record<string, string>][] = [
                [triple('granted', 'change', 'title:k_france', 'root', 'no'), { title: 'title:k_france', holder: 'root', type: 'granted', claim: 'no', baronies: '', change: 'change' }],
                [triple('usurped', 'change_2', 'root.primary_title', 'prev', '', 'yes'), { title: 'root.primary_title', holder: 'this', type: 'usurped', claim: '', baronies: 'yes', change: 'change_2' }],
                [triple('conquest', 'change_3', 'liege.primary_title', 'prev.liege', 'yes', 'no'), { title: 'liege.primary_title', holder: 'liege', type: 'conquest', claim: 'yes', baronies: 'no', change: 'change_3' }],
                [triple('granted', 'change', 'title:k_france', 'root'), { title: 'title:k_france', holder: 'root', type: 'granted', claim: '', baronies: '', change: 'change' }],
                [triple('returned', 'change_2', 'title:d_paris', 'root'), { title: 'title:d_paris', holder: 'root', type: 'returned', claim: '', baronies: '', change: 'change_2' }]
            ];

            for (const [text, want] of read)
            {
                const found = findStatement('effect', text, 'character');
                const got = found ? Object.fromEntries(Object.keys(want).map((k) => [k, found.values[k]])) : null;

                if (f3n++, found?.def.id !== 'e.do.give_title' || JSON.stringify(got) !== JSON.stringify(want))
                    (console.log(`MENUS a written triple read back: ${found?.def.id} ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}\n${text}`), f3bad++);

                const again = keepAll(text);

                if (f3n++, one(again) !== one(text))
                    (console.log(`MENUS a written triple, every value kept:\n${again}\n  wanted:\n${text}`), f3bad++);
            }

            // (the type changed: only the type; a field the template has no place for (government_base) stays in its block)
            const gov = 'create_title_and_vassal_change = { type = granted save_scope_as = change_2 }\ntitle:k_france = {\n\tchange_title_holder = { holder = prev change = scope:change_2 government_base = root }\n}\nresolve_title_and_vassal_change = scope:change_2';
            const usurped = keepAll(gov, ['What kind of change?', 'Usurped']);

            if (f3n++, one(usurped) !== one(gov.replace('type = granted', 'type = usurped')))
                (console.log(`MENUS a written triple's type changed:\n${usurped}`), f3bad++);

            // (comments between the three: read the same, kept by the Change path's keepWritten, word for word)
            const commented = 'create_title_and_vassal_change = {\n\ttype = granted # kind\n\tsave_scope_as = change\n}\n# the title\ntitle:k_france = {\n\tchange_title_holder = { holder = root change = scope:change }\n}\n# and done\nresolve_title_and_vassal_change = scope:change # end';
            const keptC = keepWritten(commented, keepAll(commented), '\t');
            const keptU = keepWritten(commented, keepAll(commented, ['What kind of change?', 'Usurped']), '\t');

            if (f3n++, findStatement('effect', commented, 'character')?.def.id !== 'e.do.give_title' || keptC.text !== commented || keptU.text !== commented.replace('type = granted', 'type = usurped') || keptU.gone.length)
                (console.log(`MENUS a commented triple: ${JSON.stringify(keptC)} ${JSON.stringify(keptU)}`), f3bad++);

            // (not one statement: in another order, another statement between, a name that differs, a holder inPrev never writes)
            for (
                const [why, text] of [
                    ['another statement between', 'create_title_and_vassal_change = { type = granted save_scope_as = change }\nadd_gold = 5\ntitle:k_france = { change_title_holder = { holder = root change = scope:change } }\nresolve_title_and_vassal_change = scope:change'],
                    ['the resolve first', 'resolve_title_and_vassal_change = scope:change\ncreate_title_and_vassal_change = { type = granted save_scope_as = change }\ntitle:k_france = { change_title_holder = { holder = root change = scope:change } }'],
                    ['another name in the resolve', 'create_title_and_vassal_change = { type = granted save_scope_as = change }\ntitle:k_france = { change_title_holder = { holder = root change = scope:change } }\nresolve_title_and_vassal_change = scope:change_2'],
                    ['a holder inPrev never writes', 'create_title_and_vassal_change = { type = granted save_scope_as = change }\ntitle:k_france = { change_title_holder = { holder = liege change = scope:change } }\nresolve_title_and_vassal_change = scope:change']
                ]
            )
            {
                if (f3n++, findStatement('effect', text, 'character'))
                    (console.log(`MENUS not a triple (${why}) read as ${findStatement('effect', text, 'character')!.def.id}`), f3bad++);
            }

            // (the readable view: one line for the adjacent three, comments between them or not; statement by statement
            // with another statement between)
            const stub = new Proxy({}, { get: (_t, p) => (p === 'named' ? () => [] : () => undefined) }) as never;
            const dsc = new Describer(stub);
            const lines = (src: string): string[] =>
            {
                const ctx = { scope: 'you', when: [], hidden: false, followUps: [], expand: 2, stack: [], src, scopeType: 'character' };
                return dsc.effects(parse(src), ctx as never).map((l) => l.text.map((x) => (typeof x === 'string' ? x : x.text)).join(''));
            };

            for (
                const [src, want] of [
                    [triple('granted', 'change', 'title:k_france', 'prev.liege', 'no'), 'Gives K France to your liege (granted)'],
                    [commented, 'Gives K France to you (granted)'],
                    [triple('granted', 'change', 'title:k_france', 'root') + '\n' + triple('returned', 'change_2', 'title:d_paris', 'root'), 'Gives K France to you (granted) | Gives D Paris to you (returned)'],
                    ['create_title_and_vassal_change = { type = granted save_scope_as = change }\nadd_gold = 5\ntitle:k_france = { change_title_holder = { holder = root change = scope:change } }\nresolve_title_and_vassal_change = scope:change', '!Gives']
                ] as [string, string][]
            )
            {
                const got = lines(src).join(' | ');

                if (f3n++, want.startsWith('!') ? got.includes(want.slice(1)) : got !== want)
                    (console.log(`MENUS the readable line of ${JSON.stringify(src.slice(0, 80))}: ${got}`), f3bad++);
            }

            // (outOfPrev, the inverse of inPrev: every value inPrev writes comes back to one it writes the same way; the
            // picker's own values come back as they were; one inPrev never writes has none)
            for (const w of ['prev', 'prev.liege', 'prev.prev', 'prev.var:x', 'prev.prev.liege', 'root', 'root.liege', 'scope:actor', 'character:163110', '‹who›', '$TARGET$', '$TARGET$.liege'])
                if (f3n++, outOfPrev(w) === undefined || inPrev(outOfPrev(w)!) !== w)
                    (console.log(`MENUS outOfPrev(${w}): ${outOfPrev(w)} -> ${inPrev(outOfPrev(w) ?? '')}`), f3bad++);

            for (const x of ['this', 'liege', 'prev', 'var:x', 'prev.liege', 'root', 'root.liege', 'scope:actor', 'character:163110', '‹who›', '$TARGET$'])
                if (f3n++, outOfPrev(inPrev(x)) !== x)
                    (console.log(`MENUS outOfPrev(inPrev(${x})): ${outOfPrev(inPrev(x))}`), f3bad++);

            for (const w of ['liege', 'this', 'prev.root', 'prev.this.liege', 'prev.scope:x'])
                if (f3n++, outOfPrev(w) !== undefined)
                    (console.log(`MENUS outOfPrev(${w}) should have none: ${outOfPrev(w)}`), f3bad++);
        }

        // (`+`: with nothing typed, the explicit "＋ New …" row of a list whose labels hold `+`; typed after a filter; no such row)
        const row = (label: string, extra: Partial<Item> = {}): Item => ({ label, go: () => ({ finish: true }), ...extra });
        const rules: Menu = { title: 'Which option?', typeahead: true, items: [row('+1'), row('+2'), row('Normal'), row('＋ New option…', { explicit: true, match: '+ new option' })] };
        const r0 = rowsOf(rules, '', undefined);
        const typed = rowsOf(rules, '+', undefined);

        f3n++;

        if (r0[plusRow(r0, '')]?.item.label !== '＋ New option…' || plusRow(typed, '+') !== -1 || plusRow(rowsOf({ ...rules, items: rules.items.slice(0, 3) }, '', undefined), '') !== -1)
            (console.log(`MENUS the + key: ${plusRow(r0, '')} ${plusRow(typed, '+')}`), f3bad++);

        // (what it fixes: typed, `+` filters for "+1" and ⏎ took it)
        if (typed[firstSelectable(typed, true)]?.item.label !== '+1')
            console.log(`MENUS note: a typed + now selects ${typed[firstSelectable(typed, true)]?.item.label} (was +1)`);

        // (the change's name: a scope the entry saves out of reach at the place (picker/targets.ts awayTargets, passed by
        // start) is taken too, as one in reach is)
        const s0 = startStates('effect', 'character').at(-1)!.state;

        for (const [why, targets, away, want] of [
            ['`change` only out of reach', [], [{ key: 'scope:change' }], 'change_2'],
            ['`change` out of reach, `change_2` in reach', [{ key: 'scope:change_2', label: 'Change 2' }], [{ key: 'scope:change' }], 'change_3'],
            ['a title key out of reach is no scope name', [], [{ key: 'title:change' }], 'change']
        ] as [string, State['targets'], { key: string; }[], string][])
        {
            const got = freeScopeName({ ...s0, targets }, 'change', away);

            if (f3n++, got !== want)
                (console.log(`MENUS freeScopeName, ${why}: ${got}`), f3bad++);
        }

        // (the Do menu's keys: Give a title has its own (h), Start a story keeps a)
        {
            let s = s0;

            for (const p of [ON, E, 'You (self)', 'Do…'] as Step[])
                s = (choose(s, p) as { state: State; }).state;

            const keys = new Map(rowsOf(menuOf(s, data), '', undefined).map((r) => [r.item.label, r.key]));

            if (f3n++, keys.get('Give a title to someone') !== 'h' || keys.get('Start a story') !== 'a' || keys.get('Get a title') !== 'g')
                (console.log(`MENUS the Do menu's keys: ${[...keys].map(([l, k]) => k + ' ' + l).join(' | ')}`), f3bad++);
        }

        console.log(`F3 give a title / + key: ${f3bad ? f3bad + ' of ' + f3n + ' cases wrong' : f3n + ' cases ok'}`);
    }

    // (round 13 lane G2: every type without a curated set takes "Other setting…" (the keys its definitions write, the value
    // typed by what the game writes for it); curated sets of holy sites, council tasks, important actions, pulse actions;
    // block fields (`send_option`, a building's or a council task's `asset`); the two Host rows of "Who gets it?")
    {
        let g2bad = 0;
        let g2n = 0;
        const SUG: Record<string, { value: string; count: number; label: string; }[]> = {
            'keys:story_cycles': [{ value: 'my_flagged', count: 9, label: '9×' }, { value: 'my_count', count: 4, label: '4×' }],
            'values:story_cycles:my_flagged': [{ value: 'yes', count: 8, label: '8×' }, { value: 'no', count: 1, label: '1×' }],
            'values:story_cycles:my_count': [{ value: '3', count: 3, label: '3×' }, { value: '10', count: 1, label: '1×' }]
        };
        const dG2: PickerData = {
            ...data,
            list: (t) => (t === 'landed_titles' ? [entry('e_byzantium', 40, 'Byzantium'), entry('c_roma', 12, 'Roma'), entry('b_roma', 3, 'Roma (barony)')] : t === 'council_positions' ? [entry('councillor_steward', 5, 'Steward')] : t === 'traits' ? [entry('brave', 900, 'Brave'), entry('craven', 300, 'Craven')] : t === 'religion/rite_types' ? [entry('g2_rite', 2, 'G2 rite')] : data.list(t)),
            suggestions: (source) => SUG[source] ?? data.suggestions(source)
        };
        const walk = (req: Req, path: Step[]): string =>
        {
            let s = startStates(req.kind, scopeOf(req.scope), undefined, req.type, req.edit).at(-1)!.state;

            for (const p of path)
            {
                const m = menuOf(s, dG2);
                const item: Item | null | undefined = typeof p === 'string' ? (m.items.find((i) => i.label === p) ?? m.items.find((i) => i.label.startsWith(p))) : 'n' in p ? m.number?.(p.n, String(p.n))[0] : m.input?.(p.input);

                if (!item?.go)
                    throw new Error(`no row ${JSON.stringify(p)} in “${m.title}”: ${m.items.map((i) => i.label).join(' | ')}`);

                const n = item.go();

                if ('finish' in n)
                    return resultText(n.state ?? s);

                s = n.state;
            }

            return resultText(s);
        };
        const cases: [string, Req, Step[], string][] = [
            ['an open set without fields: a key the game writes, yes / no', { kind: 'field', type: 'story_cycles' }, ['Other setting…', 'my_flagged', 'Yes', 'Done'], 'my_flagged = yes'],
            ['an open set without fields: a number typed', { kind: 'field', type: 'story_cycles' }, ['Other setting…', 'my_count', { n: 7 }, 'Done'], 'my_count = 7'],
            ['an open set without fields: a key typed, a text with spaces quoted', { kind: 'field', type: 'story_cycles' }, ['Other setting…', { input: 'my_new' }, { input: 'two words' }, 'Done'], 'my_new = "two words"'],
            ['an open set: a written other key kept', { kind: 'field', type: 'story_cycles', edit: 'my_count = 3' }, ['Keep: 3', 'Done'], 'my_count = 3'],
            ['an open set: a written other key changed', { kind: 'field', type: 'story_cycles', edit: 'my_count = 3' }, [{ n: 10 }, 'Done'], 'my_count = 10'],
            ['a holy site’s county', { kind: 'field', type: 'religion/holy_site_types' }, ['County…', 'Roma', 'Done'], 'county = c_roma'],
            ['a holy site: another setting', { kind: 'field', type: 'religion/holy_site_types' }, ['Other setting…', { input: 'is_active' }, 'Yes', 'Done'], 'is_active = yes'],
            ['a council task’s kind', { kind: 'field', type: 'council_tasks' }, ['Kind…', 'On a county', 'Done'], 'task_type = task_type_county'],
            ['a council task’s position', { kind: 'field', type: 'council_tasks' }, ['Council position…', 'Steward', 'Done'], 'position = councillor_steward'],
            ['an important action’s kind', { kind: 'field', type: 'important_actions' }, ['Kind…', 'An icon of its own', 'Done'], 'type = alert'],
            ['a send option (its flag asked first, then its label)', { kind: 'field', type: 'character_interactions' }, ['Send option…', { input: 'g2_gold' }, 'Label…', { input: 'G2_SPEND_GOLD' }, 'Done', 'Done'], 'send_option = { flag = g2_gold localization = G2_SPEND_GOLD }'],
            ['a written send option changed', { kind: 'field', type: 'character_interactions', edit: 'send_option = { flag = gold localization = GENERIC_SPEND_GOLD }' }, ['Can block sending', 'Done', 'Done'], 'send_option = { flag = gold localization = GENERIC_SPEND_GOLD can_invalidate_interaction = yes }'],
            // (wave 8: a send option with conditions inside: the block step changes its fields, the conditions stay as
            // written; "Clear the conditions" drops them)
            ['a written send option with conditions: a field changed, the conditions kept', { kind: 'field', type: 'character_interactions', edit: 'send_option = { is_shown = { scope:actor = { gold > 10 } } flag = gold }' }, ['Can block sending', 'Done', 'Done'], 'send_option = { is_shown = { scope:actor = { gold > 10 } } flag = gold can_invalidate_interaction = yes }'],
            ['a written send option with conditions: the conditions cleared', { kind: 'field', type: 'character_interactions', edit: 'send_option = { is_shown = { scope:actor = { gold > 10 } } flag = gold }' }, ['Clear the conditions', 'Done', 'Done'], 'send_option = { flag = gold }'],
            ['a council task’s picture', { kind: 'field', type: 'council_tasks' }, ['Picture…', 'Icon…', { input: '"gfx/x.dds"' }, 'Done', 'Done'], 'asset = { icon = "gfx/x.dds" }'],
            ['a building’s asset (its kind asked first)', { kind: 'field', type: 'buildings' }, ['Map asset…', 'Mesh', 'Mesh or entity name…', { input: 'g2 mesh 01' }, 'Done', 'Done'], 'asset = { type = pdxmesh name = "g2 mesh 01" }'],
            // (typed texts kept whole: an event path quoted with its slashes, a script constant bare)
            ['an important action’s sound typed (an event path)', { kind: 'field', type: 'important_actions' }, ['Sound…', { input: '"event:/SFX/UI/Notifications/TopBar/sfx_x"' }, 'Done'], 'soundeffect = "event:/SFX/UI/Notifications/TopBar/sfx_x"'],
            ['a building asset’s sound typed (an event path)', { kind: 'field', type: 'buildings' }, ['Map asset…', 'Mesh', 'Sound…', { input: 'event:/SFX/Ambience/g2_x' }, 'Done', 'Done'], 'asset = { type = pdxmesh soundeffect = "event:/SFX/Ambience/g2_x" }'],
            ['a building asset’s illustration typed as a constant', { kind: 'field', type: 'buildings' }, ['Map asset…', 'Mesh', 'Illustration…', { input: '@holding_illustration_norse' }, 'Done', 'Done'], 'asset = { type = pdxmesh illustration = @holding_illustration_norse }'],
            // (a character's dated history line: a field of character_life)
            ['a life line changed (trait = brave)', { kind: 'field', type: 'character_life', edit: 'trait = brave' }, ['Craven', 'Done'], 'trait = craven'],
            ['a life line: a rite', { kind: 'field', type: 'character_life' }, ['Rite…', 'G2 rite', 'Done'], 'rite = g2_rite']
        ];

        for (const [name, req, path, want] of cases)
        {
            let got: string;
            g2n++;

            try
            {
                got = walk(req, path);
            }
            catch (e)
            {
                got = 'ERROR ' + (e as Error).message;
            }

            if (got.replace(/\s+/g, ' ') !== want.replace(/\s+/g, ' '))
                (console.log(`MENUS G2 ${name}:\n${got}\n  wanted:\n${want}`), g2bad++);
        }

        // (wave 8, edit-coverage's send_option: 1.20's adopt_interaction option (00_adoption.txt:160), its comments after
        // `{` and on their own lines inside the kept conditions: a field changed, keepWritten gives the text as written
        // with the new field, every comment where it was)
        {
            const T = String.fromCharCode(9);
            const written = [
                'send_option = { # EP3 Influence',
                T + 'is_shown = { # Actor must have a government that uses influence ',
                T + T + 'scope:actor = {',
                T + T + T + 'government_has_flag = government_has_influence',
                T + T + '}',
                T + '}',
                T + 'is_valid = {',
                T + T + '# Actor has enough influence',
                T + T + 'scope:actor = { influence >= medium_influence_value }',
                T + T + '# Both characters are within the same top realm',
                T + T + 'scope:recipient.top_liege = scope:actor.top_liege',
                T + '}',
                T + 'flag = influence_send_option',
                T + 'localization = TRADE_INFLUENCE_FOR_BETTER_AI_ACCEPTANCE',
                '}'
            ];
            const want = [...written.slice(0, -1), T + 'can_invalidate_interaction = yes', '}'].join('\n');
            let got: string | null;

            try
            {
                got = canPickEdit('field', written.join('\n'), 'character_interactions') ? keepWritten(written.join('\n'), walk({ kind: 'field', type: 'character_interactions', edit: written.join('\n') }, ['Can block sending', 'Done', 'Done']), T).text : 'canPickEdit false';
            }
            catch (e)
            {
                got = 'ERROR ' + (e as Error).message;
            }

            if (g2n++, got !== want)
                (console.log(`MENUS G2 the adoption send option's comments:\n${got}\n  wanted:\n${want}`), g2bad++);
        }

        // (the root of a set without fields: "Other setting…" alone; a block's set (a cost) has none; a card builder's
        // curated set has it since lane H1, checked there)
        const rootLabels = (type: string): string[] => menuOf(startStates('field', 'character', undefined, type).at(-1)!.state, dG2).items.map((i) => i.label);

        if (g2n++, rootLabels('story_cycles').join(' | ') !== 'Other setting…')
            (console.log(`MENUS G2 the root of story_cycles: ${rootLabels('story_cycles').join(' | ')}`), g2bad++);

        if (g2n++, rootLabels('cost').includes('Other setting…') || !rootLabels('council_tasks').includes('Other setting…'))
            (console.log(`MENUS G2 Other setting in cost / council_tasks: ${rootLabels('cost').includes('Other setting…')} / ${rootLabels('council_tasks').includes('Other setting…')}`), g2bad++);

        // (a holy site's county and barony list only counties and baronies)
        {
            const rows = (field: string): string[] =>
            {
                const s = startStates('field', 'character', undefined, 'religion/holy_site_types').at(-1)!.state;
                const n = menuOf(s, dG2).items.find((i) => i.label === field)!.go!() as { state: State; };
                return menuOf(n.state, dG2).items.filter((i) => i.entry).map((i) => i.entry!.name);
            };

            if (g2n++, rows('County…').join(' ') !== 'c_roma' || rows('Barony…').join(' ') !== 'b_roma')
                (console.log(`MENUS G2 holy site rows: County ${rows('County…').join(' ')} / Barony ${rows('Barony…').join(' ')}`), g2bad++);
        }

        // (canPickEdit for an open set: any `key = value`; a block field it can take apart, also with conditions inside
        // (kept as written, round 13 wave 8), a list of bare values or a field written as a block (wave 10))
        for (const [text, type, want] of [
            ['trait = brave', 'character_life', true],
            ['rite = g2_rite', 'character_life', true],
            ['death = { death_reason = death_battle }', 'character_life', false],
            ['my_key = some_value', 'story_cycles', true],
            ['my_key = { a = b }', 'story_cycles', false],
            ['ai_value = 5', 'buildings', true],
            ['county = c_roma', 'religion/holy_site_types', true],
            ['unknown_cost_key = 5', 'cost', false],
            ['send_option = { flag = gold localization = GENERIC_SPEND_GOLD }', 'character_interactions', true],
            ['send_option = { flag = gold starts_enabled = { always = yes } }', 'character_interactions', true],
            ['send_option = { # a comment\n\tis_shown = { # another\n\t\tscope:actor = { gold > 10 }\n\t}\n\tflag = gold\n}', 'character_interactions', true],
            // (wave 10, lane U: a list of bare values, a field written as a block and an unknown key are kept as written;
            // a block mixing statements and bare values is not)
            ['send_option = { flag = gold is_shown = { a b } }', 'character_interactions', true],
            ['send_option = { flag = { x = y } }', 'character_interactions', true],
            ['send_option = { flag = gold is_shown = { a = b c } }', 'character_interactions', false],
            ['asset = { type = pdxmesh name = x graphical_regions = { a b } }', 'buildings', true],
            ['asset = { trigger = { always = yes } icon = "x.dds" }', 'council_tasks', true],
            ['asset = { icon = "x.dds" glow = "y.dds" }', 'council_tasks', true]
        ] as [string, string, boolean][])
            if (g2n++, canPickEdit('field', text, type) !== want)
                (console.log(`MENUS G2 canPickEdit(field, ${JSON.stringify(text)}, ${type}): ${!want}`), g2bad++);

        // (what an other key takes, read from the game's values)
        for (const [values, want] of [
            [['yes', 'no'], 'bool'],
            [['3', '10', '0.5'], 'number'],
            [['3', '10', 'slow_value'], 'number'],
            [['"gfx/a.dds"', '"gfx/b.dds"'], 'quoted'],
            [['flag_a', '"x"'], 'name'],
            [[], 'unknown']
        ] as [string[], string][])
            if (g2n++, valueKindOf(values) !== want)
                (console.log(`MENUS G2 valueKindOf(${values.join(',')}): ${valueKindOf(values)}`), g2bad++);

        // ("Who gets it?": the link `host` (a character's host) and the saved scope:host (an activity's) are both offered,
        // told apart by their labels: the link's says whose, "Your host")
        {
            let s = startStates('effect', 'character').at(-1)!.state;

            for (const p of [ON, E, 'You (self)', 'Do…', 'Give a title to someone', { input: 'k_france' }] as Step[])
                s = (choose(s, p) as { state: State; }).state;

            const rows = menuOf(s, data).items.filter((i) => i.hint === 'host' || i.hint === 'scope:host').map((i) => `${i.label} [${i.hint}]`);
            const labels = menuOf(s, data).items.map((i) => i.label);
            const twice = labels.filter((l, i) => labels.indexOf(l) !== i);

            if (g2n++, rows.join(' | ') !== 'Your host [host] | Host [scope:host]' || twice.length)
                (console.log(`MENUS G2 Who gets it?: ${rows.join(' | ')}; twice: ${twice.join(', ')}`), g2bad++);
        }

        // (a character's Life section, built over a made-up game folder in TEMP: a history line written in a dated block is
        // anchored as a field of character_life, an `effect = { … }` keeps its effects' own anchors, the date line's
        // "＋ on this date" carries the date)
        {
            const dir = mkdtempSync(join(tmpdir(), 'ckp-g2-life-'));

            try
            {
                const rel = join(dir, 'game', 'history', 'characters');
                mkdirSync(rel, { recursive: true });
                writeFileSync(join(rel, 'g2.txt'), 'g2_900001 = {\n\tname = "Testa"\n\t1040.1.1 = {\n\t\tbirth = yes\n\t}\n\t1066.1.1 = {\n\t\ttrait = brave\n\t\tdeath = yes\n\t\teffect = {\n\t\t\tadd_gold = 5\n\t\t}\n\t}\n}\n');
                const idx = new GameIndex(new GameFiles(join(dir, 'game'), []), 'english');
                idx.build();
                const e = idx.get('characters', 'g2_900001');
                const life = e ? new StoryBuilder(idx).card(e).sections.find((x) => x.title === 'Life') : undefined;
                const day = life?.lines.find((l) => l.text.some((t) => typeof t !== 'string' && t.text === '1066.1.1'));
                const kids: Line[] = [];
                const walkLines = (ls: Line[] | undefined): void => ls?.forEach((l) => (kids.push(l), walkLines(l.children)));
                walkLines(day?.children);
                const fieldLines = kids.filter((l) => l.src?.kind === 'field' && l.src.fields === 'character_life');
                const effectLines = kids.filter((l) => l.src?.kind === 'effect');
                const act = day?.act?.do as { kind?: string; date?: string; } | undefined;
                const got = `field lines ${fieldLines.length} (${fieldLines.map((l) => l.src!.e - l.src!.s).join(',')}), effect lines ${effectLines.length}, act ${act?.kind} ${act?.date}`;

                // (trait = brave and death = yes: 13 and 11 characters; add_gold = 5 inside effect = { … }: an effect line)
                if (g2n++, got !== 'field lines 2 (13,11), effect lines 1, act life 1066.1.1')
                    (console.log(`MENUS G2 life lines: ${got}; lines: ${JSON.stringify(day ?? life ?? null).slice(0, 600)}`), g2bad++);
            }
            catch (err)
            {
                console.log(`MENUS G2 life lines: ERROR ${(err as Error).message}`);
                g2n++, g2bad++;
            }
            finally
            {
                rmSync(dir, { recursive: true, force: true });
            }
        }

        console.log(`G2 field catalog: ${g2bad ? g2bad + ' of ' + g2n + ' cases wrong' : g2n + ' cases ok'}`);
    }

    // (round 13 lane H1: "Other setting…" also for the types with a card builder of their own: their curated sets
    // (CARD_SETS) and the ones without a set; their cards show the written keys they do not read as field lines)
    {
        let h1bad = 0;
        let h1n = 0;
        const bad = (what: string): void => (console.log(`MENUS H1 ${what}`), void h1bad++);
        // (CARD_SETS = the builder types with a curated set that is not open already)
        const want = Object.keys(TYPE_CARDS).filter((t) => FIELDS[t] && !OPEN_SETS.has(t)).sort();
        const have = [...CARD_SETS].sort();

        if (h1n++, want.join(' ') !== have.join(' '))
            bad(`CARD_SETS: missing ${want.filter((t) => !CARD_SETS.has(t)).join(' ')}; extra ${have.filter((t) => !want.includes(t)).join(' ')}`);

        // (a law's root: its fields in catalog order, then "Other setting…"; an accolade type's (no set): that alone)
        const rootLabels = (type: string): string[] => menuOf(startStates('field', 'character', undefined, type).at(-1)!.state, data).items.map((i) => i.label);
        const law = rootLabels('laws');

        if (h1n++, law.join(' | ') !== [...FIELDS.laws.map((f) => f.label), 'Other setting…'].join(' | '))
            bad(`the root of laws: ${law.join(' | ')}`);

        if (h1n++, rootLabels('accolade_types').join(' | ') !== 'Other setting…')
            bad(`the root of accolade_types: ${rootLabels('accolade_types').join(' | ')}`);

        for (const [text, type, ok] of [
            ['h1_unknown = 5', 'laws', true],
            ['h1_unknown = yes', 'accolade_types', true],
            ['h1_unknown = { a = b }', 'laws', false],
            ['h1_unknown = 5', 'cost', false]
        ] as [string, string, boolean][])
            if (h1n++, canPickEdit('field', text, type) !== ok)
                bad(`canPickEdit(field, ${JSON.stringify(text)}, ${type}): ${!ok}`);

        // (a law's other key, through "Other setting…": typed key, then its value)
        {
            let s = startStates('field', 'character', undefined, 'laws').at(-1)!.state;

            try
            {
                for (const p of ['Other setting…', { input: 'h1_other' }, { input: '7' }] as Step[])
                {
                    const m = menuOf(s, data);
                    const item = typeof p === 'string' ? m.items.find((i) => i.label === p) : 'input' in p ? (m.number?.(Number(p.input), p.input)[0] ?? m.input?.(p.input)) : undefined;
                    const n = item!.go!();

                    if ('finish' in n)
                    {
                        s = n.state ?? s;
                        break;
                    }

                    s = n.state;
                }
            }
            catch (err)
            {
                bad(`law Other setting walk: ${(err as Error).message}`);
            }

            if (h1n++, resultText(s).trim() !== 'h1_other = 7')
                bad(`law Other setting walk: ${JSON.stringify(resultText(s))}`);
        }

        // (cards over a made-up game folder in TEMP: an accolade type and a law with keys their builders do not read get
        // them as field lines of their type's set; an accolade type with none gets no Settings section (a game entry))
        {
            const dir = mkdtempSync(join(tmpdir(), 'ckp-h1-cards-'));

            try
            {
                const game = join(dir, 'game');
                const put = (rel: string, text: string): void => (mkdirSync(join(game, rel, '..'), { recursive: true }), writeFileSync(join(game, rel), text));
                put('common/accolade_types/h1.txt', 'h1_accolade = {\n\tadjective = h1_adj\n\th1_unknown_key = 5\n\taccolade_categories = { common }\n}\nh1_plain = {\n\tadjective = h1_adj\n}\n');
                put('common/law_groups/h1.txt', 'h1_group = {\n\tdefault = h1_law\n}\n');
                put('common/laws/h1.txt', 'h1_law = {\n\tlaw_group_type = h1_group\n\th1_law_key = yes\n\tflag = realm_law\n}\n');
                const idx = new GameIndex(new GameFiles(game, []), 'english');
                idx.build();
                const sb = new StoryBuilder(idx);
                const lines = (type: string, name: string): string =>
                {
                    const e = idx.get(type, name);
                    const card = e ? sb.card(e) : undefined;
                    return card ? card.sections.flatMap((x) => x.lines.filter((l) => l.src?.kind === 'field' && l.src.fields === type && /^h1_/.test(l.tip ?? '')).map((l) => `${x.title}: ${l.tip}`)).join(', ') : 'no card';
                };
                const titles = (type: string, name: string): string =>
                {
                    const e = idx.get(type, name);
                    return e ? sb.card(e).sections.map((x) => x.title).join(', ') : 'no card';
                };

                if (h1n++, lines('accolade_types', 'h1_accolade') !== 'Settings: h1_unknown_key')
                    bad(`accolade card: ${lines('accolade_types', 'h1_accolade')} (sections ${titles('accolade_types', 'h1_accolade')})`);

                if (h1n++, titles('accolade_types', 'h1_plain').includes('Settings'))
                    bad(`accolade without other keys: ${titles('accolade_types', 'h1_plain')}`);

                if (h1n++, lines('laws', 'h1_law') !== 'Rules: h1_law_key = yes')
                    bad(`law card: ${lines('laws', 'h1_law')} (sections ${titles('laws', 'h1_law')})`);

                // (the pass off: the accolade's card without its line, the rest the same)
                const e = idx.get('accolade_types', 'h1_accolade')!;
                const withKeys = JSON.stringify(sb.card(e).sections.filter((x) => x.title !== 'Settings'));
                sb.unknownKeys = false;
                const without = sb.card(e);
                sb.unknownKeys = true;

                if (h1n++, withKeys !== JSON.stringify(without.sections) || without.sections.some((x) => x.title === 'Settings'))
                    bad(`accolade card without the pass differs beyond its Settings`);

                // (H1 review fixes: a 1.20 faith's unknown key goes into its Settings section anchored in faith_details,
                // not a second one; a mod's own entry gets the empty Settings only as a keyed block of a type with top-level
                // settings: not a name list, not a faith or religion that has its Settings in its details block)
                put('common/religion/religion_types/h1.txt', 'h1_rel = {\n\tfamily = rf_pagan\n\treligion_details = {\n\t\tgraphical_faith = pagan_gfx\n\t}\n}\n');
                put('common/religion/faith_types/h1.txt', 'h1_faith = {\n\thistorical = yes\n\tfaith_details = {\n\t\treligion = h1_rel\n\t\ticon = h1\n\t}\n}\n');
                const modRoot = join(dir, 'mod');
                const putMod = (rel: string, text: string): void => (mkdirSync(join(modRoot, rel, '..'), { recursive: true }), writeFileSync(join(modRoot, rel), text));
                putMod('common/culture/name_equivalency/h1.txt', 'h1_male = { Hone Htwo }\n');
                putMod('common/religion/religion_types/h1m.txt', 'h1_mrel = {\n\tfamily = rf_pagan\n\treligion_details = {\n\t\tgraphical_faith = pagan_gfx\n\t}\n}\n');
                putMod('common/religion/faith_types/h1m.txt', 'h1_mfaith = {\n\tfaith_details = {\n\t\treligion = h1_mrel\n\t\ticon = h1\n\t}\n}\n');
                putMod('common/accolade_types/h1m.txt', 'h1_maccolade = {\n\tadjective = h1_adj\n}\n');
                const mod: ModInfo = { id: 'mod/h1_test.mod', name: 'H1 Test', tags: [], root: modRoot, source: 'local', replacePaths: [], status: 'ok', editable: true };
                const midx = new GameIndex(new GameFiles(game, [mod]), 'english');
                midx.build();
                const msb = new StoryBuilder(midx);
                const settingsOf = (i: GameIndex, s: StoryBuilder, type: string, name: string): string =>
                {
                    const x = i.get(type, name);
                    return x ? s.card(x).sections.filter((c) => c.title === 'Settings').map((c) => `[${c.src?.src?.fields ?? c.src?.parent?.fields ?? '?'}: ${c.lines.map((l) => (l.src?.kind === 'field' ? l.src.fields : '-')).join(' ')}]`).join(' ') : 'no card';
                };
                const faithSettings = settingsOf(midx, msb, 'faith', 'h1_faith');

                if (h1n++, (faithSettings.match(/\[/g) ?? []).length !== 1 || !/ faith\]$/.test(faithSettings))
                    bad(`1.20 faith with historical: Settings sections ${faithSettings}`);

                for (const [type, name, want] of [
                    ['culture/name_equivalency', 'h1_male', 0],
                    ['faith', 'h1_mfaith', 1],
                    ['religion/religion_types', 'h1_mrel', 1],
                    ['accolade_types', 'h1_maccolade', 1]
                ] as [string, string, number][])
                {
                    const got = settingsOf(midx, msb, type, name);

                    if (h1n++, (got.match(/\[/g) ?? []).length !== want)
                        bad(`mod's ${type}:${name}: Settings sections ${got || 'none'} (want ${want})`);
                }
            }
            catch (err)
            {
                bad(`cards: ERROR ${(err as Error).message}`);
            }
            finally
            {
                rmSync(dir, { recursive: true, force: true });
            }
        }

        console.log(`H1 other setting everywhere: ${h1bad ? h1bad + ' of ' + h1n + ' cases wrong' : h1n + ' cases ok'}`);
    }

    // (round 13 wave 10, lane U: written field blocks. "Clear the conditions" drops only the block's conditions
    // (FieldDef.conds); a list of bare values, a field written as a block and a key the set does not know are kept as
    // written; keepWritten's text compared exactly)
    {
        let ubad = 0;
        let un = 0;
        const bad = (what: string): void => (console.log(`MENUS U ${what}`), void ubad++);
        const T = String.fromCharCode(9);
        const uwalk = (type: string, edit: string | undefined, path: Step[], common?: string[]): { text: string; labels: string[]; } =>
        {
            let s = startStates('field', 'character', undefined, type, edit, undefined, undefined, undefined, undefined, { common }).at(-1)!.state;

            for (const p of path)
            {
                const n = choose(s, p);

                if ('finish' in n)
                    return { text: resultText(n.state ?? s), labels: [] };

                s = n.state;
            }

            return { text: resultText(s), labels: menuOf(s, data).items.map((i) => i.label) };
        };
        const kept = (written: string, type: string, path: Step[]): string =>
        {
            try
            {
                if (!canPickEdit('field', written, type))
                    return 'canPickEdit false';

                const r = keepWritten(written, uwalk(type, written, path).text, T);
                return r.text === null ? 'keepWritten null' : r.text + (r.gone?.length ? `\n(gone: ${r.gone.join(' | ')})` : '');
            }
            catch (e)
            {
                return 'ERROR ' + (e as Error).message;
            }
        };

        // (P2r(c): vanilla 1.20 adopt_interaction's option (00_adoption.txt:160): Clear drops is_shown and is_valid with the
        // comments inside them (named as gone), the flag, the label and the comment after `{` stay)
        {
            const written = [
                'send_option = { # EP3 Influence',
                T + 'is_shown = { # Actor must have a government that uses influence ',
                T + T + 'scope:actor = {',
                T + T + T + 'government_has_flag = government_has_influence',
                T + T + '}',
                T + '}',
                T + 'is_valid = {',
                T + T + '# Actor has enough influence',
                T + T + 'scope:actor = { influence >= medium_influence_value }',
                T + T + '# Both characters are within the same top realm',
                T + T + 'scope:recipient.top_liege = scope:actor.top_liege',
                T + '}',
                T + 'flag = influence_send_option',
                T + 'localization = TRADE_INFLUENCE_FOR_BETTER_AI_ACCEPTANCE',
                '}'
            ].join('\n');
            const want = [
                'send_option = { # EP3 Influence',
                T + 'flag = influence_send_option',
                T + 'localization = TRADE_INFLUENCE_FOR_BETTER_AI_ACCEPTANCE',
                '}',
                '(gone: # Actor must have a government that uses influence | # Actor has enough influence | # Both characters are within the same top realm)'
            ].join('\n');
            const got = kept(written, 'character_interactions', ['Clear the conditions', 'Done', 'Done']);

            if (un++, got !== want)
                bad(`adopt_interaction's option cleared:\n${got}\n  wanted:\n${want}`);
        }

        for (const [name, type, edit, path, want] of [
            ['a council asset with a trigger: Clear keeps the icon', 'council_tasks', 'asset = { trigger = { always = yes } icon = "x.dds" }', ['Clear the conditions', 'Done', 'Done'], 'asset = { icon = "x.dds" }'],
            ['a triggered opinion: Clear drops its conditions', 'trait_opinion', 'triggered_opinion = { opinion_modifier = x same_faith = yes male_only = yes }', ['Clear the conditions', 'Done', 'Done'], 'triggered_opinion = { opinion_modifier = x }'],
            ['a send option: Clear keeps an unknown key and the label', 'character_interactions', 'send_option = { is_valid = { always = yes } flag = gold localization = L current_description = d }', ['Clear the conditions', 'Done', 'Done'], 'send_option = { flag = gold localization = L current_description = d }'],
            // (a flavorization's rules decide when its name applies: Clear drops them, as before wave 10)
            ['flavourization rules: Clear drops every rule', 'flavorization', 'flavourization_rules = { top_liege = no only_independent = yes }', ['Clear the conditions', 'Done', 'Done'], 'flavourization_rules = { }']
        ] as [string, string, string, Step[], string][])
        {
            let got: string;

            try
            {
                got = uwalk(type, edit, path).text;
            }
            catch (e)
            {
                got = 'ERROR ' + (e as Error).message;
            }

            if (un++, got.replace(/\s+/g, ' ') !== want)
                bad(`${name}: ${got}`);
        }

        // (no condition written, or none the block has (a building's asset): no Clear row)
        for (const [type, edit] of [
            ['council_tasks', 'asset = { icon = "x.dds" glow = "y.dds" }'],
            ['buildings', 'asset = { type = pdxmesh name = x graphical_regions = { a b } }'],
            ['character_interactions', 'send_option = { flag = gold localization = L }']
        ])
        {
            const labels = uwalk(type, edit, []).labels;

            if (un++, labels.includes('Clear the conditions'))
                bad(`a Clear row for ${edit}: ${labels.join(' | ')}`);
        }

        // (P2r(b): canPickEdit for the kept shapes)
        for (const [text, type, want] of [
            ['asset = { type = pdxmesh name = x graphical_regions = { a b } graphical_cultures = { c } }', 'buildings', true],
            ['asset = { type = pdxmesh soundeffect = { soundeffect = "event:/x" soundparameter = { "Tier" = 1 } } }', 'buildings', true],
            ['send_option = { flag = gold current_description = some_key }', 'character_interactions', true],
            ['send_option = { flag = gold current_description > 1 }', 'character_interactions', false]
        ] as [string, string, boolean][])
            if (un++, canPickEdit('field', text, type) !== want)
                bad(`canPickEdit(field, ${JSON.stringify(text)}, ${type}): ${!want}`);

        // (a building's asset as vanilla writes them (00_castle.txt's shape) with comments in its list and after an unknown
        // key: a field changed, the lists, the sound block and the unknown key kept as written)
        {
            const written = [
                'asset = {',
                T + 'type = pdxmesh',
                T + 'name = "building_western_castle_01_mesh"',
                T + 'graphical_regions = { # where it shows',
                T + T + 'graphical_western # the west',
                T + T + 'graphical_mena',
                T + '}',
                T + 'soundeffect = {',
                T + T + 'soundeffect = "event:/SFX/Ambience/3D/Buildings/Castles/sfx_amb_3d_castle"',
                T + T + 'soundparameter = { "Tier" = 1 }',
                T + '}',
                T + 'current_x = some_key # unknown',
                '}'
            ];
            const lines = (i: number, line: string): string => [...written.slice(0, i), line, ...written.slice(i + 1)].join('\n');
            const sound = [...written.slice(0, 7), T + 'soundeffect = "event:/SFX/u"', ...written.slice(11)].join('\n');

            for (const [name, path, want] of [
                ['its name changed, the list kept', ['Mesh or entity name…', { input: 'u mesh 02' }, 'Done', 'Done'], lines(2, T + 'name = "u mesh 02"')],
                ['its sound block kept (Keep as written)', ['Sound…', 'Keep as written', 'Done', 'Done'], written.join('\n')],
                ['its sound block replaced by a typed sound', ['Sound…', { input: 'event:/SFX/u' }, 'Done', 'Done'], sound]
            ] as [string, Step[], string][])
            {
                const got = kept(written.join('\n'), 'buildings', path);

                if (un++, got !== want)
                    bad(`a building asset, ${name}:\n${got}\n  wanted:\n${want}`);
            }

            // (the sound written as a block reads "as written" on its row; Keep is its value menu's first row)
            const rows = menuOf(startStates('field', 'character', undefined, 'buildings', written.join('\n')).at(-1)!.state, data).items;
            const soundRow = rows.find((i) => i.label === 'Sound…');
            const first = uwalk('buildings', written.join('\n'), ['Sound…']).labels[0];

            if (un++, soundRow?.hint !== 'as written' || first !== 'Keep as written')
                bad(`the sound row: hint ${soundRow?.hint}, first row ${first}`);
        }

        // (a send option with an unknown key, as 1.20 writes current_description: a field changed, the key kept)
        {
            const written = ['send_option = {', T + 'flag = gold', T + 'current_description = my_desc # shown when chosen', '}'];
            const want = [...written.slice(0, 3), T + 'can_invalidate_interaction = yes', '}'].join('\n');
            const got = kept(written.join('\n'), 'character_interactions', ['Can block sending', 'Done', 'Done']);

            if (un++, got !== want)
                bad(`a send option with current_description:\n${got}\n  wanted:\n${want}`);
        }

        // (P2r(a), over a made-up game folder in TEMP: an AI goal type with one key shows it as a Settings line of its set,
        // and no "Nothing set"; an empty one keeps the note; two keys both shown)
        {
            const dir = mkdtempSync(join(tmpdir(), 'ckp-u-goal-'));

            try
            {
                const game = join(dir, 'game');
                mkdirSync(join(game, 'common', 'ai_goaltypes'), { recursive: true });
                writeFileSync(join(game, 'common', 'ai_goaltypes', 'u.txt'), 'u_one = {\n\tu_key = 1\n}\nu_two = {\n\tu_key = 1\n\tu_other = yes\n}\nu_empty = {\n}\n');
                const idx = new GameIndex(new GameFiles(game, []), 'english');
                idx.build();
                const sb = new StoryBuilder(idx);
                const read = (name: string): string =>
                {
                    const e = idx.get('ai_goaltypes', name);

                    if (!e)
                        return 'no entry';

                    const card = sb.card(e);
                    const lines = card.sections.flatMap((x) => x.lines.filter((l) => l.src?.kind === 'field' && l.src.fields === 'ai_goaltypes').map((l) => `${x.title}: ${l.tip ?? ''} [${l.src!.e - l.src!.s}]`));
                    const note = card.facts.some((f) => f.some((t) => (typeof t === 'string' ? t : t.text).startsWith('Nothing set')));
                    return `${lines.join(', ') || 'no lines'}; note ${note}`;
                };

                for (const [name, want] of [
                    ['u_one', 'Settings: u_key [9]; note false'],
                    ['u_two', 'Settings: u_key [9], Settings: u_other [13]; note false'],
                    ['u_empty', 'no lines; note true']
                ])
                {
                    const got = read(name);

                    if (un++, got !== want)
                        bad(`AI goal type ${name}: ${got} (wanted ${want})`);
                }
            }
            catch (err)
            {
                un++;
                bad(`AI goal types: ERROR ${(err as Error).message}`);
            }
            finally
            {
                rmSync(dir, { recursive: true, force: true });
            }
        }

        // (P2r(d): a named experience track, the set trait_tracks (one field: the picker opens at its name). The names
        // written beside it come as PickRequest.common; its name in game is an optional `loc` create, kept by usedCreates)
        {
            const pickIn = (d: PickerData, s: State, p: Step): Next =>
            {
                const m = menuOf(s, d);
                const item = typeof p === 'string' ? (m.items.find((i) => i.label === p) ?? m.items.find((i) => i.label.startsWith(p))) : 'n' in p ? m.number?.(p.n, String(p.n))[0] : m.input?.(p.input);

                if (!item?.go)
                    throw new Error(`no row ${JSON.stringify(p)} in “${m.title}”: ${m.items.map((i) => i.label).join(' | ')}`);

                return item.go();
            };
            const track = (path: Step[], d: PickerData = data): { text: string; creates: string; labels: string[]; } =>
            {
                let s = startStates('field', 'character', undefined, 'trait_tracks', undefined, undefined, undefined, undefined, undefined, { common: ['hunter'] }).at(-1)!.state;

                for (const p of path)
                {
                    const n = pickIn(d, s, p);

                    if ('finish' in n)
                    {
                        s = n.state ?? s;
                        break;
                    }

                    s = n.state;
                }

                return { text: resultText(s).trim(), creates: JSON.stringify(usedCreates(s) ?? null), labels: menuOf(s, d).items.map((i) => i.label) };
            };
            // (the review of wave 10: a track's text key is global; the game's trait_track_falconer exists, so its text is
            // kept first with no create, another text is a create marked as changing it everywhere (main overrides it
            // in the mod's replace folder: make-check's case))
            const withLoc: PickerData = {
                ...data,
                locEntry: (k) => (k === 'trait_track_falconer' ? { text: 'Falconer', rel: 'localization/english/traits_l_english.yml' } : k === 'trait_track_falconer_desc' ? { text: 'With hawks.', rel: 'localization/english/traits_l_english.yml' } : null),
                locEntryLoaded: async () => undefined
            };

            for (const [name, path, want, d] of [
                ['a named track with its name in game', [{ input: 'falconer' }, '50', 'Use “Falconer”', 'No description', 'Done'], 'falconer = { 50 = { } } [{"what":"loc","key":"trait_track_falconer","fields":[["for","falconer"]],"loc":"Falconer"}]'],
                ['a named track, its name typed', [{ input: 'Royal Falconer' }, '25', { input: 'Keeper of the Mews' }, 'No description', 'Done'], 'royal_falconer = { 25 = { } } [{"what":"loc","key":"trait_track_royal_falconer","fields":[["for","royal_falconer"]],"loc":"Keeper of the Mews"}]'],
                ['a named track without a name in game', [{ input: 'falconer' }, '50', 'No name in game', 'No description', 'Done'], 'falconer = { 50 = { } } null'],
                ['a named track whose texts the game has: both kept', [{ input: 'falconer' }, '50', 'Keep the game’s “Falconer”', 'Keep the game’s “With hawks.”', 'Done'], 'falconer = { 50 = { } } null', withLoc],
                ['a named track whose text key the game has: changed', [{ input: 'falconer' }, '50', { input: 'Hawk Master' }, 'Keep the game’s “With hawks.”', 'Done'], 'falconer = { 50 = { } } [{"what":"loc","key":"trait_track_falconer","fields":[["for","falconer"]],"loc":"Hawk Master"}]', withLoc],
                ['a named track, a new text key with the lookup', [{ input: 'hawker' }, '50', 'Use “Hawker”', 'No description', 'Done'], 'hawker = { 50 = { } } [{"what":"loc","key":"trait_track_hawker","fields":[["for","hawker"]],"loc":"Hawker"}]', withLoc],
                // (its description, the game's `trait_track_<name>_desc` (_traits.info): typed, both texts one undo step;
                // a description the game has kept first, another text changing it everywhere)
                ['a named track with its description', [{ input: 'hawker' }, '50', 'Use “Hawker”', { input: 'Hunting with birds of prey.' }, 'Done'], 'hawker = { 50 = { } } [{"what":"loc","key":"trait_track_hawker","fields":[["for","hawker"]],"loc":"Hawker"},{"what":"loc","key":"trait_track_hawker_desc","fields":[["for","hawker"]],"loc":"Hunting with birds of prey."}]', withLoc],
                ['a named track, only its description', [{ input: 'hawker' }, '50', 'No name in game', { input: 'Birds.' }, 'Done'], 'hawker = { 50 = { } } [{"what":"loc","key":"trait_track_hawker_desc","fields":[["for","hawker"]],"loc":"Birds."}]'],
                ['a named track whose description the game has: changed', [{ input: 'falconer' }, '50', 'Keep the game’s “Falconer”', { input: 'With falcons.' }, 'Done'], 'falconer = { 50 = { } } [{"what":"loc","key":"trait_track_falconer_desc","fields":[["for","falconer"]],"loc":"With falcons."}]', withLoc]
            ] as [string, Step[], string, PickerData?][])
            {
                let got: string;

                try
                {
                    const r = track(path, d);
                    got = `${r.text.replace(/\s+/g, ' ')} ${r.creates}`;
                }
                catch (e)
                {
                    got = 'ERROR ' + (e as Error).message;
                }

                if (un++, got !== want)
                    bad(`${name}: ${got}\n  wanted: ${want}`);
            }

            // (the key's step for an existing text: Keep first (⏎), no "No name in game"; the typed row says "everywhere")
            {
                let s = startStates('field', 'character', undefined, 'trait_tracks', undefined, undefined, undefined, undefined, undefined, { common: ['hunter'] }).at(-1)!.state;

                for (const p of [{ input: 'falconer' }, '50'] as Step[])
                    s = (pickIn(withLoc, s, p) as { state: State; }).state;

                const m = menuOf(s, withLoc);
                const got = `${m.items.map((i) => `${i.label} ${i.hint ?? ''}`).join(' | ')}; typed ${m.input?.('Hawk Master')?.hint}`;

                if (un++, got !== 'Keep the game’s “Falconer” ⏎; typed everywhere')
                    bad(`the existing text's step: ${got}`);
            }

            // (a second track in the same request ("And also…") may not reuse the name just made)
            {
                let s = startStates('field', 'character', undefined, 'trait_tracks', undefined, undefined, undefined, undefined, undefined, { common: ['hunter'] }).at(-1)!.state;
                let got = '';

                try
                {
                    for (const p of [{ input: 'falconer' }, '50', 'No name in game', 'No description', 'And also…'] as Step[])
                        s = (pickIn(data, s, p) as { state: State; }).state;

                    // (the set's one field opens its name step; when the root comes first, its one row leads there)
                    let m = menuOf(s, data);

                    if (!m.input)
                    {
                        s = (m.items.find((i) => i.go)!.go!() as { state: State; }).state;
                        m = menuOf(s, data);
                    }

                    const row = m.input?.('falconer');
                    got = `${row?.label} ${row?.role} ${!!row?.go}`;
                }
                catch (e)
                {
                    got = 'ERROR ' + (e as Error).message;
                }

                if (un++, got !== '“falconer” exists already info false')
                    bad(`a second track of the same name: ${got}`);
            }

            // (a name written already, not as the script writes names, or all digits (it would read as a level): refused,
            // no row to go on)
            for (const typed of ['hunter', 'fal-coner', '50'])
            {
                const s = startStates('field', 'character', undefined, 'trait_tracks', undefined, undefined, undefined, undefined, undefined, { common: ['hunter'] }).at(-1)!.state;
                const row = menuOf(s, data).input?.(typed);

                if (un++, !row || row.go || row.role !== 'info')
                    bad(`named track ${typed}: ${row ? row.label : 'no row'} (go ${!!row?.go})`);
            }
        }

        // (P2r(d), the trait's card over a made-up game folder and mod in TEMP: a trait with `tracks` has its section ＋
        // into it (set trait_tracks, the names it has as the hint); a mod's trait with neither block has both rows)
        {
            const dir = mkdtempSync(join(tmpdir(), 'ckp-u-tracks-'));

            try
            {
                const game = join(dir, 'game');
                mkdirSync(join(game, 'common', 'traits'), { recursive: true });
                writeFileSync(join(game, 'common', 'traits', 'u.txt'), 'u_hunt = {\n\tcategory = lifestyle\n\ttracks = {\n\t\thunter = {\n\t\t\t50 = { prowess = 1 }\n\t\t}\n\t\tfalconer = {\n\t\t\t50 = { diplomacy = 1 }\n\t\t}\n\t}\n}\nu_both = {\n\ttrack = {\n\t\t50 = { prowess = 1 }\n\t}\n\ttracks = {\n\t\tfalconer = {\n\t\t\t50 = { diplomacy = 1 }\n\t\t}\n\t}\n}\n');
                const modRoot = join(dir, 'mod');
                mkdirSync(join(modRoot, 'common', 'traits'), { recursive: true });
                writeFileSync(join(modRoot, 'common', 'traits', 'u_mod.txt'), 'u_plain = {\n\tcategory = personality\n}\n');
                const mod: ModInfo = { id: 'mod/u_test.mod', name: 'U Test', tags: [], root: modRoot, source: 'local', replacePaths: [], status: 'ok', editable: true };
                const idx = new GameIndex(new GameFiles(game, [mod]), 'english');
                idx.build();
                const sb = new StoryBuilder(idx);
                const tracksOf = (name: string): string =>
                {
                    const e = idx.get('traits', name);
                    const s = e ? sb.card(e).sections.find((x) => x.title === 'Experience tracks') : undefined;
                    return s ? `${s.src?.src?.fields ?? '-'} ${s.src?.kind ?? '-'} [${s.src?.hint?.common?.join(' ') ?? ''}] ${s.addLabel ?? '-'}` : 'no section';
                };

                for (const [name, want] of [
                    ['u_hunt', 'trait_tracks field [hunter falconer] track'],
                    ['u_both', 'trait_tracks field [falconer u_both] track']
                ])
                {
                    const got = tracksOf(name);

                    if (un++, got !== want)
                        bad(`the tracks section of ${name}: ${got} (wanted ${want})`);
                }

                const plain = idx.get('traits', 'u_plain');
                const more = plain ? sb.card(plain).sections.find((x) => x.title === 'More settings') : undefined;
                const acts = (more?.lines ?? []).map((l) => {
                    const d = l.act?.do as { kind?: string; at?: SectionSource; } | undefined;
                    return `${l.act?.label} ${d?.kind} ${d?.at?.key} ${d?.at?.parent?.fields}`;
                }).join(' | ');

                if (un++, acts !== '＋ level add track trait_track | ＋ named track add tracks trait_tracks')
                    bad(`a mod trait's More settings: ${acts || 'none'}`);
            }
            catch (err)
            {
                un++;
                bad(`trait tracks: ERROR ${(err as Error).message}`);
            }
            finally
            {
                rmSync(dir, { recursive: true, force: true });
            }
        }

        // (2026-11-15) a mod event's card: the saves of the scripted effects it calls, two calls deep, each with its
        // definition's span (EntityCard.calledSaves, PickTarget.inside); a name the event saves itself left out
        {
            const dir = mkdtempSync(join(tmpdir(), 'ckp-u-called-'));

            try
            {
                const game = join(dir, 'game');
                mkdirSync(join(game, 'common', 'traits'), { recursive: true });
                const modRoot = join(dir, 'mod');
                mkdirSync(join(modRoot, 'events'), { recursive: true });
                mkdirSync(join(modRoot, 'common', 'scripted_effects'), { recursive: true });
                writeFileSync(join(modRoot, 'events', 'u_ev.txt'), 'namespace = u_ev\n\nu_ev.1 = {\n\ttype = character_event\n\timmediate = {\n\t\tsave_scope_as = mine\n\t\tu_fx = yes\n\t}\n}\n');
                writeFileSync(join(modRoot, 'common', 'scripted_effects', 'u_fx.txt'), 'u_fx = {\n\tliege = { save_scope_as = found }\n\tsave_scope_as = mine\n\tu_fx2 = yes\n}\n');
                writeFileSync(join(modRoot, 'common', 'scripted_effects', 'u_fx2.txt'), 'u_fx2 = {\n\tprimary_spouse = { save_temporary_scope_as = deep }\n}\n');
                const mod: ModInfo = { id: 'mod/u_called.mod', name: 'U Called', tags: [], root: modRoot, source: 'local', replacePaths: [], status: 'ok', editable: true };
                const idx = new GameIndex(new GameFiles(game, [mod]), 'english');
                idx.build();
                const sb = new StoryBuilder(idx);
                const ev = idx.get('events', 'u_ev.1');
                const card = ev ? sb.card(ev) : undefined;
                const got = (card?.calledSaves ?? []).map((t) => `${t.key}@${t.inside?.file.replace(/^.*[\\/]/, '')}`).sort().join(' ');

                if (un++, got !== 'scope:deep@u_fx2.txt scope:found@u_fx.txt')
                    bad(`a mod event's called effects' saves: ${got || 'none'} (wanted scope:deep@u_fx2.txt scope:found@u_fx.txt)`);

                // (a scripted effect's callers' lists: only the ones in reach at a call, not one added after it or in a
                // sibling option)
                writeFileSync(join(modRoot, 'events', 'u_lists.txt'), 'namespace = u_lists\n\nu_lists.1 = {\n\ttype = character_event\n\toption = {\n\t\tadd_to_list = early\n\t\tu_lfx = yes\n\t\tadd_to_list = late\n\t}\n\toption = {\n\t\tadd_to_list = other_opt\n\t}\n}\n');
                writeFileSync(join(modRoot, 'common', 'scripted_effects', 'u_lfx.txt'), 'u_lfx = {\n\tevery_in_list = {\n\t\tlist = early\n\t\tadd_gold = 1\n\t}\n}\n');
                const idx2 = new GameIndex(new GameFiles(game, [mod]), 'english');
                idx2.build();
                const lfx = idx2.get('scripted_effects', 'u_lfx');
                const lists = lfx ? (new StoryBuilder(idx2).card(lfx).lists ?? []).map((l) => l.name).sort().join(' ') : 'no effect';

                if (un++, lists !== 'early')
                    bad(`a scripted effect's callers' lists in reach at the call: ${lists || 'none'} (wanted early)`);
            }
            catch (err)
            {
                un++;
                bad(`called effects' saves: ERROR ${(err as Error).message}`);
            }
            finally
            {
                rmSync(dir, { recursive: true, force: true });
            }
        }

        console.log(`U field blocks: ${ubad ? ubad + ' of ' + un + ' cases wrong' : un + ' cases ok'}`);
    }

    // (round 13 wave 8, lane K1: a modifier block's kind on its lines, P4. A scheme modifier entry's line and a travel
    // option's travel_modifier line carry their block's kind (LineSource.scope): "＋ Add after this line" and ✎ on them
    // offer that kind's list; the travel option's Modifiers section, with nothing but that block, adds into it, scoped
    // the same. A block of unknown kind gives its lines none of the kind around it)
    {
        let k1bad = 0;
        let k1n = 0;
        const bad = (what: string): void => (console.log(`MENUS K1 ${what}`), void k1bad++);
        const dir = mkdtempSync(join(tmpdir(), 'ckp-k1-cards-'));

        try
        {
            const game = join(dir, 'game');
            const put = (rel: string, text: string): void => (mkdirSync(join(game, rel, '..'), { recursive: true }), writeFileSync(join(game, rel), text));
            put('common/modifier_definition_formats/00_k1_definitions.txt', 'travel_speed = { decimals = 0 }\ntravel_safety = { decimals = 0 }\nscheme_success_chance = { decimals = 0 percent = yes }\nmonthly_prestige = { decimals = 1 }\n');
            put('common/modifiers/k1.txt', 'k1_scheme_mod = {\n\tscheme_success_chance = 5\n}\nk1_odd_mod = {\n\tscheme_success_chance = 5\n\tk1_odd_modifier = {\n\t\tmonthly_prestige = 1\n\t}\n}\n');
            put('events/k1.txt', 'namespace = k1\nk1.1 = {\n\ttype = character_event\n\timmediate = {\n\t\tevery_scheme = {\n\t\t\tadd_scheme_modifier = { type = k1_scheme_mod }\n\t\t\tadd_scheme_modifier = { type = k1_odd_mod }\n\t\t}\n\t}\n}\n');
            put('common/travel/travel_options/k1.txt', 'k1_option = {\n\ttravel_modifier = {\n\t\ttravel_speed = -5\n\t\ttravel_safety = 2\n\t}\n}\nk1_two = {\n\tmonthly_prestige = 1\n\ttravel_modifier = {\n\t\ttravel_speed = -5\n\t}\n}\n');
            const idx = new GameIndex(new GameFiles(game, []), 'english');
            idx.build();
            const sb = new StoryBuilder(idx);
            const flatL = (ls: Line[]): Line[] => ls.flatMap((l) => [l, ...flatL(l.children ?? [])]);
            const cardOf = (type: string, name: string) => (idx.get(type, name) ? sb.card(idx.get(type, name)!) : undefined);
            const scopeOfLine = (type: string, name: string, key: string): string =>
            {
                const lines = (cardOf(type, name)?.sections ?? []).flatMap((s) => flatL(s.lines)).filter((l) => l.src?.kind === 'modifier' && !l.children && l.src && idx.get(type, name) && l.tip?.startsWith(key));
                return lines.length ? lines.map((l) => l.src!.scope ?? 'none').join(',') : 'no line';
            };
            // (a block row's own scope: what "＋ Add after this line" on it offers; and its innerScope, what ⤷＋ inside offers)
            const rowOf = (type: string, name: string, tip: string): string =>
            {
                const rows = (cardOf(type, name)?.sections ?? []).flatMap((s) => flatL(s.lines)).filter((l) => l.children && l.tip === tip);
                return rows.length ? rows.map((l) => `${l.src?.scope ?? 'none'}/${l.src?.innerScope ?? 'none'}`).join(',') : 'no row';
            };
            const section = (type: string, name: string): string =>
            {
                const s = cardOf(type, name)?.sections.find((x) => x.title === 'Modifiers' || x.title === 'Effects');
                // (the definition's own block, `own()`, is keyed by the entry's name: its top)
                return s ? `${s.src?.scope ?? 'none'} ${s.src?.src?.inner && s.src.key !== name ? 'inside ' + s.src.key : 'top'}` : 'no section';
            };

            if (k1n++, scopeOfLine('modifiers', 'k1_scheme_mod', 'scheme_success_chance') !== 'scheme')
                bad(`scheme modifier's line: ${scopeOfLine('modifiers', 'k1_scheme_mod', 'scheme_success_chance')} (want scheme; section ${section('modifiers', 'k1_scheme_mod')})`);

            if (k1n++, scopeOfLine('travel/travel_options', 'k1_option', 'travel_speed') !== 'travel_plan' || scopeOfLine('travel/travel_options', 'k1_option', 'travel_safety') !== 'travel_plan')
                bad(`travel_modifier's lines: ${scopeOfLine('travel/travel_options', 'k1_option', 'travel_speed')} / ${scopeOfLine('travel/travel_options', 'k1_option', 'travel_safety')} (want travel_plan)`);

            if (k1n++, section('travel/travel_options', 'k1_option') !== 'travel_plan inside travel_modifier')
                bad(`travel option's Modifiers section: ${section('travel/travel_options', 'k1_option')} (want travel_plan inside travel_modifier)`);

            // (the section anchored on that block: its row is written at the option's top, so "＋ Add after this line" on
            // it keeps the row's own scope; only the lines inside get the block's kind)
            if (k1n++, rowOf('travel/travel_options', 'k1_option', 'travel_modifier') !== 'none/travel_plan')
                bad(`travel option's travel_modifier row: ${rowOf('travel/travel_options', 'k1_option', 'travel_modifier')} (want none/travel_plan)`);

            // (a block row of unknown kind inside a scheme modifier: it keeps its scope (⤷＋ inside offers no kind) and its
            // line keeps its own; the line beside it still gets the scheme kind)
            if (k1n++, rowOf('modifiers', 'k1_odd_mod', 'k1_odd_modifier') !== 'none/none' || scopeOfLine('modifiers', 'k1_odd_mod', 'monthly_prestige') !== 'none' || scopeOfLine('modifiers', 'k1_odd_mod', 'scheme_success_chance') !== 'scheme')
                bad(`unknown block in a scheme modifier: row ${rowOf('modifiers', 'k1_odd_mod', 'k1_odd_modifier')}, its line ${scopeOfLine('modifiers', 'k1_odd_mod', 'monthly_prestige')}, the line beside ${scopeOfLine('modifiers', 'k1_odd_mod', 'scheme_success_chance')} (want none/none, none, scheme)`);

            // (a modifier of its own at the top too: the section stays the definition's, its block's lines still scoped)
            if (k1n++, section('travel/travel_options', 'k1_two') !== 'none top' || scopeOfLine('travel/travel_options', 'k1_two', 'travel_speed') !== 'travel_plan')
                bad(`travel option with a top-level modifier: section ${section('travel/travel_options', 'k1_two')}, line ${scopeOfLine('travel/travel_options', 'k1_two', 'travel_speed')}`);
        }
        catch (err)
        {
            bad(`cards: ERROR ${(err as Error).stack}`);
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }

        console.log(`K1 modifier block kinds: ${k1bad ? k1bad + ' of ' + k1n + ' cases wrong' : k1n + ' cases ok'}`);
    }

    // (round 13 wave 11, lane V: a doctrine's values. P11r(d): a doctrine parameter takes On / No, no number (1.20 reads
    // numbers from special_parameters), a written number kept with a note. P11r(c): special_parameters' numbers and
    // yes / no as fields, the set open. P11r(b): the hostility blocks made with their first entry from the section's ＋,
    // their rows' ⤷＋ (the relations not written yet; a doctrine or tenet, then the level), opinion overrides, holdings;
    // the doctrine card's "Special values" section over a made-up game folder and mod)
    {
        let vbad = 0;
        let vn = 0;
        const bad = (what: string): void => (console.log(`MENUS V ${what}`), void vbad++);
        const vdata: PickerData = {
            ...data,
            list: (t) => (t === 'holdings' ? [entry('church_holding', 5, 'Temple'), entry('city_holding', 4, 'City')] : data.list(t)),
            suggestions: (source) => (source === 'doctrine_parameters' ? [{ value: 'pacifist', count: 3, label: 'Pacifism' }] : data.suggestions(source))
        };
        const vchoose = (s: State, p: Step): Next =>
        {
            const m = menuOf(s, vdata);
            const item = typeof p === 'string' ? (m.items.find((i) => i.label === p) ?? m.items.find((i) => i.label.startsWith(p))) : 'n' in p ? m.number?.(p.n, String(p.n))[0] : m.input?.(p.input);

            if (!item?.go)
                throw new Error(`no row ${JSON.stringify(p)} in “${m.title}”: ${m.items.map((i) => i.label).join(' | ')}`);

            return item.go();
        };
        // (the walk's text, the last menu, and the `back` of every step: a block's entry goes back into its menu)
        const vwalk = (type: string, edit: string | undefined, path: Step[]): { text: string; menu: Menu; backs: (number | undefined)[]; } =>
        {
            let s = startStates('field', 'character', undefined, type, edit).at(-1)!.state;
            const backs: (number | undefined)[] = [];

            for (const p of path)
            {
                const n = vchoose(s, p);

                if ('finish' in n)
                    return { text: resultText(n.state ?? s), menu: menuOf(n.state ?? s, vdata), backs };

                backs.push(n.back);
                s = n.state;
            }

            return { text: resultText(s), menu: menuOf(s, vdata), backs };
        };
        const labels = (m: Menu): string => m.items.map((i) => i.label).join(' | ');
        const scen: [string, string, string | undefined, Step[], string][] = [
            // P11r(c): a number changed and added, yes / no, Other setting…
            ['✎ number_of_spouses = 4: a preset', 'special_parameters', 'number_of_spouses = 4', ['2', 'Done'], 'number_of_spouses = 2'],
            ['＋ a number typed', 'special_parameters', undefined, ['Lowest fervor…', { n: 30 }, 'Done'], 'minimum_fervor = 30'],
            ['＋ a multiplier preset', 'special_parameters', undefined, ['Hostility towards it, multiplied…', '2', 'Done'], 'hostility_towards_us_mult = 2'],
            ['✎ unreformed = yes: no', 'special_parameters', 'unreformed = yes', ['No', 'Done'], 'unreformed = no'],
            ['＋ warmonger', 'special_parameters', undefined, ['Warmonger', 'Done'], 'warmonger = yes'],
            ['＋ Other setting…: a key the .info does not name', 'special_parameters', undefined, ['Other setting…', { input: 'v_mod_value' }, { input: '3' }, 'Done'], 'v_mod_value = 3'],
            ['✎ a key the .info does not name', 'special_parameters', 'v_mod_value = 3', [{ input: '4' }, 'Done'], 'v_mod_value = 4'],
            // P11r(b): a block made with its first entry (the section's ＋), more entries in its menu
            ['＋ Hostility by relation: the first one asked', 'special_parameters', undefined, ['Hostility by relation…', 'Faiths of the same family…', 'Hostile', 'Done', 'Done'], 'hostility_levels = { same_family = hostile }'],
            ['＋ Hostility by relation: two', 'special_parameters', undefined, ['Hostility by relation…', 'Faiths of the same family…', 'Hostile', 'Faiths of other families…', 'Evil', 'Done', 'Done'], 'hostility_levels = { same_family = hostile unrelated = evil }'],
            ['＋ Hostility by doctrine or tenet: a tenet first', 'special_parameters', undefined, ['Hostility by doctrine or tenet…', 'Pacifism', 'Evil', 'Done', 'Done'], 'hostility_level_override = { tenet_pacifism = evil }'],
            ['＋ Hostility by doctrine or tenet: a doctrine added in its menu', 'special_parameters', undefined, ['Hostility by doctrine or tenet…', 'Pacifism', 'Evil', 'Faiths with the doctrine or tenet…', 'Gender equal', 'Astray', 'Done', 'Done'], 'hostility_level_override = { tenet_pacifism = evil doctrine_gender_equal = astray }'],
            ['＋ Opinion of faiths with a parameter', 'special_parameters', undefined, ['Opinion of faiths with a parameter…', 'Pacifist', '+10', 'Done', 'Done'], 'parameter_opinion_override = { pacifist = 10 }'],
            ['✎ a hostility_levels row with every relation: one changed in its menu', 'special_parameters', 'hostility_levels = { same_religion = astray same_family = hostile unrelated = evil }', ['Faiths of the same religion…', 'Hostile', 'Done', 'Done'], 'hostility_levels = { same_religion = hostile same_family = hostile unrelated = evil }'],
            // (a block row is a setting of special_parameters (its ⤷＋ has the block's set, innerFields): ✎ opens the block's
            // menu, an entry changed or added there stays inside the block)
            ['✎ a hostility_level_override row: an entry added in its menu', 'special_parameters', 'hostility_level_override = { doctrine_gender_equal = astray }', ['Faiths with the doctrine or tenet…', 'Pacifism', 'Hostile', 'Done', 'Done'], 'hostility_level_override = { doctrine_gender_equal = astray tenet_pacifism = hostile }'],
            ['✎ a parameter_opinion_override row: an entry added in its menu', 'special_parameters', 'parameter_opinion_override = { pacifist = 10 }', ['Faiths with the parameter…', { input: 'v_param' }, { n: 5 }, 'Done', 'Done'], 'parameter_opinion_override = { pacifist = 10 v_param = 5 }'],
            ['✎ a hostility_levels row with a relation missing: one added in its menu', 'special_parameters', 'hostility_levels = { same_religion = astray }', ['Faiths of other families…', 'Evil', 'Done', 'Done'], 'hostility_levels = { same_religion = astray unrelated = evil }'],
            ['＋ head of faith', 'special_parameters', undefined, ['Faiths sharing its head of faith…', 'Righteous', 'Done'], 'same_hof_hostility_override = righteous'],
            // (allowed_holding_types: a list of bare names, made with its first one, one more each time; a written list read back)
            ['＋ Holdings its rulers may hold: the first one asked', 'special_parameters', undefined, ['Holdings its rulers may hold…', 'Temple', 'Done', 'Done'], 'allowed_holding_types = { church_holding }'],
            ['＋ Holdings its rulers may hold: two', 'special_parameters', undefined, ['Holdings its rulers may hold…', 'Temple', 'Holding type…', 'City', 'Done', 'Done'], 'allowed_holding_types = { church_holding city_holding }'],
            ['✎ an allowed_holding_types row: one added in its menu', 'special_parameters', 'allowed_holding_types = { church_holding }', ['Holding type…', 'City', 'Done', 'Done'], 'allowed_holding_types = { church_holding city_holding }'],
            // the block rows' ⤷＋
            ['⤷＋ hostility_levels, two relations missing', 'hostility_levels/same_family/unrelated', undefined, ['Faiths of other families…', 'Astray', 'Done'], 'unrelated = astray'],
            ['⤷＋ hostility_levels, one missing: its level right away', 'hostility_levels/unrelated', undefined, ['Evil', 'Done'], 'unrelated = evil'],
            ['⤷＋ hostility_level_override: a tenet, hostile', 'hostility_level_override', undefined, ['Pacifism', 'Hostile', 'Done'], 'tenet_pacifism = hostile'],
            ['⤷＋ parameter_opinion_override: a parameter, a number', 'parameter_opinion_override', undefined, ['Pacifist', '+15', 'Done'], 'pacifist = 15'],
            ['⤷＋ parameter_opinion_override: a parameter typed', 'parameter_opinion_override', undefined, [{ input: 'v_param' }, { n: 12 }, 'Done'], 'v_param = 12'],
            ['✎ an opinion override', 'parameter_opinion_override', 'pacifist = 10', ['+20', 'Done'], 'pacifist = 20'],
            ['⤷＋ allowed_holding_types', 'allowed_holding_types', undefined, ['Temple', 'Done'], 'church_holding'],
            ['✎ a holding', 'allowed_holding_types', 'castle_holding', ['Temple', 'Done'], 'church_holding'],
            // P11r(d): a doctrine parameter: On / No only
            ['a new doctrine parameter: on', 'doctrine_parameters', undefined, [{ input: 'v_flag' }, 'On', 'Done'], 'v_flag'],
            ['a written number: kept', 'doctrine_parameters', 'v_count = 3', ['Keep: 3', 'Done'], 'v_count = 3']
        ];

        for (const [name, type, edit, path, want] of scen)
        {
            vn++;

            try
            {
                if (edit && !canPickEdit('field', edit, type))
                    bad(`${name}: canPickEdit false for ${edit}`);

                const got = vwalk(type, edit, path).text;

                if (got !== want)
                    bad(`${name}: ${got} (wanted ${want})`);
            }
            catch (err)
            {
                bad(`${name}: ERROR ${(err as Error).message}`);
            }
        }

        // the menus themselves
        const check = (what: string, got: string, want: string): void => void (vn++, got !== want && bad(`${what}: ${got} (wanted ${want})`));

        try
        {
            // (P11r(d): no number row, no number typed; the note names special_parameters only for a written number)
            const fresh = vwalk('doctrine_parameters', undefined, [{ input: 'v_flag' }]).menu;
            check('a new parameter\'s menu', `${labels(fresh)} number=${!!fresh.number} note=${fresh.note}`, 'On | No number=false note=On (written bare) or no');
            const written = vwalk('doctrine_parameters', 'v_count = 3', []).menu;
            check('a written number\'s menu', `${labels(written)} number=${!!written.number} special=${/special_parameters/.test(written.note ?? '')}`, 'Keep: 3 | On | No number=false special=true');
            const yes = vwalk('doctrine_parameters', 'v_flag = yes', []).menu;
            check('a written yes: no number note', `${labels(yes)} special=${/special_parameters/.test(yes.note ?? '')}`, 'Keep: yes | On | No special=false');
            // (✎ on number_of_spouses = 4: Keep, then the presets)
            check('✎ number_of_spouses = 4', labels(vwalk('special_parameters', 'number_of_spouses = 4', []).menu), 'Keep: 4 | 1 | 2 | 3 | 4');
            // (the section's ＋: the .info's keys, the head of faith, the blocks, then Other setting…)
            const root = vwalk('special_parameters', undefined, []).menu;
            check('the special values ＋', labels(root), [...(FIELDS.special_parameters ?? []).map((f) => f.label), 'Other setting…'].join(' | '));
            const keys = new Set(root.items.map((i) => i.key).filter(Boolean));
            check('the special values ＋: one letter each', String(keys.size), String(root.items.length));
            check('the .info keys as fields', (FIELDS.special_parameters ?? []).map((f) => f.key).join(' '), 'number_of_spouses number_of_consorts divine_marriage_opinion minimum_fervor fervor_per_holy_site bonus_fervor_gain bonus_heresy_protection divergence_protection heresy_threshold hostility_towards_us_mult piety_from_long_peace unreformed warmonger increased_dynasty_prestige_birth_mult increased_dynasty_prestige_marriage_mult increased_dynasty_prestige_long_reign_mult same_hof_hostility_override hostility_levels hostility_level_override parameter_opinion_override allowed_holding_types');
            // (⤷＋ on a hostility_levels row: only the relations not written)
            check('⤷＋ two relations missing', labels(vwalk('hostility_levels/same_family/unrelated', undefined, []).menu), 'Faiths of the same family… | Faiths of other families…');
            // (the first relation asked when the block is made: the three)
            check('a new hostility block asks which relation', labels(vwalk('special_parameters', undefined, ['Hostility by relation…']).menu), 'Faiths of the same religion… | Faiths of the same family… | Faiths of other families…');
            // (an entry added from the block's menu goes back into it: past the key menu for a doctrine, one step for a relation)
            check('back into the block: a doctrine', vwalk('special_parameters', undefined, ['Hostility by doctrine or tenet…', 'Pacifism', 'Evil', 'Faiths with the doctrine or tenet…', 'Gender equal', 'Astray']).backs.map(String).join(' '), 'undefined undefined undefined undefined undefined 2');
            check('back into the block: a relation', vwalk('special_parameters', undefined, ['Hostility by relation…', 'Faiths of the same family…', 'Hostile', 'Faiths of other families…', 'Evil']).backs.map(String).join(' '), 'undefined undefined undefined undefined 1');
            // (the opinion's value step: numbers, not the parameters its `suggest` names)
            check('an opinion override\'s value step', labels(vwalk('parameter_opinion_override', undefined, ['Pacifist']).menu), '+5 | +10 | +15 | +20 | +25 | +30');
            // (the set open: "Other setting…", a written unknown key changes in the picker)
            check('special_parameters is open', `${isOpenSet('special_parameters')} ${isOpenSet('hostility_levels')} ${isOpenSet('hostility_levels/unrelated')} ${isOpenSet('parameter_opinion_override')}`, 'true false false false');
            check('the readable text of a number', fieldText('special_parameters', 'number_of_spouses', '4')?.text ?? 'none', 'Up to 4 spouses');
            check('the readable text of an opinion override', fieldText('parameter_opinion_override', 'pacifist', '10')?.text ?? 'none', '+10 opinion of faiths with pacifist');
        }
        catch (err)
        {
            bad(`menus: ERROR ${(err as Error).stack}`);
        }

        // the doctrine card's sections over a made-up game folder and a mod: "What it does" holds the parameters,
        // "Special values" the special_parameters, each line anchored with its set, the blocks as rows with ⤷＋
        const dir = mkdtempSync(join(tmpdir(), 'ckp-v-doctrine-'));

        try
        {
            const game = join(dir, 'game');
            const TAB = String.fromCharCode(9);
            const NL = String.fromCharCode(10);
            const lines = (...ls: string[]): string => ls.join(NL) + NL;
            mkdirSync(join(game, 'common', 'religion', 'doctrine_types'), { recursive: true });
            writeFileSync(join(game, 'common', 'religion', 'doctrine_types', 'v.txt'), lines(
                'v_doctrine = {',
                TAB + 'parameters = { v_flag }',
                TAB + 'special_parameters = {',
                TAB + TAB + 'number_of_spouses = 4',
                TAB + TAB + 'hostility_levels = { same_religion = astray }',
                TAB + TAB + 'hostility_level_override = { tenet_pacifism = hostile }',
                TAB + TAB + 'parameter_opinion_override = { pacifist = 10 }',
                TAB + TAB + 'allowed_holding_types = { church_holding }',
                TAB + '}',
                '}',
                'v_all = {',
                TAB + 'special_parameters = {',
                TAB + TAB + 'hostility_levels = { same_religion = astray same_family = hostile unrelated = evil }',
                TAB + '}',
                '}',
                'v_plain = {',
                TAB + 'parameters = { v_other }',
                '}'
            ));
            const modRoot = join(dir, 'mod');
            mkdirSync(join(modRoot, 'common', 'religion', 'doctrine_types'), { recursive: true });
            writeFileSync(join(modRoot, 'common', 'religion', 'doctrine_types', 'v_mod.txt'), lines('v_mod_doctrine = {', TAB + 'parameters = { v_flag }', '}'));
            const mod: ModInfo = { id: 'mod/v_test.mod', name: 'V Test', tags: [], root: modRoot, source: 'local', replacePaths: [], status: 'ok', editable: true };
            const idx = new GameIndex(new GameFiles(game, [mod]), 'english');
            idx.build();
            const sb = new StoryBuilder(idx);
            const sectionOf = (name: string, title: string) =>
            {
                const e = idx.get('religion/doctrine_types', name);
                return e ? sb.card(e).sections.find((x) => x.title === title) : undefined;
            };
            // (a line: its tip's key, the set of its anchor, `+` when it has ⤷＋ (inner), its children the same)
            const shape = (l: Line): string => `${(l.tip ?? '').split(/[\s=]/)[0]}:${l.src?.fields ?? '-'}${l.src?.inner ? '+' + (l.src.innerFields ?? '') : ''}${l.children ? '[' + l.children.map(shape).join(' ') + ']' : ''}`;
            const special = sectionOf('v_doctrine', 'Special values');
            check('v_doctrine: What it does', (sectionOf('v_doctrine', 'What it does')?.lines ?? []).map(shape).join(' '), 'v_flag:doctrine_parameters');
            check('v_doctrine: Special values', (special?.lines ?? []).map(shape).join(' '), 'number_of_spouses:special_parameters hostility_levels:special_parameters+hostility_levels/same_family/unrelated[same_religion:hostility_levels] hostility_level_override:special_parameters+hostility_level_override[tenet_pacifism:hostility_level_override] parameter_opinion_override:special_parameters+parameter_opinion_override[pacifist:parameter_opinion_override] allowed_holding_types:special_parameters+allowed_holding_types[church_holding:allowed_holding_types]');
            check('v_doctrine: the section adds into special_parameters', `${special?.src?.src?.fields} ${special?.src?.key} ${special?.addLabel}`, 'special_parameters special_parameters setting');
            check('v_all: every relation written, no ⤷＋', (sectionOf('v_all', 'Special values')?.lines ?? []).map(shape).join(' '), 'hostility_levels:special_parameters[same_religion:hostility_levels same_family:hostility_levels unrelated:hostility_levels]');
            check('v_plain (the game\'s, none written): no Special values', String(!!sectionOf('v_plain', 'Special values')), 'false');
            const made = sectionOf('v_mod_doctrine', 'Special values');
            check('v_mod_doctrine (the mod\'s, none written): made with its first setting', `${made?.lines.length} ${made?.src?.parent?.fields} ${made?.src?.key} ${made?.src?.kind}`, '0 special_parameters special_parameters field');
        }
        catch (err)
        {
            bad(`doctrine card: ERROR ${(err as Error).stack}`);
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }

        console.log(`V doctrine values: ${vbad ? vbad + ' of ' + vn + ' cases wrong' : vn + ' cases ok'}`);
    }

    // (round 13 wave 11, lane W: a top-level `modifier` is a character's only for the surveyed types (P4); a Modifiers
    // section with several blocks and nothing at its top asks "Into which block?" (the owner's choice); an on_action's
    // delay as a range (`months = { 6 12 }`); "More about this list…" inside an iterator being built (the owner's
    // choice), whose way back keeps every statement built; "Up to how many…" refuses a typed 0)
    {
        let wbad = 0;
        let wn = 0;
        const bad = (what: string): void => (console.log(`MENUS W ${what}`), void wbad++);
        const check = (what: string, got: string, want: string): void => (wn++, got === want ? undefined : bad(`${what}: ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`));
        const attempt = (what: string, f: () => string, want: string): void =>
        {
            try
            {
                check(what, f(), want);
            }
            catch (err)
            {
                wn++;
                bad(`${what}: ERROR ${(err as Error).message}`);
            }
        };

        // 1. modifierScopeOf: the surveyed types' top-level `modifier` a character's, a raid intent's a character's too, a
        // scripted modifier's (a weight's part) and a mod's own type's none
        for (const [type, want] of [['laws', 'character'], ['council_positions', 'character'], ['court_positions/types', 'character'], ['focuses', 'character'], ['scripted_relations', 'character'], ['raids/intents', 'character'], ['scripted_modifiers', undefined], ['w_mod_things', undefined], [undefined, 'character']] as [string | undefined, string | undefined][])
            check(`modifierScopeOf(modifier, ${type})`, String(modifierScopeOf('modifier', type)), String(want));

        // 2. cards over a made-up game and mod: a mod type's top-level modifier (no kind: counted as other, its row and
        // its "More modifiers" row without a kind), a building-like entry's Modifiers section with several blocks
        const dir = mkdtempSync(join(tmpdir(), 'ckp-w-cards-'));

        try
        {
            const game = join(dir, 'game');
            const modRoot = join(dir, 'mod');
            const put = (root: string, rel: string, text: string): void => (mkdirSync(join(root, rel, '..'), { recursive: true }), writeFileSync(join(root, rel), text));
            put(game, 'common/modifier_definition_formats/00_w_definitions.txt', 'monthly_prestige = { decimals = 1 }\ntax_mult = { decimals = 0 percent = yes }\nlevy_size = { decimals = 0 percent = yes }\n');
            put(game, 'common/w_mod_things/w.txt', 'w_thing = {\n\tmodifier = {\n\t\tmonthly_prestige = 1\n\t}\n}\n');
            put(modRoot, 'common/w_mod_things/w_mod.txt', 'w_new = {\n\tcost = 5\n}\n');
            put(modRoot, 'common/buildings/w_mod.txt', [
                'w_two = {\n\tcharacter_modifier = {\n\t\tmonthly_prestige = 1\n\t}\n\tcounty_modifier = {\n\t\ttax_mult = 0.1\n\t}\n}',
                'w_top = {\n\tlevy_size = 0.1\n\tcounty_modifier = {\n\t\ttax_mult = 0.1\n\t}\n\tprovince_modifier = {\n\t\tlevy_size = 0.1\n\t}\n}',
                'w_one = {\n\tcounty_modifier = {\n\t\ttax_mult = 0.1\n\t}\n}',
                'w_twice = {\n\tcounty_modifier = {\n\t\ttax_mult = 0.1\n\t}\n\tcounty_modifier = {\n\t\tlevy_size = 0.1\n\t}\n}'
            ].join('\n') + '\n');
            const mod: ModInfo = { id: 'mod/w_test.mod', name: 'W Test', tags: [], root: modRoot, source: 'local', replacePaths: [], status: 'ok', editable: true };
            const idx = new GameIndex(new GameFiles(game, [mod]), 'english');
            idx.build();
            const sb = new StoryBuilder(idx);
            const cardOf = (type: string, name: string) => (idx.get(type, name) ? sb.card(idx.get(type, name)!) : undefined);
            const flatL = (ls: Line[]): Line[] => ls.flatMap((l) => [l, ...flatL(l.children ?? [])]);

            const kinds = sb.modifierKeys().find((k) => k.key === 'monthly_prestige')?.kinds;
            check('a mod type\'s top-level modifier counted as', JSON.stringify(Object.entries(kinds ?? {}).sort()), '[["character",1],["other",1]]');

            attempt('a mod type\'s top-level modifier row', () =>
            {
                const rows = (cardOf('w_mod_things', 'w_thing')?.sections ?? []).flatMap((s) => flatL(s.lines)).filter((l) => l.tip === 'modifier');
                return rows.map((l) => `${l.src?.scope ?? 'none'}/${l.src?.innerScope ?? 'none'}`).join(',') || 'no row';
            }, 'none/none');

            attempt('a mod type\'s "More modifiers" row', () =>
            {
                const more = cardOf('w_mod_things', 'w_new')?.sections.find((s) => s.title === 'More modifiers');
                return (more?.lines ?? []).map((l) => {
                    const at = (l.act?.do as { at?: SectionSource; } | undefined)?.at;
                    return `${at?.key} ${at?.scope ?? 'none'}`;
                }).join(',') || 'no row';
            }, 'modifier none');

            const intoOf = (name: string): string =>
            {
                const s = cardOf('buildings', name)?.sections.find((x) => x.title === 'Modifiers');

                if (!s)
                    return 'no section';

                const where = s.src?.src?.inner && s.src.key !== name ? 'inside ' + s.src.key : 'top';
                return `${where} | ${(s.src?.into ?? []).map((b) => `${b.label}:${b.at.key}:${b.at.scope ?? 'none'}:${b.at.src?.inner ? 'inner' : 'no inner'}`).join(', ')}`;
            };
            check('two blocks, nothing at the top: into', intoOf('w_two'), 'top | Character:character_modifier:character:inner, County:county_modifier:landed_title:inner');
            check('a modifier of its own at the top: no into', intoOf('w_top'), 'top | ');
            check('one block: inside it, no into', intoOf('w_one'), 'inside county_modifier | ');

            attempt('two blocks of one key: two places', () =>
            {
                const s = cardOf('buildings', 'w_twice')?.sections.find((x) => x.title === 'Modifiers');
                const into = s?.src?.into ?? [];
                const starts = new Set(into.map((b) => b.at.src?.s));
                return `${into.length} ${starts.size}`;
            }, '2 2');
        }
        catch (err)
        {
            bad(`cards: ERROR ${(err as Error).stack}`);
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }

        // 3. an on_action's delay as a range: unit, the lowest, then the highest (above it); a written range kept; a
        // duration field that takes no range offers none
        const oa: Req = { kind: 'field', type: 'on_action_lists' };
        attempt('a delay range, typed', () => run(oa, ['Delay…', 'A random time between…', 'Months', { n: 6 }, { n: 12 }, 'Done']), 'months = { 6 12 }');
        attempt('a delay range, by its rows', () => run(oa, ['Delay…', 'A random time between…', 'Days', '5 days', '5–10 days', 'Done']), 'days = { 5 10 }');
        attempt('the highest at or below the lowest refused', () =>
        {
            const s0 = startStates('field', scopeOf(undefined), undefined, 'on_action_lists').at(-1)!.state;
            let s = s0;

            for (const p of ['Delay…', 'A random time between…', 'Months', { n: 6 }] as Step[])
                s = (choose(s, p) as { state: State; }).state;

            const m = menuOf(s, data);
            return `${m.number?.(6, '6').length} ${m.number?.(3, '3').length} ${m.number?.(7, '7').length} ${m.items.map((i) => i.label).join('|')}`;
        }, '0 0 1 6–12 months|6–24 months');
        attempt('a written range kept', () => run({ ...oa, edit: 'months = { 6 12 }' }, ['Keep: 6–12 months', 'Done']), 'months = { 6 12 }');
        attempt('a written range changed to one time', () => run({ ...oa, edit: 'months = { 6 12 }' }, ['1 year', 'Done']), 'years = 1');
        attempt('a written delay kept', () => run({ ...oa, edit: 'days = 5' }, ['Keep: 5 days', 'Done']), 'days = 5');
        // a statement's duration the game takes as a range too (DurationParam.range: trigger_event's delay, a character
        // modifier's and flag's time): the same steps, written into the statement
        attempt('trigger_event: a delay range by its rows', () => run({ kind: 'effect' }, ['Trigger an event…', 'my_events.1', 'A random time between…', 'Days', '5 days', '5–10 days', 'Done']), 'trigger_event = {\n\tid = my_events.1\n\tdays = { 5 10 }\n}');
        attempt('trigger_event: a delay range typed', () => run({ kind: 'effect' }, ['Trigger an event…', 'my_events.1', 'A random time between…', 'Months', { n: 2 }, { n: 4 }, 'Done']), 'trigger_event = {\n\tid = my_events.1\n\tmonths = { 2 4 }\n}');
        attempt('a character modifier for a random time', () => run({ kind: 'effect' }, [ON, E, 'You (self)', 'Add…', 'Modifier', 'my_modifier', 'A random time between…', 'Years', '1 year', '1–3 years', 'Done']), 'add_character_modifier = {\n\tmodifier = my_modifier\n\tyears = { 1 3 }\n}');
        attempt('trigger_event: a written range kept', () =>
        {
            let s = startStates('effect', scopeOf(undefined), undefined, undefined, 'trigger_event = { id = my_events.1 days = { 5 10 } }').at(-1)!.state;
            const seen: string[] = [];

            for (let i = 0; i < 4; i++)
            {
                const m = menuOf(s, data);
                seen.push(`${m.title}: ${m.items.slice(0, 3).map((x) => x.label).join('|')}`);
                const keep = m.items.find((x) => x.label.startsWith('Keep')) ?? m.items.find((x) => x.label === 'Done');

                if (!keep)
                    break;

                const n = choose(s, keep.label);

                if ('finish' in n)
                    return resultText(n.state ?? s);

                s = n.state;
            }

            return seen.join(' / ');
        }, 'trigger_event = {\n\tid = my_events.1\n\tdays = { 5 10 }\n}');
        attempt('no range for a county modifier', () =>
        {
            let s = startStates('effect', scopeOf(undefined)).at(-1)!.state;

            for (const p of [ON, 'Effect on title…', 'Your primary title', 'Add…', 'County modifier', 'my_modifier'] as Step[])
                s = (choose(s, p) as { state: State; }).state;

            return menuOf(s, data).items.some((i) => i.label === 'A random time between…') ? 'offered' : 'none';
        }, 'none');
        attempt('no range for an opinion\'s duration', () =>
        {
            const s = startStates('field', scopeOf(undefined), undefined, 'opinion_modifiers', undefined, undefined, undefined, undefined, undefined, { field: 'duration' }).at(-1)!.state;
            return menuOf(s, data).items.some((i) => i.label === 'A random time between…') ? 'offered' : 'none';
        }, 'none');

        // 4. "More about this list…" inside an iterator being built: options set, back in the block, a statement added;
        // the statements built in it before stay; ← (the state before) is untouched
        const eff: Req = { kind: 'effect' };
        attempt('ordered: up to 3, then a statement', () => run(eff, [ON, E, 'The one with the highest…', 'The child with the highest…', 'Highest age', 'More about this list…', 'Up to how many…', 'Up to 3', 'Add…', 'Gold', { n: 5 }, 'Done']), 'ordered_child = { max = 3 check_range_bounds = no order_by = age add_gold = 5 }');
        attempt('ordered: the second, typed', () => run(eff, [ON, E, 'The one with the highest…', 'The child with the highest…', 'Highest age', 'More about this list…', 'Which one of them…', { n: 1 }, 'Add…', 'Gold', { n: 5 }, 'Done']), 'ordered_child = { position = 1 order_by = age add_gold = 5 }');
        attempt('random: weighted, back, then a statement', () => run(eff, [ON, E, 'A random…', 'A random child', 'More about this list…', 'Weighted by…', 'Add', { n: 10 }, 'Back out', 'And also…', ON, E, 'A random child', 'Add…', 'Gold', { n: 5 }, 'Done']), 'random_child = {\n\tweight = { base = 1 add = 10 }\n\tadd_gold = 5\n}');
        // (the type in force before "Weighted by…" (the request's, InPlaceEdit's `type: t.fields`) comes back with Back out)
        for (const type of ['w_some_fields', undefined])
            attempt(`random: weighted, back out, the type (${type}) restored`, () =>
            {
                let s = startStates('effect', scopeOf(undefined), undefined, type).at(-1)!.state;
                const before = String(s.type);

                for (const p of [ON, E, 'A random…', 'A random child', 'More about this list…', 'Weighted by…'] as Step[])
                    s = (choose(s, p) as { state: State; }).state;

                const inWeight = String(s.type);

                for (const p of ['Add', { n: 10 }, 'Back out'] as Step[])
                    s = (choose(s, p) as { state: State; }).state;

                return `${before} ${inWeight} ${String(s.type)}`;
            }, `${String(type)} weight ${String(type)}`);
        // (the change path: a written iterator weighted, Back out (to the iterator's own "What next?"), then more
        // statements in the same run: "And also…" beside it, "And also for a random child…" inside it)
        const rc = { kind: 'effect', edit: 'random_child = { add_gold = 5 }' } as const;
        attempt('change: weighted, back out, and also beside it', () => run(rc, ['Weighted by…', 'Add', { n: 10 }, 'Back out', 'And also…', ON, E, 'You (self)', 'Add…', 'Prestige', { n: 10 }, 'Done']), 'random_child = {\n\tweight = { base = 1 add = 10 }\n\tadd_gold = 5\n}\nadd_prestige = 10');
        attempt('change: weighted, back out, and also inside it', () => run(rc, ['Weighted by…', 'Add', { n: 10 }, 'Back out', 'And also for a random child…', ON, E, 'A random child', 'Add…', 'Prestige', { n: 10 }, 'Done']), 'random_child = {\n\tweight = { base = 1 add = 10 }\n\tadd_gold = 5\n\tadd_prestige = 10\n}');
        attempt('every: a statement built, the options, another statement', () => run(eff, [ON, E, 'Every…', 'Every child', 'Add…', 'Gold', { n: 5 }, 'And also for', ON, E, 'Each child', 'More about this list…', 'Also the dead', 'Add…', 'Prestige', { n: 10 }, 'Done']), 'every_child = { even_if_dead = yes add_gold = 5 add_prestige = 10 }');
        attempt('two options in a row, then a statement', () => run(eff, [ON, E, 'The one with the highest…', 'The child with the highest…', 'Highest age', 'More about this list…', 'Up to how many…', 'Up to 2', 'More about this list…', 'Also the dead', 'Add…', 'Gold', { n: 5 }, 'Done']), 'ordered_child = {\n\teven_if_dead = yes\n\tmax = 2\n\tcheck_range_bounds = no\n\torder_by = age\n\tadd_gold = 5\n}');
        attempt('a statement before it stays, the options go to the new one', () => run(eff, [...gold, 'And also…', ON, E, 'A random…', 'A random child', 'More about this list…', 'Also the dead', 'Add…', 'Prestige', { n: 10 }, 'Done']), 'add_gold = 100\nrandom_child = { even_if_dead = yes add_prestige = 10 }');
        attempt('a link before the iterator', () => run(eff, [ON, E, 'Your liege', 'Their…', 'Every…', 'Every child', 'More about this list…', 'Also the dead', 'Add…', 'Gold', { n: 5 }, 'Done']), 'liege = {\n\tevery_child = { even_if_dead = yes add_gold = 5 }\n}');
        attempt('any: how many, then a condition', () => run({ kind: 'trigger' }, ['Any of their…', 'Any child', 'More about this list…', 'How many of them…', 'At least 2', 'And also…', 'Any child is…', 'Adult', 'Done']), 'any_child = { count >= 2 is_adult = yes }');
        attempt('← before the options: nothing changed', () =>
        {
            let s = startStates('effect', scopeOf(undefined)).at(-1)!.state;

            for (const p of [ON, E, 'Every…', 'Every child', 'Add…', 'Gold', { n: 5 }, 'And also for', ON, E, 'Each child'] as Step[])
                s = (choose(s, p) as { state: State; }).state;

            const before = JSON.stringify(s);
            let t = (choose(s, 'More about this list…') as { state: State; }).state;
            t = (choose(t, 'Also the dead') as { state: State; }).state;
            return JSON.stringify(s) === before ? 'unchanged' : 'changed';
        }, 'unchanged');
        attempt('not on every vassal (no option for it)', () =>
        {
            let s = startStates('effect', scopeOf(undefined)).at(-1)!.state;

            for (const p of [ON, E, 'Every…', 'Every vassal'] as Step[])
                s = (choose(s, p) as { state: State; }).state;

            return `${menuOf(s, data).title}: ${menuOf(s, data).items.some((i) => i.label === 'More about this list…') ? 'offered' : 'none'}`;
        }, 'Each vassal: none');
        attempt('not in a plain block', () =>
        {
            let s = startStates('effect', scopeOf(undefined)).at(-1)!.state;

            for (const p of [ON, E, 'You (self)'] as Step[])
                s = (choose(s, p) as { state: State; }).state;

            return menuOf(s, data).items.some((i) => i.label === 'More about this list…') ? 'offered' : 'none';
        }, 'none');

        // 5. "Up to how many…" refuses a typed 0; "Which one of them…" takes 0 (the first)
        attempt('a typed 0', () =>
        {
            const s0 = startStates('effect', scopeOf(undefined), undefined, undefined, 'ordered_child = { order_by = age add_gold = 5 }').at(-1)!.state;
            const max = menuOf((choose(s0, 'Up to how many…') as { state: State; }).state, data);
            const pos = menuOf((choose(s0, 'Which one of them…') as { state: State; }).state, data);
            return `${max.number?.(0, '0').length} ${pos.number?.(0, '0').length}`;
        }, '0 1');
        attempt('position 0 written', () => run({ kind: 'effect', edit: 'ordered_child = { order_by = age add_gold = 5 }' }, ['Which one of them…', { n: 0 }, 'Done']), 'ordered_child = { position = 0 order_by = age add_gold = 5 }');

        console.log(`W picker menus: ${wbad ? wbad + ' of ' + wn + ' cases wrong' : wn + ' cases ok'}`);
    }

    // Y (round 13 wave 12, E6r-b, the owner's D3): the scripted lists (common/scripted_lists) beside their base list:
    // "Every powerful vassal" right after "Every vassal", over the base list's items; any_ in a trigger; ordered_ asks
    // its order; a written one changes as an iterator, also when no menu was drawn before (setScriptedLists)
    {
        let ybad = 0;
        let yn = 0;
        const check = (what: string, got: string, want: string): void =>
        {
            yn++;

            if (got !== want)
            {
                ybad++;
                console.log(`MENUS Y ${what}: ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`);
            }
        };
        const attempt = (what: string, f: () => string, want: string): void =>
        {
            try
            {
                check(what, f(), want);
            }
            catch (err)
            {
                yn++;
                ybad++;
                console.log(`MENUS Y ${what}: ERROR ${(err as Error).message}`);
            }
        };
        const scripted: RefEntry[] = [{ name: 'powerful_vassal', refs: 3, base: 'vassal' }, { name: 'theocratic_vassal', refs: 1, base: 'vassal' }, { name: 'held_county', refs: 2, base: 'held_title' }, { name: 'orphan_list', refs: 1, base: 'no_such_list' }];
        LISTS.scripted_lists = scripted;

        try
        {
            // (a written one opened before any menu: the lists as data.ts hands them over at their load)
            setScriptedLists(scripted);
            attempt('a written one changes as an iterator, before any menu', () => run({ kind: 'effect', edit: 'every_powerful_vassal = { add_gold = 5 }' }, ['Another list…', 'Every vassal', 'Done']), 'every_vassal = { add_gold = 5 }');
            attempt('the Every… menu: each scripted list right after its base list', () =>
            {
                let s = startStates('effect', scopeOf(undefined)).at(-1)!.state;

                for (const p of [ON, E, 'Every…'] as Step[])
                    s = (choose(s, p) as { state: State; }).state;

                const labels = menuOf(s, data).items.map((i) => i.label);
                const at = labels.indexOf('Every vassal');
                // (this menu lists a character's lists of characters: a held title's lists are not in it, nor its
                // scripted held county; a list whose base is no list never shows)
                // (powerful_vassal and theocratic_vassal are in the catalog too: once each, beside their base)
                const once = labels.filter((l) => l === 'Every powerful vassal').length === 1 && labels.filter((l) => l === 'Every theocratic vassal').length === 1;
                return `${labels.slice(at, at + 3).join(' | ')}; once ${once}; held county with held title ${labels.includes('Every held title') === labels.includes('Every held county')}; orphan ${labels.some((l) => l.includes('orphan'))}`;
            }, 'Every vassal | Every powerful vassal | Every theocratic vassal; once true; held county with held title true; orphan false');
            attempt('the Every… menu waits for the scripted lists while they load', () =>
            {
                let s = startStates('effect', scopeOf(undefined)).at(-1)!.state;

                for (const p of [ON, E, 'Every…'] as Step[])
                    s = (choose(s, p) as { state: State; }).state;

                const loading: PickerData = { ...data, list: (t) => (t === 'scripted_lists' ? undefined : data.list(t)), loaded: () => Promise.resolve() };
                return `${!!menuOf(s, loading).wait} ${!!menuOf(s, data).wait}`;
            }, 'true false');
            attempt('a title list: the scripted held county right after its base', () =>
            {
                let s = startStates('effect', scopeOf(undefined)).at(-1)!.state;

                for (const p of [ON, E, 'Every…'] as Step[])
                    s = (choose(s, p) as { state: State; }).state;

                // (every list of the place, whatever its type: the view the "Every…" rows come from, without the type)
                const all = menuOf({ ...s, view: { v: 'iters', mode: 'every' } } as State, data).items.map((i) => i.label);
                const at = all.indexOf('Every held title');
                return at < 0 ? `no held title row (${all.length} rows)` : all.slice(at, at + 2).join(' | ');
            }, 'Every held title | Every held county');
            attempt('every_ built, a character effect inside', () => run({ kind: 'effect' }, [ON, E, 'Every…', 'Every powerful vassal', 'Add…', 'Gold', { n: 5 }, 'Done']), 'every_powerful_vassal = { add_gold = 5 }');
            attempt('any_ in a trigger', () => run({ kind: 'trigger' }, ['Any of their…', 'Any powerful vassal', 'Adult', 'Done']), 'any_powerful_vassal = { is_adult = yes }');
            attempt('ordered_ asks its order', () => run({ kind: 'effect' }, [ON, E, 'The one with the highest…', 'The powerful vassal with the highest…', 'Highest age', 'Add…', 'Prestige', { n: 10 }, 'Done']), 'ordered_powerful_vassal = { order_by = age add_prestige = 10 }');
            // (wave 11's Special values: the section's ＋ leaves out a block the doctrine writes already (its row's ⤷＋
            // adds to it; the section passes them as `common`); an opinion override takes whole numbers from 1 up)
            // (the holder of "Give a title to someone" is written inside the title's block: a prev-based holder would be
            // prev.prev, which the game refuses (round 13's second in-game test): no such row, a typed one refused)
            attempt('Give a title: no prev-based holder', () =>
            {
                setPlaceScopes({ prev: ['character'] });

                try
                {
                    let s = startStates('effect', 'character').at(-1)!.state;

                    for (const p of [ON, E, 'You (self)', 'Do…', 'Give a title to someone', { input: 'k_france' }] as Step[])
                        s = (choose(s, p) as { state: State; }).state;

                    const m = menuOf(s, data);
                    const prevRows = m.items.filter((i) => /^prev(\.|$)/.test(String(i.hint ?? ''))).length;
                    const typed = m.input?.('prev');
                    const liege = m.input?.('liege');
                    return `${m.title} | prev rows ${prevRows} | typed prev ${typed?.role ?? 'row'} ${typed?.go ? 'go' : 'no go'} | typed liege ${liege?.go ? 'go' : 'no go'}`;
                }
                finally
                {
                    setPlaceScopes({});
                }
            }, 'Who gets it? | prev rows 0 | typed prev info no go | typed liege go');
            attempt('Special values ＋: written blocks left out', () =>
            {
                const rows = (common?: string[]): string => menuOf(startStates('field', 'character', undefined, 'special_parameters', undefined, undefined, undefined, undefined, undefined, common ? { common } : {}).at(-1)!.state, data).items.map((i) => i.label).filter((l) => /^(Hostility by|Opinion of faiths)/.test(l)).join(' | ');
                return `${rows()} / ${rows(['hostility_levels', 'parameter_opinion_override'])}`;
            }, 'Hostility by relation… | Hostility by doctrine or tenet… | Opinion of faiths with a parameter… / Hostility by doctrine or tenet…');
            attempt('an opinion override: whole numbers from 1 up', () =>
            {
                const s0 = startStates('field', 'character', undefined, 'parameter_opinion_override').at(-1)!.state;
                const m = menuOf((choose(s0, { input: 'v_param' }) as { state: State; }).state, data);
                return [0, -5, 2.5, 12].map((n) => { const r = m.number?.(n, String(n))[0]; return `${n}:${r?.go ? 'row' : r?.role ?? 'none'}`; }).join(' ');
            }, '0:info -5:info 2.5:info 12:row');
        }
        finally
        {
            delete LISTS.scripted_lists;
            setScriptedLists([]);
        }

        console.log(`Y scripted lists: ${ybad ? ybad + ' of ' + yn + ' cases wrong' : yn + ' cases ok'}`);
    }

    // D (the script database on every pick): the rows standing for a game key carry it (Item.doc: the preview's doc
    // card), a row without a tooltip gets the explanation's summary; "Other…" leaves out a key the game documents for
    // other scopes only and offers documented keys the script never uses
    {
        let dbad = 0;
        let dn = 0;
        const attempt = (what: string, f: () => string, want: string): void =>
        {
            dn++;

            try
            {
                const got = f();

                if (got !== want)
                    (dbad++, console.log(`MENUS D ${what}: ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`));
            }
            catch (err)
            {
                dbad++;
                console.log(`MENUS D ${what}: ERROR ${(err as Error).message}`);
            }
        };
        const LABELS: Record<string, Record<string, [string, string]>> = {
            link: { liege: ['Liege', 'The liege summary'] },
            effect: { d_documented_unused_effect: ['Unused', 'Never written by vanilla'] }
        };
        const ddata: PickerData = {
            ...data,
            docLabel: (kind, key) => LABELS[kind]?.[key],
            docLabels: (kind) => LABELS[kind] ?? {},
            docLabelsLoaded: async () => undefined
        };
        const at = (path: Step[], scope?: string): Menu =>
        {
            let s = startStates('effect', scopeOf(scope)).at(-1)!.state;

            for (const p of path)
                s = (choose(s, p) as { state: State; }).state;

            return menuOf(s, ddata);
        };
        const docOf = (m: Menu, label: string): string =>
        {
            const i = m.items.find((x) => x.label === label);
            return i ? (i.doc ? `${i.doc.kind}:${i.doc.key}` : 'none') : 'no row';
        };
        attempt('a statement row', () => docOf(at([ON, E, 'You (self)', 'Add…']), 'Gold'), 'effect:add_gold');
        attempt('a choice in the key: the value row', () => docOf(at([ON, E, 'You (self)', 'Add…', 'Skill…']), 'Diplomacy'), 'effect:add_diplomacy_skill');
        attempt('a link row, its summary as the tooltip', () =>
        {
            const m = at([ON, E]);
            return `${docOf(m, 'Your liege')} ${m.items.find((x) => x.label === 'Your liege')?.title}`;
        }, 'link:liege The liege summary');
        attempt('a list row', () => docOf(at([ON, E, 'Every…']), 'Every vassal'), 'list:vassal');
        attempt('"Effect on" a type', () => docOf(at([ON]), 'Effect on title…'), 'scope_type:landed_title');
        attempt('an Other key row', () => docOf(at(['Other effect…']), 'add_gold'), 'effect:add_gold');
        attempt('Other: a documented key the script never uses', () =>
        {
            const r = at(['Other effect…']).items.find((x) => x.label === 'd_documented_unused_effect');
            return r ? `${r.hint} ${r.doc?.kind}:${r.doc?.key}` : 'no row';
        }, 'documented · unused effect:d_documented_unused_effect');

        // (a key the scan knows that the docs give for titles only: not offered at a character, offered at a title)
        const facts = scriptFacts();
        const titleOnly = facts?.statements.find((x) => x.kind === 'effect' && x.scope.length && !x.scope.includes('character') && x.scope.includes('landed_title') && known.effect.has(x.key))?.key;

        if (titleOnly)
            attempt(`Other: ${titleOnly}, documented for titles`, () => `${at(['Other effect…']).items.some((x) => x.label === titleOnly)} ${at(['Other effect…'], 'landed_title').items.some((x) => x.label === titleOnly)}`, 'false true');
        else if (withFacts)
            (dn++, dbad++, console.log('MENUS D no scanned effect documented for titles only'));

        console.log(`D script database rows: ${dbad ? dbad + ' of ' + dn + ' cases wrong' : dn + ' cases ok'}`);
    }

    console.log(`menus:${bad ? bad + ' of ' + scenarios.length + ' scenarios wrong' : scenarios.length + ' scenarios ok'}`);
}
