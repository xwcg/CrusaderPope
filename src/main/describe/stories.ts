/**
 * Builds the readable views: event stories, on_action stories and tooltip-style cards for everything else.
 */
import type { PNode } from '../indexer/parser.ts';
import type { Def, Entity, GameIndex } from '../indexer/gameIndex.ts';
import { descriptionCandidates, displayNameCandidates, typeLabel } from '../indexer/schema.ts';
import { historyFaith, riteHistory } from '../indexer/layouts.ts';
import { BOOKMARK_DATE } from '../portraits/modifiers.ts';
import type {
    FamilyTree,
    CardSection,
    CastMember,
    DescNode,
    EntityCard,
    EventScene,
    EventCast,
    EventPortrait,
    OnActionInfo,
    EventStory,
    FollowUp,
    Line,
    FieldSuggestion,
    GuiItem,
    LineSource,
    LocCodes,
    ModifierKeyInfo,
    OnActionList,
    OnActionListKey,
    OnActionStory,
    PickTarget,
    ScopeReach,
    Rich,
    RichSeg,
    SectionSource,
    StoryOption,
    StoryOrigin,
    TooltipInfo,
    UsageSummary
} from '../../shared/api.ts';
import { Describer, ownCopy, pushPrev, rootCtx, type Ctx } from './describer.ts';
import { sameScript } from '../../shared/scriptFormat.ts';
import { FIELDS, bareField, fieldOf, fieldText, isOpenSet } from '../../shared/fieldCatalog.ts';
import { capitalize, formatNumber, humanize, rich, richToString, titleCase } from './text.ts';
import { TYPE_CARDS } from './cards/index.ts';
import { EMPTY_NOTE } from './cards/presentation.ts';
import type { CardFn } from './cards/types.ts';
import { interfaceSection } from './cards/interface.ts';
import { doctrineGroups } from './cards/culture-faith.ts';
import { paramLines, paramPairs } from './cards/culture-util.ts';
import { descLines } from './cards/life-shared.ts';
import { createCharacterLine } from './cards/scripted-templates.ts';
import { TRIGGER_BLOCKS } from './scriptKeys.ts';
import { modifierAreaOf, modifierScopeOf, scopeTypeByName } from '../../shared/scriptCatalog.ts';
import { onActionFact } from '../../shared/scriptFacts.ts';
import { valueLines, weightLines } from './cards/weight.ts';

import { tr } from '../../shared/i18n.ts';
import { castTargets } from '../../shared/castTargets.ts';
const EVENT_KIND: Record<string, string> = {
    character_event: 'Event',
    letter_event: 'Letter',
    court_event: tr('Court event'),
    activity_event: tr('Activity event'),
    duel_event: 'Duel',
    none: tr('Background event'),
    empty: tr('Background event')
};

const TRIGGER_SECTIONS: Record<string, string> = {
    is_shown: tr('Shown when'),
    potential: tr('Available when'),
    is_valid: 'Requirements',
    is_valid_showing_failures_only: 'Requirements',
    can_send: tr('Can be sent when'),
    can_pick: tr('Can be picked when'),
    can_be_picked: tr('Can be picked when'),
    allow: tr('Allowed when'),
    can_create: tr('Can be created when'),
    can_start: tr('Can start when'),
    trigger: 'Conditions',
    is_highlighted: tr('Highlighted when'),
    valid: tr('Stays valid while'),
    is_valid_target: tr('Valid targets'),
    can_be_picked_artifact: tr('Can be picked when'),
    ai_potential: tr('AI considers it when'),
    is_available_on_create: tr('Offered when creating a faith if')
};

/** AI weight blocks (read by cards/weight.ts, edited with the field set `weight`: parts under a condition with "When…"). */
const WEIGHT_SECTIONS: Record<string, string> = {
    ai_will_do: tr('How much the AI wants it'),
    ai_accept: tr('How willing the AI is to accept')
};

/**
 * A block that is a formula (`chance = { value = 1 multiply = 2 }`, `ai_value = { base = 10 modifier = { … } }`):
 * nothing but the statements of a script value or a weight. Read as a weight (`weight`: base / factor / modifiers) or a
 * value (`script_value`); its lines change with the picker like ai_will_do's.
 */
const FORMULA_KEYS = new Set([
    'value',
    'add',
    'subtract',
    'multiply',
    'divide',
    'min',
    'max',
    'base',
    'factor',
    'modifier',
    'opinion_modifier',
    'compare_modifier',
    'ai_value_modifier',
    'if',
    'else_if',
    'else',
    'round',
    'ceiling',
    'floor',
    'fixed_range',
    'integer_range',
    'desc',
    'format',
    'abs',
    'save_temporary_value_as',
    'save_temporary_scope_as'
]);
const FORMULA_OPS = /^(value|add|subtract|multiply|divide|base|factor|modifier|opinion_modifier|compare_modifier|ai_value_modifier|if)$/;
const WEIGHT_KEYS = /^(base|factor|modifier|opinion_modifier|compare_modifier|ai_value_modifier)$/;

/**
 * A line for a hover card, which shows no line's children: a head whose children are a few short lines with none of
 * their own gets them after it ("If not: …: 0", "Otherwise: +50", a script value's branches), so its value is not
 * lost; a head that keeps more under it gets " …".
 */
function foldForCard(l: Line): Line
{
    const kids = (l.children ?? []).filter((c) => !c.hidden);

    if (!kids.length)
        return l;

    const leaves = kids.every((c) => !c.children?.length && !c.conditions?.length);
    const joined = kids.flatMap((c, i) => (i ? [', ', ...c.text] : c.text));

    if (leaves && kids.length <= 3 && richToString(joined).length <= 60)
        return { ...l, text: rich(l.text, ' ', joined), children: undefined };

    return { ...l, text: rich(l.text, ' …'), children: undefined };
}

/**
 * A hover card's lines: nested ones shown, opened, while `budget` rows last ("The target:" with its five conditions,
 * not "The target: …"), a short list of leaves in one row (foldForCard); past the budget a group folds ("text …") and
 * a list cut short ends in "…".
 */
function linesForCard(lines: Line[], budget: number): Line[]
{
    let left = budget;
    const walk = (ls: Line[]): Line[] =>
    {
        const shown = ls.filter((l) => !l.hidden);
        const out: Line[] = [];

        for (const l of shown)
        {
            if (left <= 0)
            {
                out.push({ text: ['…'] });
                break;
            }

            left--;
            const kids = (l.children ?? []).filter((c) => !c.hidden);
            const conditions = l.conditions?.length && left > 0 ? walk(l.conditions) : undefined;
            const folded = kids.length ? foldForCard(l) : undefined;

            // (no nested rows, or a few short leaves read in the line itself: "Has the trait: Brave, Craven")
            if (!folded || !richToString(folded.text).endsWith(' …'))
            {
                out.push({ ...(folded ?? l), collapsed: false, conditions, children: undefined });
                continue;
            }

            const children = left > 0 ? walk(kids) : undefined;
            out.push(children?.length ? { ...l, collapsed: false, conditions, children } : { ...folded, conditions });
        }

        return out;
    };
    return walk(lines);
}

function formulaOf(c: PNode): 'weight' | 'script_value' | undefined
{
    if (!Array.isArray(c.v) || !c.v.length || c.v.some((x) => !x.k || !FORMULA_KEYS.has(x.k)) || !c.v.some((x) => FORMULA_OPS.test(x.k!)))
        return undefined;

    return c.v.some((x) => WEIGHT_KEYS.test(x.k!)) ? 'weight' : 'script_value';
}

const EFFECT_SECTIONS: Record<string, string> = {
    effect: 'Effects',
    immediate: 'Immediately',
    on_accept: tr('When accepted'),
    on_decline: tr('When declined'),
    on_send: tr('When sent'),
    on_auto_accept: tr('When accepted automatically'),
    on_blocked_effect: tr('When blocked'),
    on_complete: tr('On completion'),
    on_start: tr('At the start'),
    on_end: tr('At the end'),
    on_success: tr('On success'),
    on_failure: tr('On failure'),
    on_invalidated: tr('When it becomes invalid'),
    on_monthly: tr('Every month'),
    on_yearly: tr('Every year'),
    on_activate: tr('When activated'),
    on_deactivate: tr('When deactivated'),
    after: 'Afterwards',
    on_enter: tr('When entering'),
    on_leave: tr('When leaving'),
    on_death: tr('On death'),
    on_become_head: tr('On becoming head')
};

/** Types whose script runs with a character as root (a scope hint for adding statements). */
const CHARACTER_ROOT = new Set(['traits', 'decisions', 'character_interactions', 'lifestyle_perks', 'focuses', 'schemes/scheme_types', 'secret_types', 'hook_types', 'characters']);

/** A scope as the .info files name it ("root ( Faith )") → the picker's scope type. */
const SCOPE_NAMES: Record<string, string> = {
    character: 'character',
    faith: 'faith',
    culture: 'culture',
    'landed title': 'landed_title',
    title: 'landed_title',
    ruler: 'character',
    holder: 'character',
    province: 'province',
    dynasty: 'dynasty',
    'dynasty house': 'dynasty_house',
    house: 'dynasty_house',
    artifact: 'artifact',
    scheme: 'scheme',
    secret: 'secret',
    war: 'war',
    activity: 'activity',
    army: 'army'
};

/**
 * Condition blocks of types whose .info documents them in a layout the `### Brief:` scan does not see
 * (casus_belli_types/_casus_belli.info: `allowed_for_character = { ... }` under a comment naming the roots).
 */
/** Blocks that only a trigger is made of: a block whose statements are all these reads as conditions. */
const CONDITION_LOGIC = new Set(['AND', 'OR', 'NOT', 'NOR', 'NAND', 'trigger_if', 'trigger_else_if', 'trigger_else', 'custom_description', 'calc_true_if']);

/** A setting block named as a condition: `is_location_valid`, `can_pick`, `trigger`, `limit`, `potential`, `ai_will_do_trigger`. */
const CONDITION_KEY = /^(is_\w+|can_\w+|trigger|limit|potential|allow|\w+_trigger)$/;

/** The keys of a text with its variants (descLines). */
const DESC_KEYS = new Set(['desc', 'first_valid', 'random_valid', 'triggered_desc']);

const INFO_CONDITION_BLOCKS: Record<string, Record<string, ConditionBlock>> = {
    casus_belli_types: {
        allowed_for_character: { title: tr('Attacker may use it when'), scope: 'character' },
        allowed_for_character_display_regardless: { title: tr('Attacker may use it when (shown even if it fails)'), scope: 'character' },
        allowed_against_character: { title: tr('Can be used against a character when'), scope: 'character' },
        allowed_against_character_display_regardless: { title: tr('Can be used against a character when (shown even if it fails)'), scope: 'character' },
        valid_to_start: { title: tr('To start the war'), scope: 'character' },
        valid_to_start_display_regardless: { title: tr('To start the war (shown even if it fails)'), scope: 'character' },
        should_invalidate: { title: tr('The war ends when') },
        mutually_exclusive_titles: { title: tr('Only one title can be targeted when') },
        is_allowed_claim_title: { title: tr('A title can be claimed when'), scope: 'landed_title' },
        ai_can_target_all_titles: { title: tr('The AI may target any title when'), scope: 'character' }
    }
};

/** A condition block of a type: its section's title, the scope its root is (its .info's "root ( Faith )"). */
export interface ConditionBlock
{
    title: string;
    scope?: string;
    /** what the .info says it is for (its comment lines) */
    about?: string;
}

/** Context strings that mean "this fires the event". */
/** Portrait toggles written `= yes` (the game's events/_events.info). */
const PORTRAIT_FLAGS = new Set(['hide_info', 'animate_if_dead', 'override_imprisonment_visuals', 'remove_default_outfit']);

/** a weight written as the key (`20 = some_on_action`) */
const NUMERIC_KEY = /^\d+(\.\d+)?$/;
// (also the keys that end in on_action: council tasks' monthly_on_action, travel options' on_start_on_action / on_arrival_on_action, travel_planner_cancel …)
const FIRES = /trigger_event|(^| › )(events|random_events|first_valid|fallback|on_actions|random_on_actions|random_on_action|first_valid_on_action|\w+_on_action)( › |$)/;

/** the last key of a reference's context names an event: an upper-case macro argument, or a key with "event" or "id" in it */
const EVENT_ARG = /(^|› )([A-Z][A-Z0-9_]*|\w*[Ee]vent\w*|id)$/;

/** A text of the game showing a name form, split around it (StoryBuilder.nameExample). */
export interface NameExample
{
    /** its loc key */
    key: string;
    before: string;
    after: string;
    /** the form is written capitalized there (|U, or at the start) */
    cap: boolean;
}

/** Where a stat modifier is given (ModifierKeyInfo.kinds). */
type ModKind = keyof NonNullable<ModifierKeyInfo['kinds']>;

/**
 * The effects and triggers giving a modifier entry (common/modifiers) to something, by what they give it to (the
 * reference's context; vanilla 1.20.1 uses add_artifact_modifier ~2400 times, add_scheme_modifier ~760,
 * add_house_modifier ~100, add_travel_plan_modifier ~70, add_dynasty_modifier ~40: grep counts). house_unity is the house's.
 */
const MODIFIER_GIVEN: [RegExp, Exclude<ModKind, 'other'>][] = [
    [/(^|›\s*)(add|remove|has)_character_modifier/, 'character'],
    [/(^|›\s*)(add|remove|has)_county_modifier/, 'landed_title'],
    [/(^|›\s*)(add|remove|has)_province_modifier/, 'province'],
    [/(^|›\s*)(add|remove|has)_scheme_modifier/, 'scheme'],
    [/(^|›\s*)(add|remove|has)_travel_plan_modifier/, 'travel_plan'],
    [/(^|›\s*)(add|remove|has)_artifact_modifier/, 'artifact'],
    [/(^|›\s*)(add|remove|has)_dynasty_modifier/, 'dynasty'],
    [/(^|›\s*)(add|remove|has)_house(_unity)?_modifier/, 'dynasty_house']
];

/** The `*_modifier` blocks whose numbers are not stats (an AI weight, an opinion). */
const NOT_STATS = /^(ai_value|opinion|has_opinion|compare)_modifier$/;

/**
 * What the modifier list reads of a trait's or a modifier entry's body (StoryBuilder.modifierKeys): a walk of its
 * syntax only. What depends on meaning (is a key a stat: formats and localization; who is a modifier given to:
 * references) is looked up per StoryBuilder.
 */
interface HolderScan
{
    /** the string-valued keys at the top and inside every `*_modifier` block, as written (the counts) */
    counted: string[];
    /** the string-valued keys at the top and inside the stat blocks, with the scope of the block they are in (null:
     * the body's own: a trait's character, a modifier entry's by the effects giving it) */
    leaves: [string, ModKind | null][];
}

/** What the modifier list reads of another type's body: its top-level modifier blocks' keys with their scope. */
interface BlockScan
{
    /** it has a top-level `modifier` / stat `*_modifier` block (the types whose first 40 entries have one are read) */
    hasBlock: boolean;
    leaves: [string, ModKind][];
}

/**
 * The scans by the Def object read (null: no block). A Def of a file an update did not change survives it
 * (GameIndex.refreshFiles drops a changed file's Defs and makes new ones), so the StoryBuilder made after an update
 * parses only the definitions of changed files again. Keys are own copies (ownCopy), not slices of the file text.
 */
const HOLDER_SCANS = new WeakMap<Def, HolderScan | null>();
const BLOCK_SCANS = new WeakMap<Def, BlockScan | null>();

/** The keys of a stat block and the blocks in it, each block's own scope (modifierScopeOf) or the one around it. */
function statLeaves<K extends ModKind | null>(list: PNode[], kind: K, out: [string, ModKind | K][]): void
{
    for (const c of list)
    {
        if (!c.k)
            continue;

        if (typeof c.v === 'string')
            out.push([ownCopy(c.k), kind]);
        else if (/_modifier$/.test(c.k) && !NOT_STATS.test(c.k))
            statLeaves(c.v, modifierScopeOf(c.k) ?? kind, out);
    }
}

/**
 * A modifier block's kind on its lines (docs/picker.md, "Modifiers and settings"): a modifier line's anchor carries the
 * kind of the block it is written in (the section's, or a `*_modifier` row's innerScope), so "＋ Add after this line"
 * and ✎ on it offer that kind's list, as the section's ＋ and ⤷＋ on the block row do. `kind`: the block's kind around
 * the lines, undefined when unknown (the lines keep what they carry). A block row of unknown kind gives its lines none
 * and keeps its own scope (so ⤷＋ inside it offers no kind either). `own`: the section's block, when it is one of its
 * lines' (a travel option's single travel_modifier): that row is written outside the block, so it keeps its scope and
 * only its lines get the kind.
 */
function modifierKindsDown(lines: Line[], kind: string | undefined, own?: LineSource): void
{
    for (const l of lines)
    {
        const s = l.src;
        const mod = s?.kind === 'modifier';
        const isOwn = !!(own && s && s.file === own.file && s.s === own.s && s.e === own.e);

        if (mod && kind && s.scope !== kind && !isOwn && !(s.inner && !s.innerScope))
            l.src = { ...s, scope: kind };

        if (l.children?.length)
            modifierKindsDown(l.children, isOwn ? kind : mod && s.inner ? s.innerScope : kind);
    }
}

function holderScanOf(body: PNode[]): HolderScan
{
    const counted: string[] = [];
    const count = (list: PNode[]): void =>
    {
        for (const c of list)
        {
            if (!c.k)
                continue;

            if (typeof c.v === 'string')
                counted.push(ownCopy(c.k));
            else if (/_modifier$/.test(c.k))
                count(c.v);
        }
    };
    count(body);
    const leaves: [string, ModKind | null][] = [];
    statLeaves(body, null, leaves);
    return { counted, leaves };
}

/** `type`: the definition's index type (a raid intent's top-level `modifier` is an army's: modifierScopeOf) */
function blockScanOf(body: PNode[], type: string): BlockScan
{
    const isBlock = (c: PNode): boolean => !!c.k && Array.isArray(c.v) && (c.k === 'modifier' || /_modifier$/.test(c.k)) && !NOT_STATS.test(c.k);
    const leaves: [string, ModKind][] = [];

    for (const c of body)
        if (isBlock(c))
            statLeaves(c.v as PNode[], modifierScopeOf(c.k!, type) ?? 'other', leaves);

    return { hasBlock: body.some(isBlock), leaves };
}

/** "1 days" → "1 day" (the text after a number the template writes: `Takes $ days to build`). */
function oneUnit(v: string, after: string): string
{
    return v === '1' ? after.replace(/^ (day|week|month|year)s\b/, ' $1') : after;
}

/** Field sets that are a block inside other types' definitions: where "Other setting…" reads their keys and values. */
const NESTED_SETS: Record<string, { types: string[]; block: string; }> = {
    special_parameters: { types: ['religion/doctrine_types', 'religion/tenet_types'], block: 'special_parameters' }
};

// ---------------------------------------------------------------------------
// Where a saved scope is in reach (PickTarget.reach, docs/picker.md "Scopes in reach")
// ---------------------------------------------------------------------------

/**
 * The order an event's parts run in (_events.info): `trigger` (and the on_action's weight) first, then `immediate`
 * (or `on_trigger_fail` instead), then the window (its texts, portraits and options: 2, the default), `after` last.
 */
const EVENT_PHASE: Record<string, number> = { trigger: 0, weight_multiplier: 0, immediate: 1, on_trigger_fail: 1, after: 3 };
const phaseOf = (k: string): number => EVENT_PHASE[k] ?? 2;

/**
 * The event parts the in-place editor creates (EventStory.sections, "＋ option"): ScopeReach.keys. A new trigger,
 * immediate or after only while the event has none; a new option always. (No path asks the picker for a new option
 * today: "New option" opens the script editor with a template; the key is there so a picker for one gets the same
 * rule as the written parts.)
 */
const CREATED_PARTS = ['trigger', 'immediate', 'option', 'after'];

/**
 * The order other entry types' parts run in, where the type's .info says it (docs/picker.md "Scopes in reach"): the
 * conditions that decide whether the entry can be taken or sent (0) run before its effects (1). A lasting save in an
 * effect part is not in reach in a condition part; effect parts among themselves stay in reach of each other (their
 * order is not given for all of them). A key not listed has no known order: a save there, and a save elsewhere seen
 * from there, stays in reach. Each row is cited from the game's 1.20 .info (read 2026-11-10); rows the .info does not
 * support are left out (a decision's cost, widget and alert trigger, an interaction's ai_accept, auto_accept, cost,
 * redirect …).
 */
const TYPE_PHASE: Record<string, Record<string, number>> = {
    decisions: {
        // _decisions.info:212-222 "Who *might* take this decision? Check if this decision should even be presented as an option"
        is_shown: 0,
        // :224-235 "Who *could* actually take this decision? Check if this a character can actual take this decision"
        is_valid: 0,
        // :237-248 the same, "with limited tooltip"
        is_valid_showing_failures_only: 0,
        // :283 "trigger whether the AI should look at it or not"
        ai_potential: 0,
        // :284 "Returns the % chance of executing the decision"
        ai_will_do: 0,
        // :281 "effect to execute when decision is taken"
        effect: 1
    },
    character_interactions: {
        // _character_interactions.info:249-257 "Is the interaction available and visible"
        is_shown: 0,
        // :259-263 and :265-269 "Is the interaction valid to be selected in it's current setup"; :289-290 "If
        // evaluated false, will proceed to run on_send / on_accept immediately when selected": selected, then sent
        is_valid_showing_failures_only: 0,
        is_valid: 0,
        // :271-275 "Is the target valid", :277-287 "Can this character / title / artifact / regiment be picked as a
        // valid target" (picked in the window before it is sent)
        has_valid_target_showing_failures_only: 0,
        has_valid_target: 0,
        can_be_picked: 0,
        can_be_picked_title: 0,
        can_be_picked_artifact: 0,
        can_be_picked_regiment: 0,
        // :298-299 "Can the interaction be sent?"
        can_send: 0,
        // :315-323 "Everyone sorted into the list 'characters' has the potential of being shown to be selected"
        populate_actor_list: 0,
        populate_recipient_list: 0,
        // :335-379 an option of the window ("Trigger for whether this should be on when the window opens", :357-359)
        send_option: 0,
        // :577-583 "Will the ai consider trying this interaction"
        ai_potential: 0,
        // :585-588 "Is this interaction available for the actor, both AI and player"
        is_available: 0,
        // :600-605 "How interested is the ai in sending this interaction (tested after selecting targets)"
        ai_will_do: 0,
        // :392-424 the effects: "Executes directly the interaction is sent", "Executes when accepted by recipient" …
        on_send: 1,
        on_accept: 1,
        on_decline: 1,
        on_blocked_effect: 1,
        pre_auto_accept: 1,
        on_auto_accept: 1,
        on_intermediary_accept: 1,
        on_intermediary_decline: 1
    },
    // (read 2026-11-15; the parts checked while the entry runs, `valid`, `is_valid`, `should_invalidate`, and the
    // chances and AI values have no known order: not listed)
    'schemes/scheme_types': {
        // _schemes.info:29 "When this scheme can be started" (:28 "scope:scheme (not set when starting)")
        allow: 0,
        // :92-117 "All scheme effects below …": started, a phase completed, monthly, twice a year, invalidated, the hud click
        on_start: 1,
        on_phase_completed: 1,
        on_hud_click: 1,
        on_monthly: 1,
        on_semiyearly: 1,
        on_invalidated: 1
    },
    casus_belli_types: {
        // _casus_belli.info:68-79: who may use it, against whom, whether the war can start, which claims it may press
        // (each with its `_display_regardless` form)
        allowed_for_character: 0,
        allowed_for_character_display_regardless: 0,
        allowed_against_character: 0,
        allowed_against_character_display_regardless: 0,
        valid_to_start: 0,
        valid_to_start_display_regardless: 0,
        is_allowed_claim_title: 0,
        // :50-54 the war's effects: declared, won, white peace, lost, invalidated
        on_declaration: 1,
        on_victory: 1,
        on_white_peace: 1,
        on_defeat: 1,
        on_invalidated: 1
    },
    'activities/activity_types': {
        // _activity_type.info:9-47 "Should the player see this activity type", "Can this activity be picked", "Can this
        // activity be planned" (root = the character trying to host it)
        is_shown: 0,
        can_start: 0,
        can_start_showing_failures_only: 0,
        can_plan: 0,
        // :67 "Ran if the activity fails the is valid checks", :76 the host's death, :800-891 the state changes and
        // pulses, the start and the completion
        on_invalidated: 1,
        on_host_death: 1,
        on_enter_travel_state: 1,
        on_enter_passive_state: 1,
        on_enter_active_state: 1,
        on_leave_travel_state: 1,
        on_leave_passive_state: 1,
        on_leave_active_state: 1,
        on_travel_state_pulse: 1,
        on_passive_state_pulse: 1,
        on_active_state_pulse: 1,
        on_start: 1,
        on_complete: 1
    }
};

/** An option's own blocks the game evaluates apart from its effects: a temporary scope saved there ends with them. */
const OPTION_PARTS = new Set(['trigger', 'show_as_unavailable', 'ai_chance', 'name', 'highlight_portrait']);

/**
 * The types with a builder of their own that are script, not settings (docs/readable-view.md, "Settings"): their
 * cards get no lines for the written keys they do not read (genes and the gene values of DNA and bookmark portraits too;
 * the guest system's blocks are effects).
 */
const CODE_LIKE = new Set(['genes', 'dna_data', 'bookmark_portraits', 'guest_system', 'scripted_modifiers', 'scripted_rules', 'scripted_costs', 'scripted_lists', 'scripted_animations']);

/**
 * The builder types whose entries the game writes with no top-level `key = scalar` (vanilla 1.20, lane H1's survey):
 * lists of bare values (name equivalents, colour numbers, motto inserts, template lists) or only blocks. A mod's own
 * entry of one gets no empty Settings section: "Other setting…" there would write a key into a list.
 */
const NO_TOP_SCALARS = new Set([
    'succession_election', 'diarchies/diarchy_mandates', 'culture/name_equivalency', 'graphical_unit_types', 'dynasty_house_motto_inserts',
    'dynasty_legacies', 'courtier_guest_management', 'guest_system', 'achievements', 'artifacts/feature_groups', 'situation/catalysts',
    'struggle/catalysts', 'event_backgrounds', 'event_transitions', 'event_2d_effects', 'event_themes', 'named_colors', 'portrait_types',
    'console_groups', 'ai_goaltypes', 'coat_of_arms/dynamic_definitions', 'coat_of_arms/template_lists'
]);

/** Entry types whose definition is one script (run from the caller's): a temporary scope reaches its end. */
const ONE_SCRIPT = new Set(['scripted_effects', 'scripted_triggers', 'script_values', 'scripted_modifiers']);

/**
 * A `save_scope_as` / `save_temporary_scope_as` in a definition: the top-level part holding it (`section`; the
 * definition itself for a save at its top) and the block a temporary one ends with (`part`: the section, an option's
 * trigger …, a one-script definition's whole text).
 */
export interface SaveSite
{
    name: string;
    temporary: boolean;
    node: PNode;
    section: PNode;
    part: PNode;
    /** a list a called scripted effect / trigger adds: the one whose text adds it (SavedName.by) */
    by?: string;
}

/**
 * What saveSites collects: saved scopes (`save_scope_as`, `save_temporary_scope_as`), saved values
 * (`save_scope_value_as`, `save_temporary_scope_value_as`, the name from the block's `name`) or lists (`add_to_list`,
 * `add_to_temporary_list`).
 */
export type SaveKind = 'scope' | 'value' | 'list';

/** A name a statement adds (a list a called scripted effect adds: SaveSites' `calls`). */
export interface SavedName
{
    name: string;
    temporary: boolean;
    /** the scripted effect / trigger whose text adds it */
    by?: string;
}

/**
 * The names a call adds (saveSites), its parameters filled in (exported for scripts/targets-check.ts): a callee's name
 * written with a parameter (`add_to_list = $LIST$`, `temp$LIST$`) takes the value the call gives it (`LIST = foo`;
 * `$OUTER$` passed on stays one, for the caller's own caller); a name whose parameter the call does not give (a call
 * `= yes`, the parameter left out, a block as its value) is dropped: it is no name the caller has.
 */
export function fillParams(adds: readonly SavedName[], call: PNode): SavedName[]
{
    const args = Array.isArray(call.v) ? call.v : [];
    const out: SavedName[] = [];

    for (const a of adds)
    {
        if (!a.name.includes('$'))
        {
            out.push(a);
            continue;
        }

        let missing = false;
        const name = a.name.replace(/\$(\w+)\$/g, (_m, p: string) =>
        {
            const v = args.find((c) => c.k === p)?.v;

            if (typeof v !== 'string' || !v)
                missing = true;

            return typeof v === 'string' ? v : '';
        });

        if (!missing && /^[\w$]+$/.test(name))
            out.push({ ...a, name });
    }

    return out;
}

/** The names a statement saves of a kind (saveSites): none, or the save's own (a call: the callee's, from `calls`, its parameters filled in). */
function savedBy(n: PNode, kind: SaveKind, calls?: ReadonlyMap<string, readonly SavedName[]>): readonly SavedName[] | undefined
{
    if (kind === 'scope')
        return (n.k === 'save_scope_as' || n.k === 'save_temporary_scope_as') && typeof n.v === 'string' ? [{ name: n.v, temporary: n.k === 'save_temporary_scope_as' }] : undefined;

    if (kind === 'value')
    {
        if ((n.k !== 'save_scope_value_as' && n.k !== 'save_temporary_scope_value_as') || !Array.isArray(n.v))
            return undefined;

        const name = n.v.find((c) => c.k === 'name' && typeof c.v === 'string')?.v;
        return typeof name === 'string' && name ? [{ name, temporary: n.k === 'save_temporary_scope_value_as' }] : [];
    }

    if ((n.k === 'add_to_list' || n.k === 'add_to_temporary_list') && typeof n.v === 'string')
        return [{ name: n.v, temporary: n.k === 'add_to_temporary_list' }];

    const got = n.k ? calls?.get(n.k) : undefined;
    return got && fillParams(got, n);
}

