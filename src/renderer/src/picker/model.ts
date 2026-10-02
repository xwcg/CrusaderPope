/**
 * The statement picker's state machine (docs/picker.md): which menu a state shows, what each item leads to, and the
 * script built so far. Plain TypeScript over the catalog (shared/scriptCatalog.ts); the index data comes in through
 * `PickerData` (data.ts caches it). Picker.tsx renders the menus and keeps the history of states for stepping back.
 */
import type { EntryCreate, FieldSuggestion, LocCodes, ModifierKeyInfo, NewEntryPlan, PickTarget, ScriptKeyInfo } from '../../../shared/api.ts';
import { FIELDS, OPEN_SETS, bareField, durationKey, fieldOf, type FieldDef } from '../../../shared/fieldCatalog.ts';
import {
    COMPARE_OPTIONS,
    EFFECT_GROUPS,
    ITERATORS,
    LINKS,
    SAVED_SCOPES,
    SCOPE_LABELS,
    SCOPE_ORDER,
    STATEMENTS,
    TRIGGER_GROUPS,
    allParams,
    durationLabel,
    durationScript,
    fillTemplate,
    findStatement,
    parseSnippet,
    printScript,
    statementById,
    statementsFor,
    writtenKey,
    type ParamDef,
    type PickKind,
    type SNode,
    type ScopeLink,
    type ScopeType,
    type StatementDef
} from '../../../shared/scriptCatalog.ts';

export interface RefEntry
{
    name: string;
    display?: string;
    icon?: string;
    refs: number;
    /** loaded mods touching it (ModTouch): the active mod's entries are listed first */
    mod?: { state: string; mods: string[]; };
    /** who it is (a historical character: highest title, lifetime, id) */
    about?: string;
}

/** What the menus read from the index (cached by data.ts). */
export interface PickerData
{
    /** entries of an index type, most used first; undefined while loading (the load has started) */
    list(type: string): RefEntry[] | undefined;
    /** promise of the list above */
    loaded(type: string): Promise<unknown>;
    /** too many entries to list (characters): search as one types */
    big(type: string): boolean;
    search(type: string, q: string): Promise<RefEntry[]>;
    /** effect / trigger keys the loaded script uses (the "Other…" list); undefined while collecting */
    keys(kind: PickKind): ScriptKeyInfo[] | undefined;
    keysLoaded(): Promise<unknown>;
    /** every stat modifier, most used first; undefined while loading */
    modifiers(): ModifierKeyInfo[] | undefined;
    modifiersLoaded(): Promise<unknown>;
    /** values a text field offers (a field's `suggest`); undefined while loading */
    suggestions(source: string): FieldSuggestion[] | undefined;
    suggestionsLoaded(source: string): Promise<unknown>;
    /** the active mod's id (its entries come first in the lists) */
    activeMod(): string | undefined;
    /** the game's localization codes (mode 'loc'); undefined while scanning */
    locCodes(): LocCodes | undefined;
    locCodesLoaded(): Promise<unknown>;
    /** the names an event uses without saving them ("Pass along…"); undefined while loading */
    eventScopes?(event: string): { name: string; about?: string; }[] | undefined;
    eventScopesLoaded?(event: string): Promise<unknown>;
    /** where a new entry of a type would go in the active mod (api.newEntryPlan: "＋ New trait…"); undefined while loading */
    newPlan?(type: string): NewEntryPlan | undefined;
    newPlanLoaded?(type: string): Promise<unknown>;
}

/** What is built: effects, conditions, stat modifiers (`diplomacy = 2`) or the fields of a definition. */
export type Mode = PickKind | 'modifier' | 'field' | 'loc';

export interface Item
{
    label: string;
    /** small text on the right: the script key, a count */
    hint?: string;
    /** mnemonic; assigned from the label when absent (not in type-ahead menus) */
    key?: string;
    /** leads to another menu (▸) */
    sub?: boolean;
    /** game image path of an icon */
    icon?: string;
    title?: string;
    /** done: finishes the pick; info: a note, not selectable */
    role?: 'done' | 'info';
    go?: () => Next;
    /** added to the filter score (higher = further down among matches) */
    rank?: number;
    /** what it does — shown in the preview while the row is highlighted */
    explain?: string;
    /** more words the filter matches */
    match?: string;
    /** listed only while a filter is typed (every entry behind a menu of groups) */
    filtered?: boolean;
    /** listed only while nothing is typed (a default the typed text replaces: "Keep: …" in a text step) */
    unfiltered?: boolean;
    /** the database entry the row stands for: the preview shows its card (a doctrine's description, what it does) */
    entry?: { type: string; name: string; };
    /** a picture the row stands for (an icon): large in the preview */
    image?: string;
    /** a problem with what the row writes (a typed chain leading to another type): shown in the preview, not blocking */
    warn?: string;
    /**
     * chosen only on purpose ("＋ New trait…"): listed last, never the row selected when the menu opens — ⏎ or a typed
     * key sequence must not make an entry (rows.ts)
     */
    explicit?: boolean;
}

/**
 * What choosing a row leads to: a new menu beside it; `back` n: the menu n steps up takes the new state instead (0:
 * the chosen menu itself changes — a toggle; 1: the menu it was opened from — a value chosen for a block's field).
 */
export type Next = { state: State; crumb?: string; back?: number; } | { finish: true; state?: State; };

export interface Menu
{
    title: string;
    items: Item[];
    /** letters always go to the filter (lists of names, numbers): no mnemonics */
    typeahead?: boolean;
    /** typed digits form a number: rows offering it come first */
    number?: (n: number, text: string) => Item[];
    /** the typed text as a value: "Use “…”" */
    input?: (text: string) => Item | null;
    /** rows the index finds for the typed text (big types) */
    search?: (q: string) => Promise<Item[]>;
    /** data this menu waits for (a list being loaded): the menu is built again when it arrives */
    wait?: Promise<unknown>;
    /** wider menu (names with keys) */
    wide?: boolean;
    /** "what next" after a finished statement: the cascade starts over here */
    restart?: boolean;
    /** choosing a row finishes a value: the preview shows the highlighted row's outcome */
    preview?: boolean;
    /** a hint line under the items */
    note?: string;
}

/** Where the next statement goes: a block of the draft. */
export interface Loc
{
    /** path of kid indices from the top to the block (empty: the top level) */
    path: number[];
    kind: Mode;
    scope: ScopeType;
    /** subject of the block ("Liege", "each child"); '' at the top */
    label: string;
    /** the place to go back to (a condition block returns to its effects) */
    back?: Loc;
    /**
     * how "What next?" goes back there: to its "What next?" (default), or to its root menu under this label — an
     * `else_if`'s conditions lead on to its effects ("Then…")
     */
    backTo?: { view: 'root'; label: string; };
    /** title of its root menu ("When…", "Only those who…") */
    title?: string;
}

export interface Draft
{
    top: SNode[];
    loc: Loc;
    /** path of the node inserted last at `loc` */
    last?: number[];
    /** the next condition joins the last one in an OR */
    orNext?: boolean;
}

/** A step from the place's scope to the statement's subject. */
export interface ChainStep
{
    kind: 'link' | 'iter';
    key: string;
    label: string;
    to: ScopeType;
    /** an iterator's parameters, first in its block (`type = friend`, `order_by = age`) */
    params?: [string, string][];
}

/** What a chosen part of the statements at a place is wrapped into ("When…" asks which part first). */
export type PartAction = 'when' | 'chance' | 'hidden' | 'random' | 'trigger_if' | 'calc';

export interface Pending
{
    def: StatementDef;
    chain: ChainStep[];
    values: Record<string, string>;
    step: number;
    /** changing a written statement: its parameters' values as written ("Keep …" in each step) */
    now?: Record<string, string>;
    /**
     * the statement is a block to fill next (a switch's case `brave = { }`): once built, its root menu opens inside it
     * (this place, without the path) instead of "What next?"
     */
    enter?: Omit<Loc, 'path'>;
    /** changing a written statement: its block's fields the catalog has no place for (kept as written), and a `NOT = { … }` around it */
    rest?: SNode[];
    not?: boolean;
}

export type View =
    | { v: 'root'; }
    | { v: 'targets'; type: ScopeType; }
    | { v: 'someone'; type: ScopeType; }
    | { v: 'iters'; mode: 'every' | 'random' | 'any' | 'ordered'; type?: ScopeType; }
    | { v: 'related'; }
    | { v: 'stmts'; group?: string; }
    | { v: 'param'; }
    | { v: 'cont'; }
    /** `random = { chance = N … }` around the statements from index `from` of the place */
    | { v: 'chance'; from?: number; path?: number[]; }
    /** which part of the place's statements an action wraps */
    | { v: 'part'; action: PartAction; }
    /** a random list's outcome weight: the part from `from` becomes the first outcome, or (`add`) another, empty one */
    | { v: 'weight'; from?: number; add?: boolean; }
    /** `calc_true_if = { amount >= N … }` around the conditions from `from` */
    | { v: 'calc'; from: number; }
    /** an iterator's kind (a relation's type: friend, rival …; a secret's) before its statements */
    | { v: 'iterType'; step: ChainStep; ref: string; label: string; optional?: string; }
    /** an ordered iterator's order ("The one with the highest…") */
    | { v: 'orderBy'; step: ChainStep; }
    /** how many of an `any_` iterator's items must match (count / percent) — the iterator at `path` */
    | { v: 'count'; path: number[]; }
    /** `switch`: the condition its cases are values of */
    | { v: 'switchOn'; }
    | { v: 'other'; }
    /** a condition block's conditions the game writes there (PickRequest.common) */
    | { v: 'common'; }
    | { v: 'otherValue'; key: ScriptKeyInfo; }
    | { v: 'search'; }
    | { v: 'global'; }
    /** a historical character by search: the answer of a scope parameter, or the subject (chain) */
    | { v: 'character'; as: 'param' | 'subject'; }
    /** modifiers of a group ('' = all), a modifier's value (`now`: the value it has when changing it) */
    | { v: 'modGroup'; group: string; all?: boolean; every?: boolean; }
    | { v: 'modValue'; key: string; now?: string; }
    /** a field's value (duration fields: `unit` of the written key when changing it) */
    | { v: 'fieldValue'; key: string; now?: string; unit?: string; }
    /** a field whose key is any entry (`compatibility = { brave = 15 }`): which entry, then its value */
    | { v: 'fieldKey'; field: string; }
    /** "Other setting…" of an open set: a typed key, then its value (the values the game writes for it) */
    | { v: 'otherSetting'; }
    | { v: 'otherSettingValue'; key: string; }
    /** the entries of one group of a grouped field (a doctrine group's doctrines) */
    | { v: 'fieldGroup'; key: string; group: string; }
    /** field set `doctrine_parameters`: a parameter's value (yes / no / a number) */
    | { v: 'paramValue'; key: string; now?: string; }
    /** a block field being built (its fields so far), and the value of one of its fields */
    | { v: 'block'; key: string; values: [string, string][]; }
    | { v: 'blockValue'; key: string; sub: string; values: [string, string][]; from?: 'block'; }
    /** a new entry for a block's field: its key, its menu, one of its settings, its text in game */
    | { v: 'newName'; f: { key: string; sub: string; values: [string, string][]; from?: 'block'; }; }
    | { v: 'newEntry'; ctx: NewCtx; }
    | { v: 'newValue'; ctx: NewCtx; field: string; }
    | { v: 'newLoc'; ctx: NewCtx; }
    /** mode 'loc': whose code, a character's functions (a group), concepts, icons, formatting */
    | { v: 'locWho'; }
    | { v: 'locFn'; prefix: string; group?: string; }
    | { v: 'locConcept'; }
    | { v: 'locIcon'; }
    | { v: 'locFormat'; }
    /** "Pass along…" after a trigger_event: the names the event uses */
    | { v: 'pass'; event: string; }
    /** changing a written `key op value` the catalog has no statement for: its values, the way "Other…" offers them */
    | { v: 'otherKey'; key: string; op: string; now: string; }
    /** changing a written block (the draft's first statement): its head — an if, NOT / OR, a scope switch, an iterator … */
    | { v: 'head'; }
    | { v: 'iterSet'; what: 'list' | 'mode' | 'type' | 'order'; }
    | { v: 'scopeSet'; }
    /**
     * any block statement field by field (a written one without a template; a scripted effect's call): its menu, a
     * field's value (`index`: of a written field; `ask`: parameters still to ask; `from`: the block's menu that many menus
     * up), a field to add
     */
    | { v: 'kblock'; key: string; fields: KField[]; }
    | { v: 'kfield'; key: string; field: string; fields: KField[]; index?: number; ask?: string[]; from?: number; }
    | { v: 'kadd'; key: string; fields: KField[]; }
    /** a new entry of an index type ("＋ New trait…"): its key, its name in game */
    | { v: 'newRef'; type: string; then: NewRefThen; }
    | { v: 'newRefName'; type: string; key: string; then: NewRefThen; };

export interface State
{
    kind: Mode;
    /** mode 'field': the entry type whose fields are built */
    type?: string;
    /** new entries made on the way (a new opinion modifier …): PickResult.creates */
    creates?: EntryCreate[];
    /** mode 'loc': the scopes the text can speak of; the chosen code and where the cursor goes in it */
    scopes?: string[];
    raw?: string;
    caret?: number;
    draft: Draft;
    /** subject chain being chosen (before a statement is picked) */
    chain: ChainStep[];
    pending?: Pending;
    view: View;
    title?: string;
    /**
     * PickRequest.goal — 'name': the subject chosen is given a name (save_scope_as); 'send': the subject chosen gets the
     * event `event` (trigger_event). No statement menus.
     */
    goal?: 'name' | 'send';
    event?: string;
    /** the event's scopes, offered as targets besides the links ("Child is…") — PickRequest.targets */
    targets?: PickTarget[];
    /** "Pass along…": the name being given — choosing who saves them as it before the trigger_event */
    passing?: string;
    /** PickRequest.only: the values offered for the field (the doctrines of one group) */
    only?: string[];
    /** PickRequest.once: the first statement finishes (no "What next?") */
    once?: boolean;
    /** PickRequest.root: the scope type `root` is when not a character — "Self" at the top is "the faith" */
    rootScope?: ScopeType;
    /** PickRequest.common / about: the conditions the game writes in the block, most used first, and what it is for */
    common?: string[];
    about?: string;
    /** kind 'modifier': what the block's modifiers apply to (PickRequest.scope) — the menus offer the ones the game puts there */
    modScope?: 'character' | 'landed_title' | 'province';
    /** PickRequest.newEntries: entry lists offer "＋ New trait…" (made by the caller: PickResult.creates) */
    newEntries?: boolean;
    /**
     * changing a written block that belongs to an if / else chain: an else_if / else, or one an else follows
     * (PickRequest.elseAfter) — it is not wrapped (When…, Chance…) and, with an else after it, nothing goes after it
     */
    bound?: 'else' | 'elseAfter';
}

export function initialState(kind: Mode, scope: ScopeType, title?: string, type?: string, subject?: string): State
{
    return { kind, type, title, chain: [], view: { v: 'root' }, draft: { top: [], loc: { path: [], kind, scope, label: subject ?? '' } } };
}

