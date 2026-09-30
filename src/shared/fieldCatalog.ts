/**
 * The fields of a definition that the statement picker builds and the readable view lists line by line
 * (docs/picker.md, "Modifiers and fields"): per entry type, what each field is called, what value it takes and how it
 * reads. Plain data — used by the picker (renderer) and the card builder (main/describe/stories.ts).
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
     * of its own (`50 = { }` — a trait's experience track level, its modifiers added into it afterwards)
     */
    kind: 'number' | 'bool' | 'duration' | 'ref' | 'text' | 'block' | 'choice' | 'level';
    /** the value is written alone, no key (a list's item: `opposites = { craven }`) */
    bare?: boolean;
    /** text: typed as it is (a name) — quoted when it holds anything but a–z, digits and _ (`name = "Þórir"`) */
    free?: boolean;
    /**
     * the key is an entry of this index type, any of them (`compatibility = { brave = 15 }`: `key` is '*'): asked first,
     * then the value; `%k` in `read` is the key made readable
     */
    anyKey?: string;
    /** choice: its values (script value, label) */
    options?: [string, string][];
    /** entries of this index type as values (ref), or offered after the presets (numbers: script values by name) */
    ref?: string;
    /** block: the field set of its fields */
    sub?: string;
    /** block: fields it needs (asked right away, in order) */
    ask?: string[];
    /** text: where suggestions come from (api.fieldSuggestions: 'doctrine_parameters', 'values:<type>:<key>'); numbers: the
     * named values the game writes for it, offered after the presets (`values:buildings:construction_time`) */
    suggest?: string;
    /**
     * ref: the entries grouped as this suggestion source groups them (`doctrine_groups`: a menu per doctrine group, by
     * category) — with `PickRequest.only` just those entries
     */
    group?: string;
    /**
     * a new entry can be made here instead of naming an existing one: what it is (EntryCreate.what), the menu's label,
     * the field set of its settings (`ask`: asked first), what its in-game text is called
     */
    create?: { what: 'opinion_modifiers' | 'doctrine_parameter'; label: string; fields: string; ask?: string[]; locLabel: string; };
    k?: string;
    presets?: number[];
    /** numbers shown with a sign (+30) */
    signed?: boolean;
    /** a positive number / `yes` is good (green) or bad (red) for the one who has it */
    tone?: 'good' | 'bad';
    /** the readable line: `$` is the value (numbers, durations); bools read `yes` / `no` */
    read: string | { yes: string; no: string; };
    /** a short explanation (the menu row's tooltip) */
    help?: string;
}

import { REALM_FIELDS } from './fields/realm.ts';
import { CULTURE_FIELDS } from './fields/culture.ts';
import { SCRIPTED_FIELDS } from './fields/scripted.ts';
import { LIFE_FIELDS } from './fields/life.ts';
import { PRESENTATION_FIELDS } from './fields/presentation.ts';
import { SETTINGS_FIELDS } from './fields/settings.ts';

const DURATION_UNITS = ['days', 'months', 'years'] as const;

const COST = [25, 50, 75, 100, 150, 200, 250, 300, 500, 1000];

/**
 * Keys: an entry type (`opinion_modifiers`: the definition's own fields), or a block's field set — `cost` (a cost
 * block), `script_value` (a script value's formula), `character_history` (a character's history entries),
 * `trait_opinion` (a trait's opinion fields).
 */
