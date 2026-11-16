// Unit cases of the inert rewrite (src/main/mods/inert.ts): a statement that names an entry the world lacks becomes false (or is
// dropped), folds with its neighbours, and leaves comments, line ends, macros and scope-saving blocks alone. No game files needed.
// Usage: node --experimental-strip-types --no-warnings scripts/inert-check.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inertText, type InertKind, type InertWorld } from '../src/main/mods/inert.ts';
import { inertWorld } from '../src/main/mods/inertWorld.ts';
import { inertOutputs } from '../src/main/mods/inertRule.ts';
import { inertWork, staleGameCopies, type InertWork } from '../src/main/mods/inertWork.ts';
import { orphanedRecords } from '../src/main/mods/patchLife.ts';
import { sha1 } from '../src/main/mods/fixesManifest.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

// (the world: these entries are gone)
const GONE = new Set(['religion:christianity_religion', 'faith:catholic', 'rite:roman_rite', 'culture:greek', 'doctrine:special_doc', 'title:k_papal_state', 'trait:herald',
    'region:world_india', 'doctrine_param:pacifist_opinion_active', 'maa:sicarii', 'artifact:christian_artifact_template', 'event:great_holy_war.0001', 'pillar:language_latin',
    'modifier:rejected_modifier', 'law:church_authority_1', 'religion:buddhism_religion', 'perk:erudite_perk', 'accolade:gunpowder_attribute', 'tradition:tradition_gone',
    'poi:poi_gone', 'trait:erudite', 'trait:lifestyle_scholar', 'cb:religious_war', 'doctrine:doctrine_gone', 'holy_site:rome', 'doctrine_param:devoted_trait_criminal',
    'scripted_trigger:tgp_is_any_minister', 'scripted_trigger:tgp_access_trigger', 'scripted_effect:tgp_remove_effect', 'scripted_effect:tgp_saving_effect', 'script_value:tgp_gone_value',
    'modifier_type:lifestyle_scholar_xp_gain_mult', 'law_flag:clergy_force_land_transfers', 'government_flag:government_is_monastic_holy_order', 'building_flag:gone_building_flag']);
const world: InertWorld = {
    missing: (kind: InertKind, name: string) => GONE.has(`${kind}:${name}`),
    effectKeeps: (name) => (name === 'tgp_saving_effect' ? 'scope' : undefined)
};
const run = (text: string, folder = 'common/scripted_triggers/x.txt'): string => inertText(text, folder, world).text;
const eq = (text: string, want: string, what: string, folder?: string): void =>
{
    const got = run(text, folder);
    check(got === want, what);

    if (got !== want)
        console.log('   got:  ' + JSON.stringify(got) + '\n   want: ' + JSON.stringify(want));

    // (a second pass changes nothing)
    check(run(got, folder) === got, `${what} (second pass)`);
};

// the tests of missing entries
eq('t = {\n\treligion = religion:christianity_religion\n\tage > 3\n}\n', 't = {\n\talways = no\n\tage > 3\n}\n', 'a comparison with a missing religion is false');
eq('t = {\n\treligion != religion:christianity_religion\n\tage > 3\n}\n', 't = {\n\tage > 3\n}\n', '!= a missing religion is true: among other statements it goes');
eq('t = {\n\treligion != religion:christianity_religion\n}\n', 't = {\n\talways = yes\n}\n', '!= a missing religion alone stays as always = yes');
eq('t = {\n\tfaith.religion ?= religion:christianity_religion\n}\n', 't = {\n\talways = no\n}\n', '?= with a missing religion is false');
eq('t = {\n\tthis = rite:roman_rite\n\texists = title:k_papal_state\n\thas_same_culture_language = culture:greek\n}\n', 't = {\n\talways = no\n\talways = no\n\talways = no\n}\n', 'link values of every prefix: this, exists, a test key');
eq('t = {\n\ttitle:k_papal_state.holder ?= scope:x\n}\n', 't = {\n\talways = no\n}\n', 'a link in the key of a comparison');
eq('t = {\n\tfaith:catholic = { has_trait = brave }\n\tage > 3\n}\n', 't = {\n\talways = no\n\tage > 3\n}\n', 'a scope switch on a missing faith in a trigger is false');
eq('t = {\n\thas_trait = herald\n\thas_trait = brave\n}\n', 't = {\n\talways = no\n\thas_trait = brave\n}\n', 'has_trait of a missing trait; another stays');
eq('t = {\n\thas_trait_xp = { trait = herald value >= 10 }\n}\n', 't = {\n\talways = no\n}\n', 'a block form: the field names the trait');
eq('t = {\n\tgeographical_region = world_india\n\tgeographical_region = world_europe\n}\n', 't = {\n\talways = no\n\tgeographical_region = world_europe\n}\n', 'a region');
eq('t = {\n\thas_doctrine_parameter = pacifist_opinion_active\n\tknows_language = language_latin\n\thas_realm_law = church_authority_1\n\thas_character_modifier = rejected_modifier\n}\n',
    't = {\n\talways = no\n\talways = no\n\talways = no\n\talways = no\n}\n', 'parameters, languages, laws and modifiers');
eq('t = {\n\tknows_language = language_latin\n}\n', 't = {\n\talways = no\n}\n', 'languages are pillars');

// folding
eq('t = {\n\tNOT = { religion = religion:christianity_religion }\n\tage > 3\n}\n', 't = {\n\tage > 3\n}\n', 'NOT of a false test is true: it goes among others');
eq('t = {\n\tNOT = { religion = religion:christianity_religion }\n}\n', 't = {\n\talways = yes\n}\n', 'NOT of a false test alone is always = yes');
eq('t = {\n\tOR = {\n\t\thas_trait = herald\n\t\thas_trait = herald\n\t}\n}\n', 't = {\n\talways = no\n}\n', 'an OR of only dead branches is dead');
eq('t = {\n\tOR = {\n\t\thas_trait = herald\n\t\thas_trait = brave\n\t}\n}\n', 't = {\n\tOR = {\n\t\thas_trait = brave\n\t}\n}\n', 'the dead branch of an OR goes');
eq('t = {\n\tOR = {\n\t\thas_trait = brave\n\t\tNOT = { has_trait = herald }\n\t}\n\tage > 3\n}\n', 't = {\n\tage > 3\n}\n', 'an OR with a true branch is true and goes');
eq('t = {\n\tNOT = { OR = { has_trait = herald faith:catholic = { always = yes } } }\n}\n', 't = {\n\talways = yes\n}\n', 'NOT of an OR of dead branches');
eq('t = {\n\tNOR = { has_trait = herald has_trait = brave }\n}\n', 't = {\n\tNOR = { has_trait = brave }\n}\n', 'the dead branch of a NOR goes');
eq('t = {\n\tAND = { has_trait = herald age > 3 }\n}\n', 't = {\n\talways = no\n}\n', 'an AND with a dead branch is dead');
eq('t = {\n\tNOT = { has_trait = herald has_trait = brave }\n}\n', 't = {\n\talways = yes\n}\n', 'NOT of several: one dead statement makes the AND false');
eq('t = {\n\tNOT = { always = no }\n\tOR = { always = no always = no }\n}\n', 't = {\n\tNOT = { always = no }\n\tOR = { always = no always = no }\n}\n', 'the game\'s own constants are left as they are');

