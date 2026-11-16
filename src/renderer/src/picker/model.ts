/**
 * The statement picker's state machine (docs/picker.md): which menu a state shows, what each item leads to, and the
 * script built so far. Plain TypeScript over the catalog (shared/scriptCatalog.ts); the index data comes in through
 * `PickerData` (data.ts caches it). Picker.tsx renders the menus and keeps the history of states for stepping back.
 */
import type { EntryCreate, FieldSuggestion, LocCodes, ModifierKeyInfo, ModifierKind, NewEntryPlan, PickTarget, ScriptKeyInfo } from '../../../shared/api.ts';
import { FIELDS, bareField, durationKey, fieldOf, isOpenSet, type FieldDef } from '../../../shared/fieldCatalog.ts';
import {
    COMPARE_OPTIONS,
    EFFECT_GROUPS,
    GAME_SCOPE_NAME,
    ITERATORS,
    DEAD_LISTS,
    inPrev,
    LINKS,
    PREFIX_SCOPES,
    SAVED_SCOPES,
    SCOPE_LABELS,
    SCOPE_ORDER,
    SCOPE_TYPES,
    STATEMENTS,
    TRIGGER_GROUPS,
    agreedLink,
    allParams,
    chainFits,
    durationLabel,
    durationScript,
    fillTemplate,
    findStatement,
    parseSnippet,
    printScript,
    statementById,
    statementsFor,
    writtenKey,
    type IteratorDef,
    type IteratorParam,
    type ParamDef,
    type PickKind,
    type SNode,
    type ScopeLink,
    type ScopeType,
    type StatementDef
} from '../../../shared/scriptCatalog.ts';

import { defaultEntryName, plainLabel } from '../../../shared/entryName.ts';
import { withoutComments } from '../../../shared/scriptFormat.ts';
import { tr } from '../../../shared/i18n.ts';
import { fold, foldHas } from '../../../shared/fold.ts';
import { awayTargets, placeScopes, typedScopeWarning, viewEntry, viewEntryType } from './targets.ts';
import { scriptFacts, type DbKind } from '../../../shared/scriptFacts.ts';
// (lane R: a statement of several read back, the title triple)
import type { RestAt } from '../../../shared/scriptCatalog.ts';
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
    /** a scripted list's base list (common/scripted_lists `base = vassal`) */
    base?: string;
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
    /** lists of entries grouped by the DLC (or mod) they come with (Tab toggles it; remembered) */
    grouped?(): boolean;
    setGrouped?(on: boolean): void;
    /** per entry of a type its DLC or mod (base game entries left out); undefined while loading */
    dlcGroups?(type: string): Record<string, string> | undefined;
    dlcLoaded?(type: string): Promise<unknown>;
    /** per entry of a type limited to a DLC by its own script: its flag (= feature) and the DLC's name; undefined while loading */
    dlcFlags?(type: string): Record<string, { flag: string; dlc: string; }> | undefined;
    dlcFlagsLoaded?(type: string): Promise<unknown>;
    /** the game's localization codes (mode 'loc'); undefined while scanning */
    locCodes(): LocCodes | undefined;
    locCodesLoaded(): Promise<unknown>;
    /** the names an event uses without saving them ("Pass along…"); undefined while loading */
    eventScopes?(event: string): { name: string; about?: string; }[] | undefined;
    eventScopesLoaded?(event: string): Promise<unknown>;
    /** a localization key's text and where its winning line is (api.locEntry); null: no such key; undefined while loading */
    locEntry?(key: string): { text?: string; rel?: string; mod?: string; } | null | undefined;
    locEntryLoaded?(key: string): Promise<unknown>;
    /** where a new entry of a type would go in the active mod (api.newEntryPlan: "＋ New trait…"); undefined while loading */
    newPlan?(type: string): NewEntryPlan | undefined;
    newPlanLoaded?(type: string): Promise<unknown>;
    /** the script database's explanation of a game key: [label, summary]; undefined while loading or when none is written */
    docLabel?(kind: DbKind, key: string): [string, string] | undefined;
    /** every explained key of a kind ("Other…" offers the documented ones the script never uses); undefined while loading */
    docLabels?(kind: DbKind): Record<string, [string, string]> | undefined;
    docLabelsLoaded?(kind: DbKind): Promise<unknown>;
}

/** What is built: effects, conditions, stat modifiers (`diplomacy = 2`) or the fields of a definition. */
export type Mode = PickKind | 'modifier' | 'field' | 'loc' | 'choice';

/**
 * A row of a plain menu (mode 'choice', pickChoice: the map's right-click menu): it opens another menu (`sub`) or
 * finishes with its `value`.
 */
export interface ChoiceItem
{
    label: string;
    hint?: string;
    key?: string;
    /** a swatch before the label (a culture's, a faith's colour) */
    color?: string;
    /** the game image of its icon (a trait's, a faith's) */
    icon?: string;
    /** the game entry it stands for (rows marked data-entity: scripts/icon-check.mjs) */
    entry?: { type: string; name: string; };
    /** shown in the panel while the row is highlighted */
    explain?: string;
    /** listed after the others among matches (a character not alive then) */
    dim?: boolean;
    /** what is odd about it (shown with the row, not blocking) */
    warn?: string;
    value?: string;
    sub?: () => ChoiceMenu;
    /** a toggle: the menu it is in, changed in place (the row's new state) */
    toggle?: () => ChoiceMenu;
    /** a toggle's current state, shown on the right in gold */
    state?: string;
    /** a heading row (nothing to choose: "Presets") */
    header?: boolean;
}

export interface ChoiceMenu
{
    title: string;
    items: ChoiceItem[];
    /** letters filter (a list of names): no mnemonics */
    typeahead?: boolean;
    /** rows found for the typed text (characters) */
    search?: (q: string) => Promise<ChoiceItem[]>;
    /** typed digits: rows for the number (a level) */
    number?: (n: number) => ChoiceItem[];
    /** the typed text as a row (a date), or null when it is none */
    input?: (text: string) => ChoiceItem | null;
    /** rows that come later (a list asked of the index), after `items`, loaded once; the menu shows "Loading…" meanwhile */
    load?: () => Promise<ChoiceItem[]>;
    /** (load's rows once they came, and the promise meanwhile) */
    loaded?: ChoiceItem[];
    loading?: Promise<unknown>;
    note?: string;
    wide?: boolean;
}

export interface Item
{
    label: string;
    /** small text on the right: the script key, a count */
    hint?: string;
    /** a toggle's current state, on the right in gold ("Known") */
    state?: string;
    /** mnemonic; assigned from the label when absent (not in type-ahead menus) */
    key?: string;
    /** leads to another menu (▸) */
    sub?: boolean;
    /** a colour swatch before the label (mode 'choice') */
    color?: string;
    /** game image path of an icon */
    icon?: string;
    title?: string;
    /** done: finishes the pick; info: a note, not selectable */
    role?: 'done' | 'info';
    go?: () => Next;
    /** added to the filter score (higher = further down among matches) */
    rank?: number;
    /** what it does, shown in the preview while the row is highlighted */
    explain?: string;
    /** more words the filter matches */
    match?: string;
    /** listed only while a filter is typed (every entry behind a menu of groups) */
    filtered?: boolean;
    /** listed only while nothing is typed (a default the typed text replaces: "Keep: …" in a text step) */
    unfiltered?: boolean;
    /** the database entry the row stands for: the preview shows its card (a doctrine's description, what it does) */
    entry?: { type: string; name: string; };
    /**
     * the game key the row stands for (an effect, a link, a list, a modifier …): the preview shows its explanation from
     * the script database (docs/script-database.md), the row's tooltip its summary
     */
    doc?: { kind: DbKind; key: string; variant?: string; };
    /** a picture the row stands for (an icon): large in the preview */
    image?: string;
    /** a problem with what the row writes (a typed chain leading to another type): shown in the preview, not blocking */
    warn?: string;
    /** the "… and N more" note of a list cut at MAX_ROWS (rows.ts): Space with no filter shows them all */
    more?: boolean;
    /**
     * chosen only on purpose ("＋ New trait…"): listed last, never the row selected when the menu opens, as ⏎ or a typed
     * key sequence must not make an entry (rows.ts)
     */
    explicit?: boolean;
}

/**
 * What choosing a row leads to: a new menu beside it; `back` n: the menu n steps up takes the new state instead (0:
 * the chosen menu itself changes, a toggle; 1: the menu it was opened from, a value chosen for a block's field).
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
    /** a list of entries that can be grouped by DLC (Tab) */
    groupable?: boolean;
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
    /** a weight entered from an iterator's "Weighted by…": it has a back, but its conditional parts ("When…") are still offered */
    formula?: boolean;
    /** a weight's: the State's `type` before "Weighted by…" set it to 'weight' (none: there was none); "Back out" restores it */
    typeBack?: { type?: string; };
    /**
     * how "What next?" goes back there: to its "What next?" (default), or to its root menu under this label, as an
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
    /** the same for a statement of several (the title triple): where in it they were written (findStatement's `restAt`) */
    restAt?: RestAt[];
    not?: boolean;
}

export type View =
    | { v: 'root'; }
    /** mode 'choice': the plain menu `State.choice` */
    | { v: 'choice'; }
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
    /** a list's parameters before its statements (a relation's type: friend, rival …; a pool character's province): the `i`-th of the list's `params`, asked in turn */
    | { v: 'iterParam'; step: ChainStep; list: string; i: number; }
    /** an ordered iterator's order ("The one with the highest…") */
    | { v: 'orderBy'; step: ChainStep; }
    /** how many of an `any_` iterator's items must match (count / percent) of the iterator at `path` */
    | { v: 'count'; path: number[]; }
    /** `switch`: the condition its cases are values of */
    | { v: 'switchOn'; }
    | { v: 'flowRoot'; }
    | { v: 'newText'; suffix: string; reuse: boolean; title: string; then: (st: State, key: string, label: string) => Next; }
    | { v: 'flowNew'; what: 'chance' | 'random'; }
    /** the effect root's "Effect on…": a menu of the scope types in reach */
    | { v: 'effectOn'; }
    /** a shelf of the effect root (EFFECT_SHELVES: Scope & lists, Create, Messages & sound): keys of the game's script under labels */
    | { v: 'shelf'; id: string; }
    /** a field's entry limited to a DLC (FieldDef.dlcPair): always, only with the DLC, or with a fallback (`fallback`: which) */
    | { v: 'dlcPair'; set: string; key: string; value: string; label: string; fallback?: boolean; }
    /** the effect built last names an entry limited to a DLC: only with it, or (`fallback`) another one otherwise */
    | { v: 'dlcWrap'; fallback?: boolean; }
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
    /**
     * "A random time between…" of a duration field (FieldDef.range) or, `param`, of the pending statement's duration
     * parameter (DurationParam.range): the unit, then the lowest, then the highest
     */
    | { v: 'durationRange'; key: string; unit?: 'days' | 'months' | 'years'; lo?: number; param?: boolean; }
    /** a field whose key is any entry (`compatibility = { brave = 15 }`): which entry, then its value */
    | { v: 'fieldKey'; field: string; }
    /** a level written inside a block of its own name (FieldDef.named: a trait's named track): the name, the level, its name in game */
    | { v: 'namedKey'; field: string; }
    | { v: 'namedLevel'; field: string; name: string; }
    | { v: 'namedLoc'; field: string; name: string; level: string; }
    | { v: 'namedDesc'; field: string; name: string; level: string; }
    /** "Other setting…" of an open set: a typed key, then its value (the values the game writes for it) */
    | { v: 'otherSetting'; }
    | { v: 'otherSettingValue'; key: string; now?: string; }
    /** the entries of one group of a grouped field (a doctrine group's doctrines) */
    | { v: 'fieldGroup'; key: string; group: string; }
    /** field set `doctrine_parameters`: a parameter's value (on: the name written bare / no / a number); `bare`: written so now */
    | { v: 'paramValue'; key: string; now?: string; bare?: boolean; }
    /** a block field being built (its fields so far), and the value of one of its fields */
    | { v: 'block'; key: string; values: [string, string][]; }
    | { v: 'blockValue'; key: string; sub: string; values: [string, string][]; from?: 'block' | 'blockKey'; }
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
    /** changing a written block (the draft's first statement): its head (an if, NOT / OR, a scope switch, an iterator …) */
    | { v: 'head'; }
    /**
     * changing an iterator: the written one (the draft's first statement, "What next?" after it), or (`path`, `inBlock`)
     * the one whose block is being built ("More about this list…": back to the block's statements after it)
     */
    | { v: 'iterSet'; what: 'list' | 'mode' | 'param' | 'order' | 'position' | 'max'; i?: number; path?: number[]; inBlock?: boolean; }
    /** "More about this list…" inside the block of the iterator at `path`: its options (iterOptionItems) */
    | { v: 'iterMore'; path: number[]; }
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
    | { v: 'newRefName'; type: string; key: string; then: NewRefThen; holder?: HolderPick; }
    /** a type written inside other definitions (NewEntryPlan.nested): which holder it goes in, or a new one's key and name */
    | { v: 'newRefHolder'; type: string; key: string; then: NewRefThen; }
    | { v: 'newRefHolderKey'; type: string; key: string; then: NewRefThen; }
    | { v: 'newRefHolderName'; type: string; key: string; then: NewRefThen; hk: string; };

export interface State
{
    kind: Mode;
    /**
     * The generic block editor inside a field that is a block (a nested `send_option = { … }`): the blocks above it,
     * the outermost first, each with the field of it being edited (`index`). Done in the inner one writes its text back
     * into that field; the preview and the final text are the outermost block with the inner edits in place.
     */
    kup?: { key: string; fields: KField[]; index: number; }[];
    /** mode 'choice': the menu shown (its rows finish with a value: `raw`) */
    choice?: ChoiceMenu;
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
     * PickRequest.goal. 'name': the subject chosen is given a name (save_scope_as); 'send': the subject chosen gets the
     * event `event` (trigger_event). No statement menus.
     */
    goal?: 'name' | 'send';
    event?: string;
    /** the event's scopes, offered as targets besides the links ("Child is…"), PickRequest.targets */
    targets?: PickTarget[];
    /** `targets` is every scope in reach as far as the index sees (PickRequest.targetsKnown) */
    targetsKnown?: boolean;
    /** "Pass along…": the name being given; choosing who saves them as it before the trigger_event */
    passing?: string;
    /** PickRequest.only: the values offered for the field (the doctrines of one group) */
    only?: string[];
    /** PickRequest.once: the first statement finishes (no "What next?") */
    once?: boolean;
    /** PickRequest.root: the scope type `root` is when not a character ("Self" at the top is "the faith") */
    rootScope?: ScopeType;
    /** PickRequest.common / about: the conditions the game writes in the block, most used first, and what it is for */
    common?: string[];
    about?: string;
    /** kind 'modifier': what the block's modifiers apply to (PickRequest.scope); the menus offer the ones the game puts there */
    modScope?: Exclude<ModifierKind, 'other'>;
    /** PickRequest.newEntries: entry lists offer "＋ New trait…" (made by the caller: PickResult.creates) */
    newEntries?: boolean;
    /**
     * changing a written block that belongs to an if / else chain: an else_if / else, or one an else follows
     * (PickRequest.elseAfter). It is not wrapped (When…, Chance…) and, with an else after it, nothing goes after it
     */
    bound?: 'else' | 'elseAfter';
    /** the result goes next to the block it was asked for (PickResult.outside: a tenet with its DLC, `tenet_selection_pair`) */
    outside?: boolean;
    /**
     * the statement built last (effects) and the entries it names (ref parameters): "Only with <DLC>…" when one is
     * limited to a DLC (the statement under `if = { limit = { has_dlc_feature = … } }`, a fallback in its `else`)
     */
    lastRef?: { p: Pending; refs: { name: string; type: string; prefix: string; value: string; }[]; };
}

export function initialState(kind: Mode, scope: ScopeType, title?: string, type?: string, subject?: string): State
{
    return { kind, type, title, chain: [], view: { v: 'root' }, draft: { top: [], loc: { path: [], kind, scope, label: subject ?? '' } } };
}

/** Field sets that are formulas (a script value, a weight, a cost): their blocks (if, add = { … }) change in the picker too. */
const FORMULA_SETS = new Set(['script_value', 'weight', 'cost']);