/**
 * Every save of a definition's script, each name as often as it is saved (reachOf; exported for scripts/targets-check.ts):
 * its scopes, values or lists (`kind`); for lists also the calls of scripted effects / triggers that add some (`calls`:
 * a callee's name → the lists it adds, its own callees' too: the call is where they are added).
 */
export function saveSites(def: PNode, event: boolean, type: string, kind: SaveKind = 'scope', calls?: ReadonlyMap<string, readonly SavedName[]>): SaveSite[]
{
    const out: SaveSite[] = [];
    // (`top`: the list is the section's own: an option's trigger, ai_chance … start a part of their own there)
    const walk = (list: PNode[], section: PNode, part: PNode, top: boolean): void =>
    {
        for (const n of list)
        {
            const saved = savedBy(n, kind, calls);

            if (saved)
            {
                for (const s of saved)
                    out.push({ name: s.name, temporary: s.temporary, node: n, section, part, ...(s.by ? { by: s.by } : {}) });
            }
            else if (Array.isArray(n.v))
                walk(n.v, section, top && event && section.k === 'option' && n.k && OPTION_PARTS.has(n.k) ? n : part, false);
        }
    };

    if (!Array.isArray(def.v))
        return out;

    for (const n of def.v)
    {
        const saved = savedBy(n, kind, calls);

        if (saved)
        {
            for (const s of saved)
                out.push({ name: s.name, temporary: s.temporary, node: n, section: def, part: def, ...(s.by ? { by: s.by } : {}) });
        }
        else if (Array.isArray(n.v))
            walk(n.v, n, ONE_SCRIPT.has(type) ? def : n, true);
    }

    return out;
}

/**
 * Where a name saved at `sites` is in reach, as file offsets (PickTarget.reach), as far as the game's documentation
 * and vanilla's use say (docs/picker.md "Scopes in reach"):
 * - a temporary save reaches the rest of the part of the script it is saved in (_script_values.info: "for the rest
 *   of this evaluation"; vanilla uses one in a later sibling block of the same `trigger`), not other parts;
 * - in an event a lasting save reaches the rest of its part and every part that runs later (EVENT_PHASE): `after`
 *   sees what an option saved, sibling options do not see each other's; a save in the window's other parts (a
 *   portrait's or a text's trigger) reaches the whole window, since their order is not known;
 * - in an entry of a type with a phase table (TYPE_PHASE: decisions, character interactions) a lasting save in a
 *   listed part reaches the rest of that part and everything else but the parts of an earlier phase (an effect's save
 *   is not in reach in is_shown); the text between the parts too, where a new block of a key not listed goes; a new
 *   block of an earlier phase's key (a new is_shown) is not in reach (ScopeReach.notKeys);
 * - in other entries a lasting save has no reach (in reach everywhere): the order their parts run in is not known.
 * The entry's type is ctx.entityType. Undefined: in reach everywhere.
 */
export function reachOf(sites: SaveSite[], def: PNode, event: boolean, ctx: Ctx): ScopeReach | undefined
{
    const f = ctx.file;
    const table = event || !ctx.entityType || !Object.hasOwn(TYPE_PHASE, ctx.entityType) ? undefined : TYPE_PHASE[ctx.entityType];

    if (!f || !sites.length || (!event && !table && sites.some((s) => !s.temporary)))
        return undefined;

    const m = f.map ?? ((o: number): number => o);
    const off = (o: number): number => f.start + m(o);
    const ranges: [number, number][] = [];
    const later: [number, number][] = [];
    const keys = new Set<string>();
    // (the table's parts that run before every lasting save: a new block of one is out of reach wherever it is put)
    let notKeys: Set<string> | undefined;
    const parts = event && Array.isArray(def.v) ? def.v.filter((n) => n.k && Array.isArray(n.v)) : [];

    for (const s of sites)
    {
        if (table && !s.temporary)
        {
            const earlier = phasedReach(s, def, table, off, ranges, later);
            notKeys = new Set(notKeys ? [...notKeys].filter((k) => earlier.includes(k)) : earlier);
            continue;
        }

        const end = s.temporary ? s.part : s.section;
        ranges.push([off(s.node.e), off(end.e)]);
        later.push([off(end.s), off(s.node.s)]);

        if (s.temporary || !event || s.section === def)
            continue;

        const p = phaseOf(s.section.k!);

        for (const y of parts)
        {
            if (y === s.section)
                continue;

            const q = phaseOf(y.k!);

            if (q > p || (p === 2 && q === 2 && s.section.k !== 'option'))
                ranges.push([off(y.s), off(y.e)]);
            else if (q < p)
                later.push([off(y.s), off(y.e)]);
        }

        // (a new block of a part that runs later, by the same rule as the written ones; another option always, since
        // there can be several, unless the save is an option's own: sibling options do not see each other's)
        for (const k of CREATED_PARTS)
        {
            const q = phaseOf(k);

            if ((q > p || (p === 2 && q === 2 && s.section.k !== 'option')) && (k === 'option' || !parts.some((y) => y.k === k)))
                keys.add(k);
        }
    }

    const sorted = (l: [number, number][]): [number, number][] => l.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    const r: ScopeReach = { file: f.file, def: [off(def.s), off(def.e)], ranges: sorted(ranges) };
    const l = sorted(later);

    if (l.length)
        r.later = l;

    if (keys.size)
        r.keys = [...keys];

    if (notKeys?.size)
        r.notKeys = [...notKeys];

    return r;
}

/** A key's phase in a TYPE_PHASE table (undefined: not listed; own keys only, `constructor` is no part). */
const phaseIn = (table: Record<string, number>, k: string): number | undefined => (Object.hasOwn(table, k) ? table[k] : undefined);

/**
 * reachOf for a lasting save in an entry with a phase table (TYPE_PHASE): the rest of its part, the other parts but the
 * ones of an earlier phase (they go to `later`), and the text between the parts. A save at the definition's top or in a
 * part the table does not list reaches the whole definition (its order is not known). Returns the table's keys of an
 * earlier phase (ScopeReach.notKeys: a new block of one, put between the parts, is not in reach either).
 */
function phasedReach(s: SaveSite, def: PNode, table: Record<string, number>, off: (o: number) => number, ranges: [number, number][], later: [number, number][]): string[]
{
    const p = s.section === def || !s.section.k ? undefined : phaseIn(table, s.section.k);

    if (p === undefined || !Array.isArray(def.v))
    {
        ranges.push([off(def.s), off(def.e)]);
        return [];
    }

    ranges.push([off(s.node.e), off(s.section.e)]);
    later.push([off(s.section.s), off(s.node.s)]);
    let from = def.vs;

    for (const y of def.v)
    {
        // (the text before it: a new block of a key the table does not list goes between the parts or at the end)
        ranges.push([off(from), off(y.s)]);
        from = y.e;

        if (y === s.section)
            continue;

        const q = y.k && Array.isArray(y.v) ? phaseIn(table, y.k) : undefined;

        if (q !== undefined && q < p)
            later.push([off(y.s), off(y.e)]);
        else
            ranges.push([off(y.s), off(y.e)]);
    }

    ranges.push([off(from), off(def.e)]);
    return Object.keys(table).filter((k) => table[k] < p);
}

/** The statements calling a scripted effect / trigger `name` in a definition's text (`name = yes`, `name = { … }`). */
function callsOf(list: PNode[], name: string, asValue = false, out: PNode[] = []): PNode[]
{
    // (a script value is called where it is written: as a value (`add_gold = name`, `value = name`, `scope:x.name`), as
    // a compared key (`name >= 5`, `scope:x.name > 1`) or with arguments (`value:name|A|1|`))
    const named = (s: string | null): boolean => s !== null && (s === name || s.endsWith(`.${name}`) || s.startsWith(`value:${name}|`));

    for (const n of list)
    {
        if (n.k === name || (asValue && (named(n.k) || (typeof n.v === 'string' && named(n.v)))))
            out.push(n);
        else if (Array.isArray(n.v))
            callsOf(n.v, name, asValue, out);
    }

    return out;
}

/**
 * The names in a definition's text that hold values or flags, not someone (ownTargets; a calling event's names it only
 * uses, StoryBuilder.castTargetsOf): save_scope_value_as, an interaction's option flags, `scope:x = yes`,
 * `scope:x = flag:y`.
 */
function valueNames(text: string): Set<string>
{
    return new Set([
        ...[...text.matchAll(/save_(?:temporary_)?scope_value_as\s*=\s*\{[^}]*?\bname\s*=\s*(\w+)/g)].map((m) => m[1]),
        ...[...text.matchAll(/\bflag\s*=\s*(\w+)/g)].map((m) => m[1]),
        ...[...text.matchAll(/\bscope:(\w+)\s*(?:=|>=|<=|>|<|!=)\s*(?:yes|no|-?\d|flag:)/g)].map((m) => m[1])
    ]);
}

/**
 * The time a card may spend reading a scripted effect's / trigger's callers for its scopes (StoryBuilder.callerTargets,
 * StoryBuilder.callerBudget), in ms: every caller is read until it runs out; past it the rest of the references stay
 * unread and the list "not known". Set from cast-check's times on vanilla (docs/picker.md, "A scripted effect's /
 * trigger's callers").
 */
const CALLERS_READ = 400;

/** a script that sets a variable that is no local one (StoryBuilder.globalVarType reads only those of the references) */
const SET_VARIABLE = /\bset_(global_)?variable\b/;

/** The time a card may spend reading a scripted effect's / trigger's callers for their lists (StoryBuilder.callerLists), in ms. */
const LIST_CALLERS_MS = 100;

/**
 * The Summary's "Changed by <mod>" section (StoryBuilder.modChanges). Hidden for the 0.3.0 release (the owner,
 * 2026-11-16): a changed setting written as a block reads as its raw script, comments and all (traits:brave with A Game
 * of Thrones: `Culture modifier: { parameter = … #AGOT Added …}`); docs/todo.md.
 */
const SHOW_MOD_CHANGES = false;

/** A list a scripted effect / trigger adds (StoryBuilder.calledLists): `by`, the one whose text adds it. */
interface ListAdd extends SavedName
{
    by: string;
}

/** One calledLists walk: each scripted effect / trigger read once (null while it is read), `ring` set when one calls back into an open one. */
interface ListWalk
{
    lists: Map<number, ListAdd[] | null>;
    ring: boolean;
}

/** Entry types with no targets of their own (StoryBuilder.ownTargets): an event's and an on_action's come elsewhere. */
const NO_OWN_TARGETS = new Set(['characters', 'localization', 'images', 'models', 'flag', 'variable', 'events', 'on_action']);

/** An entry other scripts call (a scripted effect / trigger / modifier / list / relation …, a script value): its scopes are its callers'. */
const isCalledType = (type: string): boolean => type.startsWith('scripted_') || type === 'script_values';

/** Caller results of a scripted effect / trigger (StoryBuilder.callerTargets) with what was read. */
export interface CallerTargets
{
    targets: PickTarget[];
    known: boolean;
    /** the names only callers' used-only names gave (each source a name the caller uses without a save) */
    usedOnly: Set<string>;
    /** references looked at / of them callers (their text calls it) / all references */
    looked: number;
    read: number;
    refs: number;
    /** the time budget ran out before every reference was looked at */
    cut: boolean;
}

export class StoryBuilder
{
    readonly idx: GameIndex;
    readonly d: Describer;
    /** what a character text code prints for the sample character (LocExamples, set by the index worker) */
    locExample?: (chain: string) => string | undefined;
    /** a historical character's family (history/characters.ts `familyTree`; the worker sets it) */
    familyOf?: (id: string) => FamilyTree | null;
    /** a loaded save's character's family (the save's own characters, docs/saves.md; the worker sets it) */
    saveFamilyOf?: (id: string) => FamilyTree | null;
    /** the `.gui` definitions calling a scripted GUI (the GUI library, set by the index worker) */
    guiUsers?: (name: string) => GuiItem[];

    constructor(idx: GameIndex)
    {
        this.idx = idx;
        this.d = new Describer(idx);
        this.d.effectReaders.create_character = (n, ctx) => createCharacterLine(this, n, ctx);
        this.d.valueReader = (list, ctx) => valueLines(this, list, ctx);
        this.d.weightReader = (list, ctx) => weightLines(this, list, ctx);
    }

    private modifierList: ModifierKeyInfo[] | undefined;

    /**
     * Every stat modifier the game defines (modifier_definition_formats), most used first, counted in the definitions
     * that hold modifiers (traits, modifiers, and their nested `*_modifier` blocks). Hidden ones are left out.
     */
    modifierKeys(): ModifierKeyInfo[]
    {
        if (this.modifierList)
            return this.modifierList;

        const counts = new Map<string, number>();

        for (const type of ['traits', 'modifiers'])
            for (const item of this.idx.list(type))
                for (const k of this.holderScan(this.idx.get(type, item.name))?.counted ?? [])
                    counts.set(k, (counts.get(k) ?? 0) + 1);

        const kinds = this.modifierKinds();
        const out: ModifierKeyInfo[] = [];

        for (const item of this.idx.list('modifier_definition_formats'))
        {
            const f = this.d.modifierFormat(item.name);

            if (f.hidden)
                continue;

            const k = kinds.get(item.name);
            // (the game's area file it is defined in: the picker groups by it)
            const area = item.file ? modifierAreaOf(item.file) : undefined;
            out.push({ key: item.name, label: f.label, percent: f.percent, alreadyPercent: f.alreadyPercent || undefined, color: f.color, count: counts.get(item.name) ?? 0, ...(k ? { kinds: k } : {}), ...(area ? { area } : {}) });
        }

        out.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
        return (this.modifierList = out);
    }

    /**
     * Where the game puts each stat modifier (docs/picker.md, "Modifiers and settings"), with how often: a trait's own
     * modifiers and every `*_modifier` block by its key (`modifierScopeOf`: character_modifier, county_modifier,
     * province_modifier …) in the definitions of every type; a modifier entry (common/modifiers) by the effects giving
     * it (add_character_modifier, add_county_modifier, add_province_modifier …: its references' contexts).
     */
    private modifierKinds(): Map<string, NonNullable<ModifierKeyInfo['kinds']>>
    {
        const out = new Map<string, NonNullable<ModifierKeyInfo['kinds']>>();
        const bump = (key: string, kind: ModKind): void =>
        {
            if (!this.d.isModifierKey(key))
                return;

            const k = out.get(key) ?? out.set(key, {}).get(key)!;
            k[kind] = (k[kind] ?? 0) + 1;
        };
        const walk = (leaves: readonly (readonly [string, ModKind | null])[], kind: ModKind): void =>
        {
            for (const [key, at] of leaves)
                bump(key, at ?? kind);
        };

        for (const name of this.idx.names('traits'))
            walk(this.holderScan(this.idx.get('traits', name))?.leaves ?? [], 'character');

        // a modifier entry: by the effects giving it (add_county_modifier → a county's …)
        for (const name of this.idx.names('modifiers'))
        {
            const e = this.idx.get('modifiers', name);
            const scan = this.holderScan(e);

            if (!e || !scan)
                continue;

            // (given to both a character and a county …: each; given by nothing the index sees: other)
            const given = this.modifierGiven(e);

            for (const k of given.size ? given : ['other' as const])
                walk(scan.leaves, k);
        }

        // every other type's modifier blocks (buildings, laws, traditions, doctrines, innovations …): the types whose
        // first definitions have one (reading every definition of every type takes seconds)
        for (const t of this.idx.types(false))
        {
            if (['traits', 'modifiers', 'characters', 'events', 'on_action', 'localization', 'flag', 'variable', 'images', 'models', 'scripted_effects', 'scripted_triggers', 'script_values'].includes(t.id))
                continue;

            const names = this.idx.names(t.id);

            if (!names.slice(0, 40).some((name) => this.blockScan(this.idx.get(t.id, name))?.hasBlock))
                continue;

            for (const name of names)
                for (const [key, at] of this.blockScan(this.idx.get(t.id, name))?.leaves ?? [])
                    bump(key, at);
        }

        return out;
    }

    /** A trait's or a modifier entry's ModScan (HOLDER_SCANS), read from its winning definition on a miss. */
    private holderScan(e: Entity | undefined): HolderScan | null
    {
        const def = e && this.idx.winningDef(e);

        if (!def)
            return null;

        let scan = HOLDER_SCANS.get(def);

        if (scan === undefined)
        {
            const d = this.idx.defNode(e!);
            scan = d && Array.isArray(d.node.v) ? holderScanOf(d.node.v) : null;
            HOLDER_SCANS.set(def, scan);
        }

        return scan;
    }

    /** Another type's definition's modifier blocks (BLOCK_SCANS), read from its winning definition on a miss. */
    private blockScan(e: Entity | undefined): BlockScan | null
    {
        const def = e && this.idx.winningDef(e);

        if (!def)
            return null;

        let scan = BLOCK_SCANS.get(def);

        if (scan === undefined)
        {
            const d = this.idx.defNode(e!);
            scan = d && Array.isArray(d.node.v) ? blockScanOf(d.node.v, e!.type) : null;
            BLOCK_SCANS.set(def, scan);
        }

        return scan;
    }

    /**
     * The values and list names in reach of a definition's script (EntityCard.values / lists, the value editor's
     * suggestions, components/valueKinds.ts), each with where it is in reach (reachOf, as for its saved scopes: an
     * event's option does not see a sibling option's): `save_scope_value_as` / `save_temporary_scope_value_as` with
     * their value as written; the lists it adds to (`add_to_list` / `add_to_temporary_list`), the ones the scripted
     * effects / triggers it calls add (calledLists: in reach from the call on), and for a scripted effect / trigger
     * the ones its callers add (callerLists: in reach everywhere in it).
     */
    private savedNames(e: Entity, card: EntityCard): void
    {
        const def = this.forTooltip ? undefined : this.idx.defNode(e);

        if (!def)
            return;

        const event = e.type === 'events';
        const ctx = rootCtx(def.src, this.idx.defAnchor(e), this.rootScopeOf(e.type));
        ctx.entityType = e.type;
        const node = def.node;
        const values: PickTarget[] = [];
        // (a name written with a parameter, `$LIST$`, is a name only inside the scripted effect / trigger itself: its
        // callers have the value they pass, fillParams)
        const named = e.type === 'scripted_effects' || e.type === 'scripted_triggers' ? (): boolean => true : (s: SaveSite): boolean => !s.name.includes('$');
        const valueSites = saveSites(node, event, e.type, 'value').filter(named);

        for (const s of valueSites)
        {
            if (values.some((v) => v.key === 'scope:' + s.name))
                continue;

            const v = Array.isArray(s.node.v) ? s.node.v.find((c) => c.k === 'value')?.v : undefined;
            const value = typeof v === 'string' ? v : undefined;
            const reach = reachOf(valueSites.filter((x) => x.name === s.name), node, event, ctx);
            values.push({
                key: 'scope:' + s.name,
                label: capitalize(humanize(s.name)),
                about: (value ? tr('a value saved here: {value}', { value }) : tr('a value saved here')) + (s.temporary ? tr(' (for a moment)') : ''),
                ...(reach ? { reach } : {})
            });
        }

        const lists: NonNullable<EntityCard['lists']> = this.ownLists(e, node, ctx);

        // (a scripted effect's / trigger's callers' lists: there from its start, so in reach everywhere in it)
        if (e.type === 'scripted_effects' || e.type === 'scripted_triggers')
        {
            for (const c of this.callerLists(e))
            {
                const names = c.by.slice(0, 3).join(', ') + (c.by.length > 3 ? ' …' : '');
                const about = tr('a list its callers add: {names}', { names });
                const i = lists.findIndex((l) => l.name === c.name);

                if (i < 0)
                    lists.push({ name: c.name, about });
                else
                    lists[i] = { name: c.name, about: `${lists[i].about} · ${about}` };
            }
        }

        if (values.length)
            card.values = values;

        if (lists.length)
            card.lists = lists;
    }

    /**
     * The lists a definition's script adds (`add_to_list` / `add_to_temporary_list`) and the ones the scripted effects /
     * triggers it calls add (calledLists: in reach from the call on), each with where it is in reach (reachOf); not its
     * callers' (savedNames adds those). A name written with a parameter counts only in a scripted effect / trigger.
     */
    private ownLists(e: Entity, node: PNode, ctx: Ctx): NonNullable<EntityCard['lists']>
    {
        const event = e.type === 'events';
        const named = e.type === 'scripted_effects' || e.type === 'scripted_triggers' ? (): boolean => true : (s: SaveSite): boolean => !s.name.includes('$');
        const calls = this.calledLists(this.body(node), { lists: new Map(), ring: false });
        const listSites = saveSites(node, event, e.type, 'list', calls).filter(named);
        const lists: NonNullable<EntityCard['lists']> = [];

        for (const s of listSites)
        {
            if (lists.some((l) => l.name === s.name))
                continue;

            const own = s.node.k === 'add_to_list' || s.node.k === 'add_to_temporary_list';
            const by = own ? undefined : s.by;
            const reach = reachOf(listSites.filter((x) => x.name === s.name), node, event, ctx);
            lists.push({
                name: s.name,
                about: (by ? tr('added by {effect}', { effect: by }) : tr('a list this entry adds to')) + (s.temporary ? tr(' (for a moment)') : ''),
                ...(reach ? { reach } : {})
            });
        }

        return lists;
    }

    /** The lists a scripted effect / trigger adds, its callees' included (calledLists), memoized per builder unless a ring was open. */
    private listWalk(e: Entity, walk: ListWalk): ListAdd[]
    {
        const had = walk.lists.get(e.id);

        if (had !== undefined)
        {
            walk.ring ||= had === null;
            return had ?? [];
        }

        const memo = this.listMemo.get(e.id);

        if (memo)
            return memo;

        walk.lists.set(e.id, null);
        const def = this.idx.defNode(e);
        const out: ListAdd[] = [];

        if (def)
        {
            const calls = this.calledLists(this.body(def.node), walk);

            for (const s of saveSites(def.node, false, e.type, 'list', calls))
            {
                if (out.some((o) => o.name === s.name))
                    continue;

                const own = s.node.k === 'add_to_list' || s.node.k === 'add_to_temporary_list';
                out.push({ name: s.name, temporary: s.temporary, by: own ? e.name : (s.by ?? e.name) });
            }
        }

        walk.lists.set(e.id, out);

        // (a list read while a ring was open may lack the ring's lists: kept for this walk only)
        if (!walk.ring)
            this.listMemo.set(e.id, out);

        return out;
    }

    private listMemo = new Map<number, ListAdd[]>();

    /**
     * The scripted effects / triggers a script calls (`name = yes`, `name = { … }`) that add lists, each with the lists
     * it adds, its own callees' too (transitively, each read once per walk; a ring reads as nothing on the way):
     * saveSites' `calls`, so a list a called effect adds is in reach from its call on. Memoized per builder.
     */
    private calledLists(body: PNode[], walk: ListWalk, out = new Map<string, ListAdd[]>()): Map<string, ListAdd[]>
    {
        for (const n of body)
        {
            if (n.k && !out.has(n.k) && (n.v === 'yes' || Array.isArray(n.v)))
            {
                const callee = this.idx.get('scripted_effects', n.k) ?? this.idx.get('scripted_triggers', n.k);

                if (callee)
                {
                    const got = this.listWalk(callee, walk);

                    if (got.length)
                        out.set(n.k, got);

                    continue;
                }
            }

            if (Array.isArray(n.v))
                this.calledLists(n.v, walk, out);
        }

        return out;
    }

    /**
     * The lists a scripted effect's / trigger's callers add (savedNames) that are in reach at a call of it (ownLists'
     * reach: a list added after the call, or in a sibling option of an event, is not), its callees' lists included,
     * with who adds them: the references are read in order while LIST_CALLERS_MS lasts, a caller whose text does not
     * name it or no list skipped. Memoized per builder.
     */
    private callerLists(e: Entity): { name: string; by: string[]; }[]
    {
        const memo = this.callerListMemo.get(e.id);

        if (memo)
            return memo;

        const deadline = performance.now() + LIST_CALLERS_MS;
        const merged = new Map<string, string[]>();
        const seen = new Set<number>();

        for (const s of this.idx.incomingSources(e))
        {
            if (performance.now() >= deadline)
                break;

            if (s.entity.id === e.id || seen.has(s.entity.id) || ['localization', 'flag', 'variable', 'images', 'models'].includes(s.entity.type))
                continue;

            seen.add(s.entity.id);
            // (a quick look first: a text that names it and some list)
            const texts = this.idx.liveDefs(s.entity).map((d) => this.idx.readFile(d.file).slice(d.start, d.end));

            if (!texts.some((t) => t.includes(e.name) && t.includes('_list')))
                continue;

            const def = this.idx.defNode(s.entity);
            const { calls } = this.callSites(s.entity, e.name);

            if (!def || !calls.length)
                continue;

            const ctx = rootCtx(def.src, this.idx.defAnchor(s.entity), this.rootScopeOf(s.entity.type));
            ctx.entityType = s.entity.type;
            const by = this.originLabel(s.entity);

            for (const l of this.ownLists(s.entity, def.node, ctx))
            {
                // (in reach at one of the calls at least; a call in another of its files: as the reach says nothing there)
                if (l.name.includes('$') || (l.reach && !calls.some((c) => c.file.toLowerCase() !== l.reach!.file.toLowerCase() || l.reach!.ranges.some(([a, b]) => c.at >= a && c.at < b))))
                    continue;

                const got = merged.get(l.name) ?? [];

                if (!got.includes(by))
                    got.push(by);

                merged.set(l.name, got);
            }
        }

        const out = [...merged].map(([name, by]) => ({ name, by }));
        this.callerListMemo.set(e.id, out);
        return out;
    }

    private callerListMemo = new Map<number, { name: string; by: string[]; }[]>();

    /**
     * The saved scopes in reach of a definition's script (docs/picker.md, "Scopes in reach"): the statement picker's
     * targets: the ones its type's .info documents (an interaction's actor, recipient, secondary actor …, a scheme's
     * target, an activity's host), the ones it saves (save_scope_as, save_temporary_scope_as, with who they are and
     * their type), the ones it uses without either (given by what runs it). Types by name (`scopeTypeByName`); names of
     * things the picker has no statements for (an activity, a story, an epidemic …) are left out. A temporary save is
     * in reach only in the rest of its part of the script (reachOf). A scripted effect's / trigger's also get what its
     * callers have where they call it (callerTargets): a used one is then typed and said by them, and the list is
     * known when every caller was read and is known itself. `usedOnly`: the names in the list nothing saves or
     * documents (its own used-only ones, or ones its callers only use), for a caller's caller (callerTargets).
     * `deadline`: the card's time budget for the callers (on callerClock(); callerTargets sets it).
     */
    private cardTargets(e: Entity, body: PNode[], node: PNode, ctx: Ctx, depth = 0, deadline?: number): { targets: PickTarget[]; known: boolean; usedOnly: Set<string>; }
    {
        const own = this.ownTargets(e, body, node, ctx);

        if (e.type !== 'scripted_effects' && e.type !== 'scripted_triggers' && e.type !== 'script_values')
            return { targets: own.targets, known: own.known, usedOnly: own.usedOnly };

        const callers = this.callerTargets(e, depth, deadline);

        if (!callers)
            return { targets: own.targets, known: own.known, usedOnly: own.usedOnly };

        const out = own.targets.slice();
        const usedOnly = new Set(own.usedOnly);

        for (const t of callers.targets)
        {
            const i = out.findIndex((o) => o.key === t.key);

            // (a name its own text uses for a value or flag is not someone, whatever a caller has under it; one it only
            // uses: the callers say who it is; one it saves too is there from the start, given by them)
            if (own.values.has(t.key.slice(6)))
                continue;

            if (i < 0)
            {
                out.push(t);

                if (callers.usedOnly.has(t.key))
                    usedOnly.add(t.key);
            }
            else if (own.usedOnly.has(t.key))
            {
                out[i] = t;

                if (!callers.usedOnly.has(t.key))
                    usedOnly.delete(t.key);
            }
            else
            {
                const { reach: _, ...kept } = out[i];
                out[i] = { ...kept, about: `${kept.about ?? ''} · ${t.about ?? ''}` };
            }
        }

        return { targets: out, known: callers.known, usedOnly };
    }

    /**
     * The scopes the scripted effects / triggers an entry calls save in their own texts (EntityCard.calledSaves), two
     * calls deep, each with its definition's span (PickTarget.inside) and its reach there (ownTargets); a name the
     * entry has itself (`have`) is left out (the entry's own reach decides it). Within CALLERS_READ.
     */
    private calledSaves(body: PNode[], have: Set<string>): PickTarget[]
    {
        const out: PickTarget[] = [];
        const seen = new Set<number>();
        const deadline = performance.now() + CALLERS_READ;
        const walk = (nodes: PNode[], depth: number): void =>
        {
            for (const n of nodes)
            {
                if (performance.now() > deadline)
                    return;

                const callee = n.k ? (this.idx.get('scripted_effects', n.k) ?? this.idx.get('scripted_triggers', n.k)) : undefined;

                if (callee && !seen.has(callee.id))
                {
                    seen.add(callee.id);
                    const def = this.idx.defNode(callee);
                    const anchor = this.idx.defAnchor(callee);

                    if (def && anchor && Array.isArray(def.node.v))
                    {
                        const own = this.body(def.node);
                        const saved = new Set<string>();
                        const names = (xs: PNode[]): void =>
                        {
                            for (const x of xs)
                            {
                                if ((x.k === 'save_scope_as' || x.k === 'save_temporary_scope_as') && typeof x.v === 'string' && /^\w+$/.test(x.v))
                                    saved.add(`scope:${x.v}`);
                                else if (Array.isArray(x.v))
                                    names(x.v);
                            }
                        };
                        names(own);

                        if (saved.size)
                        {
                            const ctx = rootCtx(def.src, anchor, this.rootScopeOf(callee.type));
                            ctx.entityType = callee.type;
                            const inside = { file: anchor.file, def: [anchor.start, anchor.end] as [number, number] };

                            for (const t of this.ownTargets(callee, own, def.node, ctx).targets)
                                if (saved.has(t.key) && !have.has(t.key) && !out.some((o) => o.key === t.key && o.inside?.file === inside.file && o.inside.def[0] === inside.def[0]))
                                    out.push({ ...t, inside });
                        }

                        if (depth < 2)
                            walk(own, depth + 1);
                    }
                }

                if (Array.isArray(n.v))
                    walk(n.v, depth);
            }
        };
        walk(body, 1);
        return out;
    }

