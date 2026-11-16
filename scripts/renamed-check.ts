// The `renamed` rule of "Fix for 1.20…" (renamed.ts the pure part, renameRule.ts the files, inert.ts the aliases) on small texts and a
// small game and mod folder in TEMP; no index, no real game. An entry the game renamed (the same body under another key, or the old
// key with a `_word` more) is paired at the same place only, and not when the mod names the new key, the game still has the old one,
// a word of the old key is no word of the game's, the body is short or shared, or the match is not mutual; an entry nothing else
// names gets the new key, one the mod uses keeps its key and gets the texts the game's program builds from the name, the game's
// files named after it and an alias for the inert step, its texts' tooltip links of the new key naming the old; a value that exists
// nowhere takes the game's spelling at the same place (also where the entry is one the merge rule writes in the same run), a model
// entity in another letter case, a part the folder's copies changed (also in a file whose only such value a copy's line decided); a
// second pass writes nothing.
// Usage: node --experimental-strip-types --no-warnings scripts/renamed-check.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
    alignedValues, applyEdits, derivedKeys, linkTypes, locFile, nearSpelling, oneWordMore, partRename, renamedPairs, renameEntryEdits, respelled, tooltipLinks, twinKey,
    twinText, withPart, type PairWorld
} from '../src/main/mods/renamed.ts';
import { renamedFileText, renameNotes, renameWork, type RenameInput } from '../src/main/mods/renameRule.ts';
import { inertText, type InertKind, type InertWorld } from '../src/main/mods/inert.ts';
import { mergeDefinitions } from '../src/main/mods/migrate.ts';
import { MIGRATIONS } from '../src/main/mods/migrations.ts';
import type { ModInfo } from '../src/shared/api.ts';

let bad = 0;
let count = 0;
const check = (ok: unknown, what: string, detail?: string): void =>
{
    count++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `\n     ${detail}` : ''}`);

    if (!ok)
        bad++;
};
const none: PairWorld = { gameDefines: () => false, modDefines: () => false, modNames: () => false };
const pairs = (copy: string, game: string, w: Partial<PairWorld> = {}): string => renamedPairs(copy, game, { ...none, ...w }).map((p) => `${p.from}>${p.to}:${p.how}`).join(' ');

// 1. pairing
const trait = (key: string, extra = ''): string => `${key} = {\n\tcategory = lifestyle\n\tlearning = 3\n\tai_rationality = 30\n\tcompatibility = { ${key} = 15 theologian = 15 }${extra}\n}\n`;
const around = (mid: string): string => `whole_of_body = { learning = 1 }\n${mid}theologian = { learning = 2 }\n`;
check(pairs(around(trait('scholar')), around(trait('erudite'))) === 'scholar>erudite:body', 'the same definition under another key (its own name inside read as the new) is a pair', pairs(around(trait('scholar')), around(trait('erudite'))));
check(pairs(around(trait('scholar')), around(trait('erudite')), { modNames: (w) => w === 'erudite' }) === '', 'not when the mod names the new key somewhere (it knew it)');
check(pairs(around(trait('scholar')), around(trait('erudite')), { gameDefines: (k) => k === 'scholar' }) === '', 'not when the game still defines the old key in the folder');
check(pairs(around(trait('scholar')), around(trait('erudite')), { modDefines: (k) => k === 'erudite' }) === '', 'not when a mod defines the new key in the folder');
check(pairs(trait('scholar'), trait('erudite')) === '', 'not without a key both files have (the whole file is one gap)');
check(pairs(`x = { a = 1 }\n${trait('scholar')}`, `x = { a = 1 }\n${trait('erudite')}y = { b = 2 }\n`) === 'scholar>erudite:body', 'a gap open to the end of one file is a gap');
check(pairs(around(trait('scholar')), `whole_of_body = { learning = 1 }\ntheologian = { learning = 2 }\n${trait('erudite')}`) === '', 'not at another place (another gap)');
check(pairs(around(trait('scholar')), around(trait('erudite') + trait('sage'))) === '', 'not when two of the game’s entries match equally (a tie)');
check(pairs(around('scholar = { a = 1 }\n'), around('erudite = { a = 1 }\n')) === '', 'not with a short body (it tells nothing by itself)');
const shared = (key: string): string => `${key} = { decimals = 0 color = good percent = yes }\n`;
check(pairs(around(shared('beasts_value_add')), around(shared('gunpowder_value_add') + 'other = { }\n').replace('theologian = { learning = 2 }', `theologian = { learning = 2 }\n${shared('twin_value_add')}`)) === '', 'not with a body another entry of the game’s file has too');
const action = (key: string, lesson: string, n: number): string => `${key} = {\n\ttype = tutorial\n\tcheck_create_action = {\n\t\tif = {\n\t\t\tlimit = { should_show_tutorial_alert = { LESSON = ${lesson} } months_from_game_start >= ${n} }\n\t\t\ttry_create_important_action = { important_action_type = ${key} actor = root }\n\t\t}\n\t}\n\teffect = { start_tutorial_lesson = ${lesson} }\n}\n`;
check(pairs(around(action('action_x', 'lesson_x', 12)), around(action('action_x_rites', 'lesson_x_rites', 8))) === 'action_x>action_x_rites:name', 'the old key with one `_word` more, the definitions alike (0.8 and more): a pair by name', pairs(around(action('action_x', 'lesson_x', 12)), around(action('action_x_rites', 'lesson_x_rites', 8))));
const other = action('action_y', 'lesson_y', 8).replace('type = tutorial', 'type = other\n\tsoundeffect = "x"\n\tunimportant = yes').replace('actor = root', 'recipient = this');
check(pairs(around(action('action_x', 'lesson_x', 12)), around(other)) === '', 'not with another name and a body under 0.9 alike', pairs(around(action('action_x', 'lesson_x', 12)), around(other)));
check(oneWordMore('x_y', 'x_y_rites') && oneWordMore('active_x', 'x') && !oneWordMore('x', 'x_a_b') && !oneWordMore('x', 'x'), 'one `_word` more or less, at the end or the start');

// 2. the entry renamed in a text
{
    const text = `# action_x stays in the comment\n${action('action_x', 'lesson_x', 12)}other = { important_action_type = action_x }\n`;
    const out = applyEdits(text, renameEntryEdits(text, 'action_x', 'action_x_rites'));
    check(out.includes('action_x_rites = {') && out.includes('important_action_type = action_x_rites actor') && out.includes('# action_x stays') && out.endsWith('other = { important_action_type = action_x }\n'), 'the key and the name inside the definition renamed; a comment and another entry’s use stay', out);
    check(applyEdits(out, renameEntryEdits(out, 'action_x', 'action_x_rites')) === out, 'a second pass changes nothing');
}

