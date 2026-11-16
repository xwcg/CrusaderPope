/**
 * Turns CK3 trigger and effect blocks into readable lines ("Has the trait Brave", "+100 Prestige",
 * "Leads to: The Good Doctor in 7–14 days"), similar to the in-game tooltips.
 *
 * Scripted triggers/effects are expanded inline (with $PARAM$ substitution) like the game does, unless
 * trigger_localization / effect_localization gives them a custom text. Every trigger_event on the way is
 * collected as a FollowUp together with the conditions/chances that lead to it.
 */
import type { PNode } from '../indexer/parser.ts';
import type { Def, DefAnchor, Entity, GameIndex } from '../indexer/gameIndex.ts';
import { CONTEXT_RULES, PREFIX_TYPES, typeLabel } from '../indexer/schema.ts';
import { VALUE_TYPES } from '../indexer/valueTypes.ts';
import { stmtCheck } from '../indexer/override.ts';
import type { EntityKey, FollowUp, GuiItem, Line, LineSource, Rich, RichSeg, SectionSource, StatementCheck } from '../../shared/api.ts';
import { capitalize, dropRepeats, dropTemplateArgs, formatNumber, humanize, locToRich, rich, richToString, signed, titleCase } from './text.ts';
import { ITERATORS, LINKS, modifierScopeOf, outOfPrev, scopeTypeByName, STATEMENTS } from '../../shared/scriptCatalog.ts';
import { onFactsApplied } from '../../shared/scriptFacts.ts';

import { tr, trn } from '../../shared/i18n.ts';
export interface Ctx
{
    /** Readable label of the current scope ("you", "Recipient", "each vassal"). */
    scope: string;
    /**
     * a scope's label as a sentence's subject where the label is not one ("the vassal" for "each vassal"): an if's one
     * condition; only while `of` is the current scope (a scope switch below keeps the field, not the scope)
     */
    subject?: { of: string; text: string; };
    /** the file's `@name = value` constants (a card's: `@terrain_mastery_advantage` read as its number) */
    consts?: Map<string, string>;
    /** the card's own pictures as found (GameIndex.imagesOf): its `icon = name` setting shows the picture */
    images?: { icon?: string; illu?: string; };
    /** Conditions/chances on the way here (for follow-ups). */
    when: Rich[];
    hidden: boolean;
    followUps: FollowUp[];
    /** Remaining depth for expanding scripted triggers/effects. */
    expand: number;
    /** Names of scripted things currently being expanded (cycle guard). */
    stack: string[];
    /** Source text the current nodes were parsed from (for tooltips). */
    src: string;
    /**
     * The definition `src` is the text of, when the nodes are its own text as written: lines made from them carry
     * `src` anchors (docs/mods.md, "Editing in place"). Absent in expanded scripted triggers/effects (their text is
     * another definition's, with $PARAM$ substituted) and in snippets.
     */
    file?: DefAnchor;
    /** Scope type of the current scope when known ('character', 'landed_title' …): a hint for adding statements. */
    scopeType?: string;
    /** Scope type of the script's root when it is not a character (a doctrine's: faith): the anchors' `root`. */
    rootType?: string;
    /**
     * The scopes `prev` leads to (docs/readable-view.md, "The prev stack"): each scope switch and iterator pushes the
     * type of the scope it left (pushPrev), the last one is `prev`, the one below it `prev.prev`. Absent at the script's
     * root (nothing switched yet: `prev` there is the caller's, unknown); an entry undefined: not known.
     */
    prevTypes?: (string | undefined)[];
    /** the types of the saved scopes the script knows (`target_title` → landed_title): `scope:x = { … }` blocks' scope hints */
    savedTypes?: Record<string, string>;
    /**
     * the saved scopes the script knows of whatever their type (its own saves, what an event's callers pass in, a card's
     * known targets): never typed by their block's use (Describer.switched); the typed ones are in savedTypes too
     */
    knownScopes?: Set<string>;
    /**
     * the scope types of the variables the script sets to a scope (`var:x`, `local_var:x`, `global_var:x` →
     * landed_title; Describer.variableTypes): `var:x = { … }` blocks' scope hints
     */
    varTypes?: Record<string, string>;
    /** the type of the definition described (a card's): its condition blocks' hints for the picker (blockSection) */
    entityType?: string;
    /**
     * the nodes are another definition's text read in place of a call (an inlined scripted effect / trigger): that
     * definition; its lines' anchors say so (LineSource.owner)
     */
    owner?: EntityKey;
    /** the lines are read for a mod's text (its entry, or an effect it calls, at any depth): inlined ones are anchored */
    inMod?: boolean;
    /** what the scripted effect being read looks at around it (Describer.expandEffect): set inside its expansion only */
    trace?: ExpansionTrace;
    /**
     * inside an inlined definition whose lines are anchored (`owner`): where the shown definition calls it (the
     * outermost call), the anchors' LineSource.via
     */
    callAt?: { file: string; offset: number; };
    /**
     * the scope whose type is a guess from its block's own statements (Describer.switched): its label and type; the
     * current scope is guessed while both still match (an iterator or a switch inside changes them)
     */
    guess?: { scope: string; type: string; };
}

/** The current scope's type is a guess from its block's use (Ctx.guess). */
function isGuessed(ctx: Ctx): boolean
{
    return !!ctx.guess && ctx.guess.scope === ctx.scope && ctx.guess.type === ctx.scopeType;
}

/** where a call statement is written, as a picker place (Ctx.callAt): the shown definition's offsets, mapped back */
function placeOfNode(n: PNode, f: DefAnchor): { file: string; offset: number; }
{
    return { file: f.file, offset: f.start + (f.map ? f.map(n.s) : n.s) };
}

/**
 * What the lines of an expanded scripted effect depend on besides the call itself (its name, arguments and the scope it is
 * read in): the depth limit, the effects being expanded around it (cycle guard) and the events already led to, so one
 * expansion can stand for the same call anywhere it would read the same.
 */
export interface ExpansionTrace
{
    /** the label of the scope the call was read in */
    outer: string;
    /** the lines say it (a follow-up's "for …", "<scope>’s opinion"): the same call in another scope reads again */
    scopeRead: boolean;
    /** how many calls deep the effect expands inside (0: none) */
    depth: number;
    /** every scripted effect / trigger met inside, refused or not */
    names: Set<string>;
    /** a call inside was left unexpanded for the depth limit: the expansion fits that remaining depth only */
    expandRefused: boolean;
    /** the calls left unexpanded for being open around already: the expansion fits that stack only */
    stackHits: Set<string>;
    /** a follow-up was made inside (it holds the conditions on the way: the same call under other conditions differs) */
    leads: boolean;
    /** the follow-ups made inside, by the list they went into */
    fus: Map<FollowUp[], Set<FollowUp>>;
    /** an event argument was compared with the follow-ups so far: what is led to depends on what came before */
    tainted: boolean;
}

/** an expanded scripted effect, kept to stand for the same call again (Describer.expandEffect) */
interface Expansion
{
    lines: Line[];
    followUps: FollowUp[];
    trace: ExpansionTrace;
    /** the depth left when it was read (it fits that only when something inside was left unexpanded for the limit) */
    expand: number;
    /** the follow-ups' conditions, when it has any (their text is in them) */
    when?: string;
}

export function rootCtx(src: string, file?: DefAnchor, scopeType?: string): Ctx
{
    return { scope: 'you', when: [], hidden: false, followUps: [], expand: 4, stack: [], src, file, scopeType, ...(scopeType && scopeType !== 'character' ? { rootType: scopeType } : {}) };
}

const LOGIC_LABELS: Record<string, string> = {
    AND: tr('All of the following:'),
    OR: tr('At least one of the following:'),
    NOR: tr('None of the following:'),
    NAND: tr('Not all of the following:')
};

/** An if's one logic group as its heading ("If any of these are true:"). */
const IF_GROUP: Record<string, string> = {
    [LOGIC_LABELS.AND]: tr('all of these are true:'),
    [LOGIC_LABELS.OR]: tr('any of these are true:'),
    [LOGIC_LABELS.NOR]: tr('none of these are true:'),
    [LOGIC_LABELS.NAND]: tr('not all of these are true:')
};

/**
 * Keys that switch scope when used with a block, besides scope:x / var:x / chains and the one table of links, scriptCatalog.ts LINKS
 * (CATALOG_LINKS; round 13 moved player_heir, capital_barony, court_owner and owner there). `root`, `prev`, `this` and `from` name
 * a scope of the walk, not a link. `councillor` is the game's link from a council task to its councillor (event_targets.log).
 * Dropped (the owner's choice, 2026-11-14): the bare actor, recipient, target, secondary_actor, secondary_recipient, scheme_target,
 * spouse, army and head_of_faith. The game's docs list none of them as a link (they are saved scopes: scope:actor …), and its
 * script never writes them as a block outside the game_concepts / message_filter definitions of the same name.
 */
const SCOPE_LINKS = new Set([
    'root',
    'prev',
    'this',
    'from',
    'councillor'
]);

/** add_activity_log_entry's own settings (the rest of its block: effects) */
const LOG_ENTRY_PARAMS = new Set(['key', 'tags', 'character', 'target', 'artifact', 'score', 'show_in_conclusion', 'title', 'desc']);

const SKIP_EFFECT_KEYS = new Set([
    'save_scope_as',
    'save_temporary_scope_as',
    'save_scope_value_as',
    'save_temporary_scope_value_as',
    'clear_saved_scope',
    'play_music_cue',
    'play_sound_effect',
    'add_activity_log_entry',
    'debug_log',
    'debug_log_scopes',
    'assert_if',
    'assert_read',
    'name',
    'ai_chance',
    'flavor',
    'trigger',
    'show_as_unavailable',
    'fallback',
    'exclusive',
    'is_cancel_option',
    'clicksound',
    'highlight_portrait',
    'skill',
    'reason',
    'custom_tooltip_type',
    'duel_mode'
]);

const QUIET_EFFECT = /(^|_)(flag|variable|variable_list|list|temporary_list|global_list)$|^(add_to|remove_from|clear)_|_variable$|^set_(global_|local_)?variable|^change_(global_|local_)?variable|^remove_(global_|local_)?variable|^round_|^clamp_/;

/** Resource-style effects: key → [label, tone when positive]. */
const RESOURCES: Record<string, [string, 'good' | 'bad', string]> = {
    add_gold: ['Gold', 'good', 'gold'],
    add_short_term_gold: ['Gold', 'good', 'gold'],
    remove_short_term_gold: ['Gold', 'bad', 'gold'],
    remove_long_term_gold: ['Gold', 'bad', 'gold'],
    add_prestige: ['Prestige', 'good', 'prestige'],
    add_prestige_no_experience: ['Prestige', 'good', 'prestige'],
    add_prestige_experience: [tr('Prestige experience'), 'good', 'prestige'],
    add_piety: ['Piety', 'good', 'piety'],
    add_piety_no_experience: ['Piety', 'good', 'piety'],
    add_piety_experience: [tr('Piety experience'), 'good', 'piety'],
    add_stress: ['Stress', 'bad', 'stress'],
    add_dread: ['Dread', 'good', 'dread'],
    add_tyranny: ['Tyranny', 'bad', 'dread'],
    add_legitimacy: ['Legitimacy', 'good', 'prestige'],
    change_influence: ['Influence', 'good', 'prestige'],
    add_influence: ['Influence', 'good', 'prestige'],
    add_treasury: ['Treasury', 'good', 'gold'],
    add_herd: ['Herd', 'good', 'gold'],
    add_county_control: [tr('County control'), 'good', 'modifier'],
    change_county_control: [tr('County control'), 'good', 'modifier'],
    change_development_progress: [tr('Development progress'), 'good', 'modifier'],
    change_development_level: ['Development', 'good', 'modifier'],
    add_diplomacy_skill: ['Diplomacy', 'good', 'skill'],
    add_martial_skill: ['Martial', 'good', 'skill'],
    add_stewardship_skill: ['Stewardship', 'good', 'skill'],
    add_intrigue_skill: ['Intrigue', 'good', 'skill'],
    add_learning_skill: ['Learning', 'good', 'skill'],
    add_prowess_skill: ['Prowess', 'good', 'skill'],
    add_diplomacy_lifestyle_xp: [tr('Diplomacy lifestyle experience'), 'good', 'skill'],
    add_martial_lifestyle_xp: [tr('Martial lifestyle experience'), 'good', 'skill'],
    add_stewardship_lifestyle_xp: [tr('Stewardship lifestyle experience'), 'good', 'skill'],
    add_intrigue_lifestyle_xp: [tr('Intrigue lifestyle experience'), 'good', 'skill'],
    add_learning_lifestyle_xp: [tr('Learning lifestyle experience'), 'good', 'skill'],
    add_wanderer_lifestyle_xp: [tr('Wanderer lifestyle experience'), 'good', 'skill']
};

const COMPARE_WORDS: Record<string, string> = {
    '>=': tr('is at least'),
    '>': tr('is more than'),
    '<=': tr('is at most'),
    '<': tr('is less than'),
    '=': 'is',
    '==': 'is',
    '!=': tr('is not'),
    '?=': 'is'
};

type LinePart = Partial<Line> & { text: Rich; };

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** Where a game text's placeholder takes the statement's own value (templateParts): a character no text holds. */
const OWN_VALUE = '\u0001';

/** Where a game text's placeholder is left out (templateParts): it goes with one space next to it, not leaving two. */
const DROPPED = '\u0002';

/** A scripted call's name that ends on a word wanting its argument after it ("… with", "… from"): callHead. */
const CALL_ENDS_ON_WORD = /\b(with|from|by|to|as|of|in|on|for|into|at|against|about|between|over|than)$/i;
/** a $PARAM$ (unsubstituted: a scripted trigger / effect read on its own) */
const PARAM_KEY = /^\$[^$\s]+\$$/;

/**
 * A list of conditions as one string, what it says and what it links to: two conditions that read the same but name
 * different entities (the "Always Administrative" of two game rule options) are not the same condition.
 */
function whenKey(when: Rich[]): string
{
    return when.map((r) => r.map((s) => (typeof s === 'string' ? s : `${s.text}\u0003${s.kind}\u0003${s.ref ? `${s.ref.type}:${s.ref.name}` : ''}\u0003${s.tip ?? ''}`)).join('')).join('\u0001');
}

/**
 * The answers of chainHasElse for one text, by the place the chain continues at: every else_if of a chain asks, and each
 * would read the rest of the chain again (a chain of 100 tiers: 5000 blocks); the places a reading passes have its answer too.
 */
const chainAnswers = new Map<string, Map<number, boolean>>();

/** Whether the if / else_if chain continuing at `from` in the text ends in an else (else_ifs skipped, brace-matched). */
function chainHasElse(src: string, from: number): boolean
{
    let at = chainAnswers.get(src);

    if (!at)
    {
        // (the texts of the effects being read, a few at a time: a call reads another text and comes back)
        if (chainAnswers.size > 200)
            chainAnswers.clear();

        chainAnswers.set(src, at = new Map());
    }

    const known = at.get(from);

    if (known !== undefined)
        return known;

    const passed = [from];
    const answer = chainEnd(src, from, passed);

    for (const place of passed)
        at.set(place, answer);

    return answer;
}

