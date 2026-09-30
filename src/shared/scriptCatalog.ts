/**
 * What the statement picker offers (docs/picker.md): scope types, the scopes one can switch to from each (links,
 * saved scopes, iterators), and the effects and triggers by menu group with their parameters and how they are
 * written. Plain data plus small helpers — no index needed; database entries, flags and the "Other…" keys come from
 * the index at pick time.
 *
 * Coverage follows vanilla usage (scripts/key-frequency.ts and the picker's own key scan, ScriptKeyInfo). Menu
 * labels are short; the preview reads the built script through the describer, so the sentence speaks like the
 * readable view.
 */

/** Scope types the picker knows ('any': statements that work in every scope — variables). */
export type ScopeType = 'character' | 'landed_title' | 'province' | 'faith' | 'culture' | 'dynasty' | 'dynasty_house' | 'artifact' | 'war' | 'scheme' | 'secret' | 'religion';

export type PickKind = 'effect' | 'trigger';

export const SCOPE_LABELS: Record<ScopeType, string> = {
    character: 'character',
    landed_title: 'title',
    province: 'province',
    faith: 'faith',
    culture: 'culture',
    dynasty: 'dynasty',
    dynasty_house: 'house',
    artifact: 'artifact',
    war: 'war',
    scheme: 'scheme',
    secret: 'secret',
    religion: 'religion'
};

/** Order of the "Effect on …" / "Condition on …" entries of the root menu. */
export const SCOPE_ORDER: ScopeType[] = ['character', 'landed_title', 'province', 'faith', 'culture', 'dynasty', 'dynasty_house', 'artifact', 'war', 'scheme', 'secret', 'religion'];

/**
 * What a block of stat modifiers applies to, by its key (docs/picker.md, "Modifiers and settings"): a character
 * (`character_modifier`, `government_character_modifier`, a trait's `culture_modifier`, the modifiers for a liege, an
 * owner, a subject, an employer …, a definition's `modifier`), a county (`county_modifier`,
 * `duchy_capital_county_modifier`), a province (`province_modifier`, `province_terrain_modifier`); undefined: unknown.
 */
export function modifierScopeOf(key: string): 'character' | 'landed_title' | 'province' | undefined
{
    if (/character/.test(key))
        return 'character';

    if (/province/.test(key))
        return 'province';

    if (/county/.test(key))
        return 'landed_title';

    if (key === 'modifier' || /^(liege|owner|subject|council_owner|employee|employer|base_employer|house_head|powerful_family\w*|courtier_guest|involved_character|any_house_member|culture|doctrine|government|knight\w*|spouse|heir|vassal|councillor)_modifier$/.test(key))
        return 'character';

    return undefined;
}

/**
 * The scope type a saved scope's name says it holds (the picker's targets): a province, a title, a scheme …; undefined:
 * a character (actor, recipient, host, liege …); null: something the picker has no statements for (an activity, a story,
 * an epidemic, a flag's name …).
 */
export function scopeTypeByName(name: string): string | null | undefined
{
    const n = name.toLowerCase();

    if (
        /^(activity|story|epidemic|legend|great_project|situation\w*|tax_slot|travel\w*|special_option|flag_name|opinion_of_liege|replacing|army|regiment|domicile|struggle|inspiration|task_contract|decision|intent|holding|goh|score|on_\w+|\w*_value|\w*_list|\w*_cost|\w*_(days|time|type|category|variables|chance|count|amount|score))$/
            .test(n)
    )
        return null;

    if (/(^|_)(province|location)$/.test(n))
        return 'province';

    if (/(^|_)(title|county|duchy|kingdom|empire|barony)$/.test(n))
        return 'landed_title';

    const direct: Record<string, string> = { scheme: 'scheme', secret: 'secret', war: 'war', faith: 'faith', religion: 'religion', culture: 'culture', house: 'dynasty_house', dynasty: 'dynasty', artifact: 'artifact' };
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

    return (SCOPE_ORDER as string[]).includes(s) ? (s as ScopeType) : 'character';
}

// ---------------------------------------------------------------------------
// Scopes one can switch to
// ---------------------------------------------------------------------------

/** A scope link (`liege`), a saved scope (`scope:actor`) or `root`: written as `key = { … }`, chained with dots. */
export interface ScopeLink
{
    key: string;
    label: string;
    /** scope types it is reached from (empty: from everywhere — root, saved scopes) */
    from: ScopeType[];
    to: ScopeType;
    /** shown right in the root menu ("Liege is…") rather than under "Someone else…" */
    main?: boolean;
    /** mnemonic */
    k?: string;
}

export const LINKS: ScopeLink[] = [
    // character → character
    { key: 'root', label: 'Root', from: [], to: 'character', main: true, k: 'r' },
    { key: 'liege', label: 'Liege', from: ['character'], to: 'character', main: true, k: 'l' },
    { key: 'primary_spouse', label: 'Primary spouse', from: ['character'], to: 'character', main: true, k: 'p' },
    { key: 'father', label: 'Father', from: ['character'], to: 'character', main: true, k: 'f' },
    { key: 'mother', label: 'Mother', from: ['character'], to: 'character', main: true, k: 'm' },
    { key: 'primary_heir', label: 'Primary heir', from: ['character'], to: 'character', main: true, k: 'h' },
    { key: 'employer', label: 'Employer', from: ['character'], to: 'character', main: true, k: 'e' },
    { key: 'top_liege', label: 'Top liege', from: ['character'], to: 'character', k: 't' },
    { key: 'host', label: 'Host', from: ['character'], to: 'character' },
    { key: 'betrothed', label: 'Betrothed', from: ['character'], to: 'character' },
    { key: 'designated_heir', label: 'Designated heir', from: ['character'], to: 'character' },
    { key: 'real_father', label: 'Real father', from: ['character'], to: 'character' },
    { key: 'killer', label: 'Killer', from: ['character'], to: 'character' },
    { key: 'imprisoner', label: 'Imprisoner', from: ['character'], to: 'character' },
    // character → other types
    { key: 'faith', label: 'Faith', from: ['character', 'landed_title', 'province'], to: 'faith', k: 'f' },
    { key: 'culture', label: 'Culture', from: ['character', 'landed_title', 'province'], to: 'culture', k: 'c' },
    { key: 'dynasty', label: 'Dynasty', from: ['character', 'dynasty_house'], to: 'dynasty', k: 'd' },
    { key: 'house', label: 'House', from: ['character'], to: 'dynasty_house', k: 'h' },
    { key: 'primary_title', label: 'Primary title', from: ['character'], to: 'landed_title', k: 'p' },
    { key: 'capital_county', label: 'Capital county', from: ['character'], to: 'landed_title', k: 'c' },
    { key: 'location', label: 'Location', from: ['character'], to: 'province', k: 'l' },
    { key: 'capital_province', label: 'Capital province', from: ['character'], to: 'province', k: 'c' },
    // titles
    { key: 'holder', label: 'Holder', from: ['landed_title'], to: 'character', main: true, k: 'h' },
    { key: 'de_jure_liege', label: 'De jure liege title', from: ['landed_title'], to: 'landed_title', k: 'd' },
    { key: 'duchy', label: 'Duchy', from: ['landed_title', 'province'], to: 'landed_title' },
    { key: 'kingdom', label: 'Kingdom', from: ['landed_title', 'province'], to: 'landed_title' },
    { key: 'empire', label: 'Empire', from: ['landed_title', 'province'], to: 'landed_title' },
    { key: 'title_province', label: 'Title province', from: ['landed_title'], to: 'province' },
    // provinces
    { key: 'county', label: 'County', from: ['province'], to: 'landed_title', k: 'c' },
    { key: 'barony', label: 'Barony', from: ['province'], to: 'landed_title', k: 'b' },
    { key: 'province_owner', label: 'Owner', from: ['province'], to: 'character', main: true, k: 'o' },
    // faiths, cultures, dynasties, houses
    { key: 'religious_head', label: 'Head of faith', from: ['faith'], to: 'character', main: true, k: 'h' },
    { key: 'religion', label: 'Religion', from: ['faith'], to: 'religion' },
    { key: 'culture_head', label: 'Culture head', from: ['culture'], to: 'character', main: true, k: 'h' },
    { key: 'dynast', label: 'Dynast', from: ['dynasty'], to: 'character', main: true, k: 'd' },
    { key: 'house_head', label: 'House head', from: ['dynasty_house'], to: 'character', main: true, k: 'h' },
    // artifacts, wars, schemes, secrets
    { key: 'artifact_owner', label: 'Owner', from: ['artifact'], to: 'character', main: true, k: 'o' },
    { key: 'primary_attacker', label: 'Primary attacker', from: ['war'], to: 'character', main: true, k: 'a' },
    { key: 'primary_defender', label: 'Primary defender', from: ['war'], to: 'character', main: true, k: 'd' },
    { key: 'scheme_owner', label: 'Scheme owner', from: ['scheme'], to: 'character', main: true, k: 'o' },
    { key: 'scheme_target_character', label: 'Scheme target', from: ['scheme'], to: 'character', main: true, k: 't' },
    { key: 'secret_owner', label: 'Secret owner', from: ['secret'], to: 'character', main: true, k: 'o' },
    { key: 'secret_target', label: 'Secret target', from: ['secret'], to: 'character', main: true, k: 't' }
];