/** A written `key op value` on one line (a quoted value keeps its quotes). */
const SCALAR = /^\s*([\w.:@$'-]+)\s*(==|!=|<=|>=|<|>|=)\s*("[^"\n]*"|[^\s{}"#]+)\s*$/;

/** A written block field the picker can take apart: `triggered_opinion = { opinion_modifier = x same_faith = yes }`. */
function writtenBlock(text: string, type?: string): { f: FieldDef; values: [string, string][]; } | null
{
    const nodes = parseSnippet(text);
    const n = nodes[0];
    const f = n && type ? fieldOf(type, n.k) : undefined;

    if (nodes.length !== 1 || !n.kids || f?.kind !== 'block' || !f.sub)
        return null;

    const known = new Set((FIELDS[f.sub] ?? []).map((x) => x.key));

    if (!n.kids.every((c) => !c.kids && c.op === '=' && known.has(c.k)))
        return null;

    return { f, values: n.kids.map((c) => [c.k, c.v ?? ''] as [string, string]) };
}

/** Tokens of script for comparing: quoted strings, braces, operators, words (comments left out). */
function scriptTokens(text: string): string[]
{
    return text.match(/"[^"\n]*"|[{}]|[<>!?=]=|[<>=]|[^\s{}<>=!?"#]+/g) ?? [];
}

/**
 * Whether the picker can take a written statement apart and write it back as it was: no comment in it (outside
 * quotes — the picker would lose it), no inline math, and parsing and printing it again gives the same tokens.
 */
export function keepsAsWritten(text: string): boolean
{
    const bare = text.replace(/"[^"\n]*"/g, '""');

    if (bare.includes('#') || bare.includes('@['))
        return false;

    return scriptTokens(printScript(parseSnippet(text))).join(' ') === scriptTokens(text).join(' ');
}

/**
 * Whether the picker can change a written statement (else the script editor does): modifiers and settings written as
 * `key = value` (settings the type knows), effects and conditions the catalog has — or any one-line `key op value`.
 */
export function canPickEdit(kind: Mode, text: string, type?: string): boolean
{
    // (a comment inside, or script the picker would print differently — `@[ … ]`, `hsv { … }`: the script editor)
    if (!keepsAsWritten(text))
        return false;

    const m = SCALAR.exec(text);

    if (kind === 'modifier')
        return !!m && m[2] === '=';

    if (kind === 'field')
        return (!!m && m[2] === '=' && !!type && (type === 'doctrine_parameters' || (!!fieldOf(type, m[1]) && fieldOf(type, m[1])!.kind !== 'level'))) || !!writtenBlock(text, type) || (!!type && !!bareField(type) && /^\s*[\w.:@-]+\s*$/.test(text));

    if (kind === 'loc')
        return false;

    return !!findStatement(kind, text) || !!m || !!writtenBlockNode(text);
}

/**
 * The states the picker opens with: the root menu, and — changing a written modifier or field (`edit`) — its value
 * step beside it (← goes back to choose another one).
 */
export function startStates(
    kind: Mode,
    scope: ScopeType,
    title?: string,
    type?: string,
    edit?: string,
    subject?: string,
    scopes?: string[],
    goal?: 'name' | 'send',
    event?: string,
    opts: { field?: string; only?: string[]; once?: boolean; root?: ScopeType; common?: string[]; about?: string; modScope?: ScopeType; newEntries?: boolean; elseAfter?: boolean; } = {}
): { state: State; crumb?: string; }[]
{
    let root = initialState(kind, scope, title, type, subject);

    if (scopes)
        root = { ...root, scopes };

    if (goal)
        root = { ...root, goal, event };

    if (opts.only)
        root = { ...root, only: opts.only };

    if (opts.once)
        root = { ...root, once: true };

    if (opts.root && opts.root !== 'character')
        root = { ...root, rootScope: opts.root };

    if (opts.common?.length || opts.about)
        root = { ...root, common: opts.common, about: opts.about };

    if (opts.newEntries)
        root = { ...root, newEntries: true };

    // (modifiers for a character, a county, a province: those the game puts there)
    if (kind === 'modifier' && (opts.modScope === 'character' || opts.modScope === 'landed_title' || opts.modScope === 'province'))
        root = { ...root, modScope: opts.modScope };

    // (a condition / modifier block the game writes: the picker opens at what it holds there, the root menu beside it)
    if (!edit && (kind === 'trigger' || kind === 'modifier') && opts.common?.length)
        return [{ state: root }, { state: { ...root, view: { v: 'common' } }, crumb: 'Used here' }];

    if (!edit)
    {
        // (a place for one field — a doctrine group's placeholder, a set of one field: an opposite, a compatibility, a
        // track's level —: its value step beside the root menu)
        const only = kind === 'field' && type && !opts.field && FIELDS[type]?.length === 1 && FIELDS[type][0].kind !== 'bool' && !OPEN_SETS.has(type) ? FIELDS[type][0] : undefined;
        const f = kind === 'field' && opts.field && type ? fieldOf(type, opts.field) : only;

        if (f?.anyKey)
            return [{ state: root }, { state: { ...root, view: { v: 'fieldKey', field: f.key } }, crumb: f.label.replace('…', '') }];

        return f ? [{ state: root }, { state: { ...root, view: { v: 'fieldValue', key: f.key } }, crumb: f.label.replace('…', '') }] : [{ state: root }];
    }

    // (the root menu offers another statement in its place)
    root = { ...root, draft: { ...root.draft, loc: { ...root.draft.loc, title: 'Change to…' } } };

    if (kind === 'effect' || kind === 'trigger')
    {
        const found = findStatement(kind, edit, scope);

        if (found)
        {
            // (every parameter asked, also those only a written one has — `years` of an add_opinion)
            const def = { ...found.def, params: allParams(found.def) };
            return [{ state: root }, { state: { ...root, pending: { def, chain: [], values: {}, step: 0, now: found.values, rest: found.rest, not: found.not }, view: { v: 'param' } }, crumb: found.not ? `Not: ${def.label}` : def.label }];
        }

        const sc = SCALAR.exec(edit);

        if (sc)
            return [{ state: root }, { state: { ...root, view: { v: 'otherKey', key: sc[1], op: sc[2], now: sc[3] } }, crumb: sc[1] }];

        // (a block: its head — if, NOT, a scope switch, an iterator … — or field by field)
        const n = writtenBlockNode(edit);

        if (n)
            return blockStart(opts.elseAfter && IF_KEYS.test(n.k) ? { ...root, bound: 'elseAfter' } : ELSE_KEYS.test(n.k) ? { ...root, bound: 'else' } : root, n, kind);

        return [{ state: root }];
    }

    const block = kind === 'field' ? writtenBlock(edit, type) : null;

    if (block)
        return [{ state: root }, { state: { ...root, view: { v: 'block', key: block.f.key, values: block.values } }, crumb: block.f.label.replace('…', '') }];

    // (a list's item written alone: `craven` of `opposites = { craven }`)
    const bare = kind === 'field' && type ? bareField(type) : undefined;

    if (bare && /^\s*[\w.:@-]+\s*$/.test(edit))
        return [{ state: root }, { state: { ...root, view: { v: 'fieldValue', key: bare.key, now: edit.trim() } }, crumb: bare.label.replace('…', '') }];

    const m = SCALAR.exec(edit);

    if (!m || m[2] !== '=')
        return [{ state: root }];

    const [, key, , now] = m;

    if (kind === 'modifier')
        return [{ state: root }, { state: { ...root, view: { v: 'modValue', key, now } }, crumb: key }];

    if (kind === 'field' && type)
    {
        if (type === 'doctrine_parameters')
            return [{ state: root }, { state: { ...root, view: { v: 'paramValue', key, now } }, crumb: key }];

        const f = fieldOf(type, key);

        // (a key that is any entry: the written one — `brave` of `compatibility = { brave = 15 }`)
        if (f && f.kind !== 'level')
            return [{ state: root }, { state: { ...root, view: { v: 'fieldValue', key: f.anyKey ? key : f.key, now, unit: f.kind === 'duration' ? key.replace(/^delay_/, '') : undefined } }, crumb: f.anyKey ? humanize(key) : f.label.replace('…', '') }];
    }

    return [{ state: root }];
}

// ---------------------------------------------------------------------------
// Draft operations (immutable: every change copies the draft)
// ---------------------------------------------------------------------------

function cloneDraft(d: Draft): Draft
{
    return structuredClone(d);
}

/** The kids array at a path (the path of a block node; empty = the top). */
function blockAt(top: SNode[], path: number[]): SNode[]
{
    let list = top;

    for (const i of path)
    {
        const n = list[i];

        if (!n.kids)
            n.kids = [];

        list = n.kids;
    }

    return list;
}

function nodeAt(top: SNode[], path: number[]): SNode | undefined
{
    if (!path.length)
        return undefined;

    return blockAt(top, path.slice(0, -1))[path[path.length - 1]];
}

/** Innermost scope switch / iterator along the last-kid spine of the node at `path`. */
function innermostWrap(top: SNode[], path: number[] | undefined): { path: number[]; node: SNode; } | undefined
{
    if (!path)
        return undefined;

    let found: { path: number[]; node: SNode; } | undefined;
    let p = path;
    let n = nodeAt(top, p);

    while (n && n.meta && n.kids?.length)
    {
        found = { path: p, node: n };
        const i = n.kids.length - 1;
        p = [...p, i];
        n = n.kids[i];
    }

    return found;
}

/** Puts a statement where the draft's place is: joins an OR, merges into the same scope switch, or appends. */
export function insert(d0: Draft, node: SNode): Draft
{
    const d = cloneDraft(d0);
    const block = blockAt(d.top, d.loc.path);
    const prev = block[block.length - 1];

    if (d.orNext && prev)
    {
        if (prev.k === 'OR' && prev.kids)
            prev.kids.push(node);
        else
            block[block.length - 1] = { k: 'OR', op: '=', kids: [prev, node] };

        d.orNext = false;
        d.last = [...d.loc.path, block.length - 1];
        return d;
    }

    d.orNext = false;

    if (prev && prev.meta?.wrap === 'scope' && node.meta?.wrap === 'scope' && prev.k === node.k && prev.kids && node.kids)
    {
        prev.kids.push(...node.kids);
        d.last = [...d.loc.path, block.length - 1];
        return d;
    }

    block.push(node);
    d.last = [...d.loc.path, block.length - 1];
    return d;
}

/**
 * Wraps the statements at the draft's place from index `from` on (default: the first statement — an iterator's own
 * parameters stay) into one block (`if`, `random`, `hidden_effect`); returns it and its path.
 */
function wrapAll(d0: Draft, make: (kids: SNode[]) => SNode, from = firstStatement(d0)): { d: Draft; path: number[]; }
{
    const d = cloneDraft(d0);
    const block = blockAt(d.top, d.loc.path);
    const wrapped = make(block.splice(from, block.length - from));
    block.push(wrapped);
    const path = [...d.loc.path, from];
    d.last = path;
    return { d, path };
}

/** An iterator's own parameters (not statements: never wrapped, not listed as parts). */
const ITERATOR_PARAMS = new Set(['limit', 'alternative_limit', 'type', 'count', 'percent', 'order_by', 'position', 'max', 'min', 'check_range_bounds', 'weight', 'even_if_dead', 'only_if_dead']);

/** else / else_if (trigger_else …): part of the if before them — never separated from it */
const ELSE_KEYS = /^(else|else_if|trigger_else|trigger_else_if)$/;
/** what an else may follow */
const IF_KEYS = /^(if|else_if|trigger_if|trigger_else_if)$/;

/** Index of the first statement at the draft's place (inside an iterator: after its parameters). */
function firstStatement(d: Draft): number
{
    const block = blockAt(structuredClone(d.top), d.loc.path);
    const holder = nodeAt(d.top, d.loc.path);
    let i = 0;

    if (holder?.meta?.wrap === 'iter' || /^(any|every|random|ordered)_/.test(holder?.k ?? ''))
    {
        while (i < block.length && ITERATOR_PARAMS.has(block[i].k))
            i++;
    }

    return i;
}

/** The statements at the draft's place (not an iterator's parameters). */
function placeStatements(d: Draft): SNode[]
{
    return blockAt(structuredClone(d.top), d.loc.path).slice(firstStatement(d));
}

/** NOT on the last condition: `x = yes` ↔ `x = no`, NOT = { … } unwrapped, anything else wrapped. */
function negateLast(d0: Draft): Draft
{
    const d = cloneDraft(d0);
    const block = blockAt(d.top, d.loc.path);
    const i = block.length - 1;
    const n = block[i];

    if (!n)
        return d;

    if (!n.kids && (n.v === 'yes' || n.v === 'no') && n.op === '=')
        n.v = n.v === 'yes' ? 'no' : 'yes';
    else if (n.k === 'NOT' && n.kids?.length === 1)
        block[i] = n.kids[0];
    else
        block[i] = { k: 'NOT', op: '=', kids: [n] };

    d.last = [...d.loc.path, i];
    return d;
}

/** Scope switches for a subject chain: links run together with dots, iterators get blocks of their own. */
export function wrapChain(nodes: SNode[], chain: ChainStep[]): SNode[]
{
    let inner = nodes;
    let i = chain.length;

    while (i > 0)
    {
        const s = chain[i - 1];

        if (s.kind === 'iter')
        {
            const params = (s.params ?? []).map(([k, v]): SNode => ({ k, op: '=', v }));
            inner = [{ k: s.key, op: '=', kids: [...params, ...inner], meta: { wrap: 'iter', label: s.label, scope: s.to } }];
            i--;
            continue;
        }

        let j = i - 1;

        while (j > 0 && chain[j - 1].kind === 'link')
            j--;

        const run = chain.slice(j, i);
        inner = [{ k: run.map((r) => r.key).join('.'), op: '=', kids: inner, meta: { wrap: 'scope', label: chainLabel(run), scope: run[run.length - 1].to } }];
        i = j;
    }

    return inner;
}

function chainLabel(chain: ChainStep[]): string
{
    const t = chain.map((c, i) => (i === 0 ? c.label : c.label.toLowerCase())).join('’s ');
    return t.charAt(0).toUpperCase() + t.slice(1);
}

/** `liege.primary_spouse` — for `exists = …` */
function chainExpr(chain: ChainStep[]): string
{
    return chain.map((c) => c.key).join('.');
}

// ---------------------------------------------------------------------------
// Statements: values, placeholders, completion
// ---------------------------------------------------------------------------

function slug(s: string): string
{
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/** A name typed for a flag / variable / saved scope: lower case, `_` for spaces. */
export function nameOf(text: string): string
{
    return text
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^\w.:@-]/g, '');
}

/** Values of a pending statement with placeholders for the parameters not asked yet. */
function withPlaceholders(p: Pending, forDescribe: boolean): Record<string, string>
{
    const v = { ...p.values };
    p.def.params.forEach((param, i) =>
    {
        if (i < p.step || param.name in p.values)
            return;

        // (changing a written statement: what it has now)
        if (p.now && param.name in p.now)
        {
            v[param.name] = p.now[param.name];
            return;
        }

        const s = slug(param.label) || param.name;

        if (!forDescribe)
            v[param.name] = `‹${s}›`;
        else if (param.kind === 'scope')
            v[param.name] = `scope:${s}`;
        else if (param.kind === 'number')
            v[param.name] = '0';
        else if (param.kind === 'compare')
            v[param.name] = '=';
        else if (param.kind === 'duration')
            v[param.name] = '';
        else if (param.kind === 'choice')
            v[param.name] = param.options[0].value;
        else
            v[param.name] = s;
    });

    if (p.def.subjectValue)
        v.subject = chainExpr(p.chain) || 'this';

    return v;
}

function statementNodes(p: Pending, values: Record<string, string>): SNode[]
{
    const nodes = parseSnippet(fillTemplate(p.def, values, { long: !!p.rest?.length }));

    // (a key the game renamed: under the name the loaded script uses)
    if (nodes[0]?.k)
        nodes[0].k = writtenKey(nodes[0].k);

    // (a written statement's other fields stay in its block)
    if (p.rest?.length && nodes[0]?.kids)
        nodes[0].kids.push(...structuredClone(p.rest));

    // `exists = liege`: the subject is the value, no scope switch
    const out = p.def.subjectValue ? nodes : wrapChain(nodes, p.chain);
    return p.not ? [{ k: 'NOT', op: '=', kids: out }] : out;
}

function complete(s: State, p: Pending): State
{
    const values = { ...p.values };

    if (p.def.subjectValue)
        values.subject = chainExpr(p.chain) || 'this';

    const nodes = statementNodes(p, values);
    let d = s.draft;

    for (const n of nodes)
        d = insert(d, n);

    // (a block to fill: its root menu inside it)
    if (p.enter && d.last)
        return { ...s, draft: { ...d, loc: { ...p.enter, path: d.last } }, chain: [], pending: undefined, view: { v: 'root' } };

    return { ...s, draft: d, chain: [], pending: undefined, view: { v: 'cont' } };
}

/** Sets a parameter and moves on: the next parameter, or the finished statement. */
function answer(s: State, value: string): State
{
    const p = s.pending!;
    const param = p.def.params[p.step];
    const next: Pending = { ...p, values: { ...p.values, [param.name]: value }, step: p.step + 1 };

    if (next.step >= next.def.params.length)
        return complete(s, next);

    return { ...s, pending: next, view: { v: 'param' } };
}

function start(s: State, def: StatementDef, chain: ChainStep[] = s.chain): State
{
    const p: Pending = { def, chain, values: {}, step: 0 };

    if (!def.params.length)
        return complete(s, p);

    return { ...s, pending: p, chain, view: { v: 'param' } };
}

/** The script built so far, with the statement being built put in (placeholders for what is still to be asked). */
export function previewText(s: State, forDescribe = false): string
{
    if (s.raw !== undefined)
        return s.raw;

    let d = s.draft;

    if (s.pending)
    {
        for (const n of statementNodes(s.pending, withPlaceholders(s.pending, forDescribe)))
            d = insert(d, n);
    }

    if ((s.view.v === 'block' || s.view.v === 'blockValue') && s.view.values.length)
    {
        for (const n of parseSnippet(blockText(s.view.key, s.view.values)))
            d = insert(d, n);
    }

    if (s.view.v === 'kblock' || s.view.v === 'kfield' || s.view.v === 'kadd')
    {
        for (const n of wrapChain(parseSnippet(kblockText(s.view.key, s.view.fields)), s.chain))
            d = insert(d, n);
    }

    return printScript(d.top);
}

export function resultText(s: State): string
{
    return s.raw ?? printScript(s.draft.top);
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

const go = (state: State, crumb?: string): Next => ({ state, crumb });

/** Scope type of the subject: the place's scope, or where the chain leads. */
function subjectScope(s: State): ScopeType
{
    return s.chain.length ? s.chain[s.chain.length - 1].to : s.draft.loc.scope;
}

/** The links from a scope type; `root` leads to what the script's root is (State.rootScope — a doctrine's: its faith). */
function linksFrom(from: ScopeType, root?: ScopeType): ScopeLink[]
{
    return LINKS.filter((l) => l.from.length === 0 || l.from.includes(from)).map((l) => (l.key === 'root' && root ? { ...l, to: root } : l));
}

/**
 * Who the place's statements are about: "you" (the event's / decision's character) — or "the faith" at the top of a
 * script whose root is one (a doctrine's) — or, inside a block, its subject.
 */
function selfName(s: State): string
{
    return s.draft.loc.label || (s.rootScope ? `the ${SCOPE_LABELS[s.rootScope]}` : 'you');
}

function selfLabel(s: State): string
{
    // (inside an iterator or a scope switch: who that is — "The child", "Liege")
    const l = selfName(s);

    if (l === 'them')
        return 'Them (the one it is about)';

    return l === 'you' ? 'You (self)' : l.charAt(0).toUpperCase() + l.slice(1);
}

/** "you" → "your", "the child" → "the child’s" */
function possessive(who: string): string
{
    if (/^you/i.test(who))
        return 'your';

    if (/^the[ym]\b/i.test(who))
        return 'their';

    return who.endsWith('s') ? who + '’' : who + '’s';
}

const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** Who a link starts from: the subject chosen so far, else the place's self. */
function whoOf(s: State): string
{
    return s.chain.length ? chainLabel(s.chain) : selfName(s);
}

/**
 * A link's label relative to who it starts from — "Your liege", "The child’s liege"; root is always the character
 * the whole script is about (the event's, the decision's).
 */
function linkLabel(s: State, l: ScopeLink): string
{
    if (l.key === 'root')
    {
        if (s.rootScope)
            return `Root (the ${SCOPE_LABELS[s.rootScope]})`;

        return selfName(s) === 'you' && !s.chain.length ? 'Root (you — the event’s character)' : 'Root (the event’s character)';
    }

    return cap(`${possessive(whoOf(s))} ${l.label.toLowerCase()}`);
}

/** A link as a subject step, labelled from who it starts at ("Your liege"). */
function stepFor(l: ScopeLink, s?: State): ChainStep
{
    return { kind: 'link', key: l.key, label: s ? linkLabel(s, l).replace(/ \(.*\)$/, '') : l.label, to: l.to };
}

const PREFIX_SCOPES: Record<string, ScopeType> = { character: 'character', title: 'landed_title', faith: 'faith', culture: 'culture', dynasty: 'dynasty', house: 'dynasty_house', province: 'province', religion: 'religion' };

/**
 * The scope type a typed chain leads to (`scope:x.liege.faith`, `primary_title.holder`, `title:k_france`): the first
 * part from the saved scopes in reach (PickRequest.targets — their types), root, a database prefix, or a link from
 * `from`; then each link from where the chain is. `problem`: a part that leads nowhere from there. Undefined type:
 * unknown (`prev`, a saved scope nobody documents).
 */
export function chainType(s: State, expr: string, from: ScopeType): { type?: ScopeType; problem?: string; }
{
    const parts = expr.split('.');
    let at: ScopeType | undefined = from;
    let i = 0;
    const first = parts[0];
    const prefix = /^(\w+):/.exec(first);

    if (first === 'root')
        (at = s.rootScope ?? 'character'), i++;
    else if (first === 'this')
        i++;
    else if (first === 'prev' || first.startsWith('var:') || first.startsWith('local_var:') || first.startsWith('global_var:'))
        return {};
    else if (prefix?.[1] === 'scope')
    {
        const t = (s.targets ?? []).find((x) => x.key === first);

        if (!t)
            return {};

        at = (SCOPE_ORDER as string[]).includes(t.type ?? 'character') ? ((t.type ?? 'character') as ScopeType) : undefined;
        i++;
    }
    else if (prefix)
    {
        at = PREFIX_SCOPES[prefix[1]];
        i++;
    }

    for (; i < parts.length && at; i++)
    {
        const here: ScopeType = at;
        const l = LINKS.find((x) => x.key === parts[i] && (x.from.length === 0 || x.from.includes(here)));

        if (!l)
        {
            // (a link the catalog knows from other types: it leads nowhere from here)
            if (LINKS.some((x) => x.key === parts[i]))
                return { problem: `“${parts[i]}” leads nowhere from a ${SCOPE_LABELS[here]}` };

            return {};
        }

        at = l.key === 'root' ? (s.rootScope ?? 'character') : l.to;
    }

    return { type: at };
}

/** A warning for a typed chain where `want` is expected (undefined: fine or unknown). */
function chainWarning(s: State, expr: string, from: ScopeType, want: ScopeType): string | undefined
{
    const c = chainType(s, expr, from);

    if (c.problem)
        return c.problem;

    return c.type && c.type !== want ? `${expr} is a ${SCOPE_LABELS[c.type]}, not a ${SCOPE_LABELS[want]}` : undefined;
}

/** The event's scopes of a type (default character) as subjects: "Child is…" / "Child". */
function targetItems(s: State, type: ScopeType, suffix: string): Item[]
{
    return (s.targets ?? [])
        .filter((t) => (t.type ?? 'character') === type)
        .map((t) => ({
            label: t.label + suffix,
            hint: t.key,
            sub: true,
            title: t.about,
            go: () => go(withChain(s, { kind: 'link', key: t.key, label: t.label, to: type }, { v: 'stmts' }), t.label + suffix.replace('…', ''))
        }));
}

function withChain(s: State, step: ChainStep, view: View): State
{
    return { ...s, chain: [...s.chain, step], view };
}

export function menuOf(s: State, data: PickerData): Menu
{
    const m = menuOfView(s, data);

    if (!s.passing)
        return m;

    // ("Pass along": choosing who saves them under the name, before the event is sent)
    const title = s.view.v === 'targets' ? `Who is “${s.passing}”?` : m.title;
    return {
        ...m,
        title,
        items: m.items.map((it) =>
            it.go
                ? {
                    ...it,
                    go: () =>
                    {
                        const n = it.go!();
                        return !('finish' in n) && n.state.view.v === 'stmts' && n.state.passing ? { ...n, state: passAlong(n.state) } : n;
                    }
                }
                : it
        )
    };
}

/** The trigger_event last written where statements go now: its index there and the event (for "Pass along…"). */
function findSend(d: Draft): { index: number; event: string; } | undefined
{
    const sent = (n: SNode): string | undefined =>
    {
        if (n.k === 'trigger_event')
            return n.kids ? n.kids.find((k) => k.k === 'id')?.v : n.v;

        for (const k of n.kids ?? [])
        {
            const e = sent(k);

            if (e)
                return e;
        }

        return undefined;
    };
    const block = blockAt(structuredClone(d.top), d.loc.path);

    for (let i = block.length - 1; i >= 0; i--)
    {
        const event = sent(block[i]);

        if (event && !/^[‹$]/.test(event))
            return { index: i, event };
    }

    return undefined;
}

/** Saves who was chosen as the name being passed, right before the statement sending the event. */
function passAlong(s: State): State
{
    const send = findSend(s.draft);
    const def: StatementDef = { id: 'e.pass', kind: 'effect', group: 'do', label: 'Pass along', scopes: 'any', script: `save_scope_as = ${s.passing}`, params: [] };
    const nodes = statementNodes({ def, chain: s.chain, values: {}, step: 0 }, {});
    const d = cloneDraft(s.draft);
    const block = blockAt(d.top, d.loc.path);
    const i = send ? send.index : block.length;
    block.splice(i, 0, ...nodes);
    return { ...s, draft: { ...d, last: [...d.loc.path, i] }, chain: [], pending: undefined, passing: undefined, view: { v: 'cont' } };
}

/** "Pass along…": the names the event uses (who they are there), or a typed one. */
function passMenu(s: State, data: PickerData, event: string): Menu
{
    const expected = data.eventScopes?.(event);
    const known = (n: string): boolean => (s.targets ?? []).some((t) => t.key === `scope:${n}`);
    const pick = (name: string, label: string, extra?: Partial<Item>): Item => ({
        label,
        sub: true,
        hint: `scope:${name}`,
        ...extra,
        go: () => go({ ...s, passing: name, chain: [], view: { v: 'targets', type: 'character' } }, `As ${name}`)
    });
    return {
        title: `Pass along to ${event}`,
        items: (expected ?? []).map((x) => pick(x.name, cap(x.name.replace(/_/g, ' ')) + (known(x.name) ? ' — the same name here goes along' : ''), { title: x.about })),
        wait: expected ? undefined : data.eventScopesLoaded?.(event),
        input: (text) =>
        {
            const n = nameOf(text).replace(/^scope:/, '');
            return n ? pick(n, `As “scope:${n}”…`, { hint: 'a new name' }) : null;
        },
        note: expected && !expected.length ? 'The event uses no names yet — type one to pass someone along as it' : 'The names the event uses — or type one'
    };
}

function menuOfView(s: State, data: PickerData): Menu
{
    const v = s.view;

    switch (v.v)
    {
        case 'pass':
            return passMenu(s, data, v.event);
        case 'root':
            if (s.draft.loc.kind === 'loc')
                return locRoot(s);

            if (s.draft.loc.kind === 'modifier')
                return modifierRoot(s, data);

            if (s.draft.loc.kind === 'field')
                return fieldRoot(s, data);

            return s.draft.loc.kind === 'effect' ? effectRoot(s) : triggerRoot(s);
        case 'targets':
            return targetsMenu(s, v.type);
        case 'someone':
            return someoneMenu(s, v.type);
        case 'iters':
            return itersMenu(s, v.mode, v.type);
        case 'iterType':
            return iterTypeMenu(s, data, v.step, v.ref, v.label, v.optional);
        case 'orderBy':
            return orderByMenu(s, v.step);
        case 'part':
            return partMenu(s, v.action);
        case 'weight':
            return weightMenu(s, v.from, v.add);
        case 'calc':
            return calcMenu(s, v.from);
        case 'count':
            return countMenu(s, v.path);
        case 'switchOn':
            return switchMenu(s, data);
        case 'related':
            return relatedMenu(s);
        case 'stmts':
            if (s.goal === 'name' && s.draft.loc.kind === 'effect')
                return nameMenu(s, data);

            if (s.goal === 'send' && s.draft.loc.kind === 'effect')
                return sendMenu(s);

            return s.draft.loc.kind === 'effect' ? effectStatements(s, v.group) : triggerStatements(s, v.group);
        case 'param':
            return paramMenu(s, data);
        case 'cont':
            return continuation(s);
        case 'chance':
            return chanceMenu(s, v.from, v.path);
        case 'other':
            return otherMenu(s, data);
        case 'common':
            return commonMenu(s, data);
        case 'otherValue':
            return otherValueMenu(s, v.key, data);
        case 'search':
            return searchMenu(s, data);
        case 'global':
            return globalMenu(s);
        case 'character':
            return characterMenu(s, data, v.as);
        case 'modGroup':
            return modGroupMenu(s, data, v.group, v.all, v.every);
        case 'modValue':
            return modValueMenu(s, data, v.key, v.now);
        case 'fieldValue':
            return fieldValueMenu(s, data, s.type ?? '', v.key, v.now, v.unit);
        case 'fieldKey':
            return fieldKeyMenu(s, data, v.field);
        case 'otherSetting':
            return otherSettingMenu(s, data);
        case 'otherSettingValue':
            return otherSettingValueMenu(s, data, v.key);
        case 'fieldGroup':
            return fieldGroupMenu(s, data, v.key, v.group);
        case 'paramValue':
            return paramValueMenu(s, v.key, v.now);
        case 'block':
            return blockMenu(s, v.key, v.values);
        case 'blockValue':
            return blockValueMenu(s, data, v.key, v.sub, v.values, v.from);
        case 'newName':
            return newNameMenu(s, data, v.f);
        case 'newEntry':
            return newEntryMenu(s, v.ctx);
        case 'newValue':
            return newValueMenu(s, data, v.ctx, v.field);
        case 'newLoc':
            return newLocMenu(s, v.ctx);
        case 'locWho':
            return locWho(s);
        case 'locFn':
            return locFnMenu(s, data, v.prefix, v.group);
        case 'locConcept':
            return locConceptMenu(s, data);
        case 'locIcon':
            return locIconMenu(s, data);
        case 'locFormat':
            return locFormatMenu(s, data);
        case 'otherKey':
            return otherKeyMenu(s, data, v.key, v.op, v.now);
        case 'head':
            return headMenu(s, data);
        case 'iterSet':
            return iterSetMenu(s, data, v.what);
        case 'scopeSet':
            return scopeSetMenu(s);
        case 'kblock':
            return kblockMenu(s, data, v.key, v.fields);
        case 'kfield':
            return kfieldMenu(s, data, v.key, v.field, v.fields, v.index, v.ask, v.from);
        case 'kadd':
            return kaddMenu(s, data, v.key, v.fields);
        case 'newRef':
            return newRefMenu(s, data, v.type, v.then);
        case 'newRefName':
            return newRefNameMenu(s, v.type, v.key, v.then);
    }
}

/** Goal 'name': who it is has been chosen — what to call them (save_scope_as; names the script uses come first). */
function nameMenu(s: State, data: PickerData): Menu
{
    const m = paramMenu(start(s, statementById('e.do.save_scope')!), data);
    const who = s.chain.length ? chainLabel(s.chain) : selfLabel(s);
    return { ...m, title: `${who}: call them…`, note: 'Type a name (letters, _): it becomes scope:<name> · ← back' };
}

/** Goal 'send': who gets the event has been chosen — send it (`trigger_event = <event>` inside their block). */
function sendMenu(s: State): Menu
{
    const who = s.chain.length ? chainLabel(s.chain) : selfLabel(s);
    const def: StatementDef = { id: 'e.send', kind: 'effect', group: 'do', label: 'Send the event', scopes: 'any', script: `trigger_event = ${s.event ?? 'event'}`, params: [] };
    return {
        title: who,
        items: [{ label: `Send the event to ${who.charAt(0).toLowerCase() + who.slice(1)}`, key: 's', hint: '⏎', go: () => go(complete(s, { def, chain: s.chain, values: {}, step: 0 }), 'Send') }]
    };
}

function effectRoot(s: State): Menu
{
    const loc = s.draft.loc;

    // (naming someone: who is it? sending the event: who gets it?)
    if (s.goal)
        return { ...targetsMenu(s, 'character'), title: s.goal === 'name' ? 'Who is it?' : 'Who gets the event?', note: 'Keys: letter = item · type to filter · ← back · Esc close' };

    const items: Item[] = [];

    for (const t of SCOPE_ORDER)
    {
        const reachable = t === loc.scope || linksFrom(loc.scope, s.rootScope).some((l) => l.to === t) || ITERATORS.some((i) => i.effect && i.from.includes(loc.scope) && i.to === t) || (s.targets ?? []).some((x) => (x.type ?? 'character') === t);

        if (!reachable)
            continue;

        items.push({ label: `Effect on ${SCOPE_LABELS[t]}…`, sub: true, key: t === 'character' ? 'c' : undefined, go: () => go({ ...s, view: { v: 'targets', type: t } }, `Effect on ${SCOPE_LABELS[t]}`) });
    }

    // (wanted most often, straight away: an event for whom the script runs for)
    const event = statementById('e.do.event');

    if (event)
        items.unshift({
            label: 'Trigger an event…',
            key: 'e',
            sub: true,
            explain: `trigger_event: ${selfName(s) === 'you' ? 'you get' : `${selfName(s)} gets`} an event (right away or later); “Pass along…” then names who it speaks of. For someone else: Effect on character → who → Do → Trigger an event.`,
            go: () => go(start({ ...s, chain: [] }, event, []), 'Trigger an event')
        });

    items.push({ label: 'Game & world…', sub: true, key: 'g', go: () => go({ ...s, view: { v: 'global' } }, 'Game & world') });
    items.push({ label: 'Other effect…', sub: true, key: 'o', title: 'Any effect key the game’s script uses', go: () => go({ ...s, view: { v: 'other' } }, 'Other effect') });
    return { title: loc.title ?? (s.title ? `Add to: ${s.title}` : 'Add an effect'), items, note: 'Keys: letter = item · type to filter · / search all · ← back · Esc close' };
}

function targetsMenu(s: State, type: ScopeType): Menu
{
    const loc = s.draft.loc;
    const items: Item[] = [];

    if (type === loc.scope)
        items.push({ label: selfLabel(s), key: 's', sub: true, go: () => go({ ...s, view: { v: 'stmts' } }, 'Self') });

    const links = linksFrom(loc.scope, s.rootScope).filter((l) => l.to === type);
    // (naming someone: root is "you" already)
    const shown = (type === 'character' ? links.filter((l) => l.main) : links).filter((l) => !(s.goal && l.key === 'root'));

    for (const l of shown)
        items.push({ label: linkLabel(s, l), key: l.k, hint: l.key, sub: true, go: () => go(withChain(s, stepFor(l, s), { v: 'stmts' }), linkLabel(s, l)) });

    items.push(...targetItems(s, type, ''));

    if (type === 'character')
        items.push({ label: 'Someone else…', sub: true, key: 'o', go: () => go({ ...s, view: { v: 'someone', type } }, 'Someone else') });

    if (ITERATORS.some((i) => i.effect && i.from.includes(loc.scope) && i.to === type))
    {
        // (a name for "every …" would be the last one's)
        if (s.goal !== 'name' && !s.passing)
            items.push({ label: 'Every…', sub: true, key: 'v', go: () => go({ ...s, view: { v: 'iters', mode: 'every', type } }, 'Every') });

        items.push({ label: 'A random…', sub: true, key: 'n', go: () => go({ ...s, view: { v: 'iters', mode: 'random', type } }, 'A random') });

        if (!s.goal && !s.passing && ITERATORS.some((i) => i.effect && i.orders && i.from.includes(loc.scope) && i.to === type))
            items.push({ label: 'The one with the highest…', sub: true, key: 'w', title: 'ordered_… = { order_by = … }: the child with the highest age, the vassal with the most gold …', go: () => go({ ...s, view: { v: 'iters', mode: 'ordered', type } }, 'The highest') });
    }

    return { title: `Effect on ${SCOPE_LABELS[type]}`, items };
}

function someoneMenu(s: State, type: ScopeType): Menu
{
    const from = subjectScope(s);
    const items: Item[] = [];

    for (const l of linksFrom(from, s.rootScope).filter((x) => x.to === type && !x.main))
        items.push({ label: linkLabel(s, l), hint: l.key, sub: true, go: () => go(withChain(s, stepFor(l, s), { v: 'stmts' }), linkLabel(s, l)) });

    items.unshift(...targetItems(s, type, ''));

    if (type === 'character')
    {
        for (const sc of SAVED_SCOPES)
        {
            const step: ChainStep = { kind: 'link', key: sc.key, label: sc.label.replace(/ \(.*\)$/, ''), to: 'character' };
            items.push({ label: sc.label, hint: sc.key, sub: true, go: () => go(withChain(s, step, { v: 'stmts' }), step.label) });
        }

        items.push({ label: 'A historical character…', key: 'h', sub: true, hint: 'character:…', go: () => go({ ...s, view: { v: 'character', as: 'subject' } }, 'Historical character') });
    }

    return {
        title: 'Someone else',
        items,
        input: (text) =>
        {
            const name = nameOf(text);

            if (!name)
                return null;

            const key = /^(scope:|root|prev|this)/.test(name) || name.includes('.') ? name : `scope:${name}`;
            // (a chain whose type is known leads to that type's statements; one leading elsewhere is said)
            const c = chainType(s, key, subjectScope(s));
            const to = c.type ?? type;
            return {
                label: `Saved scope “${key}”`,
                sub: true,
                hint: to !== 'character' ? SCOPE_LABELS[to] : undefined,
                warn: c.problem ?? (c.type && c.type !== type ? `${key} is a ${SCOPE_LABELS[c.type]}: its statements follow` : undefined),
                go: () => go(withChain(s, { kind: 'link', key, label: key.replace(/^scope:/, ''), to }, { v: 'stmts' }), key)
            };
        },
        note: 'Space, then a saved scope or a chain (scope:x, liege.faith): the statements of what it is follow'
    };
}

function itersMenu(s: State, mode: 'every' | 'random' | 'any' | 'ordered', type?: ScopeType): Menu
{
    const from = subjectScope(s);
    const items: Item[] = [];

    for (const i of ITERATORS)
    {
        if (!i.from.includes(from) || (type && i.to !== type))
            continue;

        if (mode === 'any' ? !i.trigger : !i.effect || (mode === 'ordered' && !i.orders))
            continue;

        const word = mode === 'every' ? 'Every' : mode === 'random' ? 'A random' : mode === 'ordered' ? 'The' : 'Any';
        const subject = mode === 'every' ? `each ${i.label}` : mode === 'random' ? `a random ${i.label}` : mode === 'ordered' ? `the ${i.label}` : `any ${i.label}`;
        const step: ChainStep = { kind: 'iter', key: `${mode}_${i.list}`, label: subject, to: i.to };
        const label = mode === 'ordered' ? `The ${i.label} with the highest…` : `${word} ${i.label}`;
        // (a relation: which one first — friend, rival …; ordered: by what)
        const next: View = i.type ? { v: 'iterType', step, ref: i.type.ref, label: i.type.label, optional: i.type.optional } : mode === 'ordered' ? { v: 'orderBy', step } : { v: 'stmts' };
        items.push({ label: i.type && mode !== 'ordered' ? `${label}…` : label, hint: step.key, sub: true, go: () => go(next.v === 'stmts' ? withChain(s, step, next) : { ...s, view: next }, label) });
    }

    return { title: mode === 'every' ? 'Every…' : mode === 'random' ? 'A random…' : mode === 'ordered' ? 'The one with the highest…' : 'Any of their…', items, wide: true };
}

/** A relation's (secret's, scheme's) kind: `type = friend` in the iterator — its label follows ("each friend"). */
function iterTypeMenu(s: State, data: PickerData, step: ChainStep, ref: string, label: string, optional?: string): Menu
{
    const list = modFirst(data.list(ref), data);
    const word = step.label.replace(/ \w+$/, '');
    const pick = (value: string | null, name: string): Item => ({
        label: name,
        hint: value ?? undefined,
        match: value ?? undefined,
        sub: true,
        go: () =>
        {
            const typed: ChainStep = value ? { ...step, params: [...(step.params ?? []), ['type', value]], label: `${word} ${name.toLowerCase()}` } : step;
            const i = ITERATORS.find((x) => step.key.endsWith('_' + x.list));
            // (ordered: by what, next)
            return go(step.key.startsWith('ordered_') && i?.orders ? { ...s, view: { v: 'orderBy', step: typed } } : withChain(s, typed, { v: 'stmts' }), name);
        }
    });
    return {
        title: label,
        typeahead: true,
        wide: true,
        items: [...(optional ? [pick(null, optional)] : []), ...(list ?? []).map((e) => pick(e.name, e.display && e.display !== e.name ? e.display : humanize(e.name)))],
        wait: list ? undefined : data.loaded(ref),
        input: (text) =>
        {
            const name = nameOf(text);
            return name ? pick(name, `“${name}”`) : null;
        },
        note: 'Most used first — type to filter'
    };
}

/** An ordered iterator's order: `order_by = age` — "the child with the highest age" (and the rest after it). */
function orderByMenu(s: State, step: ChainStep): Menu
{
    const i = ITERATORS.find((x) => step.key.endsWith('_' + x.list));
    const pick = (value: string, name: string, extra: Partial<Item> = {}): Item => ({
        label: `Highest ${name}`,
        hint: value,
        sub: true,
        ...extra,
        go: () => go(withChain(s, { ...step, params: [...(step.params ?? []), ['order_by', value]], label: `${step.label} with the highest ${name}` }, { v: 'stmts' }), name)
    });
    return {
        title: `${cap(step.label)} with the highest…`,
        typeahead: true,
        items: (i?.orders ?? []).map(([v, l]) => pick(v, l)),
        input: (text) =>
        {
            const name = nameOf(text);
            return name ? pick(name, name, { label: `Use “${name}”`, hint: 'a script value' }) : null;
        },
        note: 'Or type a script value — the highest first'
    };
}

/** Links from the subject to anyone or anything else: chains like "Liege’s faith". */
function relatedMenu(s: State): Menu
{
    const from = subjectScope(s);
    const items: Item[] = [];

    for (const l of linksFrom(from, s.rootScope))
    {
        if (l.key === 'root')
            continue;

        items.push({ label: linkLabel(s, l), hint: l.key, sub: true, go: () => go(withChain(s, stepFor(l, s), { v: 'stmts' }), linkLabel(s, l)) });
    }

    if (s.draft.loc.kind === 'effect' && ITERATORS.some((i) => i.effect && i.from.includes(from)))
    {
        items.push({ label: 'Every…', sub: true, go: () => go({ ...s, view: { v: 'iters', mode: 'every' } }, 'Every') });
        items.push({ label: 'A random…', sub: true, go: () => go({ ...s, view: { v: 'iters', mode: 'random' } }, 'A random') });

        if (ITERATORS.some((i) => i.effect && i.orders && i.from.includes(from)))
            items.push({ label: 'The one with the highest…', sub: true, go: () => go({ ...s, view: { v: 'iters', mode: 'ordered' } }, 'The highest') });
    }

    if (s.draft.loc.kind === 'trigger' && ITERATORS.some((i) => i.trigger && i.from.includes(from)))
        items.push({ label: 'Any of their…', sub: true, go: () => go({ ...s, view: { v: 'iters', mode: 'any' } }, 'Any') });

    return { title: 'Their…', items };
}

const VERB: Record<string, string> = { add: 'Add', remove: 'Remove', set: 'Set', do: '' };

function effectStatements(s: State, group?: string): Menu
{
    const scope = subjectScope(s);
    const defs = statementsFor('effect', scope);
    const subject = s.chain.length ? chainLabel(s.chain) : selfLabel(s);
    const pick = (d: StatementDef, label: string): Item => ({
        label,
        key: d.k,
        sub: d.params.length > 0,
        hint: d.script.split(/\s/)[0].replace(/\$\w+\$/g, '…'),
        match: d.words,
        explain: d.help,
        title: d.help,
        go: () => go(start(s, d), label)
    });

    if (group)
    {
        const g = EFFECT_GROUPS.find((x) => x.id === group)!;
        return { title: `${subject} › ${g.label.replace('…', '')}`, items: defs.filter((d) => d.group === group).map((d) => pick(d, d.label)) };
    }

    const items: Item[] = [];

    if (defs.length <= 12)
    {
        for (const d of defs)
            items.push(pick(d, VERB[d.group] ? `${VERB[d.group]} ${d.label.charAt(0).toLowerCase()}${d.label.slice(1)}` : d.label));

        for (const i of items)
            i.key = undefined;
    }
    else
    {
        for (const g of EFFECT_GROUPS)
        {
            if (!defs.some((d) => d.group === g.id))
                continue;

            items.push({ label: g.label, key: g.k, sub: true, explain: g.help, go: () => go({ ...s, view: { v: 'stmts', group: g.id } }, g.label.replace('…', '')) });
        }
    }

    items.push({ label: 'Their…', sub: true, key: 't', title: 'Someone or something of theirs: liege, faith, title, every child…', go: () => go({ ...s, view: { v: 'related' } }, 'Their') });
    items.push({ label: 'Other effect…', sub: true, key: 'o', go: () => go({ ...s, view: { v: 'other' } }, 'Other effect') });
    return { title: subject, items };
}

function triggerRoot(s: State): Menu
{
    const loc = s.draft.loc;
    const items: Item[] = [];
    const selfIs = selfName(s) === 'you' ? 'You (self) are…' : `${selfLabel(s)} is…`;
    const selfTitle = s.draft.loc.label ? `Inside the block: ${selfName(s)}` : `The ${s.rootScope ? SCOPE_LABELS[s.rootScope] : 'character'} this script runs for (this / root at the top)`;
    items.push({ label: selfIs, key: 's', sub: true, title: selfTitle, go: () => go({ ...s, view: { v: 'stmts' } }, selfIs.replace('…', '')) });

    for (const l of linksFrom(loc.scope, s.rootScope).filter((x) => x.main))
        items.push({ label: `${linkLabel(s, l)} is…`, key: l.k, hint: l.key, sub: true, go: () => go(withChain(s, stepFor(l, s), { v: 'stmts' }), `${linkLabel(s, l)} is`) });

    // (the event's scopes: "Child is…")
    items.push(...targetItems(s, 'character', ' is…'));

    for (const t of new Set((s.targets ?? []).map((x) => x.type).filter((x): x is string => !!x && x !== 'character')))
        items.push(...targetItems(s, t as ScopeType, ' is…'));

    items.push({ label: 'Someone else is…', key: 'o', sub: true, go: () => go({ ...s, view: { v: 'someone', type: 'character' } }, 'Someone else') });

    if (ITERATORS.some((i) => i.trigger && i.from.includes(loc.scope)))
        items.push({ label: 'Any of their…', key: 'n', sub: true, go: () => go({ ...s, view: { v: 'iters', mode: 'any' } }, 'Any') });

    if (linksFrom(loc.scope, s.rootScope).some((l) => l.to !== 'character'))
        items.push({ label: 'Their faith, culture, title…', key: 't', sub: true, go: () => go({ ...s, view: { v: 'related' } }, 'Their') });

    items.push({ label: 'Game & world…', sub: true, key: 'g', go: () => go({ ...s, view: { v: 'global' } }, 'Game & world') });
    items.push({ label: 'Other condition…', sub: true, key: 'c', title: 'Any trigger key the game’s script uses', go: () => go({ ...s, view: { v: 'other' } }, 'Other condition') });
    const title = loc.title ?? (s.title ? `Add to: ${s.title}` : 'Add a condition');
    return { title: s.draft.orNext ? 'Or…' : title, items, note: 'Keys: letter = item · type to filter · / search all · ← back · Esc close' };
}

function triggerStatements(s: State, group?: string): Menu
{
    const scope = subjectScope(s);
    const onlyLinks = s.chain.length > 0 && s.chain.every((c) => c.kind === 'link');
    const defs = statementsFor('trigger', scope).filter((d) => !d.subjectValue || onlyLinks);
    const subject = s.chain.length ? chainLabel(s.chain) : selfLabel(s);
    const pick = (d: StatementDef): Item => ({
        label: d.label,
        key: d.k,
        sub: d.params.length > 0,
        hint: d.script.split(/\s/)[0].replace(/\$\w+\$/g, '…'),
        match: d.words,
        go: () => go(start(s, d), d.label)
    });

    if (group)
    {
        const g = TRIGGER_GROUPS.find((x) => x.id === group)!;
        return { title: `${subject} › ${g.label.replace('…', '')}`, items: defs.filter((d) => d.group === group).map(pick) };
    }

    const items = defs.filter((d) => d.group === 'main').map(pick);

    for (const g of TRIGGER_GROUPS)
    {
        if (g.id === 'main' || !defs.some((d) => d.group === g.id))
            continue;

        items.push({ label: g.label, key: g.k, sub: true, go: () => go({ ...s, view: { v: 'stmts', group: g.id } }, g.label.replace('…', '')) });
    }

    items.push({ label: 'Their…', sub: true, key: 'h', title: 'Someone or something of theirs: liege, faith, title, any child…', go: () => go({ ...s, view: { v: 'related' } }, 'Their') });
    items.push({ label: 'Other condition…', sub: true, key: 'q', go: () => go({ ...s, view: { v: 'other' } }, 'Other condition') });
    return { title: subject.startsWith('You') ? 'You are…' : `${subject} is…`, items };
}

/** Historical characters by name (the index searches as one types): `character:<id>`. */
function characterMenu(s: State, data: PickerData, as: 'param' | 'subject'): Menu
{
    const pick = (e: RefEntry): Item =>
    {
        const label = e.display && e.display !== e.name ? e.display : e.name;
        const key = `character:${e.name}`;
        return {
            label,
            hint: e.about ?? e.name,
            title: e.about,
            match: e.name,
            icon: e.icon,
            sub: as === 'subject',
            go: () => (as === 'param' ? go(answer(s, key), label) : go(withChain(s, { kind: 'link', key, label, to: 'character' }, { v: 'stmts' }), label))
        };
    };
    return {
        title: 'Which historical character?',
        items: [],
        typeahead: true,
        wide: true,
        preview: as === 'param',
        search: async (q) => (await data.search('characters', q)).map(pick),
        note: 'Type a name, house or id to search'
    };
}

function globalMenu(s: State): Menu
{
    const defs = statementsFor(s.draft.loc.kind as PickKind, null);
    return {
        title: 'Game & world',
        items: defs.map((d) => ({ label: d.label, key: d.k, sub: d.params.length > 0, hint: d.script.split(/\s/)[0], go: () => go(start({ ...s, chain: [] }, d, []), d.label) }))
    };
}

// ---------------------------------------------------------------------------
// Parameter menus
// ---------------------------------------------------------------------------

function humanize(s: string): string
{
    const t = s.replace(/_/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
}

function scopeValueLabel(v: string): string
{
    const link = LINKS.find((l) => l.key === v);

    if (link)
        return link.label;

    const saved = SAVED_SCOPES.find((x) => x.key === v);

    if (saved)
        return saved.label;

    if (v === 'this')
        return 'Themselves';

    return v.startsWith('scope:') ? `${humanize(v.slice(6))} (${v})` : humanize(v);
}

function paramMenu(s: State, data: PickerData): Menu
{
    const menu = { ...paramMenuOf(s, data), preview: true };
    const p = s.pending!;
    const param = p.def.params[p.step];
    const now = p.now?.[param.name];

    if (now === undefined)
        return menu;

    const keep: Item = { label: `Keep: ${nowLabel(param, now, data)}`, hint: '⏎', go: () => go(answer(s, now), 'Keep') };
    return { ...menu, items: [keep, ...menu.items] };
}

/** A written parameter value as the menus call it ("Root", "At least", "5 years", an entry's name). */
function nowLabel(param: ParamDef, v: string, data: PickerData): string
{
    if (!v)
        return param.optional ?? 'none';

    switch (param.kind)
    {
        case 'compare':
            return COMPARE_OPTIONS.find((c) => c.op === v)?.label ?? v;
        case 'scope':
            return scopeValueLabel(v);
        case 'choice':
            return param.options.find((o) => o.value === v)?.label ?? v;
        case 'duration':
        {
            const m = /^(days|months|years) = (\d+)$/.exec(v);
            return m ? durationLabel(Number(m[2]), m[1]) : v;
        }
        case 'ref':
        {
            const name = param.prefix && v.startsWith(param.prefix) ? v.slice(param.prefix.length) : v;
            const e = data.list(param.type)?.find((x) => x.name === name);
            return e?.display && e.display !== e.name ? `${e.display} (${e.name})` : v;
        }
        case 'number':
            return param.signed && /^\d/.test(v) && Number(v) > 0 ? '+' + v : v;
        default:
            return v;
    }
}

/** Changing a written `key op value` of no catalog statement: "Keep …", then the values the game uses for the key. */
function otherKeyMenu(s: State, data: PickerData, key: string, op: string, now: string): Menu
{
    const kind = s.draft.loc.kind as PickKind;
    const keys = data.keys(kind);
    const info: ScriptKeyInfo = keys?.find((k) => k.key === key) ?? { key, count: 0, shapes: {}, values: [] };
    const menu = otherValueMenu(s, info, data);
    const keep: Item = { label: `Keep: ${op === '=' ? '' : op + ' '}${now}`, hint: '⏎', go: () => put(s, `${key} ${op} ${now}`, 'Keep') };
    return { ...menu, items: [keep, ...menu.items], wait: keys ? menu.wait : data.keysLoaded() };
}

function paramMenuOf(s: State, data: PickerData): Menu
{
    const p = s.pending!;
    const param = p.def.params[p.step];
    const answerItem = (label: string, value: string, extra: Partial<Item> = {}): Item => ({ label, go: () => go(answer(s, value), label), ...extra });
    const title = param.label;
    const none = param.optional !== undefined ? [answerItem(param.optional, '', { hint: 'leave out' })] : [];

    switch (param.kind)
    {
        case 'number':
        {
            const fmt = (n: number): string =>
            {
                const val = param.sign === -1 ? -Math.abs(n) : n;
                return (param.signed && val > 0 ? '+' : '') + String(val) + (param.unit && param.unit !== 'years' ? param.unit : '');
            };
            const value = (n: number): string => String(param.sign === -1 ? -Math.abs(n) : n);
            const items = [...none, ...param.presets.map((n) => answerItem(fmt(n), value(n))), ...(param.named ?? []).map((n) => answerItem(humanize(n), n, { hint: n, match: n }))];
            return {
                title,
                items,
                typeahead: true,
                number: (n) => [answerItem(fmt(n), value(n), { hint: '⏎' })],
                input: (text) =>
                {
                    const name = nameOf(text);
                    return name && !/^-?[\d.]+$/.test(name) ? answerItem(`Use “${name}”`, name, { hint: 'script value' }) : null;
                },
                note: 'Type a number, or a script value name'
            };
        }
        case 'compare':
            return { title, items: COMPARE_OPTIONS.map((c) => answerItem(c.label, c.op, { key: c.k, hint: c.op, sub: true })) };
        case 'choice':
            return { title, items: [...none, ...param.options.map((o) => answerItem(o.label, o.value, { key: o.k, hint: o.value, sub: p.step < p.def.params.length - 1 }))] };
        case 'duration':
        {
            const items = [...none, ...param.presets.map(([n, u]) => answerItem(durationLabel(n, u), durationScript(n, u)))];
            return {
                title,
                items,
                typeahead: true,
                number: (n) => (['days', 'months', 'years'] as const).map((u) => answerItem(durationLabel(n, u), durationScript(n, u), { hint: u })),
                note: 'Type a number: days, months or years'
            };
        }
        case 'scope':
            return scopeParamMenu(s, param, none, answerItem);
        case 'ref':
            return refParamMenu(s, param, data, none, answerItem);
        case 'name':
        {
            // (all of them — a filter finds any; the active mod's first, also among a filter's matches)
            const list = data.list(param.type);
            const active = data.activeMod()?.toLowerCase();
            const own = (e: RefEntry): boolean => !!active && !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active);
            return {
                title,
                typeahead: true,
                wide: true,
                items: [
                    ...none,
                    ...(modFirst(list, data) ?? []).map((e) => answerItem(e.name, e.name, { hint: own(e) ? (entryHint(e, data) ?? 'in your mod') : e.refs ? `${e.refs}×` : undefined, rank: own(e) ? -3 : undefined }))
                ],
                wait: list ? undefined : data.loaded(param.type),
                input: (text) =>
                {
                    const name = nameOf(text).toLowerCase();
                    return name ? answerItem(`New: “${name}”`, name, { hint: param.type }) : null;
                },
                note: `Type a ${param.type} name — existing ones are listed`
            };
        }
        case 'text':
        {
            // (values the game writes for this key — or one field of its block — from the key scan; a key filled by a
            // choice made before: `set_relation_$relation$` → set_relation_friend)
            const u = typeof param.usage === 'object' ? param.usage : undefined;
            const key = u?.key ?? (/^[\w$]+/.exec(p.def.script)?.[0] ?? '').replace(/\$(\w+)\$/g, (_m, n: string) => p.values[n] ?? '');
            const keys = param.usage ? data.keys(p.def.kind) : undefined;
            const info = keys?.find((k) => k.key === key);
            // (not the `$PARAM$`s scripted effects pass on)
            const used = ((u?.field ? info?.fieldValues?.[u.field] : info?.values) ?? []).map(([x]) => x).filter((x) => !x.includes('$'));
            const suggestions = [...new Set([...(param.suggestions ?? []), ...used])];
            return {
                title,
                typeahead: true,
                wide: true,
                wait: param.usage && !keys ? data.keysLoaded() : undefined,
                items: [...none, ...suggestions.map((x) => answerItem(humanize(x), x, { hint: x, match: x }))],
                input: (text) =>
                {
                    const t = text.trim();
                    return t ? answerItem(`Use “${t}”`, /\s/.test(t) ? `"${t}"` : t) : null;
                }
            };
        }
    }
}

function scopeParamMenu(s: State, param: Extract<ParamDef, { kind: 'scope'; }>, none: Item[], answerItem: (label: string, value: string, extra?: Partial<Item>) => Item): Menu
{
    const p = s.pending!;
    // relative to the statement's subject
    const from = p.chain.length ? p.chain[p.chain.length - 1].to : s.draft.loc.scope;
    const values: string[] = [];
    const add = (v: string): void =>
    {
        if (!values.includes(v))
            values.push(v);
    };

    for (const v of param.common ?? [])
        add(v);

    if (param.self)
        add('this');

    // (a script whose root is no character — a doctrine's: root only where its scope fits)
    if (!s.rootScope || s.rootScope === param.to)
        add('root');

    for (const l of linksFrom(from, s.rootScope))
        if (l.to === param.to)
            add(l.key);

    const targets = (s.targets ?? []).filter((t) => (t.type ?? 'character') === param.to);

    for (const t of targets)
        add(t.key);

    for (const sc of SAVED_SCOPES)
        add(sc.key);

    return {
        title: param.label,
        items: [
            ...none,
            ...values.map((v) =>
            {
                const t = targets.find((x) => x.key === v);
                return t ? answerItem(t.label, v, { hint: v, title: t.about }) : answerItem(scopeValueLabel(v).replace(/ \(scope:\w+\)$/, ''), v, { hint: v });
            }),
            ...(param.to === 'character' ? [{ label: 'A historical character…', sub: true, hint: 'character:…', go: () => go({ ...s, view: { v: 'character', as: 'param' } }, 'Historical character') } as Item] : [])
        ],
        input: (text) =>
        {
            const name = nameOf(text);

            if (!name)
                return null;

            const v = /^(scope:|root|prev|this|liege|primary_|var:)/.test(name) || name.includes('.') ? name : `scope:${name}`;
            // (checked against the catalog's links and the saved scopes' types: a warning, not a refusal)
            const warn = chainWarning(s, v, from, param.to);
            return answerItem(`Use “${v}”`, v, { hint: warn ? '⚠ check' : 'saved scope', warn, title: warn });
        },
        note: 'Space, then a saved scope or a chain (scope:x, liege.primary_spouse)'
    };
}

/** The active mod's entries (added or changed there) first, the rest in their order (most used first). */
function modFirst(entries: RefEntry[] | undefined, data: PickerData): RefEntry[] | undefined
{
    const active = data.activeMod()?.toLowerCase();

    if (!entries || !active)
        return entries;

    const mine = (e: RefEntry): boolean => !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active);
    return [...entries.filter(mine), ...entries.filter((e) => !mine(e))];
}

/** A list row's hint: "new in your mod" / "changed in your mod", else the key or how often it is used. */
function entryHint(e: RefEntry, data: PickerData): string | undefined
{
    if (e.mod?.state === 'merged' && data.activeMod() && e.mod.mods.some((m) => m.toLowerCase() === data.activeMod()!.toLowerCase()))
        return 'used in your mod';

    const active = data.activeMod()?.toLowerCase();
    const own = !!active && !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active);
    const base = e.display && e.display !== e.name ? e.name : e.refs ? `${e.refs}×` : undefined;

    if (!own)
        return base;

    return `${e.mod!.state === 'added' ? 'new in your mod' : e.mod!.state === 'same' ? 'in your mod, as in the game' : 'changed in your mod'}${base ? ' · ' + base : ''}`;
}