// 3. values at the same place
{
    const copy = 'a = {\n\ticon = "artefact_icons_x.dds"\n\treference = Casket_A_entity\n\tname = keep\n}\nb = {\n\tlesson = lesson_x\n\tlesson = other_y\n}\n';
    const game = 'a = {\n\ticon = "artifact_icons_x.dds"\n\treference = casket-a_entity\n\tname = keep\n}\nb = {\n\tlesson = lesson_x_rites\n\tlesson = changed_z\n}\n';
    const changed: string[] = [];
    const got = alignedValues(copy, game, (l) => void changed.push(l.trim())).map((v) => `${v.from}>${v.to}`).join(' ');
    check(got === 'artefact_icons_x.dds>artifact_icons_x.dds Casket_A_entity>casket-a_entity lesson_x>lesson_x_rites other_y>changed_z', 'the one value a line writes otherwise at the same place; of two candidate lines the near spelling, then the one left (the rule asks for a near spelling after)', got);
    check(!nearSpelling('other_y', 'changed_z'), 'the one left is no near spelling: the rule takes no value from it');
    check(changed.length === 4, 'the copy’s lines the game’s lacks are handed on (the letter-case rule reads them)', changed.join(' | '));
    check(alignedValues('a = {\n\tx = 1 y = 2\n}\nz = 1\n', 'a = {\n\tx = 3 y = 4\n}\nz = 1\n').length === 0, 'not a line that differs in two values');
    check(alignedValues('a = {\n\tkey_a = v\n}\n', 'a = {\n\tkey_b = v\n}\n').length === 0, 'not a line whose key differs');
    check(nearSpelling('map_ambient_3D_x', 'map_ambient_3d_x') && nearSpelling('a_b_casket', 'a-b_casket') && nearSpelling('artefact_icons_x.dds', '"artifact_icons_x.dds"') && nearSpelling('lesson_x', 'lesson_x_rites') && nearSpelling('nick_the_griffon', 'nick_the_griffin'), 'near spellings: letter case, - for _, two letters, a word more');
    check(!nearSpelling('scholar.dds', 'erudite.dds') && !nearSpelling('travel_positive', 'travel_negative_x') && !nearSpelling('a', 'b'), 'not near: another word');
    const part = partRename('artefact_icons_unique_x.dds', 'artifact_icons_unique_x.dds');
    check(part?.from === 'artefact' && part.to === 'artifact' && withPart('artefact_icons_y.dds', part) === 'artifact_icons_y.dds' && withPart('icons_y.dds', part) === undefined, 'the part a value changed, and the same part in another value');
    check(respelled('a = {\n\ticon = "x.dds"\n\tx.dds = 1\n\tother = x.dds\n}\n', new Map([['x.dds', 'y.dds']])) === 'a = {\n\ticon = "y.dds"\n\tx.dds = 1\n\tother = y.dds\n}\n', 'a decided value is written after every `=`, quotes kept; a key stays');
}