/** Saved scopes most used in vanilla (event and interaction scopes), offered under "Saved scope…" and for targets. */
export const SAVED_SCOPES: { key: string; label: string; }[] = [
    { key: 'scope:actor', label: 'Actor (scope:actor)' },
    { key: 'scope:recipient', label: 'Recipient (scope:recipient)' },
    { key: 'scope:target', label: 'Target (scope:target)' },
    { key: 'scope:secondary_recipient', label: 'Secondary recipient' },
    { key: 'scope:host', label: 'Host (scope:host)' },
    { key: 'prev', label: 'Previous scope (prev)' }
];

/** A list the game can iterate: every_/random_/ordered_ (effects), any_ (triggers). */
export interface IteratorDef
{
    list: string;
    /** singular ("child") */
    label: string;
    from: ScopeType[];
    to: ScopeType;
    /** every_/random_ exist */
    effect: boolean;
    /** any_ exists */
    trigger: boolean;
    /**
     * its `type = …` parameter: entries of the index type `ref` (a relation's: friend, rival …), asked when chosen —
     * `optional`: the label of leaving it out ("Any secret")
     */
    type?: { ref: string; label: string; optional?: string; };
    /** `order_by` values that fit its items (ordered_: "The one with the highest …") */
    orders?: [string, string][];
}

const it = (list: string, label: string, from: ScopeType[], to: ScopeType, effect = true, trigger = true, extra: Partial<IteratorDef> = {}): IteratorDef => ({ list, label, from, to, effect, trigger, ...extra });

/** `order_by` values the game uses for characters and titles (ordered_ iterators) */
const CHARACTER_ORDERS: [string, string][] = [
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
    ['highest_held_title_tier', 'title tier'],
    ['max_military_strength', 'military strength'],
    ['opinion(root)', 'opinion of Root']
];
const TITLE_ORDERS: [string, string][] = [
    ['tier', 'tier'],
    ['development_level', 'development'],
    ['county_control', 'county control']
];

const who_ = { orders: CHARACTER_ORDERS };
const land = { orders: TITLE_ORDERS };

export const ITERATORS: IteratorDef[] = [
    it('child', 'child', ['character'], 'character', true, true, who_),
    it('vassal', 'vassal', ['character'], 'character', true, true, who_),
    it('courtier', 'courtier', ['character'], 'character', true, true, who_),
    it('courtier_or_guest', 'courtier or guest', ['character'], 'character', true, true, who_),
    it('spouse', 'spouse', ['character'], 'character', true, true, who_),
    it('consort', 'consort', ['character'], 'character', true, true, who_),
    it('sibling', 'sibling', ['character'], 'character', true, true, who_),
    it('parent', 'parent', ['character'], 'character', true, true, who_),
    it('close_family_member', 'close family member', ['character'], 'character', true, true, who_),
    it('knight', 'knight', ['character'], 'character', true, true, who_),
    it('councillor', 'councillor', ['character'], 'character', true, true, who_),
    it('prisoner', 'prisoner', ['character'], 'character', true, true, who_),
    it('ally', 'ally', ['character'], 'character', true, true, who_),
    it('vassal_or_below', 'vassal or below', ['character'], 'character', true, true, who_),
    it('liege_or_above', 'liege or above', ['character'], 'character', false, true),
    // (`type = friend` — which relation; the game's relation iterators always name one)
    it('relation', 'relation', ['character'], 'character', true, true, { ...who_, type: { ref: 'scripted_relations', label: 'Which relation?' } }),
    it('dynasty_member', 'dynasty member', ['dynasty'], 'character', true, true, who_),
    it('house_member', 'house member', ['dynasty_house'], 'character', true, true, who_),
    it('held_title', 'held title', ['character'], 'landed_title', true, true, land),
    it('held_county', 'held county', ['character'], 'landed_title', true, true, land),
    it('realm_county', 'realm county', ['character'], 'landed_title', true, true, land),
    it('sub_realm_county', 'sub-realm county', ['character'], 'landed_title', true, true, land),
    it('de_jure_county', 'de jure county', ['landed_title'], 'landed_title', true, true, land),
    it('neighboring_county', 'neighboring county', ['landed_title'], 'landed_title', true, true, land),
    it('county_province', 'county province', ['landed_title'], 'province'),
    it('character_artifact', 'artifact', ['character'], 'artifact'),
    it('character_war', 'war', ['character'], 'war'),
    it('scheme', 'scheme', ['character'], 'scheme', true, true, { type: { ref: 'schemes/scheme_types', label: 'Which kind of scheme?', optional: 'Any scheme' } }),
    it('secret', 'secret', ['character'], 'secret', true, true, { type: { ref: 'secret_types', label: 'Which kind of secret?', optional: 'Any secret' } })
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
}

/** A database entry of an index type (`traits`, `opinion_modifiers`, …): type-ahead over its names. */
export interface RefParam extends ParamBase
{
    kind: 'ref';
    type: string;
    /** written in front of the key: `faith:`, `culture:`, `title:` */
    prefix?: string;
    /** scope expressions offered first (`root.faith` — "Root’s faith") */
    scopes?: { value: string; label: string; }[];
}

/** One of a fixed set of values; `value` may also fill a key (`add_$skill$_skill`). */
export interface ChoiceParam extends ParamBase
{
    kind: 'choice';
    options: { value: string; label: string; k?: string; }[];
}

/** `days = N` / `months = N` / `years = N` */
export interface DurationParam extends ParamBase
{
    kind: 'duration';
    presets: [number, 'days' | 'months' | 'years'][];
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
     * also suggest the values the game's script writes for this statement's key (the key scan, most used first) — or
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
    /** menu label, short ("Opinion") — the group gives the verb */
    label: string;
    /** scope types it runs in; empty = global (the "Game & world" menu) */
    scopes: ScopeType[] | 'any';
    script: string;
    short?: string;
    /** asked in this order */
    params: ParamDef[];
    /**
     * parameters the template has in `[…]` groups that are not asked when building, only when changing a written
     * statement that has them (`add_opinion = { … years = 5 }`) — each with its `optional` label
     */
    extra?: ParamDef[];
    /** mnemonic */
    k?: string;
    /** extra words for the search (`/`) */
    words?: string;
    /** only built by a continuation ("Later…"), not listed */
    hidden?: boolean;
    /** `exists = <subject>`: written outside the subject's scope switch */
    subjectValue?: boolean;
    /** what it does, when the label can't say it (shown while the row is highlighted) */
    help?: string;
}

export const EFFECT_GROUPS: { id: string; label: string; k: string; help?: string; }[] = [
    {
        id: 'pregnancy',
        label: 'Pregnancy…',
        k: 'p',
        help: 'Make them pregnant (for sure), let them sleep with someone (pregnant by chance), mark the coming child a known bastard, end a pregnancy.'
    },
    { id: 'add', label: 'Add…', k: 'a' },
    { id: 'remove', label: 'Remove…', k: 'r' },
    { id: 'set', label: 'Set / change…', k: 's' },
    { id: 'do', label: 'Do…', k: 'd' }
];

export const TRIGGER_GROUPS: { id: string; label: string; k?: string; }[] = [
    { id: 'main', label: '' },
    { id: 'resources', label: 'Prestige, piety, stress…', k: 'p' },
    { id: 'family', label: 'Family & relations…', k: 'y' },
    { id: 'realm', label: 'Titles & realm…', k: 'z' },
    { id: 'marks', label: 'Flags, modifiers & variables…', k: 'v' },
    { id: 'more', label: 'More…', k: 'x' }
];

export const COMPARE_OPTIONS: { op: string; label: string; k: string; }[] = [
    { op: '<', label: 'Under', k: 'u' },
    { op: '>', label: 'Over', k: 'o' },
    { op: '>=', label: 'At least', k: 'l' },
    { op: '<=', label: 'At most', k: 'm' },
    { op: '=', label: 'Exactly', k: 'e' }
];