function refItems(param: Extract<ParamDef, { kind: 'ref'; }>, entries: RefEntry[], answerItem: (label: string, value: string, extra?: Partial<Item>) => Item, data?: PickerData): Item[]
{
    const active = data?.activeMod()?.toLowerCase();
    const own = (e: RefEntry): boolean => !!active && !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active);
    return (data ? (modFirst(entries, data) ?? entries) : entries).map((e) =>
        answerItem(e.display && e.display !== e.name ? e.display : e.name, (param.prefix ?? '') + e.name, {
            hint: data ? entryHint(e, data) : e.display && e.display !== e.name ? e.name : e.refs ? `${e.refs}×` : undefined,
            icon: e.icon,
            match: e.name,
            // (the active mod's own come first also among the matches of a filter)
            rank: own(e) ? -3 : undefined
        })
    );
}

function refParamMenu(s: State, param: Extract<ParamDef, { kind: 'ref'; }>, data: PickerData, none: Item[], answerItem: (label: string, value: string, extra?: Partial<Item>) => Item): Menu
{
    const fixed = [...none, ...(param.scopes ?? []).map((x) => answerItem(x.label, x.value, { hint: x.value }))];

    if (data.big(param.type))
    {
        return {
            title: param.label,
            typeahead: true,
            wide: true,
            items: fixed,
            search: async (q) => refItems(param, await data.search(param.type, q), answerItem),
            note: 'Type to search'
        };
    }

    const list = data.list(param.type);
    // ("＋ New trait…" and the ones made on the way)
    const fresh = newRefRows(s, data, param.type, { to: 'param', prefix: param.prefix });
    return {
        title: param.label,
        typeahead: true,
        wide: true,
        items: [...fixed, ...fresh.items, ...refItems(param, list ?? [], answerItem, data)],
        wait: list ? fresh.wait : data.loaded(param.type),
        input: (text) =>
        {
            const name = nameOf(text);
            return name ? answerItem(`Use “${(param.prefix ?? '') + name}”`, (param.prefix ?? '') + name, { hint: 'as typed' }) : null;
        },
        note: 'Type to filter — most used first'
    };
}

