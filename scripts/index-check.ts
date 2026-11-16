// Checks two resolution rules of the index (docs/indexer.md "Resolution rules") on the vanilla game plus a temp mod in
// a TEMP folder (never the real user folder): trait groups (`has_trait = wounded` → wounded_1 … wounded_3, the group
// map rebuilt when an update touches a trait) and the localization getters (GETTER_TYPES, `[GetTrait('x').GetName]`:
// every mapped type holds entries, the getters the game's English localization uses name entries of their type, and a
// list of getters left unmapped on purpose is still the list).
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=8000 scripts/index-check.ts
// The index is built fresh (never from the cache: it is what is checked), on parse threads (scripts/fast-index.ts).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ModInfo } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex, GETTER_TYPES, leadingComment, NO_LINK_GETTERS } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { defaultInstall } from './ck3-install.ts';
import { parseIndex } from './fast-index.ts';

const gameDir = resolveGameDir(defaultInstall());

if (!gameDir)
    throw new Error('No CK3 game dir');

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

const tmp = mkdtempSync(join(tmpdir(), 'ckp-index-check-'));
const root = join(tmp, 'mod', 'index_test');
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'descriptor.mod'), 'version="1.0"\nname="Index Test"\nsupported_version="1.*"\n');
const mod: ModInfo = { id: 'mod/index_test.mod', name: 'Index Test', tags: [], root, source: 'local', replacePaths: [], status: 'ok', editable: true };
const put = (rel: string, text: string): string =>
{
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    return abs;
};

// (files for the checks at the end: a culture's history, a localization file outside the language folders, a name with accents)
put('history/cultures/ckp_test_culture.txt', '# a test culture\n867.1.1 = {\n\tdiscover_innovation = innovation_motte\n\tjoin_era = culture_era_early_medieval\n}\n');
put('localization/ckp_outside_l_english.yml', '﻿l_english:\n ckp_outside_key:0 "Outside"\n');
put('localization/english/ckp_accent_l_english.yml', '﻿l_english:\n trait_ckp_accent_trait:0 "Odważna Żółć"\n ckp_accent_trait_desc:0 "x"\n');
put('common/traits/ckp_accent.txt', 'ckp_accent_trait = { }\n');