/** A written `key op value` on one line (a quoted value keeps its quotes). */
const SCALAR = /^\s*([\w.:@$'-]+)\s*(==|!=|<=|>=|<|>|=)\s*("[^"\n]*"|[^\s{}"#]+)\s*$/;
/** A name written alone (a doctrine parameter on: `doctrine_polygamy`) */
const BARE_WORD = /^\s*[\w.-]+\s*$/;

/**
 * A written block field the picker can take apart: `triggered_opinion = { opinion_modifier = x same_faith = yes }`.
 * What in it is none of its fields is kept as written, its value as written (a block on one line, `{ … }`): a block
 * of statements (a send option's `is_shown = { … }`, an asset's `trigger`), a list of bare values
 * (`graphical_regions = { a b }`), a `key = value` the set does not know (`current_description = x`); so is a field
 * written as a block (an asset's `soundeffect = { … }`: its row reads "as written", Keep first). The block step changes
 * the fields around them and "Clear the conditions" drops just the conditions (FieldDef.conds); their layout and
 * comments come back through keepWritten (the Change path).
 */
function writtenBlock(text: string, type?: string): { f: FieldDef; values: [string, string][]; } | null
{
    const nodes = parseSnippet(text);
    const n = nodes[0];
    const f = n && type ? fieldOf(type, n.k) : undefined;

    if (nodes.length !== 1 || !n.kids || f?.kind !== 'block' || !f.sub)
        return null;

    // (a list of bare names, its set's field written bare: `allowed_holding_types = { castle_holding city_holding }`)
    const bareF = (FIELDS[f.sub] ?? []).find((x) => x.bare);

    if (bareF && n.kids.every((c) => c.op === '' && !c.kids))
        return { f, values: n.kids.map((c) => [bareF.key, c.k] as [string, string]) };

    // (a block: all statements or all bare values, not mixed; a bare value alone at the top is no `key = value`)
    const block = (c: SNode): boolean => !!c.kids && (c.kids.every((x) => x.op !== '') || c.kids.every((x) => x.op === '' && !x.kids));

    if (!n.kids.every((c) => c.op === '=' && (c.kids ? block(c) : c.v !== undefined)))
        return null;

    return { f, values: n.kids.map((c) => [c.k, c.kids ? blockOneLine(c.kids) : (c.v ?? '')] as [string, string]) };
}

/** A block's statements on one line, braces around them (`{ scope:actor = { gold > 10 } }`): a kept block's value. */
function blockOneLine(kids: SNode[]): string
{
    const one = (n: SNode): string => (n.kids ? `${n.k} ${n.op} ${blockOneLine(n.kids)}` : n.op ? `${n.k} ${n.op} ${n.v}` : n.k);
    return kids.length ? `{ ${kids.map(one).join(' ')} }` : '{ }';
}

/** Tokens of script for comparing: quoted strings, braces, operators, words (comments left out). */
function scriptTokens(text: string): string[]
{
    return text.match(/"[^"\n]*"|[{}]|[<>!?=]=|[<>=]|[^\s{}<>=!?"#]+/g) ?? [];
}

/**
 * Whether the picker can take a written statement apart and write it back as it was: no inline math, and parsing and
 * printing it again gives the same tokens, its comments aside (the Change path keeps them, or lets one go with a
 * statement the picker removes or replaces; one inside a statement it replaces opens the script editor after the pick:
 * scriptFormat.ts keepWritten).
 */
export function keepsAsWritten(text: string): boolean
{
    const plain = withoutComments(text);
    const bare = plain.replace(/"[^"\n]*"/g, '""');

    // (a `#` left: text the tokenizer does not read, its comments unclear)
    if (bare.includes('#') || bare.includes('@['))
        return false;

    return scriptTokens(printScript(parseSnippet(plain))).join(' ') === scriptTokens(plain).join(' ');
}

/**
 * Whether the picker can change a written statement (else the script editor does): modifiers and settings written as
 * `key = value` (settings the type knows), effects and conditions the catalog has, or any one-line `key op value`.
 */
export function canPickEdit(kind: Mode, text: string, type?: string): boolean
{
    // (script the picker would print differently (`@[ … ]`, `hsv { … }`): the script editor; comments inside are kept by
    // the Change path, keepWritten)
    if (!keepsAsWritten(text))
        return false;

    const m = SCALAR.exec(text);

    if (kind === 'modifier')
        return !!m && m[2] === '=';

    if (kind === 'field')
        // (a doctrine parameter also written bare, as 1.20 does: `parameters = { doctrine_polygamy }`; a set that takes
        // any other setting: any `key = value`, changed through "Other setting…")
        return (type === 'doctrine_parameters' && BARE_WORD.test(text)) || (!!m && m[2] === '=' && isOpenSet(type) && !fieldOf(type!, m[1])) || (!!m && m[2] === '=' && !!type && (type === 'doctrine_parameters' || (!!fieldOf(type, m[1]) && fieldOf(type, m[1])!.kind !== 'level'))) || !!writtenBlock(text, type) || (!!type && !!bareField(type) && /^\s*[\w.:@-]+\s*$/.test(text)) || (!!type && FORMULA_SETS.has(type) && !!writtenBlockNode(text));

    if (kind === 'loc' || kind === 'choice')
        return false;

    return !!findStatement(kind, text) || !!m || !!writtenBlockNode(text);
}

/**
 * The states the picker opens with: the root menu and, changing a written modifier or field (`edit`), its value
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
    if (kind === 'modifier' && opts.modScope && opts.modScope in MOD_SCOPE_WORD)
        root = { ...root, modScope: opts.modScope as Exclude<ModifierKind, 'other'> };

    // (a condition / modifier block the game writes: the picker opens at what it holds there, the root menu beside it)
    if (!edit && (kind === 'trigger' || kind === 'modifier') && opts.common?.length)
        return [{ state: root }, { state: { ...root, view: { v: 'common' } }, crumb: tr('Used here') }];

    if (!edit)
    {
        // (a place for one field (a doctrine group's placeholder, a set of one field: an opposite, a compatibility, a
        // track's level): its value step beside the root menu)
        const only = kind === 'field' && type && !opts.field && FIELDS[type]?.length === 1 && FIELDS[type][0].kind !== 'bool' && !isOpenSet(type) ? FIELDS[type][0] : undefined;
        const f = kind === 'field' && opts.field && type ? fieldOf(type, opts.field) : only;

        if (f?.anyKey)
            return [{ state: root }, { state: { ...root, view: { v: 'fieldKey', field: f.key } }, crumb: plainLabel(f.label) }];

        if (f?.named)
            return [{ state: root }, { state: { ...root, view: { v: 'namedKey', field: f.key } }, crumb: plainLabel(f.label) }];

        return f ? [{ state: root }, { state: { ...root, view: { v: 'fieldValue', key: f.key } }, crumb: plainLabel(f.label) }] : [{ state: root }];
    }

    // (the root menu offers another statement in its place)
    root = { ...root, draft: { ...root.draft, loc: { ...root.draft.loc, title: tr('Change to…') } } };

    if (kind === 'effect' || kind === 'trigger')
    {
        const found = findStatement(kind, edit, scope);

        if (found)
        {
            // (every parameter asked, also those only a written one has: `years` of an add_opinion)
            const def = { ...found.def, params: allParams(found.def) };
            // (a scope the statement saves itself keeps its written name: `change_2` stays; a statement of several keeps
            // the fields it has no place for where they were written)
            const saved = def.saves && found.values[def.saves.name] ? { [def.saves.name]: found.values[def.saves.name] } : {};
            return [{ state: root }, { state: { ...root, pending: { def, chain: [], values: saved, step: 0, now: found.values, rest: found.rest, ...(found.restAt ? { restAt: found.restAt } : {}), not: found.not }, view: { v: 'param' } }, crumb: found.not ? tr('Not: {label}', { label: def.label }) : def.label }];
        }

        const sc = SCALAR.exec(edit);

        if (sc)
            return [{ state: root }, { state: { ...root, view: { v: 'otherKey', key: sc[1], op: sc[2], now: sc[3] } }, crumb: sc[1] }];

        // (a block: its head (if, NOT, a scope switch, an iterator …) or field by field)
        const n = writtenBlockNode(edit);

        if (n)
            return blockStart(opts.elseAfter && IF_KEYS.test(n.k) ? { ...root, bound: 'elseAfter' } : ELSE_KEYS.test(n.k) ? { ...root, bound: 'else' } : root, n, kind);

        return [{ state: root }];
    }

    const block = kind === 'field' ? writtenBlock(edit, type) : null;

    if (block)
        return [{ state: root }, { state: { ...root, view: { v: 'block', key: block.f.key, values: block.values } }, crumb: plainLabel(block.f.label) }];

    // (a block of a formula (`if = { limit = { … } add = 5 }`, `add = { value = x multiply = 2 }`, a weight's
    // `modifier = { factor = 2 … }`): its head, as an effect's block, or field by field)
    const formula = kind === 'field' && type && FORMULA_SETS.has(type) ? writtenBlockNode(edit) : undefined;

    if (formula)
        return blockStart(opts.elseAfter && IF_KEYS.test(formula.k) ? { ...root, bound: 'elseAfter' } : ELSE_KEYS.test(formula.k) ? { ...root, bound: 'else' } : root, formula, kind);

    // (a list's item written alone: `craven` of `opposites = { craven }`)
    const bare = kind === 'field' && type ? bareField(type) : undefined;

    if (bare && /^\s*[\w.:@-]+\s*$/.test(edit))
        return [{ state: root }, { state: { ...root, view: { v: 'fieldValue', key: bare.key, now: edit.trim() } }, crumb: plainLabel(bare.label) }];

    // (a doctrine parameter written bare: on)
    if (kind === 'field' && type === 'doctrine_parameters' && BARE_WORD.test(edit))
        return [{ state: root }, { state: { ...root, view: { v: 'paramValue', key: edit.trim(), bare: true } }, crumb: edit.trim() }];

    // (a duration written as a range, `months = { 6 12 }` (an on_action's delay): its value step, kept first)
    const ranged = kind === 'field' && type ? /^\s*(\w+)\s*=\s*(\{[^{}]*\})\s*$/.exec(edit) : null;
    const rf = ranged ? fieldOf(type!, ranged[1]) : undefined;

    if (ranged && rf?.kind === 'duration' && RANGE.test(ranged[2].trim()))
        return [{ state: root }, { state: { ...root, view: { v: 'fieldValue', key: rf.key, now: ranged[2].trim().replace(/\s+/g, ' '), unit: ranged[1].replace(/^delay_/, '') } }, crumb: plainLabel(rf.label) }];

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

        // (a key that is any entry: the written one, `brave` of `compatibility = { brave = 15 }`)
        if (f && f.kind !== 'level')
            return [{ state: root }, { state: { ...root, view: { v: 'fieldValue', key: f.anyKey ? key : f.key, now, unit: f.kind === 'duration' ? key.replace(/^delay_/, '') : undefined } }, crumb: f.anyKey ? humanize(key) : plainLabel(f.label) }];

        // (a key the catalog has no field for, in a set that takes any other setting: its value step)
        if (!f && isOpenSet(type))
            return [{ state: root }, { state: { ...root, view: { v: 'otherSettingValue', key, now } }, crumb: key }];
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
 * Wraps the statements at the draft's place from index `from` on (default: the first statement; an iterator's own
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

/** else / else_if (trigger_else …): part of the if before them, never separated from it */
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
            // (a value that is a block, the lowest order `{ value = age multiply = -1 }`, is read back as one)
            const params = (s.params ?? []).map(([k, v]): SNode => (v.startsWith('{') ? (parseSnippet(`${k} = ${v}`)[0] ?? { k, op: '=', v }) : { k, op: '=', v }));
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

/** `liege.primary_spouse`, for `exists = …` */
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

    // (and those of a statement of several, in the block they were written in)
    for (const r of p.restAt ?? [])
    {
        let at: SNode | undefined = nodes[r.at];

        for (const k of r.keys)
            at = at?.kids?.find((x) => x.k === k);

        // (never lost: with its place gone from the new text, in the statement's first block, or after it)
        (at?.kids ?? nodes[r.at]?.kids ?? nodes).push(...structuredClone(r.nodes));
    }

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
        return { ...s, draft: { ...d, loc: { ...p.enter, path: d.last } }, chain: [], pending: undefined, view: { v: 'root' }, lastRef: undefined };

    // (the entries it names: "Only with <DLC>…" next)
    const refs = s.draft.loc.kind === 'effect'
        ? p.def.params
            .filter((x): x is Extract<ParamDef, { kind: 'ref'; }> => x.kind === 'ref' && typeof p.values[x.name] === 'string')
            .map((x) => ({ name: x.name, type: x.type, prefix: x.prefix ?? '', value: p.values[x.name].slice((x.prefix ?? '').length) }))
        : [];
    return { ...s, draft: d, chain: [], pending: undefined, view: { v: 'cont' }, lastRef: refs.length ? { p, refs } : undefined };
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

/**
 * A name for a scope a statement saves itself (StatementDef.saves): `base`, or `base_2`, `base_3` … when the shown entry
 * saves or is given a scope of that name, in reach at the place (State.targets) or not (`away`: saved later in the
 * block, in another option …; a second save of one name is not checked in the game), or the draft already saves or
 * uses one (a second title given in a row).
 */
export function freeScopeName(s: State, base: string, away: readonly { key: string; }[] = []): string
{
    const taken = new Set<string>();

    for (const t of [...(s.targets ?? []), ...away])
        if (t.key.startsWith('scope:'))
            taken.add(t.key.slice(6));

    const text = printScript(s.draft.top);

    for (const m of text.matchAll(/\bsave_(?:temporary_)?scope_as\s*=\s*([\w.]+)|\bscope:(\w+)/g))
        taken.add(m[1] ?? m[2]);

    if (!taken.has(base))
        return base;

    let n = 2;

    while (taken.has(`${base}_${n}`))
        n++;

    return `${base}_${n}`;
}

function start(s: State, def: StatementDef, chain: ChainStep[] = s.chain): State
{
    const p: Pending = { def, chain, values: def.saves ? { [def.saves.name]: freeScopeName(s, def.saves.base, awayTargets()) } : {}, step: 0 };

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
        for (const n of parseSnippet(blockText(s.view.key, s.view.values, s.type)))
            d = insert(d, n);
    }

    if (s.view.v === 'kblock' || s.view.v === 'kfield' || s.view.v === 'kadd')
    {
        const root = kRoot(s, s.view.key, s.view.fields);

        for (const n of wrapChain(parseSnippet(kblockText(root.key, root.fields)), s.chain))
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

/** The game's name of a scope type, as the script database writes it (`situation_sub_region` for `sub_region`). */
function gameScopeName(t: ScopeType): string
{
    return GAME_SCOPE_NAME[t] ?? t;
}

/**
 * The game key a statement writes, for its explanation: its template's first key. A key a choice fills
 * (`add_$skill$_skill`) only with the chosen value; a scope switch at the start (`title:$title$ = { … }`) is no key.
 */
function statementDoc(d: StatementDef, values: Record<string, string> = {}): Item['doc']
{
    const m = /^[\w$]+/.exec(d.script);

    if (!m || /^[:.]/.test(d.script.slice(m[0].length)))
        return undefined;

    const key = m[0].replace(/\$(\w+)\$/g, (x, n: string) => values[n] ?? x);
    return key.includes('$') ? undefined : { kind: d.kind, key };
}

/**
 * A scope value's explanation: a saved scope the game's code saves (`scope:actor`) when the database lists the name,
 * a link (`liege`, `prev`, `root`) by its key; a chain or a name the entry saved itself has none.
 */
function scopeValueDoc(v: string): Item['doc']
{
    const saved = /^scope:(\w+)$/.exec(v);

    if (saved)
        return scriptFacts()?.savedScopes.some((x) => x.name === saved[1]) ? { kind: 'saved_scope', key: saved[1] } : undefined;

    return /^\w+$/.test(v) && LINKS.some((l) => l.key === v) ? { kind: 'link', key: v } : undefined;
}

/** Scope type of the subject: the place's scope, or where the chain leads. */
function subjectScope(s: State): ScopeType
{
    return s.chain.length ? s.chain[s.chain.length - 1].to : s.draft.loc.scope;
}

/** The links from a scope type; `root` leads to what the script's root is (State.rootScope; a doctrine's: its faith). */
function linksFrom(from: ScopeType, root?: ScopeType): ScopeLink[]
{
    return LINKS.filter((l) => l.from.length === 0 || l.from.includes(from)).map((l) => (l.key === 'root' && root ? { ...l, to: root } : l));
}

/**
 * Who the place's statements are about: "you" (the event's / decision's character), or "the faith" at the top of a
 * script whose root is one (a doctrine's), or, inside a block, its subject.
 */
function selfName(s: State): string
{
    return s.draft.loc.label || (s.rootScope ? tr('the {SCOPE_LABELS}', { SCOPE_LABELS: SCOPE_LABELS[s.rootScope] }) : 'you');
}

function selfLabel(s: State): string
{
    // (inside an iterator or a scope switch: who that is ("The child", "Liege"))
    const l = selfName(s);

    if (l === 'them')
        return tr('Them (the one it is about)');

    return l === 'you' ? tr('You (self)') : l.charAt(0).toUpperCase() + l.slice(1);
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
 * A link's label relative to who it starts from ("Your liege", "The child’s liege"); root is always the character
 * the whole script is about (the event's, the decision's).
 */
function linkLabel(s: State, l: ScopeLink): string
{
    if (l.key === 'root')
        return rootLabel(s, !s.chain.length);

    return cap(`${possessive(whoOf(s))} ${l.label.toLowerCase()}`);
}

/**
 * Whose character `root` is in the entry shown (targets.ts viewEntryType): the event's, the one taking the decision,
 * an interaction's actor (its .info: "Root is the actor", but in a few blocks the recipient or the intermediary).
 */
function rootWho(): string
{
    const t = viewEntryType();
    return t === 'events' ? tr('the event’s character') : t === 'decisions' ? tr('the one taking the decision') : t === 'character_interactions' ? tr('mostly the one acting') : tr('the character the script is about');
}

/** "Root (you — the one taking the decision)": `you` where the place's self is root itself (no subject chosen). */
function rootLabel(s: State, self: boolean): string
{
    if (s.rootScope)
        return tr('Root (the {SCOPE_LABELS})', { SCOPE_LABELS: SCOPE_LABELS[s.rootScope] });

    return selfName(s) === 'you' && self ? tr('Root (you — {who})', { who: rootWho() }) : tr('Root ({who})', { who: rootWho() });
}

/** A link as a subject step, labelled from who it starts at ("Your liege"). */
function stepFor(l: ScopeLink, s?: State): ChainStep
{
    return { kind: 'link', key: l.key, label: s ? linkLabel(s, l).replace(/ \(.*\)$/, '') : l.label, to: l.to };
}

/**
 * The scope type a typed chain leads to (`scope:x.liege.faith`, `primary_title.holder`, `title:k_france`): the first
 * part from the saved scopes in reach (PickRequest.targets: their types), root, a database prefix, or a link from
 * `from`; then each link from where the chain is. `problem`: a part that leads nowhere from there, or a saved scope
 * the view has but not in reach where the statement goes (picker/targets.ts awayTargets). Undefined type:
 * unknown. `unknown`: the first part the catalog does not know at all (no link of that name, an unlisted saved scope, a
 * prefix nobody maps): not checked, a neutral note (chainNote), never a warning. `prev` (and `prev.prev` …) is the
 * prev stack's (prevStack: the request's, the picker's own nesting on top), unknown without a note where the stack
 * does not know it; variables are unknown without a note. `guessed`: the type rests on a scope typed by a guess from
 * its block's use (PickRequest.scopeGuessed): nothing resting on it is warned about.
 *
 * `free`: the open scope is no part of the answer (`from` is ignored): a bare first part, and a part after a
 * part of unknown type, is typed by its key when every link of that key leads to the same type (how valueScope types
 * the values the game wrote for a key, wherever the picker is open).
 */
export function chainType(s: State, expr: string, from: ScopeType, free = false): { type?: ScopeType; problem?: string; unknown?: string; guessed?: boolean; }
{
    const parts = expr.split('.');
    let at: ScopeType | undefined = free ? undefined : from;
    let i = 0;
    const first = parts[0];
    const prefix = /^(\w+):/.exec(first);
    // (a chain from the open scope, when that is a guess: placeScopes)
    const guessed = !free && first !== 'root' && first !== 'prev' && !prefix && subjectGuessed(s);

    if (first === 'root')
        (at = free ? undefined : (s.rootScope ?? 'character')), i++;
    else if (first === 'this')
        i++;
    else if (first === 'prev')
    {
        if (free)
            return {};

        // (`prev` is the top of the stack, `prev.prev` the one below: describer.ts linkedScope)
        const stack = prevStack(s);

        while (parts[i] === 'prev')
            i++;

        // (the game refuses a prev after a prev: error.log "Link 'prev' is a global link but follows a 'prev' link",
        // and the statement holding it is dropped; vanilla never writes it; round 13's second in-game test)
        if (i > 1)
            return { problem: tr('{expr}: the game does not allow prev after prev (error.log: “a global link but follows a prev link”), and the statement is not run', { expr }) };

        at = stack[stack.length - i];

        if (!at)
            return {};
    }
    else if (first.startsWith('var:') || first.startsWith('local_var:') || first.startsWith('global_var:'))
        return {};
    else if (prefix?.[1] === 'scope')
    {
        const t = (s.targets ?? []).find((x) => x.key === first);

        if (!t)
        {
            // (saved by the entry, but not in reach where the statement goes, or none of the known ones: picker/targets.ts)
            const problem = typedScopeWarning(first, s.targets ?? [], awayTargets(), !!s.targetsKnown);
            return problem ? { problem } : { unknown: first };
        }

        at = (SCOPE_TYPES as string[]).includes(t.type ?? 'character') ? ((t.type ?? 'character') as ScopeType) : undefined;
        i++;
    }
    else if (prefix)
    {
        at = PREFIX_SCOPES[prefix[1]];

        if (!at && !free)
            return { unknown: first };

        i++;
    }

    for (; i < parts.length && (at || free); i++)
    {
        const here = at;
        const l = here ? LINKS.find((x) => x.key === parts[i] && (x.from.length === 0 || x.from.includes(here))) : agreedLink(parts[i]);

        if (!l)
        {
            // (a link the catalog knows from other types: it leads nowhere from here; from a guessed scope: unchecked)
            if (here && LINKS.some((x) => x.key === parts[i]))
                return guessed ? {} : { problem: tr('“{parts}” leads nowhere from a {SCOPE_LABELS}', { parts: parts[i], SCOPE_LABELS: SCOPE_LABELS[here] }) };

            // (no link of that name at all, or in free mode one whose types disagree: left unchecked)
            return LINKS.some((x) => x.key === parts[i]) ? {} : { unknown: parts[i] };
        }

        at = l.key === 'root' ? (free ? undefined : (s.rootScope ?? 'character')) : l.to;
    }

    return guessed && parts.every((p) => p !== 'root') ? { type: at, guessed } : { type: at };
}

/** a picker scope type from a describer's (LineSource.scope, the prev stack's entries): undefined when not one of them */
function asScope(t: string | null | undefined): ScopeType | undefined
{
    return t && (SCOPE_TYPES as string[]).includes(t) ? (t as ScopeType) : undefined;
}

/**
 * The scopes `prev` leads to at the picker's subject (the last is `prev`), as describer.ts pushPrev builds them: the
 * request's stack (placeScopes: the line's, PickRequest.prev), then each scope switch or iterator of the draft along
 * the place's path, then the subject chain's steps (wrapChain's blocks: a run of links is one switch), each pushing
 * the scope it left. A switch to a chain of links (`liege.primary_title`) or to `prev` pushes "not known", and so does
 * one from a scope whose type is not known or a guess (placeScopes: the request's scope not given, or guessed).
 */
export function prevStack(s: State): (ScopeType | undefined)[]
{
    const p = placeScopes();
    const stack = (p.prev ?? []).map(asScope);
    let at = p.guessed ? undefined : asScope(p.scope);
    // (a link from a guessed scope is a guess too; an iterator's items are what the list says)
    let guess = !!p.guessed;
    const push = (key: string, iter: boolean): void =>
    {
        stack.push(!guess && (iter || (!key.includes('.') && key !== 'prev')) ? at : undefined);
    };
    let list = s.draft.top;

    for (const i of s.draft.loc.path)
    {
        const n = list[i];

        if (!n)
            break;

        if (n.meta)
        {
            push(n.k, n.meta.wrap === 'iter');
            at = n.meta.scope;
            guess &&= n.meta.wrap === 'scope' && !/^(root|prev)$|:/.test(n.k.split('.')[0]);
        }

        list = n.kids ?? [];
    }

    const chain = s.pending ? s.pending.chain : s.chain;

    for (let i = 0; i < chain.length;)
    {
        const c = chain[i];

        if (c.kind === 'iter')
        {
            push(c.key, true);
            at = c.to;
            guess = false;
            i++;
            continue;
        }

        let j = i;

        while (j < chain.length && chain[j].kind === 'link')
            j++;

        const run = chain.slice(i, j);
        push(run.map((r) => r.key).join('.'), false);
        at = run[run.length - 1].to;
        guess &&= !/^(root|prev)$|:/.test(run[0].key.split('.')[0]);
        i = j;
    }

    return stack;
}

/**
 * The picker's subject is the request's scope typed by a guess (placeScopes().guessed), or a link from it: no
 * iterator, saved scope, root or prev on the way (prevStack's rule).
 */
function subjectGuessed(s: State): boolean
{
    if (!placeScopes().guessed)
        return false;

    const plainLink = (k: string): boolean => !/^(root|prev)$|:/.test(k.split('.')[0]);
    let list = s.draft.top;

    for (const i of s.draft.loc.path)
    {
        const n = list[i];

        if (!n)
            break;

        if (n.meta && (n.meta.wrap === 'iter' || !plainLink(n.k)))
            return false;

        list = n.kids ?? [];
    }

    const chain = s.pending ? s.pending.chain : s.chain;
    return chain.every((c) => c.kind === 'link' && plainLink(c.key));
}

/**
 * The neutral note for a typed chain nothing could check (chainType's `unknown`): not a warning, the catalog simply
 * does not know the part. Undefined when the chain was checked, or is a problem already.
 */
function chainNote(s: State, expr: string, from: ScopeType): string | undefined
{
    const c = chainType(s, expr, from);
    return c.unknown ? tr('Not checked: the catalog does not know “{part}”', { part: c.unknown }) : undefined;
}

/**
 * The common saved scopes offered besides the ones in reach (SAVED_SCOPES) where a scope of `type` is asked for: all of
 * them while nothing is known about the scopes in reach, only `prev` when the entry's scopes are known
 * (State.targetsKnown: an event without an actor does not offer "Actor"); `prev` not when it is known to be another type.
 */
function savedScopeRows(s: State, type: ScopeType): { key: string; label: string; }[]
{
    // (`prev` of another type than the one asked for, as far as the prev stack knows it (prevStack), is not offered; typed,
    // it is warned about)
    const prev = chainType(s, 'prev', 'character').type;
    const rows = s.targetsKnown ? SAVED_SCOPES.filter((x) => x.key === 'prev') : SAVED_SCOPES;
    return prev && prev !== type ? rows.filter((x) => x.key !== 'prev') : rows;
}

/**
 * A value written with a saved scope (`scope:actor`, `scope:actor.faith`) is offered unless the entry's scopes are known
 * (State.targetsKnown) and it names none of them. The statements' `common` lists name the usual ones (actor, recipient …)
 * whether the entry has them or not.
 */
export function scopeInReach(s: State, value: string): boolean
{
    const head = /^(scope:\w+)/.exec(value)?.[1];
    return !s.targetsKnown || !head || (s.targets ?? []).some((t) => t.key === head);
}

/** A warning for a typed chain where `want` is expected (undefined: fine or unknown). */
function chainWarning(s: State, expr: string, from: ScopeType, want: ScopeType): string | undefined
{
    const c = chainType(s, expr, from);

    if (c.problem)
        return c.problem;

    // (a type resting on a guess from the block's use is never warned about)
    return c.type && c.type !== want && !c.guessed ? tr('{expr} is a {SCOPE_LABELS}, not a {SCOPE_LABELS2}', { expr, SCOPE_LABELS: SCOPE_LABELS[c.type], SCOPE_LABELS2: SCOPE_LABELS[want] }) : undefined;
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
            doc: scopeValueDoc(t.key),
            go: () => go(withChain(s, { kind: 'link', key: t.key, label: t.label, to: type }, { v: 'stmts' }), t.label + plainLabel(suffix))
        }));
}

function withChain(s: State, step: ChainStep, view: View): State
{
    return { ...s, chain: [...s.chain, step], view };
}

/** A plain menu (mode 'choice') as the picker's: a row opens its menu, or finishes with its value as the result. */
function choiceMenu(s: State, m: ChoiceMenu): Menu
{
    const item = (c: ChoiceItem): Item => (c.header ? { label: c.label, role: 'info' } : {
        label: c.label,
        key: c.key,
        color: c.color,
        icon: c.icon,
        entry: c.entry,
        explain: c.explain,
        warn: c.warn,
        hint: c.warn ? `⚠ ${c.hint ?? ''}`.trim() : c.hint,
        state: c.state,
        sub: !!c.sub,
        rank: c.dim ? 1 : undefined,
        go: () =>
            c.toggle ? { state: { ...s, choice: c.toggle() }, crumb: c.label, back: 0 } :
            c.sub ? { state: { ...s, choice: c.sub() }, crumb: c.label } :
            { finish: true, state: { ...s, raw: c.value ?? c.label } }
    });
    // (rows loaded later: asked once, the menu built again when they come; Menu.wait)
    if (m.load && !m.loaded && !m.loading)
        m.loading = m.load().then(
            (rows) => (m.loaded = rows),
            () => (m.loaded = [])
        );

    return {
        title: m.title,
        items: [...m.items, ...(m.loaded ?? [])].map(item),
        ...(m.load && !m.loaded ? { wait: m.loading } : {}),
        typeahead: m.typeahead,
        wide: m.wide,
        note: m.note,
        search: m.search && (async (q: string) => (await m.search!(q)).map(item)),
        number: m.number && ((n: number) => m.number!(n).map(item)),
        input: m.input && ((text: string) =>
        {
            const c = m.input!(text);
            return c ? item(c) : null;
        })
    };
}

/**
 * Rows standing for a game key (Item.doc) without a tooltip of their own get its explanation's summary: hovering any of
 * them says what it is, not only the highlighted one's card.
 */
function withDocTitles(m: Menu, data: PickerData): Menu
{
    if (!data.docLabel || !m.items.some((i) => i.doc && !i.title))
        return m;

    return {
        ...m,
        items: m.items.map((i) =>
        {
            const summary = i.doc && !i.title ? data.docLabel!(i.doc.kind, i.doc.key)?.[1] : undefined;
            return summary ? { ...i, title: summary } : i;
        })
    };
}

export function menuOf(s: State, data: PickerData): Menu
{
    if (s.view.v === 'choice' && s.choice)
        return choiceMenu(s, s.choice);

    const shown = withDocTitles(menuOfView(s, data), data);
    // (the place's scope typed by a guess from its block's use (placeScopes): its root menu says so)
    const m = s.view.v === 'root' && !s.draft.loc.path.length && subjectGuessed(s) ?
        { ...shown, note: [shown.note, tr('A {SCOPE_LABELS}: type guessed from its use (its block’s statements), not checked', { SCOPE_LABELS: SCOPE_LABELS[s.draft.loc.scope] })].filter(Boolean).join(' · ') } :
        shown;

    if (!s.passing)
        return m;

    // ("Pass along": choosing who saves them under the name, before the event is sent)
    const title = s.view.v === 'targets' ? tr('Who is “{passing}”?', { passing: s.passing }) : m.title;
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
    const def: StatementDef = { id: 'e.pass', kind: 'effect', group: 'do', label: tr('Pass along'), scopes: 'any', script: `save_scope_as = ${s.passing}`, params: [] };
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
        hint: tr('scope:{name}', { name }),
        ...extra,
        go: () => go({ ...s, passing: name, chain: [], view: { v: 'targets', type: 'character' } }, tr('As {name}', { name }))
    });
    return {
        title: tr('Pass along to {event}', { event }),
        items: (expected ?? []).map((x) => pick(x.name, cap(x.name.replace(/_/g, ' ')) + (known(x.name) ? tr(' — the same name here goes along') : ''), { title: x.about })),
        wait: expected ? undefined : data.eventScopesLoaded?.(event),
        input: (text) =>
        {
            const n = nameOf(text).replace(/^scope:/, '');
            return n ? pick(n, tr('As “scope:{n}”…', { n }), { hint: tr('a new name') }) : null;
        },
        note: expected && !expected.length ? tr('The event uses no names yet — type one to pass someone along as it') : tr('The names the event uses — or type one')
    };
}

function menuOfView(s: State, data: PickerData): Menu
{
    const v = s.view;

    switch (v.v)
    {
        // (menuOf shows a plain menu itself)
        case 'choice':
            return { title: s.choice?.title ?? '', items: [] };
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
        {
            // (the scripted lists go beside their base list (the active mod's first): built again once they are loaded;
            // read here only, so the picker's warm-up at start asks nothing of an index not ready yet)
            const sl = data.list('scripted_lists');
            scriptedLists = modFirst(sl, data) ?? scriptedLists;
            const m = itersMenu(s, v.mode, v.type);
            return sl ? m : { ...m, wait: data.loaded('scripted_lists') };
        }
        case 'iterParam':
            return iterParamMenu(s, data, v.step, v.list, v.i);
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
        case 'flowRoot':
            return flowRootMenu(s);
        case 'newText':
            return newTextMenu(s, data, v);
        case 'flowNew':
            return flowNewMenu(s, v.what);
        case 'related':
            return relatedMenu(s);
        case 'stmts':
            if (s.goal === 'name' && s.draft.loc.kind === 'effect')
                return nameMenu(s, data);

            if (s.goal === 'send' && s.draft.loc.kind === 'effect')
                return sendMenu(s);

        {
            const m = s.draft.loc.kind === 'effect' ? effectStatements(s, v.group) : triggerStatements(s, v.group);
            // (inside the block of an iterator being built: its other options, "More about this list…")
            const more = v.group ? null : iterMoreRow(s);
            return more ? { ...m, items: [...m.items, more] } : m;
        }
        case 'param':
            return paramMenu(s, data);
        case 'cont':
            return dlcOffer(s, data, continuation(s));
        case 'dlcPair':
            return dlcPairMenu(s, data, v);
        case 'effectOn':
            return effectOnMenu(s);
        case 'shelf':
            return shelfMenu(s, data, v.id);
        case 'dlcWrap':
            return dlcWrapMenu(s, data, v.fallback);
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
        case 'durationRange':
            return durationRangeMenu(s, v.key, v.unit, v.lo, v.param);
        case 'fieldKey':
            return fieldKeyMenu(s, data, v.field);
        case 'namedKey':
            return namedKeyMenu(s, v.field);
        case 'namedLevel':
            return namedLevelMenu(s, data, v.field, v.name);
        case 'namedLoc':
            return namedLocMenu(s, data, v.field, v.name, v.level);
        case 'namedDesc':
            return namedDescMenu(s, data, v.field, v.name, v.level);
        case 'otherSetting':
            return otherSettingMenu(s, data);
        case 'otherSettingValue':
            return otherSettingValueMenu(s, data, v.key, v.now);
        case 'fieldGroup':
            return fieldGroupMenu(s, data, v.key, v.group);
        case 'paramValue':
            return paramValueMenu(s, v.key, v.now, v.bare);
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
            return iterSetMenu(s, data, v.what, v.i, v.path, v.inBlock);
        case 'iterMore':
            return iterMoreMenu(s, v.path);
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
            return newRefNameMenu(s, v.type, v.key, v.then, v.holder);
        case 'newRefHolder':
            return newRefHolderMenu(s, data, v.type, v.key, v.then);
        case 'newRefHolderKey':
            return newRefHolderKeyMenu(s, data, v.type, v.key, v.then);
        case 'newRefHolderName':
            return newRefHolderNameMenu(s, data, v.type, v.key, v.then, v.hk);
    }
}

/** Goal 'name': who it is has been chosen. What to call them (save_scope_as; names the script uses come first). */
function nameMenu(s: State, data: PickerData): Menu
{
    const m = paramMenu(start(s, statementById('e.do.save_scope')!), data);
    const who = s.chain.length ? chainLabel(s.chain) : selfLabel(s);
    return { ...m, title: tr('{who}: call them…', { who }), note: tr('Type a name (letters, _): it becomes scope:<name> · ← back') };
}

/** Goal 'send': who gets the event has been chosen. Send it (`trigger_event = <event>` inside their block). */
function sendMenu(s: State): Menu
{
    const who = s.chain.length ? chainLabel(s.chain) : selfLabel(s);
    const def: StatementDef = { id: 'e.send', kind: 'effect', group: 'do', label: tr('Send the event'), scopes: 'any', script: `trigger_event = ${s.event ?? 'event'}`, params: [] };
    return {
        title: who,
        items: [{ label: tr('Send the event to {who}', { who: who.charAt(0).toLowerCase() + who.slice(1) }), key: 's', hint: '⏎', go: () => go(complete(s, { def, chain: s.chain, values: {}, step: 0 }), tr('Send')) }]
    };
}

function effectRoot(s: State): Menu
{
    const loc = s.draft.loc;

    // (naming someone: who is it? sending the event: who gets it?)
    if (s.goal)
        return { ...targetsMenu(s, 'character'), title: s.goal === 'name' ? tr('Who is it?') : tr('Who gets the event?'), note: tr('Keys: letter = item · type to filter · ← back · Esc close') };

    // (on whom: a menu of the scope types in reach (character, title, faith …))
    const items: Item[] = [{ label: tr('Effect on…'), sub: true, key: 'o', title: tr('A character, title, province, faith … — and what happens to them'), go: () => go({ ...s, view: { v: 'effectOn' } }, tr('Effect on')) }];
    // (conditions and chance first, the effects inside: if, random, random_list, switch, hidden_effect; "What next?"
    // offers the same around what is built already)
    items.push({ label: tr('If, chance, outcomes…'), sub: true, key: 'i', title: tr('Effects only when conditions hold (if), by chance, one of several outcomes, depending on a value, or hidden'), go: () => go({ ...s, view: { v: 'flowRoot' } }, tr('If / chance')) });

    // (the shelves: scopes and lists, things made, messages and sound; keys of the game's script under labels)
    for (const shelf of EFFECT_SHELVES)
        items.push({ label: shelf.label, sub: true, key: shelf.k, title: shelf.title, go: () => go({ ...s, view: { v: 'shelf', id: shelf.id } }, plainLabel(shelf.label)) });

    // (wanted most often, straight away: an event for whom the script runs for)
    const event = statementById('e.do.event');

    if (event)
        items.unshift({
            label: tr('Trigger an event…'),
            key: 'e',
            sub: true,
            explain: tr('trigger_event: {gets} an event (right away or later); “Pass along…” then names who it speaks of. For someone else: Effect on… → Character → who → Do → Trigger an event.', { gets: selfName(s) === 'you' ? tr('you get') : tr('{selfName} gets', { selfName: selfName(s) }) }),
            go: () => go(start({ ...s, chain: [] }, event, []), tr('Trigger an event'))
        });

    items.push({ label: tr('Game & world…'), sub: true, key: 'g', go: () => go({ ...s, view: { v: 'global' } }, 'Game & world') });
    items.push({ label: tr('Other effect…'), sub: true, key: 'x', title: tr('Any effect key the game’s script uses'), go: () => go({ ...s, view: { v: 'other' } }, tr('Other effect')) });
    return { title: loc.title ?? (s.title ? tr('Add to: {title}', { title: s.title }) : tr('Add an effect')), items, note: tr('Keys: letter = item · type to filter · / search all · ← back · Esc close') };
}

/** "Effect on…": the scope types in reach (the place's own, its links, iterators, the event's saved scopes). */
function effectOnMenu(s: State): Menu
{
    const loc = s.draft.loc;
    const items: Item[] = [];

    // (the root menu's types, then those of the place and of the event's saved scopes that are none of them: a regiment, a great project …)
    const extra = [loc.scope, ...(s.targets ?? []).map((x) => x.type ?? 'character')].filter((t, i, all) => !(SCOPE_ORDER as string[]).includes(t) && (SCOPE_TYPES as string[]).includes(t) && all.indexOf(t) === i) as ScopeType[];

    for (const t of [...SCOPE_ORDER, ...extra])
    {
        const reachable = t === loc.scope || linksFrom(loc.scope, s.rootScope).some((l) => l.to === t) || ITERATORS.some((i) => i.effect && i.from.includes(loc.scope) && i.to === t) || (s.targets ?? []).some((x) => (x.type ?? 'character') === t);

        if (!reachable)
            continue;

        items.push({ label: tr('Effect on {SCOPE_LABELS}…', { SCOPE_LABELS: SCOPE_LABELS[t] }), sub: true, key: t === 'character' ? 'c' : undefined, doc: { kind: 'scope_type', key: gameScopeName(t) }, go: () => go({ ...s, view: { v: 'targets', type: t } }, tr('Effect on {SCOPE_LABELS}', { SCOPE_LABELS: SCOPE_LABELS[t] })) });
    }

    return { title: tr('Effect on…'), items, note: tr('Keys: letter = item · type to filter · ← back') };
}

/**
 * The effect root's shelves: effects of the game's script the statement catalog has no menu for, by what they are for.
 * Each opens the key's "Other effect…" step (its values the game writes, a block field by field). [key, label, help]
 */
const EFFECT_SHELVES: { id: string; label: string; k: string; title: string; items: [string, string, string?][]; }[] = [
    {
        id: 'scope',
        label: tr('Scope & lists…'),
        k: 's',
        title: tr('Name someone or something for later (save_scope_as), lists, variables'),
        items: [
            ['save_scope_as', tr('Save scope as…'), tr('This one under a name for the rest of the event / chain: scope:<name>')],
            ['save_temporary_scope_as', tr('Save scope as, for now…'), tr('Under a name for the rest of the part of the script it is saved in')],
            ['save_scope_value_as', tr('Save a value as…'), 'A number or flag under a name: { name = x value = … }'],
            ['save_temporary_scope_value_as', tr('Save a value as, for now…')],
            ['clear_saved_scope', tr('Forget a saved scope…')],
            ['add_to_list', tr('Add to a list…'), tr('A named list of this event (every_in_list, random_in_list go through it)')],
            ['add_to_temporary_list', tr('Add to a list, for now…')],
            ['remove_from_list', tr('Remove from a list…')],
            ['add_to_variable_list', tr('Add to a variable list…'), 'A list kept on the scope: { name = x target = … }'],
            ['remove_list_variable', tr('Remove from a variable list…')],
            ['clear_variable_list', tr('Clear a variable list…')],
            ['add_to_global_variable_list', tr('Add to a global variable list…')],
            ['set_local_variable', tr('Set a local variable…')],
            ['remove_local_variable', tr('Remove a local variable…')],
            ['change_global_variable', tr('Change a global variable…')]
        ]
    },
    {
        id: 'create',
        label: tr('Create…'),
        k: 'n',
        title: tr('A new character, artifact, memory, story, army …'),
        items: [
            ['create_character', tr('A character…'), '{ template = … location = … save_scope_as = … }'],
            ['create_artifact', tr('An artifact…')],
            ['create_character_memory', tr('A memory…')],
            ['create_story', tr('A story…')],
            ['create_inspiration', tr('An inspiration…')],
            ['create_task_contract', tr('A task contract…')],
            ['create_maa_regiment', tr('A men-at-arms regiment…')],
            ['spawn_army', tr('An army…')],
            ['create_dynamic_title', tr('A title…')],
            ['create_alliance', tr('An alliance…')],
            ['create_legend_seed', tr('A legend seed…')],
            ['create_adventurer_title', tr('An adventurer title…')]
        ]
    },
    {
        id: 'fx',
        label: tr('Messages, sound & UI…'),
        k: 'm',
        title: tr('Notifications, music and sounds, windows, tooltip texts'),
        items: [
            ['send_interface_toast', tr('Toast (a short notice)…'), '{ type = event_toast_effect_good title = … left_icon = … <effects shown> }'],
            ['send_interface_message', tr('Message (in the message feed)…')],
            ['play_music_cue', tr('Play music…')],
            ['play_sound_effect', tr('Play a sound…')],
            ['custom_tooltip', tr('Tooltip text…'), tr('A text of its own shown instead of the effects inside')],
            ['open_view_data', tr('Open a window…')],
            ['open_view', tr('Open a view…')],
            ['close_view', tr('Close a view…')],
            ['open_interaction_window', tr('Open an interaction…')],
            ['start_tutorial_lesson', tr('Start a tutorial lesson…')],
            ['debug_log', tr('Debug log line…')]
        ]
    }
];

/** A shelf's keys: each to its "Other effect…" step (the scan's info: the values the game writes, its shape). */
function shelfMenu(s: State, data: PickerData, id: string): Menu
{
    const shelf = EFFECT_SHELVES.find((x) => x.id === id);

    if (!shelf)
        return { title: id, items: [] };

    const scanned = data.keys('effect');
    const info = new Map((scanned ?? []).map((k) => [k.key, k]));
    return {
        title: plainLabel(shelf.label),
        items: shelf.items.map(([key, label, help]) =>
        {
            const k = info.get(key) ?? { key, count: 0, shapes: {}, values: [] };
            return { label, hint: key, title: help ? `${key}: ${help}` : key, sub: true, doc: { kind: 'effect', key }, go: () => go({ ...s, view: keyView(k) }, plainLabel(label)) };
        }),
        wait: scanned ? undefined : data.keysLoaded(),
        note: tr('Keys: letter = item · type to filter · ← back — the values the game writes for each are offered')
    };
}

