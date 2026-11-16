/** Field sets of the realm cards (src/main/describe/cards/realm.ts): merged into FIELDS (fieldCatalog.ts). */
import type { FieldDef } from '../fieldCatalog.ts';

import { tr } from '../i18n.ts';
const TIERS: [string, string][] = [
    ['county', tr('County')],
    ['duchy', tr('Duchy')],
    ['kingdom', tr('Kingdom')]
];

const TITLE_MAA: [string, string][] = [
    ['main_administrative_tier_and_top_liege', tr('Main administrative tier and the top liege')],
    ['vassals_and_top_liege', tr('Vassal titles of the main tier or above, and the top liege')],
    ['top_vassals_and_top_liege', tr('Titles right under the top liege, and the top liege')]
];

/** A yes/no field: `key`, its menu label, how `yes` and `no` read. */
const bool = (key: string, label: string, yes: string, no: string, k?: string): FieldDef => ({ key, label, kind: 'bool', read: { yes, no }, ...(k ? { k } : {}) });

/** A share of an income (0..1, script math allowed): subject contracts' obligation levels. */
const share = (key: string, label: string, k?: string): FieldDef => ({ key, label, kind: 'number', presets: [0, 0.1, 0.2, 0.25, 0.3, 0.5], ref: 'script_values', read: `${label}: $`, ...(k ? { k } : {}) });