try
{
    const idx = new GameIndex(new GameFiles(gameDir, [mod]), 'english');
    idx.scan();
    idx.fingerprint('index-check');
    await parseIndex(idx);

    // ---- trait groups
    const names = (tok: string, k1: string | null = 'has_trait'): string[] => idx.resolveToken(tok, k1, null, false, false).map((e) => `${e.type}:${e.name}`).sort();
    check(names('wounded').join() === 'traits:wounded_1,traits:wounded_2,traits:wounded_3', `has_trait = wounded -> wounded_1..3 (${names('wounded').join(' ')})`);
    check(names('brave').join() === 'traits:brave', 'a trait still resolves to itself');
    check(names('ckp_test_group').length === 0, 'an unknown group resolves to nothing');
    // (the rule belongs to trait contexts: a key that takes other types does not turn the group into traits)
    check(!names('wounded', 'culture').some((n) => n.startsWith('traits:')), 'no trait group outside a trait context');

    const file = put('common/traits/ckp_traits.txt', 'ckp_test_trait_1 = { group = ckp_test_group }\nckp_test_trait_2 = { group = ckp_test_group }\n');
    const r = idx.refreshFiles([file]);
    check(!r.rest?.length, 'the update took the new trait file in');
    check(names('ckp_test_group').join() === 'traits:ckp_test_trait_1,traits:ckp_test_trait_2', `a new trait's group is found after the update (${names('ckp_test_group').join(' ')})`);

    writeFileSync(file, 'ckp_test_trait_1 = { group = ckp_test_other }\nckp_test_trait_2 = { group = ckp_test_group }\n');
    idx.refreshFiles([file]);
    check(names('ckp_test_group').join() === 'traits:ckp_test_trait_2' && names('ckp_test_other').join() === 'traits:ckp_test_trait_1',
        'a changed group is found after the next update, the old one is gone');
    check(names('wounded').length === 3, 'the vanilla groups survive the updates');

    // ---- getters: the mapped types hold entries
    const typeNames = new Set(idx.types().map((t) => t.id));

    for (const [getter, types] of Object.entries(GETTER_TYPES))
        for (const t of types)
            check(typeNames.has(t) || t === 'localization', `${getter} -> ${t} is a type of the index`);

    // ---- getters the game's localization uses: the keys are entries of the mapped type
    // (every language: the custom localization of the others calls getters English never does: GetSkill, GetObligationName, GetBuildingType …)
    const dir = join(gameDir, 'localization');
    const keys = new Map<string, Set<string>>();
    // (the keys of English only: the other languages' texts have typos of their own (the Russian custom localization names faiths that do not exist), so a share of their keys missing says nothing about a mapping)
    const englishKeys = new Map<string, Set<string>>();

    const walk = (d: string): void =>
    {
        for (const f of readdirSync(d, { withFileTypes: true }))
        {
            if (f.isDirectory())
                walk(join(d, f.name));
            else if (f.name.endsWith('.yml'))
            {
                const english = /_l_english\.yml$/.test(f.name);

                for (const m of readFileSync(join(d, f.name), 'utf8').matchAll(/\b(Get[A-Za-z]+)\('([^']+)'/g))
                {
                    (keys.get(m[1]) ?? keys.set(m[1], new Set()).get(m[1])!).add(m[2]);

                    if (english)
                        (englishKeys.get(m[1]) ?? englishKeys.set(m[1], new Set()).get(m[1])!).add(m[2]);
                }
            }
        }
    };
    walk(dir);

    // the getters whose argument names something that is no entry of the index (map regions, nested definitions of a
    // situation, defines, flags, levels …), left unmapped on purpose
    const unmapped = new Set([
        'GetPhaseType', 'GetTopParticipantGroupByKey', 'GetGeographicalRegion', 'GetSubRegionByKey', 'GetDefine', 'GetProperty',
        'GetDeJureLiegeOfTier', 'GetFlagName', 'GetDynastyPrestigeLevelEffect', 'GetDynastyPrestigeLevelNext', 'GetModifierDescForTask',
        'GetScriptValueDesc', 'GetPrestigeLevelName', 'GetChapterDescriptionByName', 'GetFeatureText', 'GetActiveLawInGroupWithFlag',
        'GetPietyLevelName', 'GetInfluenceLevelName', 'GetValue', 'GetPietyLevelDesc', 'GetSpecialGuest', 'GetSkillWithLevel',
        'GetPrestigeLevelDesc', 'GetCustom', 'GetCurrency'
    ]);
    const unlisted = [...keys.keys()].filter((g) => !GETTER_TYPES[g] && !unmapped.has(g) && !NO_LINK_GETTERS.has(g));
    check(!unlisted.length, `every getter of the game's localization (all languages) is mapped, listed as unmapped or as no-link${unlisted.length ? ': ' + unlisted.join(' ') : ''}`);
    check(![...unmapped, ...NO_LINK_GETTERS].some((g) => GETTER_TYPES[g]), 'no getter is both mapped and listed as unmapped / no-link');
    check(![...unmapped].some((g) => NO_LINK_GETTERS.has(g)), 'no getter is both unmapped and no-link');
    check(!idx.bracketRef("actor.GetSkill('learning')") && !idx.bracketRef("GetObligationName('title_revocation_rights_protected')"), 'a no-link getter links to nothing (GetSkill(\'learning\') is not the event theme)');
    check(idx.bracketRef("GetBuildingType('vatapi_caves_01')")?.type === 'buildings', 'GetBuildingType names a building');
    check(idx.bracketRef("GetSubjectContractGroup('tributary_mandala')")?.type === 'subject_contracts/groups', 'GetSubjectContractGroup names a contract group');

    for (const [getter, set] of [...englishKeys].sort((a, b) => b[1].size - a[1].size))
    {
        if (!GETTER_TYPES[getter] || getter === 'GetLocalizedText')
            continue;

        // (an unmapped getter falls back to a lookup of the name across all types, so a key resolving is not enough: the entry
        // found has to be of one of the getter's mapped types, or deleting the mapping would go unnoticed)
        const miss = [...set].filter((k) =>
        {
            const r = idx.bracketRef(`${getter}('${k}')`);
            return !r || !GETTER_TYPES[getter].includes(r.type);
        });
        // (a few keys are dynamic or from a DLC the install lacks; a getter whose keys mostly miss has the wrong type)
        check(miss.length <= Math.max(2, set.size * 0.1), `${getter}: ${set.size - miss.length} of ${set.size} keys resolve to ${GETTER_TYPES[getter].join('/')}${miss.length ? ' (missing ' + miss.slice(0, 4).join(', ') + ')' : ''}`);
    }

    // ---- keys naming entries of context-only types (CONTEXT_RULES), prefixes, culture history
    const incoming = (type: string, name: string): string[] => idx.detail(type, name)?.incoming.flatMap((g) => g.items.map((i) => `${g.type}:${i.name}`)) ?? [];
    check(incoming('domiciles/buildings', 'estate_main_01').some((n) => !n.startsWith('localization:')), 'a domicile building is used by script (has_domicile_building …)');
    check(incoming('artifacts/features', 'armor_material_hardened_leather').some((n) => !n.startsWith('localization:')), 'an artifact feature is used by script (has_artifact_feature)');
    check(incoming('message_filter_types', 'custom_message').some((n) => !n.startsWith('localization:')), 'a message filter is used by script (message_filter_type)');
    check(incoming('court_types', 'court_intrigue').some((n) => !n.startsWith('localization:')), 'a court type is used by script (COURT_TYPE, has_court_type)');
    check(idx.resolveToken('tradition_fp3_beacon_of_learning', 'trait', 'dlc_tradition', false, false)[0]?.type === 'culture/traditions', 'dlc_tradition = { trait = … } names a tradition');
    check(idx.resolveToken('tradition_philosopher_culture', 'fallback', 'dlc_tradition', false, false)[0]?.type === 'culture/traditions', 'dlc_tradition = { fallback = … } names a tradition, not an on_action');
    check(idx.resolveToken('aptitude:court_scholar_court_position', null, null, false, false)[0]?.type === 'court_positions/types', 'aptitude:x names a court position');
    check(idx.resolveToken('mandate_type_qualification:fill_coffers', null, null, false, false)[0]?.type === 'diarchies/diarchy_mandates', 'mandate_type_qualification:x names a mandate');
    check(!!idx.get('history/cultures', 'afghan') && !idx.get('history/cultures', '_culture'), 'the history of a culture is an entry named for its file');
    check(incoming('culture/innovations', 'innovation_motte').includes('history/cultures:afghan'), 'an innovation is used by the history of the cultures that discover it');
    check(incoming('culture/eras', 'culture_era_early_medieval').includes('history/cultures:ckp_test_culture'), 'an era is used by the history of a mod culture (join_era)');
    check(!idx.resolveToken('afghan', null, null, false, false).some((e) => e.type === 'history/cultures'), 'a culture history is never found by name alone');

    // ---- descriptions, display names, comments
    check(idx.descriptionKey(idx.get('character_memory_types', 'hostage_created_hostage')!) === 'hostage_created_hostage_desc_1', 'a memory type\'s description = { random_valid = { desc = key } } is its description');
    check(idx.displayName(idx.get('task_contracts', 'laamp_join_war_contract')!) === 'Stand With Us', `a task contract is named by <key>_contract (${idx.displayName(idx.get('task_contracts', 'laamp_join_war_contract')!)})`);
    const docOf = (text: string): string | undefined => leadingComment(text, text.indexOf('B = 2'));
    check(docOf('A = 1\n#\tB_C = 0.1\nB = 2\n') === undefined, 'a commented-out assignment is no doc of the line below');
    check(docOf('# the strength of the thing\nB = 2\n') === 'the strength of the thing', 'a comment above a definition is its doc');
    check(docOf('# explains B\n# OLD_B = 1\nB = 2\n') === undefined, 'a doc ends at a commented-out assignment');
    check(docOf('# AGOT Modified ZOOM_STEPS = { 40 41 }\nB = 2\n') === undefined, 'a "Modified X = …" note with the old value is no doc');
    check(docOf('# Does a thing.\n# ARTIFACT = The artifact to destroy\n# OWNER = character\nB = 2\n') === 'Does a thing.\nARTIFACT = The artifact to destroy\nOWNER = character', 'argument documentation (# NAME = text) stays doc');
    check(docOf('# Scope = reference character\nB = 2\n') === 'Scope = reference character', 'a "Scope = …" line stays doc');

    // ---- the faiths' icons (1.20: icon inside faith_details), search without accents, a localization file outside the language folders
    const iconless = idx.names('faith').filter((n) => !idx.imagesOf(idx.get('faith', n)!).icon);
    check(iconless.length < idx.names('faith').length * 0.2, `most faiths have an icon (${idx.names('faith').length - iconless.length} of ${idx.names('faith').length}; without: ${iconless.slice(0, 4).join(', ')})`);
    check(idx.imagesOf(idx.get('faith', 'baltic_pagan')!).icon?.lname.endsWith('/baltic.dds'), 'baltic_pagan has the icon its faith_details name (baltic)');
    const found = (q: string): boolean => idx.search(q).some((r) => r.name === 'ckp_accent_trait');
    // (the plain search reads the names computed so far; a list or card computes an entry's; the text search computes them all)
    idx.displayName(idx.get('traits', 'ckp_accent_trait')!);
    check(found('odwazna zolc'), 'search finds a name with accents typed without them');
    check(found('ODWAŻNA'), 'search finds it typed with capitals and accents');
    check(found('zołć'), 'search finds it typed with other accents');
    check(idx.search('odwazna zolc', { text: true }).some((r) => r.name === 'ckp_accent_trait'), 'the text search does too');
    check(idx.plainLoc('ckp_outside_key') === 'Outside', 'a localization file named for the language, outside its folder, is read');
    check(idx.plainLoc('TRIGGER_LINE_BLOCKER') !== undefined, 'the engine\'s trigger texts (localization/jomini/…) are read');

    check(idx.bracketRef("GetDecision('pam_evangelize_personal_tenet_decision')")?.type === 'decisions', 'GetDecision names a decision');
    check(idx.bracketRef("GetPlayerInteractionName('increase_theocratic_heir_candidacy')")?.type === 'character_interactions', 'GetPlayerInteractionName names an interaction');
}
finally
{
    rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
