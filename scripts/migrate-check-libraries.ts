// Checks the definition libraries of "Fix for 1.20…" (src/main/mods/libraries.ts, libraryRule.ts, scriptProbes.ts) on a TEMP user
// folder: a mod with older copies of game files whose entries it took out on purpose, and more registries a copy hides. An entry the
// mod's files have commented out is not brought back, a flag word its entry has commented out is not added, an entry another mod
// redefines gets no copy; invite rules, secret types, interaction categories, modifier formats and a doctrine's parameters are
// carried; a localization string the mod replaces names nothing; the notes tell the events a copy of an event file hides, moved
// entries the mod's copy still wins, and macro calls whose arguments do not fit.
// The on_actions the engine fires (the personal tenet window of 1.20 crashes the game without on_personal_tenet_gain) are carried when a
// mod's copy of the game's file hides them, and a static check (on-action-check.ts) finds none missing afterwards; a mod's interaction category
// with the index of a game category gets the next free one; portrait animations whose states or packs the loaded files lack are not carried (a pack the
// modelStates rule gives the copy of the game's pack file counts). The rest of the migration is scripts/migrate-check.ts.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=6000 scripts/migrate-check-libraries.ts [keep]
// Every index it builds is a fresh build of its mods' layering on parse threads (scripts/fast-index.ts buildIndex), never from a cache;
// the game's script files are parsed once per run, by the first build: the later builds take the game files' parse results it kept
// (fast-index.ts ParseReuse: the same index, number for number; reused for a file only with the same size and times, the kept
// results read only, checked again at the end) and parse only their mods' files. THREADS=0: one thread, nothing kept.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { modsOfList, modsState, type ModsHost } from '../src/main/mods/manager.ts';
import { guiWork, type GuiConfig } from '../src/main/mods/guiWork.ts';
import { migrationLibraries, type LibraryConfig } from '../src/main/mods/libraries.ts';
import type { InertOptions } from '../src/main/mods/inertWork.ts';
import { absentNames, knownNames, migrationPlan, stillOld } from '../src/main/mods/migrations.ts';
import { migrateMod, planMigration } from '../src/main/mods/migrate.ts';
import { parse } from '../src/main/indexer/parser.ts';
import { defaultInstall } from './ck3-install.ts';
import { buildIndex, ParseReuse } from './fast-index.ts';
import { engineOnActionsMissing } from './on-action-check.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

const install = defaultInstall();
const gameDir = resolveGameDir(install)!;
const tmp = mkdtempSync(join(tmpdir(), 'ckp-libraries-'));
mkdirSync(join(tmp, 'mod'), { recursive: true });

const files = (dir: string): Map<string, string> =>
{
    const out = new Map<string, string>();
    const walk = (d: string): void =>
    {
        for (const e of readdirSync(d, { withFileTypes: true }))
            e.isDirectory() ? walk(join(d, e.name)) : out.set(join(d, e.name), readFileSync(join(d, e.name), 'utf8'));
    };
    walk(dir);
    return out;
};

const settings: Settings = { gameDir: install, language: 'english', userDir: tmp, customModLists: [{ id: 'l1', name: 'Test list', mods: [] }], modList: 'custom:l1' };
let idx!: GameIndex;
let sb!: StoryBuilder;
let builds = 0;
/** the game files' parse results of the first build, for every later one (see the header) */
const gameParses = new ParseReuse(gameDir);
/** ms spent in the builds (overlapping ones counted each) */
let buildMs = 0;
const reindex = async (): Promise<void> =>
{
    const state = await modsState(host);
    const t0 = performance.now();
    idx = await buildIndex(new GameIndex(new GameFiles(gameDir, modsOfList(state, state.selected)), 'english'), undefined, gameParses);
    buildMs += performance.now() - t0;
    sb = new StoryBuilder(idx);
    builds++;
};
let pending: Promise<void> = Promise.resolve();
const queries: Record<string, (...a: never[]) => unknown> = {
    migrationPlan: (modId: string, supported?: string, game?: string, patchId?: string) => migrationPlan(idx, sb, modId, supported, game, patchId),
    migrationStillOld: (type: string, name: string) => stillOld(idx, sb, type, name),
    migrationLibraries: (modId: string, patchId: string | undefined, config: LibraryConfig, extra: string[], inert?: InertOptions) => migrationLibraries(idx, config, modId, patchId, extra, inert),
    migrationNames: (refs: string[]) => absentNames(idx, refs),
    // (which of the names the index has, as the worker answers the renamed rule: indexWorker.ts migrationKnown)
    migrationKnown: (names: string[]) => knownNames(idx, names),
    migrationGui: (config: GuiConfig, modId: string, patchId: string | undefined) => guiWork(idx, config, modId, patchId)
};
const host: ModsHost = {
    settings: () => settings,
    updateSettings: (patch) => Object.assign(settings, patch),
    gameDir: () => gameDir,
    documents: () => join(tmp, 'no-documents'),
    reindex: () => void (pending = reindex()),
    ready: () => pending,
    query: async <T>(method: string, ...params: unknown[]): Promise<T> =>
        (queries[method] ? queries[method](...(params as never[])) : (idx as unknown as Record<string, (...a: unknown[]) => T>)[method](...params)) as T,
    wrote: () => undefined,
    refreshFiles: async (f) =>
    {
        idx.refreshFiles(f);
        sb = new StoryBuilder(idx);
    },
    dataDir: () => join(tmp, 'data')
};

