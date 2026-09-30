/**
 * Knowledge about how CK3 lays out its definitions and how script references them.
 * See docs/game-structure.md and docs/indexer.md for the reasoning behind these rules.
 */
import type { PNode } from './parser.ts';

// ---------------------------------------------------------------------------
// Type ids and presentation
// ---------------------------------------------------------------------------

export const T_EVENT = 'events';
export const T_ON_ACTION = 'on_action';
export const T_SCRIPTED_TRIGGER = 'scripted_triggers';
export const T_SCRIPTED_EFFECT = 'scripted_effects';
export const T_LOC = 'localization';
export const T_FLAG = 'flag';
export const T_VARIABLE = 'variable';
export const T_CHARACTER = 'characters';
export const T_FAITH = 'faith';
export const T_TITLE = 'landed_titles';
export const T_IMAGE = 'images';
export const T_MODEL = 'models';

/** Pinned types shown first in the sidebar, in this order. */
export const CORE_TYPES = [
    T_EVENT,
    T_ON_ACTION,
    'decisions',
    'character_interactions',
    'story_cycles',
    T_SCRIPTED_EFFECT,
    T_SCRIPTED_TRIGGER,
    'script_values',
    'scripted_modifiers',
    'traits',
    'modifiers',
    'opinion_modifiers',
    'schemes/scheme_types',
    'activities/activity_types',
    'laws',
    'buildings',
    'culture/cultures',
    'culture/traditions',
    T_FAITH,
    T_TITLE,
    'customizable_localization'
];

const LABEL_OVERRIDES: Record<string, string> = {
    [T_EVENT]: 'Events',
    [T_ON_ACTION]: 'On Actions',
    [T_FAITH]: 'Faiths',
    [T_TITLE]: 'Landed Titles',
    [T_LOC]: 'Localization',
    [T_FLAG]: 'Flags',
    [T_VARIABLE]: 'Variables',
    [T_CHARACTER]: 'Historical Characters',
    [T_IMAGE]: 'Images',
    [T_MODEL]: '3D Models',
    law_groups: 'Law Groups',
    game_rule_options: 'Game Rule Options',
    'religion/religion_types': 'Religions',
    'schemes/scheme_types': 'Schemes',
    'activities/activity_types': 'Activities'
};

/** Sub-folder names that mean nothing without their parent folder (court_positions/types, schemes/pulse_actions …). */
const GENERIC_SUBTYPES = new Set([
    'types',
    'tasks',
    'intents',
    'pulse_actions',
    'features',
    'feature_groups',
    'catalysts',
    'contracts',
    'groups',
    'visuals',
    'slots',
    'templates',
    'blueprints',
    'options',
    'buildings',
    'obligations',
    'situations',
    'struggles',
    'bookmarks',
    'dynamic_definitions',
    'template_lists',
    'coat_of_arms'
]);

function humanize(s: string): string
{
    return s
        .split('_')
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(' ');
}

export function typeLabel(type: string): string
{
    if (LABEL_OVERRIDES[type])
        return LABEL_OVERRIDES[type];

    const parts = type.split('/');
    const last = parts[parts.length - 1];

    if (parts.length > 1 && GENERIC_SUBTYPES.has(last))
        return `${humanize(parts[parts.length - 2])}: ${humanize(last)}`;

    return humanize(last);
}

/** Sidebar group of a type. */
export function typeGroup(type: string): string
{
    if (CORE_TYPES.includes(type))
        return 'Core';

    if (type === T_LOC)
        return 'Localization';

    if (type === T_IMAGE || type === T_MODEL)
        return 'Graphics';

    if (type === T_FLAG || type === T_VARIABLE)
        return 'Implicit';

    if (type === T_CHARACTER)
        return 'History';

    if (type === T_FAITH || type.startsWith('religion/'))
        return 'religion';

    if (type === 'laws' || type === 'law_groups')
        return 'laws';

    if (type === 'game_rules' || type === 'game_rule_options')
        return 'game_rules';

    const slash = type.indexOf('/');
    return slash > 0 ? type.slice(0, slash) : 'Common';
}