// ---------------------------------------------------------------------------
// After a statement: what next
// ---------------------------------------------------------------------------

function continuation(s: State): Menu
{
    const d = s.draft;
    const loc = d.loc;
    const items: Item[] = [{ label: 'Done', role: 'done', hint: '⏎', go: () => ({ finish: true }) }];
    const wrap = innermostWrap(d.top, d.last);
    const fresh = (draft: Draft, view: View = { v: 'root' }): State => ({ ...s, draft, chain: [], pending: undefined, view });
    // the statement written last at this place: after an if (a trigger_if, a random list, a switch) its continuations
    const block = blockAt(structuredClone(d.top), loc.path);
    const lastAt = block.length - 1;
    const last = block[lastAt] as SNode | undefined;
    const here = placeStatements(d).length;

    if (loc.kind === 'modifier' || loc.kind === 'field')
    {
        // (a value's parts only under a condition: a formula's `if = { limit = { … } … }`, a weight's `modifier = { … <conditions> }`)
        if (loc.kind === 'field' && (s.type === 'script_value' || s.type === 'weight') && !loc.back)
        {
            const weight = s.type === 'weight';
            items.push({
                label: 'When…',
                key: 'w',
                sub: true,
                title: weight ? 'Only if a condition holds (modifier = { … <conditions> })' : 'Only if a condition holds (if = { limit = { … } … })',
                go: () =>
                {
                    const { d: nd, path } = wrapAll(d, (kids) => (weight ? { k: 'modifier', op: '=', kids } : { k: 'if', op: '=', kids: [{ k: 'limit', op: '=', kids: [] }, ...kids] }));
                    return go(fresh({ ...nd, loc: { path: weight ? path : [...path, 0], kind: 'trigger', scope: loc.scope, label: loc.label, back: { ...loc }, title: 'When…' } }), 'When');
                }
            });
        }

        items.push({ label: 'And also…', key: 'a', sub: true, title: loc.kind === 'modifier' ? 'Another modifier here' : 'Another setting here', go: () => go(fresh(d), 'And also') });
        return { title: 'What next?', items, restart: true, note: '⏎ Done · ← undo the last step' };
    }

    if (loc.kind === 'effect')
    {
        items.push({
            label: 'When…',
            key: 'w',
            sub: true,
            title: here > 1 ? 'Only if a condition holds (if = { limit = { … } … }) — for all or a part of what is here' : 'Only if a condition holds (if = { limit = { … } … })',
            go: () => partOr(s, 'when', 'When')
        });
        items.push({ label: 'And also…', key: 'a', sub: true, title: 'Another effect here', go: () => go(fresh(d), 'And also') });

        // (right after an if / else_if: what happens otherwise)
        if (last && (last.k === 'if' || last.k === 'else_if'))
            items.push(...otherwiseItems(s, 'effect', lastAt));

        if (wrap)
            items.push({
                label: `And also for ${wrap.node.meta!.label}…`,
                key: 'f',
                sub: true,
                go: () => go(fresh({ ...d, loc: { path: wrap.path, kind: 'effect', scope: wrap.node.meta!.scope, label: wrap.node.meta!.label, back: { ...loc }, title: `And also for ${wrap.node.meta!.label}…` } }), `And also for ${wrap.node.meta!.label}`)
            });

        const iter = wrap?.node.meta?.wrap === 'iter' ? wrap : undefined;

        if (iter)
            items.push({
                label: `Only those who…`,
                key: 'o',
                sub: true,
                title: `Limit ${iter.node.meta!.label} (limit = { … })`,
                go: () =>
                {
                    const nd = cloneDraft(d);
                    const n = nodeAt(nd.top, iter.path)!;
                    const kids = (n.kids ??= []);
                    let li = kids.findIndex((k) => k.k === 'limit');

                    // (after the iterator's own parameters: `type = friend`, `order_by = age`)
                    if (li < 0)
                    {
                        li = kids.findIndex((k) => !ITERATOR_PARAMS.has(k.k));
                        li = li < 0 ? kids.length : li;
                        kids.splice(li, 0, { k: 'limit', op: '=', kids: [] });
                    }

                    return go(fresh({ ...nd, loc: { path: [...iter.path, li], kind: 'trigger', scope: iter.node.meta!.scope, label: iter.node.meta!.label, back: { ...loc }, title: `Only if ${iter.node.meta!.label.replace(/^(each|a random|the|any) /, 'the ')} is…` } }), 'Only those who');
                }
            });

        items.push({ label: 'Chance…', key: 'c', sub: true, title: 'Happens only with a chance (random = { chance = … })', go: () => partOr(s, 'chance', 'Chance') });

        // a random list: one of several outcomes, by weight
        if (last?.k === 'random_list')
            items.push({ label: 'Another outcome…', key: 'r', sub: true, title: 'Another outcome of the random list (with its weight)', go: () => go({ ...s, view: { v: 'weight', add: true } }, 'Another outcome') });
        else
            items.push({ label: 'One of several outcomes…', key: 'r', sub: true, title: 'random_list = { 50 = { … } 50 = { … } }: this or another outcome, by weight', go: () => partOr(s, 'random', 'Outcomes') });

        // a switch: a case per value of a condition
        if (last?.k === 'switch')
            items.push(...switchItems(s, lastAt));
        else
            items.push({ label: 'Depending on…', key: 's', sub: true, title: 'switch = { trigger = has_trait brave = { … } craven = { … } }: different effects for each value', go: () => go({ ...s, view: { v: 'switchOn' } }, 'Depending on') });

        items.push({ label: 'Later…', key: 'l', sub: true, title: 'An event after a delay (trigger_event)', go: () => go(start({ ...s, chain: [] }, statementById('e.later')!, []), 'Later') });
        const send = findSend(d);

        if (send)
            items.push({
                label: 'Pass along to the event…',
                key: 'p',
                sub: true,
                title: 'Who the names the event uses are (save_scope_as before trigger_event: saved names go along with it)',
                go: () => go({ ...s, view: { v: 'pass', event: send.event } }, 'Pass along')
            });

        items.push({ label: 'Hidden (no tooltip)', key: 'h', sub: here > 1, title: 'hidden_effect = { … }: the player does not see it in the tooltip', go: () => partOr(s, 'hidden', 'Hidden') });
    }
    else
    {
        items.push({ label: 'And also…', key: 'a', sub: true, title: 'Another condition (all must hold)', go: () => go(fresh(d), 'And') });
        items.push({ label: 'Or…', key: 'o', sub: true, title: 'Either the last condition or the next one (OR = { … })', go: () => go(fresh({ ...d, orNext: true }), 'Or') });
        items.push({ label: 'Not (negate the last)', key: 'n', go: () => go(fresh(negateLast(d), { v: 'cont' }), 'Not') });

        if (wrap)
            items.push({
                label: `And also for ${wrap.node.meta!.label}…`,
                key: 'f',
                sub: true,
                go: () => go(fresh({ ...d, loc: { path: wrap.path, kind: 'trigger', scope: wrap.node.meta!.scope, label: wrap.node.meta!.label, back: { ...loc }, title: `And also for ${wrap.node.meta!.label}…` } }), `And also for ${wrap.node.meta!.label}`)
            });

        // (an `any_` iterator: how many of them must match — the one just built, or the one this place is in)
        const holder = nodeAt(d.top, loc.path);
        const anyPath = wrap && /^any_/.test(wrap.node.k) ? wrap.path : holder && /^any_/.test(holder.k) ? loc.path : undefined;

        if (anyPath)
        {
            const who = (wrap && /^any_/.test(wrap.node.k) ? wrap.node : holder)?.meta?.label ?? 'any of them';
            items.push({ label: 'How many of them…', key: 'm', sub: true, title: `Not just ${who}: count >= 2 / count = all / percent >= 0.5 — how many of them must match`, go: () => go({ ...s, view: { v: 'count', path: anyPath } }, 'How many') });
        }

        items.push({
            label: 'Only when…',
            key: 'w',
            sub: true,
            title: 'trigger_if = { limit = { … } … }: checked only when another condition holds (else it counts as true)',
            go: () => partOr(s, 'trigger_if', 'Only when')
        });

        if (last && (last.k === 'trigger_if' || last.k === 'trigger_else_if'))
            items.push(...otherwiseItems(s, 'trigger', lastAt));

        if (here > 1)
            items.push({ label: 'At least some of these…', key: 'c', sub: true, title: 'calc_true_if = { amount >= 2 … }: how many of the conditions must hold', go: () => partOr(s, 'calc', 'At least some') });
    }

    if (loc.back)
    {
        const back = loc.back;
        const to = loc.backTo;
        items.push({
            label: to ? to.label : back.kind === 'effect' && loc.kind === 'trigger' ? 'Back to the effects' : 'Back out',
            key: 'b',
            sub: !!to,
            title: to ? 'On to what happens then' : 'Continue where this block was added',
            go: () => go(fresh({ ...d, loc: back, last: loc.path.slice(0, back.path.length + 1), orNext: false }, to ? { v: 'root' } : { v: 'cont' }), to ? to.label.replace('…', '') : 'Back')
        });
    }

    // (naming someone: only narrowing who it is)
    const shown = s.goal && loc.kind === 'effect' ? items.filter((i) => i.role === 'done' || i.label === 'Only those who…' || i.key === 'b') : items;

    // (a written if / else chain's member changed on its own: never wrapped apart from the rest of the chain, and with an
    // else after it nothing goes between them — the script editor changes the chain as a whole)
    if (s.bound && !loc.path.length)
    {
        const wraps = ['When…', 'Chance…', 'One of several outcomes…', 'Hidden (no tooltip)'];
        const after = ['And also…', 'Otherwise…', 'Depending on…', 'Later…', 'Pass along to the event…'];
        const kept = shown.filter((i) => !wraps.includes(i.label) && !(s.bound === 'elseAfter' && after.includes(i.label)));
        return { title: 'What next?', items: kept, restart: true, note: s.bound === 'else' ? 'Part of an if / else chain: to wrap it, change the chain in the script editor (Shift+Enter)' : 'An “else” follows it: nothing goes between them — the script editor changes the chain as a whole (Shift+Enter)' };
    }

    return { title: 'What next?', items: shown, restart: true, note: '⏎ Done · Ctrl+⏎ Done from anywhere · ← undo the last step' };
}

