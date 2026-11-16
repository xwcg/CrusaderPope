import { tr } from './i18n.ts';
import type { ModifierKind } from './api.ts';
/**
 * What the statement picker offers (docs/picker.md): scope types, the scopes one can switch to from each (links,
 * saved scopes, iterators), and the effects and triggers by menu group with their parameters and how they are
 * written. Plain data plus small helpers, no index needed; database entries, flags and the "Other…" keys come from
 * the index at pick time.
 *
 * Coverage follows vanilla usage (scripts/key-frequency.ts and the picker's own key scan, ScriptKeyInfo). Menu
 * labels are short; the preview reads the built script through the describer, so the sentence speaks like the
 * readable view.
 */

/** Scope types the picker knows ('any': statements that work in every scope: variables). */
// (rite, tenet: 1.20; docs/game-structure.md, "Layouts that changed"; the rest from `activity` on: the scopes the game's scripts reach through their own links and lists, 1.20.1 audit; docs/picker.md, "Scope types")
export type ScopeType =
    | 'character' | 'landed_title' | 'province' | 'faith' | 'culture' | 'dynasty' | 'dynasty_house' | 'artifact' | 'war' | 'scheme' | 'secret' | 'religion' | 'rite' | 'tenet'
    | 'activity' | 'struggle' | 'situation' | 'faction' | 'holy_order' | 'domicile' | 'story' | 'epidemic'
    | 'sub_region' | 'participant_group' | 'epidemic_type' | 'great_holy_war' | 'confederation' | 'casus_belli' | 'great_project' | 'contribution' | 'legend' | 'inspiration'
    | 'task_contract' | 'travel_plan' | 'army' | 'regiment' | 'accolade' | 'memory' | 'combat_side' | 'combat' | 'tax_slot' | 'agent_slot' | 'region' | 'trait'
    | 'doctrine' | 'tradition' | 'innovation' | 'holy_site' | 'mercenary' | 'organization' | 'decision' | 'activity_type' | 'great_project_type'
    // (the rest of the game's scope types, event_scopes.log of 1.20.1.2: the script database's links and lists lead to them, docs/script-database.md)
    | 'accolade_type' | 'casus_belli_type' | 'confederation_type' | 'council_task' | 'court_position' | 'court_position_type' | 'culture_pillar'
    | 'government_type' | 'holding_type' | 'holy_site_type' | 'house_relation' | 'legend_type' | 'rite_type' | 'task_contract_type'
    | 'title_and_vassal_change' | 'vassal_contract' | 'vassal_contract_obligation_level';

export type PickKind = 'effect' | 'trigger';

export const SCOPE_LABELS: Record<ScopeType, string> = {
    character: tr('character'),
    landed_title: tr('title'),
    province: tr('province'),
    faith: tr('faith'),
    culture: tr('culture'),
    dynasty: tr('dynasty'),
    dynasty_house: tr('house'),
    artifact: tr('artifact'),
    war: tr('war'),
    scheme: tr('scheme'),
    secret: tr('secret'),
    religion: tr('religion'),
    rite: tr('rite'),
    tenet: tr('tenet'),
    activity: tr('activity'),
    struggle: tr('struggle'),
    situation: tr('situation'),
    faction: tr('faction'),
    holy_order: tr('holy order'),
    domicile: tr('domicile'),
    story: tr('story'),
    epidemic: tr('epidemic'),
    sub_region: tr('situation sub-region'),
    participant_group: tr('participant group'),
    epidemic_type: tr('epidemic type'),
    great_holy_war: tr('great holy war'),
    confederation: tr('house confederation'),
    casus_belli: tr('casus belli'),
    great_project: tr('great project'),
    contribution: tr('contribution'),
    legend: tr('legend'),
    inspiration: tr('inspiration'),
    task_contract: tr('task contract'),
    travel_plan: tr('travel plan'),
    army: tr('army'),
    regiment: tr('men-at-arms regiment'),
    accolade: tr('accolade'),
    memory: tr('memory'),
    combat_side: tr('combat side'),
    combat: tr('combat'),
    tax_slot: tr('tax slot'),
    agent_slot: tr('scheme agent slot'),
    region: tr('region'),
    trait: tr('trait'),
    doctrine: tr('doctrine'),
    tradition: tr('tradition'),
    innovation: tr('innovation'),
    holy_site: tr('holy site'),
    mercenary: tr('mercenary company'),
    organization: tr('faith organization'),
    decision: tr('decision'),
    activity_type: tr('activity type'),
    great_project_type: tr('great project type'),
    accolade_type: tr('accolade type'),
    casus_belli_type: tr('casus belli type'),
    confederation_type: tr('confederation type'),
    council_task: tr('council task'),
    court_position: tr('court position'),
    court_position_type: tr('court position type'),
    culture_pillar: tr('culture pillar'),
    government_type: tr('government type'),
    holding_type: tr('holding type'),
    holy_site_type: tr('holy site type'),
    house_relation: tr('house relation'),
    legend_type: tr('legend type'),
    rite_type: tr('rite type'),
    task_contract_type: tr('task contract type'),
    title_and_vassal_change: tr('title change'),
    vassal_contract: tr('vassal contract'),
    vassal_contract_obligation_level: tr('contract obligation level')
};

/**
 * The app's scope type names where the game's differ (event_scopes.log): the app's name → the game's. Every other
 * type has the game's name.
 */
export const GAME_SCOPE_NAME: Partial<Record<ScopeType, string>> = {
    sub_region: 'situation_sub_region',
    participant_group: 'situation_participant_group',
    great_holy_war: 'ghw',
    contribution: 'project_contribution',
    memory: 'character_memory',
    region: 'geographical_region',
    tradition: 'culture_tradition',
    innovation: 'culture_innovation',
    mercenary: 'mercenary_company'
};

/** A game scope type name as the app's ScopeType; undefined: a type the app does not know (`none`, `value`, a newer game's). */
export function appScopeType(game: string): ScopeType | undefined
{
    const own = (Object.keys(GAME_SCOPE_NAME) as ScopeType[]).find((t) => GAME_SCOPE_NAME[t] === game);

    if (own)
        return own;

    return (SCOPE_LABELS as Record<string, string>)[game] !== undefined && !GAME_SCOPE_NAME[game as ScopeType] ? (game as ScopeType) : undefined;
}

/** Order of the "Effect on …" / "Condition on …" entries of the root menu. */
// (the eight after `tenet` are the scopes the game's scripts run effects in most; every other type is reached through "Their…", the iterators and the event's saved scopes)
export const SCOPE_ORDER: ScopeType[] = ['character', 'landed_title', 'province', 'faith', 'culture', 'dynasty', 'dynasty_house', 'artifact', 'war', 'scheme', 'secret', 'religion', 'rite', 'tenet', 'activity', 'struggle', 'situation', 'faction', 'holy_order', 'domicile', 'story', 'epidemic'];

/** Every scope type, the root menu's and the rest (a PickRequest.scope is one of them). */
export const SCOPE_TYPES = Object.keys(SCOPE_LABELS) as ScopeType[];

/**
 * The types whose definitions have a top-level modifier block whose kind their type and key decide: a raid intent's
 * `modifier` (common/raids/intents writes raid_speed and movement_speed_land_raiding there, both character modifiers in
 * the game's modifiers.log, 1.20.1.2: "Tag: raid_speed / Use areas: character"; the game has no army area), a travel
 * option's `travel_modifier` (common/travel/travel_options: travel_speed, travel_safety; its .info: "applied to the
 * travels safety/speed if the option is picked").
 */
const MODIFIER_BY_TYPE: Record<string, Record<string, Exclude<ModifierKind, 'other'>>> = {
    'raids/intents': { modifier: 'character' },
    'travel/travel_options': { travel_modifier: 'travel_plan' }
};

/**
 * The types whose definitions' top-level `modifier` block is a character's (docs/picker.md, "Modifiers and settings"):
 * every index type of 1.20.1 whose definitions write one holding stat modifiers, found through the index's type ids (a
 * scan of every definition's top-level children, round 13), and what its .info says: a council position's (the
 * councillor's), a court position's (its holder's), a focus's (the character's), a law's (the ruler's), a scripted
 * relation's (each character with it). A raid intent's is a character's too (MODIFIER_BY_TYPE); a scripted modifier's
 * `modifier` is a weight's part, not stats. Any other type (a mod's own folder) gets no kind: its keys are counted as
 * 'other' and the picker offers every modifier.
 */
const TOP_MODIFIER_CHARACTER = new Set(['council_positions', 'court_positions/types', 'focuses', 'laws', 'scripted_relations']);

/**
 * The game's modifier areas (common/modifier_definition_formats/00_<area>_definitions.txt, 1.20.1), in the order the
 * picker's modifier menu lists them (ModifierKeyInfo.area); the general file (00_definitions.txt) is none of them.
 */
export const MODIFIER_AREAS = ['unit', 'terrain', 'subject', 'culture', 'government', 'vassal_stance', 'scheme', 'holding', 'travel', 'lifestyle', 'religion', 'region'] as const;

/** The area of a modifier_definition_formats file by its name (`00_scheme_definitions.txt` → scheme), undefined: the general file or another name. */
export function modifierAreaOf(file: string): string | undefined
{
    const stem = /(?:^|\/)(?:\d+_)?(\w+?)_definitions\.txt$/i.exec(file)?.[1]?.toLowerCase();
    return stem && (MODIFIER_AREAS as readonly string[]).includes(stem) ? stem : undefined;
}

/**
 * What a block of stat modifiers applies to, by its key (docs/picker.md, "Modifiers and settings"): a character
 * (`character_modifier`, `government_character_modifier`, a trait's `culture_modifier`, the modifiers for a liege, an
 * owner, a subject, an employer …, a definition's `modifier`), a county (`county_modifier`,
 * `duchy_capital_county_modifier`), a province (`province_modifier`, `province_terrain_modifier`); undefined: unknown.
 * The 1.20 keys (their .info files): `faith_character_modifier`, `county_holder_character_modifier`, `*_character_modifier`
 * and `character_*_modifier` are characters; `county_*_modifier` / `duchy_capital_county_*_modifier` (`_rite_`, `_culture_`,
 * `_dynasty_`, `_situation_`, `_holding_`) counties; `province_*_modifier` provinces; `rite_modifier` (a rite's parameter),
 * `personal_tenet_modifier`, `clergy_modifier`, `promoter_modifier`, `diarch_modifier`, `realm_modifier` and the domicile
 * temperament modifiers the characters they name. A definition's own top-level `modifier` is a character's only for the
 * types in TOP_MODIFIER_CHARACTER (and when no type is given); another type's is unknown. The type and key pairs in
 * MODIFIER_BY_TYPE come first (`type`: the definition's index type; a raid intent's `modifier` holds character
 * modifiers, a travel option's `travel_modifier` applies to the travel plan).
 */
export function modifierScopeOf(key: string, type?: string): Exclude<ModifierKind, 'other'> | undefined
{
    const byType = type ? MODIFIER_BY_TYPE[type]?.[key] : undefined;

    if (byType)
        return byType;

    if (key === 'modifier')
        return !type || TOP_MODIFIER_CHARACTER.has(type) ? 'character' : undefined;

    if (/character/.test(key))
        return 'character';

    if (/province/.test(key))
        return 'province';

    if (/county/.test(key))
        return 'landed_title';

    if (/^(liege|owner|subject|council_owner|employee|employer|base_employer|house_head|powerful_family\w*|courtier_guest|involved_character|any_house_member|culture|doctrine|government|knight\w*|spouse|heir|vassal|councillor|rite|personal_tenet|clergy|promoter|diarch|realm|domicile_temperament_(high|low))_modifier$/.test(key))
        return 'character';

    return undefined;
}

/** The last word(s) of a saved scope's name that say its type (`scope:target_faction`, `scope:situation_sub_region`). */
const NAMED_TYPES: Record<string, ScopeType> = {
    activity: 'activity',
    struggle: 'struggle',
    situation: 'situation',
    faction: 'faction',
    holy_order: 'holy_order',
    domicile: 'domicile',
    story: 'story',
    epidemic: 'epidemic',
    epidemic_type: 'epidemic_type',
    situation_sub_region: 'sub_region',
    sub_region: 'sub_region',
    situation_participant_group: 'participant_group',
    participant_group: 'participant_group',
    great_holy_war: 'great_holy_war',
    ghw: 'great_holy_war',
    confederation: 'confederation',
    casus_belli: 'casus_belli',
    great_project: 'great_project',
    contribution: 'contribution',
    legend: 'legend',
    inspiration: 'inspiration',
    task_contract: 'task_contract',
    travel_plan: 'travel_plan',
    army: 'army',
    regiment: 'regiment',
    accolade: 'accolade',
    memory: 'memory',
    combat_side: 'combat_side',
    tax_slot: 'tax_slot',
    agent_slot: 'agent_slot',
    trait: 'trait',
    doctrine: 'doctrine',
    tradition: 'tradition',
    innovation: 'innovation',
    holy_site: 'holy_site'
};
const NAMED_SUFFIX = new RegExp(`(?:^|_)(${Object.keys(NAMED_TYPES).sort((a, b) => b.length - a.length).join('|')})$`);

/**
 * The scope type a saved scope's name says it holds (the picker's targets): a province, a title, a scheme …; undefined:
 * a character (actor, recipient, host, liege …); null: something the picker has no statements for (a flag's name, a
 * decision, a score …). The things with scope types of their own (an activity, a story, an epidemic, a faction …) are
 * named by their last word(s): `scope:activity`, `scope:target_faction`, `scope:new_holy_order`: the game's .info files
 * and vanilla's saved scopes name them so.
 */
export function scopeTypeByName(name: string): string | null | undefined
{
    const n = name.toLowerCase();

    const named = NAMED_SUFFIX.exec(n);

    if (named)
        return NAMED_TYPES[named[1]];

    // (`combat` alone: `scope:single_combat` is a duel)
    if (n === 'combat')
        return 'combat';

    if (
        /^(activity|story|epidemic|legend|great_project|situation\w*|tax_slot|travel\w*|special_option|flag_name|opinion_of_liege|replacing|army|regiment|domicile|struggle|inspiration|task_contract|decision|intent|holding|goh|score|on_\w+|\w*_value|\w*_list|\w*_cost|\w*_(days|time|type|category|variables|chance|count|amount|score))$/
            .test(n)
    )
        return null;

    if (/(^|_)(province|location)$/.test(n))
        return 'province';

    if (/(^|_)(title|county|duchy|kingdom|empire|barony)$/.test(n))
        return 'landed_title';

    const direct: Record<string, string> = { scheme: 'scheme', secret: 'secret', war: 'war', faith: 'faith', religion: 'religion', culture: 'culture', house: 'dynasty_house', dynasty: 'dynasty', artifact: 'artifact', rite: 'rite', tenet: 'tenet' };
    return direct[n];
}

/** A PickRequest.scope (or LineSource.scope) as a picker scope type: aliases, unknown → character. */
export function scopeOf(s: string | undefined): ScopeType
{
    if (!s)
        return 'character';

    const alias: Record<string, ScopeType> = { title: 'landed_title', county: 'landed_title', duchy: 'landed_title', kingdom: 'landed_title', empire: 'landed_title', barony: 'landed_title', house: 'dynasty_house' };

    if (alias[s])
        return alias[s];

    return (SCOPE_TYPES as string[]).includes(s) ? (s as ScopeType) : 'character';
}

// ---------------------------------------------------------------------------
// Scopes one can switch to
// ---------------------------------------------------------------------------

/** A scope link (`liege`), a saved scope (`scope:actor`) or `root`: written as `key = { … }`, chained with dots. */
export interface ScopeLink
{
    key: string;
    label: string;
    /** scope types it is reached from (empty: from everywhere (root, saved scopes)) */
    from: ScopeType[];
    to: ScopeType;
    /** shown right in the root menu ("Liege is…") rather than under "Someone else…" */
    main?: boolean;
    /** mnemonic */
    k?: string;
}

export const LINKS: ScopeLink[] = [
    // character → character
    { key: 'root', label: tr('Root'), from: [], to: 'character', main: true, k: 'r' },
    { key: 'liege', label: tr('Liege'), from: ['character'], to: 'character', main: true, k: 'l' },
    { key: 'primary_spouse', label: tr('Primary spouse'), from: ['character'], to: 'character', main: true, k: 'p' },
    { key: 'father', label: tr('Father'), from: ['character'], to: 'character', main: true, k: 'f' },
    { key: 'mother', label: tr('Mother'), from: ['character'], to: 'character', main: true, k: 'm' },
    { key: 'primary_heir', label: tr('Primary heir'), from: ['character'], to: 'character', main: true, k: 'h' },
    { key: 'employer', label: tr('Employer'), from: ['character'], to: 'character', main: true, k: 'e' },
    { key: 'top_liege', label: tr('Top liege'), from: ['character'], to: 'character', k: 't' },
    { key: 'host', label: tr('Host'), from: ['character'], to: 'character' },
    { key: 'betrothed', label: tr('Betrothed'), from: ['character'], to: 'character' },
    { key: 'designated_heir', label: tr('Designated heir'), from: ['character'], to: 'character' },
    { key: 'real_father', label: tr('Real father'), from: ['character'], to: 'character' },
    { key: 'killer', label: tr('Killer'), from: ['character'], to: 'character' },
    { key: 'imprisoner', label: tr('Imprisoner'), from: ['character'], to: 'character' },
    // character → other types
    { key: 'faith', label: tr('Faith'), from: ['character', 'landed_title', 'province', 'rite'], to: 'faith', k: 'f' },
    // (1.20: rites, a character's, a county's or province's; a faith's main one, a realm's state one)
    { key: 'rite', label: tr('Rite'), from: ['character', 'landed_title', 'province'], to: 'rite' },
    { key: 'main_rite', label: tr('Main rite'), from: ['faith'], to: 'rite' },
    { key: 'state_rite', label: tr('State rite'), from: ['landed_title'], to: 'rite' },
    { key: 'culture', label: tr('Culture'), from: ['character', 'landed_title', 'province'], to: 'culture', k: 'c' },
    { key: 'dynasty', label: tr('Dynasty'), from: ['character', 'dynasty_house'], to: 'dynasty', k: 'd' },
    { key: 'house', label: tr('House'), from: ['character'], to: 'dynasty_house', k: 'h' },
    { key: 'primary_title', label: tr('Primary title'), from: ['character'], to: 'landed_title', k: 'p' },
    { key: 'capital_county', label: tr('Capital county'), from: ['character'], to: 'landed_title', k: 'c' },
    { key: 'location', label: tr('Location'), from: ['character', 'army', 'combat'], to: 'province', k: 'l' },
    { key: 'capital_province', label: tr('Capital province'), from: ['character'], to: 'province', k: 'c' },
    // titles
    { key: 'holder', label: tr('Holder'), from: ['landed_title'], to: 'character', main: true, k: 'h' },
    { key: 'de_jure_liege', label: tr('De jure liege title'), from: ['landed_title'], to: 'landed_title', k: 'd' },
    { key: 'duchy', label: tr('Duchy'), from: ['landed_title', 'province'], to: 'landed_title' },
    { key: 'kingdom', label: tr('Kingdom'), from: ['landed_title', 'province'], to: 'landed_title' },
    { key: 'empire', label: tr('Empire'), from: ['landed_title', 'province'], to: 'landed_title' },
    { key: 'title_province', label: tr('Title province'), from: ['landed_title'], to: 'province' },
    // provinces
    { key: 'county', label: tr('County'), from: ['province', 'landed_title'], to: 'landed_title', k: 'c' },
    { key: 'barony', label: tr('Barony'), from: ['province'], to: 'landed_title', k: 'b' },
    { key: 'province_owner', label: tr('Owner'), from: ['province'], to: 'character', main: true, k: 'o' },
    // faiths, cultures, dynasties, houses
    { key: 'religious_head', label: tr('Head of faith'), from: ['faith'], to: 'character', main: true, k: 'h' },
    // (from a character or a province too: `activity_location = { religion = { is_in_family = … } }`: the faith's religion)
    { key: 'religion', label: tr('Religion'), from: ['faith', 'character', 'province'], to: 'religion' },
    // (1.20)
    { key: 'head_of_rite', label: tr('Head of rite'), from: ['rite'], to: 'character', main: true, k: 'h' },
    { key: 'clerical_region_title', label: tr('Clerical region'), from: ['landed_title'], to: 'landed_title' },
    { key: 'clerical_elector_title', label: tr('Clerical elector title'), from: ['character'], to: 'landed_title' },
    { key: 'puppet', label: tr('Puppet'), from: ['character'], to: 'character' },
    { key: 'puppeteer', label: tr('Puppeteer'), from: ['character'], to: 'character' },
    { key: 'saint_in_province', label: tr('Saint of the province'), from: ['province'], to: 'character' },
    // (a holy order's tenet; an activity's are `activity_tenet:1` …, a prefix, see PREFIX_SCOPES)
    { key: 'order_tenet', label: tr('Order tenet'), from: ['holy_order'], to: 'tenet' },
    { key: 'culture_head', label: tr('Culture head'), from: ['culture'], to: 'character', main: true, k: 'h' },
    { key: 'dynast', label: tr('Dynast'), from: ['dynasty'], to: 'character', main: true, k: 'd' },
    { key: 'house_head', label: tr('House head'), from: ['dynasty_house'], to: 'character', main: true, k: 'h' },
    // artifacts, wars, schemes, secrets
    { key: 'artifact_owner', label: tr('Owner'), from: ['artifact'], to: 'character', main: true, k: 'o' },
    { key: 'primary_attacker', label: tr('Primary attacker'), from: ['war', 'casus_belli'], to: 'character', main: true, k: 'a' },
    { key: 'primary_defender', label: tr('Primary defender'), from: ['war', 'casus_belli'], to: 'character', main: true, k: 'd' },
    { key: 'scheme_owner', label: tr('Scheme owner'), from: ['scheme'], to: 'character', main: true, k: 'o' },
    { key: 'scheme_target_character', label: tr('Scheme target'), from: ['scheme'], to: 'character', main: true, k: 't' },
    { key: 'secret_owner', label: tr('Secret owner'), from: ['secret'], to: 'character', main: true, k: 'o' },
    { key: 'secret_target', label: tr('Secret target'), from: ['secret'], to: 'character', main: true, k: 't' },
    // 1.20.1 audit: links vanilla chains through (checked against how the game writes them)
    { key: 'title_capital_county', label: tr('Capital county of the title'), from: ['landed_title'], to: 'landed_title' },
    { key: 'lessee', label: tr('Lessee'), from: ['landed_title'], to: 'character' },
    { key: 'county_controller', label: tr('County controller'), from: ['landed_title'], to: 'character' },
    { key: 'current_heir', label: tr('Current heir to the title'), from: ['landed_title'], to: 'character' },
    { key: 'religious_head_title', label: tr('Title of the head of faith'), from: ['faith'], to: 'landed_title' },
    { key: 'dynasty_founder', label: tr('Dynasty founder'), from: ['dynasty'], to: 'character' },
    { key: 'diarch', label: tr('Diarch'), from: ['character'], to: 'character' },
    { key: 'suzerain', label: tr('Suzerain'), from: ['character'], to: 'character' },
    { key: 'overlord', label: tr('Overlord'), from: ['character'], to: 'character' },
    // Scope types of their own (docs/picker.md, "Scope types"): how the game's scripts reach them and what they lead to:
    // the chains vanilla writes (`scope:activity.activity_host`, `root.current_travel_plan.travel_leader`, `faith.great_holy_war.ghw_war`)
    // activities, travel, domiciles
    { key: 'involved_activity', label: tr('Activity they are in'), from: ['character'], to: 'activity' },
    { key: 'activity_host', label: tr('Activity host'), from: ['activity'], to: 'character', main: true, k: 'h' },
    { key: 'activity_location', label: tr('Activity location'), from: ['activity'], to: 'province' },
    { key: 'special_guest', label: tr('Special guest'), from: ['activity'], to: 'character' },
    { key: 'current_travel_plan', label: tr('Travel plan'), from: ['character'], to: 'travel_plan' },
    { key: 'travel_leader', label: tr('Travel leader'), from: ['travel_plan'], to: 'character', main: true, k: 'l' },
    { key: 'travel_plan_owner', label: tr('Travel plan owner'), from: ['travel_plan'], to: 'character' },
    { key: 'current_location', label: tr('Current location'), from: ['travel_plan'], to: 'province' },
    { key: 'departure_location', label: tr('Departure location'), from: ['travel_plan'], to: 'province' },
    { key: 'next_destination_province', label: tr('Next destination'), from: ['travel_plan'], to: 'province' },
    { key: 'final_destination_province', label: tr('Final destination'), from: ['travel_plan'], to: 'province' },
    { key: 'domicile', label: tr('Domicile'), from: ['character'], to: 'domicile' },
    { key: 'tax_slot', label: tr('Tax slot'), from: ['character'], to: 'tax_slot' },
    { key: 'title_domicile', label: tr('Domicile of the title'), from: ['landed_title'], to: 'domicile' },
    { key: 'domicile_location', label: tr('Domicile location'), from: ['domicile'], to: 'province' },
    { key: 'domicile_culture', label: tr('Domicile culture'), from: ['domicile'], to: 'culture' },
    { key: 'domicile_faith', label: tr('Domicile faith'), from: ['domicile'], to: 'faith' },
    { key: 'domicile_rite', label: tr('Domicile rite'), from: ['domicile'], to: 'rite' },
    // stories, inspirations, legends, memories, accolades
    { key: 'story_owner', label: tr('Story owner'), from: ['story'], to: 'character' },
    { key: 'inspiration', label: tr('Inspiration'), from: ['character'], to: 'inspiration' },
    { key: 'inspiration_owner', label: tr('Inspiration owner'), from: ['inspiration'], to: 'character' },
    { key: 'inspiration_sponsor', label: tr('Inspiration sponsor'), from: ['inspiration'], to: 'character' },
    { key: 'promoted_legend', label: tr('Legend they promote'), from: ['character'], to: 'legend' },
    { key: 'legend_owner', label: tr('Legend owner'), from: ['legend'], to: 'character' },
    { key: 'legend_protagonist', label: tr('Legend protagonist'), from: ['legend'], to: 'character' },
    { key: 'accolade', label: tr('Accolade'), from: ['character'], to: 'accolade' },
    { key: 'acclaimed_knight', label: tr('Acclaimed knight'), from: ['accolade'], to: 'character' },
    { key: 'creator', label: tr('Creator'), from: ['artifact'], to: 'character' },
    // factions, holy orders, great holy wars, organizations
    { key: 'joined_faction', label: tr('Faction they joined'), from: ['character'], to: 'faction' },
    { key: 'faction_leader', label: tr('Faction leader'), from: ['faction'], to: 'character', main: true, k: 'l' },
    { key: 'special_character', label: tr('Special character'), from: ['faction'], to: 'character' },
    { key: 'special_title', label: tr('Special title'), from: ['faction'], to: 'landed_title' },
    { key: 'faction_war', label: tr('Faction war'), from: ['faction'], to: 'war' },
    { key: 'holy_order', label: tr('Holy order'), from: ['character'], to: 'holy_order' },
    { key: 'leader', label: tr('Leader'), from: ['holy_order'], to: 'character', main: true, k: 'l' },
    { key: 'holy_order_patron', label: tr('Patron'), from: ['holy_order'], to: 'character' },
    { key: 'great_holy_war', label: tr('Great holy war'), from: ['faith'], to: 'great_holy_war' },
    { key: 'ghw_war', label: tr('Great holy war war'), from: ['great_holy_war'], to: 'war' },
    { key: 'ghw_war_declarer', label: tr('War declarer'), from: ['great_holy_war'], to: 'character' },
    { key: 'ghw_title_recipient', label: tr('Title recipient'), from: ['great_holy_war'], to: 'character' },
    { key: 'ghw_target_character', label: tr('Target character'), from: ['great_holy_war'], to: 'character' },
    { key: 'ghw_target_title', label: tr('Target title'), from: ['great_holy_war'], to: 'landed_title' },
    { key: 'organization', label: tr('Organization'), from: ['faith'], to: 'organization' },
    // house confederations, wars and casus belli, armies, combats
    { key: 'house_confederation', label: tr('House confederation'), from: ['dynasty_house'], to: 'confederation' },
    { key: 'confederation', label: tr('Confederation'), from: ['character'], to: 'confederation' },
    { key: 'leading_house', label: tr('Leading house'), from: ['confederation'], to: 'dynasty_house' },
    { key: 'casus_belli', label: tr('Casus belli'), from: ['war'], to: 'casus_belli' },
    { key: 'war', label: tr('War'), from: ['casus_belli'], to: 'war' },
    { key: 'combat_war', label: tr('War of the combat'), from: ['combat'], to: 'war' },
    { key: 'knight_army', label: tr('Knight’s army'), from: ['character'], to: 'army' },
    { key: 'mercenary_company_leader', label: tr('Mercenary company leader'), from: ['mercenary'], to: 'character' },
    { key: 'army_owner', label: tr('Army owner'), from: ['army'], to: 'character' },
    { key: 'army_commander', label: tr('Army commander'), from: ['army'], to: 'character' },
    { key: 'involved_combat_side', label: tr('Combat side they fight on'), from: ['army'], to: 'combat_side' },
    { key: 'combat', label: tr('Combat'), from: ['combat_side'], to: 'combat' },
    { key: 'enemy_side', label: tr('Enemy side'), from: ['combat_side'], to: 'combat_side' },
    { key: 'combat_attacker', label: tr('Attacking side'), from: ['combat'], to: 'combat_side' },
    { key: 'combat_defender', label: tr('Defending side'), from: ['combat'], to: 'combat_side' },
    { key: 'side_primary_participant', label: tr('Primary participant'), from: ['combat_side'], to: 'character' },
    // great projects, task contracts, situations
    { key: 'contributor', label: tr('Contributor'), from: ['contribution'], to: 'character' },
    { key: 'great_project_owner', label: tr('Great project owner'), from: ['great_project'], to: 'character' },
    { key: 'great_project_founder', label: tr('Great project founder'), from: ['great_project'], to: 'character' },
    { key: 'great_project_location', label: tr('Great project location'), from: ['great_project'], to: 'province' },
    { key: 'task_contract_employer', label: tr('Contract employer'), from: ['task_contract'], to: 'character' },
    { key: 'task_contract_taker', label: tr('Contract taker'), from: ['task_contract'], to: 'character' },
    { key: 'task_contract_location', label: tr('Contract location'), from: ['task_contract'], to: 'province' },
    { key: 'task_contract', label: tr('Task contract'), from: ['scheme'], to: 'task_contract' },
    { key: 'situation_center_province', label: tr('Center of the situation'), from: ['situation'], to: 'province' },
    // (the sub-region with the top phase: 64 uses; the group of a situation by `top_participant_group:<situation>` is a database prefix, see PREFIX_SCOPES)
    { key: 'situation_top_sub_region', label: tr('Top sub-region'), from: ['situation'], to: 'sub_region' },
    { key: 'epidemic_type', label: tr('Epidemic type'), from: ['epidemic'], to: 'epidemic_type' },
    { key: 'epidemic_trait', label: tr('Epidemic trait'), from: ['epidemic_type'], to: 'trait' },
    // more characters, titles and holy sites
    { key: 'home_court', label: tr('Home court'), from: ['character'], to: 'character' },
    { key: 'warden', label: tr('Warden'), from: ['character'], to: 'character' },
    { key: 'superior', label: tr('Superior'), from: ['character'], to: 'character' },
    { key: 'designated_diarch', label: tr('Designated diarch'), from: ['character'], to: 'character' },
    { key: 'default_location', label: tr('Default location'), from: ['character'], to: 'province' },
    { key: 'previous_holder', label: tr('Previous holder'), from: ['landed_title'], to: 'character' },
    { key: 'lessee_title', label: tr('Title of the lessee'), from: ['landed_title'], to: 'landed_title' },
    { key: 'last_house_head', label: tr('Last house head'), from: ['dynasty_house'], to: 'character' },
    { key: 'holy_site_county', label: tr('Holy site county'), from: ['holy_site'], to: 'landed_title' },
    // 1.20.1 audit, round three: links vanilla chains through that the catalog lacked (`scope:faction.faction_target.house`, `enemy_side.side_commander.primary_title`,
    // `scope:scheme.scheme_target_title.holder`, `scope:actor.obedience_target`, `diarchy_successor = { … }`, `scope:task_contract.task_contract_target.liege`).
    // Left out because the type depends on what the script runs for: `intent_target` (a province, a character or a house, by the activity's intent) and
    // `councillor_task_target` (a character or a county, by the council task); docs/picker.md, "Scope types"
    { key: 'faction_target', label: tr('Faction target'), from: ['faction'], to: 'character' },
    { key: 'side_commander', label: tr('Side commander'), from: ['combat_side'], to: 'character' },
    { key: 'scheme_target_title', label: tr('Scheme target title'), from: ['scheme'], to: 'landed_title' },
    { key: 'obedience_target', label: tr('Obedience target'), from: ['character'], to: 'character' },
    { key: 'diarchy_successor', label: tr('Diarchy successor'), from: ['character'], to: 'character' },
    { key: 'task_contract_target', label: tr('Contract target'), from: ['task_contract'], to: 'character' },
    // round 13 (E5b / P6): links the readable view's own tables held and the picker lacked, and the ones scripts/scope-check.ts unknown-links found used in the game's script
    // (block uses counted in the 1.20.1 common/ + events/: player_heir 194, court_owner 119, owner 198, capital_barony 28, primary_partner 14)
    { key: 'player_heir', label: tr('Player heir'), from: ['character'], to: 'character' },
    { key: 'court_owner', label: tr('Court owner'), from: ['character'], to: 'character' },
    { key: 'primary_partner', label: tr('Primary partner'), from: ['character'], to: 'character' },
    { key: 'owner', label: tr('Domicile owner'), from: ['domicile'], to: 'character' },
    { key: 'capital_barony', label: tr('Capital barony'), from: ['character', 'landed_title'], to: 'landed_title' }
];