function singular(type: string): string
{
    const last = type.slice(type.lastIndexOf('/') + 1);

    if (last.endsWith('ies'))
        return last.slice(0, -3) + 'y';

    if (last.endsWith('s'))
        return last.slice(0, -1);

    return last;
}

/** Localization keys that may hold the display name of a definition, in priority order. */
export function displayNameCandidates(type: string, name: string): string[]
{
    const s = singular(type);

    switch (type)
    {
        case 'traits':
            return [`trait_${name}`, name];
        case 'game_concepts':
            return [`game_concept_${name}`, name];
        case 'lifestyle_perks':
            return [`${name}_name`, name];
        case 'nicknames':
            return [name];
        case 'game_rules':
            return [`rule_${name}`, name];
        case 'game_rule_options':
            return [`setting_${name}`, name];
        case 'diarchies/diarchy_mandates':
            return [`${name}_mandate`, name];
        case 'succession_election':
            return [`${name}_succession_law`, name];
        // (the plain key can be an unrelated word: sword = "sword sheath")
        case 'artifacts/types':
            return [`artifact_${name}`, name];
        case 'legends/chronicles':
            return [`legend_chronicle_${name}`, name];
        case 'message_filter_types':
            return [`message_filter_${name}`, name];
        case 'message_group_types':
            return [`message_group_type_${name}`, name];
        case 'modifier_definition_formats':
            return [`MOD_${name.toUpperCase()}`, name];
    }

    return [name, `${name}_name`, `${s}_${name}`, `${s}_${name}_name`, `${name}_title`];
}

export function descriptionCandidates(type: string, name: string): string[]
{
    const s = singular(type);

    switch (type)
    {
        case 'traits':
            return [`trait_${name}_desc`, `trait_${name}_character_desc`];
        case 'game_concepts':
            return [`game_concept_${name}_desc`];
        case 'game_rule_options':
            return [`setting_${name}_desc`];
        case 'diarchies/diarchy_mandates':
            return [`${name}_mandate_desc`];
        case 'legends/chronicles':
            return [`legend_chronicle_${name}_desc`];
        case 'message_filter_types':
            return [`message_filter_${name}_desc`];
        // (`<key>_desc` of these is an unrelated text)
        case 'event_backgrounds':
        case 'event_themes':
        case 'modifier_definition_formats':
            return [];
    }

    return [`${name}_desc`, `${s}_${name}_desc`, `${name}_description`];
}

// ---------------------------------------------------------------------------
// Reference resolution rules
// ---------------------------------------------------------------------------

/**
 * Types whose names are too generic to match by name alone (e.g. event_themes has `family`, `diplomacy`;
 * named_colors reuses culture names; coat_of_arms reuses title names). They are only linked when
 * a context rule (below) explicitly asks for them.
 */