// effects
eq('e = {\n\tadd_trait = herald\n\tadd_gold = 5\n}\n', 'e = {\n\tadd_gold = 5\n}\n', 'an effect on a missing trait is dropped', 'common/scripted_effects/x.txt');
eq('e = {\n\tcreate_maa_regiment = {\n\t\ttype = sicarii\n\t\tsize = 1\n\t}\n\tadd_gold = 5\n}\n', 'e = {\n\tadd_gold = 5\n}\n', 'a block whose field names a missing entry is dropped', 'common/scripted_effects/x.txt');
eq('e = {\n\tcreate_artifact = {\n\t\ttemplate = christian_artifact_template\n\t\tdescription = x\n\t}\n\ttrigger_event = great_holy_war.0001\n\ttrigger_event = { id = great_holy_war.0001 days = 3 }\n}\n', 'e = {\n}\n', 'artifact and event effects', 'common/scripted_effects/x.txt');
eq('e = {\n\tevery_vassal = {\n\t\tlimit = { age > 3 }\n\t\tadd_trait = herald\n\t}\n\tadd_gold = 5\n}\n', 'e = {\n\tadd_gold = 5\n}\n', 'an iterator that has nothing left but its limit goes', 'common/scripted_effects/x.txt');
eq('e = {\n\tevery_vassal = {\n\t\tlimit = { age > 3 }\n\t\tadd_trait = herald\n\t\tadd_gold = 1\n\t}\n}\n', 'e = {\n\tevery_vassal = {\n\t\tlimit = { age > 3 }\n\t\tadd_gold = 1\n\t}\n}\n', 'an iterator with another effect stays', 'common/scripted_effects/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { age > 3 }\n\t\tadd_trait = herald\n\t}\n\telse = {\n\t\tadd_gold = 1\n\t}\n}\n', 'e = {\n\tif = {\n\t\tlimit = { age > 3 }\n\t}\n\telse = {\n\t\tadd_gold = 1\n\t}\n}\n', 'an if followed by an else stays (empty), the else would stand alone', 'common/scripted_effects/x.txt');
eq('e = {\n\tfaith:catholic = { add_gold = 1 }\n\tadd_gold = 2\n}\n', 'e = {\n\tadd_gold = 2\n}\n', 'a scope switch on a missing faith in an effect is dropped', 'common/scripted_effects/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { religion = religion:christianity_religion }\n\t\tadd_gold = 1\n\t}\n\telse = {\n\t\tadd_gold = 2\n\t}\n}\n', 'e = {\n\tif = {\n\t\tlimit = { always = no }\n\t}\n\telse = {\n\t\tadd_gold = 2\n\t}\n}\n', 'the limit of an if in an effect is a test', 'common/scripted_effects/x.txt');

// the body of an if the rewrite made false: it never runs, but the game reads it at load and reports what it names; it goes, whatever it holds
eq('e = {\n\tif = {\n\t\tlimit = {\n\t\t\t$A$ = {\n\t\t\t\thas_character_modifier = rejected_modifier\n\t\t\t}\n\t\t}\n\t\t$A$ = { remove_character_modifier = rejected_modifier }\n\t}\n\t$A$ = { add_gold = 1 }\n}\n', 'e = {\n\t$A$ = { add_gold = 1 }\n}\n', 'a false test inside a macro scope in the limit makes the if dead: the whole if goes, its $A$ = { } effect with it', 'common/scripted_effects/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { scope:x = { has_trait = herald } }\n\t\tadd_gold = 1\n\t\tscope:x = { add_trait = brave }\n\t}\n}\n', 'e = {\n}\n', 'a false test inside a scope switch: the if is dead, its body goes', 'common/scripted_effects/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { scope:x = { liege = { has_trait = herald } } }\n\t\tadd_gold = 1\n\t}\n\telse = {\n\t\tadd_gold = 2\n\t}\n}\n', 'e = {\n\tif = {\n\t\tlimit = { scope:x = { liege = { always = no } } }\n\t}\n\telse = {\n\t\tadd_gold = 2\n\t}\n}\n', 'scopes inside scopes; before an else the if stays, empty: the else runs as before', 'common/scripted_effects/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { age > 3 }\n\t\tadd_gold = 1\n\t}\n\telse_if = {\n\t\tlimit = { has_trait = herald }\n\t\tadd_gold = 2\n\t}\n\telse = {\n\t\tadd_gold = 3\n\t}\n}\n', 'e = {\n\tif = {\n\t\tlimit = { age > 3 }\n\t\tadd_gold = 1\n\t}\n\telse_if = {\n\t\tlimit = { always = no }\n\t}\n\telse = {\n\t\tadd_gold = 3\n\t}\n}\n', 'a dead else_if before an else stays empty', 'common/scripted_effects/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { age > 3 }\n\t\tadd_gold = 1\n\t}\n\telse_if = {\n\t\tlimit = { has_trait = herald }\n\t\tadd_gold = 2\n\t}\n}\n', 'e = {\n\tif = {\n\t\tlimit = { age > 3 }\n\t\tadd_gold = 1\n\t}\n}\n', 'a dead else_if at the end of the chain goes', 'common/scripted_effects/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { scope:x = { OR = { has_trait = herald has_trait = brave } } }\n\t\tadd_gold = 1\n\t}\n}\n', 'e = {\n\tif = {\n\t\tlimit = { scope:x = { OR = { has_trait = brave } } }\n\t\tadd_gold = 1\n\t}\n}\n', 'a scope whose test can still hold: the if runs, its body stays', 'common/scripted_effects/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { scope:x = { NOT = { has_trait = herald } } }\n\t\tadd_gold = 1\n\t}\n}\n', 'e = {\n\tif = {\n\t\tlimit = { scope:x = { always = yes } }\n\t\tadd_gold = 1\n\t}\n}\n', 'a NOT of a false test is true: the if runs', 'common/scripted_effects/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { has_trait = herald }\n\t\tadd_gold = $X$\n\t\tadd_prestige = 1\n\t}\n\tadd_piety = 1\n}\n', 'e = {\n\tif = {\n\t\tlimit = { always = no }\n\t\tadd_gold = $X$\n\t}\n\tadd_piety = 1\n}\n', 'a statement of the dead body that holds every use of a macro parameter stays (the callers pass it)', 'common/scripted_effects/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { $R$ = { has_trait = herald } }\n\t\tadd_gold = 1\n\t}\n\tadd_piety = 1\n}\n', 'e = {\n\tif = {\n\t\tlimit = { $R$ = { always = no } }\n\t}\n\tadd_piety = 1\n}\n', 'a dead if whose limit holds every use of a parameter stays, empty, with the limit made false', 'common/scripted_effects/x.txt');
eq('v = {\n\tvalue = 5\n\tif = {\n\t\tlimit = { has_trait = herald }\n\t\tadd = 3\n\t}\n}\n', 'v = {\n\tvalue = 5\n}\n', 'a dead if of a script value goes', 'common/script_values/x.txt');
eq('t = {\n\ttrigger_if = {\n\t\tlimit = { has_trait = herald }\n\t\tage > 3\n\t}\n}\n', 't = {\n\ttrigger_if = {\n\t\tlimit = { always = no }\n\t\tage > 3\n\t}\n}\n', 'a trigger_if is left as it was (its body is a test)');
{
    // (what was told as kept in the dead body is not told any more)
    const t = 'e = {\n\tif = {\n\t\tlimit = { has_trait = herald }\n\t\tfaith:catholic = { save_scope_as = f }\n\t}\n}\n';
    const r = inertText(t, 'common/scripted_effects/x.txt', world);
    check(r.text === 'e = {\n}\n' && !r.kept.length, 'a scope saved in the dead body is not kept, and not told');
}
eq('d = {\n\tis_shown = { has_trait = herald }\n\teffect = {\n\t\tremove_trait = herald\n\t\tadd_prestige = 1\n\t}\n}\n', 'd = {\n\tis_shown = { always = no }\n\teffect = {\n\t\tadd_prestige = 1\n\t}\n}\n', 'a decision: the test and the effect', 'common/decisions/x.txt');

