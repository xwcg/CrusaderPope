// Checks "Update for 1.20" (src/main/mods/modernize.ts; the views' "Update for 1.20" sections, describe/cards) on a
// TEMP mod written the old way over the 1.20 game: a faith inside its religion with its settings at its top,
// `holy_site = …` and tenets as doctrines; a doctrine group listing its doctrines; a tenet group with a tenet doctrine;
// a law group with its laws inside. The views mark them, each fix rewrites them, the index reads the 1.20 layout
// afterwards and the views have nothing left to mark; one undo per fix takes it back byte for byte.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=6000 scripts/modernize-check.ts [keep]
// Every index it builds is a fresh build on parse threads (scripts/fast-index.ts buildIndex; THREADS=0: one thread), never from a cache.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntityCard, ModInfo, Settings } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { createEntries } from '../src/main/mods/create.ts';
import { modsState, type ModsHost } from '../src/main/mods/manager.ts';
import { undoChange } from '../src/main/mods/undo.ts';
import { faithReligion, tenetsOf } from '../src/main/indexer/layouts.ts';
import { absentNames } from '../src/main/mods/migrations.ts';
import { defaultInstall } from './ck3-install.ts';
import { buildIndex } from './fast-index.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

const install = defaultInstall();
const gameDir = resolveGameDir(install)!;
const tmp = mkdtempSync(join(tmpdir(), 'ckp-modernize-'));
const root = join(tmp, 'mod', 'legacy_test');
const put = (rel: string, text: string): void =>
{
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), '﻿' + text);
};
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'descriptor.mod'), 'version="1.0"\nname="Legacy Test"\nsupported_version="1.19.*"\n');
writeFileSync(join(tmp, 'mod', 'legacy_test.mod'), `version="1.0"\nname="Legacy Test"\nsupported_version="1.19.*"\npath="${root.replace(/\\/g, '/')}"\n`);