function chainEnd(src: string, from: number, passed: number[]): boolean
{
    let i = from;
    const skip = (): void =>
    {
        for (;;)
        {
            while (i < src.length && /\s/.test(src[i]))
                i++;

            if (src[i] !== '#')
                return;

            while (i < src.length && src[i] !== '\n')
                i++;
        }
    };

    for (;;)
    {
        skip();
        const m = /^(trigger_)?else(_if)?\s*=\s*\{/.exec(src.slice(i, i + 40));

        if (!m)
            return false;

        if (!m[2])
            return true;

        // (past the else_if's block: braces counted, strings and comments skipped)
        i += m[0].length;

        for (let depth = 1; i < src.length && depth > 0; i++)
        {
            const c = src[i];

            if (c === '"')
            {
                for (i++; i < src.length && src[i] !== '"'; i++);
            }
            else if (c === '#')
            {
                for (; i < src.length && src[i] !== '\n'; i++);
            }
            else if (c === '{')
                depth++;
            else if (c === '}')
                depth--;
        }

        passed.push(i);
    }
}

/**
 * The label of the scope a statement is about ("you", "Recipient", "each vassal"). Read through here, not as `ctx.scope`: an
 * expanded scripted effect keeps track of whether its lines say the scope it was read in (Describer.expandEffect); when they
 * don't, the same call in any other scope is the same lines.
 */
export function scopeName(ctx: Ctx): string
{
    if (ctx.trace && ctx.scope === ctx.trace.outer)
        ctx.trace.scopeRead = true;

    return ctx.scope;
}

/** the copies ownCopy made, by their text */
const OWN_COPIES = new Map<string, string>();

/**
 * A string as a copy of its own, one per text: for caches that outlive the parse. The parser's keys and values are
 * slices of the definition's text, which is a slice of the whole file; V8 keeps a slice of 13 characters or more as
 * a pointer into its parent, so a slice kept in a long-lived cache would keep the file's text alive.
 */
export function ownCopy(s: string): string
{
    let c = OWN_COPIES.get(s);

    if (c === undefined)
    {
        c = Buffer.from(s, 'utf8').toString('utf8');
        OWN_COPIES.set(c, c);
    }

    return c;
}

/**
 * A modifier_definition_formats entry's fields, by the Def object read (null: no block). A Def of a file an update
 * did not change survives it (GameIndex.refreshFiles drops a changed file's Defs and makes new ones), so a new
 * Describer after an update reads only the formats of changed files again. Which Def wins stays a lookup per call.
 */
const FORMATS = new WeakMap<Def, Record<string, string> | null>();

/** keys whose value names a window or widget of the interface (Describer.guiSeg) */
const GUI_KEYS = new Set(['window', 'gui', 'gui_window_name', 'gui_participation_window_name', 'open_view', 'close_view', 'is_game_view_open']);

export class Describer
{
    private idx: GameIndex;
    private formatCache = new Map<string, Record<string, string> | null>();
    /** the window, widget, type or template of the `.gui` files by name (the GUI library, set by the index worker) */
    guiFind?: (name: string) => GuiItem | undefined;

    constructor(idx: GameIndex)
    {
        this.idx = idx;
    }

    // -------------------------------------------------------------------------
    // Values & names
    // -------------------------------------------------------------------------

    /**
     * Entries the text being described names that are not made yet (describeScript's `names`: the picker's "＋ New …",
     * key → the name given): read by that name where an unknown key would be made readable. Set only for one call.
     */
    pendingNames?: Record<string, string>;

    /** A not yet made entry's name (pendingNames), as a value segment. */
    private pendingSeg(key: string): RichSeg | undefined
    {
        const name = this.pendingNames?.[key];
        return name ? { text: name, kind: 'value', tip: key } : undefined;
    }

    lookupDisplay = (key: string): string | undefined =>
    {
        const pending = this.pendingNames?.[key];

        if (pending)
            return pending;

        const e = this.idx.named(key)[0];

        if (e)
            return this.idx.displayName(e);

        // (a faith's / religion's / rite's other names: `catholic_adj`, `_adherent`, `_adherent_plural`: loc keys)
        return /_(adj|adherent|adherent_plural)$/.test(key) ? this.idx.plainLoc(key) : undefined;
    };

    loc(key: string): Rich | undefined
    {
        // (spaces at a text's very start or end are the game's, nothing to read: "~50%: " + " They quickly quieten down")
        const t = this.idx.plainLoc(key, 0, true)?.replace(/^ +| +$/g, '');
        return t === undefined ? undefined : locToRich(t, this.lookupDisplay, (inner) => this.idx.bracketRef(inner));
    }

    entitySeg(e: Entity): RichSeg
    {
        // (a name that is a loc template, "Number of County Followers: $NUM|V0$", loses its argument; a name that is
        // only its type's word, a mod's hidden traits all named "Trait" (`name = trait_hidden`), reads as its key:
        // "Is Targaryen 35", not "Loses the Trait Trait")
        const d = this.idx.displayName(e);
        const bare = d !== undefined && d.toLowerCase() === typeLabel(e.type).replace(/s$/, '').toLowerCase();
        return { text: (!bare && d && dropTemplateArgs(d, '…')) || titleCase(humanize(e.name)), kind: 'entity', ref: { type: e.type, name: e.name }, tip: `${typeLabel(e.type)}: ${e.name}` };
    }

    /**
     * A value naming a window or widget of the interface, written under a key that does (an event's `window`, a
     * decision's `gui`, `open_view`, `is_game_view_open` …; `view` inside `open_view_data`): a link to the GUI tab
     * (docs/gui-designer.md). Undefined: another key, or no such window in the loaded `.gui` files.
     */
    guiSeg(key: string, v: string, parent?: string): RichSeg | undefined
    {
        if (!GUI_KEYS.has(key) && !(key === 'view' && parent === 'open_view_data'))
            return undefined;

        const name = v.replace(/^"|"$/g, '');
        const g = this.guiFind?.(name);
        return g ? { text: titleCase(humanize(name)), kind: 'entity', ref: { type: '@gui', name: `${g.kind}:${g.name}` }, tip: `${key} = ${name}` } : undefined;
    }

    /** Link to a definition by name, preferring the given types. */
    ref(name: string, types?: string[]): RichSeg
    {
        let e: Entity | undefined;

        if (types)
        {
            for (const t of types)
                if ((e = this.idx.get(t, name)))
                    break;
        }

        if (!e)
            e = this.idx.named(name)[0];

        if (e)
            return this.entitySeg(e);

        return this.pendingSeg(name) ?? { text: titleCase(humanize(name)), kind: 'code', tip: name };
    }

    /** Readable label of a scope expression: `scope:recipient.liege` → "Recipient’s liege". */
    scopeLabel(path: string, ctx?: Ctx): string
    {
        const segs = path.split('.');
        // a link is someone's: `liege` at the top is your liege, inside "each child" that child's liege
        const first = segs[0];
        const relative = !!ctx && !first.includes(':') && !PARAM_KEY.test(first) && !/^(root|this|prev|from)$/i.test(first);
        const words = segs.map((s) =>
        {
            if (/^root$/i.test(s))
                return 'you';

            if (s === 'this')
                return ctx ? scopeName(ctx) : 'they';

            if (s === 'prev')
                return tr('the previous one');

            // ($OWNER$ in a scripted trigger / effect read on its own: who is passed in)
            if (PARAM_KEY.test(s))
                return tr('the {humanize}', { humanize: humanize(s.slice(1, -1).toLowerCase()) });

            const c = s.indexOf(':');

            if (c > 0)
            {
                const p = s.slice(0, c);
                const n = s.slice(c + 1);

                if (p === 'scope')
                    return titleCase(humanize(n));

                if (p === 'var' || p === 'local_var' || p === 'global_var' || p === 'dead_var')
                    return `“${humanize(n)}”`;

                // (the prefix's own types: `character:131` is the character, not dynasty 131 of the same number)
                const types = PREFIX_TYPES[p];
                const e = types ? this.idx.named(n).find((x) => types.includes(x.type)) : this.idx.named(n)[0];
                const d = e && this.idx.displayName(e);
                return d ?? titleCase(humanize(n));
            }

            // (a link with an argument, `aptitude(court_physician_court_position)`: the argument by its name, left out
            // where the chain names it already: "Personal Physician’s aptitude")
            const call = /^(\w+)\(\s*([^()]*?)\s*\)$/.exec(s);

            if (call)
            {
                const arg = call[2];

                if (!arg || segs.some((o) => o !== s && o.endsWith(':' + arg)))
                    return humanize(call[1]);

                const e = /^\w+$/.test(arg) ? this.idx.named(arg)[0] : undefined;
                return `${humanize(call[1])} (${(e && this.idx.displayName(e)) ?? humanize(arg)})`;
            }

            return humanize(s);
        });
        let out = words[0];

        // (after a quoted name, "of": "the player heir of Activity’s “host var”", not "“host var”’s player heir", whose
        // quote and apostrophe run together)
        const owned = (owner: string, link: string): string => (owner.endsWith('”') ? tr('the {link} of {owner}', { link, owner }) : `${possessive(owner)} ${link}`);

        if (relative)
            out = owned(scopeName(ctx!), out.toLowerCase());

        for (let i = 1; i < words.length; i++)
            out = owned(out, words[i].toLowerCase());

        return out;
    }

    /**
     * A doctrine's entry. Many names only make sense next to their group ("None", "Spiritual", "Accepted"): where the game
     * has the doctrine's descriptive name ("No Head of Faith"), that is what is shown.
     */
    doctrineSeg(key: string): RichSeg
    {
        const seg = this.ref(key, ['religion/doctrine_types']);
        const d = typeof seg !== 'string' && seg.kind === 'entity' ? this.idx.plainLoc(key + '_descriptive_name') : undefined;
        return d && !/[$[]/.test(d) ? { ...(seg as Exclude<RichSeg, string>), text: d } : seg;
    }

    /** `head`: a line's head ("Your liege:"), capitalized */
    scopeSeg(path: string, ctx?: Ctx, head = false): RichSeg
    {
        if (PREV_PREV.test(path))
            return refusedPrev(path, true);

        const text = this.scopeLabel(path, ctx);
        return { text: head ? capitalize(text) : text, kind: 'scope', tip: path };
    }

    /**
     * `@name` / `@[formula]`: a file constant's value from `consts` (the context's), a formula worked out as a number where all
     * its operands are known (constants, numbers, script values); else as written.
     */
    constOf(v: string, ctx?: Ctx, consts = ctx?.consts, depth = 0): string
    {
        if (!v.startsWith('@') || !consts || depth > 40)
            return v;

        if (v.startsWith('@['))
        {
            const n = this.formula(v.slice(2, v.endsWith(']') ? -1 : undefined), consts, depth + 1);
            return n === undefined ? v : String(Math.round(n * 1e6) / 1e6);
        }

        const raw = consts.get(v.slice(1));
        return raw === undefined ? v : this.constOf(raw, ctx, consts, depth + 1);
    }

    /** The arithmetic of a `@[ ]` formula (+ - * / and parentheses; names are constants or script values); undefined if an operand is unknown. */
    private formula(expr: string, consts: Map<string, string>, depth: number): number | undefined
    {
        // (formulas that lead back to themselves through script values)
        if (this.formulaDepth > 16)
            return undefined;

        this.formulaDepth++;

        try
        {
            return this.formulaOf(expr, consts, depth);
        }
        finally
        {
            this.formulaDepth--;
        }
    }

    private formulaDepth = 0;

    private formulaOf(expr: string, consts: Map<string, string>, depth: number): number | undefined
    {
        const tokens = expr.match(/\d+\.?\d*|\.\d+|[A-Za-z_]\w*|\S/g) ?? [];
        let i = 0;
        let bad = false;
        const operand = (): number =>
        {
            const t = tokens[i++];

            if (t === '(')
            {
                const x = sum();
                i++;
                return x;
            }

            if (t === '-')
                return -operand();

            if (t !== undefined && /^[\d.]/.test(t))
                return parseFloat(t);

            const c = t === undefined ? undefined : this.constOf('@' + t, undefined, consts, depth);
            const n = c === undefined || c === '@' + t ? (t === undefined ? undefined : this.evalValue(t)) : NUMERIC.test(c) ? parseFloat(c) : this.evalValue(c);

            if (n === undefined)
                bad = true;

            return n ?? 0;
        };
        const product = (): number =>
        {
            let x = operand();

            for (; tokens[i] === '*' || tokens[i] === '/'; )
                x = tokens[i++] === '*' ? x * operand() : x / operand();

            return x;
        };
        const sum = (): number =>
        {
            let x = product();

            for (; tokens[i] === '+' || tokens[i] === '-'; )
                x = tokens[i++] === '+' ? x + product() : x - product();

            return x;
        };
        const r = sum();
        return bad || i < tokens.length || !Number.isFinite(r) ? undefined : r;
    }

    /** `define:NCharacter|KEY`: the define's value as written (undefined if the game's defines do not have it). */
    private defineValue(v: string): string | undefined
    {
        const m = /^define:(\w+)\|(\w+)$/i.exec(v);

        if (!m)
            return undefined;

        const ns = m[1].toLowerCase();
        const name = this.idx.names('defines').find((x) => x.toLowerCase() === ns);
        const e = name && this.idx.get('defines', name);
        const d = e && this.idx.defNode(e);

        if (!d || typeof d.node.v === 'string')
            return undefined;

        const c = d.node.v.find((x) => x.k?.toLowerCase() === m[2].toLowerCase());
        return typeof c?.v === 'string' ? c.v : undefined;
    }

    /** Tries to resolve a script value to a constant. */
    evalValue(name: string, depth = 0): number | undefined
    {
        if (NUMERIC.test(name))
            return parseFloat(name);

        if (depth > 6)
            return undefined;

        if (/^define:/i.test(name))
        {
            const d = this.defineValue(name);
            return d !== undefined && NUMERIC.test(d) ? parseFloat(d) : undefined;
        }

        const e = this.idx.get('script_values', name);

        if (!e)
            return undefined;

        const d = this.idx.defNode(e);

        if (!d)
            return undefined;

        const v = d.node.v;
        // (a value written as a constant of its own file: `tax = @[poor_tax_tier_2]`)
        const text = typeof v === 'string' ? v : v.length === 1 && v[0].k === 'value' && typeof v[0].v === 'string' ? v[0].v : undefined;

        if (text === undefined)
            return undefined;

        const c = text.startsWith('@') ? this.constOf(text, undefined, this.idx.fileConstants(e)) : text;
        return c === text && text.startsWith('@') ? undefined : this.evalValue(c, depth + 1);
    }

    /**
     * A number worked out of a written value: a script value's number links its entry (its hover card, a click opens
     * it: `stewardship = { min_template_high_skill max_template_high_skill }` "13–17"); a plain number or a constant
     * is just the number.
     */
    numberSeg(written: string, n: number, sign = false): RichSeg
    {
        const text = sign ? signed(n) : formatNumber(n);
        const e = NUMERIC.test(written) ? undefined : this.idx.get('script_values', written);
        return e ? { ...(this.entitySeg(e) as Exclude<RichSeg, string>), text, tip: written } : { text, kind: 'value', ...(NUMERIC.test(written) ? {} : { tip: written }) };
    }

    /**
     * A statement's amount (`value = …` of add_trait_xp): a number, a script value (linked: numberSeg), or a block: a
     * random range (`integer_range = { min max }`, `random_range`, `fixed_range`) "+10–20", a lone `value = x` read
     * as x, else "a calculated amount" (the block in its tooltip).
     */
    amount(node: PNode | undefined, ctx: Ctx, sign = true): Rich | undefined
    {
        if (!node)
            return undefined;

        if (typeof node.v === 'string')
        {
            const v = this.constOf(node.v, ctx);
            const n = this.evalValue(v);

            // (`VALUE = $VALUE$` in a scripted effect: the amount passed in, named, not "the value experience")
            if (n === undefined && PARAM_KEY.test(v))
                return [{ text: tr('“{humanize}”', { humanize: capitalize(humanize(v.slice(1, -1).toLowerCase())) }), kind: 'value', tip: v }];

            return [n !== undefined ? this.numberSeg(v, n, sign) : this.valueSeg(v, ctx)];
        }

        const range = node.v.find((c) => (c.k === 'integer_range' || c.k === 'random_range' || c.k === 'fixed_range') && Array.isArray(c.v));

        if (range && Array.isArray(range.v))
        {
            const end = (k: string): { seg: RichSeg; v: string; n?: number; } | undefined =>
            {
                const c = (range.v as PNode[]).find((x) => x.k === k);

                if (typeof c?.v !== 'string')
                    return undefined;

                const v = this.constOf(c.v, ctx);
                const n = this.evalValue(v);
                return n !== undefined ? { seg: this.numberSeg(v, n), v, n } : { seg: this.valueSeg(v, ctx), v };
            };
            const lo = end('min');
            const hi = end('max');

            // (both ends the same number: just that number, "+1", not "+1–1")
            if (lo && hi && lo.n !== undefined && lo.n === hi.n)
                return [this.numberSeg(lo.v, lo.n, sign)];

            // (both ends the same value that is not a number, `min = $XP_MIN$ max = $XP_MAX$` given one script value
            // twice: that value once)
            if (lo && hi && lo.n === undefined && lo.v === hi.v)
                return [lo.seg];

            if (lo && hi)
                return rich(sign && lo.n !== undefined && lo.n >= 0 ? '+' : '', lo.seg, '–', hi.seg);
        }

        if (node.v.length === 1 && node.v[0].k === 'value')
            return this.amount(node.v[0], ctx, sign);

        return [{ text: tr('a calculated amount'), kind: 'value', tip: this.tip(node, ctx) }];
    }

    /** A value operand: number, script value, scope, or a definition. */
    valueSeg(v: string, ctx?: Ctx): RichSeg
    {
        v = this.constOf(v, ctx);

        if (NUMERIC.test(v))
            return { text: formatNumber(parseFloat(v)), kind: 'value' };

        // (a date: 1150.1.1)
        if (/^-?\d+\.\d+\.\d+$/.test(v))
            return { text: v, kind: 'value' };

        // (a constant or a formula that is not worked out: its names as words, its numbers as written, never read as a scope)
        if (v.startsWith('@'))
            return { text: v.startsWith('@[') ? v.slice(2, v.endsWith(']') ? -1 : undefined).replace(/[A-Za-z_]\w*/g, (w) => humanize(w)) : humanize(v.slice(1)), kind: 'value', tip: v };

        if (/^define:/i.test(v))
        {
            const d = this.defineValue(v);

            if (d !== undefined && NUMERIC.test(d))
                return { text: formatNumber(parseFloat(d)), kind: 'value', tip: v };

            return { text: humanize(v.slice(v.indexOf('|') + 1)), kind: 'value', tip: v };
        }

        if (/^(scope|root|prev|this|var|local_var|global_var)\b/.test(v) || v.includes('.') || PARAM_KEY.test(v))
            return this.scopeSeg(v, ctx);

        if (v.startsWith('tier_'))
            return { text: capitalize(humanize(v.slice(5))), kind: 'value', tip: v };

        if (v.startsWith('flag:'))
            return { text: `“${humanize(v)}”`, kind: 'value', tip: v };

        // database links: trait:measles, faith:catholic, character:163110
        const db = /^(\w+):([\w-]+)$/.exec(v);
        // (the prefix's own types: `character:131` is the character, not dynasty 131 of the same number)
        const dbTypes = db ? PREFIX_TYPES[db[1]] : undefined;
        const dbEntity = db && (dbTypes ? this.idx.named(db[2]).find((x) => dbTypes.includes(x.type)) : this.idx.named(db[2])[0]);

        if (dbEntity)
            return this.entitySeg(dbEntity);

        // (an entry the picker is making: `trait:new_one`, `new_one`)
        const pending = this.pendingSeg(db ? db[2] : v);

        if (pending)
            return pending;

        const n = this.evalValue(v);

        if (n !== undefined)
            return { text: formatNumber(n), kind: 'value', tip: v };

        const e = this.idx.named(v)[0];

        if (e)
            return this.entitySeg(e);

        return { text: humanize(v), kind: 'value', tip: v };
    }

    private tip(n: PNode, ctx: Ctx): string
    {
        const t = ctx.src.slice(n.s, n.e);
        return t.length > 600 ? t.slice(0, 600) + '\n…' : t;
    }

    /**
     * Where a node is written in its file (Line.src), when the context reads a definition's own text. `inner`: the node
     * is a block of statements of the same kind: statements can be added inside (at its end).
     */
    anchor(n: PNode, ctx: Ctx, kind: LineSource['kind'], inner: boolean): LineSource | undefined
    {
        const f = ctx.file;

        if (!f)
            return undefined;

        // (a text with $PARAM$s filled in: its offsets are mapped back to the definition's own)
        const m = f.map ?? ((o: number): number => o);
        const a: LineSource = { file: f.file, rel: f.rel, line: f.line + n.line - 1, s: f.start + m(n.s), e: f.start + m(n.e), kind, hash: f.hash };

        if (f.mod)
            a.mod = f.mod;

        // (found again by its own text when the file changes elsewhere before the index has read it again)
        if (f.text)
            a.stmt = this.stmtOf(f, a.s, a.e);

        if (ctx.owner)
        {
            a.owner = ctx.owner;

            // (the shown definition's scopes in reach are those at its call)
            if (ctx.callAt)
                a.via = ctx.callAt;
        }

        // (the prev stack at the statement: the picker types a typed `prev` by it)
        if (ctx.prevTypes?.length)
            a.prev = ctx.prevTypes;

        if (isGuessed(ctx))
            a.scopeGuessed = true;

        // (an unclosed block has no closing brace to add before)
        if (inner && Array.isArray(n.v) && ctx.src.charCodeAt(n.e - 1) === 125)
            a.inner = [f.start + m(n.vs) + 1, f.start + m(n.e) - 1];

        if (ctx.scopeType)
            a.scope = ctx.scopeType;

        if (ctx.rootType)
            a.root = ctx.rootType;

        if (n.k && /^(trigger_)?(if|else_if)$/.test(n.k) && Array.isArray(n.v) && !chainHasElse(ctx.src, n.e))
            a.ifKey = n.k;

        // (inside an iterator or a scope switch: another scope, someone else)
        if (a.inner)
        {
            const inside = this.insideOf(n, ctx);

            if (inside.scope)
                a.innerScope = inside.scope;

            if (inside.subject)
                a.subject = inside.subject;

            if (inside.prev)
                a.prevInside = inside.prev;

            if (inside.guessed)
                a.innerGuessed = true;
        }

        return a;
    }

    /**
     * Statement checks made (LineSource.stmt), by file and offsets: an inlined scripted effect repeats its statements at
     * every call. The texts don't change while this describer lives (one per index revision); a cap bounds it.
     */
    private stmts = new Map<string, StatementCheck>();

    private stmtOf(f: DefAnchor, s: number, e: number): StatementCheck
    {
        const key = `${f.file}|${s}|${e}`;
        let c = this.stmts.get(key);

        if (!c)
        {
            if (this.stmts.size > 200_000)
                this.stmts.clear();

            this.stmts.set(key, c = stmtCheck(f.text!, s, e));
        }

        return c;
    }

    /**
     * The context a scripted effect / trigger is read in where it is called (its text `src`, `$PARAM$`s filled in with
     * `args`): where it can be edited from the view (the calling text is a mod's, or the definition is), its lines are
     * anchored to the definition (the filled-in offsets mapped back to its own, `owner` its key: docs/mods.md "Editing
     * in place"); else, as the game's are read, without anchors.
     */
    inlinedCtx(e: Entity, src: string, args: Record<string, string> | undefined, ctx: Ctx, callAt?: Ctx['callAt']): Ctx
    {
        const inMod = !!ctx.inMod || !!ctx.file?.mod;
        // (its @constants are those of its own file)
        const inner: Ctx = { ...ctx, src, file: undefined, owner: undefined, callAt: undefined, expand: ctx.expand - 1, stack: [...ctx.stack, e.name], inMod, consts: this.idx.fileConstants(e) };
        // (the game's text only read for a mod's entry (at any depth): the game's entries calling the game's effects stay
        // as they were)
        const first = ctx.file && this.idx.defAnchor(e);
        const a = first && (inMod || first.mod) ? (first.text ? first : this.idx.defAnchor(e, undefined, true)) : undefined;

        if (!a?.text)
            return inner;

        // (the text read must be the definition's, filled in: else its offsets say nothing about the file; both come
        // from the same file text, so its length tells)
        const map = args ? filledMap(a.text.slice(a.start, a.end), args) : undefined;

        if ((map ? map.text.length : a.end - a.start) !== src.length)
            return inner;

        return { ...inner, file: map ? { ...a, map: map.map } : a, owner: { type: e.type, name: e.name }, ...(callAt ? { callAt } : {}) };
    }

    /**
     * Where the shown definition calls `e` (Ctx.callAt): the call `call` in the text read, or the outermost call when that
     * text is itself an inlined one; undefined when the lines inside are not anchored (inlinedCtx: the game's effect read
     * for the game's entry) or the call is not known.
     */
    callPlace(e: Entity, ctx: Ctx, call?: PNode): Ctx['callAt']
    {
        if (!ctx.file)
            return undefined;

        if (ctx.owner)
            return ctx.callAt;

        // (the game's entry calling a mod's effect is anchored too (inlinedCtx); the file's source says so without its text)
        const def = !ctx.inMod && !ctx.file.mod ? e.defs[this.idx.winningIdx(e)] : undefined;

        if (!call || !(ctx.inMod || ctx.file.mod || (def && this.idx.files[def.file]?.source)))
            return undefined;

        return placeOfNode(call, ctx.file);
    }

    /**
     * The scripted effects read so far, by call (name, arguments, scope …): a big effect is called from many places, and
     * its callers' callers repeat it: one reading stands for them all (the same Line objects, shared). Kept while this
     * describer lives (one per index revision); a cap bounds it.
     */
    private expansions = new Map<string, Expansion[]>();
    /** the lines the kept expansions hold (a line of an expansion inside another counts for both) */
    private expansionLines = 0;
    /** the lines `effects()` made so far (a shared expansion makes none) */
    private linesMade = 0;
    /** the follow-ups of a list by what they say (an expansion read again repeats them: a list holds each once) */
    private leadKeys = new WeakMap<FollowUp[], Set<string>>();
    private whenKeys = new WeakMap<Rich[], string>();
    /** how many `effects()` calls are open (the outermost one fits its lines to the card's budget) */
    private effectsOpen = 0;
    /** the number of lines under a line, itself included (shared lines are counted once) */
    private sizes = new WeakMap<Line, number>();
    /** off: every call is read again (the check script compares both) */
    shareExpansions = true;
    /** off: no scope is typed by its block's use (Describer.switched; a dump compares both) */
    guessScopes = true;
    /** the most lines a list of effects lists in full (see fitLines) */
    lineBudget = LINE_BUDGET;
    /**
     * the lines cut for a card's size, by Line.more (moreLines gives them); the oldest go past CUT_KEPT groups (by number:
     * a group's logical size says little, its lines are one reading shared by many calls)
     */
    private cut = new Map<number, Line[]>();
    private cutNext = 1;

    /** Lines a card left out for its size (Line.more), cut again by the same budget: their own big groups load the same way. */
    moreLines(id: number): Line[] | null
    {
        const lines = this.cut.get(id);
        return lines ? this.cutLines(lines, { left: this.lineBudget, slack: SMALL_SLACK }) : null;
    }

    private keepCut(lines: Line[]): number
    {
        const id = this.cutNext++;
        this.cut.set(id, lines);

        if (this.cut.size > CUT_KEPT)
            this.cut.delete(this.cut.keys().next().value!);

        return id;
    }

    private newTrace(e: Entity, ctx: Ctx): ExpansionTrace
    {
        return { outer: ctx.scope, scopeRead: false, depth: 0, names: new Set([e.name]), expandRefused: false, stackHits: new Set(), leads: false, fus: new Map(), tainted: false };
    }

    /**
     * `t`, the trace of a call read inside the one `into` is the trace of, counts for it too (`outer`: the effects open
     * around that call; a cycle inside the call itself is no business of the ones around)
     */
    private mergeTrace(into: ExpansionTrace | undefined, t: ExpansionTrace, outer: string[]): void
    {
        if (!into)
            return;

        for (const n of t.names)
            into.names.add(n);

        for (const n of t.stackHits)
            if (outer.includes(n))
                into.stackHits.add(n);

        into.depth = Math.max(into.depth, t.depth + 1);
        into.scopeRead ||= t.scopeRead && t.outer === into.outer;
        into.expandRefused ||= t.expandRefused;
        into.leads ||= t.leads;

        for (const [list, set] of t.fus)
        {
            let to = into.fus.get(list);

            if (!to)
                into.fus.set(list, to = new Set());

            for (const f of set)
                to.add(f);
        }

        into.tainted ||= t.tainted;
    }

    /** a scripted effect / trigger call met (and not read when `refused`): its place in the trace of the expansion around */
    private meet(e: Entity, ctx: Ctx): void
    {
        const t = ctx.trace;

        if (!t)
            return;

        t.names.add(e.name);

        if (ctx.expand <= 0)
            t.expandRefused = true;

        if (ctx.stack.includes(e.name))
            t.stackHits.add(e.name);
    }

    /** do the lines read for `x` serve a call read with this depth and these effects open around it? */
    private serves(x: Expansion, ctx: Ctx): boolean
    {
        const t = x.trace;

        if (t.expandRefused ? x.expand !== ctx.expand : ctx.expand < t.depth + 1)
            return false;

        if (t.scopeRead && t.outer !== ctx.scope)
            return false;

        for (const n of ctx.stack)
            if (t.names.has(n) && !t.stackHits.has(n))
                return false;

        for (const n of t.stackHits)
            if (!ctx.stack.includes(n))
                return false;

        return true;
    }

    /** a follow-up made in `ctx` (it goes into its list; an expansion around keeps what it made, by list) */
    private lead(ctx: Ctx, f: FollowUp): void
    {
        this.listFollowUp(ctx.followUps, f);

        if (ctx.trace)
        {
            ctx.trace.leads = true;
            this.recordLeads(ctx, [f]);
        }
    }

    /** follow-ups made by lines read elsewhere (a character's after-creation effects) that belong to the list of `ctx` as well */
    leadAll(ctx: Ctx, fus: FollowUp[]): void
    {
        for (const f of fus)
            this.lead(ctx, f);
    }

    /**
     * A scripted definition read in place of its name outside `effects()` / `triggers()` (a scripted modifier in a weight
     * block): `read` gets the context its lines are read with (the trace of the expansion around is kept: the depth it
     * took, whether it was refused or open around already).
     */
    readCall<T>(e: Entity, ctx: Ctx, read: (trace: ExpansionTrace | undefined) => T): T
    {
        const trace = ctx.trace ? this.newTrace(e, ctx) : undefined;
        const r = read(trace);

        if (trace)
            this.mergeTrace(ctx.trace, trace, ctx.stack);

        return r;
    }

    /** a call to `e` met (read or left for the depth limit): the trace of the expansion around notes it */
    meetCall(e: Entity, ctx: Ctx): void
    {
        this.meet(e, ctx);
    }

    private recordLeads(ctx: Ctx, fus: FollowUp[]): void
    {
        const t = ctx.trace;

        if (!t || !fus.length)
            return;

        let set = t.fus.get(ctx.followUps);

        if (!set)
            t.fus.set(ctx.followUps, set = new Set());

        for (const f of fus)
            set.add(f);
    }

    /**
     * `f` into `list` unless the list has one that says the same (event, for whom, delay, conditions): a script that leads
     * to an event from hundreds of places gives a list of hundreds of equal entries (the view merges them anyway)
     */
    private listFollowUp(list: FollowUp[], f: FollowUp): void
    {
        let keys = this.leadKeys.get(list);

        if (!keys)
        {
            this.leadKeys.set(list, keys = new Set());

            for (const x of list)
                keys.add(this.leadKey(x));
        }

        const k = this.leadKey(f);

        if (!keys.has(k))
        {
            keys.add(k);
            list.push(f);
        }
    }

    private leadKey(f: FollowUp): string
    {
        let w = this.whenKeys.get(f.when);

        if (w === undefined)
            this.whenKeys.set(f.when, w = whenKey(f.when));

        return [f.target.type, f.target.name, f.label, f.delay ?? '', f.who ?? '', f.hidden ? 1 : 0, w].join('\u0002');
    }

    /** put `fus` into the list of `ctx` (a shared expansion repeats them) */
    private addFollowUps(ctx: Ctx, fus: FollowUp[]): void
    {
        for (const f of fus)
            this.listFollowUp(ctx.followUps, f);
    }

    /**
     * The lines of the scripted effect `e` called with `args`, read in place of the call. The same call (same arguments,
     * scope, ...) read again gives the same lines (not new ones), when the depth left and the effects open around it
     * would not make them differ; the follow-ups they lead to are added to the list again.
     */
    private expandEffect(e: Entity, args: Record<string, string> | undefined, ctx: Ctx, call?: PNode): Line[]
    {
        // (its anchored lines say where the shown definition calls it (LineSource.via): the lines of two calls differ
        // there, so the place is part of the key; unanchored lines carry none)
        const callAt = this.callPlace(e, ctx, call);
        const key = this.shareExpansions ?
            [
                e.type,
                e.name,
                args ? JSON.stringify(args) : '',
                ctx.scopeType ?? '',
                ctx.rootType ?? '',
                ctx.hidden ? 1 : 0,
                ctx.file ? 1 : 0,
                ctx.inMod || ctx.file?.mod ? 1 : 0,
                ctx.entityType ?? '',
                ctx.savedTypes ? JSON.stringify(ctx.savedTypes) : '',
                ctx.knownScopes ? [...ctx.knownScopes].sort().join(',') : '',
                ctx.varTypes ? JSON.stringify(ctx.varTypes) : '',
                ctx.prevTypes ? JSON.stringify(ctx.prevTypes) : '',
                isGuessed(ctx) ? 1 : 0,
                callAt ? `${callAt.file}|${callAt.offset}` : ''
            ].join('\u0001') :
            '';
        const kept = key ? this.expansions.get(key) : undefined;
        let when: string | undefined;

        for (const x of kept ?? [])
        {
            if (x.when !== undefined && x.when !== (when ??= whenKey(ctx.when)))
                continue;

            if (!this.serves(x, ctx))
                continue;

            this.addFollowUps(ctx, x.followUps);
            this.mergeTrace(ctx.trace, x.trace, ctx.stack);
            this.recordLeads(ctx, x.followUps);
            return x.lines;
        }

        const d = this.idx.defNode(e, args);

        // (another definition's text, $PARAM$ substituted: its lines are anchored to that definition; inlinedCtx)
        if (!d || !Array.isArray(d.node.v))
            return [];

        const trace = this.newTrace(e, ctx);
        const made = this.linesMade;
        this.effectsOpen++;
        let lines: Line[];

        try
        {
            lines = this.effects(d.node.v, { ...this.inlinedCtx(e, d.src, args, ctx, callAt), trace });
        }
        finally
        {
            this.effectsOpen--;
        }

        // (a cycle inside the effect itself (it calls itself, a call below it does) is the same wherever it is read)
        for (const n of [...trace.stackHits])
            if (!ctx.stack.includes(n))
                trace.stackHits.delete(n);

        this.mergeTrace(ctx.trace, trace, ctx.stack);

        if (key && !trace.tainted)
        {
            const followUps = [...(trace.fus.get(ctx.followUps) ?? [])];

            trace.fus = new Map();

            if (this.expansionLines > MAX_EXPANSION_LINES)
            {
                this.expansions.clear();
                this.expansionLines = 0;
            }

            let list = this.expansions.get(key);

            if (!list)
                this.expansions.set(key, list = []);

            list.push({ lines, followUps, trace, expand: ctx.expand, when: trace.leads ? (when ?? whenKey(ctx.when)) : undefined });
            this.expansionLines += this.linesMade - made;
        }

        return lines;
    }

    /**
     * Who a block's statements are about: an iterator's item ("the child"), a scope switch's target ("Liege"); the prev
     * stack inside (pushPrev) and whether the type is a guess from the block's use (Describer.switched).
     */
    insideOf(n: PNode, ctx: Ctx): { scope?: string; subject?: string; prev?: (string | undefined)[]; guessed?: boolean; }
    {
        const k = n.k ?? '';
        const it = !NOT_ITERATORS.has(k) && /^(any|every|random|ordered)_(\w+)$/.exec(k);

        if (it && !this.idx.get('scripted_effects', k) && !this.idx.get('scripted_triggers', k))
            return { scope: iteratedScope(it[2]), subject: tr('the {iterLabel}', { iterLabel: this.iterLabel(it[2]) }), prev: pushPrev(ctx) };

        if (this.isScopeKey(k))
        {
            const label = this.scopeLabel(k, ctx);
            const sw = this.switched(k, Array.isArray(n.v) ? n.v : undefined, label, ctx);
            return { scope: sw.scopeType, subject: label, prev: pushPrev(ctx, k), ...(sw.guess ? { guessed: true } : {}) };
        }

        return {};
    }

    /**
     * The scope inside a scope switch `k = { block }` (its label `label`): linkedScope's type; a saved scope that
     * nothing saves, documents or passes in (neither in Ctx.savedTypes nor in Ctx.knownScopes) and whose name says
     * nothing is typed by its block's own statements when they all fit one type, a character too (scopeTypeByUse:
     * docs/readable-view.md, "Guessed scope types"), as a guess (Ctx.guess); a link from a guessed scope is a guess
     * too. Else as linkedScope (a character, unmarked, when its block says nothing).
     */
    switched(k: string, block: PNode[] | undefined, label: string, ctx: Ctx): { scopeType?: string; guess?: Ctx['guess']; }
    {
        const m = /^scope:(\w+)$/.exec(k);

        // (a scope the script knows of (its own saves, what an event's callers pass in, a card's known targets: savedTypes
        // and knownScopes, stories.ts) is never guessed; a character use of one nobody gives is a guess too)
        if (m && block && this.guessScopes && !ctx.savedTypes?.[m[1]] && !ctx.knownScopes?.has(m[1]) && scopeTypeByName(m[1]) === undefined)
        {
            const used = scopeTypeByUse(block);

            if (used)
                return { scopeType: used, guess: { scope: label, type: used } };
        }

        const type = linkedScope(k, ctx.scopeType, ctx);

        // (`holder = { … }` in a guessed title: what it leads to rests on the guess)
        if (type && isGuessed(ctx) && /^\w+(\.\w+)*$/.test(k) && !/^(root|prev|this|from)(\.|$)/.test(k))
            return { scopeType: type, guess: { scope: label, type } };

        return { scopeType: type };
    }

    /** a scope switch's context: its label, type (Describer.switched) and prev stack */
    private switchCtx(k: string, block: PNode[], ctx: Ctx): Ctx
    {
        const label = this.scopeLabel(k, ctx);
        const sw = this.switched(k, block, label, ctx);
        return { ...ctx, scope: label, scopeType: sw.scopeType, prevTypes: pushPrev(ctx, k), guess: sw.guess ?? ctx.guess };
    }

    // -------------------------------------------------------------------------
    // Triggers
    // -------------------------------------------------------------------------

    triggers(nodes: PNode[], ctx: Ctx): Line[]
    {
        const out: Line[] = [];

        for (const n of nodes)
        {
            if (n.k === null || n.k === '')
                continue;

            const l = this.trigger(n, ctx, false);

            if (l)
                out.push(l);
        }

        return out;
    }

    private group(text: Rich | string, children: Line[], extra: Partial<Line> = {}): Line
    {
        return { text: typeof text === 'string' ? [text] : text, children, ...extra };
    }

    trigger(n: PNode, ctx: Ctx, neg: boolean): Line | null
    {
        const l = this.triggerLine(n, ctx, neg);

        if (l)
            markRefusedPrev(n, l);

        if (l && ctx.file)
        {
            // a line of an inner statement (NOT / AND / OR around a single condition) stands for the whole statement; its
            // block is not what the line shows, so nothing is added inside
            const collapsed = l.src !== undefined;
            l.src = this.anchor(n, ctx, 'trigger', !collapsed && Array.isArray(n.v) && this.holdsTriggers(n.k!));

            // (a trigger_if: "＋ if" into its limit)
            if (n.k === 'trigger_if' || n.k === 'trigger_else_if')
                l.limitSrc = this.limitOf(n, ctx);
        }

        return l;
    }

    /** Blocks whose statements are conditions of their own (statements can be added inside). */
    private holdsTriggers(k: string): boolean
    {
        return TRIGGER_BLOCKS.has(k) || k.startsWith('any_') || this.isScopeKey(k);
    }

    private triggerLine(n: PNode, ctx: Ctx, neg: boolean): Line | null
    {
        const k = n.k!;
        const block = Array.isArray(n.v) ? n.v : null;
        const v = typeof n.v === 'string' ? this.constOf(n.v, ctx) : '';
        const tip = this.tip(n, ctx);

        // `key != value`: the negation of `key = value` (the phrases read `=`; scope comparisons read `!=` themselves)
        if (n.op === '!=' && !block && !/^\w+:/.test(k) && k !== 'this' && k !== 'root' && k !== 'prev')
            return this.triggerLine({ ...n, op: '=' }, ctx, !neg);

        if (k === 'NOT' && block)
        {
            const kids = this.triggers(block, ctx);

            if (kids.length === 1 && block.filter((c) => c.k).length === 1)
                return this.trigger(block.find((c) => c.k)!, ctx, !neg);

            return this.group(neg ? tr('All of the following:') : tr('None of the following:'), kids, { tip });
        }

        if (LOGIC_LABELS[k] && block)
        {
            const kids = this.triggers(block, ctx);

            if (kids.length === 1 && (k === 'AND' || k === 'OR') && !neg)
                return kids[0];

            let label = LOGIC_LABELS[k];

            if (neg)
                label = k === 'AND' ? LOGIC_LABELS.NAND : k === 'OR' ? LOGIC_LABELS.NOR : k === 'NOR' ? LOGIC_LABELS.OR : LOGIC_LABELS.AND;

            return this.group(label, kids, { tip });
        }

        if ((k === 'trigger_if' || k === 'trigger_else_if' || k === 'trigger_else') && block)
        {
            const limit = block.find((c) => c.k === 'limit');
            const rest = block.filter((c) => c.k !== 'limit');
            const conds = limit && Array.isArray(limit.v) ? this.triggers(limit.v, ctx) : [];
            const kids = this.triggers(rest, ctx);

            // (an empty trigger_else / trigger_if = { # nothing here }: no condition)
            if (!kids.length && !ctx.file?.mod)
                return null;

            return this.ifLine(k === 'trigger_else' ? 'else' : k === 'trigger_else_if' ? 'elseif' : 'if', conds, kids, tip, ctx);
        }

        if (k === 'calc_true_if' && block)
        {
            const amount = block.find((c) => c.k === 'amount');
            const kids = this.triggers(
                block.filter((c) => c.k !== 'amount'),
                ctx
            );
            return this.group(tr('{value} {value2} of the following:', { value: neg ? 'Fewer than' : 'At least', value2: typeof amount?.v === 'string' ? amount.v : '?' }), kids, { tip });
        }

        if (TRIGGER_SKIP.has(k))
            return null;

        if (k === 'always')
            return { text: [(v === 'yes') !== neg ? tr('Always') : tr('Never')], tip };

        if (k === 'continue' && block)
            return this.continueLine(block, ctx, tip);

        if ((k === 'custom_description' || k === 'custom_description_no_bullet' || k === 'custom_tooltip') && block)
        {
            const textNode = block.find((c) => c.k === 'text');
            const key = typeof textNode?.v === 'string' ? textNode.v : '';
            // (its text: a trigger_localization entry's, else the loc key's; ✎ text changes that one: locKey)
            const tl = this.triggerLoc(key, neg);
            const own = tl ? undefined : this.loc(key);
            const said = tl?.text ?? own ?? [humanize(key)];
            const body = block.filter((c) => !['text', 'subject', 'object', 'value'].includes(c.k ?? ''));
            const locKey = tl?.key ?? (own || k === 'custom_tooltip' ? key : undefined);
            // (a text that tells the failing case, "You are Family, and Target is too young …" in a NOT, or a
            // `first_not`-only text over `NOT = { … }`: drawn as an if, inverted: "Not if: <text>" with the
            // conditions that make it so in its condition box (a scripted trigger among them folds on its own), not the
            // text alone as if it were the requirement)
            const inverted = tl ? tl.inverted : neg;
            const failing = !inverted ? undefined : neg ? body : body.length === 1 && body[0].k === 'NOT' && Array.isArray(body[0].v) ? body[0].v : undefined;

            if (failing)
                return { text: rich(tr('Not if: '), said), icon: 'if', conditions: this.triggers(failing, ctx), tip, ...(locKey ? { locKey } : {}) };

            const inner = this.triggers(body, ctx);
            return { text: inverted ? rich(tr('Not: '), said) : said, tip, children: inner, collapsed: true, ...(locKey ? { locKey } : {}) };
        }

        if (k === 'custom_tooltip' && v)
            return { text: this.loc(v) ?? [humanize(v)], tip, locKey: v };

        // iterators: any_vassal = { count = 2 ... }
        const any = /^any_(\w+)$/.exec(k);

        if (any && block)
        {
            const count = block.find((c) => c.k === 'count');
            const percent = block.find((c) => c.k === 'percent');
            const what = this.iterLabel(any[1]);
            const typeNode = block.find((c) => c.k === 'type' && typeof c.v === 'string');
            const kids = this.triggers(
                block.filter((c) => !ITERATOR_PARAMS.has(c.k ?? '') && c.k !== 'count' && c.k !== 'percent'),
                { ...ctx, scope: itemScope(what), scopeType: iteratedScope(any[1]), prevTypes: pushPrev(ctx) }
            );
            let head = '';
            let named: Rich | undefined;
            let many = false;

            if (count && typeof count.v === 'string')
            {
                // (a count by a constant script value: its number)
                const cv = this.constOf(count.v, ctx);
                const cn = this.evalValue(cv);
                ({ head, many } = countHead(count.op ?? '=', cn !== undefined ? String(cn) : cv, what, neg));
            }
            else if (percent && typeof percent.v === 'string')
            {
                many = true;
                const op = neg ? negateOp(percent.op ?? '>=') : (percent.op ?? '>=');
                const lead = COUNT_WORDS[op] ?? tr('At least');
                // (`percent >= some_script_value`: a named value, not a number to scale)
                const share = this.evalValue(this.constOf(percent.v, ctx));

                if (share !== undefined)
                    head = `${lead} ${formatNumber(Math.round(share * 1e6) / 1e4)}% of ${plural(what)}`;
                else
                    named = rich(lead, ' ', this.valueSeg(percent.v, ctx), tr(' of {what}', { what: plural(what) }));
            }
            // (this entry or its relatives: "This title or one above it where:", "Not this title nor one above it")
            else if (/^this /.test(what))
                head = neg ? tr('Not {what}', { what: what.replace(/ or /, ' nor ') }) : capitalize(what);
            else
                head = neg ? `No ${what}` : `Any ${what}`;

            const headRich = rich(named ?? head, typeNode ? rich(' (', this.ref(typeNode.v as string), ')') : '', this.listKeys(any[1], block, ctx), kids.length ? tr(' where:') : many ? tr(' exist') : tr(' exists'));
            return this.group(headRich, kids, { icon: 'loop', tip });
        }

        // scope switch
        if (block && this.isScopeKey(k))
        {
            const sctx = this.switchCtx(k, block, ctx);
            let kids = this.triggers(block, sctx);

            // (a scope that only saves scopes says nothing: no heading without lines, as in the effects; a mod's file shows it, being written;
            // written `?=` it still tests that the scope exists: `capital_province ?= { save_temporary_scope_as = home }`
            // in an OR reads "Capital province exists", the OR no empty heading)
            if (!kids.length && !ctx.file?.mod)
                return n.op === '?=' ? { text: rich(this.scopeSeg(k, ctx, true), neg ? tr(' does not exist') : tr(' exists')), icon: 'scope', tip } : null;

            // NOT = { liege = { … } }: one condition is negated in place, several become "Not all of the following"
            if (neg)
            {
                const keyed = block.filter((c) => c.k);
                const one = keyed.length === 1 ? this.trigger(keyed[0], sctx, true) : null;
                kids = one ? [one] : [this.group(LOGIC_LABELS.NAND, kids)];
            }

            return this.group([this.scopeSeg(k, ctx, true), ':'], kids, { icon: 'scope', tip });
        }

        // switch = { trigger = has_court_position court_physician_court_position = { … } … fallback = { … } }: one case's
        // conditions, by what the trigger says
        if (k === 'switch' && block)
        {
            const on = block.find((c) => c.k === 'trigger');
            const key = typeof on?.v === 'string' ? on.v : '?';
            const cases = block
                .filter((c) => c.k && c.k !== 'trigger' && Array.isArray(c.v))
                .map((c): Line =>
                {
                    // (`trigger = yes`: each case is a scope that holds or not, "If Doctrine Bastardry All:", as the
                    // effects' switch reads it)
                    const cond = c.k === 'fallback' || key === 'yes' || key === '?' ? null : this.trigger({ ...c, k: key, v: c.k!, op: '=' }, ctx, false);
                    const label = cond ? rich(tr('If '), lowerFirst(cond.text), ':') : c.k === 'fallback' ? [tr('Otherwise:')] : [tr('If {scopeLabel}:', { scopeLabel: this.scopeLabel(c.k!) })];
                    const l: Line = { text: label, icon: 'if', children: this.triggers(c.v as PNode[], ctx) };

                    if (ctx.file)
                        l.src = this.anchor(c, ctx, 'trigger', true);

                    return l;
                });
            // (what it switches on, without the scope's own noun again: a great project's `great_project_type` "great
            // project type", not "Depending on great project great project type")
            const what = switchOn(key);
            return this.group(neg ? tr('Not, depending on {humanize}:', { humanize: what }) : tr('Depending on {humanize}:', { humanize: what }), cases, { tip });
        }

        // scripted trigger
        const st = this.idx.get('scripted_triggers', k);

        if (st)
        {
            const negate = neg !== (v === 'no');
            return this.scriptedTrigger(st, n, block, negate, ctx, tip);
        }

        // comparisons with a scope on the left: scope:a = scope:b, this = root, a chain: house.house_head = root
        // (not "House house head: you")
        if (!block && (/^\w+:/.test(k) || k === 'this' || k === 'root' || k === 'prev' || this.isLinkChain(k, n.op ?? undefined, v)) && !NUMERIC.test(v))
        {
            const op = n.op ?? '=';
            // (`this = rite:roman_rite`: the scope is the named entry: its kind said, not a subject that may be wrong: "Is the rite Roman Rite")
            const kind = k === 'this' && !/^[<>]/.test(op) ? /^(rite|faith|culture|religion|tenet):[\w-]+$/.exec(v)?.[1] : undefined;

            if (kind)
            {
                const is = { rite: [tr('Is the rite '), tr('Is not the rite ')], faith: [tr('Is the faith '), tr('Is not the faith ')], culture: [tr('Is the culture '), tr('Is not the culture ')], religion: [tr('Is the religion '), tr('Is not the religion ')], tenet: [tr('Is the tenet '), tr('Is not the tenet ')] }[kind]!;
                return { text: rich(is[(op === '!=') !== neg ? 1 : 0], this.valueSeg(v, ctx)), tip };
            }

            // (`this = scope:child`: a check like the others, its subject filled in where it is read ("you are Mother",
            // "a child that is neither Child nor …"), not "you is Mother")
            if (k === 'this' && !/^[<>]/.test(op))
                return { text: rich((op === '!=') !== neg ? tr('Is not ') : tr('Is '), this.valueSeg(v, ctx)), tip };

            // (`root = scope:mother` with root the player: "you are Mother", not "you is Mother")
            // (a lone link is the scope's own: "[the contributor’s top liege]", not an entry named like it)
            const left = /^[a-z_]+$/.test(k) && !/^(this|root|prev)$/.test(k) ? this.scopeSeg(k, ctx) : this.valueSeg(k, ctx);
            const you = /^you$/i.test(typeof left === 'string' ? left : left.text);
            const word = /^[<>]/.test(op) ? ` ${neg ? negateCompare(op) : COMPARE_WORDS[op]} ` : (op === '!=') !== neg ? (you ? tr(' are not ') : tr(' is not ')) : you ? tr(' are ') : ' is ';
            return { text: rich(left, word, this.valueSeg(v, ctx)), tip };
        }

        const phrase = this.triggerPhrase(k, n, block, v, ctx, neg);

        if (phrase)
            return { tip, ...phrase };

        // numeric / script-value comparison: age >= 16, my_value > 3; on another's value through a chain,
        // `scheme_owner.intrigue >= 15`: "your scheme owner’s intrigue is at least 15" (not "your scheme owner intrigue")
        const dot = k.lastIndexOf('.');
        const left = (): RichSeg => (dot > 0 && !k.includes('|') && this.isScopeKey(k.slice(0, dot)) ? this.valueSeg(k, ctx) : this.compareLabel(k));

        if (!block && n.op && n.op !== '=' && n.op !== '?=')
        {
            return { text: rich(left(), ' ', neg ? negateCompare(n.op) : COMPARE_WORDS[n.op] ?? n.op, ' ', this.valueSeg(v, ctx)), tip };
        }

        if (!block && (NUMERIC.test(v) || this.idx.get('script_values', k)))
        {
            return { text: rich(left(), neg ? tr(' is not ') : tr(' is '), this.valueSeg(v, ctx)), tip };
        }

        // generic: has_x = y / is_x = yes
        if (!block)
            return { text: this.genericPredicate(k, v, ctx, neg), tip };

        // unknown block trigger: show key + a summary of its fields
        return { text: rich(neg ? tr('Not: ') : '', capitalize(humanize(k)), this.fieldSummary(block, ctx, k)), tip };
    }

    /** The game rule an option belongs to (`on_custom_duchies` → `custom_duchies`'s block), from the rules' definitions. */
    private gameRuleOf(option: string): string | undefined
    {
        if (!this.ruleOfOption)
        {
            this.ruleOfOption = new Map();

            for (const rule of this.idx.names('game_rules'))
            {
                const e = this.idx.get('game_rules', rule);
                const d = e && this.idx.defNode(e);

                for (const c of d && Array.isArray(d.node.v) ? d.node.v : [])
                    if (c.k && Array.isArray(c.v))
                        this.ruleOfOption.set(c.k, rule);
            }
        }

        return this.ruleOfOption.get(option);
    }

    private ruleOfOption?: Map<string, string>;

    private negSwap(neg: boolean, yes: string, no: string): string
    {
        return neg ? no : yes;
    }

    private triggerPhrase(k: string, n: PNode, block: PNode[] | null, v: string, ctx: Ctx, negIn: boolean): LinePart | null
    {
        const isNo = v === 'no';
        const neg = negIn !== isNo;
        const field = (key: string): string | undefined =>
        {
            // (the game reads a statement's own keys in any case: `TARGET = …` as `target = …`)
            const c = block?.find((x) => x.k?.toLowerCase() === key);
            return typeof c?.v === 'string' ? this.constOf(c.v, ctx) : undefined;
        };

        switch (k)
        {
            case 'has_trait':
                return { text: rich(this.negSwap(neg, tr('Has the trait '), tr('Does not have the trait ')), this.traitSeg(v)), icon: 'trait' };
            case 'has_inactive_trait':
                // (only the traits that are switched off count here, not the ones that work)
                return { text: rich(this.negSwap(neg, tr('Has the trait '), tr('Does not have the trait ')), this.traitSeg(v), tr(' among their inactive traits')), icon: 'trait' };
            case 'has_character_flag':
            case 'has_dynasty_flag':
            case 'has_house_flag':
            case 'has_title_flag':
            case 'has_county_flag':
            case 'has_global_flag':
                return { text: rich(this.negSwap(neg, tr('Has been marked '), tr('Has not been marked ')), this.codeSeg(v, 'flag', 'Flag')), icon: 'flag' };
            case 'has_variable':
            case 'has_global_variable':
            case 'has_local_variable':
            case 'has_variable_list':
                // (the block form lists names: `has_variable = { name = a name = b }`)
                if (block)
                {
                    const names = block.filter((x) => x.k === 'name' && typeof x.v === 'string').map((x) => this.codeSeg(x.v as string, 'variable', 'Variable'));

                    if (names.length)
                        return { text: rich(neg ? tr('Has none of the variables ') : tr('Has one of the variables '), ...names.flatMap((x, i): Rich => [i ? ', ' : '', x])), icon: 'var' };
                }

                return { text: rich(tr('Variable '), this.codeSeg(v, 'variable', 'Variable'), neg ? tr(' is not set') : tr(' is set')), icon: 'var' };
            // (variables by name: "Has none of the variables “realm priest”, “was bookmaker”", not "(name: …, name: …)")
            case 'has_none_of_variables':
            case 'has_any_of_variables':
            case 'has_all_of_variables':
            {
                const names = (block ?? []).filter((x) => x.k === 'name' && typeof x.v === 'string').map((x) => this.codeSeg(x.v as string, 'variable', 'Variable'));

                if (!names.length)
                    break;

                const none = (k === 'has_none_of_variables') !== neg;
                const head = k === 'has_all_of_variables' ? (neg ? tr('Lacks one of the variables ') : tr('Has all of the variables ')) : none ? tr('Has none of the variables ') : tr('Has one of the variables ');
                return { text: rich(head, ...names.flatMap((x, i): Rich => [i ? ', ' : '', x])), icon: 'var' };
            }
            // (an activity's guest group: "Is in the guest group “qualified”")
            case 'is_in_guest_subset':
            {
                const name = block?.find((x) => x.k === 'name' && typeof x.v === 'string');

                if (!name)
                    break;

                return { text: rich(neg ? tr('Is not in the guest group ') : tr('Is in the guest group '), { text: `“${humanize(name.v as string)}”`, kind: 'value', tip: name.v as string }) };
            }
            case 'exists':
                if (v.startsWith('var:') || v.startsWith('global_var:') || v.startsWith('local_var:'))
                    return { text: rich(tr('Variable '), this.codeSeg(v.slice(v.indexOf(':') + 1), 'variable', 'Variable'), neg ? tr(' is not set') : tr(' is set')), icon: 'var' };

                // (`exists = yes`: the scope the heading names; `no` is read as the negation already)
                if (v === 'yes' || v === 'no')
                    return { text: [neg ? tr('Does not exist') : tr('Exists')] };

                return { text: rich(this.scopeSeg(v, ctx), neg ? tr(' does not exist') : tr(' exists')) };
            case 'is_ai':
                return { text: [neg ? tr('Is the player') : tr('Is an AI character')] };
            // (a domicile's building: "your domicile has the building ‹X›", not "has domicile building: X")
            case 'has_domicile_building':
            case 'has_domicile_building_or_greater':
            case 'has_domicile_building_or_higher':
            case 'has_building':
            case 'has_building_or_higher':
                return { text: rich(neg ? tr('Does not have the building ') : tr('Has the building '), this.ref(v, k.includes('domicile') ? ['domiciles/buildings'] : ['buildings']), /_or_(greater|higher)$/.test(k) ? tr(' or a higher one') : '') };
            // (the activity's own phase: "the current phase is running", not "you are current phase active")
            case 'is_current_phase_active':
                return { text: [neg ? tr('The current phase is not running') : tr('The current phase is running')] };
            case 'is_alive':
                return { text: [neg ? tr('Is dead') : tr('Is alive')] };
            case 'is_adult':
                return { text: [neg ? tr('Is a child') : tr('Is an adult')] };
            case 'is_female':
                return { text: [neg ? tr('Is male') : tr('Is female')] };
            case 'is_male':
                return { text: [neg ? tr('Is female') : tr('Is male')] };
            case 'faith':
            case 'culture':
            case 'religion':
                return { text: rich(capitalize(k), neg ? tr(' is not ') : tr(' is '), this.valueSeg(v, ctx)) };
            case 'has_character_modifier':
            case 'has_county_modifier':
            case 'has_province_modifier':
            case 'has_dynasty_modifier':
            case 'has_house_modifier':
                return { text: rich(neg ? tr('Is not affected by ') : tr('Is affected by '), this.ref(v, ['modifiers'])), icon: 'modifier' };
            case 'has_realm_law':
                return { text: rich(neg ? tr('Does not have the law ') : tr('Has the law '), this.ref(v, ['laws'])) };
            case 'has_title':
                return { text: rich(neg ? tr('Does not hold ') : tr('Holds '), this.valueSeg(v, ctx)) };
            case 'government_has_flag':
            {
                // (the flags read government_is_<kind>, government_has_<what>, government_uses_<what> …; the rest (cannot_be_vassal_or_liege, may_appoint_viziers) are named as they are)
                const form = /^government_(is|has|uses|can|enables)_(.+)$/.exec(v);
                const word = form
                    ? { is: [tr('Government is '), tr('Government is not ')], has: [tr('Government has '), tr('Government does not have ')], uses: [tr('Government uses '), tr('Government does not use ')], can: [tr('Government can '), tr('Government cannot ')], enables: [tr('Government enables '), tr('Government does not enable ')] }[form[1]]!
                    : [tr('Government has the flag '), tr('Government lacks the flag ')];
                return { text: rich(word[neg ? 1 : 0], { text: humanize(form ? form[2] : v), kind: 'value', tip: v }) };
            }
            case 'has_government':
                return { text: rich(neg ? tr('Government is not ') : tr('Government is '), this.ref(v, ['governments'])) };
            case 'has_doctrine':
                return { text: rich(neg ? tr('Faith lacks the doctrine ') : tr('Faith has the doctrine '), this.doctrineSeg(v)) };
            case 'has_cultural_pillar':
            case 'has_cultural_tradition':
                return { text: rich(neg ? tr('Culture does not have ') : tr('Culture has '), this.ref(v)) };
            case 'has_dlc_feature':
                return { text: rich(neg ? tr('Requires the DLC feature ') : tr('Needs the DLC feature '), { text: titleCase(humanize(v)), kind: 'value', tip: v }, neg ? tr(' to be missing') : '') };
            case 'has_game_rule':
            {
                // (the option's name alone ("On") says nothing without its rule's: "Game rule ‹Custom Duchies› is ‹On›")
                const rule = this.gameRuleOf(v);
                return rule
                    ? { text: rich(tr('Game rule '), this.ref(rule, ['game_rules']), neg ? tr(' is not ') : tr(' is '), this.ref(v, ['game_rule_options'])) }
                    : { text: rich(neg ? tr('Game rule is not ') : tr('Game rule is '), this.ref(v, ['game_rule_options'])) };
            }
            case 'geographical_region':
                return { text: rich(neg ? tr('Is not in ') : tr('Is in '), { text: titleCase(humanize(v.replace(/^(world|custom|ghw_region|special)_/, ''))), kind: 'value', tip: v }) };
            case 'terrain':
                return { text: rich(neg ? tr('Terrain is not ') : tr('Terrain is '), this.ref(v, ['terrain_types'])) };
            case 'has_perk':
                return { text: rich(neg ? tr('Does not have the perk ') : tr('Has the perk '), this.ref(v, ['lifestyle_perks'])) };
            case 'has_focus':
                return { text: rich(neg ? tr('Does not have the focus ') : tr('Has the focus '), this.ref(v, ['focuses'])) };
            case 'has_court_position':
                return { text: rich(neg ? tr('Is not the ') : tr('Is the '), this.ref(v, ['court_positions/types'])) };
            case 'employs_court_position':
                return { text: rich(neg ? tr('Does not employ a ') : tr('Employs a '), this.ref(v, ['court_positions/types'])) };
            case 'is_in_list':
                return { text: rich(neg ? tr('Is not in the list ') : tr('Is in the list '), this.codeSeg(v)) };
            case 'is_target_in_variable_list':
            case 'is_target_in_global_variable_list':
                return {
                    // (no `target` written, as in vanilla's spread_chance_epidemics_default_value: the script docs
                    // name none for that case, so the line says so instead of a "?")
                    text: rich(
                        field('target') ? this.valueSeg(field('target')!, ctx) : { text: tr('(no target written)'), kind: 'bad' },
                        neg ? tr(' is not in list ') : tr(' is in list '),
                        this.codeSeg(field('name') ?? '?', 'variable', 'Variable')
                    ),
                    hidden: true
                };
            case 'opinion':
            case 'reverse_opinion':
            {
                const target = field('target') ?? '?';
                const valNode = block?.find((x) => x.k === 'value');
                // (`value = { -15 0 }`: two bare numbers are an inclusive range, not a script value)
                const span = this.rangeOf(valNode, ctx);
                // (`value >= { value = 0 if = { … } }`: a script value written out, its working as the line's children)
                const worked = !span && valNode && Array.isArray(valNode.v) ? valNode : undefined;
                const op = valNode ? (negIn ? negateCompare(valNode.op ?? '=') : COMPARE_WORDS[valNode.op ?? '='] ?? valNode.op) : '';
                const cmp = !valNode ? '' : span ? this.rangeText(span, negIn) : worked ? tr('{op} a value worked out as:', { op }) : `${op} ${this.valueText(String(valNode.v), ctx)}`;
                return {
                    text: k === 'opinion'
                        ? rich(tr('Opinion of '), this.scopeSeg(target, ctx), ' ', cmp)
                        : rich(this.scopeSeg(target, ctx), tr('’s opinion of '), scopeName(ctx) === 'you' ? 'you' : scopeName(ctx), ' ', cmp),
                    icon: 'opinion',
                    ...(worked && this.valueReader ? { children: this.valueReader(worked.v as PNode[], ctx) } : {})
                };
            }
            case 'has_opinion_modifier':
            case 'reverse_has_opinion_modifier':
            {
                // (an optional `value >= 20` or `value = { MIN MAX }`: the modifier's current value is checked too)
                const valNode = block?.find((x) => x.k === 'value');
                const span = this.rangeOf(valNode, ctx);
                const amount = !valNode ? '' : span ? this.rangeText(span, false) : `${COMPARE_WORDS[valNode.op ?? '='] ?? valNode.op} ${Array.isArray(valNode.v) ? tr('a worked-out value') : this.valueText(String(valNode.v), ctx)}`;
                return {
                    text: rich(
                        neg ? tr('Does not have the opinion ') : tr('Has the opinion '),
                        this.ref(field('modifier') ?? '?', ['opinion_modifiers']),
                        k === 'has_opinion_modifier' ? tr(' towards ') : tr(' from '),
                        this.scopeSeg(field('target') ?? '?', ctx),
                        amount ? tr(' (its value {amount})', { amount }) : ''
                    ),
                    icon: 'opinion'
                };
            }
            case 'has_trait_xp':
            {
                const valNode = block?.find((x) => x.k === 'value');
                return {
                    text: rich(
                        this.traitSeg(field('trait') ?? '?'),
                        field('track') ? ` (${humanize(field('track')!)})` : '',
                        tr(' experience '),
                        valNode ? `${COMPARE_WORDS[valNode.op ?? '='] ?? valNode.op} ${this.valueText(String(valNode.v), ctx)}` : ''
                    ),
                    icon: 'trait'
                };
            }
            case 'is_at_war':
                return { text: [neg ? tr('Is at peace') : tr('Is at war')] };
            case 'has_activity_type':
            {
                const seg = this.ref(v, ['activities/activity_types']);
                return { text: rich(neg ? tr('Is not ') : tr('Is '), /^[aeiou]/i.test(typeof seg === 'string' ? seg : seg.text) ? tr('an ') : 'a ', seg) };
            }
            case 'is_available_quick':
            {
                // (the options as the game's docs name them: ai, alive, female, adult, incapable, imprisoned, hostage,
                // travel, activity, ruler, advanced_ruler, landed, in_army, at_war)
                const words: Record<string, [string, string]> = {
                    ai: [tr('an AI character'), tr('a player')],
                    alive: ['alive', 'dead'],
                    female: [tr('female'), tr('male')],
                    adult: [tr('an adult'), tr('a child')],
                    at_war: [tr('at war'), tr('not at war')],
                    imprisoned: ['imprisoned', tr('not imprisoned')],
                    activity: [tr('in an activity'), tr('not in an activity')],
                    hostage: [tr('a hostage'), tr('not a hostage')],
                    travel: ['travelling', tr('not travelling')],
                    incapable: ['incapable', tr('not incapable')],
                    ruler: [tr('a ruler'), tr('not a ruler')],
                    advanced_ruler: [tr('an advanced ruler'), tr('not an advanced ruler')],
                    landed: [tr('landed'), tr('not landed')],
                    in_army: [tr('in an army'), tr('not in an army')]
                };
                const parts = (block ?? [])
                    .filter((x) => x.k && typeof x.v === 'string')
                    .map((x) => (words[x.k!] ? words[x.k!][x.v === 'yes' ? 0 : 1] : `${x.v === 'yes' ? '' : 'not '}${humanize(x.k!)}`));
                return { text: [(neg ? tr('Is not available') : tr('Is available')) + (parts.length ? ` (${parts.join(', ')})` : '')] };
            }
            case 'trait_is_virtue':
            case 'trait_is_sin':
                return { text: rich(this.traitSeg(v), neg ? tr(' is not a ') : tr(' is a '), k === 'trait_is_virtue' ? 'virtue' : 'sin', tr(' of their faith')), icon: 'trait' };
        }

        // (`has_relation_to = <character>`, a trigger of its own (script_docs: "does the character have a relation to the
        // target?"), not the scripted relation "to")
        if (k === 'has_relation_to' && v)
            return { text: rich(neg ? tr('Has no relation to ') : tr('Has a relation to '), this.scopeSeg(v, ctx)), icon: 'opinion' };

        const rel = /^has_relation_(\w+)$/.exec(k);

        // (`has_relation_guardian = scope:actor`: the target is the scope's guardian, as vanilla's "You're my guardian")
        if (rel && v)
            return { text: rich(neg ? tr('Does not have ') : tr('Has '), this.scopeSeg(v, ctx), this.relationAs(rel[1])), icon: 'opinion' };

        const of = /^is_(\w+)_of$/.exec(k);

        if (of && v && !['yes', 'no'].includes(v))
            return { text: rich(neg ? tr('Is not ') : tr('Is '), humanize(of[1]), tr(' of '), this.scopeSeg(v, ctx)) };

        return null;
    }

    ifLine(kind: 'if' | 'elseif' | 'else', conds: Line[], children: Line[], tip: string | undefined, ctx: Ctx): Line
    {
        if (kind === 'else')
            return { text: [tr('Otherwise:')], icon: 'else', children, tip };

        const prefix = kind === 'if' ? 'If ' : tr('Otherwise, if ');

        // (the one condition in the line's text, its segments kept apart: the view edits it on its own; Line.condSegs)
        // (also a scripted trigger read through, collapsed: its name says what it checks)
        // (with its subject, the scope it is about: "If you are an adult:", "If the vassal has the trait Brave:", not
        // "If is an adult:"; a collapsed trigger reads as its name)
        if (conds.length === 1 && (!conds[0].children?.length || conds[0].collapsed) && !conds[0].conditions && !richToString(conds[0].text).endsWith(':'))
        {
            const who = ctx.subject?.of === ctx.scope ? ctx.subject.text : ctx.scope;
            const clause = conds[0].collapsed ? [] : this.conditionClause(conds, /^you$/i.test(who) ? 'you' : who);
            // (a scripted trigger's name mid-sentence in lower case: "If ‹should synchronize liege law›:")
            const head = conds[0].text[0];
            const named = typeof head !== 'string' && head?.kind === 'entity' && head.ref?.type === 'scripted_triggers' ? [{ ...head, text: head.text.charAt(0).toLowerCase() + head.text.slice(1) }, ...conds[0].text.slice(1)] : undefined;
            const cond = clause.length ? clause : named ?? lowerFirst(conds[0].text);
            return { text: [prefix, ...cond, ':'], condSegs: [1, 1 + cond.length], icon: 'if', ifConds: conds, children, tip };
        }

        // (one AND / OR / NOR / NAND around all of them: "If any of these are true:" with its conditions, not a group in a group)
        const only = conds.length === 1 && conds[0].children?.length && !conds[0].collapsed && conds[0].text.length === 1 ? IF_GROUP[String(conds[0].text[0])] : undefined;

        if (only)
            return { text: [prefix + only], icon: 'if', conditions: conds[0].children, ifConds: conds, children, tip };

        return { text: [prefix + tr('all of these are true:')], icon: 'if', conditions: conds, ifConds: conds, children, tip };
    }

    /**
     * Condition lines → one clause for an "If …" label, with subjects filled in: "you have the trait Vengeful",
     * "Lover has the trait Adulterer", "your opinion of First Lover is more than 20", "you are Parent of Child".
     * Scope groups lend their scope as subject, AND/OR/NOR groups become and/or lists, short scripted triggers are
     * read through, iterators become "any vassal that …".
     */
    conditionClause(lines: Line[], subject: RichSeg | null | 'plural' = 'you'): Rich
    {
        return joinList(
            simplifyTriggerIf(lines)
                .map((l) => this.lineClause(l, subject))
                .filter((p) => p.length),
            ' and '
        );
    }

    private lineClause(l: Line, subject: RichSeg | null | 'plural'): Rich
    {
        const kids = l.children ?? [];
        const first = l.text[0];
        const label = typeof first === 'string' ? first : '';

        // (a text that tells the failing case, "Not if: X is already your Lover", in a sentence: "not (X is already
        // your Lover)")
        const failing = tr('Not if: ');

        if (typeof first === 'string' && first.startsWith(failing))
            return rich(tr('not ('), first.slice(failing.length), l.text.slice(1), ')');

        // trigger_if inside a condition: only checked when its limit holds → "… (when you are travelling)"
        if (l.icon === 'if' || l.icon === 'else')
        {
            if (!kids.length)
                return [];

            const body = this.conditionClause(kids, subject);

            if (l.icon === 'else')
                return rich(body, tr(' (otherwise)'));

            const cond = l.ifConds?.length ? this.conditionClause(l.ifConds, subject) : lowerFirst(stripColon(l.text));
            return rich(body, label.startsWith(tr('Otherwise')) ? tr(' (otherwise, when ') : tr(' (when '), cond, ')');
        }

        if (kids.length)
        {
            // scope switch "‹Lover›:" → Lover is the subject of the inner conditions
            if (l.icon === 'scope' && typeof first !== 'string' && l.text.length === 2)
                return this.conditionClause(kids, /^you$/i.test(first.text) ? 'you' : first);

            const sub = (join: string): Rich =>
                joinList(
                    kids.map((k) => this.lineClause(k, subject)).filter((p) => p.length),
                    join
                );

            if (label === LOGIC_LABELS.AND)
                return sub(' and ');

            if (label === LOGIC_LABELS.OR)
                return kids.length === 2 ? rich(tr('either '), sub(' or ')) : sub(' or ');

            if (label === LOGIC_LABELS.NOR && kids.length === 2)
            {
                // (both an "is …" of the same subject: "is neither Child nor twin of Child", not "neither is … nor is …")
                const parts = kids.map((k) => this.lineClause(k, subject));
                const verbs = parts.map((p) => (typeof p[0] === 'string' ? /^(is|are) /.exec(p[0])?.[1] : undefined));

                if (verbs[0] && verbs[0] === verbs[1])
                {
                    const verb = verbs[0];
                    const rest = (p: Rich): Rich => rich((p[0] as string).slice(verb.length + 1), p.slice(1));
                    return rich(verb, tr(' neither '), rest(parts[0]), tr(' nor '), rest(parts[1]));
                }

                return rich(tr('neither '), sub(' nor '));
            }

            if (label === LOGIC_LABELS.NOR)
                return rich(tr('none of these: '), sub('; '));

            if (label === LOGIC_LABELS.NAND)
                return kids.length === 2 ? rich(tr('not both '), sub(' and ')) : rich(tr('not all of these: '), sub('; '));

            const atLeast = /^(At least|Fewer than) (\S+) of the following:$/.exec(label);

            if (atLeast)
                return rich(atLeast[1].toLowerCase(), ' ', atLeast[2], tr(' of these: '), sub('; '));

            if (l.icon === 'loop')
            {
                // "Any vassal where:" → "there is a vassal that has …", "Every child where:" → "every child is …",
                // "At least 3 knights where:" → "at least 3 knights that have …"
                const head = l.text.map((s) => (typeof s === 'string' ? s.replace(/ where:$/, '') : s));
                const q = typeof head[0] === 'string' ? /^(Any|No|Every|At least [^ ]+(?: of)?) ([\s\S]*)$/.exec(head[0]) : null;

                if (q)
                {
                    const rest = rich(q[2], head.slice(1));
                    const article = /^[aeiou]/i.test(q[2]) ? 'an ' : 'a ';

                    if (q[1] === 'Any')
                        return rich(tr('there is '), article, rest, tr(' that '), this.conditionClause(kids, null));

                    if (q[1] === 'No')
                        return rich(tr('there is no '), rest, tr(' that '), this.conditionClause(kids, null));

                    if (q[1] === 'Every')
                        return rich(tr('every '), rest, ' ', this.conditionClause(kids, null));

                    return rich(q[1].toLowerCase(), ' ', rest, tr(' that '), this.conditionClause(kids, 'plural'));
                }

                return rich(lowerFirst(head), tr(' that '), this.conditionClause(kids, null));
            }

            // scripted triggers: read their content when it is short
            if (l.collapsed && countLeaves(kids) <= 3)
            {
                const inner = this.conditionClause(kids, subject);
                return label.startsWith(tr('Not: ')) ? rich(tr('not ('), inner, ')') : inner;
            }
        }

        // a named (scripted) condition: "Lover meets ‹Lover 0001 breakup opinion›" (the link shows its content); not a
        // script value compared ("‹Sc defender injury check actual› is at most −50", not "you meet … is at most")
        if (typeof first !== 'string' && first.kind === 'entity' && first.ref?.type === 'scripted_triggers' && subject !== null)
        {
            return subject === 'you' ? rich(tr('you meet '), l.text) : subject === 'plural' ? rich(tr('meet '), l.text) : rich(subject, tr(' meets '), l.text);
        }

        if (typeof first === 'string' && first.startsWith(tr('Not: ')) && typeof l.text[1] !== 'string' && l.text[1]?.kind === 'entity' && subject !== null)
        {
            const rest = l.text.slice(1);
            return subject === 'you' ? rich(tr('you do not meet '), rest) : subject === 'plural' ? rich(tr('do not meet '), rest) : rich(subject, tr(' does not meet '), rest);
        }

        return withSubject(stripColon(l.text), subject);
    }

    /**
     * A scripted trigger's or effect's name as the head of its call, with the argument it is about when the name ends
     * on a word that needs one: `matching_gender_and_sexuality_with_trigger = { CHARACTER = scope:x }` "Matching gender
     * and sexuality with ‹the partner›", `save_court_physician_as_effect = { SCOPE_NAME = physician }` "… as “physician”"
     * (the argument passed to a scope parameter first, a name parameter's value quoted).
     */
    private callHead(e: Entity, block: PNode[] | null, ctx: Ctx, showArgs = false): Rich
    {
        const label = capitalize(humanize(e.name));
        const head: RichSeg = { text: label, kind: 'entity', ref: { type: e.type, name: e.name }, tip: e.name };
        const args = (block ?? []).filter((c) => c.k && /^[A-Z][A-Z0-9_]*$/.test(c.k) && typeof c.v === 'string');

        // (a call read by its name alone: its arguments after it, so calls with different ones differ: "Has witnessed
        // stress coping trait (trait: ‹Contrite›)")
        if (!CALL_ENDS_ON_WORD.test(label) && showArgs && args.length)
        {
            const parts = args.slice(0, 3).map((c): Rich => rich(humanize(c.k!.toLowerCase()), ': ', /NAME|FLAG|KEY/.test(c.k!) ? { text: `“${humanize(c.v as string)}”`, kind: 'value', tip: `${c.k} = ${c.v}` } : this.valueSeg(c.v as string, ctx)));
            return rich(head, ' (', ...parts.flatMap((p, i): Rich => (i ? [', ', ...p] : p)), args.length > 3 ? ', …)' : ')');
        }

        if (!CALL_ENDS_ON_WORD.test(label))
            return [head];

        // (called with `= yes`: nothing to name after the word, so the word goes: "Select pool to move to" reads "Select
        // pool to move", not a half sentence)
        if (!args.length)
            return [{ ...head, text: label.replace(CALL_ENDS_ON_WORD, '').trimEnd() }];

        const scopeLike = (v: string): boolean => /^(scope:|root\b|prev\b|this\b|[a-z_]+:[\w-]+$)/.test(v) || /^[a-z_]+(\.[a-z_]+)+$/.test(v);
        const main = args.find((c) => scopeLike(c.v as string)) ?? args[0];
        const v = main.v as string;
        const seg: RichSeg = /NAME|FLAG|KEY/.test(main.k!) && !scopeLike(v) ? { text: `“${humanize(v)}”`, kind: 'value', tip: `${main.k} = ${v}` } : this.valueSeg(v, ctx);
        return [head, ' ', seg];
    }

    private scriptedTrigger(e: Entity, call: PNode, block: PNode[] | null, neg: boolean, ctx: Ctx, tip: string): Line
    {
        const custom = this.triggerLoc(e.name, neg);

        // (a text that tells the failing case: "Not: <text>")
        if (custom)
            return { text: custom.inverted ? rich(tr('Not: '), custom.text) : custom.text, tip, locKey: custom.key };

        const head = this.callHead(e, block, ctx, true);

        this.meet(e, ctx);

        if (ctx.expand <= 0 || ctx.stack.includes(e.name))
            return { text: rich(neg ? tr('Not: ') : '', head), tip };

        const args = block ? argsOf(block) : undefined;
        const d = this.idx.defNode(e, args);
        const trace = ctx.trace ? this.newTrace(e, ctx) : undefined;
        // (another definition's text, $PARAM$ substituted: its lines are anchored to that definition; inlinedCtx)
        const inner = d && Array.isArray(d.node.v) ? this.triggers(d.node.v, { ...this.inlinedCtx(e, d.src, args, ctx, this.callPlace(e, ctx, call)), trace }) : [];

        if (trace)
            this.mergeTrace(ctx.trace, trace, ctx.stack);

        // one-line scripted triggers read better as their content ("Has bp1 dlc" → "Needs the DLC feature …")
        if (inner.length === 1 && !inner[0].children?.length && !inner[0].conditions)
        {
            return neg ? { ...inner[0], text: rich(tr('Not: '), inner[0].text), tip } : { ...inner[0], tip };
        }

        const group: Line = {
            text: rich(neg ? tr('Not: ') : '', head),
            children: inner,
            collapsed: true,
            group: { type: e.type, name: e.name },
            tip
        };
        return group;
    }

    /** Text from common/trigger_localization for a (scripted) trigger. */
    private triggerLocText(name: string, neg: boolean): Rich | undefined
    {
        const t = this.triggerLoc(name, neg);
        return t && (t.inverted ? rich(tr('Not: '), t.text) : t.text);
    }

    /** Text from common/trigger_localization for a (scripted) trigger, and the loc key it comes from. */
    /**
     * A (scripted) trigger's text from common/trigger_localization and its loc key. `inverted`: the text tells the case
     * that fails, not what must hold: a NOT around an entry with only the text for the case itself (`first`), or an
     * entry with only the failing case's text (`first_not`) used plainly; `text` is the text alone then.
     */
    private triggerLoc(name: string, neg: boolean): { text: Rich; key: string; inverted: boolean; } | undefined
    {
        const e = this.idx.get('trigger_localization', name);

        if (!e)
            return undefined;

        const d = this.idx.defNode(e);

        if (!d || !Array.isArray(d.node.v))
            return undefined;

        // (an entry may have only the text for when it fails (`first_not`): then the condition reads "Not: <that>")
        const keys = neg ? ['global_not', 'first_not', 'third_not', 'global', 'first', 'third'] : ['global', 'first', 'third', 'global_not', 'first_not', 'third_not'];

        for (const k of keys)
        {
            const c = d.node.v.find((x) => x.k === k);

            if (typeof c?.v === 'string')
            {
                const r = this.templateLoc(c.v);

                if (r)
                    return { text: r, key: c.v, inverted: neg !== k.endsWith('_not') };
            }
        }

        return undefined;
    }

    /**
     * The entry a statement's value names: `faith:old_consanguinism`, `title:k_england`, or a plain key where the
     * statement takes one (`set_character_faith = catholic`: CONTEXT_RULES).
     */
    private valueEntity(value: string, statement?: string): { types: string[]; seg: RichSeg; } | undefined
    {
        // (a saved scope, root, a chain (`faith:adoptionist.main_rite`, `title:e_hre.holder`): its label; its type from
        // the last link where it names one (main_rite: a rite, holder: a character), else any object of the template)
        // (also a chain of links from the current scope: `mother.house`)
        if (/^(scope:|root\b|prev\b|this\b|\$\w+\$)/.test(value) || /^\w+:[\w-]+\./.test(value) || (/^[a-z_]+(\.[a-z_]+)+$/.test(value) && this.isScopeKey(value.slice(0, value.indexOf('.')))))
        {
            const last = value.slice(value.lastIndexOf('.') + 1).toUpperCase();
            const obj = /\./.test(value) ? Object.keys(LOC_OBJECT_TYPES).find((o) => last === o || last.endsWith('_' + o)) : undefined;
            // (a bare $PARAM$ of a statement that takes one kind of entry stays of that kind)
            const ruled = /^\$\w+\$$/.test(value) && statement ? CONTEXT_RULES[statement] ?? EXTRA_CONTEXT_RULES[statement] : undefined;
            return { types: obj ? LOC_OBJECT_TYPES[obj] : /^(HOLDER|CHARACTER|LIEGE|HEIR)$/.test(last) ? ['characters'] : ruled ?? [], seg: this.valueSeg(value) };
        }

        const m = /^(\w+):([\w.-]+)$/.exec(value);

        // (the statement's own kind of entry: the context rules, else what the game's uses type it (VALUE_TYPES:
        // `make_trait_inactive = x` a trait, "Loses the trait Is Targaryen 35", not the template's "Trait")
        const types = m ? PREFIX_TYPES[m[1]] : statement ? CONTEXT_RULES[statement] ?? EXTRA_CONTEXT_RULES[statement] ?? (VALUE_TYPES.get(statement) as string[] | undefined) : undefined;

        if (!types)
            return undefined;

        // (an entry the index lacks, a mod's that is not loaded: its key made readable, not "Faith")
        return { types, seg: this.ref(m ? m[2] : value, types) };
    }

    /** Loc text with $VALUE$-style template parameters filled in (unknown ones removed). */
    templateLoc(key: string, value?: string, statement?: string): Rich | undefined
    {
        const r = this.templateParts(key, value, statement);
        return r && dropRepeats(r);
    }

    private templateParts(key: string, value?: string, statement?: string): Rich | undefined
    {
        const t = this.idx.plainLoc(key);

        if (t === undefined)
            return undefined;

        // (a catalyst's effects: the statement's value is the catalyst (its name), the progress it adds is the phase's)
        const catalyst = t.includes('$CATALYST_NAME$') && value !== undefined && !NUMERIC.test(value);
        // (a text without $VALUE$ whose placeholder the game fills from the statement's own value: `set_sexuality =
        // bisexual` "Realizes they are $SEXUALITY$", `set_title_name = k_vasconia` "Name is changed to $NAME$",
        // `begin_create_holding = church_holding` "Start construction of a $HOLDING_NAME$": the first such placeholder
        // is the value (the others, and any that names a text of its own, stay left out))
        // (`= yes` only switches the effect on: no value to show)
        const ownValue = !catalyst && !!value && value !== 'yes' && value !== 'no' && !NUMERIC.test(value) && !/\$VALUE(\|[^$]*)?\$/.test(t);
        let ownUsed = false;
        const filled = t.replace(/\$([A-Z_]+|OldBuildingName)(\|[^$]*)?\$/g, (_m, p: string, fmt: string | undefined) =>
        {
            if (ownValue && !ownUsed && p !== 'VALUE' && /^[A-Z][A-Z_]*$/.test(p) && this.idx.plainLoc(p) === undefined)
            {
                ownUsed = true;
                return OWN_VALUE;
            }

            if (catalyst)
            {
                const e = this.idx.named(value!)[0];
                return p === 'CATALYST_NAME' ? ((e && this.idx.displayName(e)) ?? humanize(value!)) : p === 'VALUE' ? tr('some') : DROPPED;
            }

            // (replace_building_effect_global: the building that stands there now, which the game's code fills in)
            if (p === 'OldBuildingName')
                return tr('the existing building');

            if (p !== 'VALUE' || value === undefined)
                return DROPPED;

            const n = this.evalValue(value);

            if (n === undefined)
                return humanize(value);

            return fmt && fmt.includes('+') ? signed(n) : formatNumber(n);
        });
        // (the template's object, [FAITH.GetName], is the entry the value names: its name, its icon codes dropped:
        // `set_character_faith = faith:old_consanguinism` "Converts to Consanguinism", not "Converts to Faith")
        const named = value !== undefined ? this.valueEntity(value, statement) : undefined;
        // (a placeholder left out takes one space with it: "Ends the $TYPE$ contract" reads "Ends the contract", "($X$
        // obligation)" "(obligation)"; spaces on both sides keep one)
        const tidy = filled.replace(/ ?\u0002 ?/g, (m) => (m.length === 3 ? ' ' : ''));
        const read = locToRich(tidy, this.lookupDisplay);
        // (the value: the entry it names, else a text key's text (`set_title_name = k_vasconia` "Vasconia"), else its words)
        const ownSeg = (): RichSeg =>
        {
            if (named)
                return named.seg;

            const s = this.valueSeg(value!);
            const text = typeof s !== 'string' && s.kind === 'value' ? this.idx.plainLoc(value!) : undefined;
            return text && text.length <= 60 && !/[$[\]]/.test(text) ? { text, kind: 'value', tip: value } : s;
        };
        const out = ownUsed ? rich(read.flatMap((s) => (typeof s === 'string' && s.includes(OWN_VALUE) ? s.split(OWN_VALUE).flatMap((x, i) => (i ? [ownSeg(), x] : [x])) : [s]))) : read;

        if (named)
        {
            let filledOne = false;
            const res = out.flatMap((x) =>
            {
                const code = typeof x !== 'string' && x.kind === 'ph' ? /^\[(\w+)\.(\w+)/.exec(x.tip ?? '') : null;
                const objTypes = code && LOC_OBJECT_TYPES[
                    code[1]
                        .toUpperCase()
                        .replace(/^(TARGET|NEW|OTHER|SECOND|SECONDARY)_/, '')
                        .replace(/_TYPE$/, '')
                ];

                if (!code || !objTypes || (named.types.length && !named.types.some((t) => objTypes.includes(t))))
                    return [x];

                filledOne = true;
                return /Icon/.test(code[2]) ? [] : [named.seg];
            });

            if (filledOne)
                return rich(res);
        }

        // ([TARGET_TITLE.GetName] reads "Target Title": the statement's value is that target: "on England")
        if (value === undefined || !/^\w+:[\w.-]+$|^(root|scope:[\w.]+)$/.test(value))
            return out;

        return out.flatMap((s) =>
        {
            if (typeof s !== 'string')
                return /^Target [A-Z][a-z]+$/i.test(s.text) ? [this.valueSeg(value)] : [s];

            if (!/\bTarget [A-Z][a-z]+\b/.test(s))
                return [s];

            const parts = s.split(/\bTarget [A-Z][a-z]+\b/);
            return parts.flatMap((p, i) => (i ? [this.valueSeg(value), p] : [p]));
        });
    }

    private effectLocText(name: string, value?: string): Rich | undefined
    {
        const e = this.idx.get('effect_localization', name);
        // (a negative number reads with the entry's _neg texts ("You lose 1 level of …") and the amount without its sign)
        const n = value !== undefined ? this.evalValue(value) : undefined;
        const neg = n !== undefined && n < 0;
        const shown = neg ? String(-n) : value;

        if (e)
        {
            const d = this.idx.defNode(e);

            if (d && Array.isArray(d.node.v))
            {
                for (const suffix of neg ? ['_neg', ''] : [''])
                {
                    for (const k of ['global', 'first', 'third'])
                    {
                        const c = d.node.v.find((x) => x.k === k + suffix);

                        if (typeof c?.v === 'string')
                        {
                            const r = this.templateLoc(c.v, suffix ? shown : value, name);

                            if (r)
                                return r;
                        }
                    }
                }
            }
        }

        return (neg ? this.templateLoc(name + '_global_neg', shown, name) : undefined) ?? this.templateLoc(name + '_global', value, name) ?? this.templateLoc(name + '_first', value, name);
    }

    private genericPredicate(k: string, v: string, ctx: Ctx, neg: boolean): Rich
    {
        const words = humanize(k);
        const yesNo = v === 'yes' || v === 'no';
        const n = neg !== (v === 'no');

        if (yesNo)
        {
            if (words.startsWith('is '))
                return [capitalize(n ? tr('is not ') + words.slice(3) : words)];

            if (words.startsWith('has '))
                return [capitalize(n ? tr('does not have ') + words.slice(4) : words)];

            if (words.startsWith('can '))
                return [capitalize(n ? 'cannot ' + words.slice(4) : words)];

            return [n ? 'Not: ' + words : capitalize(words)];
        }

        return rich(n ? tr('Not: ') : '', capitalize(words), ': ', this.guiSeg(k, v) ?? this.valueSeg(v, ctx));
    }

    private compareLabel(k: string): RichSeg
    {
        const sv = this.idx.get('script_values', k);

        if (sv)
            return { text: capitalize(humanize(k)), kind: 'entity', ref: { type: sv.type, name: sv.name }, tip: k };

        // ("Number of County Followers: $NUM|V0$": the value is what the statement compares it to, so the label stops before it)
        const loc = this.idx.plainLoc(k)?.replace(/[:\s]*\$[A-Za-z_]\w*(?:\|[^$\s]*)?\$/g, '').trim();
        return capitalize(loc && loc.length < 40 ? loc : humanize(k));
    }

    private valueText(v: string, ctx: Ctx): string
    {
        const s = this.valueSeg(v, ctx);
        return typeof s === 'string' ? s : s.text;
    }

    private fieldSummary(block: PNode[], ctx: Ctx, parent?: string): Rich
    {
        const parts: Rich = [];

        for (const c of block)
        {
            if (!c.k || typeof c.v !== 'string' || parts.length >= 6)
                continue;

            // (a comparison inside keeps its operator: `squared_distance = { target = x value < 200000 }` "value is less than
            // 200000", not "value: 200000")
            const op = c.op && c.op !== '=' && c.op !== '?=' ? COMPARE_WORDS[c.op] : undefined;
            parts.push(parts.length ? ', ' : ' (', humanize(c.k), op ? ` ${op} ` : ': ', this.guiSeg(c.k, c.v, parent) ?? this.valueSeg(c.v, ctx));
        }

        if (parts.length)
            parts.push(')');

        return rich(parts);
    }

    private traitSeg(v: string): RichSeg
    {
        const name = v.replace(/^trait:/, '');
        return this.ref(name, ['traits']);
    }

    private relationSeg(rel: string): RichSeg
    {
        const e = this.idx.get('scripted_relations', rel);
        return e ? this.entitySeg(e) : { text: humanize(rel), kind: 'value', tip: rel };
    }

    /**
     * " as a guardian" after the one a relation statement names: `has_relation_x = target` / `set_relation_x = target`
     * make the target the scope's x (the ward gets its guardian), so the sentence names the target first; read the
     * same way, a symmetric one ("Has Bob as a friend") stays natural.
     */
    private relationAs(rel: string): Rich
    {
        const seg = this.relationSeg(rel);
        const text = typeof seg === 'string' ? seg : seg.text;
        return rich(/^[aeiou]/i.test(text) ? tr(' as an ') : tr(' as a '), seg);
    }

    /** `value = { MIN MAX }` (opinion, has_opinion_modifier): two bare values, an inclusive range; else undefined. */
    private rangeOf(n: PNode | undefined, ctx: Ctx): [string, string] | undefined
    {
        if (!n || !Array.isArray(n.v) || n.v.length !== 2 || n.v.some((x) => x.k !== null || typeof x.v !== 'string'))
            return undefined;

        return [this.valueText(n.v[0].v as string, ctx), this.valueText(n.v[1].v as string, ctx)];
    }

    private rangeText(span: [string, string], neg: boolean): string
    {
        return neg ? tr('is not between {min} and {max}', { min: span[0], max: span[1] }) : tr('is between {min} and {max}', { min: span[0], max: span[1] });
    }

    /**
     * Which items an ordered_ iterator runs for, when not just the best one: `position = 2` (counted from 0, or `end`)
     * the one at that place, `max = 7` the top 7 (`min` the fewest it expects); undefined for the best one alone.
     */
    private orderedRank(block: PNode[], ctx: Ctx): { head: (what: string, by: string) => string; many: boolean; } | undefined
    {
        const node = (key: string): PNode | undefined => block.find((c) => c.k === key);
        const text = (n: PNode): string => (Array.isArray(n.v) ? tr('a worked-out number') : this.valueText(n.v, ctx));
        const position = node('position');

        if (position)
        {
            const at = typeof position.v === 'string' ? position.v : undefined;

            if (at === 'end')
                return { head: (what, by) => tr('For the last {what}', { what }) + by, many: false };

            const n = at !== undefined && /^\d+$/.test(at) ? Number(at) : undefined;

            if (n === 0)
                return undefined;

            return {
                head: (what, by) => (n !== undefined ? tr('For the {what} in place {n}', { what, n: n + 1 }) : tr('For the {what} at place {place} (counted from 0)', { what, place: text(position) })) + by,
                many: false
            };
        }

        const max = node('max');

        if (!max || max.v === '1')
            return undefined;

        const min = node('min');
        const fewest = min && typeof min.v === 'string' && min.v !== '0' ? tr(' (at least {min})', { min: text(min) }) : '';
        return {
            head: (what, by) => (/^\d+$/.test(String(max.v)) ? tr('For each of the top {n} {whats}', { n: max.v as string, whats: plural(what) }) : tr('For each of the top {whats}, as many as {max}', { whats: plural(what), max: text(max) })) + by + fewest,
            many: true
        };
    }

    private codeSeg(v: string, type?: string, label?: string): RichSeg
    {
        const name = v.replace(/^(flag|var|global_var|local_var):/, '');
        return { text: `“${humanize(name)}”`, kind: 'code', ref: type ? { type, name } : undefined, tip: `${label ?? 'Name'}: ${name}` };
    }

    /** The keys a list takes in its block (the catalog's params: province, region, name, involvement …) as a phrase after its head: " (province: your location)". */
    private listKeys(list: string, block: PNode[], ctx: Ctx): Rich
    {
        // (a kept list's name: "list member in “target titles”"; its keys are not the catalog's)
        if (/^in_(local_|global_)?list$/.test(list))
        {
            const name = block.find((c) => (c.k === 'list' || c.k === 'variable') && typeof c.v === 'string');
            return name ? rich(tr(' in '), this.codeSeg(name.v as string)) : [];
        }

        const parts: Rich[] = [];

        for (const p of ITERATORS.find((i) => i.list === list)?.params ?? [])
        {
            // (the type is read with the head)
            const c = p.key === 'type' ? undefined : block.find((x) => x.k === p.key && typeof x.v === 'string');

            if (!c)
                continue;

            const v = c.v as string;
            const seg: RichSeg = p.kind === 'scope' ? this.scopeSeg(v, ctx) : p.kind === 'ref' && p.ref ? this.ref(v, [p.ref]) : p.kind === 'choice' ? (p.options?.find((o) => o[0] === v)?.[1] ?? humanize(v)) : { text: humanize(v), kind: 'value', tip: v };
            parts.push(rich(this.listKeyLabel(p.key), ': ', seg));
        }

        return parts.length ? rich(' (', ...parts.flatMap((x, i): Rich => [i ? ', ' : '', ...x]), ')') : [];
    }

    /** A list key's label (the catalog's keys: province, region, name, category …); an unknown key reads humanized. */
    private listKeyLabel(key: string): string
    {
        switch (key)
        {
            case 'province': return tr('Province');
            case 'region': return tr('Region');
            case 'name': return tr('Name');
            case 'category': return tr('Category');
            case 'artifact_slot_type': return tr('Artifact slot type');
            case 'knowledge_filter': return tr('Knowledge filter');
            case 'involvement': return tr('Involvement');
            default: return humanize(key);
        }
    }

    /**
     * An iterator inside a worked-out value (`add = { every_in_list = { list = target_titles every_in_de_jure_hierarchy
     * = { limit = { tier = tier_county } add = 100 } } }`): its head ("For each list member (list: target titles)",
     * "For each title in the de jure hierarchy where:"), its limit's conditions, the context and statements for its body.
     */
    valueIterator(k: string, block: PNode[], ctx: Ctx): { text: Rich; conditions?: Line[]; ctx: Ctx; body: PNode[]; }
    {
        const m = /^(every|any|ordered|random)_(\w+)$/.exec(k);
        const list = m ? m[2] : k;
        const what = this.iterLabel(list);
        const item = tr('the {what}', { what: itemNoun(what) });
        const ictx: Ctx = { ...ctx, scope: item, subject: { of: item, text: item }, scopeType: iteratedScope(list), prevTypes: pushPrev(ctx) };
        const limit = block.find((c) => c.k === 'limit');
        const conds = limit && Array.isArray(limit.v) ? this.triggers(limit.v, ictx) : [];
        const head = m?.[1] === 'random' ? tr('For one random {what}', { what }) : /^this /.test(what) ? tr('For {what}', { what }) : tr('For each {what}', { what });
        return {
            text: rich(head, this.listKeys(list, block, ctx), conds.length ? tr(' where:') : ':'),
            conditions: conds.length ? conds : undefined,
            ctx: ictx,
            body: block.filter((c) => !ITERATOR_PARAMS.has(c.k ?? ''))
        };
    }

    /**
     * A hierarchy walk's `continue = { tier > tier_county }` (any_in_de_jure_hierarchy and its kin): which items it
     * goes on past, down or up; the others end the walk there.
     */
    private continueLine(block: PNode[], ctx: Ctx, tip: string | undefined): Line
    {
        return { text: [tr('Goes on past one only where:')], children: this.triggers(block, ctx), tip };
    }

    iterLabel(what: string): string
    {
        // (a list a script keeps: its members)
        if (/^in_(local_|global_)?list$/.test(what))
            return tr('list member');

        // (the picker's catalog names it (`faith_rite` "rite of the faith"); else its key made readable)
        const known = ITERATORS.find((i) => i.list === what);

        if (known)
            return known.label;

        return humanize(what);
    }

    /**
     * Walks a script's scope blocks, knowing at each statement who it is about ("you", "your liege", "one of your
     * courtiers, at random" (with the iterator's conditions: a limit, or an any_'s own statements)), for the event card's
     * "Who's who". `top`: who the script's root is and how its links read ('you' → "your liege", 'them' → "their
     * liege"). `holder`: the scope block around the statement; `scoped`: inside one (not the root any more).
     */
    private walkScopes(
        nodes: PNode[],
        ctx: Ctx,
        top: { who: string; owner: string; },
        visit: (n: PNode, at: { who: string; conditions?: Line[]; holder?: PNode; scoped: boolean; scopeType?: string; prevTypes?: (string | undefined)[]; when?: Line[]; }) => void
    ): void
    {
        const scripted = (k: string): boolean => !!(this.idx.get('scripted_effects', k) || this.idx.get('scripted_triggers', k));
        // who: the one a statement right here is about; owner: whose links / lists the block's own blocks go through
        // (when: the conditions of the if / else_if blocks around: "Otherwise, if …" for a later branch)
        const walk = (list: PNode[], who: string, owner: string, c: Ctx, holder: PNode | undefined, conds: Line[] | undefined, scoped: boolean, when?: Line[]): void =>
        {
            for (const n of list)
            {
                const k = n.k;

                if (!k)
                    continue;

                visit(n, { who, conditions: conds, holder, scoped, scopeType: c.scopeType, prevTypes: c.prevTypes, when });

                if (!Array.isArray(n.v))
                    continue;

                const it = !NOT_ITERATORS.has(k) && /^(any|every|random|ordered)_(\w+)$/.exec(k);

                if (it && !scripted(k))
                {
                    const what = this.iterLabel(it[2]);
                    const many = `${possessive(owner)} ${plural(what)}`;
                    // (an ordered one with `max` runs for the top few, with `position` for one further down)
                    const rank = it[1] === 'ordered' ? this.orderedRank(n.v, c) : undefined;
                    const ordered = rank?.many ? tr('each of the first few of {many} in order', { many }) : rank ? tr('one of {many}, by its place in order', { many }) : tr('the first of {many} in order', { many });
                    const label = it[1] === 'random' ? tr('one of {many}, at random', { many }) : it[1] === 'ordered' ? ordered : it[1] === 'every' ? tr('each of {many}', { many }) : tr('one of {many}', { many });
                    // (an effect iterator's limit; a trigger iterator's own statements are its conditions)
                    const limit = n.v.find((x) => x.k === 'limit');
                    const inner = it[1] === 'any' ? n.v.filter((x) => x.k && !ITERATOR_PARAMS.has(x.k) && !/^save_/.test(x.k) && x.k !== 'count' && x.k !== 'percent') : limit && Array.isArray(limit.v) ? limit.v : [];
                    const ic: Ctx = { ...c, scope: `the ${what}`, scopeType: iteratedScope(it[2]), prevTypes: pushPrev(c) };
                    const lines = inner.length ? this.triggers(inner, ic) : [];
                    walk(n.v, label, tr('the {what}', { what }), ic, n, lines.length ? lines : undefined, true, when);
                    continue;
                }

                if (this.isScopeKey(k) && !scripted(k))
                {
                    const label = this.scopeLabel(k, { ...c, scope: owner });
                    walk(n.v, label, label, { ...c, scope: label, scopeType: linkedScope(k, c.scopeType, c), prevTypes: pushPrev(c, k) }, n, undefined, true, when);
                    continue;
                }

                // (a character made here: its save_scope_as and after_creation are about the new one)
                if (k === 'create_character')
                {
                    walk(n.v, tr('the new character'), tr('the new character'), { ...c, scope: 'the new character', scopeType: 'character', prevTypes: pushPrev(c, k, false) }, n, undefined, true, when);
                    continue;
                }

                if (k === 'if' || k === 'else_if')
                {
                    const limit = n.v.find((x) => x.k === 'limit');
                    const lines = limit && Array.isArray(limit.v) ? this.triggers(limit.v, c) : [];
                    walk(n.v, who, owner, c, holder, conds, scoped, lines.length ? [...(when ?? []), ...lines] : when);
                    continue;
                }

                // (limit, trigger, else, an option, an on_action's effect …: the same one)
                walk(n.v, who, owner, c, holder, conds, scoped, when);
            }
        };
        walk(nodes, top.who, top.owner, ctx, undefined, undefined, false);
    }

    /**
     * The scopes a script names (`save_scope_as` / `save_temporary_scope_as`) and who each is, read from where the save
     * stands: "You", "Your liege", "One of your courtiers, at random" with the iterator's conditions. `alone`: the block
     * around the save does nothing else (forgetting the name removes the block).
     */
    savedScopes(
        nodes: PNode[],
        ctx: Ctx,
        top: { who: string; owner: string; } = { who: 'you', owner: 'you' },
        everyWho = false
    ): { name: string; who: string; conditions?: Line[]; temporary: boolean; save: PNode; holder?: PNode; alone: boolean; type?: string; when?: Line[]; }[]
    {
        const out: { name: string; who: string; conditions?: Line[]; temporary: boolean; save: PNode; holder?: PNode; alone: boolean; type?: string; when?: Line[]; }[] = [];
        this.walkScopes(nodes, ctx, top, (n, at) =>
        {
            // (each name once; `everyWho`: once per who is saved under it, "the loser, else the runner-up")
            if ((n.k !== 'save_scope_as' && n.k !== 'save_temporary_scope_as') || typeof n.v !== 'string' || out.some((o) => o.name === n.v && (!everyWho || o.who === capitalize(at.who))))
                return;

            const h = at.holder;
            const alone = !!h && Array.isArray(h.v) && h.v.every((x) => x === n || (x.k !== null && (x.k === 'limit' || ITERATOR_PARAMS.has(x.k))));
            out.push({ name: n.v, who: capitalize(at.who), conditions: at.conditions, temporary: n.k === 'save_temporary_scope_as', save: n, holder: h, alone, type: at.scopeType, when: at.when });
        });
        return out;
    }

    /**
     * The scope types of the variables a script sets to a scope (Ctx.varTypes): `set_variable = { name = x value = <a
     * scope> }` (set_local_variable, set_global_variable: `local_var:x`, `global_var:x`), the value typed where the
     * statement stands (linkedScope: `scope:target.primary_title` → landed_title). Only this script's own sets: a
     * variable set elsewhere (another event, a scripted effect) is not known; one set to scopes of two types neither.
     */
    variableTypes(nodes: PNode[], ctx: Ctx): Record<string, string> | undefined
    {
        // (most scripts set none or use none as a scope: the walk reads the conditions of every iterator on the way)
        if (!/\bset_(local_|global_)?variable\b/.test(ctx.src) || !/\b(local_|global_)?var:\w/.test(ctx.src))
            return undefined;

        const out: Record<string, string> = {};
        const mixed = new Set<string>();
        const PREFIX: Record<string, string> = { set_variable: 'var', set_local_variable: 'local_var', set_global_variable: 'global_var' };
        this.walkScopes(nodes, ctx, { who: 'you', owner: 'you' }, (n, at) =>
        {
            const prefix = n.k ? PREFIX[n.k] : undefined;

            if (!prefix || !Array.isArray(n.v))
                return;

            const name = n.v.find((c) => c.k === 'name');
            const value = n.v.find((c) => c.k === 'value');

            if (typeof name?.v !== 'string' || typeof value?.v !== 'string')
                return;

            const key = prefix + ':' + name.v;
            const type = linkedScope(value.v, at.scopeType, { ...ctx, scopeType: at.scopeType, prevTypes: at.prevTypes, varTypes: { ...ctx.varTypes, ...out } });

            if (!type || mixed.has(key))
                return;

            if (out[key] !== undefined && out[key] !== type)
            {
                mixed.add(key);
                delete out[key];
            }
            else
                out[key] = type;
        });
        return Object.keys(out).length ? out : undefined;
    }

    /**
     * Every set of a variable (`set_variable`, `set_global_variable`; not local ones) in a script, per key (`var:x`,
     * `global_var:x`), each with the scope type of its value where the statement stands, or '' when the value is no
     * scope the describer knows (a number, `yes`, a script value block, the short form `set_variable = x`, a link it does
     * not know): StoryBuilder.globalVarTypes reads the setters in other files with it.
     */
    variableSets(nodes: PNode[], ctx: Ctx): Map<string, string[]>
    {
        const out = new Map<string, string[]>();

        if (!/\bset_(global_)?variable\b/.test(ctx.src))
            return out;

        const PREFIX: Record<string, string> = { set_variable: 'var', set_global_variable: 'global_var' };
        this.walkScopes(nodes, ctx, { who: 'you', owner: 'you' }, (n, at) =>
        {
            const prefix = n.k ? PREFIX[n.k] : undefined;

            if (!prefix)
                return;

            const name = typeof n.v === 'string' ? n.v : Array.isArray(n.v) ? n.v.find((c) => c.k === 'name')?.v : undefined;

            if (typeof name !== 'string' || !/^\w+$/.test(name))
                return;

            const value = Array.isArray(n.v) ? n.v.find((c) => c.k === 'value') : undefined;
            const type = typeof value?.v === 'string' ? linkedScope(value.v, at.scopeType, { ...ctx, scopeType: at.scopeType, prevTypes: at.prevTypes }) : undefined;
            const key = prefix + ':' + name;
            out.set(key, [...(out.get(key) ?? []), type ?? '']);
        });
        return out;
    }

    /**
     * The values a script saves (`save_scope_value_as = { name = x value = … }`, temporary too): each with its value
     * as written, whose scope it is worked out in and the ifs around the save.
     */
    savedValues(nodes: PNode[], ctx: Ctx): { name: string; value: PNode; who: string; temporary: boolean; when?: Line[]; scoped: boolean; }[]
    {
        const out: { name: string; value: PNode; who: string; temporary: boolean; when?: Line[]; scoped: boolean; }[] = [];
        this.walkScopes(nodes, ctx, { who: 'you', owner: 'you' }, (n, at) =>
        {
            if ((n.k !== 'save_scope_value_as' && n.k !== 'save_temporary_scope_value_as') || !Array.isArray(n.v))
                return;

            const name = n.v.find((c) => c.k === 'name');
            const value = n.v.find((c) => c.k === 'value');

            if (typeof name?.v === 'string' && value)
                out.push({ name: name.v, value, who: at.who, temporary: n.k === 'save_temporary_scope_value_as', when: at.when, scoped: at.scoped });
        });
        return out;
    }

    /**
     * Who a script sends `event` to (`trigger_event = event` / `{ id = event }`): '' when its own root gets it, else who:
     * "one of their parents, at random" (`top.owner` 'them': the script's root is "they"), with the conditions; null
     * when the script does not fire it.
     */
    firedWho(nodes: PNode[], event: string, ctx: Ctx, top: { who: string; owner: string; } = { who: 'them', owner: 'them' }): { who: string; conditions?: Line[]; } | null
    {
        let found: { who: string; conditions?: Line[]; } | null = null;
        this.walkScopes(nodes, ctx, top, (n, at) =>
        {
            if (found || n.k !== 'trigger_event')
                return;

            if (n.v === event || (Array.isArray(n.v) && n.v.some((x) => x.k === 'id' && x.v === event)))
                found = { who: at.scoped ? at.who : '', conditions: at.conditions };
        });
        return found;
    }

    /**
     * A chain of links ending on a scope, compared to another (`house.house_head = root`, `faith.religion =
     * religion:x`): a comparison of two scopes; a chain ending on a value (`primary_title.tier >= tier_county`) is not.
     */
    private isLinkChain(k: string, op: string | undefined, v: string): boolean
    {
        if (op && op !== '=' && op !== '!=' && op !== '?=')
            return false;

        // (one link compared to a scope: `top_liege = root.top_liege` "[the vassal’s top liege] is your top liege", not
        // "Top liege: your top liege")
        if (!k.includes('.'))
            return (SCOPE_LINKS.has(k) || CATALOG_LINKS.has(k)) && (/^(scope:|root\b|prev\b|this\b)/.test(v) || /^[a-z_]+(\.[a-z_]+)+$/.test(v));

        const links = k.split('.');
        const last = links[links.length - 1];
        return links.every((l) => /^\w+$/.test(l) || /^\w+:[\w-]+$/.test(l)) && (SCOPE_LINKS.has(last) || CATALOG_LINKS.has(last));
    }

    isScopeKey(k: string): boolean
    {
        if (/^\w+:/.test(k))
            return true;

        // (a number with a dot (a weight, 0.24 = { … }) is none)
        if (k.includes('.'))
            return !NUMERIC.test(k) && !/^\d+\.\d+\.\d+$/.test(k);

        // ($OWNER$ = { … }: a parameter that names who, the definition read on its own)
        if (PARAM_KEY.test(k))
            return true;

        // (and the picker's catalog of links: 1.20's rite, main_rite, head_of_rite …)
        return SCOPE_LINKS.has(k) || CATALOG_LINKS.has(k);
    }

    // -------------------------------------------------------------------------
    // Effects
    // -------------------------------------------------------------------------

    effects(nodes: PNode[], ctx: Ctx): Line[]
    {
        const out: Line[] = [];
        this.effectsOpen++;

        try
        {
            for (let i = 0; i < nodes.length; i++)
            {
                const n = nodes[i];

                if (n.k === null || n.k === '')
                    continue;

                // (a title given the way the game writes it, three statements in a row: one line, changed and removed as one)
                const given = this.titleTriple(nodes, i, ctx);

                if (given)
                {
                    const fin = finalize(given);

                    if (fin)
                    {
                        out.push(fin);
                        this.linesMade++;
                    }

                    i += 2;
                    continue;
                }

                // if / else_if / else chains share "previous conditions"
                const l = this.effect(n, ctx);

                if (!l)
                    continue;

                for (const x of Array.isArray(l) ? l : [l])
                {
                    const fin = finalize(x);

                    if (fin)
                    {
                        out.push(fin);
                        this.linesMade++;
                    }
                }
            }
        }
        finally
        {
            this.effectsOpen--;
        }

        if (this.effectsOpen)
            return out;

        if (this.expansionLines > KEPT_EXPANSION_LINES)
        {
            this.expansions.clear();
            this.expansionLines = 0;
        }

        return this.fitLines(out);
    }

    /** the number of lines under a line, itself included (the conditions too; a shared line is counted once) */
    private sizeOf(l: Line): number
    {
        let n = this.sizes.get(l);

        if (n === undefined)
        {
            n = 1;

            for (const c of l.children ?? [])
                n += this.sizeOf(c);

            for (const c of l.conditions ?? [])
                n += this.sizeOf(c);

            this.sizes.set(l, n);
        }

        return n;
    }

    /**
     * The lines of one list of effects (an event option, a card's section, an on_action) as they go into the card: all of
     * them while they number the budget at most. Past it the groups of an expanded scripted effect, in order, that no
     * longer fit are not listed (they stay folded in the view anyway) but named with their size, where the effect itself
     * can be read: what a script of nested loops calling effects that call effects would otherwise multiply into
     * hundreds of thousands of lines (and a list of them the view cannot walk). A line of the script's own text always stays.
     */
    private fitLines(lines: Line[]): Line[]
    {
        let total = 0;

        for (const l of lines)
            total += this.sizeOf(l);

        if (total <= this.lineBudget)
            return lines;

        return this.cutLines(lines, { left: this.lineBudget, slack: SMALL_SLACK });
    }

    private cutLines(lines: Line[], budget: { left: number; slack: number; }): Line[]
    {
        return lines.map((l) =>
        {
            const size = this.sizeOf(l);

            if (size <= budget.left)
            {
                budget.left -= size;
                return l;
            }

            const group = l.group && l.children?.length ? this.idx.get(l.group.type, l.group.name) : undefined;

            // (a small group stays whole while the slack lasts: its note would cost as much as its lines, and say less)
            if (group && size <= SMALL_GROUP && budget.slack >= size)
            {
                budget.slack -= size;
                return l;
            }

            if (group)
            {
                const left = size - 1;
                budget.left -= 2;
                // (kept: "Show them here" loads them with this call's own values, which the effect's card does not have)
                return {
                    ...l,
                    children: [{
                        text: rich(
                            group.type === 'scripted_triggers' ?
                                tr('{count} more lines, not listed here to keep the card readable. Show them here, or read them in the trigger itself: ', { count: formatNumber(left) }) :
                                tr('{count} more lines, not listed here to keep the card readable. Show them here, or read them in the effect itself: ', { count: formatNumber(left) }),
                            this.entitySeg(group)
                        ),
                        icon: 'note',
                        hidden: l.hidden,
                        more: this.keepCut(l.children!)
                    }]
                };
            }

            budget.left -= 1;

            if (!l.children?.length && !l.conditions?.length)
                return l;

            return {
                ...l,
                ...(l.children ? { children: this.cutLines(l.children, budget) } : {}),
                ...(l.conditions ? { conditions: this.cutLines(l.conditions, budget) } : {})
            };
        });
    }

    private withWhen(ctx: Ctx, w: Rich | string): Ctx
    {
        return { ...ctx, when: [...ctx.when, typeof w === 'string' ? [w] : w] };
    }

    /**
     * A title given as the game writes it (docs/readable-view.md, "A title given"): `create_title_and_vassal_change`
     * saving the change as X, right after it `<title> = { change_title_holder = { … change = scope:X … } }` (that statement
     * alone in the title's block) and `resolve_title_and_vassal_change = scope:X`, nothing but comments between them. One
     * line "Gives <title> to <holder> (<type>)", anchored from the create's start to the resolve's end: ✎ reads the three
     * back as the picker's "Give a title to someone", ✕ takes the three (and the create's comment lines above it), one undo
     * step each. Null for any other layout: then the three are read statement by statement.
     */
    private titleTriple(nodes: PNode[], i: number, ctx: Ctx): Line | null
    {
        const c = nodes[i];
        const t = nodes[i + 1];
        const r = nodes[i + 2];

        if (c.k !== 'create_title_and_vassal_change' || c.op !== '=' || !Array.isArray(c.v) || !t || !r)
            return null;

        const str = (b: PNode[], key: string): string | undefined =>
        {
            const x = b.find((y) => y.k === key);
            return typeof x?.v === 'string' ? x.v : undefined;
        };
        const name = str(c.v, 'save_scope_as');

        if (!name || !/^\w+$/.test(name) || r.k !== 'resolve_title_and_vassal_change' || r.op !== '=' || r.v !== `scope:${name}`)
            return null;

        if (!t.k || t.op !== '=' || !Array.isArray(t.v) || t.v.length !== 1 || !this.isScopeKey(t.k) || this.idx.get('scripted_effects', t.k))
            return null;

        const ch = t.v[0];

        if (ch.k !== 'change_title_holder' || ch.op !== '=' || !Array.isArray(ch.v) || str(ch.v, 'change') !== `scope:${name}`)
            return null;

        const holder = str(ch.v, 'holder');
        const type = str(c.v, 'type');

        if (!holder || !type)
            return null;

        // (the holder is written in the title's scope: `prev` is the one giving it, `prev.liege` their liege)
        const inner: Ctx = { ...ctx, scope: this.scopeLabel(t.k, ctx), scopeType: linkedScope(t.k, ctx.scopeType, ctx), prevTypes: pushPrev(ctx, t.k) };
        const out = outOfPrev(holder);
        const who: RichSeg = out !== undefined && out !== holder ? { ...(this.scopeSeg(out, ctx) as Exclude<RichSeg, string>), tip: holder } : this.valueSeg(holder, inner);
        // (an entry the index knows (`title:k_france`) links to its card; anything else by its scope's label)
        const entry = /^\w+:([\w-]+)$/.exec(t.k);
        const title: RichSeg = entry && !t.k.startsWith('scope:') && this.idx.named(entry[1])[0] ? this.valueSeg(t.k, ctx) : this.scopeSeg(t.k, ctx);
        const kids: Line[] = [];
        const claim = str(c.v, 'add_claim_on_loss');
        const baronies = str(ch.v, 'take_baronies');

        if (claim === 'yes' || claim === 'no')
            // (the old holder gains a claim on what they lose, one they need not have had; `no` is the default)
            kids.push({ text: [claim === 'yes' ? tr('The one who loses it gains a claim on it') : tr('The one who loses it gets no claim on it')] });

        if (baronies === 'yes' || baronies === 'no')
            kids.push({ text: [baronies === 'yes' ? tr('The other baronies in it are taken too') : tr('The other baronies’ holders in it become the new holder’s vassals')] });

        // (what else is written in the two blocks, as written)
        const told = (x: PNode): boolean => (x.k === 'add_claim_on_loss' || x.k === 'take_baronies' ? x.v === 'yes' || x.v === 'no' : ['type', 'save_scope_as', 'holder', 'change'].includes(x.k ?? '') && typeof x.v === 'string');

        for (const b of [c.v, ch.v])
        {
            for (const x of b)
            {
                if (!x.k || told(x))
                    continue;

                kids.push({ text: typeof x.v === 'string' ? rich(capitalize(humanize(x.k)), ': ', this.valueSeg(x.v, inner)) : [capitalize(humanize(x.k))] });
            }
        }

        const tip = ctx.src.slice(c.s, r.e);
        const l: Line = {
            text: rich(tr('Gives '), title, tr(' to '), who, ` (${humanize(type)})`),
            tip: tip.length > 600 ? tip.slice(0, 600) + '\n…' : tip,
            hidden: ctx.hidden,
            ...(kids.length ? { children: kids, collapsed: true } : {})
        };

        if (ctx.file)
        {
            const a = this.anchor(c, ctx, 'effect', false);
            const end = this.anchor(r, ctx, 'effect', false);

            if (a && end)
            {
                a.e = end.e;

                if (ctx.file.text)
                    a.stmt = this.stmtOf(ctx.file, a.s, a.e);

                l.src = a;
            }
        }

        return l;
    }

    effect(n: PNode, ctx: Ctx): Line | Line[] | null
    {
        const l = this.effectLine(n, ctx);

        if (l && !Array.isArray(l))
            markRefusedPrev(n, l);

        // (several lines: a hidden_effect's statements, anchored each, or an inlined scripted effect's, from another text)
        if (l && !Array.isArray(l) && ctx.file)
        {
            l.src = this.anchor(n, ctx, 'effect', Array.isArray(n.v) && this.holdsEffects(n.k!));
            l.limitSrc = this.limitOf(n, ctx);
        }

        // an inlined scripted effect in a mod's entry: the call gets a line of its own (edited, moved, removed) with the
        // effect's lines under it (the game's entries read it inline, as the game shows it)
        const se = Array.isArray(l) && l.length && ctx.file?.mod && n.k ? this.idx.get('scripted_effects', n.k) : undefined;

        if (se && Array.isArray(l))
        {
            const args = Array.isArray(n.v) ? n.v.filter((c) => c.k && typeof c.v === 'string') : [];
            const text: Rich = [
                { text: capitalize(humanize(n.k!)), kind: 'entity', ref: { type: se.type, name: se.name }, tip: n.k! },
                ...(args.length ? [' (', ...args.flatMap((c, i): Rich => [i ? ', ' : '', capitalize(humanize(c.k!)), ': ', this.valueSeg(c.v as string, ctx)]), ')'] : []),
                ':'
            ];
            return { text, children: l, icon: 'call', hidden: l.every((x) => x.hidden), src: this.anchor(n, ctx, 'effect', false) };
        }

        return l;
    }

    /**
     * An `if` / `else_if` (`trigger_if` / `trigger_else_if` among conditions) or effect iterator's `limit` as a place to
     * add conditions ("＋ if"): the block, or (none yet) where one is made (before the block's first statement).
     * Conditions there are about the iterator's item.
     */
    limitOf(n: PNode, ctx: Ctx): SectionSource | undefined
    {
        const k = n.k ?? '';

        if (!Array.isArray(n.v))
            return undefined;

        const isIf = k === 'if' || k === 'else_if' || k === 'trigger_if' || k === 'trigger_else_if';

        if (!isIf && !(/^(every|random|ordered)_\w+$/.test(k) && !this.idx.get('scripted_effects', k)))
            return undefined;

        const inside = isIf ? {} : this.insideOf(n, ctx);
        const scope = inside.scope ?? ctx.scopeType;
        const extra = { ...(scope ? { scope } : {}), ...(inside.subject ? { subject: inside.subject } : {}) };
        const limit = n.v.find((c) => c.k === 'limit' && Array.isArray(c.v));

        if (limit)
        {
            const src = this.anchor(limit, ctx, 'trigger', true);
            // (the limit is read with the iterator's item as its scope: the prev stack inside is the iterator's; an if's
            // limit is in the if's own scope, a guess where that is one)
            return src && { src: { ...src, ...(scope ? { innerScope: scope } : {}), ...(inside.subject ? { subject: inside.subject } : {}), ...(inside.prev ? { prevInside: inside.prev } : {}), ...(isIf && isGuessed(ctx) ? { innerGuessed: true } : {}) }, key: 'limit', kind: 'trigger', ...extra };
        }

        const first = n.v.find((c) => c.k);
        const body = k.startsWith('trigger_') ? 'trigger' : 'effect';
        // (a new limit, before the first statement or made inside an empty iterator, is about the iterator's item: its
        // prev stack, and not the outer scope's guess (an iterator's item is never guessed))
        const intoItem = (a: LineSource | undefined): LineSource | undefined =>
        {
            if (!a || isIf)
                return a;

            const { scopeGuessed: _, ...rest } = a;
            return { ...rest, ...(inside.prev?.length ? { prev: inside.prev } : {}) };
        };
        const before = intoItem(first && this.anchor(first, ctx, body, false));
        const parent = intoItem(this.anchor(n, ctx, body, true));

        if (!before && !parent)
            return undefined;

        return { ...(before ? { before } : { parent }), key: 'limit', kind: 'trigger', ...extra };
    }

    /** Blocks whose statements are effects of their own (statements can be added inside). */
    private holdsEffects(k: string): boolean
    {
        if (EFFECT_BLOCKS.has(k))
            return true;

        return (/^(every|random|ordered)_/.test(k) || this.isScopeKey(k)) && !this.idx.get('scripted_effects', k);
    }

    /**
     * Effects read by the cards' code (the StoryBuilder sets them: `create_character` as a character template): a
     * line, or null to fall back to the plain one.
     */
    readonly effectReaders: Record<string, (n: PNode, ctx: Ctx) => Line | null> = {};
    /** A script value's statements as lines, a weight block's (the cards' readers, weight.ts; set by the StoryBuilder) */
    valueReader?: (list: PNode[], ctx: Ctx) => Line[];
    weightReader?: (list: PNode[], ctx: Ctx) => Line[];

    private effectLine(n: PNode, ctx: Ctx): Line | Line[] | null
    {
        const k = n.k!;
        const block = Array.isArray(n.v) ? n.v : null;
        const reader = block && this.effectReaders[k];

        if (reader)
        {
            const l = reader(n, ctx);

            if (l)
                return l;
        }

        const v = typeof n.v === 'string' ? this.constOf(n.v, ctx) : '';
        const tip = this.tip(n, ctx);
        const field = (key: string): string | undefined =>
        {
            // (the game reads a statement's own keys in any case: `TARGET = …`, `GOLD = …` in vanilla's events)
            const c = block?.find((x) => x.k?.toLowerCase() === key);
            return typeof c?.v === 'string' ? this.constOf(c.v, ctx) : undefined;
        };

        // (an activity's log entry: the entry itself is quiet, the effects written in it happen, a pulse action's)
        if (k === 'add_activity_log_entry' && block)
        {
            const kids = this.effects(block.filter((c) => !c.k || !LOG_ENTRY_PARAMS.has(c.k)), ctx);
            return kids.length ? this.group(tr('Written in the activity’s log:'), kids, { icon: 'note', tip }) : null;
        }

        // (a value kept for later, behind the scenes: "Remembers “bg system”: chess")
        if ((k === 'save_scope_value_as' || k === 'save_temporary_scope_value_as') && block)
        {
            const name = field('name');
            const value = block.find((c) => c.k === 'value');

            if (!name || !value)
                return null;

            // (a worked-out one: its script in the tip; scripted effects list them with their formula, "Values it saves")
            return {
                text: rich(tr('Remembers '), { text: `“${humanize(name)}”`, kind: 'value', tip: `scope:${name}` }, typeof value.v === 'string' ? rich(': ', this.valueSeg(value.v, ctx)) : ': a worked-out value'),
                icon: 'var',
                hidden: true,
                tip
            };
        }

        // (music and sounds: behind the scenes, the sound's last path part: "ep2 event grand tour set india")
        if ((k === 'play_music_cue' || k === 'play_sound_effect') && v)
        {
            const what = k === 'play_music_cue' ? 'music' : 'sound';
            const name = humanize(v.replace(/^mx_cue_/, '').replace(/^.*\//, ''));
            return { text: rich(tr('Plays the {what} ', { what }), { text: `“${name}”`, kind: 'value', tip: v }), icon: 'note', hidden: true, tip };
        }

        // (who is remembered under a name, a name forgotten, behind the scenes; the cards list the saves, "Who it saves")
        if ((k === 'save_scope_as' || k === 'save_temporary_scope_as') && v)
            return { text: rich(scopeName(ctx) === 'you' ? tr('You are') : tr('{capitalize} is', { capitalize: capitalize(scopeName(ctx)) }), tr(' remembered as '), { text: `“${humanize(v)}”`, kind: 'value', tip: `scope:${v}` }), icon: 'var', hidden: true, tip };

        if (k === 'clear_saved_scope' && v)
            return { text: rich(tr('Forgets '), { text: `“${humanize(v)}”`, kind: 'value', tip: `scope:${v}` }), icon: 'var', hidden: true, tip };

        // (a culture's acceptance of another, a tenet's popularity: "Acceptance with ‹Volhynian›: +50", not "Change
        // cultural acceptance (target: Volhynian, value: 50)")
        if ((k === 'change_cultural_acceptance' || k === 'change_tenet_popularity') && block)
        {
            const target = block.find((c) => c.k === 'target' && typeof c.v === 'string');
            const amount = block.find((c) => (c.k === 'value' || c.k === 'change') && typeof c.v === 'string');
            const n = amount ? this.evalValue(this.constOf(amount.v as string, ctx)) : undefined;

            if (target && amount && block.every((c) => c === target || c === amount || c.k === 'desc'))
            {
                const head = k === 'change_cultural_acceptance' ? tr('Acceptance with ') : tr('Popularity of the tenet ');
                const seg: RichSeg = n !== undefined ? { text: signed(n), kind: 'value', tip: amount.v as string } : this.valueSeg(amount.v as string, ctx);
                return { text: rich(head, this.valueSeg(target.v as string, ctx), ': ', seg), tone: n === undefined ? undefined : n >= 0 ? 'good' : 'bad', tip };
            }
        }

        // (an artifact's name or description: a text key, behind the scenes (the game shows no tooltip line for it); in a
        // mod's entry "✎ text" changes the text, the line's locKey)
        if ((k === 'set_artifact_name' || k === 'set_artifact_description') && v && /^[\w.-]+$/.test(v))
        {
            const text = this.loc(v);
            const shown: RichSeg = { text: `“${text ? richToString(text) : humanize(v)}”`, kind: 'value', tip: v };
            return {
                text: k === 'set_artifact_name' ? rich(tr('Names the artifact '), shown) : rich(tr('Describes the artifact: '), shown),
                icon: 'note',
                hidden: true,
                tip,
                locKey: v
            };
        }

        // (a new artifact: its name in the line, its own `name` / `description` text keys as lines carrying their keys,
        // "✎ text" in a mod's entry, the other fields as written; a name or description given by a parameter or a scope
        // stays a plain field)
        if (k === 'create_artifact' && block)
        {
            const textKey = (c: PNode): string | undefined => (typeof c.v === 'string' && /^[\w.-]+$/.test(c.v) && !/^(scope|var|local_var|global_var):/.test(c.v) ? c.v : undefined);
            const quoted = (key: string): RichSeg =>
            {
                const text = this.loc(key);
                return { text: `“${text ? richToString(text) : humanize(key)}”`, kind: 'value', tip: key };
            };
            const nameNode = block.find((c) => c.k === 'name');
            const nameKey = nameNode && textKey(nameNode);
            const kids: Line[] = [];

            for (const c of block)
            {
                const key = (c.k === 'name' || c.k === 'description') && textKey(c);

                if (!key)
                    continue;

                kids.push({
                    text: rich(c.k === 'name' ? tr('Name: ') : tr('Description: '), quoted(key)),
                    icon: 'note',
                    tip: this.tip(c, ctx),
                    locKey: key,
                    ...(ctx.file ? { src: this.anchor(c, ctx, 'effect', false) } : {})
                });
            }

            const rest = this.effects(block.filter((c) => !((c.k === 'name' || c.k === 'description') && textKey(c))), ctx);
            const all = [...kids, ...rest];
            return { text: rich(tr('Creates an artifact'), nameKey ? rich(' ', quoted(nameKey)) : ''), children: all.length ? all : undefined, collapsed: true, tip, hidden: ctx.hidden };
        }

        // (one written with a parameter or a block: no text key to show)
        if (SKIP_EFFECT_KEYS.has(k) || k === 'set_artifact_name' || k === 'set_artifact_description')
            return null;

        if ((k === 'if' || k === 'else_if' || k === 'else') && block)
        {
            const limit = block.find((c) => c.k === 'limit');
            const conds = limit && Array.isArray(limit.v) ? this.triggers(limit.v, ctx) : [];
            const whenText: Rich = k === 'else' ? ['otherwise'] : conds.length === 1 ? rich(tr('if '), lowerFirst(conds[0].text)) : [tr('if {length} conditions are met', { length: conds.length })];
            const kids = this.effects(
                block.filter((c) => c.k !== 'limit'),
                this.withWhen(ctx, whenText)
            );

            // (an empty one is shown in a mod's files (it is being written): its statements are added with ⤷＋)
            if (!kids.length && !ctx.file?.mod)
                return null;

            return this.ifLine(k === 'else' ? 'else' : k === 'else_if' ? 'elseif' : 'if', conds, kids, tip, ctx);
        }

        if (k === 'hidden_effect' && block)
        {
            const kids = this.effects(block, { ...ctx, hidden: true });

            if (!kids.length)
                return null;

            return kids.map((l) => ({ ...l, hidden: true }));
        }

        if (k === 'show_as_tooltip' && block)
        {
            const kids = this.effects(block, { ...ctx, followUps: [] });
            return kids.length ? { text: [tr('Shown in the tooltip (applied elsewhere):')], children: kids, icon: 'note', tip } : null;
        }

        if (k === 'custom_tooltip' || k === 'custom_description' || k === 'custom_description_no_bullet')
        {
            // (✎ text changes the loc text: a custom_tooltip's key is one, a custom_description's when it has a text)
            if (!block)
                return { text: this.loc(v) ?? [humanize(v)], icon: 'note', tip, ...(k === 'custom_tooltip' || this.loc(v) ? { locKey: v } : {}) };

            const key = field('text') ?? '';
            const kids = this.effects(
                block.filter((c) => !['text', 'subject', 'object', 'value'].includes(c.k ?? '')),
                ctx
            );
            const own = this.loc(key);
            return { text: own ?? [humanize(key)], icon: 'note', children: kids, collapsed: true, tip, ...(key && (own || k === 'custom_tooltip') ? { locKey: key } : {}) };
        }

        if ((k === 'random_list' || k === 'duel') && block)
            return this.randomList(k, block, ctx, tip);

        if (k === 'random' && block)
        {
            const chance = field('chance');
            const c = chance ? this.valueText(chance, ctx) : '?';
            const kids = this.effects(
                block.filter((x) => x.k !== 'chance' && x.k !== 'modifier'),
                this.withWhen(ctx, `${c}% chance`)
            );
            return { text: [tr('{c}% chance:', { c })], icon: 'chance', children: kids, tip };
        }

        if (k === 'switch' && block)
        {
            const on = field('trigger') ?? '?';
            const cases = block
                .filter((c) => c.k && c.k !== 'trigger' && Array.isArray(c.v))
                .map((c) =>
                {
                    // (each case read as the condition it is: `switch = { trigger = religion religion:islam_religion = { … } }` →
                    // "If religion is Islam")
                    const cond = c.k === 'fallback' || on === 'yes' || on === '?' ? null : this.trigger({ ...c, k: on, v: c.k!, op: '=' }, ctx, false);
                    const label: Rich = c.k === 'fallback' ? [tr('Otherwise')] : cond ? rich(tr('If '), lowerFirst(cond.text)) : [tr('If {scopeLabel}', { scopeLabel: this.scopeLabel(c.k!) })];
                    const l: Line = { text: rich(label, ':'), icon: 'if', children: this.effects(c.v as PNode[], this.withWhen(ctx, rich(...label.map((x) => (typeof x === 'string' ? x.toLowerCase() : x))))) };

                    if (ctx.file)
                        l.src = this.anchor(c, ctx, 'effect', true);

                    return l;
                })
                // (a case that does nothing (`flag:none = {}`) drops out, as an empty `if` does; shown in a mod's files,
                // where its statements are added with ⤷＋)
                .filter((l) => l.children?.length || ctx.file?.mod);

            if (!cases.length && !ctx.file?.mod)
                return null;

            return { text: [tr('Depending on {humanize}:', { humanize: switchOn(on) })], children: cases, tip };
        }

        if (k === 'trigger_event')
            return this.triggerEvent(n, block, v, ctx, tip);

        if (k === 'continue' && block)
            return this.continueLine(block, ctx, tip);

        // iterators
        const it = /^(every|random|ordered)_(\w+)$/.exec(k);

        if (it && block && !this.idx.get('scripted_effects', k))
        {
            const what = this.iterLabel(it[2]);
            const limit = block.find((c) => c.k === 'limit');
            // (the limit is about each item: `this` there is the item)
            const self = /^this /.test(what);
            const conds = limit && Array.isArray(limit.v) ? this.triggers(limit.v, { ...ctx, scope: self ? itemScope(what) : `the ${what}`, scopeType: iteratedScope(it[2]), prevTypes: pushPrev(ctx) }) : [];
            // (an ordered one runs for the best item, or with `max` / `min` for the top few, with `position` for the one
            // at that place: `max = 7` in vanilla's HRE electors, `position = end` the last)
            const rank = it[1] === 'ordered' ? this.orderedRank(block, ctx) : undefined;
            const label = self ? itemScope(what) : it[1] === 'every' ? tr('each {what}', { what }) : it[1] === 'random' ? tr('a random {what}', { what }) : rank?.many ? tr('each of the top {whats}', { whats: plural(what) }) : rank ? tr('the {what}', { what }) : tr('the top {what}', { what });
            const kids = this.effects(
                block.filter((c) => !ITERATOR_PARAMS.has(c.k ?? '')),
                { ...ctx, scope: label, subject: { of: label, text: self ? itemScope(what) : tr('the {what}', { what }) }, scopeType: iteratedScope(it[2]), prevTypes: pushPrev(ctx) }
            );

            if (!kids.length)
                return null;

            // (a random one's weight: who is likelier to be picked)
            const weight = it[1] === 'random' ? block.find((c) => c.k === 'weight' && Array.isArray(c.v)) : undefined;
            const wl = weight && this.weightReader ? this.weightReader(weight.v as PNode[], { ...ctx, scope: `the ${what}`, scopeType: iteratedScope(it[2]), prevTypes: pushPrev(ctx) }) : [];

            if (wl.length)
                kids.unshift({ text: [tr('Likelier to be picked:')], icon: 'chance', children: wl, collapsed: true });

            // (which relation, secret, scheme: `type = friend`; an ordered one's order: `order_by = age`)
            const typeNode = block.find((c) => c.k === 'type' && typeof c.v === 'string');
            const order = block.find((c) => c.k === 'order_by' && typeof c.v === 'string');
            const low = it[1] === 'ordered' ? lowestOf(block.find((c) => c.k === 'order_by' && Array.isArray(c.v))?.v) : undefined;
            const by = order ? tr(' by highest {humanize}', { humanize: humanize(order.v as string) }) : low ? tr(' by lowest {humanize}', { humanize: humanize(low) }) : '';
            let head: string;

            if (self && it[1] === 'every')
                head = tr('For {what}', { what });
            else if (it[1] === 'every')
                head = tr('For each {what}', { what });
            else if (it[1] === 'random')
                head = tr('For one random {what}', { what });
            else if (rank)
                head = rank.head(what, by);
            else if (order)
                head = tr('For the {what} with the highest {humanize}', { what, humanize: humanize(order.v as string) });
            else if (low)
                head = tr('For the {what} with the lowest {humanize}', { what, humanize: humanize(low) });
            else
                head = tr('For the best {what}', { what });

            head = capitalize(head);
            return { text: rich(head, typeNode ? rich(' (', this.ref(typeNode.v as string), ')') : '', this.listKeys(it[2], block, ctx), conds.length ? tr(' where:') : ':'), conditions: conds.length ? conds : undefined, children: kids, icon: 'loop', tip };
        }

        // scope switch
        if (block && this.isScopeKey(k) && !this.idx.get('scripted_effects', k))
        {
            const kids = this.effects(block, this.switchCtx(k, block, ctx));

            if (!kids.length)
                return null;

            return { text: [this.scopeSeg(k, ctx, true), ':'], children: kids, icon: 'scope', tip };
        }

        // scripted effect
        const se = this.idx.get('scripted_effects', k);

        if (se)
            return this.scriptedEffect(se, n, block, ctx, tip);

        const res = RESOURCES[k];

        if (res && !block)
            return this.resourceLine(res, v, ctx, tip, k.startsWith('remove_'));

        // (the amount written as a block with one value, `add_piety = { value = 500 }` (a `desc` beside it is the
        // tooltip's): read as the plain one, "+500 Piety")
        if (res && block)
        {
            const keyed = block.filter((c) => c.k && c.k !== 'desc');
            const one = keyed.length === 1 && keyed[0].k === 'value' && typeof keyed[0].v === 'string' ? keyed[0].v : undefined;

            if (one !== undefined)
                return this.resourceLine(res, this.constOf(one, ctx), ctx, tip, k.startsWith('remove_'));

            // (a worked-out amount, `{ value = 500 multiply = … }`: "Gains a worked-out amount of Piety", its steps below)
            if (this.valueReader && keyed.length)
            {
                const removal = k.startsWith('remove_');
                return {
                    text: rich(removal ? tr('Loses ') : tr('Gains '), { text: tr('a worked-out amount of'), kind: 'value' }, ' ', res[0]),
                    icon: res[2],
                    tone: removal === (res[1] === 'good') ? 'bad' : 'good',
                    children: this.valueReader(block, ctx),
                    collapsed: true,
                    tip,
                    hidden: ctx.hidden
                };
            }
        }

        const phrase = this.effectPhrase(k, block, v, ctx, field);

        if (phrase)
            return { tip, hidden: ctx.hidden || phrase.hidden, ...phrase };

        if (QUIET_EFFECT.test(k))
        {
            const name = block ? (field('name') ?? field('flag') ?? '') : v;
            // (a variable's value: a number or a scope in the text, a worked-out one below: `value = { … }`, `add = { … }`)
            const ops = (block ?? []).filter((c) => c.k && ['value', 'add', 'subtract', 'multiply', 'divide', 'min', 'max'].includes(c.k) && k.includes('variable'));
            const plain = ops.filter((c) => typeof c.v === 'string');
            const worked = ops.filter((c) => Array.isArray(c.v));
            const kids = this.valueReader ? worked.map((c): Line => ({ text: [`${capitalize(c.k === 'value' ? 'value' : c.k!)}:`], children: this.valueReader!(c.v as PNode[], ctx) })) : [];
            return {
                text: rich(
                    capitalize(humanize(k)),
                    name ? ' ' : '',
                    name ? this.codeSeg(name, k.includes('flag') ? 'flag' : k.includes('variable') ? 'variable' : undefined) : '',
                    ...plain.flatMap((c, i) => [i ? ', ' : ': ', c.k === 'value' ? '' : `${c.k} `, this.valueSeg(c.v as string, ctx)])
                ),
                hidden: true,
                icon: k.includes('flag') ? 'flag' : 'var',
                children: kids.length ? kids : undefined,
                collapsed: kids.length > 0,
                tip
            };
        }

        const custom = this.effectLocText(k, v || undefined);

        if (custom && !block)
            return { text: custom, tip, hidden: ctx.hidden };

        // generic fallback
        if (!block)
            return { text: v === 'yes' ? [capitalize(humanize(k))] : rich(capitalize(humanize(k)), ': ', this.guiSeg(k, v) ?? this.valueSeg(v, ctx)), tip, hidden: ctx.hidden };

        const inner = this.effects(block, ctx);
        return { text: rich(capitalize(humanize(k)), this.fieldSummary(block, ctx, k)), children: inner.length ? inner : undefined, collapsed: true, tip, hidden: ctx.hidden };
    }

    private resourceLine(res: [string, 'good' | 'bad', string], v: string, ctx: Ctx, tip: string, removal: boolean): Line
    {
        const n = this.evalValue(v);
        const [label, goodWhenPositive, icon] = res;

        if (n !== undefined)
        {
            const val = removal ? -Math.abs(n) : n;
            const good = (val > 0) === (goodWhenPositive === 'good');
            return { text: [{ text: `${signed(val)} ${label}`, kind: good ? 'good' : 'bad', tip: v !== String(n) ? v : undefined }], tone: good ? 'good' : 'bad', icon, tip, hidden: ctx.hidden };
        }

        const neg = v.startsWith('-') || removal;
        const name = v.replace(/^-/, '');
        return {
            // (a value named for the resource (massive_gold) does not need the word again)
            text: rich(neg ? tr('Loses ') : tr('Gains '), { text: humanize(name), kind: 'value', tip: name }, humanize(name).endsWith(label.toLowerCase()) ? '' : ` ${label}`),
            tone: neg === (goodWhenPositive === 'good') ? 'bad' : 'good',
            icon,
            tip,
            hidden: ctx.hidden
        };
    }

    private effectPhrase(k: string, block: PNode[] | null, v: string, ctx: Ctx, field: (k: string) => string | undefined): LinePart | null
    {
        switch (k)
        {
            case 'add_trait':
            case 'add_trait_force_tooltip':
                return { text: rich(tr('Gains the trait '), this.traitSeg(v)), icon: 'trait' };
            case 'remove_trait':
            case 'remove_trait_force_tooltip':
                return { text: rich(tr('Loses the trait '), this.traitSeg(v)), icon: 'trait' };
            case 'add_trait_xp':
            {
                // (the amount may be a block: `value = { integer_range = { min = … max = … } }` "+10–20")
                // (vanilla's lower_gallowsbait_xp_effect writes it `VALUE = $VALUE$`)
                const amount = this.amount(block?.find((x) => x.k?.toLowerCase() === 'value'), ctx) ?? ['?'];
                // (a worked-out amount: "A calculated amount of experience in …", not "a calculated amount experience")
                const worked = amount.length === 1 && typeof amount[0] !== 'string' && amount[0].text === tr('a calculated amount');
                return {
                    text: rich(
                        worked ? { ...(amount[0] as Exclude<RichSeg, string>), text: tr('A calculated amount') } : amount,
                        worked ? tr(' of experience in ') : tr(' experience in '),
                        this.traitSeg(field('trait') ?? '?'),
                        field('track') ? ` (${humanize(field('track')!)})` : ''
                    ),
                    icon: 'trait'
                };
            }
            // (1.20's name: it also touches spiritual fulfillment)
            case 'stress_impact':
            case 'stress_and_fulfillment_impact':
                // (written empty, `stress_and_fulfillment_impact = { }`, it does nothing: no "Stress:" without amounts; a
                // mod's file shows it, being written)
                return block && (block.some((c) => c.k && typeof c.v === 'string') || ctx.file?.mod) ? this.stressImpact(block, ctx) : null;
            case 'add_opinion':
            case 'reverse_add_opinion':
            {
                const mod = field('modifier') ?? '?';
                const target = this.scopeSeg(field('target') ?? '?', ctx);
                const opVal = field('opinion');
                const value = opVal ? this.evalValue(opVal) ?? this.opinionValue(mod) : this.opinionValue(mod);
                const self: RichSeg = scopeName(ctx) === 'you' ? 'You' : { text: capitalize(scopeName(ctx)), kind: 'scope' };
                const [who, of] = k === 'add_opinion' ? [self, target] : [target, scopeName(ctx) === 'you' ? 'you' : scopeName(ctx)];
                return {
                    text: rich(who, tr(' now '), typeof who === 'string' && who === 'You' ? tr('feel ') : tr('feels '), this.ref(mod, ['opinion_modifiers']), tr(' towards '), of, value !== undefined ? ` (${signed(value)})` : ''),
                    icon: 'opinion',
                    tone: value !== undefined ? (value >= 0 ? 'good' : 'bad') : undefined
                };
            }
            case 'add_character_modifier':
            case 'add_county_modifier':
            case 'add_province_modifier':
            case 'add_dynasty_modifier':
            case 'add_house_modifier':
            case 'add_realm_modifier':
            case 'add_title_modifier':
            {
                const mod = block ? (field('modifier') ?? '?') : v;
                const dur = block ? this.duration(block, ctx) : '';
                const e = this.idx.get('modifiers', mod);
                return {
                    text: rich(k === 'add_character_modifier' ? tr('Gains ') : tr('{capitalize} gains ', { capitalize: capitalize(humanize(k.replace(/^add_|_modifier$/g, ''))) }), this.ref(mod, ['modifiers']), dur ? tr(' for {dur}', { dur }) : ''),
                    icon: 'modifier',
                    children: e ? this.modifierStats(e) : undefined
                };
            }
            case 'remove_character_modifier':
            case 'remove_county_modifier':
            case 'remove_province_modifier':
                return { text: rich(tr('Loses '), this.ref(v, ['modifiers'])), icon: 'modifier' };
            case 'death':
                return { text: rich(tr('Dies'), block && field('death_reason') ? rich(' (', this.ref(field('death_reason')!, ['deathreasons']), ')') : ''), icon: 'death', tone: 'bad' };
            case 'give_nickname':
                return { text: rich(tr('Becomes known as '), this.ref(v, ['nicknames'])), icon: 'trait' };
            case 'set_focus':
                // (`= no` clears it: vanilla's childhood_education.0005 runs it on a child with an education focus)
                return v === 'no' ? { text: [tr('Loses the current focus')], icon: 'trait' } : null;
            case 'change_liege':
            {
                // (the game's CHANGE_LIEGE_EFFECT "Becomes X's vassal", as part of a title change saved earlier)
                const liege = field('liege');
                return liege ? { text: rich(tr('Becomes a vassal of '), this.scopeSeg(liege, ctx), field('change') ? tr(' (with the title change)') : ''), icon: 'scope' } : null;
            }
            case 'add_hook':
            case 'add_hook_no_toast':
                return { text: rich(tr('Gains a '), this.ref(field('type') ?? '?', ['hook_types']), tr(' on '), this.scopeSeg(field('target') ?? '?', ctx)), icon: 'opinion', tone: 'good' };
            case 'remove_hook':
                // (with a `type`, only a hook of that type goes)
                return { text: rich(tr('Loses the hook on '), this.scopeSeg(field('target') ?? v, ctx), field('type') ? rich(tr(', if it is a '), this.ref(field('type')!, ['hook_types']), tr(' hook')) : ''), icon: 'opinion' };
            case 'add_secret':
                return { text: rich(tr('Gains the secret '), this.ref(field('type') ?? '?', ['secret_types']), field('target') ? rich(tr(' about '), this.scopeSeg(field('target')!, ctx)) : ''), icon: 'note' };
            case 'reveal_to':
                return { text: rich(tr('The secret is revealed to '), this.scopeSeg(v, ctx)), icon: 'note' };
            case 'start_scheme':
            {
                // (one target of four kinds, or none with `targets_nothing = yes`; the effect has no plain `target`)
                const character = field('target_character');
                const other = field('target_title') ?? field('target_culture') ?? field('target_faith');
                // (in a scripted effect the target's kind is a parameter itself, `$TARGET_TYPE$ = $TARGET_SCOPE$`: its
                // value is still the one schemed against)
                const passed = block?.find((c) => c.k && PARAM_KEY.test(c.k) && typeof c.v === 'string')?.v as string | undefined;
                const against = character
                    ? rich(tr(' scheme against '), this.scopeSeg(character, ctx))
                    : other
                    ? rich(tr(' scheme on '), this.scopeSeg(other, ctx))
                    : field('targets_nothing') === 'yes'
                    ? [tr(' scheme')]
                    : passed
                    ? rich(tr(' scheme against '), this.scopeSeg(passed, ctx))
                    : rich(tr(' scheme against '), '?');
                return { text: rich(tr('Starts a '), this.ref(field('type') ?? '?', ['schemes/scheme_types']), against) };
            }
            case 'create_character':
                return { text: rich(tr('A new character appears'), field('template') ? rich(' (', this.ref(field('template')!, ['scripted_character_templates']), ')') : '') };
            case 'add_courtier':
                return { text: rich(this.scopeSeg(v, ctx), tr(' joins the court')) };
            case 'imprison':
                return { text: rich(tr('Imprisons '), this.scopeSeg(field('target') ?? v, ctx)), tone: 'bad' };
            case 'add_realm_law':
            case 'add_realm_law_skip_effects':
                return { text: rich(tr('Adopts the law '), this.ref(v, ['laws'])) };
            case 'pay_short_term_gold':
            case 'pay_long_term_gold':
            {
                // (the amount is a number, a script value or scope, or a block of its own: all in the cost style)
                const gc = block?.find((c) => c.k?.toLowerCase() === 'gold');
                const g = typeof gc?.v === 'string' ? gc.v : undefined;
                let amount: RichSeg;

                if (g === undefined)
                {
                    amount = { text: gc ? tr('a worked-out amount') : '?', kind: 'bad' };
                }
                else
                {
                    const n = this.evalValue(g);
                    const seg = this.valueSeg(g, ctx);
                    amount = n !== undefined ? { text: formatNumber(n), kind: 'bad', tip: g } : { ...(typeof seg === 'string' ? { text: seg } : seg), kind: 'bad' };
                }

                return { text: rich(tr('Pays '), amount, tr(' Gold to '), this.scopeSeg(field('target') ?? '?', ctx)), icon: 'gold', tone: 'bad' };
            }
            case 'send_interface_toast':
            case 'send_interface_message':
            {
                const title = field('title');
                const kids = block
                    ? this.effects(
                        block.filter((c) => !['type', 'title', 'desc', 'left_icon', 'right_icon', 'goto'].includes(c.k ?? '')),
                        ctx
                    )
                    : [];

                if (!title)
                    return kids.length ? { text: [tr('Notification:')], children: kids, icon: 'note' } : null;

                return { text: rich(tr('Notification “'), this.loc(title) ?? humanize(title), '”'), children: kids, icon: 'note' };
            }
            case 'add_to_guest_subset':
                return null;
            case 'remove_relation_flag':
                // (a flag on a relation, `flag = … target = … relation = …`: the relation itself stays)
                return {
                    text: rich(tr('Removes the mark '), this.codeSeg(field('flag') ?? '?'), tr(' from the '), this.relationSeg(field('relation') ?? '?'), tr(' relation with '), this.scopeSeg(field('target') ?? '?', ctx)),
                    icon: 'opinion'
                };
        }

        const setRel = /^(set|remove)_relation_(\w+)$/.exec(k);

        // (`set_relation_guardian = scope:guardian` in the ward's scope: the target becomes the scope's guardian,
        // effect_localization's THEY_GET_A_GUARDIAN)
        if (setRel)
        {
            const target = block ? (field('target') ?? '?') : v;
            return {
                text: rich(setRel[1] === 'set' ? tr('Gets ') : tr('No longer has '), this.scopeSeg(target, ctx), this.relationAs(setRel[2])),
                icon: 'opinion'
            };
        }

        return null;
    }

    private opinionValue(mod: string): number | undefined
    {
        const e = this.idx.get('opinion_modifiers', mod);

        if (!e)
            return undefined;

        const d = this.idx.defNode(e);
        const op = d && Array.isArray(d.node.v) ? d.node.v.find((c) => c.k === 'opinion') : undefined;
        return typeof op?.v === 'string' ? this.evalValue(op.v) : undefined;
    }

    /** The number of a script value written as `value = 1825` and then changed by modifiers: its base. */
    private baseValue(name: string): number | undefined
    {
        const e = this.idx.get('script_values', name);
        const d = e && this.idx.defNode(e);
        const base = d && Array.isArray(d.node.v) ? d.node.v.find((x) => (x.k === 'value' || x.k === 'base') && typeof x.v === 'string') : undefined;
        return typeof base?.v === 'string' ? this.evalValue(this.constOf(base.v, undefined, e ? this.idx.fileConstants(e) : undefined)) : undefined;
    }

    /**
     * A time written `years = 5` / `months = { 1 3 }` as words ("5 years", "1–3 months"); a negative one (`years = -1`: without end)
     * is no time at all (empty). `ctx`: the constants of the file.
     */
    duration(block: PNode[], ctx?: Ctx): string
    {
        const text = (unit: string, n: number): string =>
        {
            const args = { n: formatNumber(n) };
            return unit === 'years' ? trn('{n} year', '{n} years', n, args) : unit === 'months' ? trn('{n} month', '{n} months', n, args) : unit === 'weeks' ? trn('{n} week', '{n} weeks', n, args) : trn('{n} day', '{n} days', n, args);
        };

        const unitWord = (unit: string): string => (unit === 'years' ? tr('years') : unit === 'months' ? tr('months') : unit === 'weeks' ? tr('weeks') : tr('days'));

        for (const unit of ['years', 'months', 'weeks', 'days'])
        {
            const c = block.find((x) => x.k === unit);

            if (!c)
                continue;

            if (typeof c.v === 'string')
            {
                const raw = this.constOf(c.v, ctx);
                const n = this.evalValue(raw);

                if (n !== undefined)
                    return n < 0 ? '' : text(unit, n);

                // (a value worked out in the game: its base, if the script gives one)
                const base = this.baseValue(raw);
                return base !== undefined ? tr('about {time}, varying', { time: text(unit, base) }) : tr('{value} ({unit})', { value: humanize(raw), unit: unitWord(unit) });
            }

            const nums = c.v.filter((x) => x.k === null && typeof x.v === 'string').map((x) => x.v as string);

            if (nums.length === 2)
            {
                const [lo, hi] = nums.map((x) => this.evalValue(this.constOf(x, ctx)));

                if (lo !== undefined && hi !== undefined)
                    return lo === hi ? text(unit, lo) : `${formatNumber(lo)}–${text(unit, hi)}`;

                return `${nums[0]}–${nums[1]} ${unitWord(unit)}`;
            }
        }

        return '';
    }

    private stressImpact(block: PNode[], ctx: Ctx): LinePart
    {
        const parts: Rich = [];
        let tone: 'good' | 'bad' | undefined;

        for (const c of block)
        {
            if (!c.k || typeof c.v !== 'string')
                continue;

            const n = this.evalValue(c.v);
            const val: RichSeg = n !== undefined ? { text: signed(n), kind: n > 0 ? 'bad' : 'good', tip: c.v } : { text: humanize(c.v), kind: 'value', tip: c.v };

            if (parts.length)
                parts.push(', ');

            if (c.k === 'base')
                parts.push(val, ' base');
            else
                parts.push(val, ' if ', this.traitSeg(c.k));

            if (n !== undefined)
                tone = n > 0 ? 'bad' : 'good';
        }

        return { text: rich(tr('Stress: '), parts), icon: 'stress', tone, hidden: ctx.hidden };
    }

    private randomList(k: string, block: PNode[], ctx: Ctx, tip: string): Line
    {
        // (a weight given by the caller, `$WIN_CHANCE$ = { … }` in a scripted effect read on its own, reads as its name)
        const entries = block.filter((c) => c.k !== null && Array.isArray(c.v) && (NUMERIC.test(c.k) || PARAM_KEY.test(c.k) || this.evalValue(c.k) !== undefined || this.idx.get('script_values', c.k)));
        const weights = entries.map((c) => this.evalValue(c.k!) ?? 0);
        const known = entries.every((c) => !PARAM_KEY.test(c.k!));
        const total = known ? weights.reduce((a, b) => a + b, 0) : 0;
        // (a trigger that drops an entry, or a modifier that moves its weight, changes every entry's share, not only its own)
        const variable = entries.some((c) => (c.v as PNode[]).some((x) => x.k === 'trigger' || x.k === 'modifier' || x.k === 'opinion_modifier' || x.k === 'compare_modifier'));
        const children: Line[] = entries.map((c, i) =>
        {
            const body = c.v as PNode[];
            const pct = total > 0 ? Math.round((weights[i] / total) * 100) : 0;
            const chance = known ? `${variable ? '~' : ''}${pct}%` : PARAM_KEY.test(c.k!) ? tr('chance “{humanize}”', { humanize: humanize(c.k!.slice(1, -1).toLowerCase()) }) : tr('weight {k}', { k: c.k });
            const descNode = body.find((x) => x.k === 'desc');
            const desc = typeof descNode?.v === 'string' ? this.loc(descNode.v) : undefined;
            const trig = body.find((x) => x.k === 'trigger');
            const conds = trig && Array.isArray(trig.v) ? this.triggers(trig.v, ctx) : [];
            const kids = this.effects(
                body.filter((x) => !['modifier', 'opinion_modifier', 'compare_modifier', 'trigger', 'desc', 'show_chance', 'min', 'max', 'ai_value_modifier'].includes(x.k ?? '')),
                this.withWhen(ctx, desc ? rich(chance + ': ', desc) : tr('{chance} chance', { chance }))
            );
            // (what makes it likelier: its modifier blocks, read as a weight)
            const mods = body.filter((x) => x.k === 'modifier' || x.k === 'opinion_modifier' || x.k === 'compare_modifier' || x.k === 'ai_value_modifier');
            const weight = mods.length && this.weightReader ? this.weightReader(mods, ctx) : [];

            // (an outcome with no effects, the "nothing happens" share of the list: said, not left as a bare percentage;
            // one whose effects are all behind the scenes shows the player nothing either)
            if (!kids.length)
                kids.push({ text: [tr('Nothing happens')], placeholder: true });
            else if (kids.every((x) => x.hidden))
                kids.unshift({ text: [tr('Nothing the player sees')], placeholder: true });

            // (one change of the weight in the line itself: "Likelier or less likely: +4 if …", not a fold with a bare marker)
            if (weight.length === 1 && !weight[0].children?.length && !weight[0].conditions?.length)
                kids.unshift({ ...weight[0], text: rich(tr('Likelier or less likely: '), weight[0].text), icon: 'chance' });
            else if (weight.length)
                kids.unshift({ text: [tr('Likelier or less likely:')], icon: 'chance', children: weight, collapsed: true });

            const l: Line = { text: rich({ text: chance, kind: 'value', tip: tr('weight {k}', { k: c.k }) }, desc ? rich(': ', desc) : ''), icon: 'chance', conditions: conds.length ? conds : undefined, children: kids };

            if (ctx.file)
                l.src = this.anchor(c, ctx, 'effect', true);

            return l;
        });
        const head = k === 'duel' ? this.duelHead(block, ctx) : [tr('One of these outcomes:')];
        return { text: head, icon: 'chance', children, tip };
    }

    /**
     * A duel's head: what it compares (`skill`, `skills` averaged, `challenge_variable(s)`) against whom (`target`) or
     * what (`value`). Without a skill there is no default: the `value` is the duel value itself.
     */
    private duelHead(block: PNode[], ctx: Ctx): Rich
    {
        const one = (key: string): string | undefined =>
        {
            const c = block.find((x) => x.k === key);
            return typeof c?.v === 'string' ? c.v : undefined;
        };
        const many = (key: string): string[] =>
        {
            const c = block.find((x) => x.k === key);
            return Array.isArray(c?.v) ? c.v.filter((x) => x.k === null && typeof x.v === 'string').map((x) => x.v as string) : [];
        };
        const skills: RichSeg[] = [
            ...[one('skill'), ...many('skills')].filter((x): x is string => !!x).map((x) => this.valueSeg(x, ctx)),
            ...[one('challenge_variable'), ...many('challenge_variables')].filter((x): x is string => !!x).map((x) => this.codeSeg(x, 'variable', 'Variable'))
        ];
        const valueNode = block.find((x) => x.k === 'value');
        const value: RichSeg | undefined = !valueNode ? undefined : typeof valueNode.v === 'string' ? this.valueSeg(valueNode.v, ctx) : tr('a worked-out value');
        const target = one('target');

        if (!skills.length)
            return value ? rich(tr('Duel decided by the value '), value, ':') : [tr('Duel:')];

        const what = skills.length > 1 ? rich(tr('average of '), ...skills.flatMap((x, i): Rich => [i ? ', ' : '', x])) : rich(skills[0]);
        const against = target ? rich(tr(' against '), this.scopeSeg(target, ctx)) : value ? rich(tr(' against the value '), value) : '';
        return rich(tr('Duel ('), what, ')', against, ':');
    }

    private triggerEvent(n: PNode, block: PNode[] | null, v: string, ctx: Ctx, tip: string): Line | null
    {
        let id = v;
        let onAction: string | undefined;
        let delay = '';

        if (block)
        {
            // (`ID = …` in some vanilla on_actions: keys in any case)
            const f = (k: string): PNode | undefined => block.find((c) => c.k?.toLowerCase() === k);
            id = typeof f('id')?.v === 'string' ? (f('id')!.v as string) : '';
            onAction = typeof f('on_action')?.v === 'string' ? (f('on_action')!.v as string) : undefined;
            const d = this.duration(block, ctx);

            // (or a date: `trigger_on_next_date = "1100.1.1"`, `"3.1"` the next time that day comes; `delayed = yes` the next day's tick)
            const date = typeof f('trigger_on_next_date')?.v === 'string' ? (f('trigger_on_next_date')!.v as string).replace(/"/g, '') : undefined;

            if (d)
                delay = 'in ' + d;
            else if (date)
                delay = /^\d+\.\d+$/.test(date) ? tr('on the next {date} (month.day)', { date }) : tr('on {date}', { date });
            else if (f('delayed')?.v === 'yes')
                delay = tr('on the next day');
        }

        const target: EntityKey | undefined = onAction ? { type: 'on_action', name: onAction } : id ? { type: 'events', name: id } : undefined;

        // (saved_event_id = scope:x: an event saved earlier; which one is only known when it runs)
        if (!target && block?.some((c) => c.k === 'saved_event_id'))
            return { text: rich(tr('Leads to an event chosen elsewhere'), scopeName(ctx) !== 'you' ? tr(' (for {scope})', { scope: scopeName(ctx) }) : ''), icon: 'event', tip, hidden: ctx.hidden };

        if (!target)
            return null;

        const e = this.idx.get(target.type, target.name);
        const label = e ? (this.idx.displayName(e) ?? (onAction ? capitalize(humanize(onAction)) : id)) : target.name;
        const followUp: FollowUp = {
            target,
            label: label ?? target.name,
            delay: delay || undefined,
            when: ctx.when,
            who: scopeName(ctx) === 'you' ? undefined : capitalize(scopeName(ctx)),
            hidden: ctx.hidden
        };
        this.lead(ctx, followUp);
        return {
            followUp,
            text: rich(
                onAction ? tr('Something may happen: ') : tr('Leads to '),
                e ? this.entitySeg(e) : (this.pendingSeg(target.name) ?? { text: target.name, kind: 'code' }),
                scopeName(ctx) !== 'you' ? tr(' (for {scope})', { scope: scopeName(ctx) }) : '',
                delay ? ` ${delay}` : ''
            ),
            icon: 'event',
            tip,
            hidden: ctx.hidden
        };
    }

    private scriptedEffect(e: Entity, call: PNode, block: PNode[] | null, ctx: Ctx, tip: string): Line | Line[] | null
    {
        const custom = this.effectLocText(e.name);
        const expandable = ctx.expand > 0 && !ctx.stack.includes(e.name);

        this.meet(e, ctx);

        // (the lines are shared with the same call read elsewhere: nothing below changes them)
        const inner = expandable ? this.expandEffect(e, block ? argsOf(block) : undefined, ctx, call) : [];
        const allHidden = inner.length > 0 && inner.every((l) => l.hidden);
        const events = this.eventArgs(e, block, ctx);

        // The game shows the contents of scripted effects inline; do the same unless the effect has its own
        // tooltip text or is too big to read inline.
        if (!custom && inner.length > 0 && countsUpTo(inner, INLINE_LIMIT))
            return [...inner.map((l) => (ctx.hidden ? { ...l, hidden: true } : l)), ...events];

        const line: Line = {
            text: custom ?? this.callHead(e, block, ctx),
            children: inner.length ? inner : undefined,
            collapsed: true,
            group: { type: e.type, name: e.name },
            tip,
            hidden: ctx.hidden || allHidden
        };
        return events.length ? [line, ...events] : line;
    }

    /**
     * Events handed to a scripted effect as arguments (`OUTPUT_EVENT = hold_court.6101`, `ARRIVAL_EVENT = …`): the effect fires
     * them later (single combat, board games, travel plans, scheme moments, contracts). Each is a follow-up of the caller, as
     * a trigger_event would be, unless the effect's own lines already led to it.
     */
    private eventArgs(e: Entity, block: PNode[] | null, ctx: Ctx): Line[]
    {
        const out: Line[] = [];

        for (const c of block ?? [])
        {
            if (!c.k || typeof c.v !== 'string' || !/EVENT|_event(_id)?$/i.test(c.k))
                continue;

            const ev = this.idx.get('events', c.v);

            if (!ev)
                continue;

            // (what is led to depends on the list so far: an expansion around is not shared)
            if (ctx.trace)
                ctx.trace.tainted = true;

            if (ctx.followUps.some((f) => f.target.type === 'events' && f.target.name === c.v))
                continue;

            const followUp: FollowUp = {
                target: { type: 'events', name: c.v },
                label: this.idx.displayName(ev) ?? c.v,
                when: ctx.when,
                who: scopeName(ctx) === 'you' ? undefined : capitalize(scopeName(ctx)),
                hidden: ctx.hidden
            };
            this.lead(ctx, followUp);
            out.push({
                followUp,
                text: rich(tr('Leads to '), this.entitySeg(ev), ' (', capitalize(humanize(e.name)), ', ', humanize(c.k.toLowerCase()), ')'),
                icon: 'event',
                tip: e.name,
                hidden: ctx.hidden
            });
        }

        return out;
    }

    // -------------------------------------------------------------------------
    // Modifiers (stat blocks)
    // -------------------------------------------------------------------------

    private format(key: string): Record<string, string> | null
    {
        let f = this.formatCache.get(key);

        if (f !== undefined)
            return f;

        f = null;
        const e = this.idx.get('modifier_definition_formats', key);
        const def = e && this.idx.winningDef(e);

        if (def)
        {
            const kept = FORMATS.get(def);

            if (kept !== undefined)
                f = kept;
            else
            {
                const d = this.idx.defNode(e!);

                if (d && Array.isArray(d.node.v))
                {
                    f = {};

                    for (const c of d.node.v)
                        if (c.k && typeof c.v === 'string')
                            f[ownCopy(c.k)] = ownCopy(c.v);
                }

                FORMATS.set(def, f);
            }
        }

        this.formatCache.set(key, f);
        return f;
    }

    /** Is this key a modifier stat (diplomacy, monthly_prestige_gain_mult, …)? */
    isModifierKey(key: string): boolean
    {
        return this.format(key) !== null || this.idx.locRaw('MOD_' + key.toUpperCase()) !== undefined;
    }

    /**
     * How a stat modifier reads (modifier_definition_formats, MOD_<KEY>): its name, percent or not, decimals, whether a
     * positive value is good; hidden ones are not shown in game.
     */
    modifierFormat(key: string): { label: string; percent: boolean; alreadyPercent: boolean; decimals: number; color: 'good' | 'bad' | 'neutral'; hidden: boolean; }
    {
        const fmt = this.format(key) ?? {};
        const label = this.plainText(this.idx.plainLoc('MOD_' + key.toUpperCase()) ?? this.idx.plainLoc(key) ?? capitalize(humanize(key))).trim();
        const percent = fmt.percent === 'yes' || (!fmt.percent && /_mult$/.test(key));
        const color = fmt.color === 'bad' || fmt.color === 'neutral' ? fmt.color : 'good';
        return {
            label: capitalize(label),
            percent,
            alreadyPercent: fmt.already_percent === 'yes',
            decimals: fmt.decimals !== undefined ? parseInt(fmt.decimals) : percent ? 0 : 2,
            color,
            hidden: fmt.hidden === 'yes'
        };
    }

    statLine(key: string, raw: string): Line | null
    {
        const fmt = this.modifierFormat(key);

        if (fmt.hidden)
            return null;

        const num = this.evalValue(raw);
        const label = fmt.label;

        if (num === undefined)
            return { text: rich(label, ': ', { text: humanize(raw), kind: 'value', tip: raw }), tip: `${key} = ${raw}` };

        const percent = fmt.percent;
        const shown = percent ? num * 100 : num;
        const decimals = fmt.decimals;
        const valueText = signed(Number(shown.toFixed(decimals)), decimals) + (percent || fmt.alreadyPercent ? '%' : '');
        const color = fmt.color;
        const good = color === 'neutral' ? undefined : (num > 0) === (color !== 'bad');
        return {
            text: rich({ text: valueText, kind: good === undefined ? 'value' : good ? 'good' : 'bad' }, ' ', label.trim()),
            tone: good === undefined ? undefined : good ? 'good' : 'bad',
            tip: `${key} = ${raw}`
        };
    }

    /**
     * Stat lines of a block: direct stat keys, plus nested *_modifier blocks as groups. `ctx`: the nodes are a
     * definition's own text: the lines get anchors.
     */
    statsOf(nodes: PNode[], ctx?: Ctx): Line[]
    {
        const out: Line[] = [];

        for (const c of nodes)
        {
            if (!c.k)
                continue;

            if (typeof c.v === 'string')
            {
                const v = this.constOf(c.v, ctx);

                if ((NUMERIC.test(v) || this.idx.get('script_values', v)) && this.isModifierKey(c.k))
                {
                    const l = this.statLine(c.k, v);

                    if (l && ctx?.file)
                        l.src = this.anchor(c, ctx, 'modifier', false);

                    if (l)
                        out.push(l);
                }
            }
            else if (/_modifier$/.test(c.k) && c.k !== 'ai_value_modifier')
            {
                const inner = this.statsOf(c.v, ctx);

                if (!inner.length)
                    continue;

                const param = c.v.find((x) => x.k === 'parameter');
                const who = capitalize(humanize(c.k.replace(/_modifier$/, '')));
                // (faith_character_modifier / doctrine_character_modifier take a doctrine (lifestyle and dynasty perks, situations))
                const doctrine = c.k === 'faith_character_modifier' || c.k === 'doctrine_character_modifier' ? c.v.find((x) => x.k === 'doctrine') : undefined;
                const label = typeof doctrine?.v === 'string'
                    ? rich(tr('If their faith has '), this.doctrineSeg(doctrine.v), ':')
                    : typeof param?.v === 'string' ? rich(tr('If '), who.toLowerCase(), tr(' has “'), humanize(param.v), '”:') : [who + ':'];
                const l: Line = { text: label, children: inner, icon: 'modifier', tip: c.k };

                if (ctx?.file)
                    l.src = this.anchor(c, ctx, 'modifier', true);

                // (what its modifiers apply to: the picker offers those: county_modifier → a county's)
                const applies = modifierScopeOf(c.k, ctx?.entityType);

                if (l.src && applies)
                    l.src = { ...l.src, innerScope: applies };

                out.push(l);
            }
        }

        return out;
    }

    modifierStats(e: Entity): Line[]
    {
        const d = this.idx.defNode(e);
        return d && Array.isArray(d.node.v) ? this.statsOf(d.node.v) : [];
    }

    /** Loc text as a single readable string (placeholders humanized). */
    plainText(t: string): string
    {
        return richToString(locToRich(t, this.lookupDisplay)).replace(/\s+/g, ' ');
    }

    richString(r: Rich): string
    {
        return richToString(r);
    }
}

/**
 * A definition's text with `$PARAM$`s filled in (as GameIndex.defNode fills them) and the map of its offsets back to
 * the text as written: offsets before, between and after the filled-in parameters shift; the start and end of one map
 * to the start and end of its `$PARAM$` (inside one (no statement starts there) to its start).
 */
function filledMap(own: string, args: Record<string, string>): { text: string; map: (o: number) => number; }
{
    const reps: { os: number; oe: number; ns: number; ne: number; }[] = [];
    let delta = 0;
    const text = own.replace(/\$([^$\s]+)\$/g, (m: string, k: string, at: number) =>
    {
        const v = args[k];

        if (v === undefined)
            return m;

        reps.push({ os: at, oe: at + m.length, ns: at + delta, ne: at + delta + v.length });
        delta += v.length - m.length;
        return v;
    });
    const map = (o: number): number =>
    {
        let shift = 0;

        for (const r of reps)
        {
            if (o < r.ns)
                break;

            if (o <= r.ne)
                return o === r.ne && r.ne > r.ns ? r.oe : r.os;

            shift = r.oe - r.ne;
        }

        return o + shift;
    };
    return { text, map };
}

function argsOf(block: PNode[]): Record<string, string>
{
    const args: Record<string, string> = {};

    for (const c of block)
        if (c.k && typeof c.v === 'string')
            args[c.k] = c.v;

    return args;
}

/** A comparison and its opposite (an iterator's count inside NOT). */
function negateOp(op: string): string
{
    return ({ '>': '<=', '>=': '<', '<': '>=', '<=': '>', '=': '!=', '==': '!=', '!=': '=' } as Record<string, string>)[op] ?? op;
}

const COUNT_WORDS: Record<string, string> = { '>': tr('More than'), '>=': tr('At least'), '<': tr('Fewer than'), '<=': tr('At most'), '=': 'Exactly', '==': 'Exactly', '!=': tr('Not exactly') };

/**
 * The head of an `any_` iterator's line for its `count` with any operator (`count > 0`: any, `count = 0` / `count < 1`:
 * none, `count >= 3`, `count = all` …); `neg`: inside NOT (the opposite comparison). `many`: the noun is plural.
 */
function countHead(op0: string, v: string, what: string, neg: boolean): { head: string; many: boolean; }
{
    const op = neg ? negateOp(op0) : op0;

    if (v === 'all')
        return { head: op === '!=' ? tr('Not every {what}', { what }) : tr('Every {what}', { what }), many: false };

    const n = Number(v);

    if (!Number.isFinite(n))
        return { head: `${COUNT_WORDS[op] ?? op} “${humanize(v)}” ${plural(what)}`, many: true };

    // (at least one / none, however it is written)
    const least = op === '>' ? n + 1 : op === '>=' ? n : op === '!=' && n === 0 ? 1 : undefined;
    const most = op === '<' ? n - 1 : op === '<=' ? n : undefined;

    if (least !== undefined && least <= 0)
        return { head: tr('Any number of {plural} (also none)', { plural: plural(what) }), many: true };

    if (least === 1)
        return { head: tr('Any {what}', { what }), many: false };

    if ((most !== undefined && most <= 0) || ((op === '=' || op === '==') && n === 0))
        return { head: most !== undefined && most < 0 ? tr('Never (fewer than {v} {plural})', { v, plural: plural(what) }) : tr('No {what}', { what }), many: false };

    if ((op === '=' || op === '==') && n === 1)
        return { head: tr('Exactly one {what}', { what }), many: false };

    return { head: `${COUNT_WORDS[op] ?? op} ${v} ${plural(what)}`, many: true };
}

function negateCompare(op: string): string
{
    switch (op)
    {
        case '>=':
            return tr('is less than');
        case '>':
            return tr('is at most');
        case '<=':
            return tr('is more than');
        case '<':
            return tr('is at least');
        case '!=':
            return 'is';
        default:
            return tr('is not');
    }
}

export function lowerFirst(r: Rich): Rich
{
    if (!r.length)
        return r;

    const [first, ...rest] = r;

    if (typeof first === 'string')
        return [first.charAt(0).toLowerCase() + first.slice(1), ...rest];

    if (first.kind === 'scope' || first.kind === 'entity')
        return r;

    return [{ ...first, text: first.text.charAt(0).toLowerCase() + first.text.slice(1) }, ...rest];
}

/** Plural of the last word of an iterator label: child → children, county → counties, vassal → vassals. */
function plural(label: string): string
{
    // (a phrase's head noun: "titles in the de jure hierarchy", "rites of the faith", not "title in the de jure hierarchies")
    const phrase = /^(.*?\w)( (?:in|of|on|at|from|under|with|within|above|below) .*)$/.exec(label);

    if (phrase)
        return plural(phrase[1]) + phrase[2];

    return label.replace(/(\w+)$/, (w) =>
    {
        const irregular: Record<string, string> = { child: 'children', person: 'people', man: 'men', woman: 'women', ally: 'allies' };

        if (irregular[w])
            return irregular[w];

        if (/[^aeiou]y$/.test(w))
            return w.slice(0, -1) + 'ies';

        if (/(s|x|z|ch|sh)$/.test(w))
            return w + 'es';

        return w + 's';
    });
}

/**
 * trigger_if / trigger_else pairs inside a condition: `trigger_else = { always = yes }` is what a trigger_if does
 * anyway (dropped); `trigger_else = { always = no }` turns the pair into "limit and body".
 */
function simplifyTriggerIf(lines: Line[]): Line[]
{
    const out: Line[] = [];

    for (let i = 0; i < lines.length; i++)
    {
        const l = lines[i];
        const next = lines[i + 1];
        const only = next?.icon === 'else' && next.children?.length === 1 && !next.children[0].children?.length ? next.children[0].text : null;
        const word = only?.length === 1 ? only[0] : undefined;

        if (l.icon === 'if' && l.ifConds && !String(l.text[0]).startsWith(tr('Otherwise')) && (word === tr('Always') || word === tr('Never')))
        {
            if (word === tr('Always'))
                out.push(l);
            else
                out.push(...l.ifConds, ...(l.children ?? []));

            i++;
            continue;
        }

        out.push(l);
    }

    return out;
}

/** Drops a trailing ":" (group labels) so a line can sit inside a sentence. */
function stripColon(r: Rich): Rich
{
    const last = r[r.length - 1];

    if (typeof last !== 'string' || !last.endsWith(':'))
        return r;

    const t = last.slice(0, -1);
    return t ? [...r.slice(0, -1), t] : r.slice(0, -1);
}

/** "a", "a and b", "a, b and c" */
function joinList(parts: Rich[], last: string): Rich
{
    const out: Rich = [];
    parts.forEach((p, i) =>
    {
        if (i > 0)
            out.push(i === parts.length - 1 ? last : last === '; ' ? '; ' : ', ');

        out.push(...p);
    });
    return rich(out);
}

function countLeaves(lines: Line[]): number
{
    return lines.reduce((n, l) => n + (l.children?.length ? countLeaves(l.children) : 1), 0);
}

/** Present tense for "you": Is → are, Has → have, Holds → hold, Reaches → reach. */
function youVerb(word: string): string
{
    const w = word.toLowerCase();
    const irregular: Record<string, string> = { is: 'are', has: 'have', was: 'were', does: 'do' };

    if (irregular[w])
        return irregular[w];

    if (/(ch|sh|ss|x|z)es$/.test(w))
        return w.slice(0, -2);

    if (/ies$/.test(w))
        return w.slice(0, -3) + 'y';

    return w.endsWith('s') ? w.slice(0, -1) : w;
}

const MODAL_VERBS = new Set(['Is', 'Has', 'Was', 'Does', 'Can', 'Could', 'Will', 'Would', 'Had', 'Did', 'Must', 'Should']);
/** Sentence starts that already carry their own subject or are not about the scope. */
const OWN_SUBJECT = new Set(['You', 'Your', 'They', 'Their', 'It', 'The', 'A', 'An', 'This', 'That', 'Any', 'Every', 'No', 'None', 'Not', 'At', 'Fewer', 'Always', 'Never', 'Variable', 'Game', 'Otherwise']);

/**
 * Puts a subject in front of a condition line: "Has the trait X" → "you have the trait X" / "Lover has the trait X";
 * noun phrases become possessive: "Opinion of Y is more than 20" → "your opinion of Y …" / "Lover’s opinion …".
 * Lines that start with their own subject ("First Lover exists") stay as they are.
 */
function withSubject(text: Rich, subject: RichSeg | null | 'plural'): Rich
{
    const [first, ...rest] = text;

    if (typeof first !== 'string')
        return text;

    const m = /^([A-Z][a-z]+)\b([\s\S]*)$/.exec(first);

    if (!m)
        return lowerFirst(text);

    const [, word, tail] = m;

    if (OWN_SUBJECT.has(word))
        return word === 'You' || word === 'Your' ? text : lowerFirst(text);

    const verb = MODAL_VERBS.has(word) || (/[^s]s$/.test(word) && !/(ous|is|us)$/.test(word));

    if (verb)
    {
        if (subject === null)
            return [word.toLowerCase() + tail, ...rest];

        if (subject === 'plural')
            return [youVerb(word) + tail, ...rest];

        if (subject === 'you')
            return rich(tr('you '), youVerb(word) + tail, rest);

        return rich(subject, ' ', word.toLowerCase() + tail, rest);
    }

    // noun phrase ("Opinion of …", "Faith is …", "Stress is at least …")
    if (subject === null)
        return lowerFirst(text);

    if (subject === 'plural')
        return rich(tr('their '), word.toLowerCase() + tail, rest);

    if (subject === 'you')
        return rich(tr('your '), word.toLowerCase() + tail, rest);

    // (a text that starts with the noun the subject ends on is about the subject itself: "Your rite" and "Rite has
    // doctrine: …" read "Your rite has doctrine: …", not "Your rite’s rite has …")
    const who = (typeof subject === 'string' ? subject : subject.text).trim();

    if (new RegExp(`(^|\\s)${word}$`, 'i').test(who))
        return rich(subject, tail, rest);

    return rich(subject, '’s ', word.toLowerCase() + tail, rest);
}

/**
 * The value an `order_by = { … }` block orders by when it is the order turned round (the lowest comes first): the
 * value times -1 (`value = age multiply = -1`) or taken from zero (`value = 0 subtract = age`); undefined for any
 * other block (a worked-out value stays "the best").
 */
export function lowestOf(v: unknown): string | undefined
{
    if (!Array.isArray(v))
        return undefined;

    const nodes = v as PNode[];
    const plain = (k: string): string | undefined => (nodes.filter((c) => c.k === k).length === 1 ? (typeof nodes.find((c) => c.k === k)!.v === 'string' ? (nodes.find((c) => c.k === k)!.v as string) : undefined) : undefined);
    const keys = nodes.map((c) => c.k);
    const value = plain('value');

    if (value !== undefined && keys.length === 2 && plain('multiply') === '-1')
        return value;

    const sub = plain('subtract');

    if (value === '0' && sub !== undefined && keys.length === 2)
        return sub;

    return undefined;
}

/** Keys that look like iterators but are none (a weighted choice, text / on_action lists). */
const NOT_ITERATORS = new Set(['random_list', 'random_valid', 'random_events', 'random_on_actions', 'random_on_action']);

const ITERATOR_PARAMS = new Set([
    'limit',
    'order_by',
    'max',
    'min',
    'position',
    'check_range_bounds',
    'weight',
    'alternative_limit',
    'type',
    'even_if_dead',
    'only_if_dead',
    'include_self',
    'filter',
    'relation',
    'province',
    // (a kept list's name: `every_in_list = { list = target_titles }`, read with the head: Describer.listKeys)
    'list',
    'variable',
    // (and the keys the catalog gives lists: region, name, artifact_slot_type, involvement …)
    ...ITERATORS.flatMap((i) => i.params ?? []).map((p) => p.key)
]);

const GROUP_ICONS = new Set(['if', 'else', 'scope', 'loop']);

/** Drops empty groups and marks groups hidden when everything inside them is hidden. */
function finalize(l: Line): Line | null
{
    // (an empty if / else a mod writes stays: it is being written)
    if (l.children && l.children.length === 0 && GROUP_ICONS.has(l.icon ?? '') && !((l.icon === 'if' || l.icon === 'else') && l.src?.mod))
        return null;

    if (l.children?.length && l.children.every((c) => c.hidden))
        return { ...l, hidden: true };

    return l;
}

/** Scripted effects with up to this many lines are shown inline instead of as a collapsed group. */
const INLINE_LIMIT = 12;

/** do the lines (and their children) number `limit` at most? (stops counting past it: a shared expansion may hold thousands) */
function countsUpTo(lines: Line[], limit: number): boolean
{
    let n = 0;
    const count = (ls: Line[]): boolean =>
    {
        for (const l of ls)
        {
            if (++n > limit || (l.children && !count(l.children)))
                return false;
        }

        return true;
    };
    return count(lines);
}

/** the most lines a list of effects lists in full: an effect called from many places repeats, and a card of 100,000 lines reads as none */
const LINE_BUDGET = 5000;
/** a collapsed group of this many lines (itself included) or fewer is kept whole past the budget ... */
const SMALL_GROUP = 8;
/** ... for this many lines in all (calls by the hundred would else bring the card over its budget again) */
const SMALL_SLACK = 500;
/** the most cut groups the describer keeps for "Show them here" (Describer.moreLines) */
const CUT_KEPT = 2000;
/**
 * The most lines the scripted effects kept to be read once hold (see Describer.expandEffect), while a list of effects is read:
 * AGOT's start-of-game on_action calls 12,000 different ones (one per scope), 1.5 million lines of them in this count (a line
 * of an expansion inside another counts for both), 900 MB with their anchors; past it all are let go.
 */
const MAX_EXPANSION_LINES = 300000;
/** what is kept once the list of effects is read: past it all are let go (the next card reads again what it calls) */
const KEPT_EXPANSION_LINES = 60000;

/** Trigger blocks holding conditions (besides iterators and scope switches): statements are added inside them. */
const TRIGGER_BLOCKS = new Set(['AND', 'OR', 'NOT', 'NOR', 'NAND', 'trigger_if', 'trigger_else_if', 'trigger_else', 'calc_true_if', 'custom_description', 'custom_description_no_bullet', 'custom_tooltip']);
/** Effect blocks holding effects (besides iterators and scope switches). */
const EFFECT_BLOCKS = new Set(['if', 'else_if', 'else', 'hidden_effect', 'show_as_tooltip', 'custom_tooltip', 'custom_description', 'custom_description_no_bullet', 'random', 'send_interface_message', 'send_interface_toast']);

/** The picker's catalog of links (scriptCatalog.ts LINKS) and where each leads: the one table; SCOPE_LINKS keeps the scope keywords and `councillor`. */
// (rebuilt when the script database's facts change LINKS: src/shared/scriptFacts.ts)
const CATALOG_LINKS = new Map<string, string>();
const fillCatalogLinks = (): void =>
{
    CATALOG_LINKS.clear();

    for (const l of LINKS)
        if (l.key !== 'root')
            CATALOG_LINKS.set(l.key, l.to);
};
fillCatalogLinks();
onFactsApplied(fillCatalogLinks);

/**
 * `prev.prev` (prev after prev, anywhere in a chain) is refused at load: "Link 'prev' is a global link but follows a
 * 'prev' link", and the statement does not run (in-game test 2026-11-12, docs/ck3-script-format.md). A scope written
 * so reads as written, marked (`withPath`); a statement whose value is one gets the mark after its line.
 */
const PREV_PREV = /(^|\.)prev\.prev(\.|$)/;

const refusedPrevTip = (): string => tr('The game refuses prev after prev (error.log: “Link \'prev\' is a global link but follows a \'prev\' link”), so this does not run');

function refusedPrev(path: string, withPath: boolean): RichSeg
{
    return { text: withPath ? tr('{path} (refused by the game)', { path }) : tr('(refused by the game: {path})', { path }), kind: 'bad', tip: refusedPrevTip() };
}

/** the mark after a statement whose own value is a `prev.prev` chain, unless its line shows it marked already */
function markRefusedPrev(n: PNode, l: Line): void
{
    const tip = refusedPrevTip();

    if (typeof n.v !== 'string' || !PREV_PREV.test(n.v) || l.text.some((s) => typeof s !== 'string' && s.kind === 'bad' && s.tip === tip))
        return;

    l.text = rich(l.text, ' ', refusedPrev(n.v, false));
}

/** "you" → "your", "the child" → "the child’s", "Wales" → "Wales’" */
function possessive(who: string): string
{
    if (/^you$/i.test(who))
        return who[0] === 'Y' ? 'Your' : 'your';

    if (/^the[ym]$/i.test(who))
        return who[0] === 'T' ? 'Their' : 'their';

    return who.endsWith('s') ? who + '’' : who + '’s';
}

/** Database prefixes that lead to a scope (`title:k_france = { … }`). */
/** Objects of the game's text templates (`[FAITH.GetName]`, `[TARGET_TITLE.GetName]`) and the entry types they are. */
const LOC_OBJECT_TYPES: Record<string, string[]> = {
    FAITH: ['faith'],
    RELIGION: ['religion/religion_types'],
    RITE: ['religion/rite_types'],
    DOCTRINE: ['religion/doctrine_types'],
    TENET: ['religion/tenet_types'],
    CULTURE: ['culture/cultures'],
    TRADITION: ['culture/traditions'],
    INNOVATION: ['culture/innovations'],
    TITLE: ['landed_titles'],
    LANDED_TITLE: ['landed_titles'],
    TRAIT: ['traits'],
    DYNASTY: ['dynasties'],
    HOUSE: ['dynasty_houses'],
    DYNASTY_HOUSE: ['dynasty_houses'],
    GOVERNMENT: ['governments'],
    LEGITIMACY: ['legitimacy'],
    LAW: ['laws'],
    BUILDING: ['buildings'],
    MODIFIER: ['modifiers'],
    NICKNAME: ['nicknames'],
    FOCUS: ['focuses'],
    PERK: ['lifestyle_perks'],
    LIFESTYLE: ['lifestyles'],
    SECRET: ['secret_types'],
    SCHEME: ['schemes/scheme_types'],
    ACTIVITY: ['activities/activity_types'],
    COURT_POSITION: ['court_positions/types'],
    HOLY_SITE: ['religion/holy_site_types'],
    MEN_AT_ARMS: ['men_at_arms_types'],
    DECISION: ['decisions']
};

/** Statements whose plain value names an entry and that CONTEXT_RULES (the indexer's) does not list: the effect `replace_building_effect = <building>` (an effect of the 1.20 game's own, used by great projects). */
const EXTRA_CONTEXT_RULES: Record<string, string[]> = { replace_building_effect: ['buildings'] };

// (struggle:x, situation:x, doctrine:x, culture_tradition:x name an entry that is a scope of its own type; activity_tenet:1 / activity_doctrine:1 are an activity's; top_participant_group:<situation> is the situation's top group)
const PREFIX_SCOPES: Record<string, string> = {
    character: 'character',
    title: 'landed_title',
    faith: 'faith',
    culture: 'culture',
    dynasty: 'dynasty',
    house: 'dynasty_house',
    province: 'province',
    religion: 'religion',
    rite: 'rite',
    tenet: 'tenet',
    struggle: 'struggle',
    situation: 'situation',
    top_participant_group: 'participant_group',
    doctrine: 'doctrine',
    culture_tradition: 'tradition',
    activity_tenet: 'tenet',
    activity_doctrine: 'doctrine'
};

/** the scope types each statement key of the catalog runs in (effects and triggers alike); null: any (no evidence) */
let statementScopes: Map<string, Set<string> | null> | undefined;

function scopesOfKey(k: string): Set<string> | null | undefined
{
    if (!statementScopes)
    {
        statementScopes = new Map();

        for (const d of STATEMENTS)
        {
            const key = /^(\w+)(?=[\s=<>!?]|$)/.exec(d.script)?.[1];

            if (!key)
                continue;

            const had = statementScopes.get(key);

            if (d.scopes === 'any' || !d.scopes.length || had === null)
                statementScopes.set(key, null);
            else
                statementScopes.set(key, new Set([...(had ?? []), ...d.scopes]));
        }
    }

    return statementScopes.get(k);
}

/** blocks whose statements run in the scope around them (scopeTypeByUse reads into them) */
const SAME_SCOPE_BLOCKS = /^(if|else_if|else|trigger_if|trigger_else_if|trigger_else|limit|AND|OR|NOT|NOR|NAND|hidden_effect|show_as_tooltip|custom_tooltip|custom_description|random|calc_true_if)$/;

/**
 * The scope type a block's own statements say it runs in (round 13, the owner's decision for a saved scope nothing
 * saves, documents or passes in: docs/readable-view.md, "Guessed scope types"): each statement the catalog knows
 * (STATEMENTS' scopes), each link (`holder = …`, `holder.liege = { … }`: LINKS' from) and each iterator (ITERATORS'
 * from) written in it, also inside if / limit / AND … blocks, names the types it fits; the one type all of them fit,
 * else undefined (none known, none in common, or several). A guess, never a check: keys the catalog does not know say
 * nothing.
 */
export function scopeTypeByUse(block: PNode[]): string | undefined
{
    let fit: Set<string> | undefined;
    const narrow = (types: Iterable<string>): void =>
    {
        const t = new Set(types);
        fit = fit ? new Set([...fit].filter((x) => t.has(x))) : t;
    };
    const walk = (nodes: PNode[]): void =>
    {
        for (const n of nodes)
        {
            const k = n.k;

            if (!k || fit?.size === 0)
                continue;

            if (SAME_SCOPE_BLOCKS.test(k))
            {
                if (Array.isArray(n.v))
                    walk(n.v);

                continue;
            }

            const s = scopesOfKey(k);

            if (s)
            {
                narrow(s);
                continue;
            }

            if (s === null)
                continue;

            const it = /^(any|every|random|ordered)_(\w+)$/.exec(k);
            const list = it && ITERATORS.find((i) => i.list === it[2]);

            if (list)
            {
                if (list.from.length)
                    narrow(list.from);

                continue;
            }

            const first = k.split('.')[0];
            const links = /^\w+$/.test(first) && first !== 'root' && first !== 'prev' && first !== 'this' ? LINKS.filter((l) => l.key === first) : [];

            if (links.length && links.every((l) => l.from.length))
                narrow(links.flatMap((l) => l.from));
        }
    };
    walk(block);
    const found = fit as Set<string> | undefined;
    return found?.size === 1 ? [...found][0] : undefined;
}

/**
 * Scope type of a scope switch, link by link: `liege = { }` → character, `primary_title.holder` → character, `root` → the
 * script's root (`ctx.rootType`), `scope:x` → what the script saved there (`ctx.savedTypes`), else what its name says
 * (`target_title` → a title; `actor` → a character), `title:x` → a title, `prev` (and `prev.prev` …) → the prev stack's
 * (`ctx.prevTypes`); undefined when not known (a `prev` with nothing known below it, `from`, variables, links the
 * describer does not know).
 */
function linkedScope(k: string, current?: string, ctx?: Ctx): string | undefined
{
    let at = current;
    const parts = k.split('.');
    // (how many `prev` led the chain so far: `prev` is the top of the prev stack, `prev.prev` the one below)
    let prevs = 0;
    let linked = false;

    for (let i = 0; i < parts.length; i++)
    {
        const part = parts[i];
        const prefix = /^(\w+):(.+)$/.exec(part);

        if (part === 'this')
            continue;

        if (part === 'prev' && !linked)
        {
            const stack = ctx?.prevTypes ?? [];
            at = stack[stack.length - 1 - prevs++];

            if (!at)
                return undefined;

            continue;
        }

        linked = true;

        if (part === 'prev' || part === 'from' || (prefix && i > 0))
            return undefined;

        if (part === 'root')
            at = ctx?.rootType ?? 'character';
        else if (prefix?.[1] === 'scope' || PARAM_KEY.test(part))
        {
            const name = prefix?.[2] ?? part.slice(1, -1).toLowerCase();
            const byName = scopeTypeByName(name);
            at = ctx?.savedTypes?.[name] ?? (byName === null ? undefined : (byName ?? 'character'));
        }
        else if (prefix && /^(var|local_var|global_var)$/.test(prefix[1]))
            // (a variable the script itself sets to a scope: Describer.variableTypes)
            at = ctx?.varTypes?.[part];
        else if (prefix)
            at = PREFIX_SCOPES[prefix[1]];
        else
            // (the catalog knows where its links lead (`domicile`, `current_travel_plan`, `involved_activity` …); the rest of SCOPE_LINKS lead to characters)
            at = CATALOG_LINKS.get(part) ?? (SCOPE_LINKS.has(part) ? 'character' : undefined);

        if (!at)
            return undefined;
    }

    return at;
}

/**
 * The prev stack inside a scope switch or an iterator (Ctx.prevTypes): the one around with the type of the scope left
 * on top, as far as it is known (ctx.scopeType; not guessed as a character: a scripted effect's own scope is its
 * caller's, which vanilla's local_arbitration_effect shows is a county there). `k`: the switch's key; a chain of links
 * (`liege.primary_title`) or a switch to `prev` itself pushes "not known", since whether the game puts each link of a
 * chain on the stack was not checked. `known` false: a block whose scope the game sets otherwise (create_character's):
 * "not known" too.
 */
export function pushPrev(ctx: Ctx, k?: string, known = true): (string | undefined)[]
{
    // (a type guessed from its block's use (Ctx.guess) is not pushed: nothing rests on a guess)
    const plain = known && (k === undefined || (!k.includes('.') && k !== 'prev')) && !isGuessed(ctx);
    return [...(ctx.prevTypes ?? []), plain ? ctx.scopeType : undefined];
}

/**
 * What an iterator's own statements are about: the label itself ("vassal"), or for one that walks this entry and its
 * relatives ("this title or one above it"), the kind of thing: "the title" ("the title's holder", not "This title or
 * one above it's holder").
 */
function itemScope(what: string): string
{
    return /^this /.test(what) ? tr('the {what}', { what: itemNoun(what) }) : itemNoun(what);
}

/**
 * What a switch switches on: `yes` "the situation" (each case a scope that holds or not); a chain link by link, a link
 * named after the one before it once ("great project type", not "great project great project type").
 */
function switchOn(key: string): string
{
    if (key === 'yes')
        return tr('the situation');

    const links = key.split('.').map((p) => humanize(p));
    let what = links[0];

    for (const p of links.slice(1))
    {
        const last = what.split('’s ').pop()!;
        what = p === last || p.startsWith(last + ' ') ? what.slice(0, what.length - last.length) + p : `${what}’s ${p}`;
    }

    return what;
}

/** An iterator label's item noun: "title" for "this title or one above it" and "title in the de jure hierarchy". */
function itemNoun(what: string): string
{
    const self = /^this (\w+)/.exec(what);
    const phrase = /^(.*?\w) (?:in|of|on|at|from|under|with|within|above|below) /.exec(what);
    return self ? self[1] : phrase ? phrase[1] : what;
}

/** Scope type of an iterator's items (`every_vassal` → character, `any_held_title` → landed_title): the picker's catalog, else by name. */
function iteratedScope(what: string): string
{
    const known = ITERATORS.find((i) => i.list === what);

    if (known)
        return known.to;

    if (/title|county|duchy|kingdom|empire|barony/.test(what))
        return 'landed_title';

    if (/province/.test(what))
        return 'province';

    if (/faith/.test(what))
        return 'faith';

    if (/culture/.test(what))
        return 'culture';

    if (/war\b|wars$/.test(what))
        return 'war';

    if (/scheme/.test(what))
        return 'scheme';

    if (/secret/.test(what))
        return 'secret';

    if (/artifact/.test(what))
        return 'artifact';

    if (/army|armies|regiment/.test(what))
        return 'army';

    if (/activit/.test(what))
        return 'activity';

    return 'character';
}

/** Keys inside triggers that only store scopes; nothing for a reader. */
const TRIGGER_SKIP = new Set(['save_temporary_scope_as', 'save_temporary_scope_value_as', 'save_scope_as', 'save_scope_value_as', 'debug_log']);

/** Every scope link the readable view knows (its own and the catalog's); scripts/update-audit.ts lists the others. */
export function knownLinks(): Set<string>
{
    return new Set([...SCOPE_LINKS, ...CATALOG_LINKS.keys()]);
}