export const CONTEXT_ONLY_TYPES = new Set([
    'event_themes',
    'event_backgrounds',
    'event_transitions',
    'event_2d_effects',
    'scripted_animations',
    'game_concepts',
    'named_colors',
    'connection_arrows',
    'graphical_unit_types',
    'portrait_types',
    'genes',
    'ethnicities',
    'dna_data',
    'artifacts/visuals',
    'artifacts/slots',
    'artifacts/features',
    'artifacts/feature_groups',
    'activities/activity_group_types',
    'situation/situation_group_types',
    'message_group_types',
    'message_filter_types',
    'decision_group_types',
    'casus_belli_groups',
    'character_backgrounds',
    'accolade_icons',
    'legends/legend_types',
    'vassal_stances',
    'house_relation_types',
    'courtier_guest_management',
    'guest_system',
    'console_groups',
    'tutorial_lessons',
    'tutorial_lesson_chains',
    'suggestions',
    'playable_difficulty_infos',
    'ruler_objective_advice_types',
    'achievements',
    'bookmark_portraits',
    'bookmarks/bookmarks',
    'bookmarks/groups',
    'bookmarks/challenge_characters',
    'coat_of_arms/coat_of_arms',
    'coat_of_arms/dynamic_definitions',
    'coat_of_arms/options',
    'coat_of_arms/template_lists',
    'culture/creation_names',
    'culture/name_equivalency',
    'defines',
    'defines/ai',
    'defines/audio',
    'defines/graphic',
    'defines/jomini',
    'modifier_definition_formats',
    'modifier_icons',
    'flavorization',
    'effect_localization',
    'trigger_localization',
    'dynasty_house_motto_inserts',
    'dynasty_house_mottos',
    'dynasties',
    'combat_effects',
    'combat_phase_events',
    'court_types',
    'terrain_types',
    'game_rules',
    'law_groups',
    'domiciles/buildings',
    'domiciles/types'
]);

/** Types that can be used as a *key* (called like a function). */
export const CALLABLE_TYPES = new Set([T_SCRIPTED_TRIGGER, T_SCRIPTED_EFFECT, 'script_values', 'scripted_modifiers']);

/** Types that may be referenced by a plain number in the right context. */
export const NUMERIC_TYPES = new Set([T_CHARACTER, 'dynasties']);

/**
 * Context rules: key (or `parent.key`) → preferred target types for the scalar value under it.
 * Used to disambiguate names defined in several types, to allow context-only types, and numeric IDs.
 */
export const CONTEXT_RULES: Record<string, string[]> = {
    has_trait: ['traits'],
    add_trait: ['traits'],
    add_trait_force_tooltip: ['traits'],
    remove_trait: ['traits'],
    remove_trait_force_tooltip: ['traits'],
    trait: ['traits'],
    has_inactive_trait: ['traits'],
    opposites: ['traits'],
    virtues: ['traits'],
    sins: ['traits'],
    trigger_event: [T_EVENT],
    'trigger_event.id': [T_EVENT],
    'trigger_event.on_action': [T_ON_ACTION],
    events: [T_EVENT],
    random_events: [T_EVENT],
    first_valid: [T_EVENT],
    on_action: [T_ON_ACTION],
    on_actions: [T_ON_ACTION],
    random_on_actions: [T_ON_ACTION],
    first_valid_on_action: [T_ON_ACTION],
    fallback: [T_ON_ACTION],
    theme: ['event_themes'],
    override_background: ['event_backgrounds'],
    'override_background.reference': ['event_backgrounds'],
    background: ['event_backgrounds'],
    transition: ['event_transitions'],
    override_effect_2d: ['event_2d_effects'],
    'add_opinion.modifier': ['opinion_modifiers'],
    'reverse_add_opinion.modifier': ['opinion_modifiers'],
    'has_opinion_modifier.modifier': ['opinion_modifiers'],
    'reverse_has_opinion_modifier.modifier': ['opinion_modifiers'],
    'remove_opinion.modifier': ['opinion_modifiers'],
    'reverse_remove_opinion.modifier': ['opinion_modifiers'],
    'opinion.modifier': ['opinion_modifiers'],
    modifier: ['modifiers'],
    has_character_modifier: ['modifiers'],
    remove_character_modifier: ['modifiers'],
    has_county_modifier: ['modifiers'],
    remove_county_modifier: ['modifiers'],
    has_province_modifier: ['modifiers'],
    remove_province_modifier: ['modifiers'],
    has_dynasty_modifier: ['modifiers'],
    has_house_modifier: ['modifiers'],
    dynasty: ['dynasties'],
    father: [T_CHARACTER],
    mother: [T_CHARACTER],
    real_father: [T_CHARACTER],
    employer: [T_CHARACTER],
    add_spouse: [T_CHARACTER],
    add_matrilineal_spouse: [T_CHARACTER],
    add_concubine: [T_CHARACTER],
    holder: [T_CHARACTER],
    character: [T_CHARACTER],
    liege: [T_TITLE],
    de_jure_liege: [T_TITLE],
    capital: [T_TITLE],
    culture: ['culture/cultures'],
    set_culture: ['culture/cultures'],
    religion: [T_FAITH, 'religion/religion_types'],
    faith: [T_FAITH],
    set_character_faith: [T_FAITH],
    set_character_faith_with_conversion: [T_FAITH],
    has_perk: ['lifestyle_perks'],
    add_perk: ['lifestyle_perks'],
    has_focus: ['focuses'],
    set_focus: ['focuses'],
    give_nickname: ['nicknames'],
    has_nickname: ['nicknames'],
    has_doctrine: ['religion/doctrine_types'],
    doctrine: ['religion/doctrine_types'],
    doctrine_types: ['religion/doctrine_types'],
    has_cultural_tradition: ['culture/traditions'],
    add_culture_tradition: ['culture/traditions'],
    has_cultural_pillar: ['culture/pillars'],
    has_innovation: ['culture/innovations'],
    add_innovation: ['culture/innovations'],
    has_realm_law: ['laws'],
    add_realm_law: ['laws'],
    add_realm_law_skip_effects: ['laws'],
    has_building: ['buildings'],
    add_building: ['buildings'],
    has_building_or_higher: ['buildings'],
    'start_scheme.type': ['schemes/scheme_types'],
    'add_secret.type': ['secret_types'],
    'add_hook.type': ['hook_types'],
    'add_hook_no_toast.type': ['hook_types'],
    government: ['governments'],
    has_government: ['governments'],
    change_government: ['governments'],
    has_game_rule: ['game_rule_options'],
    dna: ['dna_data'],
    game_concept: ['game_concepts'],
    coat_of_arms: ['coat_of_arms/coat_of_arms'],
    animation: ['scripted_animations'],
    terrain: ['terrain_types'],
    has_terrain: ['terrain_types'],
    ethnicity: ['ethnicities'],
    ethnicities: ['ethnicities'],
    court_type: ['court_types'],
    vassal_stance: ['vassal_stances'],
    has_vassal_stance: ['vassal_stances']
};

