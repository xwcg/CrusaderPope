/**
 * Inert references (docs/mods.md, "Migrating a mod to a newer game version", the `inert` step of the libraries rule): a statement
 * that names an entry the loaded world does not have is made harmless, as if the entry had never existed. The game logs an error
 * for each such statement every time it runs (36,000 lines in one AGOT run: `religion = religion:christianity_religion` in a
 * custom localization evaluated every frame), and the faith window evaluated them per tenet banner.
 *
 * This file is the pure part: `inertText(text, folder, world)` rewrites one text. It knows which keys name entries of which
 * kind (`has_trait = x`, `create_maa_regiment = { type = x }`, `religion = religion:x`, `faith:x = { }`), but not which entries
 * exist: `InertWorld.missing` answers that (inertWorld.ts builds it from the index).
 *
 * What a statement becomes (the world in which the entry never existed):
 * - a test of a missing entry (`has_trait = x`, `rite_has_doctrine = x`, `religion = religion:x`, `exists = title:x`, a scope switch
 *   `faith:x = { }` in a trigger) is `always = no`; with `!=` it is `always = yes`;
 * - an effect on a missing entry (`add_trait = x`, `create_maa_regiment = { type = x }`, `trigger_event = x`, a scope switch in an
 *   effect) is dropped, and an effect block (`every_x`, `if`, `hidden_effect`) that has nothing left but its `limit` goes with it;
 * - constants fold: `NOT = { always = no }` is true, `OR` of dead branches is dead, the dead branches of an `OR` go, a true
 *   statement among others goes (so a mod's `NOT = { has_trait = x }` is not left as "Always: no" in the tooltips);
 * - a modifier type the engine makes for content the world lacks (`lifestyle_scholar_xp_gain_mult` of a trait) in a block of modifiers
 *   (`character_modifier = { }`, a static modifier) goes: there is no such type.
 *
 * What stays, and is told: a block that saves a scope or sets a variable or a list the rest of the entry may use, macro
 * arguments (`RITE = rite:x`, statements with `$X$` in key or value, and a block whose removal would leave a `$PARAM$` of the entry
 * unused: the game fails every call that passes an argument the definition does not take), statements whose context is not
 * known (overloaded keys such as `culture`, `faith`, `religion`, `this` are tests only in a trigger, never in a `create_*` block).
 * Comments, line ends and untouched text stay byte for byte; a second pass changes nothing.
 */
import { parse, type PNode } from '../indexer/parser.ts';
import { applyStatementEdits, dropRange as dropLine, type StatementEdit } from './scriptRules.ts';

/** What a statement can name. */
export type InertKind =
    | 'religion' | 'faith' | 'rite' | 'culture' | 'doctrine' | 'title' | 'trait' | 'law' | 'pillar' | 'innovation' | 'family' | 'maa' | 'artifact'
    | 'struggle' | 'rule' | 'modifier' | 'event' | 'region' | 'doctrine_param' | 'culture_param' | 'perk' | 'accolade' | 'tradition' | 'poi' | 'inspiration' | 'cb' | 'holy_site'
    | 'scripted_trigger' | 'scripted_effect' | 'script_value' | 'modifier_type'
    | 'government_flag' | 'law_flag' | 'legitimacy_flag' | 'trait_flag' | 'building_flag' | 'contract_flag';

/** Which entries the loaded world lacks. */
export interface InertWorld
{
    missing(kind: InertKind, name: string): boolean;
    /**
     * Whether a scripted effect the world lacks leaves something behind that the rest of the entry may use (its definition saves a scope or
     * sets a variable or a list): a call of it is not dropped. Undefined: nothing (a world that cannot read the definition).
     */
    effectKeeps?(name: string): 'scope' | 'variable' | undefined;
    /**
     * The name a missing entry has in the world (renameRule.ts: the game renamed it, the mod's copy keeps the old key): a statement that
     * names it is pointed at that name instead of made false. Undefined: none.
     */
    renamed?(kind: InertKind, name: string): string | undefined;
}

/** A statement the rewrite left alone although it names a missing entry. */
export interface InertKept
{
    /**
     * `scope`: the block saves a scope; `variable`: it sets a variable or a list; `macro`: a `$PARAM$` would be unused; `context`: not known to
     * be a test or an effect; `value`: a script value the world lacks, a number no rewrite can make up
     */
    reason: 'scope' | 'variable' | 'macro' | 'context' | 'value';
    kind?: InertKind;
    name: string;
    /** the entry it stands in */
    entry: string;
    line: number;
}

export interface InertResult
{
    text: string;
    /** statements rewritten or dropped (not counting the folding) */
    edits: number;
    /** the missing names that were made inert, per kind */
    names: Map<InertKind, Set<string>>;
    kept: InertKept[];
}

type Ctx = 'trigger' | 'effect' | 'param' | 'unknown';

interface NameKey
{
    kind: InertKind;
    role: 'trigger' | 'effect';
    /** the field of the block form (`has_trait_xp = { trait = x }`) */
    field?: string;
}

const trig = (kind: InertKind, field?: string): NameKey => ({ kind, role: 'trigger', ...(field ? { field } : {}) });
const eff = (kind: InertKind, field?: string): NameKey => ({ kind, role: 'effect', ...(field ? { field } : {}) });

/**
 * The keys that name an entry: a leaf `key = name`, or a block with the name in `field`. From the keys of the error log of an
 * AGOT run on 1.20.1.2 (every one of these names a database object the game could not find) and their siblings.
 */