function targetsMenu(s: State, type: ScopeType): Menu
{
    const loc = s.draft.loc;
    const items: Item[] = [];

    if (type === loc.scope)
        items.push({ label: selfLabel(s), key: 's', sub: true, go: () => go({ ...s, view: { v: 'stmts' } }, tr('Self')) });

    const links = linksFrom(loc.scope, s.rootScope).filter((l) => l.to === type);
    // (naming someone: root is "you" already)
    const shown = (type === 'character' ? links.filter((l) => l.main) : links).filter((l) => !(s.goal && l.key === 'root'));

    for (const l of shown)
        items.push({ label: linkLabel(s, l), key: l.k, hint: l.key, sub: true, doc: { kind: 'link', key: l.key }, go: () => go(withChain(s, stepFor(l, s), { v: 'stmts' }), linkLabel(s, l)) });

    items.push(...targetItems(s, type, ''));

    if (type === 'character')
        items.push({ label: tr('Someone else…'), sub: true, key: 'o', go: () => go({ ...s, view: { v: 'someone', type } }, tr('Someone else')) });

    if (ITERATORS.some((i) => i.effect && i.from.includes(loc.scope) && i.to === type))
    {
        // (a name for "every …" would be the last one's)
        if (s.goal !== 'name' && !s.passing)
            items.push({ label: tr('Every…'), sub: true, key: 'v', go: () => go({ ...s, view: { v: 'iters', mode: 'every', type } }, tr('Every')) });

        items.push({ label: tr('A random…'), sub: true, key: 'n', go: () => go({ ...s, view: { v: 'iters', mode: 'random', type } }, tr('A random')) });

        if (!s.goal && !s.passing && ITERATORS.some((i) => i.effect && i.orders && i.from.includes(loc.scope) && i.to === type))
            items.push({ label: tr('The one with the highest…'), sub: true, key: 'w', title: 'ordered_… = { order_by = … }: the child with the highest age, the vassal with the most gold …', go: () => go({ ...s, view: { v: 'iters', mode: 'ordered', type } }, tr('The highest')) });
    }

    return { title: tr('Effect on {SCOPE_LABELS}', { SCOPE_LABELS: SCOPE_LABELS[type] }), items };
}

function someoneMenu(s: State, type: ScopeType): Menu
{
    const from = subjectScope(s);
    const items: Item[] = [];

    for (const l of linksFrom(from, s.rootScope).filter((x) => x.to === type && !x.main))
        items.push({ label: linkLabel(s, l), hint: l.key, sub: true, doc: { kind: 'link', key: l.key }, go: () => go(withChain(s, stepFor(l, s), { v: 'stmts' }), linkLabel(s, l)) });

    items.unshift(...targetItems(s, type, ''));

    if (type === 'character')
    {
        for (const sc of savedScopeRows(s, 'character'))
        {
            const step: ChainStep = { kind: 'link', key: sc.key, label: sc.label.replace(/ \(.*\)$/, ''), to: 'character' };
            items.push({ label: sc.label, hint: sc.key, sub: true, doc: scopeValueDoc(sc.key), go: () => go(withChain(s, step, { v: 'stmts' }), step.label) });
        }

        items.push({ label: tr('A historical character…'), key: 'h', sub: true, hint: tr('character:…'), go: () => go({ ...s, view: { v: 'character', as: 'subject' } }, tr('Historical character')) });
    }

    return {
        title: tr('Someone else'),
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
                label: tr('Saved scope “{key}”', { key }),
                sub: true,
                hint: c.unknown ? tr('not checked') : to !== 'character' ? SCOPE_LABELS[to] : undefined,
                title: c.unknown ? tr('Not checked: the catalog does not know “{part}”', { part: c.unknown }) : undefined,
                warn: c.problem ?? (c.type && c.type !== type && !c.guessed ? tr('{key} is a {SCOPE_LABELS}: its statements follow', { key, SCOPE_LABELS: SCOPE_LABELS[c.type] }) : undefined),
                go: () => go(withChain(s, { kind: 'link', key, label: key.replace(/^scope:/, ''), to }, { v: 'stmts' }), key)
            };
        },
        note: tr('Space, then a saved scope or a chain (scope:x, liege.faith): the statements of what it is follow')
    };
}

/**
 * The scripted lists (common/scripted_lists: `powerful_vassal = { base = vassal conditions = { … } }`), the active
 * mod's first, as menuOf last read them from the picker data. The game makes every_ / random_ / ordered_ / any_<name>
 * of each, over its base list's items (the owner's D3: offered beside their base list, itersMenu).
 */
let scriptedLists: RefEntry[] = [];

/** The scripted lists as loaded (data.ts, at once: a written `every_<name>` opened through Change is read before any menu). */
export function setScriptedLists(list: RefEntry[]): void
{
    scriptedLists = list;
}

/** A scripted list as an iterator: its base list's scopes and orders, its own name; no parameters (its conditions choose). */
function scriptedIter(list: string): IteratorDef | undefined
{
    const e = scriptedLists.find((x) => x.name === list);
    const base = e?.base ? ITERATORS.find((i) => i.list === e.base) : undefined;
    return e && base ? { ...base, list, label: e.display && e.display !== list ? e.display : list.replace(/_/g, ' '), effect: true, trigger: true, params: undefined } : undefined;
}

function itersMenu(s: State, mode: 'every' | 'random' | 'any' | 'ordered', type?: ScopeType): Menu
{
    const from = subjectScope(s);
    const items: Item[] = [];

    // (the catalog lists vanilla's scripted lists among the others (powerful_vassal …): those come after their base
    // instead, with the catalog's own entry, once)
    const scripted = scriptedLists.filter((e) => e.base && ITERATORS.some((i) => i.list === e.base));
    const moved = new Set(scripted.map((e) => e.name));

    for (const base of ITERATORS)
    {
        if (moved.has(base.list) || !base.from.includes(from) || (type && base.to !== type))
            continue;

        // (the list itself, then the scripted lists made from it)
        for (const i of [base, ...scripted.filter((e) => e.base === base.list).map((e) => ITERATORS.find((x) => x.list === e.name) ?? scriptedIter(e.name)!)])
            iterRow(i);
    }

    function iterRow(i: IteratorDef): void
    {
        if (mode === 'any' ? !i.trigger : !i.effect || (mode === 'ordered' && !i.orders))
            return;

        const word = mode === 'every' ? tr('Every') : mode === 'random' ? tr('A random') : mode === 'ordered' ? 'The' : 'Any';
        const subject = mode === 'every' ? tr('each {label}', { label: i.label }) : mode === 'random' ? tr('a random {label}', { label: i.label }) : mode === 'ordered' ? tr('the {label}', { label: i.label }) : tr('any {label}', { label: i.label });
        const step: ChainStep = { kind: 'iter', key: `${mode}_${i.list}`, label: subject, to: i.to };
        const label = mode === 'ordered' ? tr('The {label} with the highest…', { label: i.label }) : `${word} ${i.label}`;
        // (its parameters first (a relation: which one, friend, rival …; a pool character: in which province); ordered: by what)
        const next: View = i.params?.length ? { v: 'iterParam', step, list: i.list, i: 0 } : mode === 'ordered' ? { v: 'orderBy', step } : { v: 'stmts' };
        items.push({ label: i.params?.length && mode !== 'ordered' ? `${label}…` : label, hint: step.key, sub: true, doc: { kind: 'list', key: i.list }, go: () => go(next.v === 'stmts' ? withChain(s, step, next) : { ...s, view: next }, label) });
    }

    return { title: mode === 'every' ? tr('Every…') : mode === 'random' ? tr('A random…') : mode === 'ordered' ? tr('The one with the highest…') : tr('Any of their…'), items, wide: true };
}

/** The list an iterator key (`every_friend`, `any_pool_character`) is over. */
function listOfKey(key: string): IteratorDef | undefined
{
    const list = key.replace(/^(every|random|ordered|any)_/, '');
    return ITERATORS.find((x) => x.list === list) ?? scriptedIter(list);
}

/**
 * One parameter of a list (scriptCatalog.ts IteratorParam) as a menu: its entries (a relation's kind, a court position),
 * its words, a scope (a pool character's province: the links and saved scopes that lead to one, or typed) or a name;
 * `pick(null, …)` leaves an optional one out. Asked when the list is chosen (`iterParam`) and when changing a written one (`iterSet`).
 */
function iterParamItems(s: State, data: PickerData, param: IteratorParam, pick: (value: string | null, label: string) => Next): Menu
{
    const one = (value: string | null, label: string, extra: Partial<Item> = {}): Item => ({ label, hint: value ?? undefined, match: value ?? undefined, sub: true, ...extra, go: () => pick(value, label) });
    const none = param.optional !== undefined ? [one(null, param.optional, { hint: tr('leave out') })] : [];
    const typed = (text: string): Item | null =>
    {
        const name = nameOf(text);
        return name ? one(name, `“${name}”`) : null;
    };

    if (param.kind === 'ref')
    {
        const list = modFirst(data.list(param.ref!), data);
        return {
            title: param.label,
            typeahead: true,
            wide: true,
            items: [...none, ...(list ?? []).map((e) => one(e.name, e.display && e.display !== e.name ? e.display : humanize(e.name)))],
            wait: list ? undefined : data.loaded(param.ref!),
            input: typed,
            note: tr('Most used first — type to filter')
        };
    }

    if (param.kind === 'choice')
        return { title: param.label, items: [...none, ...(param.options ?? []).map(([v, l]) => one(v, l))] };

    if (param.kind === 'text')
        return { title: param.label, typeahead: true, wide: true, items: [...none, ...(param.suggestions ?? []).map((x) => one(x, humanize(x)))], input: typed, note: tr('Type a name — the ones the game’s script uses are listed') };

    // (a scope: relative to where the list is written)
    const to = param.to!;
    const from = subjectScope(s);
    const items: Item[] = [...none];
    const seen = new Set<string>();
    const add = (value: string, label: string, extra: Partial<Item> = {}): void =>
    {
        if (!seen.has(value))
        {
            seen.add(value);
            items.push(one(value, label, extra));
        }
    };

    for (const [value, label] of param.common ?? [])
        if (scopeInReach(s, value))
            add(value, label, { doc: scopeValueDoc(value) });

    for (const l of linksFrom(from, s.rootScope))
        if (l.to === to && l.key !== 'root')
            add(l.key, linkLabel(s, l), { doc: { kind: 'link', key: l.key } });

    for (const t of (s.targets ?? []).filter((x) => (x.type ?? 'character') === to))
        add(t.key, t.label, { title: t.about, doc: scopeValueDoc(t.key) });

    return {
        title: param.label,
        items,
        input: (text) =>
        {
            const name = nameOf(text);

            if (!name)
                return null;

            const key = /^(scope:|root|prev|this)/.test(name) || name.includes('.') ? name : `scope:${name}`;
            const warn = chainWarning(s, key, from, to);
            const note = warn ? undefined : chainNote(s, key, from);
            return one(key, tr('Saved scope “{key}”', { key }), { warn, title: note, hint: note ? tr('not checked') : key });
        },
        note: tr('Space, then a saved scope or a chain (scope:x, root.location)')
    };
}

/** The `i`-th parameter of a list being chosen: its answer joins the iterator's step (a relation's kind names the items: "each friend"), then the next parameter, the order or the statements. */
function iterParamMenu(s: State, data: PickerData, step: ChainStep, listKey: string, i: number): Menu
{
    const def = ITERATORS.find((x) => x.list === listKey)!;
    const param = def.params![i];
    const word = step.label.replace(/ \w+$/, '');
    const menu = iterParamItems(s, data, param, (value, name) =>
    {
        const typed: ChainStep = value ? { ...step, params: [...(step.params ?? []), [param.key, value]], label: param.names ? `${word} ${name.toLowerCase()}` : step.label } : step;

        if (i + 1 < def.params!.length)
            return go({ ...s, view: { v: 'iterParam', step: typed, list: listKey, i: i + 1 } }, name);

        // (ordered: by what, next)
        return go(step.key.startsWith('ordered_') && def.orders ? { ...s, view: { v: 'orderBy', step: typed } } : withChain(s, typed, { v: 'stmts' }), name);
    });
    return menu;
}

/** An ordered iterator's order: `order_by = age`, "the child with the highest age" (and the rest after it). */
function orderByMenu(s: State, step: ChainStep): Menu
{
    const i = listOfKey(step.key);
    const pick = (value: string, name: string, extra: Partial<Item> = {}): Item => ({
        label: tr('Highest {name}', { name }),
        hint: value,
        sub: true,
        ...extra,
        go: () => go(withChain(s, { ...step, params: [...(step.params ?? []), ['order_by', value]], label: tr('{label} with the highest {name}', { label: step.label, name }) }, { v: 'stmts' }), name)
    });
    // ("the lowest" is the order turned round: `order_by = { value = age multiply = -1 }`)
    const lowest = (value: string, name: string, extra: Partial<Item> = {}): Item => ({
        label: tr('Lowest {name}', { name }),
        hint: value,
        sub: true,
        rank: 2,
        ...extra,
        go: () => go(withChain(s, { ...step, params: [...(step.params ?? []), ['order_by', lowestOrder(value)]], label: tr('{label} with the lowest {name}', { label: step.label, name }) }, { v: 'stmts' }), name)
    });
    return {
        title: tr('{cap} with the highest or lowest…', { cap: cap(step.label) }),
        typeahead: true,
        items: (i?.orders ?? []).flatMap(([v, l]) => [pick(v, l), lowest(v, l)]),
        input: (text) =>
        {
            const low = /^(lowest|-)\s*(.+)$/i.exec(text.trim());
            const name = nameOf(low ? low[2] : text);
            return name ? (low ? lowest(name, name, { label: tr('Use “{name}”, the lowest', { name }), hint: tr('a script value') }) : pick(name, name, { label: tr('Use “{name}”', { name }), hint: tr('a script value') })) : null;
        },
        note: tr('Or type a script value: the highest first (“lowest …” for the lowest)')
    };
}

/** The order turned round, as the game writes it: the value times -1 (`{ value = age multiply = -1 }`). */
export function lowestOrder(value: string): string
{
    return `{ value = ${value} multiply = -1 }`;
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

        items.push({ label: linkLabel(s, l), hint: l.key, sub: true, doc: { kind: 'link', key: l.key }, go: () => go(withChain(s, stepFor(l, s), { v: 'stmts' }), linkLabel(s, l)) });
    }

    if (s.draft.loc.kind === 'effect' && ITERATORS.some((i) => i.effect && i.from.includes(from)))
    {
        items.push({ label: tr('Every…'), sub: true, go: () => go({ ...s, view: { v: 'iters', mode: 'every' } }, tr('Every')) });
        items.push({ label: tr('A random…'), sub: true, go: () => go({ ...s, view: { v: 'iters', mode: 'random' } }, tr('A random')) });

        if (ITERATORS.some((i) => i.effect && i.orders && i.from.includes(from)))
            items.push({ label: tr('The one with the highest…'), sub: true, go: () => go({ ...s, view: { v: 'iters', mode: 'ordered' } }, tr('The highest')) });
    }

    if (s.draft.loc.kind === 'trigger' && ITERATORS.some((i) => i.trigger && i.from.includes(from)))
        items.push({ label: tr('Any of their…'), sub: true, go: () => go({ ...s, view: { v: 'iters', mode: 'any' } }, tr('Any')) });

    return { title: tr('Their…'), items };
}

const VERB: Record<string, string> = { add: tr('Add'), remove: tr('Remove'), set: tr('Set'), do: '' };

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
        doc: statementDoc(d),
        go: () => go(start(s, d), label)
    });

    if (group)
    {
        const g = EFFECT_GROUPS.find((x) => x.id === group)!;
        return { title: `${subject} › ${plainLabel(g.label)}`, items: defs.filter((d) => d.group === group).map((d) => pick(d, d.label)) };
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

            items.push({ label: g.label, key: g.k, sub: true, explain: g.help, go: () => go({ ...s, view: { v: 'stmts', group: g.id } }, plainLabel(g.label)) });
        }
    }

    items.push({ label: tr('Their…'), sub: true, key: 't', title: tr('Someone or something of theirs: liege, faith, title, every child…'), go: () => go({ ...s, view: { v: 'related' } }, tr('Their')) });
    items.push({ label: tr('Other effect…'), sub: true, key: 'o', go: () => go({ ...s, view: { v: 'other' } }, tr('Other effect')) });
    return { title: subject, items };
}

function triggerRoot(s: State): Menu
{
    const loc = s.draft.loc;
    const items: Item[] = [];
    const selfIs = selfName(s) === 'you' ? tr('You (self) are…') : tr('{selfLabel} is…', { selfLabel: selfLabel(s) });
    const selfTitle = s.draft.loc.label ? tr('Inside the block: {selfName}', { selfName: selfName(s) }) : tr('The {scope} this script runs for (this / root at the top)', { scope: s.rootScope ? SCOPE_LABELS[s.rootScope] : 'character' });
    items.push({ label: selfIs, key: 's', sub: true, title: selfTitle, go: () => go({ ...s, view: { v: 'stmts' } }, plainLabel(selfIs)) });

    for (const l of linksFrom(loc.scope, s.rootScope).filter((x) => x.main))
        items.push({ label: tr('{linkLabel} is…', { linkLabel: linkLabel(s, l) }), key: l.k, hint: l.key, sub: true, doc: { kind: 'link', key: l.key }, go: () => go(withChain(s, stepFor(l, s), { v: 'stmts' }), tr('{linkLabel} is', { linkLabel: linkLabel(s, l) })) });

    // (the event's scopes: "Child is…")
    items.push(...targetItems(s, 'character', tr(' is…')));

    for (const t of new Set((s.targets ?? []).map((x) => x.type).filter((x): x is string => !!x && x !== 'character')))
        items.push(...targetItems(s, t as ScopeType, tr(' is…')));

    items.push({ label: tr('Someone else is…'), key: 'o', sub: true, go: () => go({ ...s, view: { v: 'someone', type: 'character' } }, tr('Someone else')) });

    if (ITERATORS.some((i) => i.trigger && i.from.includes(loc.scope)))
        items.push({ label: tr('Any of their…'), key: 'n', sub: true, go: () => go({ ...s, view: { v: 'iters', mode: 'any' } }, tr('Any')) });

    if (linksFrom(loc.scope, s.rootScope).some((l) => l.to !== 'character'))
        items.push({ label: tr('Their faith, culture, title…'), key: 't', sub: true, go: () => go({ ...s, view: { v: 'related' } }, tr('Their')) });

    items.push({ label: tr('Game & world…'), sub: true, key: 'g', go: () => go({ ...s, view: { v: 'global' } }, 'Game & world') });
    items.push({ label: tr('Other condition…'), sub: true, key: 'c', title: tr('Any trigger key the game’s script uses'), go: () => go({ ...s, view: { v: 'other' } }, tr('Other condition')) });
    const title = loc.title ?? (s.title ? tr('Add to: {title}', { title: s.title }) : tr('Add a condition'));
    return { title: s.draft.orNext ? tr('Or…') : title, items, note: tr('Keys: letter = item · type to filter · / search all · ← back · Esc close') };
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
        doc: statementDoc(d),
        go: () => go(start(s, d), d.label)
    });

    if (group)
    {
        const g = TRIGGER_GROUPS.find((x) => x.id === group)!;
        return { title: `${subject} › ${plainLabel(g.label)}`, items: defs.filter((d) => d.group === group).map(pick) };
    }

    const items = defs.filter((d) => d.group === 'main').map(pick);

    for (const g of TRIGGER_GROUPS)
    {
        if (g.id === 'main' || !defs.some((d) => d.group === g.id))
            continue;

        items.push({ label: g.label, key: g.k, sub: true, go: () => go({ ...s, view: { v: 'stmts', group: g.id } }, plainLabel(g.label)) });
    }

    items.push({ label: tr('Their…'), sub: true, key: 'h', title: tr('Someone or something of theirs: liege, faith, title, any child…'), go: () => go({ ...s, view: { v: 'related' } }, tr('Their')) });
    items.push({ label: tr('Other condition…'), sub: true, key: 'q', go: () => go({ ...s, view: { v: 'other' } }, tr('Other condition')) });
    return { title: subject.startsWith('You') ? tr('You are…') : tr('{subject} is…', { subject }), items };
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
        title: tr('Which historical character?'),
        items: [],
        typeahead: true,
        wide: true,
        preview: as === 'param',
        search: async (q) => (await data.search('characters', q)).map(pick),
        note: tr('Type a name, house or id to search')
    };
}

function globalMenu(s: State): Menu
{
    const defs = statementsFor(s.draft.loc.kind as PickKind, null);
    return {
        title: tr('Game & world'),
        items: defs.map((d) => ({ label: d.label, key: d.k, sub: d.params.length > 0, hint: d.script.split(/\s/)[0], doc: statementDoc(d), go: () => go(start({ ...s, chain: [] }, d, []), d.label) }))
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

    // (a link of someone: `root.rite`, `scope:recipient.faith` ("Root’s rite"))
    const of = /^([^.]+)\.(\w+)$/.exec(v);
    const tail = of && LINKS.find((l) => l.key === of[2]);

    if (of && tail)
        return `${possessive(scopeValueLabel(of[1]).replace(/ \(.*\)$/, ''))} ${tail.label.toLowerCase()}`;

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

    const keep: Item = { label: tr('Keep: {nowLabel}', { nowLabel: nowLabel(param, now, data) }), hint: '⏎', go: () => go(answer(s, now), tr('Keep')) };
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
            const m = /^(days|weeks|months|years) = (\d+)$/.exec(v);
            const r = /^(days|weeks|months|years) = \{ *(\d+) +(\d+) *\}$/.exec(v);
            return m ? durationLabel(Number(m[2]), m[1]) : r ? rangeLabel(r[2], r[3], r[1]) : v;
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
    const keep: Item = { label: tr('Keep: {op}{now}', { op: op === '=' ? '' : op + ' ', now }), hint: '⏎', go: () => put(s, `${key} ${op} ${now}`, tr('Keep')) };
    return { ...menu, items: [keep, ...menu.items], wait: keys ? menu.wait : data.keysLoaded() };
}

function paramMenuOf(s: State, data: PickerData): Menu
{
    const p = s.pending!;
    const param = p.def.params[p.step];
    const answerItem = (label: string, value: string, extra: Partial<Item> = {}): Item => ({ label, go: () => go(answer(s, value), label), ...extra });
    const title = param.label;
    const none = param.optional !== undefined ? [answerItem(param.optional, '', { hint: tr('leave out') })] : [];

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
                    return name && !/^-?[\d.]+$/.test(name) ? answerItem(tr('Use “{name}”', { name }), name, { hint: tr('script value') }) : null;
                },
                note: tr('Type a number, or a script value name')
            };
        }
        case 'compare':
            return { title, items: COMPARE_OPTIONS.map((c) => answerItem(c.label, c.op, { key: c.k, hint: c.op, sub: true })) };
        case 'choice':
        {
            // (a choice filling the statement's key (`add_$skill$_skill`): each value is a key of its own, explained; a
            // switch's case (`e.case`, `$value$ = { }`) names a value, no key)
            const keyed = p.def.id !== 'e.case' && (/^[\w$]+/.exec(p.def.script)?.[0] ?? '').includes(`$${param.name}$`);
            return { title, items: [...none, ...param.options.map((o) => answerItem(o.label, o.value, { key: o.k, hint: o.value, sub: p.step < p.def.params.length - 1, doc: keyed ? statementDoc(p.def, { ...p.values, [param.name]: o.value }) : undefined }))] };
        }
        case 'duration':
        {
            const items = [...none, ...param.presets.map(([n, u]) => answerItem(durationLabel(n, u), durationScript(n, u)))];
            // (a written statement's own unit first: ⏎ on a typed number keeps `years = 5` in years, not days)
            const written = /^(days|weeks|months|years)\s*=/.exec(p.now?.[param.name] ?? '')?.[1];
            const units = (['days', 'weeks', 'months', 'years'] as const).slice().sort((a, b) => Number(b === written) - Number(a === written));
            // (a statement whose time the game also takes as a range, `days = { 5 10 }`: trigger_event's delay)
            const between: Item[] = param.range
                ? [{ label: tr('A random time between…'), sub: true, title: tr('days = { 5 10 }: the game picks a time between the two'), go: () => go({ ...s, view: { v: 'durationRange', key: param.name, param: true } }, tr('Between')) }]
                : [];
            return {
                title,
                items: [...items, ...between],
                typeahead: true,
                number: (n) => units.map((u) => answerItem(durationLabel(n, u), durationScript(n, u), { hint: u })),
                note: tr('Type a number: days, weeks, months or years')
            };
        }
        case 'scope':
            return scopeParamMenu(s, param, none, answerItem);
        case 'ref':
            return refParamMenu(s, param, data, none, answerItem);
        case 'name':
        {
            // (all of them: a filter finds any; the active mod's first, also among a filter's matches)
            const list = data.list(param.type);
            const active = data.activeMod()?.toLowerCase();
            const own = (e: RefEntry): boolean => !!active && !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active);
            return {
                title,
                typeahead: true,
                wide: true,
                items: [
                    ...none,
                    ...(modFirst(list, data) ?? []).map((e) => answerItem(e.name, e.name, { hint: own(e) ? (entryHint(e, data) ?? tr('in your mod')) : e.refs ? `${e.refs}×` : undefined, rank: own(e) ? -3 : undefined }))
                ],
                wait: list ? undefined : data.loaded(param.type),
                input: (text) =>
                {
                    const name = nameOf(text).toLowerCase();
                    return name ? answerItem(tr('New: “{name}”', { name }), name, { hint: param.type }) : null;
                },
                note: tr('Type a {type} name — existing ones are listed', { type: param.type })
            };
        }
        case 'text':
        {
            // (values the game writes for this key, or one field of its block, from the key scan; a key filled by a
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
                    return t ? answerItem(tr('Use “{t}”', { t }), /\s/.test(t) ? `"${t}"` : t) : null;
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
        if (scopeInReach(s, v))
            add(v);

    if (param.self)
        add('this');

    // (a script whose root is no character (a doctrine's): root only where its scope fits)
    if (!s.rootScope || s.rootScope === param.to)
        add('root');

    for (const l of linksFrom(from, s.rootScope))
        if (l.to === param.to)
            add(l.key);

    const targets = (s.targets ?? []).filter((t) => (t.type ?? 'character') === param.to);

    for (const t of targets)
        add(t.key);

    for (const sc of savedScopeRows(s, param.to))
        add(sc.key);

    // (written inside the template's own scope switch (`switched`, the holder of "Give a title to someone"), a value
    // relative to `prev` would become `prev.prev …`, which the game refuses (chainType): those are left out)
    const prevBased = (v: string): boolean => v === 'prev' || v.startsWith('prev.');

    if (param.switched)
        values.splice(0, values.length, ...values.filter((v) => !prevBased(v)));

    // (a link and a saved scope of the same name (`host`, a character's host, and `scope:host`, an activity's) read
    // alike: the saved one then says which it is)
    // (a link or root said from the statement's subject: "Your mother’s liege", "Root (you — the one taking the
    // decision)", not a bare "Liege" that leaves open whose)
    const who = p.chain.length ? chainLabel(p.chain) : selfName(s);
    const relative = (v: string): string | undefined =>
    {
        if (v === 'root')
            return rootLabel(s, true);

        if (v === 'this')
            return who === 'you' ? tr('You (yourself)') : tr('{who} (themselves)', { who: cap(who) });

        const link = LINKS.find((l) => l.key === v);
        return link ? cap(`${possessive(who)} ${link.label.toLowerCase()}`) : undefined;
    };
    const labelOf = (v: string): string => targets.find((x) => x.key === v)?.label ?? relative(v) ?? scopeValueLabel(v).replace(/ \(scope:\w+\)$/, '');
    const shortLabels = values.map(labelOf);
    const shown = (v: string, i: number): string => (/^scope:/.test(v) && shortLabels.some((l, j) => j !== i && l === shortLabels[i]) ? `${shortLabels[i]} (${v})` : shortLabels[i]);

    return {
        title: param.label,
        items: [
            ...none,
            ...values.map((v, i) =>
            {
                const t = targets.find((x) => x.key === v);
                return t ? answerItem(shown(v, i), v, { hint: v, title: t.about, doc: scopeValueDoc(v) }) : answerItem(shown(v, i), v, { hint: v, doc: scopeValueDoc(v) });
            }),
            ...(param.to === 'character' ? [{ label: tr('A historical character…'), sub: true, hint: tr('character:…'), go: () => go({ ...s, view: { v: 'character', as: 'param' } }, tr('Historical character')) } as Item] : [])
        ],
        input: (text) =>
        {
            const name = nameOf(text);

            if (!name)
                return null;

            const v = /^(scope:|root|prev|this|liege|primary_|var:)/.test(name) || name.includes('.') ? name : `scope:${name}`;

            // (written through `prev` inside the switch it would be `prev.prev …`: the game refuses that, so this is a
            // refusal with the way round it, not a warning)
            if (param.switched && prevBased(v))
                return { label: tr('{v} cannot be written here: inside the title’s block it would be {written}, and the game does not allow prev after prev. Save that scope first (“Save as…”) and choose the saved one.', { v, written: inPrev(v) }), role: 'info' };

            // (checked against the catalog's links and the saved scopes' types: a warning, not a refusal)
            const warn = chainWarning(s, v, from, param.to);
            const note = warn ? undefined : chainNote(s, v, from);
            return answerItem(tr('Use “{v}”', { v }), v, { hint: warn ? tr('⚠ check') : note ? tr('not checked') : tr('saved scope'), warn, title: warn ?? note });
        },
        note: tr('Space, then a saved scope or a chain (scope:x, liege.primary_spouse)')
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
        return tr('used in your mod');

    const active = data.activeMod()?.toLowerCase();
    const own = !!active && !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active);
    const base = e.display && e.display !== e.name ? e.name : e.refs ? `${e.refs}×` : undefined;

    if (!own)
        return base;

    return `${e.mod!.state === 'added' ? tr('new in your mod') : e.mod!.state === 'same' ? tr('in your mod, as in the game') : tr('changed in your mod')}${base ? ' · ' + base : ''}`;
}

function refItems(param: Extract<ParamDef, { kind: 'ref'; }>, entries: RefEntry[], answerItem: (label: string, value: string, extra?: Partial<Item>) => Item, data?: PickerData): Item[]
{
    const active = data?.activeMod()?.toLowerCase();
    const own = (e: RefEntry): boolean => !!active && !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active);
    return (data ? (modFirst(entries, data) ?? entries) : entries).map((e) =>
        answerItem(e.display && e.display !== e.name ? e.display : e.name, (param.prefix ?? '') + e.name, {
            hint: data ? entryHint(e, data) : e.display && e.display !== e.name ? e.name : e.refs ? `${e.refs}×` : undefined,
            icon: e.icon,
            entry: { type: param.type, name: e.name },
            match: e.name,
            // (the active mod's own come first also among the matches of a filter)
            rank: own(e) ? -3 : undefined
        })
    );
}

/**
 * Entry rows under a header per group (`dlcGroups`: the DLC or mod an entry comes with): the mods' first, the base
 * game, then the DLCs by name; headers are notes (a typed filter lists the matches without them).
 */
function groupByDlc(rows: Item[], groups: Record<string, string>): Item[]
{
    const by = new Map<string, Item[]>();

    for (const r of rows)
    {
        const g = groups[r.match ?? ''] ?? tr('Base game');
        (by.get(g) ?? by.set(g, []).get(g)!).push(r);
    }

    const order = (g: string): number => (g.startsWith('Mod: ') ? 0 : g === tr('Base game') ? 1 : 2);
    return [...by]
        .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
        .flatMap(([g, items]) => [{ label: `${g} · ${items.length}`, role: 'info' as const }, ...items]);
}

/**
 * A menu's entry rows grouped by DLC when that is on (Tab): the rows under their headers once the type's groups are
 * loaded (`wait` till then), the note naming the toggle.
 */