// what stays
{
    const t = 'e = {\n\tfaith:catholic = {\n\t\tsave_scope_as = f\n\t}\n\tadd_gold = scope:f.x\n}\n';
    const r = inertText(t, 'common/scripted_effects/x.txt', world);
    check(r.text === t && r.kept.some((k) => k.reason === 'scope'), 'a block that saves a scope stays (and is told)');
}
{
    const t = 'e = {\n\tdoctrine:special_doc = {\n\t\tset_variable = { name = x value = 1 }\n\t}\n}\n';
    const r = inertText(t, 'common/scripted_effects/x.txt', world);
    check(r.text === t && r.kept.some((k) => k.reason === 'variable'), 'an effect block that sets a variable stays');
}
eq('t = {\n\tmy_trigger = { RITE = rite:roman_rite }\n\tRITE = rite:roman_rite\n\t$AUTH$_authority_0 = religion:christianity_religion\n}\n', 't = {\n\tmy_trigger = { RITE = rite:roman_rite }\n\tRITE = rite:roman_rite\n\t$AUTH$_authority_0 = religion:christianity_religion\n}\n', 'macro arguments and keys with a macro stay');
eq('e = {\n\tcreate_character = {\n\t\tfaith = faith:catholic\n\t\tculture = culture:greek\n\t}\n\tset_variable = { name = v value = rite:roman_rite }\n}\n', 'e = {\n\tcreate_character = {\n\t\tfaith = faith:catholic\n\t\tculture = culture:greek\n\t}\n}\n', 'overloaded keys in create_character stay; a variable that is to hold a missing rite is not set', 'common/scripted_effects/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { NOT = { has_variable = v } }\n\t\tset_variable = { name = v value = rite:roman_rite }\n\t\tset_variable = { name = w value = 3 }\n\t}\n}\n', 'e = {\n\tif = {\n\t\tlimit = { NOT = { has_variable = v } }\n\t\tset_variable = { name = w value = 3 }\n\t}\n}\n', 'a setter of a missing link goes, another stays', 'common/scripted_effects/x.txt');
eq('e = {\n\tadd_to_variable_list = { name = l target = faith:catholic }\n\tadd_to_variable_list = { name = l target = scope:x }\n}\n', 'e = {\n\tadd_to_variable_list = { name = l target = scope:x }\n}\n', 'a list target that is a missing link', 'common/scripted_effects/x.txt');