const NAME_KEYS: Record<string, NameKey> = Object.assign(Object.create(null), {
    has_trait: trig('trait', 'trait'), has_inactive_trait: trig('trait', 'trait'), has_trait_xp: trig('trait', 'trait'), has_trait_rank: trig('trait', 'trait'),
    add_trait: eff('trait', 'trait'), remove_trait: eff('trait', 'trait'), add_trait_xp: eff('trait', 'trait'), remove_trait_xp: eff('trait', 'trait'),
    add_trait_force_tooltip: eff('trait', 'trait'), remove_trait_force_tooltip: eff('trait', 'trait'), set_trait_rank: eff('trait', 'trait'),
    has_doctrine: trig('doctrine'), rite_has_doctrine: trig('doctrine'), add_doctrine: eff('doctrine'), remove_doctrine: eff('doctrine'),
    religion_tag: trig('religion'), rite_religion_tag: trig('religion'),
    has_realm_law: trig('law'), has_title_law: trig('law'), add_realm_law: eff('law'), add_realm_law_skip_effects: eff('law'), add_title_law: eff('law'), add_title_law_effect: eff('law'),
    has_cultural_pillar: trig('pillar'), knows_language: trig('pillar'), has_court_language: trig('pillar'), learn_language: eff('pillar'), set_court_language: eff('pillar'),
    has_cultural_parameter: trig('culture_param'), has_doctrine_parameter: trig('doctrine_param'), rite_has_parameter: trig('doctrine_param'),
    has_innovation: trig('innovation'), add_innovation: eff('innovation'),
    is_in_family: trig('family'), is_struggle_type: trig('struggle'), has_game_rule: trig('rule'),
    geographical_region: trig('region'), culture_overlaps_geographical_region: trig('region'),
    create_maa_regiment: eff('maa', 'type'), create_artifact: eff('artifact', 'template'), create_rite_from_type: eff('rite', 'type'),
    trigger_event: eff('event', 'id'),
    // (siblings the AGOT run's error log names: perks, accolade types, cultural traditions, points of interest, inspirations; a trait the rites weigh)
    has_perk: trig('perk'), add_perk: eff('perk'), remove_perk: eff('perk'),
    has_accolade_type: trig('accolade'),
    has_cultural_tradition: trig('tradition'), add_culture_tradition: eff('tradition'), remove_culture_tradition: eff('tradition'),
    add_travel_point_of_interest: eff('poi', 'type'), create_inspiration: eff('inspiration', 'type'),
    trait_is_virtue_rite: trig('trait', 'trait'), trait_is_sin_rite: trig('trait', 'trait'),
    add_rite_doctrine: eff('doctrine'), change_rite_doctrine: eff('doctrine'), remove_rite_doctrine: eff('doctrine'), using_cb: trig('cb'),
    is_holy_site_type: trig('holy_site'),
    // (the flag words of governments, laws, legitimacy, traits, buildings and subject contracts: "Unknown law flag" for a word no loaded entry
    // has; the libraries rule gives the mod's entries the words the game's entries of their names gained, the others are the world's to answer)
    government_has_flag: trig('government_flag'), government_type_has_flag: trig('government_flag'), has_realm_law_flag: trig('law_flag'), has_title_law_flag: trig('law_flag'),
    has_legitimacy_flag: trig('legitimacy_flag'), has_trait_with_flag: trig('trait_flag'), has_trait_flag: trig('trait_flag'),
    has_building_with_flag: trig('building_flag', 'flag'), has_construction_with_flag: trig('building_flag', 'flag'),
    vassal_contract_has_flag: trig('contract_flag'), subject_contract_has_flag: trig('contract_flag')
} as Record<string, NameKey>);

// (the static modifiers of the scopes: a name no common/modifiers file defines)
for (const scope of ['character', 'county', 'province', 'dynasty', 'house', 'travel_plan'])
{
    NAME_KEYS[`has_${scope}_modifier`] = trig('modifier', 'modifier');
    NAME_KEYS[`add_${scope}_modifier`] = eff('modifier', 'modifier');
    NAME_KEYS[`remove_${scope}_modifier`] = eff('modifier', 'modifier');
}

/** The prefixes of `prefix:name` links, and what they name. */
const LINKS: Record<string, InertKind> = { religion: 'religion', faith: 'faith', rite: 'rite', culture: 'culture', doctrine: 'doctrine', title: 'title', accolade_type: 'accolade', holy_site: 'holy_site' };
const LINK = /^(religion|faith|rite|culture|doctrine|title|accolade_type|holy_site):([A-Za-z0-9_]+)(?=\.|$)/;

/** The effects that put a value or a target into a variable or a list: with a link to a missing entry they have nothing to put. */
const SETTERS = new Set(['set_variable', 'set_global_variable', 'set_local_variable', 'add_to_variable_list', 'add_to_global_variable_list', 'add_to_local_variable_list']);

/** A data function that reads a trait's experience: `"has_trait_xp(x)"`, `"scope:y.has_trait_xp(x)"`; a trait that does not exist has none. */
const TRAIT_XP = /^(?:[A-Za-z0-9_:]+\.)*has_trait_xp\(([A-Za-z0-9_]+)\)$/;

/** Blocks whose statements are tests. */
const TRIGGER_BLOCKS = new Set([
    'limit', 'trigger', 'is_shown', 'is_valid', 'is_valid_showing_failures_only', 'allow', 'potential', 'is_available', 'can_be_picked', 'can_pick', 'can_send',
    'can_be_picked_regular', 'can_be_picked_artifact', 'is_highlighted', 'ai_potential', 'alternative_limit', 'AND', 'OR', 'NOT', 'NOR', 'NAND', 'trigger_if',
    'trigger_else_if', 'trigger_else', 'modifier', 'can_cast', 'can_start', 'can_use', 'is_valid_trigger', 'can_be_chosen', 'can_become', 'allowed_for_character',
    'valid_for_character', 'is_visible', 'can_continue', 'show_as_unavailable', 'confirm_remove_trigger', 'can_remove', 'can_add', 'is_shown_on_map'
]);

/** Blocks whose statements are effects. */
const EFFECT_BLOCKS = new Set([
    'effect', 'immediate', 'after', 'after_creation', 'hidden_effect', 'option', 'on_accept', 'on_decline', 'on_send', 'on_auto_accept', 'on_success', 'on_failure',
    'on_start', 'on_end', 'on_invalidated', 'on_expire', 'on_complete', 'show_as_tooltip', 'on_monthly', 'on_yearly', 'on_weekly', 'hidden_effect_new_object'
]);

