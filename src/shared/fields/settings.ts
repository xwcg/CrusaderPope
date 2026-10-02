/**
 * Field sets of the types whose statements show as "Settings" (no card builder of their own: decisions, interactions,
 * buildings, casus belli, schemes …), of historical characters, and of a trait's opposites, compatibility and
 * experience tracks: merged into FIELDS (fieldCatalog.ts). Chosen and typed by scripts/field-survey.ts (the keys the
 * game's definitions write, their value kinds and the type's .info comments); keys a set lacks stay script.
 */
import type { FieldDef } from '../fieldCatalog.ts';

/** A yes/no setting that reads as its label (`no`: "Not …" unless given). */
const yes = (key: string, label: string, help?: string, no?: string, k?: string): FieldDef => ({ key, label, kind: 'bool', read: { yes: label, no: no ?? `Not: ${label.charAt(0).toLowerCase()}${label.slice(1)}` }, ...(help ? { help } : {}), ...(k ? { k } : {}) });

/** A number ("Label: $"); `type`/`key`: the named values the game writes for it are offered too (script values). */
const num = (key: string, label: string, presets: number[], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind: 'number', presets, read: `${label}: $`, ...extra });

/** A text value — a text key, a file, a name ("Label: $"), with the values the game writes for it (`suggest`). */
const text = (type: string, key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: label + '…', kind: 'text', suggest: `values:${type}:${key}`, read: `${label}: $`, ...extra });

/** An entry of an index type ("Label: $", the entry linked). */
const entry = (key: string, label: string, ref: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: label + '…', kind: 'ref', ref, read: `${label}: $`, ...extra });

/** One of fixed values. */
const pick = (key: string, label: string, options: [string, string][], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: label + '…', kind: 'choice', options, read: `${label}: $`, ...extra });

const SKILLS: [string, string][] = [
    ['diplomacy', 'Diplomacy'],
    ['martial', 'Martial'],
    ['stewardship', 'Stewardship'],
    ['intrigue', 'Intrigue'],
    ['learning', 'Learning'],
    ['prowess', 'Prowess']
];

const TIERS: [string, string][] = [
    ['county', 'County'],
    ['duchy', 'Duchy'],
    ['kingdom', 'Kingdom'],
    ['empire', 'Empire'],
    ['hegemony', 'Hegemony']
];

