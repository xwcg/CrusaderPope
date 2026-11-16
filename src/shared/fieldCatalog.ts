/**
 * The fields of a definition that the statement picker builds and the readable view lists line by line
 * (docs/picker.md, "Modifiers and fields"): per entry type, what each field is called, what value it takes and how it
 * reads. Plain data, used by the picker (renderer) and the card builder (main/describe/stories.ts).
 */

export interface FieldDef
{
    /**
     * the script key; `duration` / `delay` stand for the written `days|months|years = N` / `delay_days|… = N`
     */
    key: string;
    /** menu label */
    label: string;
    /**
     * ref: an entry of the index type `ref` (a character's trait); text: a name (with `suggest`ions); block:
     * `key = { … }` holding the fields of the set `sub` (a trait's `triggered_opinion`); level: a number opening a block
     * of its own (`50 = { }`: a trait's experience track level, its modifiers added into it afterwards)
     */
    kind: 'number' | 'bool' | 'duration' | 'ref' | 'text' | 'block' | 'choice' | 'level';
    /** the value is written alone, no key (a list's item: `opposites = { craven }`) */
    bare?: boolean;
    /** text: typed as it is (a name), quoted when it holds anything but a–z, digits and _ (`name = "Þórir"`) */
    free?: boolean;
    /**
     * the key is an entry of this index type, any of them (`compatibility = { brave = 15 }`: `key` is '*'): asked first,
     * then the value; `%k` in `read` is the key made readable. Several types: their entries in one list, in this order
     * (a hostility override names a doctrine or a tenet)
     */
    anyKey?: string | string[];
    /** choice: its values (script value, label) */
    options?: [string, string][];
    /** entries of this index type as values (ref), or offered after the presets (numbers: script values by name) */
    ref?: string;
    /** ref: only the entries whose key starts with it (a holy site's `county`: `c_`, of every landed title) */
    prefix?: string;
    /** block: the field set of its fields */
    sub?: string;
    /** block: fields it needs (asked right away, in order) */
    ask?: string[];
    /**
     * block: the keys its "Clear the conditions" drops (a send option's `is_shown` …, an asset's `trigger`, a triggered
     * opinion's condition fields); everything else stays (its label, its icon, what is kept as written). None: no Clear row
     */
    conds?: string[];
    /** text: where suggestions come from (api.fieldSuggestions: 'doctrine_parameters', 'values:<type>:<key>'); numbers: the
     * named values the game writes for it, offered after the presets (`values:buildings:construction_time`) */
    suggest?: string;
    /**
     * ref: the entries grouped as this suggestion source groups them (`doctrine_groups`: a menu per doctrine group, by
     * category); with `PickRequest.only` just those entries
     */
    group?: string;
    /**
     * a new entry can be made here instead of naming an existing one: what it is (EntryCreate.what), the menu's label,
     * the field set of its settings (`ask`: asked first), what its in-game text is called
     */
    create?: { what: 'opinion_modifiers' | 'doctrine_parameter'; label: string; fields: string; ask?: string[]; locLabel: string; };
    /**
     * level: written inside a block of its own name (a trait's named track, `falconer = { 50 = { } }`): the name is typed
     * first (a–z, digits, _; not one of the names written beside it, PickRequest.common), then the first level; `loc`:
     * then its name in game, optional, written as this text key (`$` the name: `trait_track_$`) in the same undo step;
     * `descSuffix`: then its description, optional, under that key with this suffix (`_desc`: `trait_track_falconer_desc`)
     */
    named?: { loc?: string; locLabel?: string; descSuffix?: string; descLabel?: string; };
    /** the written value goes into this (`$` the value): a random traits list's trait `{ weight = { base = $ } }` */
    wrap?: string;
    /**
     * text: the value is a text key whose text the game shows (a decision's `selection_tooltip`): the card line reads the
     * text and "✎ text" writes it (also for a key with no text yet), the picker's step starts with "Write a new text…"
     * (the text typed, written under `<entry><loc>`: `_tooltip` gives `my_decision_tooltip`, '' the entry's own key)
     */
    loc?: string;
    k?: string;
    presets?: number[];
    /** numbers: only whole numbers from this value up (a typed other one gets a note instead of a row) */
    wholeFrom?: number;
    /**
     * duration: a random time between two values may be written too (`months = { 6 12 }`, an on_action's delay):
     * "A random time between…" asks the unit, the lowest, then the highest
     */
    range?: boolean;
    /** numbers shown with a sign (+30) */
    signed?: boolean;
    /** a positive number / `yes` is good (green) or bad (red) for the one who has it */
    tone?: 'good' | 'bad';
    /** the readable line: `$` is the value (numbers, durations); bools read `yes` / `no` */
    read: string | { yes: string; no: string; };
    /** a short explanation (the menu row's tooltip) */
    help?: string;
    /**
     * ref: an entry limited to a DLC can be written with the DLC's flag and a fallback, as a statement of its own next
     * to the list (`tenet_selection_pair = { requires_dlc_flag = x tenet = y fallback_tenet = z }`): its key, the
     * entry's and the fallback's keys
     */
    dlcPair?: { key: string; item: string; fallback: string; };
}

