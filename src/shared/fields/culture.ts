/** Field sets of the culture cards (src/main/describe/cards/culture.ts): merged into FIELDS (fieldCatalog.ts). */
import type { FieldDef } from '../fieldCatalog.ts';

import { tr } from '../i18n.ts';
const CHANCE = [0, 5, 10, 20, 25, 50];

/** culture/eras/_culture_eras.info and culture/innovations/_culture_innovations.info: what an era / innovation unlocks */
const UNLOCKS: FieldDef[] = [
    { key: 'unlock_building', label: tr('Unlocks a building…'), kind: 'ref', k: 'b', ref: 'buildings', read: tr('Unlocks the building $'), help: tr('Only shown in the tooltip: the building itself must check for it') },
    { key: 'unlock_maa', label: tr('Unlocks men-at-arms…'), kind: 'ref', k: 'm', ref: 'men_at_arms_types', read: tr('Unlocks the men-at-arms $') },
    { key: 'unlock_law', label: tr('Unlocks a law…'), kind: 'ref', k: 'l', ref: 'laws', read: tr('Unlocks the law $'), help: tr('Only shown in the tooltip: the law itself must check for it') },
    { key: 'unlock_decision', label: tr('Unlocks a decision…'), kind: 'ref', k: 'd', ref: 'decisions', read: tr('Unlocks the decision $'), help: tr('Only shown in the tooltip: the decision itself must check for it') },
    { key: 'unlock_casus_belli', label: tr('Unlocks a casus belli…'), kind: 'ref', k: 'w', ref: 'casus_belli_types', read: tr('Unlocks the casus belli $'), help: tr('Only shown in the tooltip: the casus belli itself must check for it') },
    { key: 'custom', label: tr('Custom effect text…'), kind: 'text', k: 'c', read: tr('Text: $'), help: tr('A loc key listed among its effects') }
];

/** Temple models (religion/religion_types/_religion_types.info: faith > religion > family) */
const TEMPLE: FieldDef = { key: 'graphical_faith', label: tr('Temple look…'), kind: 'text', k: 'g', suggest: 'nested:faith:graphical_faith', read: tr('3D models (temples): $') };
const PIETY: FieldDef = { key: 'piety_icon_group', label: tr('Piety icons…'), kind: 'text', k: 'p', read: tr('Piety icons: $') };

/** The hostility levels of `hostility_levels` / `hostility_level_override` (religion/doctrine_types/_doctrine_types.info), least hostile first */
const HOSTILITY: [string, string][] = [['righteous', tr('Righteous')], ['astray', tr('Astray')], ['hostile', tr('Hostile')], ['evil', tr('Evil')]];

/** `hostility_levels = { … }`: how hostile the faith is towards others, by their relation (_doctrine_types.info) */
const RELATIONS: FieldDef[] = [
    { key: 'same_religion', label: tr('Faiths of the same religion…'), kind: 'choice', k: 'r', options: HOSTILITY, read: tr('Other faiths of the same religion are seen as $') },
    { key: 'same_family', label: tr('Faiths of the same family…'), kind: 'choice', k: 'f', options: HOSTILITY, read: tr('Faiths of the same religion family are seen as $') },
    { key: 'unrelated', label: tr('Faiths of other families…'), kind: 'choice', k: 'u', options: HOSTILITY, read: tr('Faiths of other religion families are seen as $') }
];

/**
 * The field set of the relations a `hostility_levels` block does not write yet (its row's ⤷＋ offers just those):
 * `hostility_levels/same_family/unrelated`; all three missing: `hostility_levels`.
 */
export function hostilityLevelsSet(missing: string[]): string
{
    const keys = RELATIONS.map((f) => f.key).filter((k) => missing.includes(k));
    return keys.length === RELATIONS.length ? 'hostility_levels' : ['hostility_levels', ...keys].join('/');
}