/** Blocks whose children are arguments, not statements. */
const PARAM_BLOCKS = new Set([
    'create_character', 'create_artifact', 'create_maa_regiment', 'create_rite_from_type', 'set_variable', 'change_variable', 'set_global_variable', 'set_local_variable',
    'create_title_and_vassal_change', 'trigger_event', 'create_story', 'create_faith', 'create_religion', 'create_holy_order', 'create_dynamic_title', 'add_opinion',
    'create_inspiration', 'create_alliance', 'start_war', 'give_nickname', 'create_dynasty', 'create_house', 'add_character_modifier', 'add_county_modifier', 'add_province_modifier'
]);

/** Effects that keep something for later: a scope, a variable, a list. A block with one of them is not removed. */
export const SAVES_SCOPE = new Set(['save_scope_as', 'save_temporary_scope_as', 'save_scope_value_as', 'save_temporary_scope_value_as', 'save_opinion_value_as']);
export const SETS_VARIABLE = new Set([
    'set_variable', 'change_variable', 'clamp_variable', 'add_to_variable_list', 'remove_variable', 'remove_from_variable_list', 'set_global_variable', 'change_global_variable',
    'add_to_global_variable_list', 'set_local_variable', 'change_local_variable', 'add_to_list', 'add_to_temporary_list', 'remove_from_list', 'round_variable', 'round_global_variable'
]);

/** The children of an effect container that do not make it do anything. */
const IDLE = new Set(['limit', 'alternative_limit', 'order_by', 'position', 'min', 'max', 'count', 'check_range_bounds', 'weight', 'chance', 'even_if_invalid', 'continue', 'percent']);