function dlcGrouping(data: PickerData, type: string | undefined, rows: Item[], note: string): { items: Item[]; wait?: Promise<unknown>; note: string; groupable: boolean; }
{
    if (!type || !data.dlcGroups)
        return { items: rows, note, groupable: false };

    const on = !!data.grouped?.();
    const groups = on ? data.dlcGroups(type) : undefined;
    return { items: groups ? groupByDlc(rows, groups) : rows, wait: on && !groups ? data.dlcLoaded?.(type) : undefined, note: tr('{note} · Tab: {mode}', { note, mode: on ? 'one list' : 'group by DLC' }), groupable: true };
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
            note: tr('Type to search')
        };
    }

    const list = data.list(param.type);
    // ("＋ New trait…" and the ones made on the way)
    const fresh = newRefRows(s, data, param.type, { to: 'param', prefix: param.prefix });
    // (grouped by DLC (Tab): once the groups are loaded)
    const dlc = dlcGrouping(data, param.type, refItems(param, list ?? [], answerItem, data), tr('Type to filter — most used first'));
    return {
        title: param.label,
        typeahead: true,
        wide: true,
        groupable: dlc.groupable,
        items: [...fixed, ...fresh.items, ...dlc.items],
        wait: !list ? data.loaded(param.type) : (dlc.wait ?? fresh.wait),
        input: (text) =>
        {
            const name = nameOf(text);

            if (!name)
                return null;

            // (an entry named by a chain or a saved scope, `scope:x.rite`: written as typed, checked as far as LINKS knows the last link)
            const to = param.prefix ? PREFIX_SCOPES[param.prefix.replace(/:$/, '')] : undefined;

            if (to && !name.startsWith(param.prefix!) && (name.startsWith('scope:') || name.includes('.')))
            {
                if (chainFits(name, to))
                    return answerItem(tr('Use “{key}”', { key: name }), name, { hint: tr('as typed') });

                // (a last link LINKS knows that leads elsewhere: a warning; one it does not know: not checked)
                const other = name.includes('.') ? agreedLink(name.slice(name.lastIndexOf('.') + 1))?.to : undefined;

                if (other)
                    return answerItem(tr('Use “{key}”', { key: name }), name, { hint: tr('as typed'), warn: tr('Leads to a {other}, not a {type}', { other: SCOPE_LABELS[other], type: SCOPE_LABELS[to] }) });

                return answerItem(tr('Use “{key}”', { key: name }), name, { hint: tr('as typed, not checked'), title: tr('Its last link does not say it leads to a {type}', { type: SCOPE_LABELS[to] }) });
            }

            return answerItem(tr('Use “{key}”', { key: (param.prefix ?? '') + name }), (param.prefix ?? '') + name, { hint: tr('as typed') });
        },
        note: dlc.note
    };
}

// ---------------------------------------------------------------------------
// After a statement: what next
// ---------------------------------------------------------------------------

function continuation(s: State): Menu
{
    const d = s.draft;
    const loc = d.loc;
    const items: Item[] = [{ label: tr('Done'), role: 'done', hint: '⏎', go: () => ({ finish: true }) }];
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
        if (loc.kind === 'field' && (s.type === 'script_value' || s.type === 'weight') && (!loc.back || loc.formula))
        {
            const weight = s.type === 'weight';
            items.push({
                label: tr('When…'),
                key: 'w',
                sub: true,
                title: weight ? 'Only if a condition holds (modifier = { … <conditions> })' : 'Only if a condition holds (if = { limit = { … } … })',
                go: () =>
                {
                    // (a weight seeded by "Weighted by…" keeps its `base = 1` outside the modifier)
                    const seeded = loc.formula && blockAt(structuredClone(d.top), d.loc.path)[0]?.k === 'base' ? 1 : undefined;
                    const { d: nd, path } = wrapAll(d, (kids) => (weight ? { k: 'modifier', op: '=', kids } : { k: 'if', op: '=', kids: [{ k: 'limit', op: '=', kids: [] }, ...kids] }), seeded);
                    return go(fresh({ ...nd, loc: { path: weight ? path : [...path, 0], kind: 'trigger', scope: loc.scope, label: loc.label, back: { ...loc }, title: tr('When…') } }), tr('When'));
                }
            });
        }

        items.push({ label: tr('And also…'), key: 'a', sub: true, title: loc.kind === 'modifier' ? tr('Another modifier here') : tr('Another setting here'), go: () => go(fresh(d), tr('And also')) });

        // (an iterator's weight, "Weighted by…": back out to the iterator, where its statements go; inside a block being
        // built ("More about this list…") that is the block; the type in force before the weight comes back with it)
        if (loc.back && loc.formula)
        {
            const back = loc.back;
            const type = loc.typeBack ? loc.typeBack.type : s.type;
            items.push({ label: tr('Back out'), key: 'b', title: tr('Continue where this block was added'), go: () => go({ ...fresh({ ...d, loc: back, last: loc.path.slice(0, back.path.length + 1), orNext: false }, { v: 'cont' }), type }, tr('Back')) });
        }

        return { title: tr('What next?'), items, restart: true, note: tr('⏎ Done · ← undo the last step') };
    }

    if (loc.kind === 'effect')
    {
        items.push({
            label: tr('When…'),
            key: 'w',
            sub: true,
            title: here > 1 ? 'Only if a condition holds (if = { limit = { … } … }), for all or a part of what is here' : 'Only if a condition holds (if = { limit = { … } … })',
            go: () => partOr(s, 'when', tr('When'))
        });
        items.push({ label: tr('And also…'), key: 'a', sub: true, title: tr('Another effect here'), go: () => go(fresh(d), tr('And also')) });

        // (right after an if / else_if: what happens otherwise)
        if (last && (last.k === 'if' || last.k === 'else_if'))
            items.push(...otherwiseItems(s, 'effect', lastAt));

        if (wrap)
            items.push({
                label: tr('And also for {label}…', { label: wrap.node.meta!.label }),
                key: 'f',
                sub: true,
                go: () => go(fresh({ ...d, loc: { path: wrap.path, kind: 'effect', scope: wrap.node.meta!.scope, label: wrap.node.meta!.label, back: { ...loc }, title: tr('And also for {label}…', { label: wrap.node.meta!.label }) } }), tr('And also for {label}', { label: wrap.node.meta!.label }))
            });

        const iter = wrap?.node.meta?.wrap === 'iter' ? wrap : undefined;

        if (iter)
            items.push({
                label: tr('Only those who…'),
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

                    return go(fresh({ ...nd, loc: { path: [...iter.path, li], kind: 'trigger', scope: iter.node.meta!.scope, label: iter.node.meta!.label, back: { ...loc }, title: tr('Only if {iterator} is…', { iterator: iter.node.meta!.label.replace(/^(each|a random|the|any) /, 'the ') }) } }), tr('Only those who'));
                }
            });

        items.push({ label: tr('Chance…'), key: 'c', sub: true, title: 'Happens only with a chance (random = { chance = … })', go: () => partOr(s, 'chance', tr('Chance')) });

        // a random list: one of several outcomes, by weight
        if (last?.k === 'random_list')
            items.push({ label: tr('Another outcome…'), key: 'r', sub: true, title: tr('Another outcome of the random list (with its weight)'), go: () => go({ ...s, view: { v: 'weight', add: true } }, tr('Another outcome')) });
        else
            items.push({ label: tr('One of several outcomes…'), key: 'r', sub: true, title: 'random_list = { 50 = { … } 50 = { … } }: this or another outcome, by weight', go: () => partOr(s, 'random', tr('Outcomes')) });

        // a switch: a case per value of a condition
        if (last?.k === 'switch')
            items.push(...switchItems(s, lastAt));
        else
            items.push({ label: tr('Depending on…'), key: 's', sub: true, title: 'switch = { trigger = has_trait brave = { … } craven = { … } }: different effects for each value', go: () => go({ ...s, view: { v: 'switchOn' } }, tr('Depending on')) });

        items.push({ label: tr('Later…'), key: 'l', sub: true, title: tr('An event after a delay (trigger_event)'), go: () => go(start({ ...s, chain: [] }, statementById('e.later')!, []), tr('Later')) });
        const send = findSend(d);

        if (send)
            items.push({
                label: tr('Pass along to the event…'),
                key: 'p',
                sub: true,
                title: tr('Who the names the event uses are (save_scope_as before trigger_event: saved names go along with it)'),
                go: () => go({ ...s, view: { v: 'pass', event: send.event } }, tr('Pass along'))
            });

        items.push({ label: tr('Hidden (no tooltip)'), key: 'h', sub: here > 1, title: 'hidden_effect = { … }: the player does not see it in the tooltip', go: () => partOr(s, 'hidden', tr('Hidden')) });
    }
    else
    {
        items.push({ label: tr('And also…'), key: 'a', sub: true, title: tr('Another condition (all must hold)'), go: () => go(fresh(d), tr('And')) });
        items.push({ label: tr('Or…'), key: 'o', sub: true, title: 'Either the last condition or the next one (OR = { … })', go: () => go(fresh({ ...d, orNext: true }), tr('Or')) });
        items.push({ label: tr('Not (negate the last)'), key: 'n', go: () => go(fresh(negateLast(d), { v: 'cont' }), tr('Not')) });

        if (wrap)
            items.push({
                label: tr('And also for {label}…', { label: wrap.node.meta!.label }),
                key: 'f',
                sub: true,
                go: () => go(fresh({ ...d, loc: { path: wrap.path, kind: 'trigger', scope: wrap.node.meta!.scope, label: wrap.node.meta!.label, back: { ...loc }, title: tr('And also for {label}…', { label: wrap.node.meta!.label }) } }), tr('And also for {label}', { label: wrap.node.meta!.label }))
            });

        // (an `any_` iterator: how many of them must match; the one just built, or the one this place is in)
        const holder = nodeAt(d.top, loc.path);
        const anyPath = wrap && /^any_/.test(wrap.node.k) ? wrap.path : holder && /^any_/.test(holder.k) ? loc.path : undefined;

        if (anyPath)
        {
            const who = (wrap && /^any_/.test(wrap.node.k) ? wrap.node : holder)?.meta?.label ?? tr('any of them');
            items.push({ label: tr('How many of them…'), key: 'm', sub: true, title: tr('Not just {who}: count >= 2 / count = all / percent >= 0.5 — how many of them must match', { who }), go: () => go({ ...s, view: { v: 'count', path: anyPath } }, tr('How many')) });
        }

        items.push({
            label: tr('Only when…'),
            key: 'w',
            sub: true,
            title: 'trigger_if = { limit = { … } … }: checked only when another condition holds (else it counts as true)',
            go: () => partOr(s, 'trigger_if', tr('Only when'))
        });

        if (last && (last.k === 'trigger_if' || last.k === 'trigger_else_if'))
            items.push(...otherwiseItems(s, 'trigger', lastAt));

        if (here > 1)
            items.push({ label: tr('At least some of these…'), key: 'c', sub: true, title: 'calc_true_if = { amount >= 2 … }: how many of the conditions must hold', go: () => partOr(s, 'calc', tr('At least some')) });
    }

    if (loc.back)
    {
        const back = loc.back;
        const to = loc.backTo;
        items.push({
            label: to ? to.label : back.kind === 'effect' && loc.kind === 'trigger' ? tr('Back to the effects') : tr('Back out'),
            key: 'b',
            sub: !!to,
            title: to ? tr('On to what happens then') : tr('Continue where this block was added'),
            go: () => go(fresh({ ...d, loc: back, last: loc.path.slice(0, back.path.length + 1), orNext: false }, to ? { v: 'root' } : { v: 'cont' }), to ? plainLabel(to.label) : 'Back')
        });
    }

    // (naming someone: only narrowing who it is)
    const shown = s.goal && loc.kind === 'effect' ? items.filter((i) => i.role === 'done' || i.label === tr('Only those who…') || i.key === 'b') : items;

    // (a written if / else chain's member changed on its own: never wrapped apart from the rest of the chain, and with an
    // else after it nothing goes between them; the script editor changes the chain as a whole)
    if (s.bound && !loc.path.length)
    {
        const wraps = [tr('When…'), tr('Chance…'), tr('One of several outcomes…'), tr('Hidden (no tooltip)')];
        const after = [tr('And also…'), tr('Otherwise…'), tr('Depending on…'), tr('Later…'), tr('Pass along to the event…')];
        const kept = shown.filter((i) => !wraps.includes(i.label) && !(s.bound === 'elseAfter' && after.includes(i.label)));
        return { title: tr('What next?'), items: kept, restart: true, note: s.bound === 'else' ? tr('Part of an if / else chain: to wrap it, change the chain in the script editor (Shift+Enter)') : tr('An “else” follows it: nothing goes between them — the script editor changes the chain as a whole (Shift+Enter)') };
    }

    return { title: tr('What next?'), items: shown, restart: true, note: tr('⏎ Done · Ctrl+⏎ Done from anywhere · ← undo the last step') };
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

/**
 * A new block at the end of the place (`if`, `random`, `random_list` …), the picker inside it at `inner` (a path in the
 * block: an `if`'s limit, a list's first outcome), with the place it goes to after that (`loc2`).
 */
function openNew(s: State, node: SNode, inner: number[], loc2: (path: number[], block: number[], back: Loc) => Loc, crumb: string): Next
{
    const d = cloneDraft(s.draft);
    const block = blockAt(d.top, d.loc.path);
    block.push(node);
    const path = [...d.loc.path, block.length - 1];
    return go({ ...s, draft: { ...d, last: path, loc: loc2([...path, ...inner], path, { ...s.draft.loc }) }, chain: [], pending: undefined, view: { v: 'root' } }, crumb);
}

/** An empty `if` at the end of the place: its conditions first, then ("Then…") its effects inside it, as "Otherwise, when…" does. */
function startWhen(s: State): Next
{
    const loc = s.draft.loc;
    return openNew(s, { k: 'if', op: '=', kids: [{ k: 'limit', op: '=', kids: [] }] }, [0], (at, block, back) => ({ path: at, kind: 'trigger', scope: loc.scope, label: loc.label, back: { path: block, kind: 'effect', scope: loc.scope, label: loc.label, back, title: tr('When … — then:') }, backTo: { view: 'root', label: tr('Then…') }, title: tr('When…') }), tr('When'));
}

/** An empty `hidden_effect` at the end of the place, its effects inside it. */
function startHidden(s: State): Next
{
    const loc = s.draft.loc;
    return openNew(s, { k: 'hidden_effect', op: '=', kids: [] }, [], (at, _block, back) => ({ path: at, kind: 'effect', scope: loc.scope, label: loc.label, back, title: tr('Hidden: what happens') }), tr('Hidden'));
}

/**
 * "Other effect…" › if, random, random_list, hidden_effect, switch: the steps of the root's "If, chance, outcomes…" (the
 * condition, chance or weight first, the effects inside), not a value step offering whole blocks of the game's script.
 */
function flowKey(s: State, key: string): Next | undefined
{
    if (s.draft.loc.kind !== 'effect')
        return undefined;

    switch (key)
    {
        case 'if':
            return startWhen(s);
        case 'hidden_effect':
            return startHidden(s);
        case 'random':
            return go({ ...s, view: { v: 'flowNew', what: 'chance' } }, tr('Chance'));
        case 'random_list':
            return go({ ...s, view: { v: 'flowNew', what: 'random' } }, tr('Outcomes'));
        case 'switch':
            return go({ ...s, view: { v: 'switchOn' } }, tr('Depending on'));
    }

    return undefined;
}

/** The effect root's "If, chance, outcomes…": a block started empty, its conditions (or chance, weight) first, then its effects. */
function flowRootMenu(s: State): Menu
{
    return {
        title: tr('If, chance, outcomes…'),
        items: [
            {
                label: tr('When…'),
                key: 'w',
                sub: true,
                title: 'if = { limit = { … } … }: the effects only when the conditions hold',
                go: () => startWhen(s)
            },
            { label: tr('Chance…'), key: 'c', sub: true, title: 'random = { chance = … }: the effects only with a chance', go: () => go({ ...s, view: { v: 'flowNew', what: 'chance' } }, tr('Chance')) },
            { label: tr('One of several outcomes…'), key: 'r', sub: true, title: 'random_list = { 50 = { … } 50 = { … } }: one outcome of several, by weight', go: () => go({ ...s, view: { v: 'flowNew', what: 'random' } }, tr('Outcomes')) },
            { label: tr('Depending on…'), key: 's', sub: true, title: 'switch = { trigger = has_trait brave = { … } craven = { … } }: different effects for each value', go: () => go({ ...s, view: { v: 'switchOn' } }, tr('Depending on')) },
            {
                label: tr('Hidden (no tooltip)…'),
                key: 'h',
                sub: true,
                title: 'hidden_effect = { … }: the player does not see these effects in the tooltip',
                go: () => startHidden(s)
            }
        ],
        note: tr('The condition, chance or weight first, then the effects inside it')
    };
}

/** "Chance…" / "One of several outcomes…" from the root: the chance or the first outcome's weight, then its effects. */
function flowNewMenu(s: State, what: 'chance' | 'random'): Menu
{
    const loc = s.draft.loc;
    const inside = (path: number[], back: Loc, title: string): Loc => ({ path, kind: 'effect', scope: loc.scope, label: loc.label, back, title });
    const pick = (n: number): Item =>
        what === 'chance' ?
            { label: `${n}%`, go: () => openNew(s, { k: 'random', op: '=', kids: [{ k: 'chance', op: '=', v: String(n) }] }, [], (at, _block, back) => inside(at, back, tr('By chance ({n}%): what happens', { n })), `${n}%`) } :
            { label: tr('Weight {n}', { n }), go: () => openNew(s, { k: 'random_list', op: '=', kids: [{ k: String(n), op: '=', kids: [] }] }, [0], (at, _block, back) => inside(at, back, tr('Outcome (weight {n}): what happens', { n })), tr('Weight {n}', { n })) };
    return what === 'chance' ?
        { title: tr('How likely?'), items: [10, 20, 25, 33, 50, 66, 75, 90].map(pick), typeahead: true, number: (n) => (n > 0 && n <= 100 ? [{ ...pick(n), hint: '⏎' }] : []), note: tr('Type a percentage') } :
        { title: tr('The first outcome — how likely (its weight)?'), items: [10, 25, 50, 75, 100].map(pick), typeahead: true, number: (n) => (n > 0 ? [{ ...pick(n), hint: '⏎' }] : []), note: tr('Weights are relative: 50 and 50 is half and half — type a number; “Another outcome…” adds the next') };
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
            return go(fresh({ ...nd, loc: { path: [...path, 0], kind: 'trigger', scope: loc.scope, label: loc.label, back: { ...loc }, title: tr('When…') } }), crumb);
        }
        case 'trigger_if':
        {
            const { d: nd, path } = wrapAll(d, (kids) => ({ k: 'trigger_if', op: '=', kids: [{ k: 'limit', op: '=', kids: [] }, ...kids] }), from);
            return go(fresh({ ...nd, loc: { path: [...path, 0], kind: 'trigger', scope: loc.scope, label: loc.label, back: { ...loc }, title: tr('Only when…') } }), crumb);
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
        when: tr('Only if a condition holds — for which part?'),
        trigger_if: tr('Checked only when another condition holds — which part?'),
        chance: tr('By chance — which part?'),
        hidden: tr('Hidden — which part?'),
        random: tr('One outcome of several — which part is this outcome?'),
        calc: tr('Which conditions count?')
    };
    const items: Item[] = [{ label: tr('Everything here ({n})', { n }), key: 'e', hint: '⏎', go: () => partDo(s, action, first, tr('All')) }];

    for (const i of partStarts(s.draft))
        items.push({ label: i === block.length - 1 ? tr('Only the last: {lineOf}', { lineOf: lineOf(block[i]) }) : tr('From “{lineOf}” on ({more})', { lineOf: lineOf(block[i]), more: block.length - i }), title: printScript(block.slice(i)), go: () => partDo(s, action, i, i === block.length - 1 ? tr('The last') : tr('The last {more}', { more: block.length - i })) });

    return { title: what[action], items, wide: true, preview: true, note: tr('⏎ everything · or from one of them on') };
}

function chanceMenu(s: State, from?: number, path?: number[]): Menu
{
    // (`path`: a written `random`, its chance changed)
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
    return { title: tr('How likely?'), items: [10, 20, 25, 33, 50, 66, 75, 90].map(pick), typeahead: true, preview: true, number: (n) => (n > 0 && n <= 100 ? [{ ...pick(n), hint: '⏎' }] : []), note: tr('Type a percentage') };
}

/**
 * A random list's outcome weight: what is built (from `from` on) becomes its first outcome (`random_list = { 50 = { … } }`),
 * or (`add`) the list written last at the place gets another, empty one, whose effects follow.
 */
function weightMenu(s: State, from?: number, add?: boolean): Menu
{
    const d0 = s.draft;
    const loc = d0.loc;
    const pick = (n: number): Item => ({
        label: tr('Weight {n}', { n }),
        go: () =>
        {
            if (!add)
                return go({ ...s, draft: wrapAll(d0, (kids) => ({ k: 'random_list', op: '=', kids: [{ k: String(n), op: '=', kids }] }), from).d, view: { v: 'cont' } }, tr('Weight {n}', { n }));

            // another outcome: its effects inside it, "Back out" to the list's place
            const d = cloneDraft(d0);
            const block = blockAt(d.top, loc.path);
            const list = block[block.length - 1];
            list.kids = [...(list.kids ?? []), { k: String(n), op: '=', kids: [] }];
            const path = [...loc.path, block.length - 1, list.kids.length - 1];
            return go({ ...s, draft: { ...d, last: path, loc: { path, kind: 'effect', scope: loc.scope, label: loc.label, back: { ...loc }, title: tr('Outcome (weight {n}): what happens', { n }) } }, chain: [], pending: undefined, view: { v: 'root' } }, tr('Weight {n}', { n }));
        }
    });
    return {
        title: add ? tr('Another outcome — how likely (its weight)?') : tr('This outcome — how likely (its weight)?'),
        items: [10, 25, 50, 75, 100].map(pick),
        typeahead: true,
        preview: !add,
        number: (n) => (n > 0 ? [{ ...pick(n), hint: '⏎' }] : []),
        note: tr('Weights are relative: 50 and 50 is half and half — type a number')
    };
}

/** `calc_true_if = { amount >= N … }`: how many of the conditions from `from` on must hold. */
function calcMenu(s: State, from: number): Menu
{
    const n = blockAt(structuredClone(s.draft.top), s.draft.loc.path).length - from;
    const pick = (k: number): Item => ({
        label: tr('At least {k} of the {n}', { k, n }),
        go: () => go({ ...s, draft: wrapAll(s.draft, (kids) => ({ k: 'calc_true_if', op: '=', kids: [{ k: 'amount', op: '>=', v: String(k) }, ...kids] }), from).d, view: { v: 'cont' } }, tr('At least {k}', { k }))
    });
    const presets = Array.from({ length: Math.max(1, n - 1) }, (_x, i) => i + 1);
    return { title: tr('How many must hold?'), items: presets.map(pick), typeahead: true, preview: true, number: (k) => (k > 0 ? [{ ...pick(k), hint: '⏎' }] : []), note: tr('Type a number') };
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
        title: tr('How many must match?'),
        items: [
            set('count', '>=', '2', tr('At least 2')),
            set('count', '>=', '3', tr('At least 3')),
            set('count', '>=', '5', tr('At least 5')),
            set('count', '=', 'all', tr('All of them')),
            set('count', '=', '0', tr('None of them')),
            set('percent', '>=', '0.5', tr('At least half')),
            set('percent', '>', '0.5', tr('Most of them'))
        ],
        typeahead: true,
        preview: true,
        number: (k) => (k >= 0 && Number.isInteger(k) ? [set('count', '>=', String(k), tr('At least {k}', { k }), { hint: '⏎' })] : []),
        note: tr('Type a number: at least that many')
    };
}

/**
 * Right after an if / else_if (a trigger_if): what happens (or holds) otherwise. "Otherwise, when…" makes an `else_if`
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
            label: tr('Otherwise, when…'),
            key: 'i',
            sub: true,
            title: effect ? 'else_if = { limit = { … } … }: when the conditions before failed and these hold' : 'trigger_else_if = { limit = { … } … }',
            go: () =>
            {
                const { d, path } = add(effect ? 'else_if' : 'trigger_else_if', true);
                const body: Loc = { path, kind, scope: loc.scope, label: loc.label, back: { ...loc }, title: effect ? tr('Otherwise, when … — then:') : tr('Otherwise, when … — then check:') };
                return go({ ...s, draft: { ...d, loc: { path: [...path, 0], kind: 'trigger', scope: loc.scope, label: loc.label, back: body, backTo: { view: 'root', label: tr('Then…') }, title: tr('Otherwise, when…') } }, chain: [], pending: undefined, view: { v: 'root' } }, tr('Otherwise, when'));
            }
        },
        {
            label: tr('Otherwise…'),
            key: 'e',
            sub: true,
            title: effect ? 'else = { … }: when none of the conditions before hold' : 'trigger_else = { … }',
            go: () =>
            {
                const { d, path } = add(effect ? 'else' : 'trigger_else', false);
                return go({ ...s, draft: { ...d, loc: { path, kind, scope: loc.scope, label: loc.label, back: { ...loc }, title: tr('Otherwise…') } }, chain: [], pending: undefined, view: { v: 'root' } }, tr('Otherwise'));
            }
        }
    ];
}

/**
 * The catalog conditions a switch can go by (`switch = { trigger = has_trait … }`): one value, written `key = value` (a
 * trait, a government, a flag …), for the place's scope; the most used first.
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
    const param = { ...p0, label: tr('{label}: which case?', { label: def.label }), ...(p0.kind === 'text' && p0.usage ? { usage: { key: def.script.split(' ')[0] } } : {}) } as ParamDef;
    const caseDef: StatementDef = { id: 'e.case', kind: 'effect', group: 'do', label: tr('Case: {label}', { label: def.label }), scopes: 'any', script: `$${param.name}$ = { }`, params: [param] };
    const d: Draft = { ...s.draft, loc: { path: switchAt, kind: 'effect', scope: loc.scope, label: loc.label, back: loc } };
    return { ...s, draft: d, chain: [], pending: { def: caseDef, chain: [], values: {}, step: 0, enter: { kind: 'effect', scope: loc.scope, label: loc.label, back: { ...loc }, title: tr('In this case:') } }, view: { v: 'param' } };
}

/** "Depending on…": the condition whose values the cases are; the switch is written, its first case asked. */
function switchMenu(s: State, data: PickerData): Menu
{
    const loc = s.draft.loc;
    const scanned = data.keys('trigger');
    const count = (key: string): number => scanned?.find((k) => k.key === key)?.count ?? 0;
    const defs = switchable(loc.scope).sort((a, b) => count(b.script.split(' ')[0]) - count(a.script.split(' ')[0]));
    return {
        title: tr('Depending on…'),
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
                doc: { kind: 'trigger', key },
                go: () =>
                {
                    const d = cloneDraft(s.draft);
                    const block = blockAt(d.top, loc.path);
                    block.push({ k: 'switch', op: '=', kids: [{ k: 'trigger', op: '=', v: key }] });
                    return go(caseStart({ ...s, draft: { ...d, last: [...loc.path, block.length - 1] } }, [...loc.path, block.length - 1], def), def.label);
                }
            };
        }),
        note: tr('A condition with one value: a case for each value')
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
        items.push({ label: tr('Another case…'), key: 's', sub: true, title: tr('Another value of {key}, with its effects', { key }), go: () => go(caseStart(s, path, def), tr('Another case')) });

    if (!sw.kids?.some((k) => k.k === 'fallback'))
        items.push({
            label: tr('In no case (fallback)…'),
            key: 'e',
            sub: true,
            title: 'fallback = { … }: when none of the cases fits',
            go: () =>
            {
                const d = cloneDraft(s.draft);
                const node = nodeAt(d.top, path)!;
                node.kids = [...(node.kids ?? []), { k: 'fallback', op: '=', kids: [] }];
                const fp = [...path, node.kids.length - 1];
                return go({ ...s, draft: { ...d, last: fp, loc: { path: fp, kind: 'effect', scope: loc.scope, label: loc.label, back: { ...loc }, title: tr('In no case:') } }, chain: [], pending: undefined, view: { v: 'root' } }, tr('Fallback'));
            }
        });

    return items;
}

// ---------------------------------------------------------------------------
// Other effect / condition: any key the loaded script uses
// ---------------------------------------------------------------------------

/** Effect / trigger keys whose value is a text key, and the ending of a new one's key (newTextMenu). */
const TEXT_KEY_VALUES: Record<string, string> = { custom_tooltip: '_tt' };

function shapeHint(k: ScriptKeyInfo): string
{
    // (a text key looks like a scope link to the key scan)
    if (TEXT_KEY_VALUES[k.key] !== undefined)
        return tr('text');

    const shapes = Object.entries(k.shapes).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
    const top = shapes[0]?.[0];
    const words: Record<string, string> = { bool: 'yes/no', number: 'number', compare: '< > value', scope: 'someone', link: 'x:y', name: 'name', block: '{ … }' };
    return words[top ?? ''] ?? '';
}

/**
 * The conditions the game writes in this block (PickRequest.common: a law's `can_pass` (has_realm_law,
 * government_has_flag …)), most used first: a catalog statement for the subject's scope goes step by step, any other key
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
            return { label, hint: k, match: k, sub: true, doc: { kind: 'modifier', key: k }, go: () => go({ ...s, view: { v: 'modValue', key: k } }, label) };
        });
        items.push({ label: tr('All modifiers…'), sub: true, title: tr('Every modifier, by group (the root menu)'), go: () => go({ ...s, view: { v: 'root' } }, tr('All')) });
        return {
            title: tr('Used here in the game{title}', { title: s.title ? `: ${s.title}` : '' }),
            items,
            wait: list ? undefined : data.modifiersLoaded(),
            note: s.about ? s.about : tr('The modifiers the game’s definitions put in this block, most used first · ← all modifiers')
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
            return { label: def.label, hint: k, sub: def.params.length > 0, match: `${k} ${def.words ?? ''}`, doc: statementDoc(def), go: () => go(start(s, def), def.label) };

        return { label: humanize(k), hint: k, sub: true, match: k, doc: { kind: 'trigger', key: k }, go: () => go({ ...s, view: { v: 'otherValue', key: info } }, k) };
    });
    items.push({ label: tr('All conditions…'), sub: true, title: tr('Every condition, by subject (the root menu)'), go: () => go({ ...s, view: { v: 'root' } }, tr('All')) });
    return {
        title: tr('Used here in the game{title}', { title: s.title ? `: ${s.title}` : '' }),
        items,
        wait: !scanned ? data.keysLoaded() : undefined,
        note: s.about ? s.about : tr('The conditions the game’s definitions write in this block, most used first · ← all conditions')
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

/** The documented scopes (the game's names) of each effect and trigger the docs give scopes for, by the facts applied. */
let docScopes: { facts: ReturnType<typeof scriptFacts>; map: Map<string, string[]>; } | undefined;