import { REALM_FIELDS } from './fields/realm.ts';
import { CULTURE_FIELDS } from './fields/culture.ts';
import { SCRIPTED_FIELDS } from './fields/scripted.ts';
import { LIFE_FIELDS } from './fields/life.ts';
import { PRESENTATION_FIELDS } from './fields/presentation.ts';
import { SETTINGS_FIELDS, SETTINGS_SUB_SETS as SUB_SETS } from './fields/settings.ts';

import { tr } from './i18n.ts';
const DURATION_UNITS = ['days', 'months', 'years'] as const;

const COST = [25, 50, 75, 100, 150, 200, 250, 300, 500, 1000];

/**
 * Keys: an entry type (`opinion_modifiers`: the definition's own fields), or a block's field set: `cost` (a cost
 * block), `script_value` (a script value's formula), `character_history` (a character's history entries),
 * `trait_opinion` (a trait's opinion fields).
 */
export const FIELDS: Record<string, FieldDef[]> = {
    // common/opinion_modifiers/_opinions.info
    opinion_modifiers: [
        { key: 'opinion', label: tr('Opinion value'), kind: 'number', k: 'o', signed: true, tone: 'good', presets: [5, 10, 15, 20, 25, 30, 50, 100, -5, -10, -15, -20, -25, -30, -50, -100], read: tr('$ opinion') },
        { key: 'decaying', label: tr('Fades over time'), kind: 'bool', k: 'f', read: { yes: tr('Fades over time'), no: tr('Does not fade') }, help: tr('The value decays to 0 over its duration') },
        { key: 'duration', label: tr('Lasts…'), kind: 'duration', k: 'l', presets: [1, 2, 3, 5, 10, 20], read: tr('Lasts $'), help: tr('How long the opinion lasts (days / months / years); without it, until removed') },
        { key: 'monthly_change', label: tr('Change per month'), kind: 'number', k: 'm', presets: [0.5, 1, 2, 5, 10], read: tr('Changes by $ per month'), help: tr('Instead of a duration') },
        { key: 'stacking', label: tr('Can stack'), kind: 'bool', k: 's', read: { yes: tr('Can stack'), no: tr('Does not stack') }, help: tr('Applying it again adds up instead of resetting its duration') },
        { key: 'imprisonment_reason', label: tr('Allows imprisonment'), kind: 'bool', k: 'i', read: { yes: tr('Allows imprisonment'), no: tr('No imprisonment reason') }, help: tr('Gives a reason to imprison the target') },
        { key: 'revoke_title_reason', label: tr('Allows title revocation'), kind: 'bool', k: 'r', read: { yes: tr('Allows title revocation'), no: tr('No revocation reason') } },
        { key: 'execute_reason', label: tr('Allows execution'), kind: 'bool', k: 'e', read: { yes: tr('Allows execution'), no: tr('No execution reason') } },
        { key: 'banish_reason', label: tr('Allows banishment'), kind: 'bool', k: 'b', read: { yes: tr('Allows banishment'), no: tr('No banishment reason') } },
        { key: 'growing', label: tr('Grows over time'), kind: 'bool', k: 'g', read: { yes: tr('Grows over time'), no: tr('Does not grow') }, help: tr('Starts at 0 (or its minimum) and grows to its value') },
        { key: 'delay', label: tr('Starts fading after…'), kind: 'duration', k: 'd', presets: [1, 2, 5], read: tr('Starts fading after $'), help: tr('Only with “Fades over time”') },
        { key: 'min', label: tr('Lowest value'), kind: 'number', k: 'w', signed: true, presets: [-100, -50, -25, 0], read: tr('At least $') },
        { key: 'max', label: tr('Highest value'), kind: 'number', k: 'h', signed: true, presets: [0, 25, 50, 100], read: tr('At most $') },
        { key: 'obedient', label: tr('Makes obedient'), kind: 'bool', k: 'y', read: { yes: tr('Makes them obedient'), no: tr('No obedience') }, help: tr('Obedient to the target while it lasts (both must use obedience)') },
        { key: 'divorce_reason', label: tr('Allows divorce'), kind: 'bool', k: 'v', read: { yes: tr('Allows divorce'), no: tr('No divorce reason') } }
    ],
    // common/traits/_traits.info: a trait's own properties (its modifiers are the "Modifiers" section)
    traits: [
        {
            key: 'category',
            label: tr('Category'),
            kind: 'choice',
            k: 'c',
            read: tr('Category: $'),
            options: [['personality', tr('Personality')], ['education', tr('Education')], ['childhood', tr('Childhood')], ['commander', tr('Commander')], ['winter_commander', tr('Winter commander')], ['lifestyle', tr('Lifestyle')], ['court_type', tr('Court type')], ['fame', tr('Fame')], ['health', tr('Health')]]
        },
        { key: 'ruler_designer_cost', label: tr('Ruler designer cost'), kind: 'number', k: 'r', presets: [0, 5, 10, 20, 30, 40, 50, -5, -10, -20], read: tr('Costs $ in the ruler designer') },
        { key: 'flag', label: tr('Flag…'), kind: 'text', k: 'f', suggest: 'values:traits:flag', read: tr('Flag: $'), help: tr('A trait flag (has_trait_with_flag); several are allowed') },
        { key: 'shown_in_ruler_designer', label: tr('Shown in the ruler designer'), kind: 'bool', k: 's', read: { yes: tr('Shown in the ruler designer'), no: tr('Not in the ruler designer') } },
        { key: 'shown_in_encyclopedia', label: tr('Shown in the encyclopedia'), kind: 'bool', k: 'e', read: { yes: tr('Shown in the encyclopedia'), no: tr('Not in the encyclopedia') } },
        { key: 'level', label: tr('Level in its group'), kind: 'number', k: 'l', presets: [1, 2, 3, 4, 5], read: tr('Level $ of its group') },
        { key: 'group', label: tr('Group…'), kind: 'text', k: 'g', suggest: 'values:traits:group', read: tr('Group: $'), help: tr('Trait group, for inheritance and equivalence') },
        { key: 'group_equivalence', label: tr('Group (equivalence only)…'), kind: 'text', suggest: 'values:traits:group_equivalence', read: tr('Equivalent to the group $') },
        { key: 'group_inheritance', label: tr('Group (inheritance only)…'), kind: 'text', suggest: 'values:traits:group_inheritance', read: tr('Inherited like the group $') },
        { key: 'physical', label: tr('Physical'), kind: 'bool', k: 'p', read: { yes: tr('A physical aspect of the body'), no: tr('Not physical') } },
        { key: 'genetic', label: tr('Genetic'), kind: 'bool', k: 'n', read: { yes: tr('Genetic — can be inherited'), no: tr('Not genetic') } },
        { key: 'good', label: tr('Good genetic trait'), kind: 'bool', k: 'o', read: { yes: tr('A good genetic trait'), no: tr('A bad genetic trait') } },
        { key: 'enables_inbred', label: tr('Children can be inbred'), kind: 'bool', k: 'b', read: { yes: tr('Its children can be inbred'), no: tr('No inbreeding from it') } },
        { key: 'immortal', label: tr('Immortal'), kind: 'bool', k: 'i', read: { yes: tr('Immortal — no aging, no natural death'), no: tr('Mortal') } },
        { key: 'incapacitating', label: tr('Incapacitating'), kind: 'bool', k: 'a', read: { yes: tr('Incapacitating — needs a regent'), no: tr('Not incapacitating') } },
        { key: 'can_have_children', label: tr('Can have children'), kind: 'bool', k: 'h', read: { yes: tr('Can have children'), no: tr('Cannot have children') } },
        { key: 'disables_combat_leadership', label: tr('Cannot lead armies'), kind: 'bool', k: 'd', read: { yes: tr('Cannot lead armies'), no: tr('Can lead armies') } },
        { key: 'add_commander_trait', label: tr('Adds commander traits'), kind: 'bool', read: { yes: tr('Generated characters with it get commander traits'), no: tr('No commander traits added') } },
        { key: 'valid_sex', label: tr('Only for…'), kind: 'choice', k: 'v', read: tr('Only for: $'), options: [['all', tr('Everyone')], ['male', tr('Men')], ['female', tr('Women')]] },
        { key: 'minimum_age', label: tr('Minimum age'), kind: 'number', k: 'm', presets: [3, 6, 12, 16, 18], read: tr('Minimum age $') },
        { key: 'maximum_age', label: tr('Maximum age'), kind: 'number', k: 'x', presets: [3, 6, 12, 15, 16, 18], read: tr('Maximum age $') },
        { key: 'birth', label: tr('Born with it (%)'), kind: 'number', presets: [0.1, 0.5, 1, 2, 5, 10], read: tr('$% are born with it') },
        { key: 'random_creation', label: tr('Chance on creation (%)'), kind: 'number', presets: [0.1, 0.5, 1, 2, 5, 10], read: tr('$% chance for generated characters') },
        { key: 'random_creation_weight', label: tr('Weight when picked at random'), kind: 'number', presets: [0, 1, 2, 5, 10], read: tr('Weight $ when picked at random') },
        { key: 'inherit_chance', label: tr('Inherit chance (%)'), kind: 'number', presets: [10, 25, 50, 75, 100], read: tr('$% chance to be inherited') },
        { key: 'both_parent_has_trait_inherit_chance', label: tr('Inherit chance, both parents (%)'), kind: 'number', presets: [25, 50, 75, 100], read: tr('$% when both parents have it') },
        { key: 'parent_inheritance_sex', label: tr('Inherited from…'), kind: 'choice', read: tr('Inherited from: $'), options: [['all', tr('Both parents')], ['male', tr('Fathers')], ['female', tr('Mothers')]] },
        { key: 'child_inheritance_sex', label: tr('Inherited by…'), kind: 'choice', read: tr('Inherited by: $'), options: [['all', tr('All children')], ['male', tr('Sons')], ['female', tr('Daughters')]] },
        { key: 'inherit_from_real_father', label: tr('From the real father'), kind: 'bool', read: { yes: tr('Inherited from the real father'), no: tr('Not from the real father') } },
        { key: 'inherit_from_real_mother', label: tr('From the real mother'), kind: 'bool', read: { yes: tr('Inherited from the real mother'), no: tr('Not from the real mother') } },
        { key: 'inheritance_blocker', label: tr('Blocks inheritance…'), kind: 'choice', read: tr('Blocks inheritance: $'), options: [['none', tr('No')], ['dynasty', tr('Within the dynasty')], ['all', tr('Always')]] },
        { key: 'claim_inheritance_blocker', label: tr('Blocks claim inheritance…'), kind: 'choice', read: tr('Blocks claim inheritance: $'), options: [['none', tr('No')], ['dynasty', tr('Within the dynasty')], ['all', tr('Always')]] },
        { key: 'bastard', label: tr('Bastard…'), kind: 'choice', read: tr('Bastard: $'), options: [['none', tr('No')], ['illegitimate', tr('Illegitimate')], ['legitimate', tr('Legitimized')]] },
        { key: 'genetic_constraint_all', label: tr('Genetic constraint'), kind: 'text', suggest: 'values:traits:genetic_constraint_all', read: tr('Genetic constraint: $') },
        { key: 'genetic_constraint_men', label: tr('Genetic constraint (men)'), kind: 'text', suggest: 'values:traits:genetic_constraint_men', read: tr('Genetic constraint for men: $') },
        { key: 'genetic_constraint_women', label: tr('Genetic constraint (women)'), kind: 'text', suggest: 'values:traits:genetic_constraint_women', read: tr('Genetic constraint for women: $') },
        { key: 'portrait_extremity_shift', label: tr('Portrait extremity shift'), kind: 'number', presets: [0.1, 0.25, 0.5, 0.75], read: tr('Face genes shifted $ towards their extremes') },
        { key: 'ugliness_portrait_extremity_shift', label: tr('Ugliness extremity shift'), kind: 'number', presets: [0.1, 0.25, 0.4, 0.75], read: tr('Its most extreme feature shifted $ towards the extreme') },
        { key: 'negate_health_penalty_add', label: tr('Negates health penalties'), kind: 'number', presets: [0.1, 0.25, 0.5, 1], read: tr('Negates $ of health penalties') },
        { key: 'culture_succession_prio', label: tr('Succession priority (culture parameter)'), kind: 'text', suggest: 'values:traits:culture_succession_prio', read: tr('Succession priority with the culture parameter “$”') },
        { key: 'index', label: tr('Index (old saves)'), kind: 'number', presets: [], read: tr('Index $ (compatibility with old saves)') }
    ],
    // decisions, character interactions, schemes …: `cost = { gold = 100 prestige = 50 }`
    cost: [
        { key: 'gold', label: tr('Gold'), kind: 'number', k: 'g', presets: COST, ref: 'script_values', read: tr('$ gold') },
        { key: 'prestige', label: tr('Prestige'), kind: 'number', k: 'p', presets: COST, ref: 'script_values', read: tr('$ prestige') },
        { key: 'piety', label: tr('Piety'), kind: 'number', k: 'i', presets: COST, ref: 'script_values', read: tr('$ piety') },
        { key: 'influence', label: tr('Influence'), kind: 'number', k: 'f', presets: COST, ref: 'script_values', read: tr('$ influence') },
        { key: 'renown', label: tr('Renown'), kind: 'number', k: 'r', presets: COST, ref: 'script_values', read: tr('$ renown') }
    ],
    // a script value's formula (common/script_values): each line works on the value so far
    script_value: [
        { key: 'value', label: tr('Starts at'), kind: 'number', k: 's', presets: [0, 1, 5, 10, 25, 50, 100], ref: 'script_values', read: tr('Starts at $') },
        { key: 'add', label: tr('Add'), kind: 'number', k: 'a', presets: [1, 2, 5, 10, 25, 50, 100], ref: 'script_values', read: tr('Add $') },
        { key: 'subtract', label: tr('Subtract'), kind: 'number', k: 'u', presets: [1, 2, 5, 10, 25, 50, 100], ref: 'script_values', read: tr('Subtract $') },
        { key: 'multiply', label: tr('Multiply by'), kind: 'number', k: 'm', presets: [0.25, 0.5, 0.75, 1.5, 2, 3, 10], ref: 'script_values', read: tr('Multiply by $') },
        { key: 'divide', label: tr('Divide by'), kind: 'number', k: 'd', presets: [2, 3, 4, 5, 10, 100], ref: 'script_values', read: tr('Divide by $') },
        { key: 'min', label: tr('At least'), kind: 'number', k: 'l', presets: [0, 1, 5, 10], ref: 'script_values', read: tr('At least $') },
        { key: 'max', label: tr('At most'), kind: 'number', k: 'o', presets: [1, 10, 50, 100, 1000], ref: 'script_values', read: tr('At most $') }
    ],
    // history/characters: the entries of a character
    character_history: [{ key: 'trait', label: tr('Trait'), kind: 'ref', k: 't', ref: 'traits', read: tr('Has the trait $') }],
    // common/traits/_traits.info: opinion between holders, towards holders of an opposite trait
    trait_opinion: [
        { key: 'same_opinion', label: tr('Between holders'), kind: 'number', k: 's', signed: true, tone: 'good', presets: [5, 10, 15, 20, 25, 30, -5, -10, -15, -20], read: tr('$ opinion between characters who both have it') },
        { key: 'same_opinion_if_same_faith', label: tr('Between holders of one faith'), kind: 'number', k: 'f', signed: true, tone: 'good', presets: [5, 10, 15, 20, 25, 30, -5, -10], read: tr('$ opinion between holders of the same faith') },
        { key: 'opposite_opinion', label: tr('With the opposite trait'), kind: 'number', k: 'o', signed: true, tone: 'good', presets: [-5, -10, -15, -20, -25, -30, 5, 10], read: tr('$ opinion with characters of an opposite trait') },
        { key: 'triggered_opinion', label: tr('Under conditions…'), kind: 'block', k: 'c', sub: 'triggered_opinion', ask: ['opinion_modifier'], conds: ['parameter', 'check_missing', 'same_faith', 'same_dynasty', 'ignore_opinion_value_if_same_trait', 'male_only', 'female_only'], read: tr('An opinion modifier under conditions'), help: tr('An opinion modifier others get towards holders — for a doctrine, the same faith or dynasty, men or women only') }
    ],
    // a new doctrine parameter: the doctrine whose `parameters` turn it on
    new_doctrine_parameter: [{ key: 'doctrine', label: tr('Set by the doctrine…'), kind: 'ref', k: 'd', ref: 'religion/doctrine_types', read: tr('Set by $') }],
    // common/traits/_traits.info: `triggered_opinion = { opinion_modifier = x … }`
    triggered_opinion: [
        { key: 'opinion_modifier', label: tr('Which opinion'), kind: 'ref', k: 'o', ref: 'opinion_modifiers', read: tr('Opinion: $'), create: { what: 'opinion_modifiers', label: tr('New opinion modifier…'), fields: 'opinion_modifiers', locLabel: tr('Name shown in game…') } },
        {
            key: 'parameter',
            label: tr('Only with a doctrine parameter…'),
            kind: 'text',
            k: 'p',
            suggest: 'doctrine_parameters',
            read: tr('If their faith has “$”'),
            help: tr('A boolean doctrine parameter the faith must have (with “Only when missing”: must not have)'),
            create: { what: 'doctrine_parameter', label: tr('New doctrine parameter…'), fields: 'new_doctrine_parameter', ask: ['doctrine'], locLabel: tr('Sentence shown in game…') }
        },
        { key: 'check_missing', label: tr('Only when the parameter is missing'), kind: 'bool', k: 'm', read: { yes: tr('Unless their faith has the parameter'), no: tr('If their faith has the parameter') } },
        { key: 'same_faith', label: tr('Same faith only'), kind: 'bool', k: 'f', read: { yes: tr('Characters of the same faith'), no: tr('Any faith') } },
        { key: 'same_dynasty', label: tr('Same dynasty only'), kind: 'bool', k: 'y', read: { yes: tr('Members of the same dynasty'), no: tr('Any dynasty') } },
        { key: 'ignore_opinion_value_if_same_trait', label: tr('Not between holders'), kind: 'bool', k: 'n', read: { yes: tr('Not from others with the trait'), no: tr('Also from others with the trait') }, help: tr('Holders of the trait ignore the opinion value (punishment reasons still apply)') },
        { key: 'male_only', label: tr('Male holders only'), kind: 'bool', k: 'a', read: { yes: tr('Men only'), no: tr('Not only men') } },
        { key: 'female_only', label: tr('Female holders only'), kind: 'bool', k: 'e', read: { yes: tr('Women only'), no: tr('Not only women') } }
    ],
    // the field sets of the per-type cards (src/main/describe/cards/)
    // an on_action's lists (its story's "＋ event" / "＋ on_action": the value is written into `events`, `first_valid`,
    // `random_events` as `weight = id`, `on_actions`, `random_on_action`, `first_valid_on_action`; a fallback as
    // `fallback_event = id` / `fallback = id`), and what its story writes at a list's start: `duration` is the delay's
    // time (written inside `delay = { … }`), the chances their percent (`chance_of_no_event = N`, `chance_to_happen = N`)
    on_action_lists: [
        { key: 'event', label: tr('Event…'), kind: 'ref', ref: 'events', read: tr('Fires $') },
        { key: 'on_action', label: tr('On action…'), kind: 'ref', ref: 'on_action', read: tr('Also triggers $') },
        { key: 'duration', label: tr('Delay…'), kind: 'duration', presets: [1, 2, 5], range: true, read: tr('Delay $'), help: tr('The entries after it fire only once this time has passed') },
        { key: 'chance_of_no_event', label: tr('Chance of no event (%)…'), kind: 'number', presets: [0, 10, 25, 50, 75, 90], read: tr('$% chance that nothing happens') },
        { key: 'chance_to_happen', label: tr('Chance to happen (%)…'), kind: 'number', presets: [10, 25, 50, 75, 90], read: tr('Only happens $% of the time') }
    ],
    ...REALM_FIELDS,
    ...CULTURE_FIELDS,
    ...SCRIPTED_FIELDS,
    ...LIFE_FIELDS,
    ...PRESENTATION_FIELDS,
    ...SETTINGS_FIELDS
};

