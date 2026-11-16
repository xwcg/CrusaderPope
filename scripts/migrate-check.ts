// Checks "Fix for 1.20…" (src/main/mods/migrate.ts, migrations.ts) on a TEMP user folder: a mod written for 1.19 (a
// faith inside its religion, a law group with its laws inside) in a custom list; the plan finds them, the migration
// makes the patch mod (named after the mod, for 1.20) after the mod in the list, copies the files and fixes them there; the mod's
// own files stay byte for byte; afterwards the plan finds nothing; a second run reuses the patch mod.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=6000 scripts/migrate-check.ts [keep]
// Every index it builds is a fresh build of its mods' layering on parse threads (scripts/fast-index.ts buildIndex), never from a cache;
// the game's script files are parsed once per run, by the first build: the later builds take the game files' parse results it kept
// (fast-index.ts ParseReuse: the same index, number for number; reused for a file only with the same size and times, the kept
// results read only, checked again at the end) and parse only their mods' files. THREADS=0: one thread, nothing kept.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModInfo, Settings } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { packFolder, ZipArchive } from '../src/main/mods/zip.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { modsOfList, modsState, saveList, selectList, type ModsHost } from '../src/main/mods/manager.ts';
import { guiWork, type GuiConfig } from '../src/main/mods/guiWork.ts';
import { applyCallEdits, guiCallEdits, locCallEdits, type DataCallEnv } from '../src/main/mods/dataCalls.ts';
import { migrationLibraries, scan, type LibraryConfig, type LibraryFolder } from '../src/main/mods/libraries.ts';
import type { InertOptions } from '../src/main/mods/inertWork.ts';
import { MIGRATIONS, absentNames, knownNames, migrationPlan, migrationsBetween, stillOld, versionUnknown, type Migration } from '../src/main/mods/migrations.ts';
import { carriesGameFiles, fileRules, migrateMod, planHasWork, planMigration } from '../src/main/mods/migrate.ts';
import { definedKeys, defineRefs, missingDefines, pathTest } from '../src/main/mods/defineDiff.ts';
import { addKeyEdits, namedRefs, withoutAbsent } from '../src/main/mods/addKeys.ts';
import { gainEdits, gainScope, gameGainsOf, type GainRule, type GameGains } from '../src/main/mods/gainKeys.ts';
import { applyStatementEdits, statementEdits, type StatementEnv } from '../src/main/mods/scriptRules.ts';
import { macroArgs, macroDefinitions } from '../src/main/mods/macroArgs.ts';
import { sha1 } from '../src/main/mods/fixesManifest.ts';
import { setLocale } from '../src/shared/i18n.ts';
import { wrapDefinition } from '../src/main/mods/wrapKeys.ts';
import { mergeShaders } from '../src/main/mods/shaderMerge.ts';
import { codeItems, fxDefinitions } from '../src/main/mods/fxBlocks.ts';
import { shaderNotes, shaderWork } from '../src/main/mods/shaderRule.ts';
import { carriesGame, pairedWithReplaced } from '../src/main/mods/currency.ts';
import { bannerEdits, bannerName, gameBannerValues, type BannerEnv, type BannerRule } from '../src/main/mods/bannerKeys.ts';
import { gameMaskShape } from '../src/main/mods/textureRule.ts';
import { mipBytes } from '../src/main/mods/textureRules.ts';
import { RELIGION_DETAIL_KEYS, opinionFlagsOf } from '../src/main/mods/modernize.ts';
import { parse, type PNode } from '../src/main/indexer/parser.ts';
import { gwalk, parseGui } from '../src/main/gui/parser.ts';
import { defaultInstall } from './ck3-install.ts';
import { buildIndex, ParseReuse } from './fast-index.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

const install = defaultInstall();
const gameDir = resolveGameDir(install)!;
const tmp = mkdtempSync(join(tmpdir(), 'ckp-migrate-'));
const root = join(tmp, 'mod', 'old_mod');
const put = (rel: string, text: string): void =>
{
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), '﻿' + text);
};
mkdirSync(root, { recursive: true });
writeFileSync(join(root, 'descriptor.mod'), 'version="1.0"\nname="Old Mod"\nreplace_path="common/religion/religion_types"\nsupported_version="1.19.0.6"\n');
writeFileSync(join(tmp, 'mod', 'old_mod.mod'), `version="1.0"\nname="Old Mod"\nreplace_path="common/religion/religion_types"\nsupported_version="1.19.0.6"\npath="${root.replace(/\\/g, '/')}"\n`);

put(
    'common/religion/religion_types/om_religions.txt',
    `om_religion = {
	family = rf_abrahamic
	doctrine = doctrine_monotheist

	faiths = {
		om_faith = {
			color = { 0.4 0.1 0.6 }
			icon = catholic
			holy_site = rome
			holy_site = jerusalem
			doctrine = tenet_communion
			doctrine = doctrine_monogamy
			doctrine_selection_pair = {
				requires_dlc_flag = legacy_of_persia # fedayeen
				doctrine = tenet_fp3_fedayeen
				fallback_doctrine = tenet_struggle_submission
			}
		}
	}
}
`
);
// (1.19 religions: the settings at the top (with their comments), no faiths inside; one with a banner of its own the mod ships; one
// with religion_details already and a banner it does not ship; one in a CRLF file; one that is in the 1.20 form already)
put(
    'common/religion/religion_types/om_more_religions.txt',
    `om_plain_religion = {
	# the family
	family = rf_om_banner # of the banner
	doctrine = doctrine_monotheist
	graphical_faith = orthodox_gfx

	piety_icon_group = "christian"
	doctrine_background_icon = core_tenet_banner_om.dds
	traits = {
		virtues = { brave }
	}
}

om_details_religion = {
	religion_details = {
		family = rf_om_none
	}
	pagan_roots = yes
	theocracy_government_type = theocracy_government
	doctrine_background_icon = core_tenet_banner_vanilla_christian.dds
}

om_modern_religion = {
	religion_details = {
		family = rf_om_done
		graphical_faith = orthodox_gfx
	}
	doctrine = doctrine_monotheist
}
`
);
put('common/religion/religion_types/om_crlf_religion.txt', 'om_crlf_religion = {\n\tfamily = rf_om_none\n\tgraphical_faith = orthodox_gfx\n\tdoctrine = doctrine_monotheist\n}\n'.replace(/\n/g, '\r\n'));
// (the families: the 1.19 banner the mod ships; one it names without shipping; one with the big texture only; none; four already; one)
put(
    'common/religion/religion_family_types/om_families.txt',
    `rf_om_banner = {
	graphical_faith = "orthodox_gfx"
	# the banner the mod ships
	doctrine_background_icon = core_tenet_banner_om.dds
}

rf_om_plain = {
	piety_icon_group = "pagan"
	doctrine_background_icon = core_tenet_banner_christian.dds # the game's 1.19 banner
	hostility_doctrine = om_hostility_doctrine
}

rf_om_nosmall = {
	doctrine_background_icon = "core_tenet_banner_nosmall.dds"
}

rf_om_none = {
	graphical_faith = "orthodox_gfx"
}

rf_om_done = {
	tenet_background_icon = tenet_banner_known_core
	tenet_heretical_background_icon = tenet_banner_unknown_heretical
	tenet_neutral_background_icon = tenet_banner_known_neutral
	tenet_unknown_background_icon = tenet_banner_unknown_neutral
}

rf_om_half = {
	tenet_background_icon = tenet_banner_known_core
}
`
);
// (the folder the mod's 1.19 define FAITH_DOCTRINE_BACKGROUND_PATH names, not the game's default)
put('common/defines/graphic/om_banner_path.txt', 'NGameIcons = {\n\tFAITH_DOCTRINE_BACKGROUND_PATH = "gfx/interface/icons/om_banners/"\n}\n');
put('gfx/interface/icons/om_banners/core_tenet_banner_om.dds', 'DDS banner');
put('gfx/interface/icons/om_banners/core_tenet_banner_om_small.dds', 'DDS banner small');
put('gfx/interface/icons/faith_doctrines/core_tenet_banner_nosmall.dds', 'DDS banner without a small variant');
// (as AGOT: a group listing doctrines of another file; the 1.19 hostility numbers and valued parameters)
put(
    'common/religion/doctrine_group_types/om_groups.txt',
    `om_hostility_group = {
	category = not_creatable
	number_of_picks = 2
	doctrine_types = {
		om_hostility_doctrine
		om_other_hostility_doctrine
	}
}

# (as 1.19's tenet group: category core_tenets, all its doctrines become tenets: the mod's own and the game's)
om_core_tenets = {
	category = "core_tenets"
	number_of_picks = 3
	doctrine_types = {
		tenet_om_debug
		tenet_om_own
		tenet_pacifism
	}
}
`
);
put(
    'common/religion/doctrine_types/om_doctrines.txt',
    `om_hostility_doctrine = {
	parameters = {
		hostility_same_religion = 1
		hostility_same_family = 2
		hostility_others = 3
		hostility_override_doctrine_om_foe = 3
	}
}

om_other_hostility_doctrine = {
	visible = no
	parameters = {
		hostility_same_religion = 0
		hostility_same_family = 1
		hostility_others = 2
	}
}

om_marriage_doctrine = {
	doctrine_group_type = doctrine_marriage_type
	index = 9
	parameters = {
		number_of_spouses = 4
		marriage_event
	}
}

# (1.19's forms of what 1.20 reads from special_parameters: flags that are values too, the head of faith's hostility,
# the opinion of those with a parameter)
om_special_doctrine = {
	doctrine_group_type = doctrine_marriage_type
	index = 8
	parameters = {
		warmonger = yes
		unreformed = yes
		same_hof_hostility_override = 1
		pacifist_opinion_active = yes
		opinion_of_pacifist_opinion_active = 10
		opinion_of_om_actor_opinion_active = 30
		conquest_cb_enabled = yes
			allowed_holding_type_church_holding = yes
			allowed_holding_type_city_holding = yes
	}
	special_parameters = {
		parameter_opinion_override = {
			om_other = 5
		}
	}
}

# (a doctrine's piety_cost runs with a rite: its has_doctrine is rite_has_doctrine, a tenet's rite_has_tenet; can_pick stays a faith's)
om_cost_doctrine = {
	doctrine_group_type = doctrine_marriage_type
	index = 7
	parameters = {
		marriage_event
	}
	piety_cost = {
		value = 0
		if = {
			limit = { has_doctrine = doctrine_monogamy has_doctrine = tenet_pacifism religion_tag = om_religion }
			add = 1
		}
	}
	can_pick = {
		has_doctrine = doctrine_monogamy
		has_doctrine = tenet_pacifism
	}
}
`
);
// (the file rules: a trait with the 1.19 faith_modifier; older copies of the game's faith window, a shader, a body
// model; a tenet written as a doctrine of no group)
put(
    'common/traits/om_traits.txt',
    `om_trait = {
	category = fame
	faith_modifier = {
		parameter = can_grant_knighthood
		diplomacy = -1
	}
	track = {
		50 = {
			faith_modifier = {
				parameter = basic_pilgrimage_rewards
				learning = 1
			}
			faith_modifier = {
				parameter = om_nowhere_defined
				learning = 2
			}
		}
	}
	name = {
		first_valid = {
			desc = om_trait
		}
	}
}
`
);
put('gui/window_faith.gui', 'window = { name = "faith_window_1_19" onclick = "[ClearExploringRealms]" om_faith_extra = { } om_script_widget = { } }\n');
// (a type of the mod's own that an event names with `gui = "…"`: script uses types too, so it is not "used by nothing" once the window goes)
put('gui/om_script_widget.gui', 'types OmScript\n{\n\ttype om_script_widget = widget\n\t{\n\t}\n}\n');
put('events/om_gui_events.txt', 'namespace = om_gui\n\nom_gui.0001 = {\n\ttype = character_event\n\twindow = event_window_widgets\n\tgui = "om_script_widget"\n}\n');
// (calls a rule does not map, in places the rule cannot reach: a removed call inside a larger expression, a doctrine not named by a string,
// a tenet's name with no rite)
put('gui/om_calls2.gui', 'window = {\n\tname = "om_calls2"\n\tvisible = "[And( StraitMapIcon.ShouldBeShown, Foo )]"\n\ttext = "[GetFaithDoctrine( Foo ).GetName( GetPlayer.GetFaith )] [GetFaithDoctrine(\'tenet_a\').GetName]"\n\tbutton = { name = "om_nested" blockoverride "faith_context" { container = { datacontext = "[Foo.GetFaith]" } } }\n}\n');
// (the interface the game's windows use: a 1.19 copy of the shared list types without the tenet sort bar the faith window and rite creation
// use; a file of the mod's own that only the mod's faith window used (the game's replaces it) and one nothing ever used; stubs of two game
// windows calling what 1.20 removed, which the dialog offers to replace)
const gameLists = readFileSync(join(gameDir, 'gui', 'shared', 'lists.gui'), 'utf8').replace(/^﻿/, '');
const sortBar = parseGui(gameLists).flatMap((n) => n.children ?? [n]).find((n) => n.name === 'hbox_sort_tenets')!;
put('gui/shared/lists.gui', gameLists.slice(0, sortBar.s) + gameLists.slice(sortBar.e));
put('gui/om_faith_extras.gui', 'types OmTypes\n{\n\ttype om_faith_extra = container\n\t{\n\t\tvisible = "[GetScriptedGui(\'om_faith_sg\').IsShown( GuiScope.SetRoot( GetPlayer.MakeScope ).End )]"\n\t\tom_faith_inner = { }\n\t}\n\n\ttype om_faith_inner = widget\n\t{\n\t\tsize = { 5 5 }\n\t}\n}\n');
// (the mod's script that leads to the faith window it adds a type to: an important action that opens it, a scripted GUI its type calls)
put('common/important_actions/om_actions.txt', 'om_open_faith = {\n\ttype = alert\n\tcheck_create_action = { }\n\teffect = { scope:actor = { faith = { open_view_data = { view = faith } } } }\n}\nom_other = {\n\ttype = alert\n\teffect = { open_view_data = { view = character } }\n}\n');
put('common/scripted_guis/om_sg.txt', 'om_faith_sg = {\n\tscope = character\n\tis_shown = { always = yes }\n}\n');
put('gui/om_unused.gui', 'types OmUnused\n{\n\ttype om_never_used = widget\n\t{\n\t}\n}\n');
put('gui/window_my_realm.gui', 'window = {\n\tname = "om_my_realm"\n\ttext = "[GetPlayer.GetRemovedThing]"\n\tom_line = yes\n}\n');
put('gui/window_ledger.gui', 'window = {\n\tname = "om_ledger"\n\ttext = "[Faith.GetDoctrineBackgroundIcon]"\n}\n');
put('gui/window_domicile.gui', 'window = {\n\tname = "om_domicile"\n}\n');
// (what the restores take away and the hooks of older copies: the mod's tooltips file, which the migration replaces with the game's, defines a
// type and a template that a copy of a game window and a file of the mod's own use; the game's coat_of_arms.gui as an older copy would be: the
// house sigil type missing (a game window uses it) and the base type without the two hooks that type overrides; the game's achievement types
// without two hooks that a file of the mod overrides)
put('gui/shared/cooltip.gui', 'types OmTips\n{\n\ttype om_tip_kind = widget\n\t{\n\t\tsize = { 4 4 }\n\t}\n}\n\ntemplate om_tip_template\n{\n\tsize = { 3 3 }\n}\n');
put('gui/window_activity_log.gui', 'window = {\n\tname = "om_activity_log"\n\tom_tip_kind = { }\n\twidget = { using = om_tip_template }\n}\n');
put('gui/om_tip_user.gui', 'window = {\n\tname = "om_tip_user"\n\tom_tip_kind = { }\n}\n');
{
    const gameCoa = readFileSync(join(gameDir, 'gui', 'shared', 'coat_of_arms.gui'), 'utf8').replace(/^﻿/, '');
    const coaNodes = parseGui(gameCoa).flatMap((n) => (n.key === 'types' ? n.children ?? [] : [n]));
    const houseSigil = coaNodes.find((n) => n.name === 'coa_house_sigil')!;
    const sigil = coaNodes.find((n) => n.name === 'coa_character_sigil')!;
    const olderCoa: { s: number; e: number; text: string; }[] = [{ s: houseSigil.s, e: houseSigil.e, text: '' }];

    for (const h of ['sigil_coa', 'sigil_lowborn_visible'])
    {
        let block: typeof sigil | undefined;
        gwalk([sigil], (n) => { if (n.key === 'block' && n.name === h) block = n; });
        olderCoa.push({ s: block!.s, e: block!.e, text: gameCoa.slice(block!.inner![0], block!.inner![1]) });
    }

    put('gui/shared/coat_of_arms.gui', olderCoa.sort((a, b) => b.s - a.s).reduce((t, r) => t.slice(0, r.s) + r.text + t.slice(r.e), gameCoa));
    const gameAch = readFileSync(join(gameDir, 'gui', 'achievements', 'jomini_achievements_types.gui'), 'utf8').replace(/^﻿/, '');
    put('gui/achievements/jomini_achievements_types.gui', gameAch.replace('block "achievement_icon" {}', '').replace('block "achievement_description" {}', ''));
    put('gui/om_hook_user.gui', 'window = {\n\tname = "om_hook_user"\n\twidget_achievement_list_entry = {\n\t\tblockoverride "achievement_icon" { size = { 10 10 } }\n\t\tblockoverride "achievement_description" { }\n\t}\n}\n');
}
// (interface and localization text calling the data system the 1.19 way: renamed functions, other call shapes, the faith_context blocks;
// words in strings and comments, a longer name, a 1.20 form already: all stay. The restored window above is the game's file, not rewritten)
put(
    'gui/om_calls.gui',
    `window = {
	name = "om_calls"
	button = { onclick = "[ClearExploringRealms]" }
	button = { onclick = "[OpenSuccessionLawChangeWindow( GuiLawGroup.Self )]" }
	button = { onclick = "[OpenSuccessionElectionWindowForTitle(Title.Self)]" }
	button = { onclick = "[OpenDesignateHeirWindow]" }
	button = { down = "[IsHolyOrderDetailViewShown(HolyOrder.Self)]" onclick = "[OpenHolyOrderDetailView(HolyOrder.Self)]" }
	# [ClearExploringHouses] in a comment stays
	text = "ClearExploringHouses is only a word here, [Title.GetStateFaith.GetIcon] is a call, [GetStateFaithList] is not"
	visible = "[StraitMapIcon.ShouldBeShown]"
	visible = "[And( Government.HasRule( 'administrative' ), Government.HasRule( 'merit' ) )]"
	datacontext = "[RulerDesignerWindow.GetFaith]"
	tooltip = "[ObjectsEqual( Faith.Self, RulerDesignerWindow.GetFaith )]"
	icon_trait = {
		blockoverride "faith_context"
		{
			datacontext = "[RulerDesignerWindow.GetFaith]"
		}
	}
	icon_trait = {
		blockoverride "faith_context"
		{
			datacontext = "[Accolade.GetAcclaimedKnight.GetFaith]"
		}
	}
	icon_trait = {
		blockoverride "faith_context"
		{
			datacontext = "[GetPlayer.GetFaith]"
			datacontext = "[GetPlayer.GetRite]"
		}
	}
	datacontext = "[GetFaithDoctrine('doctrine_monogamy')]"
	datacontext = "[GetFaithDoctrine('tenet_pacifism')]"
	text = "[FaithDoctrine.GetNameNoTooltip( Faith.Self )] [GreatProjectType.GetIllustration]"
	onclick = "[OpenGameViewData( 'title_election', Title.Self )]"
}
`.replace(/\n/g, '\r\n')
);
put(
    'localization/replace/english/om_calls_l_english.yml',
    `l_english:
 OM_STATE: "Rite: [Title.GetStateFaith.GetName] [GetCountiesOfStateFaith]"
 OM_DOC: "[GetFaithDoctrine('doctrine_monogamy').GetBaseName] [GetFaithDoctrine('tenet_pacifism').GetName( GetPlayer.GetFaith )] [FaithDoctrine.GetEffectsDescription( GetPlayer.GetFaith )] [FaithDoctrine.GetDescription( GetPlayer.GetFaith )|F]"
 OM_PLAIN: "GetStateFaith and FAITH_DOCTRINE are only words here"
 OM_SCOPE: "[FAITH_DOCTRINE.GetName( FAITH.Self )]#! [FAITH.GetName]"
 FAITH_DOCTRINE_GENERAL_TOOLTIP: "[FaithDoctrine.GetEffectsDescription( GetPlayer.GetFaith )]\\n\\n[FaithDoctrine.GetDescription( GetPlayer.GetFaith )|F]"
 OM_CREATE: "[FaithCreationWindow.CalcPietyCost|V0] [FaithCreationDoctrineItem.GetBlockers]"
 OM_PHASE: "[ActivityPhase.GetDescription] [ActivityPhase.GetDescription( Activity.Self )]"
 #OM_COMMENT: "[GetStateFaith]"
 OM_TRAIL: "[GetFaithDoctrine('doctrine_x').GetName( GetPlayer.GetFaith )]" # "note [GetStateFaith]"
 ADD_TENET_GLOBAL_DESC: "Gains: [FAITH_DOCTRINE.GetName( FAITH.Self )]"
`
);
put(
    'localization/replace/french/om_calls_l_french.yml',
    `l_french:\r\n OM_STATE: "[Title.GetStateFaith.GetName]"\r\n FAITH_DOCTRINE_GENERAL_TOOLTIP: "[FaithDoctrine.GetEffectsDescription( GetPlayer.GetFaith )]"\r\n OM_KEEP: "Texte"\r\n`
);
put('gfx/FX/pdxmesh.shader', '# a 1.19 shader\n');
// (a 1.19-like copy of the game's body model: without 1.20's `streaming = Never`, with an addition of the mod's own)
const gameBody = readFileSync(join(gameDir, 'gfx', 'models', 'portraits', 'male_body', 'male_body.asset'), 'utf8').replace(/^﻿/, '');
put('gfx/models/portraits/male_body/male_body.asset', gameBody.replace(/\n\s*streaming = Never/g, '').replace('pdxmesh = {', 'pdxmesh = {\n\t# om: kept'));
// (the mod's own creature model: a mesh that imports a skeletal animation set, one with animations and one with a skeleton of its
// own (all named by the mod only), a clothes-like mesh without any, and one that has the setting already)
put('gfx/models/portraits/om_creature/om_creature.asset', `skeletal_animation_set = {
	name = "om_creature_animations"
	reference_skeleton = "om_creature_mesh"
	animation = { id = "om_idle" type = "om_idle.anim" }
}

pdxmesh = {
	name = "om_creature_mesh"
	file = "om_creature.mesh"
	import = {
		type = skeletal_animation_set
		name = "om_creature_animations"
	}
}

pdxmesh = {
	name = "om_creature_fire_mesh"
	file = "om_fire.mesh"
	animation = { id = "om_fire_idle" type = "om_fire.anim" }
}

pdxmesh = {
	name = "om_creature_cloth_mesh"
	file = "om_cloth.mesh"
	meshsettings = { name = "cloth" }
}

pdxmesh = {
	name = "om_creature_kept_mesh"
	streaming = Never
	file = "om_kept.mesh"
	animation = { id = "om_kept" type = "om_kept.anim" }
}
`);
// (an interface file calling the faith view the 1.19 way, and the conversion view, which stays)
put('gui/om_char.gui', `button = { onclick = "[OpenGameViewData( 'faith', Faith.GetID )]" }\nbutton = { onclick = "[ToggleGameViewData('faith', GetPlayer.GetFaith.GetID)]" }\nbutton = { onclick = "[ToggleGameViewData( 'faith_conversion', Faith.GetID )]" }\n`);
// (a 1.19-like copy of the game's concepts: without secular_ruler and church_authority, heresy without its
// heretical alias; church_authority is defined in another file of the mod)
const gameConcepts = readFileSync(join(gameDir, 'common', 'game_concepts', '00_game_concepts.txt'), 'utf8').replace(/^﻿/, '');
const dropBlock = (text: string, key: string): string => text.replace(new RegExp(`\\r?\\n${key} = \\{[\\s\\S]*?\\r?\\n\\}\\r?\\n`), '\r\n');
// (and without tenet and state_rite, whose aliases core_tenet and state_faith are concepts of the mod's own, as AGOT
// defines them: the game refuses an alias that collides with a concept or alias)
// (and without ethos, whose key is an alias of the mod's state_faith: a game concept added under it collides too)
put('common/game_concepts/00_game_concepts.txt', ['secular_ruler', 'church_authority', 'tenet', 'state_rite', 'ethos'].reduce(dropBlock, gameConcepts).replace('alias = { heresies heretical }', 'alias = { heresies }'));
put('common/game_concepts/om_concepts.txt', 'church_authority = {\n\ttexture = "gfx/interface/icons/om.dds"\n}\n\ncore_tenet = {\n\talias = { core_tenets }\n\ttexture = "gfx/interface/icons/om.dds"\n}\n\nstate_faith = {\n\talias = { ethos }\n\ttexture = "gfx/interface/icons/om.dds"\n}\n');
// (includes of the engine layers: the game keeps them in jomini/ and clausewitz/, next to game/)
put('gfx/FX/jomini/portrait.shader', '# a 1.19 portrait shader\n');
put('gfx/FX/cw/pdxmesh.fxh', '# a 1.19 include\n');
// (shaders with effects of the mod's own: its copy of a small game shader with an effect, its stage code and what that uses (a function and
// a define in an include of the mod's, a function and a vertex struct field in its copy of an engine include) and one of the game's
// definitions changed)
const gameFxText = (rel: string, layer = 'game'): string => readFileSync(join(gameDir, '..', layer, 'gfx', 'FX', ...rel.split('/')), 'utf8').replace(/^﻿/, '');
const gameRiver = gameFxText('river_surface.shader');
put(
    'gfx/FX/river_surface.shader',
    gameRiver.replace('Includes = {', 'Includes = {\n\t"om_river.fxh"').replace('Color.a *= 1.0f - FlatMapLerp;', 'Color.a *= 0.5f * ( 1.0f - FlatMapLerp );') +
    `
PixelShader =
{
	MainCode PS_om_surface
	{
		Input = "VS_OUTPUT_RIVER"
		Output = "PDX_COLOR"
		Code
		[[
			PDX_MAIN
			{
				float4 Color = CalcRiverAdvanced( Input )._Color;
				Color.rgb = OmRiverTint( Color.rgb ) * OM_RIVER_STRENGTH * OmWidthFactor( Input.Width );
				return Color;
			}
		]]
	}
}

Effect om_river_surface
{
	VertexShader = "VertexShader"
	PixelShader = "PS_om_surface"
	Defines = { "RIVER" }
}
`
);
put('gfx/FX/om_river.fxh', 'Code\n[[\n\t#define OM_RIVER_STRENGTH 0.5f\n\tfloat3 OmRiverTint( float3 c )\n\t{\n\t\treturn c * float3( 0.8f, 0.9f, 1.0f );\n\t}\n\tfloat3 OmUnused( float3 c )\n\t{\n\t\treturn c;\n\t}\n]]\n');
put(
    'gfx/FX/jomini/jomini_river.fxh',
    // (a line of the game's changed: a copy that holds all the game's lines is the new version's already and stays as it is, M11a)
    gameFxText('jomini/jomini_river.fxh', 'jomini').replace('float _FlattenMult;', 'float _FlattenMult2;').replace(/(VertexStruct VS_OUTPUT_RIVER[\s\S]*?DistanceToMain\s*:\s*TEXCOORD6;)/, '$1\n\tfloat OmExtra : TEXCOORD6;') +
    '\nCode\n[[\n\tfloat OmWidthFactor( float w )\n\t{\n\t\treturn w * 0.25f;\n\t}\n]]\n'
);
// (an older copy of a game animation; the mod's own animation; a game file 1.20 removed)
put('gfx/models/portraits/male_body/male_body_idle_1.anim', '# a 1.19 animation\n');
put('gfx/models/portraits/male_body/om_own_dance.anim', '# the mod’s own\n');
put('gui/window_faith_creation.gui', 'types FaithCreation = { }\n');
// (a 1.19-like copy of the game's graphics defines: without 1.20's TENET_TYPE_ICON_PATH, a value of the mod's own)
const gameGraphics = readFileSync(join(gameDir, 'common', 'defines', 'graphic', '00_graphics.txt'), 'utf8').replace(/^﻿/, '');
put('common/defines/graphic/00_graphics.txt', gameGraphics.replace(/\r?\n\s*TENET_TYPE_ICON_PATH = "[^"]*"/, '').replace('DOCTRINE_TYPE_ICON_PATH = "gfx/interface/icons/faith_doctrines"', 'DOCTRINE_TYPE_ICON_PATH = "gfx/interface/icons/om_doctrines"')
    // (paths the game moved: the trait overlays and the interaction category folder 1.19 named; the mod's own folder stays, it ships it)
    .replace('TRAIT_OVERLAY_VIRTUE = "gfx/interface/icons/traits/virtue.dds"', 'TRAIT_OVERLAY_VIRTUE = "gfx/interface/icons/traits/virtue_big.dds"')
    .replace('TRAIT_OVERLAY_SIN = "gfx/interface/icons/traits/sin.dds"', 'TRAIT_OVERLAY_SIN = "gfx/interface/icons/om_kept/sin_big.dds"')
    .replace('CHARACTER_INTERACTION_CATEGORY_ICON_PATH = "gfx/interface/icons/character_interactions"', 'CHARACTER_INTERACTION_CATEGORY_ICON_PATH = "gfx/interface/icons/character_interaction_category"'));
put('gfx/interface/icons/om_doctrines/om_doctrine.dds', 'DDS om');
put('gfx/interface/icons/om_kept/sin_big.dds', 'DDS om');
// (the tenets' icons: the game's renamed one, the mod's own in the 1.19 folder; a holy site written the 1.19 way)
put('gfx/interface/icons/faith_doctrines/core_tenet_om.dds', 'DDS om');
put('common/religion/holy_site_types/om_holy_sites.txt', `om_site = {
	county = c_roma
	character_modifier = {
		stewardship = 1
	}
	flag = om_bonus # the bonus
	flag = om_other
}

om_second_site = {
	county = c_roma
	# the old
	flag = om_third
	parameters = {
		om_known
	}
}
`);
put('gui/om_own_window.gui', 'window = { name = "om_own" }\n');
// (script written the 1.19 way: tenets tested and changed as doctrines, a link, faith targets of the trait counts, renamed
// effects and triggers; statements of the same keys that must stay: other values, other blocks, comments)
put(
    'events/om_events.txt',
    `namespace = om_ev

om_ev.0001 = {
	type = character_event
	trigger = {
		faith = { has_doctrine = tenet_om_own }
		NOT = { faith = { has_doctrine = doctrine_monogamy } }
		has_doctrine = tenet_pacifism
		scope:actor.faith = { OR = { has_doctrine = tenet_pacifism has_doctrine = doctrine_monogamy } }
		num_virtuous_traits = { value > 0 target = scope:actor.faith }
		num_sinful_traits = { value < 1 target = faith }
		num_sinful_traits = { value < 1 target = faith:catholic }
		num_sinful_traits = { value < 1 target = $FAITH$ }
		num_sinful_traits = { value < 1 target = root.rite }
		om_other_trigger = { target = root.faith }
	}
	immediate = {
		faith = {
			add_doctrine = tenet_om_own
			remove_doctrine = tenet_pacifism
			add_doctrine = doctrine_monogamy
		}
		scope:barony = { lease_out_to = scope:holy_order }
		scope:title = { set_state_faith = root.faith }
		set_state_faith = scope:some_faith
		guardian_or_court_tutor_trigger_event = { EVENT = om_ev.0002 }
		# has_doctrine = tenet_om_own (a comment stays)
		if = {
			limit = {
				sexual_activity_with_partner_is_criminal_in_faith_trigger = { PARTNER = scope:partner FAITH = root.faith }
				sexual_activity_with_partner_is_criminal_in_faith_trigger = { PARTNER = scope:partner FAITH = scope:somebody }
			}
		}
		rite = { has_doctrine = tenet_pacifism }
		random_list = {
			10 = { faith = { has_doctrine = tenet_om_own } }
		}
		scope:x = { om_effect_with_link = doctrine:tenet_om_own }
	}
}
`
);
put('common/scripted_triggers/om_triggers.txt', 'om_tenet_trigger = {\n\thas_doctrine = tenet_pacifism\n\thas_doctrine = doctrine_monogamy\n}\n' + `
om_fervor_value = {
	multiply = define:NFaith|FAITH_CREATION_FERVOR_DISCOUNT_PER_MISSING_FERVOR
	max = define:NFaith|FAITH_CREATION_FERVOR_DISCOUNT_MAX # a comment
	min = define:NRite|RITE_CREATION_FERVOR_DISCOUNT_MAX
	other = define:NOm|OM_NO_SUCH_KEY
}

# (the faith's holy sites: 1.19's loops over the barony titles; one already written for the holy site scope)
om_holy_site_trigger = {
	faith = {
		any_holy_site = { county.holder = root }
		any_holy_site = { count >= 1 }
		every_holy_site = { save_scope_as = om_site add_to_list = om_sites }
		random_holy_site = { limit = { barony = { is_county_capital = yes } } }
		any_holy_site = { holy_site_county.holder = root }
		any_holy_site = { is_eminent = no county.holder = root }
		# any_holy_site = { county.holder = root } (a comment stays)
		any_holy_site_barony = { county.holder = root }
	}
}
`);
// (CRLF line ends stay; a file with nothing but a statement no rule can map has no edit; the notes still tell it)
put('common/scripted_effects/om_crlf_effects.txt', 'om_crlf_effect = {\n\tif = {\n\t\tlimit = { has_doctrine = tenet_pacifism }\n\t\tfaith = { remove_doctrine = tenet_pacifism }\n\t}\n}\n'.replace(/\n/g, '\r\n'));
put('common/scripted_triggers/om_unmapped_only.txt', 'om_unmapped_trigger = {\n\tnum_virtuous_traits = { value > 0 target = scope:somebody }\n\tnum_sinful_traits = { value > 0 target = $RITE$ }\n}\n');
// (the users of the opinion flag the doctrine fix converts: pacifist_opinion_active is the flag pacifist; a parameter of that spelling no doctrine of the mod defines, and a comment, stay)
put('common/scripted_triggers/om_opinion_triggers.txt', 'om_opinion_trigger = {\n\tfaith = { has_doctrine_parameter = pacifist_opinion_active }\n\trite_has_parameter = pacifist_opinion_active\n\thas_doctrine_parameter = om_unrelated_opinion_active\n\t# has_doctrine_parameter = pacifist_opinion_active\n}\n');
// (the engine's named value: the mod's old faith_creation_cost_mult is rite_creation_cost_mult; a mod that defines the new one itself keeps both)
put('common/script_values/om_creation_values.txt', 'faith_creation_cost_mult = {\n\tsubtract = {\n\t\tvalue = scope:old_faith.faith_conversion_fervor_mult\n\t\tdesc = "faith_creation_cost_fervor_impact"\n\t}\n}\n');
// (macro call sites: a scripted trigger that passes FAITH on as the target of the trait counts has its calls written for the rite; one that
// uses FAITH otherwise as well keeps its calls and is told)
put('common/scripted_triggers/om_virtue_triggers.txt', 'om_virtue_check_trigger = {\n\tnum_sinful_traits = { value <= 0 target = $FAITH$ }\n\tnum_virtuous_traits = { value >= 1 target = $FAITH$ }\n}\n\nom_faith_use_trigger = {\n\tnum_sinful_traits = { value <= 0 target = $FAITH$ }\n\t$FAITH$ = { is_valid = yes }\n}\n');
put('common/scripted_effects/om_virtue_calls.txt', 'om_virtue_call_effect = {\n\tif = {\n\t\tlimit = {\n\t\t\tom_virtue_check_trigger = { FAITH = root.faith }\n\t\t\tom_virtue_check_trigger = { FAITH = faith:catholic }\n\t\t\tom_faith_use_trigger = { FAITH = root.faith }\n\t\t}\n\t}\n}\n');
put('common/modifiers/om_modifiers.txt', 'om_modifier = {\n\ticon = learning_positive\n\tfaith_creation_piety_cost_mult = -0.1\n\tfaith_creation_piety_cost_add = 5\n}\n');
// (portrait modifiers are script too)
put('gfx/portraits/portrait_modifiers/om_headgear.txt', 'om_headgear = {\n\tusage = game\n\tweight = {\n\t\tvalue = 0\n\t\tif = {\n\t\t\tlimit = { faith = { has_doctrine = tenet_pacifism } }\n\t\t\tadd = 1\n\t\t}\n\t}\n}\n');
// (the rules: faith_creation is can_create_rite now, faith_conversion stays; the rest of the game's rules are missing)
put('common/scripted_rules/00_rules.txt', 'faith_creation = {\n\tis_adult = yes\n\tis_at_war = no\n}\n\nfaith_conversion = {\n\tis_adult = yes\n}\n');
// (tenets the mod wrote as doctrines: moved to the tenet types, their piety_cost runs with a rite. om_param is a parameter no loaded doctrine
// has, which the inert rule makes false; since round 9 an if whose limit it makes false loses its body and goes, so the parameter has an if of
// its own and the doctrine's test stays to be seen)
put(
    'common/religion/doctrine_types/om_tenets.txt',
    `tenet_om_debug = {
	icon = core_tenet_communal_identity
	name = {
		first_valid = {
			triggered_desc = {
				trigger = { religion_tag = om_religion }
				desc = tenet_om_debug_name_om
			}
			desc = tenet_om_debug_name
		}
	}
	piety_cost = {
		value = 0
		if = {
			limit = { has_doctrine = tenet_om_debug }
			multiply = 0.5
		}
		if = {
			limit = { has_doctrine = doctrine_monogamy }
			add = 1
		}
		if = {
			limit = { has_doctrine_parameter = om_param }
			add = 3
		}
		if = {
			limit = { faith = { has_doctrine = tenet_om_own } }
			add = 2
		}
	}
	can_pick = {
		has_doctrine = tenet_om_own
		religion_tag = om_religion
		NOT = { doctrine:tenet_om_own = { is_in_list = selected_doctrines } }
		doctrine:doctrine_monogamy = { is_in_list = selected_doctrines }
	}
}

tenet_om_own = {
	icon = core_tenet_om
	piety_cost = { value = 0 }
}
`
);
put(
    'common/laws/om_laws.txt',
    `om_law_group = {
	default = om_law_a
	om_law_a = {
		modifier = { monthly_prestige = 1 }
	}
	om_law_b = {
		modifier = { monthly_prestige = 2 }
	}
}
`
);
// (what 1.20 added to definitions an older copy of the game's file still holds: tenet_legalism is the 1.19 tenet (a doctrine of
// no group) of a tenet the game defines; its parameter om_own_param is the mod's, legalism_reduced_faction_virtues the game's and
// its own already. tenet_literalism's tenet_literalism_conversion_resistance is a parameter the mod's tenet_om_other has too: the
// mod knows it, it stays out. doctrine_polygamy, the group, the law group, the piety level, the relic template are the game's names)
put(
    'common/religion/doctrine_types/om_shared_tenets.txt',
    `tenet_legalism = {
	icon = core_tenet_legalism
	piety_cost = { value = 0 }
	parameters = {
		legalism_reduced_faction_virtues
		om_own_param
	}
}

tenet_literalism = {
	icon = core_tenet_literalism
	parameters = {
		literalist_debate_enabled
	}
}

tenet_om_other = {
	icon = core_tenet_om
	parameters = {
		tenet_literalism_conversion_resistance
	}
}

doctrine_polygamy = {
	doctrine_group_type = doctrine_marriage_type
	index = 1
	parameters = {
		doctrine_polygamy
	}
}

doctrine_funeral_sky_burial = {
	doctrine_group_type = doctrine_funeral
	index = 3
	parameters = {
		sky_burials_active
	}
}
`
);
// (a tenet an earlier "Update for 1.20" fix of the card wrote into the mod's own tenet_types file (header comment and all), with
// the game's personal_tenet_modifier changed: it is no sign that the mod knows the 1.20 fields, the others still get them, and this
// one gets what it lacks in the patch mod's copy)
put('common/religion/tenet_types/om_app_tenet_types.txt', '# tenets of the mod (moved from doctrines for 1.20 by CrusaderPope)\n\ntenet_asceticism = {\n\ticon = tenet_asceticism\n\tpersonal_tenet_modifier = {\n\t\tmonthly_piety = 0.5\n\t}\n}\n');
put('common/religion/doctrine_group_types/om_marriage_group.txt','doctrine_marriage_type = {\r\n\tcategory = marriage\r\n}\r\n');
put(
    'common/laws/om_crown_laws.txt',
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
put('common/modifiers/om_piety_levels.txt', 'piety_level_4 = {\n\thide_effects = yes\n}\n');
put('common/artifacts/templates/om_templates.txt', 'small_religious_carving_template = {\n\tcan_benefit = { always = yes }\n\tfallback = {\n\t\tmonthly_prestige = 0.05\n\t}\n}\n');
// (the other keys 1.20 renamed or dropped: buildings' rite modifiers (a parameter nothing defines goes, character_faith_modifier
// has no counterpart), the modifier by the faith's doctrine, a decision widget's trigger)
put(
    'common/buildings/om_buildings.txt',
    `om_temple_01 = {
	province_faith_modifier = {
		parameter = basic_pilgrimage_rewards
		monthly_piety = 0.1
	}
	province_faith_modifier = {
		parameter = can_grant_knighthood
		monthly_piety = 0.4
	}
	county_faith_modifier = {
		parameter = basic_pilgrimage_rewards
		development_growth = 0.1
	}
	duchy_capital_county_faith_modifier = {
		parameter = om_nowhere_defined
		levy_size = 0.1
	}
	duchy_capital_county_faith_modifier = {
		parameter = basic_pilgrimage_rewards
		levy_size = 0.2
	}
	character_faith_modifier = {
		parameter = can_grant_knighthood
		monthly_piety = 0.2
	}
	character_faith_modifier = {
		parameter = basic_pilgrimage_rewards
		monthly_piety = 0.3
	}
	character_modifier = {
		monthly_prestige = 0.1
	}
}
`
);
put('common/lifestyle_perks/om_perks.txt', 'om_perk = {\n\tdoctrine_character_modifier = {\n\t\tdoctrine = doctrine_monogamy\n\t\tmonthly_piety = 0.1\n\t}\n}\n');
put('common/dynasty_perks/om_dynasty_perks.txt', 'om_dynasty_perk = {\n\tdoctrine_character_modifier = {\n\t\tname = om_dynasty_perk_name\n\t\tdoctrine = doctrine_monogamy\n\t\tmonthly_piety = 0.1\n\t}\n}\n');
put('common/culture/traditions/om_traditions.txt', 'tradition_om = {\n\tcategory = realm\n\tdoctrine_character_modifier = {\n\t\tdoctrine = doctrine_monogamy\n\t\tsame_faith_opinion = 3\n\t}\n}\n');
put('common/situation/situations/om_situations.txt', 'om_situation = {\n\tphases = {\n\t\tom_phase = {\n\t\t\tparticipant_groups = {\n\t\t\t\tom_group = {\n\t\t\t\t\tdoctrine_character_modifier = {\n\t\t\t\t\t\tname = om_situation_name\n\t\t\t\t\t\tdoctrine = doctrine_monogamy\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n');
put('common/decisions/om_holy_decisions.txt', 'om_holy_order_decision = {\n\twidget = {\n\t\tcontroller = create_holy_order\n\t\tbarony_valid = {\n\t\t\tis_county_capital = yes\n\t\t}\n\t}\n}\n');
// (government rules the version dropped: the mechanic_type instead; one of the mod's governments has none, one has it already)
put(
    'common/governments/om_governments.txt',
    `om_celestial_government = {
	government_rules = {
		administrative = yes
		legitimacy = yes
	}
	color = { 1 2 3 }
}

om_admin_government = {
	government_rules = {
		administrative = yes
	}
	mechanic_type = administrative
}

om_temple_government = {
	government_rules = {
		religious = yes
	}
}

om_quiet_government = {
	government_rules = {
		religious = no
		legitimacy = yes
		administrative = no
	}
}
`
);
put('common/scripted_triggers/om_government_triggers.txt', 'om_government_trigger = {\n\tgovernment_allows = administrative\n\tNOT = { government_allows = administrative }\n\tgovernment_allows = religious\n\tgovernment_allows = merit\n}\n');
// (appointments and elections: allow_same_tier_candidates; add = … lists)
put(
    'common/succession_appointment/om_appointments.txt',
    `om_governor = {
	default_candidates = { landed_vassal }
	allow_same_tier_candidates = yes
}

om_regent = {
	allow_same_tier_candidates = no
	cooldown = no
}

om_clerk = {
	allow_same_tier_candidates = yes
	cooldown = yes
}
`
);
put(
    'common/succession_election/om_elections.txt',
    `om_elective = {
	electors = {
		max = 5
		add = holder
		add = {
			type = holder_direct_vassals
			limit = {
				is_house_head = yes
			}
		}
		add = {
			type = holder_direct_vassals
			limit = { is_adult = yes }
		}
	}

	candidates = {
		add = holder
	}

	elector_vote_strength = {
		base = 1
		modifier = {
			add = gold
			gold > 0
		}
	}
}

om_done_elective = {
	candidates = {
		character_sets = {
			om_done_holder = {
				type = holder
			}
		}
	}
}
`
);
// (accessories the genes list: the game's male_clothes_religious_orthodox_head_01 under 1.19's _common name; the game's own
// …_nobility_02_common accessory and a name no accessory is behind stay)
put(
    'common/genes/om_genes.txt',
    `gene_om_clothes = {
	group = clothes
	clothes = {
		male = {
			1 = male_clothes_religious_orthodox_head_01_common
			1 = male_clothes_secular_dde_hre_nobility_02_common
			1 = om_not_an_accessory_common
			2 = { male_clothes_religious_orthodox_head_01_common male_clothes_secular_dde_hre_nobility_02_common }
		}
	}
}
`
);
// (activity types without header_background: the type's own picture, the game's of the name without the mod's word, another's block
// of several statements, else the feast's; one that has it)
put(
    'common/activities/activity_types/om_activities.txt',
    `activity_om_party = {
	conditions = { always = yes }
	background = {
		texture = "gfx/interface/illustrations/activity_header_backgrounds/activity_om_picture.dds"
	}
}

activity_om_coronation = {
	conditions = { always = yes }
}

activity_om_pilgrimage = {
	conditions = { always = yes }
}

activity_om_odd = {
	conditions = { always = yes }
	background = {
		texture = "gfx/interface/illustrations/om_other.dds"
	}
}

activity_om_done = {
	header_background = "gfx/interface/illustrations/om_done.dds"
}
`
);

const files =(dir: string): Map<string, string> =>
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
const modBefore = files(root);

const settings: Settings = {
    gameDir: install,
    language: 'english',
    userDir: tmp,
    customModLists: [{ id: 'l1', name: 'Test list', mods: [{ id: 'mod/old_mod.mod', enabled: true }] }],
    modList: 'custom:l1'
};
let idx!: GameIndex;
/** the file layers of the builds under way and of the one that is current (every other is closed: a zipped mod is held open by its layer; keeping the closed ones would keep their file lists too) */
const layers = new Set<GameFiles>();
const done = new Set<GameFiles>();
let sb!: StoryBuilder;
let builds = 0;
/** the game files' parse results of the first build, for every later one (see the header) */
const gameParses = new ParseReuse(gameDir);
/** ms spent in the builds (overlapping ones counted each) */
let buildMs = 0;
const reindex = async (): Promise<void> =>
{
    const state = await modsState(host);
    const files = new GameFiles(gameDir, modsOfList(state, state.selected));
    layers.add(files);
    const t0 = performance.now();
    const built = await buildIndex(new GameIndex(files, 'english'), undefined, gameParses);
    buildMs += performance.now() - t0;
    idx = built;
    sb = new StoryBuilder(idx);
    builds++;
    // (the file of an open zip that was deleted stays in its folder on Windows, and the folder cannot go. The host's reindex runs without being awaited,
    // so builds can overlap: of the layers, the ones that are done and not this one go, not one that is still building)
    for (const f of layers)
        if (f !== files && done.has(f))
        {
            f.close();
            layers.delete(f);
            done.delete(f);
        }

    done.add(files);
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
    // (written files taken in incrementally, as the app does)
    refreshFiles: async (f) =>
    {
        idx.refreshFiles(f);
        sb = new StoryBuilder(idx);
    },
    dataDir: () => join(tmp, 'data')
};

try
{
    // (the data calls by themselves: the expressions are read (arguments, strings, the blocks around), not the file's text)
    {
        const [ui, texts, doctrines] = MIGRATIONS[0].dataCalls!;
        const env: DataCallEnv = { tenets: new Set(['tenet_x']), gameKey: (k) => k === 'GAME_KEY' || k === 'TENET_KEY', gameScope: (k) => (k === 'TENET_KEY' ? 'tenet' : undefined) };
        const gui = (text: string, g = ui): string => applyCallEdits(text, guiCallEdits(text, g, env).edits);
        const loc = (text: string, g = doctrines): string => applyCallEdits(text, locCallEdits(text, g, env).edits);
        check(gui('a = { onclick = "[ClearExploringRealms]" onclick = [ClearExploringHouses] }') === 'a = { onclick = "[ClearExploredRealms]" onclick = [ClearExploredHouses] }', 'a rename: quoted and bare property values');
        check(gui('a = { text = "[Foo( \'ClearExploringRealms\' )] ClearExploringRealms [ClearExploringRealmsAll] [Foo.ClearExploringRealmsX]" }') === 'a = { text = "[Foo( \'ClearExploringRealms\' )] ClearExploringRealms [ClearExploringRealmsAll] [Foo.ClearExploringRealmsX]" }', 'a name in a string, outside the brackets or inside a longer name is not a call');
        check(gui('a = {\n\t# onclick = "[ClearExploringRealms]"\n\tonclick = "[ClearExploringRealms]" # [ClearExploringHouses]\n}\n') === 'a = {\n\t# onclick = "[ClearExploringRealms]"\n\tonclick = "[ClearExploredRealms]" # [ClearExploringHouses]\n}\n', 'comments are not read');
        check(gui('a = { onclick = "[OpenSuccessionLawChangeWindow( Foo( Bar.Self, 1 ), \'x\' )]" }') === 'a = { onclick = "[OpenSuccessionLawChangeWindow( Foo( Bar.Self, 1 ), \'x\' )]" }' && gui('a = { onclick = "[OpenSuccessionLawChangeWindow( Foo( Bar.Self, 1 ) )]" }') === "a = { onclick = \"[OpenGameViewData( 'succession_law_change', Foo( Bar.Self, 1 ) )]\" }", 'a call reshaped: its argument as written (nested parentheses), a call with another number of arguments untouched');
        check(gui('a = { visible = "[X.HasRule( \'administrative\' )]" visible = "[X.HasRule( \'merit\' )]" visible = "[X.HasRule(\'administrative\').Not]" }') === 'a = { visible = "[X.HasMechanic( \'administrative\' )]" visible = "[X.HasRule( \'merit\' )]" visible = "[X.HasMechanic(\'administrative\').Not]" }', 'a rename keeps the arguments, only the one with the listed argument is renamed');
        check(gui('a = {\n\tvisible = "[Not( ObjectsEqual( Faith.Self, RulerDesignerWindow.GetFaith ) )]"\n\tvisible = "[StraitMapIcon.ShouldBeShown]"\n\tvisible = "[And( StraitMapIcon.ShouldBeShown, X )]"\n}\n') === 'a = {\n\tvisible = "[Not( ObjectsEqual( Faith.Self, RulerDesignerWindow.GetRite.GetFaith ) )]"\n\tvisible = "[And( StraitMapIcon.ShouldBeShown, X )]"\n}\n', 'a call in an argument; a property dropped only when the call is all of its value');
        const twice = gui('a = { blockoverride "faith_context" { datacontext = "[X.GetFaith]" } }');
        check(twice === gui(twice) && gui('a = { blockoverride "faith_context" { datacontext = "[RulerDesignerWindow.GetFaith]" } blockoverride "other" { datacontext = "[RulerDesignerWindow.GetFaith]" } }') === 'a = { blockoverride "faith_context" { datacontext = "[RulerDesignerWindow.GetRite]" } blockoverride "other" { datacontext = "[RulerDesignerWindow.GetRite.GetFaith]" } }', 'the block around decides (faith_context: the designer’s rite), and a second run changes nothing');
        check(gui('a = {\n\tblockoverride "faith_context"\n\t{\n\t\tdatacontext = "[X.GetFaith]" # why\n\t}\n}\n') === 'a = {\n\tblockoverride "faith_context"\n\t{\n\t\tdatacontext = "[X.GetFaith]" # why\n\t\tdatacontext = "[X.GetRite]"\n\t}\n}\n', 'a sibling statement goes after the line (and its comment)');
        check(loc(' K: "[GetFaithDoctrine(\'tenet_x\').GetName( GetPlayer.GetFaith )] [GetFaithDoctrine(\'doctrine_y\').GetName( GetPlayer.GetFaith )] [GetFaithDoctrine(\'tenet_new\').GetBaseName]"\n') === ' K: "[GetTenetType(\'tenet_x\').GetName( GetPlayer.GetRite )] [GetDoctrineType(\'doctrine_y\').GetName( GetPlayer.GetFaith )] [GetTenetType(\'tenet_new\').GetBaseName]"\n', 'a doctrine of the old API: a tenet (by the set, or named so) gets the type and a rite for its name; a doctrine keeps its faith');
        check(loc(' K: "[FaithDoctrine.GetEffectsDescription( Faith.Self )]"\n GAME_KEY: "[FaithDoctrine.GetEffectsDescription( Faith.Self )] [FaithDoctrine.GetEffectsDescription( a.b.GetFaith )] [FaithDoctrine.GetEffectsDescription( x )]"\n') === ' K: "[DoctrineType.GetEffectsDescription( Faith.GetMainRite )]"\n GAME_KEY: "[DoctrineType.GetEffectsDescription( Rite.Self )] [DoctrineType.GetEffectsDescription( a.b.GetRite )] [DoctrineType.GetEffectsDescription( x )]"\n', 'what takes a rite: Faith.Self is the rite in scope for a text of the game’s own key, else the main rite; an argument that is not a faith stays');
        check(locCallEdits(' K: "[FaithDoctrine.GetEffectsDescription( x )] [FaithDoctrine.GetEffectsDescription( a.GetFaith )]"\n', doctrines, env).left.length === 1, 'an argument that cannot be mapped is told, once, though the call is rewritten after');
        const dropText = ' GAME_KEY: "[X]"\n OWN: "[X]"\n';
        const dropGroup = { ...doctrines, keepGame: ['GAME_KEY', 'OWN'] };
        check(loc(dropText, dropGroup) === ' OWN: "[X]"\n', 'a restructured key goes when the game defines it, stays when it does not');
        const goneGroup = { ...texts, gone: ['FaithCreationDoctrineItem'] };
        check(loc(' A: "[FaithCreationDoctrineItem.X]"\n GAME_KEY: "[FaithCreationDoctrineItem.X]"\n B: "[FaithCreationWindow.GetNewFaithName|U]"\n', goneGroup) === ' A: "[FaithCreationDoctrineItem.X]"\n B: "[RiteCreationWindow.GetNewRiteName|U]"\n', 'a name with no replacement: the key goes if the game has it, else stays; a rename before a format keeps the format');
        check(loc(' K: "[ActivityPhase.GetDescription] [ActivityPhase.GetDescription( Activity.Self )] [Other.ActivityPhase.GetDescription]"\n', texts) === ' K: "[ActivityPhase.GetDescription( Activity.Self )] [ActivityPhase.GetDescription( Activity.Self )] [Other.ActivityPhase.GetDescription( Activity.Self )]"\n', 'an argument added to a call without one, once');
        // (what no rule maps is told, never silent)
        const larger = guiCallEdits('a = {\n\tvisible = "[And( StraitMapIcon.ShouldBeShown, X )]"\n}\n', ui, env);
        check(larger.edits.length === 0 && larger.left.length === 1 && larger.left[0].includes('StraitMapIcon.ShouldBeShown'), `a removed call inside a larger expression stays and is told: ${larger.left.join(' | ')}`);
        check(guiCallEdits('a = { text = "[GetFaithDoctrine( Foo ).GetName( GetPlayer.GetFaith )]" }', doctrines, env).left.length === 1, 'GetFaithDoctrine with an argument that is no string is told');
        const noRite = locCallEdits(' K: "[GetFaithDoctrine(\'tenet_x\').GetName] [GetFaithDoctrine(\'tenet_x\').GetName( a, b )] [GetFaithDoctrine(\'doctrine_y\').GetName]"\n', doctrines, env);
        check(noRite.left.length === 2 && applyCallEdits(' K: "[GetFaithDoctrine(\'tenet_x\').GetName]"\n', locCallEdits(' K: "[GetFaithDoctrine(\'tenet_x\').GetName]"\n', doctrines, env).edits).includes('GetTenetType'), `a tenet's name called with no rite or two arguments is told (a doctrine's is not): ${noRite.left.join(' | ')}`);
        check(gui('a = { blockoverride "faith_context" { container = { datacontext = "[Foo.GetFaith]" } datacontext = "[Bar.GetFaith]" } }') === 'a = { blockoverride "faith_context" { container = { datacontext = "[Foo.GetFaith]" } datacontext = "[Bar.GetFaith]" datacontext = "[Bar.GetRite]" } }', 'the faith_context sibling is for the block’s own statements, not a block nested in it');
        check(gui('a = { blockoverride "faith_context" { container = { datacontext = "[RulerDesignerWindow.GetFaith]" } } }') === 'a = { blockoverride "faith_context" { container = { datacontext = "[RulerDesignerWindow.GetRite.GetFaith]" } } }', 'a faith_context rule is for the block’s own statements: a nested widget keeps the faith');
        check(gui('a = { text = "[ActivityPhase.GetDescription] [DecisionViewWidgetCreateHolyOrder.HasValidBaronies]" }', texts) === 'a = { text = "[ActivityPhase.GetDescription( Activity.Self )] [DecisionViewWidgetSelectBarony.HasValidTitles]" }', 'the activity phase and holy order barony calls are rewritten in interface files as well');
        check(loc(' K: "[FAITH_DOCTRINE.GetName( FAITH.Self )]"\n TENET_KEY: "[FAITH_DOCTRINE.GetName( FAITH.Self )] [FAITH_DOCTRINE.GetName( Rite.Self )]"\n') === ' K: "[DOCTRINE_TYPE.GetName( FAITH.Self )]"\n TENET_KEY: "[TENET_TYPE.GetName( FAITH.GetMainRite )] [TENET_TYPE.GetName( Rite.Self )]"\n', 'the FAITH_DOCTRINE scope follows the scope the game’s text of the key uses (tenet keys: TENET_TYPE and a rite)');
        check(loc(' K: "[GetFaithDoctrine(\'doctrine_x\').GetName( GetPlayer.GetFaith )]" # "c [GetStateFaith]"\n K2: "He said "[FaithDoctrine.GetDescription( GetPlayer.GetFaith )]" # c"\n') === ' K: "[GetDoctrineType(\'doctrine_x\').GetName( GetPlayer.GetFaith )]" # "c [GetStateFaith]"\n K2: "He said "[DoctrineType.GetDescription( GetPlayer.GetFaith )]" # c"\n', 'the text of a localization line ends before a comment, even a comment holding a quote');
        const bom = guiCallEdits('a = { onclick = "[ClearExploringRealms]" }\r\n', ui, env);
        check(bom.edits.length === 1 && bom.left.length === 0, 'CRLF files are read as well');
    }

    // (the opinion flags the doctrine fix converts: the old name and the flag, only in a parameters block, as `= yes` or the bare word)
    {
        const flags = opinionFlagsOf(parse('d = {\n\tparameters = {\n\t\tpacifist_opinion_active = yes\n\t\topinion_of_pacifist_opinion_active = 10\n\t\teastern_syncretic_actor_opinion_active\n\t\tx_opinion_active = no\n\t\tplain\n\t}\n\tother = { y_opinion_active = yes }\n}\n'));
        check([...flags].map((p) => p.join('>')).join(';') === 'pacifist_opinion_active>pacifist;eastern_syncretic_actor_opinion_active>eastern_syncretic_actor', `opinion flags: ${[...flags].map((p) => p.join('>')).join(';')}`);
        const group = MIGRATIONS[0].statements!.find((g) => g.rules.some((r) => r.valueMap === 'opinion_flags'))!;
        const env: StatementEnv = { sets: {}, defined: () => false, roots: [], maps: { opinion_flags: () => flags } };
        const text = 'a = {\n\tfaith = { has_doctrine_parameter = pacifist_opinion_active }\n\trite_has_parameter = "eastern_syncretic_actor_opinion_active"\n\thas_doctrine_parameter = other_opinion_active\n\thas_doctrine_parameter = pacifist\n}\n';
        const out = applyStatementEdits(text, statementEdits(text, 'common/x.txt', group, env).edits);
        check(out === 'a = {\n\tfaith = { has_doctrine_parameter = pacifist }\n\trite_has_parameter = "eastern_syncretic_actor"\n\thas_doctrine_parameter = other_opinion_active\n\thas_doctrine_parameter = pacifist\n}\n', `opinion flags: the users test the flag, a name no converted definition has stays:\n${out}`);
    }

    // (the statement rules by themselves: dropping, a name the mod defines itself, the scope of a statement)
    {
        const env: StatementEnv = { sets: { tenets: new Set(['tenet_x']) }, defined: (_folder, key) => key === 'own_effect', roots: [{ folder: 'common/x', blocks: { piety_cost: 'rite', can_pick: 'faith' } }] };
        const run = (rel: string, text: string, rules: NonNullable<Parameters<typeof statementEdits>[2]['rules']>): string => applyStatementEdits(text, statementEdits(text, rel, { files: [], label: '', rules }, env).edits);
        const dropped = run('common/y/a.txt', 'a = {\n\told_effect = yes\n\tkeep = yes\n\tb = { old_effect = scope:x }\n\tc = { old_effect = no other = yes }\n}\n', [{ key: 'old_effect', value: 'yes|scope:x', drop: true }]);
        check(dropped === 'a = {\n\tkeep = yes\n\tb = {  }\n\tc = { old_effect = no other = yes }\n}\n', `a dropped statement takes its line (a block with nothing left stays): ${JSON.stringify(dropped)}`);
        const own = run('common/y/a.txt', 'a = { own_effect = 1 other_effect = 2 }\n', [{ key: 'own_effect', rename: 'new_effect', unlessDefined: { folder: 'common/y', name: 'old' } }, { key: 'other_effect', rename: 'new_other', unlessDefined: { folder: 'common/y', name: 'old' } }]);
        check(own === 'a = { own_effect = 1 new_other = 2 }\n', 'a scripted name the mod defines itself keeps its name');
        const scoped = run('common/x/a.txt', 'a = {\n\tpiety_cost = { if = { limit = { k = 1 faith = { k = 2 } rite = { k = 3 } scope:q = { k = 4 } scope:q.faith = { switch = { k = 5 } } } } }\n\tcan_pick = { k = 6 any_faith_rite = { k = 7 } }\n}\n', [{ key: 'k', scope: ['rite'], value: '[1-9]', replace: 'rite', rename: 'r' }, { key: 'k', scope: ['faith'], rename: 'f' }]);
        // (bodyNot: a block that speaks of the new reading is left; gather: a definition's own word statements into one block)
        const loops = run('common/y/a.txt', 'a = {\n\tany_x = { county = yes }\n\tany_x = { new_thing = yes }\n\t# any_x = { county = yes }\n\tany_x = { # new_thing in a comment\n\t\tcounty = yes\n\t}\n}\n', [{ key: 'any_x', bodyNot: '\\bnew_thing\\b', rename: 'any_x_old' }]);
        check(loops === 'a = {\n\tany_x_old = { county = yes }\n\tany_x = { new_thing = yes }\n\t# any_x = { county = yes }\n\tany_x_old = { # new_thing in a comment\n\t\tcounty = yes\n\t}\n}\n', `a block with a name of the new reading stays, a comment does not count: ${JSON.stringify(loops)}`);
        const gathered = run('common/y/a.txt', 'a = {\r\n\tflag = one # first\r\n\tb = { flag = nested }\r\n\t# second\r\n\tflag = two\r\n\tflag = "not a word"\r\n}\r\n\r\nc = {\r\n\tparameters = { x }\r\n\tflag = three\r\n}\r\n\r\nd = {\r\n\tparameters = {\r\n\t\ty\r\n\t}\r\n\t# four\r\n\tflag = four\r\n}\r\n', [{ key: 'flag', gather: { into: 'parameters' } }]);
        check(gathered === 'a = {\r\n\tparameters = {\r\n\t\tone # first\r\n\t\t# second\r\n\t\ttwo\r\n\t}\r\n\tb = { flag = nested }\r\n\tflag = "not a word"\r\n}\r\n\r\nc = {\r\n\tparameters = { x three }\r\n}\r\n\r\nd = {\r\n\tparameters = {\r\n\t\ty\r\n\t\t# four\r\n\t\tfour\r\n\t}\r\n}\r\n', `the flag statements of a definition become the words of one block (comments, line ends and the block it has kept): ${JSON.stringify(gathered)}`);
        // (defines: a key the copy lacks, and a path of the copy that points where nothing is while the game's value exists)
        const gameDefs = 'NGameIcons = {\n\tA_PATH = "gfx/interface/icons/traits/virtue.dds"\n\tB_PATH = "gfx/interface/icons/character_interactions"\n\tC_PATH = "gfx/interface/icons/traits/sin.dds"\n\tD_PATH = "gfx/interface/icons/traits/virtue.dds"\n\tNEW = 5\n}\n';
        const modDefs = 'NGameIcons = {\n\tA_PATH = "gfx/interface/icons/traits/virtue_big.dds"\n\tB_PATH = "gfx/om_mod/ours"\n\tC_PATH = "gfx/om_other/sin.dds"\n\tD_PATH = "gfx/om_also_missing/none.dds"\n}\n';
        const stale: string[] = [];
        const diff = missingDefines(gameDefs, modDefs, pathTest({ gameDir, modFiles: ['gfx/om_mod/ours/x.dds'], others: [] }), stale);
        check(stale.join() === 'NGameIcons.A_PATH,NGameIcons.C_PATH,NGameIcons.D_PATH' && diff.get('NGameIcons')?.length === 4 && diff.get('NGameIcons')!.includes('NEW = 5') && !diff.get('NGameIcons')!.some((l) => l.startsWith('B_PATH')), `defines: paths pointing nowhere are the game's, one the mod ships stays: ${stale.join()}`);
        check([...defineRefs("a = define:NFaith|KEY_A # define:NX|COMMENT\nb = GetDefine('NGame', 'KEY_B')")].join() === 'NFaith|KEY_A,NX|COMMENT,NGame|KEY_B' && [...definedKeys('NA = { B = 1 c = 2 }')].join() === 'na|b,na|c', 'define references and definitions are read');
        // (a list define: the mod's words, then the game's that the mod's list lacks and the world has an entry for; other lists stay)
        {
            const listGame = 'NGovernment = {\n\tGOVERNMENT_TYPES = {\n\t\t"feudal_government"\n\t\t"gone_government"\n\t\t"ecclesiastical_government"\n\t}\n\tOTHER = { "a" "b" }\n}\n';
            const listMod = 'NGovernment = {\n\tGOVERNMENT_TYPES = {\n\t\t"feudal_government"\n\t\t"om_government" # own\n\t}\n\tOTHER = { "a" }\n}\n';
            const listed: string[] = [];
            const lists = { prefix: new Map([['government_types', 'government']]), absent: new Set(['government:gone_government']), listed };
            const merged = missingDefines(listGame, listMod, undefined, undefined, undefined, lists);
            check(merged.size === 1 && merged.get('NGovernment')?.join() === 'GOVERNMENT_TYPES = {\n\t"feudal_government"\n\t"om_government"\n\t"ecclesiastical_government"\n}' && listed.join() === 'NGovernment.GOVERNMENT_TYPES: ecclesiastical_government', `defines: a list gets the game's words the world has an entry for (not the one it lacks), the mod's own words stay, an unlisted list is not touched: ${JSON.stringify([...merged])}`);
            check(missingDefines(listGame, listMod).size === 0 && missingDefines(listGame, listMod, undefined, undefined, undefined, { ...lists, absent: new Set(['government:gone_government', 'government:ecclesiastical_government']) }).size === 0 && missingDefines(listGame, listMod, undefined, undefined, new Set(['ngovernment|government_types']), lists).size === 0, 'defines: no list rule, no word with an entry, or a list another file sets: nothing written');
        }
        // (the add rules: the game's statements that name what the world lacks are not taken over)
        const pilgrim = 'header_background = { #Islam\n\ttrigger = { religion = religion:islam_religion }\n\treference = "x"\n}\nheader_background = { #Pagan\n\ttrigger = { faith.religion = { is_in_family = rf_pagan } has_graphical_norse_culture_group_trigger = yes }\n\treference = "y"\n}\nheader_background = "gfx/fallback.dds"';
        check(namedRefs(pilgrim).join() === 'religion:islam_religion,family:rf_pagan,trigger:has_graphical_norse_culture_group_trigger', `references a statement makes: ${namedRefs(pilgrim).join()}`);
        const addRule = MIGRATIONS[0].adds![0];
        const body = { n: 0 };
        const gameStatements = (_name: string): string[] => withoutAbsent([pilgrim.slice(0, pilgrim.indexOf('header_background = { #Pagan') - 1), pilgrim.slice(pilgrim.indexOf('header_background = { #Pagan'), pilgrim.lastIndexOf('\n')), 'header_background = "gfx/fallback.dds"'], new Set(['religion:islam_religion']));
        const defText = 'activity_x = {\n\tconditions = { always = yes }\n}\n';
        const added = applyStatementEdits(defText, addKeyEdits(defText, addRule, (name) => (name === 'activity_x' ? gameStatements(name) : undefined)));
        body.n = (added.match(/header_background/g) ?? []).length;
        check(body.n === 2 && !added.includes('islam_religion') && added.includes('#Pagan') && added.includes('"gfx/fallback.dds"'), `an add rule leaves out the statements that name what the world lacks, the rest stands: ${added}`);
        const none = applyStatementEdits(defText, addKeyEdits(defText, addRule, (name) => (name === 'activity_x' ? withoutAbsent([pilgrim.slice(0, pilgrim.indexOf('header_background = { #Pagan') - 1)], new Set(['religion:islam_religion'])) : undefined)));
        check(none.includes('activity_feast.dds'), 'with nothing of the game’s left the next source applies');
        // (an OR keeps the alternatives the world has; the statement goes only when no alternative is left or the name is not one)
        const steppe = 'header_background = { #Steppe\n\ttrigger = {\n\t\tOR = {\n\t\t\treligion = religion:tengrism_religion\n\t\t\treligion = religion:magyar_religion\n\t\t\treligion = religion:kamuyism_religion # last\n\t\t}\n\t}\n\treference = "steppe"\n}';
        const asia = 'header_background = {\n\ttrigger = {\n\t\tOR = {\n\t\t\tfaith.religion = { is_in_family = rf_sinitic }\n\t\t\treligion = religion:shintoism_religion\n\t\t\tAND = {\n\t\t\t\tfaith.religion = { is_in_family = rf_eastern }\n\t\t\t\tculture = { has_graphical_east_asia_culture_group_trigger = yes }\n\t\t\t}\n\t\t}\n\t}\n\treference = "asia"\n}';
        const negated = 'header_background = {\n\ttrigger = { NOT = { religion = religion:magyar_religion } }\n\treference = "not"\n}';
        const outside = 'header_background = {\n\ttrigger = { religion = religion:magyar_religion faith.religion = { is_in_family = rf_pagan } }\n\treference = "and"\n}';
        const one = withoutAbsent([steppe], new Set(['religion:magyar_religion', 'religion:kamuyism_religion']));
        check(one.length === 1 && one[0] === 'header_background = { #Steppe\n\ttrigger = {\n\t\tOR = {\n\t\t\treligion = religion:tengrism_religion\n\t\t}\n\t}\n\treference = "steppe"\n}', `an OR keeps the alternatives the world has: ${JSON.stringify(one)}`);
        check(withoutAbsent([steppe], new Set(['religion:kamuyism_religion']))[0].includes('magyar_religion') && !withoutAbsent([steppe], new Set(['religion:kamuyism_religion']))[0].includes('kamuyism'), 'only the absent alternative is cut');
        check(withoutAbsent([steppe], new Set(['religion:tengrism_religion', 'religion:magyar_religion', 'religion:kamuyism_religion'])).length === 0, 'an OR with no alternative left goes whole');
        const east = withoutAbsent([asia], new Set(['religion:shintoism_religion', 'trigger:has_graphical_east_asia_culture_group_trigger']));
        check(east.length === 1 && east[0].includes('rf_sinitic') && !east[0].includes('shintoism') && !east[0].includes('rf_eastern') && east[0].includes('reference = "asia"'), `an AND alternative that names an absent trigger is cut with its block: ${JSON.stringify(east)}`);
        check(withoutAbsent([negated], new Set(['religion:magyar_religion'])).length === 0 && withoutAbsent([outside], new Set(['religion:magyar_religion'])).length === 0, 'a negated or required absent name drops the statement');
        check(withoutAbsent([steppe.replace(/\n/g, '\r\n')], new Set(['religion:magyar_religion']))[0] === steppe.replace(/\n/g, '\r\n').replace('\t\t\treligion = religion:magyar_religion\r\n', ''), 'CRLF lines are cut whole');
        check(scoped.includes('limit = { r = rite faith = { f = 2 } rite = { r = rite } scope:q = { k = 4 } scope:q.faith = { switch = { k = 5 } } }') && scoped.includes('can_pick = { f = 6 any_faith_rite = { r = rite } }'), `the scope of a statement: a definition’s root, scope blocks, an unknown scope and a block that makes it unknown match no scope rule:\n${scoped}`);
    }

    // (macro arguments: a scripted trigger that passes its parameter on as the target of num_sinful_traits has its call sites written
    // for the rite; one that uses the parameter otherwise as well, or a call that names no such parameter, stays)
    {
        const group = MIGRATIONS[0].statements!.find((g) => g.macroArgs)!;
        const defsText = 'scripted_trigger om_virtue_trigger = {\n\tnum_sinful_traits = { value <= 0 target = $FAITH$ }\n\tnum_virtuous_traits = { value >= 1 target = $FAITH$ }\n}\n'
            + 'scripted_trigger om_chain_trigger = {\n\tom_virtue_trigger = { FAITH = $F$ }\n}\n'
            + 'scripted_trigger om_mixed_trigger = {\n\tnum_sinful_traits = { value <= 0 target = $FAITH$ }\n\t$FAITH$ = { is_valid = yes }\n}\n'
            + 'scripted_trigger om_other_trigger = {\n\tfaith = { has_trait = $T$ }\n}\n';
        const defs = macroDefinitions(parse(defsText), false);
        const env: StatementEnv = { sets: {}, defined: () => false, roots: [], macroArgs: (t) => macroArgs(defs, t) };
        const callsText = 'a = {\n\tom_virtue_trigger = { FAITH = host.faith }\n\tom_virtue_trigger = {\n\t\tFAITH = faith:catholic # c\n\t}\n\tom_virtue_trigger = { FAITH = scope:x.rite }\n\tom_virtue_trigger = { FAITH = scope:odd }\n'
            + '\tom_chain_trigger = { F = root.capital_county.faith }\n\tom_mixed_trigger = { FAITH = host.faith }\n\tom_other_trigger = { T = faith }\n\tom_unknown_trigger = { FAITH = host.faith }\n\tFAITH = host.faith\n}\n';
        const res = statementEdits(callsText, 'common/scripted_triggers/x.txt', group, env);
        const out = applyStatementEdits(callsText, res.edits);
        check(out === callsText.replace('FAITH = host.faith }\n\tom_virtue_trigger = {', 'FAITH = host.rite }\n\tom_virtue_trigger = {').replace('faith:catholic # c', 'faith:catholic.main_rite # c').replace('F = root.capital_county.faith', 'F = root.capital_county.rite'), `macro arguments: the call sites of a parameter that is only a target are written for the rite, the others stay:\n${out}`);
        check(res.unmapped.length === 2 && res.unmapped.some((u) => u.includes('FAITH = scope:odd')) && res.unmapped.some((u) => u.includes('om_mixed_trigger') && u.includes('otherwise')), `macro arguments: a value that is no faith and no rite, and a macro that uses the parameter otherwise, are told: ${res.unmapped.join(' | ')}`);
        check(!env.macroArgs!(group.macroArgs!).mentions('a = { om_unknown_trigger = { FAITH = x } }') && env.macroArgs!(group.macroArgs!).mentions('a = { om_chain_trigger = { F = x } }') && statementEdits('a = { om_unknown_trigger = { FAITH = host.faith } }', 'common/x.txt', group, env).edits.length === 0, 'macro arguments: a file that calls none of the macros is not looked at');
    }

    // (the rules that add or gather: statements added to the definition once, a block's add = … statements collected into the
    // sets block it has already, mapped values (a list's bare words too), a key by pattern)
    {
        const env: StatementEnv = { sets: {}, maps: { renamed: () => new Map([['x_old', 'x']]) }, defined: () => false, roots: [] };
        const run = (text: string, rules: NonNullable<Parameters<typeof statementEdits>[2]['rules']>): string => applyStatementEdits(text, statementEdits(text, 'common/y/a.txt', { files: [], label: '', rules }, env).edits);
        const added = run('a = {\r\n\tg = {\r\n\t\told_a = yes\r\n\t\told_b = yes\r\n\t}\r\n\tother = 1\r\n}\r\n', [
            { key: 'old_a', drop: true, alsoAdd: [{ key: 'new_key', value: 'v' }, { key: 'other', value: '1' }] },
            { key: 'old_b', drop: true, alsoAdd: [{ key: 'new_key', value: 'v' }] }
        ]);
        check(added === 'a = {\r\n\tnew_key = v\r\n\tg = {\r\n\t}\r\n\tother = 1\r\n}\r\n', `a statement added to the definition once (CRLF kept), one it has stays: ${JSON.stringify(added)}`);
        const commented = run('a = { # why\n\tg = { old = yes }\n}\n', [{ key: 'old', drop: true, alsoAdd: [{ key: 'n', value: 'v' }] }]);
        check(commented === 'a = { # why\n\tn = v\n\tg = {  }\n}\n', `the added statement goes after the comment of the brace’s line: ${JSON.stringify(commented)}`);
        const sets = run('a = {\n\telectors = {\n\t\tcharacter_sets = {\n\t\t\tk1 = { type = holder }\n\t\t}\n\t\tadd = title_claimants\n\t\tadd = { type = holder limit = { x = 1 } }\n\t}\n\tother = { add = 5 }\n}\n', [{ key: 'electors', collect: { child: 'add', into: 'character_sets', type: 'type' } }]);
        check(sets === 'a = {\n\telectors = {\n\t\tcharacter_sets = {\n\t\t\tk1 = { type = holder }\n\t\t\ta_electors_title_claimants = {\n\t\t\t\ttype = title_claimants\n\t\t\t}\n\t\t\ta_electors_holder = { type = holder limit = { x = 1 } }\n\t\t}\n\t}\n\tother = { add = 5 }\n}\n', `the add statements join the sets block the election has: ${JSON.stringify(sets)}`);
        const note = run('a = {\n\telectors = {\n\t\t# the holder\n\t\tadd = holder # first\n\t\t# vassals\n\t\tadd = { type = holder_direct_vassals } # second\n\t\tadd = title_claimants\n\t}\n}\n', [{ key: 'electors', collect: { child: 'add', into: 'character_sets', type: 'type' } }]);
        check(note === 'a = {\n\telectors = {\n\t\t# the holder\n\t\tcharacter_sets = {\n\t\t\ta_electors_holder = {\n\t\t\t\ttype = holder\n\t\t\t} # first\n\t\t\t# vassals\n\t\t\ta_electors_holder_direct_vassals = { type = holder_direct_vassals } # second\n\t\t\ta_electors_title_claimants = {\n\t\t\t\ttype = title_claimants\n\t\t\t}\n\t\t}\n\t}\n}\n', `the comments of the collected add statements go with them: ${JSON.stringify(note)}`);
        const noteIn = run('a = {\n\telectors = {\n\t\tcharacter_sets = {\n\t\t\tk1 = { type = holder }\n\t\t}\n\t\t# vassals\n\t\tadd = holder # first\n\t}\n}\n', [{ key: 'electors', collect: { child: 'add', into: 'character_sets', type: 'type' } }]);
        check(noteIn === 'a = {\n\telectors = {\n\t\tcharacter_sets = {\n\t\t\tk1 = { type = holder }\n\t\t\t# vassals\n\t\t\ta_electors_holder = {\n\t\t\t\ttype = holder\n\t\t\t} # first\n\t\t}\n\t}\n}\n', `... and into the sets block the election has: ${JSON.stringify(noteIn)}`);
        const clashText = 'a = {\n\tg = {\n\t\told = yes\n\t}\n\tm = feudal\n}\n';
        const clash = statementEdits(clashText, 'common/y/a.txt', { files: [], label: '', rules: [{ key: 'old', drop: true, alsoAdd: [{ key: 'm', value: 'x' }] }] }, env);
        check(clash.edits.length === 0 && clash.unmapped.length === 1 && clash.unmapped[0].includes('old = yes') && clash.unmapped[0].includes('m = feudal'), `a dropped statement whose added key the definition has with another value stays, and is told: ${clash.unmapped.join(' | ')}`);
        check(run('a = { electors = { add = 3 add = holder } }\n',[{ key: 'electors', collect: { child: 'add', into: 'character_sets', type: 'type' } }]) === 'a = { electors = { add = 3 add = holder } }\n', 'a block with an add that names no type is left alone');
        const mapped = run('a = {\n\tg = { 1 = x_old 2 = { x_old y_old } 3 = x }\n\t"x_old" = 1\n}\n', [{ keyPattern: '\\d+', valueMap: 'renamed' }, { bare: true, valueMap: 'renamed' }]);
        check(mapped === 'a = {\n\tg = { 1 = x 2 = { x y_old } 3 = x }\n\t"x_old" = 1\n}\n', `a value by the map (a key of numbers; bare words), others stay: ${JSON.stringify(mapped)}`);
    }

    // (the gain rules by themselves: keys and list words of the game's definition of the same name, last in the mod's; what the
    // mod's older files know stays out; CRLF, one-liners and empty lists; a second application changes nothing)
    {
        const rule: GainRule = { files: ['common/x/*.txt'], label: '', keys: ['divergence', 'personal'], lists: ['parameters', 'special_parameters'], dropAbsent: true };
        const game: GameGains = new Map();
        gameGainsOf('a = {\n\tdivergence = 30\n\tpersonal = {\n\t\trf = rf_none\n\t\tfaith = faith:gone\n\t}\n\tparameters = {\n\t\tp_new\n\t\tp_old\n\t\tp_known\n\t\tkv = yes\n\t}\n\tspecial_parameters = {\n\t\tnum = 3\n\t\thostility_levels = {\n\t\t\tsame_religion = astray\n\t\t}\n\t}\n}\nb = {\n\tdivergence = 5\n}\nonly_here = { other = 1 }\n', rule, game);
        check(game.size === 2 && game.get('a')!.keys.get('divergence')!.join() === 'divergence = 30' && [...game.get('a')!.lists.get('parameters')!.keys()].join() === 'p_new,p_old,p_known,kv' && game.get('a')!.lists.get('special_parameters')!.get('hostility_levels') === 'hostility_levels = {\n\t\t\tsame_religion = astray\n\t\t}', 'gain rules: the game’s keys and list words per name, as written');
        const known = gainScope(rule, ['x = { parameters = { p_known } special_parameters = { num = 1 } }']);
        check(known.keys.join() === 'divergence,personal' && [...known.known].join() === 'p_known,num', 'gain rules: what the older files know');
        const aware = gainScope(rule, ['x = { divergence = 0 }']);
        check(aware.keys.length === 0 && !aware.lists && known.lists, 'gain rules: a key of the rule in the older files anywhere means the mod is written for the new version: no key, no list word (what it left out it left out on purpose)');
        // (a file the app wrote, a fix's tenet or law group, which carries the game's fields, says nothing of what the mod knows)
        const appFile = '﻿# tenets of the mod (moved from doctrines for 1.20 by CrusaderPope)\r\n\r\nx = {\r\n\tdivergence = 0\r\n\tparameters = {\r\n\t\tp_known\r\n\t}\r\n}\r\n';
        const written = gainScope(rule, [appFile]);
        check(written.keys.join() === 'divergence,personal' && written.lists && written.known.size === 0, 'gain rules: a file the app wrote (CrusaderPope in its header comment) is no sign of knowing the fields, nor are its parameters known');
        const mixed = gainScope(rule, [appFile, 'y = { parameters = { p_mine } }']);
        check(mixed.keys.length === 2 && [...mixed.known].join() === 'p_mine', 'gain rules: the mod’s other files still count');
        check(gainScope(rule, ['# mine\n\nx = { divergence = 0 }\n# written by CrusaderPope\n']).keys.length === 0 && gainScope(rule, ['x = { divergence = 0 } # by CrusaderPope\n']).keys.length === 0, 'gain rules: only the leading comment lines of a file say who wrote it');
        const awareEdits = gainEdits('a = { }\n', rule, aware, game);
        check(awareEdits.edits.length === 0, 'gain rules: and nothing is added to its definitions');
        const scope = gainScope(rule, ['a = { parameters = { p_old } }']);
        const absent = new Set(['faith:gone']);
        const run = (text: string, abs?: Set<string>): { text: string; entries: string[]; } => { const g = gainEdits(text, rule, scope, game, abs); return { text: applyStatementEdits(text, g.edits), entries: g.entries }; };
        const one = run('a = {\n\tdivergence = 1\n\tparameters = {\n\t\tp_old\n\t}\n}\n', absent);
        check(one.text === 'a = {\n\tdivergence = 1\n\tparameters = {\n\t\tp_old\n\t\tp_new\n\t\tp_known\n\t\tkv = yes\n\t}\n\tspecial_parameters = {\n\t\tnum = 3\n\t\thostility_levels = {\n\t\t\tsame_religion = astray\n\t\t}\n\t}\n}\n' && one.entries.join() === 'a', `gain rules: the mod's own value stays, the words and the missing list come last, the statement naming an absent faith goes: ${JSON.stringify(one.text)}`);
        const crlf = run('a = {\r\n\tparameters = { p_old }\r\n}\r\nb = {\r\n\tcolor = red\r\n}\r\nc = { }\r\n', absent);
        check(crlf.text === 'a = {\r\n\tparameters = { p_old\r\n\t\tp_new\r\n\t\tp_known\r\n\t\tkv = yes\r\n\t}\r\n\tdivergence = 30\r\n\tspecial_parameters = {\r\n\t\tnum = 3\r\n\t\thostility_levels = {\r\n\t\t\tsame_religion = astray\r\n\t\t}\r\n\t}\r\n}\r\nb = {\r\n\tcolor = red\r\n\tdivergence = 5\r\n}\r\nc = { }\r\n' && crlf.entries.join() === 'a,b', `gain rules: CRLF kept, a one-line list opened, a name the game lacks left: ${JSON.stringify(crlf.text)}`);
        const twice = run(run('a = { }\n', absent).text, absent);
        check(twice.entries.length === 0 && run('a = { }\n', absent).text.includes('divergence = 30'), 'gain rules: a second application changes nothing');
        const keep = run('a = { parameters = { } special_parameters = { num = 7 } }\n');
        check(keep.text.includes('num = 7') && !keep.text.includes('num = 3') && keep.text.includes('hostility_levels'), `gain rules: a word the definition has stays as its own; an absent faith is kept when no world is given: ${JSON.stringify(keep.text)}`);
    }

    // (what counts as a reference to a library entry: the key it stands under, a chain, comments, definitions, localization brackets)
    {
        const theme: LibraryFolder = { folder: 'common/event_themes', label: '', keys: ['theme', 'override_theme'] };
        const trigger: LibraryFolder = { folder: 'common/scripted_triggers', label: '' };
        const value: LibraryFolder = { folder: 'common/script_values', label: '', use: 'both' };
        const custom: LibraryFolder = { folder: 'common/customizable_localization', label: '', use: 'both', keys: ['parent'] };
        const domicile: LibraryFolder = { folder: 'common/domiciles/types', label: '', keys: ['allowed_domicile_types'] };
        const names = new Map<string, LibraryFolder[]>([['christian', [theme]], ['my_trigger', [trigger]], ['my_value', [value]], ['Name', [custom]], ['ecclesiastical_domicile', [domicile]]]);
        const hits = (text: string, mode: 'script' | 'loc' | 'macro' = 'script'): string => {
            const out: string[] = [];
            scan(text, mode, names, (h) => out.push(h.name));
            return out.join(',');
        };
        check(hits('e.1 = {\n\ttype = activity_event\n\ttitle = e.1.t\n\ttheme = christian\n}\n') === 'christian', 'a theme: the key `theme` after a block of other statements (the event’s id is not the key)');
        check(hits('e.1 = {\n\tsituation:christian = { }\n\tfaith = christian\n\tx = { christian }\n\ttheme = {\n\t\ta = 1\n\t\tchristian\n\t}\n}\n') === '', 'not as a link, another key’s value, a list of another key, or a word after a statement in a theme block');
        check(hits('e = {\n\toverride_theme = christian # theme = christian\n\t# theme = christian\n}\n') === 'christian', 'a comment names nothing');
        check(hits('my_trigger = {\n\talways = no\n}\nx = {\n\tmy_trigger = yes\n\tvalue = $my_trigger$\n\ty = @my_trigger\n}\n') === 'my_trigger', 'a definition at the start of a line, a macro parameter and a constant name nothing; a call does');
        check(hits('x = {\n\tadd = scope:a.my_value\n\tadd = value:my_value\n\tadd = faith:my_value\n\tadd = scope:a.my_trigger\n}\n') === 'my_value,my_value', 'a script value after a scope chain or `value:`; a trigger after one is something else');
        check(hits('x = {\n\tallowed_domicile_types = {\n\t\tkeep\n\t\tecclesiastical_domicile\n\t}\n\tdomicile = ecclesiastical_domicile\n}\n') === 'ecclesiastical_domicile', 'a word in the list of a listed key; the same word after another key is not');
        check(hits('text = "[GetPlayer.Custom(\'Name\')] [ROOT.Char.Name] Name"\n# [Custom(\'Name\')]\n', 'loc') === 'Name', 'localization: a word inside brackets, not a function of a chain, not outside them, not in a comment line');
        // (a flag word: `key = word`, `key = { word }`, and the block `has_building_with_flag = { flag = word count = 1 }`; `flag` alone names nothing)
        const flag: LibraryFolder = { folder: 'flags|common/buildings', label: '', keys: ['has_building_with_flag', 'has_construction_with_flag'], flagIn: ['has_building_with_flag'] };
        const fnames = new Map<string, LibraryFolder[]>([['fl', [flag]]]);
        const fhits = (text: string): number => { let n = 0; scan(text, 'script', fnames, () => n++); return n; };
        check(fhits('a = { has_building_with_flag = fl }') === 1 && fhits('a = { has_building_with_flag = { flag = fl } }') === 1 && fhits('a = {\n\thas_building_with_flag = {\n\t\tflag = fl\n\t\tcount = 1\n\t}\n}\n') === 1 && fhits('a = { has_construction_with_flag = fl }') === 1, 'a flag word tested as a value or in the block form with flag =');
        check(fhits('a = { has_building_with_flag = { count = 1 } flag = fl }') === 0 && fhits('a = { has_construction_with_flag = { flag = fl } }') === 0 && fhits('a = { other = { flag = fl } }') === 0 && fhits('a = { has_building_with_flag = { x = { y = 1 } flag = fl } }') === 1, 'flag = word names the word only inside a block of a listed key');
        check(hits('a = { parent = Name }\n') === 'Name' && hits('replace_with = "Activity.Custom(\'Name\')" x = Name', 'macro') === 'Name', 'a customizable localization by its `parent` key in script; a quoted name in a data binding macro');
    }

    // (the settings a religion keeps at its top move into religion_details, comments with them; the tenet banners)
    {
        const keys = ['family', 'graphical_faith', 'piety_icon_group'];
        const wrap = (text: string): string => applyStatementEdits(text, parse(text).filter((n) => n.k && Array.isArray(n.v)).flatMap((n) => wrapDefinition(text, n, keys, 'religion_details')));
        const w1 = wrap('a = {\n\t# the family\n\tfamily = rf_x # why\n\tdoctrine = d\n\n\t# look\n\tgraphical_faith = g\n\tpiety_icon_group = "c"\n\ttraits = { x }\n}\n');
        check(w1 === 'a = {\n\t# the family\n\treligion_details = {\n\t\tfamily = rf_x # why\n\t\t# look\n\t\tgraphical_faith = g\n\t\tpiety_icon_group = "c"\n\t}\n\tdoctrine = d\n\n\ttraits = { x }\n}\n', `the top settings in one religion_details block at the first one's place, their comments with them: ${JSON.stringify(w1)}`);
        const w2 = wrap('a = {\r\n\tgraphical_faith = g\r\n\treligion_details = {\r\n\t\tfamily = rf_x\r\n\t}\r\n\tfamily = rf_old\r\n}\r\n\r\nb = { family = f other = 1 }\r\n');
        check(w2 === 'a = {\r\n\treligion_details = {\r\n\t\tfamily = rf_x\r\n\t\tgraphical_faith = g\r\n\t}\r\n}\r\n\r\nb = { religion_details = {\r\n\tfamily = f\r\n} other = 1 }\r\n', `into the block there is (its own key wins; CRLF kept); a one-line definition: ${JSON.stringify(w2)}`);
        check(wrap('a = {\n\treligion_details = {\n\t\tfamily = rf_x\n\t}\n\tother = { family = inner }\n}\n') === 'a = {\n\treligion_details = {\n\t\tfamily = rf_x\n\t}\n\tother = { family = inner }\n}\n', 'a religion in the 1.20 form is left alone (a key deeper down too)');
        const rule: BannerRule = { files: [], old: 'doctrine_background_icon', keys: ['tenet_background_icon', 'tenet_heretical_background_icon'], always: true, from: 'f', to: 't', valuesIn: 'v', label: '' };
        const env: BannerEnv = { values: { tenet_background_icon: 'game_core', tenet_heretical_background_icon: 'game_heretical' }, carry: (v) => (bannerName(v) === 'mine' ? 'mine' : undefined) };
        const run = (text: string, r: BannerRule = rule): string => applyStatementEdits(text, bannerEdits(text, r, env));
        check(run('a = {\n\tx = 1\n\tdoctrine_background_icon = "mine.dds" # c\n\ty = 2\n}\n') === 'a = {\n\tx = 1\n\ttenet_background_icon = mine # c\n\ttenet_heretical_background_icon = game_heretical\n\ty = 2\n}\n', 'a family: the old key becomes the keys, the carried banner for the first (its comment with it), the game’s for the rest');
        check(run('a = { doctrine_background_icon = other.dds # c\n}\n') === 'a = { tenet_background_icon = game_core # c\n\ttenet_heretical_background_icon = game_heretical\n}\n', 'a one-line family: the other keys on lines of their own, the comment on the first');
        check(wrap('a = {\n\treligion_details = { piety_icon_group = p }\n\tfamily = rf_a\n}\n') === 'a = {\n\treligion_details = { piety_icon_group = p\n\t\tfamily = rf_a\n\t}\n}\n' && wrap('a = {\n\treligion_details = { }\n\tfamily = rf_a # why\n}\n') === 'a = {\n\treligion_details = {\n\t\tfamily = rf_a # why\n\t}\n}\n', 'into a block whose brace shares its line: the statements start on a line of their own');
        check(run('a = {\n\tdoctrine_background_icon = other.dds\n}\nb = {\n\tx = 1\n}\nc = {\n\ttenet_background_icon = k\n\ttenet_heretical_background_icon = h\n}\n') === 'a = {\n\ttenet_background_icon = game_core\n\ttenet_heretical_background_icon = game_heretical\n}\nb = {\n\ttenet_background_icon = game_core\n\ttenet_heretical_background_icon = game_heretical\n\tx = 1\n}\nc = {\n\ttenet_background_icon = k\n\ttenet_heretical_background_icon = h\n}\n', 'a family with a banner not carried or none gets the game’s; one with the keys is left alone');
        const own: BannerRule = { ...rule, always: false, into: 'religion_details' };
        check(run('a = {\n\tdoctrine_background_icon = mine.dds\n\tx = 1\n}\n', own) === 'a = {\n\treligion_details = {\n\t\ttenet_background_icon = mine\n\t\ttenet_heretical_background_icon = game_heretical\n\t}\n\tx = 1\n}\n', 'a religion with its own banner: all the keys in a block made for them');
        check(run('a = {\n\tdoctrine_background_icon = mine.dds\n\treligion_details = {\n\t\tfamily = f\n\t\ttenet_heretical_background_icon = h\n\t}\n}\n', own) === 'a = {\n\treligion_details = {\n\t\tfamily = f\n\t\ttenet_heretical_background_icon = h\n\t\ttenet_background_icon = mine\n\t}\n}\n', 'in the block it has (a key it has stays)');
        check(run('a = {\n\tdoctrine_background_icon = other.dds\n\tx = 1\n}\nb = { x = 1 }\n', own) === 'a = {\n\tx = 1\n}\nb = { x = 1 }\n', 'a religion whose banner is not carried: the key goes, nothing is set (its family’s applies); a religion without the key is left alone');
        check(gameBannerValues(['a = { k = x z = 1 }\nb = { k = y }\nc = { k = y }', 'd = { k = x }\ne = { k = x }'], ['k', 'z']).k === 'x', 'the game’s value: the most common one');
    }

    // (the 1.20 step's own groups over a definition: a doctrine's piety_cost and a tenet's name/desc run with a rite, can_pick with a faith;
    // a wrapper that keeps the scope (`text = { trigger = … }`), one that makes it unknown; a macro and a mod's own name are no unmapped statements)
    {
        const step = MIGRATIONS.find((m) => m.statements?.length)!;
        const env: StatementEnv = { sets: { tenets: new Set(['tenet_b']) }, defined: (folder, key) => folder === 'common/scripted_triggers' && key === 'sexual_activity_with_partner_is_criminal_in_faith_trigger', roots: step.roots ?? [] };
        const all = (rel: string, text: string): { text: string; unmapped: string[]; } =>
        {
            let out = text;
            const unmapped: string[] = [];

            for (const g of step.statements!)
            {
                const r = statementEdits(out, rel, g, env);
                unmapped.push(...r.unmapped);
                out = applyStatementEdits(out, r.edits);
            }

            return { text: out, unmapped };
        };
        const doc = all('common/religion/doctrine_types/d.txt', 'd = {\n\tpiety_cost = { if = { limit = { has_doctrine = doctrine_a has_doctrine = tenet_b religion_tag = r has_doctrine_parameter = p } } }\n\tcan_pick = { has_doctrine = doctrine_a has_doctrine = tenet_b religion_tag = r }\n}\n').text;
        check(doc === 'd = {\n\tpiety_cost = { if = { limit = { rite_has_doctrine = doctrine_a rite_has_tenet = tenet_b rite_religion_tag = r rite_has_parameter = p } } }\n\tcan_pick = { has_doctrine = doctrine_a has_tenet = tenet_b religion_tag = r }\n}\n', `a doctrine's piety_cost runs with a rite, its can_pick with a faith:\n${doc}`);
        const wrapped = all('common/religion/tenet_types/t.txt', 't = {\n\tdesc = { text = { trigger = { has_doctrine = doctrine_a has_doctrine = tenet_b } localization_key = x } }\n\tname = { first_valid = { triggered_desc = { trigger = { scope:q = { has_doctrine = doctrine_a } scope:q.faith = { has_doctrine = doctrine_a } } desc = y } } }\n}\n').text;
        check(wrapped.includes('trigger = { rite_has_doctrine = doctrine_a rite_has_tenet = tenet_b }') && wrapped.includes('scope:q = { has_doctrine = doctrine_a } scope:q.faith = { has_doctrine = doctrine_a }'), `a text block keeps the rite scope; a saved scope is unknown, a link to a faith is a faith (the doctrine stays):\n${wrapped}`);
        const unm = all('events/e.txt', 'e = {\n\ttrigger = {\n\t\tnum_virtuous_traits = { value > 0 target = $FAITH$ }\n\t\tnum_sinful_traits = { value > 0 target = scope:x }\n\t\tsexual_activity_with_partner_is_criminal_in_faith_trigger = { PARTNER = scope:p FAITH = scope:f }\n\t}\n}\n');
        check(unm.unmapped.length === 1 && unm.unmapped[0].includes('target = scope:x') && unm.text.includes('target = $FAITH$'), `a macro parameter and a scripted trigger the mod defines itself are not noted, scope:x is: ${unm.unmapped.join(' | ')}`);
    }

    // (the shader merge on small files: the game's text, then what the mod's copy has that it lacks: an effect of the mod's own with the
    // stage blocks, functions, defines and constant buffer members it needs, and nothing it does not)
    {
        const GAME: Record<string, string> = {
            'game.shader': `Includes = {\n\t"inc.fxh"\n\t"shared.fxh"\n}\n\nVertexStruct VS_OUTPUT\n{\n\tfloat4 Pos : PDX_POSITION;\n\tfloat2 UV : TEXCOORD0;\n\tfloat3 Dir : TEXCOORD1;\n};\n\nConstantBuffer( 0 )\n{\n\tfloat4 Tint;\n};\n\nVertexShader =\n{\n\tMainCode VS_a\n\t{\n\t\tInput = "VS_INPUT"\n\t\tOutput = "VS_OUTPUT"\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t\tVS_OUTPUT Out;\n\t\t\t\treturn Out;\n\t\t\t}\n\t\t]]\n\t}\n}\n\nPixelShader =\n{\n\tTextureSampler Tex\n\t{\n\t\tRef = PdxTexture0\n\t\tIndex = 0\n\t}\n\n\tCode\n\t[[\n\t\tfloat Foo( float x )\n\t\t{\n\t\t\treturn x * 2.0f;\n\t\t}\n\t\tfloat PsOnly( float x )\n\t\t{\n\t\t\treturn x;\n\t\t}\n\t]]\n\n\tMainCode PS_a\n\t{\n\t\tInput = "VS_OUTPUT"\n\t\tOutput = "PDX_COLOR"\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t\treturn float4( Foo( 1.0f ), PsOnly( 0.5f ), 0.0f, 1.0f );\n\t\t\t}\n\t\t]]\n\t}\n}\n\nEffect a\n{\n\tVertexShader = "VS_a"\n\tPixelShader = "PS_a"\n}\n`,
            'inc.fxh': 'Code\n[[\n\tfloat GameHelper( float x )\n\t{\n\t\treturn x + 1.0f;\n\t}\n\t#ifdef GAME_FLAG\n\tfloat FlagHelper( float x )\n\t{\n\t\treturn x * 5.0f;\n\t}\n\t#endif\n]]\n',
            'shared.fxh': 'Code\r\n[[\r\n\tfloat SharedGame( float x )\r\n\t{\r\n\t\treturn x;\r\n\t}\r\n]]\r\n',
            'same.fxh': 'Code\n[[\n\tfloat SameHelper( float x )\n\t{\n\t\treturn x;\n\t}\n]]\n',
            'extra.fxh': 'Code\n[[\n\tfloat ExtraFn( float x )\n\t{\n\t\treturn x - 1.0f;\n\t}\n]]\n'
        };
        const MOD: Record<string, string> = {
            // (Foo changed, the game's stays; a field and a constant buffer member of its own; its own functions, a define, an effect that
            // needs the buffer member, a vertex shader that needs a function the game has in its pixel shader only)
            'game.shader': GAME['game.shader']
                .replace('"shared.fxh"\n', '"shared.fxh"\n\t"modinc.fxh"\n\t"extra.fxh"\n')
                .replace('float3 Dir : TEXCOORD1;', 'float3 Dir : TEXCOORD1;\n\tfloat ModField : TEXCOORD1;')
                .replace('float4 Tint;', 'float4 Tint;\n\tfloat4 Tint2;')
                .replace('return x * 2.0f;', 'return x * 3.0f;')
                .replace('\tCode\n\t[[\n\t\tfloat Foo', '\tCode\n\t[[\n\t\tfloat Bar( float x )\n\t\t{\n\t\t\treturn Foo( x ) + MOD_K;\n\t\t}\n\t\tfloat Unused( float x )\n\t\t{\n\t\t\treturn x;\n\t\t}\n\t\tfloat Foo')
                + '\nPixelShader =\n{\n\tMainCode PS_mod\n\t{\n\t\tInput = "VS_OUTPUT"\n\t\tOutput = "PDX_COLOR"\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t\treturn float4( Bar( 1.0f ), ModHelper( 2.0f ), GameHelper( 1.0f ), SharedMod( 1.0f ) );\n\t\t\t}\n\t\t]]\n\t}\n\tMainCode PS_extra\n\t{\n\t\tInput = "VS_OUTPUT"\n\t\tOutput = "PDX_COLOR"\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t\treturn float4( ExtraFn( 1.0f ), 0.0f, 0.0f, 1.0f );\n\t\t\t}\n\t\t]]\n\t}\n\tMainCode PS_clash\n\t{\n\t\tInput = "VS_OUTPUT"\n\t\tOutput = "PDX_COLOR"\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t\treturn float4( GAME_FLAG, 0.0f, 0.0f, 1.0f );\n\t\t\t}\n\t\t]]\n\t}\n\tMainCode PS_bad\n\t{\n\t\tInput = "VS_OUTPUT"\n\t\tOutput = "PDX_COLOR"\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t\treturn Tint2;\n\t\t\t}\n\t\t]]\n\t}\n}\n\nVertexShader =\n{\n\tCode\n\t[[\n\t\tfloat PsOnly( float x )\n\t\t{\n\t\t\treturn x;\n\t\t}\n\t]]\n\tMainCode VS_mod\n\t{\n\t\tInput = "VS_INPUT"\n\t\tOutput = "VS_OUTPUT"\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t\tVS_OUTPUT Out;\n\t\t\t\tOut.UV.x = PsOnly( 1.0f );\n\t\t\t\tOut.ModField = 1.0f;\n\t\t\t\treturn Out;\n\t\t\t}\n\t\t]]\n\t}\n}\n\nEffect mod_effect\n{\n\tVertexShader = "VS_a"\n\tPixelShader = "PS_mod"\n}\n\nEffect mod_bad\n{\n\tVertexShader = "VS_a"\n\tPixelShader = "PS_bad"\n}\n\nEffect mod_vs\n{\n\tVertexShader = "VS_mod"\n\tPixelShader = "PS_a"\n}\n\nEffect mod_extra\n{\n\tVertexShader = "VS_a"\n\tPixelShader = "PS_extra"\n}\n\nEffect mod_clash\n{\n\tVertexShader = "VS_a"\n\tPixelShader = "PS_clash"\n}\n',
            'modinc.fxh': 'Code\n[[\n\t#define MOD_K 2.0f\n\t#define GAME_FLAG 1.0f\n\tfloat ModHelper( float x )\n\t{\n\t\treturn x * MOD_K;\n\t}\n\tfloat ModUnused( float x )\n\t{\n\t\treturn x;\n\t}\n]]\n',
            // (a restored include with a function of the mod's own that an effect in the including file needs; one with nothing new)
            'shared.fxh': GAME['shared.fxh'].replace(/\r\n/g, '\n') + 'Code\n[[\n\tfloat SharedMod( float x )\n\t{\n\t\treturn x * 4.0f;\n\t}\n]]\n',
            'same.fxh': GAME['same.fxh']
        };
        const readers = { game: (k: string) => GAME[k], mod: (k: string) => MOD[k] };
        const merge = mergeShaders(readers, ['game.shader', 'shared.fxh', 'same.fxh']).files;
        const g = merge.get('game.shader')!;
        const count = (t: string, x: string): number => t.split(x).length - 1;
        check(g.text.startsWith(GAME['game.shader'].slice(0, 24)) && g.game === GAME['game.shader'] && g.text.length > GAME['game.shader'].length, 'a merged file is the game’s text with the mod’s additions behind it');
        check(g.notes.effects.join(' ') === 'mod_effect mod_vs mod_extra' && g.text.includes('Effect mod_effect') && g.text.includes('Effect mod_vs') && !g.text.includes('Effect mod_bad'), `the mod’s effects are added: ${g.notes.effects.join(', ')}`);
        check(g.text.includes('float Bar') && g.text.includes('MainCode PS_mod') && g.text.includes('#define MOD_K 2.0f') && g.text.includes('float ModHelper') && g.text.includes('MainCode VS_mod'), 'with the functions, the define and the stage code they use');
        check(!g.text.includes('Unused'), 'a function no effect reaches is not carried');
        check(count(g.text, 'float Foo(') === 1 && g.text.includes('return x * 2.0f;') && !g.text.includes('x * 3.0f') && g.notes.lost.includes('Foo'), `a definition both have stays the game’s, once (lost: ${g.notes.lost.join(', ')})`);
        check(count(g.text, 'float GameHelper') === 0 && count(g.text, 'float SharedGame') === 0, 'the game’s own functions in its includes are not copied');
        // (extra.fxh is a game file the mod's copy includes and the game's does not: its include is added, its function not copied)
        check(g.notes.includes.join() === 'extra.fxh' && /"shared\.fxh"\n\t# MOD-MERGE: [^\n]*\n\t"extra\.fxh"\n\}/.test(g.text) && count(g.text, 'float ExtraFn') === 0, `a game file the mod's copy includes and the game's does not: its include is added, not its code (${g.notes.includes.join(', ')})`);
        check(/float ModField : TEXCOORD2;/.test(g.text) && g.notes.fields.join() === 'VS_OUTPUT.ModField', `the mod’s vertex struct field is appended, its semantic moved on: ${g.notes.fields.join(', ')}`);
        const bad = g.notes.dropped.find((x) => x.name === 'mod_bad');
        check(g.notes.dropped.length === 2 && bad?.reason.kind === 'field' && bad.reason.name === 'Tint2' && !g.text.includes('PS_bad'), `an effect that reads a buffer member the game’s lacks is left out, with its reason: ${JSON.stringify(g.notes.dropped)}`);
        // (GAME_FLAG: the game's include tests it with #ifdef; the mod's #define of it would switch that code on)
        const clash = g.notes.dropped.find((x) => x.name === 'mod_clash');
        check(clash?.reason.kind === 'clash' && clash.reason.name === 'GAME_FLAG' && !g.text.includes('#define GAME_FLAG') && !g.text.includes('PS_clash'), `an effect that needs a define of the mod's which the game's own code tests is left out: ${JSON.stringify(clash)}`);
        // (PsOnly is in the game's pixel shader only: the vertex shader's copy comes in the vertex shader block, and the pixel shader gets none)
        const vsBlock = /VertexShader =\s*\{[\s\S]*?\n\}\n/.exec(g.text.slice(g.text.indexOf('# MOD-MERGE: definitions')))?.[0] ?? '';
        check(vsBlock.includes('float PsOnly') && vsBlock.includes('MainCode VS_mod') && count(g.text, 'float PsOnly') === 2, 'a function the game has for the pixel stage only is carried for the vertex stage only');
        const sh = merge.get('shared.fxh')!;
        check(sh.text.startsWith(GAME['shared.fxh']) && sh.text.includes('float SharedMod') && sh.notes.carried.length === 1 && count(g.text, 'float SharedMod') === 0, 'a restored include carries the function an effect in the including file needs, and the including file does not');
        check(!/(?<!\r)\n/.test(sh.text), 'the merged include keeps the game’s line ends');
        check(merge.get('same.fxh')!.text === GAME['same.fxh'] && merge.get('same.fxh')!.notes.carried.length === 0, 'a mod copy with nothing new: the game’s file as it is');
        const again = mergeShaders(readers, ['game.shader', 'shared.fxh', 'same.fxh']).files;
        check([...merge].every(([k, v]) => again.get(k)!.text === v.text), 'the same input makes the same files');
    }

    // (the shader merge, edge by edge: a function with default values, the mod's own effect files, a sampler slot the game's has, the
    // branches of an #elif / #else, a definition the game has under an #ifdef, a constant buffer with another layout, a compute
    // shader, the lists in the notes, the steps' rules over one file)
    {
        const count = (t: string, x: string): number => t.split(x).length - 1;
        const vsMain = (name: string): string => `MainCode ${name}\n\t{\n\t\tInput = "VS_INPUT"\n\t\tOutput = "VS_OUT"\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t\tVS_OUT Out;\n\t\t\t\treturn Out;\n\t\t\t}\n\t\t]]\n\t}\n`;
        const psMain = (name: string, body: string): string => `\tMainCode ${name}\n\t{\n\t\tInput = "VS_OUT"\n\t\tOutput = "PDX_COLOR"\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t\t${body}\n\t\t\t}\n\t\t]]\n\t}\n`;
        const eff = (name: string, ps: string, vs = 'VS_a'): string => `Effect ${name}\n{\n\tVertexShader = "${vs}"\n\tPixelShader = "${ps}"\n}\n\n`;
        const vsA = `VertexShader =\n{\n\t${vsMain('VS_a')}}\n\n`;
        const pixel = (...parts: string[]): string => `PixelShader =\n{\n${parts.join('\n')}}\n\n`;
        const code = (text: string): string => `\tCode\n\t[[\n${text}\n\t]]\n`;
        const run = (game: Record<string, string>, mod: Record<string, string>, restore: string[], own: string[] = []): ReturnType<typeof mergeShaders> => mergeShaders({ game: (k) => game[k], mod: (k) => mod[k] }, restore, own);

        // 1. a function with default values for its last parameters: a function, not a variable; a call may leave them out
        const defaults = fxDefinitions('Code\n[[\n\tfloat ModFn( float x, float y = 1.0f )\n\t{\n\t\treturn x * y;\n\t}\n\tfloat2 ModVec( float2 v = float2( 1.0f, 2.0f ), float w = 0.5f )\n\t{\n\t\treturn v * w;\n\t}\n\tstatic const float K = 2.0f;\n]]\n').defs;
        check(defaults.get('fn:ModFn(float,float)@both')?.[0]?.kind === 'c-function' && defaults.get('fn:ModFn(float,float)@both')![0].minArgs === 1 && defaults.get('fn:ModVec(float2,float)@both')?.[0]?.minArgs === 0 && defaults.get('var:K@both')?.[0]?.kind === 'c-var', `a function with default values is a function (key by the parameters' types, the fewest arguments): ${[...defaults.keys()].join(', ')}`);
        const gameDef = code('\t\tfloat GameDef( float a, float b = 0.0f )\n\t\t{\n\t\t\treturn a + b;\n\t\t}\n\t\tfloat Amb( float a )\n\t\t{\n\t\t\treturn a;\n\t\t}\n\t\tfloat Amb2( float a, float b = 1.0f )\n\t\t{\n\t\t\treturn a + b;\n\t\t}');
        const gD = vsA + pixel(gameDef, psMain('PS_a', 'return float4( GameDef( 1.0f ), 0.0f, 0.0f, 1.0f );')) + eff('a', 'PS_a');
        const mD = gD + pixel(code('\t\tfloat ModFn( float x, float y = 1.0f )\n\t\t{\n\t\t\treturn x * y;\n\t\t}\n\t\tfloat2 ModVec( float2 v = float2( 1.0f, 2.0f ), float w = 0.5f )\n\t\t{\n\t\t\treturn v * w;\n\t\t}\n\t\tfloat GameDef( float a, float b = 0.0f )\n\t\t{\n\t\t\treturn a + b;\n\t\t}'),
            psMain('PS_m', 'return float4( ModFn( 2.0f ), ModVec().x, GameDef( 1.0f ), 1.0f );'), psMain('PS_few', 'return float4( ModFn(), 0.0f, 0.0f, 1.0f );'), psMain('PS_many', 'return float4( ModFn( 1.0f, 2.0f, 3.0f ), 0.0f, 0.0f, 1.0f );'),
            code('\t\tfloat Amb( float a, float b = 1.0f )\n\t\t{\n\t\t\treturn a * b;\n\t\t}\n\t\tfloat Amb2( float a )\n\t\t{\n\t\t\treturn a * 2.0f;\n\t\t}'), psMain('PS_amb', 'return float4( Amb( 1.0f ), Amb2( 1.0f ), 0.0f, 1.0f );')) + eff('m', 'PS_m') + eff('few', 'PS_few') + eff('many', 'PS_many') + eff('amb', 'PS_amb');
        const rD = run({ 'd.shader': gD }, { 'd.shader': mD }, ['d.shader']).files.get('d.shader')!;
        check(rD.notes.effects.join() === 'm,amb' && rD.text.includes('float ModFn( float x, float y = 1.0f )') && rD.text.includes('float2 ModVec(') && count(rD.text, 'float GameDef') === 1 && rD.notes.carried.includes('fn:ModFn(float,float)@ps'), `an effect calling a function with default values, with fewer arguments: carried with it (and the game's own, called that way, is found): ${rD.notes.effects.join()} / ${rD.notes.carried.join()}`);
        check(count(rD.text, 'float Amb(') === 1 && count(rD.text, 'float Amb2(') === 1, 'an overload of the mod’s that a call fits only by default values (or exactly, next to the game’s that fits by them) is not carried: the game’s stays');
        check(rD.notes.dropped.map((x) => x.name).join() === 'few,many' && rD.notes.dropped.every((x) => x.reason.kind === 'unavailable' && x.reason.name === 'ModFn'), `... and calls with too few or too many arguments are left out, with the reason: ${JSON.stringify(rD.notes.dropped)}`);

        // 2. the mod's own effect file (the game has none of the name): it stays, but what its effects need from the mod's copy of
        // a restored include is carried there; an effect that lacks something is told
        const incG = 'ConstantBuffer( 0 )\n{\n\tfloat4 Tint;\n};\n\nCode\n[[\n\tfloat GameHelper( float x )\n\t{\n\t\treturn x;\n\t}\n]]\n';
        const gB = 'Includes = {\n\t"inc.fxh"\n}\n\n' + vsA + pixel(psMain('PS_a', 'return float4( GameHelper( 1.0f ), 0.0f, 0.0f, 1.0f );')) + eff('a', 'PS_a');
        const incM = incG.replace('float4 Tint;', 'float4 Tint;\n\tfloat4 Tint2;') + 'Code\n[[\n\tfloat ModFn( float x )\n\t{\n\t\treturn x * 3.0f;\n\t}\n\tfloat ModUnused( float x )\n\t{\n\t\treturn x;\n\t}\n]]\n';
        const own = 'Includes = {\n\t"inc.fxh"\n}\n\nVertexShader =\n{\n\t' + vsMain('VS_o') + '}\n\n' + pixel(psMain('PS_o', 'return float4( ModFn( 1.0f ), 0.0f, 0.0f, 1.0f );'), psMain('PS_o_bad', 'return Tint2;')) + eff('o', 'PS_o', 'VS_o') + eff('o_bad', 'PS_o_bad', 'VS_o');
        // (a fragment `.fxh` with effects in it names mains the including file defines; it is no file of its own)
        const frag = eff('frag_eff', 'PS_defined_by_the_includer');
        const rO = run({ 'g.shader': gB, 'inc.fxh': incG }, { 'g.shader': gB, 'inc.fxh': incM, 'own.shader': own, 'frag.fxh': frag }, ['g.shader', 'inc.fxh'], ['own.shader', 'frag.fxh']);
        const inc = rO.files.get('inc.fxh')!;
        check(inc.text.startsWith(incG) && inc.text.includes('float ModFn') && !inc.text.includes('ModUnused') && inc.notes.carried.join() === 'fn:ModFn(float)@both' && rO.files.get('g.shader')!.text === gB, `a function only a file of the mod's own uses is carried by the include (the mod's copy of it): ${inc.notes.carried.join()}`);
        check(rO.unserved.length === 1 && rO.unserved[0].effect === 'o_bad' && rO.unserved[0].file === 'own.shader' && rO.unserved[0].reason.kind === 'field' && rO.unserved[0].reason.name === 'Tint2', `... and an effect of that file that reads a buffer member the game's lacks is told (an .fxh fragment with effects is not a file of its own): ${JSON.stringify(rO.unserved)}`);
        check(run({ 'g.shader': gB, 'inc.fxh': incG }, { 'g.shader': gB, 'inc.fxh': incM }, ['g.shader', 'inc.fxh']).files.get('inc.fxh')!.text === incG, 'without the mod’s own file nothing is carried');

        // 3. a carried sampler whose slot the game's has in the stage: the effects needing it are left out
        const sampler = (name: string, ref: string, index: number): string => `\tTextureSampler ${name}\n\t{\n\t\tRef = ${ref}\n\t\tIndex = ${index}\n\t}\n`;
        const gC = vsA + pixel(sampler('A', 'PdxTexture0', 3), psMain('PS_a', 'return PdxTex2D( A, float2( 0.0f, 0.0f ) );')) + eff('a', 'PS_a');
        const mC = gC + pixel(sampler('B', 'PdxTexture5', 3), sampler('C', 'PdxTexture6', 4), psMain('PS_b', 'return PdxTex2D( B, float2( 0.0f, 0.0f ) );'), psMain('PS_c', 'return PdxTex2D( C, float2( 0.0f, 0.0f ) );')) + eff('b', 'PS_b') + eff('c', 'PS_c');
        const rC = run({ 'c.shader': gC }, { 'c.shader': mC }, ['c.shader']).files.get('c.shader')!;
        const bound = rC.notes.dropped[0];
        check(rC.notes.effects.join() === 'c' && rC.text.includes('TextureSampler C') && !rC.text.includes('TextureSampler B') && rC.notes.dropped.length === 1 && bound.name === 'b' && bound.reason.kind === 'binding' && bound.reason.name === 'B' && bound.reason.detail === '3 | A', `a sampler with the Index of one the game has in the stage: its effect is left out, the other kept: ${JSON.stringify(rC.notes.dropped)}`);

        // 4. the branches after an #elif and an #else are written with the earlier ones negated; the condition of a #define too
        const cond = codeItems('#if COND_A\nfloat H() { return 1.0f; }\n#elif COND_B\nfloat H2() { return 2.0f; }\n#else\nfloat H3() { return 3.0f; }\n#endif\n#ifdef FOO\nfloat H4() { return 4.0f; }\n#else\nfloat H5() { return 5.0f; }\n#endif\n#ifdef OUT\n#if IN\nfloat H6() { return 6.0f; }\n#elif IN2\nfloat H7() { return 7.0f; }\n#endif\n#endif\n');
        check(cond.map((c) => c.cond).join(' | ') === 'if COND_A | if !(COND_A) && (COND_B) | if !(COND_A) && !(COND_B) | ifdef FOO | ifndef FOO | ifdef OUT~~COND~~if IN | ifdef OUT~~COND~~if !(IN) && (IN2)', `the conditions of the branches: ${cond.map((c) => c.cond).join(' | ')}`);
        const gE = vsA + pixel(psMain('PS_a', 'return float4( 0.0f, 0.0f, 0.0f, 1.0f );')) + eff('a', 'PS_a');
        const mE = gE + pixel(code('#if COND_A\nfloat H() { return 1.0f; }\n#elif COND_B\nfloat H2() { return 2.0f; }\n#else\nfloat H3() { return 3.0f; }\n#endif\n#ifdef FOO\nfloat H4() { return 4.0f; }\n#else\nfloat H5() { return 5.0f; }\n#endif'), psMain('PS_e', 'return float4( H(), H2(), H3(), H5() );')) + eff('e', 'PS_e');
        const rE = run({ 'e.shader': gE }, { 'e.shader': mE }, ['e.shader']).files.get('e.shader')!;
        check(rE.text.includes('#if COND_A\nfloat H()') && rE.text.includes('#if !(COND_A) && (COND_B)\nfloat H2()') && rE.text.includes('#if !(COND_A) && !(COND_B)\nfloat H3()') && rE.text.includes('#ifndef FOO\nfloat H5()') && !rE.text.includes('H4'), 'a carried definition under an #elif / #else holds in the builds the original branch does and no other');

        // 5. a definition the game has under an #ifdef only: the mod's own is carried for the builds without the flag
        const gF = vsA + pixel(code('#ifdef FOO\nfloat Helper( float a )\n{\n\treturn a;\n}\n#endif\n#ifdef BAR\nfloat Both( float a ) { return a; }\n#endif'), psMain('PS_a', 'return float4( 0.0f, 0.0f, 0.0f, 1.0f );')) + eff('a', 'PS_a');
        const mF = vsA + pixel(code('float Helper( float a ) { return a * 2.0f; }\n#ifdef BAR\nfloat Both( float a ) { return a * 3.0f; }\n#endif'), psMain('PS_a', 'return float4( 0.0f, 0.0f, 0.0f, 1.0f );'), psMain('PS_f', 'return float4( Helper( 1.0f ), Both( 1.0f ), 0.0f, 1.0f );')) + eff('a', 'PS_a') + eff('f', 'PS_f');
        const rF = run({ 'f.shader': gF }, { 'f.shader': mF }, ['f.shader']).files.get('f.shader')!;
        check(rF.notes.effects.join() === 'f' && /#ifndef FOO\nfloat Helper\( float a \) \{ return a \* 2\.0f; \}\n#endif/.test(rF.text) && count(rF.text, 'float Helper') === 2 && count(rF.text, 'float Both') === 1 && rF.notes.lost.join() === 'Both', `a definition the game has under an #ifdef: the mod's is carried under #ifndef, one under the same condition stays the game's (lost: ${rF.notes.lost.join()})`);

        // 6. a second declaration of a game constant buffer is another view of it when the layout (the members' types in order) is the same
        const gG = 'ConstantBuffer( PdxCam )\n{\n\tfloat4x4 ViewMatrix;\n\tfloat3 CamPos;\n\tfloat Pad;\n};\n\nConstantBuffer( PdxOther )\n{\n\tfloat4 OX;\n\tfloat4 OY;\n};\n\n' + vsA + pixel(psMain('PS_a', 'return float4( 0.0f, 0.0f, 0.0f, 1.0f );')) + eff('a', 'PS_a');
        const mG = 'Includes = {\n\t"modcam.fxh"\n}\n\n' + gG + pixel(psMain('PS_ga', 'return float4( ModView[ 0 ][ 0 ], ModPos.x, 0.0f, 1.0f );'), psMain('PS_gb', 'return ModOX;')) + eff('ga', 'PS_ga') + eff('gb', 'PS_gb');
        const camM = 'ConstantBuffer( PdxCam )\n{\n\tfloat4x4 ModView;\n\tfloat3 ModPos;\n\tfloat ModPad;\n};\n\nConstantBuffer( PdxOther )\n{\n\tfloat4 ModOX;\n\tfloat2 ModOY;\n};\n';
        const rG = run({ 'g.shader': gG }, { 'g.shader': mG, 'modcam.fxh': camM }, ['g.shader']).files.get('g.shader')!;
        const noLayout = rG.notes.dropped[0];
        check(rG.notes.effects.join() === 'ga' && rG.notes.carried.includes('cbuffer:PdxCam') && !rG.notes.carried.includes('cbuffer:PdxOther') && rG.notes.dropped.length === 1 && noLayout.name === 'gb' && noLayout.reason.kind === 'field' && noLayout.reason.name === 'ModOX', `a buffer declared again with the game's layout is carried, one with another layout is not (its effect is left out): ${JSON.stringify(rG.notes.dropped)}`);

        // 7. a compute shader: its main is in a block the merge does not read: the effect is left out as such, not as "defined nowhere"
        const gH = vsA + pixel(psMain('PS_a', 'return float4( 0.0f, 0.0f, 0.0f, 1.0f );')) + eff('a', 'PS_a');
        const mH = gH + 'ComputeShader =\n{\n\tMainCode CS_m\n\t{\n\t\tCode\n\t\t[[\n\t\t\tPDX_MAIN\n\t\t\t{\n\t\t\t}\n\t\t]]\n\t}\n}\n\nEffect cs_eff\n{\n\tComputeShader = "CS_m"\n}\n';
        const rH = run({ 'h.shader': gH }, { 'h.shader': mH }, ['h.shader']).files.get('h.shader')!;
        check(rH.notes.dropped.length === 1 && rH.notes.dropped[0].name === 'cs_eff' && rH.notes.dropped[0].reason.kind === 'compute' && rH.notes.effects.length === 0, `an effect with a compute shader: ${JSON.stringify(rH.notes.dropped)}`);

        // 8. the notes: the definitions the mod changed that stay the game's are all listed, so are the effects left out and their reasons
        const fns = (body: (n: number) => string): string => code(Array.from({ length: 9 }, (_, i) => `\t\tfloat Fn${i + 1}( float x )\n\t\t{\n\t\t\treturn ${body(i + 1)};\n\t\t}`).join('\n'));
        const gL = vsA + pixel(fns((n) => `x + ${n}.0f`), psMain('PS_a', 'return float4( 0.0f, 0.0f, 0.0f, 1.0f );')) + eff('a', 'PS_a');
        const mL = vsA + pixel(fns((n) => `x * ${n}.0f`), psMain('PS_a', 'return float4( 0.0f, 0.0f, 0.0f, 1.0f );')) + eff('a', 'PS_a') + mH.slice(gH.length);
        const gameFx: Record<string, string> = { 'l.shader': gL };
        const modFx: Record<string, string> = { 'l.shader': mL };
        const w = shaderWork({ files: ['gfx/FX/l.shader'], modFiles: ['gfx/FX/l.shader'], readMod: (rel) => (modFx[rel.slice(7)] === undefined ? undefined : Buffer.from(modFx[rel.slice(7)])), readGame: (rel) => (gameFx[rel.slice(7)] === undefined ? undefined : Buffer.from(gameFx[rel.slice(7)])) });
        const lostNote = shaderNotes(w).find((n) => n.includes('stay the game’s')) ?? '';
        check(w.files.get('gfx/FX/l.shader')!.notes.lost.length === 9 && lostNote.includes('Fn1, Fn2, Fn3, Fn4, Fn5, Fn6, Fn7, Fn8, Fn9') && !lostNote.includes('…'), `all 9 definitions the mod changed are in the note: ${lostNote}`);
        check(shaderNotes(w).some((n) => n.includes('cs_eff') && n.includes('compute shader') && !n.includes('defined nowhere')), `the note on a compute effect says so: ${shaderNotes(w).join(' | ')}`);

        // 9. one rule per effect file over all steps: a later step's restore does not take a file an earlier step's merge has
        const step = (extra: Partial<Migration>): Migration => ({ from: '1.19', to: '1.20', label: '', changes: [], types: [], section: '', order: [], newFolders: {}, ...extra });
        const mergeStep = step({ mergeShaders: [{ files: ['gfx/FX/**'], label: 'merge' }] });
        const restoreStep = step({ restore: [{ files: ['gfx/FX/**'], label: 'restore' }] });
        const modFiles = new Map<string, { file?: string; entry?: string; }>([['gfx/FX/pdxmesh.shader', { file: 'x' }], ['gfx/FX/jomini/coa_pattern_shape_mask.dds', { file: 'x' }]]);
        const rulesOf = (steps: Migration[]): string => fileRules({} as ModInfo, steps, gameDir, modFiles).map((r) => `${r.kind}:${r.files.join('+')}`).join(' ');
        const shaderRule = 'mergefx:gfx/FX/pdxmesh.shader';
        const textureRule = 'restore:gfx/FX/jomini/coa_pattern_shape_mask.dds';
        check(rulesOf([mergeStep, restoreStep]) === `${shaderRule} ${textureRule}`, `a later step's restore leaves the merged shader to the merge: ${rulesOf([mergeStep, restoreStep])}`);
        check(rulesOf([restoreStep, mergeStep]) === `${textureRule} ${shaderRule}`, `... also when the restore comes first: ${rulesOf([restoreStep, mergeStep])}`);
        check(rulesOf([mergeStep, step({ to: '1.21', mergeShaders: [{ files: ['gfx/FX/**'], label: 'again' }] })]) === 'mergefx:gfx/FX/pdxmesh.shader', `... and two merges of one file make one rule: ${rulesOf([mergeStep, step({ to: '1.21', mergeShaders: [{ files: ['gfx/FX/**'], label: 'again' }] })])}`);
    }

    console.log('building the index with the 1.19 mod …');
    await reindex();
    const state = await modsState(host);
    check(state.selected === 'custom:l1' && /^1\.20/.test(state.gameVersion ?? ''), `the list selected; the game is ${state.gameVersion}`);

    const plan = await planMigration(host, 'mod/old_mod.mod');
    check(!plan.problem && plan.steps.length === 1 && plan.steps[0].from === '1.19', `plan: ${plan.steps.map((s) => s.from + '→' + s.to).join(', ')}${plan.problem ?? ''}`);
    // (the statements no rule can map are in the plan, not only in a run's result: a mod with nothing else has no run to offer)
    check((plan.unmapped ?? []).some((u) => u === 'common/scripted_triggers/om_unmapped_only.txt:2 target = scope:somebody') && !(plan.unmapped ?? []).some((u) => u.includes('$RITE$')), `plan.unmapped: ${(plan.unmapped ?? []).join(' | ')}`);
    // (the defines nothing defines: told in the plan, but not a key the run renames; the files are not rewritten yet there)
    check((plan.notes ?? []).some((n) => n.includes('NOm.OM_NO_SUCH_KEY')) && !(plan.notes ?? []).some((n) => n.includes('FAITH_CREATION_FERVOR')), `plan.notes: the define nothing has is told, the one the NFaith rewrite fixes is not:\n${(plan.notes ?? []).filter((n) => /define/.test(n)).join('\n')}`);
    const fixes = plan.findings.filter((f) => f.fix).map((f) => `${f.fix!.fix} ${f.fix!.name}`);
    check(fixes.includes('law-group om_law_group') && fixes.some((f) => /religion-faiths om_religion|faith om_faith/.test(f)), `findings with a fix: ${fixes.join(', ')}`);
    // (religions with their settings at the top: marked, with the fix; one in the 1.20 form not; a family with the old banner key marked, no fix)
    const updateOf = (type: string, name: string) => sb.card(idx.get(type, name)!).sections.find((s) => s.title === 'Update for 1.20');
    check(['om_plain_religion', 'om_details_religion', 'om_crlf_religion'].every((n) => fixes.includes(`religion-details ${n}`)) && fixes.some((f) => f.startsWith('religion-faiths om_religion')) && !fixes.some((f) => f.includes('om_modern_religion')), `religions with their family at the top: planned (${fixes.filter((f) => f.includes('religion')).join(', ')})`);
    check(!updateOf('religion/religion_types', 'om_modern_religion') && /family, graphical_faith, piety_icon_group/.test(JSON.stringify(updateOf('religion/religion_types', 'om_plain_religion')?.lines.map((l) => l.text))) && updateOf('religion/religion_types', 'om_plain_religion')!.lines.some((l) => l.act?.do.kind === 'modernize'), 'the card marks the religion with its settings at the top (the update on the first line), not the one in the 1.20 form');
    check(['rf_om_banner', 'rf_om_plain', 'rf_om_none', 'rf_om_half'].every((n) => plan.findings.some((f) => f.type === 'religion/religion_family_types' && f.name === n && !f.fix)) && !plan.findings.some((f) => f.name === 'rf_om_done') && !!updateOf('religion/religion_family_types', 'rf_om_none'), 'the families without the four banner keys are in the plan (no fix of the card: a rule); the complete one is not');
    check(fixes.includes('doctrine-group om_hostility_group') && fixes.includes('doctrine-parameters om_marriage_doctrine') && fixes.includes('doctrine-parameters om_hostility_doctrine'), 'the doctrine group and the old parameters planned');
    check(plan.replacePaths?.join(' ') === 'common/religion/faith_types common/religion/rite_types common/holy_orders history/faiths', `new folders to hide: ${plan.replacePaths?.join(', ')}`);

    const r = await migrateMod(host, 'mod/old_mod.mod');
    console.log(`       ${r.notes.join('\n       ')}`);
    check(r.patch.folder === 'old_mod_1_20_fixes' && existsSync(join(tmp, 'mod', 'old_mod_1_20_fixes', 'descriptor.mod')), `patch mod ${r.patch.name} (${r.patch.folder})`);
    check(r.copied.length >= 3 && r.fixed.length >= 5 && !r.failed.length, `copied ${r.copied.join(', ')}; fixed ${r.fixed.join(', ')}; failed ${r.failed.map((f) => f.name + ': ' + f.why).join(', ') || 'none'}`);

    const after = await modsState(host);
    const list = after.lists.find((l) => l.ref === after.selected);
    check(list?.mods.map((m) => m.id).join(' ') === `mod/old_mod.mod ${r.patch.id}`, `the list: ${list?.mods.map((m) => m.id).join(' → ')}`);
    check(settings.activeMod === r.patch.id, 'the patch mod is the active mod');
    check(/supported_version="1\.20/.test(readFileSync(join(tmp, 'mod', 'old_mod_1_20_fixes', 'descriptor.mod'), 'utf8')), 'the patch mod is written for 1.20');

    for (const f of [join(tmp, 'mod', 'old_mod_1_20_fixes', 'descriptor.mod'), join(tmp, 'mod', 'old_mod_1_20_fixes.mod')])
        check(['common/religion/faith_types', 'common/religion/rite_types', 'common/holy_orders', 'history/faiths'].every((x) => readFileSync(f, 'utf8').includes(`replace_path="${x}"`)) && r.hidden.length === 4, `${f.split(/[\\/]/).pop()}: replace_path for the new folders`);

    const patchDir = join(tmp, 'mod', 'old_mod_1_20_fixes');
    const traits = readFileSync(join(patchDir, 'common', 'traits', 'om_traits.txt'), 'utf8');
    check(/rite_modifier = \{\s*parameter = basic_pilgrimage_rewards/.test(traits) && !/faith_modifier/.test(traits) && /name = \{/.test(traits), 'the trait’s faith_modifier is rite_modifier, in its track levels too (the rest kept)');
    // (can_grant_knighthood and om_nowhere_defined: no doctrine or tenet defines them; a rite_modifier on them crashes 1.20)
    check(!/can_grant_knighthood|om_nowhere_defined/.test(traits) && /learning = 1/.test(traits) && !/learning = 2/.test(traits), `blocks on a parameter defined nowhere left out:\n${traits}`);
    const same = (rel: string, root = gameDir): boolean => existsSync(join(patchDir, ...rel.split('/'))) && readFileSync(join(patchDir, ...rel.split('/'))).equals(readFileSync(join(root, ...rel.split('/'))));
    const install = join(gameDir, '..');
    check(same('gui/window_faith.gui') && same('gfx/FX/pdxmesh.shader'), 'the game’s own faith window and shader in the patch mod');
    check(same('gfx/FX/jomini/portrait.shader', join(install, 'jomini')) && same('gfx/FX/cw/pdxmesh.fxh', join(install, 'clausewitz')), 'the engine layers’ own includes too (jomini, clausewitz)');
    // (shaders with the mod's own effects: the game's file with the effect and what it needs behind it)
    const patchFx = (rel: string): string => readFileSync(join(patchDir, ...rel.split('/')), 'utf8').replace(/^﻿/, '');
    const riverFx = patchFx('gfx/FX/river_surface.shader');
    check(riverFx.startsWith(gameRiver) && riverFx.includes('Effect om_river_surface') && riverFx.includes('MainCode PS_om_surface') && riverFx.includes('float3 OmRiverTint') && riverFx.includes('#define OM_RIVER_STRENGTH 0.5f'), `the shader: the game’s text, then the mod’s effect with its stage code, its function and define:\n${riverFx.slice(gameRiver.length)}`);
    check(!riverFx.includes('OmUnused') && !riverFx.includes('0.5f * ( 1.0f - FlatMapLerp )') && riverFx.includes('Color.a *= 1.0f - FlatMapLerp;'), 'a function no effect uses is not carried; what the mod changed in the game’s own code is lost (the game’s PS_surface stays)');
    const riverInc = patchFx('gfx/FX/jomini/jomini_river.fxh');
    check(riverInc.includes('float OmWidthFactor') && !riverInc.includes('OmExtra') && riverInc.startsWith(gameFxText('jomini/jomini_river.fxh', 'jomini').slice(0, 300)), 'the engine include: the function the effect in the including file needs (demanded of it), the vertex struct field no carried code writes is not appended');
    check(r.notes.some((n) => n.startsWith('gfx/FX/river_surface.shader: 1 effect of the mod added')) && r.notes.some((n) => n.startsWith('gfx/FX/river_surface.shader: 1 definition the mod changed stays the game’s: PS_surface')) && r.notes.some((n) => /not appended/.test(n) && n.includes('VS_OUTPUT_RIVER.OmExtra')), `notes: ${r.notes.filter((n) => /river|vertex struct/.test(n)).join(' | ')}`);
    const fxManifest = JSON.parse(readFileSync(join(patchDir, '.crusaderpope-fixes.json'), 'utf8')) as { restored: Record<string, string>; merged?: Record<string, { game: string; mod: string; out: string; }>; lost?: Record<string, string[]>; };
    check(fxManifest.lost?.['gfx/FX/river_surface.shader']?.join() === 'PS_surface', `the manifest keeps the full list of what the mod changed that stays the game's: ${JSON.stringify(fxManifest.lost)}`);
    const fxHash = (rel: string): string => sha1(readFileSync(join(patchDir, ...rel.split('/'))));
    check(fxManifest.merged?.['gfx/FX/river_surface.shader']?.out === fxHash('gfx/FX/river_surface.shader') && fxManifest.merged?.['gfx/FX/jomini/jomini_river.fxh']?.out === fxHash('gfx/FX/jomini/jomini_river.fxh') && !fxManifest.restored['gfx/FX/river_surface.shader'] && fxManifest.restored['gfx/FX/pdxmesh.shader'] === sha1(readFileSync(join(gameDir, 'gfx', 'FX', 'pdxmesh.shader'))), 'the manifest: the merged files have a record of their own (game file, mod files, what was written), a file with nothing to add the plain restore’s');
    const body = readFileSync(join(patchDir, 'gfx', 'models', 'portraits', 'male_body', 'male_body.asset'), 'utf8');
    check(/name = "male_body_mesh"\s*streaming = Never/.test(body) && body.includes('# om: kept') && (body.match(/streaming = Never/g) ?? []).length === (gameBody.match(/streaming = Never/g) ?? []).length, 'the body model stays the mod’s, with 1.20’s streaming = Never in its pdxmesh');
    const creature = readFileSync(join(patchDir, 'gfx', 'models', 'portraits', 'om_creature', 'om_creature.asset'), 'utf8');
    check(/name = "om_creature_mesh"\s*streaming = Never/.test(creature) && /name = "om_creature_fire_mesh"\s*streaming = Never/.test(creature) && !/name = "om_creature_cloth_mesh"\s*streaming/.test(creature) && (creature.match(/streaming = Never/g) ?? []).length === 3, `the mod’s own animated meshes (an animation set imported, animations of their own) get streaming = Never, the mesh without and the one with it stay:\n${creature}`);
    check(!/streaming/.test(creature.slice(0, creature.indexOf('pdxmesh'))), 'the animation set itself gets nothing');
    check(!existsSync(join(patchDir, 'gfx', 'models', 'portraits', 'male_body', 'male_body_idle_1.anim')) && !existsSync(join(patchDir, 'gfx', 'models', 'portraits', 'male_body', 'om_own_dance.anim')), 'the animations stay the mod’s');
    const chars = readFileSync(join(patchDir, 'gui', 'om_char.gui'), 'utf8');
    check(chars.includes("OpenGameViewData( 'faith', Faith.Self )") && chars.includes("ToggleGameViewData('faith', GetPlayer.GetFaith.Self)") && chars.includes("'faith_conversion', Faith.GetID"), `the faith view opened with the faith:\n${chars}`);
    const merged = readFileSync(join(patchDir, 'common', 'game_concepts', 'zz_old_mod_1_20_fixes_game_concepts.txt'), 'utf8');
    check(/\nsecular_ruler = \{/.test(merged) && !/\nchurch_authority = \{/.test(merged) && /heresy = \{[\s\S]*?alias = \{ heresies heretical \}/.test(merged), `concepts: the missing one added, the one the mod has elsewhere not, the alias merged`);
    // (the game's tenet lists core_tenet, core_tenets and core; the mod defines core_tenet and core_tenets: they are left out;
    // state_rite's only alias state_faith is the mod's concept: the list goes)
    check(/\ntenet = \{\s*alias = \{ tenets core \}\s*\}/.test(merged) && !merged.includes('core_tenet') && /\nstate_rite = \{\s*texture = [^\n]*\s*parent = rite\s*\}/.test(merged) && !merged.includes('state_faith'), `concepts: aliases that collide with the mod’s own concepts left out:\n${merged.slice(0, 700)}`);
    // (ethos, a game concept the mod doesn't define: its key is an alias of the mod's state_faith, so it is not added)
    check(!/\nethos = \{/.test(merged) && !merged.includes('culture_pillar\n\ttexture = "gfx/interface/icons/icon_culture.dds"\n}\nethos'), 'concepts: a game concept whose key is an alias of the mod’s own is not added');
    check(existsSync(join(patchDir, 'gui', 'window_faith_creation.gui')) && readFileSync(join(patchDir, 'gui', 'window_faith_creation.gui'), 'utf8') === '', 'the game file 1.20 removed: emptied in the patch mod');
    const tenets = readFileSync(join(patchDir, 'common', 'religion', 'tenet_types', 'old_mod_1_20_fixes_tenet_types.txt'), 'utf8');
    check(/tenet_om_debug = \{\s*icon = tenet_communal_identity/.test(tenets) && /icon = core_tenet_om/.test(tenets) && existsSync(join(patchDir, 'gfx', 'interface', 'icons', 'faith_tenets', 'core_tenet_om.dds')), `tenet icons: the game's under its 1.20 name, the mod's own copied into faith_tenets`);
    check(/om_site = \{\s*county = c_roma\s*county_holder_character_modifier = \{/.test(readFileSync(join(patchDir, 'common', 'religion', 'holy_site_types', 'om_holy_sites.txt'), 'utf8')), 'holy site: character_modifier is county_holder_character_modifier');
    const defs = readFileSync(join(patchDir, 'common', 'defines', 'zz_old_mod_1_20_fixes', 'zz_old_mod_1_20_fixes_defines.txt'), 'utf8');
    check(/NGameIcons = \{[\s\S]*TENET_TYPE_ICON_PATH = "gfx\/interface\/icons\/faith_tenets"/.test(defs) && !defs.includes('DOCTRINE_TYPE_ICON_PATH'), `defines: the key 1.20 added, not the one the mod set itself:
${defs.slice(0, 300)}`);
    check(defs.includes('TRAIT_OVERLAY_VIRTUE = "gfx/interface/icons/traits/virtue.dds"') && defs.includes('CHARACTER_INTERACTION_CATEGORY_ICON_PATH = "gfx/interface/icons/character_interactions"') && !defs.includes('TRAIT_OVERLAY_SIN') && !defs.includes('om_kept') && r.notes.some((n) => n.includes('NGameIcons.TRAIT_OVERLAY_VIRTUE') && n.includes('NGameIcons.CHARACTER_INTERACTION_CATEGORY_ICON_PATH') && !n.includes('TRAIT_OVERLAY_SIN')), `defines: a path of the mod’s copy that points where nothing is (a file the game renamed, a folder it renamed) is the game’s value, a path to a file the mod ships stays; the notes tell the keys:\n${defs.slice(0, 600)}`);
    const sites = readFileSync(join(patchDir, 'common', 'religion', 'holy_site_types', 'om_holy_sites.txt'), 'utf8');
    check(/om_site = \{\s*county = c_roma\s*county_holder_character_modifier = \{\s*stewardship = 1\s*\}\s*parameters = \{\s*om_bonus # the bonus\s*om_other\s*\}\s*\}/.test(sites) && !/\bflag = /.test(sites), `holy sites: flag = x are the words of parameters = { } (the first one's place, comments with the word):\n${sites}`);
    check(/om_second_site = \{\s*county = c_roma\s*parameters = \{\s*om_known\s*# the old\s*om_third\s*\}\s*\}/.test(sites), `holy sites: the flags join the parameters block the site has:\n${sites}`);
    const faithsOut = readFileSync(join(patchDir, 'common', 'religion', 'faith_types', 'old_mod_1_20_fixes_faith_types.txt'), 'utf8');
    check(/tenet_selection_pair = \{\s*requires_dlc_flag = legacy_of_persia # fedayeen\s*tenet = tenet_fp3_fedayeen\s*fallback_tenet = tenet_struggle_submission\s*\}/.test(faithsOut) && !faithsOut.includes('doctrine_selection_pair'), `faith: the 1.19 doctrine_selection_pair of tenets is a tenet_selection_pair, its DLC flag kept:\n${faithsOut}`);
    check(readFileSync(join(patchDir, 'common', 'modifiers', 'om_modifiers.txt'), 'utf8').includes('\trite_creation_piety_cost_add = 5\n') && !readFileSync(join(patchDir, 'common', 'modifiers', 'om_modifiers.txt'), 'utf8').includes('faith_creation_piety_cost'), 'the modifier faith_creation_piety_cost_add is rite_creation_piety_cost_add, with the _mult one');
    const trig = readFileSync(join(patchDir, 'common', 'scripted_triggers', 'om_triggers.txt'), 'utf8');
    check(trig.includes('\tmultiply = define:NRite|RITE_CREATION_FERVOR_DISCOUNT_PER_MISSING_FERVOR\n') && trig.includes('\tmax = define:NRite|RITE_CREATION_FERVOR_DISCOUNT_MAX # a comment\n') && trig.includes('\tmin = define:NRite|RITE_CREATION_FERVOR_DISCOUNT_MAX\n') && !trig.includes('NFaith|'), `defines: NFaith|FAITH_CREATION_FERVOR_DISCOUNT_… is NRite|RITE_CREATION_FERVOR_DISCOUNT_…:\n${trig}`);
    check(trig.includes('\t\tany_holy_site_barony = { county.holder = root }\n') && trig.includes('\t\tany_holy_site_barony = { count >= 1 }\n') && trig.includes('every_holy_site_barony = { save_scope_as = om_site add_to_list = om_sites }') && trig.includes('random_holy_site_barony = { limit = { barony = { is_county_capital = yes } } }'), `holy site loops: the 1.19 loops over barony titles are the _barony ones:\n${trig}`);
    check(trig.includes('\t\tany_holy_site = { holy_site_county.holder = root }\n') && trig.includes('\t\tany_holy_site = { is_eminent = no county.holder = root }\n') && trig.includes('\t\t# any_holy_site = { county.holder = root } (a comment stays)\n') && (trig.match(/any_holy_site_barony = \{ county\.holder = root \}/g) ?? []).length === 2, 'holy site loops: a loop already written for the holy site scope and a comment stay');
    check(!existsSync(join(patchDir, 'gui', 'om_own_window.gui')) && r.rewritten.length >= 52 + 3,`the mod’s own interface file left alone (at least 52 files of the earlier rules and 3 of this fixture’s script files: the opinion users, the macro call sites, the creation value; rules of other lanes add their own, so the count is a floor); ${r.rewritten.length} rewritten: ${r.rewritten.join(', ')}`);
    check(existsSync(join(patchDir, 'common', 'religion', 'tenet_types')) && /tenet_om_debug = \{/.test(readFileSync(join(patchDir, 'common', 'religion', 'tenet_types', 'old_mod_1_20_fixes_tenet_types.txt'), 'utf8')), 'the group-less tenet_ doctrine moved to the tenets');
    // (script statements: a tenet moved to the tenet types: its blocks that run with a rite use the rite's triggers, its
    // faith blocks the faith's; tenets are tested and changed as tenets everywhere. The parameter's if: the rite's trigger, or gone with its
    // body when the inert rule made the parameter false, which no loaded doctrine has)
    const debugTenet = /tenet_om_debug = \{[\s\S]*?\n\}/.exec(tenets)?.[0] ?? '';
    check(/trigger = \{ rite_religion_tag = om_religion \}/.test(debugTenet) && /limit = \{ rite_has_tenet = tenet_om_debug \}/.test(debugTenet) && /limit = \{ rite_has_doctrine = doctrine_monogamy \}/.test(debugTenet)
        && (/limit = \{ rite_has_parameter = om_param \}/.test(debugTenet) || (!/om_param/.test(debugTenet) && !/\badd = 3\b/.test(debugTenet))) && /limit = \{ faith = \{ has_tenet = tenet_om_own \} \}/.test(debugTenet), `a moved tenet: name and piety_cost use the rite's triggers, a faith block inside them the faith's:\n${debugTenet}`);
    check(/can_pick = \{\s*has_tenet = tenet_om_own\s*religion_tag = om_religion\s*NOT = \{ tenet:tenet_om_own = \{ is_in_list = selected_doctrines \} \}\s*doctrine:doctrine_monogamy = \{ is_in_list = selected_doctrines \}/.test(debugTenet), 'a moved tenet: can_pick runs with a faith; has_tenet, religion_tag kept, the tenet’s link is tenet:, the doctrine’s stays');
    const ev = readFileSync(join(patchDir, 'events', 'om_events.txt'), 'utf8');
    check(ev.includes('\t\tfaith = { has_tenet = tenet_om_own }\n') && ev.includes('NOT = { faith = { has_doctrine = doctrine_monogamy } }') && ev.includes('\n\t\thas_tenet = tenet_pacifism\n') && ev.includes('scope:actor.faith = { OR = { has_tenet = tenet_pacifism has_doctrine = doctrine_monogamy } }'), `has_doctrine of a tenet is has_tenet, of a doctrine it stays:\n${ev}`);
    check(/add_tenet = tenet_om_own\s*remove_tenet = tenet_pacifism\s*add_doctrine = doctrine_monogamy/.test(ev) && ev.includes('rite = { rite_has_tenet = tenet_pacifism }') && ev.includes('10 = { faith = { has_tenet = tenet_om_own } }'), 'add_doctrine / remove_doctrine of a tenet are add_tenet / remove_tenet; in a rite block rite_has_tenet; a random_list entry keeps its scope');
    check(ev.includes('om_effect_with_link = tenet:tenet_om_own') && ev.includes('# has_doctrine = tenet_om_own (a comment stays)'), 'the doctrine: link of a tenet is tenet:, a comment stays as written');
    check(ev.includes('num_virtuous_traits = { value > 0 target = scope:actor.rite }') && ev.includes('target = rite }') && ev.includes('target = faith:catholic.main_rite }') && ev.includes('target = $FAITH$ }') && ev.includes('target = root.rite }') && ev.includes('om_other_trigger = { target = root.faith }'), 'the trait counts: the target is a rite (a faith’s main rite for faith:x, a parameter and a rite left), a target outside the two triggers untouched');
    check(ev.includes('scope:barony = { lease_out_to_holy_order = scope:holy_order }') && ev.includes('scope:title = { set_state_rite = root.rite }') && ev.includes('guardian_or_court_tutor_trigger_event_effect = { EVENT = om_ev.0002 }') && ev.includes('\t\tset_state_faith = scope:some_faith\n'), 'renamed effects: lease_out_to_holy_order, set_state_rite = x.rite (a saved faith scope stays), the scripted effect');
    check(ev.includes('sexual_activity_with_partner_is_criminal_in_rite_trigger = { PARTNER = scope:partner RITE = root.rite }') && ev.includes('sexual_activity_with_partner_is_criminal_in_faith_trigger = { PARTNER = scope:partner FAITH = scope:somebody }'), 'the renamed trigger takes RITE = x.rite; with a value that is no x.faith it stays whole');
    check(r.notes.some((n) => /stay as written/.test(n) && n.includes('set_state_faith = scope:some_faith') && !n.includes('$FAITH$') && !n.includes('$RITE$') && n.includes('sexual_activity_with_partner_is_criminal_in_faith_trigger')), `the statements it could not map are in the notes (a macro parameter is not one): ${r.notes.filter((n) => /stay as written/.test(n)).join(' | ')}`);
    check(r.notes.some((n) => /stay as written/.test(n) && n.includes('common/scripted_triggers/om_unmapped_only.txt:2 target = scope:somebody')), 'a file with nothing but a statement it cannot map is in the notes too');
    check(!existsSync(join(patchDir, 'common', 'scripted_triggers', 'om_unmapped_only.txt')), 'a file the rules do not change is not copied into the patch mod');
    const crlf = readFileSync(join(patchDir, 'common', 'scripted_effects', 'om_crlf_effects.txt'), 'utf8');
    check(crlf === '﻿om_crlf_effect = {\r\n\tif = {\r\n\t\tlimit = { has_tenet = tenet_pacifism }\r\n\t\tfaith = { remove_tenet = tenet_pacifism }\r\n\t}\r\n}\r\n', `a file with CRLF line ends and a byte order mark: edited, the rest as written: ${JSON.stringify(crlf)}`);
    const costDoctrine = /om_cost_doctrine = \{[\s\S]*?\n\}/.exec(readFileSync(join(patchDir, 'common', 'religion', 'doctrine_types', 'om_doctrines.txt'), 'utf8'))?.[0] ?? '';
    check(/limit = \{ rite_has_doctrine = doctrine_monogamy rite_has_tenet = tenet_pacifism rite_religion_tag = om_religion \}/.test(costDoctrine) && /can_pick = \{\s*has_doctrine = doctrine_monogamy\s*has_tenet = tenet_pacifism\s*\}/.test(costDoctrine), `a flat doctrine_types doctrine: piety_cost runs with a rite, can_pick with a faith:\n${costDoctrine}`);
    check(readFileSync(join(patchDir, 'common', 'scripted_triggers', 'om_triggers.txt'), 'utf8').includes('\thas_tenet = tenet_pacifism\n\thas_doctrine = doctrine_monogamy\n'), 'a scripted trigger (scope unknown): has_doctrine was a faith trigger, so has_tenet');
    check(readFileSync(join(patchDir, 'gfx', 'portraits', 'portrait_modifiers', 'om_headgear.txt'), 'utf8').includes('limit = { faith = { has_tenet = tenet_pacifism } }'), 'portrait modifiers are script too');
    check(readFileSync(join(patchDir, 'common', 'modifiers', 'om_modifiers.txt'), 'utf8').includes('\trite_creation_piety_cost_mult = -0.1\n'), 'the modifier faith_creation_piety_cost_mult is rite_creation_piety_cost_mult');
    const rules = readFileSync(join(patchDir, 'common', 'scripted_rules', '00_rules.txt'), 'utf8');
    const rulesMerged = readFileSync(join(patchDir, 'common', 'scripted_rules', 'zz_old_mod_1_20_fixes_scripted_rules.txt'), 'utf8');
    check(rules.includes('can_create_rite = {\n\tis_adult = yes\n\tis_at_war = no\n}') && !rules.includes('faith_creation') && rules.includes('faith_conversion = {'), 'scripted rules: faith_creation is can_create_rite (its body kept), faith_conversion stays');
    check(/\ncan_edit_rite = \{/.test(rulesMerged) && /\nrite_conversion = \{/.test(rulesMerged) && !/\ncan_create_rite = \{/.test(rulesMerged) && !/\nfaith_conversion = \{/.test(rulesMerged), 'scripted rules: the game’s rules the mod lacks added (not can_create_rite: the mod’s renamed one is that)');
    const docs = readFileSync(join(tmp, 'mod', 'old_mod_1_20_fixes', 'common', 'religion', 'doctrine_types', 'om_doctrines.txt'), 'utf8');
    check(/om_hostility_doctrine = \{\s*doctrine_group_type = om_hostility_group\s*index = 0/.test(docs) && /om_other_hostility_doctrine = \{\s*doctrine_group_type = om_hostility_group\s*index = 1/.test(docs), 'the doctrines of the other file name their group, with their index (the file copied into the patch mod)');
    check(/hostility_levels = \{\s*same_religion = astray\s*same_family = hostile\s*unrelated = evil\s*\}/.test(docs) && /hostility_level_override = \{\s*doctrine_om_foe = evil\s*\}/.test(docs) && /same_religion = righteous/.test(docs), 'hostility numbers as levels');
    check(/special_parameters = \{\s*number_of_spouses = 4\s*\}/.test(docs) && /\bparameters = \{\s*marriage_event\s*\}/.test(docs) && !/hostility_same_religion/.test(docs), `number_of_spouses into special_parameters, marriage_event kept:\n${docs}`);
    const special = /om_special_doctrine = \{[\s\S]*?\n\}/.exec(docs)?.[0] ?? '';
    check(/\n\tparameters = \{\s*warmonger\s*unreformed\s*pacifist\s*conquest_cb_enabled = yes\s*\}/.test(special) && !/_opinion_active/.test(special), `1.19 flags as the bare word, the opinions out of parameters:\n${special}`);
    const creationValues = readFileSync(join(patchDir, 'common', 'script_values', 'om_creation_values.txt'), 'utf8');
    check(/^﻿?rite_creation_cost_mult = \{\n/.test(creationValues) && !creationValues.includes('faith_creation_cost_mult'), `the engine’s named value faith_creation_cost_mult is rite_creation_cost_mult:\n${creationValues}`);
    const virtueCalls = readFileSync(join(patchDir, 'common', 'scripted_effects', 'om_virtue_calls.txt'), 'utf8');
    check(virtueCalls.includes('om_virtue_check_trigger = { FAITH = root.rite }') && virtueCalls.includes('om_virtue_check_trigger = { FAITH = faith:catholic.main_rite }') && virtueCalls.includes('om_faith_use_trigger = { FAITH = root.faith }') && !existsSync(join(patchDir, 'common', 'scripted_triggers', 'om_virtue_triggers.txt')), `macro call sites: the arguments of a trigger that only counts traits with it are rites, the other trigger keeps its faith:\n${virtueCalls}`);
    check((plan.unmapped ?? []).some((u) => u.includes('om_virtue_calls.txt') && u.includes('om_faith_use_trigger') && u.includes('otherwise')) && !(plan.unmapped ?? []).some((u) => u.includes('om_virtue_check_trigger')), `macro call sites: the call of the trigger that uses the parameter otherwise is told (not converted): ${(plan.unmapped ?? []).join(' | ')}`);
    const opinionUsers = readFileSync(join(patchDir, 'common', 'scripted_triggers', 'om_opinion_triggers.txt'), 'utf8');
    check(opinionUsers.includes('\tfaith = { has_doctrine_parameter = pacifist }\n') && opinionUsers.includes('\trite_has_parameter = pacifist\n') && opinionUsers.includes('\talways = no\n') && opinionUsers.includes('\t# has_doctrine_parameter = pacifist_opinion_active\n'), `the users of a converted opinion flag test the flag (has_doctrine_parameter and rite_has_parameter), another spelling and a comment stay:\n${opinionUsers}`);
    check(/special_parameters = \{[^]*?warmonger = yes[^]*?unreformed = yes[^]*?same_hof_hostility_override = astray[^]*?parameter_opinion_override = \{\s*om_other = 5\s*pacifist = 10\s*om_actor = 30\s*\}/.test(special) && (special.match(/parameter_opinion_override/g) ?? []).length === 1, 'warmonger, unreformed, the head of faith’s hostility as a level, the opinions merged into the doctrine’s own override map');
    check(/allowed_holding_types = \{\s*church_holding\s*city_holding\s*\}/.test(special) && (special.match(/allowed_holding_types/g) ?? []).length === 1 && !/allowed_holding_type_/.test(special), `allowed_holding_type_<holding> = yes as one allowed_holding_types list:\n${special}`);
    const groups = readFileSync(join(patchDir, 'common', 'religion', 'doctrine_group_types', 'om_groups.txt'), 'utf8');
    check(/om_hostility_group = \{\s*category = not_creatable\s*\}/.test(groups) && !groups.includes('number_of_picks') && !/om_core_tenets = /.test(groups) && !/category = "core_tenets"/.test(groups),`doctrine groups: number_of_picks out, the group whose doctrines became tenets removed:\n${groups}`);
    check(r.notes.some((n) => /om_core_tenets: removed/.test(n)) && !r.notes.some((n) => /om_core_tenets.*left/.test(n)), 'the group of tenets: noted as removed');

    // (the other renamed keys)
    const readPatch = (rel: string): string => readFileSync(join(patchDir, ...rel.split('/')), 'utf8');
    const buildings = readPatch('common/buildings/om_buildings.txt');
    check(/province_rite_modifier = \{\s*parameter = basic_pilgrimage_rewards\s*monthly_piety = 0\.1\s*\}\s*county_rite_modifier/.test(buildings) && /county_rite_modifier = \{\s*parameter = basic_pilgrimage_rewards/.test(buildings) && /duchy_capital_county_rite_modifier = \{\s*parameter = basic_pilgrimage_rewards\s*levy_size = 0\.2/.test(buildings) && !/_faith_modifier/.test(buildings.replace(/character_faith_modifier/g, '')), `buildings: the rite modifiers of the game:\n${buildings}`);
    check(!buildings.includes('om_nowhere_defined') && !buildings.includes('can_grant_knighthood') && !buildings.includes('character_faith_modifier') && buildings.includes('character_modifier = {\n\t\tmonthly_prestige = 0.1') && r.notes.some((n) => /no such key any more/.test(n) && n.includes('common/buildings/om_buildings.txt: character_faith_modifier (2×)')), 'buildings: a parameter defined nowhere and the character_faith_modifier blocks left out, the others kept; the notes tell the dropped key');
    check(readPatch('common/lifestyle_perks/om_perks.txt').includes('\tfaith_character_modifier = {\n\t\tdoctrine = doctrine_monogamy') && readPatch('common/dynasty_perks/om_dynasty_perks.txt').includes('faith_character_modifier = {\n\t\tname = om_dynasty_perk_name') && readPatch('common/culture/traditions/om_traditions.txt').includes('faith_character_modifier = {') && readPatch('common/situation/situations/om_situations.txt').includes('\t\t\t\t\tfaith_character_modifier = {\n\t\t\t\t\t\tname = om_situation_name') && !/doctrine_character_modifier/.test(readPatch('common/situation/situations/om_situations.txt')), 'perks, traditions and situations: doctrine_character_modifier is faith_character_modifier (deep in a situation too)');
    check(readPatch('common/decisions/om_holy_decisions.txt').includes('\t\ttitle_valid = {\n\t\t\tis_county_capital = yes') && !readPatch('common/decisions/om_holy_decisions.txt').includes('barony_valid'), 'a holy order decision’s barony_valid is title_valid');
    check(readPatch('common/scripted_triggers/om_government_triggers.txt') === '﻿om_government_trigger = {\n\tgovernment_has_mechanic = administrative\n\tNOT = { government_has_mechanic = administrative }\n\tgovernment_has_mechanic = theocracy\n\tgovernment_allows = merit\n}\n', `government_allows = administrative / religious are government_has_mechanic, a valid rule stays: ${JSON.stringify(readPatch('common/scripted_triggers/om_government_triggers.txt'))}`);
    const govs = readPatch('common/governments/om_governments.txt');
    check(govs.includes('om_celestial_government = {\n\tmechanic_type = administrative\n\tgovernment_rules = {\n\t\tlegitimacy = yes\n\t}') && govs.includes('om_temple_government = {\n\tmechanic_type = theocracy\n\tgovernment_rules = {\n\t}') && /om_admin_government = \{\s*government_rules = \{\s*\}\s*mechanic_type = administrative\s*\}/.test(govs) && (govs.match(/mechanic_type/g) ?? []).length === 3, `government rules: administrative / religious go, the mechanic_type comes (once; the one that had it keeps it):\n${govs}`);
    check(/om_quiet_government = \{\s*government_rules = \{\s*legitimacy = yes\s*\}\s*\}/.test(govs) && !/\b(?:religious|administrative) = no\b/.test(govs), `government rules: religious = no and administrative = no go with no mechanic_type (they were the default):\n${govs}`);
    const appointments = readPatch('common/succession_appointment/om_appointments.txt');
    check(/om_governor = \{\s*cooldown = yes\s*default_candidates = \{ landed_vassal \}\s*allowed_candidate_tier = lower_or_equal\s*\}/.test(appointments) && /om_regent = \{\s*cooldown = no\s*\}/.test(appointments) && /om_clerk = \{\s*allowed_candidate_tier = lower_or_equal\s*cooldown = yes\s*\}/.test(appointments) && (appointments.match(/cooldown/g) ?? []).length === 3 && !appointments.includes('allow_same_tier'), `appointments: = yes is lower_or_equal with the cooldown, = no goes:\n${appointments}`);
    const elections = readPatch('common/succession_election/om_elections.txt');
    check(elections.includes('\telectors = {\n\t\tmax = 5\n\t\tcharacter_sets = {\n\t\t\tom_elective_electors_holder = {\n\t\t\t\ttype = holder\n\t\t\t}\n\t\t\tom_elective_electors_holder_direct_vassals = {\n\t\t\t\ttype = holder_direct_vassals\n\t\t\t\tlimit = {\n\t\t\t\t\tis_house_head = yes\n\t\t\t\t}\n\t\t\t}\n\t\t\tom_elective_electors_holder_direct_vassals_2 = {\n\t\t\t\ttype = holder_direct_vassals\n\t\t\t\tlimit = { is_adult = yes }\n\t\t\t}\n\t\t}\n\t}\n'), `elections: the electors’ add statements are character_sets:\n${elections}`);
    check(elections.includes('\tcandidates = {\n\t\tcharacter_sets = {\n\t\t\tom_elective_candidates_holder = {\n\t\t\t\ttype = holder\n\t\t\t}\n\t\t}\n\t}\n') && elections.includes('add = gold\n\t\t\tgold > 0') && elections.includes('om_done_holder = {'), 'elections: candidates the same; add = gold in a modifier and a finished election stay');
    const genes = readPatch('common/genes/om_genes.txt');
    check(genes.includes('1 = male_clothes_religious_orthodox_head_01\n') && genes.includes('1 = male_clothes_secular_dde_hre_nobility_02_common\n') && genes.includes('1 = om_not_an_accessory_common\n') && genes.includes('2 = { male_clothes_religious_orthodox_head_01 male_clothes_secular_dde_hre_nobility_02_common }'), `genes: _common names that are no accessory but are one without it are renamed (a list too), real _common accessories and unknown names stay:\n${genes}`);
    const acts = readPatch('common/activities/activity_types/om_activities.txt');
    const headerOf = (name: string): string => new RegExp(`${name} = \\{\\r?\\n\\theader_background = ([^\\r\\n]*)`).exec(acts)?.[1] ?? '';
    const gamePilgrimage = readFileSync(join(gameDir, 'common', 'activities', 'activity_types', 'pilgrimage.txt'), 'utf8');
    check(headerOf('activity_om_party') === '"gfx/interface/illustrations/activity_header_backgrounds/activity_om_picture.dds"' && headerOf('activity_om_coronation') === '"gfx/interface/illustrations/activity_header_backgrounds/activity_coronation.dds"' && headerOf('activity_om_odd') === '"gfx/interface/illustrations/activity_header_backgrounds/activity_feast.dds"', `activity types: header_background from the own background, the game's type of the name, the feast's:\n${acts}`);
    check((acts.match(/header_background = "gfx\/interface\/illustrations\/om_done\.dds"/g) ?? []).length === 1 && (acts.match(/\bheader_background\b/g) ?? []).length === 4 + 5, 'activity types: the one with a header_background keeps it alone; the pilgrimage gets the 5 statements of the game’s 12 that can be read in the mod’s world (an OR keeps the alternatives it has)');
    check(/activity_om_pilgrimage = \{\r?\n\theader_background = \{ #East Asian faiths\r?\n\t\ttrigger = \{\r?\n\t\t\tOR = \{\r?\n\t\t\t\tfaith\.religion = \{ is_in_family = rf_sinitic \}\r?\n\t\t\t\tAND = \{[^]*?reference = "gfx\/interface\/illustrations\/event_scenes\/tgp_holysite_asia\.dds"\r?\n\t\}\r?\n\theader_background = \{ #Dharmic \/ Indian faiths/.test(acts) && !acts.includes('shintoism') && acts.includes('#Norse / Germanic pagan') && acts.includes('#Other pagan / folk faiths') && acts.includes('\theader_background = "gfx/interface/illustrations/event_scenes/temple.dds"\n') && !/religion:|faith:/.test(acts.slice(acts.indexOf('activity_om_pilgrimage'))), `activity types: the game’s header blocks with a trigger are copied as they are, those naming a religion or faith the mod’s world lacks are not:\n${acts}`);

    // (what 1.20 added to the definitions the mod's older files hold: keys and list words of the game's definition of the name)
    const gameTenets = readFileSync(join(gameDir, 'common', 'religion', 'tenet_types', '00_tenet_types.txt'), 'utf8').replace(/\r\n/g, '\n');
    const pt = parse(readPatch('common/religion/tenet_types/old_mod_1_20_fixes_tenet_types.txt'));
    const bodyOf = (name: string): PNode[] => (pt.find((n) => n.k === name)?.v as PNode[] | undefined) ?? [];
    const wordsOf = (name: string, key: string): string[] => ((bodyOf(name).find((c) => c.k === key)?.v as PNode[] | undefined) ?? []).map((c) => c.k ?? (c.v as string));
    check(['personal_tenet_modifier', 'personal_tenet_parameters', 'parameters'].every((k) => bodyOf('tenet_legalism').some((c) => c.k === k)) && bodyOf('tenet_legalism').filter((c) => c.k === 'parameters').length === 1, `tenets: tenet_legalism gets the game's personal tenet settings (${bodyOf('tenet_legalism').map((c) => c.k).join(', ')})`);
    check(wordsOf('tenet_legalism', 'parameters').join() === 'legalism_reduced_faction_virtues,om_own_param,legalism_increased_faction_sins,tenet_legalism_sinful_revocation,tenet_legalism_title_integration' && wordsOf('tenet_legalism', 'personal_tenet_parameters').join() === 'tenet_legalism_lawful_authority', `tenets: the parameters 1.20 added join the mod's own, which stay in their place, once each: ${wordsOf('tenet_legalism', 'parameters').join()}`);
    check(readPatch('common/religion/tenet_types/old_mod_1_20_fixes_tenet_types.txt').includes('\tpersonal_tenet_modifier = {\n\t\tlifestyle_scholar_xp_gain_mult = 0.20\n\t}') && gameTenets.includes('personal_tenet_modifier = {\n\t\tlifestyle_scholar_xp_gain_mult = 0.20'),'tenets: the block is the game’s, as written');
    check(!wordsOf('tenet_literalism', 'parameters').includes('tenet_literalism_conversion_resistance') && wordsOf('tenet_literalism', 'parameters').includes('literalism_holy_war_cb_active') && wordsOf('tenet_literalism', 'personal_tenet_parameters').length === 3, `tenets: a parameter another tenet of the mod has already is not added (the mod knew it): ${wordsOf('tenet_literalism', 'parameters').join()}`);
    check(!bodyOf('tenet_om_own').some((c) => c.k === 'personal_tenet_parameters') && !bodyOf('tenet_om_debug').some((c) => c.k === 'personal_tenet_modifier'), 'tenets: the mod’s own tenets, which the game lacks, get nothing');
    const poly = parse(readPatch('common/religion/doctrine_types/om_shared_tenets.txt')).find((n) => n.k === 'doctrine_polygamy')!;
    check((poly.v as PNode[]).filter((c) => c.k === 'divergence').map((c) => c.v).join() === '30' && (poly.v as PNode[]).filter((c) => c.k === 'parameters').length === 1, 'doctrines: the game’s divergence');
    check(/doctrine_marriage_type = \{\r\n\tcategory = marriage\r\n\tdivergence = sequence\r\n\}\r\n/.test(readPatch('common/religion/doctrine_group_types/om_marriage_group.txt')), 'doctrine groups: the game’s divergence, CRLF kept');
    const asc = readPatch('common/religion/tenet_types/om_app_tenet_types.txt');
    check(asc.replace(/^﻿/, '').startsWith('# tenets of the mod') && (asc.match(/personal_tenet_modifier/g) ?? []).length === 1 && asc.includes('monthly_piety = 0.5') && asc.includes('personal_tenet_parameters') && asc.includes('historical_glossary'), `tenets: one an earlier card fix wrote into the mod’s own file keeps its own personal_tenet_modifier and gets the rest:\n${asc}`);
    const sky = parse(readPatch('common/religion/doctrine_types/om_shared_tenets.txt')).find((n) => n.k === 'doctrine_funeral_sky_burial')!;
    check((sky.v as PNode[]).filter((c) => c.k === 'parameters').length === 1 && ((sky.v as PNode[]).find((c) => c.k === 'parameters')!.v as PNode[]).map((c) => c.k ?? c.v).join() === 'sky_burials_active,sky_burials_charnel_grounds,can_build_towers_of_silence_active', `doctrines: the parameters 1.20 added join the mod's own, which stay in their place: ${JSON.stringify(sky.v)}`);
    const lgs = parse(readPatch('common/law_groups/old_mod_1_20_fixes_law_groups.txt'));
    const lgBody = (name: string): PNode[] => (lgs.find((n) => n.k === name)?.v as PNode[] | undefined) ?? [];
    check(lgBody('crown_authority').some((c) => c.k === 'required_government_flag') && !lgBody('om_law_group').some((c) => c.k === 'required_government_flag'), 'law groups: crown_authority is gated by the government as the game’s is; the mod’s own group is not');
    check(/piety_level_4 = \{\n\thide_effects = yes\n\tpersonal_tenet_slot_add = 1\n\}/.test(readPatch('common/modifiers/om_piety_levels.txt')), 'modifiers: the piety level gets its personal tenet slot');
    check(/is_holy_relic = \{\s*scope:artifact = \{ exists = var:relic_religion \}\s*religion = scope:artifact\.var:relic_religion\s*\}/.test(readPatch('common/artifacts/templates/om_templates.txt')), 'artifact templates: is_holy_relic');
    const gainNote = (label: string): string => r.notes.find((n) => n.startsWith(label)) ?? '';
    check(
        /: 3 definitions, 2 files$/.test(gainNote('Tenets the game defines too')) && /: 2 definitions, 1 file$/.test(gainNote('Doctrines the game defines too')) && /: 1 definition, 1 file$/.test(gainNote('Doctrine groups the game defines too')) &&
            /: 1 definition, 1 file$/.test(gainNote('Law groups the game defines too')) && /: 1 definition, 1 file$/.test(gainNote('Modifiers the game defines too')) && /: 1 definition, 1 file$/.test(gainNote('Artifact templates the game defines too')),
        `the notes count the definitions and files of each gain rule (tenets: legalism, literalism and the card-written asceticism in two files; doctrines: polygamy, sky burial): ${r.notes.filter((n) => n.includes('game defines too')).join(' | ')}`);

    // (calls of the data system: found in the expressions in brackets, not by the text)
    const calls = readPatch('gui/om_calls.gui');
    check(calls.includes('onclick = "[ClearExploredRealms]"') && calls.includes("onclick = \"[OpenGameViewData( 'succession_law_change', GuiLawGroup.Self )]\"") && calls.includes("onclick = \"[OpenGameViewData( 'title_election', Title.Self )]\"") && calls.includes("onclick = \"[OpenGameView( 'designate_heir' )]\"") && calls.includes("down = \"[IsGameViewDataShown( 'title_view_window', HolyOrder.GetTitle )]\" onclick = \"[OpenGameViewData( 'title_view_window', HolyOrder.GetTitle )]\""), `interface calls: renamed functions, a call given other arguments, a bare function called:\n${calls}`);
    check(calls.includes('# [ClearExploringHouses] in a comment stays') && calls.includes('text = "ClearExploringHouses is only a word here, [Title.GetStateRite.GetIcon] is a call, [GetStateFaithList] is not"'), 'a word in a comment, in the text outside the brackets, a longer name: left as written');
    check(!calls.includes('StraitMapIcon') && calls.includes("visible = \"[And( Government.HasMechanic( 'administrative' ), Government.HasRule( 'merit' ) )]\""), 'a property that is nothing but a removed call goes; HasRule( \'administrative\' ) is HasMechanic, other rules stay');
    check(calls.includes('\tdatacontext = "[RulerDesignerWindow.GetRite.GetFaith]"') && calls.includes('ObjectsEqual( Faith.Self, RulerDesignerWindow.GetRite.GetFaith )'), 'the ruler designer’s faith is its rite’s faith');
    check(calls.includes('blockoverride "faith_context"\r\n\t\t{\r\n\t\t\tdatacontext = "[RulerDesignerWindow.GetRite]"\r\n\t\t}') && calls.includes('datacontext = "[Accolade.GetAcclaimedKnight.GetFaith]"\r\n\t\t\tdatacontext = "[Accolade.GetAcclaimedKnight.GetRite]"\r\n') && (calls.match(/GetPlayer\.GetRite/g) ?? []).length === 1, 'in faith_context: the designer supplies its rite, a faith gets the rite as a sibling (CRLF kept), one that has it is left');
    check(calls.includes("datacontext = \"[GetDoctrineType('doctrine_monogamy')]\"") && calls.includes("datacontext = \"[GetTenetType('tenet_pacifism')]\"") && calls.includes('[DoctrineType.GetNameNoTooltip( Faith.Self )] [GreatProjectType.GetIllustration]') && !/[^\r]\n/.test(calls), 'FaithDoctrine: a doctrine and a tenet by where they are defined; a call without a mapping stays; CRLF kept');
    const locEn = readPatch('localization/replace/english/om_calls_l_english.yml');
    check(locEn.startsWith('﻿l_english:') && locEn.includes(' OM_STATE: "Rite: [Title.GetStateRite.GetName] [GetCountiesOfStateRite]"\n') && locEn.includes(" OM_DOC: \"[GetDoctrineType('doctrine_monogamy').GetBaseName] [GetTenetType('tenet_pacifism').GetName( GetPlayer.GetRite )] [DoctrineType.GetEffectsDescription( GetPlayer.GetRite )] [DoctrineType.GetDescription( GetPlayer.GetFaith )|F]\"\n"), `localization: renamed functions inside the brackets, a tenet’s name and an effects description take the rite:\n${locEn}`);
    check(locEn.includes(' OM_PLAIN: "GetStateFaith and FAITH_DOCTRINE are only words here"\n') && locEn.includes(' OM_SCOPE: "[DOCTRINE_TYPE.GetName( FAITH.Self )]#! [FAITH.GetName]"\n') && locEn.includes('\n #OM_COMMENT: "[GetStateFaith]"\n'), 'localization: words outside the brackets and a comment line stay, the FAITH_DOCTRINE scope is DOCTRINE_TYPE');
    check(!locEn.includes('FAITH_DOCTRINE_GENERAL_TOOLTIP') && locEn.includes(' OM_CREATE: "[RiteCreationWindow.CalcPietyCost|V0] [FaithCreationDoctrineItem.GetBlockers]"\n') && locEn.includes(' OM_PHASE: "[ActivityPhase.GetDescription( Activity.Self )] [ActivityPhase.GetDescription( Activity.Self )]"\n'), 'localization: a key the game restructured goes (its text shows), a function with no replacement stays in a key the game lacks, an argument is added once');
    check(readPatch('localization/replace/french/om_calls_l_french.yml') === '﻿l_french:\r\n OM_STATE: "[Title.GetStateRite.GetName]"\r\n OM_KEEP: "Texte"\r\n', 'a French file: the same rules, CRLF and byte order mark kept, the restructured key gone');
    check(r.notes.some((n) => /localization keys? goes? from the patch mod/.test(n) && n.includes('FAITH_DOCTRINE_GENERAL_TOOLTIP')) && r.notes.some((n) => /sites? stays? as written/.test(n) && n.includes('GreatProjectType.GetIllustration')) && r.notes.some((n) => /sites? stays? as written/.test(n) && n.includes('OM_CREATE')), `notes: ${r.notes.filter((n) => /as written|goes? from/.test(n)).join(' | ')}`);

    // (what no rule maps is left as written and told: a removed call in a larger expression, a doctrine not named by a string, a tenet's name with no rite)
    const calls2 = readPatch('gui/om_calls2.gui');
    check(calls2.includes('[And( StraitMapIcon.ShouldBeShown, Foo )]') && calls2.includes("[GetFaithDoctrine( Foo ).GetName( GetPlayer.GetFaith )] [GetTenetType('tenet_a').GetName]") && calls2.includes('container = { datacontext = "[Foo.GetFaith]" }') && !calls2.includes('GetRite'), `unmapped sites stay, a block nested in faith_context gets no sibling:\n${calls2}`);
    check(['StraitMapIcon.ShouldBeShown', 'GetFaithDoctrine', 'GetName'].every((w) => r.notes.some((n) => /sites? stays? as written/.test(n) && n.includes('om_calls2.gui') && n.includes(w))), `notes tell the unmapped sites: ${r.notes.filter((n) => n.includes('om_calls2')).join(' | ')}`);
    check(locEn.includes(` OM_TRAIL: "[GetDoctrineType('doctrine_x').GetName( GetPlayer.GetFaith )]" # "note [GetStateFaith]"\n`), 'localization: a comment after the text is not read, even with a quote in it');
    check(locEn.includes(' ADD_TENET_GLOBAL_DESC: "Gains: [TENET_TYPE.GetName( FAITH.GetMainRite )]"\n'), 'localization: a key the game has, whose text uses TENET_TYPE, gets that scope');
    check(existsSync(join(patchDir, 'gui', 'om_script_widget.gui')) === false && readPatch('gui/om_faith_extras.gui') === '', 'a type an event names by script is not emptied with the window that used it');

    // (the interface the game's windows use: types its copies lack, files nothing uses, restores offered)
    const typesText = readPatch('gui/zz_old_mod_1_20_fixes_types.gui');
    const typeGroups = parseGui(typesText).filter((n) => n.key === 'types');
    check(typeGroups.some((g) => g.name === 'Lists' && g.children?.some((c) => c.name === 'hbox_sort_tenets')) && typesText.includes('# Reusable tenet sort controls') && typesText.startsWith('﻿# '), `types: the tenet sort bar comes back from the game's lists.gui, in its group, with its comments (${typeGroups.map((g) => g.name).join(', ')})`);
    // (om_tip_kind and om_tip_template were defined only by the mod's own copy of cooltip.gui (the mod's additions, no game type under another name) that the patch
    // mod's restore of the game's file hides: they are carried with the mod's body, in the group the copy had, a template beside its types)
    check(typeGroups.some((g) => g.name === 'OmTips' && g.children?.some((c) => c.name === 'om_tip_kind')) && /types OmTips\s*\{\s*type om_tip_kind = widget\s*\{\s*size = \{ 4 4 \}\s*\}\s*\}\s*template om_tip_template\s*\{\s*size = \{ 3 3 \}\s*\}/.test(typesText), `types: the mod’s own om_tip_kind and om_tip_template are carried from its copy of cooltip.gui, in their group (${typesText.slice(typesText.indexOf('types OmTips'), typesText.indexOf('types OmTips') + 160).replace(/\r?\n/g, '↵')})`);
    check(readPatch('gui/om_faith_extras.gui') === '' && !existsSync(join(patchDir, 'gui', 'om_unused.gui')) && readPatch('gui/om_calls.gui').length > 100, 'a file only the mod’s own faith window used is emptied, one nothing ever used and one with a window of its own are left');
    check(r.notes.some((n) => /interface files? is emptied|gui\/om_faith_extras\.gui is emptied/.test(n)) && r.notes.some((n) => /types? (and templates )?the game’s windows use/.test(n) && n.includes('hbox_sort_tenets')), `notes: ${r.notes.filter((n) => /emptied|windows use/.test(n)).join(' | ').slice(0, 400)}`);
    check(r.notes.some((n) => /^The important action om_open_faith opens the faith window, whose interface the mod added \(.*om_faith_extra.*gui\/om_faith_extras\.gui\) the patch mod no longer carries/.test(n)) && !r.notes.some((n) => /important actions? /.test(n) && n.includes('om_other')) && r.notes.some((n) => /^gui\/om_faith_extras\.gui is emptied, and the scripted GUI om_faith_sg of the mod/.test(n)), `notes for the script that leads to the interface the restore removed: ${r.notes.filter((n) => /important action|scripted GUI/.test(n)).join(' | ')}`);
    const offers = new Map((plan.optional ?? []).map((o) => [o.rel, o]));
    check(offers.get('gui/window_my_realm.gui')?.names.includes('GetRemovedThing') && (offers.get('gui/window_my_realm.gui')?.custom ?? 0) >= 3 && offers.has('gui/window_ledger.gui') && !offers.has('gui/window_domicile.gui') && !offers.has('gui/window_faith.gui'), `offered: a copy calling a name the game does not know, one with a call no rewrite maps; not a copy that is clean, not one already restored (${[...offers.keys()].join(', ')})`);

    // (what the restore of the tooltips file took away: a type and a template loaded files still use: told for each user, the copy of a game window offered;
    // hooks: a type that overrides hooks its older base lacks is written with the game's base inlined, an override on a type of an older copy is told, the copy offered)
    const logOffer = offers.get('gui/window_activity_log.gui');
    const typesNotes = (plan.rewrites ?? []).filter((x) => x.kind === 'guiTypes').flatMap((x) => x.notes ?? []);
    check(typesNotes.some((n) => /^om_tip_kind \(type\) from the mod’s copy of gui\/shared\/cooltip\.gui, line \d+ \(the patch mod hides that copy\), used by gui\/om_tip_user\.gui/.test(n))
        && typesNotes.some((n) => /^om_tip_template \(template\) from the mod’s copy of gui\/shared\/cooltip\.gui, line \d+ \(the patch mod hides that copy\), used by .*gui\/window_activity_log\.gui/.test(n))
        && !r.notes.concat(plan.notes ?? [], typesNotes).some((n) => n.includes('om_tip_') && /unknown type|the game’s file in the patch mod does not/.test(n)), `lost types: the plan tells where each carried type comes from and who uses it, and none is left lost: ${typesNotes.filter((n) => n.includes('om_tip_')).join(' | ')}`);
    check(!logOffer && !offers.has('gui/om_tip_user.gui') && !offers.has('gui/shared/cooltip.gui'), `lost types: nothing is lost, so the copy of the game window that uses them is not offered, nor is the mod’s own file (${JSON.stringify(logOffer)})`);
    check(typesText.includes('type coa_house_sigil = widget') && !typesText.includes('= coa_character_sigil') && /block "sigil_coa"\s*\{\s*visible = "\[Character\.GetHouse\.IsValid\]"/.test(typesText) && typesText.includes('# CrusaderPope: the mod\'s older coa_character_sigil lacks the hooks this type overrides (sigil_coa, sigil_lowborn_visible)'), `hooks: the house sigil type is written with the game's base inlined, the overrides in the blocks:\n${typesText.slice(typesText.indexOf('types CoATypes'), typesText.indexOf('types CoATypes') + 700)}`);
    check(r.notes.some((n) => n.includes('coa_house_sigil') && n.includes('coa_character_sigil') && n.includes('sigil_coa')) && !r.notes.some((n) => n.includes('sigil_coa') && n.includes('land on nothing')), `hooks: the inlined type is told, its hooks are declared again (${r.notes.filter((n) => n.includes('sigil')).join(' | ')})`);
    const hookOffer = offers.get('gui/achievements/jomini_achievements_types.gui');
    check(r.notes.some((n) => n.includes('gui/achievements/jomini_achievements_types.gui') && n.includes('achievement_icon') && n.includes('achievement_description') && n.includes('gui/om_hook_user.gui') && n.includes('land on nothing')) && !r.notes.some((n) => n.includes('gui/shared/coat_of_arms.gui') && n.includes('land on nothing')), `hooks: overrides that land on nothing are told for the file whose game version declares the hooks: ${r.notes.filter((n) => n.includes('land on nothing')).join(' | ')}`);
    check(hookOffer && hookOffer.reasons.some((x) => x.includes('achievement_description, achievement_icon')), `hooks: that copy is offered with the hooks as the reason (${JSON.stringify(hookOffer)})`);

    // (religions: the settings 1.20 reads from religion_details moved there; families and religions: the four banner keys)
    const religionFiles = readdirSync(join(patchDir, 'common', 'religion', 'religion_types')).filter((n) => /\.txt$/i.test(n));
    const religions = religionFiles.flatMap((n) => parse(readPatch(`common/religion/religion_types/${n}`)).filter((d) => d.k && Array.isArray(d.v)));
    check(['om_religion', 'om_plain_religion', 'om_details_religion', 'om_crlf_religion', 'om_modern_religion'].every((n) => religions.some((d) => d.k === n)) && religions.every((d) => !(d.v as { k: string | null; }[]).some((c) => c.k && RELIGION_DETAIL_KEYS.includes(c.k))), `no religion of the patch mod has family, graphical_faith … at its top (${religions.map((d) => d.k).join(', ')})`);
    const plain = readPatch('common/religion/religion_types/om_more_religions.txt');
    check(plain.includes('om_plain_religion = {\n\t# the family\n\treligion_details = {\n\t\tfamily = rf_om_banner # of the banner\n\t\tgraphical_faith = orthodox_gfx\n\t\tpiety_icon_group = "christian"\n\t\ttenet_background_icon = core_tenet_banner_om\n\t\ttenet_heretical_background_icon = ') && plain.includes('\t}\n\tdoctrine = doctrine_monotheist\n\n\ttraits = {'), `a religion: the block at the first setting’s place, comments with them, the banner it ships carried into the four keys:\n${plain}`);
    check(/om_details_religion = \{\s*religion_details = \{\s*family = rf_om_none\s*theocracy_government_type = theocracy_government\s*\}\s*pagan_roots = yes\s*\}/.test(plain) && !plain.includes('core_tenet_banner_vanilla_christian'), 'a religion with religion_details: the settings join its block; a banner it does not ship goes (its family’s applies), nothing else is set');
    check(plain.includes('om_modern_religion = {\n\treligion_details = {\n\t\tfamily = rf_om_done\n\t\tgraphical_faith = orthodox_gfx\n\t}\n\tdoctrine = doctrine_monotheist\n}\n'), 'a religion in the 1.20 form is as it was');
    check(readPatch('common/religion/religion_types/om_crlf_religion.txt') === '﻿om_crlf_religion = {\r\n\treligion_details = {\r\n\t\tfamily = rf_om_none\r\n\t\tgraphical_faith = orthodox_gfx\r\n\t}\r\n\tdoctrine = doctrine_monotheist\r\n}\r\n', 'a religion file with CRLF and a byte order mark keeps both');
    check(/om_religion = \{\s*religion_details = \{\s*family = rf_abrahamic\s*\}\s*doctrine = doctrine_monotheist\s*\}/.test(readPatch('common/religion/religion_types/om_religions.txt')), 'a religion whose faiths moved out: its family in religion_details too (one fix)');
    const gameFamilies = readFileSync(join(gameDir, 'common', 'religion', 'religion_family_types', '00_religion_family_types.txt'), 'utf8');
    const gameBanner = (k: string): string => new RegExp(`\\b${k} = (\\w+)`).exec(gameFamilies)![1];
    const fam = parse(readPatch('common/religion/religion_family_types/om_families.txt'));
    const famVal = (name: string, k: string): string | undefined => (fam.find((d) => d.k === name)?.v as { k: string | null; v: unknown; }[] | undefined)?.find((c) => c.k === k)?.v as string | undefined;
    const banners = ['tenet_background_icon', 'tenet_heretical_background_icon', 'tenet_neutral_background_icon', 'tenet_unknown_background_icon'];
    const complete = (name: string): boolean => banners.slice(1).every((k) => famVal(name, k) === gameBanner(k)) && !!famVal(name, 'tenet_background_icon');
    check(['rf_om_banner', 'rf_om_plain', 'rf_om_nosmall', 'rf_om_none', 'rf_om_done', 'rf_om_half'].every(complete) && fam.every((d) => !(d.v as { k: string | null; }[]).some((c) => c.k === 'doctrine_background_icon')), `every family has the four keys, the game’s values, and none the old key:\n${readPatch('common/religion/religion_family_types/om_families.txt')}`);
    check(famVal('rf_om_banner', 'tenet_background_icon') === 'core_tenet_banner_om' && famVal('rf_om_plain', 'tenet_background_icon') === gameBanner('tenet_background_icon') && famVal('rf_om_nosmall', 'tenet_background_icon') === gameBanner('tenet_background_icon') && famVal('rf_om_half', 'tenet_background_icon') === 'tenet_banner_known_core', 'the banner the mod ships is carried; one it does not ship, or without a small variant, is the game’s; a key the family has stays');
    const famText = readPatch('common/religion/religion_family_types/om_families.txt');
    check(famText.includes('\t# the banner the mod ships\n\ttenet_background_icon = core_tenet_banner_om\n') && /tenet_background_icon = \w+ # the game's 1\.19 banner\n\ttenet_heretical/.test(famText) && famText.includes('rf_om_plain = {\n\tpiety_icon_group = "pagan"\n\ttenet_background_icon = '), 'the family’s comments stay where they were');
    const tenetIcons = join(patchDir, 'gfx', 'interface', 'icons', 'faith_tenets');
    check(existsSync(join(tenetIcons, 'core_tenet_banner_om.dds')) && existsSync(join(tenetIcons, 'core_tenet_banner_om_small.dds')) && !existsSync(join(tenetIcons, 'core_tenet_banner_nosmall.dds')) && readFileSync(join(tenetIcons, 'core_tenet_banner_om_small.dds'), 'utf8') === '﻿DDS banner small', 'the banner the mod ships is brought into faith_tenets with its small variant; the one without a small variant is not');
    check(r.notes.some((n) => /Tenet banners carried into/.test(n) && n.includes('core_tenet_banner_om.dds')) && r.notes.some((n) => /tenet banners? the mod names/.test(n) && n.includes('core_tenet_banner_christian') && n.includes('core_tenet_banner_nosmall')), `notes: ${r.notes.filter((n) => /banner/.test(n)).join(' | ')}`);

    const modAfter = files(root);
    check(modAfter.size === modBefore.size && [...modBefore].every(([k, v]) => modAfter.get(k) === v), "the mod's own files unchanged");

    await reindex();
    check(idx.get('faith', 'om_faith') && idx.get('law_groups', 'om_law_group') && idx.get('laws', 'om_law_b'), 'the index reads the faith, the law group and its laws');
    const catholic = idx.get('faith', 'catholic');
    check(!catholic || catholic.defs.every((d) => idx.files[d.file].hidden?.how === 'replace_path'), "the game's faiths hidden (faith_types replaced)");
    const again = await planMigration(host, 'mod/old_mod.mod');
    check(!again.findings.some((f) => f.fix), `plan afterwards: ${again.findings.filter((f) => f.fix).map((f) => f.name).join(', ') || 'nothing to fix'}`);

    // (a second run: every file rule done, the patch mod known to be made for this game)
    const kinds = new Set((again.rewrites ?? []).map((x) => x.kind));
    check(kinds.size === 15 + (kinds.has('inert') ? 1 : 0) && (again.rewrites ?? []).every((x) => x.files.length > 0 && x.todo.length === 0), `the plan of a second run: every rule done (${(again.rewrites ?? []).map((x) => `${x.kind} ${x.files.length - x.todo.length}/${x.files.length}`).join(', ')})`);
    check(again.patchMod?.builtFor === state.gameVersion && !again.patchMod?.outdated && !again.replacePathsTodo?.length, `the patch mod was made for ${again.patchMod?.builtFor}; folders hidden already`);
    const patchBefore = files(patchDir);
    const manifestFile = join(patchDir, '.crusaderpope-fixes.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { game?: string; restored: Record<string, string>; };
    const gameHash = (rel: string): string => sha1(readFileSync(join(gameDir, ...rel.split('/'))));
    check(manifest.game === state.gameVersion && manifest.restored['gui/window_faith.gui'] === gameHash('gui/window_faith.gui') && Object.keys(manifest.restored).length >= 4, `the manifest: game ${manifest.game}, ${Object.keys(manifest.restored).length} restored files hashed`);
    // (a banner texture carried to the version's folder has the old folder's file as its source: the mod updating it reaches the copy)
    const carriedSrc = (JSON.parse(readFileSync(manifestFile, 'utf8')) as { sources?: Record<string, { from: string; }>; }).sources?.['gfx/interface/icons/faith_tenets/core_tenet_banner_om.dds'];
    check(carriedSrc?.from === 'gfx/interface/icons/om_banners/core_tenet_banner_om.dds', `the carried banner texture records the mod's file it was taken from (${JSON.stringify(carriedSrc)})`);
    const r2 = await migrateMod(host, 'mod/old_mod.mod');
    const lists = (await modsState(host)).lists.filter((l) => l.kind === 'custom');
    check(r2.patch.id === r.patch.id && !r2.copied.length && !r2.fixed.length && !r2.rewritten.length && lists.length === 1, 'a second run: the same patch mod and list, nothing copied, fixed or rewritten');
    check(r2.notes.some((n) => /^The important action om_open_faith opens the faith window/.test(n)) && r2.notes.some((n) => /^gui\/om_faith_extras\.gui is emptied, and the scripted GUI om_faith_sg/.test(n)), `a second run tells the lost interface again: ${r2.notes.filter((n) => /important action|scripted GUI/.test(n)).join(' | ')}`);
    const patchAfter = files(patchDir);
    check(patchAfter.size === patchBefore.size && [...patchBefore].every(([k, v]) => patchAfter.get(k) === v), 'a second run: no file of the patch mod changed (manifest included)');

    // (a change of the app's language: the files the rules generate carry no translated text, so a run in another language has
    // nothing to write: the headers of the zz_ files, the types file and the library files are fixed English)
    const header = readFileSync(join(patchDir, 'common', 'game_concepts', 'zz_old_mod_1_20_fixes_game_concepts.txt'), 'utf8');
    setLocale('qps');
    const pseudoPlan = await planMigration(host, 'mod/old_mod.mod');
    const pseudoRun = await migrateMod(host, 'mod/old_mod.mod');
    setLocale('en');
    const patchPseudo = files(patchDir);
    check(
        (pseudoPlan.rewrites ?? []).every((x) => x.todo.length === 0) && !pseudoRun.rewritten.length && patchPseudo.size === patchBefore.size && [...patchBefore].every(([k, v]) => patchPseudo.get(k) === v) && !header.includes('⟦') && /^﻿?# common\/game_concepts — merged by CrusaderPope\r?\n/.test(header),
        `a run in another language writes nothing, the generated headers are English (${(pseudoPlan.rewrites ?? []).filter((x) => x.todo.length).map((x) => x.kind).join(', ')}${pseudoRun.rewritten.join(', ')})`
    );

    // (the game changed a file the patch mod carries since: its copy is the old game's: refreshed; one changed by hand
    // stays; a copy from before the manifest that differs is refreshed; the plan says the patch mod is for another game)
    const winCopy = join(patchDir, 'gui', 'window_faith.gui');
    const handCopy = join(patchDir, 'gfx', 'FX', 'pdxmesh.shader');
    const oldCopy = join(patchDir, 'gfx', 'FX', 'jomini', 'portrait.shader');
    const olderGame = '# the game window of an older build\n';
    writeFileSync(winCopy, olderGame);
    writeFileSync(handCopy, '# edited by hand\n');
    writeFileSync(oldCopy, '# a copy from before the manifest\n');
    delete manifest.restored['gfx/FX/jomini/portrait.shader'];
    manifest.restored['gui/window_faith.gui'] = sha1(Buffer.from(olderGame));
    manifest.game = '1.20.0.4';
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const stalePlan = await planMigration(host, 'mod/old_mod.mod');
    const restoreTodo = stalePlan.rewrites!.filter((x) => x.kind === 'restore' || x.kind === 'mergefx').flatMap((x) => x.todo);
    check(stalePlan.patchMod?.outdated && stalePlan.patchMod.builtFor === '1.20.0.4', 'the plan: the patch mod was made for 1.20.0.4');
    check(restoreTodo.length === 2 && restoreTodo.includes('gui/window_faith.gui') && restoreTodo.includes('gfx/FX/jomini/portrait.shader') && stalePlan.rewrites!.filter((x) => x.kind !== 'restore' && x.kind !== 'mergefx').every((x) => x.todo.length === 0), `the plan: the two stale copies to do (${restoreTodo.join(', ')}), the hand-edited one and the other rules done`);
    const rStale = await migrateMod(host, 'mod/old_mod.mod');
    check(rStale.rewritten.length === 2 && same('gui/window_faith.gui') && same('gfx/FX/jomini/portrait.shader', join(install, 'jomini')), `stale copies copied again: ${rStale.rewritten.join(', ')}`);
    check(readFileSync(handCopy, 'utf8') === '# edited by hand\n', 'the copy changed by hand stays');
    check(rStale.notes.some((n) => /copied again/.test(n) && n.includes('window_faith.gui')) && rStale.notes.some((n) => /changed by hand/.test(n) && n.includes('pdxmesh.shader')), `notes: ${rStale.notes.filter((n) => /again|by hand/.test(n)).join(' | ')}`);
    const manifest2 = JSON.parse(readFileSync(manifestFile, 'utf8')) as { game?: string; restored: Record<string, string>; };
    check(manifest2.game === state.gameVersion && manifest2.restored['gui/window_faith.gui'] === gameHash('gui/window_faith.gui') && manifest2.restored['gfx/FX/pdxmesh.shader'] === gameHash('gfx/FX/pdxmesh.shader'), 'the manifest: the new game, the refreshed hash, the hand-edited copy’s record kept');
    const rStale2 = await migrateMod(host, 'mod/old_mod.mod');
    check(!rStale2.rewritten.length && readFileSync(handCopy, 'utf8') === '# edited by hand\n', 'and again: nothing written, the hand-edited copy still kept');
    writeFileSync(handCopy, readFileSync(join(gameDir, 'gfx', 'FX', 'pdxmesh.shader')));

    // (a game update that touched none of the files the patch mod carries: the manifest names the older game, but every
    // copy is the game's: nothing to run, so no warning that cannot be cleared)
    const manifest3 = JSON.parse(readFileSync(manifestFile, 'utf8')) as { game?: string; restored: Record<string, string>; };
    manifest3.game = '1.20.0.4';
    writeFileSync(manifestFile, JSON.stringify(manifest3, null, 2));
    const quiet = await planMigration(host, 'mod/old_mod.mod');
    check(quiet.patchMod?.builtFor === '1.20.0.4' && !quiet.patchMod.outdated && (quiet.rewrites ?? []).every((x) => x.todo.length === 0), 'the game is another version, no carried file differs: the patch mod is not outdated, every rule done');
    // (which rules count as built from the game's files: each kind with work left does, the mod's own rewrites and a finished rule do not)
    {
        const kinds = ['restore', 'mergefx', 'merge', 'defines', 'libraries', 'guiTypes', 'gains'];
        check(kinds.every((k) => carriesGameFiles([{ kind: k, todo: ['a'] }]) && !carriesGameFiles([{ kind: k, todo: [] }])), 'outdated: every rule kind built from the game’s files counts with work left, none without');
        check(!['rename', 'rewrite', 'statements', 'adds', 'icons', 'banners', 'dataCalls'].some((k) => carriesGameFiles([{ kind: k, todo: ['a'] }])), 'outdated: the mod’s own rewrites do not count');
    }

    // (a merged shader file: changed by hand it stays; the plain game file an older run left, the file of a game that changed since
    // and the file made from a mod include that changed since are written anew; a second run writes nothing)
    {
        const rel = 'gfx/FX/river_surface.shader';
        const file = join(patchDir, ...rel.split('/'));
        const merged0 = readFileSync(file);
        const mf = (): { game?: string; restored: Record<string, string>; merged: Record<string, { game: string; mod: string; out: string; }>; } => JSON.parse(readFileSync(manifestFile, 'utf8'));
        const todoOf = async (): Promise<string[]> => (await planMigration(host, 'mod/old_mod.mod')).rewrites!.filter((x) => x.kind === 'mergefx').flatMap((x) => x.todo);
        writeFileSync(file, Buffer.concat([merged0, Buffer.from('# by hand\n')]));
        const rHand = await migrateMod(host, 'mod/old_mod.mod');
        check(!(await todoOf()).includes(rel) && !rHand.rewritten.includes(rel) && readFileSync(file, 'utf8').endsWith('# by hand\n') && rHand.notes.some((n) => /changed by hand/.test(n) && n.includes('river_surface.shader')), `a merged file changed by hand is kept: ${rHand.notes.filter((n) => /by hand/.test(n)).join(' | ')}`);
        check(mf().merged[rel]?.out === sha1(merged0), 'and its record is still the one written');
        // (the plain game file an older run left: its hash in `restored`)
        writeFileSync(file, readFileSync(join(gameDir, 'gfx', 'FX', 'river_surface.shader')));
        const m1 = mf();
        delete m1.merged[rel];
        m1.restored[rel] = sha1(readFileSync(file));
        writeFileSync(manifestFile, JSON.stringify(m1, null, 2));
        check((await todoOf()).join() === rel, 'the plan: the plain game file an older run left is to be written again');
        const rUp = await migrateMod(host, 'mod/old_mod.mod');
        check(rUp.rewritten.join() === rel && readFileSync(file).equals(merged0) && mf().merged[rel]?.out === sha1(merged0) && !mf().restored[rel] && rUp.notes.some((n) => /shader file the patch mod carries was written again/.test(n)), `upgraded to the merged file: ${rUp.rewritten.join(', ')}`);
        // (a file of a game that changed since: the copy is what was written, the output differs now)
        writeFileSync(file, '# the merge of an older game\n');
        const m2 = mf();
        m2.merged[rel] = { game: sha1(Buffer.from('older')), mod: m2.merged[rel].mod, out: sha1(readFileSync(file)) };
        writeFileSync(manifestFile, JSON.stringify(m2, null, 2));
        const rOld = await migrateMod(host, 'mod/old_mod.mod');
        check(rOld.rewritten.join() === rel && readFileSync(file).equals(merged0) && mf().merged[rel].game === sha1(readFileSync(join(gameDir, 'gfx', 'FX', 'river_surface.shader'))), 'a copy that is what an older run wrote: written again with the game’s file now');
        // (the mod's include changed: the output differs, the copy is still what was written)
        const incFile = join(root, 'gfx', 'FX', 'om_river.fxh');
        const incText = readFileSync(incFile);
        writeFileSync(incFile, incText.toString('utf8').replace('0.5f', '0.6f'));
        check((await todoOf()).join() === rel, 'the plan: the mod’s own include changed: the merged file is to be written again');
        const rMod = await migrateMod(host, 'mod/old_mod.mod');
        check(rMod.rewritten.join() === rel && patchFx(rel).includes('#define OM_RIVER_STRENGTH 0.6f') && mf().merged[rel].mod !== m2.merged[rel].mod, `written again from the changed include: ${rMod.rewritten.join(', ')}`);
        writeFileSync(incFile, incText);
        const rBack = await migrateMod(host, 'mod/old_mod.mod');
        const rNone = await migrateMod(host, 'mod/old_mod.mod');
        check(rBack.rewritten.join() === rel && readFileSync(file).equals(merged0) && !rNone.rewritten.length && !(await todoOf()).length, 'and back; a second run writes nothing');
    }

    // (an entry written the old way only in the patch mod's copy of a file, as a run before a rule existed leaves it)
    const copy = join(patchDir, 'common', 'religion', 'doctrine_types', 'om_doctrines.txt');
    writeFileSync(copy, readFileSync(copy, 'utf8') + '\ntenet_om_left = {\n\tpiety_cost = { value = 0 }\n}\n');
    await host.refreshFiles!([copy]);
    const r3 = await migrateMod(host, 'mod/old_mod.mod');
    check(r3.fixed.some((f) => f.startsWith('tenet_om_left')), `a third run fixes what only the patch mod's copy has: ${r3.fixed.join(', ') || 'nothing'}`);

    // (an interface file the owner takes whole from the game: the game's, recorded, no longer offered, taken again in a run without the choice)
    {
        const gameRealm = readFileSync(join(gameDir, 'gui', 'window_my_realm.gui'));
        const rOpt = await migrateMod(host, 'mod/old_mod.mod', { restore: ['gui/window_my_realm.gui'] });
        check(readFileSync(join(patchDir, 'gui', 'window_my_realm.gui')).equals(gameRealm) && rOpt.rewritten.includes('gui/window_my_realm.gui') && (JSON.parse(readFileSync(join(patchDir, '.crusaderpope-fixes.json'), 'utf8')) as { optional?: string[]; }).optional?.join() === 'gui/window_my_realm.gui', 'a chosen interface file is the game’s own in the patch mod, recorded in the manifest');
        // (and the types of that window come back with it: the types file no longer has them: a name is defined once)
        const typesNow = readPatch('gui/zz_old_mod_1_20_fixes_types.gui');
        check(typesNow.includes('hbox_sort_tenets') && !/icon_title_succession|container_my_realm_window_contribution_tooltip|fixedgridbox_compact_subjects/.test(typesNow), 'a restored window brings its types: the types file drops them (no type registered twice)');
        const planOpt = await planMigration(host, 'mod/old_mod.mod');
        check(!(planOpt.optional ?? []).some((o) => o.rel === 'gui/window_my_realm.gui') && (planOpt.optional ?? []).some((o) => o.rel === 'gui/window_ledger.gui') && (planOpt.rewrites ?? []).every((x) => x.todo.length === 0), `afterwards it is offered no more, the other still is, nothing is left to do (${(planOpt.rewrites ?? []).filter((x) => x.todo.length).map((x) => x.kind).join(', ')})`);
        const rAgain = await migrateMod(host, 'mod/old_mod.mod');
        check(readFileSync(join(patchDir, 'gui', 'window_my_realm.gui')).equals(gameRealm) && rAgain.rewritten.length === 0, `a run without the choice keeps it taken and writes nothing (${rAgain.rewritten.join(', ')})`);
    }

    // (the patch mod deleted while the index still holds its fixed copies (the owner's rebuild): the plan made before
    // the patch mod is made again marks nothing; the run must plan again on the new index)
    rmSync(patchDir, { recursive: true, force: true });
    rmSync(join(tmp, 'mod', 'old_mod_1_20_fixes.mod'), { force: true });
    const r4 = await migrateMod(host, 'mod/old_mod.mod');
    check(r4.fixed.length >= r.fixed.length - 1 && r4.copied.length === r.copied.length, `a rebuild after deleting the patch mod (stale index): ${r4.fixed.length} fixes, ${r4.copied.length} files copied (first run: ${r.fixed.length}, ${r.copied.length})`);

    // (a second mod with no trait that has a faith_modifier, a rename without definedParameter (the holy site's) before the buildings'
    // rules with it: the parameters the game defines are still known, the temple modifiers stay)
    {
        const root2 = join(tmp, 'mod', 'old_mod2');
        const put2 = (rel: string, text: string): void =>
        {
            mkdirSync(join(root2, rel, '..'), { recursive: true });
            writeFileSync(join(root2, rel), '﻿' + text);
        };
        mkdirSync(root2, { recursive: true });
        writeFileSync(join(root2, 'descriptor.mod'), 'version="1.0"\nname="Old Mod Two"\nsupported_version="1.19.0.6"\n');
        writeFileSync(join(tmp, 'mod', 'old_mod2.mod'), `version="1.0"\nname="Old Mod Two"\nsupported_version="1.19.0.6"\npath="${root2.replace(/\\/g, '/')}"\n`);
        put2('common/religion/holy_site_types/om2_sites.txt', 'om2_site = {\n\tcharacter_modifier = {\n\t\tmonthly_piety = 0.1\n\t}\n}\n');
        put2('common/buildings/om2_buildings.txt', 'om2_temple_01 = {\n\tprovince_faith_modifier = {\n\t\tparameter = basic_pilgrimage_rewards\n\t\tmonthly_piety = 0.1\n\t}\n\tcounty_faith_modifier = {\n\t\tparameter = om2_nowhere_defined\n\t\tmonthly_piety = 0.2\n\t}\n}\n');
        settings.customModLists![0].mods.push({ id: 'mod/old_mod2.mod', enabled: true });
        await reindex();
        const r5 = await migrateMod(host, 'mod/old_mod2.mod');
        const buildings2 = readFileSync(join(tmp, 'mod', 'old_mod2_1_20_fixes', 'common', 'buildings', 'om2_buildings.txt'), 'utf8');
        check(!r5.failed.length && /province_rite_modifier = \{\s*parameter = basic_pilgrimage_rewards/.test(buildings2) && !buildings2.includes('om2_nowhere_defined') && r5.notes.some((n) => n.includes('county_faith_modifier { parameter = om2_nowhere_defined }')), `a mod without a faith_modifier trait: the game's parameters are known, the undefined one goes:\n${buildings2}\n${r5.notes.join('\n')}`);
    }

    // (a third mod with older copies of game files that hide what 1.20 added to them, that other files still call: the library
    // rule carries those over: only what a loaded file names, and what that names in turn, across the folders)
    {
        const root3 = join(tmp, 'mod', 'old_mod3');
        const put3 = (rel: string, text: string): void =>
        {
            mkdirSync(join(root3, rel, '..'), { recursive: true });
            writeFileSync(join(root3, rel), '﻿' + text);
        };
        const desc3 = 'version="1.0"\nname="Old Mod Three"\nreplace_path="common/scripted_animations"\nreplace_path="common/dynasties"\nsupported_version="1.19.0.6"\n';
        mkdirSync(root3, { recursive: true });
        writeFileSync(join(root3, 'descriptor.mod'), desc3);
        writeFileSync(join(tmp, 'mod', 'old_mod3.mod'), `${desc3}path="${root3.replace(/\\/g, '/')}"\n`);
        // (the game's files of the same path, each with a trigger/effect/value of the mod's own and nothing of the game's)
        put3('common/scripted_triggers/00_weather_triggers.txt', 'om3_weather_trigger = { always = yes }\n');
        put3('common/scripted_triggers/00_building_requirement_triggers.txt', 'om3_building_trigger = { always = yes }\n');
        // (holding_is_tribal is the mod's own in another file of the folder: the game's is not added)
        put3('common/scripted_triggers/om3_own_triggers.txt', 'holding_is_tribal = { always = no }\n');
        put3('common/scripted_triggers/00_religious_triggers.txt', 'om3_religious_trigger = { always = yes }\n');
        put3('common/scripted_effects/00_religion_effects.txt', 'om3_religion_effect = { add_gold = 1 }\n');
        put3('common/script_values/02_religion_values.txt', 'om3_religion_value = 5\n');
        put3('common/event_themes/00_event_themes.txt', 'om3_theme = { icon = "gfx/x.dds" }\n');
        put3('common/event_backgrounds/01_event_backgrounds.txt', 'om3_background = { background = { reference = "gfx/x.dds" } }\n');
        // (the rules without can_edit_rite: the merge brings it, and it calls can_edit_rite_trigger)
        put3('common/scripted_rules/00_rules.txt', 'faith_conversion = {\n\tis_adult = yes\n}\n');
        // (a government the game's 1.20 file no longer has: the new 02_theocratic_government_types.txt defines it and loads later)
        // (and a holy order government without the flag 1.20 gave it, a trait without lowers_health: the flags loaded files test)
        put3('common/governments/00_government_types.txt', 'theocracy_government = {\n\tcreate_cadet_branches = no\n\tlegacy_government = yes\n}\n\nholy_order_government = {\n\tflags = {\n\t\tgovernment_uses_crown_authority\n\t\tcannot_be_vassal_or_liege\n\t\tgovernment_is_holy_order # comment\n\t}\n}\n\ncelestial_government = {\n\tflags = {\n\t\tgovernment_is_celestial\n\t}\n}\n');
        put3('common/traits/00_traits.txt', 'ill = {\n\thealth = -1\n\tcategory = health\n}\n');
        // (a flag the game tests only as `has_building_with_flag = { flag = x }`; a government flag that only a carried trigger tests:
        // 10_tgp_triggers.txt, the file that holds the trigger, is the mod's copy too, so no loaded file tests it; the mod's own file
        // of the folder that sorts after the library file)
        put3('common/buildings/00_special_buildings.txt', 'hoshi_ryokan_01 = {\n\ttype = special\n\tflag = om3_flag\n}\n');
        put3('common/scripted_triggers/10_tgp_triggers.txt', 'om3_tgp_trigger = { always = yes }\n');
        put3('common/governments/zzz_om3_governments.txt', 'om3_government = {\n\tflags = { om3_flag }\n}\n');
        // (a library file of another mod's patch mod, here the mod's own: its entry counts as defined)
        put3('common/scripted_triggers/zz_other_1_20_fixes_library.txt', 'holding_is_nomad = { always = yes }\n');
        // (on_actions of a game file the mod's copy hides, defined in no loaded file; a trigger/effect localization file of the older version)
        put3('common/on_action/religion_on_actions.txt', 'om3_on_action = { effect = { add_gold = 1 } }\n');
        put3('common/trigger_localization/00_character_triggers.txt', 'om3_trigger = {\n\tglobal = OM3_TRIGGER\n}\n');
        settings.customModLists![0].mods.push({ id: 'mod/old_mod3.mod', enabled: true });
        await reindex();
        const lib = (p: Awaited<ReturnType<typeof planMigration>>) => (p.rewrites ?? []).filter((x) => x.kind === 'libraries');
        const plan3 = await planMigration(host, 'mod/old_mod3.mod');
        const labels = lib(plan3).map((x) => x.label).join(' | ');
        check(['Scripted triggers', 'Scripted effects', 'Script values', 'Event themes', 'Event backgrounds', 'Scripted animations'].every((l) => lib(plan3).some((x) => x.label.startsWith(l + ':') && x.todo.length === 1)) && !/Scripted rules|Game concepts/.test(labels), `the plan: one entry per folder with something to carry (${labels})`);
        check(!!plan3.notes?.some((n) => n.includes('theocracy_government') && n.includes('02_theocratic_government_types.txt') && n.includes('00_government_types.txt')), `the plan: an entry the mod defines in its copy of a game file that the game moved to a new file that loads later: ${(plan3.notes ?? []).join(' | ')}`);
        const r6 = await migrateMod(host, 'mod/old_mod3.mod');
        const patch3 = join(tmp, 'mod', 'old_mod3_1_20_fixes');
        // (the library file of a folder: `zz_…`, with more z when a file of the mod sorts after it)
        const zzNames = (folder: string): string[] => (existsSync(join(patch3, ...folder.split('/'))) ? readdirSync(join(patch3, ...folder.split('/'))).filter((n) => /^zz+_old_mod3_1_20_fixes_library\.txt$/.test(n)) : []);
        const zz = (folder: string): string => zzNames(folder).map((n) => readFileSync(join(patch3, ...folder.split('/'), n), 'utf8')).join('');
        const defs = (text: string): string[] => [...text.matchAll(/^([A-Za-z0-9_]+) = /gm)].map((m) => m[1]);
        const gameDefs = (rel: string): Map<string, string> =>
        {
            const text = readFileSync(join(gameDir, ...rel.split('/')), 'utf8').replace(/^﻿/, '');
            return new Map(parse(text).filter((n) => n.k && !n.k.startsWith('@')).map((n) => [n.k!, text.slice(n.s, n.e)]));
        };
        const trig = zz('common/scripted_triggers');
        // (a) a trigger a loaded game file calls, defined in a game file the mod replaced
        check(trig.includes('current_season_wet_extended = {') && trig.includes(gameDefs('common/scripted_triggers/00_weather_triggers.txt').get('current_season_wet_extended')!), 'a trigger a loaded game file calls is carried over, as the game wrote it');
        // (a file of that name in the mod itself (the patch mod of another mod looks so) is a loaded file: its entry is defined)
        check(!defs(trig).includes('holding_is_nomad') && defs(trig).includes('current_season_wet_extended'), 'a zz_*_library.txt file that is not this patch mod’s own counts as loaded: what it defines is not carried again');
        // (b) the mod defines it in another file of the folder
        check(!defs(trig).includes('holding_is_tribal'), 'a name the mod defines in another file of the folder is not carried');
        // (and what nothing calls is not carried)
        const replacedTriggers = ['00_religious_triggers', '00_weather_triggers', '00_building_requirement_triggers', '10_tgp_triggers'].reduce((n, f) => n + gameDefs(`common/scripted_triggers/${f}.txt`).size, 0);
        check(!defs(trig).includes('faiths_are_eastern_zoroastrian') && !defs(trig).includes('faiths_are_in_muhakkima_islam_group') && defs(trig).length < replacedTriggers, `what nothing names stays out (${defs(trig).length} triggers carried of the replaced files’ ${replacedTriggers})`);
        // (c) a chain across folders: the effect an event calls, the trigger it needs, the script value another needs (with its file's constants)
        const fx = zz('common/scripted_effects');
        const vals = zz('common/script_values');
        check(defs(fx).includes('rite_growth_pick_founder_effect') && defs(trig).includes('is_eligible_rite_growth_founder_trigger') && defs(vals).includes('rite_growth_target_rite_count') && defs(vals).includes('rite_growth_counties_per_rite'), 'a chain: the effect that is called, the trigger it calls, a script value that calls another');
        check(/^@rite_growth_/m.test(vals) && defs(vals).filter((n) => !n.startsWith('@')).length > 5, `the script values come with the constants of their file: ${(vals.match(/^@\w+/gm) ?? []).join(', ')}`);
        // (flags) the game's flag a loaded file tests, added to the mod's entry of that name, after the comment of the list's last line
        const gov = zz('common/governments');
        check(gov.includes('\t\tgovernment_is_holy_order # comment\n\t\tgovernment_is_military_holy_order\n\t}') && gov.includes('holy_order_government = {') && !gov.includes('theocracy_government'), `a government gets the flag the game gave its entry of that name (a list, a line of its own after the comment): ${gov.replace(/\r?\n/g, '↵').slice(0, 400)}`);
        check(/ill = \{\n\thealth = -1\n\tcategory = health\n\tflag = lowers_health\n(\tflag = \w+\n)*\}/.test(zz('common/traits')) && lib(plan3).some((x) => x.label.startsWith('Trait flags:')) && lib(plan3).some((x) => x.label.startsWith('Government flags:')), 'a trait gets flag = lowers_health after its last statement; one plan entry per flag kind');
        // (a flag only a block `has_building_with_flag = { flag = x }` tests; and one only a carried trigger tests)
        const bld = zz('common/buildings');
        check(/hoshi_ryokan_01 = \{[^}]*flag = travel_point_of_interest_stress_relief/.test(bld) && /flag = om3_flag/.test(bld), `a building gets the flag the game tests in the block form only: ${bld.replace(/\r?\n/g, '↵').slice(0, 300)}`);
        check(/celestial_government = \{[^}]*government_uses_ministry_budget/.test(gov) && defs(trig).includes('tgp_has_access_to_ministry_trigger'), 'a government gets the flag only a carried trigger tests (government_uses_ministry_budget)');
        // (the file of the mod that sorts after the library file: the library file loads after it)
        check(zzNames('common/governments').length === 1 && zzNames('common/governments')[0] > 'zzz_om3_governments.txt' && /holy_order_government = \{/.test(gov) && zzNames('common/traits')[0] === 'zz_old_mod3_1_20_fixes_library.txt', `the flag file sorts after the mod’s own files of its folder (${zzNames('common/governments').join(', ')}); the other folders keep the short name`);
        // (one line ending in a library file, whatever its entries came with: the game's files are CRLF in part, the test mod's are LF)
        const eols = (text: string): string => [...new Set(text.match(/\r?\n/g) ?? [])].map((x) => JSON.stringify(x)).join();
        check(['common/scripted_triggers', 'common/scripted_effects', 'common/script_values', 'common/traits', 'common/governments'].every((f) => zz(f) && !eols(zz(f)).includes(',')) && ['common/scripted_triggers', 'common/scripted_effects'].every((f) => eols(zz(f)) === '"\\r\\n"'),`a library file has one line ending: ${['common/scripted_triggers', 'common/scripted_effects', 'common/script_values', 'common/traits', 'common/governments'].map((f) => `${f.split('/')[1]} ${eols(zz(f))}`).join(', ')}`);
        // (on_actions of a hidden game file that no loaded file defines: told, not carried; the localization of the carried triggers)
        check(lib(plan3).some((x) => x.label.startsWith('On actions: ') && x.todo.length === 1) && !readdirSync(join(patch3, 'common', 'on_action')).filter((n) => /^zz+_.*_library\.txt$/.test(n)).some((n) => readFileSync(join(patch3, 'common', 'on_action', n), 'utf8').includes('om3_on_action =')), `the plan: the on_actions the engine fires or loaded files name, that the mod’s copy hides, are carried (the mod’s own is not, in the library file; the folder holds the inert step’s copies and their folders too): ${labels.slice(0, 200)}`);
        check(defs(zz('common/trigger_localization')).includes('is_at_home') && lib(plan3).some((x) => x.label.startsWith('Trigger localization:')), `trigger localization the game's files and the carried triggers need: ${defs(zz('common/trigger_localization')).length} entries`);
        // (g) the merged scripted rule calls a trigger the replaced file hides
        check(readFileSync(join(patch3, 'common', 'scripted_rules', 'zz_old_mod3_1_20_fixes_scripted_rules.txt'), 'utf8').includes('can_edit_rite_trigger') && defs(trig).includes('can_edit_rite_trigger'), 'the merged scripted rule calls can_edit_rite_trigger: carried over too');
        // (h) a theme named as `theme = x`, not one only `situation:x` names; the background the theme needs
        const themes = zz('common/event_themes');
        // (the themes and the background are defined by a loaded file: the library file of this patch mod, or an earlier patch mod's inert file that holds the game's theme)
        await reindex();
        const loadedKeys = (folder: string): Set<string> => new Set(idx.vfs.list(folder, { ext: /\.txt$/i }).flatMap((f) => parse(idx.vfs.readText(f) ?? '').flatMap((n) => (n.k ? [n.k] : []))));
        check(['christian', 'dynastic_cycle'].every((t) => loadedKeys('common/event_themes').has(t)) && !defs(themes).includes('travel_diplomacy') && loadedKeys('common/event_backgrounds').has('pam_ecumenical_council_activity_background'), `event themes the events name with theme = (${defs(themes).length}), one nothing names stays out; the background a theme needs`);
        // (d) a folder the mod hides with replace_path: the entries a loaded file names (by key), with a note
        check(defs(zz('common/scripted_animations')).includes('ecumenical_council_host_animation') && defs(zz('common/scripted_animations')).includes('ecumenical_council_lay_guest_animation_alt') && lib(plan3).some((x) => x.label.startsWith('Scripted animations') && x.notes?.some((n) => /replace_path/.test(n))), `a folder hidden by replace_path: ${defs(zz('common/scripted_animations')).length} animations the game’s activity files name`);
        // (e) a replace_path folder that is no library: nothing from it
        check(!existsSync(join(patch3, 'common', 'dynasties')) && !lib(plan3).some((x) => x.files.some((f) => f.startsWith('common/dynasties'))), 'a replaced world folder (dynasties) gets nothing brought back');
        check(!r6.failed.length && r6.notes.some((n) => /^Scripted triggers: \d+ entries/.test(n)), `the run: ${r6.notes.filter((n) => /entr(y|ies)$/.test(n)).join(' | ')}`);
        // (f) a second run writes nothing; every library rule is done
        const before3 = files(patch3);
        const again3 = await planMigration(host, 'mod/old_mod3.mod');
        check(lib(again3).length === lib(plan3).length && lib(again3).every((x) => x.todo.length === 0), 'the plan of a second run: every library rule done');
        const r7 = await migrateMod(host, 'mod/old_mod3.mod');
        const after3 = files(patch3);
        check(!r7.rewritten.length && after3.size === before3.size && [...before3].every(([k, v]) => after3.get(k) === v), `a second run writes nothing (${r7.rewritten.join(', ')})`);
        // a file of an older run that has nothing to hold now is deleted (it carries the tool's header), not emptied; one changed by hand stays and is told
        const stale = join(patch3, 'common', 'scripted_modifiers', 'zz_old_mod3_1_20_fixes_library.txt');
        const handMade = join(patch3, 'common', 'scripted_modifiers', 'zz_old_mod3_1_20_fixes_library_2.txt');
        mkdirSync(join(patch3, 'common', 'scripted_modifiers'), { recursive: true });
        writeFileSync(stale, '﻿# common/scripted_modifiers — written by CrusaderPope\n# The game\'s own definitions, as the game writes them: 1 that files of the mod hide and loaded files still use.\n\nom3_old_modifier = { }\n');
        writeFileSync(handMade, '# my own notes\nom3_hand_modifier = { }\n');
        const r8 = await migrateMod(host, 'mod/old_mod3.mod');
        check(!existsSync(stale) && !r8.rewritten.includes('common/scripted_modifiers/zz_old_mod3_1_20_fixes_library.txt') && r8.notes.some((n) => /1 file of definitions an older run carried over is not needed any more/.test(n) && n.includes('zz_old_mod3_1_20_fixes_library.txt')), `an older run's library file with nothing to hold is deleted: ${r8.rewritten.join(', ')} | ${r8.notes.filter((n) => /definitions/.test(n)).join(' | ')}`);
        check(existsSync(handMade) && readFileSync(handMade, 'utf8').includes('om3_hand_modifier') && r8.notes.some((n) => /changed by hand — kept/.test(n) && n.includes('library_2.txt')), 'a file of that name changed by hand stays and is told');
        const before8 = files(patch3);
        const r9 = await migrateMod(host, 'mod/old_mod3.mod');
        const after8 = files(patch3);
        check(!r9.rewritten.length && after8.size === before8.size && [...before8].every(([k, v]) => after8.get(k) === v) && r9.notes.some((n) => /changed by hand — kept/.test(n) && n.includes('library_2.txt')), 'a second run writes nothing and tells the same');
        rmSync(handMade);
    }

    // (a fourth mod with particles and textures written for 1.19: a compound graph named by its display name, DX10 headers around
    // BC1-3, colormask textures with a longer mip chain than the game's)
    {
        const root4 = join(tmp, 'mod', 'old_mod4');
        const desc4 = 'version="1.0"\nname="Old Mod Four"\nsupported_version="1.19.0.6"\n';
        mkdirSync(root4, { recursive: true });
        writeFileSync(join(root4, 'descriptor.mod'), desc4);
        writeFileSync(join(tmp, 'mod', 'old_mod4.mod'), `${desc4}path="${root4.replace(/\\/g, '/')}"\n`);
        const raw4 = (rel: string, data: Buffer | string): void =>
        {
            mkdirSync(join(root4, rel, '..'), { recursive: true });
            writeFileSync(join(root4, rel), data);
        };
        const dds = (w: number, h: number, mips: number, fourCC: string, dataLen: number, dx10?: { dxgi: number; dim?: number; misc?: number; arr?: number; }): Buffer =>
        {
            const b = Buffer.alloc(128 + (dx10 ? 20 : 0) + dataLen);
            b.write('DDS ', 0, 'latin1');
            b.writeUInt32LE(124, 4);
            b.writeUInt32LE(0xa1007, 8);
            b.writeUInt32LE(h, 12);
            b.writeUInt32LE(w, 16);
            b.writeUInt32LE(16, 20);
            b.writeUInt32LE(mips, 28);
            b.writeUInt32LE(32, 76);
            b.writeUInt32LE(4, 80);
            b.write(fourCC, 84, 'latin1');
            b.writeUInt32LE(0x401008, 108);

            if (dx10)
            {
                b.writeUInt32LE(dx10.dxgi, 128);
                b.writeUInt32LE(dx10.dim ?? 3, 132);
                b.writeUInt32LE(dx10.misc ?? 0, 136);
                b.writeUInt32LE(dx10.arr ?? 1, 140);
            }

            for (let i = 128 + (dx10 ? 20 : 0); i < b.length; i++)
                b[i] = (i * 7) % 251;

            return b;
        };
        // 1. particles: LF, a byte order mark, both spellings of the node; a name with pins that do not fit; an engine graph
        const node = (id: number, graph: string, pins: string[], keys = 'low'): string =>
            keys === 'low' ?
                `\t\tpdxns:common:compound={\n\t\t\tid=${id}\n\t\t\tnode={\n\t\t\t\tgraph="${graph}"\n\t\t\t}\n\t\t\tinputs={\n${pins.map((p) => `\t\t\t\tlink={\n\t\t\t\t\tpin_id="${p}"\n\t\t\t\t\tlinked_node=4\n\t\t\t\t\tlinked_pin="value"\n\t\t\t\t}\n`).join('')}\t\t\t}\n\t\t}\n` :
                `\t\tpdxns:common:compound={\n\t\t\tId=${id}\n\t\t\tNode={\n\t\t\t\tgraph="${graph}"\n\t\t\t}\n\t\t\tInputs={\n${pins.map((p) => `\t\t\t\tLink = { PinId = "${p}" LinkedNode = 4 LinkedPin = "value" }\n`).join('')}\t\t\t}\n\t\t}\n`;
        const consumer = (id: number, from: number): string => `\t\tpdxns:math:Add={\n\t\t\tid=${id}\n\t\t\tnode={\n\t\t\t}\n\t\t\tinputs={\n\t\t\t\tlink={\n\t\t\t\t\tpin_id="a"\n\t\t\t\t\tlinked_node=${from}\n\t\t\t\t\tlinked_pin="Value"\n\t\t\t\t}\n\t\t\t}\n\t\t}\n`;
        const sd = ['Delay', 'Spawnduration', 'Spawnrate'];
        const particle = '﻿graph={\n\tnodes={\n' +
            node(17, 'Spawn Delay & Duration', sd) + consumer(30, 17) +
            node(18, 'Spawn Delay & Duration', sd, 'caps') +
            node(19, 'Spawn Delay & Duration', ['Delay', 'Bogus']) +
            node(20, 'Particle/Kill by Age & Id', ['lifetime_id']) +
            node(21, 'spawn_delay_and_duration', sd) +
            '\t\t# graph="Spawn Delay & Duration" in a comment\n' +
            '\t}\n}\n';
        raw4('gfx/particles/om4_geyser.particle2', particle);
        raw4('gfx/particles/om4_plain.particle2', 'graph={\n\tnodes={\n' + node(1, 'Base with Variation', ['x']) + '\t}\n}\n');
        // (a file saved as Windows-1252: a comment with a byte that is no UTF-8; only the name may change)
        const latin = Buffer.concat([Buffer.from('graph={\r\n\t# caf', 'latin1'), Buffer.from([0xE9, 0xFF]), Buffer.from('\r\n\tnodes={\r\n' + node(1, 'Spawn Delay & Duration', sd).replace(/\n/g, '\r\n') + '\t}\r\n}\r\n', 'latin1')]);
        raw4('gfx/particles/om4_latin1.particle2', latin);
        // 2. DX10 headers: BC3 sRGB and BC1 (rewritten), BC7 and a cube and an array (untouched), legacy already (untouched)
        const bc3 = dds(4, 4, 2, 'DX10', 32, { dxgi: 78 });
        raw4('gfx/om4/surround_fade.dds', bc3);
        raw4('gfx/om4/bc1.dds', dds(4, 4, 1, 'DX10', 8, { dxgi: 71 }));
        raw4('gfx/om4/bc7.dds', dds(4, 4, 1, 'DX10', 16, { dxgi: 98 }));
        raw4('gfx/om4/cube.dds', dds(4, 4, 1, 'DX10', 48, { dxgi: 71, misc: 4 }));
        raw4('gfx/om4/array.dds', dds(4, 4, 1, 'DX10', 16, { dxgi: 71, arr: 2 }));
        raw4('gfx/om4/legacy.dds', dds(4, 4, 1, 'DXT5', 16));
        raw4('gfx/om4/not_a_dds.dds', Buffer.from('89504e470d0a1a0a', 'hex'));
        // 3. colormasks: the game's shape with one mip more (cut), a referenced one with the game's count (untouched), an unreferenced longer one (untouched)
        const shape = gameMaskShape(gameDir, 'gfx/portraits/accessory_variations')!;
        check(!!shape && shape.mips === 2 && shape.width === 512 && shape.format === 'BC3', `the game's colormask shape is read from its pattern_textures blocks: ${shape ? `${shape.width}x${shape.height} ${shape.format} ${shape.mips} mips` : 'none'}`);
        const mask = (mips: number): Buffer => dds(shape.width, shape.height, mips, 'DXT5', mipBytes(shape.width, shape.height, 16, mips));
        const tdir = 'gfx/portraits/accessory_variations/textures';
        raw4('gfx/portraits/accessory_variations/om4_patterns.txt', `﻿pattern_textures = {\n\tname = "om4_long"\n\tcolormask = "${tdir}/om4_long_masks.dds"\n\tnormal = "${tdir}/om4_long_normal.dds"\n}\npattern_textures = {\n\tname = "om4_ok"\n\tcolormask = "${tdir}/om4_ok_masks.dds"\n}\n`);
        raw4(`${tdir}/om4_long_masks.dds`, mask(shape.mips + 1));
        raw4(`${tdir}/om4_long_normal.dds`, mask(shape.mips + 1));
        raw4(`${tdir}/om4_ok_masks.dds`, mask(shape.mips));
        raw4(`${tdir}/om4_unreferenced_masks.dds`, mask(shape.mips + 1));
        settings.customModLists![0].mods.push({ id: 'mod/old_mod4.mod', enabled: true });
        await reindex();
        const tex = (p: Awaited<ReturnType<typeof planMigration>>, kind: string) => (p.rewrites ?? []).find((x) => x.kind === kind);
        const plan4 = await planMigration(host, 'mod/old_mod4.mod');
        check(tex(plan4, 'particles')?.files.slice().sort().join() === 'gfx/particles/om4_geyser.particle2,gfx/particles/om4_latin1.particle2' && tex(plan4, 'particles')?.todo.length === 2 && !!tex(plan4, 'particles')?.notes?.some((n) => n.includes('Spawn Delay & Duration → spawn_delay_and_duration: Bogus')), `the plan: the particle file with a display name (and the one whose pins do not fit told): ${JSON.stringify(tex(plan4, 'particles'))}`);
        check(tex(plan4, 'ddsLegacy')?.files.slice().sort().join() === 'gfx/om4/bc1.dds,gfx/om4/surround_fade.dds' && !!tex(plan4, 'ddsLegacy')?.notes?.some((n) => n.includes('sRGB')), `the plan: DX10 BC1-3 textures only (not BC7, cube, array, legacy, a PNG named .dds): ${JSON.stringify(tex(plan4, 'ddsLegacy')?.files)}`);
        check(tex(plan4, 'maskMips')?.files.join() === `${tdir}/om4_long_masks.dds`, `the plan: only the referenced colormask with a longer chain: ${JSON.stringify(tex(plan4, 'maskMips')?.files)}`);
        const r9 = await migrateMod(host, 'mod/old_mod4.mod');
        const patch4 = join(tmp, 'mod', 'old_mod4_1_20_fixes');
        const out4 = (rel: string): Buffer | undefined => (existsSync(join(patch4, ...rel.split('/'))) ? readFileSync(join(patch4, ...rel.split('/'))) : undefined);
        // 1.
        const geyser = out4('gfx/particles/om4_geyser.particle2')?.toString('utf8') ?? '';
        // (the first two display names, nodes 17 and 18, are the ones renamed; the third has a pin the compound lacks, the fourth is a comment)
        let named = 0;
        const expected = particle.replace(/graph="Spawn Delay & Duration"/g, (m) => (++named <= 2 ? 'graph="spawn_delay_and_duration"' : m));
        check(!r9.failed.length && geyser.startsWith('﻿') && !geyser.includes('\r') && (geyser.match(/graph="spawn_delay_and_duration"/g) ?? []).length === 3 && (geyser.match(/graph="Spawn Delay & Duration"/g) ?? []).length === 2 && geyser.includes('# graph="Spawn Delay & Duration" in a comment') && geyser.includes('graph="Particle/Kill by Age & Id"'), `the particle file: the display names renamed (both key spellings; one was an id already), the one with a pin the compound lacks, the engine graph and the comment stay; byte order mark and line ends kept (${(geyser.match(/graph="[^"]*"/g) ?? []).join(' | ')})`);
        check(geyser === expected && !out4('gfx/particles/om4_plain.particle2') && readFileSync(join(root4, 'gfx/particles/om4_geyser.particle2'), 'utf8') === particle, 'only the two names changed, every other byte is the mod’s; a file with nothing to rename is not copied; the mod’s own file is untouched');
        const latinOut = out4('gfx/particles/om4_latin1.particle2');
        check(!!latinOut && latinOut.equals(Buffer.from(latin.toString('latin1').replace('graph="Spawn Delay & Duration"', 'graph="spawn_delay_and_duration"'), 'latin1')) && latinOut.includes(Buffer.from([0xE9, 0xFF])), 'a particle file with bytes that are no UTF-8: only the name changed, the other bytes are the mod’s');
        // 2.
        const fade = out4('gfx/om4/surround_fade.dds');
        check(!!fade && fade.length === bc3.length - 20 && fade.toString('latin1', 84, 88) === 'DXT5' && fade.subarray(0, 84).equals(bc3.subarray(0, 84)) && fade.subarray(88, 128).equals(bc3.subarray(88, 128)) && fade.subarray(128).equals(bc3.subarray(148)), 'a DX10 BC3 file: the header is the legacy DXT5 one, the block data is the same bytes');
        check(out4('gfx/om4/bc1.dds')?.toString('latin1', 84, 88) === 'DXT1' && !out4('gfx/om4/bc7.dds') && !out4('gfx/om4/cube.dds') && !out4('gfx/om4/array.dds') && !out4('gfx/om4/legacy.dds') && !out4('gfx/om4/not_a_dds.dds'), 'BC1 becomes DXT1; BC7, a cube, an array, a legacy header and a file that is no DDS are not touched (and nothing throws)');
        // 3.
        const cut = out4(`${tdir}/om4_long_masks.dds`);
        const longIn = readFileSync(join(root4, ...`${tdir}/om4_long_masks.dds`.split('/')));
        check(!!cut && cut.length === 128 + mipBytes(shape.width, shape.height, 16, shape.mips) && cut.readUInt32LE(28) === shape.mips && cut.subarray(128).equals(longIn.subarray(128, cut.length)) && cut.subarray(0, 28).equals(longIn.subarray(0, 28)) && cut.subarray(32, 128).equals(longIn.subarray(32, 128)), `a colormask with a longer chain is cut to the game's ${shape.mips} mips (size ${cut?.length}, count ${cut?.readUInt32LE(28)}), the levels kept are the same bytes`);
        check(!out4(`${tdir}/om4_ok_masks.dds`) && !out4(`${tdir}/om4_unreferenced_masks.dds`) && !out4(`${tdir}/om4_long_normal.dds`), 'a mask with the game’s count, an unreferenced mask and a normal map are not touched');
        // a second run: every rule done, nothing written
        const before4 = files(patch4);
        const again4 = await planMigration(host, 'mod/old_mod4.mod');
        check(['particles', 'ddsLegacy', 'maskMips'].every((k) => tex(again4, k) && tex(again4, k)!.todo.length === 0), 'the plan of a second run: the three rules done');
        const r10 = await migrateMod(host, 'mod/old_mod4.mod');
        const after4 = files(patch4);
        check(!r10.rewritten.length && after4.size === before4.size && [...before4].every(([k, v]) => after4.get(k) === v), `a second run writes nothing (${r10.rewritten.join(', ')})`);

        // (a fifth mod, labelled 1.19 but with parts in the 1.20 form: what a mod updated by hand looks like, as Elder Kings 2 does when it is
        // labelled older: files of its own in two of the folders the patch mod would hide, the game's own copies and copies of the new version
        // with changes of its own, next to older ones; the scripted names the 1.19 way, one defined by the mod itself; a mod before it with
        // files in the other two folders)
        const rootW = join(tmp, 'mod', 'old_modw');
        const root5 = join(tmp, 'mod', 'old_mod5');
        const descW = 'version="1.0"\nname="Old Mod W"\nsupported_version="1.20.0.4"\n';
        const desc5 = 'version="1.0"\nname="Old Mod Five"\nreplace_path="common/religion/religion_types"\nsupported_version="1.19.0.6"\n';
        const put5 = (dir: string, rel: string, data: Buffer | string): void =>
        {
            mkdirSync(join(dir, rel, '..'), { recursive: true });
            writeFileSync(join(dir, rel), typeof data === 'string' ? '﻿' + data : data);
        };
        const game5 = (rel: string): Buffer => readFileSync(join(gameDir, ...rel.split('/')));
        mkdirSync(rootW, { recursive: true });
        mkdirSync(root5, { recursive: true });
        writeFileSync(join(rootW, 'descriptor.mod'), descW);
        writeFileSync(join(tmp, 'mod', 'old_modw.mod'), `${descW}path="${rootW.replace(/\\/g, '/')}"\n`);
        writeFileSync(join(root5, 'descriptor.mod'), desc5);
        writeFileSync(join(tmp, 'mod', 'old_mod5.mod'), `${desc5}path="${root5.replace(/\\/g, '/')}"\n`);
        put5(rootW, 'common/religion/rite_types/w_rites.txt', 'w_rite = { }\n');
        put5(rootW, 'history/faiths/w_hist.txt', 'w_faith = { }\n');
        put5(root5, 'common/religion/faith_types/om5_faiths.txt', 'om5_faith = { color = { 0.4 0.1 0.6 } }\n');
        put5(root5, 'common/holy_orders/om5_orders.txt', 'om5_order = { }\n');
        // (the game's own tooltips and effect include; the faith window with lines of its own added; the conversion window with a call 1.20 renamed added;
        // a shader with a function added; an older shader)
        put5(root5, 'gui/shared/cooltip.gui', game5('gui/shared/cooltip.gui'));
        put5(root5, 'gfx/FX/clouds.fxh', game5('gfx/FX/clouds.fxh'));
        put5(root5, 'gui/window_faith.gui', Buffer.concat([game5('gui/window_faith.gui'), Buffer.from('\n# om5\nwidget = { name = "om5_extra" }\n')]));
        put5(root5, 'gui/window_faith_conversion.gui', Buffer.concat([game5('gui/window_faith_conversion.gui'), Buffer.from('\nwidget = { text = "[ClearExploringRealms]" }\n')]));
        put5(root5, 'gfx/FX/gui_coatofarms.shader', Buffer.concat([game5('gfx/FX/gui_coatofarms.shader'), Buffer.from('\nPixelShader =\n{\n\tCode\n\t[[\n\t\tstatic const float OM5_EDIT = 0.5f;\n\t]]\n}\n')]));
        put5(root5, 'gfx/FX/pdxborder.shader', 'PixelShader =\n{\n\tCode\n\t[[\n\t\tfloat Om5Old() { return 1.0f; }\n\t]]\n}\n');
        // (a pair: a copy of the new version that includes an include of the mod's own addition, whose copy is older: the two are merged together;
        // a game file with no lines at all (the clausewitz lighting constants): an older copy of it is no copy of the new version)
        put5(root5, 'gfx/FX/arrow.shader', Buffer.from(game5('gfx/FX/arrow.shader').toString('utf8').replace('"standardfuncsgfx.fxh"', '"standardfuncsgfx.fxh"\n\t"shadow_tint.fxh"')));
        put5(root5, 'gfx/FX/shadow_tint.fxh', 'float Om5Tint;\n');
        put5(root5, 'gfx/FX/cw/lighting_constants.fxh', '#define OM5_OLD_CONST 1\nstatic const float Om5OldLight = 0.5f;\n');
        // (a doctrine of no group is no tenet: its icon stays in faith_doctrines)
        put5(root5, 'common/religion/doctrine_types/om5_doctrines.txt', 'doctrine_clerical_gender = {\n\ticon = doctrine_clerical_gender\n}\n');
        // (a wrapper effect and trigger that call the 1.19 names; the mod defines the trigger itself at the top level, the effect it does not)
        put5(root5, 'common/scripted_effects/om5_effects.txt', 'om5_wrap_effect = {\n\tguardian_or_court_tutor_trigger_event = { EVENT = om5_ev.2 }\n}\n');
        put5(root5, 'common/scripted_triggers/om5_triggers.txt', 'sexual_activity_with_partner_is_criminal_in_faith_trigger = { always = yes }\n\nom5_wrap_trigger = {\n\tsexual_activity_with_partner_is_criminal_in_faith_trigger = { PARTNER = scope:p FAITH = root.faith }\n}\n');
        put5(root5, 'events/om5_events.txt', 'namespace = om5_ev\n\nom5_ev.1 = {\n\ttype = character_event\n\timmediate = {\n\t\tguardian_or_court_tutor_trigger_event = { EVENT = om5_ev.2 }\n\t}\n}\n');
        settings.customModLists!.push({ id: 'l5', name: 'List five', mods: [{ id: 'mod/old_modw.mod', enabled: true }, { id: 'mod/old_mod5.mod', enabled: true }] });
        settings.modList = 'custom:l5';
        await reindex();
        const plan5 = await planMigration(host, 'mod/old_mod5.mod');
        const rule5 = (kind: string) => (plan5.rewrites ?? []).find((x) => x.kind === kind);
        check(plan5.replacePaths?.join(' ') === 'common/religion/rite_types history/faiths' && plan5.replacePathsOwn?.join(' ') === 'common/religion/faith_types common/holy_orders', `the plan: the patch mod hides the folders the mod has no file in (${plan5.replacePaths?.join(', ')}), not the two it has (${plan5.replacePathsOwn?.join(', ')})`);
        check(plan5.replacePathHides?.length === 2 && plan5.replacePathHides.every((h) => h.mod === 'Old Mod W' && h.files === 1) && plan5.replacePathHides.some((h) => h.folder === 'common/religion/rite_types') && plan5.replacePathHides.some((h) => h.folder === 'history/faiths'), `the plan: the files of the mod before it that the hiding takes too: ${JSON.stringify(plan5.replacePathHides)}`);
        check(rule5('restore')?.files.join() === 'gui/window_faith_conversion.gui', `the plan: of the three interface files only the conversion window (a call 1.20 renamed) is restored; the game's own and the copy of the new version are not (${rule5('restore')?.files.join()})`);
        check(rule5('mergefx')?.files.slice().sort().join() === 'gfx/FX/arrow.shader,gfx/FX/cw/lighting_constants.fxh,gfx/FX/pdxborder.shader,gfx/FX/shadow_tint.fxh' && plan5.leftAlone?.same.join() === 'gfx/FX/clouds.fxh,gui/shared/cooltip.gui' && plan5.leftAlone?.current.join() === 'gfx/FX/gui_coatofarms.shader,gui/window_faith.gui', `the plan: of the shaders the older copies are merged, and the copy of the new version that includes an older one of the mod's addition with it; an older copy of an empty game file is not current; left alone: ${JSON.stringify(plan5.leftAlone)} merged: ${rule5('mergefx')?.files.join()}`);
        {
            // (the test of a copy: the lines count with their repeats (a copy lacking a whole block of widgets is not the game's file), and an empty game file gives nothing to compare)
            const cool = game5('gui/shared/cooltip.gui').toString('utf8').split(/\r?\n/);
            const coolText = cool.join('\n');
            check(carriesGame(coolText, coolText + '\nextra = 1') && !carriesGame(coolText, [...cool.slice(0, 10990), ...cool.slice(11580)].join('\n')) && !carriesGame('', 'a = 1') && carriesGame('a = 1\nb = 2', 'b = 2\na = 1\nc = 3'), 'carriesGame: a copy with additions is current, one lacking a block of 590 repeated lines is not, an empty game file has no current copy');
            const pair = pairedWithReplaced(new Map([['gfx/FX/k.shader', { mod: 'Includes = {\n\t"a.fxh"\n\t"b.fxh"\n}\n', game: 'Includes = {\n\t"a.fxh"\n}\n' }], ['gfx/FX/l.shader', { mod: 'Includes = {\n\t"gfx/FX/k.shader"\n}\n', game: '' }], ['gfx/FX/m.shader', { mod: 'Includes = {\n\t"a.fxh"\n}\n', game: 'Includes = {\n\t"a.fxh"\n}\n' }]]), ['gfx/FX/b.fxh']);
            check([...pair].sort().join() === 'gfx/FX/k.shader,gfx/FX/l.shader', `pairedWithReplaced: a copy including an include of the mod's addition that is replaced, and the copy including that one (not the one whose includes are the game's): ${[...pair].join()}`);
        }
        check(!rule5('icons'), `the plan: a doctrine's icon is no work (${JSON.stringify(rule5('icons'))})`);
        const stm5 = (plan5.rewrites ?? []).filter((x) => x.kind === 'statements' && x.label.startsWith('Effects and triggers 1.20 renamed')).flatMap((x) => x.files).sort().join();
        check(stm5 === 'common/scripted_effects/om5_effects.txt,events/om5_events.txt', `the plan: the 1.19 effect is renamed in the wrapper effect and the event (an indented use defines nothing); the trigger the mod defines keeps its calls (${stm5})`);
        const r11 = await migrateMod(host, 'mod/old_mod5.mod');
        const patch5 = join(tmp, 'mod', 'old_mod5_1_20_fixes');
        const out5 = (rel: string): string | undefined => (existsSync(join(patch5, ...rel.split('/'))) ? readFileSync(join(patch5, ...rel.split('/')), 'utf8') : undefined);
        const descOut = readFileSync(join(patch5, 'descriptor.mod'), 'utf8');
        const outerOut = readFileSync(join(tmp, 'mod', 'old_mod5_1_20_fixes.mod'), 'utf8');
        check(!r11.failed.length && /replace_path="common\/religion\/rite_types"/.test(descOut) && /replace_path="history\/faiths"/.test(descOut) && !/faith_types|holy_orders/.test(descOut) && !/faith_types|holy_orders/.test(outerOut) && r11.hidden.join() === 'common/religion/rite_types,history/faiths', `the patch mod's descriptors hide rite_types and history/faiths only (${r11.hidden.join()})`);
        check(/dependencies=\{\s*"Old Mod Five"\s*\}/.test(descOut) && /dependencies=\{\s*"Old Mod Five"\s*\}/.test(outerOut), 'the patch mod names the mod as its dependency (both descriptors)');
        check(r11.notes.some((n) => n.includes('1 file of Old Mod W in common/religion/rite_types is hidden too')) && r11.notes.some((n) => n.includes('The patch mod does not hide common/religion/faith_types, common/holy_orders')), `the notes: the files of the mod before it, the folders spared (${r11.notes.filter((n) => /hidden too|does not hide/.test(n)).join(' | ')})`);
        check(r11.notes.some((n) => /2 files of Old Mod Five are the game’s own files, byte for byte/.test(n) && n.includes('gui/shared/cooltip.gui')) && r11.notes.some((n) => /2 files of Old Mod Five hold the lines of the game’s new files, bar a few they changed/.test(n)), `the notes: the copies left alone (${r11.notes.filter((n) => /byte for byte|bar a few/.test(n)).join(' | ')})`);
        const gf5 = idx.vfs.list('common/religion/faith_types').map((f) => f.rel);
        check(gf5.includes('common/religion/faith_types/om5_faiths.txt') && idx.vfs.list('common/holy_orders').some((f) => f.rel === 'common/holy_orders/om5_orders.txt') && idx.vfs.list('common/religion/rite_types').length === 0, `the files list: the mod's own faith_types and holy_orders files still load with the patch mod, rite_types is empty (${gf5.join()})`);
        check(!out5('gui/shared/cooltip.gui') && !out5('gfx/FX/clouds.fxh') && !out5('gui/window_faith.gui') && !out5('gfx/FX/gui_coatofarms.shader'), 'the game’s own copies and the copies of the new version are not written to the patch mod');
        check(out5('gfx/FX/arrow.shader') === readFileSync(join(gameDir, 'gfx', 'FX', 'arrow.shader'), 'utf8') && out5('gfx/FX/cw/lighting_constants.fxh') === '', `the pair is merged (the shader is the game's, nothing of the mod's to add), the empty game file is written as it is (${out5('gfx/FX/cw/lighting_constants.fxh')?.length})`);
        const border5 = out5('gfx/FX/pdxborder.shader');
        check(out5('gui/window_faith_conversion.gui') === readFileSync(join(gameDir, 'gui', 'window_faith_conversion.gui'), 'utf8') && !!border5?.includes('PixelShaderStruggle'), `the older conversion window is the game’s; the older shader is merged (the game’s file): ${border5?.slice(0, 200)}`);
        check(!!out5('common/scripted_effects/om5_effects.txt')?.includes('guardian_or_court_tutor_trigger_event_effect = { EVENT = om5_ev.2 }') && !!out5('events/om5_events.txt')?.includes('guardian_or_court_tutor_trigger_event_effect') && !out5('common/scripted_triggers/om5_triggers.txt'), 'the 1.19 effect is renamed in the wrapper and the event; the trigger the mod defines keeps its calls (no copy)');
        const before5 = files(patch5);
        const again5 = await planMigration(host, 'mod/old_mod5.mod');
        check(!(again5.rewrites ?? []).some((x) => x.todo.length > 0) && !again5.replacePathsTodo?.length, 'the plan of a second run: every rule done');
        const r12 = await migrateMod(host, 'mod/old_mod5.mod');
        const after5 = files(patch5);
        check(!r12.rewritten.length && after5.size === before5.size && [...before5].every(([k, v]) => after5.get(k) === v), `a second run writes nothing (${r12.rewritten.join(', ')})`);
        // (a patch mod hides the mod's own folder: a line it got by hand is told, not changed; one a run of the app wrote goes with the next run)
        writeFileSync(join(patch5, 'descriptor.mod'), descOut.replace(/\r?\n$/, '') + '\nreplace_path="common/holy_orders"\n');
        writeFileSync(join(tmp, 'mod', 'old_mod5_1_20_fixes.mod'), outerOut.replace(/\r?\n$/, '') + '\nreplace_path="common/holy_orders"\n');
        await reindex();
        const stale5 = await planMigration(host, 'mod/old_mod5.mod');
        check(stale5.replacePathsStale?.join() === 'common/holy_orders', `an older run's replace_path over the mod's own files is told (${stale5.replacePathsStale?.join()})`);
        const manifest5 = JSON.parse(readFileSync(join(patch5, '.crusaderpope-fixes.json'), 'utf8'));
        writeFileSync(join(patch5, '.crusaderpope-fixes.json'), JSON.stringify({ ...manifest5, hidden: [...manifest5.hidden, 'common/holy_orders'] }));
        const freed5 = await planMigration(host, 'mod/old_mod5.mod');
        check(!freed5.replacePathsStale?.length && freed5.replacePathsGone?.join() === 'common/holy_orders', `the line a run wrote over the mod's own files is to go (${freed5.replacePathsGone?.join()}, told ${freed5.replacePathsStale?.join()})`);
        const r13 = await migrateMod(host, 'mod/old_mod5.mod');
        check(!/holy_orders/.test(readFileSync(join(patch5, 'descriptor.mod'), 'utf8')) && !/holy_orders/.test(readFileSync(join(tmp, 'mod', 'old_mod5_1_20_fixes.mod'), 'utf8')) && /replace_path="history\/faiths"/.test(readFileSync(join(patch5, 'descriptor.mod'), 'utf8')) && r13.notes.some((n) => n.includes('no longer hides common/holy_orders') && n.includes('files of its own')), `the next run takes the line out of both descriptors (${r13.notes.filter((n) => /no longer hides/.test(n)).join(' | ')})`);

        // (a sixth mod, labelled 1.19 with its faiths still inside its religion, and one file of its own in faith_types: not laid out for 1.20:
        // the patch mod hides all four folders, or the game's faiths load against the religions the mod lacks; the file of its own goes, told)
        const root6 = join(tmp, 'mod', 'old_mod6');
        const desc6 = 'version="1.0"\nname="Old Mod Six"\nreplace_path="common/religion/religion_types"\nsupported_version="1.19.0.6"\n';
        mkdirSync(root6, { recursive: true });
        writeFileSync(join(root6, 'descriptor.mod'), desc6);
        writeFileSync(join(tmp, 'mod', 'old_mod6.mod'), `${desc6}path="${root6.replace(/\\/g, '/')}"\n`);
        put5(root6, 'common/religion/religion_types/om6_religions.txt', 'om6_religion = {\n\tfamily = rf_abrahamic\n\tdoctrine = doctrine_monotheist\n\n\tfaiths = {\n\t\tom6_faith = {\n\t\t\tcolor = { 0.4 0.1 0.6 }\n\t\t\ticon = catholic\n\t\t\tholy_site = rome\n\t\t\tdoctrine = tenet_communion\n\t\t}\n\t}\n}\n');
        put5(root6, 'common/religion/faith_types/om6_helper.txt', 'om6_helper_faith = { color = { 0.1 0.2 0.3 } }\n');
        settings.customModLists!.push({ id: 'l6', name: 'List six', mods: [{ id: 'mod/old_mod6.mod', enabled: true }] });
        settings.modList = 'custom:l6';
        await reindex();
        const plan6 = await planMigration(host, 'mod/old_mod6.mod');
        check(plan6.replacePaths?.length === 4 && plan6.replacePaths.includes('common/religion/faith_types') && !plan6.replacePathsOwn?.length && plan6.replacePathsShadowed?.join() === 'common/religion/faith_types', `the plan: the religions still hold their faiths, so the folder with a file of the mod's own is hidden all the same, told (${plan6.replacePaths?.join(', ')}; shadowed ${plan6.replacePathsShadowed?.join()})`);
        const r14 = await migrateMod(host, 'mod/old_mod6.mod');
        const desc6Out = readFileSync(join(tmp, 'mod', 'old_mod6_1_20_fixes', 'descriptor.mod'), 'utf8');
        check(!r14.failed.length && /replace_path="common\/religion\/faith_types"/.test(desc6Out) && r14.notes.some((n) => n.includes('hides common/religion/faith_types although Old Mod Six has files of its own directly in them')), `the patch mod hides faith_types, the result tells (${r14.notes.filter((n) => /although/.test(n)).join(' | ')})`);
        const again6 = await planMigration(host, 'mod/old_mod6.mod');
        check(!again6.replacePathsTodo?.length && !again6.replacePathsOwn?.length && !again6.replacePathsStale?.length && !(again6.rewrites ?? []).some((x) => x.todo.length > 0), 'the plan of a second run: nothing to do, the folder stays hidden');
        settings.modList = 'custom:l1';
    }

    // (the patch mod's life: the mod updated after the migration, files no rule asks for any more, a rule that fails, a Cancel
    // between the rules, a patch mod packed into a zip, a mod with nothing to do)
    {
        const BOM = '﻿';
        const root9 = join(tmp, 'mod', 'old_mod9');
        const patch9 = join(tmp, 'mod', 'old_mod9_1_20_fixes');
        const desc9 = (replace: boolean): string => `version="1.0"\nname="Old Mod Nine"\n${replace ? 'replace_path="common/religion/religion_types"\n' : ''}supported_version="1.19.0.6"\n`;
        const writeDesc9 = (replace: boolean): void =>
        {
            writeFileSync(join(root9, 'descriptor.mod'), desc9(replace));
            writeFileSync(join(tmp, 'mod', 'old_mod9.mod'), `${desc9(replace)}path="${root9.replace(/\\/g, '/')}"\n`);
        };
        const put9 = (rel: string, data: string | Buffer): void =>
        {
            mkdirSync(join(root9, rel, '..'), { recursive: true });
            writeFileSync(join(root9, rel), typeof data === 'string' ? BOM + data : data);
        };
        const religions9 = (faiths: string[]): string => `om9_religion = {\n\tfamily = rf_abrahamic\n\tdoctrine = doctrine_monotheist\n\n\tfaiths = {\n${faiths.map((f) => `\t\t${f} = {\n\t\t\tcolor = { 0.4 0.1 0.6 }\n\t\t\ticon = catholic\n\t\t\tholy_site = rome\n\t\t\tdoctrine = doctrine_monogamy\n\t\t}\n`).join('')}\t}\n}\n`;
        const buildings9 = (names: string[]): string => names.map((n) => `${n} = {\n\tprovince_faith_modifier = {\n\t\tparameter = basic_pilgrimage_rewards\n\t\tmonthly_piety = 0.1\n\t}\n}\n`).join('\n');
        const faithWindow = 'window = { name = "faith_window_1_19" onclick = "[ClearExploringRealms]" }\n';
        mkdirSync(root9, { recursive: true });
        writeDesc9(true);
        put9('common/religion/religion_types/om9_religions.txt', religions9(['om9_faith']));
        put9('common/buildings/om9_buildings.txt', buildings9(['om9_temple_01']));
        put9('gui/window_faith.gui', faithWindow);
        put9('common/defines/00_defines.txt', 'NFaith = {\n\tOM9_OWN_VALUE = 1\n}\n');
        settings.customModLists![0].mods.push({ id: 'mod/old_mod9.mod', enabled: true });
        await reindex();
        const at9 = (rel: string): string => join(patch9, ...rel.split('/'));
        const read9 = (rel: string): string | undefined => (existsSync(at9(rel)) ? readFileSync(at9(rel), 'utf8') : undefined);
        const modHash = (rel: string): string => sha1(readFileSync(join(root9, ...rel.split('/'))));
        type Life = { game?: string; base?: { id: string; }; restored: Record<string, string>; hidden?: string[]; generated?: string[]; files?: Record<string, string>; sources?: Record<string, { from: string; src: string; stamp?: string; }>; };
        const life9 = (): Life => JSON.parse(readFileSync(join(patch9, '.crusaderpope-fixes.json'), 'utf8')) as Life;
        const tree9 = (): Map<string, string> => new Map([...files(patch9)].map(([k, v]) => [k.slice(patch9.length + 1).replace(/\\/g, '/'), v]).filter(([k]) => k !== '.crusaderpope-fixes.json') as [string, string][]);
        const sameTree = (a: Map<string, string>, b: Map<string, string>): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
        const faithsIn = (text: string | undefined, name: string): number => (text?.match(new RegExp(`^${name} = \\{`, 'gm')) ?? []).length;
        const fixFaiths = (): string => read9('common/religion/faith_types/old_mod9_1_20_fixes_faith_types.txt') ?? '';

        // 1. the first run records what it left, and which mod file each copy was made from
        const a1 = await migrateMod(host, 'mod/old_mod9.mod');
        const m1 = life9();
        check(!a1.failed.length && m1.base?.id === 'mod/old_mod9.mod' && m1.hidden?.length === 4 && !!m1.restored['gui/window_faith.gui'] && m1.generated?.includes('common/defines/zz_old_mod9_1_20_fixes/zz_old_mod9_1_20_fixes_defines.txt'), `the manifest names the mod, the hidden folders, the generated files (${a1.failed.map((f) => f.why).join('; ')})`);
        check(m1.sources?.['common/buildings/om9_buildings.txt']?.src === modHash('common/buildings/om9_buildings.txt') && m1.sources?.['common/religion/religion_types/om9_religions.txt']?.from === 'common/religion/religion_types/om9_religions.txt' && !m1.sources?.['gui/window_faith.gui'] && !m1.files?.['gui/window_faith.gui'] && !!m1.files?.['common/religion/faith_types/old_mod9_1_20_fixes_faith_types.txt'] && !m1.files?.['common/religion/faith_types/old_mod9_1_20_fixes_faith_types.txt']?.startsWith('undefined'), 'sources: the copies and the hash of the mod’s file; files: every file left (a restored game file has its own record)');
        const tree1 = tree9();
        const idle1 = await planMigration(host, 'mod/old_mod9.mod');
        const a1b = await migrateMod(host, 'mod/old_mod9.mod');
        check(!idle1.patchMod?.stale && !idle1.patchMod?.orphans && !idle1.replacePathsGone && !a1b.rewritten.length && !a1b.copied.length && sameTree(tree1, tree9()), 'a second run: nothing stale, nothing written');

        // 2. the mod is updated: a building and a faith added, and the descriptor’s supported_version is still 1.19
        const modBefore9 = modHash('common/buildings/om9_buildings.txt');
        put9('common/buildings/om9_buildings.txt', buildings9(['om9_temple_01', 'om9_temple_02']));
        put9('common/religion/religion_types/om9_religions.txt', religions9(['om9_faith', 'om9_faith2']));
        const stalePlan9 = await planMigration(host, 'mod/old_mod9.mod');
        check(stalePlan9.patchMod?.stale?.files.slice().sort().join() === 'common/buildings/om9_buildings.txt,common/religion/religion_types/om9_religions.txt' && stalePlan9.patchMod.stale.reset > 2 && !stalePlan9.patchMod.stale.legacy, `the plan: the two changed files stand for a stale patch mod, with the work to do (${JSON.stringify(stalePlan9.patchMod?.stale)})`);
        await reindex();
        const a2 = await migrateMod(host, 'mod/old_mod9.mod');
        check(!a2.failed.length && a2.notes.some((n) => n.includes('changed 2 files') && n.includes('om9_buildings.txt')), `the run says the mod changed: ${a2.notes.filter((n) => /changed 2 files/.test(n)).join(' | ')}`);
        check(/om9_temple_02 = \{\s*province_rite_modifier/.test(read9('common/buildings/om9_buildings.txt') ?? '') && faithsIn(fixFaiths(), 'om9_faith') === 1 && faithsIn(fixFaiths(), 'om9_faith2') === 1 && !!idx.get('faith', 'om9_faith2') && !!idx.get('faith', 'om9_faith'), 'the update reaches the game: the new building (fixed), both faiths once each, in the index');
        check(life9().sources?.['common/buildings/om9_buildings.txt']?.src === modHash('common/buildings/om9_buildings.txt') && modHash('common/buildings/om9_buildings.txt') !== modBefore9, 'the manifest holds the new hash');
        const tree2 = tree9();
        const idle2 = await planMigration(host, 'mod/old_mod9.mod');
        const a2b = await migrateMod(host, 'mod/old_mod9.mod');
        check(!idle2.patchMod?.stale && !a2b.rewritten.length && sameTree(tree2, tree9()), 'and a second run after it writes nothing');
        // (the same as a patch mod made from the updated mod in one go)
        {
            const root9b = join(tmp, 'mod', 'old_mod9b');
            mkdirSync(root9b, { recursive: true });
            writeFileSync(join(root9b, 'descriptor.mod'), desc9(true).replace('Nine', 'Nine B'));
            writeFileSync(join(tmp, 'mod', 'old_mod9b.mod'), `${desc9(true).replace('Nine', 'Nine B')}path="${root9b.replace(/\\/g, '/')}"\n`);

            for (const [rel] of files(root9))
            {
                const sub = rel.slice(root9.length + 1).replace(/\\/g, '/');

                if (sub !== 'descriptor.mod')
                {
                    mkdirSync(join(root9b, sub, '..'), { recursive: true });
                    writeFileSync(join(root9b, sub), readFileSync(rel));
                }
            }

            settings.customModLists![0].mods.push({ id: 'mod/old_mod9b.mod', enabled: true });
            await reindex();
            const b1 = await migrateMod(host, 'mod/old_mod9b.mod');
            const norm = (t: Map<string, string>): Map<string, string> => new Map([...t].map(([k, v]) => [k.replace(/old_mod9b/g, 'old_mod9'), v.replace(/old_mod9b/g, 'old_mod9')]));
            const patch9b = join(tmp, 'mod', 'old_mod9b_1_20_fixes');
            const fresh = new Map([...files(patch9b)].map(([k, v]) => [k.slice(patch9b.length + 1).replace(/\\/g, '/'), v]).filter(([k]) => k !== '.crusaderpope-fixes.json' && k !== 'descriptor.mod') as [string, string][]);
            // (the types file is left out: the first patch mod, loaded before, defines the types the second one's window would need)
            const rebuilt = new Map([...tree2].filter(([k]) => k !== 'descriptor.mod' && !/^gui\/zz_.*_types\.gui$/.test(k) && !/\/zz_[^/]*_inert\.txt$/.test(k)));
            const diff = [...norm(fresh)].filter(([k, v]) => rebuilt.get(k) !== v).map(([k]) => k).concat([...rebuilt.keys()].filter((k) => !norm(fresh).has(k)));
            check(!b1.failed.length && diff.length === 0, `the patch mod after the update is the one a run on the updated mod makes from nothing (${diff.join(', ') || 'same'}${diff.length ? '\n--- fresh\n' + (norm(fresh).get(diff[0]) ?? '(none)').slice(0, 700) + '\n--- rebuilt\n' + (rebuilt.get(diff[0]) ?? '(none)').slice(0, 700) : ''})`);
            // (the second mod and its patch mod leave the list: its fixed copy of the same religion file would win over the first's)
            settings.customModLists![0].mods = settings.customModLists![0].mods.filter((m) => !m.id.startsWith('mod/old_mod9b'));
        }

        // 3. a copy changed by hand stays; the mod changing that very file does not reach it
        await reindex();
        const bld = at9('common/buildings/om9_buildings.txt');
        writeFileSync(bld, readFileSync(bld, 'utf8') + '# my edit\n');
        // (and a file put into the patch mod by hand, across two runs: it is not the run's, so the rebuild leaves it)
        const mine = at9('common/traits/om9_mine.txt');
        mkdirSync(join(mine, '..'), { recursive: true });
        writeFileSync(mine, '# my own file\n');
        await migrateMod(host, 'mod/old_mod9.mod');
        check(life9().files?.['common/traits/om9_mine.txt'] === undefined, 'a file put into the patch mod by hand is not recorded as the run’s own');
        put9('common/religion/religion_types/om9_religions.txt', religions9(['om9_faith', 'om9_faith2', 'om9_faith3']));
        const a3 = await migrateMod(host, 'mod/old_mod9.mod');
        check(existsSync(mine) && readFileSync(mine, 'utf8') === '# my own file\n', 'and the rebuild after the mod’s update leaves it');
        rmSync(mine);
        check(!a3.failed.length && (read9('common/buildings/om9_buildings.txt') ?? '').endsWith('# my edit\n') && faithsIn(fixFaiths(), 'om9_faith3') === 1 && faithsIn(fixFaiths(), 'om9_faith') === 1, `a copy changed by hand stays when something else of the mod changed; the rest is made again (failed ${a3.failed.map((f) => f.why).join('; ') || 'none'}; edit kept ${(read9('common/buildings/om9_buildings.txt') ?? '').endsWith('# my edit\n')}; faiths ${faithsIn(fixFaiths(), 'om9_faith')}/${faithsIn(fixFaiths(), 'om9_faith3')}; fixed ${a3.fixed.join(', ') || 'nothing'}; copied ${a3.copied.join(', ') || 'nothing'}; ${[...tree9().keys()].filter((k) => /faith/.test(k)).join(', ')})`);
        put9('common/buildings/om9_buildings.txt', buildings9(['om9_temple_01', 'om9_temple_02', 'om9_temple_03']));
        const plan3b = await planMigration(host, 'mod/old_mod9.mod');
        check(!plan3b.patchMod?.stale && plan3b.patchMod?.keptStale?.join() === 'common/buildings/om9_buildings.txt', `the plan: the changed file you also changed is told, not work (${JSON.stringify(plan3b.patchMod)})`);
        const a3b = await migrateMod(host, 'mod/old_mod9.mod');
        const tree3 = tree9();
        const a3c = await migrateMod(host, 'mod/old_mod9.mod');
        check(!a3b.rewritten.length && a3b.notes.some((n) => /you also changed/.test(n)) && !/om9_temple_03/.test(read9('common/buildings/om9_buildings.txt') ?? '') && !a3c.rewritten.length && sameTree(tree3, tree9()), 'the update does not reach the hand-edited copy (told), and nothing starts over in the next run');
        // (the edit gone: the update reaches it)
        rmSync(bld);
        const a3d = await migrateMod(host, 'mod/old_mod9.mod');
        check(/om9_temple_03 = \{\s*province_rite_modifier/.test(read9('common/buildings/om9_buildings.txt') ?? '') && (a3d.copied.includes('common/buildings/om9_buildings.txt') || a3d.rewritten.includes('common/buildings/om9_buildings.txt')), 'with the copy deleted the update reaches it (the new building, fixed)');

        // 4. a patch mod from before the records: a mod file newer than the patch mod’s copy
        {
            const m = life9() as Life & Record<string, unknown>;
            delete m.files;
            delete m.sources;
            writeFileSync(join(patch9, '.crusaderpope-fixes.json'), JSON.stringify(m, null, 2));
            const quiet = await planMigration(host, 'mod/old_mod9.mod');
            const aQuiet = await migrateMod(host, 'mod/old_mod9.mod');
            check(!quiet.patchMod?.stale && !aQuiet.rewritten.length && !!life9().files && !!life9().sources, 'a patch mod without the records and nothing newer: no work, the records are written');
            delete m.files;
            delete m.sources;
            writeFileSync(join(patch9, '.crusaderpope-fixes.json'), JSON.stringify(m, null, 2));
            put9('common/buildings/om9_buildings.txt', buildings9(['om9_temple_01', 'om9_temple_02', 'om9_temple_04']));
            const later = new Date(Date.now() + 120000);
            utimesSync(join(root9, 'common', 'buildings', 'om9_buildings.txt'), later, later);
            // (a file the owner made after the patch mod's last run: with no records it cannot be told from the run's own except by its time)
            const mine4 = at9('common/traits/om9_mine.txt');
            mkdirSync(join(mine4, '..'), { recursive: true });
            writeFileSync(mine4, '# my own file\n');
            utimesSync(mine4, later, later);
            const legacy = await planMigration(host, 'mod/old_mod9.mod');
            check(legacy.patchMod?.stale?.legacy === true && legacy.patchMod.stale.files.join() === 'common/buildings/om9_buildings.txt', `the plan: a mod file newer than the copy of a patch mod without records is stale (${JSON.stringify(legacy.patchMod?.stale)})`);
            await reindex();
            const aLegacy = await migrateMod(host, 'mod/old_mod9.mod');
            check(!aLegacy.failed.length && /om9_temple_04 = \{\s*province_rite_modifier/.test(read9('common/buildings/om9_buildings.txt') ?? '') && !!life9().files && aLegacy.notes.some((n) => /before it recorded/.test(n)), 'the run made the files again and wrote the records');
            check(existsSync(mine4) && life9().files?.['common/traits/om9_mine.txt'] === undefined && aLegacy.notes.some((n) => /changed after its last run and was kept/.test(n) && n.includes('om9_mine.txt')), `a file touched after the last run of a patch mod without records stays, told, and is not recorded as the run’s (${aLegacy.notes.filter((n) => /after its last run/.test(n)).join(' | ')})`);
            rmSync(mine4);
        }

        // 5. the mod stops overriding the game's window and replacing the folder, and ships the defines in full: what no rule asks for goes
        await reindex();
        check(!!read9('gui/window_faith.gui') && !!read9('common/defines/zz_old_mod9_1_20_fixes/zz_old_mod9_1_20_fixes_defines.txt') && /replace_path="common\/religion\/faith_types"/.test(readFileSync(join(patch9, 'descriptor.mod'), 'utf8')), 'before: the game’s window, the defines file and the hidden folders are in the patch mod');
        rmSync(join(root9, 'gui', 'window_faith.gui'));
        put9('common/defines/00_defines.txt', readFileSync(join(gameDir, 'common', 'defines', '00_defines.txt')));
        writeDesc9(false);
        await reindex();
        const orphanPlan = await planMigration(host, 'mod/old_mod9.mod');
        check(orphanPlan.patchMod?.orphans?.slice().sort().join() === 'common/defines/zz_old_mod9_1_20_fixes/zz_old_mod9_1_20_fixes_defines.txt,gui/window_faith.gui' && orphanPlan.replacePathsGone?.length === 4, `the plan: the window copy and the defines file are not needed, the four folders are not hidden any more (${JSON.stringify(orphanPlan.patchMod?.orphans)}, ${orphanPlan.replacePathsGone?.join()})`);
        const aOrphan = await migrateMod(host, 'mod/old_mod9.mod');
        const m5 = life9();
        check(!read9('gui/window_faith.gui') && !read9('common/defines/zz_old_mod9_1_20_fixes/zz_old_mod9_1_20_fixes_defines.txt') && !m5.restored['gui/window_faith.gui'] && !m5.generated?.length && !m5.files?.['common/defines/zz_old_mod9_1_20_fixes/zz_old_mod9_1_20_fixes_defines.txt'], `the files are deleted and their records dropped (${aOrphan.notes.filter((n) => /not needed/.test(n)).join(' | ')})`);
        check(!/replace_path/.test(readFileSync(join(patch9, 'descriptor.mod'), 'utf8')) && !/replace_path/.test(readFileSync(join(tmp, 'mod', 'old_mod9_1_20_fixes.mod'), 'utf8')) && m5.hidden?.length === 0 && aOrphan.notes.some((n) => /no longer hides/.test(n)), 'the patch mod’s descriptors do not hide the folders any more');
        const tree5 = tree9();
        const aOrphan2 = await migrateMod(host, 'mod/old_mod9.mod');
        check(!aOrphan2.rewritten.length && sameTree(tree5, tree9()), 'and a second run writes nothing');
        // (a copy of the game's file changed by hand is kept)
        put9('gui/window_faith.gui', faithWindow);
        await reindex();
        await migrateMod(host, 'mod/old_mod9.mod');
        writeFileSync(at9('gui/window_faith.gui'), '# mine\n');
        rmSync(join(root9, 'gui', 'window_faith.gui'));
        await reindex();
        const aKeep = await migrateMod(host, 'mod/old_mod9.mod');
        check(read9('gui/window_faith.gui') === '# mine\n' && aKeep.notes.some((n) => /changed by hand/.test(n) && n.includes('window_faith.gui')), `a game file changed by hand that no rule asks for is kept, told (${JSON.stringify((read9('gui/window_faith.gui') ?? '(none)').slice(0, 60))}; ${aKeep.notes.filter((n) => n.includes('window_faith')).join(' | ').slice(0, 400) || 'no note names it'}; written: ${aKeep.rewritten.filter((r) => /window_faith/.test(r)).join() || '-'})`);
        rmSync(at9('gui/window_faith.gui'));
        await migrateMod(host, 'mod/old_mod9.mod');

        // 6. a rule that fails does not take the others, nor the manifest, with it (a read-only copy of the game's window that has to be written again)
        put9('gui/window_faith.gui', faithWindow);
        put9('common/buildings/om9_buildings.txt', buildings9(['om9_temple_01', 'om9_temple_05']));
        await reindex();
        await migrateMod(host, 'mod/old_mod9.mod');
        {
            const olderGame = '# the game window of an older build\n';
            writeFileSync(at9('gui/window_faith.gui'), olderGame);
            chmodSync(at9('gui/window_faith.gui'), 0o444);
            const m = life9();
            m.restored['gui/window_faith.gui'] = sha1(Buffer.from(olderGame));
            m.game = '1.20.0.4';
            writeFileSync(join(patch9, '.crusaderpope-fixes.json'), JSON.stringify(m, null, 2));
            put9('common/buildings/om9_buildings.txt', buildings9(['om9_temple_01', 'om9_temple_06']));
            await reindex();
            let aFail: Awaited<ReturnType<typeof migrateMod>>;

            try
            {
                aFail = await migrateMod(host, 'mod/old_mod9.mod');
            }
            finally
            {
                // (undone even when the run throws: the read-only file would stay in the temp folder)
                chmodSync(at9('gui/window_faith.gui'), 0o666);
            }

            const failed = aFail.failed.length > 0;
            // (a read-only file cannot be renamed over on Windows, so the failure must happen there; elsewhere the case cannot fail a rule)
            check((failed || process.platform !== 'win32') && (!failed || (/window_faith|Interface|restor|game/i.test(aFail.failed.map((f) => f.name + f.why).join(' ')) && /om9_temple_06 = \{\s*province_rite_modifier/.test(read9('common/buildings/om9_buildings.txt') ?? '') && life9().game === '1.20.0.4' && life9().sources?.['common/buildings/om9_buildings.txt']?.src === modHash('common/buildings/om9_buildings.txt'))), `a rule that fails is in the result's failed list, the other rules and the manifest went on (${aFail.failed.map((f) => f.name + ': ' + f.why).join(' | ') || 'no failure on this platform'})`);
            await migrateMod(host, 'mod/old_mod9.mod');
            check(read9('gui/window_faith.gui') === readFileSync(join(gameDir, 'gui', 'window_faith.gui'), 'utf8'), 'and the next run does the rest');

            // (a manifest that cannot be written is a failure of the run, not a silent one: the next run would read this one's work as changes)
            const manifestPath = join(patch9, '.crusaderpope-fixes.json');
            const mOld = life9();
            const gameNow = mOld.game;
            mOld.game = '1.20.0.3';
            writeFileSync(manifestPath, JSON.stringify(mOld, null, 2) + '\n');
            chmodSync(manifestPath, 0o444);
            let aLocked: Awaited<ReturnType<typeof migrateMod>>;

            try
            {
                aLocked = await migrateMod(host, 'mod/old_mod9.mod');
            }
            finally
            {
                chmodSync(manifestPath, 0o666);
            }

            check(process.platform !== 'win32' || aLocked.failed.some((f) => /manifest/i.test(f.name)), `a manifest that cannot be written is in the failed list (${aLocked.failed.map((f) => f.name + ': ' + f.why).join(' | ') || 'nothing failed'})`);
            await migrateMod(host, 'mod/old_mod9.mod');
            check(life9().game === gameNow, 'and the next run writes it');
        }

        // 7. Cancel between the rules: the run stops, what was done is recorded, the next run goes on to the same patch mod
        {
            const tree7 = tree9();
            rmSync(patch9, { recursive: true, force: true });
            rmSync(join(tmp, 'mod', 'old_mod9_1_20_fixes.mod'), { force: true });
            await reindex();
            let counted = 0;
            let cancelErr = '';

            try
            {
                await migrateMod(host, 'mod/old_mod9.mod', { progress: (p) => void (p.total > 0 && !/^Fixing /.test(p.stage) && counted++), cancelled: () => counted > 0 });
            }
            catch (e)
            {
                cancelErr = e instanceof Error ? e.message : String(e);
            }

            check(/^Cancelled after \d+ of \d+ rules/.test(cancelErr) && !!life9().files && !!life9().sources, `Cancel is looked at between the rules, the manifest is written: ${cancelErr}`);
            const aGo = await migrateMod(host, 'mod/old_mod9.mod');
            check(!aGo.failed.length && sameTree(tree7, tree9()), 'the next run finishes the patch mod: the same one a run without Cancel makes');
        }

        // 8. a patch mod packed into a zip: told, not "already exists"
        {
            const root9p = join(tmp, 'mod', 'old_mod9p');
            const zipDir = join(tmp, 'zipsrc9');
            mkdirSync(root9p, { recursive: true });
            mkdirSync(zipDir, { recursive: true });
            const descP = 'version="1.0"\nname="Old Mod Nine P"\nsupported_version="1.19.0.6"\n';
            writeFileSync(join(root9p, 'descriptor.mod'), descP);
            writeFileSync(join(tmp, 'mod', 'old_mod9p.mod'), `${descP}path="${root9p.replace(/\\/g, '/')}"\n`);
            mkdirSync(join(root9p, 'common', 'buildings'), { recursive: true });
            writeFileSync(join(root9p, 'common', 'buildings', 'om9p_buildings.txt'), BOM + buildings9(['om9p_temple']));
            writeFileSync(join(zipDir, 'descriptor.mod'), 'version="1"\nname="Old Mod Nine P — 1.20 fixes"\nsupported_version="1.20.*"\n');
            await packFolder(zipDir, join(tmp, 'mod', 'old_mod9p_1_20_fixes.zip'));
            writeFileSync(join(tmp, 'mod', 'old_mod9p_1_20_fixes.mod'), `version="1"\nname="Old Mod Nine P — 1.20 fixes"\nsupported_version="1.20.*"\narchive="${join(tmp, 'mod', 'old_mod9p_1_20_fixes.zip').replace(/\\/g, '/')}"\n`);
            settings.customModLists![0].mods.push({ id: 'mod/old_mod9p.mod', enabled: true });
            await reindex();
            const packedPlan = await planMigration(host, 'mod/old_mod9p.mod');
            let packedErr = '';

            try
            {
                await migrateMod(host, 'mod/old_mod9p.mod');
            }
            catch (e)
            {
                packedErr = e instanceof Error ? e.message : String(e);
            }

            check(/packed into a zip: unpack it first/.test(packedPlan.problem ?? '') && packedErr === packedPlan.problem && !existsSync(join(tmp, 'mod', 'old_mod9p_1_20_fixes')), `a packed patch mod: the plan and the run say to unpack it (${packedErr})`);
        }

        // 9. nothing to do and no patch mod: none is made (a direct call, the dialog's button is off then)
        {
            const root9e = join(tmp, 'mod', 'old_mod9e');
            mkdirSync(join(root9e, 'common', 'traits'), { recursive: true });
            const descE = 'version="1.0"\nname="Old Mod Nine E"\nsupported_version="1.19.0.6"\n';
            writeFileSync(join(root9e, 'descriptor.mod'), descE);
            writeFileSync(join(tmp, 'mod', 'old_mod9e.mod'), `${descE}path="${root9e.replace(/\\/g, '/')}"\n`);
            writeFileSync(join(root9e, 'common', 'traits', 'om9e_traits.txt'), BOM + 'om9e_trait = {\n\tcategory = personality\n}\n');
            settings.customModLists![0].mods.push({ id: 'mod/old_mod9e.mod', enabled: true });
            await reindex();
            const listsBefore = JSON.stringify((await modsState(host)).lists);
            let emptyErr = '';

            try
            {
                await migrateMod(host, 'mod/old_mod9e.mod');
            }
            catch (e)
            {
                emptyErr = e instanceof Error ? e.message : String(e);
            }

            check(/needs nothing/.test(emptyErr) && !existsSync(join(tmp, 'mod', 'old_mod9e_1_20_fixes')) && !existsSync(join(tmp, 'mod', 'old_mod9e_1_20_fixes.mod')) && JSON.stringify((await modsState(host)).lists) === listsBefore, `nothing to fix: no patch mod, no .mod file, no list change (${emptyErr})`);
        }

        // 10. the mod catches up with the game: the Mods view tells the patch mod is not needed
        {
            const before = (await modsState(host)).mods.find((m) => m.id.toLowerCase().includes('old_mod9_1_20_fixes'));
            check(before?.patchFor?.id === 'mod/old_mod9.mod' && before.patchFor.obsolete === false, `a patch mod names its mod (${JSON.stringify(before?.patchFor)})`);
            writeFileSync(join(root9, 'descriptor.mod'), desc9(false).replace('1.19.0.6', '1.20.1.2'));
            writeFileSync(join(tmp, 'mod', 'old_mod9.mod'), `${desc9(false).replace('1.19.0.6', '1.20.1.2')}path="${root9.replace(/\\/g, '/')}"\n`);
            const after = (await modsState(host)).mods.find((m) => m.id.toLowerCase().includes('old_mod9_1_20_fixes'));
            check(after?.patchFor?.obsolete === true && !(await modsState(host)).mods.find((m) => m.id === 'mod/old_mod9.mod')?.patchFor, 'the mod’s own supported_version reaches the game’s: its patch mod is marked as not needed');
        }

        // 11. load order, mod lists and versions (docs/mods.md, "Load order and lists")
        {
            const BOM = '﻿';
            const mk11 = (stem: string, name: string, supported: string, tree: Record<string, string>, archive = false): string =>
            {
                const dir = join(tmp, 'mod', stem + (archive ? '_src' : ''));
                const desc = `version="1.0"\nname="${name}"\nsupported_version="${supported}"\n`;
                mkdirSync(dir, { recursive: true });
                writeFileSync(join(dir, 'descriptor.mod'), desc);

                for (const [rel, text] of Object.entries(tree))
                {
                    mkdirSync(join(dir, rel, '..'), { recursive: true });
                    writeFileSync(join(dir, rel), BOM + text);
                }

                writeFileSync(join(tmp, 'mod', stem + '.mod'), archive ? `${desc}archive="${join(tmp, 'mod', stem + '.zip').replace(/\\/g, '/')}"\n` : `${desc}path="${dir.replace(/\\/g, '/')}"\n`);
                return dir;
            };
            const buildings11 = (n: string): Record<string, string> => ({ [`common/buildings/${n}_buildings.txt`]: `${n}_temple_01 = {\n\tprovince_faith_modifier = {\n\t\tparameter = basic_pilgrimage_rewards\n\t\tmonthly_piety = 0.1\n\t}\n}\n` });
            const readIn = (dir: string, rel: string): string => (existsSync(join(dir, ...rel.split('/'))) ? readFileSync(join(dir, ...rel.split('/')), 'utf8') : '');

            // 1. a wildcard version names no game: every step is planned, the dialog says so; versions that name one are as before
            check(migrationsBetween('1.*.*', '1.20.1.2').length === migrationsBetween('1.19.0.6', '1.20.1.2').length && migrationsBetween('1.*.*', '1.20.1.2').length > 0 && migrationsBetween('*.*.*', '1.20.1.2').length > 0, 'a wildcard major or minor starts at the first step');
            check(migrationsBetween('1.20.*', '1.20.1.2').length === 0 && migrationsBetween('1.20.1.2', '1.20.1.2').length === 0 && migrationsBetween(undefined, '1.20.1.2').length === 0 && migrationsBetween('1.19.*', '1.20.1.2').length > 0, 'a version that names the game, and none at all, are as before');
            check(versionUnknown('1.*.*') && versionUnknown('*.*.*') && versionUnknown('*') && versionUnknown('v1.*') && !versionUnknown('1.19.*') && !versionUnknown('1.20.1.2') && !versionUnknown(undefined), 'versionUnknown: a wildcard where the major or minor number belongs');
            const rootW = mk11('old_mod11w', 'Old Mod Eleven W', '1.*.*', buildings11('om11w'));
            settings.customModLists!.push({ id: 'l11', name: 'List eleven', mods: [{ id: 'mod/old_mod11w.mod', enabled: true }] });
            settings.modList = 'custom:l11';
            await reindex();
            const planW = await planMigration(host, 'mod/old_mod11w.mod');
            check(planW.versionUnknown === true && planW.steps.length > 0 && planHasWork(planW) && !planW.problem, `a wildcard mod is planned (${planW.steps.length} steps, work ${planHasWork(planW)})`);
            const runW = await migrateMod(host, 'mod/old_mod11w.mod');
            check(!runW.failed.length && /province_rite_modifier/.test(readIn(join(tmp, 'mod', 'old_mod11w_1_20_fixes'), 'common/buildings/om11w_buildings.txt')) && readFileSync(join(rootW, 'common', 'buildings', 'om11w_buildings.txt'), 'utf8').includes('province_faith_modifier'), 'a wildcard mod is migrated, its own files stay');

            // 2. the launcher's .mod file says 1.19, the mod's own descriptor.mod says 1.20: the newer counts; the other way round, the .mod file's
            const rootO = mk11('old_mod11o', 'Old Mod Eleven O', '1.20.1.2', {});
            writeFileSync(join(tmp, 'mod', 'old_mod11o.mod'), `version="1.0"\nname="Old Mod Eleven O"\nsupported_version="1.19.0.6"\npath="${rootO.replace(/\\/g, '/')}"\n`);
            const rootP = mk11('old_mod11p', 'Old Mod Eleven P', '1.19.0.6', {});
            writeFileSync(join(tmp, 'mod', 'old_mod11p.mod'), `version="1.0"\nname="Old Mod Eleven P"\nsupported_version="1.20.1.2"\npath="${rootP.replace(/\\/g, '/')}"\n`);
            const st11 = await modsState(host);
            check(st11.mods.find((m) => m.id === 'mod/old_mod11o.mod')?.supportedVersion === '1.20.1.2' && st11.mods.find((m) => m.id === 'mod/old_mod11p.mod')?.supportedVersion === '1.20.1.2', 'the newer of the .mod file’s and the mod’s own supported_version counts');
            const rootQ = mk11('old_mod11q', 'Old Mod Eleven Q', '1.20.1.2', {});
            writeFileSync(join(tmp, 'mod', 'old_mod11q.mod'), `version="1.0"\nname="Old Mod Eleven Q"\nsupported_version="1.*.*"\npath="${rootQ.replace(/\\/g, '/')}"\n`);
            check((await modsState(host)).mods.find((m) => m.id === 'mod/old_mod11q.mod')?.supportedVersion === '1.20.1.2', 'a wildcard in the .mod file loses to the mod’s own concrete version');

            // 3. a mod packed into a zip: its patch mod is named by the mod’s id, not by the archive (a UUID)
            {
                const dirA = mk11('pdx_11746', 'Old Mod Eleven Zip', '1.19.0.6', buildings11('om11z'), true);
                await packFolder(dirA, join(tmp, 'mod', 'pdx_11746.zip'));
                const zipName = join(tmp, 'mod', '87fa0fb0-ef91-11ea-a735-2b61572cb70a.zip');
                renameSync(join(tmp, 'mod', 'pdx_11746.zip'), zipName);
                writeFileSync(join(tmp, 'mod', 'pdx_11746.mod'), `version="1.0"\nname="Old Mod Eleven Zip"\nsupported_version="1.19.0.6"\narchive="${zipName.replace(/\\/g, '/')}"\n`);
                settings.customModLists!.find((l) => l.id === 'l11')!.mods.push({ id: 'mod/pdx_11746.mod', enabled: true });
                await reindex();
                const runZ = await migrateMod(host, 'mod/pdx_11746.mod');
                check(!runZ.failed.length && existsSync(join(tmp, 'mod', 'pdx_11746_1_20_fixes', 'descriptor.mod')) && !existsSync(join(tmp, 'mod', '87fa0fb0-ef91-11ea-a735-2b61572cb70a_1_20_fixes')), `a packed mod’s patch mod is named after its .mod file (${runZ.patch.folder})`);
            }

            // 4. other mods' defines and concepts: the patch mod's zz_ files load after every ordinary file of the folder, so what another mod
            // (before the patch mod, or after it) sets is not written; a second patch mod leaves what the first wrote
            {
                const parsedKeys = (rel: string): string[] => parse(readFileSync(join(gameDir, ...rel.split('/')), 'utf8').replace(/^﻿/, '')).filter((n) => n.k && Array.isArray(n.v)).map((n) => n.k!);
                const ns = parse(readFileSync(join(gameDir, 'common', 'defines', '00_defines.txt'), 'utf8').replace(/^﻿/, '')).find((n) => n.k && Array.isArray(n.v) && n.v.some((c) => c.k))!;
                const kids = ns.v as PNode[];
                const defKey = kids.find((c) => c.k)!.k!;
                const conceptKeys = parsedKeys('common/game_concepts/00_game_concepts.txt');
                const stubs = { 'common/defines/00_defines.txt': 'NFaith = {\n\tOM11_OWN_VALUE = 1\n}\n', 'common/game_concepts/00_game_concepts.txt': 'om11_concept = {\n\ttexture = "gfx/interface/icons/om.dds"\n}\n' };
                // (X also has a list define; Y does not: a define another mod of the list sets is not written, so only one of them can be asked for it)
                mk11('old_mod11x', 'Old Mod Eleven X', '1.19.0.6', { ...stubs, 'common/defines/00_defines.txt': stubs['common/defines/00_defines.txt'] + '\nNGovernment = {\n\tGOVERNMENT_TYPES = {\n\t\t"feudal_government"\n\t\t"om11_government"\n\t}\n}\n' });
                mk11('old_mod11y', 'Old Mod Eleven Y', '1.19.0.6', stubs);
                mk11('old_mod11c', 'Old Mod Eleven C', '1.20.1.2', { 'common/defines/20_c_defines.txt': `${String(ns.k)} = {\n\t${defKey} = 4242\n}\n`, 'common/game_concepts/20_c_concepts.txt': `${conceptKeys[0]} = {\n\ttexture = "gfx/interface/icons/om_c.dds"\n}\n` });
                mk11('old_mod11d', 'Old Mod Eleven D', '1.20.1.2', { 'common/defines/10_d_defines.txt': `${String(ns.k)} = {\n\t${defKey} = 777\n}\n` });
                const l = settings.customModLists!.find((x) => x.id === 'l11')!;
                l.mods = ['old_mod11d', 'old_mod11x', 'old_mod11c', 'old_mod11y'].map((s) => ({ id: `mod/${s}.mod`, enabled: true }));
                await reindex();
                const planX = await planMigration(host, 'mod/old_mod11x.mod');
                check(planX.rewrites?.some((r) => r.kind === 'defines' && r.todo.length > 0) === true && planX.rewrites.some((r) => r.kind === 'merge' && r.todo.length > 0 && r.files.includes('common/game_concepts/00_game_concepts.txt')), 'the stubs have defines and concepts to write');
                await migrateMod(host, 'mod/old_mod11x.mod');
                const patchX = join(tmp, 'mod', 'old_mod11x_1_20_fixes');
                const defsX = readIn(patchX, 'common/defines/zz_old_mod11x_1_20_fixes/zz_old_mod11x_1_20_fixes_defines.txt');
                const conceptsX = readIn(patchX, 'common/game_concepts/zz_old_mod11x_1_20_fixes_game_concepts.txt');
                const hasKey = (text: string, key: string): boolean => new RegExp(`^\\s*${key}\\s*=`, 'm').test(text);
                const otherDef = kids.filter((c) => c.k).map((c) => c.k as string).find((k) => k !== defKey)!;
                check(defsX.length > 0 && !hasKey(defsX, defKey) && (otherDef ? hasKey(defsX, otherDef) : true), `a define another mod sets (before or after the patch mod) is not written: ${defKey} out, ${otherDef} in`);
                check(/GOVERNMENT_TYPES = \{\s*"feudal_government"\s*"om11_government"(\s*"[a-z_]+_government")+\s*\}/.test(defsX) && defsX.includes('"ecclesiastical_government"') && defsX.includes('"theocracy_government"') && (defsX.match(/"feudal_government"/g) ?? []).length === 1, `defines: a list define of the mod (GOVERNMENT_TYPES) is written again with its own words and the governments the game has: ${defsX.slice(defsX.indexOf('NGovernment'), defsX.indexOf('NGovernment') + 400)}`);
                check(conceptsX.length > 0 && !hasKey(conceptsX, conceptKeys[0]) && conceptKeys.slice(1).some((k) => hasKey(conceptsX, k)), `a concept another mod defines is not written: ${conceptKeys[0]} out`);
                const idle = await planMigration(host, 'mod/old_mod11x.mod');
                check(!(idle.rewrites ?? []).some((r) => (r.kind === 'defines' || r.kind === 'merge') && r.todo.length > 0), 'a second plan: defines and concepts done');
                // (a second patch mod: the first one's generated files do not count, so it carries the game's content too, but still not what C and D set)
                await migrateMod(host, 'mod/old_mod11y.mod');
                const patchY = join(tmp, 'mod', 'old_mod11y_1_20_fixes');
                const defsY = readIn(patchY, 'common/defines/zz_old_mod11y_1_20_fixes/zz_old_mod11y_1_20_fixes_defines.txt');
                const conceptsY = readIn(patchY, 'common/game_concepts/zz_old_mod11y_1_20_fixes_game_concepts.txt');
                check(defsY.length > 0 && hasKey(defsY, otherDef) && !hasKey(defsY, defKey) && conceptsY.length > 0 && !hasKey(conceptsY, conceptKeys[0]) && conceptKeys.slice(1).some((k) => hasKey(conceptsY, k)), 'a second patch mod stands on its own and leaves what another mod sets');
            }

            // 4b. replace_path hides the files directly in a folder, not those in its subfolders: the game's history/titles/ce3/00_ecclesiastical_titles.txt
            // still loads in a mod that replaces the titles and their history, and names titles the loaded files lack: an empty file of the same path
            {
                const rel = 'history/titles/ce3/00_ecclesiastical_titles.txt';
                const dirT = mk11('old_mod11t', 'Old Mod Eleven T', '1.19.0.6', { 'common/landed_titles/00_om11t_titles.txt': 'k_om11t = {\n\tcolor = { 1 2 3 }\n}\n', 'history/titles/om11t_history.txt': 'k_om11t = {\n\t1000.1.1 = { holder = 0 }\n}\n' });
                const replaces = 'replace_path="common/landed_titles"\nreplace_path="history/titles"\n';

                for (const f of [join(dirT, 'descriptor.mod'), join(tmp, 'mod', 'old_mod11t.mod')])
                    writeFileSync(f, readFileSync(f, 'utf8') + replaces);

                check(existsSync(join(gameDir, ...rel.split('/'))), 'the game has a file in a subfolder of history/titles');
                settings.customModLists!.find((x) => x.id === 'l11')!.mods = [{ id: 'mod/old_mod11t.mod', enabled: true }, { id: 'mod/old_mod11x.mod', enabled: true }];
                await reindex();
                const planT = await planMigration(host, 'mod/old_mod11t.mod');
                const emptyT = planT.rewrites?.find((r) => r.kind === 'empty' && r.files.includes(rel));
                check(!!emptyT && emptyT.todo.includes(rel) && !!emptyT.notes?.some((n) => n.startsWith(rel + ':') && n.includes('replace_path of history/titles') && n.includes('d_cd_ostia')), `a mod that replaces the titles and their history: the plan empties the game's file in the subfolder, with a note (${JSON.stringify(emptyT?.notes)})`);
                const runT = await migrateMod(host, 'mod/old_mod11t.mod');
                const patchT = join(tmp, 'mod', 'old_mod11t_1_20_fixes');
                check(!runT.failed.length && existsSync(join(patchT, ...rel.split('/'))) && readFileSync(join(patchT, ...rel.split('/')), 'utf8') === '' && runT.notes.some((n) => n.startsWith(rel + ':')), `the patch mod holds an empty file of the same path, and the result says why (${runT.failed.join(', ')})`);
                await reindex();
                const idleT = await planMigration(host, 'mod/old_mod11t.mod');
                const againT = await migrateMod(host, 'mod/old_mod11t.mod');
                check(!idleT.rewrites?.some((r) => r.kind === 'empty' && r.todo.length > 0) && !againT.rewritten.includes(rel), 'a second run: the empty file is done');
                const planOther = await planMigration(host, 'mod/old_mod11x.mod');
                check(!planOther.rewrites?.some((r) => r.kind === 'empty' && r.files.includes(rel)), 'a mod that replaces no history/titles has nothing to empty: its titles are all there');

                // (a world that has one of the file's titles: the game's text of that one stays, the others are cut out)
                {
                    const keysT = parse(readFileSync(join(gameDir, ...rel.split('/')), 'utf8').replace(/^﻿/, '')).flatMap((n) => (n.k && !n.k.startsWith('@') ? [n.k] : []));
                    const dirP = mk11('old_mod11p', 'Old Mod Eleven P', '1.19.0.6', { 'common/landed_titles/00_om11p_titles.txt': `${keysT[1]} = {\n\tcolor = { 1 2 3 }\n}\n`, 'history/titles/om11p_history.txt': 'k_om11p = {\n\t1000.1.1 = { holder = 0 }\n}\n' });

                    for (const f of [join(dirP, 'descriptor.mod'), join(tmp, 'mod', 'old_mod11p.mod')])
                        writeFileSync(f, readFileSync(f, 'utf8') + replaces);

                    settings.customModLists!.find((x) => x.id === 'l11')!.mods = [{ id: 'mod/old_mod11p.mod', enabled: true }, { id: 'mod/old_mod11x.mod', enabled: true }];
                    await reindex();
                    const runP = await migrateMod(host, 'mod/old_mod11p.mod');
                    const textP = existsSync(join(tmp, 'mod', 'old_mod11p_1_20_fixes', ...rel.split('/'))) ? readFileSync(join(tmp, 'mod', 'old_mod11p_1_20_fixes', ...rel.split('/')), 'utf8') : '';
                    const keptP = parse(textP).filter((n) => n.k && !n.k.startsWith('@')).map((n) => n.k);
                    check(!runP.failed.length && keysT.length > 2 && keptP.join() === keysT[1], `a world that has one of the file's ${keysT.length} titles: the patch mod keeps the game's text of that one only (${keptP.join()})`);
                    const againP = await migrateMod(host, 'mod/old_mod11p.mod');
                    check(!againP.rewritten.includes(rel), 'a second run: the cut file is done');
                }
            }

            // 5. the game's list (dlc_load.json): a second mod’s run keeps the first patch mod in the list made from it; the list is named by the game's list
            {
                mk11('old_mod11a', 'Old Mod Eleven A', '1.19.0.6', buildings11('om11a'));
                mk11('old_mod11b', 'Old Mod Eleven B', '1.19.0.6', buildings11('om11b'));
                writeFileSync(join(tmp, 'dlc_load.json'), JSON.stringify({ enabled_mods: ['mod/old_mod11a.mod', 'mod/old_mod11b.mod'] }));
                settings.modList = 'game';
                await reindex();
                const runA = await migrateMod(host, 'mod/old_mod11a.mod');
                check(!runA.failed.length && /^Game \(dlc_load\.json\) with .* fixes$/.test(runA.list) && !runA.list.includes('Eleven A'), `the list made from the game's list is named by it, not by the patch mod (${runA.list})`);
                // (the owner selects the game's list again: A's patch mod is not loaded)
                settings.modList = 'game';
                await reindex();
                const planA = await planMigration(host, 'mod/old_mod11a.mod');
                check(planA.patchMod?.placed === 'missing' && planHasWork(planA) && !planA.findings.some((f) => f.fix), `the patch mod is not in the loaded list: the plan says so, and does not count its fixes as to do (${planA.patchMod?.placed}, ${planA.findings.filter((f) => f.fix).length} fixes)`);
                const runB = await migrateMod(host, 'mod/old_mod11b.mod');
                const listB = (await modsState(host)).lists.find((x) => x.name === runB.list)!;
                const order = listB.mods.map((m) => m.id.replace(/^mod\//, '').replace(/\.mod$/, ''));
                check(order.join() === 'old_mod11a,old_mod11a_1_20_fixes,old_mod11b,old_mod11b_1_20_fixes', `a second mod’s run keeps the first patch mod in the list (${order.join()})`);
                check((await modsState(host)).lists.filter((x) => x.kind === 'custom' && x.name.startsWith('Game (dlc_load.json)')).length === 1, 'one list for the two runs');
                // (the patch mod before its mod overrides nothing: told, and a run moves it)
                const lb = (await modsState(host)).lists.find((x) => x.name === runB.list)!;
                const swapped = [...lb.mods];
                [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
                await saveList(host, { ref: lb.ref, name: lb.name, mods: swapped });
                await selectList(host, lb.ref);
                await reindex();
                const planBefore = await planMigration(host, 'mod/old_mod11a.mod');
                check(planBefore.patchMod?.placed === 'before' && planHasWork(planBefore), `a patch mod loaded before its mod is told (${planBefore.patchMod?.placed})`);
                await migrateMod(host, 'mod/old_mod11a.mod');
                const fixedList = (await modsState(host)).lists.find((x) => x.ref === lb.ref)!;
                check(fixedList.mods.map((m) => m.id.replace(/^mod\//, '').replace(/\.mod$/, '')).join() === 'old_mod11a,old_mod11a_1_20_fixes,old_mod11b,old_mod11b_1_20_fixes', 'a run puts it right after its mod');
                // (the owner edits the made list (a mod added at the end) and migrates again with the game's list selected: the edit stays)
                await saveList(host, { ref: lb.ref, name: lb.name, mods: [...fixedList.mods.map((m) => ({ id: m.id, enabled: m.enabled })), { id: 'mod/old_mod11x.mod', enabled: true }] });
                settings.modList = 'game';
                await reindex();
                const runC = await migrateMod(host, 'mod/old_mod11b.mod');
                const listC = (await modsState(host)).lists.filter((x) => x.kind === 'custom' && x.name.startsWith('Game (dlc_load.json)'));
                check(runC.list === lb.name && listC.length === 1 && listC[0].mods.some((m) => m.id === 'mod/old_mod11x.mod') && listC[0].mods.length === 5, `a later run from the game's list keeps the edits of the list made before (${listC[0]?.mods.length} mods)`);
            }
        }

        settings.modList = 'custom:l1';

        // (text saved as Windows-1252, banner and icon textures carried into the new folder, a zipped mod with many files)
        {
            const BOM15 = '﻿';
            const ansi = (s: string): Buffer => Buffer.from(s, 'latin1');
            const dds15 = (fourCC: string, dxgi: number | undefined, dataLen: number): Buffer =>
            {
                const b = Buffer.alloc(128 + (dxgi ? 20 : 0) + dataLen);
                b.write('DDS ', 0, 'latin1');
                b.writeUInt32LE(124, 4);
                b.writeUInt32LE(0xa1007, 8);
                b.writeUInt32LE(4, 12);
                b.writeUInt32LE(4, 16);
                b.writeUInt32LE(16, 20);
                b.writeUInt32LE(1, 28);
                b.writeUInt32LE(32, 76);
                b.writeUInt32LE(4, 80);
                b.write(fourCC, 84, 'latin1');
                b.writeUInt32LE(0x401008, 108);

                if (dxgi)
                {
                    b.writeUInt32LE(dxgi, 128);
                    b.writeUInt32LE(3, 132);
                    b.writeUInt32LE(1, 140);
                }

                for (let i = 128 + (dxgi ? 20 : 0); i < b.length; i++)
                    b[i] = (i * 7) % 251;

                return b;
            };
            const mk15 = (stem: string, name: string, archive = false): string =>
            {
                const dir = join(tmp, 'mod', stem + (archive ? '_src' : ''));
                const desc = `version="1.0"\nname="${name}"\nsupported_version="1.19.0.6"\n`;
                mkdirSync(dir, { recursive: true });
                writeFileSync(join(dir, 'descriptor.mod'), desc);
                writeFileSync(join(tmp, 'mod', stem + '.mod'), archive ? `${desc}archive="${join(tmp, 'mod', stem + '.zip').replace(/\\/g, '/')}"\n` : `${desc}path="${dir.replace(/\\/g, '/')}"\n`);
                return dir;
            };
            const raw15 = (dir: string, rel: string, data: Buffer | string): void =>
            {
                mkdirSync(join(dir, rel, '..'), { recursive: true });
                writeFileSync(join(dir, rel), data);
            };
            // 1. Windows-1252 files (single bytes above 0x7F, CRLF, no byte order mark and a BOM one) that rules rewrite
            const root15 = mk15('old_mod15', 'Old Mod Fifteen');
            const decision15 = '# Sancho Ram\xEDrez\r\nom15_decision = {\r\n\tdesc = "Caf\xE9 \xDCber \x80"\r\n\twidget = {\r\n\t\tbarony_valid = {\r\n\t\t\tis_alive = yes\r\n\t\t}\r\n\t}\r\n}\r\n';
            const gui15 = 'window = {\r\n\t# Ram\xEDrez\r\n\tname = "om15_calls"\r\n\ttext = "Caf\xE9"\r\n\tbutton = { onclick = "[ClearExploringRealms]" }\r\n}\r\n';
            const loc15 = 'l_english:\r\n OM15_STATE: "Caf\xE9 \xDCber [Title.GetStateFaith.GetName]"\r\n';
            raw15(root15, 'common/decisions/om15_decisions.txt', ansi(decision15));
            raw15(root15, 'gui/om15_calls.gui', ansi(gui15));
            raw15(root15, 'localization/replace/english/om15_l_english.yml', Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), ansi(loc15)]));
            // 2. banner and icon textures in the old folder, DX10 headers around BC3 and BC1 (carried to faith_tenets by the banners and icons rules)
            const oldIcons = 'gfx/interface/icons/faith_doctrines';
            const tenetIcons = 'gfx/interface/icons/faith_tenets';
            raw15(root15, 'common/religion/religion_family_types/om15_families.txt', BOM15 + 'rf_om15 = {\n\tgraphical_faith = "orthodox_gfx"\n\tdoctrine_background_icon = core_tenet_banner_om15.dds\n}\n');
            raw15(root15, 'common/religion/tenet_types/om15_tenets.txt', BOM15 + 'tenet_om15 = {\n\ticon = core_tenet_om15\n\tpiety_cost = { value = 0 }\n}\n');
            const banner15 = dds15('DX10', 78, 32);
            const small15 = dds15('DX10', 78, 16);
            const icon15 = dds15('DX10', 71, 8);
            raw15(root15, `${oldIcons}/core_tenet_banner_om15.dds`, banner15);
            raw15(root15, `${oldIcons}/core_tenet_banner_om15_small.dds`, small15);
            raw15(root15, `${oldIcons}/core_tenet_om15.dds`, icon15);
            // 3. a zipped mod and its loose twin: 2500 small files (planning opened the archive again for every file read), a Windows-1252 decision, a DX10 texture
            const N15 = 2500;
            const trait15 = (i: number): string => `om15z_trait_${i} = {\n\tcategory = personality\n\tgenetic = no\n}\n`;
            const zipSrc = mk15('old_mod15z', 'Old Mod Fifteen Zip', true);
            const looseDir = mk15('old_mod15l', 'Old Mod Fifteen Loose');

            for (const dir of [zipSrc, looseDir])
            {
                for (let i = 0; i < N15; i++)
                    raw15(dir, `common/traits/om15z_${String(i).padStart(4, '0')}.txt`, BOM15 + trait15(i));

                raw15(dir, 'common/decisions/om15z_decisions.txt', ansi(decision15));
                raw15(dir, 'gfx/om15z/big.dds', dds15('DX10', 78, 300000));
            }

            await packFolder(zipSrc, join(tmp, 'mod', 'old_mod15z.zip'));
            settings.customModLists!.push({ id: 'l15', name: 'M15', mods: ['old_mod15', 'old_mod15z', 'old_mod15l'].map((s) => ({ id: `mod/${s}.mod`, enabled: true })) });
            settings.modList = 'custom:l15';
            await reindex();
            const at15 = (patch: string, rel: string): Buffer | undefined => (existsSync(join(patch, ...rel.split('/'))) ? readFileSync(join(patch, ...rel.split('/'))) : undefined);
            const noFffd = (b: Buffer | undefined): boolean => !!b && !b.includes(Buffer.from([0xEF, 0xBF, 0xBD]));
            const plan15 = await planMigration(host, 'mod/old_mod15.mod');
            const dds15Rule = (plan15.rewrites ?? []).find((x) => x.kind === 'ddsLegacy');
            const r15 = await migrateMod(host, 'mod/old_mod15.mod');
            const patch15 = join(tmp, 'mod', 'old_mod15_1_20_fixes');
            const decOut = at15(patch15, 'common/decisions/om15_decisions.txt');
            const guiOut = at15(patch15, 'gui/om15_calls.gui');
            const locOut = at15(patch15, 'localization/replace/english/om15_l_english.yml');
            check(!r15.failed.length, `the run of the Windows-1252 mod: nothing failed (${r15.failed.join(' | ')})`);
            check(noFffd(decOut) && decOut!.toString('latin1') === decision15.replace('barony_valid', 'title_valid') && decOut!.includes(Buffer.from([0xED])), `a Windows-1252 script file: the key is renamed, every other byte is the mod's (no U+FFFD, the single bytes stay): ${decOut?.toString('latin1').slice(0, 80)}`);
            check(noFffd(guiOut) && guiOut!.toString('latin1') === gui15.replace('ClearExploringRealms', 'ClearExploredRealms'), `a Windows-1252 interface file: the call is renamed, every other byte stays: ${guiOut?.toString('latin1').slice(0, 120)}`);
            check(noFffd(locOut) && locOut!.toString('latin1') === '\xEF\xBB\xBF' + loc15.replace('GetStateFaith', 'GetStateRite'), `a Windows-1252 localization file: the call is renamed, the byte order mark and the other bytes stay: ${locOut?.toString('latin1').slice(0, 120)}`);
            check(readFileSync(join(root15, 'common', 'decisions', 'om15_decisions.txt')).equals(ansi(decision15)), 'the mod’s own Windows-1252 file is untouched');
            // 4. the carried copies: the 1.20 folder holds the plain header, whatever the old folder's copy has
            const bannerOut = at15(patch15, `${tenetIcons}/core_tenet_banner_om15.dds`);
            const smallOut = at15(patch15, `${tenetIcons}/core_tenet_banner_om15_small.dds`);
            const iconOut = at15(patch15, `${tenetIcons}/core_tenet_om15.dds`);
            check(!!dds15Rule && dds15Rule.files.some((f) => f.endsWith('core_tenet_banner_om15.dds')), `the plan: the mod's own DX10 banner is a ddsLegacy file (${JSON.stringify(dds15Rule?.files)})`);
            check(!!bannerOut && bannerOut.toString('latin1', 84, 88) === 'DXT5' && bannerOut.length === banner15.length - 20 && bannerOut.subarray(128).equals(banner15.subarray(148)), `a banner carried into faith_tenets (DX10 BC3 in the mod): the plain DXT5 header, the block data the same (${bannerOut?.toString('latin1', 84, 88)})`);
            check(!!smallOut && smallOut.toString('latin1', 84, 88) === 'DXT5' && !!iconOut && iconOut.toString('latin1', 84, 88) === 'DXT1' && iconOut.subarray(128).equals(icon15.subarray(148)), `the _small banner and a tenet icon carried the same way (${smallOut?.toString('latin1', 84, 88)}, ${iconOut?.toString('latin1', 84, 88)})`);
            const again15 = await planMigration(host, 'mod/old_mod15.mod');
            check((again15.rewrites ?? []).every((x) => x.todo.length === 0 || x.kind === 'libraries'), `the plan of a second run: every rule done (${(again15.rewrites ?? []).filter((x) => x.todo.length && x.kind !== 'libraries').map((x) => x.kind).join()})`);
            const before15 = files(patch15);
            const r15b = await migrateMod(host, 'mod/old_mod15.mod');
            const after15 = files(patch15);
            check(!r15b.rewritten.length && after15.size === before15.size && [...before15].every(([k, v]) => after15.get(k) === v), `a second run writes nothing (${r15b.rewritten.join(', ')})`);
            // (a patch mod of an older run, whose carried copy still has the DX10 header: the rule finds it by its path in the patch mod)
            writeFileSync(join(patch15, ...`${tenetIcons}/core_tenet_banner_om15.dds`.split('/')), banner15);
            const stale15 = await planMigration(host, 'mod/old_mod15.mod');
            check((stale15.rewrites ?? []).find((x) => x.kind === 'ddsLegacy')?.todo.some((f) => f === `${tenetIcons}/core_tenet_banner_om15.dds`), 'a carried copy of an older run that still has the DX10 header is found');
            await migrateMod(host, 'mod/old_mod15.mod');
            check(at15(patch15, `${tenetIcons}/core_tenet_banner_om15.dds`)?.toString('latin1', 84, 88) === 'DXT5', 'and fixed');
            // (the run that only rewrote the carried copy keeps its source record: the mod changing or dropping the banner is still seen)
            const srcs15 = (): Record<string, { from: string; }> => (JSON.parse(readFileSync(join(patch15, '.crusaderpope-fixes.json'), 'utf8')) as { sources?: Record<string, { from: string; }>; }).sources ?? {};
            check(srcs15()[`${tenetIcons}/core_tenet_banner_om15.dds`]?.from === `${oldIcons}/core_tenet_banner_om15.dds` && srcs15()[`${tenetIcons}/core_tenet_om15.dds`]?.from === `${oldIcons}/core_tenet_om15.dds`, `a carried copy the DX10 rule rewrote in place keeps the record of its source (${JSON.stringify(srcs15()[`${tenetIcons}/core_tenet_banner_om15.dds`])})`);
            // 5. the zipped mod: planning reads each file from one open archive
            const time = async <T>(f: () => Promise<T>): Promise<[T, number]> =>
            {
                const t0 = Date.now();
                const v = await f();
                return [v, Date.now() - t0];
            };
            const [planL, msLoose] = await time(() => planMigration(host, 'mod/old_mod15l.mod', { libraries: false }));
            const [planZ, msZip] = await time(() => planMigration(host, 'mod/old_mod15z.mod', { libraries: false }));
            check(msZip < msLoose * 3 + 3000, `planning a zipped mod of ${N15 + 2} files takes about as long as its loose twin (${msZip} ms zipped, ${msLoose} ms loose)`);
            check((planZ.rewrites ?? []).map((x) => `${x.kind}:${x.files.length}`).join() === (planL.rewrites ?? []).map((x) => `${x.kind}:${x.files.length}`).join() && (planZ.rewrites ?? []).some((x) => x.kind === 'ddsLegacy' && x.files.join() === 'gfx/om15z/big.dds'), `the zipped mod's plan is the loose mod's (${(planZ.rewrites ?? []).map((x) => `${x.kind}:${x.files.length}`).join()})`);
            const [rZ, msRun] = await time(() => migrateMod(host, 'mod/old_mod15z.mod'));
            const patchZ = join(tmp, 'mod', 'old_mod15z_1_20_fixes');
            const bigZ = at15(patchZ, 'gfx/om15z/big.dds');
            check(!rZ.failed.length && !!bigZ && bigZ.toString('latin1', 84, 88) === 'DXT5' && bigZ.length === 128 + 300000, `the zipped mod's run: the DX10 texture inside the zip gets the plain header (${rZ.failed.join(' | ')}; ${msRun} ms)`);
            const decZ = at15(patchZ, 'common/decisions/om15z_decisions.txt');
            check(noFffd(decZ) && decZ!.toString('latin1') === decision15.replace('barony_valid', 'title_valid'), 'a Windows-1252 file inside the zip is rewritten without losing its bytes');
            // 6. the head of an entry: only its first bytes are inflated and a copy is kept (a view would hold the whole texture)
            {
                const headDir = join(tmp, 'mod', 'old_mod15_heads');
                raw15(headDir, 'zeros.txt', Buffer.alloc(8 << 20));
                raw15(headDir, 'tiny.txt', 'abc');
                await packFolder(headDir, join(tmp, 'mod', 'old_mod15_heads.zip'));
                const hz = new ZipArchive(join(tmp, 'mod', 'old_mod15_heads.zip'));
                const zeros = hz.readHead('zeros.txt', 148);
                check(hz.get('zeros.txt')?.method === 8 && !!zeros && zeros.length === 148 && zeros.every((b) => b === 0) && zeros.buffer.byteLength <= 16384, `the head of a deflated entry of 8 MB is 148 bytes in a buffer of its own (${zeros?.buffer.byteLength})`);
                check(hz.readHead('tiny.txt', 148)?.toString() === 'abc' && hz.readHead('nothing.txt', 148) === undefined, 'a head longer than the entry is the entry; a missing entry has none');
                hz.close();
            }
            settings.modList = 'custom:l1';
        }
    }
}
catch (e)
{
    check(false, String((e as Error).stack ?? e));
}
finally
{
    layers.forEach((f) => f.close());

    if (process.argv[2] === 'keep')
        console.log('kept: ' + tmp);
    else
    {
        // (the zipped mods of the last index were held open until here: the folder was found empty minutes later, when the process had ended.
        // Anything else that holds a file for a moment (a virus scanner, the search indexer) is waited for: Node retries ENOTEMPTY / EBUSY / EPERM
        // itself with maxRetries; a leftover after that is a warning about the temp folder, not a failure of what was checked; failures only
        // come from check())
        try
        {
            rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        }
        catch (e)
        {
            const left = existsSync(tmp) ? (readdirSync(tmp, { recursive: true }) as string[]).filter((f) => /\.\w+$/.test(f)) : [];
            console.log(`warning: the temp folder ${tmp} could not be removed (${(e as NodeJS.ErrnoException).code ?? e}; left: ${left.join(', ') || 'folders only'}); delete it by hand`);
        }
    }
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