// 4. the texts of an old name
{
    check(twinKey('trait_erudite', 'erudite', 'scholar') === 'trait_scholar' && twinKey('EVENT_WINDOW_OPTION_AVAILABLE_ERUDITE', 'erudite', 'scholar') === 'EVENT_WINDOW_OPTION_AVAILABLE_SCHOLAR' && twinKey('scheme_odds.erudite.owner', 'erudite', 'scholar') === 'scheme_odds.scholar.owner' && twinKey('erudites', 'erudite', 'scholar') === undefined, 'the key of the old name, in the same letter case; not a longer word');
    check(twinText(`[GetTrait('erudite').GetName( X )] the erudite`, 'erudite', 'scholar') === `[GetTrait('scholar').GetName( X )] the erudite`, 'the new name as a data function’s argument becomes the old; the words stay');
    const linked = 'Вы #TOOLTIP:GAME_TRAIT,erudite,$CHARACTER_ID$ #L эрудит#!#! #TOOLTIP:GAME_TRAIT,erudite_perk #TOOLTIP:GAME_CONCEPT,erudite';
    check(
        twinText(linked, 'erudite', 'scholar', ['GAME_TRAIT']) === 'Вы #TOOLTIP:GAME_TRAIT,scholar,$CHARACTER_ID$ #L эрудит#!#! #TOOLTIP:GAME_TRAIT,erudite_perk #TOOLTIP:GAME_CONCEPT,erudite' && twinText(linked, 'erudite', 'scholar') === linked,
        'a tooltip link of the entry’s kind naming the new key names the old; a longer key and a link of another kind stay; without link types the text keeps its links',
        twinText(linked, 'erudite', 'scholar', ['GAME_TRAIT'])
    );
    const links = tooltipLinks(['#TOOLTIP:GAME_TRAIT,brave,X a #TOOLTIP:GAME_TRAIT,shy', 'b #TOOLTIP:GAME_TRAIT,erudite,$ID$', '#TOOLTIP:GAME_TRAIT,$DESC_KEY$,$ID$', '#TOOLTIP:GAME_CONCEPT,brave #TOOLTIP:GAME_CONCEPT,piety #TOOLTIP:GAME_CONCEPT,prestige #TOOLTIP:GAME_CONCEPT,shy', '#TOOLTIP:LIFESTYLE,erudite #TOOLTIP:LIFESTYLE,learning', 'no link']);
    check([...links.get('GAME_TRAIT') ?? []].sort().join() === 'brave,erudite,shy', 'the tooltip links of texts by type; a key the program fills in ($DESC_KEY$) is none', [...links].map(([t, k]) => `${t}:${[...k]}`).join(' '));
    check(linkTypes(links, new Set(['brave', 'shy', 'erudite', 'whole_of_body']), 'erudite').join() === 'GAME_TRAIT', 'the link types of a folder: most of their keys the folder’s, two besides the entry’s own; not a type whose keys are half another folder’s (the concepts), nor one with the entry’s key and one other', linkTypes(links, new Set(['brave', 'shy', 'erudite', 'whole_of_body']), 'erudite').join());
    const loc = new Set(['trait_erudite', 'trait_brave', 'trait_shy', 'trait_erudite_desc', 'trait_brave_desc', 'trait_shy_desc', 'every_poet_erudite', 'HEIR_ERUDITE', 'HEIR_BRAVE']);
    const keys = derivedKeys('erudite', ['erudite', 'brave', 'shy'], (k) => loc.has(k), loc);
    check(keys.sort().join() === 'trait_erudite,trait_erudite_desc', 'the keys the program builds from a name (two other entries have them); a text that mentions it, or one other entry, is not', keys.join());
    check(locFile('english', [['a', 'x "y"']]) === '﻿l_english:\n a: "x "y""\n', 'a localization file: byte order mark, header, one key a line');
}