/**
 * The field sets whose definitions take any other setting too: their "＋ setting" offers "Other setting…" (a typed
 * key and value) besides the catalog's fields: the types whose statements show as "Settings", traits, characters.
 */
export const OPEN_SETS = new Set([...Object.keys(SETTINGS_FIELDS).filter((k) => !k.startsWith('trait_') && !SUB_SETS.has(k)), 'traits', 'opinion_modifiers']);

/**
 * The curated field sets of the types with a card builder of their own (main/describe/cards/): their definitions take
 * any other setting too, as their cards show the written keys they do not read (StoryBuilder.unknownSettings).
 * picker-check keeps the list equal to the builder types that have a curated set.
 */
export const CARD_SETS = new Set([
    'laws', 'law_groups', 'succession_appointment', 'landed_titles', 'holdings', 'governments', 'subject_contracts/contracts', 'subject_contracts/groups', 'lease_contracts', 'hook_types',
    'men_at_arms_types', 'casus_belli_groups', 'ai_war_stances', 'game_rules', 'house_relation_types', 'house_unities', 'culture/cultures', 'culture/name_lists', 'culture/innovations', 'culture/eras',
    'ethnicities', 'faith', 'religion/religion_types', 'religion/religion_family_types', 'religion/doctrine_group_types', 'religion/doctrine_types', 'religion/tenet_types', 'dynasties', 'dynasty_houses',
    'dynasty_house_mottos', 'nicknames', 'scripted_relations', 'scripted_character_templates', 'schemes/agent_types', 'artifacts/types', 'artifacts/slots', 'artifacts/templates', 'artifacts/visuals',
    'artifacts/blueprints', 'artifacts/features', 'bookmarks/bookmarks', 'bookmarks/groups', 'bookmarks/challenge_characters', 'deathreasons', 'character_backgrounds', 'tutorial_lessons', 'domiciles/types',
    'game_concepts', 'messages', 'message_filter_types', 'message_group_types', 'customizable_localization', 'flavorization', 'modifier_definition_formats', 'decision_group_types',
    'activities/activity_group_types', 'situation/situation_group_types', 'character_interaction_categories'
]);