/** The sets of hostilityLevelsSet for one or two missing relations. */
const RELATION_SUBSETS: Record<string, FieldDef[]> = Object.fromEntries(
    [1, 2, 3, 4, 5, 6].map((bits) =>
    {
        const part = RELATIONS.filter((_f, i) => bits & (1 << i));
        return [hostilityLevelsSet(part.map((f) => f.key)), part];
    })
);

/**
 * The numbers and yes / no settings of a doctrine's or tenet's `special_parameters = { … }` (_doctrine_types.info
 * :136-282, 1.20: each key read there; the presets from its defaults and the values vanilla writes).
 */
const SPECIAL_VALUES: FieldDef[] = [
    { key: 'number_of_spouses', label: tr('Spouses…'), kind: 'number', k: 's', presets: [1, 2, 3, 4], read: tr('Up to $ spouses'), help: tr('Script keeps non-rulers to one; a culture tradition’s value comes first; of several doctrines the highest counts') },
    { key: 'number_of_consorts', label: tr('Consorts…'), kind: 'number', k: 'c', presets: [1, 2, 3, 5], read: tr('Up to $ consorts'), help: tr('Rulers only (script keeps others to none); a culture tradition’s value comes first; of several doctrines the highest counts') },
    { key: 'divine_marriage_opinion', label: tr('Opinion from a marriage in the family…'), kind: 'number', k: 'd', signed: true, tone: 'good', presets: [5, 10, 15, 20], read: tr('$ opinion of direct vassals when married within the extended family') },
    { key: 'minimum_fervor', label: tr('Lowest fervor…'), kind: 'number', k: 'f', presets: [10, 25, 45, 50], read: tr('Fervor never falls below $'), help: tr('Of several doctrines the highest counts') },
    { key: 'fervor_per_holy_site', label: tr('Fervor per holy site…'), kind: 'number', k: 'y', presets: [0.05, 0.1, 0.25, 0.5], read: tr('$ fervor a year per holy site held'), help: tr('Of several doctrines the highest counts') },
    { key: 'bonus_fervor_gain', label: tr('Extra fervor a year…'), kind: 'number', k: 'g', presets: [0.25, 0.5, 1, 2], read: tr('$ more fervor a year'), help: tr('Of several doctrines the highest counts') },
    { key: 'bonus_heresy_protection', label: tr('Heresies negated…'), kind: 'number', k: 'p', presets: [1, 2, 3], read: tr('$ more heresies negated'), help: tr('Of several doctrines the highest counts') },
    { key: 'divergence_protection', label: tr('Protection from divergent rites…'), kind: 'number', k: 'v', presets: [0.25, 0.5, 1], read: tr('Fervor loss from divergent rites negated: $'), help: tr('Of several doctrines the highest counts') },
    { key: 'heresy_threshold', label: tr('Heresy threshold…'), kind: 'number', k: 't', signed: true, presets: [5, 10, -5, -10], read: tr('Heresy threshold changed by $'), help: tr('Added up over the doctrines') },
    { key: 'hostility_towards_us_mult', label: tr('Hostility towards it, multiplied…'), kind: 'number', k: 'm', presets: [1.5, 2, 3], read: tr('Others’ hostility opinion of it multiplied by $'), help: tr('Multiplies the hostility opinion (HOSTILITY_OPINION_EFFECTS): 1 leaves it as it is, below 1 counts as 1') },
    { key: 'piety_from_long_peace', label: tr('Piety from a long peace…'), kind: 'number', k: 'l', signed: true, tone: 'good', presets: [0.5, 1, 2, -0.5, -1], read: tr('$ piety after a long peace') },
    { key: 'unreformed', label: tr('Unreformed'), kind: 'bool', k: 'u', read: { yes: tr('An unreformed faith'), no: tr('Not an unreformed faith') }, help: tr('Reforming keeps its name and icon, the old faith gets its “_old” ones; that it happens only once is up to the script') },
    { key: 'warmonger', label: tr('Warmonger'), kind: 'bool', k: 'w', read: { yes: tr('Vassals and counties of its faith dislike peace, not offensive wars'), no: tr('Not warmongering') } },
    { key: 'increased_dynasty_prestige_birth_mult', label: tr('Prestige at birth, multiplied…'), kind: 'number', k: 'b', presets: [0.5, 1, 2], read: tr('Prestige of those born to it multiplied by $') },
    { key: 'increased_dynasty_prestige_marriage_mult', label: tr('Prestige from marriage, multiplied…'), kind: 'number', k: 'r', presets: [0.5, 1, 2], read: tr('Prestige from a marriage multiplied by $'), help: tr('Only when both have it; then the lower of their values') },
    { key: 'increased_dynasty_prestige_long_reign_mult', label: tr('Long reign years, multiplied…'), kind: 'number', k: 'n', presets: [0.5, 1, 2], read: tr('Most years of the long reign opinion multiplied by $') }
];