// parameter helpers
const num = (name: string, label: string, presets: number[], extra: Partial<NumberParam> = {}): NumberParam => ({ name, kind: 'number', label, presets, ...extra });
const cmp = (): CompareParam => ({ name: 'cmp', kind: 'compare', label: 'Compared how?' });
const who = (name: string, label: string, extra: Partial<ScopeParam> = {}): ScopeParam => ({ name, kind: 'scope', label, to: 'character', common: ['root', 'scope:actor', 'scope:recipient', 'liege', 'primary_spouse'], ...extra });
const ref = (name: string, label: string, type: string, extra: Partial<RefParam> = {}): RefParam => ({ name, kind: 'ref', label, type, ...extra });
const choice = (name: string, label: string, options: [string, string, string?][]): ChoiceParam => ({ name, kind: 'choice', label, options: options.map(([value, l, k]) => ({ value, label: l, k })) });
const dur = (label = 'For how long?', none = 'Forever'): DurationParam => ({
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
const flagName = (label = 'Which flag?'): NameParam => ({ name: 'flag', kind: 'name', label, type: 'flag' });
const varName = (label = 'Which variable?'): NameParam => ({ name: 'name', kind: 'name', label, type: 'variable' });

const faithRef = (): RefParam =>
    ref('faith', 'Which faith?', 'faith', {
        prefix: 'faith:',
        scopes: [
            { value: 'root.faith', label: 'Root’s faith' },
            { value: 'liege.faith', label: 'Liege’s faith' },
            { value: 'scope:actor.faith', label: 'Actor’s faith' }
        ]
    });
const cultureRef = (): RefParam =>
    ref('culture', 'Which culture?', 'culture/cultures', {
        prefix: 'culture:',
        scopes: [
            { value: 'root.culture', label: 'Root’s culture' },
            { value: 'liege.culture', label: 'Liege’s culture' },
            { value: 'scope:actor.culture', label: 'Actor’s culture' }
        ]
    });
const titleRef = (label = 'Which title?'): RefParam =>
    ref('title', label, 'landed_titles', {
        prefix: 'title:',
        scopes: [
            { value: 'root.primary_title', label: 'Root’s primary title' },
            { value: 'liege.primary_title', label: 'Liege’s primary title' },
            { value: 'scope:target', label: 'Target (scope:target)' }
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
    ['best_friend', 'Best friend', 'b'],
    ['nemesis', 'Nemesis', 'n'],
    ['soulmate', 'Soulmate', 's'],
    ['potential_friend', 'Potential friend'],
    ['potential_rival', 'Potential rival'],
    ['potential_lover', 'Potential lover'],
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
        E(`add.${key}`, 'add', label, scopes, `${key} = $value$`, [num('value', 'How much?', presets, { named: gain, signed: true })], { k }),
        E(`remove.${key}`, 'remove', label, scopes, `${removeKey ?? key} = $value$`, [num('value', 'How much?', presets, removeKey ? { named: loss } : { named: loss, sign: -1 })], { k })
    ];
}

const levels = (what: string, dir: 'gain' | 'loss', sizes = ['minor', 'medium', 'major']): string[] => sizes.map((s) => `${s}_${what}_${dir}`);

const CH: ScopeType[] = ['character'];

export const STATEMENTS: StatementDef[] = [
    // ------------------------------------------------------------------ effects on characters
    // (without `opinion` the modifier's own value; `years` overrides its duration — asked when changing one that has it)
    E('add.opinion', 'add', 'Opinion', CH, 'add_opinion = { target = $target$ modifier = $modifier$ [opinion = $value$] [$duration$] }', [
        num('value', 'How much?', [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, -10, -20, -30, -50], { signed: true, optional: 'As the opinion says' }),
        who('target', 'Towards whom?', { common: ['root', 'scope:actor', 'scope:recipient', 'liege', 'primary_spouse', 'prev'] }),
        ref('modifier', 'Which opinion?', 'opinion_modifiers')
    ], { k: 'o', words: 'add_opinion', extra: [dur('For how long?', 'As the opinion says')] }),
    E('add.reverse_opinion', 'add', 'Opinion of them (someone’s)', CH, 'reverse_add_opinion = { target = $target$ modifier = $modifier$ [opinion = $value$] [$duration$] }', [
        num('value', 'How much?', [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, -10, -20, -30, -50], { signed: true, optional: 'As the opinion says' }),
        who('target', 'Whose opinion?'),
        ref('modifier', 'Which opinion?', 'opinion_modifiers')
    ], { words: 'reverse_add_opinion', extra: [dur('For how long?', 'As the opinion says')] }),
    E('add.trait', 'add', 'Trait', CH, 'add_trait = $trait$', [ref('trait', 'Which trait?', 'traits')], { k: 't', words: 'add_trait' }),
    E('add.trait_xp', 'add', 'Trait experience', CH, 'add_trait_xp = { trait = $trait$ value = $value$ }', [ref('trait', 'Which trait?', 'traits'), num('value', 'How much?', [5, 10, 20, 25, 50, 100])], { words: 'add_trait_xp' }),
    ...resource('add_gold', 'Gold', CH, [10, 25, 50, 100, 250, 500, 1000], ['tiny_gold_value', 'minor_gold_value', 'medium_gold_value', 'major_gold_value'], ['tiny_gold_value', 'minor_gold_value', 'medium_gold_value', 'major_gold_value'], 'g', 'remove_short_term_gold'),
    ...resource('add_prestige', 'Prestige', CH, [25, 50, 100, 150, 200, 300, 500, 1000], levels('prestige', 'gain'), levels('prestige', 'loss'), 'p'),
    ...resource('add_piety', 'Piety', CH, [25, 50, 100, 150, 200, 300, 500, 1000], levels('piety', 'gain'), levels('piety', 'loss'), 'i'),
    ...resource('add_stress', 'Stress', CH, [5, 10, 15, 20, 25, 50, 100], levels('stress', 'gain'), levels('stress', 'loss'), 's'),
    ...resource('add_dread', 'Dread', CH, [5, 10, 15, 20, 25, 50], levels('dread', 'gain'), levels('dread', 'loss'), 'd'),
    ...resource('add_tyranny', 'Tyranny', CH, [5, 10, 15, 20, 25, 50], levels('tyranny', 'gain')),
    ...resource('change_influence', 'Influence', CH, [25, 50, 100, 200, 500], levels('influence', 'gain'), levels('influence', 'loss')),
    ...resource('add_legitimacy', 'Legitimacy', CH, [5, 10, 25, 50, 100], levels('legitimacy', 'gain'), levels('legitimacy', 'loss')),
    E('add.skill', 'add', 'Skill…', CH, 'add_$skill$_skill = $value$', [choice('skill', 'Which skill?', SKILLS), num('value', 'How much?', [1, 2, 3, 5, 10], { signed: true })], { k: 'k', words: 'add_diplomacy_skill add_martial_skill add_prowess_skill' }),
    E('remove.skill', 'remove', 'Skill…', CH, 'add_$skill$_skill = $value$', [choice('skill', 'Which skill?', SKILLS), num('value', 'How much?', [1, 2, 3, 5, 10], { sign: -1 })], { k: 'k' }),
    E('add.lifestyle_xp', 'add', 'Lifestyle experience…', CH, 'add_$lifestyle$_lifestyle_xp = $value$', [
        choice('lifestyle', 'Which lifestyle?', [...SKILLS.slice(0, 5), ['wanderer', 'Wanderer', 'w']]),
        num('value', 'How much?', [100, 250, 500, 1000], { named: ['minor_lifestyle_xp', 'medium_lifestyle_xp', 'major_lifestyle_xp'] })
    ], { k: 'x', words: 'lifestyle_xp' }),
    E('add.modifier', 'add', 'Modifier', CH, 'add_character_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', 'Which modifier?', 'modifiers'), dur()], { k: 'm', words: 'add_character_modifier' }),
    E('add.flag', 'add', 'Flag', CH, 'add_character_flag = { flag = $flag$ [$duration$] }', [flagName(), dur()], { k: 'f', short: 'add_character_flag = $flag$', words: 'add_character_flag' }),
    E('add.hook', 'add', 'Hook', CH, 'add_hook = { type = $type$ target = $target$ }', [who('target', 'On whom?'), ref('type', 'Which hook?', 'hook_types')], { k: 'h', words: 'add_hook' }),
    E('add.secret', 'add', 'Secret', CH, 'add_secret = { type = $type$ [target = $target$] }', [ref('type', 'Which secret?', 'secret_types'), who('target', 'About whom?', { optional: 'Nobody in particular' })], { words: 'add_secret' }),
    E('add.courtier', 'add', 'Courtier', CH, 'add_courtier = $who$', [who('who', 'Who joins the court?', { common: ['scope:actor', 'scope:recipient', 'prev', 'root'] })], { k: 'c', words: 'add_courtier' }),
    E('add.pressed_claim', 'add', 'Claim (pressed)', CH, 'add_pressed_claim = $title$', [titleRef('On which title?')], { words: 'add_pressed_claim' }),
    E('add.unpressed_claim', 'add', 'Claim (unpressed)', CH, 'add_unpressed_claim = $title$', [titleRef('On which title?')], { words: 'add_unpressed_claim' }),
    E('add.nickname', 'add', 'Nickname', CH, 'give_nickname = $nick$', [ref('nick', 'Which nickname?', 'nicknames')], { k: 'n', words: 'give_nickname' }),
    E('add.perk', 'add', 'Perk', CH, 'add_perk = $perk$', [ref('perk', 'Which perk?', 'lifestyle_perks')], { words: 'add_perk' }),
    E('add.law', 'add', 'Realm law', CH, 'add_realm_law = $law$', [ref('law', 'Which law?', 'laws')], { words: 'add_realm_law' }),
    E('add.stress_if_trait', 'add', 'Stress if they have a trait', CH, 'stress_impact = { $trait$ = $value$ }', [
        ref('trait', 'Which trait?', 'traits'),
        num('value', 'How much stress?', [10, 20, 30, 50, -10, -20], { named: ['minor_stress_impact_gain', 'medium_stress_impact_gain', 'major_stress_impact_gain', 'minor_stress_impact_loss', 'medium_stress_impact_loss'] })
    ], { words: 'stress_impact' }),

    E('remove.trait', 'remove', 'Trait', CH, 'remove_trait = $trait$', [ref('trait', 'Which trait?', 'traits')], { k: 't', words: 'remove_trait' }),
    E('remove.opinion', 'remove', 'Opinion', CH, 'remove_opinion = { target = $target$ modifier = $modifier$ }', [who('target', 'Towards whom?'), ref('modifier', 'Which opinion?', 'opinion_modifiers')], { k: 'o', words: 'remove_opinion' }),
    E('remove.modifier', 'remove', 'Modifier', CH, 'remove_character_modifier = $modifier$', [ref('modifier', 'Which modifier?', 'modifiers')], { k: 'm', words: 'remove_character_modifier' }),
    E('remove.flag', 'remove', 'Flag', CH, 'remove_character_flag = $flag$', [flagName()], { k: 'f', words: 'remove_character_flag' }),
    E('remove.hook', 'remove', 'Hook', CH, 'remove_hook = { target = $target$ }', [who('target', 'On whom?')], { k: 'h', words: 'remove_hook' }),
    E('remove.claim', 'remove', 'Claim', CH, 'remove_claim = $title$', [titleRef('On which title?')], { words: 'remove_claim' }),
    E('remove.nickname', 'remove', 'Nickname', CH, 'remove_nickname = yes', [], { k: 'n', words: 'remove_nickname' }),
    E('remove.relation', 'remove', 'Relation…', CH, 'remove_relation_$relation$ = $target$', [choice('relation', 'Which relation?', RELATIONS), who('target', 'With whom?')], { k: 'l', words: 'remove_relation' }),

    E('set.relation', 'set', 'Relation…', CH, 'set_relation_$relation$ = { target = $target$ [reason = $reason$] }', [
        choice('relation', 'Which relation?', RELATIONS),
        who('target', 'With whom?'),
        // (a text key the relation's tooltip shows: "friend_moved_estate" — the game's for this relation are suggested)
        { name: 'reason', kind: 'text', label: 'Why? (the reason its tooltip gives)', optional: 'No reason given', usage: { field: 'reason' } }
    ], { k: 'r', short: 'set_relation_$relation$ = $target$', words: 'set_relation friend rival lover reason' }),
    E('set.faith', 'set', 'Faith', CH, 'set_character_faith = $faith$', [faithRef()], { k: 'f', words: 'set_character_faith convert' }),
    E('set.culture', 'set', 'Culture', CH, 'set_culture = $culture$', [cultureRef()], { k: 'c', words: 'set_culture' }),
    E('set.sexuality', 'set', 'Sexuality', CH, 'set_sexuality = $s$', [choice('s', 'Which sexuality?', [['heterosexual', 'Heterosexual', 'h'], ['homosexual', 'Homosexual', 'o'], ['bisexual', 'Bisexual', 'b'], ['asexual', 'Asexual', 'a']])], { words: 'set_sexuality' }),
    E('set.focus', 'set', 'Focus', CH, 'set_focus = $focus$', [ref('focus', 'Which focus?', 'focuses')], { words: 'set_focus' }),
    E('set.designated_heir', 'set', 'Designated heir', CH, 'set_designated_heir = $who$', [who('who', 'Who?')], { k: 'h', words: 'set_designated_heir' }),
    E('set.employer', 'set', 'Employer (move to a court)', CH, 'set_employer = $who$', [who('who', 'Whose court?', { common: ['root', 'scope:actor', 'liege', 'scope:recipient'] })], { k: 'e', words: 'set_employer' }),
    E('set.government', 'set', 'Government', CH, 'change_government = $gov$', [ref('gov', 'Which government?', 'governments')], { k: 'g', words: 'change_government' }),

    E('do.death', 'do', 'Die', CH, 'death = { death_reason = $reason$ [killer = $killer$] }', [ref('reason', 'How?', 'deathreasons'), who('killer', 'Killed by?', { optional: 'Nobody' })], { k: 'd', words: 'death kill' }),
    E('do.imprison', 'do', 'Imprison someone', CH, 'imprison = { target = $target$ type = $type$ }', [who('target', 'Whom?', { common: ['scope:recipient', 'scope:target', 'scope:actor', 'root'] }), choice('type', 'Where?', [['dungeon', 'Dungeon', 'd'], ['house_arrest', 'House arrest', 'h']])], {
        k: 'i',
        words: 'imprison prison'
    }),
    E('do.release', 'do', 'Release from prison', CH, 'release_from_prison = yes', [], { k: 'r', words: 'release_from_prison' }),
    E('do.marry', 'do', 'Marry', CH, 'marry = $who$', [who('who', 'Whom?', { common: ['scope:recipient', 'scope:actor', 'scope:target', 'root'] })], { k: 'm', words: 'marry' }),
    // pregnancy: run on the mother (docs/picker.md, "Pregnancy")
    E(
        'preg.make',
        'pregnancy',
        'Pregnant — for sure',
        CH,
        'make_pregnant = { father = $father$ [number_of_children = $children$] }',
        [who('father', 'Who is the father?', { common: ['root', 'scope:actor', 'scope:recipient', 'primary_spouse'] }), num('children', 'How many children?', [2, 3], { optional: 'One' })],
        {
            k: 'p',
            words: 'make_pregnant pregnant pregnancy twins father child',
            help: 'make_pregnant: she is pregnant now, by the father given — no chance involved, nothing else happens (no stress, no adultery or lover consequences). Twins and more with “How many children”. Run it on the mother.'
        }
    ),
    E(
        'preg.sex',
        'pregnancy',
        'Sleep with someone — pregnant by chance',
        CH,
        'had_sex_with_effect = { CHARACTER = $who$ PREGNANCY_CHANCE = $chance$ }',
        [
            who('who', 'With whom?', { common: ['root', 'scope:actor', 'scope:recipient', 'primary_spouse'] }),
            choice('chance', 'How likely is a pregnancy?', [
                ['pregnancy_chance', 'The usual chance (fertility, age, traits)', 'u'],
                ['seduce_pregnancy_chance', 'A seduction’s chance', 's'],
                ['50', 'Half the time (50%)', 'h'],
                ['100', 'Surely (100%)', 'c']
            ])
        ],
        {
            k: 's',
            words: 'had_sex_with_effect sex pregnant pregnancy lover',
            help: 'had_sex_with_effect: the game’s way — they sleep together with all it brings: stress loss for the lustful, the adultery and lover bookkeeping, and a pregnancy only by chance (when she can have his child). Use it for a love scene; use “Pregnant — for sure” when the story needs the child.'
        }
    ),
    E('preg.bastard', 'pregnancy', 'The coming child: a known bastard', CH, 'set_known_bastard_on_pregnancy = yes', [], {
        k: 'b',
        words: 'set_known_bastard_on_pregnancy bastard pregnancy',
        help: 'set_known_bastard_on_pregnancy: her current pregnancy’s child will be born a known bastard (everyone knows who the real father is). Only for a pregnancy that exists already.'
    }),
    E('preg.end', 'pregnancy', 'End the pregnancy', CH, 'end_pregnancy = yes', [], {
        k: 'e',
        words: 'end_pregnancy miscarriage abortion pregnancy',
        help: 'end_pregnancy: her pregnancy ends without a birth (a miscarriage or an abortion — the events around it say which).'
    }),
    E('do.divorce', 'do', 'Divorce', CH, 'divorce = $who$', [who('who', 'Whom?', { common: ['primary_spouse', 'scope:recipient', 'scope:actor'] })], { words: 'divorce' }),
    E('do.scheme', 'do', 'Start a scheme', CH, 'start_scheme = { type = $type$ target_character = $target$ }', [ref('type', 'Which scheme?', 'schemes/scheme_types'), who('target', 'Against whom?', { common: ['root', 'scope:target', 'scope:recipient', 'scope:actor'] })], { k: 's', words: 'start_scheme' }),
    E('do.event', 'do', 'Trigger an event', 'any', 'trigger_event = { id = $event$ [$delay$] }', [ref('event', 'Which event?', 'events'), { ...dur('When?', 'Right away'), name: 'delay', presets: [[1, 'days'], [3, 'days'], [7, 'days'], [14, 'days'], [30, 'days'], [3, 'months'], [6, 'months'], [1, 'years']] }], {
        k: 'e',
        short: 'trigger_event = $event$',
        words: 'trigger_event'
    }),
    E('later', 'do', 'Event later', 'any', 'trigger_event = { id = $event$ $delay$ }', [ref('event', 'Which event?', 'events'), {
        ...dur('When?'),
        optional: undefined,
        name: 'delay',
        presets: [[1, 'days'], [3, 'days'], [7, 'days'], [14, 'days'], [30, 'days'], [3, 'months'], [6, 'months'], [1, 'years'], [5, 'years']]
    }], { hidden: true }),
    E('do.pay', 'do', 'Pay gold to someone', CH, 'pay_short_term_gold = { target = $target$ gold = $value$ }', [num('value', 'How much?', [10, 25, 50, 100, 250, 500], { named: ['minor_gold_value', 'medium_gold_value', 'major_gold_value'] }), who('target', 'To whom?')], { k: 'p', words: 'pay_short_term_gold' }),
    E('do.get_title', 'do', 'Get a title', CH, 'get_title = $title$', [titleRef()], { k: 'g', words: 'get_title' }),
    E('do.pool', 'do', 'Move to the pool', CH, 'move_to_pool = yes', [], { words: 'move_to_pool' }),
    E('do.save_scope', 'do', 'Save as a scope (for later)', 'any', 'save_scope_as = $name$', [{ name: 'name', kind: 'text', label: 'Saved as?', usage: true }], { words: 'save_scope_as' }),
    E('do.visit', 'do', 'Visit a court', CH, 'visit_court_of = $who$', [who('who', 'Whose court?')], { k: 'v', words: 'visit_court_of' }),

    // ------------------------------------------------------------------ variables (every scope)
    E('set.variable', 'set', 'Variable', 'any', 'set_variable = { name = $name$ value = $value$ }', [varName(), num('value', 'Which value?', [1, 0, 5, 10, 100], { named: ['yes'] })], { k: 'v', words: 'set_variable' }),
    E('add.variable', 'add', 'Variable (change)', 'any', 'change_variable = { name = $name$ add = $value$ }', [varName(), num('value', 'How much?', [1, 2, 5, 10, -1], { signed: true })], { k: 'v', words: 'change_variable' }),
    E('remove.variable', 'remove', 'Variable', 'any', 'remove_variable = $name$', [varName()], { k: 'v', words: 'remove_variable' }),

    // ------------------------------------------------------------------ effects on titles, provinces, faiths, cultures, dynasties, houses, artifacts, wars
    E('title.holder', 'set', 'Holder', ['landed_title'], 'change_title_holder = { holder = $holder$ }', [who('holder', 'Who gets it?', { common: ['root', 'scope:actor', 'scope:recipient', 'scope:target'] })], { k: 'h', words: 'change_title_holder give title' }),
    E('title.de_jure', 'set', 'De jure liege title', ['landed_title'], 'set_de_jure_liege_title = $title$', [titleRef('Under which title?')], { k: 'd', words: 'set_de_jure_liege_title' }),
    E('title.add_modifier', 'add', 'County modifier', ['landed_title'], 'add_county_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', 'Which modifier?', 'modifiers'), dur()], { k: 'm', words: 'add_county_modifier' }),
    E('title.remove_modifier', 'remove', 'County modifier', ['landed_title'], 'remove_county_modifier = $modifier$', [ref('modifier', 'Which modifier?', 'modifiers')], { k: 'm', words: 'remove_county_modifier' }),
    ...resource('change_development_level', 'Development', ['landed_title'], [1, 2, 3, 5, 10]),
    ...resource('change_county_control', 'County control', ['landed_title'], [5, 10, 20, 25, 50, 100], ['medium_county_control_gain'], ['minor_county_control_loss', 'medium_county_control_loss']),
    E('title.faith', 'set', 'Faith (county)', ['landed_title'], 'set_county_faith = $faith$', [faithRef()], { k: 'f', words: 'set_county_faith' }),
    E('title.culture', 'set', 'Culture (county)', ['landed_title'], 'set_county_culture = $culture$', [cultureRef()], { k: 'c', words: 'set_county_culture' }),
    E('title.law', 'add', 'Title law', ['landed_title'], 'add_title_law = $law$', [ref('law', 'Which law?', 'laws')], { k: 'l', words: 'add_title_law' }),

    E('province.add_modifier', 'add', 'Province modifier', ['province'], 'add_province_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', 'Which modifier?', 'modifiers'), dur()], { k: 'm', words: 'add_province_modifier' }),
    E('province.remove_modifier', 'remove', 'Province modifier', ['province'], 'remove_province_modifier = $modifier$', [ref('modifier', 'Which modifier?', 'modifiers')], { k: 'm', words: 'remove_province_modifier' }),
    E('province.add_building', 'add', 'Building', ['province'], 'add_building = $building$', [ref('building', 'Which building?', 'buildings')], { k: 'b', words: 'add_building' }),
    E('province.remove_building', 'remove', 'Building', ['province'], 'remove_building = $building$', [ref('building', 'Which building?', 'buildings')], { k: 'b', words: 'remove_building' }),
    E('province.holding', 'set', 'Holding type', ['province'], 'set_holding_type = $holding$', [ref('holding', 'Which holding type?', 'holdings')], { k: 'h', words: 'set_holding_type' }),

    E('faith.add_doctrine', 'add', 'Doctrine', ['faith'], 'add_doctrine = $doctrine$', [ref('doctrine', 'Which doctrine?', 'religion/doctrine_types')], { k: 'd', words: 'add_doctrine' }),
    E('faith.remove_doctrine', 'remove', 'Doctrine', ['faith'], 'remove_doctrine = $doctrine$', [ref('doctrine', 'Which doctrine?', 'religion/doctrine_types')], { k: 'd', words: 'remove_doctrine' }),
    E('culture.tradition', 'add', 'Tradition', ['culture'], 'add_culture_tradition = $tradition$', [ref('tradition', 'Which tradition?', 'culture/traditions')], { k: 't', words: 'add_culture_tradition' }),
    E('culture.innovation', 'add', 'Innovation', ['culture'], 'add_innovation = $innovation$', [ref('innovation', 'Which innovation?', 'culture/innovations')], { k: 'i', words: 'add_innovation' }),
    ...resource('add_dynasty_prestige', 'Dynasty prestige', ['dynasty'], [50, 100, 200, 500, 1000], levels('dynasty_prestige', 'gain', ['miniscule', 'minor', 'medium'])),
    E('dynasty.modifier', 'add', 'Dynasty modifier', ['dynasty'], 'add_dynasty_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', 'Which modifier?', 'modifiers'), dur()], { k: 'm', words: 'add_dynasty_modifier' }),
    E('dynasty.perk', 'add', 'Legacy (dynasty perk)', ['dynasty'], 'add_dynasty_perk = $perk$', [ref('perk', 'Which legacy?', 'dynasty_perks')], { k: 'l', words: 'add_dynasty_perk' }),
    E('house.modifier', 'add', 'House modifier', ['dynasty_house'], 'add_house_modifier = { modifier = $modifier$ [$duration$] }', [ref('modifier', 'Which modifier?', 'modifiers'), dur()], { k: 'm', words: 'add_house_modifier' }),
    ...resource('add_durability', 'Durability', ['artifact'], [5, 10, 20, 50]),
    E('artifact.owner', 'set', 'Owner', ['artifact'], 'set_owner = $who$', [who('who', 'Who owns it?')], { k: 'o', words: 'set_owner' }),
    E('artifact.rarity', 'set', 'Rarity', ['artifact'], 'set_artifact_rarity = $rarity$', [choice('rarity', 'Which rarity?', [['common', 'Common', 'c'], ['masterwork', 'Masterwork', 'm'], ['famed', 'Famed', 'f'], ['illustrious', 'Illustrious', 'i']])], { k: 'r', words: 'set_artifact_rarity' }),
    E('artifact.destroy', 'do', 'Destroy it', ['artifact'], 'destroy_artifact = this', [], { k: 'd', words: 'destroy_artifact' }),
    E('scheme.end', 'do', 'End the scheme', ['scheme'], 'end_scheme = yes', [], { k: 'e', words: 'end_scheme' }),
    E('secret.reveal', 'do', 'Reveal to someone', ['secret'], 'reveal_to = $who$', [who('who', 'To whom?')], { k: 'r', words: 'reveal_to' }),
    E('secret.expose', 'do', 'Expose it', ['secret'], 'expose_secret = $who$', [who('who', 'Exposed by?')], { k: 'e', words: 'expose_secret' }),
    E('secret.remove', 'do', 'Remove it', ['secret'], 'remove_secret = yes', [], { k: 'd', words: 'remove_secret' }),
    E('artifact.modifier', 'add', 'Artifact modifier', ['artifact'], 'add_artifact_modifier = $modifier$', [ref('modifier', 'Which modifier?', 'modifiers')], { k: 'm', words: 'add_artifact_modifier' }),
    E('war.end', 'do', 'End the war', ['war'], 'end_war = $how$', [choice('how', 'How?', [['white_peace', 'White peace', 'w'], ['attacker', 'Attacker wins', 'a'], ['defender', 'Defender wins', 'd'], ['invalidated', 'Invalidated', 'i']])], { k: 'e', words: 'end_war' }),

    // ------------------------------------------------------------------ global effects ("Game & world")
    E('global.set_variable', 'set', 'Global variable', [], 'set_global_variable = { name = $name$ value = $value$ }', [varName(), num('value', 'Which value?', [1, 0, 5, 10], { named: ['yes'] })], { k: 'v', words: 'set_global_variable' }),
    E('global.remove_variable', 'remove', 'Global variable', [], 'remove_global_variable = $name$', [varName()], { k: 'v', words: 'remove_global_variable' }),

    // ------------------------------------------------------------------ triggers on characters
    T('age', 'main', 'Age', CH, 'age $cmp$ $value$', [cmp(), num('value', 'Which age?', [6, 12, 16, 18, 20, 25, 30, 40, 50, 60, 70], { unit: 'years' })], { k: 'a' }),
    T('trait', 'main', 'Trait (has)', CH, 'has_trait = $trait$', [ref('trait', 'Which trait?', 'traits')], { k: 't', words: 'has_trait' }),
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
    T('at_war', 'main', 'At war', CH, 'is_at_war = yes', [], { k: 'w', words: 'is_at_war' }),
    T('opinion', 'main', 'Opinion of…', CH, 'opinion = { target = $target$ value $cmp$ $value$ }', [who('target', 'Opinion of whom?'), cmp(), num('value', 'Which opinion?', [-50, -25, 0, 10, 20, 25, 50, 75], { signed: true })], { k: 'o', words: 'opinion' }),
    T('faith', 'main', 'Faith', ['character', 'landed_title', 'province'], 'faith = $faith$', [faithRef()], { k: 'f', words: 'faith religion' }),
    T('religion', 'more', 'Religion', ['character', 'faith'], 'religion = $religion$', [ref('religion', 'Which religion?', 'religion/religion_types', { prefix: 'religion:' })], { words: 'religion' }),
    T('culture', 'main', 'Culture', ['character', 'landed_title', 'province'], 'culture = $culture$', [cultureRef()], { k: 'u', words: 'culture' }),
    T('gold', 'main', 'Gold', CH, 'gold $cmp$ $value$', [cmp(), num('value', 'How much?', [0, 50, 100, 250, 500, 1000], { named: ['minor_gold_value', 'medium_gold_value', 'major_gold_value'] })], { k: 'g' }),
    T('prestige', 'resources', 'Prestige', CH, 'prestige $cmp$ $value$', [cmp(), num('value', 'How much?', [0, 100, 250, 500, 1000], { named: ['minor_prestige_value', 'medium_prestige_value', 'major_prestige_value'] })]),
    T('piety', 'resources', 'Piety', CH, 'piety $cmp$ $value$', [cmp(), num('value', 'How much?', [0, 100, 250, 500, 1000], { named: ['minor_piety_value', 'medium_piety_value', 'major_piety_value'] })]),
    T('stress', 'resources', 'Stress', CH, 'stress $cmp$ $value$', [cmp(), num('value', 'How much?', [0, 25, 50, 100, 150, 200])], { k: 's' }),
    T('dread', 'resources', 'Dread', CH, 'dread $cmp$ $value$', [cmp(), num('value', 'How much?', [0, 25, 50, 75, 100])]),
    T('skill', 'main', 'Skill…', CH, '$skill$ $cmp$ $value$', [choice('skill', 'Which skill?', SKILLS), cmp(), num('value', 'Which level?', [5, 8, 10, 12, 15, 20], { named: ['mediocre_skill_rating', 'decent_skill_rating', 'high_skill_rating', 'very_high_skill_rating'] })], {
        k: 'k',
        words: 'diplomacy martial stewardship intrigue learning prowess'
    }),
    T('exists', 'main', 'Exists', 'any', 'exists = $subject$', [], { k: 's', subjectValue: true, words: 'exists' }),

    T('relation', 'family', 'Relation (friend, rival, lover…)', CH, 'has_relation_$relation$ = $target$', [choice('relation', 'Which relation?', RELATIONS), who('target', 'With whom?')], { k: 'r', words: 'has_relation friend rival lover' }),
    T('child_of', 'family', 'Child of…', CH, 'is_child_of = $who$', [who('who', 'Whose child?')], { k: 'c', words: 'is_child_of' }),
    T('parent_of', 'family', 'Parent of…', CH, 'is_parent_of = $who$', [who('who', 'Whose parent?')], { k: 'p', words: 'is_parent_of' }),
    T('spouse_of', 'family', 'Spouse of…', CH, 'is_spouse_of = $who$', [who('who', 'Whose spouse?')], { k: 's', words: 'is_spouse_of' }),
    T('sibling_of', 'family', 'Sibling of…', CH, 'is_sibling_of = $who$', [who('who', 'Whose sibling?')], { k: 'b', words: 'is_sibling_of' }),
    T('close_family_of', 'family', 'Close family of…', CH, 'is_close_family_of = $who$', [who('who', 'Whose close family?')], { k: 'f', words: 'is_close_family_of' }),
    T('consort_of', 'family', 'Consort of…', CH, 'is_consort_of = $who$', [who('who', 'Whose consort?')], { words: 'is_consort_of' }),
    T('vassal_of', 'family', 'Vassal of…', CH, 'is_vassal_of = $who$', [who('who', 'Whose vassal?')], { k: 'v', words: 'is_vassal_of' }),
    T('courtier_of', 'family', 'Courtier of…', CH, 'is_courtier_of = $who$', [who('who', 'Whose courtier?')], { k: 'o', words: 'is_courtier_of' }),
    T('knight_of', 'family', 'Knight of…', CH, 'is_knight_of = $who$', [who('who', 'Whose knight?')], { k: 'k', words: 'is_knight_of' }),
    T('allied_to', 'family', 'Allied to…', CH, 'is_allied_to = $who$', [who('who', 'Allied to whom?')], { k: 'a', words: 'is_allied_to' }),
    T('at_war_with', 'family', 'At war with…', CH, 'is_at_war_with = $who$', [who('who', 'At war with whom?')], { k: 'w', words: 'is_at_war_with' }),
    T('same', 'family', 'Is someone (the same person)', CH, 'this = $who$', [who('who', 'Who?', { common: ['root', 'scope:actor', 'scope:recipient', 'liege', 'prev'] })], { k: 'i', words: 'this =' }),
    T('house_head', 'family', 'House head', CH, 'is_house_head = yes', [], { k: 'h', words: 'is_house_head' }),
    T('lowborn', 'family', 'Lowborn', CH, 'is_lowborn = yes', [], { k: 'l', words: 'is_lowborn' }),

    T('tier', 'realm', 'Highest title tier', CH, 'highest_held_title_tier $cmp$ $tier$', [cmp(), choice('tier', 'Which tier?', TIERS)], { k: 't', words: 'highest_held_title_tier' }),
    T('has_title', 'realm', 'Holds a title', CH, 'has_title = $title$', [titleRef()], { k: 'h', words: 'has_title' }),
    T('government_flag', 'realm', 'Government flag (nomadic, tribal…)', CH, 'government_has_flag = $flag$', [{ name: 'flag', kind: 'text', label: 'Which government flag?', usage: true }], { k: 'f', words: 'government_has_flag nomadic tribal feudal clan' }),
    T('employs_position', 'realm', 'Employs a court position', CH, 'employs_court_position = $pos$', [ref('pos', 'Which position?', 'court_positions/types')], { k: 'e', words: 'employs_court_position' }),
    T('independent', 'realm', 'Independent ruler', CH, 'is_independent_ruler = yes', [], { k: 'i', words: 'is_independent_ruler' }),
    T('government', 'realm', 'Government', CH, 'has_government = $gov$', [ref('gov', 'Which government?', 'governments')], { k: 'g', words: 'has_government' }),
    T('realm_law', 'realm', 'Realm law', CH, 'has_realm_law = $law$', [ref('law', 'Which law?', 'laws')], { k: 'l', words: 'has_realm_law' }),
    T('claim', 'realm', 'Claim on…', CH, 'has_claim_on = $title$', [titleRef('On which title?')], { k: 'c', words: 'has_claim_on' }),
    T('court_position', 'realm', 'Court position', CH, 'has_court_position = $pos$', [ref('pos', 'Which position?', 'court_positions/types')], { k: 'p', words: 'has_court_position' }),
    T('council_position', 'realm', 'Council position', CH, 'has_council_position = $pos$', [ref('pos', 'Which position?', 'council_positions')], { k: 'o', words: 'has_council_position' }),
    T('royal_court', 'realm', 'Has a royal court', CH, 'has_royal_court = yes', [], { k: 'r', words: 'has_royal_court' }),
    T('prestige_level', 'resources', 'Prestige level', CH, 'prestige_level $cmp$ $value$', [cmp(), num('value', 'Which level?', [0, 1, 2, 3, 4, 5])]),
    T('piety_level', 'resources', 'Piety level', CH, 'piety_level $cmp$ $value$', [cmp(), num('value', 'Which level?', [0, 1, 2, 3, 4, 5])]),

    T('flag', 'marks', 'Flag', CH, 'has_character_flag = $flag$', [flagName()], { k: 'f', words: 'has_character_flag' }),
    T('modifier', 'marks', 'Modifier', CH, 'has_character_modifier = $modifier$', [ref('modifier', 'Which modifier?', 'modifiers')], { k: 'm', words: 'has_character_modifier' }),
    T('variable', 'marks', 'Variable', 'any', 'has_variable = $name$', [varName()], { k: 'v', words: 'has_variable' }),
    T('opinion_modifier', 'marks', 'Opinion modifier', CH, 'has_opinion_modifier = { target = $target$ modifier = $modifier$ }', [who('target', 'Towards whom?'), ref('modifier', 'Which opinion?', 'opinion_modifiers')], { k: 'o', words: 'has_opinion_modifier' }),
    T('hook', 'marks', 'Hook on…', CH, 'has_hook = $who$', [who('who', 'On whom?')], { k: 'h', words: 'has_hook' }),
    T('strong_hook', 'marks', 'Strong hook on…', CH, 'has_strong_hook = $who$', [who('who', 'On whom?')], { k: 's', words: 'has_strong_hook' }),

    T('perk', 'more', 'Perk', CH, 'has_perk = $perk$', [ref('perk', 'Which perk?', 'lifestyle_perks')], { k: 'p', words: 'has_perk' }),
    T('focus', 'more', 'Focus', CH, 'has_focus = $focus$', [ref('focus', 'Which focus?', 'focuses')], { k: 'f', words: 'has_focus' }),
    T('lifestyle', 'more', 'Lifestyle', CH, 'has_lifestyle = $lifestyle$', [ref('lifestyle', 'Which lifestyle?', 'lifestyles')], { k: 'l', words: 'has_lifestyle' }),
    T('trait_xp', 'more', 'Trait experience', CH, 'has_trait_xp = { trait = $trait$ value $cmp$ $value$ }', [ref('trait', 'Which trait?', 'traits'), cmp(), num('value', 'How much?', [10, 25, 50, 75, 100])], { k: 't', words: 'has_trait_xp' }),
    T('sexuality', 'more', 'Sexuality', CH, 'has_sexuality = $s$', [choice('s', 'Which sexuality?', [['heterosexual', 'Heterosexual', 'h'], ['homosexual', 'Homosexual', 'o'], ['bisexual', 'Bisexual', 'b'], ['asexual', 'Asexual', 'a']])], { k: 's', words: 'has_sexuality' }),
    T('travelling', 'more', 'Travelling', CH, 'is_travelling = yes', [], { words: 'is_travelling' }),
    T('pregnant', 'more', 'Pregnant', CH, 'is_pregnant = yes', [], { words: 'is_pregnant' }),
    T('incapable', 'more', 'Incapable', CH, 'is_incapable = yes', [], { k: 'i', words: 'is_incapable' }),
    T('health', 'more', 'Health', CH, 'health $cmp$ $value$', [cmp(), num('value', 'Which health?', [1, 2, 3, 4, 5, 6], { named: ['poor_health', 'fine_health'] })], { k: 'h' }),
    T('fertility', 'more', 'Fertility', CH, 'fertility $cmp$ $value$', [cmp(), num('value', 'Which fertility?', [0, 0.1, 0.25, 0.5, 0.75])]),

    // ------------------------------------------------------------------ triggers on titles, provinces, faiths, cultures, dynasties, houses, artifacts, wars
    T('title.tier', 'main', 'Tier', ['landed_title'], 'tier $cmp$ $tier$', [cmp(), choice('tier', 'Which tier?', TIERS)], { k: 't', words: 'tier' }),
    T('title.holder', 'main', 'Held by…', ['landed_title'], 'holder = $who$', [who('who', 'By whom?')], { k: 'h', words: 'holder' }),
    T('title.development', 'main', 'Development', ['landed_title'], 'development_level $cmp$ $value$', [cmp(), num('value', 'Which level?', [5, 10, 20, 30, 50])], { k: 'd', words: 'development_level' }),
    T('title.control', 'main', 'County control', ['landed_title'], 'county_control $cmp$ $value$', [cmp(), num('value', 'How much?', [25, 50, 75, 90, 100])], { k: 'c', words: 'county_control' }),
    T('title.modifier', 'main', 'County modifier', ['landed_title'], 'has_county_modifier = $modifier$', [ref('modifier', 'Which modifier?', 'modifiers')], { k: 'm', words: 'has_county_modifier' }),
    T('title.coastal', 'main', 'Coastal county', ['landed_title'], 'is_coastal_county = yes', [], { words: 'is_coastal_county' }),
    T('title.de_jure', 'main', 'De jure part of…', ['landed_title'], 'de_jure_liege = $title$', [titleRef('Which title?')], { k: 'j', words: 'de_jure_liege' }),
    T('title.law', 'main', 'Title law', ['landed_title'], 'has_title_law = $law$', [ref('law', 'Which law?', 'laws')], { k: 'l', words: 'has_title_law' }),

    T('province.terrain', 'main', 'Terrain', ['province'], 'terrain = $terrain$', [ref('terrain', 'Which terrain?', 'terrain_types')], { k: 't', words: 'terrain' }),
    T('province.region', 'main', 'Region', ['province', 'landed_title'], 'geographical_region = $region$', [{ name: 'region', kind: 'text', label: 'Which region?', usage: true }], { k: 'r', words: 'geographical_region' }),
    T('province.holding', 'main', 'Holding type', ['province'], 'has_holding_type = $holding$', [ref('holding', 'Which holding type?', 'holdings')], { k: 'h', words: 'has_holding_type' }),
    T('province.has_holding', 'main', 'Has a holding', ['province'], 'has_holding = yes', [], { words: 'has_holding' }),
    T('province.building', 'main', 'Building', ['province'], 'has_building_or_higher = $building$', [ref('building', 'Which building?', 'buildings')], { k: 'b', words: 'has_building_or_higher has_building' }),
    T('province.modifier', 'main', 'Province modifier', ['province'], 'has_province_modifier = $modifier$', [ref('modifier', 'Which modifier?', 'modifiers')], { k: 'm', words: 'has_province_modifier' }),
    T('province.coastal', 'main', 'Coastal', ['province'], 'is_coastal = yes', [], { k: 'c', words: 'is_coastal' }),

    T('faith.doctrine', 'main', 'Doctrine', ['faith'], 'has_doctrine = $doctrine$', [ref('doctrine', 'Which doctrine?', 'religion/doctrine_types')], { k: 'd', words: 'has_doctrine' }),
    T('faith.parameter', 'main', 'Doctrine parameter', ['faith'], 'has_doctrine_parameter = $parameter$', [{ name: 'parameter', kind: 'text', label: 'Which parameter?', usage: true }], { k: 'p', words: 'has_doctrine_parameter' }),
    T('culture.pillar', 'main', 'Pillar (heritage, language…)', ['culture'], 'has_cultural_pillar = $pillar$', [ref('pillar', 'Which pillar?', 'culture/pillars')], { k: 'p', words: 'has_cultural_pillar' }),
    T('culture.tradition', 'main', 'Tradition', ['culture'], 'has_cultural_tradition = $tradition$', [ref('tradition', 'Which tradition?', 'culture/traditions')], { k: 't', words: 'has_cultural_tradition' }),
    T('culture.innovation', 'main', 'Innovation', ['culture'], 'has_innovation = $innovation$', [ref('innovation', 'Which innovation?', 'culture/innovations')], { k: 'i', words: 'has_innovation' }),
    T('culture.parameter', 'main', 'Cultural parameter', ['culture'], 'has_cultural_parameter = $parameter$', [{ name: 'parameter', kind: 'text', label: 'Which parameter?', usage: true }], { k: 'a', words: 'has_cultural_parameter' }),
    T('culture.era', 'main', 'Era (or later)', ['culture'], 'has_cultural_era_or_later = $era$', [ref('era', 'Which era?', 'culture/eras')], { k: 'e', words: 'has_cultural_era_or_later' }),
    T('dynasty.perk', 'main', 'Legacy (dynasty perk)', ['dynasty'], 'has_dynasty_perk = $perk$', [ref('perk', 'Which legacy?', 'dynasty_perks')], { k: 'l', words: 'has_dynasty_perk' }),
    T('dynasty.modifier', 'main', 'Dynasty modifier', ['dynasty'], 'has_dynasty_modifier = $modifier$', [ref('modifier', 'Which modifier?', 'modifiers')], { k: 'm', words: 'has_dynasty_modifier' }),
    T('dynasty.prestige_level', 'main', 'Dynasty prestige level', ['dynasty'], 'dynasty_prestige_level $cmp$ $value$', [cmp(), num('value', 'Which level?', [1, 2, 3, 5, 7, 10])], { k: 'p', words: 'dynasty_prestige_level' }),
    T('house.modifier', 'main', 'House modifier', ['dynasty_house'], 'has_house_modifier = $modifier$', [ref('modifier', 'Which modifier?', 'modifiers')], { k: 'm', words: 'has_house_modifier' }),
    T('artifact.rarity', 'main', 'Rarity', ['artifact'], 'rarity = $rarity$', [choice('rarity', 'Which rarity?', [['common', 'Common', 'c'], ['masterwork', 'Masterwork', 'm'], ['famed', 'Famed', 'f'], ['illustrious', 'Illustrious', 'i']])], { k: 'r', words: 'rarity' }),
    T('artifact.type', 'main', 'Artifact type', ['artifact'], 'artifact_type = $type$', [ref('type', 'Which type?', 'artifacts/types')], { k: 't', words: 'artifact_type' }),
    T('artifact.equipped', 'main', 'Equipped', ['artifact'], 'is_equipped = yes', [], { k: 'e', words: 'is_equipped' }),
    T('war.cb', 'main', 'Casus belli', ['war'], 'using_cb = $cb$', [ref('cb', 'Which casus belli?', 'casus_belli_types')], { k: 'c', words: 'using_cb' }),
    T('war.attacker', 'main', 'Attacker is…', ['war'], 'is_attacker = $who$', [who('who', 'Who?')], { k: 'a', words: 'is_attacker' }),
    T('war.defender', 'main', 'Defender is…', ['war'], 'is_defender = $who$', [who('who', 'Who?')], { k: 'd', words: 'is_defender' }),

    // ------------------------------------------------------------------ global triggers ("Game & world")
    T('global.rule', 'main', 'Game rule', [], 'has_game_rule = $rule$', [ref('rule', 'Which game rule setting?', 'game_rule_options')], { k: 'r', words: 'has_game_rule' }),
    T('global.dlc', 'main', 'DLC feature', [], 'has_dlc_feature = $feature$', [{ name: 'feature', kind: 'text', label: 'Which DLC feature?', usage: true }], { k: 'd', words: 'has_dlc_feature' }),
    T('global.year', 'main', 'Current year', [], 'current_year $cmp$ $value$', [cmp(), num('value', 'Which year?', [867, 1000, 1066, 1100, 1178, 1200, 1300])], { k: 'y', words: 'current_year' }),
    T('global.variable', 'main', 'Global variable', [], 'has_global_variable = $name$', [varName()], { k: 'v', words: 'has_global_variable' }),
    T('global.always', 'main', 'Always', [], 'always = yes', [], { k: 'a', words: 'always' }),
    T('global.never', 'main', 'Never', [], 'always = no', [], { k: 'n', words: 'always' })
];