/** The scopes the game documents an effect / trigger for; undefined when its docs name none (then it is not judged). */
function documentedScopes(kind: PickKind, key: string): string[] | undefined
{
    const facts = scriptFacts();

    if (docScopes?.facts !== facts)
        docScopes = { facts, map: new Map((facts?.statements ?? []).map((x) => [`${x.kind}:${x.key}`, x.scope])) };

    const scopes = docScopes.map.get(`${kind}:${key}`);
    return scopes?.length ? scopes : undefined;
}

/** Every effect / trigger key the game documents: the explained ones and those with documented scopes, by name. */
function documentedKeys(kind: PickKind, labels: Record<string, [string, string]> | undefined): string[]
{
    const keys = new Set(Object.keys(labels ?? {}));

    for (const x of scriptFacts()?.statements ?? [])
        if (x.kind === kind)
            keys.add(x.key);

    return [...keys].sort();
}

function otherMenu(s: State, data: PickerData): Menu
{
    const scanned = data.keys(s.draft.loc.kind as PickKind);
    const word = s.draft.loc.kind === 'effect' ? 'effect' : 'condition';
    // (the scan is made once per index build: scripted effects / triggers made since, the mod's first, join it)
    const type = s.draft.loc.kind === 'effect' ? 'scripted_effects' : 'scripted_triggers';
    const defined = data.list(type);
    const active = data.activeMod()?.toLowerCase();
    const own = (e: RefEntry): boolean => !!active && !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active);
    const known = new Set((scanned ?? []).map((k) => k.key));
    const fresh = (defined ?? []).filter((e) => !known.has(e.name)).sort((a, b) => Number(own(b)) - Number(own(a)));
    const kind = s.draft.loc.kind as PickKind;
    // (a key the game documents for other scopes only would be refused here: left out; where the place's scope is a
    // guess nothing is left out, the guess could be wrong)
    const here = subjectGuessed(s) ? undefined : gameScopeName(subjectScope(s));
    const fits = (key: string): boolean =>
    {
        const scopes = here ? documentedScopes(kind, key) : undefined;
        return !scopes || scopes.includes(here!);
    };
    const keys = scanned && [...fresh.filter(own).map((e): ScriptKeyInfo => ({ key: e.name, count: 0, shapes: {}, values: [], scripted: true })), ...scanned.filter((k) => k.scripted || fits(k.key)), ...fresh.filter((e) => !own(e)).map((e): ScriptKeyInfo => ({ key: e.name, count: 0, shapes: {}, values: [], scripted: true }))];
    // (keys the game documents that the loaded script never writes: offered too, after the used ones, so a modder
    // finds what exists, not only what vanilla happens to use)
    const labels = data.docLabels?.(kind);
    const unused = keys ? documentedKeys(kind, labels).filter((k) => !known.has(k) && fits(k)) : [];
    return {
        title: tr('Other {word}', { word }),
        typeahead: true,
        wide: true,
        items: keys
            ? [
                ...keys.map((k): Item => ({ label: k.key, hint: k.count ? `${k.count}× · ${shapeHint(k)}${k.scripted ? ' · scripted' : ''}` : tr('scripted · new'), sub: true, doc: k.scripted ? undefined : { kind, key: k.key }, go: () => flowKey(s, k.key) ?? go({ ...s, view: keyView(k) }, k.key) })),
                ...unused.map((key): Item => ({ label: key, hint: tr('documented · unused'), sub: true, rank: 2, doc: { kind, key }, go: () => go({ ...s, view: { v: 'otherValue', key: { key, count: 0, shapes: {}, values: [] } } }, key) }))
            ]
            : [{ label: tr('Collecting the keys the game uses…'), role: 'info' }],
        wait: !scanned ? data.keysLoaded() : !defined ? data.loaded(type) : data.docLabels && !labels ? data.docLabelsLoaded?.(kind) : undefined,
        input: (text) =>
        {
            const key = nameOf(text);
            return key ? { label: tr('Use “{key}”', { key }), sub: true, go: () => go({ ...s, view: { v: 'otherValue', key: { key, count: 0, shapes: {}, values: [] } } }, key) } : null;
        },
        note: tr('Every {word} key the game’s script uses, most used first; then those the game documents but never uses', { word })
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
 * least two of them say it and none says another; undefined when the values are no scopes or disagree. The values were
 * written wherever the game wrote them, not in the scope the picker is open in, so they are typed without it
 * (chainType `free`: root, saved scopes, database prefixes, and a link by its key when all its entries agree).
 */
export function valueScope(s: State, info: ScriptKeyInfo): ScopeType | undefined
{
    const types = new Set<ScopeType>();
    let known = 0;

    for (const [v] of info.values)
    {
        if (/^[<>=!]/.test(v) || !SCOPE_VALUE.test(v) || (!v.includes(':') && !v.includes('.') && !LINKS.some((l) => l.key === v)))
            continue;

        const t = chainType(s, v, 'character', true).type;

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

    // (a key whose value is a text key (`custom_tooltip = my_event_tt`): a new text first, the game's keys after it)
    const suffix = TEXT_KEY_VALUES[info.key];

    if (suffix !== undefined)
        items.push({ label: tr('Write a new text…'), key: 'w', sub: true, rank: -6, title: tr('Type the text the game shows; it is written as a text key of this entry in your mod'), go: () => go({ ...s, view: { v: 'newText', suffix, reuse: false, title: info.key, then: (st, k2, label) => writeOther(st, info.key, k2, label) } }, tr('New text')) });

    // (a statement of the catalog for the key: its steps ("Trigger an event" asks when, offers "Pass along…"))
    const kind = s.draft.loc.kind as PickKind;
    const def = STATEMENTS.find((d) => d.kind === kind && !d.hidden && !d.noBuild && new RegExp(`^${info.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`).test(d.script));

    if (def)
        items.push({ label: `${def.label}…`, sub: def.params.length > 0, hint: tr('step by step'), rank: -5, doc: statementDoc(def), go: () => go(start(s, def), def.label) });

    // (its value names an entry: the entries, the active mod's first; own ones also first among a filter's matches)
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
            items.push({ label: e.display && e.display !== e.name ? e.display : e.name, hint: entryHint(e, data), match: e.name, icon: e.icon, entry: { type: info.refType, name: e.name }, rank: own(e) ? -3 : undefined, go: () => finish(e.name, e.name) });
        }
    }

    // (a block of statements the game wrote somewhere (`{ limit = { … } add_trait = … }`) is no value to pick: the
    // owner found them baffling; a list of plain values (`{ 1 2 }`) is)
    const statements = (v: string): boolean => /^\{/.test(v) && v.includes('=');
    const before = items.length;

    for (const [v, n] of info.values)
        if (!statements(v))
            add(v, `${n}×`);

    for (const [v, n] of info.examples ?? [])
        if (!statements(v))
            add(v, `${n}×`);

    if (info.fields?.length && items.length === before)
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

            // (a typed scope: checked against the type the game's values for the key have; a warning, not a refusal)
            const want = valueScope(s, info);
            const warn = want && SCOPE_VALUE.test(t) ? chainWarning(s, t, subjectScope(s), want) : undefined;
            const note = want && !warn && SCOPE_VALUE.test(t) ? chainNote(s, t, subjectScope(s)) : undefined;
            return { label: tr('Use “{t}”', { t }), hint: warn ? tr('⚠ check') : note ? tr('not checked') : '⏎', warn, title: warn ?? note, go: () => finish(text, t) };
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
    [tr('AND'), tr('All of these')],
    [tr('OR'), tr('Any of these')],
    [tr('NOR'), tr('None of these')],
    [tr('NAND'), tr('Not all of these')],
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
    const def = m && (ITERATORS.find((i) => i.list === m[2]) ?? scriptedIter(m[2]));
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

    // (a relation's kind names the items: each friend)
    const naming = it.def.params?.find((p) => p.names)?.key;
    const type = naming ? n.kids?.find((c) => c.k === naming)?.v : undefined;
    const what = type ? humanize(type).toLowerCase() : it.def.label;
    return it.mode === 'every' ? tr('each {what}', { what }) : it.mode === 'random' ? tr('a random {what}', { what }) : it.mode === 'any' ? tr('any {what}', { what }) : tr('the {what}', { what });
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

/** A written block the picker can change (keepsAsWritten: comments inside are read past, the Change path keeps them). */
function writtenBlockNode(text: string): SNode | undefined
{
    if (!keepsAsWritten(text))
        return undefined;

    const nodes = parseSnippet(text);
    return nodes.length === 1 && nodes[0].kids && nodes[0].op === '=' ? nodes[0] : undefined;
}

/** The states changing a written block opens with: its head menu beside the root (random lists, switches: "What next?"). */
function blockStart(root: State, n: SNode, kind: Mode): { state: State; crumb?: string; }[]
{
    const h = headKind(n);
    const scope = root.draft.loc.scope;

    if (!h)
        return [{ state: root }, { state: { ...root, view: { v: 'kblock', key: n.k, fields: kfieldsOf(n) } }, crumb: n.k }];

    const draft: Draft = { top: [loadNode(n, scope)], loc: { path: [], kind, scope, label: root.draft.loc.label }, last: [0] };
    return [{ state: root }, { state: { ...root, draft, view: h === 'list' ? { v: 'cont' } : { v: 'head' } }, crumb: tr('Change {k}', { k: n.k }) }];
}

/** Changing the written block (the draft's first statement): what it is, then "What next?" as after building one. */
function headMenu(s: State, data: PickerData): Menu
{
    const d = s.draft;
    const n = d.top[0];
    const kind = headKind(n);
    const loc = d.loc;
    const items: Item[] = [{ label: tr('Keep it as it is'), hint: '⏎', go: () => ({ finish: true }) }];
    /** the draft with the block replaced (or by several statements: unwrapped), then "What next?" */
    const set = (nodes: SNode[], crumb: string): Next => go({ ...s, draft: { ...d, top: nodes, last: [nodes.length - 1] }, view: { v: 'cont' } }, crumb);
    const inside = (k: Mode, title: string, path: number[] = [0], extra: Partial<Loc> = {}): Item => ({
        label: title,
        key: 'a',
        sub: true,
        title: tr('Another statement inside it'),
        go: () => go({ ...s, draft: { ...d, loc: { path, kind: k, scope: n.meta?.scope ?? loc.scope, label: n.meta?.label ?? loc.label, back: { ...loc }, title, ...extra } }, view: { v: 'root' } }, plainLabel(title))
    });
    const body = (n.kids ?? []).filter((c) => c.k !== 'limit' && c.k !== 'chance');

    switch (kind)
    {
        case 'logic':
            for (const [k, label] of LOGIC_KEYS)
                items.push({ label: `${label} (${k})`, hint: k === n.k ? 'now' : undefined, go: () => set([{ ...n, k }], label) });

            items.push({ label: tr('Just the conditions (without it)'), key: 'j', title: tr('The conditions inside, each on its own'), go: () => set(n.kids ?? [], 'Unwrapped') });
            items.push(inside('trigger', tr('Another condition inside…')));
            break;
        case 'if':
        {
            const cond = /^trigger_/.test(n.k);
            const li = (n.kids ?? []).findIndex((c) => c.k === 'limit');

            if (n.k !== 'else' && n.k !== 'trigger_else')
                items.push({
                    label: tr('Another condition…'),
                    key: 'c',
                    sub: true,
                    title: tr('Into its limit (all must hold)'),
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

                        return go({ ...s, draft: { ...nd, loc: { path: [0, at], kind: 'trigger', scope: loc.scope, label: loc.label, back: { ...loc }, title: tr('When…') } }, view: { v: 'root' } }, tr('Another condition'));
                    }
                });

            items.push(inside(cond ? 'trigger' : loc.kind, cond ? tr('Another condition inside…') : loc.kind === 'field' ? tr('Another part inside…') : tr('Another effect inside…')));

            // (not with an else after it: that else would follow what was inside)
            if (s.bound !== 'elseAfter')
                items.push({ label: tr('Always — without its conditions'), key: 'w', title: tr('What is inside, without the if'), go: () => set(body, 'Always') });

            break;
        }
        case 'random':
        {
            const chance = n.kids?.find((c) => c.k === 'chance')?.v ?? '?';
            items.push({ label: tr('Another chance (now {chance}%)…', { chance }), key: 'c', sub: true, go: () => go({ ...s, view: { v: 'chance', path: [0] } }, tr('Chance')) });
            items.push(inside('effect', tr('Another effect inside…')));
            items.push({ label: tr('Always — not by chance'), key: 'w', go: () => set(body, 'Always') });
            break;
        }
        case 'hidden':
            items.push(inside('effect', tr('Another effect inside…')));
            items.push({ label: tr('Shown in the tooltip (without it)'), key: 's', go: () => set(n.kids ?? [], 'Shown') });
            break;
        case 'iter':
        {
            const it = iterOf(n.k)!;
            items.push({ label: tr('Another list…'), key: 'l', sub: true, title: tr('The same, over another list (children → vassals …)'), go: () => go({ ...s, view: { v: 'iterSet', what: 'list' } }, tr('Another list')) });

            if (it.mode !== 'any')
                items.push({ label: tr('Every / a random / the highest instead…'), key: 'm', sub: true, go: () => go({ ...s, view: { v: 'iterSet', what: 'mode' } }, tr('Instead')) });

            // (its parameters: a relation's kind, a pool character's province …)
            (it.def.params ?? []).forEach((p, pi) => items.push({ label: `${p.label.replace('?', '')}…`, key: pi === 0 ? 't' : undefined, sub: true, go: () => go({ ...s, view: { v: 'iterSet', what: 'param', i: pi } }, p.label.replace('?', '')) }));

            if (it.mode === 'ordered')
                items.push({ label: tr('Ordered by…'), key: 'o', sub: true, go: () => go({ ...s, view: { v: 'iterSet', what: 'order' } }, tr('Ordered by')) });

            // (which one, up to how many, a weight, if none fit, also the dead, how many of them: as "More about this
            // list…" offers them inside a block being built)
            items.push(...iterOptionItems(s, [0], false));
            items.push(inside(it.mode === 'any' ? 'trigger' : 'effect', it.mode === 'any' ? tr('Another condition for them…') : tr('Another effect for them…')));
            break;
        }
        case 'scope':
            items.push({ label: tr('Someone (something) else instead…'), key: 'e', sub: true, title: tr('The same, for another one'), go: () => go({ ...s, view: { v: 'scopeSet' } }, tr('Instead')) });
            items.push(inside(loc.kind, loc.kind === 'trigger' ? tr('Another condition for them…') : tr('Another effect for them…')));
            break;
    }

    items.push({ label: tr('What next…'), key: 'n', sub: true, title: tr('Wrap it (When…, Chance…), add after it …'), go: () => go({ ...s, view: { v: 'cont' } }, tr('What next')) });
    return { title: tr('Change: {lineOf}', { lineOf: lineOf(n) }), items, wide: true, preview: true, note: tr('⏎ keeps it · letters choose') };
}

/**
 * An iterator's options (docs/picker.md, "Iterators"), for the node at `path` of the draft: which one of them and up to
 * how many (ordered), weighted by and if none fit (random), also the dead / only the living (the family and relation
 * lists vanilla writes it in), how many of them (any). Each keeps the iterator's other contents, the statements built
 * in it among them. `inBlock`: offered inside the block being built ("More about this list…", the draft's place is that
 * block): each comes back to the block's statements; else (changing a written iterator, `path` [0]) to "What next?".
 */
function iterOptionItems(s: State, path: number[], inBlock: boolean): Item[]
{
    const d = s.draft;
    const n = nodeAt(d.top, path);
    const it = n && iterOf(n.k);

    if (!n || !it)
        return [];

    const items: Item[] = [];
    const sub = (what: 'position' | 'max'): View => ({ v: 'iterSet', what, ...(inBlock ? { path, inBlock } : {}) });

    if (it.mode === 'ordered')
    {
        items.push({ label: tr('Which one of them…'), key: 'p', sub: true, title: tr('position = 0 is the first, 1 the second …'), go: () => go({ ...s, view: sub('position') }, tr('Which one')) });
        items.push({ label: tr('Up to how many…'), key: 'u', sub: true, title: tr('max = 3: the first three (with check_range_bounds = no)'), go: () => go({ ...s, view: sub('max') }, tr('Up to how many')) });
    }

    // (a random one: who is likelier to be picked, and what happens when none fit; its block entered, its way back out
    // to where the option was chosen)
    if (it.mode === 'random')
    {
        const into = (key: 'weight' | 'alternative_limit', kind: 'field' | 'trigger', title: string): Next =>
        {
            const nd = cloneDraft(d);
            const node = nodeAt(nd.top, path)!;
            const kids = (node.kids ??= []);
            let at = kids.findIndex((c) => c.k === key);

            // (after the iterator's own parameters, before what it does)
            if (at < 0)
            {
                at = kids.findIndex((c) => !ITERATOR_PARAMS.has(c.k));
                at = at < 0 ? kids.length : at;
                kids.splice(at, 0, key === 'weight' ? { k: 'weight', op: '=', kids: [{ k: 'base', op: '=', v: '1' }] } : { k: 'alternative_limit', op: '=', kids: [] });
            }

            const scope = node.meta?.scope ?? it.def.to;
            const loc: Loc = { path: [...path, at], kind, scope, label: node.meta?.label ?? d.loc.label, back: { ...d.loc }, title, formula: key === 'weight', ...(key === 'weight' ? { typeBack: { type: s.type } } : {}) };
            return go({ ...s, type: key === 'weight' ? 'weight' : s.type, draft: { ...nd, loc }, view: { v: 'root' } }, plainLabel(title));
        };
        items.push({ label: tr('Weighted by…'), key: 'w', sub: true, title: tr('weight = { … }: who is likelier to be picked'), go: () => into('weight', 'field', tr('Weighted by…')) });
        items.push({ label: tr('If none fit…'), key: 'f', sub: true, title: tr('alternative_limit = { … }: the conditions tried when nobody fits the limit'), go: () => into('alternative_limit', 'trigger', tr('If none fit…')) });
    }

    // (a family / relation list: the dead are left out unless asked for; only the lists vanilla writes it in, and a written one can always be taken out)
    const dead = (n.kids ?? []).some((c) => c.k === 'even_if_dead' && c.v === 'yes');

    if (dead || DEAD_LISTS.has(it.def.list))
    {
        items.push({
            label: dead ? tr('Only the living') : tr('Also the dead'),
            key: 'd',
            title: dead ? tr('Leave out even_if_dead = yes') : tr('even_if_dead = yes: the dead are in the list too'),
            go: () =>
            {
                const nd = cloneDraft(d);
                const node = nodeAt(nd.top, path)!;
                node.kids = dead ? (node.kids ?? []).filter((c) => c.k !== 'even_if_dead') : [{ k: 'even_if_dead', op: '=', v: 'yes' }, ...(node.kids ?? [])];
                const crumb = dead ? tr('Only the living') : tr('Also the dead');
                return go({ ...s, draft: inBlock ? nd : { ...nd, last: path }, view: inBlock ? { v: 'stmts' } : { v: 'cont' } }, crumb);
            }
        });
    }

    if (it.mode === 'any')
        items.push({ label: tr('How many of them…'), key: 'h', sub: true, go: () => go({ ...s, view: { v: 'count', path } }, tr('How many')) });

    return items;
}

/**
 * The stmts menu's row inside the block of an iterator being built ("More about this list…", the owner's choice): the
 * iterator just chosen (the subject chain ends in it, nothing written in it yet) or the one whose block the draft's
 * place is. Null: none here.
 */
function iterMoreRow(s: State): Item | null
{
    const d = s.draft;
    const last = s.chain[s.chain.length - 1];
    const holder = !s.chain.length && d.loc.path.length ? nodeAt(d.top, d.loc.path) : undefined;
    const it = holder ? iterOf(holder.k) : last?.kind === 'iter' ? iterOf(last.key) : undefined;
    const dead = !!holder?.kids?.some((c) => c.k === 'even_if_dead' && c.v === 'yes');

    // (only where iterOptionItems has something: not on every vassal, which takes none of them)
    if (!it || (it.mode === 'every' && !dead && !DEAD_LISTS.has(it.def.list)))
        return null;

    return {
        label: tr('More about this list…'),
        key: '=',
        sub: true,
        title: tr('Which one of them, up to how many, a weight, if none fit, also the dead'),
        go: () =>
        {
            if (holder)
                return go({ ...s, view: { v: 'iterMore', path: d.loc.path } }, tr('More about this list'));

            // (the iterator is written into the draft now, empty but for its own parameters, and the place moves into
            // its block: its options change it there, and the statements chosen next go inside; ← takes it all back)
            let nd = d;

            for (const node of wrapChain([], s.chain))
                nd = insert(nd, node);

            let path = nd.last!;

            for (let node = nodeAt(nd.top, path); node; )
            {
                const i = (node.kids ?? []).map((c) => !!c.meta?.wrap).lastIndexOf(true);

                if (i < 0)
                    break;

                path = [...path, i];
                node = node.kids![i];
            }

            const node = nodeAt(nd.top, path)!;
            const loc: Loc = { path, kind: d.loc.kind, scope: node.meta?.scope ?? subjectScope(s), label: node.meta?.label ?? chainLabel(s.chain), back: { ...d.loc } };
            return go({ ...s, chain: [], draft: { ...nd, loc, last: path }, view: { v: 'iterMore', path } }, tr('More about this list'));
        }
    };
}

/** "More about this list…": the options of the iterator at `path`, whose block the draft's place is. */
function iterMoreMenu(s: State, path: number[]): Menu
{
    const n = nodeAt(s.draft.top, path);
    const items = iterOptionItems(s, path, true);
    return {
        title: tr('More about {label}', { label: n?.meta?.label ?? (n ? lineOf(n) : '') }),
        items: items.length ? items : [{ label: tr('Nothing more to set for this list'), role: 'info' }],
        wide: true,
        preview: true
    };
}

/** What a list asks for, as one string: two lists take the same parameters when this is equal (a relation's kind is no secret's). */
const paramsKind = (d: IteratorDef): string => (d.params ?? []).map((p) => `${p.key}:${p.kind}:${p.ref ?? p.to ?? ''}`).join(',');

/** Iterator parameters of one mode only (the game's use: weight with random_, order_by … with ordered_, count with any_). */
const MODE_PARAMS: Record<string, string> = { weight: 'random', order_by: 'ordered', position: 'ordered', max: 'ordered', min: 'ordered', check_range_bounds: 'ordered', count: 'any', percent: 'any' };

/** Changing a written iterator: another list, mode, kind (a relation's type) or order. */
function iterSetMenu(s: State, data: PickerData, what: 'list' | 'mode' | 'param' | 'order' | 'position' | 'max', pi = 0, path: number[] = [0], inBlock = false): Menu
{
    const d = s.draft;
    const n = nodeAt(d.top, path)!;
    const it = iterOf(n.k)!;
    // (the iterator at `path` replaced, everything else in the draft as it was; inside a block being built ("More about
    // this list…"): back to its statements)
    const set = (key: string, kids: SNode[], crumb: string): Next =>
    {
        const node = loadNode({ k: key, op: n.op, kids }, d.loc.scope);
        const nd = cloneDraft(d);
        blockAt(nd.top, path.slice(0, -1))[path[path.length - 1]] = node;
        return go({ ...s, draft: nd, view: inBlock ? { v: 'stmts' } : { v: 'cont' } }, crumb);
    };
    const without = (k: string): SNode[] => (n.kids ?? []).filter((c) => c.k !== k);
    const withParam = (k: string, v: string): SNode[] => [{ k, op: '=', v }, ...without(k)];

    if (what === 'list' || what === 'mode')
    {
        const modes = what === 'mode' ? (['every', 'random', 'ordered'] as const).filter((m) => m !== it.mode && (m !== 'ordered' || it.def.orders)) : [it.mode];
        // (another list of the same kind of items: its statements are for those (children → vassals, not titles))
        const lists = what === 'list' ? ITERATORS.filter((i) => i !== it.def && i.to === it.def.to && (it.mode === 'any' ? i.trigger : i.effect) && i.from.some((f) => it.def.from.includes(f))) : [it.def];
        const items: Item[] = [];

        for (const m of modes)
            for (const i of lists)
            {
                const key = `${m}_${i.list}`;
                const word = m === 'every' ? tr('Every') : m === 'random' ? tr('A random') : m === 'ordered' ? tr('The highest') : tr('Any');
                items.push({
                    label: `${word} ${i.label}`,
                    hint: key,
                    go: () =>
                    {
                        // (the old parameters only for a list that takes the same (a relation's `type` is no secret's), and only the
                        // new mode's own parameters: a random one's weight, an ordered one's order_by / position / max …)
                        const asked = (it.def.params ?? []).map((p) => p.key);
                        const kids = (paramsKind(i) === paramsKind(it.def) ? (n.kids ?? []) : (n.kids ?? []).filter((c) => !asked.includes(c.k))).filter((c) => !MODE_PARAMS[c.k] || MODE_PARAMS[c.k] === m);
                        const node = loadNode({ k: key, op: n.op, kids }, d.loc.scope);
                        const next: State = { ...s, draft: { ...d, top: [node, ...d.top.slice(1)] } };
                        // (a parameter the new list needs and the old one had not: asked next; ordered without an order: by what)
                        const missing = (i.params ?? []).findIndex((p) => p.optional === undefined && !kids.some((c) => c.k === p.key));
                        const view: View = missing >= 0 ? { v: 'iterSet', what: 'param', i: missing } : m === 'ordered' && !kids.some((c) => c.k === 'order_by') ? { v: 'iterSet', what: 'order' } : { v: 'cont' };
                        return go({ ...next, view }, `${word} ${i.label}`);
                    }
                });
            }

        return { title: what === 'list' ? tr('Over which list?') : tr('Which of them?'), items, wide: true, preview: true };
    }

    if (what === 'param' && it.def.params?.[pi])
    {
        const param = it.def.params[pi];
        return { ...iterParamItems(s, data, param, (v, label) => set(n.k, v ? withParam(param.key, v) : without(param.key), label)), preview: true };
    }

    // (which one of the ordered ones: `position = 0` is the first, 1 the second …; up to how many: `max = 3`, which also
    // needs `check_range_bounds = no` when fewer fit)
    if (what === 'position' || what === 'max')
    {
        const key = what;
        const setNum = (v: number, label: string, extra: Partial<Item> = {}): Item => ({
            label,
            hint: `${key} = ${v}`,
            ...extra,
            go: () => set(n.k, key === 'max' ? [{ k: 'max', op: '=', v: String(v) }, { k: 'check_range_bounds', op: '=', v: 'no' }, ...without('max').filter((c) => c.k !== 'check_range_bounds')] : withParam('position', String(v)), label)
        });
        const none: Item = { label: key === 'position' ? tr('The first (leave it out)') : tr('All of them (leave it out)'), hint: tr('leave out'), go: () => set(n.k, without(key).filter((c) => key !== 'max' || c.k !== 'check_range_bounds'), label0(key)) };
        const rows = key === 'position'
            ? [setNum(0, tr('The first (0)')), setNum(1, tr('The second (1)')), setNum(2, tr('The third (2)')), setNum(3, tr('The fourth (3)'))]
            : [1, 2, 3, 5, 10].map((k) => setNum(k, tr('Up to {k}', { k })));
        return {
            title: key === 'position' ? tr('Which one of them?') : tr('Up to how many?'),
            items: [...rows, none],
            typeahead: true,
            preview: true,
            number: (k) => (k >= (key === 'max' ? 1 : 0) && Number.isInteger(k) ? [setNum(k, key === 'position' ? tr('Number {k} (0 is the first)', { k }) : tr('Up to {k}', { k }), { hint: '⏎' })] : []),
            note: key === 'position' ? tr('Type a number: 0 is the first, 1 the second') : tr('Type a number: at most that many')
        };
    }

    const pick = (v: string, label: string): Item => ({ label: tr('Highest {label}', { label }), hint: v, go: () => set(n.k, withParam('order_by', v), label) });
    const low = (v: string, label: string): Item => ({ label: tr('Lowest {label}', { label }), hint: v, rank: 2, go: () => set(n.k, withParam('order_by', lowestOrder(v)), label) });
    return {
        title: tr('Ordered by…'),
        typeahead: true,
        preview: true,
        items: (it.def.orders ?? []).flatMap(([v, l]) => [pick(v, l), low(v, l)]),
        input: (text) =>
        {
            const lowT = /^(lowest|-)\s*(.+)$/i.exec(text.trim());
            const name = nameOf(lowT ? lowT[2] : text);
            return name ? (lowT ? { ...low(name, name), label: tr('Use “{name}”, the lowest', { name }) } : { ...pick(name, name), label: tr('Use “{name}”', { name }) }) : null;
        }
    };
}

const label0 = (key: string): string => (key === 'position' ? tr('Which one') : tr('How many'));

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
        for (const sc of savedScopeRows(s, 'character'))
            add(sc.key, sc.label);
    }

    return {
        title: tr('Instead of {k}', { k: n.k }),
        items,
        wide: true,
        preview: true,
        input: (text) =>
        {
            const name = nameOf(text);
            const key = !name ? '' : /^(scope:|root|prev|this)/.test(name) || name.includes('.') ? name : `scope:${name}`;
            return key ? { label: tr('Use “{key}”', { key }), hint: tr('as typed'), go: () => set(key, key) } : null;
        },
        note: tr('Space, then a link or saved scope')
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

/** A field with its value replaced (the block editor's inner block written back). */
function kWith(fields: KField[], index: number, v: string): KField[]
{
    return fields.map((f, i) => (i === index ? { ...f, op: f.op || '=', v } : f));
}

/** The outermost block of a block editor inside nested ones: the current fields folded back into each block above. */
function kRoot(s: State, key: string, fields: KField[]): { key: string; fields: KField[]; }
{
    let cur = { key, fields };

    for (let i = (s.kup?.length ?? 0) - 1; i >= 0; i--)
    {
        const up = s.kup![i];
        cur = { key: up.key, fields: kWith(up.fields, up.index, kblockText('x', cur.fields).replace(/^x = /, '')) };
    }

    return cur;
}

/** The fields of a field whose value is a block (`{ a = 1 b = { c = 2 } }`); undefined for any other value. */
function kInner(f: KField): KField[] | undefined
{
    if (!/^\{[\s\S]*\}$/.test(f.v.trim()))
        return undefined;

    const node = parseSnippet(`x = ${f.v}`)[0];
    return node?.kids ? kfieldsOf(node) : undefined;
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
    // (inside a field's block the key is a field name, not a statement of the game: nothing is known about its fields)
    return s.kup?.length ? undefined : data.keys(s.draft.loc.kind as PickKind)?.find((k) => k.key === key);
}

/**
 * Any block statement, field by field (a written one the catalog has no template for; a scripted effect's call with
 * its parameters): Done, each field (its value: the values the game writes for it, its entries, or typed), "Add a
 * field…" (the fields the game writes in it, a scripted one's parameters).
 */
function kblockMenu(s: State, data: PickerData, key: string, fields: KField[]): Menu
{
    const info = keyInfo(s, data, key);
    const up = s.kup?.[s.kup.length - 1];
    const root = kRoot(s, key, fields);
    const items: Item[] = [
        up
            ? {
                // (inside a field's block: its text goes back into that field, and the block above is shown again)
                label: tr('Done with {key}', { key }),
                hint: '⏎',
                title: kblockText(key, fields),
                go: () => ({ state: { ...s, kup: s.kup!.slice(0, -1), view: { v: 'kblock', key: up.key, fields: kWith(up.fields, up.index, kblockText('x', fields).replace(/^x = /, '')) } }, crumb: up.fields[up.index].k, back: 1 })
            }
            : { label: tr('Done'), hint: '⏎', title: kblockText(root.key, root.fields), go: () => finishKey(s, kblockText(root.key, root.fields), root.key) }
    ];

    fields.forEach((f, i) =>
    {
        const inner = kInner(f);
        const shown = f.op ? `${f.op === '=' ? '' : f.op + ' '}${f.v.length > 40 ? f.v.slice(0, 39) + '…' : f.v}` : undefined;

        // (a field that is a block opens as a block of its own; its text is the other way in)
        if (inner)
        {
            items.push({
                label: f.k,
                hint: shown,
                sub: true,
                title: tr('Its fields, one by one'),
                go: () => go({ ...s, kup: [...(s.kup ?? []), { key, fields, index: i }], view: { v: 'kblock', key: f.k, fields: inner } }, f.k)
            });
            items.push({ label: tr('{k} as text', { k: f.k }), hint: tr('typed'), sub: true, rank: 3, go: () => go({ ...s, view: { v: 'kfield', key, field: f.k, index: i, fields, from: 1 } }, f.k) });
            return;
        }

        items.push({
            label: f.op ? f.k : tr('{k} (a value)', { k: f.k }),
            hint: shown,
            sub: true,
            go: () => go({ ...s, view: { v: 'kfield', key, field: f.k, index: i, fields, from: 1 } }, f.k)
        });
    });
    items.push({ label: tr('Add a field…'), key: '+', sub: true, title: info?.params?.length ? tr('Its parameters: {params}', { params: info.params.join(', ') }) : tr('The fields the game writes in it'), go: () => go({ ...s, view: { v: 'kadd', key, fields } }, tr('Add a field')) });
    return { title: `${key} = { … }`, items, wide: true, preview: true, wait: data.keys(s.draft.loc.kind as PickKind) ? undefined : data.keysLoaded(), note: tr('⏎ Done · a field to change it') };
}

/** The fields to add: a scripted one's parameters first, then those the game writes in it, or a typed one. */
function kaddMenu(s: State, data: PickerData, key: string, fields: KField[]): Menu
{
    const info = keyInfo(s, data, key);
    const has = new Set(fields.map((f) => f.k));
    const known = [...new Set([...(info?.params ?? []), ...(info?.fields ?? []).map(([f]) => f)])].filter((f) => !has.has(f));
    const pick = (f: string, hint?: string): Item => ({ label: f, hint, sub: true, go: () => go({ ...s, view: { v: 'kfield', key, field: f, fields, from: 2 } }, f) });
    return {
        title: tr('Add to {key}', { key }),
        typeahead: known.length > 20,
        wide: true,
        items: known.map((f) => pick(f, info?.params?.includes(f) ? 'parameter' : `${info?.fields?.find(([x]) => x === f)?.[1] ?? 0}×`)),
        input: (text) =>
        {
            const f = nameOf(text);
            return f && !has.has(f) ? pick(f, tr('as typed')) : null;
        },
        note: tr('Type a field name')
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

        // (a scripted effect's parameters: the next one; then the block's menu, or back into it)
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
        items.push({ label: tr('Keep: {v}', { v: cur.v }), hint: '⏎', go: () => write(cur.v, 'Keep') });

    if (cur && from)
        items.push({ label: tr('Remove this field'), go: () => write(null, 'Removed') });

    // (the entries it names: an opinion modifier, a trait …)
    const ref = info?.fieldRefs?.[field];
    const list = ref ? modFirst(data.list(ref), data) : undefined;

    for (const e of list ?? [])
        add(e.name, e.display && e.display !== e.name ? e.display : e.name, { icon: e.icon, hint: entryHint(e, data) });

    const values = info?.fieldValues?.[field] ?? [];

    for (const [v, n] of values)
        add(v, v, { hint: `${n}×` });

    const param = info?.params?.includes(field);

    // (a parameter nothing passes yet: what its definition does with it, the values of the key it is written after; none
    // known, none offered: yes / no would be a guess, so it is typed)
    const used = param && !values.length ? paramUsage(s, data, info!, field) : undefined;
    const uref = used?.ref;
    const ulist = uref ? modFirst(data.list(uref), data) : undefined;

    for (const e of ulist ?? [])
        add(e.name, e.display && e.display !== e.name ? e.display : e.name, { icon: e.icon, hint: entryHint(e, data) });

    for (const [v, n] of used?.values ?? [])
        add(v, v, { hint: `${n}×` });

    if (!param && !values.length && !list)
    {
        add('yes', 'yes');
        add('no', 'no');
    }

    return {
        title: `${key}: ${field}${cur?.op ? tr(' (now {v})', { v: cur.v }) : ''}`,
        typeahead: true,
        wide: true,
        preview: true,
        items,
        wait: ref && !list ? data.loaded(ref) : uref && !ulist ? data.loaded(uref) : undefined,
        input: (text) =>
        {
            const t = text.trim();
            return t ? { label: tr('Use “{t}”', { t }), hint: '⏎', go: () => write(/\s/.test(t) && !/^[{"]/.test(t) ? `"${t}"` : t, t) } : null;
        },
        note: param
            ? values.length
                ? tr('A parameter of {key}: what the game passes for it is listed — or type a value', { key })
                : used?.ref || used?.values.length
                ? tr('A parameter of {key}, used as {where}: the values the game writes there are listed — or type a value', { key, where: used.where })
                : used
                ? tr('A parameter of {key}, used as {where} — type a value', { key, where: used.where })
                : tr('A parameter of {key}: nothing passes it yet — type a value', { key })
            : tr('The values the game writes for it are listed — or type one')
    };
}

/**
 * What a scripted effect's (or trigger's) parameter is used for, read from where its definition writes it
 * (ScriptKeyInfo.paramKeys): the entry type and the values the game writes for that key (or that field of its block).
 * Undefined when the scan found no such place, or the key is no statement of the loaded script.
 */
function paramUsage(s: State, data: PickerData, info: ScriptKeyInfo, param: string): { where: string; ref?: string; values: [string, number][]; } | undefined
{
    const pk = info.paramKeys?.[param];

    if (!pk || s.kup?.length)
        return undefined;

    // (a field of a block: that block's values for it. Else the key as a statement: an effect or, in a limit, a condition)
    const kinds: PickKind[] = s.draft.loc.kind === 'trigger' ? ['trigger', 'effect'] : ['effect', 'trigger'];
    const find = (key: string): ScriptKeyInfo | undefined => kinds.map((k) => data.keys(k)?.find((x) => x.key === key)).find((x) => x);
    const block = pk.block ? find(pk.block) : undefined;
    const inBlock = !!block && (!!block.fieldRefs?.[pk.key] || !!block.fieldValues?.[pk.key]?.length);
    const own = inBlock ? undefined : find(pk.key);
    const ref = inBlock ? block!.fieldRefs?.[pk.key] : own?.refType;
    // (a compare such as `< 16` is a condition's value, not one to pass)
    const values = (inBlock ? block!.fieldValues![pk.key] : own?.values ?? []).filter(([v]) => !/^[<>=!]/.test(v));
    const where = inBlock ? `${pk.block} › ${pk.key}` : pk.key;
    return { where, ref, values };
}

// ---------------------------------------------------------------------------
// "＋ New trait…": a new entry of the type a list asks for, made in the active mod when the statement is written
// ---------------------------------------------------------------------------

/** Where a new entry's key goes once it is made: a statement's parameter, a setting, an "Other…" key's value. */
export type NewRefThen = { to: 'param'; prefix?: string; } | { to: 'field'; key: string; } | { to: 'other'; key: string; };

/**
 * Where a new entry of a nested type goes (NewEntryPlan.nested): a holder of the mod's or the game's (copied into the
 * mod first), or a new holder made with it (its key, and its name in game when one was typed); a new holder another
 * new entry of the statement makes is chosen by its row (the same fields), never by typing its key again.
 */
export type HolderPick = { holder: string; } | { newHolder: string; newHolderName?: string; };

/** The holder as the fields an `entry` create carries (EntryCreate.fields; create.ts reads them). */
function holderFields(h: HolderPick | undefined): [string, string][]
{
    if (!h)
        return [];

    return 'holder' in h ? [['holder', h.holder]] : [['newHolder', h.newHolder], ...(h.newHolderName ? [['newHolderName', h.newHolderName] as [string, string]] : [])];
}

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
 * entries made on the way ("… · new"), and "＋ New trait…" when the active mod can take one of the type (its
 * `newEntryPlan`: no problem, a file of its own (not laws in law groups, faiths in religions)).
 */
function newRefRows(s: State, data: PickerData, type: string, then: NewRefThen): { items: Item[]; wait?: Promise<unknown>; }
{
    if (!s.newEntries || !data.newPlan || !data.activeMod())
        return { items: [] };

    const plan = data.newPlan(type);
    const made = (s.creates ?? []).filter((c) => c.what === 'entry' && c.fields.some(([k, v]) => k === 'type' && v === type));
    const items: Item[] = made.map((c) => ({ label: c.loc || humanize(c.key), hint: tr('{key} · new', { key: c.key }), match: c.key, rank: -5, go: () => useNewRef(s, c.key, then, c.key) }));

    if (!plan)
        return { items, wait: data.newPlanLoaded?.(type) };

    // (a nested type has no file of its own: it goes inside a holder, asked after the key)
    if (!plan.problem && (plan.rel || plan.nested))
    {
        const one = singularLabel(plan.label);
        const holder = plan.nested ? singularLabel(plan.nested.holderLabel) : '';
        items.push({
            label: tr('＋ New {one}…', { one }),
            hint: plan.nested ? tr('in a {holder} of your mod', { holder }) : tr('in your mod'),
            match: `+ new ${one}`,
            explicit: true,
            title: plan.nested
                ? tr('A new {one}, made inside a {holder} of {mod} when this is written — its template, to fill in afterwards', { one, holder, mod: plan.mod ?? tr('your mod') })
                : tr('A new {one}, made in {mod} ({rel}) when this is written — its template, to fill in afterwards', { one, mod: plan.mod ?? tr('your mod'), rel: plan.rel }),
            sub: true,
            go: () => go({ ...s, view: { v: 'newRef', type, then } }, tr('New {one}', { one }))
        });
    }

    return { items };
}

/** The new entry's key: typed (a valid key nobody has), or (events) the mod's next free id. */
function newRefMenu(s: State, data: PickerData, type: string, then: NewRefThen): Menu
{
    const plan = data.newPlan?.(type);
    const list = data.list(type);
    const one = plan ? singularLabel(plan.label) : type;
    const valid = type === 'events' ? /^[A-Za-z_][\w-]*\.\d+$/ : /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
    const taken = (k: string): boolean => !!list?.some((e) => e.name === k) || !!s.creates?.some((c) => c.key === k);
    const pick = (key: string): Next => (plan?.nested ? go({ ...s, view: { v: 'newRefHolder', type, key, then } }, key) : plan?.name ? go({ ...s, view: { v: 'newRefName', type, key, then } }, key) : made(s, type, key, undefined, then));
    const items: Item[] = plan?.key && !taken(plan.key) ? [{ label: `${plan.key}`, hint: tr('the next free id'), sub: !!plan.name || !!plan.nested, go: () => pick(plan.key!) }] : [];
    return {
        title: tr('New {one}: its key', { one }),
        typeahead: true,
        wide: true,
        items: items.length ? items : [{ label: type === 'events' ? tr('Type its id: namespace.number') : tr('Type its key, e.g. {example}', { example: `my_${one.replace(/\W+/g, '_')}` }), role: 'info' }],
        wait: list ? undefined : data.loaded(type),
        input: (text) =>
        {
            const key = nameOf(text);

            if (!key)
                return null;

            if (taken(key))
                return { label: tr('“{key}” exists already', { key }), role: 'info' };

            if (!valid.test(key))
                return { label: type === 'events' ? tr('“{key}” is no event id (namespace.number)', { key }) : tr('“{key}”: letters, digits, _, . and - only', { key }), role: 'info' };

            return { label: tr('Make “{key}”…', { key }), hint: plan?.rel, sub: !!plan?.name || !!plan?.nested, go: () => pick(key) };
        },
        note: plan?.nested
            ? tr('Written into a {holder} of your mod when the statement is — Undo takes it back with it', { holder: singularLabel(plan.nested.holderLabel) })
            : tr('Written into {rel} when the statement is — Undo takes it back with it', { rel: plan?.rel ?? 'your mod' })
    };
}

/** What a nested entry's next step is once its holder is chosen: its name in game, or made. */
function afterHolder(s: State, type: string, key: string, then: NewRefThen, holder: HolderPick, named: boolean): Next
{
    return named ? go({ ...s, view: { v: 'newRefName', type, key, then, holder } }, key) : made(s, type, key, undefined, then, holder);
}

/**
 * The holder a nested new entry goes in: a new one another new entry of this statement makes ("… · new"), the mod's own,
 * the game's, or "＋ New <holder>…" (made with it).
 */
function newRefHolderMenu(s: State, data: PickerData, type: string, key: string, then: NewRefThen): Menu
{
    const plan = data.newPlan?.(type);
    const nested = plan?.nested;

    if (!nested)
        return { title: tr('{key}: where does it go?', { key }), items: [{ label: tr('It goes inside another definition'), role: 'info' }], wait: data.newPlanLoaded?.(type) };

    const list = data.list(nested.holderType);
    const holder = singularLabel(nested.holderLabel);
    const named = !!plan?.name;
    const items: Item[] = (modFirst(list, data) ?? []).map((e) => ({
        label: e.display && e.display !== e.name ? e.display : e.name,
        hint: entryHint(e, data),
        match: `${e.name} ${e.display ?? ''}`,
        sub: named,
        go: () => afterHolder(s, type, key, then, { holder: e.name }, named)
    }));

    if (nested.newHolder)
    {
        items.unshift({
            label: tr('＋ New {holder}…', { holder }),
            hint: tr('in your mod'),
            match: `+ new ${holder}`,
            explicit: true,
            title: tr('A new {holder} to hold “{key}”, made in {mod} when this is written', { holder, key, mod: plan?.mod ?? tr('your mod') }),
            sub: true,
            go: () => go({ ...s, view: { v: 'newRefHolderKey', type, key, then } }, tr('New {holder}', { holder }))
        });
    }

    // (a new holder another new entry of this statement makes: this one goes into it too. It carries the same holder
    // fields, so whichever entry stays in the statement makes the holder (usedCreates), the others join it; create.ts)
    const pending = new Map<string, string | undefined>();

    for (const c of s.creates ?? [])
    {
        const f = new Map(c.fields);
        const hk = f.get('newHolder');
        const ct = f.get('type');

        if (c.what === 'entry' && hk && !pending.has(hk) && ct && (ct === type || data.newPlan?.(ct)?.nested?.holderType === nested.holderType))
            pending.set(hk, f.get('newHolderName'));
    }

    items.unshift(...[...pending].map(([hk, name]): Item => ({
        label: name || defaultEntryName(nested.holderType, hk),
        hint: tr('{key} · new', { key: hk }),
        match: hk,
        rank: -5,
        sub: named,
        go: () => afterHolder(s, type, key, then, { newHolder: hk, ...(name ? { newHolderName: name } : {}) }, named)
    })));

    return {
        title: tr('{key}: which {holder} is it in?', { key, holder }),
        typeahead: true,
        wide: true,
        items,
        wait: list ? undefined : data.loaded(nested.holderType),
        note: tr('A {holder} of the game is copied into your mod first — Undo takes it back with the rest', { holder })
    };
}

/** A new holder's key (a valid key nobody has, nor another new entry of this statement). */
function newRefHolderKeyMenu(s: State, data: PickerData, type: string, key: string, then: NewRefThen): Menu
{
    const nested = data.newPlan?.(type)?.nested;
    const list = nested ? data.list(nested.holderType) : undefined;
    const holder = nested ? singularLabel(nested.holderLabel) : tr('holder');
    const taken = (k: string): boolean => !!list?.some((e) => e.name === k) || !!s.creates?.some((c) => c.key === k || c.fields.some(([f, v]) => f === 'newHolder' && v === k));
    return {
        title: tr('New {holder}: its key', { holder }),
        typeahead: true,
        wide: true,
        items: [{ label: tr('Type its key, e.g. {example}', { example: `my_${holder.replace(/\W+/g, '_')}` }), role: 'info' }],
        wait: !nested ? data.newPlanLoaded?.(type) : list ? undefined : data.loaded(nested.holderType),
        input: (text) =>
        {
            const hk = nameOf(text);

            if (!hk)
                return null;

            if (taken(hk))
                return { label: tr('“{key}” exists already', { key: hk }), role: 'info' };

            if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(hk))
                return { label: tr('“{key}”: letters, digits, _, . and - only', { key: hk }), role: 'info' };

            return { label: tr('Make “{key}”…', { key: hk }), sub: true, go: () => go({ ...s, view: { v: 'newRefHolderName', type, key, then, hk } }, hk) };
        },
        note: tr('Written with “{key}” when the statement is — Undo takes it back with it', { key })
    };
}

/** A new holder's name in game: typed, or its key made readable. */
function newRefHolderNameMenu(s: State, data: PickerData, type: string, key: string, then: NewRefThen, hk: string): Menu
{
    const plan = data.newPlan?.(type);
    const named = !!plan?.name;
    const plain = defaultEntryName(plan?.nested?.holderType ?? '', hk);
    return {
        title: tr('{key}: its name in game', { key: hk }),
        typeahead: true,
        wide: true,
        items: [{ label: tr('Keep: {plain}', { plain }), hint: '⏎', unfiltered: true, go: () => afterHolder(s, type, key, then, { newHolder: hk }, named) }],
        input: (text) => (text.trim() ? { label: tr('Use “{text}”', { text: text.trim() }), hint: '⏎', go: () => afterHolder(s, type, key, then, { newHolder: hk, newHolderName: text.trim() }, named) } : null),
        note: tr('What the game shows for it')
    };
}

/** The new entry's name in game (its localization): typed, or the key made readable. */
function newRefNameMenu(s: State, type: string, key: string, then: NewRefThen, holder?: HolderPick): Menu
{
    const plain = defaultEntryName(type, key);
    return {
        title: tr('{key}: its name in game', { key }),
        typeahead: true,
        wide: true,
        items: [{ label: tr('Keep: {plain}', { plain }), hint: '⏎', unfiltered: true, go: () => made(s, type, key, undefined, then, holder) }],
        input: (text) => (text.trim() ? { label: tr('Use “{text}”', { text: text.trim() }), hint: '⏎', go: () => made(s, type, key, text.trim(), then, holder) } : null),
        note: tr('What the game shows for it')
    };
}

/** The new entry is remembered (PickResult.creates: made before the statement is written) and its key used. */
function made(s: State, type: string, key: string, name: string | undefined, then: NewRefThen, holder?: HolderPick): Next
{
    const creates: EntryCreate[] = [...(s.creates ?? []).filter((c) => c.key !== key), { what: 'entry', key, fields: [['type', type], ...holderFields(holder)], ...(name ? { loc: name } : {}) }];
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

        items.push({ label: groupLabel(d), hint: d.script.split(/\s/)[0].replace(/\$\w+\$/g, '…'), match: `${d.words ?? ''} ${d.script}`, sub: d.params.length > 0, doc: statementDoc(d), go: () => go(start(s, d), groupLabel(d)) });
    }

    for (const d of statementsFor(kind, null))
        items.push({ label: d.label, hint: d.script.split(/\s/)[0], match: d.words, sub: d.params.length > 0, doc: statementDoc(d), go: () => go(start({ ...s, chain: [] }, d, []), d.label) });

    for (const k of data.keys(kind) ?? [])
        items.push({ label: k.key, hint: tr('{count}× · other', { count: k.count }), rank: 3, sub: true, doc: k.scripted ? undefined : { kind, key: k.key }, go: () => go({ ...s, view: keyView(k) }, k.key) });

    return { title: tr('Search {kind}', { kind: kind === 'effect' ? 'effects' : 'conditions' }), items, typeahead: true, wide: true, note: tr('Type to search the catalog and every key the game uses') };
}

/** Opens the search menu from the current state (the "/" key). */
export function searchState(s: State): State
{
    return { ...s, pending: undefined, view: { v: 'search' } };
}

/**
 * The row the `+` key selects when nothing is typed: the menu's "＋ New …" row (Item.explicit), also in a list whose
 * labels hold `+` (a game rule's "+1"), where a typed `+` would filter for those and ⏎ take the first. -1 when the menu
 * has no such row or a filter is typed: `+` is then typed into the filter as before (Picker.tsx).
 */
export function plusRow(rows: { item: Item; }[], filter: string): number
{
    return filter ? -1 : rows.findIndex((r) => !!r.item.explicit && !!r.item.go && r.item.role !== 'info');
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
    // (':' splits too: a key written behind a prefix, faith:<key>, is still the key)
    const words = new Set(resultText(s).match(/[^\s{}=<>!?"#:]+/g) ?? []);
    // (a text key made for a name the script writes (a named track's `trait_track_<name>`): its `for` field)
    const used = (s.creates ?? []).filter((c) => words.has(c.key) || (c.what === 'loc' && c.fields.some(([k, v]) => k === 'for' && words.has(v))));
    return used.length ? used : undefined;
}

/**
 * The names given to the entries made on the way (key → name; a new holder's too): the preview and the summary read
 * them by that name, not by the key (api.describeScript `names`). Undefined: none.
 */
export function createdNames(s: State): Record<string, string> | undefined
{
    const out: Record<string, string> = {};

    for (const c of s.creates ?? [])
    {
        // (a new opinion modifier's `loc` is its name too; a doctrine parameter's is a sentence, not a name)
        if (c.what === 'opinion_modifiers' && c.loc)
            out[c.key] = c.loc;

        if (c.what !== 'entry')
            continue;

        if (c.loc)
            out[c.key] = c.loc;

        const f = new Map(c.fields);
        const holder = f.get('newHolder');
        const holderName = f.get('newHolderName');

        if (holder && holderName)
            out[holder] = holderName;
    }

    return Object.keys(out).length ? out : undefined;
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

/**
 * Groups of the modifier menus (docs/picker.md, "Modifiers and settings"): a modifier of one of the game's area files
 * (ModifierKeyInfo.area: units, terrain, subjects …) goes to its area's group; one of the general file (or of a mod's
 * file of another name) to the first themed group whose pattern matches its key.
 */
const MOD_AREA_GROUPS: { id: string; label: string; k: string; }[] = [
    { id: 'unit', label: tr('Units…'), k: 'u' },
    { id: 'terrain', label: tr('Terrain…'), k: 'i' },
    { id: 'subject', label: tr('Subjects…'), k: 'b' },
    { id: 'culture', label: tr('Culture…'), k: 'k' },
    { id: 'government', label: tr('Government…'), k: 'w' },
    { id: 'vassal_stance', label: tr('Vassal stances…'), k: 'x' },
    { id: 'scheme', label: tr('Schemes…'), k: 'q' },
    { id: 'holding', label: tr('Holdings…'), k: 'd' },
    { id: 'travel', label: tr('Travel…'), k: 'z' },
    { id: 'lifestyle', label: tr('Lifestyles…'), k: 'y' },
    { id: 'religion', label: tr('Religion…'), k: 'f' },
    { id: 'region', label: tr('Regions…'), k: 'j' }
];

/** The themed groups of the general file's modifiers: a modifier goes to the first whose pattern matches its key. */
const MOD_GROUPS: { id: string; label: string; k: string; re: RegExp; }[] = [
    { id: 'skills', label: tr('Skills…'), k: 's', re: /^(diplomacy|martial|stewardship|intrigue|learning|prowess)(_|$)/ },
    { id: 'opinion', label: tr('Opinion…'), k: 'o', re: /opinion/ },
    { id: 'prestige', label: tr('Prestige, piety & renown…'), k: 'p', re: /prestige|piety|renown/ },
    { id: 'money', label: tr('Gold, income & costs…'), k: 'g', re: /gold|income|tax|_cost/ },
    { id: 'health', label: tr('Health & fertility…'), k: 'h', re: /health|fertility|life_expectancy|negate_|epidemic|disease|pregnan/ },
    { id: 'stress', label: tr('Stress & dread…'), k: 't', re: /stress|dread/ },
    { id: 'military', label: tr('Military…'), k: 'm', re: /knight|levy|men_at_arms|maa|army|siege|advantage|supply|movement|garrison|fort|raid|commander|damage|toughness|pursuit|screen|counter|hostile_county/ },
    { id: 'lifestyle', label: tr('Lifestyle & experience…'), k: 'l', re: /lifestyle|_xp|experience/ },
    { id: 'schemes', label: tr('Schemes & secrets…'), k: 'c', re: /scheme|secret|agent|plot/ },
    { id: 'realm', label: tr('Realm, vassals & titles…'), k: 'r', re: /vassal|domain|title|county|development|control|realm|holding|building|legitimacy|tyranny|province/ },
    { id: 'relations', label: tr('Attraction & relations…'), k: 'n', re: /attraction|seduc|romance|marriage|friend|rival|lover|court_grandeur|fame|travel/ },
    { id: 'other', label: tr('Everything else…'), k: 'e', re: /./ }
];

/** A modifier's group: its area's (`area:<area>`), else the themed group of its key. */
export function modGroupOf(m: Pick<ModifierKeyInfo, 'key' | 'area'>): string
{
    if (m.area && MOD_AREA_GROUPS.some((g) => g.id === m.area))
        return 'area:' + m.area;

    return MOD_GROUPS.find((g) => g.re.test(m.key))!.id;
}

/** Every group of the modifier menus, in the root menu's order: the themed ones, the areas, "Everything else" last. */
const ALL_MOD_GROUPS: { id: string; label: string; k: string; }[] = [...MOD_GROUPS.filter((g) => g.id !== 'other'), ...MOD_AREA_GROUPS.map((g) => ({ ...g, id: 'area:' + g.id })), ...MOD_GROUPS.filter((g) => g.id === 'other')];

/** What a block of modifiers applies to (State.modScope), in the menus' words. */
const MOD_SCOPE_WORD: Record<Exclude<ModifierKind, 'other'>, string> = {
    character: tr('Character'),
    landed_title: tr('County'),
    province: tr('Province'),
    scheme: tr('Scheme'),
    travel_plan: tr('Travel plan'),
    army: tr('Army'),
    artifact: tr('Artifact'),
    dynasty: tr('Dynasty'),
    dynasty_house: tr('House')
};

/**
 * The modifiers the menus offer: for a block of a character's, a county's, a province's, a scheme's … modifiers the
 * ones the game puts there (ModifierKeyInfo.kinds), most used there first; else every one.
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

    for (const g of ALL_MOD_GROUPS)
    {
        if (list && !list.some((m) => modGroupOf(m) === g.id))
            continue;

        items.push({ label: g.label, key: g.k, sub: true, go: () => go({ ...s, view: { v: 'modGroup', group: g.id } }, plainLabel(g.label)) });
    }

    const word = s.modScope ? MOD_SCOPE_WORD[s.modScope] : '';
    items.push({
        label: word ? tr('All {word} modifiers…', { word: word.toLowerCase() }) : tr('All modifiers…'),
        key: 'a',
        sub: true,
        title: word ? tr('Every modifier the game puts in a {word}’s modifiers, most used there first', { word: word.toLowerCase() }) : tr('Every modifier the game defines, most used first'),
        go: () => go({ ...s, view: { v: 'modGroup', group: '' } }, tr('All modifiers'))
    });

    if (word)
        items.push({ label: tr('Every modifier…'), key: 'v', sub: true, title: tr('Also those the game never puts here'), go: () => go({ ...s, view: { v: 'modGroup', group: '', every: true } }, tr('Every modifier')) });

    return {
        title: s.draft.loc.title ?? (s.title ? tr('Add to: {title}', { title: s.title }) : tr('Add a modifier')),
        items,
        wait: list ? undefined : data.modifiersLoaded(),
        note: word ? tr('{word} modifiers (the ones the game puts there) · / every one · ← back · Esc close', { word }) : tr('Keys: letter = item · type to filter · / search all · ← back · Esc close')
    };
}

/** How many of a group's modifiers its menu shows with letter keys; the rest are under "More…". */
const GROUP_TOP = 15;

function modGroupMenu(s: State, data: PickerData, group: string, all = false, every = false): Menu
{
    // (`every`: also those the game never puts in this kind of block)
    const list = every ? data.modifiers() : fittingModifiers(s, data.modifiers());
    const mods = (list ?? []).filter((m) => !group || modGroupOf(m) === group);
    const g = ALL_MOD_GROUPS.find((x) => x.id === group);
    // (percent modifiers often share their name with the flat one: "Prowess" and "Prowess %")
    const pick = (m: ModifierKeyInfo): Item =>
    {
        const label = m.percent && !/%/.test(m.label) ? `${m.label} %` : m.label;
        return { label, hint: m.key, match: m.key, sub: true, doc: { kind: 'modifier', key: m.key }, go: () => go({ ...s, view: { v: 'modValue', key: m.key } }, label) };
    };
    // a group: its most used ones with letter keys, the rest under "More…"; the full lists: letters filter
    const short = !all && !!group && mods.length > GROUP_TOP + 1;
    const items: Item[] = !list
        ? [{ label: tr('Reading the modifiers…'), role: 'info' }]
        : short
        ? [...mods.slice(0, GROUP_TOP).map(pick), { label: tr('More… ({more})', { more: mods.length - GROUP_TOP }), sub: true, go: () => go({ ...s, view: { v: 'modGroup', group, all: true } }, tr('More')) }]
        : mods.map(pick);
    return {
        title: g ? plainLabel(g.label) : tr('All modifiers'),
        typeahead: !short && mods.length > 24,
        wide: true,
        items,
        wait: list ? undefined : data.modifiersLoaded(),
        input: (text) =>
        {
            const key = nameOf(text).toLowerCase();
            return key ? { label: tr('Use “{key}”', { key }), sub: true, hint: tr('as typed'), go: () => go({ ...s, view: { v: 'modValue', key } }, key) } : null;
        },
        note: tr('Most used first — type to filter by name or key')
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
    const keep: Item[] = now !== undefined ? [{ label: tr('Keep: {now}', { now }), hint: '⏎', go: () => put(s, `${key} = ${now}`, tr('Keep')) }] : [];
    return {
        title: now !== undefined ? tr('{label} (now {now})', { label: m.label, now }) : m.label,
        items: [...keep, ...modifierPresets(m).map((n) => item(n))],
        typeahead: true,
        preview: true,
        wait: list ? undefined : data.modifiersLoaded(),
        number: (n) => [item(n, { hint: '⏎' })],
        input: (text) =>
        {
            const name = nameOf(text);
            return name && !/^-?[\d.]+$/.test(name) ? { label: tr('Use “{name}”', { name }), hint: tr('script value'), go: () => put(s, `${key} = ${name}`, name) } : null;
        },
        note: pct ? tr('Type a percentage (10 = +10%), or a script value') : tr('Type an amount (-2 lowers it), or a script value')
    };
}

function fieldRoot(s: State, data: PickerData): Menu
{
    const type = s.type ?? '';

    if (type === 'doctrine_parameters')
        return paramRoot(s, data);

    // (a block the section writes already is left out: its row's ⤷＋ adds to it, and a second block of the key would be
    // written otherwise; the Special values section passes its written blocks as the request's `common`)
    const written = new Set(s.common ?? []);
    const items: Item[] = (FIELDS[type] ?? []).filter((f) => !(f.kind === 'block' && written.has(f.key))).map((f) =>
    {
        if (f.kind === 'bool')
            return { label: f.label, key: f.k, hint: `${f.key} = yes`, title: f.help, go: () => put(s, `${f.key} = yes`, f.label) };

        const crumb = plainLabel(f.label);

        // a block: its needed fields first, then the block's own menu
        if (f.kind === 'block')
            return { label: f.label, key: f.k, hint: `${f.key} = { … }`, title: f.help, sub: true, go: () => go({ ...s, view: blockStep(f, []) }, crumb) };

        // a level inside a block of its own name (a named track): the name first
        if (f.named)
            return { label: f.label, key: f.k, hint: `… = { N = { } }`, title: f.help, sub: true, go: () => go({ ...s, view: { v: 'namedKey', field: f.key } }, crumb) };

        // a key that is any entry (a trait of a compatibility): which one first
        if (f.anyKey)
            return { label: f.label, key: f.k, hint: `… = value`, title: f.help, sub: true, go: () => go({ ...s, view: { v: 'fieldKey', field: f.key } }, crumb) };

        const hint = f.kind === 'duration' ? (f.key === 'delay' ? 'delay_years …' : tr('years …')) : f.bare ? tr('a value') : f.kind === 'level' ? 'N = { … }' : f.key;
        return { label: f.label, key: f.k, hint, title: f.help, sub: true, go: () => go({ ...s, view: { v: 'fieldValue', key: f.key } }, crumb) };
    });

    // (a definition that takes any other setting too: a typed key and value)
    if (isOpenSet(type))
        items.push({ label: tr('Other setting…'), key: 'o', sub: true, title: tr('Any key the definitions write — typed, with the values the game writes for it'), go: () => go({ ...s, view: { v: 'otherSetting' } }, tr('Other setting')) });

    return {
        title: s.draft.loc.title ?? (s.title ? tr('Add to: {title}', { title: s.title }) : tr('Add a setting')),
        wide: true,
        items: items.length ? items : [{ label: tr('Nothing to add for this kind of entry'), role: 'info' }],
        note: tr('Keys: letter = item · type to filter · ← back · Esc close')
    };
}

/**
 * A field whose key is any entry of a type (`compatibility = { brave = 15 }`): which entry, then its value (`next`: where
 * the key leads instead, a block's entry). No type (`anyKey` empty): the keys of its `suggest` (a doctrine parameter).
 */
function fieldKeyMenu(s: State, data: PickerData, field: string, next?: (name: string, label: string) => Next): Menu
{
    const f = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === field);

    if (Array.isArray(f?.anyKey) && !f.anyKey.length && f.suggest)
    {
        const source = f.suggest;
        const list = data.suggestions(source);
        const to = (name: string, label: string): Next => (next ? next(name, label) : go({ ...s, view: { v: 'fieldValue', key: name } }, label));
        const row = (name: string, extra: Partial<Item> = {}): Item => ({ label: humanize(name), match: name, sub: true, go: () => to(name, humanize(name)), ...extra });
        return {
            title: plainLabel(f.label),
            typeahead: true,
            wide: true,
            items: (list ?? []).map((x) => row(x.value, { hint: x.label })),
            wait: list ? undefined : data.suggestionsLoaded(source),
            input: (text) =>
            {
                const name = nameOf(text);
                return name && !list?.some((x) => x.value === name) ? row(name, { label: tr('Use “{name}”', { name }), hint: tr('as typed') }) : null;
            },
            note: tr('Type to filter, or a key as typed')
        };
    }

    // (the entries of one type, or of several in turn: a hostility override's doctrines, then its tenets)
    const types = typeof f?.anyKey === 'string' ? [f.anyKey] : f?.anyKey ?? [''];
    const lists = types.map((t) => data.list(t));
    const ready = lists.every((l) => !!l);
    const list = ready ? modFirst(lists.flatMap((l) => l!), data) : undefined;
    const typeOfEntry = new Map<RefEntry, string>(types.flatMap((t, i) => (lists[i] ?? []).map((e) => [e, t] as [RefEntry, string])));
    const pick = (name: string, label: string, extra: Partial<Item> = {}): Item => ({ label, sub: true, match: name, go: () => (next ? next(name, label) : go({ ...s, view: { v: 'fieldValue', key: name } }, label)), ...extra });
    const dlc = dlcGrouping(data, types.length === 1 ? types[0] : undefined, (list ?? []).map((e) => pick(e.name, e.display && e.display !== e.name ? e.display : e.name, { hint: entryHint(e, data), icon: e.icon, entry: { type: typeOfEntry.get(e) ?? types[0], name: e.name } })), tr('Your mod’s first, then the most used — type to filter'));
    return {
        title: f ? plainLabel(f.label) : field,
        typeahead: true,
        wide: true,
        groupable: dlc.groupable,
        items: dlc.items,
        wait: ready ? dlc.wait : Promise.all(types.map((t) => data.loaded(t))),
        input: (text) =>
        {
            const name = nameOf(text);
            return name ? pick(name, tr('Use “{name}”', { name }), { hint: tr('as typed') }) : null;
        },
        note: dlc.note
    };
}

/**
 * A level inside a block of its own name (FieldDef.named: a trait's new named track): the name typed, as the script
 * writes it (a–z, digits, _, at least one letter: an all-digit key reads as a level), and not one written beside it
 * (PickRequest.common: the trait's tracks) or made already in this request ("And also…").
 */
function namedKeyMenu(s: State, field: string): Menu
{
    const f = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === field);
    const taken = new Set([...(s.common ?? []), ...s.draft.top.map((n) => n.k)]);
    return {
        title: f ? plainLabel(f.label) : field,
        typeahead: true,
        wide: true,
        items: [
            { label: tr('Type its name, e.g. {example}', { example: 'royal_falconer' }), role: 'info' },
            ...(taken.size ? [{ label: tr('Written already: {names}', { names: [...taken].join(', ') }), role: 'info' } as Item] : [])
        ],
        input: (text) =>
        {
            const name = text.trim().replace(/\s+/g, '_').toLowerCase();

            if (!name)
                return null;

            if (!/^[a-z0-9_]*[a-z][a-z0-9_]*$/.test(name))
                return { label: tr('Only letters a–z, digits and _, at least one letter'), role: 'info' };

            if (taken.has(name))
                return { label: tr('“{name}” exists already', { name }), role: 'info' };

            return { label: tr('Use “{name}”…', { name }), sub: true, go: () => go({ ...s, view: { v: 'namedLevel', field, name } }, name) };
        },
        note: tr('The name the script uses: letters a–z, digits and _')
    };
}

/** The named block's first level (`falconer = { 50 = { } }`), then its name in game when the field asks it. */
function namedLevelMenu(s: State, data: PickerData, field: string, name: string): Menu
{
    const f = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === field);
    const write: Write = (_k, v, label) => (f?.named?.loc ? go({ ...s, view: { v: 'namedLoc', field, name, level: v } }, label) : put(s, `${name} = { ${v} = { } }`, label));
    const m = fieldValueMenu(s, data, s.type ?? '', field, undefined, undefined, write);
    return { ...m, title: `${name}: ${m.title}` };
}

/**
 * The named block's name in game (optional): written as its text key (FieldDef.named.loc, `trait_track_<name>`), a
 * `loc` create of the result, so the key and the block are one undo step (PickResult.creates; usedCreates keeps it by
 * its `for` field). A key that exists (the game's `trait_track_falconer`: a track's text key is global) is kept first,
 * with no create; another text changes it everywhere it is used (main writes it as an override in the mod's replace
 * folder, or in the mod's own line).
 */
function namedLocMenu(s: State, data: PickerData, field: string, name: string, level: string): Menu
{
    const f = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === field);
    const key = (f?.named?.loc ?? '$').replace('$', name);
    const text = `${name} = { ${level} = { } }`;
    const done = (loc?: string, crumb?: string): Next =>
    {
        const next = loc ? { ...s, creates: [...(s.creates ?? []).filter((c) => c.key !== key), { what: 'loc' as const, key, fields: [['for', name]] as [string, string][], loc }] } : s;
        const label = crumb ?? loc ?? tr('No name in game');
        // (then its description, when the field asks one: namedDescMenu)
        return f?.named?.descSuffix ? go({ ...next, view: { v: 'namedDesc', field, name, level } }, label) : put(next, text, label);
    };
    const suggested = humanize(name);
    const title = f?.named?.locLabel ? plainLabel(f.named.locLabel) : tr('In game');
    const known = data.locEntry?.(key);

    if (known === undefined && data.locEntry)
        return { title, items: [{ label: tr('Looking up {key}…', { key }), role: 'info' }], wait: data.locEntryLoaded?.(key) };

    if (known)
    {
        const now = known.text ?? '';
        const mine = !!known.mod && known.mod.toLowerCase() === (data.activeMod() ?? '').toLowerCase();
        const everywhere = mine ? tr('{key} is your mod’s text already: a new one changes it everywhere it is used', { key }) : tr('{key} is the game’s text: a new one changes it everywhere the game uses it (an override in your mod’s replace folder)', { key });
        return {
            title,
            typeahead: true,
            wide: true,
            items: [
                { label: mine ? tr('Keep your mod’s “{text}”', { text: now }) : tr('Keep the game’s “{text}”', { text: now }), hint: '⏎', title: known.rel, unfiltered: true, go: () => done(undefined, tr('Keep')) }
            ],
            input: (t) => (t.trim() && t.trim() !== now ? { label: tr('Change it to “{text}”', { text: t.trim() }), hint: tr('everywhere'), title: everywhere, go: () => done(t.trim()) } : null),
            note: everywhere
        };
    }

    return {
        title,
        typeahead: true,
        wide: true,
        items: [
            { label: tr('Use “{text}”', { text: suggested }), hint: '⏎', unfiltered: true, go: () => done(suggested) },
            { label: tr('No name in game'), hint: key, title: tr('The game then shows the text key {key}', { key }), unfiltered: true, go: () => done() }
        ],
        input: (t) => (t.trim() ? { label: tr('Use “{text}”', { text: t.trim() }), hint: '⏎', go: () => done(t.trim()) } : null),
        note: tr('What the game shows for it ({key}) — or type it', { key })
    };
}

/**
 * The named block's description in game (optional, after its name: FieldDef.named.descSuffix, `trait_track_<name>_desc`), a
 * `loc` create like the name's (namedLocMenu), so both texts and the block are one undo step. No description is the
 * first row (the game then shows none, or the key); a key that exists is kept first, another text changes it
 * everywhere it is used.
 */
function namedDescMenu(s: State, data: PickerData, field: string, name: string, level: string): Menu
{
    const f = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === field);
    const key = (f?.named?.loc ?? '$').replace('$', name) + (f?.named?.descSuffix ?? '_desc');
    const text = `${name} = { ${level} = { } }`;
    const done = (loc?: string, crumb?: string): Next =>
        put(loc ? { ...s, creates: [...(s.creates ?? []).filter((c) => c.key !== key), { what: 'loc', key, fields: [['for', name]], loc }] } : s, text, crumb ?? loc ?? tr('No description'));
    const title = f?.named?.descLabel ? plainLabel(f.named.descLabel) : tr('Description');
    const known = data.locEntry?.(key);

    if (known === undefined && data.locEntry)
        return { title, items: [{ label: tr('Looking up {key}…', { key }), role: 'info' }], wait: data.locEntryLoaded?.(key) };

    if (known)
    {
        const now = known.text ?? '';
        const mine = !!known.mod && known.mod.toLowerCase() === (data.activeMod() ?? '').toLowerCase();
        const everywhere = mine ? tr('{key} is your mod’s text already: a new one changes it everywhere it is used', { key }) : tr('{key} is the game’s text: a new one changes it everywhere the game uses it (an override in your mod’s replace folder)', { key });
        return {
            title,
            typeahead: true,
            wide: true,
            items: [
                { label: mine ? tr('Keep your mod’s “{text}”', { text: now }) : tr('Keep the game’s “{text}”', { text: now }), hint: '⏎', title: known.rel, unfiltered: true, go: () => done(undefined, tr('Keep')) }
            ],
            input: (t) => (t.trim() && t.trim() !== now ? { label: tr('Change it to “{text}”', { text: t.trim() }), hint: tr('everywhere'), title: everywhere, go: () => done(t.trim()) } : null),
            note: everywhere
        };
    }

    return {
        title,
        typeahead: true,
        wide: true,
        items: [{ label: tr('No description'), hint: '⏎', title: tr('Nothing written for {key}', { key }), unfiltered: true, go: () => done() }],
        input: (t) => (t.trim() ? { label: tr('Use “{text}”', { text: t.trim() }), hint: '⏎', go: () => done(t.trim()) } : null),
        note: tr('The text the game shows under its name ({key}) — or none', { key })
    };
}

/**
 * "Write a new text…" (a text key's field, FieldDef.loc; `custom_tooltip`): the text typed, written under a text key of
 * the shown entry (`<entry><suffix>`: `my_decision_tooltip`, `my_event_tt`) in the same undo step as the statement (a
 * `loc` create, PickResult.creates). `reuse`: the entry's own key is taken also when it exists (its text changed: a
 * field's key is the entry's, the game's default for it); otherwise the first key no text has (`_2`, `_3` …).
 */
function newTextMenu(s: State, data: PickerData, v: Extract<View, { v: 'newText'; }>): Menu
{
    const base = viewEntry()?.name.replace(/[^\w.-]/g, '_') ?? 'new_text';
    let key = `${base}${v.suffix}`;
    let known: { text?: string; rel?: string; mod?: string; } | null | undefined;

    for (let i = 1; i <= 30; i++)
    {
        const k = i === 1 ? key : `${base}${v.suffix}_${i}`;
        const made = s.creates?.some((c) => c.what === 'loc' && c.key === k);
        const e = made ? undefined : data.locEntry?.(k);

        if (!made && e === undefined && data.locEntry)
            return { title: v.title, items: [{ label: tr('Looking up {key}…', { key: k }), role: 'info' }], wait: data.locEntryLoaded?.(k) };

        if ((v.reuse && i === 1) || (!made && !e))
        {
            key = k;
            known = made ? undefined : e;
            break;
        }
    }

    const done = (text: string): Next => v.then({ ...s, creates: [...(s.creates ?? []).filter((c) => c.key !== key), { what: 'loc', key, fields: [], loc: text }] }, key, text);
    return {
        title: tr('{title}: the text', { title: v.title }),
        typeahead: true,
        wide: true,
        items: known?.text ? [{ label: tr('Keep “{text}”', { text: known.text }), hint: '⏎', title: known.rel, unfiltered: true, go: () => v.then(s, key, tr('Keep')) }] : [{ label: tr('Type the text the game shows'), role: 'info' }],
        input: (t) => (t.trim() ? { label: tr('Use “{text}”', { text: t.trim() }), hint: key, go: () => done(t.trim()) } : null),
        note: tr('Written as {key} in your mod, with the statement (one undo step)', { key })
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
        title: tr('Other setting'),
        typeahead: true,
        wide: true,
        items: (list ?? []).filter((x) => !known.has(x.value)).map((x) => pick(x.value, { hint: x.label })),
        wait: list ? undefined : data.suggestionsLoaded(source),
        input: (text) =>
        {
            const key = nameOf(text);
            return key ? pick(key, { label: tr('Use “{key}”', { key }), hint: tr('as typed') }) : null;
        },
        note: tr('The keys the game’s definitions of this type write — or type one')
    };
}

/**
 * What an "Other setting…" key takes, read from the values the game writes for it: yes / no, a number (a named script
 * value counts as one when most of them are numbers), a quoted text (a file path, a sentence), else a name (an entry, a
 * text key, a flag). Nothing written: unknown.
 */
export function valueKindOf(values: string[]): 'bool' | 'number' | 'quoted' | 'name' | 'unknown'
{
    if (!values.length)
        return 'unknown';

    if (values.every((v) => v === 'yes' || v === 'no'))
        return 'bool';

    const numbers = values.filter((v) => /^-?\d+(\.\d+)?$/.test(v)).length;

    if (numbers === values.length || (numbers * 2 > values.length && values.every((v) => /^-?\d+(\.\d+)?$/.test(v) || /^[\w.:]+$/.test(v))))
        return 'number';

    return values.every((v) => v.startsWith('"')) ? 'quoted' : 'name';
}

/**
 * An "Other setting…" key's value, typed by what the game writes for it (valueKindOf): yes / no; a number (the game's
 * values first, any number typed); a name or a quoted text (the game's values, or typed; a text with spaces is quoted).
 * A written one (`now`) is offered to keep first.
 */
function otherSettingValueMenu(s: State, data: PickerData, key: string, now?: string): Menu
{
    const source = `values:${s.type ?? ''}:${key}`;
    const list = data.suggestions(source);
    const kind = valueKindOf((list ?? []).map((x) => x.value));
    const write = (v: string, label: string): Next => put(s, `${key} = ${v}`, label);
    const keep: Item[] = now !== undefined ? [{ label: tr('Keep: {now}', { now }), hint: '⏎', go: () => write(now, tr('Keep')) }] : [];
    const items: Item[] =
        kind === 'bool' || (kind === 'unknown' && list)
            ? [{ label: tr('Yes'), key: 'y', hint: 'yes', go: () => write('yes', 'yes') }, { label: tr('No'), key: 'n', hint: 'no', go: () => write('no', 'no') }]
            : (list ?? []).map((x) => ({ label: x.value, hint: x.label, go: () => write(x.value, x.value) }));
    const notes: Record<typeof kind, string> = {
        bool: tr('Yes or no, as the game writes it — or type a value'),
        number: tr('A number, as the game writes it — type one (or a script value)'),
        quoted: tr('A quoted text (a file, a path), as the game writes it — or type one'),
        name: tr('A name (an entry, a text key, a flag), as the game writes it — or type one'),
        unknown: tr('Type the value (a number, a name, a text key or { … })')
    };

    return {
        title: now !== undefined ? tr('{key} (now {now})', { key, now }) : `${key} = …`,
        typeahead: true,
        wide: true,
        preview: true,
        items: [...keep, ...items],
        wait: list ? undefined : data.suggestionsLoaded(source),
        number: kind === 'number' ? (n) => [{ label: String(n), hint: '⏎', go: () => write(String(n), String(n)) }] : undefined,
        input: (text) =>
        {
            const t = text.trim();
            // (a text with spaces, or one where the game quotes all of them, is written quoted)
            const v = /^[{"]/.test(t) ? t : /\s/.test(t) || kind === 'quoted' ? `"${t}"` : t;
            return t ? { label: tr('Use “{t}”', { t }), hint: '⏎', go: () => write(v, t) } : null;
        },
        note: notes[kind]
    };
}

/** Doctrine group categories (religion/doctrine_group_types `category`). */
const CATEGORY_LABELS: Record<string, string> = { core_tenets: tr('Tenets'), main_group: tr('Main'), marriage: tr('Marriage'), crimes: tr('Crimes'), clergy: tr('Clergy'), special: tr('Special'), not_creatable: tr('Not creatable') };

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
        title: s.draft.loc.title ?? (s.title ? tr('Add to: {title}', { title: s.title }) : tr('Add a parameter')),
        typeahead: true,
        wide: true,
        items: sorted.map((x) => ({ label: humanize(x.value), hint: mine(x) ? tr('your mod · {label}', { label: x.label ?? '' }) : x.label, match: x.value, sub: true, go: () => go({ ...s, view: { v: 'paramValue', key: x.value } }, humanize(x.value)) })),
        wait: list ? undefined : data.suggestionsLoaded('doctrine_parameters'),
        input: (text) =>
        {
            const name = nameOf(text);
            return name && !list?.some((x) => x.value === name) ? { label: tr('New parameter “{name}”…', { name }), sub: true, go: () => go({ ...s, view: { v: 'paramValue', key: name } }, name) } : null;
        },
        note: tr('The parameters the doctrines use — type to filter, or a new key')
    };
}

/**
 * A doctrine parameter's value: on (the name written bare, as 1.20's own files and _doctrine_types.info write a flag)
 * or no. No number: 1.20 reads numbers from `special_parameters` (_doctrine_types.info: `parameters` holds flags); a
 * written `key = N` is kept, with a note saying so. `bare`: the written one is the bare name; a written `key = yes` is
 * kept as it is, unless changed.
 */
function paramValueMenu(s: State, key: string, now?: string, bare?: boolean): Menu
{
    const number = now !== undefined && /^-?\d+(\.\d+)?$/.test(now);
    const keep: Item[] = bare
        ? [{ label: tr('Keep: on (written bare)'), hint: '⏎', go: () => put(s, key, tr('Keep')) }]
        : now !== undefined ? [{ label: tr('Keep: {now}', { now }), hint: '⏎', go: () => put(s, `${key} = ${now}`, tr('Keep')) }] : [];
    const on: Item[] = bare ? [] : [{ label: tr('On'), hint: key, title: tr('Written bare, as the 1.20 game files write a doctrine’s flags'), go: () => put(s, key, tr('On')) }];
    return {
        title: bare ? tr('{key} (now on)', { key: humanize(key) }) : now !== undefined ? tr('{key} (now {now})', { key: humanize(key), now }) : humanize(key),
        preview: true,
        typeahead: true,
        items: [...keep, ...on, { label: tr('No'), hint: 'no', go: () => put(s, `${key} = no`, tr('No')) }],
        note: number ? tr('1.20 reads numbers from special_parameters, not from here: the card’s “Special values”') : tr('On (written bare) or no')
    };
}

/** Where writing a field's value leads: the statement written (a setting), or back into the block being built. */
type Write = (key: string, value: string, label: string) => Next;

/** A block field's next step: a field it still needs, else its own menu. */
function blockStep(f: FieldDef, values: [string, string][]): View
{
    // (`*`: an entry of any key first, the block's first one: a hostility override's doctrine, a relation)
    const missing = (f.ask ?? []).find((a) => (a === '*' ? !values.length : !values.some(([k]) => k === a)));
    return missing ? { v: 'blockValue', key: f.key, sub: missing, values } : { v: 'block', key: f.key, values };
}

/** `key = { a = 1 b = yes }`; a list's items bare, the entry type's block field telling (`allowed_holding_types = { castle_holding }`) */
function blockText(key: string, values: [string, string][], type?: string): string
{
    const bare = bareKeys(key, type);
    return `${key} = { ${values.map(([k, v]) => (bare.has(k) ? v : `${k} = ${v}`)).join(' ')} }`;
}

/** The fields of a block field's set that are written bare (a list's items: several of them, no key). */
function bareKeys(key: string, type?: string): Set<string>
{
    const sub = type ? (FIELDS[type] ?? []).find((x) => x.key === key)?.sub : undefined;
    return new Set((FIELDS[sub ?? ''] ?? []).filter((x) => x.bare).map((x) => x.key));
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
 * then its fields. Yes/no ones toggle (✓), the others ask their value and come back here.
 */
function blockMenu(s: State, key: string, values: [string, string][]): Menu
{
    const f = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === key);

    if (!f?.sub)
        return { title: key, items: [{ label: tr('Unknown setting'), role: 'info' }] };

    const has = new Map(values);
    // (a toggle changes this menu in place)
    const back = (vals: [string, string][], crumb: string): Next => ({ state: { ...s, view: { v: 'block', key, values: vals } }, crumb, back: 0 });
    const items: Item[] = [{ label: tr('Done'), hint: '⏎', title: blockText(key, values, s.type), go: () => put(s, blockText(key, values, s.type), plainLabel(f.label)) }];

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
            // (a field written as a block (a sound with its parameters): "as written", kept unless a new value is chosen;
            // a list's items: all of them, one more each time)
            const items1 = sf.bare ? values.filter(([k]) => k === sf.key).map(([, v]) => v).join(' ') : undefined;
            items.push({ label: sf.label, key: sf.k, title: sf.help, hint: sf.bare ? items1 || undefined : now?.startsWith('{') ? tr('as written') : now, sub: true, go: () => go({ ...s, view: { v: 'blockValue', key, sub: sf.key, values, from: 'block' } }, plainLabel(sf.label)) });
        }
    }

    // (only its conditions go (FieldDef.conds): a send option's label, an asset's icon and what is kept as written stay)
    const conds = new Set(f.conds ?? []);

    if (values.some(([k]) => conds.has(k)))
        items.push({ label: tr('Clear the conditions'), title: tr('Drop its conditions, keep the rest'), go: () => back(values.filter(([k]) => !conds.has(k)), 'Clear') });

    return { title: plainLabel(f.label), items, preview: true, wide: true, note: tr('⏎ Done · letters toggle / choose · ← back') };
}

/** The value of a block's field: written into the block, which comes back. */
function blockValueMenu(s: State, data: PickerData, key: string, sub: string, values: [string, string][], from?: 'block' | 'blockKey'): Menu
{
    const f = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === key);
    const write: Write = (k, v, label) =>
    {
        // (a list's item: one more, once each; any other field: its one value)
        const vals = bareKeys(key, s.type).has(k) ? (values.some(([kk, vv]) => kk === k && vv === v) ? values : [...values, [k, v] as [string, string]]) : withValue(values, k, v);
        const view = f ? blockStep(f, vals) : ({ v: 'block', key, values: vals } as View);
        // (opened from the block's menu: back into it (past the key menu of an entry of any key); the first field
        // asked: the block's menu opens beside)
        return from && view.v === 'block' ? { state: { ...s, view }, crumb: label, back: from === 'blockKey' ? 2 : 1 } : go({ ...s, view }, label);
    };

    // (an entry of any key (`*`): which one first, then its value; of a set of named fields (a relation): which field)
    if (sub === '*' && f?.sub)
    {
        const next = (name: string, label: string): Next => go({ ...s, view: { v: 'blockValue', key, sub: name, values, from: from ? 'blockKey' : undefined } }, label);
        const fields = FIELDS[f.sub] ?? [];

        if (fields.some((x) => x.key === '*' && x.anyKey))
            return fieldKeyMenu({ ...s, type: f.sub }, data, '*', next);

        return { title: plainLabel(f.label), items: fields.map((x) => ({ label: x.label, key: x.k, title: x.help, sub: true, go: () => next(x.key, plainLabel(x.label)) })), note: tr('Keys: letter = item · ← back') };
    }

    // (a new opinion modifier / parameter instead of an existing one)
    // (a field of its own name, never an entry of any key: `blockKey` does not come here)
    const create = (FIELDS[f?.sub ?? ''] ?? []).find((x) => x.key === sub)?.create;
    const fromBlock = from === 'block' ? from : undefined;
    const onCreate = create
        ? (name?: string): Next => go({ ...s, view: name ? newStep(s, { key, sub, values, from: fromBlock, name, fields: [] }) : { v: 'newName', f: { key, sub, values, from: fromBlock } } }, name ?? plainLabel(create.label))
        : undefined;
    const now = new Map(values).get(sub);

    // (written as a block: Keep (as written) first, then a new value instead of the block)
    if (now?.startsWith('{'))
    {
        const m = fieldValueMenu(s, data, f?.sub ?? '', sub, undefined, undefined, write, onCreate);
        return { ...m, title: tr('{name} (now as written)', { name: m.title }), items: [{ label: tr('Keep as written'), hint: '⏎', title: `${sub} = ${now}`, go: () => write(sub, now, 'Keep') }, ...m.items] };
    }

    return fieldValueMenu(s, data, f?.sub ?? '', sub, now, undefined, write, onCreate);
}

/** A duration written as a range: `{ 6 12 }` (between 6 and 12 of the unit, the game picks). */
const RANGE = /^\{\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*\}$/;

/** "6–12 months" (a whole text per unit, so a language can word it; another unit as the script writes it) */
function rangeLabel(lo: string | number, hi: string | number, unit: string): string
{
    const v = { lo: String(lo), hi: String(hi) };
    return unit === 'days' ? tr('{lo}–{hi} days', v) : unit === 'months' ? tr('{lo}–{hi} months', v) : unit === 'years' ? tr('{lo}–{hi} years', v) : `${lo}–${hi} ${unit}`;
}

/** The steps for each unit of "A random time between…": the lowest from these, then the highest above it. */
const RANGE_STEPS: Record<'days' | 'months' | 'years', number[]> = { days: [5, 10, 15, 30, 60, 90], months: [1, 2, 3, 6, 12, 24], years: [1, 2, 3, 5, 10] };

/**
 * "A random time between…" of a duration field that takes a range (FieldDef.range: an on_action's delay) or, `param`,
 * of the pending statement's duration parameter (DurationParam.range: trigger_event's delay): the unit, then the
 * lowest, then the highest (above the lowest), written `months = { 6 12 }`.
 */
function durationRangeMenu(s: State, key: string, unit?: 'days' | 'months' | 'years', lo?: number, param?: boolean): Menu
{
    const f = param ? undefined : fieldOf(s.type ?? '', key);

    if (!f && !param)
        return { title: key, items: [{ label: tr('Unknown setting'), role: 'info' }] };

    const units: ['days' | 'months' | 'years', string, string][] = [['days', tr('Days'), 'd'], ['months', tr('Months'), 'm'], ['years', tr('Years'), 'y']];
    const view = (extra: { unit?: 'days' | 'months' | 'years'; lo?: number; }): View => ({ v: 'durationRange', key, ...extra, ...(param ? { param } : {}) });

    if (!unit)
        return {
            title: tr('A random time between… in'),
            preview: true,
            items: units.map(([u, label, k]) => ({ label, key: k, hint: u, sub: true, go: () => go({ ...s, view: view({ unit: u }) }, label) }))
        };

    if (lo === undefined)
    {
        const low = (n: number, extra: Partial<Item> = {}): Item => ({ label: durationLabel(n, unit), sub: true, ...extra, go: () => go({ ...s, view: view({ unit, lo: n }) }, durationLabel(n, unit)) });
        return {
            title: tr('At least how long?'),
            preview: true,
            typeahead: true,
            items: RANGE_STEPS[unit].slice(0, -1).map((n) => low(n)),
            number: (n) => (n >= 0 && Number.isInteger(n) ? [low(n, { hint: '⏎' })] : []),
            note: unit === 'days' ? tr('Type a number: the shortest time, in days') : unit === 'months' ? tr('Type a number: the shortest time, in months') : tr('Type a number: the shortest time, in years')
        };
    }

    const high = (n: number, extra: Partial<Item> = {}): Item => ({ label: rangeLabel(lo, n, unit), ...extra, go: () => (f ? put(s, `${durationKey(f, unit)} = { ${lo} ${n} }`, rangeLabel(lo, n, unit)) : go(answer({ ...s, view: { v: 'param' } }, `${unit} = { ${lo} ${n} }`), rangeLabel(lo, n, unit))) });
    return {
        title: tr('At most how long? (more than {lo})', { lo: durationLabel(lo, unit) }),
        preview: true,
        typeahead: true,
        items: RANGE_STEPS[unit].filter((n) => n > lo).map((n) => high(n)),
        // (the highest above the lowest: an equal or lower one is no range)
        number: (n) => (n > lo && Number.isInteger(n) ? [high(n, { hint: '⏎' })] : []),
        note: unit === 'days' ? tr('Type a number above {lo}, in days', { lo }) : unit === 'months' ? tr('Type a number above {lo}, in months', { lo }) : tr('Type a number above {lo}, in years', { lo })
    };
}

function fieldValueMenu(s: State, data: PickerData, set: string, key: string, now?: string, unit?: string, write?: Write, onCreate?: (name?: string) => Next): Menu
{
    // (a key that is any entry (a compatibility's trait), a track's level: the set's field for it)
    const f: FieldDef | undefined = (FIELDS[set] ?? []).find((x) => x.key === key) ?? fieldOf(set, key);

    if (!f)
        return { title: key, items: [{ label: tr('Unknown setting'), role: 'info' }] };

    // written `key = value`; a list's item alone (`craven`), a level as the block it opens (`50 = { }`)
    const plain: Write = write ?? ((k, v, label) => put(s, f.bare ? v : f.kind === 'level' ? `${v} = { }` : `${k} = ${v}`, label));
    // (an entry limited to a DLC where the game takes one with a fallback (a faith's tenet): asked next)
    const flags = f.dlcPair && !write && f.ref ? data.dlcFlags?.(f.ref) : undefined;
    const put0: Write = flags ? (k, v, label) => (flags[v] ? go({ ...s, view: { v: 'dlcPair', set, key: k, value: v, label } }, label) : plain(k, v, label)) : plain;
    // (a value written into a block of its own, FieldDef.wrap: a random list's trait `brave = { weight = { base = 10 } }`)
    const put1: Write = f.wrap ? (k, v, label) => put0(k, f.wrap!.replace('$', v), label) : put0;
    const name = f.anyKey ? humanize(key) : plainLabel(f.label);
    const title = now !== undefined ? tr('{name} (now {now}{unit})', { name, now, unit: unit ? ' ' + unit : '' }) : name;
    // changing a written one: the same again (duration fields keep their unit)
    const keep: Item[] = now !== undefined ? [{ label: tr('Keep: {now}{unit}', { now, unit: unit ? ' ' + unit : '' }), hint: '⏎', go: () => put1(unit ? durationKey(f, unit) : key, now, 'Keep') }] : [];

    if (f.kind === 'bool')
    {
        return { title, preview: true, items: [...keep, { label: tr('Yes'), key: 'y', go: () => put1(key, 'yes', 'Yes') }, { label: tr('No'), key: 'n', go: () => put1(key, 'no', 'No') }] };
    }

    if (f.kind === 'choice')
    {
        return { title, preview: true, items: [...keep, ...(f.options ?? []).map(([v, l]) => ({ label: l, hint: v, go: () => put1(key, v, l) }))] };
    }

    if (f.kind === 'duration')
    {
        const item = (n: number, u: string, extra: Partial<Item> = {}): Item => ({ label: durationLabel(n, u), go: () => put1(durationKey(f, u), String(n), durationLabel(n, u)), ...extra });
        // (a range written, `months = { 6 12 }`: kept as it is; a field that takes one offers it (an on_action's delay))
        const range = now && unit ? RANGE.exec(now) : null;
        const keepRange: Item[] = range ? [{ ...keep[0], label: tr('Keep: {range}', { range: rangeLabel(range[1], range[2], unit!) }) }] : keep;
        const between: Item[] = f.range && !write
            ? [{ label: tr('A random time between…'), sub: true, title: tr('months = { 6 12 }: the game picks a time between the two'), go: () => go({ ...s, view: { v: 'durationRange', key: f.key } }, tr('Between')) }]
            : [];
        return {
            title: range ? tr('{name} (now {range})', { name, range: rangeLabel(range[1], range[2], unit!) }) : title,
            preview: true,
            typeahead: true,
            items: [...keepRange, ...(f.presets ?? [1, 5]).map((n) => item(n, 'years')), item(6, 'months'), item(3, 'months'), item(30, 'days'), ...between],
            number: (n) => (['years', 'months', 'days'] as const).slice().sort((a, b) => Number(b === unit) - Number(a === unit)).map((u) => item(n, u, { hint: u })),
            note: tr('Type a number: years, months or days')
        };
    }

    // "New …" first; entries made on the way, then the active mod's, then the rest (most used first)
    const made = (s.creates ?? []).filter((c) => c.what === f.create?.what);
    const fresh: Item[] = [
        ...(onCreate && f.create ? [{ label: f.create.label, key: '+', sub: true, go: () => onCreate() } as Item] : []),
        ...made.map((c) => ({ label: c.loc || humanize(c.key), hint: tr('{key} · new', { key: c.key }), match: c.key, go: () => put1(key, c.key, c.key) }))
    ];
    const typed = (name: string, known: boolean): Item | null => !name ? null : onCreate && !known ? { label: tr('New “{name}”…', { name }), sub: true, hint: tr('make it'), go: () => onCreate(name) } : { label: tr('Use “{name}”', { name }), hint: tr('as typed'), go: () => put1(key, name, name) };

    // a character (father, mother): the active mod's listed, any found by name, house or id as one types
    if (f.ref && data.big(f.ref))
    {
        const type = f.ref;
        const all = data.list(type);
        const active = data.activeMod()?.toLowerCase();
        const own = (all ?? []).filter((e) => !!active && !!e.mod && e.mod.state !== 'removed' && e.mod.mods.some((m) => m.toLowerCase() === active));
        const row = (e: RefEntry, mine: boolean): Item =>
        {
            const label = e.display && e.display !== e.name ? e.display : e.name;
            return { label, hint: mine ? tr('your mod · {name}', { name: e.name }) : (e.about ?? e.name), title: e.about, match: `${e.name} ${label}`, icon: e.icon, entry: { type, name: e.name }, go: () => put1(key, e.name, label) };
        };
        return {
            title,
            preview: true,
            typeahead: true,
            wide: true,
            items: [...keep, ...fresh, ...own.map((e) => row(e, true))],
            wait: all ? undefined : data.loaded(type),
            search: async (q) =>
            {
                // (accents and case aside, like the main side's search the other rows come from)
                const t = fold(q.trim());
                const mine = own.filter((e) => foldHas(e.name, t) || foldHas(e.display, t));
                const found = (await data.search(type, q)).filter((e) => !mine.some((m) => m.name === e.name));
                return [...mine.map((e) => row(e, true)), ...found.map((e) => row(e, false))];
            },
            input: (text) => typed(nameOf(text), true),
            note: tr('Your mod’s characters — type a name, house or id to search all')
        };
    }

    if (f.kind === 'text')
    {
        const list = f.suggest ? data.suggestions(f.suggest) : undefined;
        const active = data.activeMod()?.toLowerCase();
        const mine = (x: FieldSuggestion): boolean => !!active && !!x.mods?.some((m) => m.toLowerCase() === active);
        const sorted = [...(list ?? []).filter(mine), ...(list ?? []).filter((x) => !mine(x))];
        // (a text key (FieldDef.loc): its text written new, under the entry's own key, first)
        const writeText: Item[] = f.loc !== undefined && !write
            ? [{ label: tr('Write a new text…'), key: 'w', sub: true, title: tr('Type the text the game shows; it is written as a text key of this entry in your mod'), go: () => go({ ...s, view: { v: 'newText', suffix: f.loc!, reuse: true, title: name, then: (st, k2, label) => put(st, `${key} = ${k2}`, label) } }, tr('New text')) }]
            : [];
        return {
            title,
            preview: true,
            typeahead: true,
            wide: true,
            items: [...writeText, ...keep, ...fresh, ...sorted.map((x) => ({ label: humanize(x.value), hint: mine(x) ? tr('your mod · {label}', { label: x.label ?? '' }) : x.label, match: `${x.value} ${x.label ?? ''}`, icon: x.image, image: x.image, go: () => put1(key, x.value, humanize(x.value)) }))],
            wait: f.suggest && !list ? data.suggestionsLoaded(f.suggest) : undefined,
            input: (text) =>
            {
                // (a name as typed: spaces and letters of any language kept, quoted)
                if (f.free)
                {
                    const t = text.trim().replace(/"/g, '');
                    // (bare: a plain name, or a script constant `@holding_illustration_norse` as the game writes it)
                    return t ? { label: tr('Use “{t}”', { t }), hint: tr('as typed'), go: () => put1(key, /^@?[A-Za-z0-9_]+$/.test(t) ? t : `"${t}"`, t) } : null;
                }

                const name = nameOf(text);
                return typed(name, !!list?.some((x) => x.value === name) || made.some((c) => c.key === name));
            },
            note: onCreate ? tr('Type to filter — or a new key to make one') : tr('Type to filter, or a new name')
        };
    }

    // entries of an index type: a trait of a character, a script value in a formula, an opinion modifier
    // (a field of one tier of titles: only its keys, `c_` for a holy site's county)
    const listed = f.ref ? data.list(f.ref) : undefined;
    const all = f.ref ? modFirst(f.prefix && listed ? listed.filter((e) => e.name.startsWith(f.prefix!)) : listed, data) : undefined;
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
            note: tr('A group, or type to find any')
        };
    }

    if (f.kind === 'ref')
    {
        // (a setting of its own naming an entry: "＋ New trait…"; not inside a block, whose fields make their own)
        const extra = !write && !onCreate && f.ref ? newRefRows(s, data, f.ref, { to: 'field', key }) : { items: [] };
        const dlc = dlcGrouping(data, f.ref, entries, onCreate ? tr('Your mod’s first — type to filter, or a new key to make one') : tr('Your mod’s first, then the most used — type to filter'));
        return {
            title,
            preview: true,
            typeahead: true,
            wide: true,
            groupable: dlc.groupable,
            items: [...keep, ...fresh, ...extra.items, ...dlc.items],
            // (the DLC flags too where an entry of a DLC is asked about next)
            wait: wait ?? dlc.wait ?? extra.wait ?? (f.dlcPair && !write && f.ref && !flags ? data.dlcFlagsLoaded?.(f.ref) : undefined),
            input: (text) =>
            {
                const name = nameOf(text);
                return typed(name, !!list?.some((e) => e.name === name) || made.some((c) => c.key === name));
            },
            note: dlc.note
        };
    }

    const label = (n: number): string => `${f.signed && n > 0 ? '+' : ''}${n}`;
    const item = (n: number, extra: Partial<Item> = {}): Item => ({ label: label(n), go: () => put1(key, String(n), label(n)), ...extra });
    // (the named values the game writes for it: slow_construction_time …)
    // (not where `suggest` names the keys: an entry of any key, fieldKeyMenu)
    const named = f.suggest && !f.anyKey ? data.suggestions(f.suggest) : undefined;
    const namedItems: Item[] = (named ?? []).filter((x) => !/^-?[\d.]+$/.test(x.value)).map((x) => ({ label: humanize(x.value), hint: x.label ?? x.value, match: x.value, go: () => put1(key, x.value, humanize(x.value)) }));
    return {
        title,
        preview: true,
        typeahead: true,
        wide: entries.length > 0 || namedItems.length > 0,
        wait: wait ?? (f.suggest && !f.anyKey && !named ? data.suggestionsLoaded(f.suggest) : undefined),
        items: [...keep, ...(f.presets ?? []).map((n) => item(n)), ...namedItems, ...entries],
        // (a field that takes only whole numbers from a value up: parameter_opinion_override's, the .info: 0 is ignored)
        number: (n) => (f.wholeFrom !== undefined && (!Number.isInteger(n) || n < f.wholeFrom) ? [{ label: tr('Only whole numbers from {min} up', { min: f.wholeFrom }), role: 'info' }] : [item(n, { hint: '⏎' })]),
        input: (text) =>
        {
            const name = nameOf(text);
            return name && !/^-?[\d.]+$/.test(name) ? { label: tr('Use “{name}”', { name }), hint: tr('script value'), go: () => put1(key, name, name) } : null;
        },
        note: tr('Type a number')
    };
}