// 5. the inert step's aliases
{
    const gone = new Set(['trait:erudite', 'perk:erudite_perk']);
    const plain: InertWorld = { missing: (k: InertKind, n: string) => gone.has(`${k}:${n}`) };
    const aliased: InertWorld = { ...plain, renamed: (k: InertKind, n: string) => (n === 'erudite' && k === 'trait' ? 'scholar' : n === 'erudite_perk' ? 'scholar_perk' : undefined) };
    const text = 'x = {\n\ttrigger = {\n\t\thas_trait = erudite\n\t\thas_perk = erudite_perk\n\t\thas_trait_xp = { trait = erudite value > 10 }\n\t}\n\teffect = {\n\t\tstress_and_fulfillment_impact = { erudite = minor_stress_impact_gain }\n\t\tset_variable = { name = v value = "has_trait_xp(erudite)" }\n\t}\n}\n';
    const a = inertText(text, 'common/decisions/x.txt', aliased);
    check(a.text === text.replace(/erudite_perk/g, 'scholar_perk').replace(/\berudite\b/g, 'scholar') && !a.names.size, 'a name the world has under another is written as that one (leaf, field, stress impact key, has_trait_xp): nothing made false', a.text);
    check(inertText(a.text, 'common/decisions/x.txt', aliased).text === a.text, 'a second pass changes nothing');
    const p = inertText(text, 'common/decisions/x.txt', plain);
    check(p.text.includes('always = no') && !p.text.includes('has_perk'), 'without the alias the same statements are made false (as before)', p.text);
    // (with the inert rule's dead if: a limit whose name the world has under another is no false limit, the if and its body stay)
    const ifText = 'e = {\n\tif = {\n\t\tlimit = { has_trait = erudite }\n\t\tadd_gold = 1\n\t}\n\tadd_prestige = 1\n}\n';
    const ifA = inertText(ifText, 'common/scripted_effects/x.txt', aliased).text;
    const ifP = inertText(ifText, 'common/scripted_effects/x.txt', plain).text;
    check(ifA === ifText.replace('erudite', 'scholar') && ifP === 'e = {\n\tadd_prestige = 1\n}\n', 'an if whose limit names an aliased entry stays, the name written as the alias; without the alias the dead if goes whole', JSON.stringify([ifA, ifP]));
    // (with the inert rule's count guard: a count that zero satisfies keeps a name nothing has, but a name the world has under another is written as that one)
    const countWorld: InertWorld = { missing: (k: InertKind, n: string) => k === 'building_flag' && n === 'old_flag', renamed: (k: InertKind, n: string) => (k === 'building_flag' && n === 'old_flag' ? 'new_flag' : undefined) };
    const ct = 't = {\n\thas_building_with_flag = { flag = old_flag count < 1 }\n}\n';
    const cr = inertText(ct, 'common/scripted_triggers/x.txt', countWorld);
    check(cr.text === ct.replace('old_flag', 'new_flag') && !cr.kept.length, 'a zero count with an aliased name: the alias written, nothing kept as context', JSON.stringify([cr.text, cr.kept]));
}

// 6. the rule over a small game and mod
const dir = mkdtempSync(join(tmpdir(), 'ckp-renamed-check-'));