/** The one type every link of the key leads to (`owner`: the entries may differ in `from` only), when they agree. */
export function agreedLink(key: string): ScopeLink | undefined
{
    const same = LINKS.filter((x) => x.key === key);
    return same.length && same.every((x) => x.to === same[0].to) ? same[0] : undefined;
}

/**
 * The scope type of a database prefix's entries (`title:k_france` a title). (struggle:x, situation:x … are entries
 * that are scopes of their own type; activity_tenet:1 / activity_doctrine:1 an activity's; top_participant_group:<situation>
 * the situation's top group)
 */
export const PREFIX_SCOPES: Record<string, ScopeType> = {
    character: 'character',
    title: 'landed_title',
    faith: 'faith',
    culture: 'culture',
    dynasty: 'dynasty',
    house: 'dynasty_house',
    province: 'province',
    religion: 'religion',
    rite: 'rite',
    tenet: 'tenet',
    struggle: 'struggle',
    situation: 'situation',
    top_participant_group: 'participant_group',
    doctrine: 'doctrine',
    culture_tradition: 'tradition',
    activity_tenet: 'tenet',
    activity_doctrine: 'doctrine'
};

/**
 * A value naming a database entry by a chain of links instead (`set_character_rite = scope:x.rite`,
 * `top_liege.primary_title.state_rite`): whether it may be one of `type`. The chain's last link is typed by its key
 * alone, when every LINKS entry of that key agrees (agreedLink, the picker's chainType in free mode): true when it
 * leads to `type`; a saved scope alone (`scope:new_rite`) has no type and fits; a chain whose last link the catalog does
 * not know, or leads elsewhere (`scope:x.faith` for a rite), does not.
 */
export function chainFits(value: string, type: ScopeType): boolean
{
    if (/^scope:\w+$/.test(value))
        return true;

    const parts = value.split('.');

    if (parts.length < 2 || !parts.every((p, i) => (i === 0 ? /^(scope:)?\w+$/ : /^\w+$/).test(p)))
        return false;

    return agreedLink(parts[parts.length - 1])?.to === type;
}

/** Saved scopes most used in vanilla (event and interaction scopes), offered under "Saved scope…" and for targets. */
export const SAVED_SCOPES: { key: string; label: string; }[] = [
    { key: 'scope:actor', label: tr('Actor (scope:actor)') },
    { key: 'scope:recipient', label: tr('Recipient (scope:recipient)') },
    { key: 'scope:target', label: tr('Target (scope:target)') },
    { key: 'scope:secondary_recipient', label: tr('Secondary recipient') },
    { key: 'scope:host', label: tr('Host (scope:host)') },
    { key: 'prev', label: tr('Previous scope (prev)') }
];

/** A list the game can iterate: every_/random_/ordered_ (effects), any_ (triggers). */
export interface IteratorDef
{
    list: string;
    /** singular ("child") */
    label: string;
    from: ScopeType[];
    to: ScopeType;
    /** every_/random_ exist (as the key scan sees the game's effect blocks: picker-check) */
    effect: boolean;
    /** any_ exists (likewise) */
    trigger: boolean;
    // (both false: the game writes the list only in blocks the key scan does not walk (a weight's `modifier`, an interaction's `populate_recipient_list`), so the picker does not offer it; its scopes still serve the readable view and the change menus)
    /**
     * the keys it takes first in its block, asked when it is chosen, in this order: a relation's `type = friend`, a
     * `pool_character`'s `province = root.location`; those without `optional` are required by the game's scripts
     * (docs/picker.md, "Lists with parameters")
     */
    params?: IteratorParam[];
    /** a list of the whole game, written in any scope (`every_ruler`, `any_pool_character`): `from` is where the picker offers it */
    global?: boolean;
    /** `order_by` values that fit its items (ordered_: "The one with the highest …") */
    orders?: [string, string][];
}

/** A key a list takes inside its block: the value is an entry of an index type, a scope, one of a few words or a name. */
export interface IteratorParam
{
    /** the key written in the block (`province`, `type`, `name`) */
    key: string;
    /** the question of the menu ("Which relation?") */
    label: string;
    kind: 'ref' | 'scope' | 'choice' | 'text';
    /** kind ref: the index type whose entries are listed (a relation's: friend, rival …) */
    ref?: string;
    /** kind scope: the scope type the value leads to; its links from the place, the event's saved scopes of that type and these `common` ones (value, label) are offered */
    to?: ScopeType;
    common?: [string, string][];
    /** kind choice: [value, label] */
    options?: [string, string][];
    /** kind text: names the game's scripts use (typing is always possible) */
    suggestions?: string[];
    /** may be left out (the game's scripts mostly write it): the label of leaving it out ("Any secret") */
    optional?: string;
    /** the value names the items of the list ("each friend") */
    names?: boolean;
}

const it = (list: string, label: string, from: ScopeType[], to: ScopeType, effect = true, trigger = true, extra: Partial<IteratorDef> = {}): IteratorDef => ({ list, label, from, to, effect, trigger, ...extra });

/** `order_by` values the game uses for characters and titles (ordered_ iterators) */
export const CHARACTER_ORDERS: [string, string][] = [
    ['age', 'age'],
    ['prowess', 'prowess'],
    ['martial', 'martial'],
    ['diplomacy', 'diplomacy'],
    ['stewardship', 'stewardship'],
    ['intrigue', 'intrigue'],
    ['learning', 'learning'],
    ['prestige', 'prestige'],
    ['piety', 'piety'],
    ['gold', 'gold'],
    ['highest_held_title_tier', tr('title tier')],
    ['max_military_strength', tr('military strength')],
    ['opinion(root)', tr('opinion of Root')]
];
export const TITLE_ORDERS: [string, string][] = [
    ['tier', 'tier'],
    ['development_level', 'development'],
    ['county_control', tr('county control')]
];

const who_ = { orders: CHARACTER_ORDERS };
const land = { orders: TITLE_ORDERS };

// Keys lists take inside their block, as vanilla writes them (`province` in every `pool_character`, `region` in every `county_in_region`, `name` in every `guest_subset`; the optional ones in most uses)
const PROVINCE: IteratorParam[] = [
    { key: 'province', kind: 'scope', to: 'province', label: tr('In which province?'), common: [['root.location', tr('Root’s location')], ['root.capital_province', tr('Root’s capital province')]] }
];
const REGION: IteratorParam[] = [
    {
        key: 'region',
        kind: 'text',
        label: tr('In which region?'),
        suggestions: ['world_europe', 'world_europe_west_iberia', 'world_europe_east', 'world_africa', 'world_middle_east', 'world_persian_empire', 'world_asia_minor', 'world_steppe', 'world_india', 'world_burma', 'world_tibet', 'world_asia_east', 'world_asia_southeast']
    }
];
const COURT_POSITION: IteratorParam[] = [{ key: 'type', kind: 'ref', ref: 'court_positions/types', label: tr('Which court position?'), optional: tr('Any court position') }];
const ARTIFACT_SLOT: IteratorParam[] = [{ key: 'artifact_slot_type', kind: 'ref', ref: 'artifacts/slots', label: tr('In which slot?'), optional: tr('Any slot') }];
const STORY: IteratorParam[] = [{ key: 'type', kind: 'ref', ref: 'story_cycles', label: tr('Which kind of story?'), optional: tr('Any story') }];
const GUEST_SUBSET: IteratorParam[] = [{ key: 'name', kind: 'text', label: tr('Which group of guests?') }];
const TRAIT_CATEGORY: IteratorParam[] = [
    { key: 'category', kind: 'text', label: tr('Which category?'), suggestions: ['personality', 'education', 'lifestyle', 'commander', 'fame', 'health', 'childhood', 'court_type'] }
];
const KNOWLEDGE: IteratorParam[] = [
    { key: 'knowledge_filter', kind: 'choice', label: tr('Known or unknown?'), optional: tr('Either'), options: [['known', tr('Known')], ['unknown', tr('Unknown')]] }
];
const INVOLVEMENT: IteratorParam[] = [
    { key: 'involvement', kind: 'choice', label: tr('How involved?'), optional: tr('Either'), options: [['involved', tr('Involved')], ['interloper', tr('Interloper')]] }
];

/**
 * Lists the game's scripts write `even_if_dead = yes` inside (a scan of vanilla common/ and events/: the family and
 * relation lists). The parameter is not offered on other lists (`every_living_character` would contradict it, and
 * nothing shows the game takes it on a vassal or courtier list).
 */
export const DEAD_LISTS = new Set(['parent', 'child', 'spouse', 'ancestor', 'sibling', 'close_or_extended_family_member', 'close_family_member', 'former_spouse', 'real_parent', 'real_grandparent', 'relation', 'consort', 'house_member', 'former_concubine', 'former_concubinist']);