eq('t = {\n\tNOR = { using_cb = religious_war using_cb = other_war }\n}\n', 't = {\n\tNOR = { using_cb = other_war }\n}\n', 'a casus belli test');
eq('e = {\n\trite = { add_rite_doctrine = doctrine_gone }\n\tchange_rite_doctrine = doctrine_gone\n\tadd_gold = 1\n}\n', 'e = {\n\trite = { }\n\tadd_gold = 1\n}\n', 'rite doctrine effects', 'common/scripted_effects/x.txt');
// the forms the first run left (perks, accolade types, traditions, trait experience as a data function, stress impacts by trait key)
eq('t = {\n\thas_perk = erudite_perk\n\thas_perk = other_perk\n\thas_accolade_type = gunpowder_attribute\n\thas_cultural_tradition = tradition_gone\n}\n', 't = {\n\talways = no\n\thas_perk = other_perk\n\talways = no\n\talways = no\n}\n', 'perks, accolade types and traditions');
eq('t = {\n\taccolade_type:gunpowder_attribute = { always = yes }\n\tthis = accolade_type:gunpowder_attribute\n}\n', 't = {\n\talways = no\n\talways = no\n}\n', 'the accolade_type: link in a key and in a value');
eq('e = {\n\tadd_perk = erudite_perk\n\tadd_travel_point_of_interest = poi_gone\n\tadd_gold = 1\n}\n', 'e = {\n\tadd_gold = 1\n}\n', 'perk and point of interest effects go', 'common/scripted_effects/x.txt');
eq('t = {\n\ttrait_is_virtue_rite = { trait = erudite }\n\ttrait_is_virtue_rite = brave\n}\n', 't = {\n\talways = no\n\ttrait_is_virtue_rite = brave\n}\n', 'a rite test on a trait');
eq('v = {\n\tvalue = "has_trait_xp(erudite)"\n\tadd = "scope:recipient.has_trait_xp(lifestyle_scholar)"\n\tadd = "has_trait_xp(brave)"\n}\n', 'v = {\n\tvalue = 0\n\tadd = 0\n\tadd = "has_trait_xp(brave)"\n}\n', 'the experience of a missing trait as a data function is 0', 'common/script_values/x.txt');
eq('e = {\n\tstress_and_fulfillment_impact = {\n\t\tbase = minor_stress_impact_gain\n\t\terudite = major_stress_impact_loss\n\t\tbrave = minor_stress_impact_loss\n\t}\n}\n', 'e = {\n\tstress_and_fulfillment_impact = {\n\t\tbase = minor_stress_impact_gain\n\t\tbrave = minor_stress_impact_loss\n\t}\n}\n', 'a stress impact loses the keys of missing traits', 'common/scripted_effects/x.txt');
eq('e = {\n\tadd_trait_xp = {\n\t\ttrait = lifestyle_scholar\n\t\tvalue = 5\n\t}\n\tremove_trait_xp = { trait = erudite value = 1 }\n\tadd_gold = 1\n}\n', 'e = {\n\tadd_gold = 1\n}\n', 'the block forms of the trait experience effects', 'common/scripted_effects/x.txt');
eq('t = {\n\thas_trait_xp = {\n\t\ttrait = lifestyle_scholar\n\t\tvalue >= 50\n\t}\n\thas_trait_xp = {\n\t\ttrait = brave\n\t\tvalue >= 50\n\t}\n}\n', 't = {\n\talways = no\n\thas_trait_xp = {\n\t\ttrait = brave\n\t\tvalue >= 50\n\t}\n}\n', 'has_trait_xp over several lines');
eq('e = {\n\tadd_trait = $T$\n\tadd_trait = herald\n}\n', 'e = {\n\tadd_trait = $T$\n}\n', 'a macro in the value is not a name');
{
    // (the only use of $X$ is in the dead part: the callers pass X, so the block stays)
    const t = 'e = {\n\tfaith:catholic = {\n\t\tadd_gold = $X$\n\t}\n\tadd_prestige = 1\n}\n';
    const r = inertText(t, 'common/scripted_effects/x.txt', world);
    check(r.text === t && r.kept.some((k) => k.reason === 'macro'), 'a block that holds the only use of a macro parameter stays');
    const t2 = 'e = {\n\tfaith:catholic = {\n\t\tadd_gold = $X$\n\t}\n\tadd_prestige = $X$\n}\n';
    check(inertText(t2, 'common/scripted_effects/x.txt', world).text === 'e = {\n\tadd_prestige = $X$\n}\n', 'a parameter used elsewhere too does not keep it');
}
eq('t = {\n\t$RITE$ = { rite_has_parameter = devoted_trait_criminal }\n\tage > 3\n}\n', 't = {\n\t$RITE$ = { always = no }\n\tage > 3\n}\n', 'a dead test under a macro key stays as a shell with a dead test: the argument is still used');
eq('t = {\n\tAND = {\n\t\t$TRAIT$ = trait:devoted\n\t\t$RITE$ = { rite_has_parameter = devoted_trait_criminal rite_has_parameter = other }\n\t}\n}\n', 't = {\n\tAND = {\n\t\t$TRAIT$ = trait:devoted\n\t\t$RITE$ = { always = no rite_has_parameter = other }\n\t}\n}\n', 'in an AND the macro keys stay: only the dead test inside the argument block goes false');
// a block whose key is only a macro argument (`$OWNER$ = { }`) is a scope the callers pass, in an effect too (round 9): visited like scope:x = { }
eq('e = {\n\t$OWNER$ = {\n\t\tadd_trait = herald\n\t\tadd_gold = 1\n\t}\n}\n', 'e = {\n\t$OWNER$ = {\n\t\tadd_gold = 1\n\t}\n}\n', 'an effect on a missing entry in a $ARG$ block of an effect goes, as in scope:x = { }', 'common/scripted_effects/x.txt');
eq('e = {\n\t$RITE$ = {\n\t\tif = {\n\t\t\tlimit = { faith.religion = religion:christianity_religion }\n\t\t\tadd_piety = 1\n\t\t}\n\t\tadd_gold = 1\n\t}\n}\n', 'e = {\n\t$RITE$ = {\n\t\tadd_gold = 1\n\t}\n}\n', 'a dead if inside a $ARG$ block of an effect goes (its limit is a test of the scope)', 'common/scripted_effects/x.txt');
eq('e = {\n\t$OWNER$ = { add_trait = herald }\n}\n', 'e = {\n\t$OWNER$ = { }\n}\n', 'the $ARG$ block stays when nothing is left in it: the argument is still used', 'common/scripted_effects/x.txt');
eq('e = {\n\t$OWNER$ = {\n\t\trandom_list = {\n\t\t\t20 = {\n\t\t\t\ttrigger = { has_trait = herald }\n\t\t\t\tadd_gold = 1\n\t\t\t}\n\t\t\t80 = { add_gold = 2 }\n\t\t}\n\t}\n}\n', 'e = {\n\t$OWNER$ = {\n\t\trandom_list = {\n\t\t\t20 = {\n\t\t\t\ttrigger = { always = no }\n\t\t\t\tadd_gold = 1\n\t\t\t}\n\t\t\t80 = { add_gold = 2 }\n\t\t}\n\t}\n}\n', 'control flow inside a $ARG$ block of an effect: the weight\'s trigger is a test', 'common/scripted_effects/x.txt');
eq('t = {\n\t$X$ = { faith = faith:catholic }\n\tage > 3\n}\n', 't = {\n\t$X$ = { always = no }\n\tage > 3\n}\n', 'in a trigger the $ARG$ block holds tests: a link to a missing faith in it is false too');
// (not when the entry shows the argument is no scope: a scripted trigger or effect it calls, a part of a word or a link, the name of an entry)
eq('e = {\n\t$EFFECT$ = { add_trait = herald }\n\t$EFFECT$ = yes\n}\n', 'e = {\n\t$EFFECT$ = { add_trait = herald }\n\t$EFFECT$ = yes\n}\n', 'an argument the entry calls as $X$ = yes names a scripted effect: its block holds arguments, left alone', 'common/scripted_effects/x.txt');
eq('e = {\n\t$X$ = { add_trait = herald }\n\tscope:$X$ = { add_gold = 1 }\n}\n', 'e = {\n\t$X$ = { add_trait = herald }\n\tscope:$X$ = { add_gold = 1 }\n}\n', 'an argument the entry uses as a part of a link (scope:$X$) is a name, no scope: left alone', 'common/scripted_effects/x.txt');
eq('e = {\n\t$X$ = { add_trait = herald }\n\tadd_gold = $X$_value\n}\n', 'e = {\n\t$X$ = { add_trait = herald }\n\tadd_gold = $X$_value\n}\n', 'an argument the entry uses as a part of a word ($X$_value): left alone', 'common/scripted_effects/x.txt');
eq('e = {\n\t$T$ = { add_trait = herald }\n\tadd_trait = $T$\n}\n', 'e = {\n\t$T$ = { add_trait = herald }\n\tadd_trait = $T$\n}\n', 'an argument the entry gives as the name of an entry (add_trait = $T$): left alone', 'common/scripted_effects/x.txt');
eq('e = {\n\t$X$ = { add_trait = herald }\n\t$X$.liege = { add_gold = 1 }\n\tadd_opinion = { target = $X$ modifier = m }\n}\n', 'e = {\n\t$X$ = { }\n\t$X$.liege = { add_gold = 1 }\n\tadd_opinion = { target = $X$ modifier = m }\n}\n', 'a scope chain ($X$.liege) and a target are scope uses: the block is visited', 'common/scripted_effects/x.txt');
eq('e = {\n\tcreate_character = {\n\t\t$X$ = { add_trait = herald }\n\t}\n}\n', 'e = {\n\tcreate_character = {\n\t\t$X$ = { add_trait = herald }\n\t}\n}\n', 'a $ARG$ block among arguments is left alone', 'common/scripted_effects/x.txt');
eq('t = {\n\tscope:site = holy_site:rome\n\tage > 3\n}\n', 't = {\n\talways = no\n\tage > 3\n}\n', 'a link to a holy site the world lacks');
eq('t = {\n\tis_holy_site_type = rome\n\tis_holy_site_type = mecca\n}\n', 't = {\n\talways = no\n\tis_holy_site_type = mecca\n}\n', 'is_holy_site_type names a holy site');
eq('t = {\n\tnum_virtuous_traits = { value > 0 target = faith:catholic.main_rite }\n\tfaith = { religion = religion:christianity_religion }\n}\n', 't = {\n\tnum_virtuous_traits = { value > 0 target = faith:catholic.main_rite }\n\tfaith = { always = no }\n}\n', 'the arguments of a trigger are no statements; a scope switch by name holds statements');
eq('d = {\n\tai_will_do = {\n\t\tbase = 10\n\t\tmodifier = { add = 5 has_trait = herald }\n\t}\n\tcost = { gold = 5 }\n}\n', 'd = {\n\tai_will_do = {\n\t\tbase = 10\n\t\tmodifier = { add = 5 always = no }\n\t}\n\tcost = { gold = 5 }\n}\n', 'a modifier block is a test', 'common/decisions/x.txt');
eq('x = {\n\tculture = culture:greek\n}\n', 'x = {\n\tculture = culture:greek\n}\n', 'an overloaded key outside a known test stays', 'common/decisions/x.txt');