// ---------------------------------------------------------------------------
// Entries limited to a DLC: only with it, or with a fallback (docs/picker.md, "Only with a DLC")
// ---------------------------------------------------------------------------

/** Entries of a type for a fallback: those without a DLC first (the active mod's first among them), the chosen one left out. */
function fallbackItems(data: PickerData, type: string, not: string, pick: (name: string, label: string) => Next): { items: Item[]; wait?: Promise<unknown>; }
{
    const list = modFirst(data.list(type), data);
    const flags = data.dlcFlags?.(type) ?? {};
    const rows = (list ?? []).filter((e) => e.name !== not);
    const free = rows.filter((e) => !flags[e.name]);
    const limited = rows.filter((e) => flags[e.name]);
    const item = (e: RefEntry): Item => ({
        label: e.display && e.display !== e.name ? e.display : e.name,
        hint: flags[e.name] ? `${e.name} · ${flags[e.name].dlc}` : entryHint(e, data),
        icon: e.icon,
        match: e.name,
        entry: { type, name: e.name },
        go: () => pick(e.name, e.display ?? e.name)
    });
    return { items: [...free.map(item), ...limited.map(item)], wait: list ? undefined : data.loaded(type) };
}

/**
 * A field's entry limited to a DLC where the game takes it with a fallback (FieldDef.dlcPair, a faith's or rite's
 * tenet: `tenet_selection_pair = { requires_dlc_flag = by_god_alone tenet = x fallback_tenet = y }`, written next to
 * the list): always (as picked), only with the DLC, or with the DLC and else another one.
 */
