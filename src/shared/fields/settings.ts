/**
 * Field sets of the types whose statements show as "Settings" (no card builder of their own: decisions, interactions,
 * buildings, casus belli, schemes …), of historical characters, and of a trait's opposites, compatibility and
 * experience tracks: merged into FIELDS (fieldCatalog.ts). Chosen and typed by scripts/field-survey.ts (the keys the
 * game's definitions write, their value kinds and the type's .info comments); keys a set lacks stay script.
 */
import type { FieldDef } from '../fieldCatalog.ts';

import { tr } from '../i18n.ts';
/** A yes/no setting that reads as its label (`no`: "Not …" unless given). */
const yes = (key: string, label: string, help?: string, no?: string, k?: string): FieldDef => ({ key, label, kind: 'bool', read: { yes: label, no: no ?? tr('Not: {toLowerCase}{slice}', { toLowerCase: label.charAt(0).toLowerCase(), slice: label.slice(1) }) }, ...(help ? { help } : {}), ...(k ? { k } : {}) });

/** A number ("Label: $"); `type`/`key`: the named values the game writes for it are offered too (script values). */
const num = (key: string, label: string, presets: number[], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind: 'number', presets, read: `${label}: $`, ...extra });

/** A text value: a text key, a file, a name ("Label: $"), with the values the game writes for it (`suggest`). */
const text = (type: string, key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: label + '…', kind: 'text', suggest: `values:${type}:${key}`, read: `${label}: $`, ...extra });

/** An entry of an index type ("Label: $", the entry linked). */
const entry = (key: string, label: string, ref: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: label + '…', kind: 'ref', ref, read: `${label}: $`, ...extra });

/** One of fixed values. */
const pick = (key: string, label: string, options: [string, string][], extra: Partial<FieldDef> = {}): FieldDef => ({ key, label: label + '…', kind: 'choice', options, read: `${label}: $`, ...extra });

const SKILLS: [string, string][] = [
    ['diplomacy', tr('Diplomacy')],
    ['martial', tr('Martial')],
    ['stewardship', tr('Stewardship')],
    ['intrigue', tr('Intrigue')],
    ['learning', tr('Learning')],
    ['prowess', tr('Prowess')]
];

const TIERS: [string, string][] = [
    ['county', tr('County')],
    ['duchy', tr('Duchy')],
    ['kingdom', tr('Kingdom')],
    ['empire', tr('Empire')],
    ['hegemony', tr('Hegemony')]
];

// common/council_tasks/_council_tasks.info `county_target`
const COUNTY_TARGETS: [string, string][] = [
    ['all', tr('Any county')],
    ['realm', tr('In the realm')],
    ['domain', tr('In the domain')],
    ['neighbor_land', tr('Neighboring land')],
    ['neighbor_land_or_water', tr('Neighboring land or across water (AI only)')],
    ['none', tr('None')]
];

/** The sets below that are a block's fields (a block field's `sub`), not a type's: no "Other setting…" of their own. */
export const SETTINGS_SUB_SETS = new Set(['send_option', 'building_asset', 'council_task_asset']);