// a character's traits (round 9): create_character, a scripted character template, an event option's trait ("Failed to lookup trait")
eq('t = {\n\tage = { 20 30 }\n\ttrait = herald\n\ttrait = brave\n}\n', 't = {\n\tage = { 20 30 }\n\ttrait = brave\n}\n', 'a character template: a trait the world lacks goes', 'common/scripted_character_templates/x.txt');
eq('t = {\n\trandom_traits_list = {\n\t\tcount = 1\n\t\therald = {}\n\t\tbrave = { weight = { base = 2 } }\n\t}\n}\n', 't = {\n\trandom_traits_list = {\n\t\tcount = 1\n\t\tbrave = { weight = { base = 2 } }\n\t}\n}\n', 'a template\'s random traits lose the ones the world lacks', 'common/scripted_character_templates/x.txt');
eq('e = {\n\tcreate_character = {\n\t\tage = 20\n\t\ttrait = herald\n\t\ttrait = brave\n\t\tsave_scope_as = x\n\t}\n}\n', 'e = {\n\tcreate_character = {\n\t\tage = 20\n\t\ttrait = brave\n\t\tsave_scope_as = x\n\t}\n}\n', 'create_character: the trait goes, the block (it saves a scope) stays', 'common/scripted_effects/x.txt');
eq('e = {\n\tcreate_character = {\n\t\trandom_traits_list = { count = 1 herald = {} brave = {} }\n\t}\n}\n', 'e = {\n\tcreate_character = {\n\t\trandom_traits_list = { count = 1 brave = {} }\n\t}\n}\n', 'create_character: its random traits too, on one line', 'common/scripted_effects/x.txt');
eq('e.1 = {\n\toption = {\n\t\tname = e.1.a\n\t\ttrait = herald\n\t\tadd_gold = 1\n\t}\n}\n', 'e.1 = {\n\toption = {\n\t\tname = e.1.a\n\t\tadd_gold = 1\n\t}\n}\n', 'an event option\'s trait the world lacks goes', 'events/x.txt');
eq('p = {\n\ttrait = herald\n}\n', 'p = {\n\ttrait = herald\n}\n', 'trait = x elsewhere (a perk\'s own trait) is left as it is', 'common/lifestyle_perks/x.txt');
eq('t = {\n\ttrait = brave\n\ttrait = $T$\n}\n', 't = {\n\ttrait = brave\n\ttrait = $T$\n}\n', 'a template\'s traits the world has, and a macro, stay', 'common/scripted_character_templates/x.txt');
{
    const aliased: InertWorld = { ...world, renamed: (kind, name) => (kind === 'trait' && name === 'erudite' ? 'scholar' : undefined) };
    const t = 't = {\n\ttrait = erudite\n\trandom_traits_list = {\n\t\terudite = {}\n\t\tbrave = {}\n\t}\n}\n';
    const out = inertText(t, 'common/scripted_character_templates/x.txt', aliased).text;
    check(out === 't = {\n\ttrait = scholar\n\trandom_traits_list = {\n\t\tscholar = {}\n\t\tbrave = {}\n\t}\n}\n', `a template's trait the world has under another name is written as that one: ${JSON.stringify(out)}`);
    check(inertText(out, 'common/scripted_character_templates/x.txt', aliased).text === out, 'a template\'s trait under another name (second pass)');
    const e = 'e = {\n\tcreate_character = { trait = erudite age = 20 }\n}\n';
    check(inertText(e, 'common/scripted_effects/x.txt', aliased).text === 'e = {\n\tcreate_character = { trait = scholar age = 20 }\n}\n', 'create_character: the trait under another name');
}

// customizable localization
eq('L = {\n\ttype = character\n\ttext = {\n\t\ttrigger = { religion = religion:christianity_religion }\n\t\tlocalization_key = a\n\t}\n\ttext = {\n\t\tlocalization_key = b\n\t\tfallback = yes\n\t}\n}\n', 'L = {\n\ttype = character\n\ttext = {\n\t\tlocalization_key = b\n\t\tfallback = yes\n\t}\n}\n', 'a text whose trigger is false goes', 'common/customizable_localization/x.txt');
eq('L = {\n\ttext = {\n\t\ttrigger = { religion = religion:christianity_religion }\n\t\tlocalization_key = a\n\t}\n}\n', 'L = {\n\ttext = {\n\t\ttrigger = { always = no }\n\t\tlocalization_key = a\n\t}\n}\n', 'the last text of a localization stays', 'common/customizable_localization/x.txt');