export const ITERATORS: IteratorDef[] = [
    it('child', 'child', ['character'], 'character', true, true, who_),
    it('vassal', 'vassal', ['character'], 'character', true, true, who_),
    it('courtier', 'courtier', ['character'], 'character', true, true, who_),
    it('courtier_or_guest', tr('courtier or guest'), ['character'], 'character', true, true, who_),
    it('spouse', 'spouse', ['character'], 'character', true, true, who_),
    it('consort', 'consort', ['character'], 'character', true, true, who_),
    it('sibling', 'sibling', ['character'], 'character', true, true, who_),
    it('parent', 'parent', ['character'], 'character', true, true, who_),
    it('close_family_member', tr('close family member'), ['character'], 'character', true, true, who_),
    it('knight', 'knight', ['character'], 'character', true, true, who_),
    it('councillor', 'councillor', ['character'], 'character', true, true, who_),
    it('prisoner', 'prisoner', ['character'], 'character', true, true, who_),
    it('ally', 'ally', ['character'], 'character', true, true, who_),
    it('vassal_or_below', tr('vassal or below'), ['character'], 'character', true, true, who_),
    it('liege_or_above', tr('liege or above'), ['character'], 'character', false, true),
    // (`type = friend`: which relation; the game's relation iterators always name one)
    it('relation', 'relation', ['character'], 'character', true, true, { ...who_, params: [{ key: 'type', kind: 'ref', ref: 'scripted_relations', label: tr('Which relation?'), names: true }] }),
    it('dynasty_member', tr('dynasty member'), ['dynasty'], 'character', true, true, who_),
    it('house_member', tr('house member'), ['dynasty_house'], 'character', true, true, who_),
    it('held_title', tr('held title'), ['character'], 'landed_title', true, true, land),
    it('held_county', tr('held county'), ['character'], 'landed_title', true, true, land),
    it('realm_county', tr('realm county'), ['character'], 'landed_title', true, true, land),
    it('sub_realm_county', tr('sub-realm county'), ['character'], 'landed_title', true, true, land),
    it('de_jure_county', tr('de jure county'), ['landed_title'], 'landed_title', true, true, land),
    it('neighboring_county', tr('neighboring county'), ['landed_title'], 'landed_title', true, true, land),
    it('county_province', tr('county province'), ['landed_title'], 'province'),
    it('character_artifact', 'artifact', ['character'], 'artifact'),
    it('character_war', 'war', ['character'], 'war'),
    it('scheme', 'scheme', ['character'], 'scheme', true, true, { params: [{ key: 'type', kind: 'ref', ref: 'schemes/scheme_types', label: tr('Which kind of scheme?'), optional: tr('Any scheme'), names: true }] }),
    it('secret', 'secret', ['character'], 'secret', true, true, { params: [{ key: 'type', kind: 'ref', ref: 'secret_types', label: tr('Which kind of secret?'), optional: tr('Any secret'), names: true }] }),
    // 1.20: tenets, rites, clerical regions, saints (as the game uses them: every_ in effects = effect, any_ = trigger)
    it('personal_tenet', tr('personal tenet'), ['character'], 'tenet'),
    it('character_tenet', 'tenet', ['character'], 'tenet', true, true, { params: KNOWLEDGE }),
    it('desired_tenet', tr('desired tenet'), ['character'], 'tenet'),
    it('undesired_tenet', tr('undesired tenet'), ['character'], 'tenet', false),
    it('rite_tenet', tr('tenet of the rite'), ['rite'], 'tenet'),
    it('faith_rite', tr('rite of the faith'), ['faith'], 'rite'),
    it('available_rite', tr('available rite'), ['character'], 'rite', false),
    it('clerical_region_title', tr('clerical region'), ['faith'], 'landed_title'),
    it('county_in_clerical_region', tr('county in the clerical region'), ['landed_title'], 'landed_title'),
    it('ruler_in_clerical_region', tr('ruler in the clerical region'), ['landed_title'], 'character'),
    it('clerical_region_in_dejure_title', tr('clerical region in the de jure title'), ['landed_title'], 'landed_title'),
    it('clerical_region_in_realm', tr('clerical region in the realm'), ['character'], 'landed_title', true, false),
    it('clerical_elector_title', tr('clerical elector title'), ['faith'], 'landed_title'),
    it('saint', 'saint', ['faith'], 'character', false),
    // 1.20.1 audit: lists vanilla uses a lot (scope types checked against how the game writes them; the lists of scope types the catalog has no type for (activities, struggles, situations, factions, holy orders …), and those that need a parameter (pool_character `province`, county_in_region `region`), are left out)
    it('close_or_extended_family_member', tr('close or extended family member'), ['character'], 'character', true, true, who_),
    it('powerful_vassal', tr('powerful vassal'), ['character'], 'character', true, true, who_),
    it('tributary', 'tributary', ['character'], 'character', true, true, who_),
    it('neighboring_top_liege_realm_owner', tr('neighboring top liege'), ['character'], 'character', true, true, who_),
    // (global lists: written inside any scope; offered from a character's)
    it('player', 'player', ['character'], 'character', true, true, { ...who_, global: true }),
    it('ruler', 'ruler', ['character'], 'character', true, true, { ...who_, global: true }),
    it('independent_ruler', tr('independent ruler'), ['character'], 'character', true, true, { ...who_, global: true }),
    it('faith', 'faith', ['character', 'religion'], 'faith', true, true, { global: true }),
    it('claim', 'claim', ['character'], 'landed_title', true, true, land),
    it('heir_title', tr('title the character is heir to'), ['character'], 'landed_title', true, true, land),
    it('sub_realm_title', tr('sub-realm title'), ['character'], 'landed_title', true, true, land),
    it('sub_realm_barony', tr('sub-realm barony'), ['character'], 'landed_title', true, true, land),
    it('realm_province', tr('realm province'), ['character'], 'province'),
    it('known_secret', tr('known secret'), ['character'], 'secret'),
    it('claimant', 'claimant', ['landed_title'], 'character', true, true, who_),
    it('title_heir', tr('heir to the title'), ['landed_title'], 'character', true, true, who_),
    it('connected_county', tr('connected county'), ['landed_title'], 'landed_title', true, true, land),
    it('direct_de_jure_vassal_title', tr('direct de jure vassal title'), ['landed_title'], 'landed_title', true, true, land),
    it('in_de_jure_hierarchy', tr('title in the de jure hierarchy'), ['landed_title'], 'landed_title', true, true, land),
    it('this_title_or_de_jure_above', tr('this title or one above it'), ['landed_title'], 'landed_title', true, true, land),
    it('neighboring_province', tr('neighboring province'), ['province'], 'province'),
    it('culture_county', tr('county of the culture'), ['culture'], 'landed_title', true, true, land),
    it('parent_culture_or_above', tr('parent culture or above'), ['culture'], 'culture', false, true),
    it('holy_site_barony', tr('holy site barony'), ['faith'], 'landed_title', true, true, land),
    it('faith_ruler', tr('ruler of the faith'), ['faith'], 'character', true, true, who_),
    it('war_participant', tr('war participant'), ['war'], 'character', true, true, who_),
    it('war_attacker', tr('war attacker'), ['war'], 'character', true, true, who_),
    it('war_defender', tr('war defender'), ['war'], 'character', true, true, who_),
    // 1.20.1 audit, round two: the lists of the scope types the catalog has now (activities, travel plans, struggles, situations, factions, holy orders, domiciles, stories, epidemics …), the global lists and those that need a parameter; scopes read off how vanilla writes each one (docs/picker.md, "Scope types")
    // characters of a character
    it('ancestor', tr('ancestor'), ['character'], 'character', true, true, who_),
    it('heir', tr('heir'), ['character'], 'character', true, true, who_),
    it('concubine', tr('concubine'), ['character'], 'character', true, true, who_),
    it('former_spouse', tr('former spouse'), ['character'], 'character', true, true, who_),
    it('former_concubine', tr('former concubine'), ['character'], 'character', false, true),
    it('former_concubinist', tr('former concubinist'), ['character'], 'character', false, true),
    it('real_parent', tr('real parent'), ['character'], 'character', false, false),
    it('real_grandparent', tr('real grandparent'), ['character'], 'character', false, false),
    it('real_great_grandparent', tr('real great-grandparent'), ['character'], 'character', false, false),
    it('extended_family_member', tr('extended family member'), ['character'], 'character', true, false, who_),
    it('killed_character', tr('killed character'), ['character'], 'character', true, true, who_),
    it('subordinate', tr('subordinate'), ['character'], 'character', true, true, who_),
    it('subject', tr('subject'), ['character'], 'character', true, true, who_),
    it('traveling_family_member', tr('traveling family member'), ['character'], 'character', true, true, who_),
    it('hooked_character', tr('hooked character'), ['character'], 'character', true, true, who_),
    it('warden_hostage', tr('held hostage'), ['character'], 'character', true, true, who_),
    it('home_court_hostage', tr('home court hostage'), ['character'], 'character', true, true, who_),
    it('foreign_court_guest', tr('foreign court guest'), ['character'], 'character', true, true, who_),
    it('courtier_away', tr('absent courtier'), ['character'], 'character', true, false, who_),
    it('pool_guest', tr('pool guest'), ['character'], 'character', true, true, who_),
    it('tax_collector', tr('tax collector'), ['character'], 'character', true, true, who_),
    it('tax_collector_vassal', tr('tax collector vassal'), ['character'], 'character', true, true, who_),
    it('theocratic_vassal', tr('theocratic vassal'), ['character'], 'character', true, true, who_),
    it('war_enemy', tr('war enemy'), ['character'], 'character', true, true, who_),
    it('war_ally', tr('war ally'), ['character'], 'character', true, true, who_),
    it('primary_war_enemy', tr('primary war enemy'), ['character'], 'character', true, true, who_),
    it('truce_target', tr('truce target'), ['character'], 'character', true, true, who_),
    it('truce_holder', tr('truce holder'), ['character'], 'character', true, true, who_),
    it('hostile_raider', tr('hostile raider'), ['character'], 'character', false, true, who_),
    it('acclaimed_knight', tr('acclaimed knight'), ['character'], 'character', false, true, who_),
    it('diarchy_succession_character', tr('diarchy succession candidate'), ['character'], 'character', true, true, who_),
    it('court_position_employer', tr('court position employer'), ['character'], 'character', false, true),
    it('martial_councillor', tr('martial councillor'), ['character'], 'character', true, true, who_),
    it('diplomacy_councillor', tr('diplomacy councillor'), ['character'], 'character', true, true, who_),
    it('stewardship_councillor', tr('stewardship councillor'), ['character'], 'character', false, true),
    it('intrigue_councillor', tr('intrigue councillor'), ['character'], 'character', true, true, who_),
    it('learning_councillor', tr('learning councillor'), ['character'], 'character', true, true, who_),
    it('normal_councillor', tr('regular councillor'), ['character'], 'character', true, true, who_),
    it('neighboring_realm_owner', tr('neighboring realm owner'), ['character'], 'character', false, false),
    it('neighboring_realm_same_rank_owner', tr('same-rank neighboring realm owner'), ['character'], 'character', true, true, who_),
    it('neighboring_realm_with_tributaries_owner', tr('tributary-inclusive neighboring realm owner'), ['character'], 'character', false, true),
    it('land_neighboring_realm_with_tributaries_owner', tr('tributary-inclusive neighboring land realm owner'), ['character'], 'character', true, true, who_),
    it('neighboring_and_across_water_realm_owner', tr('neighboring or overseas realm owner'), ['character'], 'character', true, true, who_),
    it('neighboring_and_across_water_realm_same_rank_owner', tr('same-rank neighboring or overseas realm owner'), ['character'], 'character', true, true, who_),
    it('neighboring_and_across_water_top_liege_realm_owner', tr('neighboring or overseas top liege'), ['character'], 'character', true, true, who_),
    it('neighboring_top_suzerain_realm_owner', tr('neighboring top suzerain'), ['character'], 'character', false, true),
    // court position (type)
    it('court_position_holder', tr('court position holder'), ['character'], 'character', true, true, { ...who_, params: COURT_POSITION }),
    // global character lists
    it('pool_character', tr('pool character'), ['character'], 'character', true, true, { ...who_, params: PROVINCE, global: true }),
    it('character_with_royal_court', tr('royal court character'), ['character'], 'character', true, true, { ...who_, global: true }),
    it('living_character', tr('living character'), ['character'], 'character', true, false, { ...who_, global: true }),
    it('contact', tr('contact'), ['character'], 'character', true, true, who_),
    // things of a character
    it('directly_owned_province', tr('directly owned province'), ['character'], 'province', true, true),
    it('character_to_title_neighboring_county', tr('realm-neighboring county'), ['character'], 'landed_title', true, true, land),
    it('character_to_title_neighboring_duchy', tr('realm-neighboring duchy'), ['character'], 'landed_title', true, true, land),
    it('character_to_title_neighboring_and_across_water_county', tr('realm-neighboring or overseas county'), ['character'], 'landed_title', true, true, land),
    it('character_to_title_neighboring_and_across_water_duchy', tr('realm-neighboring or overseas duchy'), ['character'], 'landed_title', false, true, land),
    it('character_to_title_neighboring_and_across_water_empire', tr('realm-neighboring or overseas empire'), ['character'], 'landed_title', false, false),
    it('realm_de_jure_duchy', tr('realm de jure duchy'), ['character'], 'landed_title', true, true, land),
    it('realm_de_jure_kingdom', tr('realm de jure kingdom'), ['character'], 'landed_title', true, true, land),
    it('realm_de_jure_empire', tr('realm de jure empire'), ['character'], 'landed_title', true, true, land),
    it('sub_realm_duchy', tr('sub-realm duchy'), ['character'], 'landed_title', true, true, land),
    it('sub_realm_kingdom', tr('sub-realm kingdom'), ['character'], 'landed_title', true, true, land),
    it('sub_realm_empire', tr('sub-realm empire'), ['character'], 'landed_title', true, true, land),
    it('realm_border_county', tr('realm border county'), ['character'], 'landed_title', true, true, land),
    it('top_realm_border_county', tr('top realm border county'), ['character', 'landed_title'], 'landed_title', true, true, land),
    it('neighboring_top_liege_realm', tr('neighboring top realm'), ['character'], 'landed_title', true, true, land),
    it('neighboring_and_across_water_top_liege_realm', tr('neighboring or overseas top realm'), ['character'], 'landed_title', true, true, land),
    it('de_jure_claim', tr('de jure claim'), ['character'], 'landed_title', true, true, land),
    it('pretender_title', tr('pretender title'), ['character'], 'landed_title', false, true, land),
    it('election_title', tr('electable title'), ['character'], 'landed_title', false, false, land),
    it('alert_creatable_title', tr('creatable title'), ['character'], 'landed_title', true, true, land),
    it('alert_usurpable_title', tr('usurpable title'), ['character'], 'landed_title', false, false, land),
    it('noble_family', tr('noble family'), ['character'], 'landed_title', true, true, land),
    it('powerful_family', tr('powerful family'), ['character'], 'dynasty_house', true, true),
    it('equipped_character_artifact', tr('equipped artifact'), ['character'], 'artifact', true, true, { params: ARTIFACT_SLOT }),
    it('claimed_artifact', tr('claimed artifact'), ['character'], 'artifact', true, true),
    it('personal_claimed_artifact', tr('personally claimed artifact'), ['character'], 'artifact', true, false),
    it('character_trait', tr('trait'), ['character'], 'trait', true, true),
    it('character_doctrine', tr('doctrine'), ['character'], 'doctrine', true, true, { params: KNOWLEDGE }),
    it('controlled_faith', tr('controlled faith'), ['landed_title'], 'faith', false, true),
    // things with scope types of their own, from a character
    it('character_struggle', tr('struggle'), ['character'], 'struggle', true, true, { params: INVOLVEMENT }),
    it('character_situation', tr('situation'), ['character'], 'situation', true, true),
    it('character_epidemic', tr('epidemic'), ['character'], 'epidemic', false, true),
    it('memory', tr('memory'), ['character'], 'memory', true, true),
    it('owned_story', tr('story'), ['character'], 'story', true, true, { params: STORY }),
    it('character_active_contract', tr('active task contract'), ['character'], 'task_contract', true, true),
    it('character_task_contract', tr('task contract'), ['character'], 'task_contract', true, true),
    it('targeting_faction', tr('targeting faction'), ['character'], 'faction', true, true),
    it('targeting_scheme', tr('targeting scheme'), ['character'], 'scheme', true, true),
    it('targeting_secret', tr('targeting secret'), ['character'], 'secret', true, true),
    it('maa_regiment', tr('men-at-arms regiment'), ['character'], 'regiment', true, true),
    it('army', tr('army'), ['character'], 'army', true, true),
    it('hired_mercenary', tr('hired mercenary company'), ['character'], 'mercenary', false, true),
    it('active_accolade', tr('active accolade'), ['character'], 'accolade', true, true),
    it('tax_slot', tr('tax slot'), ['character'], 'tax_slot', false, true),
    it('sponsored_inspiration', tr('sponsored inspiration'), ['character'], 'inspiration', true, true),
    it('patroned_holy_order', tr('patroned holy order'), ['character'], 'holy_order', true, true),
    it('invited_activity', tr('invited activity'), ['character'], 'activity', false, true),
    it('open_invite_activity', tr('open-invite activity'), ['character'], 'activity', false, true),
    // global lists of things
    it('culture_global', tr('culture'), ['character'], 'culture', true, true, { global: true }),
    it('religion_global', tr('religion'), ['character'], 'religion', true, true, { global: true }),
    it('kingdom', tr('kingdom'), ['character'], 'landed_title', true, true, { ...land, global: true }),
    it('duchy', tr('duchy'), ['character'], 'landed_title', true, true, { ...land, global: true }),
    it('empire', tr('empire'), ['character'], 'landed_title', true, true, { ...land, global: true }),
    it('county', tr('county'), ['character'], 'landed_title', true, true, { ...land, global: true }),
    it('hegemony', tr('hegemony title'), ['character'], 'landed_title', true, true, { ...land, global: true }),
    it('province', tr('province'), ['character'], 'province', true, true, { global: true }),
    it('special_building_province', tr('special building province'), ['character'], 'province', true, true, { global: true }),
    it('dynasty', tr('dynasty'), ['character'], 'dynasty', true, false, { global: true }),
    it('dynasty_house', tr('house'), ['character'], 'dynasty_house', true, false, { global: true }),
    it('artifact', tr('artifact'), ['character'], 'artifact', true, true, { global: true }),
    it('great_project', tr('great project'), ['character'], 'great_project', true, true, { global: true }),
    it('legend', tr('legend'), ['character'], 'legend', true, true, { global: true }),
    it('accolade', tr('accolade'), ['character'], 'accolade', true, true, { global: true }),
    it('epidemic', tr('epidemic'), ['character'], 'epidemic', true, true, { global: true }),
    it('confederation', tr('house confederation'), ['character'], 'confederation', true, true, { global: true }),
    it('domicile', tr('domicile'), ['character'], 'domicile', true, false, { global: true }),
    it('task_contract', tr('task contract'), ['character'], 'task_contract', false, true, { global: true }),
    it('mercenary_company', tr('mercenary company'), ['character'], 'mercenary', true, true, { global: true }),
    it('trait', tr('trait'), ['character'], 'trait', true, false, { global: true }),
    it('trait_in_category', tr('category trait'), ['character'], 'trait', true, true, { params: TRAIT_CATEGORY, global: true }),
    it('doctrine', tr('doctrine'), ['character'], 'doctrine', false, true, { global: true }),
    it('tenet', tr('tenet'), ['character'], 'tenet', true, true, { global: true }),
    it('county_in_region', tr('region county'), ['character'], 'landed_title', true, true, { ...land, params: REGION, global: true }),
    // faiths, holy sites, organizations
    it('faith_holy_order', tr('faith holy order'), ['faith'], 'holy_order', true, true),
    it('holy_site', tr('holy site'), ['faith'], 'holy_site', true, true),
    it('eminent_holy_site', tr('eminent holy site'), ['faith'], 'holy_site', true, true),
    it('faith_county', tr('faith county'), ['faith'], 'landed_title', true, false, land),
    it('faith_character', tr('faith character'), ['faith'], 'character', true, true, who_),
    it('faith_playable_ruler', tr('faith playable ruler'), ['faith'], 'character', true, true, who_),
    it('faith_subordinate', tr('faith subordinate'), ['faith'], 'character', false, true),
    it('religious_head_challenger', tr('head of faith challenger'), ['faith'], 'character', true, true, who_),
    it('theocratic_ruler', tr('theocratic ruler'), ['faith'], 'character', true, false, who_),
    it('neighboring_faith', tr('neighboring faith'), ['faith'], 'faith', true, false),
    it('county_holy_site', tr('county holy site'), ['landed_title'], 'holy_site', true, true),
    it('barony_holy_site', tr('barony holy site'), ['landed_title'], 'holy_site', false, false),
    it('holy_site_faith', tr('holy site faith'), ['holy_site'], 'faith', true, true),
    it('holy_site_enshrined_artifact', tr('enshrined artifact'), ['holy_site'], 'artifact', true, true),
    it('organization_member', tr('organization member'), ['organization'], 'character', true, true, who_),
    // cultures and houses
    it('parent_culture', tr('parent culture'), ['culture'], 'culture', true, true),
    it('tradition', tr('tradition'), ['culture'], 'tradition', true, true),
    it('culture_tradition', tr('culture tradition'), ['culture'], 'tradition', false, true),
    it('known_innovation', tr('known innovation'), ['culture'], 'innovation', true, true),
    it('culture_duchy', tr('culture duchy'), ['culture'], 'landed_title', true, true, land),
    it('culture_kingdom', tr('culture kingdom'), ['culture'], 'landed_title', false, true),
    it('culture_empire', tr('culture empire'), ['culture'], 'landed_title', false, true),
    it('house_relation', tr('house relation'), ['dynasty_house'], 'dynasty_house', true, true),
    it('relation_house', tr('related house'), ['dynasty_house'], 'dynasty_house', true, true),
    it('house_unity_member', tr('house unity member'), ['dynasty_house'], 'character', true, true, who_),
    it('adult_house_member', tr('adult house member'), ['dynasty_house'], 'character', false, true),
    it('house_claimed_artifact', tr('house claimed artifact'), ['dynasty_house'], 'artifact', true, false),
    // titles
    it('title_to_title_neighboring_county', tr('neighboring county'), ['landed_title'], 'landed_title', true, true, land),
    it('title_to_title_neighboring_duchy', tr('neighboring duchy'), ['landed_title'], 'landed_title', true, true, land),
    it('title_to_title_neighboring_kingdom', tr('neighboring kingdom'), ['landed_title'], 'landed_title', false, true),
    it('title_to_title_neighboring_empire', tr('neighboring empire'), ['landed_title'], 'landed_title', false, true),
    it('title_to_title_neighboring_and_across_water_county', tr('neighboring or overseas county'), ['landed_title'], 'landed_title', true, true, land),
    it('title_to_title_neighboring_and_across_water_duchy', tr('neighboring or overseas duchy'), ['landed_title'], 'landed_title', true, true, land),
    it('title_to_title_neighboring_and_across_water_kingdom', tr('neighboring or overseas kingdom'), ['landed_title'], 'landed_title', true, true, land),
    it('title_to_title_neighboring_and_across_water_empire', tr('neighboring or overseas empire'), ['landed_title'], 'landed_title', true, true, land),
    it('in_de_facto_hierarchy', tr('de facto hierarchy title'), ['landed_title'], 'landed_title', true, true, land),
    it('direct_de_facto_vassal_title', tr('direct de facto vassal title'), ['landed_title'], 'landed_title', true, true, land),
    it('de_jure_top_liege', tr('de jure top title'), ['landed_title'], 'landed_title', false, true),
    it('past_holder', tr('past holder'), ['landed_title'], 'character', true, true, who_),
    it('past_holder_reversed', tr('reversed past holder'), ['landed_title'], 'character', true, true, who_),
    it('de_jure_county_holder', tr('de jure county holder'), ['landed_title'], 'character', true, true, who_),
    it('dejure_vassal_title_holder', tr('de jure vassal title holder'), ['landed_title'], 'character', true, true, who_),
    it('elector', tr('elector'), ['landed_title'], 'character', true, true, who_),
    it('election_candidate', tr('election candidate'), ['landed_title'], 'character', true, true, who_),
    it('succession_appointment_investors', tr('succession appointment investor'), ['landed_title'], 'character', true, true, who_),
    it('title_maa_regiment', tr('title men-at-arms regiment'), ['landed_title'], 'regiment', false, true),
    it('controlled_title_maa_regiment', tr('controlled title regiment'), ['landed_title'], 'regiment', false, true),
    it('owned_title_maa_regiment', tr('owned title regiment'), ['landed_title'], 'regiment', true, true),
    it('county_situation', tr('county situation'), ['landed_title'], 'situation', true, true),
    it('county_situation_sub_region', tr('county situation sub-region'), ['landed_title'], 'sub_region', true, true),
    it('county_struggle', tr('county struggle'), ['landed_title'], 'struggle', false, true),
    it('county_province_epidemic', tr('county epidemic'), ['landed_title'], 'epidemic', false, true),
    it('title_joined_faction', tr('joined faction'), ['landed_title'], 'faction', false, true),
    // provinces
    it('province_epidemic', tr('province epidemic'), ['province'], 'epidemic', true, true),
    it('province_legend', tr('province legend'), ['province'], 'legend', true, true),
    it('province_domicile', tr('province domicile'), ['province'], 'domicile', true, true),
    it('great_project_in_province', tr('province great project'), ['province'], 'great_project', false, true),
    it('character_in_location', tr('resident character'), ['province'], 'character', true, true, who_),
    it('army_in_location', tr('local army'), ['province'], 'army', true, true),
    // activities, travel
    it('attending_character', tr('attending character'), ['activity'], 'character', true, true, who_),
    it('guest_subset', tr('subset guest'), ['activity'], 'character', true, true, { ...who_, params: GUEST_SUBSET }),
    it('guest_subset_current_phase', tr('current-phase subset guest'), ['activity'], 'character', true, true, { ...who_, params: GUEST_SUBSET }),
    it('invited_character', tr('invited character'), ['activity'], 'character', false, true, who_),
    it('special_guest', tr('special guest'), ['activity'], 'character', true, true, who_),
    it('activity_phase_location', tr('phase location'), ['activity'], 'province', true, false),
    it('activity_phase_location_past', tr('past phase location'), ['activity'], 'province', false, true),
    it('entourage_character', tr('entourage character'), ['travel_plan'], 'character', true, true, who_),
    it('visited_location', tr('visited location'), ['travel_plan'], 'province', true, false),
    it('future_path_location', tr('future path location'), ['travel_plan'], 'province', false, true),
    // struggles, situations
    it('involved_ruler', tr('involved ruler'), ['struggle'], 'character', true, true, who_),
    it('interloper_ruler', tr('interloper ruler'), ['struggle'], 'character', true, false, who_),
    it('involved_county', tr('involved county'), ['struggle'], 'landed_title', true, false, land),
    it('situation_sub_region', tr('sub-region'), ['situation'], 'sub_region', true, true),
    it('participant_group', tr('participant group'), ['situation'], 'participant_group', true, true),
    it('situation_participant', tr('participant'), ['situation'], 'character', true, true, who_),
    it('situation_county', tr('situation county'), ['situation'], 'landed_title', true, true, land),
    it('situation_sub_region_participant_group', tr('sub-region participant group'), ['sub_region'], 'participant_group', true, true),
    it('situation_sub_region_participant', tr('sub-region participant'), ['sub_region'], 'character', true, true, who_),
    it('situation_sub_region_county', tr('sub-region county'), ['sub_region'], 'landed_title', true, true, land),
    it('situation_sub_region_geographical_region', tr('sub-region geographical region'), ['sub_region'], 'region', true, false),
    it('situation_group_participant', tr('group participant'), ['participant_group'], 'character', true, true, who_),
    // factions, orders, confederations, wars, schemes, secrets, other
    it('faction_member', tr('faction member'), ['faction'], 'character', true, true, who_),
    it('faction_county_member', tr('faction county member'), ['faction'], 'landed_title', true, true, land),
    it('leased_title', tr('leased title'), ['holy_order'], 'landed_title', true, true, land),
    it('confederation_member', tr('confederation member'), ['confederation'], 'character', true, true, who_),
    it('confederation_member_house', tr('member house'), ['confederation'], 'dynasty_house', true, true),
    it('pledged_attacker', tr('pledged attacker'), ['great_holy_war'], 'character', true, true, who_),
    it('pledged_defender', tr('pledged defender'), ['great_holy_war'], 'character', true, false, who_),
    it('target_title', tr('target title'), ['casus_belli'], 'landed_title', true, true, land),
    it('contribution', tr('contribution'), ['great_project'], 'contribution', true, true),
    it('infected_province', tr('infected province'), ['epidemic'], 'province', true, true),
    it('spread_province', tr('spread province'), ['legend'], 'province', false, true),
    it('legend_promoter', tr('legend promoter'), ['legend'], 'character', false, true),
    it('secret_knower', tr('secret knower'), ['secret'], 'character', true, true, who_),
    it('secret_participant', tr('secret participant'), ['secret'], 'character', false, true),
    it('scheme_agent_character', tr('scheme agent'), ['scheme'], 'character', true, true, who_),
    it('scheme_agent_slot', tr('scheme agent slot'), ['scheme'], 'agent_slot', true, true),
    it('memory_participant', tr('memory participant'), ['memory'], 'character', true, true, who_),
    it('side_knight', tr('side knight'), ['combat_side'], 'character', true, true, who_),
    it('side_commander', tr('side commander'), ['combat_side'], 'character', true, true, who_),
    it('side_participant', tr('side participant'), ['combat_side'], 'character', true, true, who_),
    it('army_maa_regiment', tr('army regiment'), ['army'], 'regiment', true, true),
    it('tax_slot_vassal', tr('tax slot vassal'), ['tax_slot'], 'character', true, true, who_),
    it('opposite_trait', tr('opposite trait'), ['trait'], 'trait', true, true),
    // (from the lists that were left: the scope read off the statements inside: `is_spouse_of = prev` for the player's heirs, `this = scope:target` for a title)
    it('pinned_character', tr('pinned character'), ['character'], 'character', false, true),
    it('player_heir', tr('player heir'), ['character'], 'character', true, true, who_),
    it('succession_appointment_invested_candidate', tr('invested succession candidate'), ['character'], 'character', false, false, who_),
    it('succession_appointment_invested_title', tr('invested succession title'), ['character'], 'landed_title', false, false, land),
    it('artifact_claimant', tr('artifact claimant'), ['artifact'], 'character', true, true, who_),
    it('artifact_house_claimant', tr('artifact house claimant'), ['artifact'], 'dynasty_house', false, true),
    it('great_project_type', tr('great project type'), ['character'], 'great_project_type', false, true, { global: true }),
    it('activity_type', tr('activity type'), ['character'], 'activity_type', false, false, { global: true }),
    it('decision', tr('decision'), ['character'], 'decision', false, false, { global: true }),
    // 1.20.1 audit, round three: lists vanilla uses that were missing. `every_activity` / `any_activity` run anywhere (tournament.txt: the activities of the whole game); the spouse
    // candidates run in the character who is looked at (`scope:secondary_actor = { every_opposite_sex_spouse_candidate … }`), `potential_marriage_option` in the one an important action
    // checks. All five are written only in blocks the key scan does not walk (script values, scripted modifiers, an important action's `check_create_action`, an AI weight): the readable
    // view and the change menus know them, the picker does not offer them. Left out: `raid_target` (only `always = yes` inside), `required_heir_government_type` (the items are government types, no scope type of ours) and
    // `court_position_candidate` (it takes a `court_position_type = scope:…` that is no entry of an index type)
    it('inspired_character', tr('inspired character'), ['character'], 'character', false, false, { ...who_, global: true }),
    it('opposite_sex_spouse_candidate', tr('opposite-sex spouse candidate'), ['character'], 'character', false, false, who_),
    it('same_sex_spouse_candidate', tr('same-sex spouse candidate'), ['character'], 'character', false, false, who_),
    it('potential_marriage_option', tr('potential marriage option'), ['character'], 'character', false, false, who_),
    it('culture_innovation', tr('culture innovation'), ['culture'], 'innovation', true, false),
    it('activity', tr('activity'), ['character'], 'activity', false, false, { global: true })
];

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface ParamBase
{
    /** placeholder in the script template: `$name$` */
    name: string;
    /** the question of the menu ("Towards whom?") */
    label: string;
    /** may be left out: the menu offers `none` (a label: "Forever", "Nobody"), the template's `[…]` group is dropped */
    optional?: string;
}

/** A number: presets, typed digits, named script values. `sign: -1` writes the negated amount (verb "Remove"). */
export interface NumberParam extends ParamBase
{
    kind: 'number';
    presets: number[];
    /** script values offered by name (`medium_prestige_gain`); written as they are, never negated */
    named?: string[];
    sign?: 1 | -1;
    /** shows + on positive presets ("+30") */
    signed?: boolean;
    /** a unit after the number in the menu ("%", "years") */
    unit?: string;
}

/** Under / Over / At least / At most / Exactly → `<` `>` `>=` `<=` `=` */
export interface CompareParam extends ParamBase
{
    kind: 'compare';
}

/** Someone (or something) as a scope: links, root, saved scopes, or a typed `scope:name`. */
export interface ScopeParam extends ParamBase
{
    kind: 'scope';
    to: ScopeType;
    /** values offered first, most common in vanilla first (`root`, `scope:actor`, `liege`) */
    common?: string[];
    /** "Themselves" (`this`) is a sensible choice */
    self?: boolean;
    /**
     * the template writes it inside a scope switch of its own (`$title$ = { change_title_holder = { holder = $holder$ } }`):
     * a value relative to the statement's subject (`this`, `liege`) is written through `prev` there (fillTemplate, inPrev)
     */
    switched?: boolean;
}

/** A database entry of an index type (`traits`, `opinion_modifiers`, …): type-ahead over its names. */
export interface RefParam extends ParamBase
{
    kind: 'ref';
    type: string;
    /** written in front of the key: `faith:`, `culture:`, `title:` */
    prefix?: string;
    /** scope expressions offered first (`root.faith`: "Root’s faith") */
    scopes?: { value: string; label: string; }[];
}

/** One of a fixed set of values; `value` may also fill a key (`add_$skill$_skill`). */
export interface ChoiceParam extends ParamBase
{
    kind: 'choice';
    options: { value: string; label: string; k?: string; }[];
}

/** `days = N` / `weeks = N` / `months = N` / `years = N` */
export interface DurationParam extends ParamBase
{
    kind: 'duration';
    presets: [number, 'days' | 'weeks' | 'months' | 'years'][];
    /**
     * the game takes a random time between two (`days = { 5 10 }`): offered as "A random time between…"; set where
     * vanilla 1.20.1.2 writes ranges (trigger_event 1,455, add_character_flag 46, add_character_modifier 9)
     */
    range?: boolean;
}

/** A flag or variable name: the index's flags / variables as suggestions, or a new name. */
export interface NameParam extends ParamBase
{
    kind: 'name';
    /** index type of the suggestions */
    type: 'flag' | 'variable';
}

/** Free text (with suggestions). */
export interface TextParam extends ParamBase
{
    kind: 'text';
    suggestions?: string[];
    /**
     * also suggest the values the game's script writes for this statement's key (the key scan, most used first), or
     * for another `key`, or for one `field` of the statement's block (`set_relation_friend = { reason = … }`)
     */
    usage?: boolean | { key?: string; field?: string; };
}