const isIterator = (k: string): boolean => /^(every|random|ordered)_/.test(k);
const NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const LOC_FOLDER = /(^|\/)common\/customizable_localization(\/|$)/i;
const EXPRESSIONS = new Set(['NOT', 'OR', 'AND', 'NOR', 'NAND']);
/** A macro argument at a call: `RITE = rite:x` (the expressions NOT, OR … are no arguments). */
const isMacroArg = (k: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(k) && !EXPRESSIONS.has(k);
const MACRO = /\$[A-Za-z0-9_]+(?:\|[^$]*)?\$/g;
/** A key that is only a macro argument: `$OWNER$`. */
const MACRO_KEY = /^\$[A-Za-z0-9_]+\$$/;

/** The context a folder's (or a file's) entries start in: a scripted trigger is a test, a scripted effect an effect. */
function folderCtx(folder: string): Ctx
{
    const f = folder.toLowerCase().replace(/\\/g, '/');
    return /(^|\/)common\/scripted_triggers(\/|$)/.test(f) ? 'trigger' : /(^|\/)common\/scripted_effects(\/|$)/.test(f) ? 'effect' : 'unknown';
}

/** The context of a block's children. */
function childCtx(k: string | null, ctx: Ctx): Ctx
{
    if (k === null)
        return ctx;

    if (TRIGGER_BLOCKS.has(k) || k.startsWith('any_'))
        return 'trigger';

    if (EFFECT_BLOCKS.has(k) || isIterator(k) || k.endsWith('_effect') || k.startsWith('on_'))
        return 'effect';

    if (PARAM_BLOCKS.has(k))
        return 'param';

    // (a block that is a scope or control flow holds statements like the block around it, a macro argument's block too (`$OWNER$ = { }`:
    // a scope the callers pass); any other key may be a trigger or effect with arguments, `num_virtuous_traits = { target = faith:x }`,
    // whose children are no statements)
    return ctx === 'unknown' || STRUCTURE.has(k) || SCOPES.has(k) || /^\d+$/.test(k) || k.includes(':') || k.includes('.') || MACRO_KEY.test(k) ? ctx : 'param';
}

/** Control flow: its blocks hold the statements of the block around. */
const STRUCTURE = new Set(['if', 'else', 'else_if', 'while', 'random', 'random_list', 'switch', 'custom_tooltip', 'custom_description', 'custom_description_no_bullet', 'show_as_tooltip', 'hidden_effect', 'trigger_else']);

/** Scope links whose block holds statements of the scope they lead to. */
const SCOPES = new Set([
    'faith', 'religion', 'culture', 'rite', 'holder', 'liege', 'top_liege', 'overlord', 'owner', 'root', 'this', 'prev', 'from', 'father', 'mother', 'real_father', 'spouse',
    'primary_spouse', 'primary_heir', 'designated_heir', 'employer', 'host', 'ruler', 'capital_province', 'capital_county', 'capital_barony', 'location', 'county', 'duchy', 'kingdom',
    'empire', 'title', 'dynasty', 'house', 'dynast', 'house_head', 'liege_or_court_owner', 'primary_title', 'realm', 'home_court', 'court_owner', 'imprisoner', 'killer', 'main_rite',
    'founder', 'religious_head', 'religious_head_title', 'de_jure_liege', 'de_facto_liege', 'domicile', 'actor', 'recipient', 'secondary_actor', 'secondary_recipient', 'target'
]);

/** The text a dropped statement takes: its line when nothing else is on it, else the statement and the spaces behind it. */
function dropRange(text: string, n: PNode): StatementEdit
{
    const d = dropLine(text, n);

    if (d.s !== n.s)
        return d;

    let e = d.e;

    while (text[e] === ' ' || text[e] === '\t')
        e++;

    return { s: d.s, e, text: '' };
}

type Verdict = 'dead' | 'alive' | 'drop';

/** What visiting a statement found: its verdict (the parent decides whether to use it) and the edits that apply when the parent does not. */
interface Vis
{
    v?: Verdict;
    edits: StatementEdit[];
    /** a `trigger` block whose statements are all false */
    allDead?: true;
    /** a `limit` block with a false statement: the `if` it belongs to never runs */
    deadLimit?: true;
    /**
     * a scope block of a trigger (`scope:x = { }`, `$ACTOR$ = { }`, `liege = { }`) with a false statement in it, which stays as it is
     * written: its statements are all true at once or it is false, so it is false (a scope that does not exist is false too)
     */
    never?: true;
}

interface State
{
    text: string;
    world: InertWorld;
    names: Map<InertKind, Set<string>>;
    kept: InertKept[];
    entry: string;
    /** statements rewritten */
    count: number;
    /** the text is a customizable localization: a `text` whose trigger is false goes */
    loc: boolean;
    /** inside a `show_as_tooltip` (its effects are only shown, never run): how many deep */
    tip: number;
    /** the uses of each macro parameter (`$X$`) in the entry: a part that holds all of one is not dropped (the callers pass it) */
    macros: Map<string, number>;
    /** the macro parameters the entry uses as something no scope is (`wordArguments`): a `$X$ = { }` block of one is not visited */
    words: Set<string>;
    /** the text is an event file: an `option` is an event's option (its `trait = x` shows the trait) */
    events: boolean;
}

const NONE: Vis = { edits: [] };

/** Whether any statement of the subtree is one of `keys`. */
function holds(n: PNode, keys: Set<string>): boolean
{
    if (n.k && keys.has(n.k))
        return true;

    return Array.isArray(n.v) && n.v.some((c) => holds(c, keys));
}

function note(st: State, kind: InertKind, name: string): void
{
    let s = st.names.get(kind);

    if (!s)
        st.names.set(kind, (s = new Set()));

    s.add(name);
}

function keep(st: State, reason: InertKept['reason'], kind: InertKind, name: string, n: PNode): Vis
{
    st.kept.push({ reason, kind, name, entry: st.entry, line: n.line });
    return NONE;
}

/** The verdict for a block (a scope switch on a missing entry), unless it keeps something for the rest of the entry. */
function blockVerdict(st: State, n: PNode, ctx: Ctx, kind: InertKind, name: string): Vis
{
    if (holds(n, SAVES_SCOPE))
        return keep(st, 'scope', kind, name, n);

    if (ctx === 'trigger')
    {
        note(st, kind, name);
        st.count++;
        return { v: 'dead', edits: [] };
    }

    if (ctx === 'effect')
    {
        if (holds(n, SETS_VARIABLE))
            return keep(st, 'variable', kind, name, n);

        note(st, kind, name);
        st.count++;
        return { v: 'drop', edits: [] };
    }

    return keep(st, 'context', kind, name, n);
}

/** The edits that apply a node's verdict. */
function materialize(st: State, n: PNode, v: Verdict): StatementEdit
{
    return v === 'dead' ? { s: n.s, e: n.e, text: 'always = no' } : v === 'alive' ? { s: n.s, e: n.e, text: 'always = yes' } : dropRange(st.text, n);
}

/** All the edits of a block's children: their own, or the ones their verdicts ask for. */
const all = (st: State, kids: PNode[], vis: Vis[]): StatementEdit[] => vis.flatMap((x, i) => (x.v ? [materialize(st, kids[i], x.v)] : x.edits));

/** The edits of an expression whose dead branches go (the rest as they are). */
const withoutDead = (st: State, kids: PNode[], vis: Vis[]): StatementEdit[] => vis.flatMap((x, i) => (x.v === 'dead' ? [dropRange(st.text, kids[i])] : x.v ? [materialize(st, kids[i], x.v)] : x.edits));

/**
 * What the children's verdicts make of an expression block (`NOT`, `OR`, `NOR`, `AND`, `NAND`): a verdict of its own (the parent decides
 * what to do with it) or the edits of its children. Only blocks with a child that has a verdict change: an `OR` of the game's own is left as it is.
 */
function expression(st: State, kids: PNode[], vis: Vis[], key: string): Vis
{
    const dead = vis.filter((x) => x.v === 'dead').length;
    const alive = vis.filter((x) => x.v === 'alive').length;
    const other = vis.length - dead - alive;

    if (!dead && !alive)
        return { edits: vis.flatMap((x) => x.edits) };

    // (a NOT of several statements is a NOT of their AND)
    if (key === 'NOT' || key === 'NAND')
    {
        if (dead)
            return { v: 'alive', edits: [] };

        if (!other)
            return { v: 'dead', edits: [] };
    }
    else if (key === 'OR')
    {
        if (alive)
            return { v: 'alive', edits: [] };

        return other ? { edits: withoutDead(st, kids, vis) } : { v: 'dead', edits: [] };
    }
    else if (key === 'NOR')
    {
        if (alive)
            return { v: 'dead', edits: [] };

        return other ? { edits: withoutDead(st, kids, vis) } : { v: 'alive', edits: [] };
    }
    else if (key === 'AND')
    {
        if (dead)
            return { v: 'dead', edits: [] };

        if (!other)
            return { v: 'alive', edits: [] };
    }

    return { edits: sectionEdits(st, kids, vis) };
}

/** The edits of a block whose children keep their own verdicts: dead ones become `always = no`, true ones go (the last one stays as `always = yes`). */
function sectionEdits(st: State, kids: PNode[], vis: Vis[]): StatementEdit[]
{
    const out: StatementEdit[] = [];
    // (the statements that stay: no verdict, or one that is not "true")
    const stays = vis.filter((x) => x.v !== 'alive').length;
    let last = false;

    vis.forEach((x, i) =>
    {
        const n = kids[i];

        if (!x.v)
        {
            out.push(...x.edits);
            return;
        }

        if (x.v === 'alive')
        {
            // (a true statement among others is no statement; alone it stays as `always = yes`)
            out.push(stays || last ? dropRange(st.text, n) : materialize(st, n, 'alive'));
            last = true;
            return;
        }

        // (an `if` followed by an `else` cannot go alone: the `else` would stand without it; the last `text` of a localization stays)
        const next = kids[i + 1]?.k;

        if (x.v === 'drop' && n.k === 'text' && !kids.some((c, j) => j !== i && c.k === 'text' && vis[j].v !== 'drop'))
        {
            out.push(...x.edits);
            return;
        }

        if (x.v === 'drop' && (n.k === 'if' || n.k === 'else_if') && (next === 'else' || next === 'else_if'))
        {
            out.push(...x.edits);
            return;
        }

        out.push(materialize(st, n, x.v));
    });

    return out;
}

/** Visits a block's children. */
function visitChildren(st: State, n: PNode, ctx: Ctx): Vis[]
{
    const kids = Array.isArray(n.v) ? n.v : [];
    const cctx = childCtx(n.k, ctx);
    return kids.map((c) => visit(st, c, cctx));
}

/** The value of a node (`at`: the leaf with the name) written as another name, quotes kept. */
const renamedTo = (at: PNode, name: string): Vis => ({ edits: [{ s: at.q ? at.vs + 1 : at.vs, e: at.q ? at.e - 1 : at.e, text: name }] });

/**
 * The verdict of a statement of a name key: `has_trait = x`, `create_maa_regiment = { type = x }`. `at`: the leaf with the name (the
 * statement itself, or the block's field). A name the world has under another (`InertWorld.renamed`) is written as that one.
 */
function nameVerdict(st: State, n: PNode, nk: NameKey, name: string, at: PNode = n): Vis | undefined
{
    // (a name, not a scope or a link: `scope:region_temp`, `geographical_region:x`, a macro argument)
    if (!NAME.test(name) || !st.world.missing(nk.kind, name))
        return undefined;

    const alias = st.world.renamed?.(nk.kind, name);

    if (alias)
    {
        st.count++;
        return renamedTo(at, alias);
    }

    note(st, nk.kind, name);
    st.count++;
    return { v: nk.role === 'trigger' ? 'dead' : 'drop', edits: [] };
}

const CALL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMPARES = new Set(['<', '>', '<=', '>=', '!=']);

/**
 * A call of a scripted trigger or effect, or a script value, the world lacks (the author took the definition out; the game's files, or
 * the copies of the tool, still call it). The key of a statement is the name: a name that is a scripted trigger can only be a test, a
 * scripted effect only an effect, so where the context is not known the definition decides.
 * - a test: `name = yes` is false, `name = no` true, `name = { arguments }` false (the world in which the trigger never existed);
 * - an effect: `name = yes` / `name = { arguments }` is dropped, unless the definition saves a scope or sets a variable or a list (the rest
 *   of the entry may use it: the call stays and is told);
 * - a script value: a number nothing makes up; told, never rewritten.
 * The names that carry a macro (`$X$`) never get here; a name the library rule carries over is not missing (the world decides).
 */
function scriptedCall(st: State, n: PNode, ctx: Ctx): Vis | undefined
{
    const k = n.k!;

    if (ctx === 'param' || !CALL.test(k) || NAME_KEYS[k] || EXPRESSIONS.has(k) || STRUCTURE.has(k))
        return undefined;

    if (n.op === '=')
    {
        const no = n.v === 'no';

        if (no || n.v === 'yes' || Array.isArray(n.v))
        {
            if (ctx !== 'effect' && st.world.missing('scripted_trigger', k))
            {
                note(st, 'scripted_trigger', k);
                st.count++;
                return { v: no ? 'alive' : 'dead', edits: [] };
            }

            if (ctx !== 'trigger' && !no && st.world.missing('scripted_effect', k))
            {
                // (inside a `show_as_tooltip` the effects only show: nothing they would leave behind is ever there)
                if (!st.tip)
                {
                    if (Array.isArray(n.v) && holds(n, SAVES_SCOPE))
                        return keep(st, 'scope', 'scripted_effect', k, n);

                    if (Array.isArray(n.v) && holds(n, SETS_VARIABLE))
                        return keep(st, 'variable', 'scripted_effect', k, n);

                    const kept = st.world.effectKeeps?.(k);

                    if (kept)
                        return keep(st, kept, 'scripted_effect', k, n);
                }

                note(st, 'scripted_effect', k);
                st.count++;
                return { v: 'drop', edits: [] };
            }
        }
    }

    // (a script value as the left side of a comparison)
    if (n.op && COMPARES.has(n.op) && typeof n.v === 'string' && st.world.missing('script_value', k))
        return keep(st, 'value', 'script_value', k, n);

    return undefined;
}

function visit(st: State, n: PNode, ctx: Ctx): Vis
{
    const k = n.k;

    if (k === null)
        return Array.isArray(n.v) ? { edits: sectionEdits(st, n.v, visitChildren(st, n, ctx)) } : NONE;

    // (a macro in the key: the statement is not what it looks like; except a block whose key is only the argument, `$RITE$ = { rite_has_parameter = x }`,
    // `$OWNER$ = { add_trait = x }`: a scope the callers pass, in a trigger or an effect, visited like `scope:x = { }`. Its dead tests are made false in
    // place and its effects on missing entries go, the block stays, so the argument is still used and the callers' calls stay valid. Not when the
    // entry uses the argument as something no scope is (`State.words`): then the block may be a call with arguments)
    if (k.includes('$') && !((ctx === 'trigger' || ctx === 'effect') && MACRO_KEY.test(k) && Array.isArray(n.v) && !st.words.has(k.slice(1, -1))))
        return NONE;

    // (a stress impact names traits by its keys: `stress_and_fulfillment_impact = { erudite = minor_stress_impact_gain }`)
    if (k === 'stress_and_fulfillment_impact' && Array.isArray(n.v) && ctx !== 'trigger')
    {
        const edits: StatementEdit[] = [];

        for (const c of n.v)
        {
            if (c.k && NAME.test(c.k) && st.world.missing('trait', c.k))
            {
                const alias = st.world.renamed?.('trait', c.k);
                st.count++;

                if (alias)
                {
                    edits.push({ s: c.s, e: c.s + c.kl, text: alias });
                    continue;
                }

                note(st, 'trait', c.k);
                edits.push(dropRange(st.text, c));
            }
        }

        return { edits };
    }

    // (a variable or a list that is to hold a missing entry: nothing to hold, the effect goes; a read of it finds it unset, as for any entry the world never had)
    if (SETTERS.has(k) && Array.isArray(n.v) && ctx !== 'trigger' && ctx !== 'param')
    {
        const f = n.v.find((c) => (c.k === 'value' || c.k === 'target') && typeof c.v === 'string' && !c.q);
        const lv = f ? LINK.exec(f.v as string) : null;

        if (lv && st.world.missing(LINKS[lv[1]], lv[2]) && !holds(n, SAVES_SCOPE))
        {
            note(st, LINKS[lv[1]], lv[2]);
            st.count++;
            return { v: 'drop', edits: [] };
        }
    }

    // (a call of a scripted trigger or effect the world lacks, a script value it lacks)
    const call = scriptedCall(st, n, ctx);

    if (call)
        return call;

    const nk = NAME_KEYS[k];

    if (nk && (n.op === '=' || n.op === '?='))
    {
        if (typeof n.v === 'string')
        {
            const r = nameVerdict(st, n, nk, n.v);

            if (r)
                return r;
        }
        else if (nk.field)
        {
            const f = n.v.find((c) => c.k === nk.field && typeof c.v === 'string');

            // (a count that zero satisfies, `has_building_with_flag = { flag = x count < 1 }`, holds when nothing has the name: no verdict to give;
            // a name the world has under another is written as that one below, and the count then tests the entry it names)
            if (f && nk.role === 'trigger' && n.v.some((c) => c.k === 'count' && typeof c.v === 'string' && zeroCounts(c.op, c.v)) && NAME.test(f.v as string) && st.world.missing(nk.kind, f.v as string) && !st.world.renamed?.(nk.kind, f.v as string))
                return keep(st, 'context', nk.kind, f.v as string, n);

            const r = f ? nameVerdict(st, n, nk, f.v as string, f) : undefined;

            if (r)
                return holds(n, SAVES_SCOPE) && r.v ? keep(st, 'scope', nk.kind, (f!.v as string), n) : r;
        }
    }

    // (a link in the key: `faith:x = { … }`, `title:x.holder ?= this`)
    const lk = LINK.exec(k);

    if (lk && st.world.missing(LINKS[lk[1]], lk[2]))
    {
        if (Array.isArray(n.v))
            return blockVerdict(st, n, ctx, LINKS[lk[1]], lk[2]);

        if (ctx === 'trigger' && (n.op === '=' || n.op === '?=' || n.op === '!='))
        {
            note(st, LINKS[lk[1]], lk[2]);
            st.count++;
            return { v: n.op === '!=' ? 'alive' : 'dead', edits: [] };
        }

        return keep(st, 'context', LINKS[lk[1]], lk[2], n);
    }

    if (typeof n.v === 'string')
    {
        // (the experience of a trait that does not exist: a value of 0)
        const xp = n.q && n.op === '=' ? TRAIT_XP.exec(n.v) : null;

        if (xp && NAME.test(xp[1]) && st.world.missing('trait', xp[1]))
        {
            const alias = st.world.renamed?.('trait', xp[1]);
            st.count++;

            // (the trait the world has under another name: `has_trait_xp(<that name>)`)
            if (alias)
            {
                const at = n.vs + (n.q ? 1 : 0) + n.v.lastIndexOf('(') + 1;
                return { edits: [{ s: at, e: at + xp[1].length, text: alias }] };
            }

            note(st, 'trait', xp[1]);
            return { edits: [{ s: n.vs, e: n.e, text: '0' }] };
        }

        // (a link in the value: `religion = religion:x`, `exists = title:x`, `this = rite:x`)
        const lv = LINK.exec(n.v);

        if (lv && !isMacroArg(k) && st.world.missing(LINKS[lv[1]], lv[2]))
        {
            if (ctx === 'trigger' && (n.op === '=' || n.op === '?=' || n.op === '!='))
            {
                note(st, LINKS[lv[1]], lv[2]);
                st.count++;
                return { v: n.op === '!=' ? 'alive' : 'dead', edits: [] };
            }

            // (a variable, an argument of an effect: stays)
            if (ctx !== 'param' && !isMacroArg(k))
                return keep(st, 'context', LINKS[lv[1]], lv[2], n);
        }

        // (a script value the world lacks as a value: `add_gold = name`, `value = name`; a number nothing makes up, told)
        if (ctx !== 'param' && !n.q && CALL.test(n.v) && !NAME_KEYS[n.v] && n.v !== 'yes' && n.v !== 'no' && st.world.missing('script_value', n.v))
            return keep(st, 'value', 'script_value', n.v, n);

        return NONE;
    }

    if (!Array.isArray(n.v) || isMacroArg(k))
        return NONE;

    const kids = n.v;
    const tip = k === 'show_as_tooltip';

    if (tip)
        st.tip++;

    const vis = visitChildren(st, n, ctx);

    if (tip)
        st.tip--;

    if (k.endsWith('_modifier'))
        dropGoneTypes(st, kids, vis);

    // (a new character's traits: `create_character = { trait = x }`, `random_traits_list = { x = { } }`; an event option shows a trait)
    if (k === 'create_character' || k === 'random_traits_list' || (k === 'option' && st.events))
        characterTraits(st, kids, vis, k === 'random_traits_list');

    const cctx = childCtx(k, ctx);

    if (EXPRESSIONS.has(k))
        return expression(st, kids, vis, k);

    // (an `if` or `else_if` whose condition the rewrite made false never runs, but the game still reads its body when it loads the file and
    // reports every name in it that does not exist: `$ACTOR$ = { remove_character_modifier = x }` under `limit = { $ACTOR$ = { always = no } }`.
    // The body goes, whatever it holds; nothing in it ever ran, so nothing changes. What was kept in it for a scope or a variable has nothing
    // to be kept for. A statement that holds every use of a macro parameter of the entry stays (the callers pass the argument). The `if`
    // itself goes when nothing is left, or stays empty before an `else` / `else_if`, which then runs as before)
    const dead = (k === 'if' || k === 'else_if') && cctx !== 'trigger' ? kids.findIndex((c, i) => c.k === 'limit' && vis[i].deadLimit) : -1;

    if (dead >= 0)
    {
        let body = false;

        kids.forEach((c, i) =>
        {
            if (i === dead || (c.k && IDLE.has(c.k)) || holdsMacro(st, c))
                return;

            const last = lastLine(st.text, c);

            for (let j = st.kept.length - 1; j >= 0; j--)
                if (st.kept[j].line >= c.line && st.kept[j].line <= last)
                    st.kept.splice(j, 1);

            if (vis[i].v !== 'drop')
                body = true;

            vis[i] = { v: 'drop', edits: [] };
        });

        if (body)
            st.count++;
    }

    const edits = sectionEdits(st, kids, vis);

    // (a text of a customizable localization whose trigger is false is never shown)
    if (st.loc && k === 'text' && kids.some((c, i) => c.k === 'trigger' && vis[i].allDead))
    {
        st.count++;
        return { v: 'drop', edits };
    }

    // (an effect block that has nothing left to do: its effects went)
    if (cctx !== 'trigger' && (isIterator(k) || k === 'hidden_effect' || k === 'if' || k === 'else' || k === 'else_if' || k === 'while' || k === 'show_as_tooltip') && vis.some((x) => x.v === 'drop'))
    {
        const left = kids.filter((c, i) => vis[i].v !== 'drop' && !(c.k && IDLE.has(c.k)));

        // (a false `if` whose limit holds every use of a macro parameter stays, empty: dropped, the entry would lose the parameter, and the
        // check below would put the whole `if` back as it was, with the limit's names unchanged)
        if (!left.length && !(dead >= 0 && holdsMacro(st, n)))
            return { v: 'drop', edits };
    }

    return {
        edits,
        ...(k === 'trigger' && vis.length && vis.every((x) => x.v === 'dead') ? { allDead: true as const } : {}),
        ...(k === 'limit' && vis.some((x) => x.v === 'dead' || x.never) ? { deadLimit: true as const } : {}),
        ...(ctx === 'trigger' && isScopeKey(k) && vis.some((x) => x.v === 'dead' || x.never) ? { never: true as const } : {})
    };
}

/** Whether `0 <op> value` holds (a count compared so: what a test of a name nothing has gives); a value that is no number may. */
function zeroCounts(op: string | null, value: string): boolean
{
    const n = Number(value);

    if (!Number.isFinite(n))
        return true;

    return op === '<' ? 0 < n : op === '<=' ? 0 <= n : op === '>' ? 0 > n : op === '>=' ? 0 >= n : op === '!=' ? n !== 0 : n === 0;
}

/** A trait a new character gets (or an event option shows): no test, the effect of having it. */
const CHARACTER_TRAIT = eff('trait');

/**
 * The traits of a new character's data (the game's "Failed to lookup trait 'x'" for one the world lacks): `trait = x` in a
 * `create_character` block, at the top of a scripted character template, and in an event option (its trait icon: "Unknown trait
 * x, in event"); with `keys`, the traits a `random_traits_list` names by its keys (`x = { weight = … }`, `count` aside). A trait the
 * world lacks goes, one it has under another name is written as that one.
 */
function characterTraits(st: State, kids: PNode[], vis: Vis[], keys: boolean): void
{
    kids.forEach((c, i) =>
    {
        if (vis[i].v || !c.k)
            return;

        if (!keys)
        {
            const r = c.k === 'trait' && c.op === '=' && typeof c.v === 'string' && !c.q ? nameVerdict(st, c, CHARACTER_TRAIT, c.v) : undefined;

            if (r)
                vis[i] = r;

            return;
        }

        if (c.k === 'count' || !Array.isArray(c.v) || !NAME.test(c.k) || !st.world.missing('trait', c.k))
            return;

        const alias = st.world.renamed?.('trait', c.k);
        st.count++;

        if (alias)
        {
            vis[i] = { edits: [{ s: c.s, e: c.s + c.kl, text: alias }, ...vis[i].edits] };
            return;
        }

        note(st, 'trait', c.k);
        vis[i] = { v: 'drop', edits: [] };
    });
}

/** The files of the scripted character templates: each entry is a new character's data. */
const TEMPLATE_FOLDER = /(^|\/)common\/scripted_character_templates(\/|$)/i;

/** A value a modifier type takes: a number or a constant. */
const MODIFIER_VALUE = /^(?:[-+]?(?:\d+\.?\d*|\.\d+)|@[A-Za-z0-9_]+)$/;

/** The files of the static modifiers: each entry is a block of modifiers. */
const MODIFIER_FOLDER = /(^|\/)common\/modifiers(\/|$)/i;

/**
 * The statements of a block of modifiers (`character_modifier = { }`, `personal_tenet_modifier = { }`, a static modifier) that are types the
 * engine makes for content the world lacks: the engine registers `<trait>_xp_gain_mult`, `<culture>_opinion` … only for the trait or culture
 * that is there ("Unknown modifier type 'lifestyle_scholar_xp_gain_mult'"). Such a type goes; the block stays, empty if it held nothing else.
 */
function dropGoneTypes(st: State, kids: PNode[], vis: Vis[]): void
{
    kids.forEach((c, i) =>
    {
        if (!c.k || c.op !== '=' || typeof c.v !== 'string' || c.q || !MODIFIER_VALUE.test(c.v) || vis[i].v || !st.world.missing('modifier_type', c.k))
            return;

        note(st, 'modifier_type', c.k);
        st.count++;
        vis[i] = { v: 'drop', edits: [] };
    });
}

/** A key that switches the scope (`scope:x`, `liege`, `faith:x.religion`, a macro argument `$ACTOR$`): its block holds statements of that scope. */
const isScopeKey = (k: string): boolean => SCOPES.has(k) || k.includes(':') || k.includes('.') || /^\$[A-Za-z0-9_]+\$$/.test(k);

/** The last line of a node. */
const lastLine = (text: string, n: PNode): number => n.line + (text.slice(n.s, n.e).match(/\n/g)?.length ?? 0);

/** The uses of each macro parameter in a text (`$X$`, `$X|default$`). */
function macroUses(text: string): Map<string, number>
{
    const out = new Map<string, number>();

    for (const m of text.matchAll(MACRO))
    {
        const name = m[0].slice(1, -1).split('|')[0];
        out.set(name, (out.get(name) ?? 0) + 1);
    }

    return out;
}

/** Whether a node holds every use of a macro parameter of the entry. */
function holdsMacro(st: State, n: PNode): boolean
{
    const text = st.text.slice(n.s, n.e);

    if (!text.includes('$'))
        return false;

    return [...macroUses(text)].some(([name, uses]) => uses >= (st.macros.get(name) ?? 0));
}

/** The macro parameters (`$X$`) of a text, by name. */
function macroNames(text: string): Set<string>
{
    return new Set([...text.matchAll(MACRO)].map((m) => m[0].slice(1, -1).split('|')[0]));
}

/** The fields of the name keys' block forms (`trait`, `type`, `template` …): a name stands there. */
const NAME_FIELDS = new Set(Object.values(NAME_KEYS).flatMap((nk) => (nk.field ? [nk.field] : [])));

/**
 * The macro parameters an entry uses as something no scope is, so that a block keyed by one may be a call with arguments: a part of a
 * word or of a link (`$X$_value`, `has_$X$`, `scope:$X$`, `faith:$X$`), a scripted trigger or effect it calls (`$X$ = yes` / `no`), the
 * name a name key takes (`add_trait = $X$`, `trait = $X$`). A scope chain (`$X$.liege`) and a target (`target = $X$`) are scope uses.
 * The game's 1,549 blocks of this kind (entry and argument) have none of these: the guard is for what mods may write.
 */
function wordArguments(text: string): Set<string>
{
    const out = new Set<string>();

    for (const m of text.matchAll(/([A-Za-z0-9_:]?)\$([A-Za-z0-9_]+)(?:\|[^$]*)?\$([A-Za-z0-9_]?)/g))
        if (m[1] || m[3])
            out.add(m[2]);

    for (const m of text.matchAll(/\$([A-Za-z0-9_]+)\$[ \t]*=[ \t]*(?:yes|no)(?![A-Za-z0-9_])/g))
        out.add(m[1]);

    for (const m of text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)[ \t]*\??=[ \t]*\$([A-Za-z0-9_]+)(?:\|[^$]*)?\$(?![A-Za-z0-9_.:$])/g))
        if (NAME_KEYS[m[1]] || NAME_FIELDS.has(m[1]))
            out.add(m[2]);

    return out;
}