// scripted triggers and effects a mod took out (the definitions are in no loaded file; the game's files and the tool's copies still call them)
eq('t = {\n\ttgp_is_any_minister = yes\n\tage > 3\n}\n', 't = {\n\talways = no\n\tage > 3\n}\n', 'a call of a removed scripted trigger is false');
eq('t = {\n\ttgp_is_any_minister = no\n\tage > 3\n}\n', 't = {\n\tage > 3\n}\n', '= no of a removed scripted trigger is true: among other statements it goes');
eq('t = {\n\ttgp_is_any_minister = no\n}\n', 't = {\n\talways = yes\n}\n', '= no of a removed scripted trigger alone stays as always = yes');
eq('t = {\n\tOR = {\n\t\ttgp_is_any_minister = yes\n\t\thas_trait = brave\n\t}\n}\n', 't = {\n\tOR = {\n\t\thas_trait = brave\n\t}\n}\n', 'name = yes inside an OR: the dead branch goes');
eq('t = {\n\tOR = {\n\t\ttgp_is_any_minister = yes\n\t\ttgp_access_trigger = yes\n\t}\n}\n', 't = {\n\talways = no\n}\n', 'an OR of removed scripted triggers is dead');
eq('t = {\n\tNOT = { tgp_is_any_minister = yes }\n\tage > 3\n}\n', 't = {\n\tage > 3\n}\n', 'NOT of a removed scripted trigger is true: it goes among others');
eq('t = {\n\tNOT = { tgp_is_any_minister = no }\n}\n', 't = {\n\talways = no\n}\n', 'name = no inside a NOT: true inside, so the NOT is false');
eq('t = {\n\ttgp_access_trigger = { TARGET = scope:x LEVEL = 2 }\n\tage > 3\n}\n', 't = {\n\talways = no\n\tage > 3\n}\n', 'the argument form of a removed scripted trigger is false');
eq('t = {\n\tNOR = { tgp_access_trigger = { TARGET = scope:x } has_trait = brave }\n}\n', 't = {\n\tNOR = { has_trait = brave }\n}\n', 'the argument form in a NOR');
eq('i = {\n\tis_shown = { tgp_is_any_minister = yes }\n\ton_accept = {\n\t\ttgp_remove_effect = yes\n\t\ttgp_remove_effect = { TARGET = scope:x }\n\t\tadd_prestige = 1\n\t}\n}\n', 'i = {\n\tis_shown = { always = no }\n\ton_accept = {\n\t\tadd_prestige = 1\n\t}\n}\n', 'a removed scripted effect is dropped, in both of its forms', 'common/character_interactions/x.txt');
eq('e = {\n\tevery_vassal = {\n\t\tlimit = { tgp_is_any_minister = yes }\n\t\ttgp_remove_effect = yes\n\t}\n}\n', 'e = {\n}\n', 'an iterator whose only effect was a removed scripted effect goes', 'common/scripted_effects/x.txt');
eq('x = {\n\ttgp_is_any_minister = yes\n}\n', 'x = {\n\talways = no\n}\n', 'where the context is not known, the definition says it is a test', 'common/decisions/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { tgp_is_any_minister = yes }\n\t\ttgp_remove_effect = yes\n\t}\n\telse = {\n\t\tadd_gold = 1\n\t}\n}\n', 'e = {\n\tif = {\n\t\tlimit = { always = no }\n\t}\n\telse = {\n\t\tadd_gold = 1\n\t}\n}\n', 'the if stays (empty) for its else', 'common/scripted_effects/x.txt');
eq('t = {\n\ttgp_$X$_trigger = yes\n\tdoes_not_exist_any_more_trigger = yes\n\t$NAME$ = yes\n}\n', 't = {\n\ttgp_$X$_trigger = yes\n\tdoes_not_exist_any_more_trigger = yes\n\t$NAME$ = yes\n}\n', 'a name a macro produces, and a name the world has, stay');
eq('t = {\n\ttgp_live_trigger = yes\n\ttgp_live_trigger = { A = 1 }\n}\n', 't = {\n\ttgp_live_trigger = yes\n\ttgp_live_trigger = { A = 1 }\n}\n', 'a scripted trigger a loaded file defines stays');
eq('e = {\n\ttgp_is_any_minister = yes\n}\n', 'e = {\n\ttgp_is_any_minister = yes\n}\n', 'a removed scripted trigger called in an effect is no test: left to the game', 'common/scripted_effects/x.txt');
eq('d = {\n\tai_will_do = {\n\t\tmodifier = { add = 5 tgp_is_any_minister = yes }\n\t\tmodifier = { add = 5 tgp_is_any_minister = no }\n\t}\n}\n', 'd = {\n\tai_will_do = {\n\t\tmodifier = { add = 5 always = no }\n\t\tmodifier = { add = 5 }\n\t}\n}\n', 'in a modifier block a true call goes (the weight stays)', 'common/decisions/x.txt');
{
    const t = 'e = {\n\ttgp_saving_effect = { TARGET = scope:x }\n\tadd_gold = scope:saved.value\n}\n';
    const r = inertText(t, 'common/scripted_effects/x.txt', world);
    check(r.text === t && r.kept.some((k) => k.reason === 'scope' && k.kind === 'scripted_effect'), 'a removed scripted effect whose definition saves a scope stays (and is told)');
    const t2 = 'e = {\n\ttgp_remove_effect = {\n\t\tSAVE = yes\n\t\tsave_scope_as = x\n\t}\n}\n';
    check(inertText(t2, 'common/scripted_effects/x.txt', world).kept.some((k) => k.reason === 'scope'), 'a call that saves a scope in its arguments stays');
}
{
    const t = 'e = {\n\tadd_gold = tgp_gone_value\n\tif = { limit = { tgp_gone_value > 3 } add_prestige = 1 }\n}\n';
    const r = inertText(t, 'common/scripted_effects/x.txt', world);
    check(r.text === t && r.kept.filter((k) => k.reason === 'value' && k.name === 'tgp_gone_value').length === 2, 'a removed script value is left and told, as a value and as the left side of a comparison');
}
// (what would stay for a scope or a variable has no use where nothing runs: the body of an if the rewrite made false, a show_as_tooltip)
eq('e = {\n\tif = {\n\t\tlimit = { tgp_is_any_minister = yes }\n\t\ttgp_saving_effect = yes\n\t}\n\telse = {\n\t\tadd_gold = 1\n\t}\n}\n', 'e = {\n\tif = {\n\t\tlimit = { always = no }\n\t}\n\telse = {\n\t\tadd_gold = 1\n\t}\n}\n', 'a call that would stay (it saves a scope) goes with the body of an if the rewrite made false', 'common/scripted_effects/x.txt');
eq('e = {\n\tif = {\n\t\tlimit = { tgp_is_any_minister = yes }\n\t\ttgp_saving_effect = yes\n\t}\n\tadd_gold = 1\n}\n', 'e = {\n\tadd_gold = 1\n}\n', 'an if whose condition is false and whose body only held such a call goes', 'common/scripted_effects/x.txt');
eq('e = {\n\tshow_as_tooltip = {\n\t\ttgp_saving_effect = yes\n\t}\n\tadd_gold = 1\n}\n', 'e = {\n\tadd_gold = 1\n}\n', 'a call that would stay inside a show_as_tooltip is dropped (nothing runs there)', 'common/scripted_effects/x.txt');
eq('e = {\n\thidden_effect_new_object = {\n\t\tif = {\n\t\t\tlimit = { religion = religion:christianity_religion }\n\t\t\ttgp_saving_effect = { OWNER = $OWNER$ }\n\t\t}\n\t\telse = {\n\t\t\tadd_gold = $OWNER$\n\t\t}\n\t}\n}\n', 'e = {\n\thidden_effect_new_object = {\n\t\tif = {\n\t\t\tlimit = { always = no }\n\t\t}\n\t\telse = {\n\t\t\tadd_gold = $OWNER$\n\t\t}\n\t}\n}\n', 'the effects of hidden_effect_new_object are read like those of hidden_effect', 'common/scripted_effects/x.txt');
{
    const t = 'e = {\n\tif = {\n\t\tlimit = { age > 3 }\n\t\ttgp_saving_effect = yes\n\t}\n}\n';
    const r = inertText(t, 'common/scripted_effects/x.txt', world);
    check(r.text === t && r.kept.some((k) => k.reason === 'scope'), 'the same call in an if that can run stays');
}

// modifier types the engine makes for content the world lacks (a trait's experience gain): there is no such type, it goes from a block of modifiers
eq('b = {\n\tcharacter_modifier = {\n\t\tmonthly_lifestyle_xp_gain_mult = 0.05\n\t\tlifestyle_scholar_xp_gain_mult = @scholar_xp\n\t\tdevelopment_growth_factor = 0.1\n\t}\n}\n', 'b = {\n\tcharacter_modifier = {\n\t\tmonthly_lifestyle_xp_gain_mult = 0.05\n\t\tdevelopment_growth_factor = 0.1\n\t}\n}\n', 'a modifier type of a trait the world lacks goes from a character_modifier (a constant as its value)', 'common/domiciles/buildings/x.txt');
eq('tenet_x = {\n\tpersonal_tenet_modifier = {\n\t\tlifestyle_scholar_xp_gain_mult = 0.20\n\t}\n}\n', 'tenet_x = {\n\tpersonal_tenet_modifier = {\n\t}\n}\n', 'the block stays, empty: the definition keeps the key (a gains rule sees it there)', 'common/religion/tenet_types/x.txt');
eq('study_modifier = {\n\ticon = learning_positive\n\tlifestyle_scholar_xp_gain_mult = 0.20\n\tlearning = 1\n}\n', 'study_modifier = {\n\ticon = learning_positive\n\tlearning = 1\n}\n', 'a static modifier is a block of modifiers itself', 'common/modifiers/x.txt');
eq('d = {\n\tlifestyle_scholar_xp_gain_mult = 0.2\n\tis_shown = { scope:x = { lifestyle_scholar_xp_gain_mult > 0 } }\n\tcharacter_modifier = { lifestyle_scholar_xp_gain_mult = yes }\n}\n', 'd = {\n\tlifestyle_scholar_xp_gain_mult = 0.2\n\tis_shown = { scope:x = { lifestyle_scholar_xp_gain_mult > 0 } }\n\tcharacter_modifier = { lifestyle_scholar_xp_gain_mult = yes }\n}\n', 'outside a block of modifiers, compared, or with a word as its value: left alone', 'common/decisions/x.txt');
{
    const r = inertText('b = {\n\tcounty_modifier = {\n\t\tlifestyle_scholar_xp_gain_mult = 1\n\t}\n}\n', 'common/buildings/x.txt', world);
    check(r.names.get('modifier_type')?.has('lifestyle_scholar_xp_gain_mult') && r.edits === 1, 'the type is told as a name of its kind');
}

// flag words no loaded entry has (the libraries rule cannot give them to an entry of the mod): a test of one never holds
eq('t = {\n\thas_realm_law_flag = clergy_force_land_transfers\n\thas_realm_law_flag = other_flag\n\tNOT = { government_has_flag = government_is_monastic_holy_order }\n}\n', 't = {\n\talways = no\n\thas_realm_law_flag = other_flag\n}\n', 'a law flag no law has is false, a government flag under a NOT is true');
eq('t = {\n\thas_building_with_flag = { flag = gone_building_flag count >= 2 }\n\thas_building_with_flag = gone_building_flag\n\thas_construction_with_flag = gone_building_flag\n}\n', 't = {\n\talways = no\n\talways = no\n\talways = no\n}\n', 'building flags in both forms');
{
    const t = 't = {\n\thas_building_with_flag = { flag = gone_building_flag count < 1 }\n\thas_building_with_flag = { flag = gone_building_flag count = 0 }\n}\n';
    const r = inertText(t, 'common/scripted_triggers/x.txt', world);
    check(r.text === t && r.kept.filter((k) => k.reason === 'context' && k.kind === 'building_flag').length === 2, 'a count that zero satisfies holds when nothing has the flag: left as it is, and told');
}
eq('e = {\n\tif = {\n\t\tlimit = { liege = { government_has_flag = government_is_monastic_holy_order } }\n\t\tadd_gold = 1\n\t}\n\tadd_prestige = 1\n}\n', 'e = {\n\tadd_prestige = 1\n}\n', 'a flag test in a limit makes the if dead', 'common/scripted_effects/x.txt');