put(
    'common/religion/religion_types/lt_religions.txt',
    `lt_religion = {
	family = rf_abrahamic
	doctrine = doctrine_monotheist

	faiths = {
		lt_faith = {
			color = { 0.4 0.1 0.6 }
			icon = catholic
			religious_head = k_papal_state
			holy_site = rome
			holy_site = jerusalem
			doctrine = tenet_communion
			doctrine = lt_old_tenet
			doctrine = doctrine_monogamy
			# a DLC pair of tenets, doctrines in 1.19
			doctrine_selection_pair = {
				requires_dlc_flag = legacy_of_persia
				doctrine = tenet_fp3_fedayeen
				fallback_doctrine = tenet_struggle_submission
			}
			localization = {
				HighGodName = lt_high_god
			}
		}
	}
}
`
);
// (a religion with no faiths inside, its settings at the top: 1.20 reads them from religion_details)
put('common/religion/religion_types/lt_plain.txt', 'lt_plain_religion = {\n\t# the family\n\tfamily = rf_abrahamic\n\tdoctrine = doctrine_monotheist\n\tgraphical_faith = orthodox_gfx\n}\n');
put(
    'common/religion/doctrine_group_types/lt_groups.txt',
    `lt_group = {
	category = special
	number_of_picks = 2
	doctrine_types = {
		lt_doc_a
		lt_doc_b
	}
}

lt_tenet_group = {
	category = core_tenets
	number_of_picks = 3
	doctrine_types = {
		lt_old_tenet
	}
}

# (a category 1.19 took as a name: 1.20 reads it from the database)
lt_magic_group = {
	category = "lt_magic"
	doctrine_types = {
		lt_doc_m
	}
}

# (a tenet group whose list an older run took out)
lt_leftover_group = {
	category = "core_tenets"
}
`
);
put(
    'common/religion/doctrine_types/lt_doctrines.txt',
    `lt_doc_a = {
	piety_cost = { value = 10 }
}

lt_doc_b = {
	piety_cost = { value = 20 }
}

lt_doc_m = {
	piety_cost = { value = 30 }
}

lt_old_tenet = { # tenet head
	# cost of the tenet
	piety_cost = {
		value = 100
		if = { limit = { has_doctrine = tenet_communion } add = 1 }
	}
	can_pick = { has_doctrine = tenet_communion } # who may
	parameters = { lt_param = yes }
	# tenet tail
}

# (values 1.20 reads from special_parameters, with comments: the fix keeps every one)
lt_values_doc = {
	doctrine_group_type = doctrine_marriage_type # the group
	index = 5
	# about the parameters
	parameters = { # ph
		# a flag
		lt_flag # the flag
		# the spouses
		number_of_spouses = 3 # three
		hostility_override_lt_foe = 2 # the foe
		hostility_override_lt_bare
		# nothing follows
	}
	# end of the doctrine
}

# (a comment with $ in it, on the brace of a block that is written again)
lt_dollar_doc = {
	doctrine_group_type = doctrine_marriage_type
	index = 6
	parameters = { opinion_of_lt_other_opinion_active = 10 }
	special_parameters = {
		parameter_opinion_override = { # costs $$5 and $&
			lt_first = 5
		}
	}
}
`
);
put(
    'common/laws/lt_laws.txt',
    `lt_law_group = {
	default = lt_law_a
	cumulative = yes
	flag = realm_law

	lt_law_a = {
		modifier = { monthly_prestige = 1 }
	}

	lt_law_b = {
		modifier = { monthly_prestige = 2 }
	}
}
`
);
put(
    'common/laws/lt_crown_laws.txt',
    `crown_authority = {
	default = crown_authority_1
	cumulative = yes
	flag = realm_law

	crown_authority_0 = {
		modifier = { monthly_prestige = 1 }
	}
}
`
);
// (the game's tenet, written as a doctrine the 1.19 way: what 1.20 added to it comes with the fix, the mod's own parameter stays)
put('common/religion/doctrine_types/lt_shared_tenet.txt', 'tenet_legalism = {\n\ticon = core_tenet_legalism\n\tparameters = {\n\t\tlt_param\n\t}\n}\n');
// (more of them, fixed one after the other: the first fix's output in the mod's tenet_types file must not make the next think the mod knows the 1.20 fields)
put('common/religion/doctrine_types/lt_shared_tenet_more.txt', 'tenet_literalism = {\n\ticon = tenet_literalism\n}\n\ntenet_aniconism = {\n\ticon = tenet_aniconism\n}\n');
put(
    'common/laws/lt_tribal_laws.txt',
    `tribal_authority = {
	default = tribal_authority_1
	cumulative = yes
	flag = realm_law

	tribal_authority_0 = {
		modifier = { monthly_prestige = 1 }
	}
}
`
);

const settings: Settings = { gameDir: install, language: 'english', userDir: tmp, activeMod: 'mod/legacy_test.mod' };
let idx!: GameIndex;
let sb!: StoryBuilder;
let mod!: ModInfo;
const worldLacks = new Set<string>();
const host: ModsHost = {
    settings: () => settings,
    updateSettings: (patch) => Object.assign(settings, patch),
    gameDir: () => gameDir,
    documents: () => join(tmp, 'no-documents'),
    reindex: () => undefined,
    // (names the check declares absent from the world besides: a mod that replaces the religions)
    query: async <T>(method: string, ...params: unknown[]): Promise<T> => (method === 'migrationNames' ? [...(absentNames(idx, params[0] as string[]) ?? []), ...(params[0] as string[]).filter((r) => worldLacks.has(r))] : (idx as unknown as Record<string, (...a: unknown[]) => T>)[method](...params)) as T,
    wrote: () => undefined,
    refreshFiles: async () => undefined,
    dataDir: () => join(tmp, 'data')
};
const reindex = async (): Promise<void> =>
{
    idx = await buildIndex(new GameIndex(new GameFiles(gameDir, [mod]), 'english'));
    sb = new StoryBuilder(idx);
};
const card = (type: string, name: string): EntityCard => sb.card(idx.get(type, name)!);
const update = (c: EntityCard): string[] => c.sections.filter((s) => s.title === 'Update for 1.20').flatMap((s) => s.lines.map((l) => l.text.map((x) => (typeof x === 'string' ? x : x.text)).join('')));
const hasFix = (c: EntityCard): boolean => c.sections.some((s) => s.title === 'Update for 1.20' && s.lines.some((l) => l.act?.do.kind === 'modernize'));
const folder = (): Map<string, string> =>
{
    const out = new Map<string, string>();
    const walk = (d: string): void =>
    {
        for (const e of readdirSync(d, { withFileTypes: true }))
            e.isDirectory() ? walk(join(d, e.name)) : out.set(join(d, e.name), readFileSync(join(d, e.name), 'utf8'));
    };
    walk(root);
    return out;
};
const same = (a: Map<string, string>, b: Map<string, string>): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
const body = (type: string, name: string) => (idx.defNode(idx.get(type, name)!)?.node.v ?? []) as { k: string | null; v: unknown; }[];
const scalarOf = (b: { k: string | null; v: unknown; }[], k: string): string | undefined => b.find((c) => c.k === k && typeof c.v === 'string')?.v as string | undefined;