export type ParamDef = NumberParam | CompareParam | ScopeParam | RefParam | ChoiceParam | DurationParam | NameParam | TextParam;

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * One effect or trigger as the picker builds it. `script` is the template: `$param$` placeholders, `[…]` groups that
 * are dropped when an optional parameter inside is left out; `short` is used instead when every optional parameter
 * is left out (`add_character_flag = x` rather than `{ flag = x }`).
 */
export interface StatementDef
{
    id: string;
    kind: PickKind;
    /** effects: add / remove / set / do; triggers: main / family / realm / marks / more (EFFECT_GROUPS, TRIGGER_GROUPS) */
    group: string;
    /** menu label, short ("Opinion"); the group gives the verb */
    label: string;
    /** scope types it runs in; empty = global (the "Game & world" menu) */
    scopes: ScopeType[] | 'any';
    script: string;
    short?: string;
    /** asked in this order */
    params: ParamDef[];
    /**
     * parameters the template has in `[…]` groups that are not asked when building, only when changing a written
     * statement that has them (`add_opinion = { … years = 5 }`), each with its `optional` label
     */
    extra?: ParamDef[];
    /** mnemonic */
    k?: string;
    /** extra words for the search (`/`) */
    words?: string;
    /** only built by a continuation ("Later…"), not listed */
    hidden?: boolean;
    /** read and changed where written, but not offered when building: the game needs more around it than one statement (see `title.holder`) */
    noBuild?: boolean;
    /** `exists = <subject>`: written outside the subject's scope switch */
    subjectValue?: boolean;
    /** what it does, when the label can't say it (shown while the row is highlighted) */
    help?: string;
    /**
     * a scope the template saves and names itself (`save_scope_as = $change$ … scope:$change$`), not asked: the picker
     * fills `name` with `base`, or `base_2`, `base_3` … when the place already has a scope of that name (freeScopeName in
     * picker/model.ts); fillTemplate writes `base` when nothing filled it
     */
    saves?: { name: string; base: string; };
}

export const EFFECT_GROUPS: { id: string; label: string; k: string; help?: string; }[] = [
    {
        id: 'pregnancy',
        label: tr('Pregnancy…'),
        k: 'p',
        help: tr('Make them pregnant (for sure), let them sleep with someone (pregnant by chance), mark the coming child a known bastard, end a pregnancy.')
    },
    { id: 'add', label: tr('Add…'), k: 'a' },
    { id: 'remove', label: tr('Remove…'), k: 'r' },
    { id: 'set', label: tr('Set / change…'), k: 's' },
    { id: 'do', label: tr('Do…'), k: 'd' }
];

export const TRIGGER_GROUPS: { id: string; label: string; k?: string; }[] = [
    { id: 'main', label: '' },
    { id: 'resources', label: tr('Prestige, piety, stress…'), k: 'p' },
    { id: 'family', label: tr('Family & relations…'), k: 'y' },
    { id: 'realm', label: tr('Titles & realm…'), k: 'z' },
    { id: 'marks', label: tr('Flags, modifiers & variables…'), k: 'v' },
    { id: 'more', label: tr('More…'), k: 'x' }
];

export const COMPARE_OPTIONS: { op: string; label: string; k: string; }[] = [
    { op: '<', label: tr('Under'), k: 'u' },
    { op: '>', label: tr('Over'), k: 'o' },
    { op: '>=', label: tr('At least'), k: 'l' },
    { op: '<=', label: tr('At most'), k: 'm' },
    { op: '=', label: tr('Exactly'), k: 'e' }
];

// parameter helpers
const num = (name: string, label: string, presets: number[], extra: Partial<NumberParam> = {}): NumberParam => ({ name, kind: 'number', label, presets, ...extra });
const cmp = (): CompareParam => ({ name: 'cmp', kind: 'compare', label: tr('Compared how?') });
const who = (name: string, label: string, extra: Partial<ScopeParam> = {}): ScopeParam => ({ name, kind: 'scope', label, to: 'character', common: ['root', 'scope:actor', 'scope:recipient', 'liege', 'primary_spouse'], ...extra });
const ref = (name: string, label: string, type: string, extra: Partial<RefParam> = {}): RefParam => ({ name, kind: 'ref', label, type, ...extra });
const choice = (name: string, label: string, options: [string, string, string?][]): ChoiceParam => ({ name, kind: 'choice', label, options: options.map(([value, l, k]) => ({ value, label: l, k })) });
const dur = (label = tr('For how long?'), none = tr('Forever')): DurationParam => ({
    name: 'duration',
    kind: 'duration',
    label,
    optional: none,
    presets: [
        [1, 'months'],
        [6, 'months'],
        [1, 'years'],
        [2, 'years'],
        [5, 'years'],
        [10, 'years'],
        [20, 'years']
    ]
});
/** a trait's experience track (`add_trait_xp`, `has_trait_xp`): the game's names are suggested; left out, the trait's only one */
const TRACK: TextParam = { name: 'track', kind: 'text', label: tr('Which track?'), optional: tr('The trait’s only track'), usage: { field: 'track' } };
const flagName = (label = tr('Which flag?')): NameParam => ({ name: 'flag', kind: 'name', label, type: 'flag' });
const varName = (label = tr('Which variable?')): NameParam => ({ name: 'name', kind: 'name', label, type: 'variable' });

const faithRef = (): RefParam =>
    ref('faith', tr('Which faith?'), 'faith', {
        prefix: 'faith:',
        scopes: [
            { value: 'root.faith', label: tr('Root’s faith') },
            { value: 'liege.faith', label: tr('Liege’s faith') },
            { value: 'scope:actor.faith', label: tr('Actor’s faith') }
        ]
    });
const cultureRef = (): RefParam =>
    ref('culture', tr('Which culture?'), 'culture/cultures', {
        prefix: 'culture:',
        scopes: [
            { value: 'root.culture', label: tr('Root’s culture') },
            { value: 'liege.culture', label: tr('Liege’s culture') },
            { value: 'scope:actor.culture', label: tr('Actor’s culture') }
        ]
    });
const titleRef = (label = tr('Which title?')): RefParam =>
    ref('title', label, 'landed_titles', {
        prefix: 'title:',
        scopes: [
            { value: 'root.primary_title', label: tr('Root’s primary title') },
            { value: 'liege.primary_title', label: tr('Liege’s primary title') },
            { value: 'scope:target', label: tr('Target (scope:target)') }
        ]
    });

const SKILLS: [string, string, string?][] = [
    ['diplomacy', 'Diplomacy', 'd'],
    ['martial', 'Martial', 'm'],
    ['stewardship', 'Stewardship', 's'],
    ['intrigue', 'Intrigue', 'i'],
    ['learning', 'Learning', 'l'],
    ['prowess', 'Prowess', 'p']
];
const RELATIONS: [string, string, string?][] = [
    ['friend', 'Friend', 'f'],
    ['rival', 'Rival', 'r'],
    ['lover', 'Lover', 'l'],
    ['best_friend', tr('Best friend'), 'b'],
    ['nemesis', 'Nemesis', 'n'],
    ['soulmate', 'Soulmate', 's'],
    ['potential_friend', tr('Potential friend')],
    ['potential_rival', tr('Potential rival')],
    ['potential_lover', tr('Potential lover')],
    ['crush', 'Crush', 'c'],
    ['guardian', 'Guardian', 'g'],
    ['ward', 'Ward', 'w'],
    ['mentor', 'Mentor', 'm']
];
const TIERS: [string, string, string?][] = [
    ['tier_barony', 'Barony', 'b'],
    ['tier_county', 'County', 'c'],
    ['tier_duchy', 'Duchy', 'd'],
    ['tier_kingdom', 'Kingdom', 'k'],
    ['tier_empire', 'Empire', 'e']
];

type Extra = Partial<StatementDef>;
const E = (id: string, group: string, label: string, scopes: ScopeType[] | 'any', script: string, params: ParamDef[] = [], extra: Extra = {}): StatementDef => ({
    id: 'e.' + id,
    kind: 'effect',
    group,
    label,
    scopes,
    script,
    params,
    ...extra
});
const T = (id: string, group: string, label: string, scopes: ScopeType[] | 'any', script: string, params: ParamDef[] = [], extra: Extra = {}): StatementDef => ({
    id: 't.' + id,
    kind: 'trigger',
    group,
    label,
    scopes,
    script,
    params,
    ...extra
});

/** Add X / Remove X for a resource written `key = amount` (remove: the amount negated, or the "loss" script values). */
function resource(key: string, label: string, scopes: ScopeType[], presets: number[], gain: string[] = [], loss: string[] = [], k?: string, removeKey?: string): StatementDef[]
{
    return [
        E(`add.${key}`, 'add', label, scopes, `${key} = $value$`, [num('value', tr('How much?'), presets, { named: gain, signed: true })], { k }),
        E(`remove.${key}`, 'remove', label, scopes, `${removeKey ?? key} = $value$`, [num('value', tr('How much?'), presets, removeKey ? { named: loss } : { named: loss, sign: -1 })], { k })
    ];
}

const levels = (what: string, dir: 'gain' | 'loss', sizes = ['minor', 'medium', 'major']): string[] => sizes.map((s) => `${s}_${what}_${dir}`);

const CH: ScopeType[] = ['character'];

// helpers of the statements for the scope types of their own (STATEMENTS, "scopes of their own")
/** A scope of a type (an activity, a province, a title …) as a parameter: the links and saved scopes that lead to it are offered, `common` first. */
const thing = (name: string, label: string, to: ScopeType, common: string[] = [], extra: Partial<ScopeParam> = {}): ScopeParam => ({ name, kind: 'scope', label, to, common, ...extra });
/** A word the game's scripts write for the statement's key (a phase, a parameter, a reward): the key scan's values are suggested, typing is always possible. */
const word = (name: string, label: string, usage: TextParam['usage'] = true, extra: Partial<TextParam> = {}): TextParam => ({ name, kind: 'text', label, usage, ...extra });
const yesno = (name: string, label: string): ChoiceParam => choice(name, label, [['yes', tr('Yes'), 'y'], ['no', tr('No'), 'n']]);
/** A span of days, weeks or months (a journey's delay, an activity's next phase): required, unlike `dur` (`weeks` is the game's: 80 uses, 25 of the 100 `progress_activity_phase_after`) */
const span = (label: string): DurationParam => ({ name: 'duration', kind: 'duration', label, presets: [[1, 'days'], [3, 'days'], [7, 'days'], [14, 'days'], [30, 'days'], [1, 'weeks'], [2, 'weeks'], [4, 'weeks'], [8, 'weeks'], [1, 'months'], [3, 'months'], [6, 'months']] });
/** A legend's chapter: the chronicles' `chapters = { <key> … }` are free names (common/legends/chronicles/_chronicles.info); the game's own are suggested, the key scan adds a mod's */
const CHAPTER: TextParam = { name: 'name', kind: 'text', label: tr('Which chapter?'), suggestions: ['opening', 'motivation', 'discovery', 'battle', 'famous_deed', 'extra_deed', 'hunt', 'conclusion'], usage: { field: 'name' } };
/** The game's hostility levels (common/script_values/02_religion_values.txt): what `faith_hostility_level` / `rite_hostility_level` are compared with */
const HOSTILITY_LEVELS = ['faith_fully_accepted_level', 'faith_astray_level', 'faith_hostile_level', 'faith_evil_level'];
const tenetRef = (prefix?: string): RefParam => ref('tenet', tr('Which tenet?'), 'religion/tenet_types', prefix ? { prefix } : {});
/** A rite: `rite:hanafi`, or the rite of someone the script already has (1.20: a character, a county, a faith's main one) */
const riteRef = (): RefParam =>
    ref('rite', tr('Which rite?'), 'religion/rite_types', {
        prefix: 'rite:',
        scopes: [
            { value: 'root.rite', label: tr('Root’s rite') },
            { value: 'liege.rite', label: tr('Liege’s rite') },
            { value: 'scope:actor.rite', label: tr('Actor’s rite') }
        ]
    });
/** The effect / trigger of a key, with the key itself as a search word */
const KE = (id: string, group: string, label: string, scopes: ScopeType[] | 'any', script: string, params: ParamDef[] = [], extra: Extra = {}): StatementDef => E(id, group, label, scopes, script, params, { words: /^\w+/.exec(script)![0], ...extra });
const KT = (id: string, group: string, label: string, scopes: ScopeType[] | 'any', script: string, params: ParamDef[] = [], extra: Extra = {}): StatementDef => T(id, group, label, scopes, script, params, { words: /^\w+/.exec(script)![0], ...extra });