    /**
     * cardTargets for the definition itself (`usedOnly`: the names it uses without a save or a documentation; `values`:
     * the names its text uses for values or flags, valueNames).
     */
    private ownTargets(e: Entity, body: PNode[], node: PNode, ctx: Ctx): { targets: PickTarget[]; known: boolean; usedOnly: Set<string>; values: Set<string>; }
    {
        const usedOnly = new Set<string>();

        if (NO_OWN_TARGETS.has(e.type))
            return { targets: [], known: false, usedOnly, values: new Set() };

        const out: PickTarget[] = [];
        let documented = false;
        const text = ctx.src.slice(node.s, node.e);
        const values = valueNames(text);
        const add = (t: PickTarget): boolean =>
        {
            if (out.some((o) => o.key === t.key) || values.has(t.key.slice(6)))
                return false;

            out.push(t);
            return true;
        };
        const label = (n: string): string => capitalize(humanize(n));
        const typeName = typeLabel(e.type).toLowerCase();

        for (const doc of this.idx.typeDoc(e.type))
        {
            // (a name the .info mentions only on lines that save it is its example of the syntax, not a scope it is
            // given: `save_temporary_scope_as = name # Saves the current scope as scope:name` of _script_values.info;
            // the activity .info's `save_scope_as = province` example is given too, as scope:province elsewhere)
            const given = new Set<string>();

            for (const line of doc.text.split('\n'))
            {
                const saved = new Set([...line.matchAll(/\bsave_\w*_as\s*=\s*(\w+)/g)].map((m) => m[1]));

                for (const m of line.matchAll(/\bscope:(\w+)/g))
                    if (!saved.has(m[1]))
                        given.add(m[1]);
            }

            for (const name of given)
            {
                const type = scopeTypeByName(name);

                if (type !== null)
                {
                    documented = true;
                    add({ key: `scope:${name}`, label: label(name), about: tr('given to every {replace} (its .info)', { replace: typeName.replace(/s$/, '') }), ...(type ? { type } : {}) });
                }
            }
        }

        const sites = saveSites(node, false, e.type);

        for (const s of this.d.savedScopes(body, ctx))
        {
            const type = s.type ?? scopeTypeByName(s.name);
            // (a temporary one only in the rest of its part of the script; a lasting one everywhere)
            const reach = reachOf(sites.filter((x) => x.name === s.name), node, false, ctx);

            if (type !== null)
                add({
                    key: `scope:${s.name}`,
                    label: label(s.name) + (s.temporary ? tr(' (for a moment)') : ''),
                    about: s.temporary ? tr('{who} — saved here with save_temporary_scope_as: only until the end of the part of the script it is saved in', { who: s.who }) : tr('{who} — saved here', { who: s.who }),
                    ...(type ? { type } : {}),
                    ...(reach ? { reach } : {})
                });
        }

        for (const name of new Set([...text.matchAll(/\bscope:(\w+)/g)].map((m) => m[1])))
        {
            const type = scopeTypeByName(name);

            if (type !== null && add({ key: `scope:${name}`, label: label(name), about: tr('used here — given by what runs it'), ...(type ? { type } : {}) }))
                usedOnly.add(`scope:${name}`);
        }

        // (a type whose .info names no scope while the game's own entries of it use some they do not save: the names
        // used by at least two of them, or by half of them, and by a tenth of the ones that use any (factions'
        // scope:target, holy orders' scope:founder; a name a few entries of many use is theirs, given by their own
        // callers: customizable localization's scope:skill_a); the list stays not known)
        const uses = documented ? null : this.typeUses(e.type);

        for (const [name, k] of [...(uses?.names ?? [])].sort((a, b) => b[1] - a[1]))
        {
            const type = scopeTypeByName(name);

            if (type !== null && (k >= 2 || k * 2 >= uses!.defs) && k * 10 >= uses!.using && add({ key: `scope:${name}`, label: label(name), about: tr('the game’s own entries of this kind use it ({k} of {n}) without saving it: given by what runs them', { k, n: uses!.defs }), ...(type ? { type } : {}) }))
                usedOnly.add(`scope:${name}`);
        }

        // (known = the game runs the entry with the scopes its type's .info names, so the list is complete as far as the
        // index sees; an entry other scripts call (a scripted effect / trigger / modifier / list / relation / animation,
        // a script value) gets its scopes from its callers: known only through them (cardTargets, callerTargets); a type
        // whose .info names no scope is known with none when the game's own entries of it use none (knownEmptyType))
        const called = isCalledType(e.type);
        return { targets: out, known: (documented || this.knownEmptyType(e.type)) && !called, usedOnly, values };
    }

    private emptyTypes = new Map<string, boolean>();

    /**
     * An entry type the game runs with no saved scope (docs/picker.md "Known or not"): it has an .info, the .info names
     * no `scope:` at all, other scripts do not call its entries (not scripted_* / script_values), and none of the
     * game's own definitions of it (the vanilla files, not a mod's) uses a `scope:x` it does not save itself
     * (save_scope_as, save_temporary_scope_as, save_scope_value_as, save_temporary_scope_value_as). A type with no
     * definition in the game's files stays not known. Its entries' lists are then known: an empty one means "nothing
     * saved here". Memoized per builder.
     */
    knownEmptyType(type: string): boolean
    {
        const memo = this.emptyTypes.get(type);

        if (memo !== undefined)
            return memo;

        const uses = this.typeUses(type);
        const ok = uses !== null && uses.defs > 0 && uses.names.size === 0;
        this.emptyTypes.set(type, ok);
        return ok;
    }

    private usesMemo = new Map<string, { defs: number; using: number; names: Map<string, number>; } | null>();

    /**
     * The saved scopes the game's own definitions of a type use without saving them (knownEmptyType; ownTargets'
     * "the game's own … use it"): for a type with an .info that names no `scope:` at all, not called by other scripts
     * and not one without own targets. `defs`: its definitions in the game's files (a definition inside another one's
     * span, a title in its kingdom, read with it); `using`: how many of them use any; `names`: per name, how many of
     * them use it. Null: not such a type.
     * Memoized per builder; the time counts as a one-time scan (setupMs).
     */
    typeUses(type: string): { defs: number; using: number; names: Map<string, number>; } | null
    {
        const memo = this.usesMemo.get(type);

        if (memo !== undefined)
            return memo;

        const t0 = performance.now();
        let ok = !isCalledType(type) && !NO_OWN_TARGETS.has(type);
        const docs = ok ? this.idx.typeDoc(type) : [];
        ok &&= docs.length > 0 && !docs.some((d) => /\bscope:\w/.test(d.text));
        let out: { defs: number; using: number; names: Map<string, number>; } | null = null;

        if (ok)
        {
            out = { defs: 0, using: 0, names: new Map() };
            const spans = new Map<number, [number, number][]>();

            for (const name of this.idx.names(type))
                for (const d of this.idx.get(type, name)?.defs ?? [])
                {
                    const f = this.idx.files[d.file];

                    if (!f || f.source || f.gone)
                        continue;

                    let l = spans.get(d.file);

                    if (!l)
                        spans.set(d.file, l = []);

                    l.push([d.start, d.end]);
                }

            for (const [file, list] of spans)
            {
                const text = this.idx.readFile(file);
                let end = -1;

                for (const [s, e] of list.sort((a, b) => a[0] - b[0] || b[1] - a[1]))
                {
                    if (s < end)
                        continue;

                    end = e;
                    out.defs++;
                    const t = text.slice(s, e);

                    if (!t.includes('scope:'))
                        continue;

                    const saved = new Set([...t.matchAll(/\bsave_(?:temporary_)?scope_as\s*=\s*(\w+)/g), ...t.matchAll(/\bsave_(?:temporary_)?scope_value_as\s*=\s*\{[^}]*?\bname\s*=\s*(\w+)/g)].map((m) => m[1]));

                    const unsaved = [...new Set([...t.matchAll(/\bscope:(\w+)/g)].map((m) => m[1]))].filter((n) => !saved.has(n));

                    if (unsaved.length)
                        out.using++;

                    for (const n of unsaved)
                        out.names.set(n, (out.names.get(n) ?? 0) + 1);
                }
            }
        }

        this.usesMemo.set(type, out);
        this.setupMs += performance.now() - t0;
        return out;
    }

    /** The types knownEmptyType marks known with no scope, from the types the index has (scripts/cast-check.ts `known-empty`). */
    knownEmptyTypes(): string[]
    {
        return this.idx.types(false)
            .map((t) => t.id)
            .filter((t) => this.knownEmptyType(t))
            .sort();
    }

    private valueSaved?: Set<string>;

    /**
     * The names some scripted effect saves as a value (save_scope_value_as, save_temporary_scope_value_as) and none
     * saves as a scope (save_scope_as, save_temporary_scope_as): `scope:wound` of hunt_wound_select_effect. A caller
     * that only uses such a name (`exists = scope:wound`) has it from such an effect, so it is not someone
     * (callerTargets). Every loaded definition's text, once per builder.
     */
    valueSavedNames(): Set<string>
    {
        if (this.valueSaved)
            return this.valueSaved;

        const t0 = performance.now();
        const values = new Set<string>();
        const scopes = new Set<string>();

        for (const name of this.idx.names('scripted_effects'))
        {
            const e = this.idx.get('scripted_effects', name);

            for (const d of e ? this.idx.liveDefs(e) : [])
            {
                const t = this.idx.readFile(d.file).slice(d.start, d.end);

                if (!t.includes('scope_'))
                    continue;

                for (const m of t.matchAll(/\bsave_(?:temporary_)?scope_value_as\s*=\s*\{[^}]*?\bname\s*=\s*(\w+)/g))
                    values.add(m[1]);

                for (const m of t.matchAll(/\bsave_(?:temporary_)?scope_as\s*=\s*(\w+)/g))
                    scopes.add(m[1]);
            }
        }

        this.valueSaved = new Set([...values].filter((n) => !scopes.has(n)));
        this.setupMs += performance.now() - t0;
        return this.valueSaved;
    }

    /**
     * The time spent in the builder's one-time scans (valueSavedNames, knownEmptyType) in ms: the callers' budget does
     * not count them (callerClock). Other cold costs (a caller event's first Who's who, first parses and file reads)
     * still count against the first card, so a later card on the same builder, helped by its memos, may read more.
     */
    setupMs = 0;

    /** The clock of the callers' time budget (callerTargets): performance.now() without the builder's one-time scans. */
    callerClock(): number
    {
        return performance.now() - this.setupMs;
    }

    private callerMemo = new Map<string, CallerTargets | null>();
    private castMemo = new Map<number, { targets: PickTarget[]; usedOnly: Set<string>; }>();
    /**
     * off: a block's scope only from the "### Brief" docs, as before round 13 wave 12 (no key comments, no builder's
     * own block scopes: blockScope, blockCtx, the scripted list's conditions; a dump compares both)
     */
    blockScopes = true;
    /** globalVarType's answers per key (`var:x`, `global_var:x`): the type, or null (not known) */
    private varMemo = new Map<string, string | null>();
    /** the time globalVarType took in all (ms), and how many keys it looked up (scripts/vartypes-check.ts prints them) */
    varStats = { ms: 0, keys: 0, setters: 0 };

    /**
     * The scope type of a variable set in other files (docs/readable-view.md, "Variables"): every definition that sets
     * it (`set_variable` for `var:x`, `set_global_variable` for `global_var:x`; the index's references to the variable,
     * mods' files too), its value typed where it is set (Describer.variableSets, the setter's own saves and variables
     * known); the one type when every set agrees, else null (two types, a value that is no scope or is not known, no
     * setter). By name, whatever object it is set on (as the script's own sets). Memoized per builder (a new index
     * gets a new builder).
     */
    globalVarType(key: string): string | undefined
    {
        const memo = this.varMemo.get(key);

        if (memo !== undefined)
            return memo ?? undefined;

        const t0 = performance.now();
        const name = key.split(':')[1];
        const e = this.idx.get('variable', name);
        const types = new Set<string>();
        let sets = 0;

        for (const s of e ? this.idx.incomingSources(e) : [])
        {
            const src = s.entity;

            for (const def of this.idx.liveDefs(src))
            {
                const d = this.idx.defNode(src, undefined, src.defs.indexOf(def));

                const text = d ? d.src.slice(d.node.s, d.node.e) : '';

                // (most references only read it)
                if (!d || !text.includes(name) || !SET_VARIABLE.test(text))
                    continue;

                const body = this.body(d.node);
                const ctx = rootCtx(d.src, undefined, (src.type === 'on_action' ? onActionFact(src.name)?.root : undefined) ?? this.rootScopeOf(src.type) ?? 'character');

                // (a value `scope:x` is typed by the setter's own save of x)
                if (text.includes('scope:'))
                    ctx.savedTypes = Object.fromEntries(this.d.savedScopes(body, ctx).filter((x) => x.type).map((x) => [x.name, x.type!]));

                ctx.varTypes = this.d.variableTypes(body, ctx);

                for (const t of this.d.variableSets(body, ctx).get(key) ?? [])
                {
                    types.add(t);
                    sets++;
                }
            }
        }

        const type = types.size === 1 && !types.has('') ? [...types][0] : null;
        this.varMemo.set(key, type);
        this.varStats.ms += performance.now() - t0;
        this.varStats.keys++;
        this.varStats.setters += sets;
        return type ?? undefined;
    }

    /**
     * A definition's variable types (Ctx.varTypes): its own sets (Describer.variableTypes), then each `var:x` /
     * `global_var:x` it reads but does not set itself, typed by its setters in other files when they all agree
     * (globalVarType). `local_var:x` stays the definition's own (local by the game's rules).
     */
    varTypesOf(node: PNode, ctx: Ctx): Record<string, string> | undefined
    {
        const body = this.body(node);
        const own = this.d.variableTypes(body, ctx);
        const reads = new Set([...ctx.src.slice(node.s, node.e).matchAll(/(?<![\w:])((?:global_)?var):(\w+)/g)].map((m) => `${m[1]}:${m[2]}`));

        if (!reads.size)
            return own;

        const setHere = this.d.variableSets(body, ctx);
        const out: Record<string, string> = { ...own };

        for (const key of reads)
        {
            if (out[key] || setHere.has(key))
                continue;

            const t = this.globalVarType(key);

            if (t)
                out[key] = t;
        }

        return Object.keys(out).length ? out : undefined;
    }
    /** The time budget per card for a scripted effect's / trigger's callers in ms (CALLERS_READ; scripts may change it). */
    callerBudget = CALLERS_READ;

    /**
     * The scopes a scripted effect's / trigger's callers have where they call it (docs/picker.md "Scopes in reach"):
     * every caller whose text calls it (`name = yes`, `name = { … }`; the references are looked at in order while the
     * card's time budget lasts, callerBudget: past it the rest stay unread and the list is not known), each caller's
     * targets in reach at one of its calls (an event's Who's who, an on_action's documented scopes and its own saves,
     * another entry's cardTargets; a calling scripted effect's own callers, two levels deep), merged by name: "given by
     * 2 of 3 callers: …", typed by most of them. A name only callers' used-only names give and that a scripted effect
     * saves as a value (valueSavedNames) is left out. `known`: every caller was read and each one's scopes are known
     * (an event; an entry its type's .info documents or knownEmptyType). Null: no caller calls it in its text.
     * Memoized per builder (a new one after each index update); a nested list the budget cut is not kept, so a card of
     * its own reads it with its own budget.
     */
    callerTargets(e: Entity, depth = 0, deadline?: number): CallerTargets | null
    {
        const memoKey = `${e.id}:${depth}`;
        const memo = this.callerMemo.get(memoKey);

        if (memo !== undefined)
            return memo;

        deadline ??= this.callerClock() + this.callerBudget;
        // (set first: a scripted effect calling itself, or a ring of them, reads as no callers on the way)
        this.callerMemo.set(memoKey, null);
        const sources = this.idx.incomingSources(e).filter((s) => s.entity.id !== e.id && !['localization', 'flag', 'variable', 'images', 'models'].includes(s.entity.type));
        const merged = new Map<string, { t: PickTarget; by: string[]; types: Map<string, number>; given: boolean; }>();
        let read = 0;
        let looked = 0;
        let allKnown = true;
        let cut = false;

        // (while the budget lasts: a reference whose text does not call it (another kind of reference) is skipped and
        // does not count, but leaves the list not known)
        for (const s of sources)
        {
            if (this.callerClock() >= deadline)
            {
                cut = true;
                break;
            }

            looked++;
            const got = this.targetsAtCalls(s.entity, e.name, depth, deadline, e.type === 'script_values');

            if (!got)
                continue;

            read++;
            allKnown &&= got.known;
            const by = this.originLabel(s.entity);

            for (const t of got.targets)
            {
                let m = merged.get(t.key);

                if (!m)
                    merged.set(t.key, m = { t, by: [], types: new Map(), given: false });

                if (!m.by.includes(by))
                    m.by.push(by);

                if (t.type)
                    m.types.set(t.type, (m.types.get(t.type) ?? 0) + 1);

                m.given ||= !got.usedOnly.has(t.key);
            }
        }

        if (!read && !cut)
            return null;

        // (references not looked at: they may hold more callers)
        const left = sources.length - looked;
        const targets: PickTarget[] = [];
        const usedOnly = new Set<string>();
        const valueSaved = merged.size ? this.valueSavedNames() : new Set<string>();

        for (const { t, by, types, given } of merged.values())
        {
            // (a name the callers only use, which a scripted effect saves as a value and never as a scope: a value
            // given by an effect they call before, not someone)
            if (!given && valueSaved.has(t.key.slice(6)))
                continue;

            // (typed by most callers, else by its name like the entry's own; a name no caller types and whose name says
            // a value or a thing the picker has no statements for (scopeTypeByName null) is left out, as in ownTargets;
            // a type a caller gives wins over the name's)
            const byName = scopeTypeByName(t.key.slice(6));
            const type = [...types].sort((a, b) => b[1] - a[1])[0]?.[0] ?? byName;

            if (type === null)
                continue;

            const names = by.slice(0, 3).join(', ') + (by.length > 3 ? ' …' : '');
            const about = tr('given by {k} of {n} callers: {names}', { k: by.length, n: read, names }) + (left > 0 ? tr(' (the first {n} callers read; {left} more references not read)', { n: read, left }) : '');
            targets.push({ key: t.key, label: t.label, about, ...(type ? { type } : {}) });

            if (!given)
                usedOnly.add(t.key);
        }

        const out: CallerTargets = { targets, known: allKnown && left === 0 && read === looked, usedOnly, looked, read, refs: sources.length, cut };

        // (a nested list cut by an outer card's budget is not kept: another card reads it with a budget of its own)
        if (cut && depth > 0)
            this.callerMemo.delete(memoKey);
        else
            this.callerMemo.set(memoKey, out);

        return out;
    }

    /**
     * Where a definition calls `name` (callsOf): each call's file and offset as the index read them, and the definitions
     * that do (an on_action merges its definitions: any of them may call it, each read with its own file's anchor).
     */
    private callSites(src: Entity, name: string, asValue = false): { calls: { file: string; at: number; }[]; callers: { node: PNode; src: string; anchor: ReturnType<GameIndex['defAnchor']>; }[]; }
    {
        const idxs: (number | undefined)[] = src.type === 'on_action' ? src.defs.flatMap((d, i) => (this.idx.files[d.file]?.hidden ? [] : [i])) : [undefined];
        const calls: { file: string; at: number; }[] = [];
        const callers: { node: PNode; src: string; anchor: ReturnType<GameIndex['defAnchor']>; }[] = [];

        for (const i of idxs)
        {
            const d = i === undefined ? this.idx.defNode(src) : this.idx.defNode(src, undefined, i);

            if (!d || !d.src.includes(name))
                continue;

            const f = i === undefined ? this.idx.defAnchor(src) : this.idx.defAnchor(src, i);
            const m = f?.map ?? ((o: number): number => o);
            const found = callsOf(this.body(d.node), name, asValue);

            for (const c of found)
                calls.push({ file: f?.file ?? '', at: (f?.start ?? 0) + m(c.s) });

            if (found.length)
                callers.push({ node: d.node, src: d.src, anchor: f });
        }

        return { calls, callers };
    }

    /**
     * A caller's scopes in reach at its calls of `name` (callerTargets): an event's Who's who, an on_action's documented
     * ones and the ones its own script saves (its definitions that call it), another entry's cardTargets (a scripted
     * effect's with its own callers while `depth` allows). `usedOnly`: the names in it the caller only uses. Null: its
     * text does not call `name` (a reference of another kind). Public for scripts/cast-check.ts `per-caller`.
     */
    targetsAtCalls(src: Entity, name: string, depth: number, deadline: number, asValue = false): { targets: PickTarget[]; known: boolean; usedOnly: Set<string>; } | null
    {
        const { calls, callers } = this.callSites(src, name, asValue);

        if (!calls.length)
            return null;

        let all: PickTarget[];
        let known: boolean;
        let usedOnly = new Set<string>();

        if (src.type === 'events')
        {
            ({ targets: all, usedOnly } = this.castTargetsOf(src));
            known = true;
        }
        else if (src.type === 'on_action')
        {
            all = this.onActionDoc(src).scopes.map((s) => ({ key: `scope:${s.name}`, label: capitalize(humanize(s.name)), about: s.who, ...(scopeTypeByName(s.name) ? { type: scopeTypeByName(s.name)! } : {}) }));

            // (what its own script saves: a lasting save counts everywhere, a temporary one in the rest of its part, as in
            // other entries (reachOf with event = false))
            for (const c of callers)
            {
                const ctx = rootCtx(c.src, c.anchor, this.rootScopeOf(src.type));
                ctx.entityType = src.type;
                const sites = saveSites(c.node, false, src.type);

                for (const s of this.d.savedScopes(this.body(c.node), ctx))
                {
                    const type = s.type ?? scopeTypeByName(s.name);
                    const reach = reachOf(sites.filter((x) => x.name === s.name), c.node, false, ctx);

                    if (type !== null && !all.some((o) => o.key === `scope:${s.name}`))
                        all.push({
                            key: `scope:${s.name}`,
                            label: capitalize(humanize(s.name)) + (s.temporary ? tr(' (for a moment)') : ''),
                            about: s.temporary ? tr('{who} — saved here with save_temporary_scope_as: only until the end of the part of the script it is saved in', { who: s.who }) : tr('{who} — saved here', { who: s.who }),
                            ...(type ? { type } : {}),
                            ...(reach ? { reach } : {})
                        });
                }
            }

            // (known only for an on_action the game's _on_actions.info lists (the pulses: each line says what it comes
            // with, "Does not have any scopes", "Comes with a saved scope value called scope:quarter"), that no script
            // fires or chains (a firer passes its own scopes) and whose calling definitions use no scope:x that is not
            // documented or saved; the other code on_actions are documented by comments above them, which may leave a
            // scope out: not known)
            const used = callers.flatMap((c) => [...c.src.slice(c.node.s, c.node.e).matchAll(/\bscope:(\w+)/g)].map((x) => `scope:${x[1]}`));
            known = this.onActionInfo().has(src.name)
                && !this.idx.incomingSources(src).some((s) => s.entity.id !== src.id && !['localization', 'flag', 'variable', 'images', 'models'].includes(s.entity.type))
                && used.every((k) => all.some((o) => o.key === k));
        }
        else
        {
            const def = this.idx.defNode(src);

            if (!def)
                return null;

            const ctx = rootCtx(def.src, this.idx.defAnchor(src), this.rootScopeOf(src.type));
            ctx.entityType = src.type;
            const deeper = depth + 1 < 2;
            const r = deeper ? this.cardTargets(src, this.body(def.node), def.node, ctx, depth + 1, deadline) : this.ownTargets(src, this.body(def.node), def.node, ctx);
            all = r.targets;
            known = r.known;
            usedOnly = r.usedOnly;
        }

        const at = (t: PickTarget): boolean => !t.reach || calls.some((c) => c.file.toLowerCase() !== t.reach!.file.toLowerCase() || t.reach!.ranges.some(([s, e]) => c.at >= s && c.at < e));
        // (in the called script a scope is there from its start: its reach was the caller's)
        return { targets: all.filter(at).map(({ reach: _, ...t }) => t), known, usedOnly };
    }

    /**
     * An event's Who's who as targets (shared/castTargets.ts) for the scripted effects it calls, memoized per builder;
     * the names it only uses are left out where its text uses them for values or flags (valueNames). `usedOnly`: the
     * names it uses without a save or being given them (EventCast.unknown).
     */
    private castTargetsOf(e: Entity): { targets: PickTarget[]; usedOnly: Set<string>; }
    {
        const memo = this.castMemo.get(e.id);

        if (memo)
            return memo;

        const def = this.idx.defNode(e);
        const out = { targets: [] as PickTarget[], usedOnly: new Set<string>() };

        if (def)
        {
            const ctx = rootCtx(def.src, this.idx.defAnchor(e), 'character');
            const cast = this.eventCast(e, this.body(def.node), def.node, ctx, this.origins(e));
            const values = valueNames(def.src.slice(def.node.s, def.node.e));
            const unknown = cast.unknown.filter((u) => !values.has(u));
            out.targets = castTargets({ ...cast, unknown });

            for (const u of unknown)
                if (!cast.named.some((m) => m.name === u) && !cast.given.some((m) => m.name === u))
                    out.usedOnly.add(`scope:${u}`);
        }

        this.castMemo.set(e.id, out);
        return out;
    }

    /** What a modifier entry is given to: the effects its references are in (add_character_modifier, add_county_modifier …). */
    private modifierGiven(e: Entity): Set<Exclude<ModKind, 'other'>>
    {
        const contexts = this.idx.incomingSources(e).flatMap((s) => s.contexts);
        return new Set(MODIFIER_GIVEN.filter(([re]) => contexts.some((c) => re.test(c))).map(([, k]) => k));
    }

    /** The one thing a modifier entry is given to, when it is only one (the picker's modifiers for its "Effects"). */
    modifierGivenTo(e: Entity): Exclude<ModKind, 'other'> | undefined
    {
        const g = this.modifierGiven(e);
        return g.size === 1 ? [...g][0] : undefined;
    }

    /**
     * The fields of a definition as lines (opinion modifiers: "+30 opinion", "Lasts 5 years", "Fades over time"),
     * one per field, anchored when `ctx` reads the definition's own text. Unknown keys read "key: value".
     */
    fieldLines(type: string, list: PNode[], ctx?: Ctx): Line[]
    {
        const out: Line[] = [];
        const bare = bareField(type);

        for (const c0 of list)
        {
            // (a constant of the file is read as its value)
            const c = ctx && typeof c0.v === 'string' && c0.v.startsWith('@') ? { ...c0, v: this.d.constOf(c0.v, ctx) } : c0;
            // (a list's items written alone: `opposites = { craven }`)
            const key = c.k ?? (bare && typeof c.v === 'string' ? bare.key : null);

            if (!key || typeof c.v !== 'string')
                continue;

            const def = fieldOf(type, key);
            const f = fieldText(type, key, c.v);
            const tip = c.k ? `${c.k} = ${c.v}` : c.v;
            // an entry linked, a text key read ("Label: $" split around the value); a number written as a named value:
            // "Label: <the value>"
            const named = def?.kind === 'number' && !/^-?[\d.]+$/.test(c.v);
            // (a number too: "Diplomacy <8>", the number highlighted)
            const around = def && typeof def.read === 'string' && def.read.includes('$') && (def.kind === 'ref' || def.kind === 'text' || (def.kind === 'number' && !named)) ? def.read.replace('%k', key.replace(/_/g, ' ')).split('$') : undefined;
            // (a label with the value's place marked inside: "AI checks it every … months" reads "AI checks it every
            // <the value> months", not "AI checks it every  months: <the value>")
            const gap = named ? def!.label.split('…') : [];
            // (a text key (FieldDef.loc): its text, or the key with "no text yet": ✎ text writes it (Line.locKey))
            const textKey = def?.kind === 'text' && def.loc !== undefined;
            const noText = textKey && !this.d.loc(c.v);
            const l: Line = noText && around
                ? { text: rich(capitalize(around[0]), { text: tr('{key} (no text yet)', { key: c.v }), kind: 'ph', tip: c.v }, around.slice(1).join('$')), tip }
                : named && ctx
                ? { text: gap.length === 2 && gap[0].trim() && gap[1].trim() ? rich(capitalize(gap[0]), this.settingValue(c.v, ctx, key), gap[1]) : rich(capitalize(def!.label.replace('…', '').trim()), ': ', this.settingValue(c.v, ctx, key)), tip }
                : around
                ? { text: rich(capitalize(around[0]), def!.kind === 'number' ? { text: c.v, kind: 'value' } : def!.ref ? this.d.ref(c.v, [def!.ref]) : ctx ? this.settingValue(c.v, ctx, key) : c.v, oneUnit(c.v, around.slice(1).join('$'))), tip }
                : f
                ? { text: f.tone ? [{ text: f.text, kind: f.tone }] : [f.text], tone: f.tone, tip }
                : { text: rich(capitalize(humanize(key)), ': ', ctx && /^(scope:|root\b|prev\b|this\b|@|define:)/.test(c.v) ? this.d.valueSeg(c.v, ctx) : { text: c.v, kind: 'value' }), tip };

            if (ctx?.file)
            {
                const src = this.d.anchor(c, ctx, 'field', false);

                if (src)
                    l.src = { ...src, fields: type };
            }

            if (textKey)
                l.locKey = c.v;

            const act = l.src && this.pictureAct(key, c.v, l.src);

            if (act)
                l.act = act;

            out.push(l);
        }

        return out;
    }