try
{
    mod = (await modsState(host)).mods.find((m) => m.id === settings.activeMod)!;
    console.log('building the index with the old-layout mod …');
    await reindex();

    // the views mark what 1.20 no longer reads
    const faithMarks = update(card('faith', 'lt_faith'));
    check(faithMarks.length === 6 && hasFix(card('faith', 'lt_faith')), `faith: ${faithMarks.length} obsolete parts marked, with "update":\n       ${faithMarks.join('\n       ')}`);
    check(update(card('religion/religion_types', 'lt_religion')).length === 2 && update(card('religion/religion_types', 'lt_plain_religion')).length === 1 && hasFix(card('religion/religion_types', 'lt_plain_religion')) && update(card('religion/religion_types', 'christianity_religion')).length === 0, 'religion: its faith written inside and its family at the top marked; one with the family at the top; the game’s not');
    check(update(card('religion/doctrine_group_types', 'lt_group')).length === 1 && update(card('religion/doctrine_group_types', 'lt_tenet_group')).length === 2, 'doctrine groups: the list marked; the tenet group as such too');
    check(update(card('religion/doctrine_types', 'lt_old_tenet')).length === 1 && update(card('religion/doctrine_types', 'lt_doc_a')).length === 0, 'doctrine: the tenet doctrine marked, an ordinary one not');
    check(update(card('law_groups', 'lt_law_group')).length === 1 && update(card('laws', 'lt_law_a')).length === 1, 'laws: the group and a law inside it marked');
    check(update(card('faith', 'catholic')).length === 0 && update(card('laws', 'crown_authority_1')).length === 0, "the game's own entries: nothing marked");

    const before = folder();
    const run = async (type: string, name: string, fix: string): Promise<void> =>
    {
        const r = await createEntries(host, [{ what: 'modernize', key: name, fields: [['type', type], ['fix', fix]] }]);
        console.log(`     ${fix} ${name}: ${r.notes.join('; ')}`);
        await reindex();
    };

    // the fixes, in the order a modder would click them
    await run('religion/doctrine_types', 'lt_old_tenet', 'tenet-doctrine');
    check(idx.get('religion/tenet_types', 'lt_old_tenet') && !idx.get('religion/doctrine_types', 'lt_old_tenet'), 'the tenet doctrine is a tenet type now');
    // (the card's fix writes the tenet the way the migration's file rules would have: statements of 1.19 converted)
    const tenetFile = [...folder()].find(([k]) => /tenet_types[\\/].*_tenet_types\.txt$/.test(k))?.[1] ?? '';
    check(/piety_cost = \{[^]*?rite_has_tenet = tenet_communion/.test(tenetFile) && /can_pick = \{\s*has_tenet = tenet_communion\s*\}/.test(tenetFile) && !/has_doctrine/.test(tenetFile), `the moved tenet's has_doctrine of a tenet is has_tenet (rite_has_tenet in its piety_cost):\n${tenetFile}`);
    check(['# tenet head', '# cost of the tenet', '# who may', '# tenet tail'].every((c) => tenetFile.includes(c)), `the moved tenet keeps its comments:\n${tenetFile}`);
    // (values 1.20 reads from special_parameters: converted, every comment kept, a bare name with no value left and told)
    const valuesMarks = update(card('religion/doctrine_types', 'lt_values_doc'));
    check(valuesMarks.length === 1 && valuesMarks[0].includes('hostility_override_lt_bare') && valuesMarks[0].includes('number_of_spouses'), `parameters: the values and the bare name marked: ${valuesMarks.join(' | ')}`);
    await run('religion/doctrine_types', 'lt_values_doc', 'doctrine-parameters');
    const valuesText = /lt_values_doc = \{[^]*?\n\}/.exec([...folder()].map(([, v]) => v).join('\n'))?.[0] ?? '';
    check(
        /parameters = \{ # ph\s*# a flag\s*lt_flag # the flag\s*hostility_override_lt_bare\s*# nothing follows\s*\}/.test(valuesText) && /# the spouses\s*number_of_spouses = 3 # three/.test(valuesText) && /hostility_level_override = \{\s*lt_foe = hostile # the foe\s*\}/.test(valuesText) &&
        valuesText.includes('# about the parameters') && valuesText.includes('# end of the doctrine') && valuesText.includes('doctrine_group_type = doctrine_marriage_type # the group') && !/hostility_override_lt_foe/.test(valuesText),
        `parameters: comments kept (above, after, inside, at the end), a bare valueless name stays:\n${valuesText}`
    );
    await run('religion/doctrine_types', 'lt_dollar_doc', 'doctrine-parameters');
    const dollarText = /lt_dollar_doc = \{[^]*?\n\}/.exec([...folder()].map(([, v]) => v).join('\n'))?.[0] ?? '';
    check(dollarText.includes('parameter_opinion_override = { # costs $$5 and $&') && /lt_other = 10/.test(dollarText), `a comment on a rewritten block's brace keeps its $:\n${dollarText}`);
    const valuesAgain = update(card('religion/doctrine_types', 'lt_values_doc'));
    check(valuesAgain.length === 1 && valuesAgain[0].includes('hostility_override_lt_bare') && !valuesAgain[0].includes('number_of_spouses') && !hasFix(card('religion/doctrine_types', 'lt_values_doc')), `parameters: only the bare name is marked afterwards, with no update to run: ${valuesAgain.join(' | ')}`);
    await run('religion/religion_types', 'lt_religion', 'religion-faiths');
    const f = idx.get('faith', 'lt_faith');
    const fb = body('faith', 'lt_faith');
    const details = fb.find((c) => c.k === 'faith_details')?.v as { k: string | null; v: unknown; }[] | undefined;
    check(f && idx.files[idx.winningDef(f)!.file].rel.startsWith('common/religion/faith_types/'), `the faith moved to ${f && idx.files[idx.winningDef(f)!.file].rel}`);
    check(details && scalarOf(details, 'religion') === 'lt_religion' && scalarOf(details, 'religious_head') === 'k_papal_state' && details.some((c) => c.k === 'color'), 'faith_details: religion, colour, icon, head of faith');
    check(f && faithReligion(idx, f)?.name === 'lt_religion', 'its religion read from faith_details');
    const words = (k: string): string[] => ((fb.find((c) => c.k === k)?.v as { v: unknown; }[] | undefined) ?? []).map((c) => c.v as string);
    check(words('holy_sites').join(' ') === 'rome jerusalem' && words('tenets').join(' ') === 'tenet_communion lt_old_tenet' && words('doctrines').join(' ') === 'doctrine_monogamy', `lists: holy_sites ${words('holy_sites')}, tenets ${words('tenets')}, doctrines ${words('doctrines')}`);
    check(fb.some((c) => c.k === 'localization') && !body('religion/religion_types', 'lt_religion').some((c) => c.k === 'faiths'), 'its other settings kept; the religion has no faiths block left');
    const pair = fb.find((c) => c.k === 'tenet_selection_pair')?.v as { k: string | null; v: unknown; }[] | undefined;
    check(pair && scalarOf(pair, 'requires_dlc_flag') === 'legacy_of_persia' && scalarOf(pair, 'tenet') === 'tenet_fp3_fedayeen' && scalarOf(pair, 'fallback_tenet') === 'tenet_struggle_submission' && !fb.some((c) => c.k === 'doctrine_selection_pair'), 'the DLC pair of tenets: tenet_selection_pair (requires_dlc_flag, tenet, fallback_tenet) instead of the doctrine pair');
    check(tenetsOf(fb as never).length === 3, 'tenetsOf reads both tenets and the tenet pair');
    const lr = body('religion/religion_types', 'lt_religion');
    check(!lr.some((c) => c.k === 'family') && scalarOf((lr.find((c) => c.k === 'religion_details')?.v ?? []) as never, 'family') === 'rf_abrahamic', 'the religion’s family is in its religion_details too (one fix)');
    await run('religion/religion_types', 'lt_plain_religion', 'religion-details');
    const pr = body('religion/religion_types', 'lt_plain_religion');
    const prd = (pr.find((c) => c.k === 'religion_details')?.v ?? []) as never;
    check(!pr.some((c) => c.k === 'family' || c.k === 'graphical_faith') && scalarOf(prd, 'family') === 'rf_abrahamic' && scalarOf(prd, 'graphical_faith') === 'orthodox_gfx' && readFileSync(join(root, 'common/religion/religion_types/lt_plain.txt'), 'utf8').includes('\t# the family\n\treligion_details = {'),'a religion: family and graphical_faith in religion_details, the comment where it was');
    await run('religion/doctrine_group_types', 'lt_group', 'doctrine-group');
    check(
        scalarOf(body('religion/doctrine_types', 'lt_doc_a'), 'doctrine_group_type') === 'lt_group' && scalarOf(body('religion/doctrine_types', 'lt_doc_b'), 'doctrine_group_type') === 'lt_group' && !body('religion/doctrine_group_types', 'lt_group').some((c) => c.k === 'doctrine_types' || c.k === 'number_of_picks'),
        'doctrine group: its doctrines name it, the list and number_of_picks (no 1.20 key) are gone'
    );
    check(update(card('religion/doctrine_group_types', 'lt_magic_group')).length === 1, 'a group whose category nothing defines is marked for its list');
    await run('religion/doctrine_group_types', 'lt_magic_group', 'doctrine-group');
    const categories = [...folder()].filter(([k]) => /doctrine_category_types[\\/]/.test(k)).map(([, v]) => v).join('\n');
    const catLoc = [...folder()].filter(([k]) => /doctrine_categories_l_english\.yml$/.test(k)).map(([, v]) => v).join('\n');
    check(/lt_magic = \{\s*sort_order = 0\s*\}/.test(categories) && (categories.match(/lt_magic =/g) ?? []).length === 1 && /^\ufeff?l_english:\r?\n doctrine_category_lt_magic: "Lt Magic"/.test(catLoc) && !!idx.get('religion/doctrine_category_types', 'lt_magic'), `a category the group names that nothing defines: defined in the mod’s category file with its English name:\n${categories}\n${catLoc}`);
    await run('religion/doctrine_group_types', 'lt_tenet_group', 'doctrine-group');
    check(!idx.get('religion/doctrine_group_types', 'lt_tenet_group'), 'the group whose doctrines all became tenets is removed');
    check(hasFix(card('religion/doctrine_group_types', 'lt_leftover_group')), 'a tenet group without its list is marked, with the fix');
    await run('religion/doctrine_group_types', 'lt_leftover_group', 'doctrine-group');
    check(!idx.get('religion/doctrine_group_types', 'lt_leftover_group') && idx.get('religion/doctrine_group_types', 'lt_group'), 'it is removed too, the other groups stay');
    await run('law_groups', 'lt_law_group', 'law-group');
    check(
        scalarOf(body('laws', 'lt_law_a'), 'law_group_type') === 'lt_law_group' && scalarOf(body('laws', 'lt_law_b'), 'index') === '1' && idx.files[idx.winningDef(idx.get('law_groups', 'lt_law_group')!)!.file].rel.startsWith('common/law_groups/'),
        'laws: each names the group with its index, the group in common/law_groups'
    );

    // (what 1.20 added to the game's definitions of the same names comes with the card's fix, as with the migration's file rule)
    await run('religion/doctrine_types', 'tenet_legalism', 'tenet-doctrine');
    const sharedTenet = /\ntenet_legalism = \{[^]*?\n\}/.exec([...folder()].filter(([k]) => /tenet_types[\\/]/.test(k)).map(([, v]) => '\n' + v).join('\n'))?.[0] ?? '';
    check(sharedTenet.includes('lifestyle_scholar_xp_gain_mult = 0.20') && /personal_tenet_parameters = \{\s*tenet_legalism_lawful_authority/.test(sharedTenet) && /parameters = \{\s*lt_param\s*legalism_reduced_faction_virtues\s*legalism_increased_faction_sins\s*tenet_legalism_sinful_revocation\s*tenet_legalism_title_integration\s*\}/.test(sharedTenet), `a tenet the game defines too gets its personal tenet settings and parameters, the mod's stay:\n${sharedTenet}`);
    await run('law_groups', 'crown_authority', 'law-group');
    const crownGroup = /\ncrown_authority = \{[^]*?\n\}/.exec([...folder()].filter(([k]) => /law_groups[\\/]/.test(k)).map(([, v]) => '\n' + v).join('\n'))?.[0] ?? '';
    check(/required_government_flag = \{ government_uses_crown_authority \}/.test(crownGroup) && crownGroup.includes('cumulative = yes'), `a law group the game defines too is gated by the government as the game's is:\n${crownGroup}`);

    // (and the next ones: the first fix's output sits in the mod's own tenet_types and law_groups files, which says nothing of
    // what the mod knows; the world lacking a religion drops the statements that name it, as in the migration)
    const defOf = (folderRe: RegExp, name: string): string => new RegExp(`\\n${name} = \\{[^]*?\\n\\}`).exec([...folder()].filter(([k]) => folderRe.test(k)).map(([, v]) => '\n' + v).join('\n'))?.[0] ?? '';
    await run('religion/doctrine_types', 'tenet_literalism', 'tenet-doctrine');
    const literalism = defOf(/tenet_types[\\/]/, 'tenet_literalism');
    check(/personal_tenet_parameters = \{\s*tenet_literalism_debate_experience\s*tenet_literalism_scholar_conversion\s*tenet_literalism_scholar_trait\s*\}/.test(literalism) && /parameters = \{\s*literalist_debate_enabled\s*tenet_literalism_conversion_resistance\s*literalism_holy_war_cb_active\s*\}/.test(literalism), `a second tenet the game defines too gets the 1.20 fields as well:\n${literalism}`);
    worldLacks.add('religion:christianity_religion');
    await run('religion/doctrine_types', 'tenet_aniconism', 'tenet-doctrine');
    worldLacks.clear();
    const aniconism = defOf(/tenet_types[\\/]/, 'tenet_aniconism');
    check(/personal_tenet_parameters = \{\s*tenet_aniconism_destruction_fulfillment\s*\}/.test(aniconism) && aniconism.includes('divergence_multiplier') && !aniconism.includes('historical_glossary') && !aniconism.includes('religion:christianity_religion'), `a third one, in a world without christianity: its glossary, which names it in a trigger, is left out, the rest comes:\n${aniconism}`);
    await run('law_groups', 'tribal_authority', 'law-group');
    const tribalGroup = defOf(/law_groups[\\/]/, 'tribal_authority');
    check(/required_government_flag = \{ government_uses_tribal_authority \}/.test(tribalGroup), `a second law group the game defines too is gated as well:\n${tribalGroup}`);

    // nothing left to mark (the tenet group is removed with the last fix)
    check(
        update(card('faith', 'lt_faith')).length === 0 && update(card('religion/religion_types', 'lt_religion')).length === 0 && update(card('religion/religion_types', 'lt_plain_religion')).length === 0 && update(card('law_groups', 'lt_law_group')).length === 0 && update(card('laws', 'lt_law_a')).length === 0 && update(card('religion/doctrine_group_types', 'lt_group')).length === 0,
        'after the fixes: nothing marked'
    );
    const lawsCard = card('law_groups', 'lt_law_group');
    check(lawsCard.sections.find((s) => s.title === 'Laws')?.lines.length === 2, 'the group lists its 2 laws');

    // one undo per fix: the folder byte for byte as before
    for (let i = 0; i < 15; i++)
        await undoChange(host, { mod: mod.id });

    check(same(before, folder()), 'fifteen undos: the mod folder as before the fixes');
}
finally
{
    if (!process.argv.includes('keep'))
        rmSync(tmp, { recursive: true, force: true });
    else
        console.log('kept: ' + tmp);
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exitCode = failures ? 1 : 0;
void existsSync;