/** Statements of a kind that run in a scope type (`[]` scopes: only global ones). */
export function statementsFor(kind: PickKind, scope: ScopeType | null): StatementDef[]
{
    const fits = STATEMENTS.filter((s) => s.kind === kind && !s.hidden && (scope === null ? Array.isArray(s.scopes) && s.scopes.length === 0 : s.scopes === 'any' || s.scopes.includes(scope)));
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
 * Fills a template: `$name$` → the value; a `[…]` group is dropped when a parameter inside is empty. `short`
 * replaces the template when every optional parameter is empty.
 */
export function fillTemplate(def: Pick<StatementDef, 'script' | 'short' | 'params'>, values: Record<string, string>, opts: { long?: boolean; } = {}): string
{
    const optional = def.params.filter((p) => p.optional !== undefined);
    // (`long`: the block form even so — a written statement's other fields go into it)
    const tpl = def.short && !opts.long && optional.length && optional.every((p) => !values[p.name]) ? def.short : def.script;
    return tpl
        .replace(/\[([^\]]*)\]/g, (_m, inner: string) => ([...inner.matchAll(/\$(\w+)\$/g)].some((m) => !values[m[1]]) ? '' : inner))
        .replace(/\$(\w+)\$/g, (_m, n: string) => values[n] ?? '')
        .replace(/\s+/g, ' ')
        .trim();
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

    if (p.kind === 'ref' && p.prefix)
        return value.startsWith(p.prefix) || (p.scopes ?? []).some((s) => s.value === value);

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
        if (!fits(def, names[i], m[i + 1]))
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
 * over — or, with `rest`, what is left over goes there. `kidRest`: the leftovers of the matched nodes' own blocks.
 */
function matchNodes(t: SNode[], s: SNode[], def: StatementDef, vals: Record<string, string>, rest?: SNode[], kidRest?: SNode[]): boolean
{
    const used = new Set<number>();

    for (const tn of t)
    {
        // a duration placeholder stands for `days|months|years = N`
        const dur = /^‹(\w+)›$/.exec(tn.k);

        if (dur && !tn.op)
        {
            const i = s.findIndex((x, j) => !used.has(j) && !x.kids && x.op === '=' && /^(days|months|years)$/.test(x.k));

            if (i >= 0)
            {
                used.add(i);
                vals[dur[1]] = `${s[i].k} = ${s[i].v}`;
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
export function findStatement(kind: PickKind, text: string, scope?: ScopeType): { def: StatementDef; values: Record<string, string>; rest?: SNode[]; not?: boolean; } | null
{
    const nodes = parseSnippet(text);

    if (nodes.length !== 1)
        return null;

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

            // (fields it has no place for are kept — but a statement that has a place for them wins)
            let score = -3 * rest.length;

            if (scope && (def.scopes === 'any' || def.scopes.includes(scope)))
                score += 2;

            for (const p of def.params)
            {
                const v = values[p.name];

                if (p.kind !== 'number' || !v)
                    continue;

                if (p.sign === -1 && v.startsWith('-'))
                    score += 2;

                if (p.named?.includes(v))
                    score += 1;
            }

            // (optional parameters the written form leaves out — the short form — are "none")
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