/**
 * The tenet banners (1.20; _religion_family_types.info: four keys, a family has all of them, a religion overrides its
 * family's with all four in `religion_details`; a faith has none). 1.19's one `doctrine_background_icon` is no longer read.
 */
const BANNERS: FieldDef[] = [
    { key: 'tenet_background_icon', label: tr('Tenet banner…'), kind: 'text', suggest: 'values:religion/religion_family_types:tenet_background_icon', read: tr('Tenet banner: $'), help: tr('Approved by the faith, or core: a texture of gfx/interface/icons/faith_tenets (with a _small variant)') },
    { key: 'tenet_heretical_background_icon', label: tr('Tenet banner, heretical…'), kind: 'text', suggest: 'values:religion/religion_family_types:tenet_heretical_background_icon', read: tr('Tenet banner, heretical: $'), help: tr('Core for a rite, prohibited by the faith') },
    { key: 'tenet_neutral_background_icon', label: tr('Tenet banner, neutral…'), kind: 'text', suggest: 'values:religion/religion_family_types:tenet_neutral_background_icon', read: tr('Tenet banner, neutral: $'), help: tr('Known by the faith') },
    { key: 'tenet_unknown_background_icon', label: tr('Tenet banner, unknown…'), kind: 'text', suggest: 'values:religion/religion_family_types:tenet_unknown_background_icon', read: tr('Tenet banner, unknown: $'), help: tr('Unknown by the faith') }
];

/** What a religion writes inside `religion_details = { }` (1.20 reads them only there) */
const RELIGION_DETAILS: FieldDef[] = [
    { key: 'family', label: tr('Family…'), kind: 'ref', k: 'f', ref: 'religion/religion_family_types', read: tr('Family: $') },
    TEMPLE,
    PIETY,
    ...BANNERS.map((b) => ({ ...b, help: `${b.help}; ${tr('all four banners must be set for the religion to override its family’s')}` })),
    { key: 'theocracy_government_type', label: tr('Theocracy government…'), kind: 'ref', ref: 'governments', read: tr('Theocratic rulers have the government $') },
    { key: 'theocracy_lease_contract_type', label: tr('Theocracy lease contract…'), kind: 'text', read: tr('Theocratic leases use the contract $') }
];

/** What a faith writes inside `faith_details = { }` (1.20; _faith_types.info) */
const FAITH_DETAILS: FieldDef[] = [
    { key: 'religious_head', label: tr('Head of faith title…'), kind: 'ref', k: 'r', ref: 'landed_titles', read: tr('Head of faith: $') },
    { key: 'icon', label: tr('Icon…'), kind: 'text', k: 'i', suggest: 'faith_icons', read: tr('Icon: $'), help: 'gfx/interface/icons/faith/<name>.dds' },
    { key: 'reformed_icon', label: tr('Icon once reformed…'), kind: 'text', suggest: 'faith_icons', read: tr('Icon once reformed: $') },
    TEMPLE,
    { key: 'theocracy_government_type', label: tr('Theocracy government…'), kind: 'ref', ref: 'governments', read: tr('Theocratic rulers have the government $') },
    { key: 'head_of_rite', label: tr('Head of rite title…'), kind: 'ref', ref: 'landed_titles', read: tr('Head of a rite: $'), help: tr('The holder of this title heads their rite ahead of clerical region rulers and secular rulers') }
];