export const SETTINGS_FIELDS: Record<string, FieldDef[]> = {
    // common/decisions/_decisions.info
    decisions: [
        text('decisions', 'desc', tr('Description'), { k: 'd', loc: '_desc', help: tr('Its text key (default: <key>_desc)') }),
        entry('decision_group_type', tr('Group'), 'decision_group_types', { k: 'g', help: tr('The foldable group in the decision list (default: decisions)') }),
        text('decisions', 'selection_tooltip', tr('Tooltip in the list'), { k: 't', loc: '_tooltip', help: tr('Its text key (default: <key>_tooltip)') }),
        text('decisions', 'title', tr('Title'), { loc: '', help: tr('Its text key (default: <key>)') }),
        text('decisions', 'confirm_text', tr('Confirm button text'), { k: 'c' }),
        num('sort_order', tr('Sort order'), [0, 50, 80, 100, 120, 200], { k: 's', read: tr('Sort order $ (higher first)') }),
        num('ai_check_interval', tr('AI checks it every … months'), [0, 6, 12, 24, 36, 60, 120], { k: 'a', read: tr('The AI checks it every $ months'), help: tr('0: the AI never takes it') }),
        yes('ai_goal', tr('An AI goal'), tr('The AI saves up for it (no check interval needed)')),
        yes('is_invisible', 'Invisible', tr('Not listed; only taken by script'))
    ],
    // common/character_interactions/_character_interactions.info
    character_interactions: [
        entry('category', tr('Category'), 'character_interaction_categories', { k: 'c', help: tr('Required: the group in the interaction menu') }),
        text('character_interactions', 'icon', tr('Icon'), { k: 'i' }),
        text('character_interactions', 'desc', tr('Description'), { k: 'd' }),
        yes('auto_accept', tr('Accepted automatically'), tr('Else the recipient decides'), tr('The recipient decides'), 'a'),
        num('interface_priority', tr('Menu priority'), [-1, 20, 30, 50, 60, 120], { k: 'p', read: tr('Priority $ in the menu (higher first)') }),
        yes('common_interaction', tr('Common (never under More…)'), undefined, undefined, 'o'),
        yes('send_options_exclusive', tr('Options exclusive'), tr('Only one of its send options can be chosen')),
        yes('use_diplomatic_range', tr('Needs diplomatic range'), tr('Yes by default'), tr('Ignores diplomatic range')),
        text('character_interactions', 'notification_text', tr('Request text'), { help: tr('Shown to the recipient') }),
        pick('greeting', tr('Greeting'), [['positive', tr('Positive')], ['negative', tr('Negative')]], { k: 'g', help: tr('The tone of the request text') }),
        yes('popup_on_receive', tr('Pops up for the recipient')),
        yes('pause_on_receive', tr('Pauses the game for the recipient')),
        yes('ignores_pending_interaction_block', tr('Sent while another waits for an answer')),
        num('ai_min_reply_days', tr('AI answers after at least … days'), [0, 1, 4, 5], { read: tr('The AI answers after at least $ days') }),
        num('ai_max_reply_days', tr('AI answers within … days'), [0, 5, 9, 10], { read: tr('The AI answers within $ days') }),
        yes('ai_maybe', tr('The AI answer is random')),
        yes('can_send_despite_rejection', tr('Can be sent though the AI would refuse')),
        text('character_interactions', 'send_name', tr('Name once sent')),
        pick('target_type', tr('Target'), [['title', tr('A title')], ['artifact', tr('An artifact')], ['court_position_type', tr('A court position')]], { help: tr('What else is chosen besides the recipient') }),
        text('character_interactions', 'target_filter', tr('Targets from')),
        entry('scheme', tr('Starts the scheme'), 'schemes/scheme_types'),
        yes('hidden', 'Hidden', tr('Not in the menu'), undefined, 'h'),
        // (one block per option; `is_shown`, `is_valid`, `starts_enabled`, `can_be_changed` are its conditions
        // (_character_interactions.info): a written option keeps them as written while its fields change, model.ts
        // writtenBlock, and "Clear the conditions" drops just them)
        { key: 'send_option', label: tr('Send option…'), kind: 'block', k: 'n', sub: 'send_option', ask: ['flag'], conds: ['is_shown', 'is_valid', 'starts_enabled', 'can_be_changed'], read: tr('A send option'), help: tr('A choice in the interaction window; when chosen, scope:<flag> is yes') }
    ],
    // common/character_interactions/_character_interactions.info: `send_option = { flag = x localization = y }`
    send_option: [
        text('character_interactions', 'flag', tr('Flag'), { k: 'f', suggest: 'nested:character_interactions:flag', help: tr('Its name: scope:<flag> is yes when the option is chosen') }),
        text('character_interactions', 'localization', tr('Label'), { k: 'l', suggest: 'nested:character_interactions:localization', help: tr('Its text key (default: the flag)') }),
        yes('can_invalidate_interaction', tr('Can block sending'), tr('The AI checks the whole interaction again when it picks this option'), undefined, 'i')
    ],
    // common/buildings/_buildings.info
    buildings: [
        num('construction_time', tr('Construction time (days)'), [180, 365, 730, 1095, 1825], { k: 't', suggest: 'values:buildings:construction_time', read: tr('Takes $ days to build'), help: tr('A number or a named value (slow_construction_time …)') }),
        num('cost_gold', tr('Gold cost'), [50, 100, 200, 500, 1000], { k: 'g', suggest: 'values:buildings:cost_gold', read: tr('Costs $ gold') }),
        num('cost_prestige', tr('Prestige cost'), [50, 100, 200, 500], { k: 'p', suggest: 'values:buildings:cost_prestige', read: tr('Costs $ prestige') }),
        num('cost_piety', tr('Piety cost'), [50, 100, 200, 500], { suggest: 'values:buildings:cost_piety', read: tr('Costs $ piety') }),
        entry('next_building', tr('Upgrades to'), 'buildings', { k: 'n', help: tr('The next building of the chain') }),
        pick('type', tr('Kind'), [['regular', tr('Regular')], ['special', tr('Special')], ['duchy_capital', tr('Duchy capital')], ['great_building', tr('Great building')]], { k: 'k' }),
        text('buildings', 'flag', tr('Flag'), { k: 'f', help: tr('Checked by triggers (has_building_with_flag); several are allowed') }),
        text('buildings', 'type_icon', tr('Icon'), { k: 'i' }),
        text('buildings', 'effect_desc', tr('Custom effect text'), { help: tr('Describes what it gives indirectly') }),
        num('levy', tr('Levies'), [50, 100, 200, 500], { k: 'l', suggest: 'values:buildings:levy', read: tr('Gives $ levies') }),
        num('max_garrison', tr('Garrison'), [50, 100, 200, 500], { suggest: 'values:buildings:max_garrison', read: tr('Gives $ garrison') }),
        num('garrison_reinforcement_factor', tr('Garrison reinforcement'), [0.1, 0.2, 0.3], { suggest: 'values:buildings:garrison_reinforcement_factor' }),
        yes('show_disabled', tr('Shown when it can’t be built'), tr('Still listed (greyed) while can_construct fails'), undefined, 's'),
        // (one block per asset; its lists (`graphical_regions = { … }`), a sound written as a block and keys this set does
        // not know are kept as written while its fields change (model.ts writtenBlock); the lists choose the best fitting
        // asset, they are no conditions: no Clear row)
        { key: 'asset', label: tr('Map asset…'), kind: 'block', k: 'a', sub: 'building_asset', ask: ['type'], read: tr('A map asset'), help: tr('The mesh or entity shown on the map (several: the best fitting one)') }
    ],
    // common/buildings/_buildings.info: `asset = { type = pdxmesh name = "…" }`
    building_asset: [
        pick('type', tr('Kind'), [['pdxmesh', tr('Mesh')], ['entity', tr('Entity')]], { k: 't' }),
        text('buildings', 'name', tr('Mesh or entity name'), { k: 'n', suggest: 'nested:buildings:name', free: true }),
        text('buildings', 'illustration', tr('Illustration'), { k: 'i', suggest: 'nested:buildings:illustration', free: true }),
        text('buildings', 'requires_dlc_flag', tr('Only with the DLC'), { k: 'd', suggest: 'nested:buildings:requires_dlc_flag' }),
        text('buildings', 'soundeffect', tr('Sound'), { k: 's', suggest: 'nested:buildings:soundeffect', free: true })
    ],
    // common/domiciles/buildings
    'domiciles/buildings': [
        num('construction_time', tr('Construction time (days)'), [180, 365, 730], { k: 't', suggest: 'values:domiciles/buildings:construction_time', read: tr('Takes $ days to build') }),
        entry('previous_building', tr('Upgrade of'), 'domiciles/buildings', { k: 'p', help: tr('Without it: a base building') }),
        pick('slot_type', tr('Slot'), [['main', tr('Main')], ['internal', tr('Internal')], ['external', tr('External')]], { k: 's' }),
        num('internal_slots', tr('Internal slots'), [1, 2, 3, 4, 5], { k: 'i', read: tr('Unlocks $ internal slots') })
    ],
    // common/casus_belli_types/_casus_belli.info
    casus_belli_types: [
        entry('group', tr('Group'), 'casus_belli_groups', { k: 'g' }),
        text('casus_belli_types', 'war_name', tr('War name'), { k: 'w' }),
        text('casus_belli_types', 'cb_name', tr('Name')),
        text('casus_belli_types', 'icon', tr('Icon'), { k: 'i' }),
        num('interface_priority', tr('List priority'), [60, 80, 100, 120], { k: 'p', read: tr('Priority $ in the list (higher first)') }),
        pick('target_titles', tr('Targets'), [['all', tr('All titles')], ['claim', tr('Claimed titles')], ['de_jure', tr('De jure titles')], ['neighbor_land', tr('Neighboring land')], ['neighbor_land_or_water', tr('Neighboring land or across water')], ['none', tr('No title')]], { k: 't' }),
        pick('target_title_tier', tr('Target tier'), [['all', tr('Any')], ['county', tr('County')], ['duchy', tr('Duchy')], ['kingdom', tr('Kingdom')], ['empire', tr('Empire')]]),
        num('attacker_wargoal_percentage', tr('War goal share to win'), [0.5, 0.8, 1], { read: tr('The attacker must hold $ of the war goal') }),
        num('max_attacker_score_from_occupation', tr('Attacker score from occupation (max)'), [50, 100, 150]),
        num('max_defender_score_from_occupation', tr('Defender score from occupation (max)'), [50, 100, 150]),
        num('max_attacker_score_from_battles', tr('Attacker score from battles (max)'), [50, 100, 150, 200]),
        num('max_defender_score_from_battles', tr('Defender score from battles (max)'), [50, 100, 150, 200]),
        yes('attacker_allies_inherit', tr('Attacker’s allies stay in the war')),
        yes('defender_allies_inherit', tr('Defender’s allies stay in the war')),
        pick('on_primary_attacker_death', tr('When the attacker dies'), [['inherit', tr('The heir inherits the war')], ['invalidate', tr('The war ends')], ['inherit_faction', tr('The faction inherits it')]]),
        pick('on_primary_defender_death', tr('When the defender dies'), [['inherit', tr('The heir inherits the war')], ['invalidate', tr('The war ends')]]),
        yes('use_de_jure_wargoal_only', tr('Only the de jure war goal')),
        yes('should_show_war_goal_subview', tr('Shows the war goal view')),
        yes('combine_into_one', tr('One casus belli for all targets')),
        yes('allow_hostages', tr('Hostages allowed')),
        yes('white_peace_possible', tr('White peace possible')),
        yes('ai_only_against_neighbors', tr('AI: only against neighbors')),
        num('max_ai_diplo_distance_to_title', tr('AI: farthest target'), [500, 1000, 2000])
    ],
    // common/schemes/scheme_types/_schemes.info
    'schemes/scheme_types': [
        pick('skill', tr('Skill'), SKILLS, { k: 's' }),
        pick('category', tr('Category'), [['hostile', tr('Hostile')], ['personal', tr('Personal')], ['political', tr('Political')], ['contract', tr('Contract')]], { k: 'c' }),
        pick('target_type', tr('Target'), [['character', tr('A character')], ['title', tr('A title')], ['culture', tr('A culture')], ['faith', tr('A faith')], ['nothing', tr('Nothing')]], { k: 't' }),
        text('schemes/scheme_types', 'icon', tr('Icon'), { k: 'i' }),
        text('schemes/scheme_types', 'illustration', tr('Illustration')),
        text('schemes/scheme_types', 'desc', tr('Description'), { k: 'd' }),
        text('schemes/scheme_types', 'success_desc', tr('Success text')),
        num('speed_per_skill_point', tr('Speed per skill point'), [-2.5, -2, -1], { suggest: 'values:schemes/scheme_types:speed_per_skill_point' }),
        num('base_progress_goal', tr('Phase length (days)'), [90, 180, 365], { suggest: 'values:schemes/scheme_types:base_progress_goal' }),
        num('base_maximum_success', tr('Highest success chance'), [50, 80, 95], { suggest: 'values:schemes/scheme_types:base_maximum_success' }),
        num('minimum_success', tr('Lowest success chance'), [5, 10, 20]),
        num('agent_leave_threshold', tr('Agents leave below opinion'), [-25, -10, 0]),
        num('maximum_breaches', tr('Breaches allowed'), [3, 5, 10]),
        num('maximum_secrecy', tr('Highest secrecy'), [85, 95, 100]),
        yes('is_secret', 'Secret', tr('Hidden from its target until discovered'), undefined, 'e'),
        yes('uses_resistance', tr('Uses resistance')),
        yes('is_basic', tr('Basic scheme')),
        yes('freeze_scheme_when_traveling', tr('Paused while the owner travels'))
    ],
    // common/court_positions/types/_court_positions.info
    'court_positions/types': [
        num('max_available_positions', tr('How many can be employed'), [1, 2, 3], { k: 'm' }),
        pick('skill', tr('Skill'), SKILLS, { k: 's' }),
        pick('minimum_rank', tr('Lowest rank of the employer'), TIERS, { k: 'r' }),
        num('sort_order', tr('Sort order'), [10, 50, 100]),
        yes('is_powerful_agent', tr('A powerful agent')),
        text('court_positions/types', 'custom_employer_modifier_description', tr('Custom text for the employer'))
    ],
    // common/lifestyle_perks/_lifestyle_perks.info
    lifestyle_perks: [
        entry('lifestyle', tr('Lifestyle'), 'lifestyles', { k: 'l' }),
        text('lifestyle_perks', 'tree', tr('Tree'), { k: 't', help: tr('Only for the layout of the lifestyle screen') }),
        entry('parent', tr('Needs the perk'), 'lifestyle_perks', { k: 'p' }),
        text('lifestyle_perks', 'icon', tr('Icon'), { k: 'i' }),
        entry('trait', tr('Unlocks the trait'), 'traits', { help: tr('Shown in its tooltip') })
    ],
    // common/focuses/_focuses.info
    focuses: [
        entry('lifestyle', tr('Lifestyle'), 'lifestyles', { k: 'l' }),
        pick('type', tr('Kind'), [['lifestyle', tr('Lifestyle focus')], ['education', tr('Education focus')]], { k: 't' }),
        pick('skill', tr('Skill'), SKILLS, { k: 's' })
    ],
    // common/secret_types/_secret_types.info
    secret_types: [text('secret_types', 'category', tr('Category'), { k: 'c' })],
    // common/task_contracts/_task_contracts.info
    task_contracts: [
        text('task_contracts', 'group', tr('Group'), { k: 'g' }),
        text('task_contracts', 'icon', tr('Icon'), { k: 'i' }),
        yes('travel', tr('The taker travels there'), undefined, undefined, 't'),
        yes('use_diplomatic_range', tr('Within diplomatic range')),
        yes('is_criminal', 'Criminal', undefined, undefined, 'c')
    ],
    // common/activities/activity_types/_activity_type.info
    'activities/activity_types': [
        num('max_guests', tr('Most guests'), [20, 30, 50, 100], { k: 'g' }),
        yes('is_single_location', tr('In one place'), undefined, tr('In several places'), 's'),
        yes('open_invite', tr('Open invitation')),
        yes('allow_zero_guest_invites', tr('Can start without guests')),
        text('activities/activity_types', 'province_filter', tr('Where'), { k: 'w' }),
        text('activities/activity_types', 'ai_province_filter', tr('Where the AI holds it')),
        num('max_province_icons', tr('Most map icons'), [1, 3, 5]),
        num('ai_check_interval', tr('AI checks every … months'), [6, 36, 60], { read: tr('The AI checks it every $ months') }),
        yes('can_always_plan', tr('Can always be planned'))
    ],
    // common/religion/holy_site_types/_holy_site_types.info (its modifiers: the Modifiers sections)
    'religion/holy_site_types': [
        entry('county', tr('County'), 'landed_titles', { k: 'c', prefix: 'c_', help: tr('The county the holy site is in (needed unless it is dynamic)') }),
        entry('barony', tr('Barony'), 'landed_titles', { k: 'b', prefix: 'b_', help: tr('A barony of its own instead of the county’s') }),
        yes('is_dynamic', tr('Dynamic (no fixed place)'), tr('A general holy site type without a location; county and barony are then ignored'), tr('In a fixed place'))
    ],
    // common/council_tasks/_council_tasks.info
    council_tasks: [
        entry('position', tr('Council position'), 'council_positions', { k: 'p', help: tr('The councillor who performs it') }),
        pick('task_type', tr('Kind'), [['task_type_general', tr('General')], ['task_type_county', tr('On a county')], ['task_type_court', tr('At court')]], { k: 't' }),
        pick('task_progress', tr('Progress'), [['task_progress_infinite', tr('Never ends')], ['task_progress_percentage', tr('A percentage')], ['task_progress_value', tr('A value up to a maximum')]], { k: 'r' }),
        yes('default_task', tr('The position’s default task'), tr('Only a general task that never ends'), undefined, 'd'),
        entry('monthly_on_action', tr('Every month'), 'on_action', { k: 'm', help: tr('The on_action run every month while it is performed') }),
        pick('skill', tr('Skill'), SKILLS, { k: 's', help: tr('Shown in the council window') }),
        pick('county_target', tr('Counties it can target'), COUNTY_TARGETS, { k: 'c', help: tr('Only for a county task') }),
        pick('ai_county_target', tr('Counties the AI targets'), COUNTY_TARGETS, { help: tr('Default: the same as for the player') }),
        yes('restart_on_finish', tr('Starts again when finished')),
        yes('highlight_own_realm', tr('Own realm’s counties highlighted'), undefined, undefined, 'h'),
        text('council_tasks', 'custom_other_loc', tr('Text for other progress sources')),
        entry('clone', tr('A copy of the task'), 'council_tasks', { help: tr('Shares its texts, conditions and effects') }),
        // (several: the first valid one is shown; its `trigger` is its condition)
        { key: 'asset', label: tr('Picture…'), kind: 'block', k: 'a', sub: 'council_task_asset', conds: ['trigger'], read: tr('A picture'), help: tr('Its icon, background, frame and glow (several: the first whose trigger fits)') }
    ],
    // common/council_tasks/_council_tasks.info: `asset = { icon = "…" background = "…" frame = "…" glow = "…" }`
    council_task_asset: [
        text('council_tasks', 'icon', tr('Icon'), { k: 'i', suggest: 'nested:council_tasks:icon', free: true }),
        text('council_tasks', 'background', tr('Background'), { k: 'b', suggest: 'nested:council_tasks:background', free: true }),
        text('council_tasks', 'frame', tr('Frame'), { k: 'f', suggest: 'nested:council_tasks:frame', free: true }),
        text('council_tasks', 'glow', tr('Glow'), { k: 'g', suggest: 'nested:council_tasks:glow', free: true })
    ],
    // common/important_actions/_important_actions.info
    important_actions: [
        pick('type', tr('Kind'), [['action', tr('In the “current situation” list')], ['alert', tr('An icon of its own')], ['tutorial', tr('Starts a tutorial lesson')]], { k: 't' }),
        num('priority', tr('Priority'), [100, 300, 350, 400, 900, 1000], { k: 'p', read: tr('Priority $ (higher first)') }),
        text('important_actions', 'icon', tr('Icon'), { k: 'i' }),
        yes('is_dangerous', tr('Dangerous'), tr('Shown first, marked as a danger'), tr('Not dangerous'), 'd'),
        yes('combine_into_one', tr('Several shown as one'), tr('Several of it (other scopes) combine into one entry that opens'), undefined, 'c'),
        text('important_actions', 'soundeffect', tr('Sound'), { k: 's', free: true, help: tr('An event path, as typed: "event:/SFX/…"') })
    ],
    // common/activities/pulse_actions/_pulse_actions.info
    'activities/pulse_actions': [text('activities/pulse_actions', 'icon', tr('Icon'), { k: 'i', help: tr('Default: its key') })],
    // history/characters: a character's own fields (their traits: `character_history`; dated changes: their life)
    characters: [
        { key: 'name', label: tr('Name…'), kind: 'text', k: 'n', free: true, read: tr('Name: $'), help: tr('A name or its text key') },
        yes('female', 'Female', undefined, 'Male', 'f'),
        entry('dynasty', tr('Dynasty'), 'dynasties', { k: 'd' }),
        entry('dynasty_house', tr('House'), 'dynasty_houses', { k: 'h' }),
        entry('culture', tr('Culture'), 'culture/cultures', { k: 'c' }),
        entry('religion', tr('Faith'), 'faith', { k: 'r' }),
        entry('faith', 'Faith (written faith = …)', 'faith'),
        // (1.20: a rite wins over the faith, its faith at the date)
        entry('rite', tr('Rite'), 'religion/rite_types', { k: 'i' }),
        // (a character id typed, 70,000 of them; read as the character)
        { key: 'father', label: tr('Father (character id)…'), kind: 'text', ref: 'characters', k: 'a', read: tr('Father: $') },
        { key: 'mother', label: tr('Mother (character id)…'), kind: 'text', ref: 'characters', k: 'm', read: tr('Mother: $') },
        ...SKILLS.map(([key, label]): FieldDef => ({ key, label, kind: 'number', presets: [2, 5, 8, 10, 12, 15, 20], read: `${label} $` })),
        pick('sexuality', tr('Sexuality'), [['heterosexual', tr('Heterosexual')], ['homosexual', tr('Homosexual')], ['bisexual', tr('Bisexual')], ['asexual', tr('Asexual')]], { k: 's' }),
        yes('disallow_random_traits', tr('No random traits'), tr('The game gives them no random traits at start')),
        entry('dna', tr('Appearance (DNA)'), 'dna_data')
    ],
    // history/characters: what a dated block (`1066.1.1 = { … }`, their life) writes directly; anything else goes in
    // `effect = { … }` (the life event picker offers both)
    character_life: [
        entry('trait', tr('Gets a trait'), 'traits', { k: 't', read: tr('Gets the trait $') }),
        { key: 'add_spouse', label: tr('Marries…'), kind: 'text', ref: 'characters', k: 'm', read: tr('Marries $') },
        { key: 'add_matrilineal_spouse', label: tr('Marries (matrilineal)…'), kind: 'text', ref: 'characters', read: tr('Marries (matrilineal) $') },
        { key: 'remove_spouse', label: tr('No longer married to…'), kind: 'text', ref: 'characters', read: tr('No longer married to $') },
        { key: 'add_concubine', label: tr('Takes a concubine…'), kind: 'text', ref: 'characters', read: tr('Takes $ as a concubine') },
        yes('death', tr('Dies'), undefined, undefined, 'd'),
        entry('give_nickname', tr('Nickname'), 'nicknames', { k: 'n', read: tr('Known as $') }),
        { key: 'employer', label: tr('At the court of…'), kind: 'text', ref: 'characters', k: 'e', read: tr('At the court of $') },
        entry('culture', tr('Culture'), 'culture/cultures', { k: 'c' }),
        entry('religion', tr('Faith'), 'faith', { k: 'r' }),
        entry('faith', 'Faith (written faith = …)', 'faith'),
        // (1.20: a rite wins over the faith, its faith at the date)
        entry('rite', tr('Rite'), 'religion/rite_types', { k: 'i' }),
        entry('dynasty', tr('Dynasty'), 'dynasties'),
        entry('dynasty_house', tr('House'), 'dynasty_houses'),
        entry('government', tr('Government'), 'governments', { k: 'g' })
    ],
    // religion/faith_types (1.20): `tenets = { tenet_communion … }`: a tenet each, any of the game's and the mods'
    // (a tenet of a DLC: with its flag and a fallback; religion/rite_types/_rite_types.info `tenet_selection_pair`)
    faith_tenets: [{ key: 'tenet', label: tr('Tenet…'), kind: 'ref', ref: 'religion/tenet_types', bare: true, k: 't', read: '$', dlcPair: { key: 'tenet_selection_pair', item: 'tenet', fallback: 'fallback_tenet' } }],
    // common/traits/_traits.info: `opposites = { craven }`: a trait each
    // religion_types/_religion_types.info `traits = { virtues = { brave generous = 0.5 } sins = { … } }`: a trait, or a
    // trait with a scale (how strongly it counts)
    religion_virtues: [
        { key: 'trait', label: tr('Trait…'), kind: 'ref', ref: 'traits', bare: true, k: 't', read: '$' },
        { key: '*', anyKey: 'traits', label: tr('Trait with a scale…'), kind: 'number', k: 's', presets: [0.5, 1.5, 2, 3], read: '%k ×$', help: tr('How strongly it counts (1 = normal)') }
    ],
    trait_opposites: [{ key: 'trait', label: tr('Opposite trait…'), kind: 'ref', ref: 'traits', bare: true, k: 't', read: tr('Opposite of $') }],
    // common/traits/_traits.info: `compatibility = { brave = 15 }`: any trait, how well they get along
    trait_compatibility: [{ key: '*', anyKey: 'traits', label: tr('With the trait…'), kind: 'number', signed: true, tone: 'good', k: 't', presets: [5, 10, 15, 20, 30, -5, -10, -15, -20, -30], read: tr('$ with %k') }],
    // common/traits/_traits.info: `track = { 50 = { <modifiers> } }`: the modifiers from an amount of experience on
    trait_track: [{ key: '#', label: tr('A level (experience)…'), kind: 'level', k: 'l', presets: [20, 25, 40, 50, 60, 75, 80, 100], read: tr('From $ experience') }],
    // common/traits/_traits.info: `tracks = { falconer = { 50 = { <modifiers> } } }`: named tracks, each with its levels,
    // a unique name each; the game shows a track by the text `trait_track_<name>` (and `_desc`)
    trait_tracks: [
        {
            key: '#',
            label: tr('A named track…'),
            kind: 'level',
            k: 't',
            named: { loc: 'trait_track_$', locLabel: tr('Name shown in game…'), descSuffix: '_desc', descLabel: tr('Description shown in game…') },
            presets: [20, 25, 40, 50, 60, 75, 80, 100],
            read: tr('From $ experience'),
            help: tr('A track of its own name, with its first level (experience)')
        }
    ]
};