try
{
    const gameDir = join(dir, 'game');
    const modRoot = join(dir, 'mod');
    const patchRoot = join(dir, 'patch');
    const put = (root: string, rel: string, text: string | Buffer): string =>
    {
        const f = join(root, ...rel.split('/'));
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, text);
        return f;
    };
    // (the game 1.20: erudite with its texts and icon, the action with _rites, the icons and the entity renamed)
    put(gameDir, 'common/traits/00_traits.txt', around(trait('erudite')) + 'brave = { learning = 9 }\nshy = { learning = 8 }\n');
    put(gameDir, 'common/important_actions/00_actions.txt', around(action('action_x_rites', 'lesson_x_rites', 8)));
    put(gameDir, 'common/tutorial_lessons/00_lessons.txt', 'lesson_x_rites = { chain = c }\n');
    put(gameDir, 'common/artifacts/visuals/00_visuals.txt', 'v1 = {\n\ticon = "artifact_icons_one.dds"\n}\nv2 = {\n\ticon = "artifact_icons_two.dds"\n}\n');
    put(gameDir, 'gfx/interface/icons/artifact/artifact_icons_one.dds', 'DDS');
    put(gameDir, 'gfx/interface/icons/artifact/artifact_icons_two.dds', 'DDS');
    put(gameDir, 'gfx/interface/icons/artifact/artifact_icons_three.dds', 'DDS');
    put(gameDir, 'gfx/interface/icons/traits/erudite.dds', 'ERUDITE');
    put(gameDir, 'gfx/models/audio/audio.asset', 'entity = { name = "map_ambient_3d_desert" }\n');
    put(gameDir, 'gfx/map/map_object_data/audio_emitters.txt', '# object = { entity = "map_ambient_3d_desert" }\n');
    // (`lifestyle_scholar`: the word scholar is one of the game's; `imperial` too, for the case below)
    put(gameDir, 'localization/english/traits_l_english.yml', '﻿l_english:\n trait_erudite: "Erudite"\n trait_erudite_desc: "Knows [GetTrait(\'erudite\').GetName( X )]"\n trait_brave: "Brave"\n trait_brave_desc: "B"\n trait_shy: "Shy"\n trait_shy_desc: "S"\n every_poet_erudite: "Poets"\n lifestyle_scholar: "Scholar"\n imperial_court: "Court"\n');
    put(gameDir, 'localization/english/actions_l_english.yml', '﻿l_english:\n action_x_rites: "Religion"\n');
    // (the Russian texts link the traits by tooltip: the game writes `#TOOLTIP:GAME_TRAIT,<trait>` there)
    put(gameDir, 'localization/russian/traits_l_russian.yml', '﻿l_russian:\n trait_erudite: "Эрудит"\n trait_erudite_desc: "Знает #TOOLTIP:GAME_TRAIT,erudite,$CHARACTER_ID$ #L эрудит#!#!, не #TOOLTIP:GAME_TRAIT,brave или #TOOLTIP:GAME_TRAIT,shy"\n');
    // (a custom localization naming a game concept that the mod's copy of the concept file lacks: the merge rule writes it in the run)
    const customLoc = (key: string): string => `cl_x = {\n\ttype = character\n\ttext = {\n\t\tlocalization_key = ${key}\n\t}\n}\n`;
    put(gameDir, 'common/customizable_localization/00_cl.txt', customLoc('authority_concept'));
    put(gameDir, 'common/game_concepts/00_concepts.txt', 'old_concept = {\n\ttexture = "x.dds"\n}\nauthority_concept = {\n\talias = { authority_alias }\n}\n');
    // (the mod 1.19: scholar, used elsewhere; the action, named nowhere else; the old icons, its own visual; the old entity spelling)
    const files = new Map<string, string>();
    const mod = (rel: string, text: string): void => void files.set(rel, put(modRoot, rel, text));
    mod('common/traits/00_traits.txt', around(trait('scholar')) + 'brave = { learning = 9 }\nshy = { learning = 8 }\n');
    mod('events/mine.txt', 'mine.1 = { trigger = { has_trait = scholar } }\n');
    mod('common/important_actions/00_actions.txt', around(action('action_x', 'lesson_x', 12)));
    mod('common/artifacts/visuals/00_visuals.txt', 'v1 = {\n\ticon = "artefact_icons_one.dds"\n}\nv2 = {\n\ticon = "artefact_icons_two.dds"\n}\n');
    mod('common/artifacts/visuals/my_visuals.txt', 'mine = {\n\ticon = "artefact_icons_three.dds"\n}\nown = {\n\ticon = "artefact_icons_mine.dds"\n}\n');
    mod('gfx/interface/icons/artifact/artefact_icons_mine.dds', 'DDS');
    mod('gfx/map/map_object_data/audio_emitters.txt', 'object = {\n\tentity = "map_ambient_3D_desert"\n}\n');
    mod('localization/english/mine_l_english.yml', '﻿l_english:\n mine.1: "x"\n');
    mod('localization/russian/mine_l_russian.yml', '﻿l_russian:\n mine.1: "x"\n');
    // (a file of the mod's own whose only such value the line rule decides in a copy)
    mod('common/artifacts/visuals/other_visuals.txt', 'third = {\n\ticon = "artefact_icons_one.dds"\n}\n');
    mod('common/customizable_localization/00_cl.txt', customLoc('authority_concept_administrative'));
    mod('common/game_concepts/00_concepts.txt', 'old_concept = {\n\ttexture = "x.dds"\n}\n');
    const read = (f: string): string => readFileSync(f, 'utf8').replace(/^﻿/, '');
    const input = (patch?: string): RenameInput => ({
        gameDir, modFiles: [...files.keys()], patchFolder: 'mod_1_20_fixes', patchRoot: patch,
        modText: (rel) => (files.has(rel) ? read(files.get(rel)!) : undefined),
        currentText: (rel) =>
        {
            try
            {
                return read(join(patch ?? '', ...rel.split('/')));
            }
            catch
            {
                return files.has(rel) ? read(files.get(rel)!) : undefined;
            }
        }
    });
    // (the index's answer: the game's lesson and the mod's entries are defined; the old lesson is defined nowhere)
    const answer = async (names: string[]): Promise<Record<string, 'defined' | 'known'>> => Object.fromEntries(names.filter((n) => ['lesson_x_rites', 'scholar', 'action_x'].includes(n)).map((n) => [n, 'defined' as const]));
    const w = await renameWork(input(), answer);
    const entries = w.entries.map((e) => `${e.from}>${e.to}:${e.mode}`).sort().join(' ');
    check(entries === 'action_x>action_x_rites:rename scholar>erudite:alias', 'the action nothing else names is renamed; the trait the mod’s events use keeps its key', entries);
    const loc = w.outputs.get('localization/english/mod_1_20_fixes_renamed_l_english.yml')?.text ?? '';
    check(loc === '﻿l_english:\n trait_scholar: "Erudite"\n trait_scholar_desc: "Knows [GetTrait(\'scholar\').GetName( X )]"\n', 'the old name’s texts the program builds (the game’s, its data function arguments renamed); not a text that merely mentions the name', JSON.stringify(loc));
    check(w.outputs.get('gfx/interface/icons/traits/scholar.dds')?.copy?.endsWith('erudite.dds'), 'the game’s icon of the new name copied under the old');
    check(w.aliases.map((a) => `${a.type}:${a.from}>${a.to}`).join() === 'traits:erudite>scholar', 'the inert step is told the trait’s new name is the old one');
    const values = w.values.map((v) => `${v.from}>${v.to}:${v.how}`).sort().join(' ');
    check(values === 'artefact_icons_one.dds>artifact_icons_one.dds:line artefact_icons_three.dds>artifact_icons_three.dds:part artefact_icons_two.dds>artifact_icons_two.dds:line lesson_x>lesson_x_rites:line map_ambient_3D_desert>map_ambient_3d_desert:case', 'values: the game’s line, the part in the folder’s own file (where the result exists), the entity in another case; the mod’s own icon stays', values);
    const actionText = renamedFileText(read(files.get('common/important_actions/00_actions.txt')!), w.files.get('common/important_actions/00_actions.txt')!);
    check(actionText === around(action('action_x_rites', 'lesson_x_rites', 12)), 'the action’s copy: the new key, the lesson’s new name, the mod’s own number kept', actionText);
    check(renameNotes(w).length === w.entries.length + w.values.length, 'a note per entry and per value');
    const ru = w.outputs.get('localization/russian/mod_1_20_fixes_renamed_l_russian.yml')?.text ?? '';
    check(
        ru === '﻿l_russian:\n trait_scholar: "Эрудит"\n trait_scholar_desc: "Знает #TOOLTIP:GAME_TRAIT,scholar,$CHARACTER_ID$ #L эрудит#!#!, не #TOOLTIP:GAME_TRAIT,brave или #TOOLTIP:GAME_TRAIT,shy"\n' && w.aliases[0]?.links?.join() === 'GAME_TRAIT',
        'a text of the old name: the tooltip link of the trait names the old key, the links of other traits stay; the alias carries the link type (for the texts rule)',
        JSON.stringify([ru, w.aliases])
    );
    const third = w.values.find((v) => v.from === 'artefact_icons_one.dds');
    check(
        w.files.get('common/artifacts/visuals/other_visuals.txt')?.values.get('artefact_icons_one.dds') === 'artifact_icons_one.dds' && third?.how === 'line' && third.files.join() === 'common/artifacts/visuals/00_visuals.txt,common/artifacts/visuals/other_visuals.txt',
        'a file of the mod’s own in the folder whose only such value the line rule decided in a copy: the part rule still gives it the value',
        JSON.stringify(third)
    );
    // (a value the game spells as an entry the run writes before the rule: decided only with the merge rule's entries counted)
    const files20 = new Map([...files].map(([rel, f]) => [rel, { file: f }]));
    const planned = mergeDefinitions({} as ModInfo, MIGRATIONS.filter((m) => m.to === '1.20'), gameDir, files20);
    check(planned.has('authority_concept') && !planned.has('old_concept') && !planned.has('authority_alias'), 'the merge rule’s entries: the game’s concept the mod’s copy lacks, not the one it has nor a list word', [...planned].join());
    check(mergeDefinitions({} as ModInfo, MIGRATIONS.filter((m) => m.to === '1.20'), gameDir, new Map([...files20].filter(([rel]) => !rel.startsWith('common/game_concepts/')))).size === 0, 'no copy of the concept file: no entry to write');
    check(!w.values.some((v) => v.from === 'authority_concept_administrative'), 'without them the value waits (the concept is defined nowhere yet)');
    const withPlanned = await renameWork({ ...input(), planned }, answer);
    const authority = withPlanned.values.find((v) => v.from === 'authority_concept_administrative');
    const clText = renamedFileText(read(files.get('common/customizable_localization/00_cl.txt')!), withPlanned.files.get('common/customizable_localization/00_cl.txt') ?? { renames: [], values: new Map() });
    check(authority?.to === 'authority_concept' && authority.how === 'line' && clText === customLoc('authority_concept'), 'with them the value takes the game’s spelling in the same run', JSON.stringify([authority, clText]));
    const planPatch = join(dir, 'patch-planned');
    put(planPatch, 'common/customizable_localization/00_cl.txt', '﻿' + clText);
    const plannedAgain = await renameWork({ ...input(planPatch), planned }, answer);
    check(!plannedAgain.values.some((v) => v.from === 'authority_concept_administrative') && !plannedAgain.files.get('common/customizable_localization/00_cl.txt')?.values.size, 'and a second pass over that copy finds nothing more');

    // (written as a run writes them, then planned again: nothing more)
    for (const [rel, f] of w.files)
        put(patchRoot, rel, '﻿' + renamedFileText(input(patchRoot).currentText(rel)!, f));

    for (const [rel, o] of w.outputs)
        put(patchRoot, rel, o.text ?? readFileSync(o.copy!));

    const again = await renameWork(input(patchRoot), answer);
    const left = [...again.files].filter(([rel, f]) => renamedFileText(input(patchRoot).currentText(rel)!, f) !== input(patchRoot).currentText(rel)).length
        + [...again.outputs].filter(([rel, o]) => (o.text ?? '') !== (o.text === undefined ? '' : readFileSync(join(patchRoot, ...rel.split('/')), 'utf8'))).length;
    check(left === 0 && again.outputs.size === w.outputs.size, 'a second pass over the written patch mod writes nothing', `${left} files, ${again.outputs.size} outputs`);

    // (another rule's rename, a folder the libraries rule carries, a word of the mod's own setting)
    const handled = await renameWork({ ...input(), handled: new Set(['action_x']) }, answer);
    check(!handled.entries.some((e) => e.from === 'action_x'), 'a pair another rule renames is that rule’s');
    files.set('common/traits/00_traits.txt', put(modRoot, 'common/traits/00_traits.txt', around(trait('fereldan_scholar')) + 'brave = { learning = 9 }\nshy = { learning = 8 }\n'));
    put(gameDir, 'common/traits/00_traits.txt', around(trait('imperial_scholar')) + 'brave = { learning = 9 }\nshy = { learning = 8 }\n');
    const own = await renameWork({ ...input(), gameDir }, answer);
    check(!own.entries.some((e) => e.from === 'fereldan_scholar'), 'not when a word of the old key is no word of the game’s (the mod renamed the game’s entry for its own setting)', own.entries.map((e) => e.from).join());
}
finally
{
    rmSync(dir, { recursive: true, force: true });
}

console.log(bad ? `${bad} of ${count} checks failed` : `all ${count} checks ok`);
process.exit(bad ? 1 : 0);