export const REALM_FIELDS: Record<string, FieldDef[]> = {
    // common/laws/_laws.info: a law's own scalars (flags are the "Rules" section, the succession block its own set)
    laws: [
        { key: 'flag', label: tr('Flag…'), kind: 'text', k: 'f', suggest: 'values:laws:flag', read: tr('Flag: $'), help: tr('A realm law flag (has_realm_law_flag); several are allowed') },
        bool('shown_in_encyclopedia', tr('Shown in the encyclopedia'), tr('Shown in the encyclopedia'), tr('Not in the encyclopedia'), 'e'),
        { key: 'title_allegiance_opinion', label: tr('Allegiance opinion'), kind: 'number', k: 'o', signed: true, tone: 'good', presets: [5, 10, 15, 20], read: tr('$ opinion from allegiance to the title') },
        { key: 'widget_name', label: tr('Interface widget'), kind: 'text', read: tr('Shown with the interface widget $') },
        { key: 'pass_phrase', label: tr('Text when passing'), kind: 'text', read: tr('Text when passing: $') },
        { key: 'confirmation_title', label: tr('Confirmation title'), kind: 'text', read: tr('Confirmation title: $') },
        { key: 'confirmation_button_text', label: tr('Confirmation button'), kind: 'text', read: tr('Confirmation button: $') }
    ],
    // common/laws/_laws.info: `succession = { … }`
    law_succession: [
        {
            key: 'order_of_succession',
            label: tr('Order of succession'),
            kind: 'choice',
            k: 'o',
            read: tr('Succession: $'),
            options: [
                ['inheritance', tr('Inheritance')],
                ['election', tr('Election')],
                ['appointment', tr('Appointment')],
                ['theocratic', tr('Theocratic — chosen by the faith')],
                ['company', tr('Company — a new leader from the pool')],
                ['generate', tr('A new ruler is generated')],
                ['generate_from_template', tr('A new ruler from a template')],
                ['player_heir', tr('The player’s heir')],
                ['noble_family', tr('Within the noble family')]
            ]
        },
        { key: 'title_division', label: tr('Title division'), kind: 'choice', k: 'd', read: '$', options: [['partition', tr('Titles are split among the heirs')], ['single_heir', tr('One heir gets every title')]] },
        { key: 'traversal_order', label: tr('Heirs come from'), kind: 'choice', k: 't', read: tr('Heirs come from: $'), options: [['children', tr('The children')], ['dynasty', tr('The dynasty')], ['dynasty_house', tr('The house')]] },
        { key: 'rank', label: tr('Order of heirs'), kind: 'choice', k: 'r', read: '$', options: [['oldest', tr('Oldest first')], ['youngest', tr('Youngest first')]] },
        {
            key: 'gender_law',
            label: tr('Gender law'),
            kind: 'choice',
            k: 'g',
            read: tr('Heirs: $'),
            options: [
                ['male_only', tr('Men only')],
                ['male_preference', tr('Men before women')],
                ['equal', tr('Men and women equally')],
                ['female_preference', tr('Women before men')],
                ['female_only', tr('Women only')]
            ]
        },
        { key: 'faith', label: tr('Faith of heirs'), kind: 'choice', k: 'f', read: tr('Heirs must share the ruler’s $'), options: [['same_faith', 'faith'], ['same_religion', 'religion'], ['same_family', tr('religious family')]], help: tr('Ignored when nobody fits') },
        { key: 'election_type', label: tr('Election'), kind: 'ref', k: 'e', ref: 'succession_election', read: tr('Election: $') },
        { key: 'appointment_type', label: tr('Appointment'), kind: 'ref', k: 'a', ref: 'succession_appointment', read: tr('Appointment: $') },
        { key: 'pool_character_config', label: tr('Pool selector'), kind: 'ref', k: 'p', ref: 'pool_character_selectors', read: tr('Heirs picked from the pool by $') },
        bool('create_primary_tier_titles', tr('Create primary tier titles'), tr('Younger heirs get new titles of the primary tier'), tr('No new titles for younger heirs'), 'c'),
        { key: 'primary_heir_minimum_share', label: tr('Primary heir’s share'), kind: 'number', k: 's', presets: [0.25, 0.5, 0.75], read: tr('The primary heir gets at least $ of the titles') },
        bool('exclude_rulers', tr('Exclude rulers'), tr('Rulers cannot inherit'), tr('Rulers can inherit'), 'x'),
        bool('limit_to_courtiers', tr('Courtiers only'), tr('Only courtiers can inherit'), tr('Not only courtiers inherit'), 'l')
    ],
    // common/laws/_laws.info: a law group's own scalars
    law_groups: [
        { key: 'default', label: tr('Default law'), kind: 'ref', k: 'd', ref: 'laws', read: tr('Default: $'), help: tr('New rulers start with it when its should_start_with allows') },
        bool('cumulative', tr('Cumulative'), tr('Cumulative — each law has the effects of the laws before it'), tr('Not cumulative'), 'c'),
        bool('is_treasury_budget_group', tr('Treasury budget'), tr('Part of the treasury budget'), tr('Not in the treasury budget'), 't'),
        { key: 'flag', label: tr('Flag…'), kind: 'text', k: 'f', suggest: 'values:law_groups:flag', read: tr('Flag: $') }
    ],
    // common/governments/_governments.info
    governments: [
        {
            key: 'mechanic_type',
            label: tr('Kind of government'),
            kind: 'choice',
            k: 'm',
            read: tr('Kind: $'),
            options: [
                ['feudal', tr('Feudal')],
                ['mercenary', tr('Mercenary')],
                ['holy_order', tr('Holy order')],
                ['clan', tr('Clan')],
                ['theocracy', tr('Theocracy')],
                ['administrative', tr('Administrative')],
                ['landless_adventurer', tr('Landless adventurer')],
                ['herder', tr('Herder')],
                ['nomad', tr('Nomad')],
                ['mandala', tr('Mandala')]
            ]
        },
        bool('is_mechanic_type_default', tr('Default of its kind'), tr('The default government of its kind'), tr('Not the default of its kind'), 'd'),
        { key: 'fallback', label: tr('Fallback priority'), kind: 'number', k: 'f', presets: [1, 2, 3], read: tr('Fallback government, priority $'), help: tr('Used when no other government is valid (1 before 2)') },
        { key: 'primary_holding', label: tr('Primary holding'), kind: 'ref', k: 'p', ref: 'holdings', read: tr('Primary holding: $') },
        { key: 'royal_court', label: tr('Royal court'), kind: 'choice', k: 'r', read: tr('Royal court: $'), options: [['none', tr('None')], ['any', tr('Rulers and their vassals')], ['top_liege', tr('Independent rulers only')]] },
        { key: 'vassal_contract_group', label: tr('Vassal contracts'), kind: 'ref', k: 'v', ref: 'subject_contracts/groups', read: tr('Vassal contracts: $') },
        { key: 'house_unity', label: tr('House unity'), kind: 'ref', k: 'u', ref: 'house_unities', read: tr('House unity: $') },
        { key: 'domicile_type', label: tr('Domicile'), kind: 'ref', k: 'o', ref: 'domiciles/types', read: tr('Domicile: $') },
        { key: 'tax_slot_type', label: tr('Tax slots'), kind: 'ref', ref: 'tax_slots/types', read: tr('Tax slots: $') },
        { key: 'generated_character_template', label: tr('Generated characters'), kind: 'ref', ref: 'scripted_character_templates', read: tr('New characters from the template $') },
        { key: 'main_administrative_tier', label: tr('Main administrative tier'), kind: 'choice', read: tr('Main administrative tier: $'), options: TIERS },
        { key: 'min_appointment_tier', label: tr('Appointment from tier'), kind: 'choice', read: tr('Appointment succession from the $ tier up'), options: TIERS },
        { key: 'minimum_provincial_maa_tier', label: tr('Title troops from tier'), kind: 'choice', read: tr('Title troops from the $ tier up'), options: TIERS },
        { key: 'administrative_title_maa_setup', label: tr('Title troops for'), kind: 'choice', read: tr('Title troops for: $'), options: TITLE_MAA },
        { key: 'supply_limit_mult_for_others', label: tr('Supply limit for others'), kind: 'number', presets: [-0.5, -0.25, 0.25], read: tr('Supply limit multiplier for armies of other governments: $') },
        { key: 'court_generate_commanders', label: tr('Generate commanders'), kind: 'number', presets: [0, 1, 2], read: tr('Courts generate commanders: $') },
        { key: 'max_dread', label: tr('Maximum dread'), kind: 'number', presets: [50, 100], read: tr('Dread is capped at $') }
    ],
    // common/governments/_governments.info: `government_rules = { … }` (government_allows)
    government_rules: [
        bool('create_cadet_branches', tr('Cadet branches'), tr('Rulers can found cadet branches'), tr('No cadet branches')),
        bool('religious', tr('Clergy'), tr('Rulers are clergy'), tr('Rulers are not clergy')),
        bool('court_generate_spouses', tr('Spouses at court'), tr('New realms get suitable spouses at court'), tr('No spouses generated at court')),
        bool('council', tr('Council'), tr('Has a council'), tr('No council')),
        bool('rulers_should_have_dynasty', tr('Dynasty'), tr('Rulers get a dynasty'), tr('Rulers need no dynasty')),
        bool('regiments_prestige_as_gold', tr('Men-at-arms for prestige'), tr('Men-at-arms are bought and reinforced with prestige'), tr('Men-at-arms cost gold')),
        bool('dynasty_named_realms', tr('Dynasty-named realms'), tr('Realms can be named after the ruler’s dynasty and culture'), tr('Realms keep their own names')),
        bool('legitimacy', tr('Legitimacy'), tr('Uses legitimacy'), tr('No legitimacy')),
        bool('administrative', tr('Administrative'), tr('Administrative: noble families as landless vassals, title troops'), tr('Not administrative')),
        bool('admin_allows_holding_multiple_primary_tier_titles', tr('Several primary titles'), tr('Can hold several titles of the primary tier'), tr('One title of the primary tier')),
        bool('landless_playable', tr('Playable landless'), tr('Playable without land'), tr('Needs land to be played')),
        bool('allow_out_of_realm_inheritance', tr('Inheritance from outside'), tr('Can inherit from outside the realm'), tr('No inheritance from outside the realm')),
        bool('use_as_base_on_landed', tr('Kept on becoming landed'), tr('Taken by an heir who becomes landed from a holder of it'), tr('Not taken on becoming landed')),
        bool('use_as_base_on_rank_up', tr('Kept on rank-up'), tr('Taken by an independent ruler who gains a higher title from a holder of it'), tr('Not taken on rank-up')),
        bool('conditional_maa_refill', tr('Conditional reinforcement'), tr('Men-at-arms only reinforce under their own conditions, without upkeep'), tr('Men-at-arms reinforce normally')),
        bool('mercenary', tr('Mercenary'), tr('Landless rulers can hire themselves out as mercenaries'), tr('No hiring out as mercenaries')),
        bool('state_faith', tr('State faith'), tr('Uses a state faith'), tr('No state faith')),
        bool('treasury', tr('Treasury'), tr('Uses the treasury'), tr('No treasury')),
        bool('merit', tr('Merit'), tr('Uses merit'), tr('No merit')),
        bool('uses_county_fertility', tr('County fertility'), tr('Uses county fertility'), tr('No county fertility')),
        bool('replenishes_county_fertility', tr('Replenishes fertility'), tr('Replenishes county fertility'), tr('Does not replenish county fertility')),
        bool('obedience', tr('Obedience'), tr('Uses obedience'), tr('No obedience')),
        bool('uses_culture_and_house_head_named_realms', tr('Culture-named realms'), tr('Realms named after the culture and house head'), tr('Not named after the culture and house head')),
        bool('sticky_government', tr('Sticky'), tr('Sticky — rulers keep it'), tr('Not sticky')),
        bool('subject_men_at_arms', tr('Subject men-at-arms'), tr('Subjects provide men-at-arms'), tr('No men-at-arms from subjects')),
        bool('use_title_tier_modifiers', tr('Title tier bonuses'), tr('Prestige and modifiers from title tiers'), tr('No prestige or modifiers from title tiers')),
        bool('inherit_from_dynastic_government', tr('Inherits from dynastic governments'), tr('Can inherit from dynastic governments'), tr('Cannot inherit from dynastic governments')),
        bool('deny_powerful_vassal', tr('Never a powerful vassal'), tr('Never a powerful vassal'), tr('Can be a powerful vassal')),
        bool('use_maa_maintenance', tr('Men-at-arms upkeep'), tr('Pays men-at-arms upkeep'), tr('No men-at-arms upkeep')),
        bool('no_capital_movement_cooldown', tr('Capital moves freely'), tr('Can move the capital without a cooldown'), tr('Capital moves have a cooldown')),
        bool('redirects_wars_to_overlord', tr('Wars go to the overlord'), tr('Wars against it are redirected to its overlord'), tr('Wars are not redirected')),
        bool('noble_families', tr('Noble families'), tr('Allows noble family titles'), tr('No noble family titles')),
        bool('house_aspirations', tr('House aspirations'), tr('Uses house aspirations'), tr('No house aspirations')),
        bool('replace_gold_cost_by_treasury', tr('Pays from the treasury'), tr('State expenses are paid from the treasury'), tr('State expenses are paid in gold')),
        bool('block_alliance_child_marriage', tr('No alliances from children'), tr('Children’s marriages make no alliances'), tr('Children’s marriages make alliances')),
        bool('block_alliance_non_dominant_gender_child_marriage', tr('No alliances from some children'), tr('Marriages of children of the non-dominant gender make no alliances'), tr('Marriages of all children make alliances')),
        bool('always_use_patronym', tr('Patronyms'), tr('Always shows patronyms'), tr('Patronyms as the culture has them')),
        bool('affected_by_development', tr('Development'), tr('Counties are affected by development'), tr('Counties are not affected by development')),
        bool('considers_piety_for_title_creation', tr('Piety for titles'), tr('Piety counts for creating titles'), tr('Piety does not count for creating titles')),
        bool('ask_for_tribute', tr('Asks for tribute'), tr('Can ask others to become tributaries'), tr('Cannot ask for tribute')),
        bool('barter', tr('Barter'), tr('Uses bartering'), tr('No bartering')),
        bool('buildings', tr('Buildings'), tr('Can construct buildings in holdings'), tr('Cannot construct buildings')),
        bool('count_tributaries_for_title_requirements', tr('Tributaries’ land counts'), tr('Tributaries’ land counts for creating or usurping titles'), tr('Only its own land counts for titles')),
        bool('radiance', tr('Radiance'), tr('Uses radiance'), tr('No radiance')),
        bool('disable_regnal_numbers', tr('No regnal numbers'), tr('No regnal numbers'), tr('Regnal numbers')),
        bool('allow_accolades', tr('Accolades'), tr('Can have accolades'), tr('No accolades')),
        bool('allow_as_base_for_baronies', tr('Barony holders'), tr('Can be the government of barony holders'), tr('Not for barony holders'))
    ],
    // common/governments/_governments.info: `ai = { … }`
    government_ai: [
        bool('use_lifestyle', tr('Lifestyles'), tr('AI picks lifestyles'), tr('AI picks no lifestyle')),
        bool('arrange_marriage', tr('Marriages'), tr('AI arranges marriages'), tr('AI arranges no marriages')),
        bool('use_goals', tr('Long-term goals'), tr('AI pursues long-term goals'), tr('AI pursues no long-term goals')),
        bool('use_decisions', tr('Decisions'), tr('AI takes minor decisions'), tr('AI takes no minor decisions')),
        bool('use_scripted_guis', tr('Scripted interfaces'), tr('AI uses scripted interface actions'), tr('AI uses no scripted interface actions')),
        bool('use_legends', tr('Legends'), tr('AI creates and promotes legends'), tr('AI creates no legends')),
        bool('perform_religious_reformation', tr('Reformation'), tr('AI reforms its faith'), tr('AI never reforms its faith')),
        bool('use_great_projects', tr('Great projects'), tr('AI founds and contributes to great projects'), tr('AI stays out of great projects'))
    ],
    // common/succession_appointment/_succession_appointment.info
    succession_appointment: [
        { key: 'level', label: tr('Candidates by level'), kind: 'choice', k: 'l', read: tr('Candidates: everyone with enough $'), options: [['merit', 'merit'], ['prestige', 'prestige'], ['piety', 'piety'], ['influence', 'influence']], help: tr('Replaces the default candidates') },
        bool('allow_children', tr('Children'), tr('Children can be appointed'), tr('Children cannot be appointed'), 'c'),
        // (1.20: replaces 1.19's allow_same_tier_candidates; the game's appointments that allow the same tier or more write cooldown = yes)
        { key: 'allowed_candidate_tier', label: tr('Candidates’ tier'), kind: 'choice', k: 's', read: tr('Candidates: $'), options: [['lower', tr('only of a lower tier than the title')], ['lower_or_equal', tr('of a lower or the same tier')], ['any', tr('of any tier')]], help: tr('Landed rulers can only be appointed to lower-level landed titles if they are de jure liege of the title') },
        bool('cooldown', tr('Cooldown'), tr('Candidates appointed incur a cooldown before another appointment'), tr('No cooldown after an appointment'), 'o')
    ],
    // common/landed_titles/_landed_titles.info
    landed_titles: [
        { key: 'capital', label: tr('Capital'), kind: 'ref', k: 'c', ref: 'landed_titles', read: tr('Capital: $') },
        { key: 'province', label: tr('Province'), kind: 'number', presets: [], read: tr('Province $') },
        bool('landless', tr('Landless'), tr('A landless title'), tr('A landed title'), 'l'),
        bool('definite_form', tr('Definite form'), tr('Named in its definite form'), tr('No definite form'), 'd'),
        bool('ruler_uses_title_name', tr('Holder named after it'), tr('Its holder is named after it'), tr('Its holder is not named after it'), 'r'),
        bool('noble_family', tr('Noble family'), tr('A noble family title'), tr('Not a noble family title'), 'n'),
        bool('always_follows_primary_heir', tr('Follows the primary heir'), tr('Always goes to the primary heir'), tr('Not bound to the primary heir'), 'p'),
        bool('destroy_if_invalid_heir', tr('Destroyed without a valid heir'), tr('Destroyed when there is no valid heir'), tr('Kept without a valid heir'), 'i'),
        bool('destroy_on_succession', tr('Destroyed on succession'), tr('Destroyed on succession'), tr('Kept on succession')),
        bool('delete_on_destroy', tr('Deleted when destroyed'), tr('Deleted when destroyed'), tr('Kept when destroyed')),
        bool('delete_on_gain_same_tier', tr('Deleted on a same-tier title'), tr('Deleted when the holder gains another title of its tier'), tr('Kept when the holder gains a title of its tier')),
        bool('no_automatic_claims', tr('No automatic claims'), tr('Heirs get no automatic claims'), tr('Heirs get automatic claims'), 'a'),
        bool('can_be_named_after_dynasty', tr('Named after the dynasty'), tr('Can be named after its holder’s dynasty'), tr('Never named after its holder’s dynasty')),
        bool('can_use_nomadic_naming', tr('Nomadic naming'), tr('Can use nomadic naming'), tr('No nomadic naming')),
        bool('require_landless', tr('Landless holders only'), tr('Only for landless holders — may be destroyed when they gain land'), tr('Holders may have land')),
        bool('de_jure_drift_disabled', tr('No de jure drift'), tr('Titles do not drift into it'), tr('Titles can drift into it')),
        bool('allow_domicile', tr('Domicile'), tr('Allows a domicile'), tr('No domicile')),
        bool('disable_regnal_numbers', tr('No regnal numbers'), tr('No regnal numbers'), tr('Regnal numbers')),
        bool('figurehead', tr('Figurehead'), tr('Has figurehead status'), tr('No figurehead status')),
        bool('ignore_titularity_for_title_weighting', tr('Titularity ignored'), tr('The AI ignores whether it is titular when picking a primary title'), tr('The AI weighs whether it is titular'))
    ],
    // common/holdings/_holdings.info
    holdings: [
        { key: 'primary_building', label: tr('Primary building'), kind: 'ref', k: 'p', ref: 'buildings', read: tr('Primary building: $') },
        bool('can_be_inherited', tr('Inherited'), tr('Baronies with it can be inherited'), tr('Baronies with it cannot be inherited'), 'i'),
        bool('counts_toward_domain_limit_if_disabled', tr('Domain limit when disabled'), tr('Counts toward the domain limit when disabled'), tr('Does not count toward the domain limit when disabled'), 'd')
    ],
    // common/subject_contracts/contracts/_subject_contracts.info
    'subject_contracts/contracts': [
        { key: 'display_mode', label: tr('Shown as'), kind: 'choice', k: 'd', read: tr('Shown as: $'), options: [['tree', tr('A tree of levels')], ['radiobutton', tr('One of several options')], ['checkbox', tr('A checkbox')], ['hidden', tr('Hidden')]] },
        bool('defaults_to_highest_valid_level', tr('Highest level by default'), tr('Defaults to the highest valid level'), tr('Defaults to its default level'), 'h'),
        bool('uses_opinion_of_liege', tr('Uses the liege’s opinion'), tr('Its levels can use the subject’s opinion of the liege'), tr('Its levels do not use the opinion of the liege'), 'o')
    ],
    // an obligation level (`obligation_levels = { <level> = { … } }`)
    obligation_level: [
        share('tax', 'Tax', 't'),
        share('levies', 'Levies', 'l'),
        share('herd', 'Herd', 'h'),
        share('barter_goods', tr('Barter goods'), 'b'),
        share('prestige', 'Prestige'),
        share('piety', 'Piety'),
        share('min_tax', tr('At least tax')),
        share('min_levies', tr('At least levies')),
        share('min_herd', tr('At least herd')),
        share('min_barter_goods', tr('At least barter goods')),
        { key: 'subject_opinion', label: tr('Subject’s opinion'), kind: 'number', k: 'o', signed: true, tone: 'good', presets: [5, 10, 15, -5, -10, -15, -25], read: tr('$ opinion of the liege') },
        { key: 'score', label: tr('Score'), kind: 'number', k: 's', presets: [-2, -1, 0, 1, 2], read: tr('Score $ (above 0 favours the subject)'), help: tr('Compared when obligations change; defaults to the order of the levels') },
        bool('default', tr('Default level'), tr('The default level'), tr('Not the default level'), 'd'),
        { key: 'parent', label: tr('Follows'), kind: 'text', k: 'p', read: tr('Follows $') },
        { key: 'flag', label: tr('Flag…'), kind: 'text', k: 'f', read: tr('Flag: $') },
        { key: 'tax_factor', label: tr('Tax factor'), kind: 'number', ref: 'script_values', presets: [0.5, 1.5, 2], read: tr('Tax ×$') },
        { key: 'levies_factor', label: tr('Levies factor'), kind: 'number', ref: 'script_values', presets: [0.5, 1.5, 2], read: tr('Levies ×$') },
        { key: 'herd_factor', label: tr('Herd factor'), kind: 'number', ref: 'script_values', presets: [0.5, 1.5, 2], read: tr('Herd ×$') },
        bool('enable_title_maa', tr('Title troops'), tr('Title troops allowed'), tr('No title troops')),
        bool('enable_character_maa', tr('Character men-at-arms'), tr('Character men-at-arms allowed'), tr('No character men-at-arms')),
        { key: 'appointment_trait_flag', label: tr('Heirs need a trait flag'), kind: 'text', read: tr('Heirs need a trait with the flag “$”') }
    ],
    // common/subject_contracts/groups/_subject_contract_groups.info
    'subject_contracts/groups': [
        { key: 'admin_province_contract', label: tr('Province contract'), kind: 'ref', k: 'p', ref: 'subject_contracts/contracts', read: tr('Province contract: $') },
        { key: 'modify_contract_layout', label: tr('Window layout'), kind: 'text', read: tr('Contract window layout: $') },
        bool('is_tributary', tr('Tributary'), tr('A tributary contract'), tr('A vassal contract'), 't'),
        bool('tributary_heir_succession', tr('Heirs stay tributaries'), tr('The tributary’s heirs stay tributaries'), tr('The tributary’s heirs go free'), 'h'),
        bool('suzerain_heir_succession', tr('Suzerain’s heir takes over'), tr('The suzerain’s heir takes over as suzerain'), tr('The suzerain’s heir does not take over'), 's'),
        bool('should_show_as_suzerain_realm_name', tr('Suzerain’s realm name'), tr('Shown with the suzerain’s realm name on the map'), tr('Keeps its own realm name on the map')),
        bool('should_show_as_suzerain_realm_color', tr('Suzerain’s realm colour'), tr('Shown in (a blend of) the suzerain’s realm colour on the map'), tr('Keeps its own realm colour on the map')),
        { key: 'suzerain_line_type', label: tr('Line to the suzerain'), kind: 'text', read: tr('Map line to the suzerain: $') },
        { key: 'tributary_line_type', label: tr('Line to tributaries'), kind: 'text', read: tr('Map line to tributaries: $') }
    ],
    // common/lease_contracts/_lease_contracts.info
    lease_contracts: [
        { key: 'government', label: tr('Government'), kind: 'ref', k: 'g', ref: 'governments', read: tr('Government: $') },
        { key: 'ruler_share_min_opinion_from_lessee', label: tr('Opinion for a share'), kind: 'number', k: 'o', presets: [1, 25, 50], read: tr('The ruler gets a share from $ opinion of the lessee') },
        { key: 'hook_strength_max_opinion', label: tr('Hook for the full share'), kind: 'choice', k: 'h', read: tr('Hook that counts as full opinion: $'), options: [['none', tr('None')], ['any', tr('Any hook')], ['strong', tr('A strong hook')]] }
    ],
    // common/hook_types/_hooks.info
    hook_types: [
        { key: 'expiration_days', label: tr('Expires after (days)'), kind: 'number', k: 'e', presets: [365, 1825, 3650, 7300, -1], read: tr('Expires after $ days'), help: '-1 or none: never expires' },
        bool('strong', tr('Strong'), tr('A strong hook — put on cooldown instead of used up'), tr('A weak hook'), 's'),
        bool('perpetual', tr('Reusable'), tr('Can be used again'), tr('Used up when used'), 'p'),
        bool('requires_secret', tr('Needs a secret'), tr('Needs a secret'), tr('Needs no secret'), 'r')
    ],
    casus_belli_groups: [
        bool('can_only_start_via_script', tr('Only by script'), tr('Only started by script'), tr('Rulers can declare it'), 's'),
        bool('should_check_for_interface_availability', tr('Checked for the interface'), tr('Its availability is checked for the war interface'), tr('Not checked for the war interface'), 'i'),
        bool('debug', tr('Debug'), tr('Debug only'), tr('Not debug only'), 'd')
    ],
    // common/men_at_arms_types/_men_at_arms_types.info
    men_at_arms_types: [
        { key: 'type', label: tr('Type'), kind: 'text', k: 't', suggest: 'values:men_at_arms_types:type', read: tr('Type: $') },
        { key: 'damage', label: tr('Damage'), kind: 'number', k: 'd', presets: [10, 20, 30, 50, 100], read: tr('$ damage') },
        { key: 'toughness', label: tr('Toughness'), kind: 'number', k: 'o', presets: [10, 20, 30, 50], read: tr('$ toughness') },
        { key: 'pursuit', label: tr('Pursuit'), kind: 'number', k: 'p', presets: [0, 10, 20, 30], read: tr('$ pursuit — damage dealt when winning') },
        { key: 'screen', label: tr('Screen'), kind: 'number', k: 's', presets: [0, 10, 20, 30], read: tr('$ screen — damage avoided when losing') },
        { key: 'siege_value', label: tr('Siege value'), kind: 'number', presets: [0.1, 0.5, 1], read: tr('$ siege value') },
        { key: 'siege_tier', label: tr('Siege tier'), kind: 'number', presets: [1, 2, 3], read: tr('Siege tier $ against forts') },
        { key: 'stack', label: tr('Soldiers per sub-regiment'), kind: 'number', k: 'k', presets: [25, 50, 100], read: tr('$ soldiers per sub-regiment') },
        { key: 'hired_stack_size', label: tr('Hired sub-regiment size'), kind: 'number', presets: [25, 50], read: tr('$ soldiers per hired sub-regiment') },
        { key: 'max', label: tr('Size limit'), kind: 'number', presets: [1, 2, 3], read: tr('Size limit $') },
        { key: 'max_regiments', label: tr('Most regiments'), kind: 'number', presets: [1, 2, 3], read: tr('At most $ regiments') },
        { key: 'max_sub_regiments', label: tr('Most sub-regiments'), kind: 'number', presets: [1, 5, 10], read: tr('One regiment of at most $ sub-regiments') },
        { key: 'provision_cost', label: tr('Provisions'), kind: 'number', presets: [3, 7, 12, 15], read: tr('$ provisions when moving the domicile') },
        bool('fights_in_main_phase', tr('Fights in the main phase'), tr('Fights in the main phase'), tr('Only fights in the pursuit phase')),
        bool('special_recruit_only', tr('Never recruited'), tr('Never recruited — only made by events and effects'), tr('Can be recruited')),
        bool('allowed_in_hired_troops', tr('Hired troops'), tr('Can be hired troops'), tr('Never among hired troops')),
        bool('holy_order_fallback', tr('Holy orders use it less'), tr('Holy orders use it less'), tr('Holy orders use it normally')),
        bool('fallback_in_hired_troops_if_unlocked', tr('Not preferred by hired troops'), tr('Hired troops do not prefer it once unlocked'), tr('Hired troops prefer it once unlocked'))
    ],
    // a men-at-arms type's terrain, winter and holding bonuses: `forest = { damage = 4 toughness = 6 }`
    maa_bonus: [
        { key: 'damage', label: tr('Damage'), kind: 'number', k: 'd', signed: true, tone: 'good', presets: [2, 4, 6, 10, -2, -4], read: tr('$ damage') },
        { key: 'toughness', label: tr('Toughness'), kind: 'number', k: 't', signed: true, tone: 'good', presets: [2, 4, 6, 10, -2, -4], read: tr('$ toughness') },
        { key: 'pursuit', label: tr('Pursuit'), kind: 'number', k: 'p', signed: true, tone: 'good', presets: [2, 4, 6, 10, -2, -4], read: tr('$ pursuit') },
        { key: 'screen', label: tr('Screen'), kind: 'number', k: 's', signed: true, tone: 'good', presets: [2, 4, 6, 10, -2, -4], read: tr('$ screen') },
        { key: 'siege_value', label: tr('Siege value'), kind: 'number', k: 'v', signed: true, tone: 'good', presets: [0.1, 0.5, 1], read: tr('$ siege value') }
    ],
    // common/ai_war_stances/_ai_war_stances.info
    ai_war_stances: [
        { key: 'side', label: tr('Side'), kind: 'choice', k: 's', read: tr('Side: $'), options: [['attacker', tr('Attacker')], ['defender', tr('Defender')]] },
        { key: 'enemy_unit_priority', label: tr('Enemy army priority'), kind: 'number', k: 'e', presets: [50, 100, 250, 500], read: tr('Priority $ for enemy armies half its strength') }
    ],
    // `behaviour_attributes = { … }`: when the stance is considered
    war_stance_behaviour: [
        bool('stronger', tr('When stronger'), tr('When its side is stronger'), tr('Not when stronger'), 's'),
        bool('weaker', tr('When weaker'), tr('When its side is weaker'), tr('Not when weaker'), 'w'),
        bool('desperate', tr('When desperate'), tr('When its side is desperate — much weaker and about to lose'), tr('Not when desperate'), 'd')
    ],
    // common/game_rules/_game_rules.info
    game_rules: [{ key: 'default', label: tr('Default setting'), kind: 'ref', k: 'd', ref: 'game_rule_options', read: tr('Default: $') }],
    // common/house_unities/_house_unities.info
    house_unities: [
        { key: 'default_value', label: tr('Starting unity'), kind: 'number', k: 'd', presets: [0, 50, 100], read: tr('Starts at $ unity') },
        { key: 'min_value', label: tr('Lowest unity'), kind: 'number', k: 'm', presets: [0], read: tr('Never below $ unity') }
    ],
    // a house unity stage (`<stage> = { points = 40 … }`)
    house_unity_stage: [
        { key: 'points', label: tr('Points'), kind: 'number', k: 'p', presets: [20, 40, 60], read: tr('Spans $ points of unity') },
        { key: 'succession_law_flag', label: tr('Succession law flag'), kind: 'text', read: tr('Succession law flag: $') }
    ],
    // common/house_relation_types/_house_relation.info
    house_relation_types: [{ key: 'neutral_level', label: tr('Neutral level'), kind: 'text', k: 'n', read: tr('Neutral level: $') }],
    // a house relation level (`levels = { <level> = { opinion = -30 … } }`)
    house_relation_level: [
        { key: 'opinion', label: tr('Opinion'), kind: 'number', k: 'o', signed: true, tone: 'good', presets: [5, 10, 20, 30, -10, -20, -30], read: tr('$ opinion between their members') },
        { key: 'cohesion_contribution', label: tr('Cohesion'), kind: 'number', k: 'c', signed: true, tone: 'good', presets: [10, 20, 30, -10, -20, -30], read: tr('$ monthly cohesion when both are in a bloc') }
    ]
};