export const STATEMENTS: StatementDef[] = [
    // ------------------------------------------------------------------ effects on characters
    // (without `opinion` the modifier's own value; `years` overrides its duration, asked when changing one that has it)
    E('add.opinion', 'add', 'Opinion', CH, 'add_opinion = { target = $target$ modifier = $modifier$ [opinion = $value$] [$duration$] }', [
        num('value', tr('How much?'), [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, -10, -20, -30, -50], { signed: true, optional: tr('As the opinion says') }),
        who('target', tr('Towards whom?'), { common: ['root', 'scope:actor', 'scope:recipient', 'liege', 'primary_spouse', 'prev'] }),
        ref('modifier', tr('Which opinion?'), 'opinion_modifiers')
    ], { k: 'o', words: 'add_opinion', extra: [dur(tr('For how long?'), tr('As the opinion says'))] }),
    E('add.reverse_opinion', 'add', tr('Opinion of them (someone’s)'), CH, 'reverse_add_opinion = { target = $target$ modifier = $modifier$ [opinion = $value$] [$duration$] }', [
        num('value', tr('How much?'), [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, -10, -20, -30, -50], { signed: true, optional: tr('As the opinion says') }),
        who('target', tr('Whose opinion?')),
        ref('modifier', tr('Which opinion?'), 'opinion_modifiers')
    ], { words: 'reverse_add_opinion', extra: [dur(tr('For how long?'), tr('As the opinion says'))] }),
    E('add.trait', 'add', 'Trait', CH, 'add_trait = $trait$', [ref('trait', tr('Which trait?'), 'traits')], { k: 't', words: 'add_trait' }),
    // (`track`: which of the trait's experience tracks; the game writes it for traits with several, e.g. tourney_participant's foot / horse / bow)
    E('add.trait_xp', 'add', tr('Trait experience'), CH, 'add_trait_xp = { trait = $trait$ [track = $track$] value = $value$ }', [ref('trait', tr('Which trait?'), 'traits'), num('value', tr('How much?'), [5, 10, 20, 25, 50, 100]), TRACK], { words: 'add_trait_xp' }),
    ...resource('add_gold', 'Gold', CH, [10, 25, 50, 100, 250, 500, 1000], ['tiny_gold_value', 'minor_gold_value', 'medium_gold_value', 'major_gold_value'], ['tiny_gold_value', 'minor_gold_value', 'medium_gold_value', 'major_gold_value'], 'g', 'remove_short_term_gold'),
    ...resource('add_prestige', 'Prestige', CH, [25, 50, 100, 150, 200, 300, 500, 1000], levels('prestige', 'gain'), levels('prestige', 'loss'), 'p'),
    ...resource('add_piety', 'Piety', CH, [25, 50, 100, 150, 200, 300, 500, 1000], levels('piety', 'gain'), levels('piety', 'loss'), 'i'),
    ...resource('add_stress', 'Stress', CH, [5, 10, 15, 20, 25, 50, 100], levels('stress', 'gain'), levels('stress', 'loss'), 's'),
    ...resource('add_dread', 'Dread', CH, [5, 10, 15, 20, 25, 50], levels('dread', 'gain'), levels('dread', 'loss'), 'd'),
    ...resource('add_tyranny', 'Tyranny', CH, [5, 10, 15, 20, 25, 50], levels('tyranny', 'gain')),
    ...resource('change_influence', 'Influence', CH, [25, 50, 100, 200, 500], levels('influence', 'gain'), levels('influence', 'loss')),
    ...resource('add_legitimacy', 'Legitimacy', CH, [5, 10, 25, 50, 100], levels('legitimacy', 'gain'), levels('legitimacy', 'loss')),
    E('add.skill', 'add', tr('Skill…'), CH, 'add_$skill$_skill = $value$', [choice('skill', tr('Which skill?'), SKILLS), num('value', tr('How much?'), [1, 2, 3, 5, 10], { signed: true })], { k: 'k', words: 'add_diplomacy_skill add_martial_skill add_prowess_skill' }),
    E('remove.skill', 'remove', tr('Skill…'), CH, 'add_$skill$_skill = $value$', [choice('skill', tr('Which skill?'), SKILLS), num('value', tr('How much?'), [1, 2, 3, 5, 10], { sign: -1 })], { k: 'k' }),
    E('add.lifestyle_xp', 'add', tr('Lifestyle experience…'), CH, 'add_$lifestyle$_lifestyle_xp = $value$', [
        choice('lifestyle', tr('Which lifestyle?'), [...SKILLS.slice(0, 5), ['wanderer', 'Wanderer', 'w']]),
        num('value', tr('How much?'), [100, 250, 500, 1000], { named: ['minor_lifestyle_xp', 'medium_lifestyle_xp', 'major_lifestyle_xp'] })
    ], { k: 'x', words: 'lifestyle_xp' }),
    E('add.modifier', 'add', 'Modifier', CH, 'add_character_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', tr('Which modifier?'), 'modifiers'), { ...dur(), range: true }], { k: 'm', words: 'add_character_modifier' }),
    E('add.flag', 'add', 'Flag', CH, 'add_character_flag = { flag = $flag$ [$duration$] }', [flagName(), { ...dur(), range: true }], { k: 'f', short: 'add_character_flag = $flag$', words: 'add_character_flag' }),
    // (the game's doc, 1.20.1.2: "secret required for hook types that require it", the duration "optional (taken from hook
    // type otherwise)"; vanilla writes `secret = scope:secret` and `years = 5`, `days = default_favor_duration`)
    E('add.hook', 'add', 'Hook', CH, 'add_hook = { type = $type$ target = $target$ [secret = $secret$] [$duration$] }', [who('target', tr('On whom?')), ref('type', tr('Which hook?'), 'hook_types')], {
        k: 'h',
        words: 'add_hook',
        extra: [
            thing('secret', tr('Which secret is the hook based on? (needed by hook types that require one)'), 'secret', ['scope:secret'], { optional: tr('None (the hook type needs none)') }),
            dur(tr('For how long?'), tr('As the hook type says'))
        ]
    }),
    E('add.secret', 'add', 'Secret', CH, 'add_secret = { type = $type$ [target = $target$] }', [ref('type', tr('Which secret?'), 'secret_types'), who('target', tr('About whom?'), { optional: tr('Nobody in particular') })], { words: 'add_secret' }),
    E('add.courtier', 'add', 'Courtier', CH, 'add_courtier = $who$', [who('who', tr('Who joins the court?'), { common: ['scope:actor', 'scope:recipient', 'prev', 'root'] })], { k: 'c', words: 'add_courtier' }),
    E('add.pressed_claim', 'add', tr('Claim (pressed)'), CH, 'add_pressed_claim = $title$', [titleRef(tr('On which title?'))], { words: 'add_pressed_claim' }),
    E('add.unpressed_claim', 'add', tr('Claim (unpressed)'), CH, 'add_unpressed_claim = $title$', [titleRef(tr('On which title?'))], { words: 'add_unpressed_claim' }),
    E('add.nickname', 'add', 'Nickname', CH, 'give_nickname = $nick$', [ref('nick', tr('Which nickname?'), 'nicknames')], { k: 'n', words: 'give_nickname' }),
    E('add.perk', 'add', 'Perk', CH, 'add_perk = $perk$', [ref('perk', tr('Which perk?'), 'lifestyle_perks')], { words: 'add_perk' }),
    E('add.law', 'add', tr('Realm law'), CH, 'add_realm_law = $law$', [ref('law', tr('Which law?'), 'laws')], { words: 'add_realm_law' }),
    // (written as stress_and_fulfillment_impact where the game uses that: RENAMED_KEYS)
    E('add.stress_if_trait', 'add', tr('Stress if they have a trait'), CH, 'stress_impact = { [base = $base$] $trait$ = $value$ }', [
        ref('trait', tr('Which trait?'), 'traits'),
        num('value', tr('How much stress?'), [10, 20, 30, 50, -10, -20], { named: ['minor_stress_impact_gain', 'medium_stress_impact_gain', 'major_stress_impact_gain', 'minor_stress_impact_loss', 'medium_stress_impact_loss'] })
    ], { words: 'stress_impact stress_and_fulfillment_impact', extra: [num('base', tr('How much stress always (added to the trait’s amount)?'), [5, 10, 20, -5, -10], { optional: tr('None'), named: ['minor_stress_impact_gain', 'medium_stress_impact_gain', 'major_stress_impact_gain', 'minor_stress_impact_loss', 'medium_stress_impact_loss'] })] }),

    E('remove.trait', 'remove', 'Trait', CH, 'remove_trait = $trait$', [ref('trait', tr('Which trait?'), 'traits')], { k: 't', words: 'remove_trait' }),
    E('remove.opinion', 'remove', 'Opinion', CH, 'remove_opinion = { target = $target$ modifier = $modifier$ }', [who('target', tr('Towards whom?')), ref('modifier', tr('Which opinion?'), 'opinion_modifiers')], { k: 'o', words: 'remove_opinion' }),
    E('remove.modifier', 'remove', 'Modifier', CH, 'remove_character_modifier = $modifier$', [ref('modifier', tr('Which modifier?'), 'modifiers')], { k: 'm', words: 'remove_character_modifier' }),
    E('remove.flag', 'remove', 'Flag', CH, 'remove_character_flag = $flag$', [flagName()], { k: 'f', words: 'remove_character_flag' }),
    E('remove.hook', 'remove', 'Hook', CH, 'remove_hook = { target = $target$ }', [who('target', tr('On whom?'))], { k: 'h', words: 'remove_hook' }),
    E('remove.claim', 'remove', 'Claim', CH, 'remove_claim = $title$', [titleRef(tr('On which title?'))], { words: 'remove_claim' }),
    E('remove.nickname', 'remove', 'Nickname', CH, 'remove_nickname = yes', [], { k: 'n', words: 'remove_nickname' }),
    E('remove.relation', 'remove', tr('Relation…'), CH, 'remove_relation_$relation$ = $target$', [choice('relation', tr('Which relation?'), RELATIONS), who('target', tr('With whom?'))], { k: 'l', words: 'remove_relation' }),

    E('set.relation', 'set', tr('Relation…'), CH, 'set_relation_$relation$ = { target = $target$ [reason = $reason$] }', [
        choice('relation', tr('Which relation?'), RELATIONS),
        who('target', tr('With whom?')),
        // (a localization key: "friend_moved_estate"; the game's for this relation are suggested. The game's doc, 1.20.1.2:
        // "In addition to `reason_key` you also need to define a `reason_key_corresponding`", the reason on the target's side)
        { name: 'reason', kind: 'text', label: tr('Why? (a localization key; the game also needs one named <key>_corresponding)'), optional: tr('No reason given'), usage: { field: 'reason' } }
    ], { k: 'r', short: 'set_relation_$relation$ = $target$', words: tr('set_relation friend rival lover reason') }),
    E('set.faith', 'set', 'Faith', CH, 'set_character_faith = $faith$', [faithRef()], { k: 'f', words: 'set_character_faith convert' }),
    E('set.culture', 'set', 'Culture', CH, 'set_culture = $culture$', [cultureRef()], { k: 'c', words: 'set_culture' }),
    E('set.sexuality', 'set', 'Sexuality', CH, 'set_sexuality = $s$', [choice('s', tr('Which sexuality?'), [['heterosexual', 'Heterosexual', 'h'], ['homosexual', 'Homosexual', 'o'], ['bisexual', 'Bisexual', 'b'], ['asexual', 'Asexual', 'a']])], { words: 'set_sexuality' }),
    E('set.focus', 'set', 'Focus', CH, 'set_focus = $focus$', [ref('focus', tr('Which focus?'), 'focuses')], { words: 'set_focus' }),
    E('set.designated_heir', 'set', tr('Designated heir'), CH, 'set_designated_heir = $who$', [who('who', tr('Which of their children?'), { common: ['scope:recipient', 'scope:secondary_recipient'] })], {
        k: 'h',
        words: 'set_designated_heir',
        // (the game's doc, 1.20.1.2: "Sets one the given direct child character as designated heir"; vanilla's values:
        // scope:recipient 4, scope:secondary_recipient 3, then saved children; not the liege or spouse `who` offers first)
        help: tr('The heir must be a direct child of the character.')
    }),
    E('set.employer', 'set', tr('Employer (move to a court)'), CH, 'set_employer = $who$', [who('who', tr('Whose court?'), { common: ['root', 'scope:actor', 'liege', 'scope:recipient'] })], { k: 'e', words: 'set_employer' }),
    E('set.government', 'set', 'Government', CH, 'change_government = $gov$', [ref('gov', tr('Which government?'), 'governments')], { k: 'g', words: 'change_government' }),

    E('do.death', 'do', 'Die', CH, 'death = { death_reason = $reason$ [killer = $killer$] }', [ref('reason', 'How?', 'deathreasons'), who('killer', tr('Killed by?'), { optional: 'Nobody' })], { k: 'd', words: tr('death kill') }),
    E('do.imprison', 'do', tr('Imprison someone'), CH, 'imprison = { target = $target$ type = $type$ }', [who('target', 'Whom?', { common: ['scope:recipient', 'scope:target', 'scope:actor', 'root'] }), choice('type', 'Where?', [['dungeon', 'Dungeon', 'd'], ['house_arrest', tr('House arrest'), 'h']])], {
        k: 'i',
        words: tr('imprison prison')
    }),
    E('do.release', 'do', tr('Release from prison'), CH, 'release_from_prison = yes', [], { k: 'r', words: 'release_from_prison' }),
    E('do.marry', 'do', 'Marry', CH, 'marry = $who$', [who('who', 'Whom?', { common: ['scope:recipient', 'scope:actor', 'scope:target', 'root'] })], { k: 'm', words: 'marry' }),
    // pregnancy: run on the mother (docs/picker.md, "Pregnancy")
    E(
        'preg.make',
        'pregnancy',
        tr('Pregnant — for sure'),
        CH,
        'make_pregnant = { father = $father$ [number_of_children = $children$] }',
        [who('father', tr('Who is the father?'), { common: ['root', 'scope:actor', 'scope:recipient', 'primary_spouse'] }), num('children', tr('How many children?'), [2, 3], { optional: 'One' })],
        {
            k: 'p',
            words: tr('make_pregnant pregnant pregnancy twins father child'),
            help: tr('make_pregnant: she is pregnant now, by the father given — no chance involved, nothing else happens (no stress, no adultery or lover consequences). Twins and more with “How many children”. Run it on the mother.')
        }
    ),
    E(
        'preg.sex',
        'pregnancy',
        tr('Sleep with someone — pregnant by chance'),
        CH,
        'had_sex_with_effect = { CHARACTER = $who$ PREGNANCY_CHANCE = $chance$ }',
        [
            who('who', tr('With whom?'), { common: ['root', 'scope:actor', 'scope:recipient', 'primary_spouse'] }),
            choice('chance', tr('How likely is a pregnancy?'), [
                ['pregnancy_chance', tr('The usual chance (fertility, age, traits)'), 'u'],
                ['seduce_pregnancy_chance', tr('A seduction’s chance'), 's'],
                ['50', tr('Half the time (50%)'), 'h'],
                ['100', tr('Surely (100%)'), 'c']
            ])
        ],
        {
            k: 's',
            words: tr('had_sex_with_effect sex pregnant pregnancy lover'),
            help: tr('had_sex_with_effect: the game’s way — they sleep together with all it brings: stress loss for the lustful, the adultery and lover bookkeeping, and a pregnancy only by chance (when she can have his child). Use it for a love scene; use “Pregnant — for sure” when the story needs the child.')
        }
    ),
    E('preg.bastard', 'pregnancy', tr('The coming child: a known bastard'), CH, 'set_known_bastard_on_pregnancy = yes', [], {
        k: 'b',
        words: 'set_known_bastard_on_pregnancy bastard pregnancy',
        help: tr('set_known_bastard_on_pregnancy: her current pregnancy’s child will be born a known bastard (everyone knows who the real father is). Only for a pregnancy that exists already.')
    }),
    E('preg.end', 'pregnancy', tr('End the pregnancy'), CH, 'end_pregnancy = yes', [], {
        k: 'e',
        words: 'end_pregnancy miscarriage abortion pregnancy',
        help: tr('end_pregnancy: her pregnancy ends without a birth (a miscarriage or an abortion — the events around it say which).')
    }),
    E('do.divorce', 'do', 'Divorce', CH, 'divorce = $who$', [who('who', 'Whom?', { common: ['primary_spouse', 'scope:recipient', 'scope:actor'] })], { words: 'divorce' }),
    E('do.scheme', 'do', tr('Start a scheme'), CH, 'start_scheme = { type = $type$ target_character = $target$ }', [ref('type', tr('Which scheme?'), 'schemes/scheme_types'), who('target', tr('Against whom?'), { common: ['root', 'scope:target', 'scope:recipient', 'scope:actor'] })], { k: 's', words: 'start_scheme' }),
    E('do.event', 'do', tr('Trigger an event'), 'any', 'trigger_event = { id = $event$ [$delay$] }', [ref('event', tr('Which event?'), 'events'), { ...dur('When?', tr('Right away')), name: 'delay', range: true, presets: [[1, 'days'], [3, 'days'], [7, 'days'], [14, 'days'], [30, 'days'], [3, 'months'], [6, 'months'], [1, 'years']] }], {
        k: 'e',
        short: 'trigger_event = $event$',
        words: 'trigger_event'
    }),
    E('later', 'do', tr('Event later'), 'any', 'trigger_event = { id = $event$ $delay$ }', [ref('event', tr('Which event?'), 'events'), {
        ...dur('When?'),
        optional: undefined,
        name: 'delay',
        range: true,
        presets: [[1, 'days'], [3, 'days'], [7, 'days'], [14, 'days'], [30, 'days'], [3, 'months'], [6, 'months'], [1, 'years'], [5, 'years']]
    }], { hidden: true }),
    E('do.pay', 'do', tr('Pay gold to someone'), CH, 'pay_short_term_gold = { target = $target$ gold = $value$ }', [num('value', tr('How much?'), [10, 25, 50, 100, 250, 500], { named: ['minor_gold_value', 'medium_gold_value', 'major_gold_value'] }), who('target', tr('To whom?'))], { k: 'p', words: 'pay_short_term_gold' }),
    E('do.get_title', 'do', tr('Get a title'), CH, 'get_title = $title$', [titleRef()], { k: 'g', words: 'get_title' }),
    // A title changes hands the way the game's script does it (1.20.1.2: 782 creates, 704 change_title_holder, 775 resolves;
    // `type` and `save_scope_as` in every create, `add_claim_on_loss` in 647 (no 436, yes 211); `holder` and `change` in 703
    // of the 704 change_title_holder, `take_baronies` in 108 (yes 69, no 39), `government_base` in 3, all saved scopes:
    // an extra, asked when changing a written one). The change types in the order of their use there, granted first; the
    // change's name is `change` (563 of the 782) unless the place already has one of that name (freeScopeName). The
    // holder and the government base are written inside the title's block, so a value relative to the subject goes
    // through `prev` (`switched`).
    E(
        'do.give_title',
        'do',
        tr('Give a title to someone'),
        CH,
        'create_title_and_vassal_change = { type = $type$ save_scope_as = $change$ [add_claim_on_loss = $claim$] } $title$ = { change_title_holder = { holder = $holder$ change = scope:$change$ [take_baronies = $baronies$] [government_base = $gov$] } } resolve_title_and_vassal_change = scope:$change$',
        [
            titleRef(),
            who('holder', tr('Who gets it?'), { common: ['root', 'scope:actor', 'scope:recipient', 'scope:target'], self: true, switched: true }),
            choice('type', tr('What kind of change?'), [
                ['granted', tr('Granted'), 'g'],
                ['created', tr('Created'), 'c'],
                ['conquest', tr('Conquest'), 'q'],
                ['independency', tr('Independence'), 'i'],
                ['swear_fealty', tr('Swore fealty'), 's'],
                ['revoked', tr('Revoked'), 'r'],
                ['usurped', tr('Usurped'), 'u'],
                ['returned', tr('Returned'), 't'],
                ['appointment', tr('Appointment'), 'a'],
                ['conquest_populist', tr('Conquest (populist)')],
                ['conquest_claim', tr('Conquest (claim)')],
                ['conquest_holy_war', tr('Conquest (holy war)')],
                ['leased_out', tr('Leased out'), 'l'],
                ['faction_demand', tr('Faction demand'), 'f'],
                ['stepped_down', tr('Stepped down'), 'd'],
                ['migration', tr('Migration'), 'm']
            ]),
            { ...choice('claim', tr('Does the one who loses it keep a claim?'), [['no', tr('No claim'), 'n'], ['yes', tr('Keeps a claim'), 'y']]), optional: tr('Not written (the game’s default)') },
            // (take_baronies, the game's own doc in its exe: "if set, will cause baronies to be taken (rather than
            // vassalized) as well if this title is a county"; `no` is the default. It is not about the old holder's own
            // baronies there: in game they went to the new holder with `no` too, round 13's second in-game test)
            { ...choice('baronies', tr('A county: the other baronies in it?'), [['yes', tr('Take them too'), 'y'], ['no', tr('Their holders become vassals'), 'n']]), optional: tr('Not written (the game’s default: their holders become vassals)') }
        ],
        {
            // (a key of its own: assigned from the label it would take `a`, Start a story's key)
            k: 'h',
            words: 'change_title_holder create_title_and_vassal_change resolve_title_and_vassal_change ' + tr('give grant title holder'),
            saves: { name: 'change', base: 'change' },
            // (government_base, the game's doc, 1.20.1.2: "Required when holder is unlanded and the batch type is not
            // appointment, confederation, election, lease_revoked, migration, revoked, or stepped_down. Landed character
            // whose government the new holder copies. If omitted, defaults to holder.")
            extra: [who('gov', tr('Whose government does an unlanded new holder copy?'), { common: ['scope:actor', 'scope:recipient', 'root'], switched: true, optional: tr('Not written (the game’s default: the holder)') })],
            help: tr('Written as the game does it: a title change of the chosen kind is created, the title goes to the new holder, then the change is resolved. An unlanded new holder needs a landed character whose government they copy (government_base), unless the kind is appointment, confederation, election, lease_revoked, migration, revoked or stepped_down; left out, it is the holder.')
        }
    ),
    E('do.pool', 'do', tr('Move to the pool'), CH, 'move_to_pool = yes', [], { words: 'move_to_pool' }),
    E('do.save_scope', 'do', tr('Save as a scope (for later)'), 'any', 'save_scope_as = $name$', [{ name: 'name', kind: 'text', label: tr('Saved as?'), usage: true }], { words: 'save_scope_as' }),
    E('do.visit', 'do', tr('Visit a court'), CH, 'visit_court_of = $who$', [who('who', tr('Whose court?'))], { k: 'v', words: 'visit_court_of' }),

    // ------------------------------------------------------------------ variables (every scope)
    E('set.variable', 'set', 'Variable', 'any', 'set_variable = { name = $name$ value = $value$ }', [varName(), num('value', tr('Which value?'), [1, 0, 5, 10, 100], { named: ['yes'] })], { k: 'v', words: 'set_variable' }),
    E('add.variable', 'add', tr('Variable (change)'), 'any', 'change_variable = { name = $name$ add = $value$ }', [varName(), num('value', tr('How much?'), [1, 2, 5, 10, -1], { signed: true })], { k: 'v', words: 'change_variable' }),
    E('remove.variable', 'remove', 'Variable', 'any', 'remove_variable = $name$', [varName()], { k: 'v', words: 'remove_variable' }),

    // ------------------------------------------------------------------ effects on titles, provinces, faiths, cultures, dynasties, houses, artifacts, wars
    // (the game writes it in the title's scope between `create_title_and_vassal_change = { type = granted save_scope_as = change }`
    // and `resolve_title_and_vassal_change = scope:change` in the character's scope, with `change = scope:change` inside: 703 of
    // the 704 uses in 1.20.1.2. One statement in the title's scope cannot be that, so it is read and changed where written;
    // it is built as the whole triple from the character's scope: `do.give_title` above)
    E('title.holder', 'set', 'Holder', ['landed_title'], 'change_title_holder = { holder = $holder$ }', [who('holder', tr('Who gets it?'), { common: ['root', 'scope:actor', 'scope:recipient', 'scope:target'] })], { k: 'h', words: 'change_title_holder give title', noBuild: true }),
    E('title.de_jure', 'set', tr('De jure liege title'), ['landed_title'], 'set_de_jure_liege_title = $title$', [titleRef(tr('Under which title?'))], { k: 'd', words: 'set_de_jure_liege_title' }),
    E('title.add_modifier', 'add', tr('County modifier'), ['landed_title'], 'add_county_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', tr('Which modifier?'), 'modifiers'), dur()], { k: 'm', words: 'add_county_modifier' }),
    E('title.remove_modifier', 'remove', tr('County modifier'), ['landed_title'], 'remove_county_modifier = $modifier$', [ref('modifier', tr('Which modifier?'), 'modifiers')], { k: 'm', words: 'remove_county_modifier' }),
    ...resource('change_development_level', 'Development', ['landed_title'], [1, 2, 3, 5, 10]),
    ...resource('change_county_control', tr('County control'), ['landed_title'], [5, 10, 20, 25, 50, 100], ['medium_county_control_gain'], ['minor_county_control_loss', 'medium_county_control_loss']),
    E('title.faith', 'set', tr('Faith (county)'), ['landed_title'], 'set_county_faith = $faith$', [faithRef()], { k: 'f', words: 'set_county_faith' }),
    E('title.culture', 'set', tr('Culture (county)'), ['landed_title'], 'set_county_culture = $culture$', [cultureRef()], { k: 'c', words: 'set_county_culture' }),
    E('title.law', 'add', tr('Title law'), ['landed_title'], 'add_title_law = $law$', [ref('law', tr('Which law?'), 'laws')], { k: 'l', words: 'add_title_law' }),

    E('province.add_modifier', 'add', tr('Province modifier'), ['province'], 'add_province_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', tr('Which modifier?'), 'modifiers'), dur()], { k: 'm', words: 'add_province_modifier' }),
    E('province.remove_modifier', 'remove', tr('Province modifier'), ['province'], 'remove_province_modifier = $modifier$', [ref('modifier', tr('Which modifier?'), 'modifiers')], { k: 'm', words: 'remove_province_modifier' }),
    E('province.add_building', 'add', 'Building', ['province'], 'add_building = $building$', [ref('building', tr('Which building?'), 'buildings')], { k: 'b', words: 'add_building' }),
    E('province.remove_building', 'remove', 'Building', ['province'], 'remove_building = $building$', [ref('building', tr('Which building?'), 'buildings')], { k: 'b', words: 'remove_building' }),
    E('province.holding', 'set', tr('Holding type'), ['province'], 'set_holding_type = $holding$', [ref('holding', tr('Which holding type?'), 'holdings')], { k: 'h', words: 'set_holding_type' }),

    E('faith.add_doctrine', 'add', 'Doctrine', ['faith'], 'add_doctrine = $doctrine$', [ref('doctrine', tr('Which doctrine?'), 'religion/doctrine_types')], { k: 'd', words: 'add_doctrine' }),
    E('faith.remove_doctrine', 'remove', 'Doctrine', ['faith'], 'remove_doctrine = $doctrine$', [ref('doctrine', tr('Which doctrine?'), 'religion/doctrine_types')], { k: 'd', words: 'remove_doctrine' }),
    E('culture.tradition', 'add', 'Tradition', ['culture'], 'add_culture_tradition = $tradition$', [ref('tradition', tr('Which tradition?'), 'culture/traditions')], { k: 't', words: 'add_culture_tradition' }),
    E('culture.innovation', 'add', 'Innovation', ['culture'], 'add_innovation = $innovation$', [ref('innovation', tr('Which innovation?'), 'culture/innovations')], { k: 'i', words: 'add_innovation' }),
    ...resource('add_dynasty_prestige', tr('Dynasty prestige'), ['dynasty'], [50, 100, 200, 500, 1000], levels('dynasty_prestige', 'gain', ['miniscule', 'minor', 'medium'])),
    E('dynasty.modifier', 'add', tr('Dynasty modifier'), ['dynasty'], 'add_dynasty_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', tr('Which modifier?'), 'modifiers'), dur()], { k: 'm', words: 'add_dynasty_modifier' }),
    E('dynasty.perk', 'add', tr('Legacy (dynasty perk)'), ['dynasty'], 'add_dynasty_perk = $perk$', [ref('perk', tr('Which legacy?'), 'dynasty_perks')], { k: 'l', words: 'add_dynasty_perk' }),
    E('house.modifier', 'add', tr('House modifier'), ['dynasty_house'], 'add_house_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', tr('Which modifier?'), 'modifiers'), dur()], { k: 'm', words: 'add_house_modifier' }),
    ...resource('add_durability', 'Durability', ['artifact'], [5, 10, 20, 50]),
    E('artifact.owner', 'set', 'Owner', ['artifact'], 'set_owner = $who$', [who('who', tr('Who owns it?'))], { k: 'o', words: 'set_owner' }),
    E('artifact.rarity', 'set', 'Rarity', ['artifact'], 'set_artifact_rarity = $rarity$', [choice('rarity', tr('Which rarity?'), [['common', 'Common', 'c'], ['masterwork', 'Masterwork', 'm'], ['famed', 'Famed', 'f'], ['illustrious', 'Illustrious', 'i']])], { k: 'r', words: 'set_artifact_rarity' }),
    E('artifact.destroy', 'do', tr('Destroy it'), ['artifact'], 'destroy_artifact = this', [], { k: 'd', words: 'destroy_artifact' }),
    E('scheme.end', 'do', tr('End the scheme'), ['scheme'], 'end_scheme = yes', [], { k: 'e', words: 'end_scheme' }),
    E('secret.reveal', 'do', tr('Reveal to someone'), ['secret'], 'reveal_to = $who$', [who('who', tr('To whom?'))], { k: 'r', words: 'reveal_to' }),
    E('secret.expose', 'do', tr('Expose it'), ['secret'], 'expose_secret = $who$', [who('who', tr('Exposed by?'))], { k: 'e', words: 'expose_secret' }),
    E('secret.remove', 'do', tr('Remove it'), ['secret'], 'remove_secret = yes', [], { k: 'd', words: 'remove_secret' }),
    E('artifact.modifier', 'add', tr('Artifact modifier'), ['artifact'], 'add_artifact_modifier = $modifier$', [ref('modifier', tr('Which modifier?'), 'modifiers')], { k: 'm', words: 'add_artifact_modifier' }),
    E('war.end', 'do', tr('End the war'), ['war'], 'end_war = $how$', [choice('how', 'How?', [['white_peace', tr('White peace'), 'w'], ['attacker', tr('Attacker wins'), 'a'], ['defender', tr('Defender wins'), 'd'], ['invalidated', 'Invalidated', 'i']])], { k: 'e', words: 'end_war' }),

    // ------------------------------------------------------------------ rites and tenets (1.20: a faith's doctrines, parameters and tenets sit in its rites)
    // (a character, a county or a province reaches its rite by `rite = { … }`, a faith its main one by `main_rite = { … }`; counts: the walk of scripts/scope-check.ts by scope type, 1.20.1.2)
    KT('rite.doctrine', 'main', tr('Doctrine'), ['rite'], 'rite_has_doctrine = $doctrine$', [ref('doctrine', tr('Which doctrine?'), 'religion/doctrine_types')]),
    KT('rite.parameter', 'main', tr('Doctrine parameter'), ['rite'], 'rite_has_parameter = $parameter$', [word('parameter', tr('Which parameter?'))]),
    KT('rite.tenet', 'main', tr('Tenet'), ['rite'], 'rite_has_tenet = $tenet$', [tenetRef()]),
    KT('rite.tenet_status', 'main', tr('Tenet status'), ['rite'], 'has_tenet_status = { tenet = $tenet$ status = $status$ }', [
        tenetRef(),
        choice('status', tr('Which status?'), [['core', tr('Core'), 'c'], ['permitted', tr('Permitted'), 'p'], ['prohibited', tr('Prohibited'), 'r'], ['known', tr('Known'), 'k'], ['unknown', tr('Unknown'), 'u']])
    ]),
    KT('rite.virtue', 'more', tr('Virtue'), ['rite'], 'trait_is_virtue_rite = $trait$', [ref('trait', tr('Which trait?'), 'traits')]),
    KT('rite.sin', 'more', tr('Sin'), ['rite'], 'trait_is_sin_rite = $trait$', [ref('trait', tr('Which trait?'), 'traits')]),
    KT('rite.enabled', 'more', tr('Enabled'), ['rite'], 'is_rite_enabled = $on$', [yesno('on', tr('Is it enabled?'))]),
    // (how hostile the rite is to another: 0 fully accepted, 1 astray, 2 hostile, 3 evil: the script values of common/script_values/02_religion_values.txt; the faith's own counterpart is `faith.hostility`)
    KT('rite.hostility', 'main', tr('Hostility to another rite'), ['rite'], 'rite_hostility_level = { target = $target$ value $cmp$ $value$ }', [
        thing('target', tr('Towards which rite?'), 'rite', ['scope:actor.rite', 'scope:recipient.rite', 'root.rite']),
        cmp(),
        num('value', tr('How hostile?'), [], { named: HOSTILITY_LEVELS })
    ]),
    KT('rite.ruling_gender', 'more', tr('Of the ruling gender'), ['rite'], 'rite_has_dominant_ruling_gender = $who$', [who('who', tr('Who?'), { common: ['prev', 'root', 'scope:actor'] })], { help: tr('The character is of the gender that rules in this rite.') }),
    KT('rite.clergy_gender', 'more', tr('Of a gender allowed as clergy'), ['rite'], 'rite_has_allowed_gender_for_clergy = $who$', [who('who', tr('Who?'), { common: ['prev', 'root', 'scope:actor'] })], { help: tr('The character is of a gender the rite lets serve as clergy.') }),
    KT('rite.choose_doctrine', 'more', tr('Can pick a doctrine'), ['rite'], 'rite_can_choose_doctrine = $doctrine$', [ref('doctrine', tr('Which doctrine?'), 'religion/doctrine_types', { prefix: 'doctrine:' })]),
    KT('rite.convertible', 'more', tr('Convertible to'), ['rite'], 'can_convert_to_rite = $on$', [yesno('on', tr('Can characters convert to it?'))]),
    KE('rite.set_doctrine', 'set', tr('Doctrine'), ['rite'], 'change_rite_doctrine = $doctrine$', [ref('doctrine', tr('Which doctrine?'), 'religion/doctrine_types')]),
    KE('rite.remove_doctrine', 'remove', tr('Doctrine'), ['rite'], 'remove_rite_doctrine = $doctrine$', [ref('doctrine', tr('Which doctrine?'), 'religion/doctrine_types')]),
    KE('rite.add_tenet', 'add', tr('Tenet'), ['rite'], 'add_rite_tenet = $tenet$', [tenetRef()]),
    KE('rite.remove_tenet', 'remove', tr('Tenet'), ['rite'], 'remove_rite_tenet = $tenet$', [tenetRef()]),
    KE('rite.set_enabled', 'set', tr('Enabled'), ['rite'], 'set_rite_enabled = $on$', [yesno('on', tr('Enabled?'))]),
    KE('rite.set_convertible', 'set', tr('Convertible to'), ['rite'], 'set_can_convert_to_rite = $on$', [yesno('on', tr('Can characters convert to it?'))]),
    KT('faith.tenet', 'main', tr('Tenet'), ['faith'], 'has_tenet = $tenet$', [tenetRef()]),
    KT('faith.hostility', 'main', tr('Hostility to another faith'), ['faith'], 'faith_hostility_level = { target = $target$ value $cmp$ $value$ }', [
        thing('target', tr('Towards which faith?'), 'faith', ['scope:actor.faith', 'scope:recipient.faith', 'scope:host.faith', 'root.faith']),
        cmp(),
        num('value', tr('How hostile?'), [], { named: HOSTILITY_LEVELS })
    ]),
    KE('faith.add_tenet', 'add', tr('Tenet'), ['faith'], 'add_tenet = $tenet$', [tenetRef()]),
    KE('faith.remove_tenet', 'remove', tr('Tenet'), ['faith'], 'remove_tenet = $tenet$', [tenetRef()]),
    KE('faith.tenet_status', 'set', tr('Tenet status'), ['faith'], 'set_tenet_status = { tenet = $tenet$ status = $status$ }', [
        tenetRef(),
        choice('status', tr('Which status?'), [['core', tr('Core'), 'c'], ['permitted', tr('Permitted'), 'p'], ['prohibited', tr('Prohibited'), 'r'], ['known', tr('Known'), 'k'], ['unknown', tr('Unknown'), 'u']])
    ]),
    KE('set.rite', 'set', tr('Rite'), CH, 'set_character_rite = $rite$', [riteRef()], { words: 'set_character_rite convert' }),
    KE('set.rite_conversion', 'set', tr('Rite (with conversion)'), CH, 'set_character_rite_with_conversion = $rite$', [riteRef()], { words: 'set_character_rite_with_conversion convert' }),
    KE('set.faith_conversion', 'set', tr('Faith (with conversion)'), CH, 'set_character_faith_with_conversion = $faith$', [faithRef()], { words: 'set_character_faith_with_conversion convert' }),
    KE('set.personal_tenet', 'set', tr('Personal tenet'), CH, 'set_personal_tenet = $tenet$', [tenetRef()]),
    KE('add.known_tenet', 'add', tr('Known tenet'), CH, 'add_known_tenet = $tenet$', [tenetRef()]),
    KT('personal_tenet', 'more', tr('Personal tenet'), CH, 'has_personal_tenet = $tenet$', [tenetRef()]),
    KT('knows_tenet', 'more', tr('Knows a tenet'), CH, 'knows_tenet = $tenet$', [tenetRef()]),
    KT('rite', 'main', tr('Rite'), ['character', 'landed_title', 'province'], 'rite = $rite$', [riteRef()]),
    KE('title.rite', 'set', tr('Rite (county)'), ['landed_title'], 'set_county_rite = $rite$', [riteRef()], { words: 'set_county_rite' }),
    KE('title.state_rite', 'set', tr('State rite'), ['landed_title'], 'set_state_rite = $rite$', [riteRef()]),
    KE('order.tenet', 'set', tr('Order tenet'), ['holy_order'], 'set_order_tenet = $tenet$', [tenetRef('tenet:')]),
    KT('order.leased', 'main', tr('Leased titles'), ['holy_order'], 'num_leased_titles $cmp$ $value$', [cmp(), num('value', tr('How many?'), [1, 5, 10, 12, 20], { named: ['holy_order_barony_number_soft_threshold'] })]),

    // ------------------------------------------------------------------ the scope types of their own: activities, journeys, struggles, situations, factions, domiciles, stories … (docs/picker.md, "Scope types")
    // activities
    KE('activity.log', 'do', tr('Add a log entry'), ['activity'], 'add_activity_log_entry = { key = $key$ character = $character$ [score = $score$] }', [
        word('key', tr('Which log entry?'), { field: 'key' }),
        who('character', tr('For whom?'), { common: ['root', 'scope:host'] }),
        num('score', tr('How many points?'), [5, 10, 20, 25, 50, 100], { optional: tr('No points') })
    ]),
    KE('activity.next_phase', 'do', tr('Move to the next phase after…'), ['activity'], 'progress_activity_phase_after = { $duration$ }', [span(tr('After how long?'))]),
    KE('activity.skip_phase', 'do', tr('Skip the current phase'), ['activity'], 'skip_activity_phase = yes'),
    KE('activity.add_guest', 'add', tr('Guest to a group'), ['activity'], 'add_to_guest_subset = { name = $name$ target = $target$ }', [
        word('name', tr('Which group of guests?'), { field: 'name' }),
        who('target', tr('Who joins?'), { common: ['root', 'prev', 'scope:host'] })
    ]),
    KE('activity.remove_guest', 'remove', tr('Guest from a group'), ['activity'], 'remove_from_guest_subset = { name = $name$ target = $target$ }', [
        word('name', tr('Which group of guests?'), { field: 'name' }),
        who('target', tr('Who leaves?'), { common: ['root', 'prev', 'scope:host'] })
    ]),
    KT('activity.type', 'main', tr('Kind of activity'), ['activity'], 'has_activity_type = $type$', [ref('type', tr('Which activity?'), 'activities/activity_types')]),
    KT('activity.option', 'main', tr('Chosen option'), ['activity'], 'has_activity_option = { category = $category$ option = $option$ }', [
        word('category', tr('Which choice?'), { field: 'category' }),
        word('option', tr('Which option?'), { field: 'option' })
    ]),
    KT('activity.phase', 'main', tr('Current phase'), ['activity'], 'has_current_phase = $phase$', [word('phase', tr('Which phase?'))]),
    KT('activity.phase_active', 'main', tr('Phase is running'), ['activity'], 'is_current_phase_active = $on$', [yesno('on', tr('Is the phase running?'))]),
    KT('activity.locale', 'more', tr('Locale'), ['activity'], 'has_active_locale = $locale$', [ref('locale', tr('Which locale?'), 'activities/activity_locales')]),
    KT('activity.phases', 'more', tr('Number of phases'), ['activity'], 'num_phases $cmp$ $value$', [cmp(), num('value', tr('How many?'), [2, 3, 4, 5, 6])]),
    KT('guest_group', 'more', tr('In a group of guests'), CH, 'is_in_guest_subset = { name = $name$ }', [word('name', tr('Which group of guests?'), { field: 'name' })]),
    KT('activity_intent', 'more', tr('Activity intent'), CH, 'has_activity_intent = $intent$', [ref('intent', tr('Which intent?'), 'activities/intents')]),
    KT('in_activity', 'more', tr('Takes part in an activity'), CH, 'is_participant_in_activity = $activity$', [thing('activity', tr('In which activity?'), 'activity', ['scope:activity', 'involved_activity'])]),
    KE('do.intent_done', 'do', tr('Complete the activity intent'), CH, 'complete_activity_intent = yes'),
    // journeys
    KE('travel.delay', 'do', tr('Delay the journey'), ['travel_plan'], 'delay_travel_plan = { $duration$ }', [span(tr('By how long?'))]),
    KE('travel.progress', 'do', tr('Advance towards the next stop'), ['travel_plan'], 'add_destination_progress = { $duration$ }', [span(tr('By how long?'))]),
    KE('travel.pause', 'do', tr('Pause the journey'), ['travel_plan'], 'pause_travel_plan = yes'),
    KE('travel.resume', 'do', tr('Resume the journey'), ['travel_plan'], 'resume_travel_plan = yes'),
    KE('travel.cancel', 'do', tr('Cancel the journey'), ['travel_plan'], 'cancel_travel_plan = yes'),
    KE('travel.abort', 'do', tr('Abort the journey'), ['travel_plan'], 'abort_travel_plan = yes'),
    KE('travel.companion', 'add', tr('Companion'), ['travel_plan'], 'add_companion = $who$', [who('who', tr('Who joins the entourage?'), { common: ['scope:companion', 'root', 'prev'] })]),
    KE('travel.modifier', 'add', tr('Journey modifier'), ['travel_plan'], 'add_travel_plan_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', tr('Which modifier?'), 'modifiers'), dur()]),
    KE('travel.leader', 'set', tr('Travel leader'), ['travel_plan'], 'set_travel_leader = $who$', [who('who', tr('Who leads?'))]),
    KT('travel.paused', 'main', tr('Paused'), ['travel_plan'], 'is_paused = $on$', [yesno('on', tr('Is it paused?'))]),
    KT('travel.stop_progress', 'main', tr('Progress to the next stop'), ['travel_plan'], 'next_destination_progress $cmp$ $value$', [cmp(), num('value', tr('How far? (0.5 = halfway)'), [0.2, 0.5, 0.75, 0.9])]),
    KT('travel.entourage', 'main', tr('Entourage size'), ['travel_plan'], 'num_entourage_characters $cmp$ $value$', [cmp(), num('value', tr('How many?'), [1, 2, 3, 5, 10])]),
    KT('travel.can_cancel', 'more', tr('Can be cancelled'), ['travel_plan'], 'can_cancel = $on$', [yesno('on', tr('Can it be cancelled?'))]),
    KT('travel.with_domicile', 'more', tr('Travels with a domicile'), ['travel_plan'], 'is_travel_with_domicile = $on$', [yesno('on', tr('With a domicile?'))]),
    KT('travel.has_modifier', 'more', tr('Journey modifier'), ['travel_plan'], 'has_travel_plan_modifier = $modifier$', [ref('modifier', tr('Which modifier?'), 'modifiers')]),
    KT('travel.option', 'more', tr('Travel option'), ['travel_plan'], 'has_travel_option = $option$', [ref('option', tr('Which option?'), 'travel/travel_options')]),
    // struggles
    KE('struggle.catalyst', 'do', tr('Activate a catalyst'), ['struggle'], 'activate_struggle_catalyst = { catalyst = $catalyst$ character = $character$ }', [
        ref('catalyst', tr('Which catalyst?'), 'struggle/catalysts'),
        who('character', tr('Caused by whom?'), { common: ['root', 'scope:actor', 'scope:host'] })
    ]),
    // (the game writes the catalyst and the phase bare as well (11 of 162 and 5 of 11 uses): read and changed where written, built in the block form)
    KE('struggle.catalyst_bare', 'do', tr('Activate a catalyst'), ['struggle'], 'activate_struggle_catalyst = $catalyst$', [ref('catalyst', tr('Which catalyst?'), 'struggle/catalysts')], { noBuild: true }),
    KE('struggle.phase', 'set', tr('Phase'), ['struggle'], 'change_struggle_phase = { struggle_phase = $phase$ }', [word('phase', tr('Which phase?'), { field: 'struggle_phase' })]),
    KE('struggle.phase_bare', 'set', tr('Phase'), ['struggle'], 'change_struggle_phase = $phase$', [word('phase', tr('Which phase?'))], { noBuild: true }),
    KE('struggle.end', 'do', tr('End the struggle'), ['struggle'], 'end_struggle = yes'),
    KE('struggle.faith_involved', 'set', tr('Faith: involved'), ['struggle'], 'set_faith_as_involved = $faith$', [faithRef()]),
    KE('struggle.faith_uninvolved', 'set', tr('Faith: uninvolved'), ['struggle'], 'set_faith_as_uninvolved = $faith$', [faithRef()]),
    KE('struggle.culture_uninvolved', 'set', tr('Culture: uninvolved'), ['struggle'], 'set_culture_as_uninvolved = $culture$', [cultureRef()]),
    KT('struggle.type', 'main', tr('Kind of struggle'), ['struggle'], 'is_struggle_type = $type$', [ref('type', tr('Which struggle?'), 'struggle/struggles')]),
    KT('struggle.phase', 'main', tr('Current phase'), ['struggle'], 'is_struggle_phase = $phase$', [word('phase', tr('Which phase?'))]),
    KT('struggle.phase_parameter', 'main', tr('Phase parameter'), ['struggle'], 'has_struggle_phase_parameter = $parameter$', [word('parameter', tr('Which parameter?'))]),
    KT('struggle.has_catalyst', 'more', tr('Catalyst of the phase'), ['struggle'], 'phase_has_catalyst = $catalyst$', [ref('catalyst', tr('Which catalyst?'), 'struggle/catalysts')]),
    KT('struggle.faith', 'more', tr('Faith is involved'), ['struggle'], 'is_faith_involved_in_struggle = $faith$', [faithRef()]),
    KT('struggle.culture', 'more', tr('Culture is involved'), ['struggle'], 'is_culture_involved_in_struggle = $culture$', [cultureRef()]),
    // situations, their sub-regions and participant groups
    KE('situation.catalyst', 'do', tr('Trigger a catalyst'), ['situation'], 'trigger_situation_catalyst = $catalyst$', [ref('catalyst', tr('Which catalyst?'), 'situation/catalysts')]),
    // (`county`: the silk road's catalysts name the county they happened in, 4 of 291 uses)
    KE('situation.catalyst_by', 'do', tr('Trigger a catalyst (caused by someone)'), ['situation'], 'trigger_situation_catalyst = { catalyst = $catalyst$ [county = $county$] character = $character$ }', [
        ref('catalyst', tr('Which catalyst?'), 'situation/catalysts'),
        who('character', tr('Caused by whom?'), { common: ['root', 'scope:actor', 'scope:host'] })
    ], { extra: [thing('county', tr('In which county?'), 'landed_title', ['root.capital_county', 'root.location.county', 'prev'], { optional: tr('In no county in particular') })] }),
    KE('situation.phase', 'set', tr('Top phase'), ['situation'], 'change_top_phase = { phase = $phase$ }', [word('phase', tr('Which phase?'), { field: 'phase' })]),
    KE('situation.add_participant', 'add', tr('Manual participant'), ['situation'], 'add_manual_participant = $who$', [who('who', tr('Who?'), { common: ['prev', 'root', 'scope:actor'] })]),
    KE('situation.remove_participant', 'remove', tr('Manual participant'), ['situation'], 'remove_manual_participant = $who$', [who('who', tr('Who?'), { common: ['prev', 'root', 'scope:actor'] })]),
    KE('situation.center', 'set', tr('Center province'), ['situation'], 'set_situation_center_province = $province$', [thing('province', tr('Which province?'), 'province', ['root.capital_province', 'root.location'])]),
    KE('situation.end', 'do', tr('End the situation'), ['situation'], 'end_situation = yes'),
    KT('situation.type', 'main', tr('Kind of situation'), ['situation'], 'situation_type = $type$', [ref('type', tr('Which situation?'), 'situation/situations')]),
    KT('situation.phase', 'main', tr('Current phase'), ['situation'], 'situation_current_phase = $phase$', [word('phase', tr('Which phase?'))]),
    KT('situation.catalyst', 'main', tr('Catalyst of the top phase'), ['situation'], 'situation_top_has_catalyst = $catalyst$', [ref('catalyst', tr('Which catalyst?'), 'situation/catalysts')]),
    KT('situation.phase_parameter', 'more', tr('Top phase parameter'), ['situation'], 'has_situation_top_phase_parameter = $parameter$', [word('parameter', tr('Which parameter?'))]),
    KT('situation.manual_participant', 'more', tr('Manual participant'), ['situation'], 'is_manual_participant = $who$', [who('who', tr('Who?'), { common: ['prev', 'root'] })]),
    KE('subregion.phase', 'set', tr('Phase'), ['sub_region'], 'change_phase = { phase = $phase$ }', [word('phase', tr('Which phase?'), { field: 'phase' })]),
    KE('subregion.catalyst', 'do', tr('Trigger a catalyst'), ['sub_region'], 'trigger_sub_region_catalyst = { catalyst = $catalyst$ [character = $character$] }', [
        ref('catalyst', tr('Which catalyst?'), 'situation/catalysts'),
        who('character', tr('Caused by whom?'), { common: ['root', 'scope:actor', 'scope:host'], optional: tr('Nobody in particular') })
    ]),
    KE('subregion.takeover', 'add', tr('Takeover points'), ['sub_region'], 'add_takeover_phase_points = { phase = $phase$ points = $points$ }', [
        word('phase', tr('Which phase?'), { field: 'phase' }),
        num('points', tr('How many points?'), [50, 100, 200, 400, 800])
    ]),
    KT('subregion.phase', 'main', tr('Current phase'), ['sub_region'], 'sub_region_current_phase = $phase$', [word('phase', tr('Which phase?'))]),
    KT('subregion.county', 'main', tr('Has a county'), ['sub_region'], 'situation_sub_region_has_county = $county$', [thing('county', tr('Which county?'), 'landed_title', ['root.capital_county', 'root.location.county', 'prev'])]),
    KT('subregion.region', 'more', tr('Covers a region'), ['sub_region'], 'situation_sub_region_has_geographical_region = $region$', [word('region', tr('Which region?'))]),
    KT('subregion.phase_parameter', 'more', tr('Phase parameter'), ['sub_region'], 'has_sub_region_phase_parameter = $parameter$', [word('parameter', tr('Which parameter?'))]),
    KT('group.type', 'main', tr('Kind of group'), ['participant_group'], 'participant_group_type = $type$', [word('type', tr('Which group?'))]),
    KT('group.character', 'main', tr('Has the character'), ['participant_group'], 'participant_group_has_character = $who$', [who('who', tr('Who?'), { common: ['root', 'scope:actor', 'scope:recipient', 'this'] })]),
    // factions
    KE('faction.destroy', 'do', tr('Destroy the faction'), ['faction'], 'destroy_faction = yes'),
    KE('faction.war', 'do', tr('Start the faction’s war'), ['faction'], 'faction_start_war = { [title = $title$] }', [{ ...titleRef(tr('For which title?')), optional: tr('Without a title') }]),
    ...resource('add_faction_discontent', tr('Discontent'), ['faction'], [5, 10, 25, 50], levels('discontent', 'gain', ['minor', 'medium', 'major']), levels('discontent', 'loss', ['minor', 'medium', 'major', 'massive'])),
    KE('faction.special_character', 'set', tr('Special character'), ['faction'], 'set_special_character = $who$', [who('who', tr('Who?'))]),
    KE('faction.special_title', 'set', tr('Special title'), ['faction'], 'set_special_title = $title$', [thing('title', tr('Which title?'), 'landed_title', ['root.primary_title', 'scope:landed_title'])]),
    KT('faction.type', 'main', tr('Kind of faction'), ['faction'], 'faction_is_type = $type$', [ref('type', tr('Which faction?'), 'factions')]),
    KT('faction.power', 'main', tr('Power'), ['faction'], 'faction_power $cmp$ $value$', [cmp(), num('value', tr('How much?'), [50, 75, 110, 150, 200], { named: ['faction_power_threshold', 'faction_power_halfway_threshold'] })]),
    KT('faction.at_war', 'main', tr('At war'), ['faction'], 'faction_is_at_war = $on$', [yesno('on', tr('Is it at war?'))]),
    KT('faction.discontent', 'more', tr('Discontent per month'), ['faction'], 'discontent_per_month $cmp$ $value$', [cmp(), num('value', tr('How much?'), [0, 1, 2, 5])]),
    KT('faction.max_discontent', 'more', tr('Months until full discontent'), ['faction'], 'months_until_max_discontent $cmp$ $value$', [cmp(), num('value', tr('How many months?'), [4, 8, 12, 24])]),
    KT('faction.demands', 'more', tr('Can press its demands'), ['faction'], 'faction_can_press_demands = $on$', [yesno('on', tr('Can it?'))]),
    // domiciles
    KE('domicile.add_building', 'add', tr('Building'), ['domicile'], 'add_domicile_building = $building$', [ref('building', tr('Which building?'), 'domiciles/buildings')]),
    KE('domicile.remove_building', 'remove', tr('Building'), ['domicile'], 'remove_domicile_building = $building$', [ref('building', tr('Which building?'), 'domiciles/buildings')]),
    KE('domicile.construct', 'do', tr('Start building'), ['domicile'], 'construct_domicile_building = $building$', [ref('building', tr('Which building?'), 'domiciles/buildings')]),
    KE('domicile.move', 'do', tr('Move to a province'), ['domicile'], 'move_domicile = $province$', [thing('province', tr('Which province?'), 'province', ['root.capital_province', 'prev.capital_province', 'root.location'])]),
    KE('domicile.rite', 'set', tr('Rite'), ['domicile'], 'set_domicile_rite = $rite$', [riteRef()]),
    KE('domicile.culture', 'set', tr('Culture'), ['domicile'], 'set_domicile_culture = $culture$', [cultureRef()]),
    ...resource('change_provisions', tr('Provisions'), ['domicile'], [50, 100, 250, 500], levels('provisions', 'gain', ['microscopic', 'miniscule', 'minor', 'medium', 'major', 'massive', 'monumental']), levels('provisions', 'loss', ['microscopic', 'miniscule', 'minor', 'medium', 'major', 'massive', 'monumental'])),
    ...resource('change_herd', tr('Herd'), ['domicile'], [10, 50, 100, 250], levels('herd', 'gain', ['miniscule', 'minor', 'medium', 'major', 'massive', 'monumental']), levels('herd', 'loss', ['miniscule', 'minor', 'medium', 'major', 'massive', 'monumental'])),
    KT('domicile.building', 'main', tr('Building'), ['domicile'], 'has_domicile_building = $building$', [ref('building', tr('Which building?'), 'domiciles/buildings')]),
    KT('domicile.building_or_higher', 'main', tr('Building (or a better one)'), ['domicile'], 'has_domicile_building_or_higher = $building$', [ref('building', tr('Which building?'), 'domiciles/buildings')]),
    KT('domicile.type', 'main', tr('Kind of domicile'), ['domicile'], 'is_domicile_type = $type$', [ref('type', tr('Which kind?'), 'domiciles/types')]),
    KT('domicile.parameter', 'main', tr('Domicile parameter'), ['domicile'], 'has_domicile_parameter = $parameter$', [word('parameter', tr('Which parameter?'))]),
    KT('domicile.herd', 'more', tr('Herd'), ['domicile'], 'herd $cmp$ $value$', [cmp(), num('value', tr('How much?'), [0, 100, 250, 500], { named: ['minor_herd_value', 'medium_herd_value', 'max_herd'] })]),
    KT('domicile.provisions', 'more', tr('Provisions'), ['domicile'], 'provisions $cmp$ $value$', [cmp(), num('value', tr('How much?'), [0, 100, 250, 500], { named: ['max_provisions'] })]),
    KT('domicile.constructing', 'more', tr('Building under construction'), ['domicile'], 'has_domicile_construction = $building$', [ref('building', tr('Which building?'), 'domiciles/buildings')]),
    KT('domicile.buildings', 'more', tr('Number of buildings'), ['domicile'], 'num_domicile_buildings $cmp$ $value$', [cmp(), num('value', tr('How many?'), [2, 4, 6, 8, 12])]),
    // stories, epidemics, great holy wars
    KE('story.end', 'do', tr('End the story'), ['story'], 'end_story = yes'),
    KE('story.owner', 'set', tr('Story owner'), ['story'], 'make_story_owner = $who$', [who('who', tr('Who owns it?'))]),
    KT('story.type', 'main', tr('Kind of story'), ['story'], 'story_type = $type$', [ref('type', tr('Which story?'), 'story_cycles')]),
    KE('do.story', 'do', tr('Start a story'), CH, 'create_story = $type$', [ref('type', tr('Which story?'), 'story_cycles')]),
    KT('epidemic.intensity', 'main', tr('Outbreak intensity'), ['epidemic'], 'outbreak_intensity $cmp$ $level$', [cmp(), choice('level', tr('Which intensity?'), [['minor', tr('Minor'), 'm'], ['major', tr('Major'), 'j'], ['apocalyptic', tr('Apocalyptic'), 'a']])]),
    KT('epidemic.type', 'main', tr('Kind of epidemic'), ['epidemic'], 'epidemic_type = $type$', [ref('type', tr('Which epidemic?'), 'epidemics', { prefix: 'epidemic_type:' })]),
    KE('epidemic.intensity', 'set', tr('Outbreak intensity'), ['epidemic'], 'set_epidemic_outbreak_intensity = $level$', [choice('level', tr('Which intensity?'), [['minor', tr('Minor'), 'm'], ['major', tr('Major'), 'j'], ['apocalyptic', tr('Apocalyptic'), 'a']])]),
    KT('ghw.attacker', 'main', tr('Has pledged to attack'), ['great_holy_war'], 'has_pledged_attacker = $who$', [who('who', tr('Who?'), { common: ['root', 'prev', 'scope:ghw_sponsor'] })]),
    KT('ghw.defender', 'main', tr('Has pledged to defend'), ['great_holy_war'], 'has_pledged_defender = $who$', [who('who', tr('Who?'), { common: ['root', 'prev'] })]),
    KT('ghw.forced_defender', 'more', tr('Is a forced defender'), ['great_holy_war'], 'has_forced_defender = $who$', [who('who', tr('Who?'), { common: ['root', 'prev'] })]),
    KT('ghw.directed', 'more', tr('Directed at a target'), ['great_holy_war'], 'is_directed_ghw = $on$', [yesno('on', tr('Is it directed?'))]),
    KE('ghw.pledge_attacker', 'add', tr('Pledged attacker'), ['great_holy_war'], 'pledge_attacker = $who$', [who('who', tr('Who?'), { common: ['root', 'prev', 'scope:ghw_sponsor'] })]),
    KE('ghw.pledge_defender', 'add', tr('Pledged defender'), ['great_holy_war'], 'pledge_defender = $who$', [who('who', tr('Who?'), { common: ['root', 'prev'] })]),
    KE('ghw.unpledge_attacker', 'remove', tr('Pledged attacker'), ['great_holy_war'], 'unpledge_attacker = $who$', [who('who', tr('Who?'), { common: ['root', 'prev'] })]),
    KE('ghw.unpledge_defender', 'remove', tr('Pledged defender'), ['great_holy_war'], 'unpledge_defender = $who$', [who('who', tr('Who?'), { common: ['root', 'prev'] })]),
    // task contracts, legends, inspirations, accolades
    KE('contract.complete', 'do', tr('Complete the contract'), ['task_contract'], 'complete_task_contract = $outcome$', [word('outcome', tr('How does it end?'))]),
    KE('contract.invalidate', 'do', tr('Invalidate the contract'), ['task_contract'], 'invalidate_contract = yes'),
    KT('contract.type', 'main', tr('Kind of contract'), ['task_contract'], 'has_task_contract_type = $type$', [ref('type', tr('Which contract?'), 'task_contracts')]),
    KT('contract.tier', 'main', tr('Tier'), ['task_contract'], 'task_contract_tier $cmp$ $value$', [cmp(), num('value', tr('Which tier?'), [0, 3, 4], { named: ['define:NTaskContract|LOW_TASK_CONTRACT_TIER', 'define:NTaskContract|MEDIUM_TASK_CONTRACT_TIER', 'define:NTaskContract|HIGH_TASK_CONTRACT_TIER'] })]),
    KT('contract.criminal', 'more', tr('Criminal'), ['task_contract'], 'is_criminal = $on$', [yesno('on', tr('Is it criminal?'))]),
    KT('contract.group', 'more', tr('Group of contracts'), ['task_contract'], 'has_task_contract_group = $group$', [word('group', tr('Which group?'))]),
    KT('contract.taken', 'more', tr('Days since it was taken'), ['task_contract'], 'time_since_contract_taken $cmp$ $value$', [cmp(), num('value', tr('How many days?'), [30, 90, 180, 360])]),
    KE('legend.chapter', 'set', tr('Chapter'), ['legend'], 'set_legend_chapter = { name = $name$ localization_key = $key$ }', [
        CHAPTER,
        word('key', tr('Which text?'), { field: 'localization_key' })
    ]),
    KE('legend.owner_modifier', 'add', tr('Owner modifier'), ['legend'], 'add_legend_owner_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', tr('Which modifier?'), 'modifiers'), dur()]),
    KE('legend.county_modifier', 'add', tr('County modifier'), ['legend'], 'add_legend_county_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', tr('Which modifier?'), 'modifiers'), dur()]),
    KT('legend.quality', 'main', tr('Quality'), ['legend'], 'legend_quality = $quality$', [choice('quality', tr('Which quality?'), [['famed', tr('Famed'), 'f'], ['illustrious', tr('Illustrious'), 'i'], ['mythical', tr('Mythical'), 'm']])]),
    KT('legend.type', 'main', tr('Kind of legend'), ['legend'], 'legend_type = $type$', [ref('type', tr('Which legend?'), 'legends/legend_types', { prefix: 'legend_type:' })]),
    KT('legend.chapter', 'more', tr('Has a chapter'), ['legend'], 'has_legend_chapter = $name$', [CHAPTER]),
    // (the block form names the chapter's text as well: 16 of the 56 uses in 1.20.1.2)
    KT('legend.chapter_text', 'more', tr('Has a chapter with a text'), ['legend'], 'has_legend_chapter = { name = $name$ [localization_key = $key$] }', [CHAPTER, word('key', tr('Which text?'), true, { optional: tr('Any text') })], { noBuild: true }),
    KT('legend.chronicle', 'more', tr('Chronicle'), ['legend'], 'has_legend_chronicle = $chronicle$', [ref('chronicle', tr('Which chronicle?'), 'legends/chronicles')]),
    ...resource('change_inspiration_progress', tr('Progress'), ['inspiration'], [1, 2, 5, 10, 20]),
    KE('inspiration.invest', 'do', tr('Invest gold'), ['inspiration'], 'invest_gold = $value$', [num('value', tr('How much?'), [25, 50, 100], { named: ['root.tiny_gold_value', 'root.minor_gold_value', 'root.medium_gold_value'] })]),
    KT('inspiration.type', 'main', tr('Kind of inspiration'), ['inspiration'], 'has_inspiration_type = $type$', [ref('type', tr('Which inspiration?'), 'inspirations')]),
    KT('inspiration.progress', 'main', tr('Progress'), ['inspiration'], 'inspiration_progress $cmp$ $value$', [cmp(), num('value', tr('How much?'), [1, 5, 10, 20, 50])]),
    ...resource('add_glory', tr('Glory'), ['accolade'], [10, 25, 50, 100], levels('glory', 'gain', ['minimal', 'minor', 'medium', 'major', 'massive', 'monumental']), levels('glory', 'loss', ['minimal', 'minor', 'medium', 'major', 'massive', 'monumental'])),
    KT('accolade.rank', 'main', tr('Rank'), ['accolade'], 'accolade_rank $cmp$ $value$', [cmp(), num('value', tr('Which rank?'), [1, 2, 3, 4, 5, 6])]),
    KT('accolade.type', 'main', tr('Kind of accolade'), ['accolade'], 'has_accolade_type = $type$', [ref('type', tr('Which accolade?'), 'accolade_types')]),
    KT('accolade.parameter', 'more', tr('Accolade parameter'), ['accolade'], 'has_accolade_parameter = $parameter$', [word('parameter', tr('Which parameter?'))]),
    // armies, regiments, memories, great projects, confederations
    KE('army.commander', 'set', tr('Commander'), ['army'], 'assign_commander = $who$', [who('who', tr('Who commands?'))]),
    KE('army.remove_commander', 'remove', tr('Commander'), ['army'], 'remove_commander = yes'),
    KE('army.location', 'set', tr('Location'), ['army'], 'set_army_location = $province$', [thing('province', tr('Which province?'), 'province', ['root.capital_province', 'root.location'])]),
    KE('army.deplete', 'do', tr('Lose a share of its men'), ['army'], 'deplete_army_by_percentage = $value$', [num('value', tr('What share? (0.1 = a tenth)'), [0.1, 0.25, 0.4, 0.5, 0.9])]),
    KT('army.in_combat', 'main', tr('In combat'), ['army'], 'is_army_in_combat = $on$', [yesno('on', tr('Is it fighting?'))]),
    KT('army.in_siege', 'main', tr('Besieging'), ['army'], 'is_army_in_siege = $on$', [yesno('on', tr('Is it besieging?'))]),
    KT('army.raiding', 'main', tr('Raiding'), ['army'], 'is_army_in_raid = $on$', [yesno('on', tr('Is it raiding?'))]),
    KT('army.raid_army', 'more', tr('Is a raid army'), ['army'], 'is_raid_army = $on$', [yesno('on', tr('Is it?'))]),
    KT('army.moving', 'more', tr('Moving'), ['army'], 'army_is_moving = $on$', [yesno('on', tr('Is it moving?'))]),
    KT('army.size', 'more', tr('Size'), ['army'], 'army_size $cmp$ $value$', [cmp(), num('value', tr('How many men?'), [500, 1000, 3000, 5000, 10000])]),
    KT('in_army', 'more', tr('In an army'), CH, 'is_in_army = $on$', [yesno('on', tr('Is the character in an army?'))]),
    KT('commanding', 'more', tr('Commands an army'), CH, 'is_commanding_army = $on$', [yesno('on', tr('Does the character command one?'))]),
    KE('regiment.destroy', 'do', tr('Disband the regiment'), ['regiment'], 'destroy_maa_regiment = yes'),
    KE('regiment.size', 'set', tr('Size (change)'), ['regiment'], 'change_maa_regiment_size = { size = $size$ reinforce = yes }', [num('size', tr('By how many?'), [1, 2, 3, -1, -2], { signed: true })]),
    // (bare, 5 of 26 uses: read and changed where written)
    KE('regiment.size_bare', 'set', tr('Size (change)'), ['regiment'], 'change_maa_regiment_size = $size$', [num('size', tr('By how many?'), [1, 2, 3, -1, -2], { signed: true })], { noBuild: true }),
    // (`value` is mostly a script value: `replenishable_troops_value`, `maa_max_troops_count`; 8 bare of 31 uses, the others write an inline value block)
    KE('regiment.troops_change', 'set', tr('Men (change)'), ['regiment'], 'change_maa_troops_count = $value$', [num('value', tr('By how many?'), [10, 50, 100, -10, -50, -100], { signed: true, named: ['maa_max_troops_count'] })]),
    KT('regiment.type', 'main', tr('Kind of regiment'), ['regiment'], 'is_maa_type = $type$', [ref('type', tr('Which kind?'), 'men_at_arms_types')]),
    KT('regiment.unit', 'main', tr('Kind of unit'), ['regiment'], 'is_unit_type = $unit$', [word('unit', tr('Which unit?'))]),
    KT('regiment.size', 'main', tr('Size'), ['regiment'], 'maa_size $cmp$ $value$', [cmp(), num('value', tr('How many?'), [2, 4, 8, 12])]),
    KT('regiment.troops', 'more', tr('Men currently in it'), ['regiment'], 'maa_current_troops_count $cmp$ $value$', [cmp(), num('value', tr('How many?'), [100, 500, 1000], { named: ['maa_max_troops_count'] })]),
    KT('regiment.title', 'more', tr('Belongs to a title'), ['regiment'], 'is_title_maa_regiment = $on$', [yesno('on', tr('Does it?'))]),
    KT('regiment.upgrade', 'more', tr('Can be upgraded'), ['regiment'], 'can_upgrade_maa = $on$', [yesno('on', tr('Can it?'))]),
    KT('regiment.raised', 'more', tr('Raised'), ['regiment'], 'is_raised = $on$', [yesno('on', tr('Is it raised?'))]),
    KT('memory.category', 'main', tr('Category'), ['memory'], 'has_memory_category = $category$', [word('category', tr('Which category?'))]),
    KT('memory.type', 'main', tr('Kind of memory'), ['memory'], 'has_memory_type = $type$', [ref('type', tr('Which memory?'), 'character_memory_types')]),
    KT('memory.age', 'main', tr('Age in years'), ['memory'], 'memory_age_years $cmp$ $value$', [cmp(), num('value', tr('How many years?'), [1, 5, 10, 20])]),
    KT('memory.participant', 'more', tr('Participant'), ['memory'], 'has_memory_participant = $who$', [who('who', tr('Who?'))]),
    KT('project.type', 'main', tr('Kind of project'), ['great_project'], 'great_project_type = $type$', [ref('type', tr('Which project?'), 'great_projects/types')]),
    KT('project.phase', 'main', tr('Construction phase'), ['great_project'], 'great_project_construction_phase_is = $phase$', [choice('phase', tr('Which phase?'), [['planned', tr('Planned'), 'p'], ['in_progress', tr('In progress'), 'i'], ['completed', tr('Completed'), 'c']])]),
    KT('contribution.funded', 'main', tr('Funded'), ['contribution'], 'contribution_is_funded = $on$', [yesno('on', tr('Is it funded?'))]),
    KE('confederation.add', 'add', tr('Member'), ['confederation'], 'add_confederation_member = $who$', [who('who', tr('Who joins?'))]),
    KE('confederation.remove', 'remove', tr('Member'), ['confederation'], 'remove_confederation_member = $who$', [who('who', tr('Who leaves?'))]),
    KE('confederation.disband', 'do', tr('Disband it'), ['confederation'], 'disband_confederation = yes'),
    ...resource('change_cohesion', tr('Cohesion'), ['confederation'], [5, 10, 20, 50, 100]),
    KT('confederation.parameter', 'main', tr('Cohesion level parameter'), ['confederation'], 'has_cohesion_level_parameter = $parameter$', [word('parameter', tr('Which parameter?'))]),
    KT('confederation.cohesion', 'main', tr('Cohesion'), ['confederation'], 'cohesion $cmp$ $value$', [cmp(), num('value', tr('How much?'), [3, 10, 25, 50, 100])]),
    KT('confederation.house_based', 'more', tr('Based on houses'), ['confederation'], 'is_house_based = $on$', [yesno('on', tr('Is it?'))]),
    KT('confederation.leading_house', 'more', tr('Has a leading house'), ['confederation'], 'has_leading_house = $on$', [yesno('on', tr('Does it?'))]),
    KT('agent_slot.type', 'main', tr('Kind of agent slot'), ['agent_slot'], 'is_agent_slot_type = $type$', [ref('type', tr('Which kind?'), 'schemes/agent_types')]),
    KT('agent_slot.filled', 'main', tr('Filled'), ['agent_slot'], 'is_filled = $on$', [yesno('on', tr('Is it filled?'))]),
    KT('holy_site.artifact', 'main', tr('Has an enshrined artifact'), ['holy_site'], 'holy_site_has_artifact = $on$', [yesno('on', tr('Does it?'))]),
    KT('holy_site.artifacts', 'main', tr('Number of enshrined artifacts'), ['holy_site'], 'holy_site_artifact_count $cmp$ $value$', [cmp(), num('value', tr('How many?'), [0, 1, 2, 3, 5])]),
    KT('tradition.category', 'main', tr('Category'), ['tradition'], 'has_tradition_category = $category$', [word('category', tr('Which category?'))]),
    KT('faction_member', 'more', tr('Member of a faction'), CH, 'is_a_faction_member = $on$', [yesno('on', tr('Is the character in one?'))]),

    // ------------------------------------------------------------------ global effects ("Game & world")
    E('global.set_variable', 'set', tr('Global variable'), [], 'set_global_variable = { name = $name$ value = $value$ }', [varName(), num('value', tr('Which value?'), [1, 0, 5, 10], { named: ['yes'] })], { k: 'v', words: 'set_global_variable' }),
    E('global.remove_variable', 'remove', tr('Global variable'), [], 'remove_global_variable = $name$', [varName()], { k: 'v', words: 'remove_global_variable' }),

    // ------------------------------------------------------------------ triggers on characters
    T('age', 'main', 'Age', CH, 'age $cmp$ $value$', [cmp(), num('value', tr('Which age?'), [6, 12, 16, 18, 20, 25, 30, 40, 50, 60, 70], { unit: 'years' })], { k: 'a' }),
    T('trait', 'main', tr('Trait (has)'), CH, 'has_trait = $trait$', [ref('trait', tr('Which trait?'), 'traits')], { k: 't', words: 'has_trait' }),
    T('adult', 'main', 'Adult', CH, 'is_adult = yes', [], { k: 'd', words: 'is_adult' }),
    T('child', 'main', 'Child', CH, 'is_adult = no', [], { k: 'c', words: 'is_adult' }),
    T('male', 'main', 'Male', CH, 'is_male = yes', [], { k: 'm', words: 'is_male gender' }),
    T('female', 'main', 'Female', CH, 'is_female = yes', [], { k: 'e', words: 'is_female gender' }),
    T('alive', 'main', 'Alive', CH, 'is_alive = yes', [], { k: 'l', words: 'is_alive' }),
    T('dead', 'more', 'Dead', CH, 'is_alive = no', [], { words: 'is_alive' }),
    T('ai', 'main', 'AI', CH, 'is_ai = yes', [], { k: 'i', words: 'is_ai' }),
    T('player', 'more', 'Player', CH, 'is_ai = no', [], { k: 'p', words: 'is_ai' }),
    T('ruler', 'main', 'Ruler', CH, 'is_ruler = yes', [], { k: 'r', words: 'is_ruler' }),
    T('landed', 'realm', 'Landed', CH, 'is_landed = yes', [], { words: 'is_landed' }),
    T('married', 'family', 'Married', CH, 'is_married = yes', [], { words: 'is_married' }),
    T('imprisoned', 'more', 'Imprisoned', CH, 'is_imprisoned = yes', [], { words: 'is_imprisoned prison' }),
    T('at_war', 'main', tr('At war'), CH, 'is_at_war = yes', [], { k: 'w', words: 'is_at_war' }),
    T('opinion', 'main', tr('Opinion of…'), CH, 'opinion = { target = $target$ value $cmp$ $value$ }', [who('target', tr('Opinion of whom?')), cmp(), num('value', tr('Which opinion?'), [-50, -25, 0, 10, 20, 25, 50, 75], { signed: true })], { k: 'o', words: 'opinion' }),
    T('faith', 'main', 'Faith', ['character', 'landed_title', 'province'], 'faith = $faith$', [faithRef()], { k: 'f', words: tr('faith religion') }),
    T('religion', 'more', 'Religion', ['character', 'faith', 'province', 'landed_title'], 'religion = $religion$', [ref('religion', tr('Which religion?'), 'religion/religion_types', { prefix: 'religion:' })], { words: 'religion' }),
    T('culture', 'main', 'Culture', ['character', 'landed_title', 'province'], 'culture = $culture$', [cultureRef()], { k: 'u', words: 'culture' }),
    T('gold', 'main', 'Gold', CH, 'gold $cmp$ $value$', [cmp(), num('value', tr('How much?'), [0, 50, 100, 250, 500, 1000], { named: ['minor_gold_value', 'medium_gold_value', 'major_gold_value'] })], { k: 'g' }),
    T('prestige', 'resources', 'Prestige', CH, 'prestige $cmp$ $value$', [cmp(), num('value', tr('How much?'), [0, 100, 250, 500, 1000], { named: ['minor_prestige_value', 'medium_prestige_value', 'major_prestige_value'] })]),
    T('piety', 'resources', 'Piety', CH, 'piety $cmp$ $value$', [cmp(), num('value', tr('How much?'), [0, 100, 250, 500, 1000], { named: ['minor_piety_value', 'medium_piety_value', 'major_piety_value'] })]),
    T('stress', 'resources', 'Stress', CH, 'stress $cmp$ $value$', [cmp(), num('value', tr('How much?'), [0, 25, 50, 100, 150, 200])], { k: 's' }),
    T('dread', 'resources', 'Dread', CH, 'dread $cmp$ $value$', [cmp(), num('value', tr('How much?'), [0, 25, 50, 75, 100])]),
    T('skill', 'main', tr('Skill…'), CH, '$skill$ $cmp$ $value$', [choice('skill', tr('Which skill?'), SKILLS), cmp(), num('value', tr('Which level?'), [5, 8, 10, 12, 15, 20], { named: ['mediocre_skill_rating', 'decent_skill_rating', 'high_skill_rating', 'very_high_skill_rating'] })], {
        k: 'k',
        words: tr('diplomacy martial stewardship intrigue learning prowess')
    }),
    T('exists', 'main', 'Exists', 'any', 'exists = $subject$', [], { k: 's', subjectValue: true, words: 'exists' }),

    T('relation', 'family', tr('Relation (friend, rival, lover…)'), CH, 'has_relation_$relation$ = $target$', [choice('relation', tr('Which relation?'), RELATIONS), who('target', tr('With whom?'))], { k: 'r', words: 'has_relation friend rival lover' }),
    T('child_of', 'family', tr('Child of…'), CH, 'is_child_of = $who$', [who('who', tr('Whose child?'))], { k: 'c', words: 'is_child_of' }),
    T('parent_of', 'family', tr('Parent of…'), CH, 'is_parent_of = $who$', [who('who', tr('Whose parent?'))], { k: 'p', words: 'is_parent_of' }),
    T('spouse_of', 'family', tr('Spouse of…'), CH, 'is_spouse_of = $who$', [who('who', tr('Whose spouse?'))], { k: 's', words: 'is_spouse_of' }),
    T('sibling_of', 'family', tr('Sibling of…'), CH, 'is_sibling_of = $who$', [who('who', tr('Whose sibling?'))], { k: 'b', words: 'is_sibling_of' }),
    T('close_family_of', 'family', tr('Close family of…'), CH, 'is_close_family_of = $who$', [who('who', tr('Whose close family?'))], { k: 'f', words: 'is_close_family_of' }),
    T('consort_of', 'family', tr('Consort of…'), CH, 'is_consort_of = $who$', [who('who', tr('Whose consort?'))], { words: 'is_consort_of' }),
    T('vassal_of', 'family', tr('Vassal of…'), CH, 'is_vassal_of = $who$', [who('who', tr('Whose vassal?'))], { k: 'v', words: 'is_vassal_of' }),
    T('courtier_of', 'family', tr('Courtier of…'), CH, 'is_courtier_of = $who$', [who('who', tr('Whose courtier?'))], { k: 'o', words: 'is_courtier_of' }),
    T('knight_of', 'family', tr('Knight of…'), CH, 'is_knight_of = $who$', [who('who', tr('Whose knight?'))], { k: 'k', words: 'is_knight_of' }),
    T('allied_to', 'family', tr('Allied to…'), CH, 'is_allied_to = $who$', [who('who', tr('Allied to whom?'))], { k: 'a', words: 'is_allied_to' }),
    T('at_war_with', 'family', tr('At war with…'), CH, 'is_at_war_with = $who$', [who('who', tr('At war with whom?'))], { k: 'w', words: 'is_at_war_with' }),
    T('same', 'family', tr('Is someone (the same person)'), CH, 'this = $who$', [who('who', 'Who?', { common: ['root', 'scope:actor', 'scope:recipient', 'liege', 'prev'] })], { k: 'i', words: 'this =' }),
    T('house_head', 'family', tr('House head'), CH, 'is_house_head = yes', [], { k: 'h', words: 'is_house_head' }),
    T('lowborn', 'family', 'Lowborn', CH, 'is_lowborn = yes', [], { k: 'l', words: 'is_lowborn' }),

    T('tier', 'realm', tr('Highest title tier'), CH, 'highest_held_title_tier $cmp$ $tier$', [cmp(), choice('tier', tr('Which tier?'), TIERS)], { k: 't', words: 'highest_held_title_tier' }),
    T('has_title', 'realm', tr('Holds a title'), CH, 'has_title = $title$', [titleRef()], { k: 'h', words: 'has_title' }),
    T('government_flag', 'realm', tr('Government flag (nomadic, tribal…)'), CH, 'government_has_flag = $flag$', [{ name: 'flag', kind: 'text', label: tr('Which government flag?'), usage: true }], { k: 'f', words: tr('government_has_flag nomadic tribal feudal clan') }),
    T('employs_position', 'realm', tr('Employs a court position'), CH, 'employs_court_position = $pos$', [ref('pos', tr('Which position?'), 'court_positions/types')], { k: 'e', words: 'employs_court_position' }),
    T('independent', 'realm', tr('Independent ruler'), CH, 'is_independent_ruler = yes', [], { k: 'i', words: 'is_independent_ruler' }),
    T('government', 'realm', 'Government', CH, 'has_government = $gov$', [ref('gov', tr('Which government?'), 'governments')], { k: 'g', words: 'has_government' }),
    T('realm_law', 'realm', tr('Realm law'), CH, 'has_realm_law = $law$', [ref('law', tr('Which law?'), 'laws')], { k: 'l', words: 'has_realm_law' }),
    T('claim', 'realm', tr('Claim on…'), CH, 'has_claim_on = $title$', [titleRef(tr('On which title?'))], { k: 'c', words: 'has_claim_on' }),
    T('court_position', 'realm', tr('Court position'), CH, 'has_court_position = $pos$', [ref('pos', tr('Which position?'), 'court_positions/types')], { k: 'p', words: 'has_court_position' }),
    T('council_position', 'realm', tr('Council position'), CH, 'has_council_position = $pos$', [ref('pos', tr('Which position?'), 'council_positions')], { k: 'o', words: 'has_council_position' }),
    T('royal_court', 'realm', tr('Has a royal court'), CH, 'has_royal_court = yes', [], { k: 'r', words: 'has_royal_court' }),
    T('prestige_level', 'resources', tr('Prestige level'), CH, 'prestige_level $cmp$ $value$', [cmp(), num('value', tr('Which level?'), [0, 1, 2, 3, 4, 5])]),
    T('piety_level', 'resources', tr('Piety level'), CH, 'piety_level $cmp$ $value$', [cmp(), num('value', tr('Which level?'), [0, 1, 2, 3, 4, 5])]),

    T('flag', 'marks', 'Flag', CH, 'has_character_flag = $flag$', [flagName()], { k: 'f', words: 'has_character_flag' }),
    T('modifier', 'marks', 'Modifier', CH, 'has_character_modifier = $modifier$', [ref('modifier', tr('Which modifier?'), 'modifiers')], { k: 'm', words: 'has_character_modifier' }),
    T('variable', 'marks', 'Variable', 'any', 'has_variable = $name$', [varName()], { k: 'v', words: 'has_variable' }),
    T('opinion_modifier', 'marks', tr('Opinion modifier'), CH, 'has_opinion_modifier = { target = $target$ modifier = $modifier$ }', [who('target', tr('Towards whom?')), ref('modifier', tr('Which opinion?'), 'opinion_modifiers')], { k: 'o', words: 'has_opinion_modifier' }),
    T('hook', 'marks', tr('Hook on…'), CH, 'has_hook = $who$', [who('who', tr('On whom?'))], { k: 'h', words: 'has_hook' }),
    T('strong_hook', 'marks', tr('Strong hook on…'), CH, 'has_strong_hook = $who$', [who('who', tr('On whom?'))], { k: 's', words: 'has_strong_hook' }),

    T('perk', 'more', 'Perk', CH, 'has_perk = $perk$', [ref('perk', tr('Which perk?'), 'lifestyle_perks')], { k: 'p', words: 'has_perk' }),
    T('focus', 'more', 'Focus', CH, 'has_focus = $focus$', [ref('focus', tr('Which focus?'), 'focuses')], { k: 'f', words: 'has_focus' }),
    T('lifestyle', 'more', 'Lifestyle', CH, 'has_lifestyle = $lifestyle$', [ref('lifestyle', tr('Which lifestyle?'), 'lifestyles')], { k: 'l', words: 'has_lifestyle' }),
    T('trait_xp', 'more', tr('Trait experience'), CH, 'has_trait_xp = { trait = $trait$ [track = $track$] value $cmp$ $value$ }', [ref('trait', tr('Which trait?'), 'traits'), cmp(), num('value', tr('How much?'), [10, 25, 50, 75, 100]), TRACK], { k: 't', words: 'has_trait_xp' }),
    T('sexuality', 'more', 'Sexuality', CH, 'has_sexuality = $s$', [choice('s', tr('Which sexuality?'), [['heterosexual', 'Heterosexual', 'h'], ['homosexual', 'Homosexual', 'o'], ['bisexual', 'Bisexual', 'b'], ['asexual', 'Asexual', 'a'], ['none', tr('None yet (children)'), 'n']])], { k: 's', words: 'has_sexuality' }),
    T('travelling', 'more', 'Travelling', CH, 'is_travelling = yes', [], { words: 'is_travelling' }),
    T('pregnant', 'more', 'Pregnant', CH, 'is_pregnant = yes', [], { words: 'is_pregnant' }),
    T('incapable', 'more', 'Incapable', CH, 'is_incapable = yes', [], { k: 'i', words: 'is_incapable' }),
    T('health', 'more', 'Health', CH, 'health $cmp$ $value$', [cmp(), num('value', tr('Which health?'), [1, 2, 3, 4, 5, 6], { named: ['poor_health', 'fine_health'] })], { k: 'h' }),
    T('fertility', 'more', 'Fertility', CH, 'fertility $cmp$ $value$', [cmp(), num('value', tr('Which fertility?'), [0, 0.1, 0.25, 0.5, 0.75])]),

    // ------------------------------------------------------------------ triggers on titles, provinces, faiths, cultures, dynasties, houses, artifacts, wars
    T('title.tier', 'main', 'Tier', ['landed_title'], 'tier $cmp$ $tier$', [cmp(), choice('tier', tr('Which tier?'), TIERS)], { k: 't', words: 'tier' }),
    T('title.holder', 'main', tr('Held by…'), ['landed_title'], 'holder = $who$', [who('who', tr('By whom?'))], { k: 'h', words: 'holder' }),
    T('title.development', 'main', 'Development', ['landed_title'], 'development_level $cmp$ $value$', [cmp(), num('value', tr('Which level?'), [5, 10, 20, 30, 50])], { k: 'd', words: 'development_level' }),
    T('title.control', 'main', tr('County control'), ['landed_title'], 'county_control $cmp$ $value$', [cmp(), num('value', tr('How much?'), [25, 50, 75, 90, 100])], { k: 'c', words: 'county_control' }),
    T('title.modifier', 'main', tr('County modifier'), ['landed_title'], 'has_county_modifier = $modifier$', [ref('modifier', tr('Which modifier?'), 'modifiers')], { k: 'm', words: 'has_county_modifier' }),
    T('title.coastal', 'main', tr('Coastal county'), ['landed_title'], 'is_coastal_county = yes', [], { words: 'is_coastal_county' }),
    T('title.de_jure', 'main', tr('De jure part of…'), ['landed_title'], 'de_jure_liege = $title$', [titleRef(tr('Which title?'))], { k: 'j', words: 'de_jure_liege' }),
    T('title.law', 'main', tr('Title law'), ['landed_title'], 'has_title_law = $law$', [ref('law', tr('Which law?'), 'laws')], { k: 'l', words: 'has_title_law' }),

    T('province.terrain', 'main', 'Terrain', ['province'], 'terrain = $terrain$', [ref('terrain', tr('Which terrain?'), 'terrain_types')], { k: 't', words: 'terrain' }),
    T('province.region', 'main', 'Region', ['province', 'landed_title'], 'geographical_region = $region$', [{ name: 'region', kind: 'text', label: tr('Which region?'), usage: true }], { k: 'r', words: 'geographical_region' }),
    T('province.holding', 'main', tr('Holding type'), ['province'], 'has_holding_type = $holding$', [ref('holding', tr('Which holding type?'), 'holdings')], { k: 'h', words: 'has_holding_type' }),
    T('province.has_holding', 'main', tr('Has a holding'), ['province'], 'has_holding = yes', [], { words: 'has_holding' }),
    T('province.building', 'main', 'Building', ['province'], 'has_building_or_higher = $building$', [ref('building', tr('Which building?'), 'buildings')], { k: 'b', words: 'has_building_or_higher has_building' }),
    T('province.modifier', 'main', tr('Province modifier'), ['province'], 'has_province_modifier = $modifier$', [ref('modifier', tr('Which modifier?'), 'modifiers')], { k: 'm', words: 'has_province_modifier' }),
    T('province.coastal', 'main', 'Coastal', ['province'], 'is_coastal = yes', [], { k: 'c', words: 'is_coastal' }),

    T('faith.doctrine', 'main', 'Doctrine', ['faith'], 'has_doctrine = $doctrine$', [ref('doctrine', tr('Which doctrine?'), 'religion/doctrine_types')], { k: 'd', words: 'has_doctrine' }),
    T('faith.parameter', 'main', tr('Doctrine parameter'), ['faith'], 'has_doctrine_parameter = $parameter$', [{ name: 'parameter', kind: 'text', label: tr('Which parameter?'), usage: true }], { k: 'p', words: 'has_doctrine_parameter' }),
    T('culture.pillar', 'main', tr('Pillar (heritage, language…)'), ['culture'], 'has_cultural_pillar = $pillar$', [ref('pillar', tr('Which pillar?'), 'culture/pillars')], { k: 'p', words: 'has_cultural_pillar' }),
    T('culture.tradition', 'main', 'Tradition', ['culture'], 'has_cultural_tradition = $tradition$', [ref('tradition', tr('Which tradition?'), 'culture/traditions')], { k: 't', words: 'has_cultural_tradition' }),
    T('culture.innovation', 'main', 'Innovation', ['culture'], 'has_innovation = $innovation$', [ref('innovation', tr('Which innovation?'), 'culture/innovations')], { k: 'i', words: 'has_innovation' }),
    T('culture.parameter', 'main', tr('Cultural parameter'), ['culture'], 'has_cultural_parameter = $parameter$', [{ name: 'parameter', kind: 'text', label: tr('Which parameter?'), usage: true }], { k: 'a', words: 'has_cultural_parameter' }),
    T('culture.era', 'main', tr('Era (or later)'), ['culture'], 'has_cultural_era_or_later = $era$', [ref('era', tr('Which era?'), 'culture/eras')], { k: 'e', words: 'has_cultural_era_or_later' }),
    T('dynasty.perk', 'main', tr('Legacy (dynasty perk)'), ['dynasty'], 'has_dynasty_perk = $perk$', [ref('perk', tr('Which legacy?'), 'dynasty_perks')], { k: 'l', words: 'has_dynasty_perk' }),
    T('dynasty.modifier', 'main', tr('Dynasty modifier'), ['dynasty'], 'has_dynasty_modifier = $modifier$', [ref('modifier', tr('Which modifier?'), 'modifiers')], { k: 'm', words: 'has_dynasty_modifier' }),
    T('dynasty.prestige_level', 'main', tr('Dynasty prestige level'), ['dynasty'], 'dynasty_prestige_level $cmp$ $value$', [cmp(), num('value', tr('Which level?'), [1, 2, 3, 5, 7, 10])], { k: 'p', words: 'dynasty_prestige_level' }),
    T('house.modifier', 'main', tr('House modifier'), ['dynasty_house'], 'has_house_modifier = $modifier$', [ref('modifier', tr('Which modifier?'), 'modifiers')], { k: 'm', words: 'has_house_modifier' }),
    T('artifact.rarity', 'main', 'Rarity', ['artifact'], 'rarity = $rarity$', [choice('rarity', tr('Which rarity?'), [['common', 'Common', 'c'], ['masterwork', 'Masterwork', 'm'], ['famed', 'Famed', 'f'], ['illustrious', 'Illustrious', 'i']])], { k: 'r', words: 'rarity' }),
    T('artifact.type', 'main', tr('Artifact type'), ['artifact'], 'artifact_type = $type$', [ref('type', tr('Which type?'), 'artifacts/types')], { k: 't', words: 'artifact_type' }),
    T('artifact.equipped', 'main', 'Equipped', ['artifact'], 'is_equipped = yes', [], { k: 'e', words: 'is_equipped' }),
    T('war.cb', 'main', tr('Casus belli'), ['war'], 'using_cb = $cb$', [ref('cb', tr('Which casus belli?'), 'casus_belli_types')], { k: 'c', words: 'using_cb' }),
    T('war.attacker', 'main', tr('Attacker is…'), ['war'], 'is_attacker = $who$', [who('who', 'Who?')], { k: 'a', words: 'is_attacker' }),
    T('war.defender', 'main', tr('Defender is…'), ['war'], 'is_defender = $who$', [who('who', 'Who?')], { k: 'd', words: 'is_defender' }),

    // ------------------------------------------------------------------ global triggers ("Game & world")
    T('global.rule', 'main', tr('Game rule'), [], 'has_game_rule = $rule$', [ref('rule', tr('Which game rule setting?'), 'game_rule_options')], { k: 'r', words: 'has_game_rule' }),
    T('global.dlc', 'main', tr('DLC feature'), [], 'has_dlc_feature = $feature$', [{ name: 'feature', kind: 'text', label: tr('Which DLC feature?'), usage: true }], { k: 'd', words: 'has_dlc_feature' }),
    T('global.year', 'main', tr('Current year'), [], 'current_year $cmp$ $value$', [cmp(), num('value', tr('Which year?'), [867, 1000, 1066, 1100, 1178, 1200, 1300])], { k: 'y', words: 'current_year' }),
    T('global.variable', 'main', tr('Global variable'), [], 'has_global_variable = $name$', [varName()], { k: 'v', words: 'has_global_variable' }),
    T('global.always', 'main', 'Always', [], 'always = yes', [], { k: 'a', words: 'always' }),
    T('global.never', 'main', 'Never', [], 'always = no', [], { k: 'n', words: 'always' })
];