function dlcPairMenu(s: State, data: PickerData, v: Extract<View, { v: 'dlcPair'; }>): Menu
{
    const f = (FIELDS[v.set] ?? []).find((x) => x.key === v.key) ?? fieldOf(v.set, v.key);
    const pair = f?.dlcPair;
    const info = f?.ref ? data.dlcFlags?.(f.ref)?.[v.value] : undefined;

    if (!f || !pair || !info)
        return { title: v.label, items: [{ label: tr('Not limited to a DLC'), role: 'info' }] };

    // (a statement of its own next to the list: finished right away; the rest of the draft would go there too)
    const write = (fallback?: string): Next =>
    {
        const text = `${pair.key} = {
	requires_dlc_flag = ${info.flag}
	${pair.item} = ${v.value}${
            fallback ?
                `
	${pair.fallback} = ${fallback}` :
                ''
        }
}`;
        let d = s.draft;

        for (const n of parseSnippet(text))
            d = insert(d, n);

        return { finish: true, state: { ...s, draft: d, chain: [], pending: undefined, view: { v: 'cont' }, outside: true } };
    };

    if (v.fallback)
    {
        const rows = fallbackItems(data, f.ref!, v.value, (name) => write(name));
        return { title: tr('Without {dlc}: which instead?', { dlc: info.dlc }), preview: true, typeahead: true, wide: true, items: rows.items, wait: rows.wait, note: tr('Those of every game first — type to filter') };
    }

    return {
        title: tr('{label} comes with {dlc}', { label: v.label, dlc: info.dlc }),
        preview: true,
        items: [
            { label: tr('Always'), hint: '⏎', title: tr('Written as picked, whatever DLCs a player has'), go: () => put(s, f.bare ? v.value : `${v.key} = ${v.value}`, v.label) },
            { label: tr('Only with {dlc}', { dlc: info.dlc }), key: 'o', title: `${pair.key} = { requires_dlc_flag = ${info.flag} … }: none without the DLC`, go: () => write() },
            { label: tr('With {dlc}, otherwise…', { dlc: info.dlc }), key: 'w', sub: true, title: tr('{key} with {fallback}: another one for players without the DLC', { key: pair.key, fallback: pair.fallback }), go: () => go({ ...s, view: { ...v, fallback: true } }, tr('Otherwise')) }
        ]
    };
}