try
{
    {
        const root12 = join(tmp, 'mod', 'old_mod12');
        const put12 = (rel: string, text: string): void =>
        {
            mkdirSync(join(root12, rel, '..'), { recursive: true });
            writeFileSync(join(root12, rel), '﻿' + text);
        };
        const desc12 = 'version="1.0"\nname="Old Mod Twelve"\nsupported_version="1.19.0.6"\n';
        mkdirSync(root12, { recursive: true });
        writeFileSync(join(root12, 'descriptor.mod'), desc12);
        writeFileSync(join(tmp, 'mod', 'old_mod12.mod'), `${desc12}path="${root12.replace(/\\/g, '/')}"\n`);
        // (a mod loading after it that redefines a law of its)
        const root12b = join(tmp, 'mod', 'old_mod12b');
        const desc12b = 'version="1.0"\nname="Old Mod Twelve B"\nsupported_version="1.20.0.4"\n';
        mkdirSync(join(root12b, 'common', 'laws'), { recursive: true });
        writeFileSync(join(root12b, 'descriptor.mod'), desc12b);
        writeFileSync(join(root12b, 'common', 'laws', '20_other_laws.txt'), '﻿mandala_decree_expansion = {\n\tlaw_group_type = mandala_decree\n\tindex = 2\n\tflag = z_mark\n}\n');
        writeFileSync(join(tmp, 'mod', 'old_mod12b.mod'), `${desc12b}path="${root12b.replace(/\\/g, '/')}"\n`);
        // (the cat triggers are commented out by the mod: other game files name them; one the mod's own script names; the dog trigger is simply missing)
        put12('common/scripted_triggers/00_pet_triggers.txt', 'om12_pet_trigger = { always = yes }\n\n# \t\t\thas_dog_trigger = yes\n#has_dog_trigger = yes\n# has_dog_trigger = no\n# has_cat_trigger = {\n# \talways = yes\n# }\n\n#has_named_cat_trigger = {\n#\talways = yes\n#}\n');
        // (macro calls: an argument the definition does not take, a required one left out, one with a default, a conditional part,
        // a NOT in the block, a definition with a lower-case parameter; a call of the game's effect without the argument it needs)
        put12('common/scripted_effects/om12_effects.txt', 'om12_use_effect = {\n\tif = {\n\t\tlimit = { has_named_cat_trigger = yes }\n\t\tadd_gold = 1\n\t}\n\tom12_macro_effect = { AMOUNT = 1 EXTRA = 2 }\n\tom12_macro_effect = { PRESTIGE = 1 }\n\tom12_macro_effect = { AMOUNT = 5 NOT = { always = no } }\n\tvar:om12_macro_effect = { add_gold = 1 }\n\tscope:x.om12_macro_effect = { add_gold = 1 }\n\tom12_cmp_trigger = { AMOUNT >= 5 }\n\tom12_cmp_trigger = { AMOUNT <= 9 }\n\thire_for_court_position_journey_laamp_replacement_effect = { CHARACTER = scope:om12 COURT_POSITION = chancellor }\n}\n\nom12_macro_effect = {\n\tadd_gold = $AMOUNT$\n\t[[PRESTIGE]\n\tadd_prestige = $PRESTIGE$\n\t]\n\tadd_piety = $PIETY|0$\n}\n\nom12_lower_effect = {\n\tadd_gold = $amount$\n}\n\nom12_cmp_trigger = {\n\tgold >= $AMOUNT$\n}\n\nom12_lower_use_effect = {\n\tom12_lower_effect = { amount = 5 other = 1 }\n}\n');
        // (laws: the flag the author commented out; flags the game gave the law since; a law another mod redefines)
        put12('common/laws/00_realm_laws.txt', '#old_decree = {\n#\tflag = vassals_more_inclined_to_convert\n#}\nmandala_decree_reverence = {\n\tlaw_group_type = mandala_decree\n\tindex = 3\n\t#Standard laws\n\t# vassals_more_inclined_to_convert is a word the game gave this law\n\tflag = can_have_tributaries\n\t#EK EDIT: can\'t turn subjects into Mandalas\n\t#flag = can_convert_all_subjects_to_mandalas\n}\n\nmandala_decree_expansion = {\n\tlaw_group_type = mandala_decree\n\tindex = 2\n\tflag = can_have_tributaries\n}\n');
        // (a doctrine without the parameter 1.20.1 gave it, which a game file tests)
        put12('common/religion/doctrine_types/20_doctrines.txt', 'doctrine_clerical_succession_temporal_appointment = {\n\tdoctrine_group_type = doctrine_clerical_succession\n\tindex = 0\n\tparameters = {\n\t\tclerical_appointment_ruler\n\t\tclerical_appointment_fixed_disabled\n\t}\n}\n');
        put12('common/activities/guest_invite_rules/activity_invite_rules.txt', 'om12_invite_rule = {\n\tallow = { always = yes }\n}\n');
        put12('common/secret_types/00_secret_types.txt', 'om12_secret = {\n\tcategory = secret_category_personal\n}\n');
        put12('common/character_interaction_categories/00_character_interaction_categories.txt', 'interaction_category_om12 = {\n\tname = om12_category\n}\n');
        // (the formats: the mod's older copies lack the engine's own; its culture and the format file of the cultures are the mod's, so
        // the game's cultures are gone: kru is, levantine is defined in a file the mod does not hide)
        put12('common/modifier_definition_formats/00_definitions.txt', 'om12_modifier = {\n\tdecimals = 1\n}\n');
        put12('common/modifier_definition_formats/00_culture_definitions.txt', 'om12_culture_opinion = {\n\tdecimals = 0\n}\n');
        // (the traits file is the mod's too: the game's lifestyle_scholar is gone, so the format of lifestyle_scholar_xp_gain_mult, which the engine
        // generates from that trait, has nothing to format)
        put12('common/traits/00_traits.txt', 'om12_scholar = {\n\tindex = 9999\n}\n');
        put12('common/culture/cultures/00_akan.txt', 'om12_culture = {\n\tcolor = { 0.1 0.2 0.3 }\n}\n');
        // (a string the mod replaces names nothing: GreetingToLiegePositive, which two keys name and the mod replaces both; GreetingToLiegeNegative is still shown by the game's text)
        put12('common/customizable_localization/00_greeting_custom_loc.txt', 'om12_greeting = {\n\ttype = character\n\ttext = { localization_key = om12_greeting_text }\n}\n');
        put12('localization/replace/english/om12_greeting_l_english.yml', 'l_english:\n greeting_liege_positive:1 "Greetings, [second.GetNameNoTooltip],"\n greeting_appropriate_positive_liege:1 "Greetings, [second.GetNameNoTooltip],"\n');
        // (an entry the game moved to the file that loads before the mod's copy of 07_ep3_values.txt: one body the same, one different)
        const gameValues = readFileSync(join(gameDir, 'common', 'script_values', '07_appointment_values.txt'), 'utf8').replace(/^﻿/, '');
        const sameValue = parse(gameValues).find((n) => n.k === 'appointment_score_max_tt_value')!;
        put12('common/script_values/07_ep3_values.txt', `${gameValues.slice(sameValue.s, sameValue.e)}\n\nappointment_investment_cap = 75\n`);
        // (the mod's copy of an event file: most of the game's events are gone, game files fire them)
        put12('events/activities/hunt_activity/hunt_events.txt', 'namespace = hunt\n\nhunt.0001 = {\n\ttype = character_event\n}\n');
        settings.customModLists![0].mods.push({ id: 'mod/old_mod12.mod', enabled: true }, { id: 'mod/old_mod12b.mod', enabled: true });
        await reindex();
        const lib12 = (p: Awaited<ReturnType<typeof planMigration>>) => (p.rewrites ?? []).filter((x) => x.kind === 'libraries');
        const plan12 = await planMigration(host, 'mod/old_mod12.mod');
        const r12m = await migrateMod(host, 'mod/old_mod12.mod');
        const patch12 = join(tmp, 'mod', 'old_mod12_1_20_fixes');
        const zz12 = (folder: string): string =>
        {
            const dir = join(patch12, ...folder.split('/'));
            return existsSync(dir) ? readdirSync(dir).filter((n) => /^zz+_old_mod12_1_20_fixes_library\.txt$/.test(n)).map((n) => readFileSync(join(dir, n), 'utf8')).join('') : '';
        };
        const defs12 = (text: string): string[] => [...text.matchAll(/^([A-Za-z0-9_]+) = /gm)].map((m) => m[1]);
        const notes12 = [...(plan12.notes ?? []), ...r12m.notes];
        const note12 = (re: RegExp): string => notes12.find((n) => re.test(n)) ?? '';
        check(!r12m.failed.length, `the run of the twelfth mod: nothing failed (${r12m.failed.join(', ')})`);
        // (a) entries the author commented out
        const trig12 = defs12(zz12('common/scripted_triggers'));
        check(trig12.includes('has_dog_trigger') && trig12.includes('has_named_cat_trigger') && !trig12.includes('has_cat_trigger'), `an entry the mod’s file has commented out is not carried although game files name it, unless a script file of the mod names it: ${trig12.join(', ')}`);
        check(/^Scripted triggers: 1 entry the mod’s files have commented out \(the author took it out\) is left out although other files name it — has_cat_trigger \(/.test(note12(/commented out \(the author took it out\) is left out/)), `the plan tells the entry left out: ${note12(/commented out \(the author took it out\) is left out/)}`);
        // (b) a flag the author commented out; the others the game gave the law are added
        const laws12 = zz12('common/laws');
        check(/mandala_decree_reverence = \{/.test(laws12) && /^\s*flag = vassals_more_inclined_to_convert/m.test(laws12) && !/^\s*flag = can_convert_all_subjects_to_mandalas/m.test(laws12) && /^\s*#flag = can_convert_all_subjects_to_mandalas/m.test(laws12), `a flag word the entry has commented out is not added, the others are: ${laws12.replace(/\r?\n/g, '↵').slice(0, 400)}`);
        check(/Law flags: 1 flag the game’s entry has and loaded files test is left out because the mod’s entry has it commented out \(the author took it out\): can_convert_all_subjects_to_mandalas \(mandala_decree_reverence\)/.test(note12(/commented out \(the author took/)), `the flag word left out is told: ${note12(/Law flags: .*commented out/)}`);
        // (c) another mod redefines the entry after the mod: no copy that would win over it
        check(!defs12(laws12).includes('mandala_decree_expansion') && /Law flags: 1 entry of the mod is defined again by a file that loads after it.*mandala_decree_expansion \(common\/laws\/20_other_laws\.txt\)/.test(note12(/defined again by a file that loads after/)), `an entry another mod defines last gets no copy, and it is told: ${note12(/defined again by a file that loads after/)}`);
        // (d) a doctrine parameter: the mod's doctrine knows none of 1.20's keys, so the gains rule gives it the game's `divergence` and the parameters
        // the game's entry has, in the patch mod's copy of the file, among them the one game files test, which the libraries rule would add, so
        // the plan does not list it as a library entry as well (it did, and the run then found nothing left for it: the second plan had one entry fewer)
        const doc12 = readFileSync(join(patch12, 'common', 'religion', 'doctrine_types', '20_doctrines.txt'), 'utf8');
        check(/doctrine_clerical_succession_temporal_appointment = \{[^]*parameters = \{[^}]*clerical_appointment_fixed_disabled[^}]*clerical_appointment_ruler_can_replace_ecc[^}]*\}/.test(doc12) && plan12.rewrites!.some((x) => x.kind === 'gains' && x.todo.length > 0) && !lib12(plan12).some((x) => x.label.startsWith('Doctrine parameters:')) && !zz12('common/religion/doctrine_types'), `a doctrine gets the parameter the game gave its entry from the gains rule, once (${doc12.replace(/\r?\n/g, '↵').slice(0, 400)})`);
        // (e) the folders the game's files name
        check(defs12(zz12('common/activities/guest_invite_rules')).includes('activity_invite_cardinals') && defs12(zz12('common/secret_types')).includes('secret_forbidden_personal_tenet') && defs12(zz12('common/character_interaction_categories')).includes('interaction_debug_mpo'), 'invite rules, secret types and interaction categories the game’s files name are carried');
        // (f) the formats the engine asks for
        const fmt12 = defs12(zz12('common/modifier_definition_formats'));
        check(fmt12.includes('piety_standalone_gain_mult') && fmt12.includes('personal_tenet_slot_add') && fmt12.length > 20, `modifier formats the mod’s copies lack are carried (${fmt12.length})`);
        check(!fmt12.includes('kru_opinion') && fmt12.includes('levantine_opinion'), 'the format about a culture the loaded files lack (kru) is not carried; one about a culture they define (levantine) is');
        check(!fmt12.includes('lifestyle_scholar_xp_gain_mult'), 'the format about a trait the loaded files lack (the game’s lifestyle_scholar, in a file the mod hides) is not carried');
        // (g) the localization the mod replaces
        const cl12 = defs12(zz12('common/customizable_localization'));
        check(cl12.includes('GreetingToLiegeNegative') && !cl12.includes('GreetingToLiegePositive'), `an entry only a replaced localization string named is not carried: ${cl12.filter((n) => /^GreetingToLiege/.test(n)).join(', ')}`);
        // (h) the notes
        check(/appointment_investment_cap \(script_values\) is defined in the game’s new common\/script_values\/07_appointment_values\.txt .* and in the mod’s common\/script_values\/07_ep3_values\.txt, which loads after it, so the mod’s older body wins/.test(note12(/appointment_investment_cap/)) && !notes12.some((n) => n.startsWith('appointment_score_max_tt_value')), `an entry the game moved to an earlier file that the mod’s copy still wins is told when the bodies differ: ${note12(/appointment_investment_cap/)}`);
        check(/^events\/activities\/hunt_activity\/hunt_events\.txt: the game’s file has \d+ events, the mod’s copy hides \d+ that other loaded files still fire — .*hunt\.00/.test(note12(/hunt_events\.txt: the game’s file has/)), `events the mod’s copy hides that other files fire are told: ${note12(/hunt_events\.txt: the game’s file has/).slice(0, 200)}`);
        check(/^om12_macro_effect \(scripted effect\) in the mod’s common\/scripted_effects\/om12_effects\.txt: callers pass EXTRA \(1, .*\) that it does not take; callers leave out AMOUNT \(1, .*\) that it needs \(it takes AMOUNT, PIETY, PRESTIGE\)/.test(note12(/^om12_macro_effect/)), `macro arguments that do not fit the definition are told (a NOT, a default and a conditional part are no drift): ${note12(/^om12_macro_effect/)}`);
        check(/^hire_for_court_position_journey_laamp_replacement_effect \(scripted effect\) in the game’s .*callers leave out CURRENT_HOLDER/.test(note12(/^hire_for_court_position_journey_laamp_replacement_effect/)), `a mod’s call of the game’s macro effect without its argument is told: ${note12(/^hire_for_court_position_journey_laamp_replacement_effect/).slice(0, 220)}`);
        check(!notes12.some((n) => n.startsWith('om12_cmp_trigger')), `calls that give an argument with a comparison (AMOUNT >= 5) are no missing arguments: ${note12(/^om12_cmp_trigger/)}`);
        check(!notes12.some((n) => n.startsWith('om12_macro_effect') && /AMOUNT \((?!1,)/.test(n)), `var:name = { } and scope:x.name = { } are no calls of the effect: ${note12(/^om12_macro_effect/)}`);
        check(!notes12.some((n) => n.startsWith('om12_lower_effect')), 'a definition with a lower-case parameter is not checked (its arguments cannot be told from its other statements)');
        // (i) a second run writes nothing
        const before12 = files(patch12);
        const again12 = await planMigration(host, 'mod/old_mod12.mod');
        check(lib12(again12).length === lib12(plan12).length && lib12(again12).every((x) => x.todo.length === 0), 'the plan of a second run: every library rule done');
        const r12n = await migrateMod(host, 'mod/old_mod12.mod');
        const after12 = files(patch12);
        check(!r12n.rewritten.length && after12.size === before12.size && [...before12].every(([k, v]) => after12.get(k) === v), `a second run writes nothing (${r12n.rewritten.join(', ')})`);
        check(note12(/commented out \(the author took it out\) is left out/) !== '' && r12n.notes.some((n) => /commented out \(the author took it out\) is left out/.test(n)) && r12n.notes.some((n) => /^hunt|events\/activities\/hunt_activity\/hunt_events\.txt: the game’s file has/.test(n)), 'the notes of a second run are the same');
        // (j) a mod that knows 1.20's `divergence` of doctrines (it carries one): the gains rule leaves its doctrines alone, so the libraries rule is the one
        // that adds the parameter game files test (bare, after the others) and the plan lists it
        {
            const root12c = join(tmp, 'mod', 'old_mod12c');
            const desc12c = 'version="1.0"\nname="Old Mod Twelve C"\nsupported_version="1.19.0.6"\n';
            mkdirSync(join(root12c, 'common', 'religion', 'doctrine_types'), { recursive: true });
            writeFileSync(join(root12c, 'descriptor.mod'), desc12c);
            writeFileSync(join(root12c, 'common', 'religion', 'doctrine_types', '20_doctrines.txt'), '﻿doctrine_clerical_succession_spiritual_appointment = {\n\tdoctrine_group_type = doctrine_clerical_succession\n\tindex = 1\n\tdivergence = 10\n\tparameters = {\n\t\tclerical_appointment_head_of_faith\n\t\tclerical_appointment_fixed_disabled\n\t}\n}\n');
            writeFileSync(join(tmp, 'mod', 'old_mod12c.mod'), `${desc12c}path="${root12c.replace(/\\/g, '/')}"\n`);
            // (out of the list, the mod before: its file of the same name would hide this one, and the game's file has to be hidden by the mod that is tested)
            settings.customModLists![0].mods = settings.customModLists![0].mods.filter((m) => !/^mod\/old_mod12(\.mod|_1_20)/i.test(m.id));
            settings.customModLists![0].mods.push({ id: 'mod/old_mod12c.mod', enabled: true });
            await reindex();
            const plan12c = await planMigration(host, 'mod/old_mod12c.mod');
            const r12c = await migrateMod(host, 'mod/old_mod12c.mod');
            const patch12c = join(tmp, 'mod', 'old_mod12c_1_20_fixes', 'common', 'religion', 'doctrine_types');
            const lib12c = existsSync(patch12c) ? readdirSync(patch12c).filter((n) => /^zz+_.*_library\.txt$/.test(n)).map((n) => readFileSync(join(patch12c, n), 'utf8')).join('') : '';
            check(!r12c.failed.length && !(plan12c.rewrites ?? []).some((x) => x.kind === 'gains' && x.todo.length > 0) && lib12(plan12c).some((x) => x.label.startsWith('Doctrine parameters:') && x.todo.length > 0) && /doctrine_clerical_succession_spiritual_appointment = \{[^]*parameters = \{[^}]*clerical_appointment_fixed_disabled[^}]*clerical_appointment_hof_can_replace_ecc[^}]*\}/.test(lib12c), `a doctrine of a mod that knows 1.20's divergence gets the parameter from the libraries rule (${r12c.failed.join(', ')}; ${lib12c.replace(/\r?\n/g, '↵').slice(0, 300)})`);
            const again12c = await planMigration(host, 'mod/old_mod12c.mod');
            check(lib12(again12c).length === lib12(plan12c).length && lib12(again12c).every((x) => x.todo.length === 0), 'the plan of a second run of that mod: every library rule done');
        }

        // (k) the on_actions the engine fires: a mod that replaces the game's religion, inventory, holy order and army on_action files with
        // copies of its own (AGOT does) takes `on_personal_tenet_gain` and 13 more with them, and the engine logs "Couldn't find predefined
        // on action" and, 1.20's personal tenet window, crashes the game. They are carried, with the hooks of those files that nothing names
        // (on_army_monthly …) and what a carried hook fires in turn (on_faith_monthly fires faith_rite_growth_pulse); one a loaded script names
        // is carried; the ones only the game's own hidden files name (the Toledo council's, in a file, an event file and a decision file the
        // mod replaces) stay a note
        {
            const root13 = join(tmp, 'mod', 'old_mod13f');
            const desc13 = 'version="1.0"\nname="Old Mod Thirteen F"\nsupported_version="1.19.0.6"\n';
            const put13 = (rel: string, text: string): void =>
            {
                mkdirSync(join(root13, rel, '..'), { recursive: true });
                writeFileSync(join(root13, rel), '﻿' + text);
            };
            mkdirSync(root13, { recursive: true });
            writeFileSync(join(root13, 'descriptor.mod'), desc13);
            writeFileSync(join(tmp, 'mod', 'old_mod13f.mod'), `${desc13}path="${root13.replace(/\\/g, '/')}"\n`);
            for (const f of ['religion_on_actions', 'inventory_on_actions', 'holy_order_on_actions', 'army_on_actions'])
                put13(`common/on_action/${f}.txt`, `om13_${f}_hook = {\n\teffect = { add_gold = 1 }\n}\n`);
            // (a script of the mod fires an on_action of the hidden file: carried because a loaded file names it)
            put13('common/scripted_effects/om13_effects.txt', 'om13_fire_effect = {\n\ttrigger_event = { on_action = update_main_rite_action days = 3 }\n}\n');
            // (the on_actions of the Toledo council, named by the game's own event file and decision file, which the mod replaces as well)
            put13('common/on_action/dlc/fp2/fp2_other_decision_on_actions.txt', 'om13_toledo_hook = {\n\teffect = { add_gold = 1 }\n}\n');
            put13('events/dlc/fp2/fp2_other_decision_events.txt', 'namespace = om13_toledo\n');
            put13('common/decisions/dlc_decisions/03_fp2_decisions.txt', 'om13_toledo_decision = {\n\tis_shown = { always = no }\n}\n');
            settings.customModLists![0].mods = [{ id: 'mod/old_mod13f.mod', enabled: true }];
            await reindex();
            const before13 = engineOnActionsMissing(idx.vfs);
            const plan13 = await planMigration(host, 'mod/old_mod13f.mod');
            const r13 = await migrateMod(host, 'mod/old_mod13f.mod');
            const patch13 = join(tmp, 'mod', 'old_mod13f_1_20_fixes');
            const dir13 = join(patch13, 'common', 'on_action');
            const zz13 = existsSync(dir13) ? readdirSync(dir13).filter((n) => /^zz+_.*_library\.txt$/.test(n)).map((n) => readFileSync(join(dir13, n), 'utf8')).join('') : '';
            const defs13 = [...zz13.matchAll(/^([A-Za-z0-9_]+) = /gm)].map((m) => m[1]);
            const ENGINE = ['on_liberation_siege_completion', 'on_rite_created', 'on_rite_change', 'on_rite_edited', 'yearly_holy_order_pulse', 'on_personal_tenet_gain', 'on_personal_tenet_loss',
                'on_artifact_changed_holy_site_owner', 'on_holy_site_artifact_enshrined', 'on_holy_site_artifact_removed', 'on_faith_holy_site_added', 'on_faith_holy_site_removed',
                'on_faith_holy_site_eminence_changed', 'on_character_holy_site_created'];
            const notes13 = [...(plan13.notes ?? []), ...r13.notes];
            check(!r13.failed.length, `the run of the thirteenth mod: nothing failed (${r13.failed.join(', ')})`);
            check(ENGINE.every((n) => before13.includes(n)), `the static check finds the 14 on_actions the engine fires before the run (${before13.length} found, missing: ${ENGINE.filter((n) => !before13.includes(n)).join(', ')})`);
            check(ENGINE.every((n) => defs13.includes(n)), `the 14 on_actions the engine reported are defined in the patch mod’s library file (${defs13.length}; missing: ${ENGINE.filter((n) => !defs13.includes(n)).join(', ')})`);
            const entries13 = lib12(plan13).filter((x) => x.label.startsWith('On actions: ')).flatMap((x) => x.notes ?? []);
            check(defs13.includes('update_main_rite_action') && defs13.includes('on_army_monthly') && defs13.includes('faith_rite_growth_pulse') && !defs13.some((n) => /^fp2_struggle_council_toledo_/.test(n)), `an on_action a loaded script names is carried, so are the engine’s hooks and the ones a carried hook fires, not the ones only hidden game files name: ${defs13.length} carried`);
            check(entries13.some((n) => /^Named by loaded files: \d+ on_actions — .*update_main_rite_action \(common\/scripted_effects\/om13_effects\.txt\)/.test(n)) && entries13.some((n) => /^Fired in turn by the on_actions carried over: .*faith_rite_growth_pulse/.test(n)), `the plan says why: ${entries13.map((n) => n.slice(0, 100)).join(' | ')}`);
            const gameOa = readFileSync(join(gameDir, 'common', 'on_action', 'religion_on_actions.txt'), 'utf8').replace(/^﻿/, '');
            const tenet13 = parse(gameOa).find((n) => n.k === 'on_personal_tenet_gain')!;
            check(zz13.replace(/\r\n/g, '\n').includes(gameOa.slice(tenet13.s, tenet13.e).replace(/\r\n/g, '\n')) && /pam_[a-z_]+_effect/.test(zz13), 'the game’s block of on_personal_tenet_gain is carried exactly as the game wrote it');
            check(notes13.some((n) => /^common\/on_action\/dlc\/fp2\/fp2_other_decision_on_actions\.txt: the game defines 4 on_actions there .* only game files that are hidden name them.* fp2_struggle_council_toledo_organize/.test(n)), `the on_actions nothing fires now stay a note: ${notes13.find((n) => /only game files that are hidden name/.test(n))?.slice(0, 200)}`);
            check(entries13.some((n) => /^Fired by the engine, which logs .* on_personal_tenet_gain/.test(n)) && lib12(plan13).some((x) => x.label.startsWith('On actions: ') && x.todo.length > 0), 'the plan lists the on_actions with the reason');
            await reindex();
            check(!engineOnActionsMissing(idx.vfs).length, `after the run no on_action the engine fires is missing from the loaded files (${engineOnActionsMissing(idx.vfs).join(', ')})`);
            const before13b = files(patch13);
            const again13 = await planMigration(host, 'mod/old_mod13f.mod');
            const r13n = await migrateMod(host, 'mod/old_mod13f.mod');
            const after13 = files(patch13);
            check(lib12(again13).every((x) => x.todo.length === 0) && !r13n.rewritten.length && after13.size === before13b.size && [...before13b].every(([k, v]) => after13.get(k) === v), `a second run writes nothing (${r13n.rewritten.join(', ')})`);
        }
        // (l) interaction categories: a category of the mod with the index of one of the game's (1.20: interaction_debug_pam at 15, AGOT's debug category too)
        // gets the smallest free index in the patch mod's copy of its file
        {
            const root13 = join(tmp, 'mod', 'old_mod13g');
            const desc13 = 'version="1.0"\nname="Old Mod Thirteen G"\nsupported_version="1.19.0.6"\n';
            mkdirSync(join(root13, 'common', 'character_interaction_categories'), { recursive: true });
            writeFileSync(join(root13, 'descriptor.mod'), desc13);
            const cats13 = '﻿#########################################################\r\n#  DO NOT LEAVE GAPS IN "index" OR THE GAME WILL CRASH  #\r\n#########################################################\r\nom13g_debug = {\r\n\tindex = 15\r\n\tdesc = "OM13G_DEBUG"\r\n\tcolor = { 1 0 0 1 }\r\n}\r\nom13g_second = {\r\n\tindex = 16\r\n\tdesc = "OM13G_SECOND"\r\n}\r\n';
            writeFileSync(join(root13, 'common', 'character_interaction_categories', '01_om13g_categories.txt'), cats13);
            writeFileSync(join(tmp, 'mod', 'old_mod13g.mod'), `${desc13}path="${root13.replace(/\\/g, '/')}"\n`);
            settings.customModLists![0].mods = [{ id: 'mod/old_mod13g.mod', enabled: true }];
            await reindex();
            const plan13 = await planMigration(host, 'mod/old_mod13g.mod');
            const r13 = await migrateMod(host, 'mod/old_mod13g.mod');
            const patch13 = join(tmp, 'mod', 'old_mod13g_1_20_fixes');
            const file13 = join(patch13, 'common', 'character_interaction_categories', '01_om13g_categories.txt');
            const text13 = existsSync(file13) ? readFileSync(file13, 'utf8') : '';
            const notes13 = [...(plan13.notes ?? []), ...r13.notes];
            check(!r13.failed.length, `the run of the thirteenth G mod: nothing failed (${r13.failed.join(', ')})`);
            check(text13 === cats13.replace('index = 15', 'index = 17'), `the category gets the next free index in a copy of the mod’s file, the rest of the file as it was: ${text13.replace(/\r?\n/g, '↵').slice(0, 260)}`);
            check(notes13.some((n) => /^om13g_debug \(common\/character_interaction_categories\/01_om13g_categories\.txt\) had the index 15, which the game’s interaction_debug_pam has/.test(n) && n.includes('index 17')), `the plan tells the category: ${notes13.find((n) => /^om13g_debug/.test(n))?.slice(0, 200)}`);
            check(lib12(plan13).some((x) => x.label.startsWith('Interaction categories: 1 category of the mod gets another index') && x.todo.length === 1), `the plan lists the category rule: ${lib12(plan13).map((x) => x.label).join(' | ')}`);
            await reindex();
            const indexes13 = idx.vfs.list('common/character_interaction_categories', { ext: /\.txt$/i }).flatMap((f) => [...(idx.vfs.readText(f) ?? '').matchAll(/^\s*index = (\d+)/gm)].map((m) => Number(m[1]))).sort((a, b) => a - b);
            check(indexes13.every((n, i) => n === i), `the loaded categories have each index once, with no gap: ${indexes13.join(',')}`);
            const before13 = files(patch13);
            const again13 = await planMigration(host, 'mod/old_mod13g.mod');
            const r13n = await migrateMod(host, 'mod/old_mod13g.mod');
            const after13 = files(patch13);
            check(lib12(again13).every((x) => x.todo.length === 0) && !r13n.rewritten.length && after13.size === before13.size && [...before13].every(([k, v]) => after13.get(k) === v), `a second run writes nothing (${r13n.rewritten.join(', ')})`);
        }
        // (m) portrait animations: the mod's older copies of the model assets and the modifier pack file lack the states and the pack that 1.20 added; an
        // entry of the game's animations the loaded files name is carried only when the loaded world has what it needs. Since round 9 the modelStates
        // rule's pack entry gives the mod's copy of the game's pack file (in the patch mod) the game's packs a portrait animation names before the
        // libraries step runs, so an animation that lacked only a pack is carried; the states the copies cannot take keep theirs out. A mod that hides
        // the folder with a replace_path and has a pack file of its own name gives that entry no copy: there a lacking pack still leaves its animation out
        {
            const root13 = join(tmp, 'mod', 'old_mod13h');
            const desc13 = 'version="1.0"\nname="Old Mod Thirteen H"\nsupported_version="1.19.0.6"\n';
            const put13 = (rel: string, text: string): void =>
            {
                mkdirSync(join(root13, rel, '..'), { recursive: true });
                writeFileSync(join(root13, rel), '﻿' + text);
            };
            mkdirSync(root13, { recursive: true });
            writeFileSync(join(root13, 'descriptor.mod'), desc13);
            writeFileSync(join(tmp, 'mod', 'old_mod13h.mod'), `${desc13}path="${root13.replace(/\\/g, '/')}"\n`);
            // (every model asset of the game that defines animation states, as a copy with two states: mental_agony_action and acknowledging_crozier; the
            // copies have no entity the game's files have, so the modelStates rule has no block to give the game's other states to)
            const models = join(gameDir, 'gfx', 'models', 'portraits');
            const walk = (dir: string, rel: string): string[] => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, `${rel}/${e.name}`) : /\.asset$/i.test(e.name) && /\bstate\s*=\s*\{/.test(readFileSync(join(dir, rel, e.name), 'utf8')) ? [`${rel}/${e.name}`] : []));
            const withStates = walk(models, '.').map((p) => p.slice(2));
            withStates.forEach((p) => put13(`gfx/models/portraits/${p}`, 'pdxmesh = { }\nstate = { name = "mental_agony_action" looping = no }\nstate = { name = "acknowledging_crozier" looping = no }\n'));
            put13('gfx/portraits/portrait_animations/animations.modifierpack', 'om13h_pack = {\n\tportrait_modifier = { animations = fat_additive }\n}\n');
            put13('gfx/portraits/portrait_animations/animations.txt', 'om13h_animation = {\n\tdefault = {\n\t\tdefault = { head = "mental_agony_action" torso = "mental_agony_action" }\n\t}\n}\n');
            settings.customModLists![0].mods = [{ id: 'mod/old_mod13h.mod', enabled: true }];
            await reindex();
            const plan13 = await planMigration(host, 'mod/old_mod13h.mod');
            const r13 = await migrateMod(host, 'mod/old_mod13h.mod');
            const dir13 = join(tmp, 'mod', 'old_mod13h_1_20_fixes', 'gfx', 'portraits', 'portrait_animations');
            const zz13 = existsSync(dir13) ? readdirSync(dir13).filter((n) => /^zz+_.*_library\.txt$/.test(n)).map((n) => readFileSync(join(dir13, n), 'utf8')).join('') : '';
            const defs13 = [...zz13.matchAll(/^([A-Za-z0-9_]+) = /gm)].map((m) => m[1]);
            const lackingNote = (notes: string[]): string => notes.find((n) => /^Portrait animations: \d+ entr(y|ies) of the game that loaded files name is left out|^Portrait animations: \d+ entries of the game that loaded files name are left out/.test(n)) ?? '';
            const planNote13 = lackingNote(plan13.notes ?? []);
            // (the run's own note: its libraries step reads the world after the pack entry wrote the copy)
            const runNote13 = lackingNote(r13.notes);
            const pack13 = join(dir13, 'animations.modifierpack');
            const packText13 = existsSync(pack13) ? readFileSync(pack13, 'utf8') : '';
            check(!r13.failed.length && withStates.length > 3, `the run of the thirteenth H mod: nothing failed (${r13.failed.join(', ')}), ${withStates.length} model assets with states`);
            check(r13.rewritten.includes('gfx/portraits/portrait_animations/animations.modifierpack') && /^﻿?om13h_pack = \{/.test(packText13) && /^crozier = \{/m.test(packText13),
                `the patch mod's copy of the pack file is the mod's packs with the game's that the portrait animations name (crozier among them): ${r13.rewritten.join(', ')}`);
            check(defs13.includes('mental_anguish') && defs13.includes('acknowledging_crozier') && !defs13.some((n) => /^(divine_gesture_1|thurible|acknowledging|preaching)$/.test(n)),
                `an animation with the states the loaded assets have is carried, also one whose pack the copy got (acknowledging_crozier); the ones whose states they lack are not: ${defs13.join(', ')}`);
            check(/acknowledging \(animation state acknowledging\)/.test(planNote13) && /acknowledging \(animation state acknowledging\)/.test(runNote13) && !/acknowledging_crozier/.test(runNote13),
                `the plan and the run tell what each left-out animation lacks, the run without the one the pack brought: ${runNote13.slice(0, 300)}`);
            const again13 = await planMigration(host, 'mod/old_mod13h.mod');
            check((again13.rewrites ?? []).filter((x) => x.kind === 'libraries' || x.kind === 'modelStates').every((x) => x.todo.length === 0), 'the plan of a second run: every library rule and the pack entry done');
        }
        // (m2) the same with a replace_path: the mod hides the game's animation folder and has a pack file of its own name, so the pack entry has no copy to
        // give the game's packs to and the loaded files lack them all; the game's models load, so the states are there
        {
            const root13 = join(tmp, 'mod', 'old_mod13i');
            const desc13 = 'version="1.0"\nname="Old Mod Thirteen I"\nsupported_version="1.19.0.6"\nreplace_path="gfx/portraits/portrait_animations"\n';
            const put13 = (rel: string, text: string): void =>
            {
                mkdirSync(join(root13, rel, '..'), { recursive: true });
                writeFileSync(join(root13, rel), '﻿' + text);
            };
            mkdirSync(root13, { recursive: true });
            writeFileSync(join(root13, 'descriptor.mod'), desc13);
            writeFileSync(join(tmp, 'mod', 'old_mod13i.mod'), `${desc13}path="${root13.replace(/\\/g, '/')}"\n`);
            put13('gfx/portraits/portrait_animations/om13i_animations.modifierpack', 'om13i_pack = {\n\tportrait_modifier = { animations = fat_additive }\n}\n');
            put13('gfx/portraits/portrait_animations/om13i_animations.txt', 'om13i_animation = {\n\tdefault = {\n\t\tdefault = { head = "mental_agony_action" torso = "mental_agony_action" }\n\t}\n}\n');
            settings.customModLists![0].mods = [{ id: 'mod/old_mod13i.mod', enabled: true }];
            await reindex();
            const plan13 = await planMigration(host, 'mod/old_mod13i.mod');
            const r13 = await migrateMod(host, 'mod/old_mod13i.mod');
            const dir13 = join(tmp, 'mod', 'old_mod13i_1_20_fixes', 'gfx', 'portraits', 'portrait_animations');
            const names13 = existsSync(dir13) ? readdirSync(dir13) : [];
            const zz13 = names13.filter((n) => /^zz+_.*_library\.txt$/.test(n)).map((n) => readFileSync(join(dir13, n), 'utf8')).join('');
            const defs13 = [...zz13.matchAll(/^([A-Za-z0-9_]+) = /gm)].map((m) => m[1]);
            const note13 = r13.notes.find((n) => /^Portrait animations: \d+ entr(y|ies) of the game that loaded files name (is|are) left out/.test(n)) ?? '';
            check(!r13.failed.length && !(plan13.rewrites ?? []).some((x) => x.kind === 'modelStates') && !names13.some((n) => /\.modifierpack$/i.test(n)),
                `the run of the thirteenth I mod: nothing failed (${r13.failed.join(', ')}), no copy of the game's pack file, so no pack entry and no pack file written (${names13.join(', ')})`);
            check(defs13.includes('mental_anguish') && defs13.includes('divine_gesture_1') && !defs13.includes('acknowledging_crozier'),
                `with the folder replaced, an animation whose pack the loaded files lack is not carried, ones with the game's states are: ${defs13.length} carried, acknowledging_crozier ${defs13.includes('acknowledging_crozier') ? '' : 'not '}among them`);
            check(/acknowledging_crozier \(modifier pack crozier\)/.test(note13), `the run tells the pack the left-out animation lacks: ${note13.slice(0, 300)}`);
        }
        // (n) inert references: the mod replaces the file that defines Christianity with a religion of its own, so christianity_religion and its
        // faiths are gone while the game's live files (the saints' custom localization, scripted triggers, interactions) still test them: the game's
        // definitions that do are written again in the patch mod with those statements made false; a mod that keeps the religion needs none
        {
            const mkMod = (id: string, religion: string): string =>
            {
                const root = join(tmp, 'mod', id);
                const desc = `version="1.0"\nname="${id}"\nsupported_version="1.19.0.6"\n`;
                mkdirSync(join(root, 'common', 'religion', 'religion_types'), { recursive: true });
                writeFileSync(join(root, 'descriptor.mod'), desc);
                writeFileSync(join(root, 'common', 'religion', 'religion_types', '00_christianity.txt'), '﻿' + religion);
                writeFileSync(join(tmp, 'mod', `${id}.mod`), `${desc}path="${root.replace(/\\/g, '/')}"\n`);
                return root;
            };
            mkMod('old_mod14', 'om14_religion = {\n\tfamily = rf_pagan\n\tdoctrine = unreformed_faith_doctrine\n\tfaiths = {\n\t\tom14_faith = {\n\t\t\tcolor = { 0.1 0.2 0.3 }\n\t\t\ticon = norse\n\t\t\treligious_head = d_om14\n\t\t\tdoctrine = tenet_ancestor_worship\n\t\t}\n\t}\n}\n');
            mkMod('old_mod14b', readFileSync(join(gameDir, 'common', 'religion', 'religion_types', '00_christianity.txt'), 'utf8').replace(/^﻿/, ''));
            settings.customModLists![0].mods = [{ id: 'mod/old_mod14.mod', enabled: true }];
            await reindex();
            const inert14 = (p: Awaited<ReturnType<typeof planMigration>>): NonNullable<typeof p.rewrites> => (p.rewrites ?? []).filter((x) => x.kind === 'inert');
            const plan14 = await planMigration(host, 'mod/old_mod14.mod');
            check(inert14(plan14).some((x) => /^common\/customizable_localization: \d+ definitions? of the game or the mod names? entries this playset does not have/.test(x.label) && x.todo.length === 1), `the plan lists the customizable localization of the game: ${inert14(plan14).map((x) => x.label).join(' | ')}`);
            check((plan14.notes ?? []).some((n) => /^Statements about religions that this playset does not have are made false: \d+ names? — .*christianity_religion/.test(n)), `the plan names the religions: ${(plan14.notes ?? []).find((n) => /^Statements about religions/.test(n))?.slice(0, 160)}`);
            const r14 = await migrateMod(host, 'mod/old_mod14.mod');
            const patch14 = join(tmp, 'mod', 'old_mod14_1_20_fixes');
            const dir14 = join(patch14, 'common', 'customizable_localization');
            const name14 = existsSync(dir14) ? readdirSync(dir14).find((n) => /^zz+_.*_inert\.txt$/.test(n)) : undefined;
            const text14 = name14 ? readFileSync(join(dir14, name14), 'utf8') : '';
            const body14 = text14.replace(/^﻿/, '');
            const entry14 = parse(body14).find((n) => n.k === 'PamVenerateObjectTitle');
            check(!r14.failed.length, `the run of the fourteenth mod: nothing failed (${r14.failed.join(', ')})`);
            check(!!entry14 && !/religion:christianity_religion/.test(body14.slice(entry14.s, entry14.e)) && /always = no/.test(body14), `the game’s PamVenerateObjectTitle is written again without the tests of christianity_religion (${name14}, ${text14.length} bytes)`);
            const manifest14 = JSON.parse(readFileSync(join(patch14, '.crusaderpope-fixes.json'), 'utf8'));
            check(Object.keys(manifest14.inert?.sources ?? {}).includes('common/customizable_localization/pam_saint_custom_loc.txt') && (manifest14.inert?.names ?? []).includes('religion:christianity_religion'), `the manifest records the game files and the names: ${JSON.stringify(manifest14.inert?.names?.slice(0, 3))}`);
            await reindex();
            const before14 = files(patch14);
            const again14 = await planMigration(host, 'mod/old_mod14.mod');
            check(inert14(again14).every((x) => x.todo.length === 0), `the plan of a second run: every inert file done (${inert14(again14).map((x) => x.label.slice(0, 40) + ' ' + x.todo.length).join(' | ')})`);
            check(!again14.patchMod?.outdated, 'the patch mod is not outdated while the game files are the ones recorded');
            const r14n = await migrateMod(host, 'mod/old_mod14.mod');
            const after14 = files(patch14);
            check(!r14n.rewritten.length && after14.size === before14.size && [...before14].every(([k, v]) => after14.get(k) === v), `a second run writes nothing (${r14n.rewritten.join(', ')})`);
            // (a game file the override was made from changed: the patch mod is outdated, which a missing file alone does not say)
            const inertFile = join(dir14, name14!);
            const saved = readFileSync(inertFile);
            rmSync(inertFile);
            await reindex();
            const missing14 = await planMigration(host, 'mod/old_mod14.mod');
            check(inert14(missing14).some((x) => x.todo.length > 0) && !missing14.patchMod?.outdated, 'a deleted inert file is work, and the patch mod is not outdated');
            const mf = join(patch14, '.crusaderpope-fixes.json');
            const stale14 = JSON.parse(readFileSync(mf, 'utf8'));
            stale14.inert.sources['common/customizable_localization/pam_saint_custom_loc.txt'] = '0'.repeat(40);
            writeFileSync(mf, JSON.stringify(stale14, null, 2));
            const changed14 = await planMigration(host, 'mod/old_mod14.mod');
            check(changed14.patchMod?.outdated === true, 'with a game file that is not the one the override was made from, the patch mod is outdated');
            writeFileSync(inertFile, saved);
            writeFileSync(mf, JSON.stringify(manifest14, null, 2));
            // (the playset that defines the religion: nothing to make false)
            settings.customModLists![0].mods = [{ id: 'mod/old_mod14b.mod', enabled: true }];
            await reindex();
            const plan14b = await planMigration(host, 'mod/old_mod14b.mod');
            check(!inert14(plan14b).some((x) => /customizable_localization/.test(x.label)) && !(plan14b.notes ?? []).some((n) => /^Statements about religions/.test(n)), `a playset that defines the religion leaves the game’s definitions alone: ${inert14(plan14b).map((x) => x.label).join(' | ')}`);
        }
        // (o) inert references in what the overrides cannot reach: the mod replaces the religions and the landed titles, and has an event file, an
        // on_action file, a scheme and an older scripted_rules file of its own, while game files (an event file, an on_action file) test the religion
        // too. The mod's scheme is overridden like a game entry; the event and on_action files are written whole at their paths in the patch mod (the
        // game's and the mod's; an if whose limit is made false loses its body), the merged scripted_rules file is rewritten and counts as done; the
        // manifest records the sources, the copies and the merge's hash. A second run writes nothing; a copy of the game's file that is not the game's
        // file now is written again.
        {
            const id = 'old_mod15';
            const root = join(tmp, 'mod', id);
            const desc = `version="1.0"\nname="${id}"\nsupported_version="1.19.0.6"\n`;
            const put15 = (rel: string, text: string): void =>
            {
                mkdirSync(join(root, rel, '..'), { recursive: true });
                writeFileSync(join(root, rel), '﻿' + text);
            };
            mkdirSync(root, { recursive: true });
            writeFileSync(join(root, 'descriptor.mod'), desc);
            writeFileSync(join(tmp, 'mod', `${id}.mod`), `${desc}path="${root.replace(/\\/g, '/')}"\n`);
            put15('common/religion/religion_types/00_christianity.txt', 'om15_religion = {\n\tfamily = rf_pagan\n\tdoctrine = unreformed_faith_doctrine\n\tfaiths = {\n\t\tom15_faith = {\n\t\t\tcolor = { 0.1 0.2 0.3 }\n\t\t\ticon = norse\n\t\t\treligious_head = d_om15\n\t\t\tdoctrine = tenet_ancestor_worship\n\t\t}\n\t}\n}\n');
            put15('common/landed_titles/00_landed_titles.txt', 'e_om15 = {\n\tcolor = { 1 1 1 }\n\tk_om15 = {\n\t\tcolor = { 1 1 2 }\n\t\td_om15 = {\n\t\t\tcolor = { 1 1 3 }\n\t\t\tc_om15 = {\n\t\t\t\tcolor = { 1 1 4 }\n\t\t\t\tb_om15 = { province = 1 }\n\t\t\t}\n\t\t}\n\t}\n}\n');
            put15('events/om15_events.txt', 'namespace = om15\n\nom15.0001 = {\n\ttype = character_event\n\ttrigger = { faith = { religion_tag = christianity_religion } }\n\timmediate = { add_gold = 1 }\n\toption = { name = om15.0001.a }\n}\n');
            // (two ifs whose limit the rewrite makes false: since round 9 such an if loses its body; the first, alone, goes whole, the second stays empty
            // before its else, which runs as before)
            put15('common/on_action/om15_on_actions.txt', 'on_monthly_pulse = {\n\teffect = {\n\t\tif = {\n\t\t\tlimit = { religion = religion:christianity_religion }\n\t\t\tadd_gold = 1\n\t\t}\n\t\tif = {\n\t\t\tlimit = { religion = religion:christianity_religion }\n\t\t\tadd_gold = 2\n\t\t}\n\t\telse = {\n\t\t\tadd_prestige = 1\n\t\t}\n\t}\n}\n');
            put15('common/schemes/scheme_types/om15_scheme.txt', 'om15_scheme = {\n\tskill = diplomacy\n\tallow = { has_character_modifier = rejected_from_marriage_bed_modifier }\n}\n');
            put15('common/scripted_rules/00_rules.txt', 'om15_rule = {\n\tcan_create_rite = { always = yes }\n}\n');
            settings.customModLists![0].mods = [{ id: 'mod/old_mod15.mod', enabled: true }];
            await reindex();
            const inert15 = (p: Awaited<ReturnType<typeof planMigration>>): NonNullable<typeof p.rewrites> => (p.rewrites ?? []).filter((x) => x.kind === 'inert');
            const plan15 = await planMigration(host, 'mod/old_mod15.mod');
            const copies15 = inert15(plan15).find((x) => /^\d+ files? of the game or the mod \(events, on_actions\)/.test(x.label));
            const want15 = ['events/om15_events.txt', 'common/on_action/om15_on_actions.txt', 'common/on_action/county_on_actions.txt', 'events/story_cycles/pam_story_cycle_slavic_rite_events.txt'];
            check(!!copies15 && want15.every((rel) => copies15.files.includes(rel)) && copies15.todo.length === copies15.files.length,
                `the plan lists the event and on_action files to copy: ${copies15?.label}, ${copies15?.files.length} files, ${copies15?.todo.length} to do, lacking ${want15.filter((rel) => !copies15?.files.includes(rel)).join(', ')}`);
            check(inert15(plan15).some((x) => /^common\/schemes\/scheme_types: \d+ definitions? of the game or the mod/.test(x.label) && x.todo.length === 1), 'the plan lists the mod’s scheme as an override');
            const r15 = await migrateMod(host, 'mod/old_mod15.mod');
            const patch15 = join(tmp, 'mod', 'old_mod15_1_20_fixes');
            const read15 = (rel: string): string => (existsSync(join(patch15, ...rel.split('/'))) ? readFileSync(join(patch15, ...rel.split('/')), 'utf8') : '');
            check(!r15.failed.length, `the run of the fifteenth mod: nothing failed (${r15.failed.join(', ')})`);
            const ev15 = read15('events/om15_events.txt');
            check(ev15.startsWith('﻿namespace = om15') && !/christianity_religion/.test(ev15) && /faith = \{ always = no \}/.test(ev15), `the mod’s event file is a copy with the test made false (${ev15.slice(0, 160).replace(/\n/g, ' ')})`);
            const oa15 = read15('common/on_action/om15_on_actions.txt');
            check(!!oa15 && !/christianity_religion|add_gold/.test(oa15) && (oa15.match(/limit = \{ always = no \}/g) ?? []).length === 1 && /if = \{\s*limit = \{ always = no \}\s*\}\s*else = \{\s*add_prestige = 1\s*\}/.test(oa15),
                `the mod’s on_action file is a copy with the test made false: the dead ifs lose their bodies, the one alone goes, the one before an else stays empty (${oa15.replace(/\r?\n/g, '↵').slice(0, 200)})`);
            const county15 = read15('common/on_action/county_on_actions.txt');
            check(!!county15 && !/religion:christianity_religion/.test(county15) && county15.length > 1000, `the game’s on_action file is a copy with the statements made false (${county15.length} bytes)`);
            const slavic15 = read15('events/story_cycles/pam_story_cycle_slavic_rite_events.txt');
            check(!!slavic15 && !/religion_tag = christianity_religion/.test(slavic15) && /faith = \{ always = no \}/.test(slavic15), 'the game’s event file is a copy with the statements made false');
            const scheme15 = join(patch15, 'common', 'schemes', 'scheme_types');
            const schemeFile15 = existsSync(scheme15) ? readdirSync(scheme15).find((n) => /^zz+_.*_inert\.txt$/.test(n)) : undefined;
            const schemeText15 = schemeFile15 ? readFileSync(join(scheme15, schemeFile15), 'utf8') : '';
            check(/om15_scheme = \{/.test(schemeText15) && !/rejected_from_marriage_bed_modifier/.test(schemeText15) && /always = no/.test(schemeText15), `the mod’s scheme is written again without the test of the modifier no file defines (${schemeFile15})`);
            const merged15 = read15('common/scripted_rules/zz_old_mod15_1_20_fixes_scripted_rules.txt');
            check(merged15.length > 1000 && !/title:k_papal_state/.test(merged15), `the merged scripted_rules file is rewritten too: the game’s tests of the papal state are false (${merged15.length} bytes)`);
            const mf15 = join(patch15, '.crusaderpope-fixes.json');
            const manifest15 = JSON.parse(readFileSync(mf15, 'utf8'));
            const rec15 = manifest15.inert ?? {};
            check((rec15.copies ?? []).includes('events/om15_events.txt') && (rec15.copies ?? []).includes('common/on_action/county_on_actions.txt') && !!rec15.sources?.['common/on_action/county_on_actions.txt']
                && !!rec15.sources?.['mod:events/om15_events.txt'] && !!rec15.sources?.['mod:common/schemes/scheme_types/om15_scheme.txt'], `the manifest records the copies and their sources: ${JSON.stringify(Object.keys(rec15.sources ?? {}).slice(0, 4))}`);
            check(!!rec15.raw?.['common/scripted_rules/zz_old_mod15_1_20_fixes_scripted_rules.txt'], 'the manifest records the hash of the merged file before the rewrite');
            await reindex();
            check(!engineOnActionsMissing(idx.vfs).length, `no on_action the engine fires is missing after the copies of on_action files (${engineOnActionsMissing(idx.vfs).join(', ')})`);
            const before15 = files(patch15);
            const again15 = await planMigration(host, 'mod/old_mod15.mod');
            check(inert15(again15).every((x) => x.todo.length === 0) && (again15.rewrites ?? []).filter((x) => x.kind === 'merge').every((x) => x.todo.length === 0),
                `the plan of a second run: every inert file and the merge done (${inert15(again15).concat((again15.rewrites ?? []).filter((x) => x.kind === 'merge')).map((x) => x.label.slice(0, 40) + ' ' + x.todo.length).join(' | ')})`);
            check(!again15.patchMod?.outdated, 'the patch mod is not outdated while the game’s and the mod’s files are the ones recorded');
            const r15n = await migrateMod(host, 'mod/old_mod15.mod');
            const after15 = files(patch15);
            check(!r15n.rewritten.length && after15.size === before15.size && [...before15].every(([k, v]) => after15.get(k) === v), `a second run writes nothing (${r15n.rewritten.join(', ')})`);
            // (the game’s file changed since the copy: the recorded hash is not the file’s, the patch mod is outdated; a copy that is not the file’s text is written again)
            const countyFile = join(patch15, 'common', 'on_action', 'county_on_actions.txt');
            const savedCounty = readFileSync(countyFile);
            const tampered = Buffer.concat([savedCounty, Buffer.from('\n# an older text\n')]);
            writeFileSync(countyFile, tampered);
            const stale15 = JSON.parse(readFileSync(mf15, 'utf8'));
            stale15.files['common/on_action/county_on_actions.txt'] = createHash('sha1').update(tampered).digest('hex');
            stale15.inert.sources['common/on_action/county_on_actions.txt'] = '0'.repeat(40);
            writeFileSync(mf15, JSON.stringify(stale15, null, 2));
            await reindex();
            const changed15 = await planMigration(host, 'mod/old_mod15.mod');
            check(changed15.patchMod?.outdated === true && inert15(changed15).some((x) => x.todo.includes('common/on_action/county_on_actions.txt')), 'a game file that is not the one the copy was made from: the patch mod is outdated and the copy is work');
            const r15c = await migrateMod(host, 'mod/old_mod15.mod');
            check(!r15c.failed.length && readFileSync(countyFile).equals(savedCounty), `the run writes the copy again from the game’s file (${r15c.rewritten.join(', ')})`);
            // (the mod changed a file an override was made from: the override masks the new text, the patch mod is outdated)
            put15('common/schemes/scheme_types/om15_scheme.txt', 'om15_scheme = {\n\tskill = diplomacy\n\tprestige = 5\n\tallow = { has_character_modifier = rejected_from_marriage_bed_modifier }\n}\n');
            await reindex();
            const changed15b = await planMigration(host, 'mod/old_mod15.mod');
            check(changed15b.patchMod?.outdated === true && inert15(changed15b).some((x) => /schemes\/scheme_types/.test(x.label) && x.todo.length > 0), 'a mod file that is not the one the override was made from: the override is work and the patch mod is outdated');
        }
        // (p) a library entry only a statement the inert step makes false names: the game's pam_clergy_events.txt fires should_use_theocratic_elective_succession_law_trigger
        // inside `if = { limit = { … } add_realm_law_skip_effects = theocratic_elective_succession_law }`; the mod replaces the file of the laws (the law is gone) and the
        // file that defines the trigger. The event file is copied whole with that block made false, so nothing loaded names the trigger any more: the first run must
        // not carry it (it did, and the second run, which reads the copy, dropped it again: two library files rewritten, a plan that was never done)
        {
            const id = 'old_mod16';
            const root = join(tmp, 'mod', id);
            const desc = `version="1.0"\nname="${id}"\nsupported_version="1.19.0.6"\n`;
            const put16 = (rel: string, text: string): void =>
            {
                mkdirSync(join(root, rel, '..'), { recursive: true });
                writeFileSync(join(root, rel), '﻿' + text);
            };
            mkdirSync(root, { recursive: true });
            writeFileSync(join(root, 'descriptor.mod'), desc);
            writeFileSync(join(tmp, 'mod', `${id}.mod`), `${desc}path="${root.replace(/\\/g, '/')}"\n`);
            put16('common/laws/00_succession_laws.txt', 'om16_succession_law = {\n\tflag = om16_flag\n}\n');
            put16('common/scripted_triggers/00_law_triggers.txt', 'om16_law_trigger = { always = yes }\n');
            settings.customModLists![0].mods = [{ id: 'mod/old_mod16.mod', enabled: true }];
            await reindex();
            const trigger = 'should_use_theocratic_elective_succession_law_trigger';
            const libs16 = (p: Awaited<ReturnType<typeof planMigration>>): NonNullable<typeof p.rewrites> => (p.rewrites ?? []).filter((x) => x.kind === 'libraries');
            const gameEvents = readFileSync(join(gameDir, 'events', 'dlc', 'pam', 'pam_clergy_events.txt'), 'utf8');
            check(gameEvents.includes(trigger) && readFileSync(join(gameDir, 'common', 'scripted_triggers', '00_law_triggers.txt'), 'utf8').includes(trigger + ' = {'), 'the game’s event file names the trigger and its law-trigger file defines it');
            const plan16 = await planMigration(host, 'mod/old_mod16.mod');
            const r16 = await migrateMod(host, 'mod/old_mod16.mod');
            const patch16 = join(tmp, 'mod', 'old_mod16_1_20_fixes');
            const read16 = (rel: string): string => (existsSync(join(patch16, ...rel.split('/'))) ? readFileSync(join(patch16, ...rel.split('/')), 'utf8') : '');
            const dirOf = (folder: string): string => join(patch16, ...folder.split('/'));
            const lib16 = (folder: string): string =>
                (existsSync(dirOf(folder)) ? readdirSync(dirOf(folder)).filter((n) => /^zz+_old_mod16_1_20_fixes_library\.txt$/.test(n)).map((n) => readFileSync(join(dirOf(folder), n), 'utf8')).join('') : '');
            check(!r16.failed.length, `the run of the sixteenth mod: nothing failed (${r16.failed.join(', ')})`);
            const copy16 = read16('events/dlc/pam/pam_clergy_events.txt');
            check(copy16.length > 1000 && !copy16.includes(trigger) && !copy16.includes('theocratic_elective_succession_law'), `the event file is copied with the block that names the missing law made false (${copy16.length} bytes)`);
            check(!lib16('common/scripted_triggers').includes(trigger + ' = {'), `the trigger only that block named is not carried by the first run (${[...lib16('common/scripted_triggers').matchAll(/^([A-Za-z0-9_]+) = /gm)].length} triggers carried)`);
            check(!libs16(plan16).some((x) => (x.notes ?? []).some((n) => n.includes(trigger))), 'the plan does not list it among the entries loaded files name');
            await reindex();
            const before16 = files(patch16);
            const again16 = await planMigration(host, 'mod/old_mod16.mod');
            check(libs16(again16).every((x) => x.todo.length === 0), `the plan of a second run: every library rule done (${libs16(again16).filter((x) => x.todo.length).map((x) => x.label.slice(0, 60) + ' ' + x.todo.length).join(' | ')})`);
            const r16n = await migrateMod(host, 'mod/old_mod16.mod');
            const after16 = files(patch16);
            check(!r16n.rewritten.length && after16.size === before16.size && [...before16].every(([k, v]) => after16.get(k) === v), `a second run writes nothing (${r16n.rewritten.join(', ')})`);
        }
        // (q) two migrated mods in one playset: the first mod replaces the religions, so its patch mod holds a whole-file copy of the game's religion_on_actions.txt (the file
        // tests christianity); the second mod ships a file of that path of its own. The game's file is hidden by the first patch mod's copy, which the second mod then replaces:
        // the on_actions the engine fires (on_personal_tenet_gain …) are in no loaded file, and the second mod's libraries rule has to carry them all the same
        {
            const mk17 = (id: string): ((rel: string, text: string) => void) =>
            {
                const root = join(tmp, 'mod', id);
                const desc = `version="1.0"\nname="${id}"\nsupported_version="1.19.0.6"\n`;
                mkdirSync(root, { recursive: true });
                writeFileSync(join(root, 'descriptor.mod'), desc);
                writeFileSync(join(tmp, 'mod', `${id}.mod`), `${desc}path="${root.replace(/\\/g, '/')}"\n`);
                return (rel, text) =>
                {
                    mkdirSync(join(root, rel, '..'), { recursive: true });
                    writeFileSync(join(root, rel), '﻿' + text);
                };
            };
            mk17('old_mod17')('common/religion/religion_types/00_christianity.txt', 'om17_religion = {\n\tfamily = rf_pagan\n\tdoctrine = unreformed_faith_doctrine\n\tfaiths = {\n\t\tom17_faith = {\n\t\t\tcolor = { 0.1 0.2 0.3 }\n\t\t\ticon = norse\n\t\t\treligious_head = d_om17\n\t\t\tdoctrine = tenet_ancestor_worship\n\t\t}\n\t}\n}\n');
            settings.customModLists![0].mods = [{ id: 'mod/old_mod17.mod', enabled: true }];
            await reindex();
            const r17 = await migrateMod(host, 'mod/old_mod17.mod');
            const copy17 = join(tmp, 'mod', 'old_mod17_1_20_fixes', 'common', 'on_action', 'religion_on_actions.txt');
            check(!r17.failed.length && existsSync(copy17), `the first mod’s patch mod holds a copy of the game’s religion_on_actions.txt (${r17.failed.join(', ')})`);
            mk17('old_mod18')('common/on_action/religion_on_actions.txt', 'om18_on_action = {\n\teffect = { add_gold = 1 }\n}\n');
            settings.customModLists![0].mods = [{ id: 'mod/old_mod17.mod', enabled: true }, { id: 'mod/old_mod17_1_20_fixes.mod', enabled: true }, { id: 'mod/old_mod18.mod', enabled: true }];
            await reindex();
            const missing17 = engineOnActionsMissing(idx.vfs);
            check(missing17.includes('on_personal_tenet_gain'), `with the second mod’s file replacing the copy, the engine’s on_actions are missing before its run (${missing17.join(', ')})`);
            const plan18 = await planMigration(host, 'mod/old_mod18.mod');
            check((plan18.rewrites ?? []).some((x) => x.kind === 'libraries' && x.label.startsWith('On actions: ') && x.todo.length === 1), `the plan lists the on_actions of the game’s file although the first patch mod’s copy hid it: ${(plan18.rewrites ?? []).filter((x) => x.kind === 'libraries').map((x) => x.label.slice(0, 40)).join(' | ')}`);
            const r18 = await migrateMod(host, 'mod/old_mod18.mod');
            const dir18 = join(tmp, 'mod', 'old_mod18_1_20_fixes', 'common', 'on_action');
            const lib18 = existsSync(dir18) ? readdirSync(dir18).filter((n) => /^zz+_.*_library\.txt$/.test(n)).map((n) => readFileSync(join(dir18, n), 'utf8')).join('') : '';
            check(!r18.failed.length && /^on_personal_tenet_gain = /m.test(lib18) && !lib18.includes('om18_on_action'), `the second patch mod’s library file defines them, not the mod’s own (${r18.failed.join(', ')}; ${lib18.length} bytes)`);
            await reindex();
            check(!engineOnActionsMissing(idx.vfs).length, `after the run no on_action the engine fires is missing from the loaded files (${engineOnActionsMissing(idx.vfs).join(', ')})`);
            const patch18 = join(tmp, 'mod', 'old_mod18_1_20_fixes');
            const before18 = files(patch18);
            const again18 = await planMigration(host, 'mod/old_mod18.mod');
            const r18n = await migrateMod(host, 'mod/old_mod18.mod');
            const after18 = files(patch18);
            check((again18.rewrites ?? []).filter((x) => x.kind === 'libraries').every((x) => x.todo.length === 0) && !r18n.rewritten.length && after18.size === before18.size && [...before18].every(([k, v]) => after18.get(k) === v), `a second run writes nothing (${r18n.rewritten.join(', ')})`);
        }
    }
}
catch (e)
{
    check(false, String((e as Error).stack ?? e));
}
finally
{
    if (process.argv[2] === 'keep')
        console.log('kept: ' + tmp);
    else
        rmSync(tmp, { recursive: true, force: true });
}

// (the kept game parse results as they were parsed: no game file changed since, no build wrote into one; a FAIL line only when not)
for (const bad of gameParses.audit().slice(0, 20))
{
    failures++;
    console.log(`FAIL the game's kept parse results: ${bad}`);
}

console.log(`${gameParses.summary()}; ${(buildMs / 1000).toFixed(0)} s in ${builds} builds`);
console.log(failures ? `${failures} failed (${builds} builds)` : `all ok (${builds} builds)`);
process.exit(failures ? 1 : 0);