// the world of an index: a scripted entry is missing when only hidden files define it AND the libraries rule declined it
{
    const mk = (defs: { removed: boolean; local?: boolean; }[], type = 'scripted_triggers') => ({ id: 1, type, name: 'n', lname: 'n', defs: defs.map((d) => ({ file: 0, line: 1, start: 0, end: 0, ...(d.local ? { local: true } : {}) })), removed: defs.every((d) => d.removed) });
    const worldOf = (entities: ReturnType<typeof mk>[], declined?: (folder: string, name: string) => boolean) =>
    {
        const idx = { vfs: { readText: () => '' }, files: [{ gf: {} }], named: () => entities, isRemoved: (e: { removed: boolean; }) => e.removed } as unknown as Parameters<typeof inertWorld>[0];
        const w = inertWorld(idx);
        w.declined = declined;
        return w;
    };
    const yes = () => true;
    check(worldOf([mk([{ removed: true }])], yes).missing('scripted_trigger', 'n'), 'removed in the index and declined by the libraries rule: missing');
    check(!worldOf([mk([{ removed: true }])], () => false).missing('scripted_trigger', 'n'), 'removed, but the libraries rule carries it back: not missing');
    check(!worldOf([mk([{ removed: true }])]).missing('scripted_trigger', 'n'), 'removed, the libraries rule has not said: not missing');
    check(!worldOf([mk([{ removed: true }, { removed: false }])], yes).missing('scripted_trigger', 'n'), 'a loaded definition as well: not missing');
    check(!worldOf([mk([{ removed: false }])], yes).missing('scripted_trigger', 'n'), 'defined in a loaded file: not missing');
    check(!worldOf([], yes).missing('scripted_trigger', 'n'), 'defined nowhere: a typo is no removal');
    check(!worldOf([mk([{ removed: true, local: true }])], yes).missing('scripted_trigger', 'n'), 'a trigger local to an events file is no entry of the folder');
    check(!worldOf([mk([{ removed: true }], 'scripted_effects')], yes).missing('scripted_trigger', 'n'), 'the type decides: an effect of that name is no trigger');
    const asked: string[] = [];
    const wx = worldOf([mk([{ removed: true }], 'scripted_effects')], (folder) => (asked.push(folder), true));
    check(wx.missing('scripted_effect', 'n') && asked.join() === 'common/scripted_effects', 'the folder it asks the libraries rule about');
    const wg = worldOf([]);
    check(!wg.missing('modifier_type', 'lifestyle_scholar_xp_gain_mult'), 'modifier types: without the content the libraries rule found gone, none is missing');
    const wg2 = worldOf([]);
    wg2.gone = new Set(['lifestyle_scholar', 'kru', 'ab']);
    check(wg2.missing('modifier_type', 'lifestyle_scholar_xp_gain_mult') && wg2.missing('modifier_type', 'kru_opinion'), 'a type whose key starts with gone content and _ is missing');
    check(!wg2.missing('modifier_type', 'lifestyle_reveler_xp_gain_mult') && !wg2.missing('modifier_type', 'lifestyle_scholarly_bonus') && !wg2.missing('modifier_type', 'ab_opinion') && !wg2.missing('modifier_type', 'lifestyle_scholar'), 'another content\'s type, a longer word, a name under 3 letters, the name itself: not missing');
    const wf = worldOf([]);
    check(!wf.missing('law_flag', 'w'), 'flag words: before the libraries rule has said, none is missing');
    const folders: string[] = [];
    wf.flagMissing = (folder, word) => (folders.push(folder), word === 'w');
    check(wf.missing('law_flag', 'w') && !wf.missing('law_flag', 'v') && wf.missing('government_flag', 'w') && wf.missing('contract_flag', 'w'), 'a flag word is missing when the libraries rule says so');
    check(folders.join() === 'common/laws,common/laws,common/governments,common/subject_contracts/contracts', `the folder it asks about: ${folders.join()}`);
}

// the text around it
{
    const t = '﻿# a comment with has_trait = herald\r\nt = {\r\n\t# kept\r\n\thas_trait = herald # why\r\n\tage > 3\r\n}\r\n\r\nu = {\r\n\tage > 4\r\n}\r\n';
    const r = inertText(t, 'common/scripted_triggers/x.txt', world);
    check(r.text === '﻿# a comment with has_trait = herald\r\nt = {\r\n\t# kept\r\n\talways = no # why\r\n\tage > 3\r\n}\r\n\r\nu = {\r\n\tage > 4\r\n}\r\n', 'BOM, CRLF, comments and untouched entries stay');
    check(inertText(r.text, 'common/scripted_triggers/x.txt', world).text === r.text, 'a second pass changes nothing (CRLF)');
    check(r.names.get('trait')?.has('herald') && r.edits === 1, 'the names and the count');
}
{
    const t = 'e = {\r\n\tadd_trait = herald\r\n\tadd_gold = 1\r\n}\r\n';
    check(inertText(t, 'common/scripted_effects/x.txt', world).text === 'e = {\r\n\tadd_gold = 1\r\n}\r\n', 'a dropped statement takes its line, CRLF');
}
{
    // (nothing missing: the text is returned as it is)
    const t = 'e = {\n\thas_trait = brave\n}\n';
    const r = inertText(t, 'common/scripted_triggers/x.txt', world);
    check(r.text === t && r.edits === 0 && !r.names.size, 'nothing missing: nothing changes');
}