/** How script names an entry of a type (`trait:brave`): the first prefix of PREFIX_TYPES leading to it. */
export function refPrefixOf(type: string): string | undefined
{
    return Object.keys(PREFIX_TYPES).find((p) => PREFIX_TYPES[p].includes(type));
}

/** `prefix:name` event-target lookups → target type. */
export const PREFIX_TYPES: Record<string, string[]> = {
    trait: ['traits'],
    faith: [T_FAITH],
    religion: ['religion/religion_types'],
    culture: ['culture/cultures'],
    title: [T_TITLE],
    character: [T_CHARACTER],
    dynasty: ['dynasties'],
    house: ['dynasty_houses'],
    court_position: ['court_positions/types'],
    court_position_type: ['court_positions/types'],
    culture_pillar: ['culture/pillars'],
    culture_tradition: ['culture/traditions'],
    culture_innovation: ['culture/innovations'],
    doctrine: ['religion/doctrine_types'],
    government_type: ['governments'],
    activity_type: ['activities/activity_types'],
    struggle: ['struggle/struggles'],
    situation: ['situation/situations'],
    accolade_type: ['accolade_types'],
    holy_site: ['religion/holy_site_types'],
    lifestyle: ['lifestyles'],
    focus: ['focuses'],
    perk: ['lifestyle_perks'],
    epidemic_type: ['epidemics'],
    legend_type: ['legends/legend_types'],
    legitimacy_type: ['legitimacy'],
    vassal_contract: ['subject_contracts/contracts'],
    vassal_contract_type: ['subject_contracts/contracts'],
    task_contract_type: ['task_contracts'],
    decision: ['decisions'],
    scheme_type: ['schemes/scheme_types'],
    men_at_arms_type: ['men_at_arms_types'],
    building_type: ['buildings'],
    great_project_type: ['great_projects/types'],
    domicile_type: ['domiciles/types'],
    artifact_type: ['artifacts/types'],
    inspiration_type: ['inspirations'],
    confederation_type: ['confederation_types'],
    mandate_type: ['diarchies/diarchy_mandates'],
    diarchy_type: ['diarchies/diarchy_types'],
    house_aspiration: ['house_aspirations'],
    house_relation_type: ['house_relation_types'],
    law: ['laws'],
    nickname: ['nicknames'],
    government: ['governments'],
    secret_type: ['secret_types'],
    hook_type: ['hook_types'],
    game_concept: ['game_concepts'],
    story_type: ['story_cycles'],
    dynasty_perk: ['dynasty_perks'],
    legacy_track: ['dynasty_legacies']
};