/**
 * Whether a field set takes "Other setting…" (a key the type's definitions write, typed by the values the game writes
 * for it): the sets of OPEN_SETS and CARD_SETS, and any set the catalog has no fields for (a type without a curated
 * set: holy site types' modifiers aside, story cycles …, read as "Settings", and the builder types without one;
 * docs/picker.md, "Other setting…"). The sets of a block's fields (cost, trait_opinion …) stay closed, but for a
 * doctrine's `special_parameters` (a key a mod writes that _doctrine_types.info does not document).
 */
export function isOpenSet(set: string | undefined): boolean
{
    return !!set && set !== 'doctrine_parameters' && (OPEN_SETS.has(set) || CARD_SETS.has(set) || set === 'special_parameters' || !FIELDS[set]);
}

/** The field a written key belongs to: `years` → duration, `delay_months` → delay. */
export function fieldOf(type: string, key: string): FieldDef | undefined
{
    const list = FIELDS[type];

    if (!list)
        return undefined;

    const k = (DURATION_UNITS as readonly string[]).includes(key) ? 'duration' : /^delay_(days|months|years)$/.test(key) ? 'delay' : key;
    // (a key that is any entry (compatibility's traits), a number (a track's level))
    return list.find((f) => f.key === k) ?? list.find((f) => (f.anyKey && f.key === '*') || (f.kind === 'level' && /^\d+$/.test(key)));
}