// the files of the step: one per directory of the winners' files, the extra z's per directory, an old file with nothing to hold deleted
{
    const entry = (name: string, rel: string) => ({ name, rel, pos: 0, text: name + ' = { always = no }\n', constants: [] });
    const work = {
        folders: [
            { folder: 'common/decisions', entries: [entry('a', 'common/decisions/10_a.txt')], after: '80_major.txt' },
            { folder: 'common/decisions/dlc_decisions/pam', entries: [entry('b', 'common/decisions/dlc_decisions/pam/p.txt')], after: 'zz_old_inert.txt' }
        ],
        files: [], copies: [], sources: [], modSources: [], summary: { names: {}, kept: {} }, present: []
    } as InertWork;
    const root = mkdtempSync(join(tmpdir(), 'ckp-inert-out-'));

    try
    {
        const put = (rel: string, text: string): void =>
        {
            mkdirSync(join(root, rel, '..'), { recursive: true });
            writeFileSync(join(root, rel), text);
        };
        const header = '﻿# common/decisions — written by CrusaderPope\n# Nothing to write (any more): x.\n';
        put('common/decisions/zz_old_inert.txt', header);
        put('common/decisions/dlc_decisions/gone/zz_old_inert.txt', header);
        put('common/decisions/dlc_decisions/hand/zz_old_inert.txt', 'my own text\n');
        const out = inertOutputs(work, 'old', ['common/decisions/zz_old_inert.txt', 'common/decisions/dlc_decisions/gone/zz_old_inert.txt', 'common/decisions/dlc_decisions/hand/zz_old_inert.txt'], root);
        const rels = out.filter((o) => !o.remove).map((o) => o.rel);
        check(rels.join() === 'common/decisions/zz_old_inert.txt,common/decisions/dlc_decisions/pam/zzz_old_inert.txt', 'one file per directory, the z\'s per directory: ' + rels.join(' '));
        check(out.filter((o) => o.remove).map((o) => o.rel).join() === 'common/decisions/dlc_decisions/gone/zz_old_inert.txt', 'an old file with only the tool\'s header and nothing to hold is deleted; one changed by hand stays');
        check(out.find((o) => o.rel === 'common/decisions/dlc_decisions/pam/zzz_old_inert.txt')?.folder === 'common/decisions/dlc_decisions/pam', 'the output names its directory');
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
}

// the step on a small layering (inertWork): the winning definitions of a game file and of a mod file get overrides in the directory of
// the winner (no whole-file copy of the game's database file, round 9: dropped); a copy of one an older run made is no copy of the
// step's, is not rewritten in place, and the patch life deletes it (orphanedRecords) while it is as the run left it
{
    type F = { rel: string; source: number; hidden?: boolean; text: string; };
    const GAME = 0;
    const MOD = 1;
    const PATCH = 2;
    const stepOf = (list: F[], more: Parameters<typeof inertWork>[8] = {}): InertWork =>
    {
        const files = list.map((f) => ({ rel: f.rel, source: f.source, hidden: !!f.hidden, gone: false, area: f.rel.split('/')[0], gf: f }));
        const loaded = (top: string): F[] => list.filter((f) => !f.hidden && f.rel.startsWith(top + '/'));
        const vfs = {
            readText: (gf: F) => gf.text,
            read: (gf: F) => Buffer.from(gf.text),
            list: (top: string) => loaded(top),
            hidden: (top: string) => list.filter((f) => f.hidden && f.rel.startsWith(top + '/')).map((f) => ({ file: f, by: list.find((x) => !x.hidden && x.rel === f.rel)?.source ?? -1, how: 'file' }))
        };
        // (the entities: every top-level key, its definitions in file order)
        const entities = new Map<string, { type: string; name: string; dead: boolean; defs: { file: number; }[]; }>();
        files.forEach((f, i) =>
        {
            const type = f.rel.split('/').slice(1, -1).join('/');

            for (const m of f.gf.text.matchAll(/^([a-z_0-9]+) = \{/gm))
            {
                const e = entities.get(`${type}|${m[1]}`) ?? { type, name: m[1], dead: false, defs: [] };
                e.defs.push({ file: i });
                entities.set(`${type}|${m[1]}`, e);
            }
        });
        const idx = { entities: [...entities.values()], files, vfs } as unknown as Parameters<typeof inertWork>[0];
        return inertWork(idx, world, MOD, PATCH, () => false, undefined, new Set(), [], more);
    };
    const gameText = 'd_a = {\n\tis_shown = { has_trait = herald }\n}\n\nd_b = {\n\tis_shown = { age > 3 }\n}\n\nd_c = {\n\tis_shown = { has_trait = herald }\n}\n';
    const modText = 'd_c = {\n\tis_shown = { age > 5 }\n}\n\nd_m = {\n\tis_shown = { has_trait = herald }\n}\n';
    const plain = 'd_x = {\n\tis_shown = { age > 1 }\n}\n';
    const layering: F[] = [{ rel: 'common/decisions/00_game.txt', source: GAME, text: gameText }, { rel: 'common/decisions/01_plain.txt', source: GAME, text: plain }, { rel: 'common/decisions/10_mod.txt', source: MOD, text: modText }];
    const w1 = stepOf(layering);
    check(!w1.copies.length && w1.folders.length === 1 && w1.folders[0].folder === 'common/decisions' && w1.folders[0].entries.map((e) => e.name).join() === 'd_a,d_m', 'a game file and a mod file with winning definitions to rewrite: overrides of both winners, no whole-file copy (d_c of the game does not win)');
    check(w1.folders[0].entries[0].text === 'd_a = {\n\tis_shown = { always = no }\n}', 'the override is the game\'s definition rewritten');
    check(w1.sources.join() === 'common/decisions/00_game.txt' && w1.modSources.join() === 'common/decisions/10_mod.txt', 'the game file is a source the manifest keeps the hash of (a game update marks the override outdated)');
    // (a patch mod an older run wrote with a whole-file copy of the game file: the copy hides the game's file)
    const oldCopy = gameText.replace(/has_trait = herald/g, 'always = no');
    const record = { copies: ['common/decisions/00_game.txt', 'events/e.txt'], sources: { 'common/decisions/00_game.txt': sha1(Buffer.from(gameText)) } };
    const w2 = stepOf([{ ...layering[0], hidden: true }, { rel: 'common/decisions/00_game.txt', source: PATCH, text: oldCopy.replace('age > 3', 'has_trait = herald') }, layering[1], layering[2]], record);
    check(!w2.copies.length && !w2.files.length && w2.folders[0]?.entries.map((e) => e.name).join() === 'd_m', 'an older run\'s copy of a game database file: not looked at again as a copy, not rewritten in place (the run deletes it first)');
    check(staleGameCopies(record.copies).join() === 'common/decisions/00_game.txt' && !staleGameCopies(['events/x.txt', 'common/on_action/y.txt']).length, 'the copies the step does not make any more: the game database files, not the events and on_actions');
    // (after the patch life deleted it: the same as a run from nothing)
    const w3 = stepOf(layering, { copies: [], sources: {} });
    check(JSON.stringify(w3.folders) === JSON.stringify(w1.folders) && !w3.copies.length, 'with the copy deleted: the overrides of a run from nothing');
    // (the patch life: the copy as the run wrote it is deleted, one changed by hand is kept and told, a record whose file is gone is dropped)
    const root = mkdtempSync(join(tmpdir(), 'ckp-inert-life-'));

    try
    {
        const put = (rel: string, text: string): void =>
        {
            mkdirSync(join(root, rel, '..'), { recursive: true });
            writeFileSync(join(root, rel), text);
        };
        put('common/decisions/00_game.txt', oldCopy);
        put('common/scripted_effects/00_hand.txt', 'my own text\n');
        put('events/e.txt', 'e = { }\n');
        const manifest = {
            restored: {}, merged: {}, lost: {},
            files: { 'common/decisions/00_game.txt': sha1(Buffer.from(oldCopy)), 'common/scripted_effects/00_hand.txt': sha1(Buffer.from('the run\'s text\n')), 'events/e.txt': sha1(Buffer.from('e = { }\n')) },
            inert: { sources: {}, names: [], copies: ['common/decisions/00_game.txt', 'common/scripted_effects/00_hand.txt', 'common/traits/00_gone.txt', 'events/e.txt'] }
        } as unknown as Parameters<typeof orphanedRecords>[0];
        const o = orphanedRecords(manifest, root, new Set(), new Set(), staleGameCopies(manifest.inert!.copies));
        check(o.remove.join() === 'common/decisions/00_game.txt' && o.edited.join() === 'common/scripted_effects/00_hand.txt' && o.forget.join() === 'common/traits/00_gone.txt', 'the patch life: the old copy as the run wrote it is deleted, one changed by hand kept, a gone one forgotten; the event copy stays the step\'s');
    }
    finally
    {
        rmSync(root, { recursive: true, force: true });
    }
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exit(failures ? 1 : 0);