export const FIELDS: Record<string, FieldDef[]> = {
    // common/opinion_modifiers/_opinions.info
    opinion_modifiers: [
        { key: 'opinion', label: 'Opinion value', kind: 'number', k: 'o', signed: true, tone: 'good', presets: [5, 10, 15, 20, 25, 30, 50, 100, -5, -10, -15, -20, -25, -30, -50, -100], read: '$ opinion' },
        { key: 'decaying', label: 'Fades over time', kind: 'bool', k: 'f', read: { yes: 'Fades over time', no: 'Does not fade' }, help: 'The value decays to 0 over its duration' },
        { key: 'duration', label: 'Lasts…', kind: 'duration', k: 'l', presets: [1, 2, 3, 5, 10, 20], read: 'Lasts $', help: 'How long the opinion lasts (days / months / years); without it, until removed' },
        { key: 'monthly_change', label: 'Change per month', kind: 'number', k: 'm', presets: [0.5, 1, 2, 5, 10], read: 'Changes by $ per month', help: 'Instead of a duration' },
        { key: 'stacking', label: 'Can stack', kind: 'bool', k: 's', read: { yes: 'Can stack', no: 'Does not stack' }, help: 'Applying it again adds up instead of resetting its duration' },
        { key: 'imprisonment_reason', label: 'Allows imprisonment', kind: 'bool', k: 'i', read: { yes: 'Allows imprisonment', no: 'No imprisonment reason' }, help: 'Gives a reason to imprison the target' },
        { key: 'revoke_title_reason', label: 'Allows title revocation', kind: 'bool', k: 'r', read: { yes: 'Allows title revocation', no: 'No revocation reason' } },
        { key: 'execute_reason', label: 'Allows execution', kind: 'bool', k: 'e', read: { yes: 'Allows execution', no: 'No execution reason' } },
        { key: 'banish_reason', label: 'Allows banishment', kind: 'bool', k: 'b', read: { yes: 'Allows banishment', no: 'No banishment reason' } },
        { key: 'growing', label: 'Grows over time', kind: 'bool', k: 'g', read: { yes: 'Grows over time', no: 'Does not grow' }, help: 'Starts at 0 (or its minimum) and grows to its value' },
        { key: 'delay', label: 'Starts fading after…', kind: 'duration', k: 'd', presets: [1, 2, 5], read: 'Starts fading after $', help: 'Only with “Fades over time”' },
        { key: 'min', label: 'Lowest value', kind: 'number', k: 'w', signed: true, presets: [-100, -50, -25, 0], read: 'At least $' },
        { key: 'max', label: 'Highest value', kind: 'number', k: 'h', signed: true, presets: [0, 25, 50, 100], read: 'At most $' },
        { key: 'obedient', label: 'Makes obedient', kind: 'bool', k: 'y', read: { yes: 'Makes them obedient', no: 'No obedience' }, help: 'Obedient to the target while it lasts (both must use obedience)' },
        { key: 'divorce_reason', label: 'Allows divorce', kind: 'bool', k: 'v', read: { yes: 'Allows divorce', no: 'No divorce reason' } }
    ],
    // common/traits/_traits.info: a trait's own properties (its modifiers are the "Modifiers" section)
    traits: [
        {
            key: 'category',
            label: 'Category',
            kind: 'choice',
            k: 'c',
            read: 'Category: $',
            options: [['personality', 'Personality'], ['education', 'Education'], ['childhood', 'Childhood'], ['commander', 'Commander'], ['winter_commander', 'Winter commander'], ['lifestyle', 'Lifestyle'], ['court_type', 'Court type'], ['fame', 'Fame'], ['health', 'Health']]
        },
        { key: 'ruler_designer_cost', label: 'Ruler designer cost', kind: 'number', k: 'r', presets: [0, 5, 10, 20, 30, 40, 50, -5, -10, -20], read: 'Costs $ in the ruler designer' },
        { key: 'flag', label: 'Flag…', kind: 'text', k: 'f', suggest: 'values:traits:flag', read: 'Flag: $', help: 'A trait flag (has_trait_with_flag); several are allowed' },
        { key: 'shown_in_ruler_designer', label: 'Shown in the ruler designer', kind: 'bool', k: 's', read: { yes: 'Shown in the ruler designer', no: 'Not in the ruler designer' } },
        { key: 'shown_in_encyclopedia', label: 'Shown in the encyclopedia', kind: 'bool', k: 'e', read: { yes: 'Shown in the encyclopedia', no: 'Not in the encyclopedia' } },
        { key: 'level', label: 'Level in its group', kind: 'number', k: 'l', presets: [1, 2, 3, 4, 5], read: 'Level $ of its group' },
        { key: 'group', label: 'Group…', kind: 'text', k: 'g', suggest: 'values:traits:group', read: 'Group: $', help: 'Trait group, for inheritance and equivalence' },
        { key: 'group_equivalence', label: 'Group (equivalence only)…', kind: 'text', suggest: 'values:traits:group_equivalence', read: 'Equivalent to the group $' },
        { key: 'group_inheritance', label: 'Group (inheritance only)…', kind: 'text', suggest: 'values:traits:group_inheritance', read: 'Inherited like the group $' },
        { key: 'physical', label: 'Physical', kind: 'bool', k: 'p', read: { yes: 'A physical aspect of the body', no: 'Not physical' } },
        { key: 'genetic', label: 'Genetic', kind: 'bool', k: 'n', read: { yes: 'Genetic — can be inherited', no: 'Not genetic' } },
        { key: 'good', label: 'Good genetic trait', kind: 'bool', k: 'o', read: { yes: 'A good genetic trait', no: 'A bad genetic trait' } },
        { key: 'enables_inbred', label: 'Children can be inbred', kind: 'bool', k: 'b', read: { yes: 'Its children can be inbred', no: 'No inbreeding from it' } },
        { key: 'immortal', label: 'Immortal', kind: 'bool', k: 'i', read: { yes: 'Immortal — no aging, no natural death', no: 'Mortal' } },
        { key: 'incapacitating', label: 'Incapacitating', kind: 'bool', k: 'a', read: { yes: 'Incapacitating — needs a regent', no: 'Not incapacitating' } },
        { key: 'can_have_children', label: 'Can have children', kind: 'bool', k: 'h', read: { yes: 'Can have children', no: 'Cannot have children' } },
        { key: 'disables_combat_leadership', label: 'Cannot lead armies', kind: 'bool', k: 'd', read: { yes: 'Cannot lead armies', no: 'Can lead armies' } },
        { key: 'add_commander_trait', label: 'Adds commander traits', kind: 'bool', read: { yes: 'Generated characters with it get commander traits', no: 'No commander traits added' } },
        { key: 'valid_sex', label: 'Only for…', kind: 'choice', k: 'v', read: 'Only for: $', options: [['all', 'Everyone'], ['male', 'Men'], ['female', 'Women']] },
        { key: 'minimum_age', label: 'Minimum age', kind: 'number', k: 'm', presets: [3, 6, 12, 16, 18], read: 'Minimum age $' },
        { key: 'maximum_age', label: 'Maximum age', kind: 'number', k: 'x', presets: [3, 6, 12, 15, 16, 18], read: 'Maximum age $' },
        { key: 'birth', label: 'Born with it (%)', kind: 'number', presets: [0.1, 0.5, 1, 2, 5, 10], read: '$% are born with it' },
        { key: 'random_creation', label: 'Chance on creation (%)', kind: 'number', presets: [0.1, 0.5, 1, 2, 5, 10], read: '$% chance for generated characters' },
        { key: 'random_creation_weight', label: 'Weight when picked at random', kind: 'number', presets: [0, 1, 2, 5, 10], read: 'Weight $ when picked at random' },
        { key: 'inherit_chance', label: 'Inherit chance (%)', kind: 'number', presets: [10, 25, 50, 75, 100], read: '$% chance to be inherited' },
        { key: 'both_parent_has_trait_inherit_chance', label: 'Inherit chance, both parents (%)', kind: 'number', presets: [25, 50, 75, 100], read: '$% when both parents have it' },
        { key: 'parent_inheritance_sex', label: 'Inherited from…', kind: 'choice', read: 'Inherited from: $', options: [['all', 'Both parents'], ['male', 'Fathers'], ['female', 'Mothers']] },
        { key: 'child_inheritance_sex', label: 'Inherited by…', kind: 'choice', read: 'Inherited by: $', options: [['all', 'All children'], ['male', 'Sons'], ['female', 'Daughters']] },
        { key: 'inherit_from_real_father', label: 'From the real father', kind: 'bool', read: { yes: 'Inherited from the real father', no: 'Not from the real father' } },
        { key: 'inherit_from_real_mother', label: 'From the real mother', kind: 'bool', read: { yes: 'Inherited from the real mother', no: 'Not from the real mother' } },
        { key: 'inheritance_blocker', label: 'Blocks inheritance…', kind: 'choice', read: 'Blocks inheritance: $', options: [['none', 'No'], ['dynasty', 'Within the dynasty'], ['all', 'Always']] },
        { key: 'claim_inheritance_blocker', label: 'Blocks claim inheritance…', kind: 'choice', read: 'Blocks claim inheritance: $', options: [['none', 'No'], ['dynasty', 'Within the dynasty'], ['all', 'Always']] },
        { key: 'bastard', label: 'Bastard…', kind: 'choice', read: 'Bastard: $', options: [['none', 'No'], ['illegitimate', 'Illegitimate'], ['legitimate', 'Legitimized']] },
        { key: 'genetic_constraint_all', label: 'Genetic constraint', kind: 'text', suggest: 'values:traits:genetic_constraint_all', read: 'Genetic constraint: $' },
        { key: 'genetic_constraint_men', label: 'Genetic constraint (men)', kind: 'text', suggest: 'values:traits:genetic_constraint_men', read: 'Genetic constraint for men: $' },
        { key: 'genetic_constraint_women', label: 'Genetic constraint (women)', kind: 'text', suggest: 'values:traits:genetic_constraint_women', read: 'Genetic constraint for women: $' },
        { key: 'portrait_extremity_shift', label: 'Portrait extremity shift', kind: 'number', presets: [0.1, 0.25, 0.5, 0.75], read: 'Face genes shifted $ towards their extremes' },
        { key: 'ugliness_portrait_extremity_shift', label: 'Ugliness extremity shift', kind: 'number', presets: [0.1, 0.25, 0.4, 0.75], read: 'Its most extreme feature shifted $ towards the extreme' },
        { key: 'negate_health_penalty_add', label: 'Negates health penalties', kind: 'number', presets: [0.1, 0.25, 0.5, 1], read: 'Negates $ of health penalties' },
        { key: 'culture_succession_prio', label: 'Succession priority (culture parameter)', kind: 'text', suggest: 'values:traits:culture_succession_prio', read: 'Succession priority with the culture parameter “$”' },
        { key: 'index', label: 'Index (old saves)', kind: 'number', presets: [], read: 'Index $ (compatibility with old saves)' }
    ],
    // decisions, character interactions, schemes …: `cost = { gold = 100 prestige = 50 }`
    cost: [
        { key: 'gold', label: 'Gold', kind: 'number', k: 'g', presets: COST, ref: 'script_values', read: '$ gold' },
        { key: 'prestige', label: 'Prestige', kind: 'number', k: 'p', presets: COST, ref: 'script_values', read: '$ prestige' },
        { key: 'piety', label: 'Piety', kind: 'number', k: 'i', presets: COST, ref: 'script_values', read: '$ piety' },
        { key: 'influence', label: 'Influence', kind: 'number', k: 'f', presets: COST, ref: 'script_values', read: '$ influence' },
        { key: 'renown', label: 'Renown', kind: 'number', k: 'r', presets: COST, ref: 'script_values', read: '$ renown' }
    ],
    // a script value's formula (common/script_values): each line works on the value so far
    script_value: [
        { key: 'value', label: 'Starts at', kind: 'number', k: 's', presets: [0, 1, 5, 10, 25, 50, 100], ref: 'script_values', read: 'Starts at $' },
        { key: 'add', label: 'Add', kind: 'number', k: 'a', presets: [1, 2, 5, 10, 25, 50, 100], ref: 'script_values', read: 'Add $' },
        { key: 'subtract', label: 'Subtract', kind: 'number', k: 'u', presets: [1, 2, 5, 10, 25, 50, 100], ref: 'script_values', read: 'Subtract $' },
        { key: 'multiply', label: 'Multiply by', kind: 'number', k: 'm', presets: [0.25, 0.5, 0.75, 1.5, 2, 3, 10], ref: 'script_values', read: 'Multiply by $' },
        { key: 'divide', label: 'Divide by', kind: 'number', k: 'd', presets: [2, 3, 4, 5, 10, 100], ref: 'script_values', read: 'Divide by $' },
        { key: 'min', label: 'At least', kind: 'number', k: 'l', presets: [0, 1, 5, 10], ref: 'script_values', read: 'At least $' },
        { key: 'max', label: 'At most', kind: 'number', k: 'o', presets: [1, 10, 50, 100, 1000], ref: 'script_values', read: 'At most $' }
    ],
    // history/characters: the entries of a character
    character_history: [{ key: 'trait', label: 'Trait', kind: 'ref', k: 't', ref: 'traits', read: 'Has the trait $' }],
    // common/traits/_traits.info: opinion between holders, towards holders of an opposite trait
    trait_opinion: [
        { key: 'same_opinion', label: 'Between holders', kind: 'number', k: 's', signed: true, tone: 'good', presets: [5, 10, 15, 20, 25, 30, -5, -10, -15, -20], read: '$ opinion between characters who both have it' },
        { key: 'same_opinion_if_same_faith', label: 'Between holders of one faith', kind: 'number', k: 'f', signed: true, tone: 'good', presets: [5, 10, 15, 20, 25, 30, -5, -10], read: '$ opinion between holders of the same faith' },
        { key: 'opposite_opinion', label: 'With the opposite trait', kind: 'number', k: 'o', signed: true, tone: 'good', presets: [-5, -10, -15, -20, -25, -30, 5, 10], read: '$ opinion with characters of an opposite trait' },
        { key: 'triggered_opinion', label: 'Under conditions…', kind: 'block', k: 'c', sub: 'triggered_opinion', ask: ['opinion_modifier'], read: 'An opinion modifier under conditions', help: 'An opinion modifier others get towards holders — for a doctrine, the same faith or dynasty, men or women only' }
    ],
    // a new doctrine parameter: the doctrine whose `parameters` turn it on
    new_doctrine_parameter: [{ key: 'doctrine', label: 'Set by the doctrine…', kind: 'ref', k: 'd', ref: 'religion/doctrine_types', read: 'Set by $' }],
    // common/traits/_traits.info: `triggered_opinion = { opinion_modifier = x … }`
    triggered_opinion: [
        { key: 'opinion_modifier', label: 'Which opinion', kind: 'ref', k: 'o', ref: 'opinion_modifiers', read: 'Opinion: $', create: { what: 'opinion_modifiers', label: 'New opinion modifier…', fields: 'opinion_modifiers', locLabel: 'Name shown in game…' } },
        {
            key: 'parameter',
            label: 'Only with a doctrine parameter…',
            kind: 'text',
            k: 'p',
            suggest: 'doctrine_parameters',
            read: 'If their faith has “$”',
            help: 'A boolean doctrine parameter the faith must have (with “Only when missing”: must not have)',
            create: { what: 'doctrine_parameter', label: 'New doctrine parameter…', fields: 'new_doctrine_parameter', ask: ['doctrine'], locLabel: 'Sentence shown in game…' }
        },
        { key: 'check_missing', label: 'Only when the parameter is missing', kind: 'bool', k: 'm', read: { yes: 'Unless their faith has the parameter', no: 'If their faith has the parameter' } },
        { key: 'same_faith', label: 'Same faith only', kind: 'bool', k: 'f', read: { yes: 'Characters of the same faith', no: 'Any faith' } },
        { key: 'same_dynasty', label: 'Same dynasty only', kind: 'bool', k: 'y', read: { yes: 'Members of the same dynasty', no: 'Any dynasty' } },
        { key: 'ignore_opinion_value_if_same_trait', label: 'Not between holders', kind: 'bool', k: 'n', read: { yes: 'Not from others with the trait', no: 'Also from others with the trait' }, help: 'Holders of the trait ignore the opinion value (punishment reasons still apply)' },
        { key: 'male_only', label: 'Male holders only', kind: 'bool', k: 'a', read: { yes: 'Men only', no: 'Not only men' } },
        { key: 'female_only', label: 'Female holders only', kind: 'bool', k: 'e', read: { yes: 'Women only', no: 'Not only women' } }
    ],
    // the field sets of the per-type cards (src/main/describe/cards/)
    // an on_action's lists (its story's "＋ event" / "＋ on_action": the value is written into `events`, `random_events`
    // as `weight = id`, `on_actions`)
    on_action_lists: [
        { key: 'event', label: 'Event…', kind: 'ref', ref: 'events', read: 'Fires $' },
        { key: 'on_action', label: 'On action…', kind: 'ref', ref: 'on_action', read: 'Also triggers $' }
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
 * key and value) besides the catalog's fields — the types whose statements show as "Settings", traits, characters.
 */
export const OPEN_SETS = new Set([...Object.keys(SETTINGS_FIELDS).filter((k) => !k.startsWith('trait_')), 'traits', 'opinion_modifiers']);

/** The field a written key belongs to: `years` → duration, `delay_months` → delay. */
export function fieldOf(type: string, key: string): FieldDef | undefined
{
    const list = FIELDS[type];

    if (!list)
        return undefined;

    const k = (DURATION_UNITS as readonly string[]).includes(key) ? 'duration' : /^delay_(days|months|years)$/.test(key) ? 'delay' : key;
    // (a key that is any entry — compatibility's traits —, a number — a track's level)
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