export const VARIABLE_PREFIXES = new Set(['var', 'local_var', 'global_var', 'dead_var']);

/** Words that are never references. */
export const STOP_WORDS = new Set([
    'yes',
    'no',
    'root',
    'this',
    'prev',
    'from',
    'none',
    'all',
    'always',
    'never',
    'true',
    'false',
    'and',
    'or',
    'not',
    'male',
    'female',
    'value',
    'desc',
    'name',
    'type',
    'default',
    'scope',
    'flag',
    'var'
]);

const FLAG_KEY = /^(add|has|remove)_\w*flag$/;
const NOT_FLAG_KEY = new Set(['has_trait_with_flag', 'has_realm_law_flag', 'has_government_flag', 'has_holding_type_flag']);
const VARIABLE_KEY = /variable/;

export function isFlagKey(key: string | null): boolean
{
    return key !== null && FLAG_KEY.test(key) && !NOT_FLAG_KEY.has(key);
}

export function isVariableKey(key: string | null): boolean
{
    return key !== null && VARIABLE_KEY.test(key);
}

// ---------------------------------------------------------------------------
// Definition extraction
// ---------------------------------------------------------------------------

export interface DefEmit
{
    type: string;
    name: string;
    node: PNode;
    local?: boolean;
    /** Enclosing definition node (nested titles, faiths in religions, laws in groups). */
    parent?: PNode;
    /** Node that starts the definition in the source (e.g. the bare `scripted_trigger` keyword). */
    startNode?: PNode;
}

/** Folders under common/ that are skipped entirely. */
const SKIPPED_COMMON = new Set(['province_terrain']);

/**
 * Normalizes a common/ subpath to a type id. Subfolders become their own type unless the top folder has
 * script files directly inside it (then subfolders are just organizational, e.g. on_action/dlc/ep3).
 */
export function commonTypeFor(relDir: string, topHasDirectFiles: boolean): string
{
    if (relDir === '' || relDir === '.')
        return 'common';

    const top = relDir.split('/')[0];

    if (topHasDirectFiles)
        return top;

    const parts = relDir.split('/');
    return parts.slice(0, 2).join('/');
}

function isBlock(n: PNode): n is PNode & { v: PNode[]; }
{
    return Array.isArray(n.v);
}

const TITLE_KEY = /^[hekdcb]_/;

function emitTitles(n: PNode, parent: PNode | undefined, emit: (d: DefEmit) => void): void
{
    if (!isBlock(n))
        return;

    if (n.k && TITLE_KEY.test(n.k))
    {
        emit({ type: T_TITLE, name: n.k, node: n, parent });

        for (const c of n.v)
            if (c.k && TITLE_KEY.test(c.k))
                emitTitles(c, n, emit);
    }
}

/**
 * Extracts definitions from a parsed file.
 * @param area 'common' | 'events' | 'history/characters'
 * @param type  normalized type for common files
 */
