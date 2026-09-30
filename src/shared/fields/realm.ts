/** Field sets of the realm cards (src/main/describe/cards/realm.ts): merged into FIELDS (fieldCatalog.ts). */
import type { FieldDef } from '../fieldCatalog.ts';

const TIERS: [string, string][] = [
    ['county', 'County'],
    ['duchy', 'Duchy'],
    ['kingdom', 'Kingdom']
];

const TITLE_MAA: [string, string][] = [
    ['main_administrative_tier_and_top_liege', 'Main administrative tier and the top liege'],
    ['vassals_and_top_liege', 'Vassal titles of the main tier or above, and the top liege'],
    ['top_vassals_and_top_liege', 'Titles right under the top liege, and the top liege']
];

/** A yes/no field: `key`, its menu label, how `yes` and `no` read. */
const bool = (key: string, label: string, yes: string, no: string, k?: string): FieldDef => ({ key, label, kind: 'bool', read: { yes, no }, ...(k ? { k } : {}) });

/** A share of an income (0..1, script math allowed): subject contracts' obligation levels. */
const share = (key: string, label: string, k?: string): FieldDef => ({ key, label, kind: 'number', presets: [0, 0.1, 0.2, 0.25, 0.3, 0.5], ref: 'script_values', read: `${label}: $`, ...(k ? { k } : {}) });