/**
 * Rewrites a text as if the entries `world` lacks had never existed. `folder` (or the file's path) tells what the top-level
 * entries are (a scripted trigger is a test, a scripted effect an effect, the rest decides by the blocks).
 */
export function inertText(text: string, folder: string, world: InertWorld): InertResult
{
    const bom = text.startsWith('﻿');
    const src = bom ? text.slice(1) : text;
    const names = new Map<InertKind, Set<string>>();
    const kept: InertKept[] = [];
    const entryCtx = folderCtx(folder);
    const path = folder.replace(/\\/g, '/');
    const all: StatementEdit[] = [];
    let count = 0;

    for (const top of parse(src))
    {
        if (!top.k || top.k.startsWith('@') || !Array.isArray(top.v))
            continue;

        const body = src.slice(top.s, top.e);
        const st: State = {
            text: src, world, names: new Map(), kept: [], entry: top.k, count: 0, tip: 0, loc: LOC_FOLDER.test(path), macros: macroUses(body), words: body.includes('$') ? wordArguments(body) : new Set(),
            events: /^events\//i.test(path)
        };
        const vis = top.v.map((c) => visit(st, c, entryCtx));

        // (a static modifier is a block of modifiers itself)
        if (MODIFIER_FOLDER.test(path))
            dropGoneTypes(st, top.v, vis);

        // (a scripted character template is a new character's data itself)
        if (TEMPLATE_FOLDER.test(path))
            characterTraits(st, top.v, vis, false);

        let edits = sectionEdits(st, top.v, vis);

        if (!edits.length)
        {
            kept.push(...st.kept);
            continue;
        }

        // (a macro parameter the entry would lose: the callers pass it, and the game fails the call that passes one the definition does not take)
        const before = macroNames(src.slice(top.s, top.e));

        for (let again = true; again && before.size;)
        {
            again = false;
            const after = macroNames(applyStatementEdits(src.slice(top.s, top.e), edits.map((e) => ({ ...e, s: e.s - top.s, e: e.e - top.s }))));
            const lost = [...before].filter((p) => !after.has(p));

            for (const p of lost)
            {
                const hit = edits.filter((e) => macroNames(src.slice(e.s, e.e)).has(p));

                if (hit.length)
                {
                    edits = edits.filter((e) => !hit.includes(e));
                    st.kept.push({ reason: 'macro', name: `$${p}$`, entry: top.k, line: top.line });
                    again = true;
                }
            }
        }

        if (!edits.length)
        {
            kept.push(...st.kept);
            continue;
        }

        all.push(...edits);
        kept.push(...st.kept);
        count += st.count;

        for (const [kind, set] of st.names)
            for (const name of set)
                names.set(kind, (names.get(kind) ?? new Set<string>()).add(name));
    }

    const out = all.length ? applyStatementEdits(src, all) : src;
    return { text: bom ? '﻿' + out : out, edits: count, names, kept };
}