export function extractDefs(area: string, type: string, ast: PNode[], emit: (d: DefEmit) => void): void
{
    if (area === 'events')
    {
        let pendingKeyword: PNode | null = null;

        for (const n of ast)
        {
            if (n.k === null && typeof n.v === 'string' && (n.v === 'scripted_trigger' || n.v === 'scripted_effect'))
            {
                pendingKeyword = n;
                continue;
            }

            if (n.k && isBlock(n))
            {
                if (pendingKeyword)
                {
                    const t = pendingKeyword.v === 'scripted_trigger' ? T_SCRIPTED_TRIGGER : T_SCRIPTED_EFFECT;
                    emit({ type: t, name: n.k, node: n, local: true, startNode: pendingKeyword });
                }
                else if (!n.k.startsWith('@'))
                {
                    emit({ type: T_EVENT, name: n.k, node: n });
                }
            }

            pendingKeyword = null;
        }

        return;
    }

    if (area === 'history/characters')
    {
        for (const n of ast)
            if (n.k && isBlock(n))
                emit({ type: T_CHARACTER, name: n.k, node: n });

        return;
    }

    if (SKIPPED_COMMON.has(type))
        return;

    switch (type)
    {
        case T_TITLE:
            for (const n of ast)
                emitTitles(n, undefined, emit);

            return;
        case 'religion/religion_types':
            for (const n of ast)
            {
                if (!n.k || !isBlock(n) || n.k.startsWith('@'))
                    continue;

                emit({ type, name: n.k, node: n });

                for (const c of n.v)
                {
                    if (c.k === 'faiths' && isBlock(c))
                    {
                        for (const f of c.v)
                            if (f.k && isBlock(f))
                                emit({ type: T_FAITH, name: f.k, node: f, parent: n });
                    }
                }
            }

            return;
        case 'laws':
            for (const n of ast)
            {
                if (!n.k || !isBlock(n) || n.k.startsWith('@'))
                    continue;

                emit({ type: 'law_groups', name: n.k, node: n });

                // (`can_change_law_group`: the group's own condition, no law)
                for (const c of n.v)
                    if (c.k && c.k !== 'can_change_law_group' && isBlock(c))
                        emit({ type: 'laws', name: c.k, node: c, parent: n });
            }

            return;
        case 'game_rules':
            for (const n of ast)
            {
                if (!n.k || !isBlock(n) || n.k.startsWith('@'))
                    continue;

                emit({ type: 'game_rules', name: n.k, node: n });

                for (const c of n.v)
                {
                    if (c.k && c.k !== 'categories' && isBlock(c))
                        emit({ type: 'game_rule_options', name: c.k, node: c, parent: n });
                }
            }

            return;
        case 'genes':
            // color_genes/morph_genes/age_presets/… = { gene = {} }, and special_genes = { morph_genes = { gene = {} } accessory_genes = { … } }
            for (const n of ast)
            {
                if (!n.k || !isBlock(n) || n.k.startsWith('@'))
                    continue;

                for (const c of n.v)
                {
                    if (!c.k || !isBlock(c))
                        continue;

                    if (n.k === 'special_genes' && (c.k === 'morph_genes' || c.k === 'accessory_genes'))
                    {
                        for (const g of c.v)
                            if (g.k && isBlock(g))
                                emit({ type: 'genes', name: g.k, node: g });
                    }
                    else
                        emit({ type: 'genes', name: c.k, node: c });
                }
            }

            return;
        case 'named_colors':
            for (const n of ast)
            {
                if (n.k === 'colors' && isBlock(n))
                {
                    for (const c of n.v)
                        if (c.k)
                            emit({ type, name: c.k, node: c });
                }
            }

            return;
    }

    for (const n of ast)
    {
        if (!n.k || n.k.startsWith('@') || n.k === '')
            continue;

        if (isBlock(n) || type === 'script_values' || type === 'scripted_lists')
            emit({ type, name: n.k, node: n });
    }
}