/** A set's field for values written alone (a list's items: `opposites = { craven }`). */
export function bareField(type: string): FieldDef | undefined
{
    return FIELDS[type]?.find((f) => f.bare);
}

/** The written key of a duration field: `years`, `delay_years`. */
export function durationKey(f: FieldDef, unit: string): string
{
    return f.key === 'delay' ? `delay_${unit}` : unit;
}

/** "5 years", "1 month" */
function durationText(n: string, unit: string): string
{
    return `${n} ${n === '1' ? unit.slice(0, -1) : unit}`;
}

/** How a written field reads, with its tone; null when the type has no such field. */
export function fieldText(type: string, key: string, value: string): { text: string; tone?: 'good' | 'bad'; } | null
{
    const f = fieldOf(type, key);

    if (!f)
        return null;

    if (typeof f.read !== 'string')
        return { text: value === 'no' ? f.read.no : f.read.yes };

    let shown = f.kind === 'choice' ? (f.options?.find(([v]) => v === value)?.[1] ?? value) : value;

    if (f.kind === 'duration')
        shown = durationText(value, key.replace(/^delay_/, ''));
    else if (f.signed && /^\d/.test(value) && Number(value) > 0)
        shown = '+' + value;

    const text = f.read.replace('$', shown).replace('%k', key.replace(/_/g, ' '));
    const n = Number(value);
    const tone = f.tone && Number.isFinite(n) && n !== 0 ? ((n > 0) === (f.tone === 'good') ? 'good' : 'bad') : undefined;
    return { text: text.charAt(0).toUpperCase() + text.slice(1), tone };
}
