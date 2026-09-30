/** Field sets of the culture cards (src/main/describe/cards/culture.ts): merged into FIELDS (fieldCatalog.ts). */
import type { FieldDef } from '../fieldCatalog.ts';

const CHANCE = [0, 5, 10, 20, 25, 50];

/** culture/eras/_culture_eras.info and culture/innovations/_culture_innovations.info: what an era / innovation unlocks */
const UNLOCKS: FieldDef[] = [
    { key: 'unlock_building', label: 'Unlocks a building…', kind: 'ref', k: 'b', ref: 'buildings', read: 'Unlocks the building $', help: 'Only shown in the tooltip: the building itself must check for it' },
    { key: 'unlock_maa', label: 'Unlocks men-at-arms…', kind: 'ref', k: 'm', ref: 'men_at_arms_types', read: 'Unlocks the men-at-arms $' },
    { key: 'unlock_law', label: 'Unlocks a law…', kind: 'ref', k: 'l', ref: 'laws', read: 'Unlocks the law $', help: 'Only shown in the tooltip: the law itself must check for it' },
    { key: 'unlock_decision', label: 'Unlocks a decision…', kind: 'ref', k: 'd', ref: 'decisions', read: 'Unlocks the decision $', help: 'Only shown in the tooltip: the decision itself must check for it' },
    { key: 'unlock_casus_belli', label: 'Unlocks a casus belli…', kind: 'ref', k: 'w', ref: 'casus_belli_types', read: 'Unlocks the casus belli $', help: 'Only shown in the tooltip: the casus belli itself must check for it' },
    { key: 'custom', label: 'Custom effect text…', kind: 'text', k: 'c', read: 'Text: $', help: 'A loc key listed among its effects' }
];

/** Temple models, piety icons and the tenet banner (religion/religion_types/_religion_types.info: faith > religion > family) */
const FAITH_LOOK: FieldDef[] = [
    { key: 'graphical_faith', label: 'Temple look…', kind: 'text', k: 'g', suggest: 'values:faith:graphical_faith', read: '3D models (temples): $' },
    { key: 'piety_icon_group', label: 'Piety icons…', kind: 'text', k: 'p', read: 'Piety icons: $' },
    { key: 'doctrine_background_icon', label: 'Tenet banner…', kind: 'text', read: 'Tenet banner: $' }
];

/** Name and prefix (loc keys), motto, coat of arms style of a dynasty or house (history in common/dynasties, dynasty_houses) */
const HOUSE: FieldDef[] = [
    { key: 'name', label: 'Name (loc key)…', kind: 'text', k: 'n', read: 'Name: $' },
    { key: 'prefix', label: 'Prefix (loc key)…', kind: 'text', k: 'p', suggest: 'values:dynasty_houses:prefix', read: 'Prefix: $' },
    { key: 'motto', label: 'Motto (loc key)…', kind: 'text', k: 'm', read: 'Motto: $', help: 'The motto it has at game start' },
    { key: 'forced_coa_religiongroup', label: 'Coat of arms style…', kind: 'choice', k: 'c', read: 'Coat of arms in the $ style', options: [['christian', 'Christian'], ['muslim', 'Muslim'], ['zoroastrian_group', 'Zoroastrian']] }
];