export const REALM_FIELDS: Record<string, FieldDef[]> = {
    // common/laws/_laws.info: a law's own scalars (flags are the "Rules" section, the succession block its own set)
    laws: [
        { key: 'flag', label: 'Flag…', kind: 'text', k: 'f', suggest: 'values:laws:flag', read: 'Flag: $', help: 'A realm law flag (has_realm_law_flag); several are allowed' },
        bool('shown_in_encyclopedia', 'Shown in the encyclopedia', 'Shown in the encyclopedia', 'Not in the encyclopedia', 'e'),
        { key: 'title_allegiance_opinion', label: 'Allegiance opinion', kind: 'number', k: 'o', signed: true, tone: 'good', presets: [5, 10, 15, 20], read: '$ opinion from allegiance to the title' },
        { key: 'widget_name', label: 'Interface widget', kind: 'text', read: 'Shown with the interface widget $' },
        { key: 'pass_phrase', label: 'Text when passing', kind: 'text', read: 'Text when passing: $' },
        { key: 'confirmation_title', label: 'Confirmation title', kind: 'text', read: 'Confirmation title: $' },
        { key: 'confirmation_button_text', label: 'Confirmation button', kind: 'text', read: 'Confirmation button: $' }
    ],
    // common/laws/_laws.info: `succession = { … }`
    law_succession: [
        {
            key: 'order_of_succession',
            label: 'Order of succession',
            kind: 'choice',
            k: 'o',
            read: 'Succession: $',
            options: [
                ['inheritance', 'Inheritance'],
                ['election', 'Election'],
                ['appointment', 'Appointment'],
                ['theocratic', 'Theocratic — chosen by the faith'],
                ['company', 'Company — a new leader from the pool'],
                ['generate', 'A new ruler is generated'],
                ['generate_from_template', 'A new ruler from a template'],
                ['player_heir', 'The player’s heir'],
                ['noble_family', 'Within the noble family']
            ]
        },
        { key: 'title_division', label: 'Title division', kind: 'choice', k: 'd', read: '$', options: [['partition', 'Titles are split among the heirs'], ['single_heir', 'One heir gets every title']] },
        { key: 'traversal_order', label: 'Heirs come from', kind: 'choice', k: 't', read: 'Heirs come from: $', options: [['children', 'The children'], ['dynasty', 'The dynasty'], ['dynasty_house', 'The house']] },
        { key: 'rank', label: 'Order of heirs', kind: 'choice', k: 'r', read: '$', options: [['oldest', 'Oldest first'], ['youngest', 'Youngest first']] },
        {
            key: 'gender_law',
            label: 'Gender law',
            kind: 'choice',
            k: 'g',
            read: 'Heirs: $',
            options: [
                ['male_only', 'Men only'],
                ['male_preference', 'Men before women'],
                ['equal', 'Men and women equally'],
                ['female_preference', 'Women before men'],
                ['female_only', 'Women only']
            ]
        },
        { key: 'faith', label: 'Faith of heirs', kind: 'choice', k: 'f', read: 'Heirs must share the ruler’s $', options: [['same_faith', 'faith'], ['same_religion', 'religion'], ['same_family', 'religious family']], help: 'Ignored when nobody fits' },
        { key: 'election_type', label: 'Election', kind: 'ref', k: 'e', ref: 'succession_election', read: 'Election: $' },
        { key: 'appointment_type', label: 'Appointment', kind: 'ref', k: 'a', ref: 'succession_appointment', read: 'Appointment: $' },
        { key: 'pool_character_config', label: 'Pool selector', kind: 'ref', k: 'p', ref: 'pool_character_selectors', read: 'Heirs picked from the pool by $' },
        bool('create_primary_tier_titles', 'Create primary tier titles', 'Younger heirs get new titles of the primary tier', 'No new titles for younger heirs', 'c'),
        { key: 'primary_heir_minimum_share', label: 'Primary heir’s share', kind: 'number', k: 's', presets: [0.25, 0.5, 0.75], read: 'The primary heir gets at least $ of the titles' },
        bool('exclude_rulers', 'Exclude rulers', 'Rulers cannot inherit', 'Rulers can inherit', 'x'),
        bool('limit_to_courtiers', 'Courtiers only', 'Only courtiers can inherit', 'Not only courtiers inherit', 'l')
    ],
    // common/laws/_laws.info: a law group's own scalars
    law_groups: [
        { key: 'default', label: 'Default law', kind: 'ref', k: 'd', ref: 'laws', read: 'Default: $', help: 'New rulers start with it when its should_start_with allows' },
        bool('cumulative', 'Cumulative', 'Cumulative — each law has the effects of the laws before it', 'Not cumulative', 'c'),
        bool('is_treasury_budget_group', 'Treasury budget', 'Part of the treasury budget', 'Not in the treasury budget', 't'),
        { key: 'flag', label: 'Flag…', kind: 'text', k: 'f', suggest: 'values:law_groups:flag', read: 'Flag: $' }
    ],
    // common/governments/_governments.info
    governments: [
        {
            key: 'mechanic_type',
            label: 'Kind of government',
            kind: 'choice',
            k: 'm',
            read: 'Kind: $',
            options: [
                ['feudal', 'Feudal'],
                ['mercenary', 'Mercenary'],
                ['holy_order', 'Holy order'],
                ['clan', 'Clan'],
                ['theocracy', 'Theocracy'],
                ['administrative', 'Administrative'],
                ['landless_adventurer', 'Landless adventurer'],
                ['herder', 'Herder'],
                ['nomad', 'Nomad'],
                ['mandala', 'Mandala']
            ]
        },
        bool('is_mechanic_type_default', 'Default of its kind', 'The default government of its kind', 'Not the default of its kind', 'd'),
        { key: 'fallback', label: 'Fallback priority', kind: 'number', k: 'f', presets: [1, 2, 3], read: 'Fallback government, priority $', help: 'Used when no other government is valid (1 before 2)' },
        { key: 'primary_holding', label: 'Primary holding', kind: 'ref', k: 'p', ref: 'holdings', read: 'Primary holding: $' },
        { key: 'royal_court', label: 'Royal court', kind: 'choice', k: 'r', read: 'Royal court: $', options: [['none', 'None'], ['any', 'Rulers and their vassals'], ['top_liege', 'Independent rulers only']] },
        { key: 'vassal_contract_group', label: 'Vassal contracts', kind: 'ref', k: 'v', ref: 'subject_contracts/groups', read: 'Vassal contracts: $' },
        { key: 'house_unity', label: 'House unity', kind: 'ref', k: 'u', ref: 'house_unities', read: 'House unity: $' },
        { key: 'domicile_type', label: 'Domicile', kind: 'ref', k: 'o', ref: 'domiciles/types', read: 'Domicile: $' },
        { key: 'tax_slot_type', label: 'Tax slots', kind: 'ref', ref: 'tax_slots/types', read: 'Tax slots: $' },
        { key: 'generated_character_template', label: 'Generated characters', kind: 'ref', ref: 'scripted_character_templates', read: 'New characters from the template $' },
        { key: 'main_administrative_tier', label: 'Main administrative tier', kind: 'choice', read: 'Main administrative tier: $', options: TIERS },
        { key: 'min_appointment_tier', label: 'Appointment from tier', kind: 'choice', read: 'Appointment succession from the $ tier up', options: TIERS },
        { key: 'minimum_provincial_maa_tier', label: 'Title troops from tier', kind: 'choice', read: 'Title troops from the $ tier up', options: TIERS },
        { key: 'title_maa_setup', label: 'Title troops for', kind: 'choice', read: 'Title troops for: $', options: TITLE_MAA },
        { key: 'administrative_title_maa_setup', label: 'Title troops for', kind: 'choice', read: 'Title troops for: $', options: TITLE_MAA },
        { key: 'supply_limit_mult_for_others', label: 'Supply limit for others', kind: 'number', presets: [-0.5, -0.25, 0.25], read: 'Supply limit multiplier for armies of other governments: $' },
        { key: 'court_generate_commanders', label: 'Generate commanders', kind: 'number', presets: [0, 1, 2], read: 'Courts generate commanders: $' },
        { key: 'max_dread', label: 'Maximum dread', kind: 'number', presets: [50, 100], read: 'Dread is capped at $' }
    ],
    // common/governments/_governments.info: `government_rules = { … }` (government_allows)
    government_rules: [
        bool('create_cadet_branches', 'Cadet branches', 'Rulers can found cadet branches', 'No cadet branches'),
        bool('religious', 'Clergy', 'Rulers are clergy', 'Rulers are not clergy'),
        bool('court_generate_spouses', 'Spouses at court', 'New realms get suitable spouses at court', 'No spouses generated at court'),
        bool('council', 'Council', 'Has a council', 'No council'),
        bool('rulers_should_have_dynasty', 'Dynasty', 'Rulers get a dynasty', 'Rulers need no dynasty'),
        bool('regiments_prestige_as_gold', 'Men-at-arms for prestige', 'Men-at-arms are bought and reinforced with prestige', 'Men-at-arms cost gold'),
        bool('dynasty_named_realms', 'Dynasty-named realms', 'Realms can be named after the ruler’s dynasty and culture', 'Realms keep their own names'),
        bool('legitimacy', 'Legitimacy', 'Uses legitimacy', 'No legitimacy'),
        bool('administrative', 'Administrative', 'Administrative: noble families as landless vassals, title troops', 'Not administrative'),
        bool('admin_allows_holding_multiple_primary_tier_titles', 'Several primary titles', 'Can hold several titles of the primary tier', 'One title of the primary tier'),
        bool('landless_playable', 'Playable landless', 'Playable without land', 'Needs land to be played'),
        bool('allow_out_of_realm_inheritance', 'Inheritance from outside', 'Can inherit from outside the realm', 'No inheritance from outside the realm'),
        bool('use_as_base_on_landed', 'Kept on becoming landed', 'Taken by an heir who becomes landed from a holder of it', 'Not taken on becoming landed'),
        bool('use_as_base_on_rank_up', 'Kept on rank-up', 'Taken by an independent ruler who gains a higher title from a holder of it', 'Not taken on rank-up'),
        bool('conditional_maa_refill', 'Conditional reinforcement', 'Men-at-arms only reinforce under their own conditions, without upkeep', 'Men-at-arms reinforce normally'),
        bool('mercenary', 'Mercenary', 'Landless rulers can hire themselves out as mercenaries', 'No hiring out as mercenaries'),
        bool('state_faith', 'State faith', 'Uses a state faith', 'No state faith'),
        bool('treasury', 'Treasury', 'Uses the treasury', 'No treasury'),
        bool('merit', 'Merit', 'Uses merit', 'No merit'),
        bool('uses_county_fertility', 'County fertility', 'Uses county fertility', 'No county fertility'),
        bool('replenishes_county_fertility', 'Replenishes fertility', 'Replenishes county fertility', 'Does not replenish county fertility'),
        bool('obedience', 'Obedience', 'Uses obedience', 'No obedience'),
        bool('uses_culture_and_house_head_named_realms', 'Culture-named realms', 'Realms named after the culture and house head', 'Not named after the culture and house head'),
        bool('sticky_government', 'Sticky', 'Sticky — rulers keep it', 'Not sticky'),
        bool('subject_men_at_arms', 'Subject men-at-arms', 'Subjects provide men-at-arms', 'No men-at-arms from subjects'),
        bool('use_title_tier_modifiers', 'Title tier bonuses', 'Prestige and modifiers from title tiers', 'No prestige or modifiers from title tiers'),
        bool('inherit_from_dynastic_government', 'Inherits from dynastic governments', 'Can inherit from dynastic governments', 'Cannot inherit from dynastic governments'),
        bool('deny_powerful_vassal', 'Never a powerful vassal', 'Never a powerful vassal', 'Can be a powerful vassal'),
        bool('use_maa_maintenance', 'Men-at-arms upkeep', 'Pays men-at-arms upkeep', 'No men-at-arms upkeep'),
        bool('no_capital_movement_cooldown', 'Capital moves freely', 'Can move the capital without a cooldown', 'Capital moves have a cooldown'),
        bool('redirects_wars_to_overlord', 'Wars go to the overlord', 'Wars against it are redirected to its overlord', 'Wars are not redirected'),
        bool('noble_families', 'Noble families', 'Allows noble family titles', 'No noble family titles'),
        bool('house_aspirations', 'House aspirations', 'Uses house aspirations', 'No house aspirations'),
        bool('replace_gold_cost_by_treasury', 'Pays from the treasury', 'State expenses are paid from the treasury', 'State expenses are paid in gold'),
        bool('block_alliance_child_marriage', 'No alliances from children', 'Children’s marriages make no alliances', 'Children’s marriages make alliances'),
        bool('block_alliance_non_dominant_gender_child_marriage', 'No alliances from some children', 'Marriages of children of the non-dominant gender make no alliances', 'Marriages of all children make alliances'),
        bool('always_use_patronym', 'Patronyms', 'Always shows patronyms', 'Patronyms as the culture has them'),
        bool('affected_by_development', 'Development', 'Counties are affected by development', 'Counties are not affected by development'),
        bool('considers_piety_for_title_creation', 'Piety for titles', 'Piety counts for creating titles', 'Piety does not count for creating titles'),
        bool('ask_for_tribute', 'Asks for tribute', 'Can ask others to become tributaries', 'Cannot ask for tribute'),
        bool('barter', 'Barter', 'Uses bartering', 'No bartering'),
        bool('buildings', 'Buildings', 'Can construct buildings in holdings', 'Cannot construct buildings'),
        bool('count_tributaries_for_title_requirements', 'Tributaries’ land counts', 'Tributaries’ land counts for creating or usurping titles', 'Only its own land counts for titles'),
        bool('radiance', 'Radiance', 'Uses radiance', 'No radiance'),
        bool('disable_regnal_numbers', 'No regnal numbers', 'No regnal numbers', 'Regnal numbers'),
        bool('allow_accolades', 'Accolades', 'Can have accolades', 'No accolades'),
        bool('allow_as_base_for_baronies', 'Barony holders', 'Can be the government of barony holders', 'Not for barony holders')
    ],
    // common/governments/_governments.info: `ai = { … }`
    government_ai: [
        bool('use_lifestyle', 'Lifestyles', 'AI picks lifestyles', 'AI picks no lifestyle'),
        bool('arrange_marriage', 'Marriages', 'AI arranges marriages', 'AI arranges no marriages'),
        bool('use_goals', 'Long-term goals', 'AI pursues long-term goals', 'AI pursues no long-term goals'),
        bool('use_decisions', 'Decisions', 'AI takes minor decisions', 'AI takes no minor decisions'),
        bool('use_scripted_guis', 'Scripted interfaces', 'AI uses scripted interface actions', 'AI uses no scripted interface actions'),
        bool('use_legends', 'Legends', 'AI creates and promotes legends', 'AI creates no legends'),
        bool('perform_religious_reformation', 'Reformation', 'AI reforms its faith', 'AI never reforms its faith'),
        bool('use_great_projects', 'Great projects', 'AI founds and contributes to great projects', 'AI stays out of great projects')
    ],
    // common/succession_appointment/_succession_appointment.info
    succession_appointment: [
        { key: 'level', label: 'Candidates by level', kind: 'choice', k: 'l', read: 'Candidates: everyone with enough $', options: [['merit', 'merit'], ['prestige', 'prestige'], ['piety', 'piety'], ['influence', 'influence']], help: 'Replaces the default candidates' },
        bool('allow_children', 'Children', 'Children can be appointed', 'Children cannot be appointed', 'c'),
        bool('allow_same_tier_candidates', 'Same tier', 'Holders of a title of the same tier can be candidates', 'Holders of a title of the same tier cannot be candidates', 's')
    ],
    // common/landed_titles/_landed_titles.info
    landed_titles: [
        { key: 'capital', label: 'Capital', kind: 'ref', k: 'c', ref: 'landed_titles', read: 'Capital: $' },
        { key: 'province', label: 'Province', kind: 'number', presets: [], read: 'Province $' },
        bool('landless', 'Landless', 'A landless title', 'A landed title', 'l'),
        bool('definite_form', 'Definite form', 'Named in its definite form', 'No definite form', 'd'),
        bool('ruler_uses_title_name', 'Holder named after it', 'Its holder is named after it', 'Its holder is not named after it', 'r'),
        bool('noble_family', 'Noble family', 'A noble family title', 'Not a noble family title', 'n'),
        bool('always_follows_primary_heir', 'Follows the primary heir', 'Always goes to the primary heir', 'Not bound to the primary heir', 'p'),
        bool('destroy_if_invalid_heir', 'Destroyed without a valid heir', 'Destroyed when there is no valid heir', 'Kept without a valid heir', 'i'),
        bool('destroy_on_succession', 'Destroyed on succession', 'Destroyed on succession', 'Kept on succession'),
        bool('delete_on_destroy', 'Deleted when destroyed', 'Deleted when destroyed', 'Kept when destroyed'),
        bool('delete_on_gain_same_tier', 'Deleted on a same-tier title', 'Deleted when the holder gains another title of its tier', 'Kept when the holder gains a title of its tier'),
        bool('no_automatic_claims', 'No automatic claims', 'Heirs get no automatic claims', 'Heirs get automatic claims', 'a'),
        bool('can_be_named_after_dynasty', 'Named after the dynasty', 'Can be named after its holder’s dynasty', 'Never named after its holder’s dynasty'),
        bool('can_use_nomadic_naming', 'Nomadic naming', 'Can use nomadic naming', 'No nomadic naming'),
        bool('require_landless', 'Landless holders only', 'Only for landless holders — may be destroyed when they gain land', 'Holders may have land'),
        bool('de_jure_drift_disabled', 'No de jure drift', 'Titles do not drift into it', 'Titles can drift into it'),
        bool('allow_domicile', 'Domicile', 'Allows a domicile', 'No domicile'),
        bool('disable_regnal_numbers', 'No regnal numbers', 'No regnal numbers', 'Regnal numbers'),
        bool('figurehead', 'Figurehead', 'Has figurehead status', 'No figurehead status'),
        bool('ignore_titularity_for_title_weighting', 'Titularity ignored', 'The AI ignores whether it is titular when picking a primary title', 'The AI weighs whether it is titular')
    ],
    // common/holdings/_holdings.info
    holdings: [
        { key: 'primary_building', label: 'Primary building', kind: 'ref', k: 'p', ref: 'buildings', read: 'Primary building: $' },
        bool('can_be_inherited', 'Inherited', 'Baronies with it can be inherited', 'Baronies with it cannot be inherited', 'i'),
        bool('counts_toward_domain_limit_if_disabled', 'Domain limit when disabled', 'Counts toward the domain limit when disabled', 'Does not count toward the domain limit when disabled', 'd')
    ],
    // common/subject_contracts/contracts/_subject_contracts.info
    'subject_contracts/contracts': [
        { key: 'display_mode', label: 'Shown as', kind: 'choice', k: 'd', read: 'Shown as: $', options: [['tree', 'A tree of levels'], ['radiobutton', 'One of several options'], ['checkbox', 'A checkbox'], ['hidden', 'Hidden']] },
        bool('defaults_to_highest_valid_level', 'Highest level by default', 'Defaults to the highest valid level', 'Defaults to its default level', 'h'),
        bool('uses_opinion_of_liege', 'Uses the liege’s opinion', 'Its levels can use the subject’s opinion of the liege', 'Its levels do not use the opinion of the liege', 'o')
    ],
    // an obligation level (`obligation_levels = { <level> = { … } }`)
    obligation_level: [
        share('tax', 'Tax', 't'),
        share('levies', 'Levies', 'l'),
        share('herd', 'Herd', 'h'),
        share('barter_goods', 'Barter goods', 'b'),
        share('prestige', 'Prestige'),
        share('piety', 'Piety'),
        share('min_tax', 'At least tax'),
        share('min_levies', 'At least levies'),
        share('min_herd', 'At least herd'),
        share('min_barter_goods', 'At least barter goods'),
        { key: 'subject_opinion', label: 'Subject’s opinion', kind: 'number', k: 'o', signed: true, tone: 'good', presets: [5, 10, 15, -5, -10, -15, -25], read: '$ opinion of the liege' },
        { key: 'score', label: 'Score', kind: 'number', k: 's', presets: [-2, -1, 0, 1, 2], read: 'Score $ (above 0 favours the subject)', help: 'Compared when obligations change; defaults to the order of the levels' },
        bool('default', 'Default level', 'The default level', 'Not the default level', 'd'),
        { key: 'parent', label: 'Follows', kind: 'text', k: 'p', read: 'Follows $' },
        { key: 'flag', label: 'Flag…', kind: 'text', k: 'f', read: 'Flag: $' },
        { key: 'tax_factor', label: 'Tax factor', kind: 'number', ref: 'script_values', presets: [0.5, 1.5, 2], read: 'Tax ×$' },
        { key: 'levies_factor', label: 'Levies factor', kind: 'number', ref: 'script_values', presets: [0.5, 1.5, 2], read: 'Levies ×$' },
        { key: 'herd_factor', label: 'Herd factor', kind: 'number', ref: 'script_values', presets: [0.5, 1.5, 2], read: 'Herd ×$' },
        bool('enable_title_maa', 'Title troops', 'Title troops allowed', 'No title troops'),
        bool('enable_character_maa', 'Character men-at-arms', 'Character men-at-arms allowed', 'No character men-at-arms'),
        { key: 'appointment_trait_flag', label: 'Heirs need a trait flag', kind: 'text', read: 'Heirs need a trait with the flag “$”' }
    ],
    // common/subject_contracts/groups/_subject_contract_groups.info
    'subject_contracts/groups': [
        { key: 'admin_province_contract', label: 'Province contract', kind: 'ref', k: 'p', ref: 'subject_contracts/contracts', read: 'Province contract: $' },
        { key: 'modify_contract_layout', label: 'Window layout', kind: 'text', read: 'Contract window layout: $' },
        bool('is_tributary', 'Tributary', 'A tributary contract', 'A vassal contract', 't'),
        bool('joins_suzerain_wars', 'Joins wars', 'Tributaries join their suzerain’s wars', 'Tributaries stay out of their suzerain’s wars', 'w'),
        bool('tributary_heir_succession', 'Heirs stay tributaries', 'The tributary’s heirs stay tributaries', 'The tributary’s heirs go free', 'h'),
        bool('suzerain_heir_succession', 'Suzerain’s heir takes over', 'The suzerain’s heir takes over as suzerain', 'The suzerain’s heir does not take over', 's'),
        bool('should_show_as_suzerain_realm_name', 'Suzerain’s realm name', 'Shown with the suzerain’s realm name on the map', 'Keeps its own realm name on the map'),
        bool('should_show_as_suzerain_realm_color', 'Suzerain’s realm colour', 'Shown in (a blend of) the suzerain’s realm colour on the map', 'Keeps its own realm colour on the map'),
        { key: 'suzerain_line_type', label: 'Line to the suzerain', kind: 'text', read: 'Map line to the suzerain: $' },
        { key: 'tributary_line_type', label: 'Line to tributaries', kind: 'text', read: 'Map line to tributaries: $' }
    ],
    // common/lease_contracts/_lease_contracts.info
    lease_contracts: [
        { key: 'government', label: 'Government', kind: 'ref', k: 'g', ref: 'governments', read: 'Government: $' },
        { key: 'ruler_share_min_opinion_from_lessee', label: 'Opinion for a share', kind: 'number', k: 'o', presets: [1, 25, 50], read: 'The ruler gets a share from $ opinion of the lessee' },
        { key: 'hook_strength_max_opinion', label: 'Hook for the full share', kind: 'choice', k: 'h', read: 'Hook that counts as full opinion: $', options: [['none', 'None'], ['any', 'Any hook'], ['strong', 'A strong hook']] }
    ],
    // common/hook_types/_hooks.info
    hook_types: [
        { key: 'expiration_days', label: 'Expires after (days)', kind: 'number', k: 'e', presets: [365, 1825, 3650, 7300, -1], read: 'Expires after $ days', help: '-1 or none: never expires' },
        bool('strong', 'Strong', 'A strong hook — put on cooldown instead of used up', 'A weak hook', 's'),
        bool('perpetual', 'Reusable', 'Can be used again', 'Used up when used', 'p'),
        bool('requires_secret', 'Needs a secret', 'Needs a secret', 'Needs no secret', 'r')
    ],
    casus_belli_groups: [
        bool('can_only_start_via_script', 'Only by script', 'Only started by script', 'Rulers can declare it', 's'),
        bool('should_check_for_interface_availability', 'Checked for the interface', 'Its availability is checked for the war interface', 'Not checked for the war interface', 'i'),
        bool('debug', 'Debug', 'Debug only', 'Not debug only', 'd')
    ],
    // common/men_at_arms_types/_men_at_arms_types.info
    men_at_arms_types: [
        { key: 'type', label: 'Type', kind: 'text', k: 't', suggest: 'values:men_at_arms_types:type', read: 'Type: $' },
        { key: 'damage', label: 'Damage', kind: 'number', k: 'd', presets: [10, 20, 30, 50, 100], read: '$ damage' },
        { key: 'toughness', label: 'Toughness', kind: 'number', k: 'o', presets: [10, 20, 30, 50], read: '$ toughness' },
        { key: 'pursuit', label: 'Pursuit', kind: 'number', k: 'p', presets: [0, 10, 20, 30], read: '$ pursuit — damage dealt when winning' },
        { key: 'screen', label: 'Screen', kind: 'number', k: 's', presets: [0, 10, 20, 30], read: '$ screen — damage avoided when losing' },
        { key: 'siege_value', label: 'Siege value', kind: 'number', presets: [0.1, 0.5, 1], read: '$ siege value' },
        { key: 'siege_tier', label: 'Siege tier', kind: 'number', presets: [1, 2, 3], read: 'Siege tier $ against forts' },
        { key: 'stack', label: 'Soldiers per sub-regiment', kind: 'number', k: 'k', presets: [25, 50, 100], read: '$ soldiers per sub-regiment' },
        { key: 'hired_stack_size', label: 'Hired sub-regiment size', kind: 'number', presets: [25, 50], read: '$ soldiers per hired sub-regiment' },
        { key: 'max', label: 'Size limit', kind: 'number', presets: [1, 2, 3], read: 'Size limit $' },
        { key: 'max_regiments', label: 'Most regiments', kind: 'number', presets: [1, 2, 3], read: 'At most $ regiments' },
        { key: 'max_sub_regiments', label: 'Most sub-regiments', kind: 'number', presets: [1, 5, 10], read: 'One regiment of at most $ sub-regiments' },
        { key: 'provision_cost', label: 'Provisions', kind: 'number', presets: [3, 7, 12, 15], read: '$ provisions when moving the domicile' },
        bool('fights_in_main_phase', 'Fights in the main phase', 'Fights in the main phase', 'Only fights in the pursuit phase'),
        bool('special_recruit_only', 'Never recruited', 'Never recruited — only made by events and effects', 'Can be recruited'),
        bool('allowed_in_hired_troops', 'Hired troops', 'Can be hired troops', 'Never among hired troops'),
        bool('holy_order_fallback', 'Holy orders use it less', 'Holy orders use it less', 'Holy orders use it normally'),
        bool('mercenary_fallback', 'Mercenaries use it less', 'Mercenaries use it less', 'Mercenaries use it normally'),
        bool('fallback_in_hired_troops_if_unlocked', 'Not preferred by hired troops', 'Hired troops do not prefer it once unlocked', 'Hired troops prefer it once unlocked')
    ],
    // a men-at-arms type's terrain, winter and holding bonuses: `forest = { damage = 4 toughness = 6 }`
    maa_bonus: [
        { key: 'damage', label: 'Damage', kind: 'number', k: 'd', signed: true, tone: 'good', presets: [2, 4, 6, 10, -2, -4], read: '$ damage' },
        { key: 'toughness', label: 'Toughness', kind: 'number', k: 't', signed: true, tone: 'good', presets: [2, 4, 6, 10, -2, -4], read: '$ toughness' },
        { key: 'pursuit', label: 'Pursuit', kind: 'number', k: 'p', signed: true, tone: 'good', presets: [2, 4, 6, 10, -2, -4], read: '$ pursuit' },
        { key: 'screen', label: 'Screen', kind: 'number', k: 's', signed: true, tone: 'good', presets: [2, 4, 6, 10, -2, -4], read: '$ screen' },
        { key: 'siege_value', label: 'Siege value', kind: 'number', k: 'v', signed: true, tone: 'good', presets: [0.1, 0.5, 1], read: '$ siege value' }
    ],
    // common/ai_war_stances/_ai_war_stances.info
    ai_war_stances: [
        { key: 'side', label: 'Side', kind: 'choice', k: 's', read: 'Side: $', options: [['attacker', 'Attacker'], ['defender', 'Defender']] },
        { key: 'enemy_unit_priority', label: 'Enemy army priority', kind: 'number', k: 'e', presets: [50, 100, 250, 500], read: 'Priority $ for enemy armies half its strength' }
    ],
    // `behaviour_attributes = { … }`: when the stance is considered
    war_stance_behaviour: [
        bool('stronger', 'When stronger', 'When its side is stronger', 'Not when stronger', 's'),
        bool('weaker', 'When weaker', 'When its side is weaker', 'Not when weaker', 'w'),
        bool('desperate', 'When desperate', 'When its side is desperate — much weaker and about to lose', 'Not when desperate', 'd')
    ],
    // common/game_rules/_game_rules.info
    game_rules: [{ key: 'default', label: 'Default setting', kind: 'ref', k: 'd', ref: 'game_rule_options', read: 'Default: $' }],
    // common/house_unities/_house_unities.info
    house_unities: [
        { key: 'default_value', label: 'Starting unity', kind: 'number', k: 'd', presets: [0, 50, 100], read: 'Starts at $ unity' },
        { key: 'min_value', label: 'Lowest unity', kind: 'number', k: 'm', presets: [0], read: 'Never below $ unity' }
    ],
    // a house unity stage (`<stage> = { points = 40 … }`)
    house_unity_stage: [
        { key: 'points', label: 'Points', kind: 'number', k: 'p', presets: [20, 40, 60], read: 'Spans $ points of unity' },
        { key: 'succession_law_flag', label: 'Succession law flag', kind: 'text', read: 'Succession law flag: $' }
    ],
    // common/house_relation_types/_house_relation.info
    house_relation_types: [{ key: 'neutral_level', label: 'Neutral level', kind: 'text', k: 'n', read: 'Neutral level: $' }],
    // a house relation level (`levels = { <level> = { opinion = -30 … } }`)
    house_relation_level: [
        { key: 'opinion', label: 'Opinion', kind: 'number', k: 'o', signed: true, tone: 'good', presets: [5, 10, 20, 30, -10, -20, -30], read: '$ opinion between their members' },
        { key: 'cohesion_contribution', label: 'Cohesion', kind: 'number', k: 'c', signed: true, tone: 'good', presets: [10, 20, 30, -10, -20, -30], read: '$ monthly cohesion when both are in a bloc' }
    ]
};