/** The entry limited to a DLC that the effect built last names, and its flag; 'wait' while the flags load. */
function lastDlcRef(s: State, data: PickerData): { ref: NonNullable<State['lastRef']>['refs'][number]; flag: string; dlc: string; } | 'wait' | undefined
{
    if (!s.lastRef || !data.dlcFlags || s.draft.loc.kind !== 'effect')
        return undefined;

    for (const ref of s.lastRef.refs)
    {
        const flags = data.dlcFlags(ref.type);

        if (!flags)
            return 'wait';

        if (flags[ref.value])
            return { ref, ...flags[ref.value] };
    }

    return undefined;
}

/** "What next?" with "Only with <DLC>…" after an effect naming an entry limited to a DLC. */
function dlcOffer(s: State, data: PickerData, menu: Menu): Menu
{
    const found = lastDlcRef(s, data);

    if (found === 'wait')
        return { ...menu, wait: menu.wait ?? data.dlcFlagsLoaded?.(s.lastRef!.refs[0].type) };

    if (!found)
        return menu;

    const item: Item = { label: tr('Only with {dlc}…', { dlc: found.dlc }), key: 'd', sub: true, title: tr('{entry} comes with {dlc}: only for players with it, or something else for the others', { entry: found.ref.value, dlc: found.dlc }), go: () => go({ ...s, view: { v: 'dlcWrap' } }, tr('Only with {dlc}', { dlc: found.dlc })) };
    const i = menu.items.findIndex((x) => x.role === 'done');
    return { ...menu, items: [...menu.items.slice(0, i + 1), item, ...menu.items.slice(i + 1)] };
}

/**
 * The effect built last under `if = { limit = { has_dlc_feature = <flag> } … }` (the flags are the features' names),
 * and (`fallback`) the same effect with another entry in its `else`.
 */
function dlcWrapMenu(s: State, data: PickerData, fallback?: boolean): Menu
{
    const found = lastDlcRef(s, data);

    if (!found || found === 'wait' || !s.lastRef)
        return { title: tr('Only with a DLC'), items: [{ label: tr('Nothing here comes with a DLC'), role: 'info' }] };

    const { p } = s.lastRef;
    const at = blockAt(structuredClone(s.draft.top), s.draft.loc.path).length - 1;
    const wrap = (other?: string): Next =>
    {
        const { d } = wrapAll(s.draft, (kids) => ({ k: 'if', op: '=', kids: [{ k: 'limit', op: '=', kids: [{ k: 'has_dlc_feature', op: '=', v: found.flag }] }, ...kids] }), at);

        if (other)
        {
            const values = { ...p.values, [found.ref.name]: found.ref.prefix + other };

            if (p.def.subjectValue)
                values.subject = chainExpr(p.chain) || 'this';

            blockAt(d.top, d.loc.path).push({ k: 'else', op: '=', kids: statementNodes(p, values) });
        }

        return go({ ...s, draft: d, view: { v: 'cont' }, lastRef: undefined }, other ? tr('Otherwise {other}', { other }) : tr('Only with {dlc}', { dlc: found.dlc }));
    };

    if (fallback)
    {
        const rows = fallbackItems(data, found.ref.type, found.ref.value, (name) => wrap(name));
        return { title: tr('Without {dlc}: which instead?', { dlc: found.dlc }), preview: true, typeahead: true, wide: true, items: rows.items, wait: rows.wait, note: tr('Those of every game first — type to filter') };
    }

    return {
        title: tr('{entry} comes with {dlc}', { entry: found.ref.value, dlc: found.dlc }),
        preview: true,
        items: [
            { label: tr('Only with {dlc}', { dlc: found.dlc }), key: 'o', title: `if = { limit = { has_dlc_feature = ${found.flag} } … }`, go: () => wrap() },
            { label: tr('With {dlc}, otherwise…', { dlc: found.dlc }), key: 'w', sub: true, title: 'The same with another entry for players without it (else = { … })', go: () => go({ ...s, view: { v: 'dlcWrap', fallback: true } }, tr('Otherwise')) }
        ]
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
        title: c ? plainLabel(c.label) : tr('New'),
        typeahead: true,
        wide: true,
        items: [{ label: c?.what === 'opinion_modifiers' ? tr('Type its key, e.g. {example}', { example: 'my_respect_opinion' }) : tr('Type its key, e.g. {example}', { example: 'allows_my_marriage' }), role: 'info' }],
        input: (text) =>
        {
            const name = nameOf(text).toLowerCase();

            if (!name)
                return null;

            if (existing.has(name) || s.creates?.some((x) => x.key === name))
                return { label: tr('“{name}” exists already', { name }), role: 'info' };

            return { label: tr('Create “{name}”…', { name }), sub: true, go: () => go({ ...s, view: newStep(s, { ...f, name, fields: [] }) }, name) };
        },
        note: tr('Letters, digits, _, . and - — the key the script uses')
    };
}

/** The new entry's menu: Done (back into the block, the entry remembered for making), its settings, its text in game. */
function newEntryMenu(s: State, ctx: NewCtx): Menu
{
    const c = createOf(s, ctx);

    if (!c)
        return { title: ctx.name, items: [{ label: tr('Unknown'), role: 'info' }] };

    const has = new Map(ctx.fields);
    const here = (next: NewCtx, crumb: string): Next => ({ state: { ...s, view: { v: 'newEntry', ctx: next } }, crumb, back: 0 });
    const done = (): Next =>
    {
        const block = (FIELDS[s.type ?? ''] ?? []).find((x) => x.key === ctx.key);
        const values = withValue(ctx.values, ctx.sub, ctx.name);
        const creates = [...(s.creates ?? []).filter((x) => x.key !== ctx.name), { what: c.what, key: ctx.name, fields: ctx.fields, loc: ctx.loc }];
        const view = block ? blockStep(block, values) : ({ v: 'block', key: ctx.key, values } as View);
        // (back into the block's menu it came from: 3 menus up (the field's value, the name, this one))
        return ctx.from === 'block' && view.v === 'block' ? { state: { ...s, creates, view }, crumb: ctx.name, back: 3 } : go({ ...s, creates, view }, ctx.name);
    };
    const items: Item[] = [{ label: tr('Done — make “{name}”', { name: ctx.name }), hint: '⏎', go: done }];

    for (const sf of FIELDS[c.fields] ?? [])
    {
        const now = sf.kind === 'duration' ? ctx.fields.find(([k]) => /^(delay_)?(days|months|years)$/.test(k) && k.startsWith(sf.key === 'delay' ? 'delay_' : ''))?.join(' ') : has.get(sf.key);

        if (sf.kind === 'bool')
        {
            const on = now === 'yes';
            items.push({ label: `${on ? '✓ ' : ''}${sf.label}`, key: sf.k, title: sf.help, hint: on ? 'yes' : undefined, go: () => here({ ...ctx, fields: withValue(ctx.fields, sf.key, on ? null : 'yes') }, sf.label) });
        }
        else
            items.push({ label: sf.label, key: sf.k, title: sf.help, hint: now, sub: true, go: () => go({ ...s, view: { v: 'newValue', ctx, field: sf.key } }, plainLabel(sf.label)) });
    }

    items.push({ label: c.locLabel, key: 'z', hint: ctx.loc, sub: true, go: () => go({ ...s, view: { v: 'newLoc', ctx } }, tr('In game')) });
    return { title: `${plainLabel(c.label)}: ${ctx.name}`, items, preview: true, wide: true, note: tr('⏎ make it · letters toggle / choose · ← back') };
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
    const set = (text: string): Next => ({ state: { ...s, view: { v: 'newEntry', ctx: { ...ctx, loc: text } } }, crumb: tr('In game'), back: 1 });
    const locLabel = createOf(s, ctx)?.locLabel;
    return {
        title: locLabel ? plainLabel(locLabel) : tr('In game'),
        typeahead: true,
        wide: true,
        items: ctx.loc ? [{ label: tr('Keep: {loc}', { loc: ctx.loc }), hint: '⏎', unfiltered: true, go: () => set(ctx.loc!) }] : [{ label: tr('Type the text'), role: 'info' }],
        input: (text) => (text.trim() ? { label: tr('Use “{text}”', { text: text.trim() }), hint: '⏎', go: () => set(text.trim()) } : null),
        note: tr('What the game shows for it')
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
    { id: 'names', label: tr('Names…'), k: 'n', re: /^Get(First|Titled|Full|Short|UI|Name|BaseName|TitleAs|NamePossessive|Desc)/ },
    { id: 'words', label: 'Pronouns & words (she/he, her/his …)…', k: 'p', re: /^Get(She|Her|His|Him|Woman|Women|Man|Men|Daughter|Son|Wife|Husband|Mother|Father|Sister|Brother|Lady|Lord|Girl|Boy|Queen|King|Niece|Nephew|Aunt|Uncle|Grand|Mistress|Master)[A-Z|]?/ },
    { id: 'faith', label: tr('Faith & culture…'), k: 'f', re: /^Get(Faith|Religion|Culture)/ },
    { id: 'family', label: tr('Family, liege & court…'), k: 'r', re: /^Get(House|Dynasty|Father|Mother|Spouse|PrimarySpouse|Heir|PlayerHeir|Liege|DeJureLiege|TopLiege|Employer|Host|Court|Councillor|Betrothed|Concubine)\b|^Get(House|Dynasty)/ },
    { id: 'titles', label: tr('Titles & places…'), k: 't', re: /^Get(PrimaryTitle|Title|Capital|CurrentLocation|Location|Holding|Realm|County|Barony|Council|Diarch|Domicile|Government)/ },
    { id: 'other', label: tr('Everything else…'), k: 'e', re: /./ }
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
        return fmt === 'U' ? tr('{first}{rest} (capitalized)', { first: pair.charAt(0).toUpperCase(), rest: pair.slice(1) }) : pair;
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
    return fmt === 'U' ? tr('{t} (capitalized)', { t }) : fmt === 'l' ? tr('{t} (lower case)', { t }) : fmt ? `${t} (|${fmt})` : t;
}

function locRoot(s: State): Menu
{
    return {
        title: s.title ? tr('Insert into {title}', { title: s.title }) : tr('Insert a text code'),
        items: [
            { label: tr('Someone’s name, pronoun, faith …'), key: 'c', sub: true, go: () => go({ ...s, view: { v: 'locWho' } }, tr('Someone')) },
            { label: tr('A concept link…'), key: 'k', sub: true, title: tr('[faith|E] — the game underlines it and explains it on hover'), go: () => go({ ...s, view: { v: 'locConcept' } }, tr('Concept')) },
            { label: tr('An icon…'), key: 'i', sub: true, title: '@gold_icon!', go: () => go({ ...s, view: { v: 'locIcon' } }, tr('Icon')) },
            { label: tr('Formatting…'), key: 'f', sub: true, title: '#P positive#!, #N negative#!, #bold …#!', go: () => go({ ...s, view: { v: 'locFormat' } }, tr('Formatting')) },
            // (the editor shows line breaks as they read; saved as \n)
            { label: tr('Line break'), key: 'b', hint: '\\n', go: () => code(s, '\n') }
        ],
        note: tr('Keys: letter = item · type to filter · ← back · Esc close')
    };
}

function locWho(s: State): Menu
{
    const pick = (prefix: string, label: string): Item => ({ label, hint: prefix, sub: true, go: () => go({ ...s, view: { v: 'locFn', prefix } }, label) });
    return {
        title: tr('Whose?'),
        items: [pick('ROOT.Char', tr('You — the event’s character (ROOT)')), ...(s.scopes ?? []).map((x) => pick(x, humanize(x)))],
        input: (text) =>
        {
            const name = nameOf(text).replace(/^scope:/, '');
            return name ? pick(name, tr('Saved scope “{name}”', { name })) : null;
        },
        note: tr('The event’s saved scopes are listed; or type one')
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
        // (the game's docs know a function by its type: ROOT.Char is a Character; a chain of several, or another prefix
        // whose type is not known here, is left without one)
        const fn = c.split('|')[0];
        const doc: Item['doc'] = prefix === 'ROOT.Char' && /^\w+$/.test(fn) ? { kind: 'data_function', key: `Character.${fn}` } : undefined;
        return { label: chainLabel2(c), hint: ex ? `“${ex}”` : `${n}×`, title: tr('{example}{n}× in the game’s texts', { example: ex ? tr('e.g. “{ex}” (William of Normandy, 1066) · ', { ex }) : '', n }), match: c, doc, go: () => code(s, `[${prefix}.${c}]`) };
    };

    if (!group)
    {
        const items: Item[] = LOC_GROUPS.filter((g) => !codes || codes.functions.some(([c]) => locGroupOf(c) === g.id)).map((g) => ({ label: g.label, key: g.k, sub: true, go: () => go({ ...s, view: { v: 'locFn', prefix, group: g.id } }, plainLabel(g.label)) }));
        items.push({ label: tr('All codes…'), key: 'a', sub: true, go: () => go({ ...s, view: { v: 'locFn', prefix, group: '' } }, tr('All')) });
        return { title: prefix === 'ROOT.Char' ? tr('You') : humanize(prefix), items, wait: codes ? undefined : data.locCodesLoaded(), note: tr('Most used in the game first') };
    }

    const groupLabel = LOC_GROUPS.find((g) => g.id === group)?.label;

    return {
        title: groupLabel ? plainLabel(groupLabel) : tr('All codes'),
        typeahead: true,
        wide: true,
        preview: true,
        items: codes ? fns.map(item) : [{ label: tr('Reading the game’s texts…'), role: 'info' }],
        wait: codes ? undefined : data.locCodesLoaded(),
        input: (text) =>
        {
            const c = text.trim().replace(/^\[|\]$/g, '');
            return /^Get\w/.test(c) ? { label: tr('Use [{prefix}.{c}]', { prefix, c }), go: () => code(s, `[${prefix}.${c}]`) } : null;
        },
        note: tr('Type to filter — or a function (GetFirstName)')
    };
}

function locConceptMenu(s: State, data: PickerData): Menu
{
    const codes = data.locCodes();
    return {
        title: tr('Concept'),
        typeahead: true,
        wide: true,
        preview: true,
        items: codes ? codes.concepts.map((c) => ({ label: c.label, hint: `${c.key} · ${c.count}×`, match: c.key, go: () => code(s, `[${c.key}|E]`) })) : [{ label: tr('Reading the game’s texts…'), role: 'info' }],
        wait: codes ? undefined : data.locCodesLoaded(),
        note: tr('Written [key|E]: underlined, explained on hover')
    };
}

function locIconMenu(s: State, data: PickerData): Menu
{
    const codes = data.locCodes();
    return {
        title: tr('Icon'),
        typeahead: true,
        wide: true,
        preview: true,
        items: codes ? codes.icons.map(([i, n]) => ({ label: humanize(i.replace(/_icon$/, '')), hint: `@${i}! · ${n}×`, match: i, icon: codes.iconImages?.[i], go: () => code(s, `@${i}!`) })) : [{ label: tr('Reading the game’s texts…'), role: 'info' }],
        wait: codes ? undefined : data.locCodesLoaded()
    };
}

/** What the common formatting codes do (the rest: their code). */
const FORMAT_LABELS: Record<string, string> = {
    P: tr('Positive (green)'),
    N: tr('Negative (red)'),
    V: tr('Value'),
    EMP: tr('Emphasis'),
    bold: tr('Bold'),
    italic: tr('Italic'),
    I: tr('Italic (short)'),
    weak: tr('Weak (dim)'),
    high: tr('High (bright)'),
    low: tr('Low'),
    F: tr('Flavor text'),
    T: tr('Title'),
    X: tr('Bad value'),
    S: tr('Small')
};

function locFormatMenu(s: State, data: PickerData): Menu
{
    const codes = data.locCodes();
    const list = codes?.formats ?? Object.keys(FORMAT_LABELS).map((k) => [k, 0] as [string, number]);
    return {
        title: tr('Formatting'),
        typeahead: true,
        preview: true,
        items: list.map(([f, n]) => ({ label: FORMAT_LABELS[f] ?? '#' + f, hint: `#${f} … #!${n ? ` · ${n}×` : ''}`, match: f, go: () => code(s, `#${f} #!`, f.length + 2) })),
        note: tr('Wraps the selected text; else the cursor goes between')
    };
}