/** Statements of a kind that run in a scope type (`[]` scopes: only global ones). */
export function statementsFor(kind: PickKind, scope: ScopeType | null): StatementDef[]
{
    const fits = STATEMENTS.filter((s) => s.kind === kind && !s.hidden && !s.noBuild && (scope === null ? Array.isArray(s.scopes) && s.scopes.length === 0 : s.scopes === 'any' || s.scopes.includes(scope)));
    // (the scope's own statements first, those of every scope after them)
    return [...fits.filter((s) => s.scopes !== 'any'), ...fits.filter((s) => s.scopes === 'any')];
}

export function statementById(id: string): StatementDef | undefined
{
    return STATEMENTS.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Script snippets: a small tree, template filling, printing
// ---------------------------------------------------------------------------

/** A statement of built script. `meta` is the picker's own note (a scope switch or iterator it made). */
export interface SNode
{
    k: string;
    op: string;
    /** scalar value; absent for blocks */
    v?: string;
    kids?: SNode[];
    meta?: { wrap: 'scope' | 'iter'; label: string; scope: ScopeType; };
}

const OPS = ['==', '!=', '<=', '>=', '?=', '=', '<', '>'];

/** Tokens of a script snippet: `{`, `}`, operators, words and quoted strings. */
function tokens(src: string): string[]
{
    const out: string[] = [];
    let i = 0;

    while (i < src.length)
    {
        const c = src[i];

        if (/\s/.test(c))
        {
            i++;
            continue;
        }

        if (c === '#')
        {
            while (i < src.length && src[i] !== '\n')
                i++;

            continue;
        }

        if (c === '{' || c === '}')
        {
            out.push(c);
            i++;
            continue;
        }

        const op = OPS.find((o) => src.startsWith(o, i));

        if (op)
        {
            out.push(op);
            i += op.length;
            continue;
        }

        if (c === '"')
        {
            let j = i + 1;

            while (j < src.length && src[j] !== '"')
                j += src[j] === '\\' ? 2 : 1;

            out.push(src.slice(i, j + 1));
            i = j + 1;
            continue;
        }

        let j = i;

        while (j < src.length && !/[\s{}=<>!?#"]/.test(src[j]))
            j++;

        if (j === i)
            j++;

        out.push(src.slice(i, j));
        i = j;
    }

    return out;
}

/** Parses a script snippet into nodes (bare values in blocks become `{ k: value, op: '' }`). */
export function parseSnippet(src: string): SNode[]
{
    const t = tokens(src);
    let p = 0;
    const list = (): SNode[] =>
    {
        const out: SNode[] = [];

        while (p < t.length && t[p] !== '}')
        {
            const k = t[p++];

            if (k === '{')
            {
                // anonymous block: keep its content flat
                out.push(...list());
                p++;
                continue;
            }

            // (a placeholder standing for the operator: `age ‹compared_how› ‹which_age›`)
            const placeholderOp = t[p]?.startsWith('‹') && t[p + 1] !== undefined && t[p + 1] !== '{' && t[p + 1] !== '}' && !OPS.includes(t[p + 1]);

            if (p < t.length && (OPS.includes(t[p]) || placeholderOp))
            {
                const op = t[p++];

                if (t[p] === '{')
                {
                    p++;
                    const kids = list();
                    p++;
                    out.push({ k, op, kids });
                }
                else
                    out.push({ k, op, v: t[p++] ?? '' });
            }
            else
                out.push({ k, op: '' });
        }

        return out;
    };
    return list();
}

/** Blocks up to this long (and holding only scalars) are written on one line. */
const INLINE = 100;

function inline(n: SNode): string
{
    if (!n.kids)
        return n.op ? `${n.k} ${n.op} ${n.v}` : n.k;

    return `${n.k} ${n.op} { ${n.kids.map(inline).join(' ')} }`.replace('{  }', '{ }');
}

/** Script text: top level unindented, nested lines indented with tabs, short scalar blocks on one line. */
export function printScript(nodes: SNode[], depth = 0): string
{
    const pad = '\t'.repeat(depth);
    const lines: string[] = [];

    for (const n of nodes)
    {
        if (!n.kids)
        {
            lines.push(pad + inline(n));
            continue;
        }

        const one = inline(n);

        if (n.kids.every((c) => !c.kids) && one.length + depth * 4 <= INLINE && n.kids.length <= 4)
        {
            lines.push(pad + one);
            continue;
        }

        lines.push(`${pad}${n.k} ${n.op} {`);
        const inner = printScript(n.kids, depth + 1);

        if (inner)
            lines.push(inner);

        lines.push(pad + '}');
    }

    return lines.join('\n');
}

/**
 * Keys a later game version renamed: the catalog's name → the newer one (1.20: `stress_impact` →
 * `stress_and_fulfillment_impact`, which also touches spiritual fulfillment). A written statement under either name is
 * the catalog's (findStatement); one the picker writes takes the newer name when the loaded game's script uses it
 * (`preferKeys`, from the key scan; the older game knows only the old one).
 */
export const RENAMED_KEYS: Record<string, string> = { stress_impact: 'stress_and_fulfillment_impact' };
const OLDER_KEYS: Record<string, string> = Object.fromEntries(Object.entries(RENAMED_KEYS).map(([o, n]) => [n, o]));
const preferred = new Map<string, string>();

/** The effect / trigger keys the loaded script uses: the renamed ones it uses under their newer name are written so. */
export function preferKeys(used: Iterable<string>): void
{
    const have = new Set(used);
    preferred.clear();

    for (const [o, n] of Object.entries(RENAMED_KEYS))
        if (have.has(n))
            preferred.set(o, n);
}

/** The name a statement of the catalog is written under (its newer one, when the game uses that). */
export function writtenKey(key: string): string
{
    return preferred.get(key) ?? key;
}

/**
 * Fills a template: `$name$` → the value; a `[…]` group is dropped when a parameter inside is empty. `short`
 * replaces the template when every optional parameter is empty.
 */
export function fillTemplate(def: Pick<StatementDef, 'script' | 'short' | 'params' | 'saves' | 'extra'>, values0: Record<string, string>, opts: { long?: boolean; } = {}): string
{
    const values = { ...values0 };

    // (the scope the template names itself; a value written inside its own scope switch, seen from there)
    if (def.saves && !values[def.saves.name])
        values[def.saves.name] = def.saves.base;

    for (const p of def.extra?.length ? [...def.params, ...def.extra] : def.params)
        if (p.kind === 'scope' && p.switched && values[p.name])
            values[p.name] = inPrev(values[p.name]);

    const optional = def.params.filter((p) => p.optional !== undefined);
    // (`long`: the block form even so: a written statement's other fields go into it)
    const tpl = def.short && !opts.long && optional.length && optional.every((p) => !values[p.name]) ? def.short : def.script;
    return tpl
        .replace(/\[([^\]]*)\]/g, (_m, inner: string) => ([...inner.matchAll(/\$(\w+)\$/g)].some((m) => !values[m[1]]) ? '' : inner))
        .replace(/\$(\w+)\$/g, (_m, n: string) => values[n] ?? '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * A scope value as written one scope switch further in (ScopeParam.switched): `root`, a saved scope or an entry stay as
 * they are; `this` is `prev` there, and a value relative to the subject (`liege`, `var:x`, `prev`) goes through it
 * (`prev.liege`: vanilla writes `holder = prev` and `holder = prev.liege`). A placeholder (‹…›) and a scripted effect's
 * parameter (`$TARGET$`: what replaces it is not known here) stay. A typed `prev` would become `prev.prev`, which the
 * game refuses (round 13's second in-game test: "Link 'prev' is a global link but follows a 'prev' link"), so the
 * picker keeps prev-based values away from a switched parameter (picker/model.ts scopeParamMenu).
 */
export function inPrev(v: string): string
{
    if (!v || v.includes('‹') || /^(\$|root(\.|$)|scope:|global_var:|local_var:|(character|title|faith|culture|dynasty|house|province|religion|rite):)/.test(v))
        return v;

    if (v === 'this')
        return 'prev';

    return 'prev.' + v.replace(/^this\./, '');
}

/**
 * The inverse of inPrev: a value written one scope switch further in, as seen from outside (`prev` → `this`, `prev.x` →
 * `x`, `prev.prev` → `prev`; `root`, a saved scope, an entry, a placeholder, a parameter stay). Undefined when inPrev
 * never writes the value (`liege` written inside the title's block, `prev.root`): it can't be read back as one the
 * picker would write the same way. For every value v it gives one that inPrev turns back into v.
 */
export function outOfPrev(v: string): string | undefined
{
    if (inPrev(v) === v)
        return v;

    if (v === 'prev')
        return 'this';

    if (!v.startsWith('prev.'))
        return undefined;

    const x = v.slice(5);
    return inPrev(x) === v ? x : undefined;
}

/** A duration as script: `years = 5` */
export function durationScript(n: number, unit: string): string
{
    return `${unit} = ${n}`;
}

/** "5 years", "1 month" */
export function durationLabel(n: number, unit: string): string
{
    return `${n} ${n === 1 ? unit.slice(0, -1) : unit}`;
}

// ---------------------------------------------------------------------------
// Reading a written statement back (changing it through the picker)
// ---------------------------------------------------------------------------

/** A template as a tree: `$x$` placeholders become `‹x›` tokens, `[…]` groups stay in (their parameters optional). */
function templateTree(tpl: string): SNode[]
{
    return parseSnippet(tpl.replace(/[[\]]/g, ' ').replace(/\$(\w+)\$/g, (_m, n: string) => `‹${n}›`));
}

const PLACEHOLDER = /‹(\w+)›/g;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMPARE_OPS = ['<', '<=', '>', '>=', '=', '==', '!='];

function placeholdersOf(n: SNode): string[]
{
    const out: string[] = [];
    const scan = (x: SNode): void =>
    {
        for (const s of [x.k, x.op, x.v ?? ''])
            for (const m of s.matchAll(PLACEHOLDER))
                out.push(m[1]);

        x.kids?.forEach(scan);
    };
    scan(n);
    return out;
}

/** A value written for a parameter fits it: a choice's option, a number of the right sign, a prefixed entry. */
/** A statement's parameters with those asked only when changing a written one. */
export const allParams = (def: StatementDef): ParamDef[] => (def.extra?.length ? [...def.params, ...def.extra] : def.params);

function fits(def: StatementDef, name: string, value: string): boolean
{
    // (the scope the statement saves itself: a name)
    if (def.saves && name === def.saves.name)
        return /^\w+$/.test(value);

    const p = allParams(def).find((x) => x.name === name);

    if (!p || !value)
        return !!p || !value;

    if (p.kind === 'choice')
        return p.options.some((o) => o.value === value);

    if (p.kind === 'number')
    {
        if (!/^-?\d+(\.\d+)?$/.test(value))
            return !value.includes(' ');

        return p.sign === -1 ? value.startsWith('-') : true;
    }

    // (an entry by its prefix, a listed scope, or a chain leading to the prefix's type: `scope:x.rite`)
    if (p.kind === 'ref' && p.prefix)
    {
        const to = PREFIX_SCOPES[p.prefix.replace(/:$/, '')];
        return value.startsWith(p.prefix) || (p.scopes ?? []).some((s) => s.value === value) || (!!to && chainFits(value, to));
    }

    return !/[{}]/.test(value);
}

function matchText(t: string, s: string, def: StatementDef, vals: Record<string, string>): boolean
{
    if (!t.includes('‹'))
        return t === s;

    const names: string[] = [];
    const parts = t.split(/‹(\w+)›/);
    const re = new RegExp('^' + parts.map((part, i) => (i % 2 ? (names.push(part), '(.+?)') : escapeRe(part))).join('') + '$');
    const m = re.exec(s);

    if (!m)
        return false;

    for (let i = 0; i < names.length; i++)
    {
        // (a parameter the template writes twice (a saved scope's name: `save_scope_as = $change$ … scope:$change$`) is
        // written the same in both places)
        if (!fits(def, names[i], m[i + 1]) || (!!vals[names[i]] && vals[names[i]] !== m[i + 1]))
            return false;

        vals[names[i]] = m[i + 1];
    }

    return true;
}

/** `rest`: the written block's fields the template has no place for are kept there instead of failing the match. */
function matchNode(t: SNode, s: SNode, def: StatementDef, vals: Record<string, string>, rest?: SNode[]): boolean
{
    if (!matchText(t.k, s.k, def, vals))
        return false;

    const op = /^‹(\w+)›$/.exec(t.op);

    if (op)
    {
        if (!COMPARE_OPS.includes(s.op))
            return false;

        vals[op[1]] = s.op === '==' ? '=' : s.op;
    }
    else if (t.op !== s.op)
        return false;

    if (t.kids)
        return !!s.kids && matchNodes(t.kids, s.kids, def, vals, rest);

    if (s.kids)
        return false;

    return matchText(t.v ?? '', s.v ?? '', def, vals);
}

const isOptional = (def: StatementDef, name: string): boolean => allParams(def).some((p) => p.name === name && p.optional !== undefined);

/**
 * Every template node matches its own written node (in any order); optional parts may be missing; nothing is left
 * over, or, with `rest`, what is left over goes there. `kidRest`: the leftovers of the matched nodes' own blocks.
 */
function matchNodes(t: SNode[], s: SNode[], def: StatementDef, vals: Record<string, string>, rest?: SNode[], kidRest?: SNode[]): boolean
{
    const used = new Set<number>();

    for (const tn of t)
    {
        // a duration placeholder stands for `days|weeks|months|years = N`, or a random time between two, `days = { 5 10 }`
        // (read as written wherever it stands; offered for new writes where the game takes it: DurationParam.range)
        const dur = /^‹(\w+)›$/.exec(tn.k);

        if (dur && !tn.op)
        {
            const range = (x: SNode): boolean => !!x.kids && x.kids.length === 2 && x.kids.every((y) => !y.op && !y.kids && /^\d+$/.test(y.k));
            const i = s.findIndex((x, j) => !used.has(j) && x.op === '=' && /^(days|weeks|months|years)$/.test(x.k) && (!x.kids || range(x)));

            if (i >= 0)
            {
                used.add(i);
                vals[dur[1]] = s[i].kids ? `${s[i].k} = { ${s[i].kids![0].k} ${s[i].kids![1].k} }` : `${s[i].k} = ${s[i].v}`;
            }
            else if (isOptional(def, dur[1]))
                vals[dur[1]] = '';
            else
                return false;

            continue;
        }

        let found = -1;

        for (let j = 0; j < s.length && found < 0; j++)
        {
            if (used.has(j))
                continue;

            const trial = { ...vals };
            const trialRest: SNode[] = [];

            if (matchNode(tn, s[j], def, trial, kidRest ? trialRest : undefined))
            {
                found = j;
                Object.assign(vals, trial);
                kidRest?.push(...trialRest);
            }
        }

        if (found >= 0)
        {
            used.add(found);
            continue;
        }

        const names = placeholdersOf(tn);

        if (!names.length || !names.every((n) => isOptional(def, n)))
            return false;

        for (const n of names)
            vals[n] ??= '';
    }

    if (used.size === s.length)
        return true;

    if (!rest)
        return false;

    rest.push(...s.filter((_x, j) => !used.has(j)));
    return true;
}

/**
 * The catalog statement a written effect / condition is, with its parameters' values as written (`add_gold = 100` →
 * add.add_gold, value 100; `age >= 16` → age, cmp >=, value 16). Among several fitting ones: the one for the scope,
 * a negative amount the "Remove" one, a named value from the statement's own list. Null when none fits.
 */
export function findStatement(kind: PickKind, text: string, scope?: ScopeType): { def: StatementDef; values: Record<string, string>; rest?: SNode[]; restAt?: RestAt[]; not?: boolean; } | null
{
    const nodes = parseSnippet(text);

    // (several statements: one the picker writes as several, the title triple of `do.give_title`)
    if (nodes.length > 1)
        return findSequence(kind, nodes);

    if (nodes.length !== 1)
        return null;

    // (a renamed key under its newer name: the catalog's statement)
    if (nodes[0].k && OLDER_KEYS[nodes[0].k])
        nodes[0].k = OLDER_KEYS[nodes[0].k];

    let best: { def: StatementDef; values: Record<string, string>; score: number; rest: SNode[]; } | null = null;

    for (const def of STATEMENTS)
    {
        if (def.kind !== kind || def.subjectValue || def.hidden || !def.params.length)
            continue;

        for (const tpl of def.short ? [def.script, def.short] : [def.script])
        {
            const values: Record<string, string> = {};
            const rest: SNode[] = [];

            if (!matchNodes(templateTree(tpl), nodes, def, values, undefined, rest))
                continue;

            // (fields it has no place for are kept, but a statement that has a place for them wins)
            let score = -3 * rest.length;

            if (scope && (def.scopes === 'any' || def.scopes.includes(scope)))
                score += 2;

            for (const p of def.params)
            {
                const v = values[p.name];

                // (an entry named by a chain (chainFits) only where nothing else fits: a statement taking a scope wins)
                if (p.kind === 'ref' && p.prefix && v && !v.startsWith(p.prefix) && !(p.scopes ?? []).some((x) => x.value === v))
                    score -= 1;

                if (p.kind !== 'number' || !v)
                    continue;

                if (p.sign === -1 && v.startsWith('-'))
                    score += 2;

                if (p.named?.includes(v))
                    score += 1;
            }

            // (optional parameters the written form leaves out (the short form) are "none")
            for (const p of allParams(def))
                if (p.optional !== undefined)
                    values[p.name] ??= '';

            if (!best || score > best.score)
                best = { def, values, score, rest };
        }
    }

    if (best)
        return { def: best.def, values: best.values, ...(best.rest.length ? { rest: best.rest } : {}) };

    // (a condition in `NOT = { … }`: the condition, negated again when written)
    const n = nodes[0];

    if (kind === 'trigger' && n.k === 'NOT' && n.kids?.length === 1)
    {
        const inner = findStatement(kind, printScript(n.kids), scope);
        return inner && !inner.not ? { ...inner, not: true } : null;
    }

    return null;
}

/**
 * Written fields a statement of several nodes has no place for (findStatement's `restAt`), kept where they were written:
 * in the block of the template's top-level node `at`, then down the template's own keys `keys` (`[1, ['change_title_holder']]`:
 * inside the title block's change_title_holder). The picker puts them back there when it writes the statement again.
 */
export interface RestAt
{
    at: number;
    keys: string[];
    nodes: SNode[];
}

/**
 * A run of written statements read as one catalog statement whose template is several statements (a def that `saves`
 * its own scope: `do.give_title`'s create / change / resolve). Each template node matches the written node at its place,
 * in the written order; the saved scope's name is the same in every place and kept as written (`change_2` stays); a
 * value written inside the template's scope switch (ScopeParam.switched) is read back through outOfPrev, so the picker
 * writes it the same again (one inPrev never writes: no match). Fields with no place in the template are kept (`restAt`)
 * where the template has a literal key above them; anything else left over: no match.
 */
function findSequence(kind: PickKind, nodes: SNode[]): { def: StatementDef; values: Record<string, string>; restAt?: RestAt[]; } | null
{
    for (const def of STATEMENTS)
    {
        if (def.kind !== kind || !def.saves || def.hidden)
            continue;

        const tpl = templateTree(def.script);

        if (tpl.length !== nodes.length)
            continue;

        const values: Record<string, string> = {};
        const restAt: RestAt[] = [];

        if (!tpl.every((t, i) => matchDeep(t, nodes[i], def, values, { at: i, keys: [] }, restAt)))
            continue;

        let ok = !!values[def.saves.name] && /^\w+$/.test(values[def.saves.name]);

        for (const p of allParams(def))
        {
            if (p.kind !== 'scope' || !p.switched || !values[p.name])
                continue;

            const out = outOfPrev(values[p.name]);

            if (out === undefined)
                ok = false;
            else
                values[p.name] = out;
        }

        if (!ok)
            continue;

        for (const p of allParams(def))
            if (p.optional !== undefined)
                values[p.name] ??= '';

        return { def, values, ...(restAt.length ? { restAt } : {}) };
    }

    return null;
}

/**
 * matchNode for one node of a statement of several (findSequence): its block's fields in any order, optional ones may
 * be missing; the fields left over are kept in `restAt` under `where` while every template key above them is literal.
 */
function matchDeep(t: SNode, s: SNode, def: StatementDef, vals: Record<string, string>, where: { at: number; keys: string[]; }, restAt: RestAt[]): boolean
{
    if (!matchText(t.k, s.k, def, vals) || t.op !== s.op)
        return false;

    if (!t.kids)
        return !s.kids && matchText(t.v ?? '', s.v ?? '', def, vals);

    if (!s.kids)
        return false;

    const used = new Set<number>();

    for (const tn of t.kids)
    {
        const inner = { at: where.at, keys: [...where.keys, tn.k] };
        let found = -1;

        for (let j = 0; j < s.kids.length && found < 0; j++)
        {
            if (used.has(j))
                continue;

            const trial = { ...vals };
            const trialRest: RestAt[] = [];

            if (matchDeep(tn, s.kids[j], def, trial, inner, trialRest))
            {
                found = j;
                Object.assign(vals, trial);
                restAt.push(...trialRest);
            }
        }

        if (found >= 0)
        {
            used.add(found);
            continue;
        }

        const names = placeholdersOf(tn);

        if (!names.length || !names.every((n) => isOptional(def, n)))
            return false;

        for (const n of names)
            vals[n] ??= '';
    }

    const left = s.kids.filter((_x, j) => !used.has(j));

    if (!left.length)
        return true;

    // (a place the picker can find again: the top-level node, then literal keys only)
    if (where.keys.some((k) => k.includes('‹')))
        return false;

    restAt.push({ at: where.at, keys: where.keys, nodes: left });
    return true;
}