export const CULTURE_FIELDS: Record<string, FieldDef[]> = {
    // culture/cultures/_cultures.info: pillars, names, look
    'culture/cultures': [
        { key: 'ethos', label: 'Ethos…', kind: 'text', k: 'e', suggest: 'values:culture/cultures:ethos', read: 'Ethos: $' },
        { key: 'heritage', label: 'Heritage…', kind: 'text', k: 'h', suggest: 'values:culture/cultures:heritage', read: 'Heritage: $' },
        { key: 'language', label: 'Language…', kind: 'text', k: 'l', suggest: 'values:culture/cultures:language', read: 'Language: $' },
        { key: 'martial_custom', label: 'Martial custom…', kind: 'text', k: 'm', suggest: 'values:culture/cultures:martial_custom', read: 'Martial custom: $' },
        { key: 'head_determination', label: 'Head of culture…', kind: 'text', k: 'd', suggest: 'values:culture/cultures:head_determination', read: 'Head of culture: $' },
        { key: 'name_list', label: 'Name list…', kind: 'ref', k: 'n', ref: 'culture/name_lists', read: 'Names from $', help: 'Several are allowed; the first is the main one (prefixes)' },
        { key: 'name_order_convention', label: 'Name order…', kind: 'choice', k: 'o', read: 'Name order: $', options: [['dynasty_always_first', 'Dynasty name first, always shown'], ['dynasty_first', 'Dynasty name first'], ['japanese', 'Japanese']] },
        { key: 'created', label: 'Created on (date)…', kind: 'text', k: 'c', read: 'Created on $', help: 'y.m.d' },
        { key: 'house_coa_frame', label: 'House coat of arms frame…', kind: 'text', k: 'f', suggest: 'values:culture/cultures:house_coa_frame', read: 'House coat of arms frame: $' },
        { key: 'dynasty_coa_frame', label: 'Dynasty coat of arms frame…', kind: 'text', read: 'Dynasty coat of arms frame: $' },
        { key: 'history_loc_override', label: 'History text (loc key)…', kind: 'text', read: 'History text: $' }
    ],
    // culture/name_lists/_name_lists.info: naming customs
    'culture/name_lists': [
        { key: 'pat_grf_name_chance', label: 'Named after the father’s father (%)', kind: 'number', k: 'g', presets: CHANCE, read: '$% of sons are named after their father’s father' },
        { key: 'mat_grf_name_chance', label: 'Named after the mother’s father (%)', kind: 'number', k: 'h', presets: CHANCE, read: '$% of sons are named after their mother’s father' },
        { key: 'father_name_chance', label: 'Named after the father (%)', kind: 'number', k: 'f', presets: CHANCE, read: '$% of sons are named after their father' },
        { key: 'pat_grm_name_chance', label: 'Named after the father’s mother (%)', kind: 'number', k: 'i', presets: CHANCE, read: '$% of daughters are named after their father’s mother' },
        { key: 'mat_grm_name_chance', label: 'Named after the mother’s mother (%)', kind: 'number', k: 'j', presets: CHANCE, read: '$% of daughters are named after their mother’s mother' },
        { key: 'mother_name_chance', label: 'Named after the mother (%)', kind: 'number', k: 'm', presets: CHANCE, read: '$% of daughters are named after their mother' },
        { key: 'founder_named_dynasties', label: 'Dynasties named after founders', kind: 'bool', k: 'd', read: { yes: 'New dynasties and cadet branches are named after their founder', no: 'New dynasties are not named after their founder' } },
        { key: 'house_based_map_names', label: 'Realms named after houses', kind: 'bool', k: 'r', read: { yes: 'Realms can be named after the ruler’s house on the map', no: 'Realms are not named after houses' } },
        { key: 'suggest_family_names', label: 'Suggest family names', kind: 'bool', read: { yes: 'Names from within the family are suggested', no: 'No names from within the family are suggested' } },
        { key: 'suggest_ancestor_names', label: 'Suggest ancestors’ names', kind: 'bool', read: { yes: 'Ancestors’ names are suggested', no: 'No ancestors’ names are suggested' } },
        { key: 'always_use_patronym', label: 'Always show patronyms', kind: 'bool', k: 'a', read: { yes: 'Patronyms are always shown', no: 'Patronyms only where the government shows them' } },
        { key: 'dynasty_name_first', label: 'Dynasty name first', kind: 'bool', read: { yes: 'The dynasty name comes before the first name', no: 'The dynasty name comes after the first name' } },
        { key: 'dynasty_of_location_prefix', label: 'Prefix of dynasties named after a place…', kind: 'text', k: 'l', suggest: 'values:culture/name_lists:dynasty_of_location_prefix', read: 'Dynasties named after a place: $…' },
        { key: 'bastard_dynasty_prefix', label: 'Prefix of bastard dynasties…', kind: 'text', read: 'Bastard dynasties: $…' },
        { key: 'patronym_prefix_male', label: 'Patronym prefix for sons…', kind: 'text', read: 'Sons: $' },
        { key: 'patronym_prefix_male_vowel', label: 'Patronym prefix for sons (vowel)…', kind: 'text', read: 'Sons, before a vowel: $' },
        { key: 'patronym_prefix_female', label: 'Patronym prefix for daughters…', kind: 'text', read: 'Daughters: $' },
        { key: 'patronym_prefix_female_vowel', label: 'Patronym prefix for daughters (vowel)…', kind: 'text', read: 'Daughters, before a vowel: $' },
        { key: 'patronym_suffix_male', label: 'Patronym suffix for sons…', kind: 'text', read: 'Sons: $' },
        { key: 'patronym_suffix_female', label: 'Patronym suffix for daughters…', kind: 'text', read: 'Daughters: $' },
        { key: 'grammar_transform', label: 'Grammar transform…', kind: 'text', read: 'Grammar: $' }
    ],
    // culture/eras/_culture_eras.info
    'culture/eras': [
        { key: 'year', label: 'Starting year', kind: 'number', k: 'y', presets: [0, 900, 1050, 1200, 1300], read: 'Starts spreading in $', help: 'Innovations of the era can get base progress from this year on' },
        { key: 'invalid_for_government', label: 'Not for a government…', kind: 'ref', k: 'g', ref: 'governments', read: 'Not for the government $' },
        ...UNLOCKS
    ],
    // culture/innovations/_culture_innovations.info
    'culture/innovations': [
        { key: 'culture_era', label: 'Era…', kind: 'ref', k: 'e', ref: 'culture/eras', read: 'Era: $' },
        { key: 'group', label: 'Group…', kind: 'choice', k: 'g', read: 'Group: $', options: [['culture_group_military', 'Military'], ['culture_group_civic', 'Civic'], ['culture_group_regional', 'Cultural and regional']] },
        { key: 'skill', label: 'Skill of the head of culture…', kind: 'choice', k: 's', read: 'Fascination uses the head of culture’s $', options: [['learning', 'Learning'], ['martial', 'Martial'], ['stewardship', 'Stewardship'], ['diplomacy', 'Diplomacy'], ['intrigue', 'Intrigue']] },
        { key: 'region', label: 'Region…', kind: 'text', k: 'r', suggest: 'values:culture/innovations:region', read: 'Only progresses in $', help: 'The culture needs a minimum of provinces in the region' },
        { key: 'flag', label: 'Flag…', kind: 'text', k: 'f', suggest: 'values:culture/innovations:flag', read: 'Flag: $', help: 'For has_all_innovations; several are allowed' },
        ...UNLOCKS
    ],
    // ethnicities: the template it builds on
    ethnicities: [
        { key: 'template', label: 'Template…', kind: 'ref', k: 't', ref: 'ethnicities', read: 'Based on $' },
        { key: 'visible', label: 'Visible', kind: 'bool', k: 'v', read: { yes: 'Visible', no: 'Hidden — a template for others' } }
    ],
    // religion/religion_types/_religion_types.info: a faith's statements
    faith: [
        { key: 'doctrine', label: 'Doctrine or tenet…', kind: 'ref', k: 'd', ref: 'religion/doctrine_types', group: 'doctrine_groups', read: 'Has $' },
        { key: 'holy_site', label: 'Holy site…', kind: 'ref', k: 'h', ref: 'religion/holy_site_types', read: 'Holy site: $' },
        { key: 'religious_head', label: 'Head of faith title…', kind: 'ref', k: 'r', ref: 'landed_titles', read: 'Head of faith: $' },
        { key: 'icon', label: 'Icon…', kind: 'text', k: 'i', suggest: 'faith_icons', read: 'Icon: $', help: 'gfx/interface/icons/faith/<name>.dds' },
        { key: 'reformed_icon', label: 'Icon once reformed…', kind: 'text', suggest: 'faith_icons', read: 'Icon once reformed: $' },
        ...FAITH_LOOK
    ],
    'religion/religion_types': [
        { key: 'family', label: 'Family…', kind: 'ref', k: 'f', ref: 'religion/religion_family_types', read: 'Family: $' },
        { key: 'doctrine', label: 'Doctrine for every faith…', kind: 'ref', k: 'd', ref: 'religion/doctrine_types', group: 'doctrine_groups', read: 'Has $', help: 'At game start, as if every faith had it; a faith’s own doctrine of the group wins' },
        { key: 'pagan_roots', label: 'Pagan roots', kind: 'bool', k: 'a', read: { yes: 'Pagan roots: faiths without the Unreformed doctrine count as reformed', no: 'No pagan roots' } },
        ...FAITH_LOOK
    ],
    // religion/religion_family_types/_religion_family_types.info
    'religion/religion_family_types': [{ key: 'hostility_doctrine', label: 'Hostility doctrine…', kind: 'ref', k: 'h', ref: 'religion/doctrine_types', read: 'Hostility shown with $' }, ...FAITH_LOOK],
    // religion/doctrine_group_types/_doctrine_group_types.info
    'religion/doctrine_group_types': [
        { key: 'category', label: 'Category…', kind: 'choice', k: 'c', read: 'Category: $', options: [['main_group', 'Main'], ['core_tenets', 'Tenets'], ['marriage', 'Marriage'], ['crimes', 'Crimes'], ['clergy', 'Clergy'], ['special', 'Special'], ['not_creatable', 'Not creatable']] },
        { key: 'number_of_picks', label: 'Number of picks', kind: 'number', k: 'n', presets: [1, 2, 3], read: '$ can be picked' }
    ],
    // religion/doctrine_types/_doctrine_types.info
    'religion/doctrine_types': [
        { key: 'visible', label: 'Visible', kind: 'bool', k: 'v', read: { yes: 'Shown in the interface', no: 'Hidden in the interface' } },
        { key: 'icon', label: 'Icon…', kind: 'text', k: 'i', suggest: 'doctrine_icons', read: 'Icon: $', help: 'Another doctrine’s icon: gfx/interface/icons/faith_doctrines/<name>.dds (default: the doctrine’s own key)' }
    ],
    // a doctrine's `parameters = { … }`: any parameter key (suggested from every doctrine's) — yes / no or a number
    doctrine_parameters: [],
    // the doctrine group a doctrine is put into (its card: "＋ put it in a group")
    doctrine_membership: [{ key: 'group', label: 'Doctrine group…', kind: 'ref', k: 'g', ref: 'religion/doctrine_group_types', read: 'In the group $' }],
    dynasties: [{ key: 'culture', label: 'Culture…', kind: 'ref', k: 'u', ref: 'culture/cultures', read: 'Culture: $' }, ...HOUSE],
    dynasty_houses: [{ key: 'dynasty', label: 'Dynasty…', kind: 'ref', k: 'd', ref: 'dynasties', read: 'Dynasty: $' }, ...HOUSE],
    // dynasty_house_mottos/_mottos.info: the words filled in as $1$, $2$ …
    dynasty_house_mottos: [{ key: 'insert', label: 'Word filled in…', kind: 'ref', k: 'i', ref: 'dynasty_house_motto_inserts', read: 'Filled in: $' }],
    // nicknames/_nicknames.info
    nicknames: [
        { key: 'is_bad', label: 'Bad nickname', kind: 'bool', k: 'b', read: { yes: 'A bad nickname', no: 'Not a bad nickname' } },
        { key: 'is_prefix', label: 'Before the name', kind: 'bool', k: 'p', read: { yes: 'Written before the name', no: 'Written after the name' } }
    ]
};