    label(e: Entity): string
    {
        return this.idx.displayName(e) ?? titleCase(humanize(e.name));
    }

    body(node: PNode): PNode[]
    {
        return Array.isArray(node.v) ? node.v : [];
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /**
     * Loc keys in a title/name node, in order, with the conditions of triggered_desc variants; an unconditional entry
     * after conditional ones in a first_valid is the fallback ("Otherwise"). (An event's description: descTree.)
     */
    private locVariants(n: PNode | undefined, ctx: Ctx): { text: Rich; key?: string; conditional?: Line[]; otherwise?: boolean; trigger?: PNode; }[]
    {
        if (!n)
            return [];

        if (typeof n.v === 'string')
            return n.v ? [{ text: this.d.loc(n.v) ?? [humanize(n.v)], key: n.v }] : [];

        const out: { text: Rich; key?: string; conditional?: Line[]; otherwise?: boolean; trigger?: PNode; }[] = [];
        const visit = (list: PNode[], conds?: Line[], firstValid = false, trigger?: PNode): void =>
        {
            let afterConditional = false;

            for (const c of list)
            {
                if (c.k === 'trigger' || c.k === 'limit')
                    continue;

                if (c.k === 'triggered_desc' && Array.isArray(c.v))
                {
                    const t = c.v.find((x) => x.k === 'trigger');
                    const cs = t && Array.isArray(t.v) ? this.d.triggers(t.v, ctx) : undefined;

                    if (cs?.length)
                        afterConditional = true;

                    visit(c.v, cs, false, t);
                }
                else if (typeof c.v === 'string')
                {
                    if ((c.k === 'desc' || c.k === null) && c.v)
                        out.push({ text: this.d.loc(c.v) ?? [humanize(c.v)], key: c.v, conditional: conds, otherwise: firstValid && afterConditional && !conds, trigger });
                }
                else
                    visit(c.v, conds, c.k === 'first_valid');
            }
        };
        visit(n.v);
        return out;
    }

    /**
     * An event's description as a tree (DescNode, docs/readable-view.md "Descriptions"): `desc = key` a text, a block a
     * sequence of parts, `first_valid` / `random_valid` versions, a `triggered_desc` its content with its condition.
     * Paths count keyed statements from the `desc` statement down.
     */
    private descTree(n: PNode, ctx: Ctx): DescNode | undefined
    {
        const node = (c: PNode, path: number[] | undefined): DescNode | undefined =>
        {
            if (typeof c.v === 'string')
                return c.v ? { kind: 'text', text: this.d.loc(c.v) ?? [humanize(c.v)], key: c.v, path } : undefined;

            const list = c.v;
            // (the keyed index of each statement of the block)
            const keyed: number[] = [];
            let k = -1;

            for (const x of list)
                keyed.push(x.k !== null ? ++k : -1);

            const sub = (i: number): number[] | undefined => (path && keyed[i] >= 0 ? [...path, keyed[i]] : undefined);

            if (c.k === 'triggered_desc')
            {
                const t = list.find((x) => x.k === 'trigger');
                const di = list.findIndex((x) => x.k === 'desc');
                const inner = di >= 0 ? node(list[di], sub(di)) : undefined;

                if (!inner)
                    return undefined;

                const cs = t && Array.isArray(t.v) ? this.d.triggers(t.v, ctx) : [];
                return {
                    ...inner,
                    path,
                    when: cs.length ? rich(tr('If '), this.d.conditionClause(cs), ':') : [tr('If … (no condition yet):')],
                    triggerSrc: t && Array.isArray(t.v) ? this.blockSection(t, 'trigger', ctx) : undefined
                };
            }

            const kind: DescNode['kind'] = c.k === 'first_valid' ? 'first' : c.k === 'random_valid' ? 'random' : 'seq';
            const kids: DescNode[] = [];
            let afterConditional = false;

            list.forEach((x, i) =>
            {
                if (x.k === 'trigger' || x.k === 'limit' || (x.k === null && typeof x.v !== 'string'))
                    return;

                const kid = node(x, sub(i));

                if (!kid)
                    return;

                if (kid.when)
                    afterConditional = true;
                else if (kind === 'first' && afterConditional)
                    kid.otherwise = true;

                kids.push(kid);
            });

            return kids.length ? { kind, kids, path, at: path } : undefined;
        };
        return node(n, []);
    }

    /**
     * An event's scenes: every `override_background = { trigger = { … } reference = x }` in order (the first whose
     * condition holds shows; none: the theme's), with its picture and "If …:".
     */
    private eventScenes(body: PNode[], ctx: Ctx): EventScene[]
    {
        return body
            .filter((n) => n.k === 'override_background')
            .map((n) =>
            {
                const list = Array.isArray(n.v) ? n.v : [];
                const r = typeof n.v === 'string' ? n.v : list.find((x) => x.k === 'reference')?.v;
                const ref = typeof r === 'string' ? r : undefined;
                const t = list.find((x) => x.k === 'trigger' && Array.isArray(x.v));
                const cs = t ? this.d.triggers(t.v as PNode[], ctx) : [];
                const bg = ref ? this.idx.get('event_backgrounds', ref) : undefined;
                const im = bg && this.idx.imagesOf(bg);
                const src = this.d.anchor(n, ctx, 'other', true);
                const out: EventScene = { ref, image: (im?.illu ?? im?.icon)?.name, src };

                if (cs.length)
                    out.when = rich(tr('If '), this.d.conditionClause(cs), ':');

                // (its trigger block, or (none yet) where "＋ condition" makes one)
                out.triggerSrc = t ? this.blockSection(t, 'trigger', ctx) : src?.inner ? { parent: { ...src, kind: 'trigger' }, key: 'trigger', kind: 'trigger' } : undefined;
                return out;
            });
    }

    /** What a description reads as at first sight: every part, the first version of each choice. */
    private descReading(n: DescNode | undefined): Rich
    {
        if (!n)
            return [];

        if (n.kind === 'text')
            return n.text ?? [];

        return n.kind === 'seq' ? n.kids!.flatMap((k) => this.descReading(k)) : this.descReading(n.kids![0]);
    }

    eventStory(e: Entity): EventStory | null
    {
        const def = this.idx.defNode(e);

        if (!def)
            return null;

        const body = this.body(def.node);
        // (the lines read the event's own text: they carry anchors for editing in place)
        const ctx = rootCtx(def.src, this.idx.defAnchor(e), 'character');
        ctx.consts = this.idx.fileConstants(e);
        // (the lines' scope hints: what the event saves, and what its callers pass in (a save of the event or on_action
        // firing it, an on_action's documented scope): `scope:target_title = { … }` holds a title; a name known either
        // way is never typed by its block's use (Describer.switched), its own saves' types win)
        const origins = this.origins(e);
        const givenAll = this.givenTo(e, origins, 0, new Set([e.id]));
        const ownSaves = this.d.savedScopes(body, ctx);
        ctx.savedTypes = Object.fromEntries([
            ...givenAll.given.filter((g) => g.type).map((g) => [g.name, g.type!]),
            ...ownSaves.filter((s) => s.type).map((s) => [s.name, s.type!])
        ]);
        ctx.knownScopes = new Set([...givenAll.given.map((g) => g.name), ...ownSaves.map((s) => s.name)]);
        // (and the variables it sets to a scope: `var:my_title = { … }` holds a title)
        ctx.varTypes = this.varTypesOf(def.node, ctx);
        const get = (k: string): PNode | undefined => body.find((n) => n.k === k);
        const scalar = (k: string): string | undefined =>
        {
            const n = get(k);
            return typeof n?.v === 'string' ? n.v : undefined;
        };
        const titles = this.locVariants(get('title'), ctx);
        const descNode = get('desc');
        const eventType = scalar('type') ?? 'character_event';
        const hidden = scalar('hidden') === 'yes';

        const immediateCtx = { ...ctx, followUps: [] as FollowUp[] };
        const immediateNode = get('immediate');
        const immediate = immediateNode && Array.isArray(immediateNode.v) ? this.d.effects(immediateNode.v, immediateCtx) : [];

        const options: StoryOption[] = body
            .filter((n) => n.k === 'option' && Array.isArray(n.v))
            .map((n) =>
            {
                const list = n.v as PNode[];
                const names = this.locVariants(
                    list.find((c) => c.k === 'name'),
                    ctx
                );
                const trig = list.find((c) => c.k === 'trigger');
                const octx = { ...ctx, followUps: [] as FollowUp[] };
                const option: StoryOption = {
                    text: names[0]?.text ?? [tr('OK')],
                    nameKey: names[0]?.key,
                    alternatives: names.slice(1).map((x) => x.text),
                    conditions: trig && Array.isArray(trig.v) ? this.d.triggers(trig.v, ctx) : [],
                    effects: this.d.effects(list, octx),
                    followUps: octx.followUps,
                    fallback: list.some((c) => c.k === 'fallback' && c.v === 'yes')
                };
                const src = this.d.anchor(n, ctx, 'effect', true);

                if (src)
                {
                    option.src = src;
                    option.trigger = this.section(trig, 'trigger', 'trigger', ctx, src);
                }

                return option;
            });

        const afterCtx = { ...ctx, followUps: [] as FollowUp[] };
        const afterNode = get('after');
        const after = afterNode && Array.isArray(afterNode.v) ? this.d.effects(afterNode.v, afterCtx) : [];
        const trigger = get('trigger');
        const cooldown = get('cooldown');
        const weightNode = get('weight_multiplier');

        const portraits: Rich[] = body
            .filter((n) => n.k !== null && /portrait$/.test(n.k))
            .map((n) =>
            {
                const ch = typeof n.v === 'string' ? n.v : (n.v.find((c) => c.k === 'character')?.v as string | undefined);
                return typeof ch === 'string' ? [this.d.scopeSeg(ch)] : [];
            })
            .filter((r) => r.length);

        const images = this.idx.imagesOf(e);
        const src = this.d.anchor(def.node, ctx, 'other', true);
        // a new trigger / immediate goes before the first option (where they usually are), a new `after` at the end
        const firstOption = body.find((n) => n.k === 'option');
        const before = firstOption && this.d.anchor(firstOption, ctx, 'effect', false);
        const sections: EventStory['sections'] = src && {
            trigger: this.section(trigger, 'trigger', 'trigger', ctx, src, before),
            immediate: this.section(immediateNode, 'immediate', 'effect', ctx, src, before),
            after: this.section(afterNode, 'after', 'effect', ctx, src)
        };
        return {
            src,
            sections,
            cast: this.eventCast(e, body, def.node, ctx, origins, givenAll),
            key: { type: e.type, name: e.name },
            illustration: images.illu?.name,
            icon: images.icon?.name,
            title: titles[0]?.text ?? [titleCase(humanize(e.name))],
            titleKey: titles[0]?.key,
            titleSrc: get('title') && this.d.anchor(get('title')!, ctx, 'other', false),
            descSrc: get('desc') && this.d.anchor(get('desc')!, ctx, 'other', false),
            backgroundSrc: get('override_background') && this.d.anchor(get('override_background')!, ctx, 'other', false),
            scenes: this.eventScenes(body, ctx),
            themeSrc: get('theme') && this.d.anchor(get('theme')!, ctx, 'other', false),
            background: this.idx.eventBackground(e).ref,
            themeKey: scalar('theme'),
            titleVariants: titles.slice(1).map((t) => t.text),
            desc: descNode && this.descTree(descNode, ctx),
            kindLabel: hidden ? tr('Hidden event') : (EVENT_KIND[eventType] ?? capitalize(humanize(eventType))),
            theme: scalar('theme') ? capitalize(humanize(scalar('theme')!)) : undefined,
            window: scalar('window') ? [this.d.guiSeg('window', scalar('window')!) ?? { text: scalar('window')!, kind: 'code' as const }] : undefined,
            hidden,
            cooldown: cooldown && Array.isArray(cooldown.v) ? this.d.duration(cooldown.v, ctx) : undefined,
            portraits,
            origins,
            conditions: trigger && Array.isArray(trigger.v) ? this.d.triggers(trigger.v, ctx) : [],
            weight: weightNode && Array.isArray(weightNode.v) ? weightLines(this, weightNode.v, ctx) : undefined,
            immediate,
            immediateFollowUps: immediateCtx.followUps,
            options,
            after,
            afterFollowUps: afterCtx.followUps
        };
    }

    /**
     * Where a section is written: its block when the definition has one, else the statement to create `key = { }` in
     * (right before `before` when given).
     */
    private section(node: PNode | undefined, key: string, kind: SectionSource['kind'], ctx: Ctx, parent: LineSource, before?: LineSource): SectionSource
    {
        const src = node && Array.isArray(node.v) ? this.d.anchor(node, ctx, kind, true) : undefined;
        return src ? { src, key, kind } : { parent, before, key, kind };
    }

    /**
     * What an event is given by what fires it: who root is (the on_action's documentation, or whom an origin sends it
     * to) and the scopes it gets: an on_action's documented ones and those saved in the effect that sends it, the names
     * a firing event saves, and (saved scopes carry over with trigger_event) the ones that event was given itself (its
     * own origins, back along the whole chain: each event once, at most 60).
     */
    private givenTo(e: Entity, origins: StoryOrigin[], depth: number, seen: Set<number>, cut = { chain: 0 }): { rootNotes: EventCast['rootNotes']; given: CastMember[]; note?: string; }
    {
        const rootNotes: EventCast['rootNotes'] = [];
        const given: CastMember[] = [];
        const give = (m: CastMember): void =>
        {
            if (!given.some((g) => g.name === m.name))
                given.push(m);
        };

        for (const o of origins.slice(0, depth ? 6 : 12))
        {
            const src = this.idx.get(o.ref.type, o.ref.name);

            if (!src)
                continue;

            if (o.ref.type === 'character_interactions')
            {
                give({ name: 'actor', who: [tr('The one who uses the interaction')], from: o.label });
                give({ name: 'recipient', who: [tr('The one it is used on')], from: o.label });
                continue;
            }

            if (o.ref.type !== 'on_action' && o.ref.type !== 'events')
                continue;

            const doc = o.ref.type === 'on_action' ? this.onActionDoc(src) : undefined;
            // "they": the origin's own character: its documented root, else "the one … is about"
            const about = doc?.root ?? (o.ref.type === 'events' ? tr('the one “{label}” happens to', { label: o.label }) : tr('the one {label} is about', { label: o.label }));
            // (on_actions merge: the definition that fires the event; an on_action fires from its effect, an event anywhere)
            let sent: { who: string; conditions?: Line[]; } | null = null;
            const saves: { name: string; who: string; conditions?: Line[]; type?: string; }[] = [];
            this.idx.liveDefs(src).forEach((def) =>
            {
                const d = this.idx.defNode(src, undefined, src.defs.indexOf(def));

                if (!d || !d.src.includes(e.name))
                    return;

                const oc = rootCtx(d.src, undefined, 'character');
                const scripts = o.ref.type === 'on_action' ?
                    this.body(d.node)
                        .filter((n) => n.k === 'effect' && Array.isArray(n.v))
                        .flatMap((n) => n.v as PNode[]) :
                    this.body(d.node);
                const w = this.d.firedWho(scripts, e.name, oc);
                sent ??= w;

                // (an on_action's effect saves reach only the events it sends from there, not those of its lists)
                if (o.ref.type === 'on_action' && !w)
                    return;

                // (its saved names go along with trigger_event; read from "they" when the event goes to someone else)
                const top = w?.who ? { who: about, owner: 'them' } : { who: o.ref.type === 'events' ? 'you' : about, owner: w?.who ? 'them' : 'you' };

                for (const s of this.d.savedScopes(scripts, oc, top))
                    if (!s.temporary)
                        saves.push(s);
            });
            const w = sent as { who: string; conditions?: Line[]; } | null;

            if (w?.who)
                rootNotes.push({ from: o.label, who: capitalize(w.who), of: about, conditions: w.conditions });
            else if (doc?.root)
                rootNotes.push({ from: o.label, who: doc.root });

            for (const s of doc?.scopes ?? [])
                give({ name: s.name, who: [s.who ? capitalize(s.who) : tr('(not described)')], from: o.label });

            for (const s of saves)
                give({ name: s.name, who: [capitalize(s.who)], conditions: s.conditions, from: o.label, type: s.type });

            // (what the firing event had itself goes along too)
            if (o.ref.type === 'events' && !seen.has(src.id))
            {
                if (seen.size >= 60)
                {
                    cut.chain++;
                    continue;
                }

                seen.add(src.id);

                // (named by the event before, and where the name began: "A pretty daughter (First time), from Testmod 000 on …")
                for (const g of this.givenTo(src, this.origins(src), depth + 1, seen, cut).given)
                    give({ ...g, from: g.from ? tr('{label}, from {pop}', { label: o.label, pop: g.from.split(', from ').pop() }) : o.label });
            }
        }

        // (what was not read, said: the first 12 of what fires it (6 a step further back), 60 events along the chain)
        if (depth)
            return { rootNotes, given };

        const notes = [
            ...(origins.length > 12 ? [tr('read from the first {read} of the {of} things that fire it', { read: 12, of: origins.length })] : []),
            ...(cut.chain ? [tr('{n} events further back along the chain not followed (at most 60 are)', { n: cut.chain })] : [])
        ];
        return { rootNotes, given, note: notes.length ? capitalize(notes.join('; ')) + '.' : undefined };
    }

    /**
     * Who is who in an event (the card's "Who's who", docs/readable-view.md): root, the scopes what fires it gives (the
     * on_actions' documentation, the names the firing events saved, an interaction's actor / recipient), the ones it
     * names itself, the ones it uses without either, its portraits. `given0`: givenTo's answer, read already
     * (eventStory reads it before its lines).
     */
    private eventCast(e: Entity, body: PNode[], node: PNode, ctx: Ctx, origins: StoryOrigin[], given0?: ReturnType<StoryBuilder['givenTo']>): EventCast
    {
        const { rootNotes, given, note } = given0 ?? this.givenTo(e, origins, 0, new Set([e.id]));
        // (where each name is in reach: after its saves; one also given by what fires the event is there from the start)
        const sites = saveSites(node, true, e.type);
        const named: CastMember[] = this.d.savedScopes(body, ctx).map((s) =>
        {
            const m: CastMember = { name: s.name, who: [s.who], conditions: s.conditions, temporary: s.temporary || undefined, type: s.type };
            const src = s.alone && s.holder ? this.d.anchor(s.holder, ctx, 'effect', false) : this.d.anchor(s.save, ctx, 'effect', false);
            const reach = given.some((g) => g.name === s.name) ? undefined : reachOf(sites.filter((x) => x.name === s.name), node, true, ctx);

            if (src)
                m.src = src;

            if (reach)
                m.reach = reach;

            return m;
        });
        const known = new Set([...given, ...named].map((m) => m.name));
        const text = ctx.src.slice(node.s, node.e);
        const unknown = [...new Set([...text.matchAll(/\bscope:(\w+)/g)].map((m) => m[1]))].filter((n) => !known.has(n));
        const portraits: EventPortrait[] = [];
        let portraitAt: LineSource | undefined;
        // (a statement as written, without the indentation of its first line on the others)
        const rawOf = (n: PNode): string =>
        {
            let ls = n.s;

            while (ls > 0 && ctx.src.charCodeAt(ls - 1) !== 10)
                ls--;

            const base = /^[ \t]*/.exec(ctx.src.slice(ls, n.s))![0];
            return ctx.src
                .slice(n.s, n.e)
                .split(/\r?\n/)
                .map((l, i) => (i && l.startsWith(base) ? l.slice(base.length) : l))
                .join('\n');
        };
        const str = (n: PNode | undefined): string | undefined => (typeof n?.v === 'string' ? n.v : undefined);

        for (const n of body)
        {
            const m = n.k && /^(left|right|center|lower_left|lower_center|lower_right)_portrait$/.exec(n.k);

            if (!m)
                continue;

            const kids = Array.isArray(n.v) ? n.v : undefined;
            const scope = typeof n.v === 'string' ? n.v : str(kids?.find((c) => c.k === 'character'));
            const src = this.d.anchor(n, ctx, 'other', false);

            if (src)
                portraitAt = src;

            if (typeof scope !== 'string')
                continue;

            const get = (k: string): PNode | undefined => kids?.find((c) => c.k === k);
            const who = this.d.scopeSeg(scope, ctx);
            // (conditions of a portrait are about the one shown)
            const clause = (t: PNode | undefined): Rich | undefined => (t && Array.isArray(t.v) ? this.d.conditionClause(this.d.triggers(t.v, { ...ctx, scope: typeof who === 'string' ? who : who.text }), scope === 'root' ? 'you' : who) : undefined);
            const outfit = get('outfit_tags');
            const p: EventPortrait = {
                pos: m[1],
                scope,
                animation: str(get('animation')),
                scripted: str(get('scripted_animation')),
                camera: str(get('camera')),
                outfitTags: outfit && Array.isArray(outfit.v) ? outfit.v.map((x) => str(x)).filter((x): x is string => !!x) : [],
                flags: (kids ?? []).filter((c) => c.k && c.v === 'yes' && PORTRAIT_FLAGS.has(c.k)).map((c) => c.k!),
                shownIf: clause(get('trigger')),
                triggered: (kids ?? [])
                    .filter((c) => c.k === 'triggered_animation' && Array.isArray(c.v))
                    .map((t) =>
                    {
                        const tk = t.v as PNode[];
                        const anim = tk.find((c) => c.k === 'animation' || c.k === 'scripted_animation');
                        const list = anim && Array.isArray(anim.v) ?
                            anim.v.map((x) => str(x))
                                .filter(Boolean)
                                .join(' / ') :
                            str(anim);
                        return { when: clause(tk.find((c) => c.k === 'trigger')) ?? ['always'], animation: list, text: rawOf(t) };
                    }),
                kids: kids ? kids.filter((c) => c.k).map((c) => ({ key: c.k!, text: rawOf(c) })) : [{ key: 'character', text: `character = ${scope}` }],
                src
            };
            portraits.push(p);
        }

        if (!portraitAt)
        {
            const after = body.find((n) => n.k === 'desc') ?? body.find((n) => n.k === 'title') ?? body.find((n) => n.k === 'theme');
            portraitAt = after && this.d.anchor(after, ctx, 'other', false);
        }

        return { rootNotes, given, named, unknown, portraits, portraitAt, givenNote: note };
    }

    /**
     * The names an event uses that it does not save itself (`scope:x` in its script): what whoever fires it passes
     * along (the picker's "Pass along…" after "Trigger an event"), with who they are by what fires it now.
     */
    eventScopes(e: Entity): { name: string; about?: string; }[]
    {
        const c = this.eventStory(e)?.cast;

        if (!c)
            return [];

        const out: { name: string; about?: string; }[] = c.unknown.map((name) => ({ name }));
        const text = this.idx.defNode(e)?.src ?? '';

        for (const g of c.given)
            if (new RegExp(`\\bscope:${g.name}\\b`).test(text) && !out.some((o) => o.name === g.name))
                out.push({ name: g.name, about: `${richToString(g.who)}${g.from ? tr(' — given by {from}', { from: g.from }) : ''}` });

        return out;
    }

    private infoDocs?: Map<string, string>;

    /** The on_actions the game's `_on_actions.info` lists ("- name  # what it is # Root is …"): name → its text. */
    private onActionInfo(): Map<string, string>
    {
        if (this.infoDocs)
            return this.infoDocs;

        const m = new Map<string, string>();

        for (const d of this.idx.typeDoc('on_action'))
            for (const line of d.text.split(/\r?\n/))
            {
                const x = /^\s*-\s*([\w.]+)\s+#\s*(.+)$/.exec(line);

                if (x)
                    m.set(x[1], x[2]);
            }

        return (this.infoDocs = m);
    }

    /** What an on_action's documentation says (the comment above it, the .info list): a summary, who root is, its scopes. */
    onActionDoc(e: Entity): { summary?: string; root?: string; scopes: { name: string; who: string; }[]; }
    {
        const out: { summary?: string; root?: string; scopes: { name: string; who: string; }[]; } = { scopes: [] };
        const tidy = (t: string): string =>
        {
            const s = t.trim().replace(/[.;,]+$/, '');
            return s.length > 180 ? s.slice(0, 177) + '…' : s;
        };
        const lines: string[] = [];

        for (const d of this.idx.liveDefs(e))
            if (d.doc)
                lines.push(...d.doc.split('\n'));

        const info = this.onActionInfo().get(e.name);

        if (info)
            lines.push(...info.split(/\s#\s*/));

        for (const raw of lines)
        {
            const t = raw.replace(/^[#\s-]+/, '').trim();

            if (!t)
                continue;

            const sc = /^(?:saved\s+)?scope:(\w+)\s*(?:=|:|-|,|\bis\b)?\s*(.*)$/i.exec(t);

            if (sc)
            {
                if (!out.scopes.some((s) => s.name === sc[1]))
                    out.scopes.push({ name: sc[1], who: tidy(sc[2]) });

                continue;
            }

            // ("# called for the newborn child": root is the child)
            const r = /^root\s*(?:=|:|-|\bis\b)\s*(.+)$/i.exec(t) ?? /^(?:called|fired|run) (?:for|on) (.+)$/i.exec(t) ?? /\broot (?:is|=) ([^.#]+)/i.exec(t);

            if (r)
            {
                out.root ??= tidy(r[1]);

                // (a sentence of its own: the summary too)
                if (!/^root\b/i.test(t))
                    out.summary ??= tidy(t);

                continue;
            }

            if (!out.summary && t.length > 3 && !/^[=\-*#\s]+$/.test(t))
                out.summary = tidy(t);
        }

        return out;
    }

    /**
     * Every on_action for the event card's "When it happens…" (docs/mods.md, "What fires an event"): its documentation,
     * how many events it fires, whether the game fires it (nothing in script does), whether it fires `event` already.
     */
    onActionList(event?: Entity): OnActionInfo[]
    {
        const fires = new Map<string, 'always' | 'sometimes'>();

        if (event)
        {
            for (const o of this.origins(event))
                if (o.ref.type === 'on_action')
                    fires.set(o.ref.name, o.when === 'sometimes' ? 'sometimes' : 'always');
        }

        const out: OnActionInfo[] = [];

        for (const name of this.idx.names('on_action'))
        {
            const e = this.idx.get('on_action', name);

            if (!e || this.idx.isRemoved(e))
                continue;

            let events = 0;
            let randomEvents = 0;
            e.defs.forEach((d, i) =>
            {
                if (!this.idx.liveDefs(e).includes(d))
                    return;

                const n = this.idx.defNode(e, undefined, i);

                for (const c of n && Array.isArray(n.node.v) ? n.node.v : [])
                {
                    if (!Array.isArray(c.v))
                        continue;

                    if (c.k === 'events')
                        events += c.v.filter((x) => x.k === null && typeof x.v === 'string').length;

                    if (c.k === 'random_events')
                        randomEvents += c.v.filter((x) => x.k !== null && /^\d+(\.\d+)?$/.test(x.k) && x.v !== '0').length;
                }
            });
            const doc = this.onActionDoc(e);
            const item: OnActionInfo = {
                name,
                label: capitalize(humanize(name.replace(/^on_/, ''))),
                summary: doc.summary,
                root: doc.root,
                scopes: doc.scopes,
                // (the game's docs say whether its code fires it; without them: nothing in script fires it, so the game must)
                byGame: onActionFact(name)?.fromCode ?? !this.origins(e).length,
                byScript: this.origins(e).length > 0,
                events,
                randomEvents
            };
            const f = fires.get(name);

            if (f)
                item.fires = f;

            const mod = this.idx.modTouch(e);

            if (mod)
                item.mod = mod;

            out.push(item);
        }

        return out;
    }

    /** What fires this event / on_action. */
    origins(e: Entity): StoryOrigin[]
    {
        const out: StoryOrigin[] = [];

        for (const s of this.idx.incomingSources(e))
        {
            const src = s.entity;

            if (src.type === 'localization' || src.type === 'flag' || src.type === 'variable')
                continue;

            // (an event is also named as an argument of a scripted effect (OUTPUT_EVENT = …, ARRIVAL_EVENT = …) or as a
            // key such as on_arrival_event: every reference to one except its texts and flags fires it)
            if (e.type !== 'events' && !s.contexts.some((c) => FIRES.test(c)) && src.type !== 'on_action')
                continue;

            // (in the body of a scripted effect / trigger only an argument that names an event counts (OUTPUT_EVENT, on_arrival_event,
            // an id), not a title or a text that happens to hold the same words)
            if (e.type === 'events' && (src.type === 'scripted_effects' || src.type === 'scripted_triggers') && !s.contexts.some((c) => FIRES.test(c) || EVENT_ARG.test(c)))
                continue;

            const ctx = s.contexts.find((c) => FIRES.test(c)) ?? s.contexts[0];
            const when = /random_events/.test(ctx) ? 'sometimes' : /(^| › )events/.test(ctx) ? 'always' : undefined;
            const o: StoryOrigin = { ref: { type: src.type, name: src.name }, label: this.originLabel(src), typeLabel: typeLabel(src.type), when };
            const mods = this.idx.refMods(src, e);

            if (mods.length)
                o.mods = mods;

            out.push(o);
        }

        return out.sort((a, b) => a.typeLabel.localeCompare(b.typeLabel) || a.label.localeCompare(b.label)).slice(0, 5000);
    }

    /**
     * A line of the on_action's note: what no list row shows (a random list's `0 = …` weight, "N% chance that nothing
     * happens"); the chance statements and a list's start delay are rows of their list (listInfo).
     */
    private addNote(story: OnActionStory, text: string): void
    {
        (story.notes ??= []).push(text);
    }

    /** How a chance_to_happen / chance_of_no_event statement reads (_on_actions.info: N percent, a script value, a block). */
    private chanceText(c: PNode): string
    {
        if (c.k === 'chance_to_happen')
        {
            if (typeof c.v === 'string')
                return tr('Only happens {v}% of the time', { v: this.d.evalValue(c.v) ?? c.v });

            return tr('Only happens some of the time');
        }

        const v = typeof c.v === 'string' ? this.d.evalValue(c.v) : undefined;

        if (v !== undefined)
            return tr('{v}% chance that nothing happens', { v });

        if (typeof c.v === 'string' && !c.v.startsWith('$'))
            return tr('Chance that nothing happens: {name}', { name: capitalize(humanize(c.v)) });

        return tr('Sometimes nothing happens');
    }

    /** "after 5 days" for a delay block; none for a delay that is no time (negative) or not worked out. */
    private delayText(block: PNode[], ctx: Ctx): string | undefined
    {
        const time = this.d.duration(block, ctx);
        return time ? tr('after {time}', { time }) : undefined;
    }

    /** Whether an event has no `trigger` block (it applies whenever it is reached); false for one the index does not have. */
    private eventHasNoTrigger(name: string): boolean
    {
        const t = this.idx.get('events', name);
        const def = t && this.idx.defNode(t);
        return !!def && !this.body(def.node).some((n) => n.k === 'trigger');
    }

    /**
     * What an on_action's list holds besides its entries (OnActionList): its `delay` and chance statements as lines with
     * their anchors, the first entry (a new delay or chance goes before it) and the statements "Delay…" / "Chance…"
     * change. `ctx` reads the definition the list is written in. Only the definition edits go into (`own`) gives its
     * rows anchors and the statements "Delay…" / "Chance…" change; another definition's rows are read-only. A delay
     * after the first entry is the chip of the entries after it (FollowUp.delay, delayAt) when it is the last delay
     * before a later entry; one that no chip owns (after the last entry, or replaced by a later delay before any entry)
     * is a row, so it can still be seen, changed and taken out.
     */
    private listInfo(block: PNode | undefined, ctx: Ctx, own = true): OnActionList
    {
        const info: OnActionList = { lines: [] };
        const list = block && Array.isArray(block.v) ? block.v : [];
        const anchor = (n: PNode): LineSource | undefined => (own ? this.d.anchor(n, ctx, 'other', false) : undefined);
        const isEntry = (c: PNode): boolean => typeof c.v === 'string' && (c.k === null || NUMERIC_KEY.test(c.k));
        let entries = 0;

        for (let i = 0; i < list.length; i++)
        {
            const c = list[i];

            if (c.k === 'delay' && Array.isArray(c.v) && entries)
            {
                // (the statement after it that decides: an entry (this delay is its chip), another delay, or none)
                const next = list.slice(i + 1).find((n) => isEntry(n) || (n.k === 'delay' && Array.isArray(n.v)));

                if (next && isEntry(next))
                    continue;

                const src = anchor(c);
                const time = this.d.duration(c.v, ctx) ?? '?';
                const text = next
                    ? tr('Delay ({time}): the next delay replaces it before any entry', { time })
                    : tr('Delay after the last entry ({time}): it holds nothing back', { time });
                info.lines.push({ text: [text], icon: 'note', ...(src ? { src } : {}) });
                continue;
            }

            if (isEntry(c))
            {
                if (!entries++)
                    info.first = anchor(c);

                continue;
            }

            const src = anchor(c);
            const row = (l: Line): void =>
            {
                info.lines.push(src ? { ...l, src } : l);
            };

            // (only a delay before the first entry is the list's: it counts for all of them; a later one is the chip)
            if (c.k === 'delay' && Array.isArray(c.v) && !entries)
            {
                const time = this.d.duration(c.v, ctx);
                row({ text: [time ? tr('Delay: {time}', { time }) : tr('Delay')], icon: 'note' });

                if (!info.delay && src)
                    info.delay = src;
            }
            else if (c.k === 'chance_to_happen' || c.k === 'chance_of_no_event')
            {
                row({ text: [this.chanceText(c)], icon: 'chance' });

                if (src)
                    info[c.k] ??= src;
            }
        }

        return info;
    }

    /**
     * An entry's share in a weighted list as the "when" of its follow-up. The game also factors each weight by the target's
     * own weight_multiplier (_on_actions.info), which is not worked in: such a share is approximate (~).
     */
    private shareOf(pct: number, type: string, name: string): Rich
    {
        const t = this.idx.get(type, name);
        const def = t && this.idx.defNode(t);
        const factored = !!def && this.body(def.node).some((n) => n.k === 'weight_multiplier');
        return factored
            ? [{ text: `~${formatNumber(pct)}%`, kind: 'value', tip: tr('The listed weights give this share; the target’s own weight_multiplier changes it further.') }]
            : [`${formatNumber(pct)}%`];
    }

    private originLabel(e: Entity): string
    {
        if (e.type === 'on_action')
            return capitalize(humanize(e.name.replace(/^on_/, '')));

        return this.label(e);
    }

    // -------------------------------------------------------------------------
    // on_actions
    // -------------------------------------------------------------------------

    onActionStory(e: Entity): OnActionStory
    {
        const story: OnActionStory = {
            key: { type: e.type, name: e.name },
            label: capitalize(humanize(e.name.replace(/^on_/, ''))),
            doc: this.idx.liveDefs(e).find((d) => d.doc)?.doc,
            conditions: [],
            events: [],
            randomEvents: [],
            firstValid: [],
            onActions: [],
            randomOnActions: [],
            firstValidOnActions: [],
            fallbacks: [],
            effects: [],
            effectFollowUps: [],
            origins: this.origins(e)
        };
        // the definition edits go into (editing in place): a mod's last loaded one, else the winning one
        const loaded = e.defs.map((_d, i) => i).filter((i) => !this.idx.isHiddenDef(e.defs[i]));
        const own = [...loaded].reverse().find((i) => this.idx.defAnchor(e, i)?.mod) ?? loaded[loaded.length - 1];
        // (its list entries carry anchors: ✕ removes one)
        let anchorOf: ((n: PNode) => LineSource | undefined) | undefined;
        // (where an entry stands in its list: after the first one, and the delay statement right before it)
        type EntryPos = { later: boolean; delayNode?: PNode; };
        const follow = (type: string, name: string, delay?: string, when: Rich[] = [], at?: PNode, pos?: EntryPos): FollowUp =>
        {
            const t = this.idx.get(type, name);
            const f: FollowUp = { target: { type, name }, label: t ? this.originLabel(t) : name, delay, when };
            const src = at && anchorOf?.(at);

            if (src)
                f.src = src;

            // (an entry of the editable list after its first: "Delay from here…", the delay written right before it)
            if (src && pos?.later)
            {
                f.afterFirst = true;
                const d = pos.delayNode && anchorOf?.(pos.delayNode);

                if (d)
                    f.delayAt = d;
            }

            return f;
        };
        // the lists' rows of every loaded definition, merged per list (one row per statement; with more than one
        // definition writing a list, the tip names the file)
        const rows = new Map<OnActionListKey, { lines: Line[]; rel: string; }[]>();
        const LISTS: [OnActionListKey, string[]][] = [
            ['events', ['events']],
            ['random_events', ['random_events']],
            ['first_valid', ['first_valid']],
            ['on_actions', ['on_actions']],
            ['random_on_action', ['random_on_action', 'random_on_actions']],
            ['first_valid_on_action', ['first_valid_on_action']]
        ];
        // (`random_on_actions`: the files that spell it so; the game's files and its .info write `random_on_action`)
        const plural: string[] = [];
        // (the entries of a list with the delay that holds for each: only one after the first entry is a chip, a start
        // delay is the list's row)
        const entriesOf = (list: PNode[], ctx: Ctx): { c: PNode; delay?: string; pos: EntryPos; }[] =>
        {
            const out: { c: PNode; delay?: string; pos: EntryPos; }[] = [];
            let delay: string | undefined;
            // (the last delay written since the entry before: the chip's statement, also with a chance between it and
            // the entry; listInfo makes the others rows)
            let since: PNode | undefined;

            for (const c of list)
            {
                if (c.k === 'delay' && Array.isArray(c.v))
                {
                    // (a new delay overrides the one before, _on_actions.info)
                    delay = out.length ? this.delayText(c.v, ctx) : undefined;
                    since = out.length ? c : undefined;
                    continue;
                }

                if (typeof c.v === 'string' && (c.k === null || NUMERIC_KEY.test(c.k)))
                {
                    out.push({ c, delay, pos: { later: out.length > 0, delayNode: since } });
                    since = undefined;
                }
            }

            return out;
        };

        const docScopes = new Set(this.onActionDoc(e).scopes.map((s) => s.name));

        // every loaded definition merges in (files a mod hid don't count)
        for (let i = 0; i < e.defs.length; i++)
        {
            if (this.idx.isHiddenDef(e.defs[i]))
                continue;

            const def = this.idx.defNode(e, undefined, i);

            if (!def)
                continue;

            const defAt = this.idx.defAnchor(e, i);
            // (its root by the game's docs: 24 of vanilla's are a faith's, a culture's, an artifact's, an army's …; not documented: a character)
            const ctx = rootCtx(def.src, defAt, onActionFact(e.name)?.root ?? 'character');
            ctx.consts = this.idx.fileConstants(e);
            // (the variables this definition's script sets to a scope: `var:x = { … }` in its effect holds that scope)
            ctx.varTypes = this.varTypesOf(def.node, ctx);
            // (the scopes its documentation names are given by the game: never typed by their block's use)
            ctx.knownScopes = docScopes;
            anchorOf = i === own ? (n) => this.d.anchor(n, ctx, 'other', false) : undefined;
            const body = this.body(def.node);
            // (a list is read as any of its keys: the .info spells `random_on_action`, an older file `random_on_actions`;
            // a new one is made under the first)
            const found = (keys: string[]): PNode | undefined => [...body].reverse().find((n) => !!n.k && keys.includes(n.k) && Array.isArray(n.v));

            // (every definition's lists: their rows; the own definition's also where new statements go)
            for (const [key, keys] of LISTS)
            {
                const b = found(keys);

                if (!b)
                    continue;

                const info = this.listInfo(b, ctx, i === own);

                if (i === own)
                    (story.lists ??= {} as Record<OnActionListKey, OnActionList>)[key] = info;

                if (info.lines.length)
                    rows.set(key, [...(rows.get(key) ?? []), { lines: info.lines, rel: defAt?.rel ?? '' }]);
            }

            if (body.some((n) => n.k === 'random_on_actions' && Array.isArray(n.v)) && defAt?.rel && !plural.includes(defAt.rel))
                plural.push(defAt.rel);

            if (i === own)
            {
                story.src = this.d.anchor(def.node, ctx, 'other', true);
                const section = (keys: string[], kind: SectionSource['kind']): SectionSource =>
                {
                    const b = found(keys);
                    const src = b && this.d.anchor(b, ctx, kind, true);
                    return src ? { src, key: b.k!, kind } : { parent: story.src && { ...story.src, kind }, key: keys[0], kind };
                };
                story.sections = {
                    trigger: section(['trigger'], 'trigger'),
                    effect: section(['effect'], 'effect'),
                    events: section(['events'], 'other'),
                    random_events: section(['random_events'], 'other'),
                    first_valid: section(['first_valid'], 'other'),
                    on_actions: section(['on_actions'], 'other'),
                    random_on_action: section(['random_on_action', 'random_on_actions'], 'other'),
                    first_valid_on_action: section(['first_valid_on_action'], 'other')
                };
                // (a list it does not write: no rows, a new statement goes inside the list its first entry makes)
                story.lists ??= {} as Record<OnActionListKey, OnActionList>;

                for (const [key] of LISTS)
                    story.lists[key] ??= { lines: [] };

                // (first_valid: an unconditional last event always applies: a new one goes before it)
                const last = found(['first_valid'])?.v;
                const lastEntry = Array.isArray(last) ? [...last].reverse().find((c) => c.k === null && typeof c.v === 'string') : undefined;

                if (lastEntry && typeof lastEntry.v === 'string' && this.eventHasNoTrigger(lastEntry.v))
                    story.firstValidLast = this.d.anchor(lastEntry, ctx, 'other', false);
            }

            for (const n of this.body(def.node))
            {
                const list = Array.isArray(n.v) ? n.v : null;

                // (the scalar forms: fallback = on_action (the game's own use), fallback_event = event; the .info: fired when
                // nothing else of the on_action fired)
                if (!list && typeof n.v === 'string' && (n.k === 'fallback' || n.k === 'fallback_event'))
                {
                    // (the pool "If nothing else fires": the event of `fallback_event`, the on_action of `fallback`)
                    story.fallbacks.push(n.k === 'fallback' ? follow('on_action', n.v, undefined, [], n) : follow('events', n.v, undefined, [], n));
                    continue;
                }

                if (!list)
                    continue;

                // (a list's only entry stands for the list: ✕ takes both)
                const at = (c: PNode): PNode => (list.length === 1 ? n : c);

                // (loops, not push(...list): a list of tens of thousands overflows the stack)
                if (n.k === 'trigger')
                {
                    for (const l of this.d.triggers(list, ctx))
                        story.conditions.push(l);
                }
                else if (n.k === 'effect')
                {
                    const c = { ...ctx, followUps: [] as FollowUp[] };

                    for (const l of this.d.effects(list, c))
                        story.effects.push(l);

                    for (const f of c.followUps)
                        story.effectFollowUps.push(f);
                }
                else if (n.k === 'events' || n.k === 'first_valid')
                {
                    // (a start delay is the list's row; chances are rows too: listInfo)
                    for (const x of entriesOf(list, ctx))
                    {
                        if (x.c.k === null && typeof x.c.v === 'string')
                            (n.k === 'events' ? story.events : story.firstValid).push(follow('events', x.c.v, x.delay, [], at(x.c), x.pos));
                    }
                }
                else if (n.k === 'random_events')
                {
                    const entries = entriesOf(list, ctx).map((x) => ({ ...x, w: x.c.k === null ? 1 : parseFloat(x.c.k), ev: x.c.v as string }));
                    const total = entries.reduce((s, x) => s + x.w, 0);

                    for (const x of entries)
                    {
                        const pct = total ? Math.round((x.w / total) * 1000) / 10 : 0;

                        if (x.ev === '0')
                            this.addNote(story, tr('{formatNumber}% chance that nothing happens', { formatNumber: formatNumber(pct) }));
                        else
                            story.randomEvents.push(follow('events', x.ev, x.delay, [this.shareOf(pct, 'events', x.ev)], at(x.c), x.pos));
                    }
                }
                else if (n.k === 'on_actions' || n.k === 'random_on_actions' || n.k === 'random_on_action' || n.k === 'first_valid_on_action' || n.k === 'fallback')
                {
                    // (each list is a pool of its own: also triggers, picks one at random, first that applies, if nothing else fires)
                    const pool = n.k === 'on_actions' ? story.onActions : n.k === 'first_valid_on_action' ? story.firstValidOnActions : n.k === 'fallback' ? story.fallbacks : story.randomOnActions;
                    // (weighted ones (`20 = some_on_action`): each one's chance)
                    const weighted = list.filter((c) => c.k !== null && NUMERIC_KEY.test(c.k) && typeof c.v === 'string');
                    const total = weighted.reduce((t, c) => t + parseFloat(c.k!), 0);

                    // (a name, or one with its weight; chance_to_happen, a delay … are no entries)
                    for (const { c, delay, pos } of entriesOf(list, ctx))
                    {
                        const name = c.v as string;
                        const pct = c.k !== null && NUMERIC_KEY.test(c.k) && total ? Math.round((parseFloat(c.k) / total) * 1000) / 10 : undefined;

                        if (name === '0')
                        {
                            if (pct !== undefined)
                                this.addNote(story, tr('{formatNumber}% chance that nothing happens', { formatNumber: formatNumber(pct) }));

                            continue;
                        }

                        // (a random list: each one's share; the others read by the pool they are in)
                        const label = pct !== undefined && pool === story.randomOnActions ? [this.shareOf(pct, 'on_action', name)] : [];
                        pool.push(follow('on_action', name, delay, label, at(c), pos));
                    }
                }
            }
        }

        // (the rows each list shows: every definition's, in load order; the own definition's own objects keep its anchors)
        if (rows.size || plural.length)
            story.lists ??= {} as Record<OnActionListKey, OnActionList>;

        for (const [key, per] of rows)
        {
            const list = (story.lists![key] ??= { lines: [] });
            const many = per.length > 1;
            list.lines = per.flatMap((p) => (many ? p.lines.map((l) => ({ ...l, tip: tr('Written in {rel}', { rel: p.rel }) })) : p.lines));
        }

        if (plural.length)
            (story.lists!.random_on_action ??= { lines: [] }).plural = plural;

        return story;
    }

    // -------------------------------------------------------------------------
    // Cards (everything else)
    // -------------------------------------------------------------------------

    /** An entry's card, a loaded save's word on it first ("Savegame": docs/saves.md). */
    card(e: Entity): EntityCard
    {
        const card = this.cardOf(e);
        const facts = this.idx.vfs.save?.facts.get(`${e.type}|${e.name}`);

        for (const s of card.sections)
            modifierKindsDown(s.lines, s.src?.kind === 'modifier' ? s.src.scope : undefined, s.src?.kind === 'modifier' ? s.src.src : undefined);

        // (an entry a mod changes: what it changes against the game's, on top; hidden for now: SHOW_MOD_CHANGES)
        const changed = SHOW_MOD_CHANGES ? this.modChanges(e) : undefined;

        if (changed)
            card.sections.unshift(changed);

        if (facts?.length)
        {
            const seg = (r: { type?: string; name: string; }): RichSeg => this.d.ref(r.name, r.type ? [r.type] : undefined);
            card.sections.unshift({
                title: tr('Savegame'),
                lines: facts.map((f) => ({
                    text: rich(f.label + ': ', ...(f.ref ? [seg(f.ref)] : f.refs ? f.refs.flatMap((r, i) => (i ? [', ', seg(r)] : [seg(r)])) : [{ text: f.text ?? '', kind: 'value' as const }])),
                    icon: 'note'
                }))
            });
        }

        return card;
    }

    /**
     * What a mod's definition changes against the game's (the Summary's "Changed by <mod>", docs/mods.md "Changed by
     * the mod"): the definitions' own statements by key, equal ones (spacing and comments aside) paired off; the rest
     * changed (both sides have the key: the mod's lines, the game's below them), added or removed, each read as the
     * card reads its settings. A definition inside it (a religion's faith) is an entry of its own and left out.
     */
    private modChanges(e: Entity): CardSection | undefined
    {
        const t = this.idx.modTouch(e);

        if (t?.state !== 'overridden' || this.idx.vfs.save)
            return undefined;

        const win = this.idx.winningIdx(e);
        let game = -1;

        for (let i = e.defs.length - 1; i >= 0 && game < 0; i--)
            if (this.idx.files[e.defs[i].file].source === 0)
                game = i;

        if (win < 0 || game < 0 || this.idx.files[e.defs[win].file].source === 0)
            return undefined;

        const a = this.idx.defNode(e, undefined, game);
        const b = this.idx.defNode(e, undefined, win);

        if (!a || !b || !Array.isArray(a.node.v) || !Array.isArray(b.node.v))
            return undefined;

        // (a nested definition: a block whose key names an entry defined right there)
        const own = (n: PNode, def: Def): boolean => !!n.k && Array.isArray(n.v) && this.idx.named(n.k).some((x) => x.id !== e.id && x.defs.some((d) => d.file === def.file && d.line === def.line + n.line - 1));
        const groups = (list: PNode[], def: Def): Map<string, PNode[]> =>
        {
            const m = new Map<string, PNode[]>();

            for (const n of list)
                if (!own(n, def))
                    (m.get(n.k ?? '') ?? m.set(n.k ?? '', []).get(n.k ?? '')!).push(n);

            return m;
        };
        const ga = groups(a.node.v, e.defs[game]);
        const gb = groups(b.node.v, e.defs[win]);
        const ca = rootCtx(a.src);
        const cb = rootCtx(b.src);
        const textA = (n: PNode): string => a.src.slice(n.s, n.e);
        const textB = (n: PNode): string => b.src.slice(n.s, n.e);
        // (as the card reads the settings; a statement it reads nothing for (a trait's `opposites`) as written)
        const read = (nodes: PNode[], ctx: Ctx, text: (n: PNode) => string): Line[] =>
            nodes.flatMap((n) =>
            {
                const ls = this.fieldLines(e.type, [n], ctx);
                return ls.length ? ls : [{ text: rich(n.k ? capitalize(n.k.replace(/_/g, ' ')) + ': ' : '', { text: text(n).replace(/^[^=]*=\s*/, '').replace(/\s+/g, ' ').slice(0, 160), kind: 'code' }), tip: text(n) }];
            });
        const lines: Line[] = [];

        for (const k of new Set([...ga.keys(), ...gb.keys()]))
        {
            const xa = ga.get(k) ?? [];
            const xb = gb.get(k) ?? [];
            const was = xa.filter((n) => !xb.some((m) => sameScript(textA(n), textB(m))));
            const now = xb.filter((m) => !xa.some((n) => sameScript(textA(n), textB(m))));

            if (!was.length && !now.length)
                continue;

            if (was.length && now.length)
            {
                const mine = read(now, cb, textB);
                const theirs = read(was, ca, textA);
                lines.push({
                    text: rich(tr('Changed: '), ...(mine[0]?.text ?? [humanize(k)])),
                    icon: 'modifier',
                    tip: now.map(textB).join('\n'),
                    children: [...(mine[0]?.children ?? []), ...mine.slice(1), { text: [tr('In the game:')], icon: 'note', children: theirs, tip: was.map(textA).join('\n') }]
                });
            }
            else if (now.length)
                lines.push(...read(now, cb, textB).map((l) => ({ ...l, text: rich(tr('Added: '), ...l.text) })));
            else
                lines.push(...read(was, ca, textA).map((l) => ({ ...l, text: rich(tr('Removed: '), ...l.text) })));
        }

        if (!lines.length)
            return undefined;

        const mod = this.idx.vfs.sources[this.idx.files[e.defs[win].file].source]?.name ?? tr('a mod');
        return { title: tr('Changed by {mod}', { mod }), lines };
    }

    private cardOf(e: Entity): EntityCard
    {
        const images = this.idx.imagesOf(e);
        const card: EntityCard = {
            key: { type: e.type, name: e.name },
            title: this.label(e),
            typeLabel: typeLabel(e.type),
            icon: images.icon?.name,
            illustration: images.illu?.name,
            facts: [],
            sections: [],
            usage: this.usage(e)
        };

        if (e.type === 'images')
            return this.imageCard(e, card);

        if (e.type === 'events')
        {
            card.event = this.eventStory(e) ?? undefined;
            this.savedNames(e, card);
            const def = card.event?.src?.mod && !this.forTooltip ? this.idx.defNode(e) : undefined;

            // (a mod's event, edited in place: the saves of the scripted effects it calls, as for other entries below)
            if (def)
            {
                const cast = card.event!.cast;
                const have = new Set([...(cast?.named ?? []), ...(cast?.given ?? [])].map((m) => `scope:${m.name}`));
                const called = this.calledSaves(this.body(def.node), have);

                if (called.length)
                    card.calledSaves = called;
            }

            return card;
        }

        if (e.type === 'on_action')
        {
            card.onAction = this.onActionStory(e);
            return card;
        }

        if (e.type === 'localization')
        {
            // (the text is the key's own: ✎ changes it: the mod's line, else an override in its replace file)
            card.description = this.d.loc(e.name);
            card.descriptionKey = e.name;
            card.src = this.idx.locAnchor(e);
            return card;
        }

        // (by its name's key, else its own `desc` (a dynamic one's fallback: GameIndex.descriptionKey))
        const dk = this.idx.descriptionKey(e);
        const dr = dk === undefined ? undefined : this.d.loc(dk);

        if (dk && dr)
        {
            card.description = dr;
            card.descriptionKey = dk;
        }

        // (its name's text key: edited in place, the first the game looks up that exists)
        for (const k of displayNameCandidates(e.type, e.name))
        {
            if (this.idx.plainLoc(k) !== undefined)
            {
                card.titleKey = k;
                break;
            }
        }

        if (e.type === 'flag' || e.type === 'variable')
        {
            card.sections = this.usageSections(e);
            return card;
        }

        const def = this.idx.defNode(e);

        if (!def)
            return card;

        // (the lines read the definition's own text: they carry anchors for editing in place)
        const ctx = rootCtx(def.src, this.idx.defAnchor(e), this.rootScopeOf(e.type));
        ctx.entityType = e.type;
        ctx.consts = this.idx.fileConstants(e);
        ctx.images = { icon: images.icon?.name, illu: images.illu?.name };
        const node = def.node;
        const body = this.body(node);
        card.src = this.d.anchor(node, ctx, 'other', true);
        // (the saved scopes its script can speak of: the picker's targets)
        const { targets, known, usedOnly } = this.forTooltip ? { targets: [], known: false, usedOnly: new Set<string>() } : this.cardTargets(e, body, node, ctx);
        this.savedNames(e, card);

        if (targets.length)
        {
            card.targets = targets;
            // (the lines' scope hints: `scope:target_title = { … }` holds a title)
            ctx.savedTypes = Object.fromEntries(targets.filter((t) => t.type).map((t) => [t.key.slice(6), t.type!]));
            // (and every name known to be given or saved, typed or not, is never typed by its block's use (Describer.switched);
            // one it only uses, that nothing is known to give, is)
            ctx.knownScopes = new Set(targets.filter((t) => t.key.startsWith('scope:') && !usedOnly.has(t.key)).map((t) => t.key.slice(6)));
        }

        // (an empty known list is a fact too: no saved scope in reach, so a typed one gets the warning (a trait))
        if (targets.length || known)
            card.targetsKnown = known;

        // (a mod's entry, edited in place: the saves of the scripted effects / triggers it calls, in their own texts,
        // offered on their lines read inlined at the call)
        if (!this.forTooltip && card.src?.mod)
        {
            const called = this.calledSaves(body, new Set(targets.map((t) => t.key)));

            if (called.length)
                card.calledSaves = called;
        }

        // (the variables it sets to a scope: `var:my_title = { … }` holds a title)
        if (!this.forTooltip)
            ctx.varTypes = this.varTypesOf(node, ctx);

        // a description of its own (`desc = key`: interactions, decisions …) wins over the one found by its name
        const own0 = body.find((c) => c.k === 'desc' && typeof c.v === 'string' && c.v && !/s/.test(c.v as string));

        if (own0 && this.idx.plainLoc(own0.v as string) !== undefined)
        {
            card.description = this.d.loc(own0.v as string);
            card.descriptionKey = own0.v as string;
        }

        // the definition's own block as a section's place (scripted effects, modifiers)
        const own = (kind: SectionSource['kind'], fields?: string): SectionSource | undefined => card.src && { src: { ...card.src, kind, ...(fields ? { fields } : {}) }, key: e.name, kind };

        switch (e.type)
        {
            case 'scripted_effects':
            {
                const c = { ...ctx, expand: 3, followUps: [] as FollowUp[] };
                card.sections.push({ title: tr('What it does'), lines: this.d.effects(body, c), followUps: c.followUps, src: own('effect') });
                // (the scopes it saves for its caller; "find a thief" effects do nothing else)
                const saved = this.d.savedScopes(body, ctx, undefined, true);

                if (saved.length)
                {
                    card.sections.push({
                        title: tr('Who it saves'),
                        lines: saved.map((v) => ({
                            text: rich(v.who, v.who.includes(',') ? ',' : '', v.temporary ? tr(' for now as ') : tr(' as '), { text: `“${humanize(v.name.replace(/^\$(\w+)\$$/, '$1').toLowerCase())}”`, kind: 'value', tip: `scope:${v.name}` }),
                            icon: 'scope',
                            conditions: v.conditions?.length ? v.conditions : undefined,
                            // (when it does: the ifs around the save)
                            children: v.when?.length ? [{ text: [tr('When:')], icon: 'if', children: v.when }] : undefined,
                            tip: `save_${v.temporary ? 'temporary_' : ''}scope_as = ${v.name}`
                        }))
                    });
                }

                // (the values it works out for its caller (`save_scope_value_as`: a quality, a wealth …))
                const values = this.d.savedValues(body, ctx);

                if (values.length)
                {
                    card.sections.push({
                        title: tr('Values it saves'),
                        lines: values.map((v): Line =>
                        {
                            const vctx = v.scoped ? { ...ctx, scope: v.who } : ctx;
                            const how = Array.isArray(v.value.v) ? valueLines(this, v.value.v, vctx) : [];
                            const kids: Line[] = [...(v.when?.length ? [{ text: [tr('When:')], icon: 'if', children: v.when }] : []), ...how];
                            return {
                                text: rich(
                                    { text: `“${humanize(v.name)}”`, kind: 'value', tip: `scope:${v.name}` },
                                    v.temporary ? tr(' (for now)') : '',
                                    typeof v.value.v === 'string' ? rich(': ', this.d.valueSeg(v.value.v, vctx)) : ':',
                                    v.scoped ? tr(' — of {who}', { who: v.who }) : ''
                                ),
                                icon: 'var',
                                tip: `save_${v.temporary ? 'temporary_' : ''}scope_value_as = ${v.name}`,
                                children: kids.length ? kids : undefined
                            };
                        })
                    });
                }

                return card;
            }
            case 'scripted_triggers':
                card.sections.push({ title: tr('What it checks'), lines: this.d.triggers(body, ctx), src: own('trigger') });
                return card;
            case 'script_values':
                if (typeof node.v === 'string')
                    card.facts.push(rich(tr('Value: '), this.d.valueSeg(node.v, ctx)));
                else
                    card.sections.push({ title: tr('How it is calculated'), lines: valueLines(this, body, ctx), src: own('field', 'script_value') });

                return card;
            case 'modifiers':
            {
                // (what it is given to (a county, a character …): the picker offers those modifiers)
                const src = own('modifier');
                const applies = this.modifierGivenTo(e);
                card.sections.push({ title: tr('Effects'), lines: this.d.statsOf(body, ctx), src: src && applies ? { ...src, scope: applies } : src });
                // (`scale = { value = … desc = key }`: the effects times a value of the holder's: "more the lower the skill")
                const scale = body.find((c) => c.k === 'scale' && Array.isArray(c.v));

                if (scale)
                {
                    const sb = scale.v as PNode[];
                    const value = sb.find((c) => c.k === 'value');
                    const desc = sb.find((c) => c.k === 'desc' && typeof c.v === 'string');
                    const lines: Line[] = [];

                    if (desc)
                        lines.push({ text: rich('“', this.d.loc(desc.v as string) ?? [humanize(desc.v as string)], '”'), icon: 'note', tip: desc.v as string });

                    if (value)
                        lines.push(...(Array.isArray(value.v) ? this.formula(value.v, ctx) : [{ text: rich(tr('Times '), this.d.valueSeg(value.v as string, ctx)), icon: 'chance' }]));

                    card.sections.push({ title: tr('Scaled by'), lines });
                }

                return card;
            }
            case 'opinion_modifiers':
                this.opinionFacts(body, card);
                card.sections.push({ title: tr('How it works'), lines: this.fieldLines(e.type, body, ctx), src: own('field', e.type) });
                return card;
            case 'characters':
            // (a loaded save's characters: written like history characters; saves/project.ts)
            case 'savegame/characters':
                this.characterFacts(body, card, ctx);
                return card;
            case 'traits':
                this.traitFacts(body, card);
                this.traitSections(e, body, card, ctx, own('field', 'traits'));

                // (names and descriptions by faith, culture, gender …: `name = { first_valid = { triggered_desc … } }`)
                for (const [k, title] of [['name', tr('Names')], ['desc', tr('Descriptions')]])
                {
                    const n = body.find((c) => c.k === k && Array.isArray(c.v));
                    const lines = n ? descLines(this, n, ctx) : [];

                    if (lines.length > 1)
                        card.sections.push({ title, lines, noAdd: true });
                }

                break;
            default:
            {
                // the per-type builders (cards/): true = complete (the generic sections otherwise)
                const fn = TYPE_CARDS[e.type];

                if (fn)
                {
                    // (as the card was before its builder: built again without a statement, it tells whether the card reads it)
                    const before = this.forTooltip || !this.unknownKeys || CODE_LIKE.has(e.type) ? undefined : structuredClone(card);
                    const read = this.typedCard(fn, e, node, body, card, ctx, own);

                    if (before)
                        this.unknownSettings(fn, e, node, body, card, before, ctx, own, read);

                    // (after the pass: made by the builder, the note would tell the pass that a lone key is read)
                    if (EMPTY_NOTE.has(e.type) && !body.length)
                        card.facts.push([tr('Nothing set — the game’s defaults apply')]);

                    return card;
                }

                // (a type without a builder of its own: the statements no section reads as its settings)
                this.genericSections(e, body, card, ctx, own, undefined, true);

                if (e.type === 'scripted_guis')
                    interfaceSection(this, e, card);

                return card;
            }
        }

        this.genericSections(e, body, card, ctx, own);
        return card;
    }

    /** A per-type builder's card: the builder, then the generic sections when it is not complete. */
    private typedCard(fn: CardFn, e: Entity, node: PNode, body: PNode[], card: EntityCard, ctx: Ctx, own: (kind: SectionSource['kind'], fields?: string) => SectionSource | undefined): Set<string>
    {
        const outer = this.readKeys;
        const keys = (this.readKeys = new Set());

        try
        {
            if (!fn(this, { e, node, body, card, ctx, own }))
                this.genericSections(e, body, card, ctx, own);
        }
        finally
        {
            this.readKeys = outer;
        }

        return keys;
    }

    /** the keys the per-type builder at work reads its own way (unknownSettings leaves them out) */
    private readKeys?: Set<string>;

    /**
     * Keys a per-type builder reads in a way its card does not show one by one (a colour named once, a layout key the
     * index reads): not "keys it does not read" (unknownSettings). genericSections' `skip` counts too.
     */
    known(...keys: string[]): void
    {
        for (const k of keys)
            this.readKeys?.add(k);
    }

    /**
     * The written `key = value` statements a per-type builder's card does not read (a mod's own settings, keys the
     * builder does not know; docs/readable-view.md, "Settings"): as field lines of the type's set in its Settings
     * section (made when the card has none), so they change through the picker ("Other setting…"). A statement counts
     * as read when a line of the card is anchored at it, or when the card built again without it differs (a fact, the
     * title, a sentence made from it). A mod's own entry gets the section also when empty (its ＋ adds a setting).
     */
    private unknownSettings(fn: CardFn, e: Entity, node: PNode, body: PNode[], card: EntityCard, before: EntityCard, ctx: Ctx, own: (kind: SectionSource['kind'], fields?: string) => SectionSource | undefined, read: Set<string>): void
    {
        const set = e.type;
        const anchors: [number, number][] = [];
        const whole = card.src;
        const walk = (ls: Line[] | undefined): void =>
        {
            for (const l of ls ?? [])
            {
                if (l.src && !(whole && l.src.s === whole.s && l.src.e === whole.e))
                    anchors.push([l.src.s, l.src.e]);

                walk(l.children);
                walk(l.conditions);
            }
        };

        for (const s of card.sections)
            walk(s.lines);

        // (the statements read before the builder: the description's and the name's text keys, the card's picture)
        const shownAs = new Set([card.descriptionKey, card.titleKey].filter((k): k is string => !!k));
        const base = (p?: string): string | undefined =>
            p?.replace(/^"|"$/g, '')
                .split('/')
                .pop()
                ?.replace(/\.\w+$/, '');
        const pictures = new Set([ctx.images?.icon, ctx.images?.illu].map(base).filter((p): p is string => !!p));
        const candidates = body.filter((c) =>
        {
            // (a file constant defined inside the definition, `@x = 0.5`, is no setting)
            if (!c.k || typeof c.v !== 'string' || c.k.startsWith('@') || read.has(c.k) || (shownAs.has(c.v) && (c.k === 'desc' || c.k === 'name')) || pictures.has(base(c.v)!))
                return false;

            const a = this.d.anchor(c, ctx, 'field', false);
            return !a || !anchors.some(([s, e2]) => s <= a.s && a.e <= e2);
        });
        const at = own('field', set);
        // (the type's own field section, else a Settings section the builder anchors elsewhere (a 1.20 faith's in
        // faith_details): the lines keep their own field anchors there, so ✎ and ✕ act on them)
        let section =
            card.sections.find((s) => s.src?.kind === 'field' && s.src.src?.fields === set && s.src.key === at?.key && !s.noAdd) ??
            card.sections.find((s) => s.title === tr('Settings') && !s.noAdd);

        if (candidates.length)
        {
            const json = JSON.stringify(card);
            // (the card built without some statements: the same text = they are not read)
            const same = (drop: Set<PNode>): boolean =>
            {
                const list = body.filter((c) => !drop.has(c));
                const copy = structuredClone(before);
                this.typedCard(fn, e, { ...node, v: list }, list, copy, { ...ctx }, own);
                return JSON.stringify(copy) === json;
            };
            const unread = same(new Set(candidates)) ? candidates : candidates.filter((c) => same(new Set([c])));
            // (read as the generic Settings read them: a field of the set its way, any other key "Label: value" (a text
            // key's text, a picture's path, the .info comment as its tooltip), anchored as a field of the set)
            const docs = this.keyDocs(set);
            const kinds = this.keyKinds(set);
            const lines = unread.flatMap((c) =>
                fieldOf(set, c.k!) ? this.fieldLines(set, [c], ctx) : this.settingLines([c], ctx, docs, undefined, kinds).map((l) => (l.src ? { ...l, src: { ...l.src, kind: 'field' as const, fields: set } } : l))
            );

            if (lines.length)
            {
                if (section)
                    section.lines.push(...lines);
                else
                    card.sections.push((section = { title: tr('Settings'), lines, src: at, addLabel: 'setting' }));
            }
        }

        // (a mod's own entry: only a keyed block of a type that writes top-level settings, never a list of bare values)
        if (!section && card.src?.mod && at && !NO_TOP_SCALARS.has(set) && !body.some((c) => !c.k) && !card.sections.some((s) => s.title === tr('Settings')))
            card.sections.push({ title: tr('Settings'), lines: [], src: at, addLabel: 'setting' });
    }

    /**
     * The sections every definition gets from its statements: modifiers, trigger / effect blocks (TRIGGER_SECTIONS,
     * EFFECT_SECTIONS, `on_*`) and `cost`; keys in `skip` are left out (a per-type builder shows them its own way).
     */
    genericSections(e: Entity, body: PNode[], card: EntityCard, ctx: Ctx, own: (kind: SectionSource['kind'], fields?: string) => SectionSource | undefined, skip?: Set<string>, settings = false): void
    {
        const all = body;
        const written = new Set(body.map((c) => c.k));
        const blocks = this.conditionBlocks(e.type);

        if (skip)
        {
            body = body.filter((c) => !c.k || !skip.has(c.k));
            this.known(...skip);
        }

        const stats = this.d.statsOf(body, ctx);

        // (a trait without modifiers yet: the section to add them to)
        if (stats.length || (e.type === 'traits' && card.src))
        {
            // (a trait's modifiers are its holder's: the picker offers character modifiers)
            const src = own('modifier');
            // (no modifier of its own at the top, one block of them (a travel option's travel_modifier): the section's ＋
            // adds into that block, offering its kind's list, as ⤷＋ on its row does; not a modifier at the definition's
            // top, where the type may take none)
            const blockRows = stats.filter((l) => l.children && l.src?.inner);
            const blocksOf = blockRows.length === 1 && stats.length === 1 && e.type !== 'traits' ? body.filter((c) => c.k === blockRows[0].tip && Array.isArray(c.v)) : [];
            const at = blocksOf.length === 1 ? this.blockSection(blocksOf[0], 'modifier', ctx) : undefined;
            // (several blocks and no modifier of its own at the top (a building's character_modifier, county_modifier …):
            // the section's ＋ asks "Into which block?" first (the owner's choice), each block as its ⤷＋ adds, with its
            // kind; a block row is matched to its statement by its anchor, so two blocks of one key stay apart)
            const into = !at && blockRows.length > 1 && blockRows.length === stats.length && e.type !== 'traits' && src
                ? blockRows.flatMap((l) =>
                {
                    const b = body.filter((c) => c.k === l.tip && Array.isArray(c.v)).map((c) => this.blockSection(c, 'modifier', ctx)).find((x) => x?.src?.s === l.src!.s);
                    return b ? [{ label: l.text.map((x) => (typeof x === 'string' ? x : x.text)).join('').replace(/:$/, ''), at: b }] : [];
                })
                : [];
            card.sections.push({ title: tr('Modifiers'), lines: stats, src: at ?? (src && e.type === 'traits' ? { ...src, scope: 'character' } : src && into.length > 1 ? { ...src, into } : src) });
        }

        if (e.type === 'traits')
        {
            const opinion = this.traitOpinion(body, card.title, ctx);

            // (when anchored also empty: opinion fields can be added)
            if (opinion.length || card.src)
                card.sections.push({ title: tr('Opinion'), lines: opinion, src: own('field', 'trait_opinion') });
        }

        // sections with a block of their own come also when empty (when anchored): statements can be added to them
        for (const c of body)
        {
            if (!c.k || !Array.isArray(c.v))
                continue;

            if (TRIGGER_SECTIONS[c.k] || blocks.has(c.k))
            {
                const scope = this.blockScope(e.type, c.k);
                // (a documented block runs in its own scope, whatever the card's root is (blockCtx): its lines are read in it
                // and their anchors carry it (LineSource.scope / root); InPlaceEdit hands them to the picker, so a Change or
                // ＋ on a line inside opens at that scope)
                const bctx = this.blockCtx(c, ctx, scope);
                const lines = this.d.triggers(c.v, bctx);
                const src = this.blockSection(c, 'trigger', bctx);

                if (lines.length || src)
                    card.sections.push({ title: TRIGGER_SECTIONS[c.k] ?? blocks.get(c.k)!.title, lines, src: src && scope ? { ...src, scope } : src });
            }
            // (a text with its variants, a casus belli's `on_victory_desc = { first_valid = { triggered_desc … } desc = … }`:
            // its texts with their conditions, not effects)
            else if (/_desc$/.test(c.k) && c.v.length && c.v.every((x) => x.k === null || ['desc', 'first_valid', 'random_valid', 'triggered_desc'].includes(x.k)))
            {
                const lines = descLines(this, c, ctx);
                const src = this.blockSection(c, 'other', ctx);

                if (lines.length || src)
                    card.sections.push({ title: tr('{what}: the text shown', { what: capitalize(humanize(c.k.replace(/_desc$/, ''))) }), lines, src });
            }
            else if (EFFECT_SECTIONS[c.k] || (/^on_/.test(c.k) && c.k !== 'on_action'))
            {
                const fctx = { ...ctx, followUps: [] as FollowUp[] };
                const lines = this.d.effects(c.v, fctx);
                const src = this.blockSection(c, 'effect', ctx);

                if (lines.length || src)
                    card.sections.push({ title: EFFECT_SECTIONS[c.k] ?? capitalize(humanize(c.k)), lines, followUps: fctx.followUps, src });
            }
            else if (c.k === 'cost')
            {
                const lines = this.cost(c.v, ctx);
                const src = this.blockSection(c, 'field', ctx, 'cost');

                if (lines.length || src)
                    card.sections.push({ title: tr('Cost'), lines, src });
            }
            else if (WEIGHT_SECTIONS[c.k])
            {
                const lines = weightLines(this, c.v, ctx);
                const src = this.blockSection(c, 'field', ctx, 'weight');

                if (lines.length || src)
                    card.sections.push({ title: WEIGHT_SECTIONS[c.k], lines, src });
            }
            // (any other block that is a formula: a chance, an AI value, a predicted cost: read and changed as one)
            else if (formulaOf(c))
            {
                const set = formulaOf(c)!;
                const lines = set === 'weight' ? weightLines(this, c.v, ctx) : valueLines(this, c.v, ctx);
                const src = this.blockSection(c, 'field', ctx, set);

                if (lines.length || src)
                    card.sections.push({ title: capitalize(humanize(c.k)), lines, src });
            }
        }

        // the statements no section reads (types without a builder of their own): Settings
        if (settings)
        {
            const read = (c: PNode): boolean => !!c.k && (!!TRIGGER_SECTIONS[c.k] || blocks.has(c.k) || !!EFFECT_SECTIONS[c.k] || (/^on_/.test(c.k) && c.k !== 'on_action' && Array.isArray(c.v)) || c.k === 'cost' || !!WEIGHT_SECTIONS[c.k] || !!formulaOf(c) || this.d.statsOf([c]).length > 0);
            const rest = all.filter((c) => c.k && !read(c) && !(c.k === 'desc' && card.descriptionKey === c.v));
            // (a type the field catalog knows: its settings read as fields and change through the picker, the others as script)
            const docs = this.keyDocs(e.type);
            const kinds = this.keyKinds(e.type);
            const known = (c: PNode): boolean => !!FIELDS[e.type] && typeof c.v === 'string' && !!fieldOf(e.type, c.k!);
            // (any other `key = value` of a type that takes other settings (every type without a curated set, docs/picker.md
            // "Other setting…"), and a block field (`asset = { … }`, `send_option = { … }`): read as settings, changed
            // through the picker; a block it cannot take apart opens the script editor)
            const open = isOpenSet(e.type);
            const asField = (c: PNode): boolean => (typeof c.v === 'string' && open) || (Array.isArray(c.v) && fieldOf(e.type, c.k!)?.kind === 'block');
            const lines = rest.flatMap((c) =>
                known(c)
                    ? this.fieldLines(e.type, [c], ctx).map((l) => (docs.get(c.k!) ? { ...l, tip: `${l.tip}: ${docs.get(c.k!)}` } : l))
                    : this.settingLines([c], ctx, docs, undefined, kinds).map((l) => (l.src && asField(c) ? { ...l, src: { ...l.src, kind: 'field' as const, fields: e.type } } : l))
            );

            if (lines.length || card.src)
                card.sections.push({ title: tr('Settings'), lines, src: own('field', e.type), addLabel: 'setting' });
        }

        // the condition blocks the type takes and this definition lacks: a row each, made with its first condition (a
        // mod's entry; the game's are not edited)
        if (card.src?.mod)
        {
            const missing = [...blocks].filter(([key]) => !written.has(key));
            const lines: Line[] = [];

            for (const [key, b] of missing)
            {
                const parent = { ...card.src, kind: 'trigger' as const, ...(b.scope ? { scope: b.scope, innerScope: b.scope } : {}) };
                const at: SectionSource = { parent, key, kind: 'trigger', ...(b.scope ? { scope: b.scope } : {}), ...this.blockHint(e.type, key) };
                // (two blocks of the same title, is_valid and is_valid_showing_failures_only, told apart by their keys)
                const label = [...blocks].some(([k, o]) => k !== key && o.title === b.title) ? `${b.title} (${key})` : b.title;
                lines.push({ text: rich(label, ': ', { text: tr('not written'), kind: 'ph' }), placeholder: true, tip: `${key} = { … }${b.about ? `: ${b.about}` : ''}`, act: { label: tr('＋ condition'), src: card.src, do: { kind: 'add', at, title: b.title } } });
            }

            if (lines.length)
                card.sections.push({ title: tr('More conditions'), lines, noAdd: true });

            // the modifier blocks it lacks: a row each, made with its first modifier
            const mods: Line[] = [];

            for (const [key, b] of this.modifierBlocks(e.type))
            {
                if (written.has(key))
                    continue;

                const applies = modifierScopeOf(key, e.type);
                const at: SectionSource = { parent: { ...card.src, kind: 'modifier' }, key, kind: 'modifier', ...(applies ? { scope: applies } : {}), ...this.blockHint(e.type, key, 'modifier') };
                mods.push({ text: rich(b.title, ': ', { text: tr('not written'), kind: 'ph' }), placeholder: true, tip: `${key} = { … }${b.about ? `: ${b.about}` : ''}`, act: { label: tr('＋ modifier'), src: card.src, do: { kind: 'add', at, title: b.title } } });
            }

            if (mods.length)
                card.sections.push({ title: tr('More modifiers'), lines: mods, noAdd: true });
        }
    }

    /**
     * Statements as settings (docs/readable-view.md, "Settings"): "Label: value" (an entry linked, a text key read, yes /
     * no), a duration read ("5 years"), a list of values joined, a block "Label:" with its statements under it. The
     * tooltip is the key with the type's .info comment on it (`keyDocs`). Anchored: each is edited as script.
     */
    settingLines(list: PNode[], ctx: Ctx, docs: Map<string, string>, parent?: string, kinds?: Map<string, 'trigger' | 'effect'>): Line[]
    {
        const out: Line[] = [];

        for (const c of list)
        {
            if (!c.k)
                continue;

            const label = capitalize(humanize(c.k));
            const doc = docs.get(c.k);
            const tip = doc ? `${c.k}: ${doc}` : c.k;
            const src = ctx.file ? this.d.anchor(c, ctx, 'other', Array.isArray(c.v)) : undefined;
            const line: Line = { text: [], tip, ...(src ? { src } : {}) };

            if (typeof c.v === 'string')
            {
                line.text = rich(label, ': ', this.settingValue(c.v, ctx, c.k, parent));

                // (a text key's text: ✎ text changes it in place)
                if (this.isTextKey(c.v, c.k))
                    line.locKey = c.v;

                // (a picture: ✎ opens the picture chooser)
                const act = src && this.pictureAct(c.k, c.v, src);

                if (act)
                    line.act = act;
            }
            else
            {
                const keyed = c.v.filter((x) => x.k);
                const bare = c.v.filter((x) => !x.k && typeof x.v === 'string').map((x) => x.v as string);

                if (keyed.length && keyed.every((x) => x.k === 'years' || x.k === 'months' || x.k === 'days') && !bare.length)
                    line.text = rich(label, ': ', this.d.duration(c.v, ctx));
                else if (!keyed.length)
                    line.text = rich(label, ': ', ...(bare.length ? bare.flatMap((v, i) => (i ? [', ', this.settingValue(v, ctx, c.k!)] : [this.settingValue(v, ctx, c.k!)])) : ['none']));
                else if (kinds?.get(c.k) === 'effect' || /^on_\w+$/.test(c.k) || c.k === 'effect')
                {
                    // (a block the type's .info gives as `= effect` (`on_accept = effect`): read as effects, not key by key)
                    line.text = [label + ':'];
                    line.children = this.d.effects(c.v, { ...ctx, followUps: [] });
                }
                else if (kinds?.get(c.k) === 'trigger' || (keyed.every((x) => CONDITION_LOGIC.has(x.k!) || !!this.idx.get('scripted_triggers', x.k!)) && !bare.length) || CONDITION_KEY.test(c.k))
                {
                    // (a trigger: `auto_accept = yes/no/trigger` in the .info, or plainly one: OR, NOT, trigger_if …, or
                    // named as one: `is_location_valid = { has_holding = yes }`)
                    line.text = [label + ':'];
                    line.children = this.d.triggers(c.v, ctx);
                }
                else if (keyed.length && keyed.every((x) => DESC_KEYS.has(x.k!)) && keyed.some((x) => x.k !== 'desc' || Array.isArray(x.v)))
                {
                    // (a text with its variants, `province_description = { desc = … triggered_desc = { trigger desc } }`:
                    // its texts with their conditions, not "Triggered desc: Trigger: …")
                    line.text = [label + ':'];
                    line.children = descLines(this, c, ctx);
                }
                else if (c.k === 'cost')
                {
                    // (an option's cost, `cost = { gold = { add = … } }`: read as the card's own Cost)
                    line.text = [label + ':'];
                    line.children = this.cost(c.v, ctx);
                }
                else if (formulaOf(c) || (keyed.some((x) => WEIGHT_KEYS.test(x.k!)) && keyed.every((x) => FORMULA_KEYS.has(x.k!) || /_modifiers?$/.test(x.k!) || !!this.idx.get('scripted_modifiers', x.k!))))
                {
                    // (a worked-out amount: its steps; a weight with scripted modifiers among its modifiers, a faction's
                    // `county_join_score = { base = 0 modifier = { … } legalism_virtue_and_sin_modifier = { … } }`)
                    line.text = [label + ':'];
                    line.children = formulaOf(c) === 'script_value' ? valueLines(this, c.v, ctx) : weightLines(this, c.v, ctx);
                }
                else
                {
                    line.text = [label + ':'];
                    line.children = this.settingLines(c.v, ctx, new Map(), c.k);
                }
            }

            out.push(line);
        }

        return out;
    }

    /**
     * A setting's value: yes / no; a file path, or the value of a picture / icon / sound key, as written; a text key's
     * text (quoted); else as values read (entries linked, numbers, scopes).
     */
    private settingValue(v: string, ctx: Ctx, key: string, parent?: string): RichSeg
    {
        // (a constant of the file: its value)
        v = this.d.constOf(v, ctx);

        if (v === 'yes' || v === 'no')
            return v;

        // (a window or widget of the interface: a link to the GUI tab)
        const gui = this.d.guiSeg(key, v, parent);

        if (gui)
            return gui;

        // (a picture: written as its path, or as the name the card's own icon / illustration was found by)
        const base = (p?: string): string | undefined =>
            p?.split('/')
                .pop()
                ?.replace(/\.\w+$/, '');
        const path = /\.(dds|png|tga)"?$/i.test(v) ? v.replace(/^"|"$/g, '') : /icon/.test(key) && base(ctx.images?.icon) === v ? ctx.images!.icon : /illustration|picture|background/.test(key) && base(ctx.images?.illu) === v ? ctx.images!.illu : undefined;

        if (path && /\.(dds|png|tga)$/i.test(path))
            return { text: path, kind: 'image', tip: v };

        // (an icon of a scope, `left_icon = root.task_contract_taker`, is a scope, not a picture)
        if (/^(scope:|root\b|prev\b|this\b)/.test(v))
            return this.d.valueSeg(v, ctx);

        if (/[/\\]|\.(dds|png|tga|txt|gui|mesh|asset)$/i.test(v) || /icon|picture|texture|reference|sound|background|illustration|gfx/.test(key))
            return { text: v, kind: 'code' };

        // (its data functions read as words ([GetGovernment('x').GetName] the name), not as the code)
        const t = this.isTextKey(v, key) && this.d.richString(this.d.loc(v) ?? []);

        if (t)
            return { text: `“${t.length > 80 ? t.slice(0, 80) + '…' : t}”`, kind: 'value', tip: v };

        return this.d.valueSeg(v, ctx);
    }

    /** A setting's value that names a localization text (read quoted, edited as text). */
    private isTextKey(v: string, key: string): boolean
    {
        return v !== 'yes' && v !== 'no' && !/^-?[\d.]+$/.test(v) && !/[/\\]|\.(dds|png|tga|txt|gui|mesh|asset)$/i.test(v) && !/icon|picture|texture|reference|sound|background|illustration|gfx/.test(key) && this.idx.plainLoc(v) !== undefined;
    }

    private keyKindCache = new Map<string, Map<string, 'trigger' | 'effect'>>();

    /**
     * The keys a type's .info gives a trigger or an effect as value (`can_send = trigger`, `auto_accept = yes/no/trigger`,
     * `on_accept = effect`): only lines whose value is made of those words, so settingLines reads such a block as
     * conditions / effects.
     */
    keyKinds(type: string): Map<string, 'trigger' | 'effect'>
    {
        const hit = this.keyKindCache.get(type);

        if (hit)
            return hit;

        const out = new Map<string, 'trigger' | 'effect'>();

        for (const doc of this.idx.typeDoc(type))
            for (const raw of doc.text.split(/\r?\n/))
            {
                const m = /^\s*([a-z_]\w*)\s*=\s*([a-z/ ]+?)\s*(?:#.*)?$/i.exec(raw);
                const words = m?.[2].toLowerCase().split(/[/\s]+/) ?? [];

                if (m && words.every((w) => ['yes', 'no', 'trigger', 'effect'].includes(w)) && !out.has(m[1]))
                    if (words.includes('trigger') !== words.includes('effect'))
                        out.set(m[1], words.includes('trigger') ? 'trigger' : 'effect');
            }

        this.keyKindCache.set(type, out);
        return out;
    }

    private keyDocCache = new Map<string, Map<string, string>>();

    /**
     * What a type's .info says about each key of its definitions: the comment lines directly above `key = …` (or the
     * comment after it on its line), joined: "auto_accept: Will the interaction be accepted …".
     */
    keyDocs(type: string): Map<string, string>
    {
        const hit = this.keyDocCache.get(type);

        if (hit)
            return hit;

        const out = new Map<string, string>();

        for (const doc of this.idx.typeDoc(type))
        {
            let comment: string[] = [];

            for (const raw of doc.text.split(/\r?\n/))
            {
                const line = raw.trim();

                if (line.startsWith('#'))
                {
                    comment.push(line.replace(/^#+\s*/, ''));
                    continue;
                }

                const m = /^([a-z_][\w]*)\s*=\s*([^#]*?)\s*(?:#\s*(.*))?$/i.exec(line);

                if (m && !out.has(m[1]))
                {
                    const text = [...comment, m[3] ?? '']
                        .map((x) => x.trim())
                        .filter(Boolean)
                        .join(' ');

                    if (text)
                        out.set(m[1], text.length > 400 ? text.slice(0, 400) + '…' : text);
                }

                comment = [];
            }
        }

        this.keyDocCache.set(type, out);
        return out;
    }

    private conditionBlockCache = new Map<string, Map<string, ConditionBlock>>();

    /**
     * The condition blocks a type's definitions take (docs/readable-view.md, "Condition blocks"): the ones its .info
     * documents as triggers (`### Brief: can_pick ( trigger )`, with the scope its root is: "root ( Faith )") and the
     * top-level trigger blocks its definitions write (in the game and the loaded mods).
     */
    conditionBlocks(type: string): Map<string, ConditionBlock>
    {
        const hit = this.conditionBlockCache.get(type);

        if (hit)
            return hit;

        const out = new Map<string, ConditionBlock>();
        const title = (k: string): string => TRIGGER_SECTIONS[k] ?? capitalize(humanize(k));

        for (const doc of this.idx.typeDoc(type))
        {
            const briefs = [...doc.text.matchAll(/###\s*brief:\s*([a-z_0-9]+)\s*\(\s*trigger\s*\)/gi)];

            for (const m of briefs)
            {
                // (its part of the text: up to the next brief)
                const next = doc.text.slice(m.index! + m[0].length).search(/###\s*brief:/i);
                const part = doc.text.slice(m.index!, next < 0 ? undefined : m.index! + m[0].length + next);
                // its root: "root ( Faith )", "Root scope = title for which …", "Root = ruler in question", "root is the ruler …"
                const root = (/root\s*\(\s*([a-z ]+?)\s*\)/i.exec(part)?.[1] ?? /\broot(?:\s+scope)?\s*(?:=|is)\s*(?:the\s+|a\s+)?([a-z]+(?:\s+(?:title|house))?)/i.exec(part)?.[1])?.toLowerCase();
                const scope = root ? (SCOPE_NAMES[root] ?? SCOPE_NAMES[root.split(' ')[0]]) : undefined;
                // what it is for: its comment lines (the root's line left out)
                const about = part
                    .split(/\r?\n/)
                    .slice(1)
                    .map((l) => l.trim())
                    .filter((l) => l.startsWith('#') && !/^#+\s*root\b/i.test(l))
                    .map((l) => l.replace(/^#+\s*/, ''))
                    .join(' ')
                    .trim();
                out.set(m[1], { title: title(m[1]), ...(scope ? { scope } : {}), ...(about ? { about: about.length > 300 ? about.slice(0, 300) + '…' : about } : {}) });
            }
        }

        if (!['events', 'on_action', 'scripted_effects', 'scripted_triggers', 'script_values', 'localization', 'flag', 'variable', 'images', 'models', 'characters'].includes(type))
        {
            for (const name of this.idx.names(type))
            {
                const e = this.idx.get(type, name);
                const d = e && this.idx.defNode(e);

                for (const c of d && Array.isArray(d.node.v) ? d.node.v : [])
                    if (c.k && c.k !== 'limit' && Array.isArray(c.v) && (TRIGGER_SECTIONS[c.k] || TRIGGER_BLOCKS.has(c.k)) && !out.has(c.k))
                        out.set(c.k, { title: title(c.k) });
            }
        }

        // (the blocks a type's .info lists without a `### Brief:` entry of their own)
        for (const [key, block] of Object.entries(INFO_CONDITION_BLOCKS[type] ?? {}))
            if (!out.has(key))
                out.set(key, block);

        this.conditionBlockCache.set(type, out);
        return out;
    }

    /** The scope a type's script runs in: a character (CHARACTER_ROOT), else the one its conditions' docs name. */
    rootScopeOf(type: string): string | undefined
    {
        if (CHARACTER_ROOT.has(type))
            return 'character';

        // (only when every condition block of the type names the same one)
        const scopes = [...this.conditionBlocks(type).values()].map((b) => b.scope);
        return scopes.length && scopes[0] && scopes.every((s) => s === scopes[0]) ? scopes[0] : undefined;
    }

    /**
     * The scope a block of a type's definitions runs in by the type's .info (docs/readable-view.md, "Condition blocks"):
     * a documented condition block's (conditionBlocks: "### Brief: can_pick ( trigger )", "root ( Faith )"), else what
     * the comment on its key says in one of three plain forms (keyDocs): "Scope: culture", "Trigger in character scope"
     * ("Script value in character scope"), "Root scope: faith" / "Root scope = ruler …"; undefined when neither names a
     * scope. Looser wordings are left out on purpose: "root = the culture head …", "Supported scopes: root = …" and
     * `scope:x` (a saved scope) name other things too (a scratch print over vanilla's .info files, round 13 wave 12).
     */
    blockScope(type: string, key: string): string | undefined
    {
        const doc = this.conditionBlocks(type).get(key)?.scope;

        if (doc || !this.blockScopes)
            return doc;

        const text = this.keyDocs(type).get(key);

        if (!text)
            return undefined;

        const m = /(?:^|[.;]\s*)scope:\s+([a-z]+)\b/i.exec(text) ?? /\bin ([a-z]+) scope\b/i.exec(text) ?? /\broot scope\s*[:=]\s*([a-z]+)\b/i.exec(text);
        return m ? SCOPE_NAMES[m[1].toLowerCase()] : undefined;
    }

    /**
     * The ctx a block of the described definition is read in (round 13 wave 12): its own scope where it runs in another
     * one than the card's (`scope`: what the builder knows, a scripted list's item; else blockScope by the .info), as
     * the block's root too when that is not a character (the anchors carry both: LineSource.scope / root); else ctx.
     */
    blockCtx(node: PNode, ctx: Ctx, scope?: string): Ctx
    {
        const s = (this.blockScopes ? scope : undefined) ?? (ctx.entityType && node.k ? this.blockScope(ctx.entityType, node.k) : undefined);
        return s && s !== ctx.scopeType ? { ...ctx, scopeType: s, rootType: s !== 'character' ? s : undefined } : ctx;
    }

    blockSection(node: PNode, kind: SectionSource['kind'], ctx: Ctx, fields?: string): SectionSource | undefined
    {
        const src = this.d.anchor(node, ctx, kind, true);

        if (!src)
            return undefined;

        const out: SectionSource = { src: fields ? { ...src, fields } : src, key: node.k!, kind };
        // (a modifier block: what its modifiers apply to: character_modifier, county_modifier …)
        const applies = kind === 'modifier' ? modifierScopeOf(node.k!, ctx.entityType) : undefined;

        if (applies)
            out.scope = applies;

        // a condition or modifier block of the definition described: its scope, what it is for, the conditions / modifiers
        // the game writes in it
        if ((kind === 'trigger' || kind === 'modifier') && ctx.entityType && node.k)
            Object.assign(out, this.blockHint(ctx.entityType, node.k, kind));

        return out;
    }

    private blockHints = new Map<string, Partial<SectionSource>>();
    private modifierBlockCache = new Map<string, Map<string, ConditionBlock>>();

    /**
     * The modifier blocks a type's definitions take (docs/readable-view.md, "Modifier blocks"): the ones its .info
     * documents (`### brief: modifier ( character modifier )`, with what they are for) and the top-level
     * `modifier` / `*_modifier` blocks its definitions write holding modifiers (a building's `county_modifier`).
     */
    modifierBlocks(type: string): Map<string, ConditionBlock>
    {
        const hit = this.modifierBlockCache.get(type);

        if (hit)
            return hit;

        const out = new Map<string, ConditionBlock>();
        const title = (k: string): string => (k === 'modifier' ? 'Modifiers' : capitalize(humanize(k)));

        for (const doc of this.idx.typeDoc(type))
        {
            for (const m of doc.text.matchAll(/###\s*brief:\s*([a-z_0-9]+)\s*\(\s*([a-z ]*?)\s*modifier\s*\)/gi))
            {
                const next = doc.text.slice(m.index! + m[0].length).search(/###\s*brief:/i);
                const part = doc.text.slice(m.index!, next < 0 ? undefined : m.index! + m[0].length + next);
                const about = part
                    .split(/\r?\n/)
                    .slice(1)
                    .map((l) => l.trim())
                    .filter((l) => l.startsWith('#'))
                    .map((l) => l.replace(/^#+\s*/, ''))
                    .join(' ')
                    .trim();
                const what = m[2].trim();
                out.set(m[1], { title: title(m[1]), ...(about || what ? { about: [what ? capitalize(what) + ' modifier.' : '', about].filter(Boolean).join(' ') } : {}) });
            }
        }

        if (!['events', 'on_action', 'scripted_effects', 'scripted_triggers', 'script_values', 'localization', 'flag', 'variable', 'images', 'models', 'characters', 'modifiers', 'traits'].includes(type))
        {
            for (const name of this.idx.names(type))
            {
                const e = this.idx.get(type, name);
                const d = e && this.idx.defNode(e);

                for (const c of d && Array.isArray(d.node.v) ? d.node.v : [])
                {
                    if (!c.k || out.has(c.k) || !Array.isArray(c.v) || !(c.k === 'modifier' || /_modifier$/.test(c.k)) || c.k === 'ai_value_modifier' || c.k === 'opinion_modifier')
                        continue;

                    if (c.v.some((x) => x.k && typeof x.v === 'string' && this.d.isModifierKey(x.k)))
                        out.set(c.k, { title: title(c.k) });
                }
            }
        }

        this.modifierBlockCache.set(type, out);
        return out;
    }

    /**
     * The picker's hints for a condition block of a type (`SectionSource.hint`): the scope its .info documents, what it
     * is for, and the conditions the game's definitions write in it (leaf keys through AND / OR / NOT, trigger_if,
     * custom descriptions; scope switches, iterators and chains left out (they are about someone else)), most used first.
     */
    blockHint(type: string, key: string, kind: 'trigger' | 'modifier' = 'trigger'): Partial<SectionSource>
    {
        const id = type + '|' + key + '|' + kind;
        const hit = this.blockHints.get(id);

        if (hit)
            return hit;

        const doc = kind === 'trigger' ? this.conditionBlocks(type).get(key) : this.modifierBlocks(type).get(key);
        const counts = new Map<string, number>();
        const LOGIC = new Set(['AND', 'OR', 'NOT', 'NOR', 'NAND', 'trigger_if', 'trigger_else_if', 'trigger_else', 'limit', 'custom_description', 'custom_description_no_bullet', 'custom_tooltip', 'calc_true_if']);
        const walk = (list: PNode[]): void =>
        {
            for (const c of list)
            {
                if (!c.k || ['text', 'subject', 'object', 'value', 'amount'].includes(c.k))
                    continue;

                // (a modifier block: its modifiers, keys with a value the game knows as a modifier)
                if (kind === 'modifier')
                {
                    if (typeof c.v === 'string' && this.d.isModifierKey(c.k))
                        counts.set(c.k, (counts.get(c.k) ?? 0) + 1);

                    continue;
                }

                if (LOGIC.has(c.k))
                {
                    if (Array.isArray(c.v))
                        walk(c.v);

                    continue;
                }

                if (c.k.includes('.') || c.k.includes(':') || /^(any|every|random|ordered)_/.test(c.k) || /^(this|root|prev|from)$/.test(c.k) || (Array.isArray(c.v) && this.d.isScopeKey(c.k)))
                    continue;

                counts.set(c.k, (counts.get(c.k) ?? 0) + 1);
            }
        };

        for (const name of this.idx.names(type))
        {
            const e = this.idx.get(type, name);
            const d = e && this.idx.defNode(e);

            for (const c of d && Array.isArray(d.node.v) ? d.node.v : [])
                if (c.k === key && Array.isArray(c.v))
                    walk(c.v);
        }

        const common = [...counts]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 24)
            .map(([k]) => k);
        const out: Partial<SectionSource> = {};

        if (doc?.scope)
            out.scope = doc.scope;

        if (common.length || doc?.about)
            out.hint = { ...(doc?.about ? { about: doc.about } : {}), ...(common.length ? { common } : {}) };

        this.blockHints.set(id, out);
        return out;
    }

    /** The anchor of a statement that is one of a field set's settings (`cost`, `script_value` …: shared/fieldCatalog.ts). */
    /**
     * A statement whose value is a picture of the game's files (`reference = "gfx/interface/illustrations/…dds"`, a 1.19
     * `picture = "gfx/…"`): its action, the picture chooser (✎ opens it: LineAct 'picture'), with the current picture's
     * size, which an image of one's own is cropped to.
     */
    pictureAct(key: string, value: string, src: LineSource): Line['act'] | undefined
    {
        const path = /^"?(gfx\/[^"]+\.(?:dds|png|tga))"?$/i.exec(value)?.[1];

        if (!path)
            return undefined;

        const e = this.idx.get('images', path);
        const h = e ? this.idx.imageHeader(e) : undefined;
        return { label: tr('🖼 change…'), src, do: { kind: 'picture', key, now: path, replace: src, ...(h?.width ? { width: h.width, height: h.height } : {}) } };
    }

    fieldAnchor(node: PNode, ctx: Ctx, fields: string, inner = false): LineSource | undefined
    {
        const src = this.d.anchor(node, ctx, 'field', inner);
        return src && { ...src, fields };
    }

    /** a card made for a tooltip: no picker targets (they cost a walk of the script) */
    private forTooltip = false;

    /** false: per-type cards leave out the lines of the written keys they do not read (checks compare both) */
    unknownKeys = true;

    tooltip(e: Entity): TooltipInfo
    {
        let card: EntityCard;
        this.forTooltip = true;

        try
        {
            card = this.card(e);
        }
        finally
        {
            this.forTooltip = false;
        }

        let lines: Line[] = [];

        if (card.event)
            lines = linesForCard(card.event.conditions, 8);
        else
        {
            // (sections come also when empty: the first with lines; nested lines shown while 14 rows last)
            const skip = new Set([tr('Names in game'), tr('Name in game'), tr('Description'), tr('Update for 1.20'), tr('Group'), tr('More conditions'), tr('Who they are'), tr('More settings')]);
            const s = card.sections.find((x) => (x.title === tr('Modifiers') || x.title === tr('Effects') || x.title === tr('What it does')) && x.lines.length) ??
                card.sections.find((x) => x.lines.length && !skip.has(x.title));
            lines = s ? linesForCard(s.lines, 14) : [];
        }

        // (an event's text: every part, the first version of each choice)
        const descText = card.event ? this.descReading(card.event.desc) : card.description;
        return {
            key: card.key,
            title: card.event ? this.d.richString(card.event.title) : card.title,
            typeLabel: card.event ? card.event.kindLabel : card.typeLabel,
            icon: card.picture ? undefined : card.icon,
            illustration: card.picture?.path ?? card.illustration ?? card.event?.illustration,
            description: descText ? truncate(this.d.richString(descText), 280) : undefined,
            lines: [...card.facts.map((f) => ({ text: f })), ...lines]
        };
    }

    private imageCard(e: Entity, card: EntityCard): EntityCard
    {
        const h = this.idx.imageHeader(e);
        const folder = e.name.slice(0, e.name.lastIndexOf('/'));
        card.icon = undefined;
        card.title = titleCase(humanize(this.label(e)));
        card.typeLabel = tr('Image');
        card.picture = { path: e.name, width: h.width, height: h.height };

        if (h.width)
            card.facts.push([tr('{width} × {height} px', { width: h.width, height: h.height })]);

        if (h.format)
            card.facts.push([h.format + (h.mips && h.mips > 1 ? tr(' · {mips} mip levels', { mips: h.mips }) : '')]);

        if (h.bytes)
            card.facts.push([h.bytes > 1048576 ? tr('{toFixed} MB', { toFixed: (h.bytes / 1048576).toFixed(1) }) : tr('{ceil} KB', { ceil: Math.ceil(h.bytes / 1024) })]);

        card.facts.push([{ text: humanize(folder.replace(/^gfx\/(interface\/)?/, '')), kind: 'ph', tip: e.name }]);
        const users = this.idx.imageUsers(e);

        if (users.length)
        {
            const lines: Line[] = users.slice(0, 40).map((u) => ({ text: [this.d.entitySeg(u), { text: ' · ' + typeLabel(u.type), kind: 'ph' as const }] }));

            if (users.length > 40)
                lines.push({ text: [tr('… and {value} more', { value: users.length - 40 })] });

            card.sections.push({ title: tr('Shown for'), lines });
        }

        return card;
    }

    private usage(e: Entity): UsageSummary[]
    {
        const byType = new Map<string, { e: Entity; n: number; }[]>();

        for (const s of this.idx.incomingSources(e))
        {
            if (s.entity.type === 'localization')
                continue;

            const l = byType.get(s.entity.type) ?? [];
            l.push({ e: s.entity, n: s.count });
            byType.set(s.entity.type, l);
        }

        return [...byType.entries()]
            .map(([type, list]) => ({
                type,
                typeLabel: typeLabel(type),
                count: list.length,
                examples: list
                    .sort((a, b) => b.n - a.n)
                    .slice(0, 4)
                    .map((x) => ({ ref: { type: x.e.type, name: x.e.name }, label: this.label(x.e) }))
            }))
            .sort((a, b) => b.count - a.count);
    }

    /** Every entry of one type using `e` (the "Used by" row revealed in full), most references first. */
    usageAll(e: Entity, type: string): UsageSummary['examples']
    {
        return this.idx
            .incomingSources(e)
            .filter((s) => s.entity.type === type)
            .sort((a, b) => b.count - a.count)
            .map((s) => ({ ref: { type: s.entity.type, name: s.entity.name }, label: this.label(s.entity) }));
    }

    private usageSections(e: Entity): CardSection[]
    {
        const buckets: Record<string, Line[]> = { 'Set by': [], 'Checked by': [], 'Removed by': [], 'Also used by': [] };

        for (const s of this.idx.incomingSources(e))
        {
            const ctx = s.contexts.join(' ');
            const bucket = /remove_|clear_/.test(ctx) ? tr('Removed by') : /(add_|set_|change_)\w*(flag|variable)|add_to_/.test(ctx) ? tr('Set by') : /has_|exists|is_target|is_in/.test(ctx) ? tr('Checked by') : tr('Also used by');
            buckets[bucket].push({ text: [this.d.entitySeg(s.entity), { text: ` · ${typeLabel(s.entity.type)}`, kind: 'ph' }] });
        }

        return Object.entries(buckets)
            .filter(([, l]) => l.length)
            .map(([title, lines]) => ({ title, lines: lines.length > 40 ? [...lines.slice(0, 40), { text: [tr('… and {value} more (see Expert)', { value: lines.length - 40 })] }] : lines }));
    }

    cost(list: PNode[], ctx: Ctx): Line[]
    {
        const out: Line[] = [];

        for (const c of list)
        {
            if (!c.k)
                continue;

            const label = capitalize(humanize(c.k));

            if (typeof c.v === 'string')
            {
                const n = this.d.evalValue(c.v);
                out.push({ text: rich(n !== undefined ? { text: formatNumber(n), kind: 'value', tip: c.v } : this.d.valueSeg(c.v, ctx), ' ', label), icon: c.k, src: this.fieldAnchor(c, ctx, 'cost') });
            }
            else
            {
                // (one written number: that; else how it is worked out, its parts editable as a script value's)
                const keyed = c.v.filter((x) => x.k);
                const v = keyed.length === 1 && (keyed[0].k === 'value' || keyed[0].k === 'add') ? keyed[0] : undefined;
                const n = typeof v?.v === 'string' ? this.d.evalValue(v.v) : undefined;

                if (n !== undefined)
                    out.push({ text: [{ text: formatNumber(n), kind: 'value' }, ' ', label], icon: c.k, src: this.fieldAnchor(c, ctx, 'cost') });
                else
                    out.push({ text: [label + ':'], icon: c.k, children: this.formula(c.v, ctx), src: this.fieldAnchor(c, ctx, 'script_value', true) });
            }
        }

        return out;
    }

    formula(list: PNode[], ctx: Ctx): Line[]
    {
        const out: Line[] = [];
        const OPS: Record<string, string> = { value: 'Starts at', add: 'Add', subtract: 'Subtract', multiply: tr('Multiply by'), divide: tr('Divide by'), min: tr('At least'), max: tr('At most') };

        for (const c of list)
        {
            if (!c.k)
                continue;

            let l: Line | undefined;

            if (OPS[c.k] && typeof c.v === 'string')
                l = { text: rich(OPS[c.k], ' ', this.d.valueSeg(c.v, ctx)), tip: `${c.k} = ${c.v}` };
            else if ((c.k === 'if' || c.k === 'else_if' || c.k === 'else') && Array.isArray(c.v))
            {
                const limit = c.v.find((x) => x.k === 'limit');
                const conds = limit && Array.isArray(limit.v) ? this.d.triggers(limit.v, ctx) : [];
                const kids = this.formula(
                    c.v.filter((x) => x.k !== 'limit'),
                    ctx
                );
                l = { text: [c.k === 'else' ? tr('Otherwise:') : c.k === 'else_if' ? tr('Otherwise, if:') : tr('If:')], conditions: conds, children: kids, icon: 'if' };

                // (its limit: "＋ condition" adds one, the limit made when missing)
                if (ctx.file && c.k !== 'else')
                    l.limitSrc = this.d.limitOf(c, ctx);
            }
            else if ((c.k === 'fixed_range' || c.k === 'integer_range') && Array.isArray(c.v))
            {
                const min = c.v.find((x) => x.k === 'min')?.v;
                const max = c.v.find((x) => x.k === 'max')?.v;
                l = { text: [tr('Random between {min} and {max}', { min, max })], icon: 'chance' };
            }
            else if (Array.isArray(c.v) && /^(every|any|ordered|random)_/.test(c.k))
            {
                // ("For each list member (list: target titles):", "For each title in the de jure hierarchy where:" with the
                // limit's conditions; inside, the item is the subject)
                const it = this.d.valueIterator(c.k, c.v, ctx);
                l = { text: it.text, conditions: it.conditions, children: this.formula(it.body, it.ctx), icon: 'loop' };
            }
            // (a scope switch, `prestige = { scope:actor = { if … add … } }` in an interaction's cost: its lines under it;
            // one that only saves a scope says nothing)
            else if (Array.isArray(c.v) && (this.d.isScopeKey(c.k) || c.op === '?='))
            {
                const kids = this.formula(c.v, { ...ctx, scope: this.d.scopeLabel(c.k, ctx), scopeType: undefined, prevTypes: pushPrev(ctx, c.k) });

                if (!kids.length && !ctx.file?.mod)
                    continue;

                l = { text: [this.d.scopeSeg(c.k, ctx, true), ':'], children: kids, icon: 'scope' };
            }
            else if (Array.isArray(c.v) && OPS[c.k])
            {
                // (`multiply = { value = 0 desc = … }`: one value, read as `multiply = 0`)
                const keyed = c.v.filter((x) => x.k && x.k !== 'desc');
                const one = keyed.length === 1 && keyed[0].k === 'value' && typeof keyed[0].v === 'string' ? keyed[0].v : undefined;
                l = one !== undefined ? { text: rich(OPS[c.k], ' ', this.d.valueSeg(one, ctx)), tip: `${c.k} = { value = ${one} }` } : { text: [OPS[c.k] + ':'], children: this.formula(c.v, ctx) };
            }

            if (!l)
                continue;

            if (ctx.file)
                l.src = this.fieldAnchor(c, ctx, 'script_value', !!l.children);

            out.push(l);
        }

        return out;
    }

    private opinionFacts(list: PNode[], card: EntityCard): void
    {
        const s = (k: string): string | undefined =>
        {
            const c = list.find((x) => x.k === k);
            return typeof c?.v === 'string' ? c.v : undefined;
        };
        const op = s('opinion');

        if (op)
        {
            const n = this.d.evalValue(op);
            card.facts.push(rich(tr('Opinion '), n !== undefined ? { text: (n > 0 ? '+' : '') + formatNumber(n), kind: n >= 0 ? 'good' : 'bad' } : this.d.valueSeg(op)));
        }

        const dur = this.d.duration(list);

        if (dur)
            card.facts.push([tr('Lasts {dur}', { dur })]);
    }

    private traitFacts(list: PNode[], card: EntityCard): void
    {
        const s = (k: string): string | undefined =>
        {
            const c = list.find((x) => x.k === k);
            return typeof c?.v === 'string' ? c.v : undefined;
        };

        if (s('category'))
            card.facts.push([capitalize(humanize(s('category')!)) + ' trait']);

        // (its other properties are the "Settings" section, its opposites and compatibility sections of their own,
        // changeable there)
    }

    /**
     * A trait's own properties as a "Settings" section (every scalar the trait catalog knows, and any other scalar that
     * is no modifier; shared/fieldCatalog.ts FIELDS.traits: shown, changed and added through the picker), and its blocks:
     * compatibility, experience tracks (their modifiers per XP level), the terrain of commander traits.
     */
    private traitSections(e: Entity, list: PNode[], card: EntityCard, ctx: Ctx, settings: SectionSource | undefined): void
    {
        const known = new Set((FIELDS.traits ?? []).map((f) => f.key));
        // (name, description and icon show as the card's; the opinion fields in the "Opinion" section)
        const skip = new Set(['name', 'desc', 'icon', ...(FIELDS.trait_opinion ?? []).map((f) => f.key)]);
        // a value written as a file constant (`@pos_compat_high`) reads as its number
        const consts = this.idx.fileConstants(e);
        const valueOf = (v: string): number | undefined => this.d.evalValue(v.startsWith('@') ? (consts.get(v.slice(1)) ?? v) : v);
        const scalars = list.filter((c) => c.k && typeof c.v === 'string' && !skip.has(c.k) && (known.has(c.k) || !this.d.isModifierKey(c.k)));
        const lines = this.fieldLines('traits', scalars, ctx);

        if (lines.length || settings)
            card.sections.push({ title: tr('Settings'), lines, src: settings });

        const block = (k: string): PNode | undefined => list.find((c) => c.k === k && Array.isArray(c.v));
        // a block of the trait, or (in a mod's trait without it) where it is made (with its first item)
        const place = (k: string, fields: string): SectionSource | undefined =>
        {
            const b = block(k);
            return b ? this.blockSection(b, 'field', ctx, fields) : card.src?.mod ? { parent: { ...card.src, kind: 'field', fields }, key: k, kind: 'field' } : undefined;
        };
        // opposites: a trait each (`opposites = { craven }`), each line changed or removed, "＋" another
        const opp = block('opposites');
        const oppAt = place('opposites', 'trait_opposites');

        if (opp || oppAt)
            card.sections.push({ title: tr('Opposites'), lines: opp ? this.fieldLines('trait_opposites', opp.v as PNode[], ctx).map((l) => ({ ...l, icon: 'trait' })) : [], src: oppAt, addLabel: 'opposite' });

        // compatibility: how well holders get along with holders of another trait (`compatibility = { brave = 15 }`)
        const compat = block('compatibility');
        const compatAt = place('compatibility', 'trait_compatibility');

        if (compat || compatAt)
        {
            const rows: Line[] = [];

            for (const c of compat && Array.isArray(compat.v) ? compat.v : [])
            {
                if (!c.k || typeof c.v !== 'string')
                    continue;

                const n = valueOf(c.v);
                const l: Line = { text: rich(n !== undefined ? { text: (n > 0 ? '+' : '') + formatNumber(n), kind: n >= 0 ? 'good' : 'bad', tip: c.v } : { text: c.v, kind: 'value' }, tr(' with '), this.d.ref(c.k, ['traits'])), icon: 'trait', tip: `${c.k} = ${c.v}` };

                if (ctx.file)
                    l.src = this.fieldAnchor(c, ctx, 'trait_compatibility');

                rows.push(l);
            }

            card.sections.push({ title: tr('Compatibility'), lines: rows, src: compatAt, addLabel: 'trait' });
        }

        // experience tracks: `track = { 20 = { <modifiers> } }`, `tracks = { name = { 20 = { … } } }`
        const levels = (b: PNode[]): Line[] =>
            b
                .filter((c) => c.k && /^\d+$/.test(c.k) && Array.isArray(c.v))
                .map((c) =>
                {
                    const l: Line = { text: [tr('From {k} experience:', { k: c.k })], children: this.d.statsOf(c.v as PNode[], ctx), icon: 'modifier', tip: c.k! };

                    if (ctx.file)
                        l.src = this.d.anchor(c, ctx, 'modifier', true);

                    return l;
                });
        const track = block('track');

        if (track && Array.isArray(track.v))
        {
            const at = this.blockSection(track, 'field', ctx, 'trait_track');
            card.sections.push({ title: tr('Experience track'), lines: levels(track.v), src: at, addLabel: 'level' });

            // (a mod's trait with `track` alone: a named track makes it `tracks`, its track named after the trait, and
            // gives the mod's add_trait_xp / has_trait_xp of it their track (the owner's choice, 2026-11-15:
            // ScriptEditRequest.fromTrack); the trait's own name is taken)
            if (card.src?.mod && at?.src && !block('tracks'))
            {
                const named: SectionSource = { ...at, src: { ...at.src, fields: 'trait_tracks' }, key: 'tracks', fromTrack: e.name, hint: { common: [e.name] } };
                card.sections.push({
                    title: tr('More settings'),
                    lines: [{ text: rich(tr('Named experience tracks: '), { text: tr('not written'), kind: 'ph' }), placeholder: true, tip: tr('A second track turns track into tracks: this one is named {name}, and the add_trait_xp / has_trait_xp of the trait in your mod get track = {name}', { name: e.name }), act: { label: tr('＋ named track'), src: card.src, do: { kind: 'add', at: named, title: tr('Experience tracks') } } }],
                    noAdd: true
                });
            }
        }
        // (a mod's trait without one: a row to make it with its first level, and one to make a named track (`tracks`))
        else if (card.src?.mod && !block('tracks'))
        {
            const at: SectionSource = { parent: { ...card.src, kind: 'field', fields: 'trait_track' }, key: 'track', kind: 'field' };
            const named: SectionSource = { parent: { ...card.src, kind: 'field', fields: 'trait_tracks' }, key: 'tracks', kind: 'field' };
            card.sections.push({
                title: tr('More settings'),
                lines: [
                    { text: rich(tr('Experience track: '), { text: tr('not written'), kind: 'ph' }), placeholder: true, tip: 'track = { 50 = { <modifiers> } }: modifiers from an amount of experience with the trait', act: { label: tr('＋ level'), src: card.src, do: { kind: 'add', at, title: tr('Experience track') } } },
                    { text: rich(tr('Named experience tracks: '), { text: tr('not written'), kind: 'ph' }), placeholder: true, tip: 'tracks = { falconer = { 50 = { <modifiers> } } }: several tracks, each of its own name', act: { label: tr('＋ named track'), src: card.src, do: { kind: 'add', at: named, title: tr('Experience tracks') } } }
                ],
                noAdd: true
            });
        }

        const tracks = block('tracks');

        if (tracks && Array.isArray(tracks.v))
        {
            const rows = tracks.v
                .filter((t) => t.k && Array.isArray(t.v))
                .map((t) =>
                {
                    const l: Line = { text: [capitalize(humanize(t.k!)) + ':'], children: levels(t.v as PNode[]), tip: t.k! };

                    // (⤷＋ adds a level)
                    if (ctx.file)
                        l.src = this.fieldAnchor(t, ctx, 'trait_track', true);

                    return l;
                });
            // (＋ a named track: the names written (and the trait's own, which a `track` block stands for) are taken; the
            // picker reads them from the section's hint, PickRequest.common)
            const at = this.blockSection(tracks, 'field', ctx, 'trait_tracks');
            const taken = [...tracks.v.filter((t) => t.k && Array.isArray(t.v)).map((t) => t.k!), ...(track ? [e.name] : [])];
            card.sections.push({ title: tr('Experience tracks'), lines: rows, src: at ? { ...at, hint: { common: taken } } : undefined, addLabel: 'track' });
        }

        const terrain = block('trait_exclusive_if_realm_contains');

        if (terrain && Array.isArray(terrain.v))
        {
            const names = terrain.v.filter((x) => typeof x.v === 'string').map((x) => this.d.ref(x.v as string, ['terrain_types']));
            const l: Line = { text: rich(tr('Only assigned where the realm has '), ...names.flatMap((n, i) => (i ? [i === names.length - 1 ? ' or ' : ', ', n] : [n]))), icon: 'note' };

            if (ctx.file)
                l.src = this.d.anchor(terrain, ctx, 'other', false);

            card.sections.push({ title: tr('Commander terrain'), lines: [l] });
        }
    }

    /**
     * A trait's opinion effects beyond its modifiers: `same_opinion` / `same_opinion_if_same_faith` between holders,
     * `opposite_opinion` with holders of an opposite trait, and `triggered_opinion` blocks applying an opinion modifier
     * (value and punishment reasons read from common/opinion_modifiers) under conditions; see traits/_traits.info.
     */
    private traitOpinion(list: PNode[], trait: string, ctx: Ctx): Line[]
    {
        const lines: Line[] = [];
        const str = (l: PNode[], k: string): string | undefined =>
        {
            const c = l.find((x) => x.k === k);
            return typeof c?.v === 'string' ? c.v : undefined;
        };
        const num = (l: PNode[], k: string): number | undefined =>
        {
            const v = str(l, k);
            return v === undefined ? undefined : this.d.evalValue(v);
        };
        const val = (n: number): RichSeg => ({ text: (n > 0 ? '+' : '') + formatNumber(n), kind: n >= 0 ? 'good' : 'bad' });
        // (anchored to the statement it reads, when it is one)
        const line = (n: number | undefined, text: Rich, node?: PNode): Line =>
        {
            const l: Line = { text, icon: 'opinion', tone: n === undefined || n < 0 ? 'bad' : 'good' };

            if (node && ctx.file)
                l.src = this.fieldAnchor(node, ctx, 'trait_opinion');

            return l;
        };
        const name: RichSeg = { text: trait, kind: 'ph' };
        const nodeOf = (k: string): PNode | undefined => list.find((x) => x.k === k);

        const same = num(list, 'same_opinion');

        if (same)
            lines.push(line(same, rich(val(same), tr(' opinion between characters who are both '), name), nodeOf('same_opinion')));

        const sameFaith = num(list, 'same_opinion_if_same_faith');

        if (sameFaith)
            lines.push(line(sameFaith, rich(val(sameFaith), tr(' opinion between characters of the same faith who are both '), name), nodeOf('same_opinion_if_same_faith')));

        const opp = num(list, 'opposite_opinion');

        if (opp)
        {
            const node = list.find((x) => x.k === 'opposites');
            const names = (Array.isArray(node?.v) ? node.v : []).filter((x) => typeof x.v === 'string').map((x) => this.d.ref(x.v as string, ['traits']));
            lines.push(line(opp, rich(val(opp), tr(' opinion with characters who are '), ...names.flatMap((n, i) => (i ? [i === names.length - 1 ? ' or ' : ', ', n] : [n]))), nodeOf('opposite_opinion')));
        }

        // blocks that differ only in their doctrine parameter become one line listing the doctrines
        const groups = new Map<string, { b: PNode[]; params: string[]; always: boolean; nodes: PNode[]; }>();

        for (const trig of list.filter((x) => x.k === 'triggered_opinion' && Array.isArray(x.v)))
        {
            const b = trig.v as PNode[];

            if (!str(b, 'opinion_modifier'))
                continue;

            const k = ['opinion_modifier', 'same_faith', 'same_dynasty', 'check_missing', 'ignore_opinion_value_if_same_trait', 'male_only', 'female_only'].map((x) => str(b, x) ?? '').join('|');
            const g = groups.get(k) ?? { b, params: [], always: false, nodes: [] };
            g.nodes.push(trig);
            const param = str(b, 'parameter');

            if (param)
            {
                if (!g.params.includes(param))
                    g.params.push(param);
            }
            else
                g.always = true;

            groups.set(k, g);
        }

        const join = (segs: Rich[]): Rich => rich(...segs.flatMap((s, i) => (i ? [i === segs.length - 1 ? ' or ' : ', ', ...s] : s)));

        for (const { b, params, always, nodes } of groups.values())
        {
            const key = str(b, 'opinion_modifier')!;
            const om = this.idx.get('opinion_modifiers', key);
            const omDef = om ? this.idx.defNode(om) : undefined;
            const omBody = omDef ? this.body(omDef.node) : [];
            const value = num(omBody, 'opinion');
            const who = str(b, 'same_faith') === 'yes' ? tr('characters of the same faith') : str(b, 'same_dynasty') === 'yes' ? tr('members of the same dynasty') : 'others';
            let text = rich(value !== undefined ? rich(val(value), tr(' opinion from ')) : tr('Opinion from '), who, ' (', this.d.ref(key, ['opinion_modifiers']), ')');

            if (params.length && !always)
            {
                const missing = str(b, 'check_missing') === 'yes';
                // the doctrines setting a parameter read best by name (when few), else the game's sentence for it
                const doctrines = [...new Set(params.flatMap((p) => this.doctrinesWith(p)))];

                if (doctrines.length && doctrines.length <= 5 && params.every((p) => this.doctrinesWith(p).length))
                {
                    text = rich(text, missing ? tr(', unless their faith has ') : tr(', if their faith has '), join(doctrines.map((d) => [this.d.entitySeg(d)])));
                }
                else
                {
                    const sentences = params.map((p) =>
                    {
                        const s = this.d.loc('doctrine_parameter_' + p);
                        return s ? rich('“', s, '”') : [`“${humanize(p)}”`];
                    });
                    text = rich(text, missing ? tr(', unless their faith holds that ') : tr(', if their faith holds that '), join(sentences));
                }
            }

            if (str(b, 'ignore_opinion_value_if_same_trait') === 'yes')
                text = rich(text, tr(', not from others who are '), name, tr(' too'));

            if (str(b, 'male_only') === 'yes')
                text = rich(text, tr(' (men only)'));

            if (str(b, 'female_only') === 'yes')
                text = rich(text, tr(' (women only)'));

            const reasons = [
                ['imprisonment_reason', 'imprison'],
                ['execute_reason', 'execute'],
                ['banish_reason', 'banish'],
                ['revoke_title_reason', 'revoke titles']
            ]
                .filter(([k]) => str(omBody, k) === 'yes')
                .map(([, w]) => w);

            if (reasons.length)
                text = rich(text, tr(' — lets them '), reasons.length > 1 ? reasons.slice(0, -1).join(', ') + tr(' or ') + reasons[reasons.length - 1] : reasons[0]);

            // (merged blocks are several statements: no anchor)
            lines.push(line(value, text, nodes.length === 1 ? nodes[0] : undefined));
        }

        return lines;
    }

    private nameExamples: Map<string, { score: number; ex: NameExample; }> | undefined;

    /**
     * An example of the game's own texts using a faith's or religion's name form (`GetName`, `GetAdjective`,
     * `GetAdherentName`, `GetAdherentNamePlural`): the shortest clean sentence (a few other codes at most, each filled in
     * as the text codes' examples print it (William of Normandy), else it is passed over), split around the form. A
     * religion's form without an example of its own: a faith's. Every loc text is scanned once per build.
     */
    nameExample(owner: 'faith' | 'religion', fn: string): NameExample | undefined
    {
        const m = (this.nameExamples ??= this.scanNameExamples());
        return (m.get(`${owner}:${fn}`) ?? (owner === 'religion' ? m.get(`faith:${fn}`) : undefined))?.ex;
    }

    private scanNameExamples(): Map<string, { score: number; ex: NameExample; }>
    {
        const forms = new Set(['GetName', 'GetAdjective', 'GetAdherentName', 'GetAdherentNamePlural']);
        const best = new Map<string, { score: number; ex: NameExample; }>();

        for (const key of this.idx.names('localization'))
        {
            const raw = this.idx.locRaw(key);

            // (a sentence: no line breaks, $values$, formatting, icons or concept links)
            if (!raw || raw.length < 24 || raw.length > 130 || !raw.includes('.Get') || /\\n|\$|#|@|\|E\]/.test(raw))
                continue;

            if (!/^["“]?[A-Z[]/.test(raw) || !/[.!?"”…]$/.test(raw))
                continue;

            const codes = [...raw.matchAll(/\[([^\][]+)\]/g)];

            if (!codes.length || codes.length > 3)
                continue;

            for (const target of codes)
            {
                const [chain, fmt] = target[1].split('|');
                const last = chain.slice(chain.lastIndexOf('.') + 1).replace(/NoTooltip$/, '');

                if (!forms.has(last))
                    continue;

                const lower = chain.toLowerCase();
                const owner = lower.includes('religion') ? 'religion' : lower.includes('faith') ? 'faith' : undefined;

                if (!owner)
                    continue;

                let before = '';
                let text = '';
                let at = 0;
                let ok = true;

                for (const c of codes)
                {
                    text += raw.slice(at, c.index);
                    at = c.index! + c[0].length;

                    if (c === target)
                    {
                        before = text;
                        text = '';
                        continue;
                    }

                    const fill = this.codeExample(c[1]);

                    if (fill === undefined)
                    {
                        ok = false;
                        break;
                    }

                    text += fill;
                }

                if (!ok)
                    continue;

                const after = text + raw.slice(at);
                const score = Math.abs(raw.length - 60) + 25 * (codes.length - 1);
                const k = `${owner}:${last}`;
                const cur = best.get(k);

                if (!cur || score < cur.score || (score === cur.score && key < cur.ex.key))
                    best.set(k, { score, ex: { key, before: before.replace(/^["“]/, ''), after: after.replace(/["”]$/, ''), cap: !!fmt?.includes('U') || !before.replace(/^["“]/, '').trim() } });
            }
        }

        return best;
    }

    /** What a character text code prints for the sample character (`spouse.GetSheHe` → "she"), else undefined. */
    private codeExample(inner: string): string | undefined
    {
        const [body, fmt] = inner.split('|');
        const parts = body.split('.');
        // (the scope (ROOT.Char, CHARACTER, a saved scope), then the chain)
        let i = /^(ROOT|THIS|PREV|CHARACTER|Character|[a-z_][a-z0-9_]*)$/.test(parts[0]) ? 1 : 0;

        if (parts[i] === 'Char')
            i++;

        if (!i || i >= parts.length)
            return undefined;

        return this.locExample?.(parts.slice(i).join('.') + (fmt ? '|' + fmt : ''))?.split(' / ')[0];
    }

    /** A doctrine's parameters in the game's words (the picker's preview of the field set doctrine_parameters). */
    doctrineParamLines(nodes: PNode[]): Line[]
    {
        return paramLines(this, nodes, rootCtx(''), 'doctrine_parameter_');
    }

    /** A trait's opinion lines of a script snippet (the picker's preview of trait_opinion fields). */
    traitOpinionLines(nodes: PNode[]): Line[]
    {
        return this.traitOpinion(nodes, tr('this trait'), rootCtx(''));
    }

    /**
     * Values a text field offers (shared/fieldCatalog.ts `suggest`): `doctrine_parameters`: every boolean doctrine
     * parameter, named by the doctrines that set it; `doctrine_groups`: every doctrine with its group, in the game's
     * order of groups (a field's `group`); `faith_icons` / `doctrine_icons` / `tenet_icons`: the icons of their folders.
     */
    /**
     * The statements of a field set's blocks as the definitions write them: a type's definitions (big types: the first
     * `max`), or for a set that is a block inside other types (NESTED_SETS) that block of their definitions.
     */
    private setBodies(set: string, max: number): PNode[][]
    {
        const nested = NESTED_SETS[set];
        const out: PNode[][] = [];

        for (const type of nested?.types ?? [set])
        {
            for (const name of this.idx.names(type).slice(0, max))
            {
                const e = this.idx.get(type, name);
                const d = e && this.idx.defNode(e);

                if (!d || !Array.isArray(d.node.v))
                    continue;

                if (!nested)
                    out.push(d.node.v);
                else
                    for (const b of d.node.v)
                        if (b.k === nested.block && Array.isArray(b.v))
                            out.push(b.v);
            }
        }

        return out;
    }

    fieldSuggestions(source: string): FieldSuggestion[]
    {
        if (source === 'doctrine_groups')
        {
            const out: FieldSuggestion[] = [];

            for (const g of doctrineGroups(this).list)
            {
                const group = { key: g.key, label: g.label, category: g.category, picks: g.picks };

                for (const d of g.doctrines)
                {
                    const e = this.idx.get('religion/doctrine_types', d);
                    const mods = e && this.idx.modTouch(e)?.mods;
                    out.push({ value: d, label: (e && this.idx.displayName(e)) ?? humanize(d), group, ...(mods?.length ? { mods } : {}) });
                }
            }

            return out;
        }

        if (source === 'faith_icons' || source === 'doctrine_icons' || source === 'tenet_icons')
        {
            const folder = source === 'faith_icons' ? 'gfx/interface/icons/faith' : source === 'tenet_icons' ? 'gfx/interface/icons/faith_tenets' : 'gfx/interface/icons/faith_doctrines';
            return this.idx.imagesIn(folder).map((p) =>
            {
                const name = p.slice(p.lastIndexOf('/') + 1).replace(/\.dds$/i, '');
                return { value: name, label: p, image: p };
            });
        }

        // `keys:<type>`: the keys with a value of their own the type's definitions write (the picker's "Other setting…");
        // a set that is a block inside other types (NESTED_SETS: special_parameters): the keys written in that block
        const ks = /^keys:(.+)$/.exec(source);

        if (ks)
        {
            const counts = new Map<string, number>();

            for (const list of this.setBodies(ks[1], 6000))
                for (const c of list)
                    if (c.k && typeof c.v === 'string' && !this.d.isModifierKey(c.k))
                        counts.set(c.k, (counts.get(c.k) ?? 0) + 1);

            return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count, label: `${count}×` }));
        }

        // `values:<type>:<key>`: the values the type's definitions write for a key (trait flags, groups …), most used first;
        // `nested:<type>:<key>`: also inside their blocks (a bookmark character's `difficulty`, `relation`, `animation`)
        const v = /^(values|nested):([^:]+):(.+)$/.exec(source);

        if (v)
        {
            const counts = new Map<string, number>();
            const deep = v[1] === 'nested';
            const scan = (list: PNode[]): void =>
            {
                for (const c of list)
                {
                    if (c.k === v[3] && typeof c.v === 'string')
                        counts.set(c.v, (counts.get(c.v) ?? 0) + 1);
                    else if (deep && Array.isArray(c.v))
                        scan(c.v);
                }
            };

            for (const list of this.setBodies(v[2], 20000))
                scan(list);

            return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count, label: `${count}×` }));
        }

        if (source !== 'doctrine_parameters')
            return [];

        this.doctrinesWith('');
        const out: FieldSuggestion[] = [];

        for (const [param, doctrines] of this.paramDoctrines ?? [])
        {
            const names = doctrines.map((d) => this.idx.displayName(d) ?? humanize(d.name));
            const mods = [...new Set(doctrines.flatMap((d) => this.idx.modTouch(d)?.mods ?? []))];
            out.push({ value: param, label: names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : ''), count: doctrines.length, ...(mods.length ? { mods } : {}) });
        }

        return out.sort((a, b) => (a.value < b.value ? -1 : 1));
    }

    private locCodeList: LocCodes | undefined;

    /**
     * The codes the game's localization uses (the text editor's "Insert code…"), most used first: a character's data
     * functions after \`ROOT.Char.\` / \`<scope>.\` (\`GetHerHis\`, \`GetFaith.HighGodName\`, with \`|U\` variants), concept links
     * (\`[faith|E]\`), icons (\`@gold_icon!\`), formatting (\`#P … #!\`). Scanned once from every loc text (~0.4 s).
     */
    locCodes(): LocCodes
    {
        if (this.locCodeList)
            return this.locCodeList;

        const fns = new Map<string, number>();
        const concepts = new Map<string, number>();
        const icons = new Map<string, number>();
        const formats = new Map<string, number>();
        const add = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

        for (const key of this.idx.names('localization'))
        {
            const raw = this.idx.locRaw(key);

            if (!raw)
                continue;

            if (raw.includes('['))
            {
                for (const m of raw.matchAll(/\[([^\][]+)\]/g))
                {
                    const c = m[1];
                    const concept = /^([a-z_0-9]+)\|[A-Za-z]+$/.exec(c);

                    if (concept)
                    {
                        add(concepts, concept[1]);
                        continue;
                    }

                    const parts = c.split('.');
                    const chain = parts[0] === 'ROOT' && parts[1] === 'Char' ? parts.slice(2).join('.') : /^[a-z_][a-z_0-9]*$/.test(parts[0]) && parts[1]?.startsWith('Get') ? parts.slice(1).join('.') : undefined;

                    if (chain && !chain.includes('(') && !chain.includes("'"))
                        add(fns, chain);
                }
            }

            if (raw.includes('@'))
            {
                for (const m of raw.matchAll(/@(\w+)!/g))
                    add(icons, m[1]);
            }

            if (raw.includes('#'))
            {
                for (const m of raw.matchAll(/#([A-Za-z_]+)[ ;]/g))
                    add(formats, m[1]);
            }
        }

        const top = (m: Map<string, number>, n: number): [string, number][] => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
        this.locCodeList = {
            functions: top(fns, 400),
            concepts: top(concepts, 600).map(([key, count]) => ({ key, count, label: this.idx.plainLoc(`game_concept_${key}`) ?? humanize(key) })),
            icons: top(icons, 200),
            formats: top(formats, 30)
        };
        return this.locCodeList;
    }

    /** The scopes an entry's script names (saved scopes, `scope:x`): who its texts can speak of (`[actor.GetFirstName]`). */
    locScopes(e: Entity): string[]
    {
        const d = this.idx.defNode(e);

        if (!d)
            return [];

        const seen = new Map<string, number>();

        for (const m of d.src.matchAll(/(?:scope:|save_(?:temporary_)?scope_as\s*=\s*)([a-z_][a-z_0-9]*)/g))
            seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);

        return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    }

    private paramDoctrines: Map<string, Entity[]> | null = null;

    /** Doctrines whose `parameters` block turns a doctrine parameter on (built once). */
    private doctrinesWith(param: string): Entity[]
    {
        if (!this.paramDoctrines)
        {
            const m = (this.paramDoctrines = new Map<string, Entity[]>());

            for (const name of this.idx.names('religion/doctrine_types'))
            {
                const e = this.idx.get('religion/doctrine_types', name)!;
                const def = this.idx.defNode(e);
                const params = def ? this.body(def.node).find((c) => c.k === 'parameters') : undefined;

                // (`name = yes`, or the bare name 1.20 writes)
                for (const p of paramPairs(params && Array.isArray(params.v) ? params.v : []))
                {
                    if (p.value !== 'yes')
                        continue;

                    const l = m.get(p.key);

                    if (l)
                        l.push(e);
                    else
                        m.set(p.key, [e]);
                }
            }
        }

        return this.paramDoctrines.get(param) ?? [];
    }

    private characterFacts(list: PNode[], card: EntityCard, ctx: Ctx): void
    {
        const s = (k: string): string | undefined =>
        {
            const c = list.find((x) => x.k === k);
            return typeof c?.v === 'string' ? c.v : undefined;
        };

        if (s('dynasty'))
            card.facts.push(rich(tr('Dynasty: '), this.d.ref(s('dynasty')!, ['dynasties'])));

        if (s('culture'))
            card.facts.push(rich(tr('Culture: '), this.d.ref(s('culture')!, ['culture/cultures'])));

        // (1.20: the rite (it wins over a faith); its faith at the first bookmark)
        const rite = s('rite');
        const written = s('religion') || s('faith');
        const faith = (rite && riteHistory(this.idx).faithOf(rite, BOOKMARK_DATE)) || (written && riteHistory(this.idx).faithOf(written, BOOKMARK_DATE)) || written;

        if (faith)
            card.facts.push(rich(tr('Faith: '), this.d.ref(faith, ['faith'])));

        if (rite)
            card.facts.push(rich(tr('Rite: '), this.d.ref(rite, ['religion/rite_types'])));

        const own = card.src && { src: { ...card.src, kind: 'field' as const, fields: 'character_history' }, key: card.key.name, kind: 'field' as const };
        // who they are: name, sex, dynasty, house, culture, faith, parents, skills … (shared/fields/settings.ts `characters`)
        const fields = list.filter((x) => x.k && typeof x.v === 'string' && x.k !== 'trait' && fieldOf('characters', x.k));

        // their birth (a dated block `<date> = { birth = yes }`, changed or written by its act) and a new relative
        // (docs/mods.md, "New characters": a father, mother, sibling, twin or child from a preset)
        const bornAt = list.find((c) => c.k && /^\d+\.\d+\.\d+$/.test(c.k) && Array.isArray(c.v) && c.v.some((x) => x.k === 'birth'))?.k ?? undefined;
        const whoLines = this.fieldLines('characters', fields, ctx);
        const female = s('female') === 'yes';
        // (the name as the game shows it: `name` is a text key: "Magnu_s" → Magnús)
        const charName = s('name') ? (this.idx.plainLoc(s('name')!) ?? s('name')!) : card.key.name;

        // (a loaded save's character: its people are the save's; docs/saves.md)
        const charType = card.key.type === 'savegame/characters' ? 'savegame/characters' : 'characters';
        // the relatives the history files give them: spouses, siblings (twins: born the same day; half), children (not a
        // save's character: its parents and spouses are its own fields)
        const tree = charType === 'characters' ? this.familyOf?.(card.key.name) : this.saveFamilyOf?.(card.key.name);
        const kin: Line[] = [];

        if (tree)
        {
            const who = (p: { id: string; name: string; }): RichSeg =>
            {
                const r = this.d.ref(p.id, [charType]);
                return typeof r === 'string' ? (p.name || r) : { ...r, text: p.name || p.id };
            };
            const born = (p: { birth?: string; }): string => (p.birth ? tr(' · born {date}', { date: p.birth }) : '');

            for (const p of tree.spouses)
                kin.push({ text: rich(tr('Spouse: '), who(p), born(p)), icon: 'opinion' });

            for (const p of tree.siblings)
            {
                const twin = !!p.birth && p.birth === bornAt && !p.half;
                kin.push({ text: rich(twin ? tr('Twin: ') : p.half ? tr('Half-sibling: ') : tr('Sibling: '), who(p), born(p)), icon: 'scope' });
            }

            for (const p of tree.children)
                kin.push({ text: rich(tr('Child: '), who(p), born(p)), icon: 'scope' });
        }

        // (a save's character: no new relatives or dates: the save can't take new entries)
        if (card.src && charType === 'characters')
        {
            whoLines.push(
                bornAt ?
                    { text: rich(tr('Born on '), { text: bornAt, kind: 'value' }), icon: 'note', act: { label: tr('change'), src: card.src, do: { kind: 'birth', character: card.key.name, birth: bornAt } } } :
                    { text: [{ text: tr('Born on…'), kind: 'ph' }], icon: 'note', placeholder: true, act: { label: tr('＋ birth date'), src: card.src, do: { kind: 'birth', character: card.key.name } } }
            );
            whoLines.push({ text: [{ text: tr('Family: a father, mother, sibling, twin or child'), kind: 'ph' }], icon: 'scope', placeholder: true, act: { label: tr('＋ relative'), src: card.src, do: { kind: 'relative', character: card.key.name, birth: bornAt, female, name: charName } }, children: kin.length ? kin : undefined });
        }
        else if (kin.length)
            whoLines.push({ text: [tr('Family')], icon: 'scope', children: kin });

        if (fields.length || card.src || kin.length)
            card.sections.push({ title: tr('Who they are'), lines: whoLines, src: card.src && { src: { ...card.src, kind: 'field', fields: 'characters' }, key: card.key.name, kind: 'field' }, addLabel: 'setting' });

        const traits = list.filter((x) => x.k === 'trait' && typeof x.v === 'string');

        if (traits.length || card.src)
            card.sections.push({ title: tr('Traits'), lines: traits.map((x) => ({ text: [this.d.ref(x.v as string, ['traits'])], icon: 'trait', tip: `trait = ${x.v}`, src: this.fieldAnchor(x, ctx, 'character_history') })), src: own });

        // Life: each date's statements in words: the history keys here, the rest (effect = { … }, add_trait_xp …) as effects
        const born = list.find((c) => c.k && /^\d+\.\d+\.\d+$/.test(c.k) && Array.isArray(c.v) && c.v.some((x) => x.k === 'birth'))?.k;
        const year = (d: string): number =>
        {
            const [y, m, day] = d.split('.').map(Number);
            return y + (m - 1) / 12 + (day - 1) / 365;
        };
        const person = (id: string): RichSeg => this.d.ref(id, [charType]);
        const say = (x: PNode, on?: string): Line[] =>
        {
            const v = typeof x.v === 'string' ? x.v : undefined;
            const field = (k: string): string | undefined =>
            {
                const f = Array.isArray(x.v) ? x.v.find((c) => c.k === k) : undefined;
                return typeof f?.v === 'string' ? f.v : undefined;
            };
            const tip = `${x.k} = ${v ?? '{ … }'}`;

            switch (x.k)
            {
                case 'birth':
                    return [{ text: [tr('Born')], icon: 'note', tip }];
                case 'death':
                {
                    const reason = field('death_reason');
                    const killer = field('killer');
                    // (the reason's data functions read as words: [GetTrait('ill').GetName( CHARACTER.Self )] the trait's name)
                    const reasonText = reason ? this.d.loc(reason) : undefined;
                    const why = reason ? (reasonText ? this.d.richString(reasonText) : humanize(reason.replace(/^death_/, ''))) : undefined;
                    return [{ text: rich(tr('Dies'), why ? `: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : '', killer ? tr(', killed by ') : '', killer ? person(killer) : ''), icon: 'death', tip }];
                }
                case 'trait':
                    return v ? [{ text: rich(tr('Gets the trait '), this.d.ref(v, ['traits'])), icon: 'trait', tip }] : [];
                case 'add_spouse':
                case 'add_matrilineal_spouse':
                    return v ? [{ text: rich(x.k === 'add_matrilineal_spouse' ? tr('Marries (matrilineal) ') : tr('Marries '), person(v)), icon: 'opinion', tip }] : [];
                case 'remove_spouse':
                    return v ? [{ text: rich(tr('No longer married to '), person(v)), tip }] : [];
                case 'add_concubine':
                    return v ? [{ text: rich(tr('Takes '), person(v), tr(' as a concubine')), tip }] : [];
                case 'give_nickname':
                    // (its text as the texts are read: a data function in it as a placeholder, "the [CHARACTER.GetCulture…]")
                    return v ? [{ text: rich(tr('Known as “'), this.d.loc(v) ?? [humanize(v.replace(/^nick_/, ''))], '”'), icon: 'note', tip }] : [];
                case 'culture':
                    return v ? [{ text: rich(tr('Culture: '), this.d.ref(v, ['culture/cultures'])), tip }] : [];
                case 'religion':
                case 'faith':
                    // (1.20 writes a rite under `religion =` too: its faith on that date)
                    return v ? [{ text: rich(tr('Faith: '), this.d.ref(historyFaith(this.idx, x, on ? Number(on.split('.').map((p) => p.padStart(2, '0')).join('')) : BOOKMARK_DATE) ?? v, ['faith'])), tip }] : [];
                case 'rite':
                    return v ? [{ text: rich(tr('Rite: '), this.d.ref(v, ['religion/rite_types'])), tip }] : [];
                case 'employer':
                    return v ? [{ text: rich(tr('At the court of '), person(v)), tip }] : [];
                case 'dynasty':
                case 'dynasty_house':
                    return v ? [{ text: rich(x.k === 'dynasty' ? tr('Dynasty: ') : tr('House: '), this.d.ref(v, x.k === 'dynasty' ? ['dynasties'] : ['dynasty_houses'])), tip }] : [];
                case 'set_father':
                    return v ? [{ text: rich(tr('Father: '), person(v)), tip }] : [];
                case 'set_mother':
                    return v ? [{ text: rich(tr('Mother: '), person(v)), tip }] : [];
                case 'government':
                    return v ? [{ text: rich(tr('Government: '), this.d.ref(v, ['governments'])), tip }] : [];
                case 'effect':
                    return Array.isArray(x.v) ? this.d.effects(x.v, ctx) : [];
            }

            return this.d.effects([x], ctx);
        };
        const life: Line[] = [];

        for (const c of list)
        {
            if (!c.k || !/^\d+\.\d+\.\d+$/.test(c.k) || !Array.isArray(c.v))
                continue;

            // (a history change written directly (`trait = brave`, `death = yes`): a field of `character_life`, changed through
            // the picker; an `effect = { … }` keeps its effects' own anchors)
            const lines = c.v.filter((x) => x.k).flatMap((x) =>
            {
                const out = say(x, c.k ?? undefined);
                const src = out.length && typeof x.v === 'string' && fieldOf('character_life', x.k!) ? this.fieldAnchor(x, ctx, 'character_life') : undefined;
                return src ? [{ ...out[0], src }, ...out.slice(1)] : out;
            });
            const age = born && c.k !== born ? Math.floor(year(c.k) - year(born)) : undefined;
            life.push({
                text: rich({ text: c.k, kind: 'value' }, age !== undefined && age >= 0 ? tr(' · age {age}', { age }) : ''),
                icon: 'note',
                children: lines,
                // (nothing but behind-the-scenes lines: the date is one too)
                hidden: lines.length > 0 && lines.every((l) => l.hidden),
                src: this.d.anchor(c, ctx, 'effect', true),
                // (more on this date: the same choice as "＋ life event", the date given)
                ...(card.src && charType === 'characters' ? { act: { label: tr('＋ on this date'), src: card.src, do: { kind: 'life' as const, character: card.key.name, birth: born ?? undefined, name: s('name') ? (this.idx.plainLoc(s('name')!) ?? s('name')!) : card.key.name, date: c.k } } } : {})
            });
        }

        // (something new on a date: a history change or any effect; docs/mods.md "New characters")
        if (card.src && charType === 'characters')
            life.push({ text: [{ text: tr('Something happens on a date: a trait, a marriage, a death, any effect …'), kind: 'ph' }], icon: 'note', placeholder: true, act: { label: tr('＋ life event'), src: card.src, do: { kind: 'life', character: card.key.name, birth: born ?? undefined, name: s('name') ? (this.idx.plainLoc(s('name')!) ?? s('name')!) : card.key.name } } });

        if (life.length)
            card.sections.push({ title: tr('Life'), lines: life });
    }
}

function truncate(s: string, n: number): string
{
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