export const SETTINGS_FIELDS: Record<string, FieldDef[]> = {
    // common/decisions/_decisions.info
    decisions: [
        text('decisions', 'desc', 'Description', { k: 'd', help: 'Its text key (default: <key>_desc)' }),
        entry('decision_group_type', 'Group', 'decision_group_types', { k: 'g', help: 'The foldable group in the decision list (default: decisions)' }),
        text('decisions', 'selection_tooltip', 'Tooltip in the list', { k: 't', help: 'Its text key (default: <key>_tooltip)' }),
        text('decisions', 'title', 'Title', { help: 'Its text key (default: <key>)' }),
        text('decisions', 'confirm_text', 'Confirm button text', { k: 'c' }),
        num('sort_order', 'Sort order', [0, 50, 80, 100, 120, 200], { k: 's', read: 'Sort order $ (higher first)' }),
        num('ai_check_interval', 'AI checks it every … months', [0, 6, 12, 24, 36, 60, 120], { k: 'a', read: 'The AI checks it every $ months', help: '0: the AI never takes it' }),
        yes('ai_goal', 'An AI goal', 'The AI saves up for it (no check interval needed)'),
        yes('is_invisible', 'Invisible', 'Not listed; only taken by script')
    ],
    // common/character_interactions/_character_interactions.info
    character_interactions: [
        entry('category', 'Category', 'character_interaction_categories', { k: 'c', help: 'Required: the group in the interaction menu' }),
        text('character_interactions', 'icon', 'Icon', { k: 'i' }),
        text('character_interactions', 'desc', 'Description', { k: 'd' }),
        yes('auto_accept', 'Accepted automatically', 'Else the recipient decides', 'The recipient decides', 'a'),
        num('interface_priority', 'Menu priority', [-1, 20, 30, 50, 60, 120], { k: 'p', read: 'Priority $ in the menu (higher first)' }),
        yes('common_interaction', 'Common (never under More…)', undefined, undefined, 'o'),
        yes('send_options_exclusive', 'Options exclusive', 'Only one of its send options can be chosen'),
        yes('use_diplomatic_range', 'Needs diplomatic range', 'Yes by default', 'Ignores diplomatic range'),
        text('character_interactions', 'notification_text', 'Request text', { help: 'Shown to the recipient' }),
        pick('greeting', 'Greeting', [['positive', 'Positive'], ['negative', 'Negative']], { k: 'g', help: 'The tone of the request text' }),
        yes('popup_on_receive', 'Pops up for the recipient'),
        yes('pause_on_receive', 'Pauses the game for the recipient'),
        yes('ignores_pending_interaction_block', 'Sent while another waits for an answer'),
        num('ai_min_reply_days', 'AI answers after at least … days', [0, 1, 4, 5], { read: 'The AI answers after at least $ days' }),
        num('ai_max_reply_days', 'AI answers within … days', [0, 5, 9, 10], { read: 'The AI answers within $ days' }),
        yes('ai_maybe', 'The AI answer is random'),
        yes('can_send_despite_rejection', 'Can be sent though the AI would refuse'),
        text('character_interactions', 'send_name', 'Name once sent'),
        pick('target_type', 'Target', [['title', 'A title'], ['artifact', 'An artifact'], ['court_position_type', 'A court position']], { help: 'What else is chosen besides the recipient' }),
        text('character_interactions', 'target_filter', 'Targets from'),
        entry('scheme', 'Starts the scheme', 'schemes/scheme_types'),
        yes('hidden', 'Hidden', 'Not in the menu', undefined, 'h')
    ],
    // common/buildings/_buildings.info
    buildings: [
        num('construction_time', 'Construction time (days)', [180, 365, 730, 1095, 1825], { k: 't', suggest: 'values:buildings:construction_time', read: 'Takes $ days to build', help: 'A number or a named value (slow_construction_time …)' }),
        num('cost_gold', 'Gold cost', [50, 100, 200, 500, 1000], { k: 'g', suggest: 'values:buildings:cost_gold', read: 'Costs $ gold' }),
        num('cost_prestige', 'Prestige cost', [50, 100, 200, 500], { k: 'p', suggest: 'values:buildings:cost_prestige', read: 'Costs $ prestige' }),
        num('cost_piety', 'Piety cost', [50, 100, 200, 500], { suggest: 'values:buildings:cost_piety', read: 'Costs $ piety' }),
        entry('next_building', 'Upgrades to', 'buildings', { k: 'n', help: 'The next building of the chain' }),
        pick('type', 'Kind', [['regular', 'Regular'], ['special', 'Special'], ['duchy_capital', 'Duchy capital'], ['great_building', 'Great building']], { k: 'k' }),
        text('buildings', 'flag', 'Flag', { k: 'f', help: 'Checked by triggers (has_building_with_flag); several are allowed' }),
        text('buildings', 'type_icon', 'Icon', { k: 'i' }),
        text('buildings', 'effect_desc', 'Custom effect text', { help: 'Describes what it gives indirectly' }),
        num('levy', 'Levies', [50, 100, 200, 500], { k: 'l', suggest: 'values:buildings:levy', read: 'Gives $ levies' }),
        num('max_garrison', 'Garrison', [50, 100, 200, 500], { suggest: 'values:buildings:max_garrison', read: 'Gives $ garrison' }),
        num('garrison_reinforcement_factor', 'Garrison reinforcement', [0.1, 0.2, 0.3], { suggest: 'values:buildings:garrison_reinforcement_factor' }),
        yes('show_disabled', 'Shown when it can’t be built', 'Still listed (greyed) while can_construct fails', undefined, 's')
    ],
    // common/domiciles/buildings
    'domiciles/buildings': [
        num('construction_time', 'Construction time (days)', [180, 365, 730], { k: 't', suggest: 'values:domiciles/buildings:construction_time', read: 'Takes $ days to build' }),
        entry('previous_building', 'Upgrade of', 'domiciles/buildings', { k: 'p', help: 'Without it: a base building' }),
        pick('slot_type', 'Slot', [['main', 'Main'], ['internal', 'Internal'], ['external', 'External']], { k: 's' }),
        num('internal_slots', 'Internal slots', [1, 2, 3, 4, 5], { k: 'i', read: 'Unlocks $ internal slots' })
    ],
    // common/casus_belli_types/_casus_belli.info
    casus_belli_types: [
        entry('group', 'Group', 'casus_belli_groups', { k: 'g' }),
        text('casus_belli_types', 'war_name', 'War name', { k: 'w' }),
        text('casus_belli_types', 'cb_name', 'Name'),
        text('casus_belli_types', 'icon', 'Icon', { k: 'i' }),
        num('interface_priority', 'List priority', [60, 80, 100, 120], { k: 'p', read: 'Priority $ in the list (higher first)' }),
        pick('target_titles', 'Targets', [['all', 'All titles'], ['claim', 'Claimed titles'], ['de_jure', 'De jure titles'], ['neighbor_land', 'Neighboring land'], ['neighbor_land_or_water', 'Neighboring land or across water'], ['none', 'No title']], { k: 't' }),
        pick('target_title_tier', 'Target tier', [['all', 'Any'], ['county', 'County'], ['duchy', 'Duchy'], ['kingdom', 'Kingdom'], ['empire', 'Empire']]),
        num('attacker_wargoal_percentage', 'War goal share to win', [0.5, 0.8, 1], { read: 'The attacker must hold $ of the war goal' }),
        num('max_attacker_score_from_occupation', 'Attacker score from occupation (max)', [50, 100, 150]),
        num('max_defender_score_from_occupation', 'Defender score from occupation (max)', [50, 100, 150]),
        num('max_attacker_score_from_battles', 'Attacker score from battles (max)', [50, 100, 150, 200]),
        num('max_defender_score_from_battles', 'Defender score from battles (max)', [50, 100, 150, 200]),
        yes('attacker_allies_inherit', 'Attacker’s allies stay in the war'),
        yes('defender_allies_inherit', 'Defender’s allies stay in the war'),
        pick('on_primary_attacker_death', 'When the attacker dies', [['inherit', 'The heir inherits the war'], ['invalidate', 'The war ends'], ['inherit_faction', 'The faction inherits it']]),
        pick('on_primary_defender_death', 'When the defender dies', [['inherit', 'The heir inherits the war'], ['invalidate', 'The war ends']]),
        yes('use_de_jure_wargoal_only', 'Only the de jure war goal'),
        yes('should_show_war_goal_subview', 'Shows the war goal view'),
        yes('combine_into_one', 'One casus belli for all targets'),
        yes('allow_hostages', 'Hostages allowed'),
        yes('white_peace_possible', 'White peace possible'),
        yes('ai_only_against_neighbors', 'AI: only against neighbors'),
        num('max_ai_diplo_distance_to_title', 'AI: farthest target', [500, 1000, 2000])
    ],
    // common/schemes/scheme_types/_schemes.info
    'schemes/scheme_types': [
        pick('skill', 'Skill', SKILLS, { k: 's' }),
        pick('category', 'Category', [['hostile', 'Hostile'], ['personal', 'Personal'], ['political', 'Political'], ['contract', 'Contract']], { k: 'c' }),
        pick('target_type', 'Target', [['character', 'A character'], ['title', 'A title'], ['culture', 'A culture'], ['faith', 'A faith'], ['nothing', 'Nothing']], { k: 't' }),
        text('schemes/scheme_types', 'icon', 'Icon', { k: 'i' }),
        text('schemes/scheme_types', 'illustration', 'Illustration'),
        text('schemes/scheme_types', 'desc', 'Description', { k: 'd' }),
        text('schemes/scheme_types', 'success_desc', 'Success text'),
        num('speed_per_skill_point', 'Speed per skill point', [-2.5, -2, -1], { suggest: 'values:schemes/scheme_types:speed_per_skill_point' }),
        num('base_progress_goal', 'Phase length (days)', [90, 180, 365], { suggest: 'values:schemes/scheme_types:base_progress_goal' }),
        num('base_maximum_success', 'Highest success chance', [50, 80, 95], { suggest: 'values:schemes/scheme_types:base_maximum_success' }),
        num('minimum_success', 'Lowest success chance', [5, 10, 20]),
        num('agent_leave_threshold', 'Agents leave below opinion', [-25, -10, 0]),
        num('maximum_breaches', 'Breaches allowed', [3, 5, 10]),
        num('maximum_secrecy', 'Highest secrecy', [85, 95, 100]),
        yes('is_secret', 'Secret', 'Hidden from its target until discovered', undefined, 'e'),
        yes('uses_resistance', 'Uses resistance'),
        yes('is_basic', 'Basic scheme'),
        yes('freeze_scheme_when_traveling', 'Paused while the owner travels')
    ],
    // common/court_positions/types/_court_positions.info
    'court_positions/types': [
        num('max_available_positions', 'How many can be employed', [1, 2, 3], { k: 'm' }),
        pick('skill', 'Skill', SKILLS, { k: 's' }),
        pick('minimum_rank', 'Lowest rank of the employer', TIERS, { k: 'r' }),
        num('sort_order', 'Sort order', [10, 50, 100]),
        yes('is_powerful_agent', 'A powerful agent'),
        text('court_positions/types', 'custom_employer_modifier_description', 'Custom text for the employer')
    ],
    // common/lifestyle_perks/_lifestyle_perks.info
    lifestyle_perks: [
        entry('lifestyle', 'Lifestyle', 'lifestyles', { k: 'l' }),
        text('lifestyle_perks', 'tree', 'Tree', { k: 't', help: 'Only for the layout of the lifestyle screen' }),
        entry('parent', 'Needs the perk', 'lifestyle_perks', { k: 'p' }),
        text('lifestyle_perks', 'icon', 'Icon', { k: 'i' }),
        entry('trait', 'Unlocks the trait', 'traits', { help: 'Shown in its tooltip' })
    ],
    // common/focuses/_focuses.info
    focuses: [
        entry('lifestyle', 'Lifestyle', 'lifestyles', { k: 'l' }),
        pick('type', 'Kind', [['lifestyle', 'Lifestyle focus'], ['education', 'Education focus']], { k: 't' }),
        pick('skill', 'Skill', SKILLS, { k: 's' })
    ],
    // common/secret_types/_secret_types.info
    secret_types: [text('secret_types', 'category', 'Category', { k: 'c' })],
    // common/task_contracts/_task_contracts.info
    task_contracts: [
        text('task_contracts', 'group', 'Group', { k: 'g' }),
        text('task_contracts', 'icon', 'Icon', { k: 'i' }),
        yes('travel', 'The taker travels there', undefined, undefined, 't'),
        yes('use_diplomatic_range', 'Within diplomatic range'),
        yes('is_criminal', 'Criminal', undefined, undefined, 'c')
    ],
    // common/activities/activity_types/_activity_type.info
    'activities/activity_types': [
        num('max_guests', 'Most guests', [20, 30, 50, 100], { k: 'g' }),
        yes('is_single_location', 'In one place', undefined, 'In several places', 's'),
        yes('open_invite', 'Open invitation'),
        yes('allow_zero_guest_invites', 'Can start without guests'),
        text('activities/activity_types', 'province_filter', 'Where', { k: 'w' }),
        text('activities/activity_types', 'ai_province_filter', 'Where the AI holds it'),
        num('max_province_icons', 'Most map icons', [1, 3, 5]),
        num('ai_check_interval', 'AI checks every … months', [6, 36, 60], { read: 'The AI checks it every $ months' }),
        yes('can_always_plan', 'Can always be planned')
    ],
    // history/characters: a character's own fields (their traits: `character_history`; dated changes: their life)
    characters: [
        { key: 'name', label: 'Name…', kind: 'text', k: 'n', free: true, read: 'Name: $', help: 'A name or its text key' },
        yes('female', 'Female', undefined, 'Male', 'f'),
        entry('dynasty', 'Dynasty', 'dynasties', { k: 'd' }),
        entry('dynasty_house', 'House', 'dynasty_houses', { k: 'h' }),
        entry('culture', 'Culture', 'culture/cultures', { k: 'c' }),
        entry('religion', 'Faith', 'faith', { k: 'r' }),
        entry('faith', 'Faith (written faith = …)', 'faith'),
        // (1.20: a rite wins over the faith — its faith at the date)
        entry('rite', 'Rite', 'religion/rite_types', { k: 'i' }),
        // (a character id typed — 70,000 of them; read as the character)
        { key: 'father', label: 'Father (character id)…', kind: 'text', ref: 'characters', k: 'a', read: 'Father: $' },
        { key: 'mother', label: 'Mother (character id)…', kind: 'text', ref: 'characters', k: 'm', read: 'Mother: $' },
        ...SKILLS.map(([key, label]): FieldDef => ({ key, label, kind: 'number', presets: [2, 5, 8, 10, 12, 15, 20], read: `${label} $` })),
        pick('sexuality', 'Sexuality', [['heterosexual', 'Heterosexual'], ['homosexual', 'Homosexual'], ['bisexual', 'Bisexual'], ['asexual', 'Asexual']], { k: 's' }),
        yes('disallow_random_traits', 'No random traits', 'The game gives them no random traits at start'),
        entry('dna', 'Appearance (DNA)', 'dna_data')
    ],
    // common/traits/_traits.info: `opposites = { craven }` — a trait each
    trait_opposites: [{ key: 'trait', label: 'Opposite trait…', kind: 'ref', ref: 'traits', bare: true, k: 't', read: 'Opposite of $' }],
    // common/traits/_traits.info: `compatibility = { brave = 15 }` — any trait, how well they get along
    trait_compatibility: [{ key: '*', anyKey: 'traits', label: 'With the trait…', kind: 'number', signed: true, tone: 'good', k: 't', presets: [5, 10, 15, 20, 30, -5, -10, -15, -20, -30], read: '$ with %k' }],
    // common/traits/_traits.info: `track = { 50 = { <modifiers> } }` — the modifiers from an amount of experience on
    trait_track: [{ key: '#', label: 'A level (experience)…', kind: 'level', k: 'l', presets: [20, 25, 40, 50, 60, 75, 80, 100], read: 'From $ experience' }]
};