/** The first line of a statement, short: a part's row ("From “add_gold = 100” on"). */
function lineOf(n: SNode): string
{
    const t = printScript([n]).split('\n')[0].replace(/\s*\{$/, ' { … }');
    return t.length > 48 ? t.slice(0, 47) + '…' : t;
}

/** An action on a part of the place's statements: straight on with the only one, else "Which part?" first. */
function partOr(s: State, action: PartAction, crumb: string): Next
{
    return partStarts(s.draft).length ? go({ ...s, view: { v: 'part', action } }, crumb) : partDo(s, action, firstStatement(s.draft), crumb);
}

/** Where a part other than everything may start, last first: not at an else / else_if (it goes with its if). */
function partStarts(d: Draft): number[]
{
    const first = firstStatement(d);
    const block = blockAt(structuredClone(d.top), d.loc.path);
    const out: number[] = [];

    for (let i = block.length - 1; i > first; i--)
        if (!ELSE_KEYS.test(block[i].k))
            out.push(i);

    return out;
}

/** What "When…", "Chance…" … do with the statements from `from` on. */
function partDo(s: State, action: PartAction, from: number, crumb: string): Next
{
    const d = s.draft;
    const loc = d.loc;
    const fresh = (draft: Draft, view: View = { v: 'root' }): State => ({ ...s, draft, chain: [], pending: undefined, view });

    switch (action)
    {
        case 'when':
        {
            const { d: nd, path } = wrapAll(d, (kids) => ({ k: 'if', op: '=', kids: [{ k: 'limit', op: '=', kids: [] }, ...kids] }), from);
            return go(fresh({ ...nd, loc: { path: [...path, 0], kind: 'trigger', scope: loc.scope, label: loc.label, back: { ...loc }, title: 'When…' } }), crumb);
        }
        case 'trigger_if':
        {
            const { d: nd, path } = wrapAll(d, (kids) => ({ k: 'trigger_if', op: '=', kids: [{ k: 'limit', op: '=', kids: [] }, ...kids] }), from);
            return go(fresh({ ...nd, loc: { path: [...path, 0], kind: 'trigger', scope: loc.scope, label: loc.label, back: { ...loc }, title: 'Only when…' } }), crumb);
        }
        case 'hidden':
            return go(fresh(wrapAll(d, (kids) => ({ k: 'hidden_effect', op: '=', kids }), from).d, { v: 'cont' }), crumb);
        case 'chance':
            return go({ ...s, view: { v: 'chance', from } }, crumb);
        case 'random':
            return go({ ...s, view: { v: 'weight', from } }, crumb);
        case 'calc':
            return go({ ...s, view: { v: 'calc', from } }, crumb);
    }
}

/** "Which part?": everything at the place, or from one of its statements on (the last one alone …). */
function partMenu(s: State, action: PartAction): Menu
{
    const first = firstStatement(s.draft);
    const block = blockAt(structuredClone(s.draft.top), s.draft.loc.path);
    const n = block.length - first;
    const what: Record<PartAction, string> = {
        when: 'Only if a condition holds — for which part?',
        trigger_if: 'Checked only when another condition holds — which part?',
        chance: 'By chance — which part?',
        hidden: 'Hidden — which part?',
        random: 'One outcome of several — which part is this outcome?',
        calc: 'Which conditions count?'
    };
    const items: Item[] = [{ label: `Everything here (${n})`, key: 'e', hint: '⏎', go: () => partDo(s, action, first, 'All') }];

    for (const i of partStarts(s.draft))
        items.push({ label: i === block.length - 1 ? `Only the last: ${lineOf(block[i])}` : `From “${lineOf(block[i])}” on (${block.length - i})`, title: printScript(block.slice(i)), go: () => partDo(s, action, i, i === block.length - 1 ? 'The last' : `The last ${block.length - i}`) });

    return { title: what[action], items, wide: true, preview: true, note: '⏎ everything · or from one of them on' };
}

function chanceMenu(s: State, from?: number, path?: number[]): Menu
{
    // (`path`: a written `random` — its chance changed)
    const setAt = (n: number): Draft =>
    {
        const d = cloneDraft(s.draft);
        const node = nodeAt(d.top, path!)!;
        node.kids = [{ k: 'chance', op: '=', v: String(n) }, ...(node.kids ?? []).filter((c) => c.k !== 'chance')];
        return d;
    };
    const pick = (n: number): Item => ({
        label: `${n}%`,
        go: () => go({ ...s, draft: path ? setAt(n) : wrapAll(s.draft, (kids) => ({ k: 'random', op: '=', kids: [{ k: 'chance', op: '=', v: String(n) }, ...kids] }), from).d, view: { v: 'cont' } }, `${n}%`)
    });
    return { title: 'How likely?', items: [10, 20, 25, 33, 50, 66, 75, 90].map(pick), typeahead: true, preview: true, number: (n) => (n > 0 && n <= 100 ? [{ ...pick(n), hint: '⏎' }] : []), note: 'Type a percentage' };
}

/**
 * A random list's outcome weight: what is built (from `from` on) becomes its first outcome (`random_list = { 50 = { … } }`),
 * or — `add` — the list written last at the place gets another, empty one, whose effects follow.
 */
function weightMenu(s: State, from?: number, add?: boolean): Menu
{
    const d0 = s.draft;
    const loc = d0.loc;
    const pick = (n: number): Item => ({
        label: `Weight ${n}`,
        go: () =>
        {
            if (!add)
                return go({ ...s, draft: wrapAll(d0, (kids) => ({ k: 'random_list', op: '=', kids: [{ k: String(n), op: '=', kids }] }), from).d, view: { v: 'cont' } }, `Weight ${n}`);

            // another outcome: its effects inside it, "Back out" to the list's place
            const d = cloneDraft(d0);
            const block = blockAt(d.top, loc.path);
            const list = block[block.length - 1];
            list.kids = [...(list.kids ?? []), { k: String(n), op: '=', kids: [] }];
            const path = [...loc.path, block.length - 1, list.kids.length - 1];
            return go({ ...s, draft: { ...d, last: path, loc: { path, kind: 'effect', scope: loc.scope, label: loc.label, back: { ...loc }, title: `Outcome (weight ${n}): what happens` } }, chain: [], pending: undefined, view: { v: 'root' } }, `Weight ${n}`);
        }
    });
    return {
        title: add ? 'Another outcome — how likely (its weight)?' : 'This outcome — how likely (its weight)?',
        items: [10, 25, 50, 75, 100].map(pick),
        typeahead: true,
        preview: !add,
        number: (n) => (n > 0 ? [{ ...pick(n), hint: '⏎' }] : []),
        note: 'Weights are relative: 50 and 50 is half and half — type a number'
    };
}

/** `calc_true_if = { amount >= N … }`: how many of the conditions from `from` on must hold. */
function calcMenu(s: State, from: number): Menu
{
    const n = blockAt(structuredClone(s.draft.top), s.draft.loc.path).length - from;
    const pick = (k: number): Item => ({
        label: `At least ${k} of the ${n}`,
        go: () => go({ ...s, draft: wrapAll(s.draft, (kids) => ({ k: 'calc_true_if', op: '=', kids: [{ k: 'amount', op: '>=', v: String(k) }, ...kids] }), from).d, view: { v: 'cont' } }, `At least ${k}`)
    });
    const presets = Array.from({ length: Math.max(1, n - 1) }, (_x, i) => i + 1);
    return { title: 'How many must hold?', items: presets.map(pick), typeahead: true, preview: true, number: (k) => (k > 0 ? [{ ...pick(k), hint: '⏎' }] : []), note: 'Type a number' };
}

/** How many of an `any_` iterator's items must match: `count >= 2`, `count = all`, `percent >= 0.5`. */
function countMenu(s: State, path: number[]): Menu
{
    const set = (k: 'count' | 'percent', op: string, v: string, label: string, extra: Partial<Item> = {}): Item => ({
        label,
        hint: `${k} ${op} ${v}`,
        ...extra,
        go: () =>
        {
            const d = cloneDraft(s.draft);
            const n = nodeAt(d.top, path)!;
            const kids = (n.kids ?? []).filter((x) => x.k !== 'count' && x.k !== 'percent');
            // (after the iterator's `type`, before its conditions)
            const at = kids.findIndex((x) => x.k !== 'type');
            kids.splice(at < 0 ? kids.length : at, 0, { k, op, v });
            n.kids = kids;
            return go({ ...s, draft: d, view: { v: 'cont' } }, label);
        }
    });
    return {
        title: 'How many must match?',
        items: [
            set('count', '>=', '2', 'At least 2'),
            set('count', '>=', '3', 'At least 3'),
            set('count', '>=', '5', 'At least 5'),
            set('count', '=', 'all', 'All of them'),
            set('count', '=', '0', 'None of them'),
            set('percent', '>=', '0.5', 'At least half'),
            set('percent', '>', '0.5', 'Most of them')
        ],
        typeahead: true,
        preview: true,
        number: (k) => (k >= 0 && Number.isInteger(k) ? [set('count', '>=', String(k), `At least ${k}`, { hint: '⏎' })] : []),
        note: 'Type a number: at least that many'
    };
}

/**
 * Right after an if / else_if (a trigger_if): what happens — or holds — otherwise. "Otherwise, when…" makes an `else_if`
 * (`trigger_else_if`), asks its conditions and leads on to its content ("Then…"); "Otherwise…" an `else`.
 */
function otherwiseItems(s: State, kind: 'effect' | 'trigger', at: number): Item[]
{
    const d0 = s.draft;
    const loc = d0.loc;
    const effect = kind === 'effect';
    const add = (key: string, limit: boolean): { d: Draft; path: number[]; } =>
    {
        const d = cloneDraft(d0);
        const block = blockAt(d.top, loc.path);
        block.splice(at + 1, 0, { k: key, op: '=', kids: limit ? [{ k: 'limit', op: '=', kids: [] }] : [] });
        const path = [...loc.path, at + 1];
        return { d: { ...d, last: path }, path };
    };
    return [
        {
            label: 'Otherwise, when…',
            key: 'i',
            sub: true,
            title: effect ? 'else_if = { limit = { … } … }: when the conditions before failed and these hold' : 'trigger_else_if = { limit = { … } … }',
            go: () =>
            {
                const { d, path } = add(effect ? 'else_if' : 'trigger_else_if', true);
                const body: Loc = { path, kind, scope: loc.scope, label: loc.label, back: { ...loc }, title: effect ? 'Otherwise, when … — then:' : 'Otherwise, when … — then check:' };
                return go({ ...s, draft: { ...d, loc: { path: [...path, 0], kind: 'trigger', scope: loc.scope, label: loc.label, back: body, backTo: { view: 'root', label: 'Then…' }, title: 'Otherwise, when…' } }, chain: [], pending: undefined, view: { v: 'root' } }, 'Otherwise, when');
            }
        },
        {
            label: 'Otherwise…',
            key: 'e',
            sub: true,
            title: effect ? 'else = { … }: when none of the conditions before hold' : 'trigger_else = { … }',
            go: () =>
            {
                const { d, path } = add(effect ? 'else' : 'trigger_else', false);
                return go({ ...s, draft: { ...d, loc: { path, kind, scope: loc.scope, label: loc.label, back: { ...loc }, title: 'Otherwise…' } }, chain: [], pending: undefined, view: { v: 'root' } }, 'Otherwise');
            }
        }
    ];
}

/**
 * The catalog conditions a switch can go by (`switch = { trigger = has_trait … }`): one value, written `key = value` — a
 * trait, a government, a flag … — for the place's scope; the most used first.
 */
function switchable(scope: ScopeType): StatementDef[]
{
    return statementsFor('trigger', scope).filter((d) => d.params.length === 1 && ['ref', 'choice', 'name', 'text'].includes(d.params[0].kind) && new RegExp(`^\\w+ = \\$${d.params[0].name}\\$$`).test(d.script));
}

/** A case of a switch: its value (the condition's parameter), then its effects inside it. */
function caseStart(s: State, switchAt: number[], def: StatementDef): State
{
    const loc = s.draft.loc;
    const p0 = def.params[0];
    // (a text value: the values the game writes for the condition's own key)
    const param = { ...p0, label: `${def.label}: which case?`, ...(p0.kind === 'text' && p0.usage ? { usage: { key: def.script.split(' ')[0] } } : {}) } as ParamDef;
    const caseDef: StatementDef = { id: 'e.case', kind: 'effect', group: 'do', label: `Case: ${def.label}`, scopes: 'any', script: `$${param.name}$ = { }`, params: [param] };
    const d: Draft = { ...s.draft, loc: { path: switchAt, kind: 'effect', scope: loc.scope, label: loc.label, back: loc } };
    return { ...s, draft: d, chain: [], pending: { def: caseDef, chain: [], values: {}, step: 0, enter: { kind: 'effect', scope: loc.scope, label: loc.label, back: { ...loc }, title: 'In this case:' } }, view: { v: 'param' } };
}

/** "Depending on…": the condition whose values the cases are; the switch is written, its first case asked. */
function switchMenu(s: State, data: PickerData): Menu
{
    const loc = s.draft.loc;
    const scanned = data.keys('trigger');
    const count = (key: string): number => scanned?.find((k) => k.key === key)?.count ?? 0;
    const defs = switchable(loc.scope).sort((a, b) => count(b.script.split(' ')[0]) - count(a.script.split(' ')[0]));
    return {
        title: 'Depending on…',
        wide: true,
        wait: scanned ? undefined : data.keysLoaded(),
        items: defs.map((def) =>
        {
            const key = def.script.split(' ')[0];
            return {
                label: def.label,
                hint: key,
                match: `${key} ${def.words ?? ''}`,
                sub: true,
                go: () =>
                {
                    const d = cloneDraft(s.draft);
                    const block = blockAt(d.top, loc.path);
                    block.push({ k: 'switch', op: '=', kids: [{ k: 'trigger', op: '=', v: key }] });
                    return go(caseStart({ ...s, draft: { ...d, last: [...loc.path, block.length - 1] } }, [...loc.path, block.length - 1], def), def.label);
                }
            };
        }),
        note: 'A condition with one value: a case for each value'
    };
}

/** After a switch: another case (its value), or what happens in no case (`fallback`). */
function switchItems(s: State, at: number): Item[]
{
    const loc = s.draft.loc;
    const sw = blockAt(structuredClone(s.draft.top), loc.path)[at];
    const key = sw.kids?.find((k) => k.k === 'trigger')?.v ?? '';
    const def = switchable(loc.scope).find((x) => x.script.startsWith(key + ' '));
    const path = [...loc.path, at];
    const items: Item[] = [];

    if (def)
        items.push({ label: 'Another case…', key: 's', sub: true, title: `Another value of ${key}, with its effects`, go: () => go(caseStart(s, path, def), 'Another case') });

    if (!sw.kids?.some((k) => k.k === 'fallback'))
        items.push({
            label: 'In no case (fallback)…',
            key: 'e',
            sub: true,
            title: 'fallback = { … }: when none of the cases fits',
            go: () =>
            {
                const d = cloneDraft(s.draft);
                const node = nodeAt(d.top, path)!;
                node.kids = [...(node.kids ?? []), { k: 'fallback', op: '=', kids: [] }];
                const fp = [...path, node.kids.length - 1];
                return go({ ...s, draft: { ...d, last: fp, loc: { path: fp, kind: 'effect', scope: loc.scope, label: loc.label, back: { ...loc }, title: 'In no case:' } }, chain: [], pending: undefined, view: { v: 'root' } }, 'Fallback');
            }
        });

    return items;
}

// ---------------------------------------------------------------------------
// Other effect / condition: any key the loaded script uses
// ---------------------------------------------------------------------------

function shapeHint(k: ScriptKeyInfo): string
{
    const shapes = Object.entries(k.shapes).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    const top = shapes[0]?.[0];
    const words: Record<string, string> = { bool: 'yes/no', number: 'number', compare: '< > value', scope: 'someone', link: 'x:y', name: 'name', block: '{ … }' };
    return words[top ?? ''] ?? '';
}

/**
 * The conditions the game writes in this block (PickRequest.common: a law's `can_pass` — has_realm_law,
 * government_has_flag …), most used first: a catalog statement for the subject's scope goes step by step, any other key
 * as "Other…" offers it (its values, the entries it names); "All conditions…" is the root menu; the block's purpose
 * (PickRequest.about) is the note.
 */
function commonMenu(s: State, data: PickerData): Menu
{
    // (a modifier block: its modifiers, each to its amount)
    if (s.draft.loc.kind === 'modifier')
    {
        const list = data.modifiers();
        const byKey = new Map((list ?? []).map((m) => [m.key, m]));
        const items: Item[] = (s.common ?? []).map((k) =>
        {
            const m = byKey.get(k);
            const label = m ? (m.percent && !/%/.test(m.label) ? `${m.label} %` : m.label) : humanize(k);
            return { label, hint: k, match: k, sub: true, go: () => go({ ...s, view: { v: 'modValue', key: k } }, label) };
        });
        items.push({ label: 'All modifiers…', sub: true, title: 'Every modifier, by group (the root menu)', go: () => go({ ...s, view: { v: 'root' } }, 'All') });
        return {
            title: `Used here in the game${s.title ? ` — ${s.title}` : ''}`,
            items,
            wait: list ? undefined : data.modifiersLoaded(),
            note: s.about ? s.about : 'The modifiers the game’s definitions put in this block, most used first · ← all modifiers'
        };
    }

    const scanned = data.keys('trigger');
    const byKey = new Map((scanned ?? []).map((k) => [k.key, k]));
    const defs = statementsFor('trigger', subjectScope(s));
    const items: Item[] = (s.common ?? []).map((k) =>
    {
        const def = defs.find((d) => !d.subjectValue && new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`).test(d.script));
        const info = byKey.get(k) ?? { key: k, count: 0, shapes: {}, values: [] };

        if (def)
            return { label: def.label, hint: k, sub: def.params.length > 0, match: `${k} ${def.words ?? ''}`, go: () => go(start(s, def), def.label) };

        return { label: humanize(k), hint: k, sub: true, match: k, go: () => go({ ...s, view: { v: 'otherValue', key: info } }, k) };
    });
    items.push({ label: 'All conditions…', sub: true, title: 'Every condition, by subject (the root menu)', go: () => go({ ...s, view: { v: 'root' } }, 'All') });
    return {
        title: `Used here in the game${s.title ? ` — ${s.title}` : ''}`,
        items,
        wait: !scanned ? data.keysLoaded() : undefined,
        note: s.about ? s.about : 'The conditions the game’s definitions write in this block, most used first · ← all conditions'
    };
}

/**
 * What an "Other…" key leads to: a scripted effect / trigger with parameters asks each (`NAME = value`, what the game
 * passes for it listed), then its block's menu; any other key its values.
 */
function keyView(k: ScriptKeyInfo): View
{
    return k.scripted && k.params?.length ? { v: 'kfield', key: k.key, field: k.params[0], fields: [], ask: k.params.slice(1) } : { v: 'otherValue', key: k };
}

function otherMenu(s: State, data: PickerData): Menu
{
    const scanned = data.keys(s.draft.loc.kind as PickKind);
    const word = s.draft.loc.kind === 'effect' ? 'effect' : 'condition';
    // (the scan is made once per index build: scripted effects / triggers made since — the mod's first — join it)
    const type = s.draft.loc.kind === 'effect' ? 'scripted_effects' : 'scripted_triggers';
    const defined = data.list(type);
    const active = data.activeMod()?.toLowerCase();
    const own = (e: RefEntry): boolean => !!active && !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active);
    const known = new Set((scanned ?? []).map((k) => k.key));
    const fresh = (defined ?? []).filter((e) => !known.has(e.name)).sort((a, b) => Number(own(b)) - Number(own(a)));
    const keys = scanned && [...fresh.filter(own).map((e): ScriptKeyInfo => ({ key: e.name, count: 0, shapes: {}, values: [], scripted: true })), ...scanned, ...fresh.filter((e) => !own(e)).map((e): ScriptKeyInfo => ({ key: e.name, count: 0, shapes: {}, values: [], scripted: true }))];
    return {
        title: `Other ${word}`,
        typeahead: true,
        wide: true,
        items: keys
            ? keys.map((k) => ({ label: k.key, hint: k.count ? `${k.count}× · ${shapeHint(k)}${k.scripted ? ' · scripted' : ''}` : 'scripted · new', sub: true, go: () => go({ ...s, view: keyView(k) }, k.key) }))
            : [{ label: 'Collecting the keys the game uses…', role: 'info' }],
        wait: !scanned ? data.keysLoaded() : !defined ? data.loaded(type) : undefined,
        input: (text) =>
        {
            const key = nameOf(text);
            return key ? { label: `Use “${key}”`, sub: true, go: () => go({ ...s, view: { v: 'otherValue', key: { key, count: 0, shapes: {}, values: [] } } }, key) } : null;
        },
        note: `Every ${word} key the game’s script uses, most used first`
    };
}

/** `key = value` (`key < 16` when the value starts with an operator) at the place, for the subject chosen. */
function writeOther(s: State, key: string, value: string, label: string): Next
{
    const v = value.trim();
    const text = /^(<=|>=|!=|\?=|==|<|>|=)/.test(v) ? `${key} ${v}` : `${key} = ${v}`;
    let d = s.draft;

    for (const n of wrapChain(parseSnippet(text), s.chain))
        d = insert(d, n);

    return go({ ...s, draft: d, chain: [], pending: undefined, view: { v: 'cont' } }, label);
}

/** A value that names a scope: a link, root / this, a saved scope, a chain, `title:x`. */
const SCOPE_VALUE = /^(root|this|prev|scope:|title:|faith:|culture:|character:|dynasty:|house:|province:|religion:|[a-z_]+\.[a-z_:]|[a-z_]+$)/;

/**
 * The scope type the game's values for a key are (`add_courtier = scope:x`, `liege`, `root` … all characters), when at
 * least two of them say it and none says another; undefined when the values are no scopes or disagree.
 */
function valueScope(s: State, info: ScriptKeyInfo): ScopeType | undefined
{
    const from = subjectScope(s);
    const types = new Set<ScopeType>();
    let known = 0;

    for (const [v] of info.values)
    {
        if (/^[<>=!]/.test(v) || !SCOPE_VALUE.test(v) || (!v.includes(':') && !v.includes('.') && !LINKS.some((l) => l.key === v)))
            continue;

        const t = chainType(s, v, from).type;

        if (t)
            (types.add(t), known++);
    }

    return types.size === 1 && known >= 2 ? [...types][0] : undefined;
}

function otherValueMenu(s: State, info: ScriptKeyInfo, data: PickerData): Menu
{
    const finish = (value: string, label: string): Next => writeOther(s, info.key, value, label);
    const seen = new Set<string>();
    const items: Item[] = [];
    const add = (value: string, hint?: string): void =>
    {
        if (seen.has(value))
            return;

        seen.add(value);
        items.push({ label: value, hint, go: () => finish(value, value) });
    };

    if (info.shapes.bool)
    {
        add('yes');
        add('no');
    }

    // (a statement of the catalog for the key: its steps — "Trigger an event" asks when, offers "Pass along…")
    const kind = s.draft.loc.kind as PickKind;
    const def = STATEMENTS.find((d) => d.kind === kind && !d.hidden && new RegExp(`^${info.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`).test(d.script));

    if (def)
        items.push({ label: `${def.label}…`, sub: def.params.length > 0, hint: 'step by step', rank: -5, go: () => go(start(s, def), def.label) });

    // (its value names an entry: the entries, the active mod's first — own ones also first among a filter's matches)
    const list = info.refType ? data.list(info.refType) : undefined;

    // ("＋ New trait…": its entries' type can be made in the mod)
    const fresh = info.refType ? newRefRows(s, data, info.refType, { to: 'other', key: info.key }) : { items: [] };
    items.push(...fresh.items);

    if (info.refType && list)
    {
        const active = data.activeMod()?.toLowerCase();
        const own = (e: RefEntry): boolean => !!active && !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active);

        for (const e of modFirst(list, data) ?? list)
        {
            if (seen.has(e.name))
                continue;

            seen.add(e.name);
            items.push({ label: e.display && e.display !== e.name ? e.display : e.name, hint: entryHint(e, data), match: e.name, icon: e.icon, rank: own(e) ? -3 : undefined, go: () => finish(e.name, e.name) });
        }
    }

    for (const [v, n] of info.values)
        add(v, `${n}×`);

    for (const [v, n] of info.examples ?? [])
        add(v, `${n}×`);

    if (info.fields?.length && !info.examples?.length)
        add(`{ ${info.fields.slice(0, 3).map(([f]) => `${f} = `).join(' ')}}`, 'fields');

    return {
        title: `${info.key} = …`,
        preview: true,
        typeahead: true,
        wide: true,
        wait: info.refType && !list ? data.loaded(info.refType) : fresh.wait,
        items,
        input: (text) =>
        {
            const t = text.trim();

            if (!t)
                return null;

            // (a typed scope: checked against the type the game's values for the key have — a warning, not a refusal)
            const want = valueScope(s, info);
            const warn = want && SCOPE_VALUE.test(t) ? chainWarning(s, t, subjectScope(s), want) : undefined;
            return { label: `Use “${t}”`, hint: warn ? '⚠ check' : '⏎', warn, title: warn, go: () => finish(text, t) };
        },
        note: 'Type the value (a number, name, scope or { block }); common values are listed'
    };
}

// ---------------------------------------------------------------------------
// Changing a written block: its head (if, NOT / OR, a scope switch, an iterator …) or its fields (any other block)
// ---------------------------------------------------------------------------

/** What a written block statement is, for its "Change" menu (none: the generic block editor). */
type HeadKind = 'logic' | 'if' | 'random' | 'hidden' | 'iter' | 'scope' | 'list';

const LOGIC_KEYS: [string, string][] = [
    ['AND', 'All of these'],
    ['OR', 'Any of these'],
    ['NOR', 'None of these'],
    ['NAND', 'Not all of these'],
    ['NOT', 'Not']
];

function headKind(n: SNode): HeadKind | undefined
{
    if (LOGIC_KEYS.some(([k]) => k === n.k))
        return 'logic';

    if (/^(if|else_if|else|trigger_if|trigger_else_if|trigger_else)$/.test(n.k))
        return 'if';

    if (n.k === 'random' && n.kids?.some((c) => c.k === 'chance'))
        return 'random';

    if (n.k === 'hidden_effect' || n.k === 'show_as_tooltip')
        return 'hidden';

    if (n.k === 'random_list' || n.k === 'switch')
        return 'list';

    const it = /^(every|random|any|ordered)_(\w+)$/.exec(n.k);

    if (it && ITERATORS.some((i) => i.list === it[2]))
        return 'iter';

    if (n.k.includes('.') || n.k.includes(':') || LINKS.some((l) => l.key === n.k) || /^(prev|this)$/.test(n.k))
        return 'scope';

    return undefined;
}

/** The iterator a key names (`every_child` → child, mode every). */
function iterOf(key: string): { mode: 'every' | 'random' | 'any' | 'ordered'; def: (typeof ITERATORS)[number]; } | undefined
{
    const m = /^(every|random|any|ordered)_(\w+)$/.exec(key);
    const def = m && ITERATORS.find((i) => i.list === m[2]);
    return m && def ? { mode: m[1] as 'every' | 'random' | 'any' | 'ordered', def } : undefined;
}

/** The type a scope switch leads to (the last link of a chain; saved scopes and the rest: a character). */
function switchedScope(key: string, from: ScopeType): ScopeType
{
    let at = from;

    for (const part of key.split('.'))
        at = LINKS.find((l) => l.key === part && (l.from.length === 0 || l.from.includes(at)))?.to ?? (part.startsWith('scope:') || /^(prev|this)$/.test(part) ? 'character' : at);

    return at;
}

/** An iterator's subject as the menus say it: "each child", "any friend". */
function iterLabelOf(n: SNode): string
{
    const it = iterOf(n.k);

    if (!it)
        return humanize(n.k);

    const type = n.kids?.find((c) => c.k === 'type')?.v;
    const what = type ? humanize(type).toLowerCase() : it.def.label;
    return it.mode === 'every' ? `each ${what}` : it.mode === 'random' ? `a random ${what}` : it.mode === 'any' ? `any ${what}` : `the ${what}`;
}

/** A written block as the picker's draft: iterators and scope switches carry who they are about ("And also for …"). */
function loadNode(n: SNode, scope: ScopeType): SNode
{
    const kind = headKind(n);

    if (kind === 'iter')
        return { ...n, meta: { wrap: 'iter', label: iterLabelOf(n), scope: iterOf(n.k)!.def.to } };

    if (kind === 'scope')
        return {
            ...n,
            meta: {
                wrap: 'scope',
                label: humanize(n.k.split('.')
                    .pop()!
                    .replace(/^scope:/, '')),
                scope: switchedScope(n.k, scope)
            }
        };

    return n;
}

/** A written block the picker can change (no comments inside: they would be lost). */
function writtenBlockNode(text: string): SNode | undefined
{
    if (!keepsAsWritten(text))
        return undefined;

    const nodes = parseSnippet(text);
    return nodes.length === 1 && nodes[0].kids && nodes[0].op === '=' ? nodes[0] : undefined;
}

/** The states changing a written block opens with: its head menu beside the root (random lists, switches: "What next?"). */
function blockStart(root: State, n: SNode, kind: PickKind): { state: State; crumb?: string; }[]
{
    const h = headKind(n);
    const scope = root.draft.loc.scope;

    if (!h)
        return [{ state: root }, { state: { ...root, view: { v: 'kblock', key: n.k, fields: kfieldsOf(n) } }, crumb: n.k }];

    const draft: Draft = { top: [loadNode(n, scope)], loc: { path: [], kind, scope, label: root.draft.loc.label }, last: [0] };
    return [{ state: root }, { state: { ...root, draft, view: h === 'list' ? { v: 'cont' } : { v: 'head' } }, crumb: `Change ${n.k}` }];
}

/** Changing the written block (the draft's first statement): what it is, then "What next?" as after building one. */
function headMenu(s: State, data: PickerData): Menu
{
    const d = s.draft;
    const n = d.top[0];
    const kind = headKind(n);
    const loc = d.loc;
    const items: Item[] = [{ label: 'Keep it as it is', hint: '⏎', go: () => ({ finish: true }) }];
    /** the draft with the block replaced (or by several statements: unwrapped), then "What next?" */
    const set = (nodes: SNode[], crumb: string): Next => go({ ...s, draft: { ...d, top: nodes, last: [nodes.length - 1] }, view: { v: 'cont' } }, crumb);
    const inside = (k: Mode, title: string, path: number[] = [0], extra: Partial<Loc> = {}): Item => ({
        label: title,
        key: 'a',
        sub: true,
        title: 'Another statement inside it',
        go: () => go({ ...s, draft: { ...d, loc: { path, kind: k, scope: n.meta?.scope ?? loc.scope, label: n.meta?.label ?? loc.label, back: { ...loc }, title, ...extra } }, view: { v: 'root' } }, title.replace('…', ''))
    });
    const body = (n.kids ?? []).filter((c) => c.k !== 'limit' && c.k !== 'chance');

    switch (kind)
    {
        case 'logic':
            for (const [k, label] of LOGIC_KEYS)
                items.push({ label: `${label} (${k})`, hint: k === n.k ? 'now' : undefined, go: () => set([{ ...n, k }], label) });

            items.push({ label: 'Just the conditions (without it)', key: 'j', title: 'The conditions inside, each on its own', go: () => set(n.kids ?? [], 'Unwrapped') });
            items.push(inside('trigger', 'Another condition inside…'));
            break;
        case 'if':
        {
            const cond = /^trigger_/.test(n.k);
            const li = (n.kids ?? []).findIndex((c) => c.k === 'limit');

            if (n.k !== 'else' && n.k !== 'trigger_else')
                items.push({
                    label: 'Another condition…',
                    key: 'c',
                    sub: true,
                    title: 'Into its limit (all must hold)',
                    go: () =>
                    {
                        const nd = cloneDraft(d);
                        const node = nd.top[0];
                        let at = li;

                        if (at < 0)
                        {
                            node.kids = [{ k: 'limit', op: '=', kids: [] }, ...(node.kids ?? [])];
                            at = 0;
                        }

                        return go({ ...s, draft: { ...nd, loc: { path: [0, at], kind: 'trigger', scope: loc.scope, label: loc.label, back: { ...loc }, title: 'When…' } }, view: { v: 'root' } }, 'Another condition');
                    }
                });

            items.push(inside(cond ? 'trigger' : loc.kind, cond ? 'Another condition inside…' : 'Another effect inside…'));

            // (not with an else after it: that else would follow what was inside)
            if (s.bound !== 'elseAfter')
                items.push({ label: 'Always — without its conditions', key: 'w', title: 'What is inside, without the if', go: () => set(body, 'Always') });

            break;
        }
        case 'random':
        {
            const chance = n.kids?.find((c) => c.k === 'chance')?.v ?? '?';
            items.push({ label: `Another chance (now ${chance}%)…`, key: 'c', sub: true, go: () => go({ ...s, view: { v: 'chance', path: [0] } }, 'Chance') });
            items.push(inside('effect', 'Another effect inside…'));
            items.push({ label: 'Always — not by chance', key: 'w', go: () => set(body, 'Always') });
            break;
        }
        case 'hidden':
            items.push(inside('effect', 'Another effect inside…'));
            items.push({ label: 'Shown in the tooltip (without it)', key: 's', go: () => set(n.kids ?? [], 'Shown') });
            break;
        case 'iter':
        {
            const it = iterOf(n.k)!;
            items.push({ label: 'Another list…', key: 'l', sub: true, title: 'The same, over another list (children → vassals …)', go: () => go({ ...s, view: { v: 'iterSet', what: 'list' } }, 'Another list') });

            if (it.mode !== 'any')
                items.push({ label: 'Every / a random / the highest instead…', key: 'm', sub: true, go: () => go({ ...s, view: { v: 'iterSet', what: 'mode' } }, 'Instead') });

            if (it.def.type)
                items.push({ label: `${it.def.type.label.replace('?', '')}…`, key: 't', sub: true, go: () => go({ ...s, view: { v: 'iterSet', what: 'type' } }, 'Which kind') });

            if (it.mode === 'ordered')
                items.push({ label: 'Ordered by…', key: 'o', sub: true, go: () => go({ ...s, view: { v: 'iterSet', what: 'order' } }, 'Ordered by') });

            if (it.mode === 'any')
                items.push({ label: 'How many of them…', key: 'h', sub: true, go: () => go({ ...s, view: { v: 'count', path: [0] } }, 'How many') });

            items.push(inside(it.mode === 'any' ? 'trigger' : 'effect', it.mode === 'any' ? 'Another condition for them…' : 'Another effect for them…'));
            break;
        }
        case 'scope':
            items.push({ label: 'Someone (something) else instead…', key: 'e', sub: true, title: 'The same, for another one', go: () => go({ ...s, view: { v: 'scopeSet' } }, 'Instead') });
            items.push(inside(loc.kind, loc.kind === 'trigger' ? 'Another condition for them…' : 'Another effect for them…'));
            break;
    }

    items.push({ label: 'What next…', key: 'n', sub: true, title: 'Wrap it (When…, Chance…), add after it …', go: () => go({ ...s, view: { v: 'cont' } }, 'What next') });
    return { title: `Change: ${lineOf(n)}`, items, wide: true, preview: true, note: '⏎ keeps it · letters choose' };
}

/** Iterator parameters of one mode only (the game's use: weight with random_, order_by … with ordered_, count with any_). */
const MODE_PARAMS: Record<string, string> = { weight: 'random', order_by: 'ordered', position: 'ordered', max: 'ordered', min: 'ordered', check_range_bounds: 'ordered', count: 'any', percent: 'any' };

/** Changing a written iterator: another list, mode, kind (a relation's type) or order. */
function iterSetMenu(s: State, data: PickerData, what: 'list' | 'mode' | 'type' | 'order'): Menu
{
    const d = s.draft;
    const n = d.top[0];
    const it = iterOf(n.k)!;
    const set = (key: string, kids: SNode[], crumb: string): Next =>
    {
        const node = loadNode({ k: key, op: n.op, kids }, d.loc.scope);
        return go({ ...s, draft: { ...d, top: [node, ...d.top.slice(1)] }, view: { v: 'cont' } }, crumb);
    };
    const without = (k: string): SNode[] => (n.kids ?? []).filter((c) => c.k !== k);
    const withParam = (k: string, v: string): SNode[] => [{ k, op: '=', v }, ...without(k)];

    if (what === 'list' || what === 'mode')
    {
        const modes = what === 'mode' ? (['every', 'random', 'ordered'] as const).filter((m) => m !== it.mode && (m !== 'ordered' || it.def.orders)) : [it.mode];
        // (another list of the same kind of items: its statements are for those — children → vassals, not titles)
        const lists = what === 'list' ? ITERATORS.filter((i) => i !== it.def && i.to === it.def.to && (it.mode === 'any' ? i.trigger : i.effect) && i.from.some((f) => it.def.from.includes(f))) : [it.def];
        const items: Item[] = [];

        for (const m of modes)
            for (const i of lists)
            {
                const key = `${m}_${i.list}`;
                const word = m === 'every' ? 'Every' : m === 'random' ? 'A random' : m === 'ordered' ? 'The highest' : 'Any';
                items.push({
                    label: `${word} ${i.label}`,
                    hint: key,
                    go: () =>
                    {
                        // (the old `type` only for a list of the same kinds — a relation's is no secret's —, and only the
                        // new mode's own parameters: a random one's weight, an ordered one's order_by / position / max …)
                        const kids = (i.type?.ref === it.def.type?.ref ? (n.kids ?? []) : without('type')).filter((c) => !MODE_PARAMS[c.k] || MODE_PARAMS[c.k] === m);
                        const node = loadNode({ k: key, op: n.op, kids }, d.loc.scope);
                        const next: State = { ...s, draft: { ...d, top: [node, ...d.top.slice(1)] } };
                        // (ordered without an order: by what, next)
                        return go({ ...next, view: m === 'ordered' && !kids.some((c) => c.k === 'order_by') ? { v: 'iterSet', what: 'order' } : { v: 'cont' } }, `${word} ${i.label}`);
                    }
                });
            }

        return { title: what === 'list' ? 'Over which list?' : 'Which of them?', items, wide: true, preview: true };
    }

    if (what === 'type' && it.def.type)
    {
        const list = modFirst(data.list(it.def.type.ref), data);
        const pick = (v: string | null, label: string): Item => ({ label, hint: v ?? undefined, match: v ?? undefined, go: () => set(n.k, v ? withParam('type', v) : without('type'), label) });
        return {
            title: it.def.type.label,
            typeahead: true,
            wide: true,
            preview: true,
            items: [...(it.def.type.optional ? [pick(null, it.def.type.optional)] : []), ...(list ?? []).map((e) => pick(e.name, e.display && e.display !== e.name ? e.display : humanize(e.name)))],
            wait: list ? undefined : data.loaded(it.def.type.ref),
            input: (text) =>
            {
                const name = nameOf(text);
                return name ? pick(name, `“${name}”`) : null;
            }
        };
    }

    const pick = (v: string, label: string): Item => ({ label: `Highest ${label}`, hint: v, go: () => set(n.k, withParam('order_by', v), label) });
    return {
        title: 'Ordered by…',
        typeahead: true,
        preview: true,
        items: (it.def.orders ?? []).map(([v, l]) => pick(v, l)),
        input: (text) =>
        {
            const name = nameOf(text);
            return name ? { ...pick(name, name), label: `Use “${name}”` } : null;
        }
    };
}

/** Changing a written scope switch: the same statements for someone (something) else of the same type. */
function scopeSetMenu(s: State): Menu
{
    const d = s.draft;
    const n = d.top[0];
    const to = switchedScope(n.k, d.loc.scope);
    const set = (key: string, label: string): Next => go({ ...s, draft: { ...d, top: [loadNode({ k: key, op: n.op, kids: n.kids }, d.loc.scope), ...d.top.slice(1)] }, view: { v: 'cont' } }, label);
    const items: Item[] = [];
    const seen = new Set<string>([n.k]);
    const add = (key: string, label: string, extra: Partial<Item> = {}): void =>
    {
        if (seen.has(key))
            return;

        seen.add(key);
        items.push({ label, hint: key, go: () => set(key, label), ...extra });
    };

    for (const l of linksFrom(d.loc.scope, s.rootScope))
        if (l.to === to)
            add(l.key, linkLabel(s, l));

    for (const t of s.targets ?? [])
        if ((t.type ?? 'character') === to)
            add(t.key, t.label, { title: t.about });

    if (to === 'character')
    {
        for (const sc of SAVED_SCOPES)
            add(sc.key, sc.label);
    }

    return {
        title: `Instead of ${n.k}`,
        items,
        wide: true,
        preview: true,
        input: (text) =>
        {
            const name = nameOf(text);
            const key = !name ? '' : /^(scope:|root|prev|this)/.test(name) || name.includes('.') ? name : `scope:${name}`;
            return key ? { label: `Use “${key}”`, hint: 'as typed', go: () => set(key, key) } : null;
        },
        note: 'Space, then a link or saved scope'
    };
}

/** A field of a written block (the generic block editor): `k op v`, the value as written (a block inline). */
export interface KField
{
    k: string;
    op: string;
    v: string;
}

function kfieldsOf(n: SNode): KField[]
{
    return (n.kids ?? []).map((c) => ({ k: c.k, op: c.op, v: c.kids ? printScript([c]).replace(/^[^=]*=\s*/, '').replace(/\s+/g, ' ') : (c.v ?? '') }));
}

function kblockText(key: string, fields: KField[]): string
{
    return `${key} = { ${fields.map((f) => (f.op ? `${f.k} ${f.op} ${f.v}` : f.k)).join(' ')} }`;
}

/** The block written: at the place, for the subject chosen (a scope switch / iterator around it). */
function finishKey(s: State, text: string, crumb: string): Next
{
    let d = s.draft;

    for (const n of wrapChain(parseSnippet(text), s.chain))
        d = insert(d, n);

    const next: State = { ...s, draft: d, chain: [], pending: undefined, view: { v: 'cont' } };
    return s.once ? { finish: true, state: next } : go(next, crumb);
}

/** The key's scan info (its fields, the values written for each, a scripted one's parameters). */
function keyInfo(s: State, data: PickerData, key: string): ScriptKeyInfo | undefined
{
    return data.keys(s.draft.loc.kind as PickKind)?.find((k) => k.key === key);
}

/**
 * Any block statement, field by field (a written one the catalog has no template for; a scripted effect's call with
 * its parameters): Done, each field (its value: the values the game writes for it, its entries, or typed), "Add a
 * field…" (the fields the game writes in it, a scripted one's parameters).
 */
function kblockMenu(s: State, data: PickerData, key: string, fields: KField[]): Menu
{
    const info = keyInfo(s, data, key);
    const items: Item[] = [{ label: 'Done', hint: '⏎', title: kblockText(key, fields), go: () => finishKey(s, kblockText(key, fields), key) }];

    fields.forEach((f, i) =>
        items.push({
            label: f.op ? f.k : `${f.k} (a value)`,
            hint: f.op ? `${f.op === '=' ? '' : f.op + ' '}${f.v.length > 40 ? f.v.slice(0, 39) + '…' : f.v}` : undefined,
            sub: true,
            go: () => go({ ...s, view: { v: 'kfield', key, field: f.k, index: i, fields, from: 1 } }, f.k)
        })
    );
    items.push({ label: 'Add a field…', key: '+', sub: true, title: info?.params?.length ? `Its parameters: ${info.params.join(', ')}` : 'The fields the game writes in it', go: () => go({ ...s, view: { v: 'kadd', key, fields } }, 'Add a field') });
    return { title: `${key} = { … }`, items, wide: true, preview: true, wait: data.keys(s.draft.loc.kind as PickKind) ? undefined : data.keysLoaded(), note: '⏎ Done · a field to change it' };
}

/** The fields to add: a scripted one's parameters first, then those the game writes in it, or a typed one. */
function kaddMenu(s: State, data: PickerData, key: string, fields: KField[]): Menu
{
    const info = keyInfo(s, data, key);
    const has = new Set(fields.map((f) => f.k));
    const known = [...new Set([...(info?.params ?? []), ...(info?.fields ?? []).map(([f]) => f)])].filter((f) => !has.has(f));
    const pick = (f: string, hint?: string): Item => ({ label: f, hint, sub: true, go: () => go({ ...s, view: { v: 'kfield', key, field: f, fields, from: 2 } }, f) });
    return {
        title: `Add to ${key}`,
        typeahead: known.length > 20,
        wide: true,
        items: known.map((f) => pick(f, info?.params?.includes(f) ? 'parameter' : `${info?.fields?.find(([x]) => x === f)?.[1] ?? 0}×`)),
        input: (text) =>
        {
            const f = nameOf(text);
            return f && !has.has(f) ? pick(f, 'as typed') : null;
        },
        note: 'Type a field name'
    };
}

/**
 * A field's value in the block editor: "Keep", the entries it names, the values the game writes for it (a scripted
 * effect's parameter: what the game passes), yes / no, or typed. `ask`: parameters still to ask, one after the other
 * (a scripted effect picked from "Other…"); `from`: the block's menu is that many menus up (it takes the value).
 */
function kfieldMenu(s: State, data: PickerData, key: string, field: string, fields: KField[], index?: number, ask?: string[], from?: number): Menu
{
    const info = keyInfo(s, data, key);
    const cur = index !== undefined ? fields[index] : undefined;
    const write = (v: string | null, label: string): Next =>
    {
        const nf = [...fields];

        if (v === null)
            nf.splice(index!, 1);
        else if (cur)
            nf[index!] = { ...cur, op: cur.op || '=', v };
        else
            nf.push({ k: field, op: '=', v });

        // (a scripted effect's parameters: the next one; then the block's menu — or back into it)
        if (ask?.length)
            return go({ ...s, view: { v: 'kfield', key, field: ask[0], fields: nf, ask: ask.slice(1) } }, label);

        const state: State = { ...s, view: { v: 'kblock', key, fields: nf } };
        return from ? { state, crumb: label, back: from } : go(state, label);
    };
    const items: Item[] = [];
    const seen = new Set<string>();
    const add = (v: string, label: string, extra: Partial<Item> = {}): void =>
    {
        if (seen.has(v) || v.includes('$'))
            return;

        seen.add(v);
        items.push({ label, hint: v === label ? undefined : v, match: v, go: () => write(v, label), ...extra });
    };

    if (cur?.op)
        items.push({ label: `Keep: ${cur.v}`, hint: '⏎', go: () => write(cur.v, 'Keep') });

    if (cur && from)
        items.push({ label: 'Remove this field', go: () => write(null, 'Removed') });

    // (the entries it names: an opinion modifier, a trait …)
    const ref = info?.fieldRefs?.[field];
    const list = ref ? modFirst(data.list(ref), data) : undefined;

    for (const e of list ?? [])
        add(e.name, e.display && e.display !== e.name ? e.display : e.name, { icon: e.icon, hint: entryHint(e, data) });

    const values = info?.fieldValues?.[field] ?? [];

    for (const [v, n] of values)
        add(v, v, { hint: `${n}×` });

    if (!values.length && !list)
    {
        add('yes', 'yes');
        add('no', 'no');
    }

    const param = info?.params?.includes(field);
    return {
        title: `${key}: ${field}${cur?.op ? ` (now ${cur.v})` : ''}`,
        typeahead: true,
        wide: true,
        preview: true,
        items,
        wait: ref && !list ? data.loaded(ref) : undefined,
        input: (text) =>
        {
            const t = text.trim();
            return t ? { label: `Use “${t}”`, hint: '⏎', go: () => write(/\s/.test(t) && !/^[{"]/.test(t) ? `"${t}"` : t, t) } : null;
        },
        note: param ? `A parameter of ${key}: what the game passes for it is listed — or type a value` : 'The values the game writes for it are listed — or type one'
    };
}

// ---------------------------------------------------------------------------
// "＋ New trait…": a new entry of the type a list asks for, made in the active mod when the statement is written
// ---------------------------------------------------------------------------

/** Where a new entry's key goes once it is made: a statement's parameter, a setting, an "Other…" key's value. */
export type NewRefThen = { to: 'param'; prefix?: string; } | { to: 'field'; key: string; } | { to: 'other'; key: string; };

/** "Traits" → "trait", "Opinion Modifiers" → "opinion modifier" */
function singularLabel(label: string): string
{
    const l = label.toLowerCase();
    return l.endsWith('ies') ? l.slice(0, -3) + 'y' : l.replace(/s$/, '');
}

/** The key written where the new entry was asked for (a new key named again: the same). */
function useNewRef(s: State, key: string, then: NewRefThen, crumb: string): Next
{
    switch (then.to)
    {
        case 'param':
            return go(answer(s, (then.prefix ?? '') + key), crumb);
        case 'field':
            return put(s, `${then.key} = ${key}`, crumb);
        case 'other':
            return writeOther(s, then.key, key, crumb);
    }
}

/**
 * The rows a list of entries of `type` starts with when the caller makes new entries (PickRequest.newEntries): the
 * entries made on the way ("… · new"), and "＋ New trait…" — when the active mod can take one of the type (its
 * `newEntryPlan`: no problem, a file of its own — not laws in law groups, faiths in religions).
 */
function newRefRows(s: State, data: PickerData, type: string, then: NewRefThen): { items: Item[]; wait?: Promise<unknown>; }
{
    if (!s.newEntries || !data.newPlan || !data.activeMod())
        return { items: [] };

    const plan = data.newPlan(type);
    const made = (s.creates ?? []).filter((c) => c.what === 'entry' && c.fields.some(([k, v]) => k === 'type' && v === type));
    const items: Item[] = made.map((c) => ({ label: c.loc || humanize(c.key), hint: `${c.key} · new`, match: c.key, rank: -5, go: () => useNewRef(s, c.key, then, c.key) }));

    if (!plan)
        return { items, wait: data.newPlanLoaded?.(type) };

    if (!plan.problem && !plan.nested && plan.rel)
    {
        const one = singularLabel(plan.label);
        items.push({
            label: `＋ New ${one}…`,
            hint: 'in your mod',
            match: `+ new ${one}`,
            explicit: true,
            title: `A new ${one}, made in ${plan.mod ?? 'your mod'} (${plan.rel}) when this is written — its template, to fill in afterwards`,
            sub: true,
            go: () => go({ ...s, view: { v: 'newRef', type, then } }, `New ${one}`)
        });
    }

    return { items };
}

/** The new entry's key: typed (a valid key nobody has), or — events — the mod's next free id. */
function newRefMenu(s: State, data: PickerData, type: string, then: NewRefThen): Menu
{
    const plan = data.newPlan?.(type);
    const list = data.list(type);
    const one = plan ? singularLabel(plan.label) : type;
    const valid = type === 'events' ? /^[A-Za-z_][\w-]*\.\d+$/ : /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
    const taken = (k: string): boolean => !!list?.some((e) => e.name === k) || !!s.creates?.some((c) => c.key === k);
    const pick = (key: string): Next => (plan?.name ? go({ ...s, view: { v: 'newRefName', type, key, then } }, key) : made(s, type, key, undefined, then));
    const items: Item[] = plan?.key && !taken(plan.key) ? [{ label: `${plan.key}`, hint: 'the next free id', sub: !!plan.name, go: () => pick(plan.key!) }] : [];
    return {
        title: `New ${one}: its key`,
        typeahead: true,
        wide: true,
        items: items.length ? items : [{ label: type === 'events' ? 'Type its id: namespace.number' : `Type its key, e.g. my_${one.replace(/\W+/g, '_')}`, role: 'info' }],
        wait: list ? undefined : data.loaded(type),
        input: (text) =>
        {
            const key = nameOf(text);

            if (!key)
                return null;

            if (taken(key))
                return { label: `“${key}” exists already`, role: 'info' };

            if (!valid.test(key))
                return { label: type === 'events' ? `“${key}” is no event id (namespace.number)` : `“${key}”: letters, digits and _ only`, role: 'info' };

            return { label: `Make “${key}”…`, hint: plan?.rel, sub: !!plan?.name, go: () => pick(key) };
        },
        note: `Written into ${plan?.rel ?? 'your mod'} when the statement is — Undo takes it back with it`
    };
}

/** The new entry's name in game (its localization): typed, or the key made readable. */
function newRefNameMenu(s: State, type: string, key: string, then: NewRefThen): Menu
{
    const plain = humanize(key.replace(/^.*\./, ''));
    return {
        title: `${key}: its name in game`,
        typeahead: true,
        wide: true,
        items: [{ label: `Keep: ${plain}`, hint: '⏎', unfiltered: true, go: () => made(s, type, key, undefined, then) }],
        input: (text) => (text.trim() ? { label: `Use “${text.trim()}”`, hint: '⏎', go: () => made(s, type, key, text.trim(), then) } : null),
        note: 'What the game shows for it'
    };
}

/** The new entry is remembered (PickResult.creates: made before the statement is written) and its key used. */
function made(s: State, type: string, key: string, name: string | undefined, then: NewRefThen): Next
{
    const creates: EntryCreate[] = [...(s.creates ?? []).filter((c) => c.key !== key), { what: 'entry', key, fields: [['type', type]], ...(name ? { loc: name } : {}) }];
    return useNewRef({ ...s, creates }, key, then, key);
}

// ---------------------------------------------------------------------------
// Search everything ("/")
// ---------------------------------------------------------------------------

function searchMenu(s: State, data: PickerData): Menu
{
    if (s.draft.loc.kind === 'modifier')
        return modGroupMenu(s, data, '', false, true);

    if (s.draft.loc.kind === 'field')
        return { ...fieldRoot(s, data), typeahead: true };

    const kind = s.draft.loc.kind as PickKind;
    const scope = subjectScope(s);
    const items: Item[] = [];
    const groupLabel = (d: StatementDef): string => kind === 'effect' ? (VERB[d.group] ? `${VERB[d.group]} ${d.label.charAt(0).toLowerCase()}${d.label.slice(1)}` : d.label) : d.label;

    for (const d of statementsFor(kind, scope))
    {
        if (d.subjectValue)
            continue;

        items.push({ label: groupLabel(d), hint: d.script.split(/\s/)[0].replace(/\$\w+\$/g, '…'), match: `${d.words ?? ''} ${d.script}`, sub: d.params.length > 0, go: () => go(start(s, d), groupLabel(d)) });
    }

    for (const d of statementsFor(kind, null))
        items.push({ label: d.label, hint: d.script.split(/\s/)[0], match: d.words, sub: d.params.length > 0, go: () => go(start({ ...s, chain: [] }, d, []), d.label) });

    for (const k of data.keys(kind) ?? [])
        items.push({ label: k.key, hint: `${k.count}× · other`, rank: 3, sub: true, go: () => go({ ...s, view: keyView(k) }, k.key) });

    return { title: `Search ${kind === 'effect' ? 'effects' : 'conditions'}`, items, typeahead: true, wide: true, note: 'Type to search the catalog and every key the game uses' };
}

/** Opens the search menu from the current state (the "/" key). */
export function searchState(s: State): State
{
    return { ...s, pending: undefined, view: { v: 'search' } };
}

/** A statement can be finished right away (Ctrl+Enter): something is built and no statement is half done. */
export function canFinish(s: State): boolean
{
    return s.raw !== undefined || s.draft.top.length > 0;
}

/**
 * The new entries the finished script uses (PickResult.creates): one made inside a statement that was then dropped
 * (Ctrl+⏎ on a half-built one) or replaced is not made.
 */
export function usedCreates(s: State): EntryCreate[] | undefined
{
    const words = new Set(resultText(s).match(/[^\s{}=<>!?"#]+/g) ?? []);
    const used = (s.creates ?? []).filter((c) => words.has(c.key));
    return used.length ? used : undefined;
}

/** Readable sentence of described lines (the PickResult summary). */
export function sentenceOf(lines: { text: (string | { text: string; })[]; children?: unknown[]; ifConds?: unknown[]; }[]): string
{
    const text = (l: { text: (string | { text: string; })[]; }): string => l.text.map((x) => (typeof x === 'string' ? x : x.text)).join('');
    const parts: string[] = [];

    for (const l of lines as { text: (string | { text: string; })[]; children?: typeof lines; icon?: string; }[])
    {
        const own = text(l).replace(/:$/, '');

        if (l.children?.length)
        {
            const inner = sentenceOf(l.children);

            if (/^(If|Otherwise)/.test(own))
                parts.push(`${inner}, ${own.charAt(0).toLowerCase()}${own.slice(1)}`);
            else
                parts.push(`${own}: ${inner}`);
        }
        else
            parts.push(own);
    }

    return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Stat modifiers (`diplomacy = 2`, `stress_gain_mult = 0.1`) and definition fields (opinion modifiers)
// ---------------------------------------------------------------------------

/** Puts one written statement at the draft's place; "What next?" follows. */
function put(s: State, text: string, crumb: string): Next
{
    let d = s.draft;

    for (const n of parseSnippet(text))
        d = insert(d, n);

    const next: State = { ...s, draft: d, chain: [], pending: undefined, view: { v: 'cont' } };
    return s.once ? { finish: true, state: next } : go(next, crumb);
}

/** Groups of the modifier menus: a modifier goes to the first whose pattern matches its key. */
const MOD_GROUPS: { id: string; label: string; k: string; re: RegExp; }[] = [
    { id: 'skills', label: 'Skills…', k: 's', re: /^(diplomacy|martial|stewardship|intrigue|learning|prowess)(_|$)/ },
    { id: 'opinion', label: 'Opinion…', k: 'o', re: /opinion/ },
    { id: 'prestige', label: 'Prestige, piety & renown…', k: 'p', re: /prestige|piety|renown/ },
    { id: 'money', label: 'Gold, income & costs…', k: 'g', re: /gold|income|tax|_cost/ },
    { id: 'health', label: 'Health & fertility…', k: 'h', re: /health|fertility|life_expectancy|negate_|epidemic|disease|pregnan/ },
    { id: 'stress', label: 'Stress & dread…', k: 't', re: /stress|dread/ },
    { id: 'military', label: 'Military…', k: 'm', re: /knight|levy|men_at_arms|maa|army|siege|advantage|supply|movement|garrison|fort|raid|commander|damage|toughness|pursuit|screen|counter|hostile_county/ },
    { id: 'lifestyle', label: 'Lifestyle & experience…', k: 'l', re: /lifestyle|_xp|experience/ },
    { id: 'schemes', label: 'Schemes & secrets…', k: 'c', re: /scheme|secret|agent|plot/ },
    { id: 'realm', label: 'Realm, vassals & titles…', k: 'r', re: /vassal|domain|title|county|development|control|realm|holding|building|legitimacy|tyranny|province/ },
    { id: 'relations', label: 'Attraction & relations…', k: 'n', re: /attraction|seduc|romance|marriage|friend|rival|lover|court_grandeur|fame|travel/ },
    { id: 'other', label: 'Everything else…', k: 'e', re: /./ }
];

function modGroupOf(key: string): string
{
    return MOD_GROUPS.find((g) => g.re.test(key))!.id;
}

const MOD_SCOPE_WORD: Record<string, string> = { character: 'Character', landed_title: 'County', province: 'Province' };

/**
 * The modifiers the menus offer: for a block of a character's, a county's or a province's modifiers the ones the game
 * puts there (ModifierKeyInfo.kinds), most used there first; else every one.
 */
function fittingModifiers(s: State, list: ModifierKeyInfo[] | undefined): ModifierKeyInfo[] | undefined
{
    const k = s.modScope;

    if (!k || !list)
        return list;

    return list.filter((m) => (m.kinds?.[k] ?? 0) > 0).sort((a, b) => (b.kinds![k] ?? 0) - (a.kinds![k] ?? 0));
}

function modifierRoot(s: State, data: PickerData): Menu
{
    const list = fittingModifiers(s, data.modifiers());
    const items: Item[] = [];

    for (const g of MOD_GROUPS)
    {
        if (list && !list.some((m) => modGroupOf(m.key) === g.id))
            continue;

        items.push({ label: g.label, key: g.k, sub: true, go: () => go({ ...s, view: { v: 'modGroup', group: g.id } }, g.label.replace('…', '')) });
    }

    const word = s.modScope ? MOD_SCOPE_WORD[s.modScope] : '';
    items.push({
        label: word ? `All ${word.toLowerCase()} modifiers…` : 'All modifiers…',
        key: 'a',
        sub: true,
        title: word ? `Every modifier the game puts in a ${word.toLowerCase()}’s modifiers, most used there first` : 'Every modifier the game defines, most used first',
        go: () => go({ ...s, view: { v: 'modGroup', group: '' } }, 'All modifiers')
    });

    if (word)
        items.push({ label: 'Every modifier…', key: 'v', sub: true, title: 'Also those the game never puts here', go: () => go({ ...s, view: { v: 'modGroup', group: '', every: true } }, 'Every modifier') });

    return {
        title: s.draft.loc.title ?? (s.title ? `Add to: ${s.title}` : 'Add a modifier'),
        items,
        wait: list ? undefined : data.modifiersLoaded(),
        note: word ? `${word} modifiers (the ones the game puts there) · / every one · ← back · Esc close` : 'Keys: letter = item · type to filter · / search all · ← back · Esc close'
    };
}

/** How many of a group's modifiers its menu shows with letter keys; the rest are under "More…". */
const GROUP_TOP = 15;

function modGroupMenu(s: State, data: PickerData, group: string, all = false, every = false): Menu
{
    // (`every`: also those the game never puts in this kind of block)
    const list = every ? data.modifiers() : fittingModifiers(s, data.modifiers());
    const mods = (list ?? []).filter((m) => !group || modGroupOf(m.key) === group);
    const g = MOD_GROUPS.find((x) => x.id === group);
    // (percent modifiers often share their name with the flat one: "Prowess" and "Prowess %")
    const pick = (m: ModifierKeyInfo): Item =>
    {
        const label = m.percent && !/%/.test(m.label) ? `${m.label} %` : m.label;
        return { label, hint: m.key, match: m.key, sub: true, go: () => go({ ...s, view: { v: 'modValue', key: m.key } }, label) };
    };
    // a group: its most used ones with letter keys, the rest under "More…"; the full lists: letters filter
    const short = !all && !!group && mods.length > GROUP_TOP + 1;
    const items: Item[] = !list
        ? [{ label: 'Reading the modifiers…', role: 'info' }]
        : short
        ? [...mods.slice(0, GROUP_TOP).map(pick), { label: `More… (${mods.length - GROUP_TOP})`, sub: true, go: () => go({ ...s, view: { v: 'modGroup', group, all: true } }, 'More') }]
        : mods.map(pick);
    return {
        title: g ? g.label.replace('…', '') : 'All modifiers',
        typeahead: !short && mods.length > 24,
        wide: true,
        items,
        wait: list ? undefined : data.modifiersLoaded(),
        input: (text) =>
        {
            const key = nameOf(text).toLowerCase();
            return key ? { label: `Use “${key}”`, sub: true, hint: 'as typed', go: () => go({ ...s, view: { v: 'modValue', key } }, key) } : null;
        },
        note: 'Most used first — type to filter by name or key'
    };
}

/** Preset amounts for a modifier, by what it measures (the number as shown: percent points for percentages). */
function modifierPresets(m: ModifierKeyInfo): number[]
{
    if (m.percent || m.alreadyPercent)
        return [5, 10, 15, 20, 25, 50, 100, -5, -10, -15, -20, -25, -50];

    if (/^(diplomacy|martial|stewardship|intrigue|learning|prowess)$/.test(m.key))
        return [1, 2, 3, 4, 5, -1, -2, -3, -4, -5];

    if (/opinion/.test(m.key))
        return [5, 10, 15, 20, 25, 30, 50, -5, -10, -15, -20, -25, -30, -50];

    if (/^monthly_/.test(m.key))
        return [0.1, 0.25, 0.5, 1, 2, -0.1, -0.25, -0.5, -1];

    if (/health|fertility/.test(m.key))
        return [0.1, 0.25, 0.5, 1, -0.1, -0.25, -0.5, -1];

    return [1, 2, 5, 10, 20, -1, -2, -5, -10, -20];
}

function modValueMenu(s: State, data: PickerData, key: string, now?: string): Menu
{
    const list = data.modifiers();
    const m: ModifierKeyInfo = list?.find((x) => x.key === key) ?? { key, label: humanize(key), percent: /_mult$/.test(key), color: 'good', count: 0 };
    const pct = m.percent || !!m.alreadyPercent;
    // the script value of an amount as shown (percent points → a fraction for percent modifiers)
    const value = (n: number): string => String(m.percent ? Number((n / 100).toFixed(4)) : n);
    const label = (n: number): string => `${n > 0 ? '+' : ''}${n}${pct ? '%' : ''}`;
    const tone = (n: number): string | undefined => (m.color === 'neutral' || n === 0 ? undefined : (n > 0) === (m.color === 'good') ? 'good' : 'bad');
    const item = (n: number, extra: Partial<Item> = {}): Item => ({ label: label(n), hint: tone(n), go: () => put(s, `${key} = ${value(n)}`, label(n)), ...extra });
    const keep: Item[] = now !== undefined ? [{ label: `Keep: ${now}`, hint: '⏎', go: () => put(s, `${key} = ${now}`, 'Keep') }] : [];
    return {
        title: now !== undefined ? `${m.label} (now ${now})` : m.label,
        items: [...keep, ...modifierPresets(m).map((n) => item(n))],
        typeahead: true,
        preview: true,
        wait: list ? undefined : data.modifiersLoaded(),
        number: (n) => [item(n, { hint: '⏎' })],
        input: (text) =>
        {
            const name = nameOf(text);
            return name && !/^-?[\d.]+$/.test(name) ? { label: `Use “${name}”`, hint: 'script value', go: () => put(s, `${key} = ${name}`, name) } : null;
        },
        note: pct ? 'Type a percentage (10 = +10%), or a script value' : 'Type an amount (-2 lowers it), or a script value'
    };
}

function fieldRoot(s: State, data: PickerData): Menu
{
    const type = s.type ?? '';

    if (type === 'doctrine_parameters')
        return paramRoot(s, data);

    const items: Item[] = (FIELDS[type] ?? []).map((f) =>
    {
        if (f.kind === 'bool')
            return { label: f.label, key: f.k, hint: `${f.key} = yes`, title: f.help, go: () => put(s, `${f.key} = yes`, f.label) };

        const crumb = f.label.replace('…', '');

        // a block: its needed fields first, then the block's own menu
        if (f.kind === 'block')
            return { label: f.label, key: f.k, hint: `${f.key} = { … }`, title: f.help, sub: true, go: () => go({ ...s, view: blockStep(f, []) }, crumb) };

        // a key that is any entry (a trait of a compatibility): which one first
        if (f.anyKey)
            return { label: f.label, key: f.k, hint: `… = value`, title: f.help, sub: true, go: () => go({ ...s, view: { v: 'fieldKey', field: f.key } }, crumb) };

        const hint = f.kind === 'duration' ? (f.key === 'delay' ? 'delay_years …' : 'years …') : f.bare ? 'a value' : f.kind === 'level' ? 'N = { … }' : f.key;
        return { label: f.label, key: f.k, hint, title: f.help, sub: true, go: () => go({ ...s, view: { v: 'fieldValue', key: f.key } }, crumb) };
    });

    // (a definition that takes any other setting too: a typed key and value)
    if (OPEN_SETS.has(type))
        items.push({ label: 'Other setting…', key: 'o', sub: true, title: 'Any key the definitions write — typed, with the values the game writes for it', go: () => go({ ...s, view: { v: 'otherSetting' } }, 'Other setting') });

    return {
        title: s.draft.loc.title ?? (s.title ? `Add to: ${s.title}` : 'Add a setting'),
        wide: true,
        items: items.length ? items : [{ label: 'Nothing to add for this kind of entry', role: 'info' }],
        note: 'Keys: letter = item · type to filter · ← back · Esc close'
    };
}

/** A field whose key is any entry of a type (`compatibility = { brave = 15 }`): which entry — then its value. */
function fieldKeyMenu(s: State, data: PickerData, field: string): Menu
{
    const f = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === field);
    const type = f?.anyKey ?? '';
    const list = modFirst(data.list(type), data);
    const pick = (name: string, label: string, extra: Partial<Item> = {}): Item => ({ label, sub: true, match: name, go: () => go({ ...s, view: { v: 'fieldValue', key: name } }, label), ...extra });
    return {
        title: f?.label.replace('…', '') ?? field,
        typeahead: true,
        wide: true,
        items: (list ?? []).map((e) => pick(e.name, e.display && e.display !== e.name ? e.display : e.name, { hint: entryHint(e, data), icon: e.icon, entry: { type, name: e.name } })),
        wait: list ? undefined : data.loaded(type),
        input: (text) =>
        {
            const name = nameOf(text);
            return name ? pick(name, `Use “${name}”`, { hint: 'as typed' }) : null;
        },
        note: 'Your mod’s first, then the most used — type to filter'
    };
}

/** "Other setting…": the keys the type's definitions write that the catalog has no field for, or a typed one. */
function otherSettingMenu(s: State, data: PickerData): Menu
{
    const type = s.type ?? '';
    const source = `keys:${type}`;
    const list = data.suggestions(source);
    const known = new Set((FIELDS[type] ?? []).map((f) => f.key));
    const pick = (key: string, extra: Partial<Item> = {}): Item => ({ label: key, sub: true, go: () => go({ ...s, view: { v: 'otherSettingValue', key } }, key), ...extra });
    return {
        title: 'Other setting',
        typeahead: true,
        wide: true,
        items: (list ?? []).filter((x) => !known.has(x.value)).map((x) => pick(x.value, { hint: x.label })),
        wait: list ? undefined : data.suggestionsLoaded(source),
        input: (text) =>
        {
            const key = nameOf(text);
            return key ? pick(key, { label: `Use “${key}”`, hint: 'as typed' }) : null;
        },
        note: 'The keys the game’s definitions of this type write — or type one'
    };
}

/** An "Other setting…" key's value: the values the game writes for it, yes / no, or typed (a `{ … }` block too). */
function otherSettingValueMenu(s: State, data: PickerData, key: string): Menu
{
    const source = `values:${s.type ?? ''}:${key}`;
    const list = data.suggestions(source);
    const items: Item[] = (list ?? []).map((x) => ({ label: x.value, hint: x.label, go: () => put(s, `${key} = ${x.value}`, x.value) }));

    if (!items.length)
        items.push({ label: 'yes', go: () => put(s, `${key} = yes`, 'yes') }, { label: 'no', go: () => put(s, `${key} = no`, 'no') });

    return {
        title: `${key} = …`,
        typeahead: true,
        wide: true,
        preview: true,
        items,
        wait: list ? undefined : data.suggestionsLoaded(source),
        input: (text) =>
        {
            const t = text.trim();
            return t ? { label: `Use “${t}”`, hint: '⏎', go: () => put(s, `${key} = ${/\s/.test(t) && !/^[{"]/.test(t) ? `"${t}"` : t}`, t) } : null;
        },
        note: 'Type the value (a number, a name, a text key or { … })'
    };
}

/** Doctrine group categories (religion/doctrine_group_types `category`). */
const CATEGORY_LABELS: Record<string, string> = { core_tenets: 'Tenets', main_group: 'Main', marriage: 'Marriage', crimes: 'Crimes', clergy: 'Clergy', special: 'Special', not_creatable: 'Not creatable' };

/** A grouped field's groups (doctrines: a row per doctrine group, in the game's order), each opening its entries. */
function groupItems(s: State, data: PickerData, f: FieldDef): { items: Item[]; wait?: Promise<unknown>; }
{
    const list = data.suggestions(f.group!);

    if (!list)
        return { items: [], wait: data.suggestionsLoaded(f.group!) };

    const groups = new Map<string, { label: string; category: string; n: number; }>();

    for (const x of list)
    {
        if (!x.group)
            continue;

        const g = groups.get(x.group.key);

        if (g)
            g.n++;
        else
            groups.set(x.group.key, { label: x.group.label, category: x.group.category, n: 1 });
    }

    const items = [...groups].map(
        ([key, g]): Item => ({ label: g.label + '…', hint: `${CATEGORY_LABELS[g.category] ?? g.category} · ${g.n}`, sub: true, match: key, go: () => go({ ...s, view: { v: 'fieldGroup', key: f.key, group: key } }, g.label) })
    );
    return { items };
}

/** The entries of one group of a grouped field (a doctrine group's doctrines). */
function fieldGroupMenu(s: State, data: PickerData, key: string, group: string): Menu
{
    const f = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === key);
    const list = f?.group ? data.suggestions(f.group) : undefined;

    if (!list)
        return { title: group, items: [], wait: f?.group ? data.suggestionsLoaded(f.group) : undefined };

    const mine = list.filter((x) => x.group?.key === group);
    const m = fieldValueMenu({ ...s, only: mine.map((x) => x.value) }, data, s.type ?? '', key);
    return { ...m, title: mine[0]?.group?.label ?? group };
}

/** Field set `doctrine_parameters`: every parameter the doctrines use (the active mod's first), or a new one. */
function paramRoot(s: State, data: PickerData): Menu
{
    const list = data.suggestions('doctrine_parameters');
    const active = data.activeMod()?.toLowerCase();
    const mine = (x: FieldSuggestion): boolean => !!active && !!x.mods?.some((m) => m.toLowerCase() === active);
    const sorted = [...(list ?? []).filter(mine), ...(list ?? []).filter((x) => !mine(x))];
    return {
        title: s.draft.loc.title ?? (s.title ? `Add to: ${s.title}` : 'Add a parameter'),
        typeahead: true,
        wide: true,
        items: sorted.map((x) => ({ label: humanize(x.value), hint: mine(x) ? `your mod · ${x.label ?? ''}` : x.label, match: x.value, sub: true, go: () => go({ ...s, view: { v: 'paramValue', key: x.value } }, humanize(x.value)) })),
        wait: list ? undefined : data.suggestionsLoaded('doctrine_parameters'),
        input: (text) =>
        {
            const name = nameOf(text);
            return name && !list?.some((x) => x.value === name) ? { label: `New parameter “${name}”…`, sub: true, go: () => go({ ...s, view: { v: 'paramValue', key: name } }, name) } : null;
        },
        note: 'The parameters the doctrines use — type to filter, or a new key'
    };
}

/** A doctrine parameter's value: yes / no, or a number. */
function paramValueMenu(s: State, key: string, now?: string): Menu
{
    const keep: Item[] = now !== undefined ? [{ label: `Keep: ${now}`, hint: '⏎', go: () => put(s, `${key} = ${now}`, 'Keep') }] : [];
    return {
        title: now !== undefined ? `${humanize(key)} (now ${now})` : humanize(key),
        preview: true,
        typeahead: true,
        items: [...keep, { label: 'Yes', hint: 'yes', go: () => put(s, `${key} = yes`, 'Yes') }, { label: 'No', hint: 'no', go: () => put(s, `${key} = no`, 'No') }],
        number: (n) => [{ label: String(n), hint: '⏎', go: () => put(s, `${key} = ${n}`, String(n)) }],
        note: 'Yes or no — or type a number'
    };
}

/** Where writing a field's value leads: the statement written (a setting), or back into the block being built. */
type Write = (key: string, value: string, label: string) => Next;

/** A block field's next step: a field it still needs, else its own menu. */
function blockStep(f: FieldDef, values: [string, string][]): View
{
    const missing = (f.ask ?? []).find((a) => !values.some(([k]) => k === a));
    return missing ? { v: 'blockValue', key: f.key, sub: missing, values } : { v: 'block', key: f.key, values };
}

/** `key = { a = 1 b = yes }` */
function blockText(key: string, values: [string, string][]): string
{
    return `${key} = { ${values.map(([k, v]) => `${k} = ${v}`).join(' ')} }`;
}

function withValue(values: [string, string][], key: string, value: string | null): [string, string][]
{
    const out = values.filter(([k]) => k !== key);

    if (value !== null)
    {
        const i = values.findIndex(([k]) => k === key);
        out.splice(i < 0 ? out.length : i, 0, [key, value]);
    }

    return out;
}

/**
 * A block field being built (a trait's "Under conditions…": `triggered_opinion = { opinion_modifier = x … }`): Done,
 * then its fields — yes/no ones toggle (✓), the others ask their value and come back here.
 */
function blockMenu(s: State, key: string, values: [string, string][]): Menu
{
    const f = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === key);

    if (!f?.sub)
        return { title: key, items: [{ label: 'Unknown setting', role: 'info' }] };

    const has = new Map(values);
    // (a toggle changes this menu in place)
    const back = (vals: [string, string][], crumb: string): Next => ({ state: { ...s, view: { v: 'block', key, values: vals } }, crumb, back: 0 });
    const items: Item[] = [{ label: 'Done', hint: '⏎', title: blockText(key, values), go: () => put(s, blockText(key, values), f.label.replace('…', '')) }];

    for (const sf of FIELDS[f.sub] ?? [])
    {
        const now = has.get(sf.key);

        if (sf.kind === 'bool')
        {
            const on = now === 'yes';
            items.push({ label: `${on ? '✓ ' : ''}${sf.label}`, key: sf.k, title: sf.help, hint: on ? 'yes' : undefined, go: () => back(withValue(values, sf.key, on ? null : 'yes'), sf.label) });
        }
        else
        {
            items.push({ label: sf.label, key: sf.k, title: sf.help, hint: now, sub: true, go: () => go({ ...s, view: { v: 'blockValue', key, sub: sf.key, values, from: 'block' } }, sf.label.replace('…', '')) });
        }
    }

    if (values.some(([k]) => !(f.ask ?? []).includes(k)))
        items.push({ label: 'Clear the conditions', title: 'Keep only what it needs', go: () => back(values.filter(([k]) => (f.ask ?? []).includes(k)), 'Clear') });

    return { title: f.label.replace('…', ''), items, preview: true, wide: true, note: '⏎ Done · letters toggle / choose · ← back' };
}

/** The value of a block's field: written into the block, which comes back. */
function blockValueMenu(s: State, data: PickerData, key: string, sub: string, values: [string, string][], from?: 'block'): Menu
{
    const f = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === key);
    const write: Write = (k, v, label) =>
    {
        const vals = withValue(values, k, v);
        const view = f ? blockStep(f, vals) : ({ v: 'block', key, values: vals } as View);
        // (opened from the block's menu: back into it; the first field asked: the block's menu opens beside)
        return from === 'block' && view.v === 'block' ? { state: { ...s, view }, crumb: label, back: 1 } : go({ ...s, view }, label);
    };
    // (a new opinion modifier / parameter instead of an existing one)
    const create = (FIELDS[f?.sub ?? ''] ?? []).find((x) => x.key === sub)?.create;
    const onCreate = create
        ? (name?: string): Next => go({ ...s, view: name ? newStep(s, { key, sub, values, from, name, fields: [] }) : { v: 'newName', f: { key, sub, values, from } } }, name ?? create.label.replace('…', ''))
        : undefined;
    return fieldValueMenu(s, data, f?.sub ?? '', sub, new Map(values).get(sub), undefined, write, onCreate);
}

function fieldValueMenu(s: State, data: PickerData, set: string, key: string, now?: string, unit?: string, write?: Write, onCreate?: (name?: string) => Next): Menu
{
    // (a key that is any entry — a compatibility's trait —, a track's level: the set's field for it)
    const f: FieldDef | undefined = (FIELDS[set] ?? []).find((x) => x.key === key) ?? fieldOf(set, key);

    if (!f)
        return { title: key, items: [{ label: 'Unknown setting', role: 'info' }] };

    // written `key = value` — a list's item alone (`craven`), a level as the block it opens (`50 = { }`)
    const put1: Write = write ?? ((k, v, label) => put(s, f.bare ? v : f.kind === 'level' ? `${v} = { }` : `${k} = ${v}`, label));
    const name = f.anyKey ? humanize(key) : f.label.replace('…', '');
    const title = now !== undefined ? `${name} (now ${now}${unit ? ' ' + unit : ''})` : name;
    // changing a written one: the same again (duration fields keep their unit)
    const keep: Item[] = now !== undefined ? [{ label: `Keep: ${now}${unit ? ' ' + unit : ''}`, hint: '⏎', go: () => put1(unit ? durationKey(f, unit) : key, now, 'Keep') }] : [];

    if (f.kind === 'bool')
    {
        return { title, preview: true, items: [...keep, { label: 'Yes', key: 'y', go: () => put1(key, 'yes', 'Yes') }, { label: 'No', key: 'n', go: () => put1(key, 'no', 'No') }] };
    }

    if (f.kind === 'choice')
    {
        return { title, preview: true, items: [...keep, ...(f.options ?? []).map(([v, l]) => ({ label: l, hint: v, go: () => put1(key, v, l) }))] };
    }

    if (f.kind === 'duration')
    {
        const item = (n: number, u: string, extra: Partial<Item> = {}): Item => ({ label: durationLabel(n, u), go: () => put1(durationKey(f, u), String(n), durationLabel(n, u)), ...extra });
        return {
            title,
            preview: true,
            typeahead: true,
            items: [...keep, ...(f.presets ?? [1, 5]).map((n) => item(n, 'years')), item(6, 'months'), item(3, 'months'), item(30, 'days')],
            number: (n) => (['years', 'months', 'days'] as const).map((u) => item(n, u, { hint: u })),
            note: 'Type a number: years, months or days'
        };
    }

    // "New …" first; entries made on the way, then the active mod's, then the rest (most used first)
    const made = (s.creates ?? []).filter((c) => c.what === f.create?.what);
    const fresh: Item[] = [
        ...(onCreate && f.create ? [{ label: f.create.label, key: '+', sub: true, go: () => onCreate() } as Item] : []),
        ...made.map((c) => ({ label: c.loc || humanize(c.key), hint: `${c.key} · new`, match: c.key, go: () => put1(key, c.key, c.key) }))
    ];
    const typed = (name: string, known: boolean): Item | null => !name ? null : onCreate && !known ? { label: `New “${name}”…`, sub: true, hint: 'make it', go: () => onCreate(name) } : { label: `Use “${name}”`, hint: 'as typed', go: () => put1(key, name, name) };

    if (f.kind === 'text')
    {
        const list = f.suggest ? data.suggestions(f.suggest) : undefined;
        const active = data.activeMod()?.toLowerCase();
        const mine = (x: FieldSuggestion): boolean => !!active && !!x.mods?.some((m) => m.toLowerCase() === active);
        const sorted = [...(list ?? []).filter(mine), ...(list ?? []).filter((x) => !mine(x))];
        return {
            title,
            preview: true,
            typeahead: true,
            wide: true,
            items: [...keep, ...fresh, ...sorted.map((x) => ({ label: humanize(x.value), hint: mine(x) ? `your mod · ${x.label ?? ''}` : x.label, match: `${x.value} ${x.label ?? ''}`, icon: x.image, image: x.image, go: () => put1(key, x.value, humanize(x.value)) }))],
            wait: f.suggest && !list ? data.suggestionsLoaded(f.suggest) : undefined,
            input: (text) =>
            {
                // (a name as typed: spaces and letters of any language kept, quoted)
                if (f.free)
                {
                    const t = text.trim().replace(/"/g, '');
                    return t ? { label: `Use “${t}”`, hint: 'as typed', go: () => put1(key, /^[A-Za-z0-9_]+$/.test(t) ? t : `"${t}"`, t) } : null;
                }

                const name = nameOf(text);
                return typed(name, !!list?.some((x) => x.value === name) || made.some((c) => c.key === name));
            },
            note: onCreate ? 'Type to filter — or a new key to make one' : 'Type to filter, or a new name'
        };
    }

    // entries of an index type: a trait of a character, a script value in a formula, an opinion modifier
    const all = f.ref ? modFirst(data.list(f.ref), data) : undefined;
    // (the values offered here: a doctrine group's doctrines)
    const only = s.only && new Set(s.only);
    const list = all && only ? all.filter((e) => only.has(e.name)) : all;
    const entries: Item[] = (list ?? []).map((e) => ({
        label: e.display && e.display !== e.name ? e.display : e.name,
        hint: entryHint(e, data),
        icon: e.icon,
        match: e.name,
        entry: f.ref ? { type: f.ref, name: e.name } : undefined,
        go: () => put1(key, e.name, e.display ?? e.name)
    }));
    const wait = f.ref && !list ? data.loaded(f.ref) : undefined;
    // grouped (doctrines by their group): a menu per group first, every entry by typing
    const groups = f.kind === 'ref' && f.group && !only ? groupItems(s, data, f) : undefined;

    if (groups && groups.items.length)
    {
        return {
            title,
            preview: true,
            typeahead: true,
            wide: true,
            items: [...keep, ...fresh, ...groups.items, ...entries.map((it) => ({ ...it, rank: 1, filtered: true }))],
            wait: wait ?? groups.wait,
            input: (text) =>
            {
                const name = nameOf(text);
                return typed(name, !!list?.some((e) => e.name === name) || made.some((c) => c.key === name));
            },
            note: 'A group, or type to find any'
        };
    }

    if (f.kind === 'ref')
    {
        // (a setting of its own naming an entry: "＋ New trait…" — not inside a block, whose fields make their own)
        const extra = !write && !onCreate && f.ref ? newRefRows(s, data, f.ref, { to: 'field', key }) : { items: [] };
        return {
            title,
            preview: true,
            typeahead: true,
            wide: true,
            items: [...keep, ...fresh, ...extra.items, ...entries],
            wait: wait ?? extra.wait,
            input: (text) =>
            {
                const name = nameOf(text);
                return typed(name, !!list?.some((e) => e.name === name) || made.some((c) => c.key === name));
            },
            note: onCreate ? 'Your mod’s first — type to filter, or a new key to make one' : 'Your mod’s first, then the most used — type to filter'
        };
    }

    const label = (n: number): string => `${f.signed && n > 0 ? '+' : ''}${n}`;
    const item = (n: number, extra: Partial<Item> = {}): Item => ({ label: label(n), go: () => put1(key, String(n), label(n)), ...extra });
    // (the named values the game writes for it: slow_construction_time …)
    const named = f.suggest ? data.suggestions(f.suggest) : undefined;
    const namedItems: Item[] = (named ?? []).filter((x) => !/^-?[\d.]+$/.test(x.value)).map((x) => ({ label: humanize(x.value), hint: x.label ?? x.value, match: x.value, go: () => put1(key, x.value, humanize(x.value)) }));
    return {
        title,
        preview: true,
        typeahead: true,
        wide: entries.length > 0 || namedItems.length > 0,
        wait: wait ?? (f.suggest && !named ? data.suggestionsLoaded(f.suggest) : undefined),
        items: [...keep, ...(f.presets ?? []).map((n) => item(n)), ...namedItems, ...entries],
        number: (n) => [item(n, { hint: '⏎' })],
        input: (text) =>
        {
            const name = nameOf(text);
            return name && !/^-?[\d.]+$/.test(name) ? { label: `Use “${name}”`, hint: 'script value', go: () => put1(key, name, name) } : null;
        },
        note: 'Type a number'
    };
}

// ---------------------------------------------------------------------------
// New entries (a new opinion modifier, a new doctrine parameter) made while building a block's field
// ---------------------------------------------------------------------------

/** The block field a new entry is made for: the block (`key`, its values so far) and its field (`sub`). */
interface NewFor
{
    key: string;
    sub: string;
    values: [string, string][];
    /** opened from the block's menu (its entry is 3 menus up when the new entry is done) */
    from?: 'block';
}

/** A new entry being made: its key, its settings, its text in game. */
export interface NewCtx extends NewFor
{
    name: string;
    fields: [string, string][];
    loc?: string;
}

function createOf(s: State, f: NewFor): NonNullable<FieldDef['create']> | undefined
{
    const block = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === f.key);
    return (FIELDS[block?.sub ?? ''] ?? []).find((x) => x.key === f.sub)?.create;
}

/** The new entry's next step: a field it needs, else its own menu. */
function newStep(s: State, ctx: NewCtx): View
{
    const c = createOf(s, ctx);
    const missing = (c?.ask ?? []).find((a) => !ctx.fields.some(([k]) => k === a));
    return missing ? { v: 'newValue', ctx, field: missing } : { v: 'newEntry', ctx };
}

/** Type the key of the new entry. */
function newNameMenu(s: State, data: PickerData, f: NewFor): Menu
{
    const c = createOf(s, f);
    const existing = new Set(c?.what === 'opinion_modifiers' ? (data.list('opinion_modifiers') ?? []).map((e) => e.name) : (data.suggestions('doctrine_parameters') ?? []).map((x) => x.value));
    return {
        title: c?.label.replace('…', '') ?? 'New',
        typeahead: true,
        wide: true,
        items: [{ label: c?.what === 'opinion_modifiers' ? 'Type its key, e.g. my_respect_opinion' : 'Type its key, e.g. allows_my_marriage', role: 'info' }],
        input: (text) =>
        {
            const name = nameOf(text).toLowerCase();

            if (!name)
                return null;

            if (existing.has(name) || s.creates?.some((x) => x.key === name))
                return { label: `“${name}” exists already`, role: 'info' };

            return { label: `Create “${name}”…`, sub: true, go: () => go({ ...s, view: newStep(s, { ...f, name, fields: [] }) }, name) };
        },
        note: 'Letters, digits and _ — the key the script uses'
    };
}

/** The new entry's menu: Done (back into the block, the entry remembered for making), its settings, its text in game. */
function newEntryMenu(s: State, ctx: NewCtx): Menu
{
    const c = createOf(s, ctx);

    if (!c)
        return { title: ctx.name, items: [{ label: 'Unknown', role: 'info' }] };

    const has = new Map(ctx.fields);
    const here = (next: NewCtx, crumb: string): Next => ({ state: { ...s, view: { v: 'newEntry', ctx: next } }, crumb, back: 0 });
    const done = (): Next =>
    {
        const block = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === ctx.key);
        const values = withValue(ctx.values, ctx.sub, ctx.name);
        const creates = [...(s.creates ?? []).filter((x) => x.key !== ctx.name), { what: c.what, key: ctx.name, fields: ctx.fields, loc: ctx.loc }];
        const view = block ? blockStep(block, values) : ({ v: 'block', key: ctx.key, values } as View);
        // (back into the block's menu it came from: 3 menus up — the field's value, the name, this one)
        return ctx.from === 'block' && view.v === 'block' ? { state: { ...s, creates, view }, crumb: ctx.name, back: 3 } : go({ ...s, creates, view }, ctx.name);
    };
    const items: Item[] = [{ label: `Done — make “${ctx.name}”`, hint: '⏎', go: done }];

    for (const sf of FIELDS[c.fields] ?? [])
    {
        const now = sf.kind === 'duration' ? ctx.fields.find(([k]) => /^(delay_)?(days|months|years)$/.test(k) && k.startsWith(sf.key === 'delay' ? 'delay_' : ''))?.join(' ') : has.get(sf.key);

        if (sf.kind === 'bool')
        {
            const on = now === 'yes';
            items.push({ label: `${on ? '✓ ' : ''}${sf.label}`, key: sf.k, title: sf.help, hint: on ? 'yes' : undefined, go: () => here({ ...ctx, fields: withValue(ctx.fields, sf.key, on ? null : 'yes') }, sf.label) });
        }
        else
            items.push({ label: sf.label, key: sf.k, title: sf.help, hint: now, sub: true, go: () => go({ ...s, view: { v: 'newValue', ctx, field: sf.key } }, sf.label.replace('…', '')) });
    }

    items.push({ label: c.locLabel, key: 'z', hint: ctx.loc, sub: true, go: () => go({ ...s, view: { v: 'newLoc', ctx } }, 'In game') });
    return { title: `${c.label.replace('…', '')}: ${ctx.name}`, items, preview: true, wide: true, note: '⏎ make it · letters toggle / choose · ← back' };
}

/** A setting of the new entry. */
function newValueMenu(s: State, data: PickerData, ctx: NewCtx, field: string): Menu
{
    const c = createOf(s, ctx);
    const write: Write = (k, v, label) =>
    {
        // (a duration replaces any other unit written before)
        const f = (FIELDS[c?.fields ?? ''] ?? []).find((x) => x.key === field);
        const fields = f?.kind === 'duration' ? ctx.fields.filter(([x]) => !/^(delay_)?(days|months|years)$/.test(x) || x.startsWith('delay_') !== (field === 'delay')) : ctx.fields;
        const next = { ...ctx, fields: withValue(fields, k, v) };
        const view = newStep(s, next);
        return view.v === 'newEntry' && ctx.fields.length ? { state: { ...s, view }, crumb: label, back: 1 } : go({ ...s, view }, label);
    };
    return fieldValueMenu(s, data, c?.fields ?? '', field, undefined, undefined, write);
}

/** The new entry's name or sentence in game. */
function newLocMenu(s: State, ctx: NewCtx): Menu
{
    const set = (text: string): Next => ({ state: { ...s, view: { v: 'newEntry', ctx: { ...ctx, loc: text } } }, crumb: 'In game', back: 1 });
    return {
        title: createOf(s, ctx)?.locLabel.replace('…', '') ?? 'In game',
        typeahead: true,
        wide: true,
        items: ctx.loc ? [{ label: `Keep: ${ctx.loc}`, hint: '⏎', unfiltered: true, go: () => set(ctx.loc!) }] : [{ label: 'Type the text', role: 'info' }],
        input: (text) => (text.trim() ? { label: `Use “${text.trim()}”`, hint: '⏎', go: () => set(text.trim()) } : null),
        note: 'What the game shows for it'
    };
}

// ---------------------------------------------------------------------------
// Text codes (the localization editor's "Insert code…": mode 'loc')
// ---------------------------------------------------------------------------

/** A chosen code: the pick is done, its text inserted (\`caret\`: where the cursor goes inside it). */
function code(s: State, raw: string, caret?: number): Next
{
    return { finish: true, state: { ...s, raw, caret } };
}

/** Groups of a character's data functions, by the chain's first function. */
const LOC_GROUPS: { id: string; label: string; k: string; re: RegExp; }[] = [
    { id: 'names', label: 'Names…', k: 'n', re: /^Get(First|Titled|Full|Short|UI|Name|BaseName|TitleAs|NamePossessive|Desc)/ },
    { id: 'words', label: 'Pronouns & words (she/he, her/his …)…', k: 'p', re: /^Get(She|Her|His|Him|Woman|Women|Man|Men|Daughter|Son|Wife|Husband|Mother|Father|Sister|Brother|Lady|Lord|Girl|Boy|Queen|King|Niece|Nephew|Aunt|Uncle|Grand|Mistress|Master)[A-Z|]?/ },
    { id: 'faith', label: 'Faith & culture…', k: 'f', re: /^Get(Faith|Religion|Culture)/ },
    { id: 'family', label: 'Family, liege & court…', k: 'r', re: /^Get(House|Dynasty|Father|Mother|Spouse|PrimarySpouse|Heir|PlayerHeir|Liege|DeJureLiege|TopLiege|Employer|Host|Court|Councillor|Betrothed|Concubine)\b|^Get(House|Dynasty)/ },
    { id: 'titles', label: 'Titles & places…', k: 't', re: /^Get(PrimaryTitle|Title|Capital|CurrentLocation|Location|Holding|Realm|County|Barony|Council|Diarch|Domicile|Government)/ },
    { id: 'other', label: 'Everything else…', k: 'e', re: /./ }
];

const locGroupOf = (chain: string): string => LOC_GROUPS.find((g) => g.re.test(chain))!.id;

/** "GetTitledFirstNamePossessive|U" → "Titled first name possessive (capitalized)" */
function chainLabel2(chain: string): string
{
    const [body, fmt] = chain.split('|');

    // pronouns and word pairs read as the game shows them: GetHerHis → "her/his", GetWomanMan → "woman/man"
    if (!body.includes('.') && LOC_GROUPS[1].re.test(body))
    {
        const pair = body
            .replace(/^Get/, '')
            .split(/(?=[A-Z])/)
            .map((w) => w.toLowerCase())
            .join('/');
        return fmt === 'U' ? `${pair.charAt(0).toUpperCase()}${pair.slice(1)} (capitalized)` : pair;
    }

    const words = body
        .split('.')
        .map((p) =>
            p.replace(/^Get/, '')
                .replace(/([a-z])([A-Z])/g, '$1 $2')
                .toLowerCase()
        )
        .join(' › ');
    const t = words.charAt(0).toUpperCase() + words.slice(1);
    return fmt === 'U' ? `${t} (capitalized)` : fmt === 'l' ? `${t} (lower case)` : fmt ? `${t} (|${fmt})` : t;
}

function locRoot(s: State): Menu
{
    return {
        title: s.title ? `Insert into ${s.title}` : 'Insert a text code',
        items: [
            { label: 'Someone’s name, pronoun, faith …', key: 'c', sub: true, go: () => go({ ...s, view: { v: 'locWho' } }, 'Someone') },
            { label: 'A concept link…', key: 'k', sub: true, title: '[faith|E] — the game underlines it and explains it on hover', go: () => go({ ...s, view: { v: 'locConcept' } }, 'Concept') },
            { label: 'An icon…', key: 'i', sub: true, title: '@gold_icon!', go: () => go({ ...s, view: { v: 'locIcon' } }, 'Icon') },
            { label: 'Formatting…', key: 'f', sub: true, title: '#P positive#!, #N negative#!, #bold …#!', go: () => go({ ...s, view: { v: 'locFormat' } }, 'Formatting') },
            // (the editor shows line breaks as they read; saved as \n)
            { label: 'Line break', key: 'b', hint: '\\n', go: () => code(s, '\n') }
        ],
        note: 'Keys: letter = item · type to filter · ← back · Esc close'
    };
}

function locWho(s: State): Menu
{
    const pick = (prefix: string, label: string): Item => ({ label, hint: prefix, sub: true, go: () => go({ ...s, view: { v: 'locFn', prefix } }, label) });
    return {
        title: 'Whose?',
        items: [pick('ROOT.Char', 'You — the event’s character (ROOT)'), ...(s.scopes ?? []).map((x) => pick(x, humanize(x)))],
        input: (text) =>
        {
            const name = nameOf(text).replace(/^scope:/, '');
            return name ? pick(name, `Saved scope “${name}”`) : null;
        },
        note: 'The event’s saved scopes are listed; or type one'
    };
}

function locFnMenu(s: State, data: PickerData, prefix: string, group?: string): Menu
{
    const codes = data.locCodes();
    const fns = (codes?.functions ?? []).filter(([c]) => !group || locGroupOf(c) === group);
    // (what it prints, for William of Normandy in 1066: "Duke William", "his / her")
    const item = ([c, n]: [string, number]): Item =>
    {
        const ex = codes?.examples?.[c];
        return { label: chainLabel2(c), hint: ex ? `“${ex}”` : `${n}×`, title: `${ex ? `e.g. “${ex}” (William of Normandy, 1066) · ` : ''}${n}× in the game’s texts`, match: c, go: () => code(s, `[${prefix}.${c}]`) };
    };

    if (!group)
    {
        const items: Item[] = LOC_GROUPS.filter((g) => !codes || codes.functions.some(([c]) => locGroupOf(c) === g.id)).map((g) => ({ label: g.label, key: g.k, sub: true, go: () => go({ ...s, view: { v: 'locFn', prefix, group: g.id } }, g.label.replace('…', '')) }));
        items.push({ label: 'All codes…', key: 'a', sub: true, go: () => go({ ...s, view: { v: 'locFn', prefix, group: '' } }, 'All') });
        return { title: prefix === 'ROOT.Char' ? 'You' : humanize(prefix), items, wait: codes ? undefined : data.locCodesLoaded(), note: 'Most used in the game first' };
    }

    return {
        title: LOC_GROUPS.find((g) => g.id === group)?.label.replace('…', '') ?? 'All codes',
        typeahead: true,
        wide: true,
        preview: true,
        items: codes ? fns.map(item) : [{ label: 'Reading the game’s texts…', role: 'info' }],
        wait: codes ? undefined : data.locCodesLoaded(),
        input: (text) =>
        {
            const c = text.trim().replace(/^\[|\]$/g, '');
            return /^Get\w/.test(c) ? { label: `Use [${prefix}.${c}]`, go: () => code(s, `[${prefix}.${c}]`) } : null;
        },
        note: 'Type to filter — or a function (GetFirstName)'
    };
}

function locConceptMenu(s: State, data: PickerData): Menu
{
    const codes = data.locCodes();
    return {
        title: 'Concept',
        typeahead: true,
        wide: true,
        preview: true,
        items: codes ? codes.concepts.map((c) => ({ label: c.label, hint: `${c.key} · ${c.count}×`, match: c.key, go: () => code(s, `[${c.key}|E]`) })) : [{ label: 'Reading the game’s texts…', role: 'info' }],
        wait: codes ? undefined : data.locCodesLoaded(),
        note: 'Written [key|E]: underlined, explained on hover'
    };
}

function locIconMenu(s: State, data: PickerData): Menu
{
    const codes = data.locCodes();
    return {
        title: 'Icon',
        typeahead: true,
        wide: true,
        preview: true,
        items: codes ? codes.icons.map(([i, n]) => ({ label: humanize(i.replace(/_icon$/, '')), hint: `@${i}! · ${n}×`, match: i, icon: codes.iconImages?.[i], go: () => code(s, `@${i}!`) })) : [{ label: 'Reading the game’s texts…', role: 'info' }],
        wait: codes ? undefined : data.locCodesLoaded()
    };
}

/** What the common formatting codes do (the rest: their code). */
const FORMAT_LABELS: Record<string, string> = {
    P: 'Positive (green)',
    N: 'Negative (red)',
    V: 'Value',
    EMP: 'Emphasis',
    bold: 'Bold',
    italic: 'Italic',
    I: 'Italic (short)',
    weak: 'Weak (dim)',
    high: 'High (bright)',
    low: 'Low',
    F: 'Flavor text',
    T: 'Title',
    X: 'Bad value',
    S: 'Small'
};

function locFormatMenu(s: State, data: PickerData): Menu
{
    const codes = data.locCodes();
    const list = codes?.formats ?? Object.keys(FORMAT_LABELS).map((k) => [k, 0] as [string, number]);
    return {
        title: 'Formatting',
        typeahead: true,
        preview: true,
        items: list.map(([f, n]) => ({ label: FORMAT_LABELS[f] ?? '#' + f, hint: `#${f} … #!${n ? ` · ${n}×` : ''}`, match: f, go: () => code(s, `#${f} #!`, f.length + 2) })),
        note: 'Wraps the selected text; else the cursor goes between'
    };
}