/** Name and prefix (loc keys), motto, coat of arms style of a dynasty or house (history in common/dynasties, dynasty_houses) */
const HOUSE: FieldDef[] = [
    { key: 'name', label: tr('Name (loc key)…'), kind: 'text', k: 'n', read: tr('Name: $') },
    { key: 'prefix', label: tr('Prefix (loc key)…'), kind: 'text', k: 'p', suggest: 'values:dynasty_houses:prefix', read: tr('Prefix: $') },
    { key: 'motto', label: tr('Motto (loc key)…'), kind: 'text', k: 'm', read: tr('Motto: $'), help: tr('The motto it has at game start') },
    { key: 'forced_coa_religiongroup', label: tr('Coat of arms style…'), kind: 'choice', k: 'c', read: tr('Coat of arms in the $ style'), options: [['christian', tr('Christian')], ['muslim', tr('Muslim')], ['zoroastrian_group', tr('Zoroastrian')]] }
];

export const CULTURE_FIELDS: Record<string, FieldDef[]> = {
    // culture/cultures/_cultures.info: pillars, names, look
    'culture/cultures': [
        { key: 'ethos', label: tr('Ethos…'), kind: 'text', k: 'e', suggest: 'values:culture/cultures:ethos', read: tr('Ethos: $') },
        { key: 'heritage', label: tr('Heritage…'), kind: 'text', k: 'h', suggest: 'values:culture/cultures:heritage', read: tr('Heritage: $') },
        { key: 'language', label: tr('Language…'), kind: 'text', k: 'l', suggest: 'values:culture/cultures:language', read: tr('Language: $') },
        { key: 'martial_custom', label: tr('Martial custom…'), kind: 'text', k: 'm', suggest: 'values:culture/cultures:martial_custom', read: tr('Martial custom: $') },
        { key: 'head_determination', label: tr('Head of culture…'), kind: 'text', k: 'd', suggest: 'values:culture/cultures:head_determination', read: tr('Head of culture: $') },
        { key: 'name_list', label: tr('Name list…'), kind: 'ref', k: 'n', ref: 'culture/name_lists', read: tr('Names from $'), help: tr('Several are allowed; the first is the main one (prefixes)') },
        { key: 'name_order_convention', label: tr('Name order…'), kind: 'choice', k: 'o', read: tr('Name order: $'), options: [['dynasty_always_first', tr('Dynasty name first, always shown')], ['dynasty_first', tr('Dynasty name first')], ['japanese', tr('Japanese')]] },
        { key: 'created', label: tr('Created on (date)…'), kind: 'text', k: 'c', read: tr('Created on $'), help: 'y.m.d' },
        { key: 'house_coa_frame', label: tr('House coat of arms frame…'), kind: 'text', k: 'f', suggest: 'values:culture/cultures:house_coa_frame', read: tr('House coat of arms frame: $') },
        { key: 'dynasty_coa_frame', label: tr('Dynasty coat of arms frame…'), kind: 'text', read: tr('Dynasty coat of arms frame: $') },
        { key: 'history_loc_override', label: tr('History text (loc key)…'), kind: 'text', read: tr('History text: $') }
    ],
    // culture/name_lists/_name_lists.info: naming customs
    'culture/name_lists': [
        { key: 'pat_grf_name_chance', label: tr('Named after the father’s father (%)'), kind: 'number', k: 'g', presets: CHANCE, read: tr('$% of sons are named after their father’s father') },
        { key: 'mat_grf_name_chance', label: tr('Named after the mother’s father (%)'), kind: 'number', k: 'h', presets: CHANCE, read: tr('$% of sons are named after their mother’s father') },
        { key: 'father_name_chance', label: tr('Named after the father (%)'), kind: 'number', k: 'f', presets: CHANCE, read: tr('$% of sons are named after their father') },
        { key: 'pat_grm_name_chance', label: tr('Named after the father’s mother (%)'), kind: 'number', k: 'i', presets: CHANCE, read: tr('$% of daughters are named after their father’s mother') },
        { key: 'mat_grm_name_chance', label: tr('Named after the mother’s mother (%)'), kind: 'number', k: 'j', presets: CHANCE, read: tr('$% of daughters are named after their mother’s mother') },
        { key: 'mother_name_chance', label: tr('Named after the mother (%)'), kind: 'number', k: 'm', presets: CHANCE, read: tr('$% of daughters are named after their mother') },
        { key: 'founder_named_dynasties', label: tr('Dynasties named after founders'), kind: 'bool', k: 'd', read: { yes: tr('New dynasties and cadet branches are named after their founder'), no: tr('New dynasties are not named after their founder') } },
        { key: 'house_based_map_names', label: tr('Realms named after houses'), kind: 'bool', k: 'r', read: { yes: tr('Realms can be named after the ruler’s house on the map'), no: tr('Realms are not named after houses') } },
        { key: 'suggest_family_names', label: tr('Suggest family names'), kind: 'bool', read: { yes: tr('Names from within the family are suggested'), no: tr('No names from within the family are suggested') } },
        { key: 'suggest_ancestor_names', label: tr('Suggest ancestors’ names'), kind: 'bool', read: { yes: tr('Ancestors’ names are suggested'), no: tr('No ancestors’ names are suggested') } },
        { key: 'always_use_patronym', label: tr('Always show patronyms'), kind: 'bool', k: 'a', read: { yes: tr('Patronyms are always shown'), no: tr('Patronyms only where the government shows them') } },
        { key: 'dynasty_name_first', label: tr('Dynasty name first'), kind: 'bool', read: { yes: tr('The dynasty name comes before the first name'), no: tr('The dynasty name comes after the first name') } },
        { key: 'dynasty_of_location_prefix', label: tr('Prefix of dynasties named after a place…'), kind: 'text', k: 'l', suggest: 'values:culture/name_lists:dynasty_of_location_prefix', read: tr('Dynasties named after a place: $…') },
        { key: 'bastard_dynasty_prefix', label: tr('Prefix of bastard dynasties…'), kind: 'text', read: tr('Bastard dynasties: $…') },
        { key: 'patronym_prefix_male', label: tr('Patronym prefix for sons…'), kind: 'text', read: tr('Sons: $') },
        { key: 'patronym_prefix_male_vowel', label: tr('Patronym prefix for sons (vowel)…'), kind: 'text', read: tr('Sons, before a vowel: $') },
        { key: 'patronym_prefix_female', label: tr('Patronym prefix for daughters…'), kind: 'text', read: tr('Daughters: $') },
        { key: 'patronym_prefix_female_vowel', label: tr('Patronym prefix for daughters (vowel)…'), kind: 'text', read: tr('Daughters, before a vowel: $') },
        { key: 'patronym_suffix_male', label: tr('Patronym suffix for sons…'), kind: 'text', read: tr('Sons: $') },
        { key: 'patronym_suffix_female', label: tr('Patronym suffix for daughters…'), kind: 'text', read: tr('Daughters: $') },
        { key: 'grammar_transform', label: tr('Grammar transform…'), kind: 'text', read: tr('Grammar: $') }
    ],
    // culture/eras/_culture_eras.info
    'culture/eras': [
        { key: 'year', label: tr('Starting year'), kind: 'number', k: 'y', presets: [0, 900, 1050, 1200, 1300], read: tr('Starts spreading in $'), help: tr('Innovations of the era can get base progress from this year on') },
        { key: 'invalid_for_government', label: tr('Not for a government…'), kind: 'ref', k: 'g', ref: 'governments', read: tr('Not for the government $') },
        ...UNLOCKS
    ],
    // culture/innovations/_culture_innovations.info
    'culture/innovations': [
        { key: 'culture_era', label: tr('Era…'), kind: 'ref', k: 'e', ref: 'culture/eras', read: tr('Era: $') },
        { key: 'group', label: tr('Group…'), kind: 'choice', k: 'g', read: tr('Group: $'), options: [['culture_group_military', tr('Military')], ['culture_group_civic', tr('Civic')], ['culture_group_regional', tr('Cultural and regional')]] },
        { key: 'skill', label: tr('Skill of the head of culture…'), kind: 'choice', k: 's', read: tr('Fascination uses the head of culture’s $'), options: [['learning', tr('Learning')], ['martial', tr('Martial')], ['stewardship', tr('Stewardship')], ['diplomacy', tr('Diplomacy')], ['intrigue', tr('Intrigue')]] },
        { key: 'region', label: tr('Region…'), kind: 'text', k: 'r', suggest: 'values:culture/innovations:region', read: tr('Only progresses in $'), help: tr('The culture needs a minimum of provinces in the region') },
        { key: 'flag', label: tr('Flag…'), kind: 'text', k: 'f', suggest: 'values:culture/innovations:flag', read: tr('Flag: $'), help: tr('For has_all_innovations; several are allowed') },
        ...UNLOCKS
    ],
    // ethnicities: the template it builds on
    ethnicities: [
        { key: 'template', label: tr('Template…'), kind: 'ref', k: 't', ref: 'ethnicities', read: tr('Based on $') },
        { key: 'visible', label: tr('Visible'), kind: 'bool', k: 'v', read: { yes: tr('Visible'), no: tr('Hidden — a template for others') } }
    ],
    // religion/faith_types/_faith_types.info (1.20): the statements of a faith that has a `faith_details` block (`faith` below
    // is the 1.19 layout: the same at the faith's top, doctrines and holy sites one statement each). These sets are what the
    // card adds with: the details block, `doctrines = { }` and `holy_sites = { }` (made when missing)
    faith_details: FAITH_DETAILS,
    faith_doctrines: [{ key: 'doctrine', label: tr('Doctrine…'), kind: 'ref', ref: 'religion/doctrine_types', group: 'doctrine_groups', bare: true, k: 'd', read: tr('Has $') }],
    faith_holy_sites: [{ key: 'holy_site', label: tr('Holy site…'), kind: 'ref', ref: 'religion/holy_site_types', bare: true, k: 'h', read: tr('Holy site: $') }],
    // a faith's statements as one set (reading and changing the ones written; adding where the layout has them at the top)
    faith: [
        { key: 'doctrine', label: tr('Doctrine or tenet…'), kind: 'ref', k: 'd', ref: 'religion/doctrine_types', group: 'doctrine_groups', read: tr('Has $') },
        { key: 'holy_site', label: tr('Holy site…'), kind: 'ref', k: 'h', ref: 'religion/holy_site_types', read: tr('Holy site: $') },
        ...FAITH_DETAILS
    ],
    // religion/religion_types/_religion_types.info: the settings go into `religion_details` (1.20 reads family, temple
    // models, piety icons and banners only there), doctrine and pagan_roots stay at the top. `religion/religion_details`
    // is the set the card adds the look with; this one reads and changes what is written
    'religion/religion_details': RELIGION_DETAILS,
    'religion/religion_types': [
        { key: 'doctrine', label: tr('Doctrine for every faith…'), kind: 'ref', k: 'd', ref: 'religion/doctrine_types', group: 'doctrine_groups', read: tr('Has $'), help: tr('At game start, as if every faith had it; a faith’s own doctrine of the group wins') },
        { key: 'pagan_roots', label: tr('Pagan roots'), kind: 'bool', k: 'a', read: { yes: tr('Pagan roots: faiths without the Unreformed doctrine count as reformed'), no: tr('No pagan roots') } },
        ...RELIGION_DETAILS
    ],
    // religion/religion_family_types/_religion_family_types.info
    'religion/religion_family_types': [{ key: 'hostility_doctrine', label: tr('Hostility doctrine…'), kind: 'ref', k: 'h', ref: 'religion/doctrine_types', read: tr('Hostility shown with $') }, PIETY, TEMPLE, ...BANNERS],
    // religion/doctrine_group_types/_doctrine_group_types.info (1.20.1: the categories are common/religion/doctrine_category_types)
    'religion/doctrine_group_types': [
        { key: 'category', label: tr('Category…'), kind: 'choice', k: 'c', read: tr('Category: $'), options: [['main_group', tr('Main')], ['marriage', tr('Marriage')], ['crimes', tr('Crimes')], ['clergy', tr('Clergy')], ['special', tr('Special')], ['not_creatable', tr('Not creatable')]] },
        { key: 'main_rite', label: tr('Only the main rite'), kind: 'bool', k: 'm', read: { yes: tr('Applied only when practised by the main rite (a warning in the interface; the script does the rest)'), no: tr('Applied to every rite') } },
        { key: 'divergence', label: tr('Divergence…'), kind: 'choice', k: 'd', read: tr('Divergence: $'), options: [['category', tr('Separate customs: the sum of the two compared')], ['sequence', tr('A spectrum: the difference of the two compared')]] },
        { key: 'doctrine_lock', label: tr('Tied to…'), kind: 'choice', k: 'l', read: tr('Tied to: $'), options: [['none', tr('Nothing')], ['rite', tr('A rite')], ['faith', tr('A faith')], ['religion', tr('A religion')]], help: tr('Removed when the rite is changed (rite), moves to another faith (faith) or religion (religion)') }
    ],
    // religion/doctrine_types/_doctrine_types.info
    'religion/doctrine_types': [
        { key: 'visible', label: tr('Visible'), kind: 'bool', k: 'v', read: { yes: tr('Shown in the interface'), no: tr('Hidden in the interface') } },
        { key: 'icon', label: tr('Icon…'), kind: 'text', k: 'i', suggest: 'doctrine_icons', read: tr('Icon: $'), help: tr('Another doctrine’s icon: gfx/interface/icons/faith_doctrines/<name>.dds (default: the doctrine’s own key)') }
    ],
    // religion/tenet_types (1.20: tenets of their own, the doctrine's keys)
    'religion/tenet_types': [
        { key: 'visible', label: tr('Visible'), kind: 'bool', k: 'v', read: { yes: tr('Shown in the interface'), no: tr('Hidden in the interface') } },
        { key: 'icon', label: tr('Icon…'), kind: 'text', k: 'i', suggest: 'tenet_icons', read: tr('Icon: $'), help: tr('Another tenet’s icon: gfx/interface/icons/faith_tenets/<name>.dds (default: the tenet’s own key)') }
    ],
    // a doctrine's `parameters = { … }`: any parameter key (suggested from every doctrine's): yes / no or a number
    doctrine_parameters: [],
    // a doctrine's `special_parameters` (_doctrine_types.info, 1.20): how hostile its faith is towards others, by their relation
    hostility_levels: RELATIONS,
    // (the relations a written block does not have yet: its row's ⤷＋)
    ...RELATION_SUBSETS,
    // … by a doctrine or tenet the other faith has (the most hostile match wins; before hostility_levels)
    hostility_level_override: [{ key: '*', anyKey: ['religion/doctrine_types', 'religion/tenet_types'], label: tr('Faiths with the doctrine or tenet…'), kind: 'choice', k: 'd', options: HOSTILITY, read: tr('Faiths with %k are seen as $'), help: tr('A doctrine or a tenet the other faith has') }],
    // … an opinion of faiths that have a doctrine parameter (`parameter_opinion_override = { pacifist = 10 }`): the key is
    // a parameter (no index type: `anyKey` empty, the keys from `suggest`, which the value step then does not offer)
    parameter_opinion_override: [{ key: '*', anyKey: [], suggest: 'doctrine_parameters', label: tr('Faiths with the parameter…'), kind: 'number', k: 'p', signed: true, tone: 'good', presets: [5, 10, 15, 20, 25, 30], wholeFrom: 1, read: tr('$ opinion of faiths with %k'), help: tr('Positive whole numbers (0 is ignored); its tooltip: doctrine_parameter_<parameter>_opinion_active') }],
    // `allowed_holding_types = { church_holding }`: holdings its rulers may hold whatever their government
    allowed_holding_types: [{ key: 'holding', label: tr('Holding type…'), kind: 'ref', ref: 'holdings', bare: true, k: 'h', read: tr('Can hold $') }],
    // `special_parameters = { … }` itself (open: a key a mod writes that the .info does not document changes through
    // "Other setting…"): the numbers, the head of faith's hostility, and the blocks, each made with its first entry
    special_parameters: [
        ...SPECIAL_VALUES,
        { key: 'same_hof_hostility_override', label: tr('Faiths sharing its head of faith…'), kind: 'choice', k: 'h', options: HOSTILITY, read: tr('Faiths sharing its head of faith are seen as $'), help: tr('Before every other hostility setting') },
        { key: 'hostility_levels', label: tr('Hostility by relation…'), kind: 'block', k: 'e', sub: 'hostility_levels', ask: ['*'], read: tr('Hostility by relation'), help: tr('How hostile it is towards other faiths of its religion, its family, other families') },
        { key: 'hostility_level_override', label: tr('Hostility by doctrine or tenet…'), kind: 'block', k: 'i', sub: 'hostility_level_override', ask: ['*'], read: tr('Hostility by doctrine or tenet'), help: tr('How hostile it is towards faiths with a doctrine or tenet: before the relation, the most hostile match wins') },
        { key: 'parameter_opinion_override', label: tr('Opinion of faiths with a parameter…'), kind: 'block', k: 'a', sub: 'parameter_opinion_override', ask: ['*'], read: tr('Opinion of faiths with a parameter') },
        { key: 'allowed_holding_types', label: tr('Holdings its rulers may hold…'), kind: 'block', k: 'k', sub: 'allowed_holding_types', ask: ['holding'], read: tr('Rulers may hold'), help: tr('Holding types its rulers may hold, whatever their government') }
    ],
    // the doctrine group a doctrine is put into (its card: "＋ put it in a group")
    doctrine_membership: [{ key: 'group', label: tr('Doctrine group…'), kind: 'ref', k: 'g', ref: 'religion/doctrine_group_types', read: tr('In the group $') }],
    dynasties: [{ key: 'culture', label: tr('Culture…'), kind: 'ref', k: 'u', ref: 'culture/cultures', read: tr('Culture: $') }, ...HOUSE],
    dynasty_houses: [{ key: 'dynasty', label: tr('Dynasty…'), kind: 'ref', k: 'd', ref: 'dynasties', read: tr('Dynasty: $') }, ...HOUSE],
    // dynasty_house_mottos/_mottos.info: the words filled in as $1$, $2$ …
    dynasty_house_mottos: [{ key: 'insert', label: tr('Word filled in…'), kind: 'ref', k: 'i', ref: 'dynasty_house_motto_inserts', read: tr('Filled in: $') }],
    // nicknames/_nicknames.info
    nicknames: [
        { key: 'is_bad', label: tr('Bad nickname'), kind: 'bool', k: 'b', read: { yes: tr('A bad nickname'), no: tr('Not a bad nickname') } },
        { key: 'is_prefix', label: tr('Before the name'), kind: 'bool', k: 'p', read: { yes: tr('Written before the name'), no: tr('Written after the name') } }
    ]
};
