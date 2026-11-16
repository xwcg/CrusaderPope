/** Types shared between the main process, the index worker and the renderer. */
import type { DbEntry, DbKind, ScriptDbStatus, ScriptDbUpdateResult, ScriptFacts } from './scriptFacts.ts';

/** Graphics quality of the 3D views (renderer graphics.ts): a preset, each value overridable (absent = the preset's). */
export interface GraphicsSettings
{
    preset?: 'low' | 'medium' | 'high';
    /** render resolution: × the display's pixel ratio (viewers: 2 = supersampled; the map uses at most 1) */
    renderScale?: number;
    /** MSAA edge smoothing */
    antialias?: boolean;
    /** anisotropic texture filtering (1–16) */
    anisotropy?: number;
    /** trees, cliffs, bridges, cities on the 3D map */
    mapObjects?: boolean;
    /** shadows in the portrait and model viewers */
    shadows?: boolean;
}

export interface Settings
{
    graphics?: GraphicsSettings;
    /** false: the first-run wizard shows (nothing indexed until it is done); absent = set up */
    setupDone?: boolean;
    /** CK3 install dir (the folder containing `game/`), or the `game` folder itself. */
    gameDir: string;
    /** the content language: the game's localization shown (l_english …) */
    language: string;
    /** the app's own texts (only 'en' so far; absent = en) */
    appLanguage?: string;
    /** image decoding threads; 0 or absent = one per CPU core */
    imageWorkers?: number;
    /** script parsing threads of an index build (takes effect at the next build): 0 or absent = automatic, -1 = off (parsed on the index worker's own thread), else the number */
    parseThreads?: number;
    /** keep the parsed index on disk and load it at startup while the game files are unchanged (absent = on) */
    indexCache?: boolean;
    /** how many mod lists' index caches are kept (1 to 8, absent = 3; shared/indexCaches.ts): switching back to one loads it */
    indexCachesKept?: number;
    /** CK3 user folder (Documents/Paradox Interactive/Crusader Kings III); absent = detected */
    userDir?: string;
    /** ModList.ref of the mod list the index loads; absent / 'none' = the game without mods */
    modList?: string;
    /** mod lists kept by the app (ModList.kind 'custom') */
    customModLists?: { id: string; name: string; mods: ModListEntry[]; }[];
    /** the mod being edited (ModInfo.id) */
    activeMod?: string;
    /** a game save loaded into the index as the top layer (docs/saves.md): its file */
    loadedSave?: string;
    /** the loaded save's own file when `loadedSave` is its text copy (a binary save converted with rakaly) */
    loadedSaveSource?: string;
    /**
     * format the active mod's script files on every change: the app's edits and files saved in another editor
     * (shared/scriptFormat.ts); absent = on
     */
    formatScripts?: boolean;
    /** look for a newer release at every start (main/updates.ts); absent = on */
    updateCheck?: boolean;
    /** a release version the update banner no longer shows ("Don't remind me about this version again") */
    updateSkip?: string;
    /** fetch newer script databases from GitHub, at most once a day (main/scriptDbUpdate.ts); absent = on */
    scriptDbUpdates?: boolean;
    /** presets for new historical characters (a map holder, a relative): global, any mod; absent = the app's (shared/characterPresets.ts) */
    characterPresets?: CharacterPreset[];
    /** a new relative's birth, in years from the character's (father −18, child +6 …); absent = the app's */
    relativeAges?: Partial<Record<Relation, number>>;
}

/** How a new character is related to the one it is made for (the character card's "＋ relative"). */
export type Relation = 'father' | 'mother' | 'sibling' | 'twin' | 'child';

/**
 * A preset for a new historical character (docs/mods.md, "New characters"): what is written for them. Culture, faith
 * and dynasty empty: taken from the relative (a sibling's, a child's parent's) or, for a map holder, from the county.
 */
export interface CharacterPreset
{
    id: string;
    label: string;
    /** 'either': a man or a woman by chance (a father is a man, a mother a woman whatever the preset says) */
    sex: 'male' | 'female' | 'either';
    /** an age when made for a title (map holder) */
    age: number;
    culture?: string;
    faith?: string;
    /** 'relative': the relative's house or dynasty (a map holder: the title's holder's); 'none': lowborn; else a dynasty key */
    dynasty?: 'relative' | 'none' | string;
    /** a fixed name (a name or its key); empty: one from the culture's name list */
    name?: string;
    traits?: string[];
    /** diplomacy, martial, stewardship, intrigue, learning, prowess */
    skills?: Partial<Record<'diplomacy' | 'martial' | 'stewardship' | 'intrigue' | 'learning' | 'prowess', number>>;
}

/** A folder as the in-app picker lists it (main/folders.ts): subfolder names only, no stat per entry. */
export interface FolderListing
{
    path: string;
    /** null at a drive or share root */
    parent: string | null;
    dirs: string[];
    /** files in it (not listed) */
    files: number;
    error?: string;
    notFound?: boolean;
}

/** A Browse… answer (main/findNear.ts): the folder meant, and the one picked when the search moved from it. */
export interface BrowsedFolder
{
    path: string;
    picked?: string;
}

/** A newer release than the running app (main/updates.ts). */
export interface UpdateInfo
{
    /** `0.3.0` */
    version: string;
    /** the release's title */
    name: string;
    /** its page on GitHub (notes and downloads) */
    url: string;
    /** when it was published (ISO) */
    date?: string;
}

export interface IndexStats
{
    files: number;
    entities: number;
    refs: number;
    locKeys: number;
    ms: number;
    /** loaded from the index cache instead of parsed */
    cached?: boolean;
    /** the mods loaded on top of the game, in load order (ModTouch.mods refer to these ids) */
    mods?: { id: string; name: string; }[];
}

export interface IndexStatus
{
    state: 'idle' | 'indexing' | 'ready' | 'error';
    phase?: string;
    /** progress of the current stage */
    done?: number;
    total?: number;
    /** progress over all stages of the build (0..1, weighted by their usual duration) */
    overall?: number;
    /** current stage number and planned stages (1-based) */
    step?: number;
    steps?: number;
    message?: string;
    stats?: IndexStats;
    gameDir?: string;
    /**
     * bumped by every incremental update of the index (files of the active mod written by the app or changed on disk,
     * `ModsHost.refreshFiles`): views keyed on the ready state reload
     */
    revision?: number;
    /** game-relative paths the last incremental update took in (a sample; images shown for them load again) */
    changedFiles?: string[];
}

export interface TypeSummary
{
    id: string;
    label: string;
    group: string;
    count: number;
    order: number;
    hasDoc: boolean;
    /** Too many entries to list; use search instead. */
    searchOnly: boolean;
    /** how script names an entry of the type: `<refPrefix>:<name>` (`trait:brave`) */
    refPrefix?: string;
    /** entries the loaded mods add, change or remove */
    modCount?: number;
    /**
     * the same per kind of change, `conflicts`: entries two or more mods touch (ModTouch.mods), `duplicates`: entries
     * the game keeps no single winner for (ModTouch.duplicate)
     */
    modStates?: Partial<Record<ModTouch['state'] | 'conflicts' | 'duplicates' | 'conflictsRemoved' | 'duplicatesRemoved', number>>;
}

export interface EntityKey
{
    type: string;
    name: string;
}

export interface EntityListItem
{
    name: string;
    display?: string;
    file?: string;
    defs: number;
    refs: number;
    /** Game path of the entry's icon (served as ck3://img/<path>). */
    icon?: string;
    /** set when loaded mods add, change or remove the entry */
    mod?: ModTouch;
    /** a scripted list's (common/scripted_lists) `base`: the list it is made from (the picker offers it beside that iterator) */
    base?: string;
}

/** An event background (common/event_backgrounds): the picture behind an event and its portraits' lighting. */
export interface EventBackgroundInfo
{
    name: string;
    /** game path of its picture */
    image?: string;
    environment?: string;
    /** how many entries use it */
    refs: number;
    mod?: ModTouch;
}

export interface SearchResult
{
    type: string;
    typeLabel: string;
    name: string;
    display?: string;
    match?: string;
    icon?: string;
    mod?: ModTouch;
}

export interface LinkSpan
{
    /** Offsets relative to `DefSiteView.source`. */
    start: number;
    end: number;
    targets: EntityKey[];
}

export interface DefSiteView
{
    file: string;
    absPath: string;
    line: number;
    endLine: number;
    source: string;
    links: LinkSpan[];
    doc?: string;
    local?: boolean;
    /** A later definition with the same key replaces this one. */
    overridden?: boolean;
    /**
     * A landed title written only as the way to a title inside it (nothing but its de jure vassals): the game merges it
     * into the title it has: no values of its own, it changes nothing; the definition before it wins
     */
    path?: boolean;
    /** where the definition comes from: the game or a mod, and whether a mod removed its whole file */
    origin?: DefOrigin;
    /** the definition as a statement of its file (script definitions): the Source tab's editor replaces it */
    src?: LineSource;
}

export interface RefItem
{
    type: string;
    name: string;
    display?: string;
    contexts: string[];
    sites: { file: string; line: number; }[];
    count: number;
    icon?: string;
    /** set when loaded mods add, change or remove the referencing / referenced entry */
    mod?: ModTouch;
}

export interface RefGroup
{
    type: string;
    typeLabel: string;
    items: RefItem[];
}

export interface LocView
{
    key: string;
    text?: string;
}

export interface EventOptionPreview
{
    names: LocView[];
    conditional: boolean;
    fallback: boolean;
    aiChance: boolean;
    references: EntityKey[];
}

export interface EventPreview
{
    eventType?: string;
    theme?: string;
    hidden: boolean;
    titles: LocView[];
    descs: LocView[];
    options: EventOptionPreview[];
    portraits: { position: string; character: string; animation?: string; }[];
    hasTrigger: boolean;
    hasImmediate: boolean;
    hasAfter: boolean;
    cooldown?: string;
}

/** A [data function] or [concept|E] link in localization text: the entity it names and, for concepts, the text shown. */
export interface BracketLink extends EntityKey
{
    text?: string;
}

export interface EntityDetail
{
    type: string;
    typeLabel: string;
    name: string;
    display?: string;
    description?: string;
    defs: DefSiteView[];
    outgoing: RefGroup[];
    incoming: RefGroup[];
    locText?: string;
    locPlain?: string;
    event?: EventPreview;
    /** entities that [data functions] and [concept|E] links in the texts above refer to, keyed by the bracket content */
    textRefs?: Record<string, BracketLink>;
    mod?: ModTouch;
}

export interface GraphNode
{
    id: string;
    type: string;
    name: string;
    display?: string;
    distance: number;
}

export interface GraphEdge
{
    source: string;
    target: string;
    ctx: string;
    count: number;
}

export interface GraphData
{
    nodes: GraphNode[];
    edges: GraphEdge[];
    truncated?: boolean;
}

export interface GraphOptions
{
    depth: number;
    excludeTypes: string[];
    onlyTypes: string[] | null;
    maxNodes?: number;
}

// ---------------------------------------------------------------------------
// Readable ("story") view
// ---------------------------------------------------------------------------

/** A piece of readable text. Plain strings, or a styled segment that may link to an entity. */
export type RichSeg =
    | string
    | {
        text: string;
        /**
         * entity: linkable definition, scope: a character/title placeholder, value: a number, ph: loc placeholder,
         * color: a colour (text #rrggbb, shown with a swatch), image: a game image (text: its path, shown as the
         * picture, `tip` (the value as written) after it), kw / kwneg: a keyword the renderer marks (If, Otherwise /
         * Not if, Not, None: rich.tsx keywordText)
         */
        kind: 'entity' | 'scope' | 'value' | 'ph' | 'good' | 'bad' | 'code' | 'color' | 'image' | 'kw' | 'kwneg';
        ref?: EntityKey;
        /** Tooltip (raw script key etc.) */
        tip?: string;
    };
export type Rich = RichSeg[];

export interface Line
{
    text: Rich;
    /** Visual hint: 'event' 'trait' 'gold' 'prestige' 'piety' 'stress' 'opinion' 'modifier' 'flag' 'var' 'chance' 'death' 'scope' 'if' 'else' 'loop' 'note' */
    icon?: string;
    tone?: 'good' | 'bad';
    /** Raw script shown on hover. */
    tip?: string;
    /** a note for lines left out for the card's size: their id, IndexApi.moreLines gives them ("Show them here") */
    more?: number;
    /** For `if` lines with complex conditions. */
    conditions?: Line[];
    /** Conditions of an if / else-if line, also when shown inline in its text (used to write sentences). */
    ifConds?: Line[];
    /**
     * an if / else-if with one condition shown in its own text ("If you are an adult:"): the segments of `text` that
     * are that condition (`ifConds[0]`), [from, to), edited, removed and added to on their own
     */
    condSegs?: [number, number];
    children?: Line[];
    /** Not shown to the player in game (hidden_effect, flags, variables …). */
    hidden?: boolean;
    /** Start collapsed (expanded scripted effects/triggers). */
    collapsed?: boolean;
    /** the line is the reading of this scripted effect / trigger called there (a collapsed group: `children` are its lines) */
    group?: EntityKey;
    /**
     * where the statement is written (lines read straight from a definition's text, the game's too, without `mod`):
     * edited in place when it is the active mod's
     */
    src?: LineSource;
    /** `if` / `else_if` and effect iterators: their `limit`, where "＋ if" adds a condition (made when missing) */
    limitSrc?: SectionSource;
    /** a trigger_event line ("Leads to …"): the event it leads to, shown right under the line */
    followUp?: FollowUp;
    /**
     * a row for what is not written yet (a doctrine group without a choice, a name in game): shown as a placeholder,
     * `tone: 'bad'` when the game needs it
     */
    placeholder?: boolean;
    /** the row's own action (editing in place): pick a value into a place, write a text, make a faith … */
    act?: LineAct;
    /** changing the row's statement offers only these values (the doctrines of its group) */
    choices?: string[];
    /**
     * the line shows a localization text (a custom tooltip, a setting's text, a customizable localization's or a
     * dynamic description's text …): its key; in a mod's entry "✎ text" changes it in place (api.editLoc)
     */
    locKey?: string;
    /**
     * a line with a `locKey` that is no statement of its own (a bookmark character's name, a trigger localization's
     * `NOT_` text, a message's default text, a concept's alias): the definition or statement whose owner owns the text.
     * "✎ text" is offered when that is the active mod's; the line gets no row actions from it (✕ / ＋ never act on it)
     */
    locAt?: LineSource;
}

/**
 * A row's or a section's own action in the readable view (docs/mods.md "Editing in place", the faith cards): offered
 * when `src` (the entry's definition) is the active mod's.
 */
export interface LineAct
{
    /** the button's text ("choose", "＋ faith") */
    label: string;
    src: LineSource;
    do:
        /** a value of the field `field` (field set `fields`) picked and written at `at`; `only`: the values offered */
        | { kind: 'pick'; at: SectionSource; fields: string; field: string; only?: string[]; title?: string; }
        /** a localization text written (a name in game, a description) */
        | { kind: 'loc'; key: string; multiline?: boolean; }
        /** statements added at `at` with the picker (a condition block not written yet: made with its first condition) */
        | { kind: 'add'; at: SectionSource; title: string; }
        /** a new faith in the religion */
        | { kind: 'faith'; religion: string; }
        /** the doctrine put into a doctrine group */
        | { kind: 'group'; doctrine: string; }
        /** a term of a faith or religion (`localization = { HighGodName = … }`): its text under a key of its own */
        | { kind: 'term'; term: string; owner: EntityKey; }
        /** the colour `color = { r g b }` (0–1): written at `at`, or in place of the written one (`replace`) */
        | { kind: 'color'; at?: SectionSource; replace?: LineSource; now?: [number, number, number]; }
        /**
         * a picture path (`reference = "gfx/…/decision_misc.dds"`, a 1.19 `picture = "…"`): ✎ opens the picture chooser
         * (PictureChooser.tsx: the pictures of its folder, or an image of one's own, cropped to the current one's size
         * and saved into the mod) and the statement is written again with the path chosen
         */
        | { kind: 'picture'; key: string; now: string; replace: LineSource; width?: number; height?: number; }
        /** "Update for 1.20": the mod's old-layout definition rewritten (main/mods/modernize.ts `fix`) */
        | { kind: 'modernize'; type: string; name: string; fix: string; }
        /** a historical character added to the bookmark (filled from history at its date); `under`: beside that main character */
        | { kind: 'bookmarkCharacter'; bookmark: string; under?: string; }
        /** a historical character's birth date set (its `<date> = { birth = yes }` moved, or written) */
        | { kind: 'birth'; character: string; birth?: string; }
        /** a new relative of a historical character from a preset (docs/mods.md, "New characters") */
        | { kind: 'relative'; character: string; birth?: string; female?: boolean; name: string; }
        /** something that happens to a historical character on a date (a dated block of their history); `date`: on that one
         * (the date line's ＋), not asked */
        | { kind: 'life'; character: string; birth?: string; name: string; date?: string; };
}

/**
 * Where a readable line's statement lives in a file (docs/mods.md, "Editing in place"): what edit / remove / add
 * change. Only lines read straight from a file carry one (not the lines of expanded scripted effects, whose text is
 * substituted).
 */
export interface LineSource
{
    /** absolute path of the file */
    file: string;
    /** game-relative path (= its path in the mod) */
    rel: string;
    /** ModInfo id of the mod the file belongs to; absent = the game (never edited in place) */
    mod?: string;
    /** 1-based line of the statement */
    line: number;
    /** offsets of the statement in the file's text as indexed: [s, e) */
    s: number;
    e: number;
    /** block statements: the offsets just past `{` and of the closing `}`: where statements are added inside */
    inner?: [number, number];
    /**
     * kind 'field', a block row of a field set: the set of what its block holds (its ⤷＋), when not `fields` (a
     * doctrine's `hostility_level_override = { … }` is a setting of special_parameters and holds doctrine / tenet levels)
     */
    innerFields?: string;
    /**
     * what the statement is (and what its block holds): effects, triggers, stat modifiers (`diplomacy = 2`), the
     * fields of a definition (`fields`: an opinion modifier's `opinion`, `years`, `decaying` …), or anything else
     */
    kind: StatementKind;
    /** kind 'field': the entry type whose definition fields these are ('opinion_modifiers') */
    fields?: string;
    /** scope type the statement runs in, when known ('character', 'landed_title', …), a hint for the picker */
    scope?: string;
    /** blocks switching scope (iterators, scope switches): the scope type inside, and who that is ("the child", "Liege") */
    innerScope?: string;
    subject?: string;
    /** the scope type `root` is when not a character (a doctrine's conditions and costs run for a faith) */
    root?: string;
    /** an if / else_if (trigger_if / trigger_else_if): its key; "＋ else" adds the else of its chain */
    ifKey?: string;
    /**
     * the statement is another definition's, read where it is called (an inlined scripted effect / trigger): that
     * definition: editing the line changes it for every caller; not the active mod's: overridden into it first
     */
    owner?: EntityKey;
    /**
     * an `owner` line: where the shown definition calls it (the call statement's file and offset; the outermost call
     * when one inlined effect calls another): the picker's place for the shown entry's scopes in reach
     * (picker/targets.ts placeOf)
     */
    via?: { file: string; offset: number; };
    /**
     * the scopes `prev` leads to at the statement (describer Ctx.prevTypes: the last is `prev`, the one below
     * `prev.prev`; an entry null or undefined: not known); absent: nothing switched yet (`prev` there is the caller's)
     */
    prev?: (string | null | undefined)[];
    /** the same inside the statement's block (an iterator or a scope switch pushes the scope it left); absent: as `prev` */
    prevInside?: (string | null | undefined)[];
    /**
     * `scope` / `innerScope` is a guess from the block's own statements (`scope:foo = { … }` that nothing saves,
     * documents or passes in, its name saying nothing: docs/readable-view.md, "Guessed scope types"): the picker marks
     * it and warns about nothing that rests on it
     */
    scopeGuessed?: boolean;
    innerGuessed?: boolean;
    /**
     * checksum of the file's text when indexed: while the file is still that text, the offsets hold ('' for the game's
     * files, which are never edited)
     */
    hash: string;
    /**
     * the statement itself as indexed (mods' files): how many characters it has and checksums of its text and of the
     * 32 characters before and after it, whitespace left out; when the file changed since (another edit, another
     * editor) the statement is found again by them, so changes elsewhere in the file don't block an edit
     */
    stmt?: StatementCheck;
}

/** LineSource.stmt (indexer/override.ts `stmtCheck`). */
export interface StatementCheck
{
    /** characters of the statement's text without whitespace */
    n: number;
    text: string;
    before: string;
    after: string;
}

/**
 * Where a section of a story or card is written (docs/mods.md, "Editing in place"), so statements can be added to it
 * also while it is empty or missing: the block itself, or, when the definition has no such block yet, the statement
 * to create `key = { … }` in.
 */
export interface SectionSource
{
    /** the block (`immediate = { … }`, a trait's own block for its modifiers): statements go at its end (`src.inner`) */
    src?: LineSource;
    /** no such block yet: the statement that gets `key = { … }` (the event, the option) */
    parent?: LineSource;
    /** a created block goes right before this statement (a new `trigger` / `immediate` before the event's first option) */
    before?: LineSource;
    /** the block's key (what a created block is called) */
    key: string;
    /** what the block holds */
    kind: StatementKind;
    /** the scope type inside and who that is (an iterator's limit: "the child"); else the anchors' */
    scope?: string;
    subject?: string;
    /**
     * a condition block of a definition (a law's `can_pass`): what it is for (its .info's words) and the conditions the
     * game writes in it, most used first: the picker opens at those (PickRequest.common / about)
     * (a field section of `trait_tracks`: the trait's track names, which a new named track may not take; of
     * `special_parameters`: the blocks it writes already, which its ＋ does not offer again)
     */
    hint?: { about?: string; common?: string[]; };
    /**
     * the blocks an add here goes into, asked first ("Into which block?", a picker choice): a Modifiers section with
     * several modifier blocks and no modifier of its own at the top (a building's character_modifier, county_modifier
     * …); each with its row's label and the block's own SectionSource (its kind's list, as the row's ⤷＋)
     */
    into?: { label: string; at: SectionSource; }[];
    /** a new named track on a trait that writes `track` (`src` that block): ScriptEditRequest.fromTrack, the trait's key */
    fromTrack?: string;
}

/** What a statement is, and what the picker builds (PickRequest.kind): see LineSource.kind. */
export type StatementKind = 'effect' | 'trigger' | 'modifier' | 'field' | 'other';

/** An edit of the active mod's script at a line anchor (docs/mods.md, "Editing in place"). */
export interface ScriptEditRequest
{
    /**
     * replace: the statement's text with `text`; remove: the statement (its line, a comment after it on that line and
     * the comment lines directly above it go along); insert: `text` after the statement, inside its block (at the end)
     * or before it; removeDef: the whole top-level definition holding the anchor (the entry's copy in the mod); swap: the
     * statement and `with` (a sibling in the same file) exchange places
     */
    op: 'replace' | 'remove' | 'insert' | 'removeDef' | 'swap';
    at: LineSource;
    /** swap: the other statement */
    with?: LineSource;
    /** script, unindented (lines separated by \n): indented like the surrounding lines, the file's line endings */
    text?: string;
    /** insert: after the statement (default), inside its block (at the end), or before it */
    where?: 'after' | 'inside' | 'before';
    /** insert: wrap the text into `wrap = { … }` (a section the definition does not have yet) */
    wrap?: string;
    /**
     * replace: the text goes right after the block holding the statement, which is removed: a list's item that
     * becomes a statement of its own (`tenets = { x }` → `tenet_selection_pair = { … }` next to the list)
     */
    outside?: boolean;
    /** what the edit is, in words (its undo step's: "Changed: +4 Martial") */
    label?: string;
    /**
     * entries the statement needs, made first in the same undo step (a picked statement's new trait, opinion modifier …;
     * createEntries): one undo takes both back; a refused statement takes them back at once, leaving no step
     */
    creates?: EntryCreate[];
    /**
     * replace: the comment lines directly above the statement and the comment after it on its line go along (the
     * statement's own line(s) are replaced whole): set when the picker's "Change to…" puts another statement in its
     * place, so the old one's comments do not stay behind (the change bar names them; Undo brings them back)
     */
    withComments?: boolean;
    /**
     * insert inside a trait's `track = { … }` (the `at`), which is first turned into `tracks = { <fromTrack> = { … } }`
     * (the single track named after the trait, as the game names it) with `text` after it; the mod's add_trait_xp /
     * has_trait_xp of the trait get `track = <fromTrack>` in the same undo step (docs/picker.md)
     */
    fromTrack?: string;
}

export interface ScriptEditResult
{
    mod: { id: string; name: string; };
    /** a loaded save's entry was changed (docs/saves.md): no undo step of the mod, the save's own undo */
    save?: true;
    /** the file written (absolute, and game-relative) */
    file: string;
    rel: string;
    /** 1-based line of the changed statement after the edit (removed: where it was) */
    line: number;
    /** changes of the mod that can be undone (this one included) */
    undo: number;
    /** the undo step of this change (the change bar's Undo undoes it; mods/undo.ts) */
    step?: number;
    /** what else to know */
    notes: string[];
}

/** An undone change (docs/mods.md, "Undo"): what it was, where to show it, what can be undone next. */
export interface UndoResult
{    /** the step can be redone (undone: its id) */
    redo?: number;

    /** the change (its undo step), its words ("Changed: +4 Martial", "Override of brave") and kind (edit, override …) */
    id: number;
    label: string;
    kind: string;
    mod?: { id: string; name: string; };
    /** a file it changed that is still there (absolute, and in the mod) and the line */
    file?: string;
    rel?: string;
    line?: number;
    /** files it had made, removed again (paths in the mod) */
    removed: string[];
    /** other files it changed, taken back too (a picked statement's new entries in files that were there) */
    also: string[];
    /** changes of the mod still to undo, and the next of them */
    left: number;
    next?: { id: number; label: string; };
    /**
     * not undone, and why: a file changed since (another editor, deleted), or a later change touched it (undo that first);
     * nothing was written, the change stays ("Forget" drops it: api.forgetChange)
     */
    refused?: string;
}

/** A statement's script as written (the in-place editor's starting text). */
export interface ScriptText
{
    /** the statement's text, continuation lines without the statement's own indentation */
    text: string;
    /** the file's indentation unit ('\t' or spaces) */
    indent: string;
    /** set when the statement can't be edited: the file changed since it was read, it is not the active mod's … */
    problem?: string;
    /** an else / else_if follows it (an if's): it can't be wrapped or have statements put between them */
    elseAfter?: boolean;
}

/** The statement picker (renderer: picker/pickStatement.ts): what to build. */
/** A scope the picker offers as a target besides the links ("Child is…"): an event's saved scopes. */
export interface PickTarget
{
    /** scope:child */
    key: string;
    label: string;
    /** who it is (e.g. "The new born character", given by Birth child) */
    about?: string;
    /** scope type; default character */
    type?: string;
    /**
     * where in its definition's file the scope is in reach (docs/picker.md, "Scopes in reach"): saved there, it exists
     * only from the save on (an event's later parts, its own option, the rest of a temporary one's part of the script).
     * Absent: in reach everywhere (given by what runs the entry, documented, used without a save).
     */
    reach?: ScopeReach;
    /**
     * saved by a scripted effect / trigger the entry calls, in its own text (that definition's file and span): offered
     * only on that definition's lines read inlined at the call (PickPlace.own inside the span), there by `reach` at the
     * line's own place; elsewhere neither offered nor warned about (picker/targets.ts)
     */
    inside?: { file: string; def: [number, number]; };
}

/** Where a saved scope is in reach (PickTarget.reach): file offsets as the index read them, the ends excluded. */
export interface ScopeReach
{
    /** absolute path of the file (LineSource.file) */
    file: string;
    /**
     * the definition's own span (its `key = { … }`): a place outside it (another definition of the same file, e.g. a
     * follow-up event shown nested in the timeline) is treated like a place in another file: in reach
     */
    def: [number, number];
    ranges: [number, number][];
    /**
     * where it is not in reach yet: before its save in the part that saves it, and the parts of an event that run
     * earlier (a typed one reads "saved only later" there, else "saved elsewhere": another option …)
     */
    later?: [number, number][];
    /**
     * the event's parts it reaches as a whole that may not be written yet ('immediate', 'after'): a new block of that
     * key (PickPlace.section) is in reach
     */
    keys?: string[];
    /**
     * the parts of an entry with a phase table that run before every lasting save of it (a decision's is_shown for an
     * effect's save): a new block of that key (PickPlace.section) is not in reach, wherever it is put ("saved only later")
     */
    notKeys?: string[];
}

/** Where a picked statement goes (PickRequest.place): the file and offset; `section`: it goes into a new block of that key. */
export interface PickPlace
{
    file: string;
    offset: number;
    section?: string;
    /** a line of an inlined definition (LineSource.owner): its own place in that definition's text (PickTarget.inside) */
    own?: { file: string; offset: number; };
}

export interface PickRequest
{
    /**
     * effects, conditions, stat modifiers, the fields of a definition (`type`), a localization text code, or plain
     * menus (`choice`: pickChoice; the result's text is the chosen row's value)
     */
    kind: 'effect' | 'trigger' | 'modifier' | 'field' | 'loc' | 'choice';
    /** kind 'choice': the first menu (renderer picker/model.ts ChoiceMenu; functions inside, so renderer only) */
    choice?: unknown;
    /** kind 'loc': the saved scopes the text can speak of (the event's) */
    scopes?: string[];
    /** kind 'field': the entry type whose fields are built ('opinion_modifiers') */
    type?: string;
    /** a statement to change (`diplomacy = 2`, `years = 5`): the picker opens at its value (modifiers, fields) */
    edit?: string;
    /** the statement changed is an if / else_if with an else after it (ScriptText.elseAfter): not wrapped, nothing added between */
    elseAfter?: boolean;
    /** kind 'field': open right at this field's value (a doctrine group's placeholder: `doctrine`) */
    field?: string;
    /** kind 'field': the values offered for the field (the doctrines of one group) */
    only?: string[];
    /** finished with the first statement (no "What next?") */
    once?: boolean;
    /** scope type of the block the statement goes into; default 'character' */
    scope?: string;
    /** where to open the menu (client coordinates); default: near the middle of the window */
    at?: { x: number; y: number; };
    /** who "Self" is inside the block ("the child", "Liege"): the menus say it instead of "Self" */
    subject?: string;
    /** the scope type `root` is when not a character (LineSource.root): "Self" at the top is "the faith", not "you" */
    root?: string;
    /**
     * a condition block's conditions the game writes, most used first (SectionSource.hint): the picker opens at them
     * (a field section of `trait_tracks`: the trait's track names, which a new named track may not take; of
     * `special_parameters`: the blocks it writes already, which its ＋ does not offer again)
     */
    common?: string[];
    /** what the block is for, in the type's .info words: shown with them */
    about?: string;
    /** where the statement goes, for the menu's header: "Add to: Right away" */
    title?: string;
    /**
     * kind 'effect': choose someone and ('name') give them a name (`… = { save_scope_as = name }`, the "Who's who"
     * "＋ name someone"), or ('send') send them the event `event` (`… = { trigger_event = <event> }`, "When it
     * happens…" → "Who gets it")
     */
    goal?: 'name' | 'send';
    event?: string;
    /** scopes to offer as targets (default: the event shown, its Who's who) */
    targets?: PickTarget[];
    /**
     * `targets` is the whole list of scopes in reach as far as the index sees (an event's, an interaction's): the common
     * saved scopes (actor, recipient …) are then not offered unless listed, and a typed `scope:x` outside the list is
     * warned about. Unset: nothing is known (an empty list means "none known").
     */
    targetsKnown?: boolean;
    /**
     * where the statement goes (the in-place editor's line or block): the view's scopes are offered only where they are
     * in reach (PickTarget.reach); one typed that is saved elsewhere is warned about. Unset: every scope of the view.
     */
    place?: PickPlace;
    /**
     * the scopes `prev` leads to where the statement goes (LineSource.prev, or .prevInside for one added into a block):
     * the picker types a typed `prev` / `prev.prev` by it, its own nesting pushed on top (picker/model.ts prevStack)
     */
    prev?: (string | null | undefined)[];
    /** `scope` is a guess from its block's use (LineSource.scopeGuessed): marked, and nothing resting on it is warned about */
    scopeGuessed?: boolean;
    /**
     * the caller makes the result's new entries (`PickResult.creates`, the in-place editor): entry lists offer
     * "＋ New trait…", "＋ New event…" … (docs/picker.md, "New entries")
     */
    newEntries?: boolean;
}

/**
 * An entry the picker's result needs that does not exist yet, to be made in the active mod before the statement is
 * written (docs/picker.md, "New entries"): a new opinion modifier (its fields), or a new doctrine parameter (set by
 * the doctrine in `fields`); `loc`: its name / sentence in game.
 */
export interface EntryCreate
{
    /**
     * also, without the picker, `loc` (a localization text: `key`), `faith` (a new faith `key` in the religion
     * `fields.religion`, `loc` its name), `doctrine_group_member` (the doctrine `key` into the group `fields.group`),
     * `term` (the term `key` (HighGodName) of `fields.type` / `fields.owner`, `loc` its text); `entry`: a new entry
     * of the type `fields.type` from its template ("New <type>…", the picker's "＋ New trait…"), `loc` its name in game;
     * `character`: a new historical character (`key` '': an id is made, returned in `keys`): `fields.preset` (a
     * CharacterPreset as JSON), `birth` (y.m.d), `relation` + `relative` (a Relation of that character: the family is
     * linked (a parent written on the relative, siblings' parents copied, a twin's trait)), `culture` / `faith` (what
     * the preset leaves to the place: a map holder's county), `house_of` (whose house a 'relative' dynasty is; a map
     * holder: the title's holder); `birth`: the character `key`'s birth moved to `fields.date` (or written)
     */
    what: 'opinion_modifiers' | 'doctrine_parameter' | 'loc' | 'faith' | 'doctrine_group_member' | 'term' | 'entry' | 'modernize' | 'bookmark_character' | 'character' | 'birth' | 'relative' | 'life_event';
    key: string;
    fields: [string, string][];
    loc?: string;
}

/** Where a new entry of a type would go in the active mod ("New <type>…"), or why it can't be made. */
export interface NewEntryPlan
{
    type: string;
    label: string;
    problem?: string;
    mod?: string;
    /** the file it is written to (game-relative = in the mod) */
    rel?: string;
    /** a suggested key (events: the first free id of the mod's namespace) */
    key?: string;
    /** the type has a name in game (asked for its localization) */
    name: boolean;
    /**
     * the type's entries are written inside other definitions (laws in law groups, faiths in religions): the holder's
     * type, the blocks between (`faiths`), whether a new holder can be made: the dialog asks which holder
     */
    nested?: { holderType: string; holderLabel: string; within: string[]; newHolder: boolean; };
}

/** "Duplicate as a new event…": the event copied, the copy's id, another title for it */
/** An image picked for the crop & rotate dialog: its file, and bytes the page can show (a DDS decoded to PNG). */
export interface PickedImage
{
    file: string;
    name: string;
    mime: string;
    data: Uint8Array;
}

/** What an import takes instead of asking for a file: the crop dialog's PNG (`name`: the picked file's), or the picked file as it is. */
export interface ImageSource
{
    png?: Uint8Array;
    name?: string;
    file?: string;
}

export interface DuplicateRequest
{
    source: string;
    key: string;
    title?: string;
}

/** Duplicating an entry of any type (docs/mods.md, "Duplicating an entry"): the copy's key and, if wanted, its name in game. */
export interface DuplicateEntryRequest
{
    type: string;
    source: string;
    key: string;
    name?: string;
}

export interface NewEntryRequest
{
    type: string;
    key: string;
    /** its name in game (localization); default: the key made readable */
    name?: string;
    /** a type written inside other definitions (NewEntryPlan.nested): the holder it goes in, or a new one */
    holder?: string;
    newHolder?: { key: string; name?: string; };
    /** start as a copy of this entry of the holder */
    from?: string;
}

export interface NewEntryResult
{
    type: string;
    key: string;
    mod: string;
    file: string;
    rel: string;
    line: number;
    /** the mod is loaded: the explorer shows the entry */
    loaded: boolean;
    /** the undo step of the change (mods/undo.ts) */
    step?: number;
}

/** The codes the game's localization uses, most used first (the text editor's "Insert code…"). */
export interface LocCodes
{
    /** a character's data function chains after `ROOT.Char.` / `<scope>.` (`GetHerHis`, `GetFaith.HighGodName`), with counts */
    functions: [string, number][];
    /** what a function chain prints, worked out for William of Normandy in 1066 ("Duke William", "his / her") */
    examples?: Record<string, string>;
    /** a text icon's picture: `gold_icon` → gfx/interface/icons/icon_gold.dds (gui texticon blocks) */
    iconImages?: Record<string, string>;
    concepts: { key: string; label: string; count: number; }[];
    icons: [string, number][];
    formats: [string, number][];
}

/** What the picker built. */
export interface PickResult
{
    /** kind 'loc': where the cursor goes inside `text` (between a formatting code's halves: a selection is wrapped there) */
    caret?: number;
    /** entries to make first (new opinion modifiers, doctrine parameters) */
    creates?: EntryCreate[];
    /** script of the statement(s), unindented, lines separated by
     */
    text: string;
    /** readable sentence of what was built ("Add +30 opinion of your liege, when you are under 18") */
    summary?: string;
    /**
     * written next to the block it was asked for, not into it (a list's item became a statement of its own: a tenet
     * with its DLC and fallback, `tenet_selection_pair`); ScriptEditRequest.outside
     */
    outside?: boolean;
}

/** How the loaded script uses an effect or trigger key (the picker's "Other effect… / Other condition…" list). */
/** A value a text field of the picker offers (a doctrine parameter), with what it is. */
export interface FieldSuggestion
{
    value: string;
    label?: string;
    count?: number;
    /** loaded mods adding or changing it (a parameter: the doctrines setting it) */
    mods?: string[];
    /** `doctrine_groups`: the doctrine's group (its key, name, category and how many a faith picks) */
    group?: { key: string; label: string; category: string; picks: number; };
    /** a picture it stands for (`faith_icons`: the icon), shown in the row and large in the preview */
    image?: string;
}

/** A stat modifier key (diplomacy, monthly_prestige, stress_gain_mult …) as the picker offers it. */
export interface ModifierKeyInfo
{
    key: string;
    /** the game's name for it (MOD_<KEY>), else the key made readable */
    label: string;
    /** shown as a percentage: the value is a fraction (0.1 = +10%) */
    percent: boolean;
    /** the value is a percentage already (10 = +10%) */
    alreadyPercent?: boolean;
    /** a positive value is good / bad for the holder, or neither */
    color: 'good' | 'bad' | 'neutral';
    /** uses in the loaded definitions (traits, modifiers …) */
    count: number;
    /**
     * where the game puts it, with how often: character modifiers (traits, `character_modifier` blocks, modifiers
     * given with add_character_modifier …), county (`county_modifier`, add_county_modifier), province, scheme
     * (add_scheme_modifier), travel plan, army (a raid intent's `modifier`), artifact, dynasty, house; other: a
     * modifier entry nothing gives (as far as the index sees)
     */
    kinds?: Partial<Record<ModifierKind, number>>;
    /**
     * the game's modifier area it is defined in: the stem of its modifier_definition_formats file
     * (`00_scheme_definitions.txt` → scheme; scriptCatalog.ts MODIFIER_AREAS); none for the general file (`00_definitions.txt`) and
     * files of other names (a mod's own)
     */
    area?: string;
}

/** What a block of stat modifiers applies to (ModifierKeyInfo.kinds; 'other': nothing known). */
export type ModifierKind = 'character' | 'landed_title' | 'province' | 'scheme' | 'travel_plan' | 'army' | 'artifact' | 'dynasty' | 'dynasty_house' | 'other';
export interface ScriptKeyInfo
{
    key: string;
    /** statements using it */
    count: number;
    /** value shapes seen: yes/no, number, compare (`<`, `>=` …), scope (`root`, `scope:x`), link (`trait:x`), name, block */
    shapes: Partial<Record<'bool' | 'number' | 'compare' | 'scope' | 'link' | 'name' | 'block', number>>;
    /** most common scalar values as written (with the operator when it is not `=`: `< 16`), with their counts */
    values: [string, number][];
    /** blocks: their fields, most used first */
    fields?: [string, number][];
    /** blocks: the values written for each field (`reason` of set_relation_friend, `CHARACTER` of a scripted effect), most used first */
    fieldValues?: Record<string, [string, number][]>;
    /** blocks short enough for one line (`{ target = root modifier = x }`), most common first */
    examples?: [string, number][];
    /** a scripted effect / trigger (common/scripted_effects, common/scripted_triggers) */
    scripted?: boolean;
    /** a scripted one's parameters: the `$NAME$`s its definition uses, in the order written (a call: `NAME = value`) */
    params?: string[];
    /**
     * where each parameter is used in the definition, its commonest spot: `add_gold = $AMOUNT$` gives `{ key: 'add_gold' }`,
     * `trait = $TRAIT$` inside `add_trait_xp = { … }` gives `{ key: 'trait', block: 'add_trait_xp' }` (a parameter used
     * only inside a longer word or a text has no entry): the picker asks for the values of that key
     */
    paramKeys?: Record<string, { key: string; block?: string; }>;
    /** a block field whose value names an entry: its index type (`add_opinion.modifier` → opinion_modifiers) */
    fieldRefs?: Record<string, string>;
    /** its value names an entry of this type (trigger_event → events): "Other…" lists the entries, the mod's first */
    refType?: string;
}

export interface ScriptKeys
{
    effect: ScriptKeyInfo[];
    trigger: ScriptKeyInfo[];
}

export interface FollowUp
{
    target: EntityKey;
    label: string;
    /** "in 7–14 days" */
    delay?: string;
    /** Conditions/chances on the path to the trigger_event: "50% chance", "If …" */
    when: Rich[];
    /** Whose event it is, when not the current character: "Recipient" */
    who?: string;
    hidden?: boolean;
    /** an on_action's list entry: where it is written (✕ removes it, editing in place) */
    src?: LineSource;
    /**
     * an entry of the edited on_action's list after its first one ("Delay from here…": a delay written right before it
     * holds this entry and the ones after it back)
     */
    afterFirst?: boolean;
    /** the last `delay` statement written between the entry before and this one (its chip's ✎ / ✕) */
    delayAt?: LineSource;
}

export interface StoryOption
{
    text: Rich;
    alternatives: Rich[];
    conditions: Line[];
    effects: Line[];
    followUps: FollowUp[];
    fallback?: boolean;
    /** the `option = { … }` block (editing in place: effects are added at its end) */
    src?: LineSource;
    /** the localization key of its name (edited in place) */
    nameKey?: string;
    /** its `trigger` block ("Only if"), or where to create one */
    trigger?: SectionSource;
}

export interface StoryOrigin
{
    ref: EntityKey;
    label: string;
    typeLabel: string;
    when?: string;
    /** the mods whose files hold the reference (ModInfo ids): the active mod's can be taken back ("✕") */
    mods?: string[];
}

/** One the event speaks of: a saved scope and who it is (the event card's "Who's who"). */
export interface CastMember
{
    /** the scope's name: `scope:<name>` */
    name: string;
    who: Rich;
    /** what the one chosen fits (an iterator's limit, an any_'s conditions) */
    conditions?: Line[];
    /** given by what fires the event: the on_action's / event's label; none: the event names it itself */
    from?: string;
    /** save_temporary_scope_as: only until the end of the part of the script it is saved in (immediate, an option …) */
    temporary?: boolean;
    /** its scope type where it is saved (character, landed_title …), when known */
    type?: string;
    /** named: where it is in reach (after its saves; PickTarget.reach); given ones are in reach everywhere */
    reach?: ScopeReach;
    /** the statement to remove to forget the name (the whole block when it only names them) */
    src?: LineSource;
}

export interface EventPortrait
{
    /** left, right, center, lower_left, lower_center, lower_right */
    pos: string;
    /** who is shown: root, scope:x … */
    scope: string;
    /** the mood / pose (`animation`), or a scripted one (`scripted_animation`) */
    animation?: string;
    scripted?: string;
    camera?: string;
    outfitTags: string[];
    /** toggles written `= yes`: hide_info, animate_if_dead, override_imprisonment_visuals, remove_default_outfit */
    flags: string[];
    /** `trigger`: shown only if (about the one shown) */
    shownIf?: Rich;
    /** `triggered_animation`s: the first whose condition holds is used ("Mood when …"), as written, to keep */
    triggered: { when: Rich; animation?: string; text: string; }[];
    /** the block's statements as written (unindented), in order; a change rewrites the block from them */
    kids: { key: string; text: string; }[];
    src?: LineSource;
}

/** What an event portrait can be set to, with how often the game's events use each (index:portraitOptions). */
export interface PortraitOptions
{
    /** gfx/portraits/portrait_animations; group: the file's section ("Emotion", "Personality", "Misc" …) */
    animations: { name: string; group: string; uses: number; }[];
    cameras: { name: string; uses: number; }[];
    /** common/scripted_animations */
    scripted: { name: string; uses: number; }[];
    /** outfit tags the game's events use */
    outfits: { name: string; uses: number; }[];
}

/** Who is who in an event: root, the scopes it is given and names, its portraits (docs/readable-view.md). */
export interface EventCast
{
    /**
     * root is the character who gets the event; what the on_actions firing it say root is, or who they send it to (`of`:
     * whose ("they" in `who`), `conditions`: who fits)
     */
    rootNotes: { from: string; who: string; of?: string; conditions?: Line[]; }[];
    given: CastMember[];
    named: CastMember[];
    /** scopes it uses but neither names nor, as far as known, is given */
    unknown: string[];
    /** what the given scopes were not read from ("Read from the first 12 of the 40 things that fire it.") */
    givenNote?: string;
    portraits: EventPortrait[];
    /** a new portrait statement goes after this one */
    portraitAt?: LineSource;
}

/** An on_action as "When it happens…" lists it (docs/mods.md, "What fires an event"). */
export interface OnActionInfo
{
    name: string;
    label: string;
    /** its documentation's first sentence */
    summary?: string;
    /** who root is, by its documentation */
    root?: string;
    /** the scopes it gives, by its documentation */
    scopes: { name: string; who: string; }[];
    /**
     * the game's code fires it (the script database's on_actions.log, `From Code`); without the database: nothing in
     * script fires it, so the game must
     */
    byGame: boolean;
    /** something in the loaded script fires it (an origin: an on_action list, an effect) */
    byScript: boolean;
    /** events it fires always / one of at random */
    events: number;
    randomEvents: number;
    /** the event asked about is fired by it already */
    fires?: 'always' | 'sometimes';
    mod?: ModTouch;
}

/** "When it happens…": fire the event from an on_action: always, or among its random events (weight). */
export interface FireRequest
{
    event: string;
    onAction: string;
    how: 'always' | 'sometimes';
    weight?: number;
    /**
     * someone else than the one the on_action is about gets it: the picker's script sending it (`random_parent = {
     * limit = { … } trigger_event = <event> }`), written into an on_action of the mod's own that the on_action fires
     */
    send?: string;
    /** with `send`: the one the on_action is about is kept as `scope:<keepAs>` for the event */
    keepAs?: string;
    /** with `send`: who the on_action is about, by its documentation (the new on_action's `# root is …`) */
    about?: string;
}

/** One description text of an event; `when` says when it is shown ("If Lover has the trait Adulterer:", "Otherwise:"). */
/**
 * An event's description as written (docs/readable-view.md, "Descriptions"): a text (a localization key), a sequence
 * of parts shown one after another (a `desc = { … }` block), or versions of which one shows: the first valid one
 * (`first_valid`) or a random valid one (`random_valid`). They nest: a version can be a sequence holding versions of
 * its own. A `triggered_desc` is its content with `when` (shown / picked only when its condition holds).
 */
export interface DescNode
{
    kind: 'text' | 'seq' | 'first' | 'random';
    /** kind text: the text and its localization key (edited in place) */
    text?: Rich;
    key?: string;
    /** seq / first / random: the parts or versions */
    kids?: DescNode[];
    /** a `triggered_desc`: "If …:" and its `trigger` block ("＋ condition" adds to it) */
    when?: Rich;
    triggerSrc?: SectionSource;
    /** the unconditional version after conditional ones in a first_valid: "Otherwise:" */
    otherwise?: boolean;
    /**
     * where it is written, from the event's `desc` statement down (indexes among keyed statements): `path` its
     * statement as an item of its parent (a `triggered_desc` for a conditional one: moved, removed), `at` the
     * statement whose block holds its kids (added to); absent for bare values
     */
    path?: number[];
    at?: number[];
}

/**
 * One of an event's scenes (`override_background`, in order): the first whose condition holds shows; none: its theme's
 * (events/_events.info).
 */
export interface EventScene
{
    /** the background (common/event_backgrounds) and its picture */
    ref?: string;
    image?: string;
    /** "If …:" of its `trigger`; its trigger block or where one is made ("＋ condition") */
    when?: Rich;
    triggerSrc?: SectionSource;
    /** the statement (changed, moved, removed) */
    src?: LineSource;
}

export interface EventStory
{
    key: EntityKey;
    /** the localization key of its title (edited in place) */
    titleKey?: string;
    /** the `title` / `desc` statements ("＋ text version when…" adds a conditional version) */
    titleSrc?: LineSource;
    descSrc?: LineSource;
    /** its `override_background` / `theme` statements ("Change scene…") */
    backgroundSrc?: LineSource;
    /** every `override_background`, in order (several: conditional scenes) */
    scenes: EventScene[];
    themeSrc?: LineSource;
    /** the background it shows (its own or its theme's) and its theme's key */
    background?: string;
    themeKey?: string;
    /** Event scene (from theme / override_background) and event type icon. */
    illustration?: string;
    icon?: string;
    title: Rich;
    titleVariants: Rich[];
    /** its description (absent: none written) */
    desc?: DescNode;
    kindLabel: string;
    theme?: string;
    /** `window = x`: the interface window the event is shown in (linked to the GUI tab when the `.gui` files have it) */
    window?: Rich;
    hidden: boolean;
    cooldown?: string;
    portraits: Rich[];
    origins: StoryOrigin[];
    conditions: Line[];
    /** its own `weight_multiplier`: how its weight changes when a list (an on_action's random_events) picks one at random */
    weight?: Line[];
    immediate: Line[];
    immediateFollowUps: FollowUp[];
    options: StoryOption[];
    after: Line[];
    afterFollowUps: FollowUp[];
    /** the event's definition (editing in place: options are added at its end) */
    src?: LineSource;
    /** who is who: root, the scopes it is given and names, its portraits */
    cast?: EventCast;
    /** where its conditions, `immediate` and `after` are written, or where to create them */
    sections?: { trigger: SectionSource; immediate: SectionSource; after: SectionSource; };
}

/**
 * The lists of an on_action (the keys they are written under): the events it always fires, the ones it picks from at
 * random, the first that applies, the same for on_actions.
 */
export type OnActionListKey = 'events' | 'random_events' | 'first_valid' | 'on_actions' | 'random_on_action' | 'first_valid_on_action';

/**
 * What a list of an on_action holds besides its entries (editing in place): the `delay` and chance statements written
 * in it (as lines: ✎ changes, ✕ removes one), and where a new one goes.
 */
export interface OnActionList
{
    /**
     * the delay at the list's start, `chance_to_happen` and `chance_of_no_event` as they are written, in order: every
     * loaded definition's (only the edited one's are anchored; with several writing the list, the tip names the file).
     * A delay after the first entry is no row when it is the last one before a later entry: it is the chip of the
     * entries after it (FollowUp.delay, delayAt); one after the last entry or replaced by a later delay is a row.
     */
    lines: Line[];
    /** the files that write the list as `random_on_actions` (the game's files and its .info spell it `random_on_action`): a hint */
    plural?: string[];
    /** the list's first entry: a new delay or chance goes right before it (absent: the list has none, it goes inside) */
    first?: LineSource;
    /** the delay written before every entry (it counts for all of them: "Delay…" changes it) */
    delay?: LineSource;
    /** the chance statements (one of each: "Chance…" changes it) */
    chance_to_happen?: LineSource;
    chance_of_no_event?: LineSource;
}

export interface OnActionStory
{
    key: EntityKey;
    label: string;
    doc?: string;
    conditions: Line[];
    /** always fired */
    events: FollowUp[];
    /** one picked at random */
    randomEvents: FollowUp[];
    /** what no list row shows: a random list's `0 = …` weight ("N% chance that nothing happens"); the chances are rows (lists) */
    notes?: string[];
    /** events: the first whose trigger holds */
    firstValid: FollowUp[];
    /** on_actions it also triggers */
    onActions: FollowUp[];
    /** on_actions: one picked at random (`random_on_action`, each with its share) */
    randomOnActions: FollowUp[];
    /** on_actions: the first that applies (`first_valid_on_action`) */
    firstValidOnActions: FollowUp[];
    /** `fallback_event` (an event) and `fallback` (an on_action): fired when nothing else of the on_action fired */
    fallbacks: FollowUp[];
    effects: Line[];
    effectFollowUps: FollowUp[];
    origins: StoryOrigin[];
    /**
     * the definition edits go into (docs/mods.md "Editing in place"): a mod's last loaded one, else the winning one, and
     * its blocks, or where each is made: conditions, effects and the lists (the events always fired, the random ones
     * (`weight = id`), the first that applies, the on_actions it also triggers, the random and first-valid ones)
     */
    src?: LineSource;
    sections?: { trigger: SectionSource; effect: SectionSource; events: SectionSource; random_events: SectionSource; first_valid: SectionSource; on_actions: SectionSource; random_on_action: SectionSource; first_valid_on_action: SectionSource; };
    /** what each list holds besides its entries (delay, chances), and where new ones go */
    lists?: Record<OnActionListKey, OnActionList>;
    /**
     * `first_valid`'s last entry when it is an event with no trigger (it always applies, so nothing after it would be
     * reached): a new entry goes right before it
     */
    firstValidLast?: LineSource;
}

export interface CardSection
{
    title: string;
    lines: Line[];
    followUps?: FollowUp[];
    /** where the section is written (editing in place); sections with a block of their own come also when empty */
    src?: SectionSource;
    /** "＋" of its own (a faith, a holy site …), besides or instead of the one of `src` */
    acts?: LineAct[];
    /** the one of `src` is not shown (the section's acts say better what goes in) */
    noAdd?: boolean;
    /** what the one of `src` adds ("parameter"), else by its kind ("setting", "condition" …) */
    addLabel?: string;
}

export interface UsageSummary
{
    type: string;
    typeLabel: string;
    count: number;
    examples: { ref: EntityKey; label: string; }[];
}

export interface EntityCard
{
    key: EntityKey;
    title: string;
    icon?: string;
    illustration?: string;
    /** For image entries: the image itself plus file facts. */
    picture?: { path: string; width?: number; height?: number; };
    typeLabel: string;
    description?: Rich;
    /** the text keys of its description and its name (edited in place in a mod's entry) */
    descriptionKey?: string;
    titleKey?: string;
    facts: Rich[];
    sections: CardSection[];
    usage: UsageSummary[];
    /** Set when the entity is an event or on_action: the renderer shows the story timeline instead. */
    event?: EventStory;
    onAction?: OnActionStory;
    /** the winning definition (editing in place) */
    src?: LineSource;
    /**
     * the saved scopes in reach of its script (docs/picker.md, "Scopes in reach"): the ones its type's .info documents
     * (an interaction's actor and recipient …), the ones it saves, the ones it uses; a scripted effect's / trigger's also
     * the ones its callers have where they call it ("given by 2 of 3 callers"); the picker offers them as targets
     */
    targets?: PickTarget[];
    /**
     * a mod's entry: the scopes the scripted effects / triggers it calls save in their own texts (PickTarget.inside),
     * offered on those definitions' lines read inlined at the call (StoryView adds them to the view's targets)
     */
    calledSaves?: PickTarget[];
    /**
     * `targets` is the whole list as far as the index sees (the game runs the entry with the scopes its type's .info
     * names, or a type known to come with none (docs/picker.md "Known-empty types"), then possibly with an empty list;
     * a scripted effect / trigger every reference of which was looked at within the callers' time budget, each caller
     * known): the picker then leaves the other saved scopes out
     */
    targetsKnown?: boolean;
    /**
     * the values its script saves (`save_scope_value_as` / `save_temporary_scope_value_as`: `scope:x` holds a number or
     * yes / no), an event's too: the value editor offers them for a number (components/valueKinds.ts)
     */
    values?: PickTarget[];
    /**
     * the list names in reach of its script, offered for a list's name: the ones it adds to (`add_to_list`,
     * `add_to_temporary_list`), the ones the scripted effects / triggers it calls add (from the call on), a scripted
     * effect's / trigger's callers' ones; `about`: where it comes from; `reach`: where in the file it is in reach, as
     * PickTarget.reach (absent: everywhere)
     */
    lists?: { name: string; about?: string; reach?: ScopeReach; }[];
}

export interface TooltipInfo
{
    key: EntityKey;
    title: string;
    icon?: string;
    illustration?: string;
    typeLabel: string;
    description?: string;
    lines: Line[];
}

// ---------------------------------------------------------------------------
// Portraits (3D heads built from DNA)
// ---------------------------------------------------------------------------

export interface PortraitPart
{
    name: string;
    /**
     * shading: skin/eye/hair use palette colours, cloth is an attachment (clothes, headgear, jewellery), prop any other
     * model (buildings, artifacts, court rooms)
     */
    kind: 'skin' | 'eye' | 'hair' | 'teeth' | 'cloth' | 'prop';
    /** accessory gene the part comes from (hairstyles, clothes, …); absent for head and body */
    group?: string;
    /** alpha-to-coverage cut-out (hair, fur, lace) */
    cutout?: boolean;
    /** Game coordinates (Y up, left-handed); the viewer mirrors Z for three.js. */
    positions: Float32Array;
    normals: Float32Array;
    uvs: Float32Array;
    /** second UV set (clothes: pattern coordinates) */
    uvs2?: Float32Array;
    indices: Uint32Array;
    /** game texture path, or a data URL when decals were baked in */
    diffuse?: string;
    normal?: string;
    /** baked normal maps store x in R and y in G (game normal maps: "RRxG", x in G and y in A) */
    bakedNormal?: boolean;
    properties?: string;
    /** Palette colour blended in by the diffuse alpha (skin/eye/hair); absent when baked into the diffuse. */
    color?: [number, number, number];
    /** clothes colour patterns (accessory variation), see docs/portraits.md */
    variation?: PortraitVariation;
    /** model previews: level of detail (1+ = simplified copies), decal planes; hidden unless asked for */
    lod?: number;
    decal?: boolean;
    /** material shader as declared (model previews) */
    shader?: string;
    /** effect file of the shader (`gfx/FX/pdxmesh.shader`); with `shader` the Effect to compile */
    shaderFile?: string;
    /** the meshsettings' `additional_shader_defines`: the Effect is compiled with them */
    shaderDefines?: string[];
    /** per-vertex tangent xyz + handedness (game shaders) */
    tangents?: Float32Array;
    /** every texture of the material by role (diffuse, normal, properties, `texture 5` …) */
    textures?: Record<string, string>;
    /** model previews of skinned meshes: what a GPU-skinned program reads (portraits are skinned on the CPU) */
    skin?: PartSkin;
}

/**
 * The engine's skinning inputs for one mesh part (docs/shaders.md, "GPU skinning"): the vertex streams BoneIndex /
 * BoneWeight and the joint matrices of JointVertexMatrices.
 */
export interface PartSkin
{
    /** 4 bone indices per vertex (unused influences: bone 0 with weight 0) */
    bones: Uint16Array;
    /** the first 3 weights per vertex (the engine's stream); the fourth is what they leave of 1 */
    weights: Float32Array;
    /** posed world · inverse bind per joint in bone index order, 12 floats each: x, y, z axis and translation */
    joints: Float32Array;
    /**
     * the pdxmesh `scale`: it scales the rig's space, vertex positions and joint translations (already in `joints`),
     * not the joints' own axes (AGOT's particle cards read opacity from an axis length)
     */
    scale: number;
}

// ---------------------------------------------------------------------------
// 3D model files (.asset declarations, .mesh geometry): see docs/images.md
// ---------------------------------------------------------------------------

/** A texture of a model material: the role the material gives it, the reference as written, the image it resolves to. */
export interface ModelTexture
{
    role: string;
    ref: string;
    /** image entity name (game path); absent = not found */
    path?: string;
}

export interface ModelMeshSettings
{
    shape: string;
    /** sub-mesh of the shape (a shape holds one mesh per material) */
    index: number;
    shader?: string;
    /** `shader_file`: the effect file defining the shader */
    shaderFile?: string;
    /** `additional_shader_defines` */
    defines?: string[];
    textures: ModelTexture[];
}

export interface ModelPdxMesh
{
    name: string;
    fileRef: string;
    /** model entity name of the .mesh; absent = not found */
    file?: string;
    scale?: number;
    settings: ModelMeshSettings[];
    blendShapes: { id: string; ref: string; file?: string; }[];
    animations: { id: string; ref: string; additive: boolean; }[];
    line: number;
}

export interface ModelEntityDecl
{
    name: string;
    pdxmesh?: string;
    /** asset file declaring that pdxmesh when it is another one */
    pdxmeshAsset?: string;
    defaultState?: string;
    states: { name: string; animation?: string; }[];
    /** attached entities (locators), with the asset file declaring them */
    attaches: { node?: string; entity?: string; asset?: string; }[];
    attributes: number;
    scale?: number;
    /** clothes: pattern mask texture and accessory variation */
    patternMask?: ModelTexture;
    variation?: string;
    line: number;
}

export interface AssetFileInfo
{
    kind: 'asset';
    path: string;
    abs: string;
    bytes: number;
    meshes: ModelPdxMesh[];
    entities: ModelEntityDecl[];
    /** other top-level blocks by key (pdxparticle, …) */
    other: { key: string; count: number; }[];
    /** every resolved texture, in order of appearance */
    textures: ModelTexture[];
    /** accessories (gfx/portraits/accessories) showing entities of this file */
    accessories: string[];
    source: DefSiteView;
}

export interface MeshShapeInfo
{
    name: string;
    vertices: number;
    triangles: number;
    skinned: boolean;
    uvSets: number;
    shader?: string;
    lod?: number;
    decal?: boolean;
    min: [number, number, number];
    max: [number, number, number];
    textures: ModelTexture[];
}

export interface MeshFileInfo
{
    kind: 'mesh';
    path: string;
    abs: string;
    bytes: number;
    shapes: MeshShapeInfo[];
    bones: string[];
    /** pdxmesh declarations using this file */
    declaredIn: { asset: string; pdxmesh: string; }[];
    /** blend shape targets: whose morph target this file is */
    blendShapeOf: { asset: string; pdxmesh: string; id: string; }[];
    error?: string;
}

export type ModelInfo = AssetFileInfo | MeshFileInfo;

export interface ModelGeometry
{
    parts: PortraitPart[];
    /** mesh file shown (for an asset: the chosen pdxmesh's) */
    mesh: string;
    pdxmesh?: string;
    bones: number;
    /** animation whose first frame the parts' joint matrices hold (the entity's default state); absent = bind pose */
    pose?: string;
    /**
     * meshes creatures show (docs/portraits.md, "Creatures"): the decal list of the first character whose portrait shows
     * the mesh (`decalsFrom`): their game shaders may take their colours from it
     */
    decals?: PortraitDecal[];
    decalsFrom?: string;
}

// ---------------------------------------------------------------------------
// Blender round trip (docs/blender.md): glTF export of a mesh, import back into the active mod
// ---------------------------------------------------------------------------

export interface ModelExportResult
{
    /** the .gltf written; `files`: everything written next to it (bin, PNGs, manifest) */
    gltf: string;
    files: string[];
    counts: { shapes: number; primitives: number; vertices: number; triangles: number; joints: number; materials: number; textures: number; blendShapes: number; };
    warnings: string[];
}

/** What "Import from Blender…" would write, or why it can't. */
export interface ModelImportPlan
{
    mod?: { id: string; name: string; loaded: boolean; };
    /** the .mesh file (game path = its path in the mod) */
    mesh?: string;
    problem?: string;
}

/** An asset's file in the active mod: its game path, the mod's name, the file when the mod has one (overrides it). */
export interface AssetOverride
{
    rel: string;
    mod: string;
    file?: string;
}

export interface ModelImportResult
{
    mod: { id: string; name: string; loaded: boolean; };
    /** the glTF / GLB imported */
    source: string;
    files: { rel: string; abs: string; what: string; }[];
    shapes: { name: string; triangles: number; vertices: number; status: 'matched' | 'new'; }[];
    removed: string[];
    notes: string[];
    warnings: string[];
    /** the mod is loaded: the index takes the files in */
    reindex: boolean;
    /** the undo step of the change (mods/undo.ts) */
    step?: number;
}

// ---------------------------------------------------------------------------
// The game's shaders (gfx/FX effect files compiled to WebGL2): see docs/shaders.md
// ---------------------------------------------------------------------------

export interface ShaderRequest
{
    /** effect file as assets name it: `gfx/FX/pdxmesh.shader` */
    file: string;
    /** Effect name = the `shader` of a meshsettings block */
    effect: string;
    /** extra defines (engine-set ones like PDX_MESH_UV1, viewer choices like NO_FOG) */
    defines?: string[];
    /** effect defines to leave out (map-only paths) */
    remove?: string[];
    /** uniform array lengths to declare instead of the engine's placeholders (`Data[2]`) */
    arrays?: Record<string, number>;
    /** append the viewer's exposure / tone mapping / sRGB step to the pixel shader (uniform PdxViewerExposure) */
    post?: boolean;
}

export interface ShaderProgram
{
    file: string;
    effect: string;
    defines: string[];
    /** GLSL ES 3.00 without the #version line */
    vertex: string;
    fragment: string;
    /** vertex inputs: `a_<field>` */
    attributes: { name: string; field: string; type: string; semantic?: string; location: number; }[];
    samplers: { name: string; type: string; index?: number; ref?: string; file?: string; props: Record<string, string>; }[];
    states: { blend?: Record<string, string>; raster?: Record<string, string>; depth?: Record<string, string>; };
    /**
     * uniform → the uniform whose value it takes: members of a constant buffer declared again under other names
     * (AGOT's copy of PdxCamera: `Camera_Position` = `CameraPosition`); the engine fills buffers by layout
     */
    aliases?: Record<string, string>;
}

export interface ModelFolderItem
{
    name: string;
    file: string;
    kind: 'asset' | 'mesh';
    /** a diffuse texture to show as thumbnail */
    thumb?: string;
    /** asset files: "2 meshes · 1 entity"; meshes: blend shape / animation hints */
    summary?: string;
    /** ModInfo id of the mod providing the file (absent = the game) */
    mod?: string;
    /** how the loaded mods touch the file: added, overridden (it replaces the game's); two or more mods: a conflict */
    touch?: ModTouch;
    /** removed by this mod's replace_path (ModInfo id): the game with the loaded mods doesn't load it */
    removed?: string;
}

// ---------------------------------------------------------------------------
// The GUI tab (docs/gui-designer.md): the game's `.gui` files
// ---------------------------------------------------------------------------

/** a `window`, another named root widget, a `type` of a `types` group, a `template` */
export type GuiKind = 'window' | 'root' | 'type' | 'template';

/** A definition in the list of the GUI tab. */
export interface GuiItem
{
    kind: GuiKind;
    name: string;
    /** a window / root: its widget kind or the type it is made from; a type: what it is based on */
    base: string;
    /** the `types` group of a type */
    group?: string;
    /** `local_type` / `local_template`: only the file's own */
    local?: boolean;
    file: string;
    line: number;
    /** the mod the file is from (ModInfo id; absent = the game) */
    mod?: string;
}

/** What a definition uses (one row per name, with how often). */
export interface GuiUse
{
    kind: 'template' | 'type' | 'texture' | 'text' | 'scriptedGui' | 'function';
    name: string;
    count: number;
    /** the first line it is used at */
    line: number;
    /** a template / type: the definition */
    gui?: { kind: GuiKind; name: string; };
    /** a texture, a text key, a scripted GUI: the entry of the explorer */
    entry?: EntityKey;
    /** a text key: its text */
    text?: string;
}

export interface GuiDefView
{
    item: GuiItem;
    /** the definition as written, from `line` to `endLine` */
    text: string;
    endLine: number;
    /** the file's path as the app shows and opens it (a zip: `archive.zip › entry`) */
    where: string;
    uses: GuiUse[];
}

/** A widget of the GUI tab's preview, laid out (src/main/gui/layout.ts): on the game's screen, in pixels at UI scale 100%. */
export interface GuiBox
{
    /** its order in the expanded tree (what GuiToggle.id and guiLayout's `hidden` name) */
    id: number;
    /** as written: a widget kind or a type's name */
    key: string;
    /** the engine's kind it is in the end (vbox, icon, textbox …) */
    kind: string;
    name?: string;
    /** the types it is made from, the written one first */
    types?: string[];
    x: number;
    y: number;
    w: number;
    h: number;
    file: string;
    /** the file's path as the app opens it */
    where: string;
    line: number;
    /** what brought it in: `type x`, `template y`, `blockoverride "z"` */
    via?: string[];
    /** a textbox's text (a binding as its function's name) */
    text?: string;
    /** children cut at its edges (a scroll area) */
    clip?: boolean;
    /** a list's item, drawn once (the game draws one per row of its data) */
    sample?: boolean;
    /** what the layout could not know (a position from a binding …) */
    notes?: string[];
    /** a bound `visible` */
    visible?: string;
    /** a bound text (its sample is shown; GuiLayoutOptions.samples changes it) */
    bound?: string;
    /** what it draws, in order: its `background`s, then its own texture */
    paint?: GuiPaint[];
    /** how its `text` is set (a textbox, a button with a text of its own) */
    textStyle?: GuiTextStyle;
    /** its text in pieces when it has inline formats, text icons, data or concepts (else `text` as it is) */
    runs?: GuiRun[];
    /** the mod its file is from (ModInfo id; absent = the game) */
    mod?: string;
    /** its properties as the game reads them (scalars and lists), its own and those from its types and templates */
    props?: GuiProp[];
    /** how it can be moved and resized on the canvas */
    place?: GuiPlace;
    /** its property blocks (`background`, `state`, `modify_texture` …), its own and those from its types and templates */
    blocks?: GuiBlock[];
    children: GuiBox[];
}

/** A texture a widget draws (a `background` block or its own `texture`). */
export interface GuiPaint
{
    /** a game path; absent when bound (`bound` holds the binding) */
    texture?: string;
    bound?: string;
    /** where, relative to the widget's box (a background's `margin` grows it, a negative one insets it) */
    x: number;
    y: number;
    w: number;
    h: number;
    /** `spriteType = Corneredtiled / Corneredstretched`: nine-slice with `border` (texels: left top right bottom) */
    sprite?: 'tiled' | 'stretched';
    border?: [number, number, number, number];
    /** texels per pixel (`texture_density`, default 1) */
    density?: number;
    /** a sheet of frames: the frame's size in texels and which one (1-based; a button's `upframe`) */
    frame?: { w: number; h: number; n: number; };
    alpha?: number;
    mirror?: string;
    /** `fittype` (centercrop …) */
    fit?: string;
    /** `color` / `tintcolor` (r g b a, 0–1): multiplies the texture */
    color?: [number, number, number, number];
    /** `modify_texture` with `blend_mode = alphamultiply` (at full alpha): masks cutting it (overlays are not drawn) */
    masks?: GuiMask[];
    /** a progressbar's progress: only this share of the rectangle shown (from the left, or the bottom when vertical) */
    fill?: { part: number; vertical?: boolean; };
    /** drawn by the preview instead of a texture: a portrait's silhouette, a sample coat of arms (cut by `mask`) */
    stand?: 'portrait' | 'coa';
    mask?: string;
}

/** Moving and resizing a widget on the canvas (stage 3): what its `position` is and where its own anchor point lies. */
export interface GuiPlace
{
    /** placed by its parent (an hbox / vbox / flowcontainer / list): `position` does nothing there */
    inBox?: boolean;
    /** its `position` (0 0 when none); absent when bound to data */
    pos?: [number, number];
    /** its widgetanchor as fractions of its size (left / top 0, centre 0.5, right / bottom 1) */
    wa: [number, number];
    /** its `size` is bound to data: not resizable */
    boundSize?: boolean;
}

/** A property block of a widget (stage 3): edited where it is written: the widget's own, or a shared type / template. */
export interface GuiBlock
{
    key: string;
    /** where it is written (what GuiEditRequest.at names: the block statement itself) */
    file: string;
    where: string;
    line: number;
    mod?: string;
    /** written in the widget's statement itself; else in `from` */
    own: boolean;
    from?: string;
    /** its `name` (a state's) */
    name?: string;
    props: GuiProp[];
    /** blocks inside it (a background's modify_texture) */
    blocks: GuiBlock[];
}

/** A widget's property for the property grid. */
export interface GuiProp
{
    key: string;
    /** as written: `top|right`, `{ 100 30 }`, `[Data.Function]` */
    value: string;
    /** written in the widget's statement itself (editable there); else it comes from `from` */
    own: boolean;
    /** a type or template it comes from, or where it is written */
    from?: string;
}

/** A change of one widget's property in a `.gui` file (mods:editGui, the active mod; a game file is copied whole first). */
export interface GuiEditRequest
{
    /** the widget statement: where it is written (GuiBox file / where / line / key / mod) */
    at: { rel: string; where: string; line: number; key: string; mod?: string; };
    /** set (or add) `key = value`; `value` as written (`{ 100 30 }` for a list; quoted when it holds spaces) */
    set?: { key: string; value: string; };
    /** remove the widget's own `key` */
    remove?: string;
    /** add a statement (a new widget: `icon = {\n\tsize = { 48 48 }\n}`, tabs for its own nesting) as the widget's last child */
    insert?: string;
    /** the widget tree: delete the widget statement */
    delete?: boolean;
    /** the widget tree: swap the widget with the widget statement before (-1) / after (1) it */
    shift?: -1 | 1;
    /** the widget tree: move the widget statement into another widget of the same file (by its line and key) as its last child */
    moveInto?: { line: number; key: string; };
    /** more changes of the same widget in the same undo step (a resize: `size` and `position`) */
    also?: { set?: { key: string; value: string; }; remove?: string; }[];
    label?: string;
}

/** A piece of a text: words in a format of their own (`#high …#!`), or a text icon's picture (`@gold_icon!`). */
export interface GuiRun
{
    t?: string;
    /** a text icon: its texture */
    icon?: string;
    color?: [number, number, number];
    italic?: boolean;
    bold?: boolean;
}

export interface GuiTextStyle
{
    /** a font name of fonts/fonts.font (StandardGameFont, TitleFont …): GuiLayoutView.fonts has its files */
    font?: string;
    size: number;
    /** `align` as written (left, center|nobaseline, right …) */
    align?: string;
    /** `default_format` / `fontcolor` resolved (r g b, 0–1) */
    color?: [number, number, number];
    italic?: boolean;
    bold?: boolean;
    multiline?: boolean;
    /** `elide = right / left / middle`: a text too long for its box is cut with … */
    elide?: string;
    /** the textbox's `margin` (top right bottom left): padding around the text */
    pad?: [number, number, number, number];
}

/** A font's files by style (game paths: fonts/Gitan/GitanLatin-Regular.otf), served as ck3://font/<path>. */
export interface GuiFontFiles
{
    regular?: string;
    bold?: string;
    italic?: string;
    boldItalic?: string;
}

export interface GuiMask
{
    texture: string;
    sprite?: 'tiled' | 'stretched';
    border?: [number, number, number, number];
    density?: number;
}

/** How the preview fills in the game's data (stage 4): sample texts typed per widget id, rows of bound lists. */
export interface GuiLayoutOptions
{
    samples?: Record<number, string>;
    rows?: number;
    /** widgets switched on that are hidden by default (GuiToggle.alt) */
    shown?: number[];
}

/** A widget whose `visible` is bound: the preview draws it unless switched off. */
export interface GuiToggle
{
    id: number;
    label: string;
    visible: string;
    file: string;
    line: number;
    /** not drawn now (hidden by default or switched off) */
    off: boolean;
    /** hidden by default: an alternative the game shows one at a time (`Not(X)` beside `X`, siblings that all depend on data) */
    alt?: boolean;
}

export interface GuiLayoutView
{
    root: GuiBox;
    /** every box together (decorations stand out of the window) */
    bounds: { x: number; y: number; w: number; h: number; };
    screen: { w: number; h: number; };
    toggles: GuiToggle[];
    /** the fonts the texts use */
    fonts: Record<string, GuiFontFiles>;
}

export interface GuiDetail
{
    kind: GuiKind;
    name: string;
    /** every definition of the name, in file order (the game takes one; which is not settled yet) */
    defs: GuiDefView[];
    /** definitions using it (at most 300 of `usedByCount`) */
    usedBy: GuiItem[];
    usedByCount: number;
}

/** A file of a gallery folder (images, models: GameIndex.filesIn). */
export interface GalleryFile
{
    /** game path */
    name: string;
    /** file name */
    file: string;
    /** ModInfo id of the mod providing the file (absent = the game) */
    mod?: string;
    /** how the loaded mods touch the file (the state filter: added, overridden, conflicts) */
    touch?: ModTouch;
    /** images: the mod whose replace_path removed the file (no entry of its own; the picture is the former file's) */
    removed?: string;
}

/** A gallery folder with its file count, and how many of its files the loaded mods touch, per state and conflicts. */
export interface GalleryFolder
{
    folder: string;
    count: number;
    modCount?: number;
    modStates?: Partial<Record<ModTouch['state'] | 'conflicts' | 'duplicates' | 'conflictsRemoved' | 'duplicatesRemoved', number>>;
    /** images a mod's replace_path removed (not in `count`) */
    removed?: number;
}

/** One pattern per channel of the pattern mask: colour mask texture tiled over the second UV set. */
export interface PortraitPattern
{
    colormask: string;
    /** fabric roughness/metalness/AO replacing the base properties under the pattern */
    properties?: string;
    /** fabric normal map ("RRxG") */
    normal?: string;
    /** UV transform around (0.5, 0.5): rotate (radians), divide by scale, add offset */
    scale: number;
    rotation: number;
    offset: [number, number];
}

/** One entry of the shader error log (logs/shaders.log, see src/main/shaderLog.ts). */
export interface ShaderLogEntry
{
    kind: string;
    title: string;
    detail?: string;
}

export interface TextureData
{
    width: number;
    height: number;
    rgba: Uint8Array;
}

// ---------------------------------------------------------------------------
// Map (docs/map.md)
// ---------------------------------------------------------------------------

/**
 * A landed title on the map at the map's date (docs/map.md, "History and realms"): de jure tree (parent), colour
 * (#rrggbb, from its `color` or history), name, holder and liege.
 */
export interface MapTitle
{
    key: string;
    /** the name at the date: history's (`name = WEST_FRANCIA`), the cultural name for the holder's culture, or, for a
     *  ruler's primary title, the realm name after their house ("Abbasid Empire"); else the loc name */
    name: string;
    /** the title's own name when `name` is a realm name after the holder's house */
    baseName?: string;
    /** h e k d c b */
    tier: string;
    color?: string;
    /** de jure liege at the date (index into MapInfo.titles), −1 for the top */
    parent: number;
    /** the holder at the date: character id and name; their house (name), age, culture and faith then */
    holder?: { id: string; name: string; house?: string; age?: number; culture?: { key: string; name: string; }; faith?: { key: string; name: string; }; };
    /** held titles: the primary title of the holder's liege (index into MapInfo.titles) */
    liege?: number;
    /** held titles: the holder's primary title (index; the title itself for the primary one) */
    primary?: number;
}

/** Cultures, faiths, terrains, holdings …: what a layer colours by. */
export interface MapThing
{
    key: string;
    name: string;
    color?: string;
    /** type of the index entry (a link), when it is one */
    type?: string;
    /** a line about it beside the name (a holy site: the faiths it is holy to) */
    note?: string;
}

/** Province kinds (default.map): what is water and what cannot be walked. */
export type MapKind = 'none' | 'land' | 'sea' | 'lake' | 'river' | 'impassable' | 'impassable_sea';

/**
 * A map mode other than realms and de jure titles (src/main/map/layers.ts): per province a thing (categorical) or a
 * value (numeric, coloured along `scale`).
 */
export interface MapLayer
{
    /** 'culture', 'faith', 'terrain', 'holding' … (the mode id) */
    id: string;
    /** the mode's button ('Cultures') */
    label: string;
    /** what the mode shows (the button's tooltip) */
    title?: string;
    /** the side panel's row for a province ('Culture') */
    row: string;
    /** read from the history at the map's date (the date control applies) */
    historical?: boolean;
    /** water provinces are coloured too (terrain) */
    water?: boolean;
    /** names are drawn on the map (default yes; off where a thing covers scattered provinces: terrain, holdings) */
    labels?: boolean;
    /** categorical: the things, `values` index them (−1: none) */
    things?: MapThing[];
    /** per province: an index into `things`, or the value (numeric; NaN: none) */
    values: number[];
    /**
     * numeric: colours from low to high over min … max: even bands, or from `steps` on (each band's lowest value,
     * ascending, one per colour; the last band takes all above)
     */
    scale?: { min: number; max: number; colors: string[]; unit?: string; steps?: number[]; };
}

export interface MapInfo
{
    /** a loaded save's map (MapStatic.save): its date and the played characters */
    save?: { date: string; players?: string[]; };
    /** the raster file: ck3://map/<key>.bin (province ids, Uint16, row-major, top row first) */
    key: string;
    width: number;
    height: number;
    /** province ids 0 … count − 1 */
    count: number;
    /** the history date the holders, cultures, faiths and holdings are read at (y.m.d) */
    date: string;
    /** the bookmarks' start dates */
    dates: { date: string; label: string; }[];
    /** the years the history covers (from when a tenth of the counties has had a holder to the last holder changes, the
     *  bookmarks included): the date control's range */
    range: { from: number; to: number; };
    kinds: MapKind[];
    titles: MapTitle[];
    /** the other map modes (cultures, faiths, terrain, holdings …) */
    layers: MapLayer[];
    /** per province id (−1: none) */
    province: {
        kind: number[];
        /** the barony (index into titles) */
        barony: number[];
        /** the province's name (a barony's is its title's; seas and wastelands: src/main/map/names.ts) */
        name: string[];
        /** the realm: the top liege's primary title at the date */
        realm: number[];
        /** the top liege's direct vassal the province is under (their primary title), else the realm (the top liege's own) */
        vassal: number[];
        /** pixel count, centre, bounds (x0 y0 x1 y1 per id) */
        area: number[];
        cx: number[];
        cy: number[];
        box: number[];
    };
    /** colour map of the terrain (gfx path), shown under the map mode's colours */
    terrainImage?: string;
    /** the paper map (gfx path) */
    paperImage?: string;
}

/**
 * What of MapInfo is the same at every date (per index state and map files): fetched once, then only a MapDated per
 * date; the renderer composes them into MapInfo (src/shared/mapCompose.ts; docs/map.md, "History and realms").
 */
export interface MapStatic
{
    /** this map data's version: a MapDated of another version needs the MapStatic of its own */
    version: string;
    /** a loaded save's map (docs/saves.md): its state at its date only, no other date to show; `players`: the played characters' ids (the fog of war's default viewpoint) */
    save?: { date: string; players?: string[]; };
    key: string;
    width: number;
    height: number;
    count: number;
    dates: MapInfo['dates'];
    range: MapInfo['range'];
    kinds: MapKind[];
    titles: {
        key: string[];
        /** the loc name (the key made readable when it has none) */
        name: string[];
        /** h e k d c b, a letter per title */
        tier: string;
        /** landed_titles `color` */
        color: (string | undefined)[];
    };
    province: Omit<MapInfo['province'], 'realm' | 'vassal'>;
    /** every layer at the first date; the ones read at a date come with each MapDated again (their values at least) */
    layers: MapLayer[];
    terrainImage?: string;
    paperImage?: string;
}

/** A holder's culture or faith. */
export interface MapNamed
{
    key: string;
    name: string;
}

/** What of MapInfo changes with the date, compact (typed arrays, names only where they differ). */
export interface MapDated
{
    /** MapStatic.version of the static part it goes with */
    version: string;
    date: string;
    titles: {
        /** de jure liege per title, −1 */
        parent: Int32Array;
        /** per title: its holder (index into holders), −1 */
        holder: Int32Array;
        /** [title, name at the date, its own name (house and nomad realm names)] where the name is not MapStatic's */
        names: [number, string, string?][];
        /** [title, colour] where history changed it */
        colors: [number, string][];
    };
    holders: {
        id: string[];
        name: string[];
        /** house (with its prefix, index into houses), −1 */
        house: Int32Array;
        houses: string[];
        /** years at the date (at death when dead), −1 unknown */
        age: Int16Array;
        /** index into cultures / faiths, −1 */
        culture: Int32Array;
        faith: Int32Array;
        cultures: MapNamed[];
        faiths: MapNamed[];
        /** per holder: their primary title; their liege's primary title, −1 */
        primary: Int32Array;
        liege: Int32Array;
    };
    province: { realm: Int32Array; vassal: Int32Array; };
    /**
     * The layers at the date, in order: `{ id }` alone: MapStatic's layer as it is; else its values (Int32Array:
     * things, Float64Array: numeric), its things when not MapStatic's, the rest of it when that differs
     */
    layers: { id: string; values?: Int32Array | Float64Array; things?: MapThing[]; layer?: Omit<MapLayer, 'values' | 'things'>; }[];
}

// --- the 3D map's terrain (src/main/map/terrain.ts) ------------------------------------------------------------

/**
 * The 3D map's terrain (map/terrain.ts): rasters served as ck3://map/<key>-height.bin and <key>-rivers.bin, the
 * terrain's materials and map objects, and the game's settings for heights, water, camera and light. World units: a
 * province map pixel is one unit across, heights go up.
 */
export interface MapTerrainInfo
{
    key: string;
    /**
     * The height raster: Uint16 per pixel, row-major, top row first, 0 … 65535 = 0 … heightScale: heightmap.png
     * averaged down by a whole factor to about the province map's size (vanilla 18432 × 9216 → 9216 × 4608).
     */
    width: number;
    height: number;
    /** world units of the highest height (NJominiMap WORLD_EXTENTS_Y: vanilla 50, AGOT 85) */
    heightScale: number;
    /** the water surface (NJominiMap WATERLEVEL: vanilla 3, AGOT 6.2) */
    waterLevel: number;
    /** the rivers raster, rivers.png's size: a byte per pixel, 0 none, 1 … 13 the river's width (narrowest first) */
    rivers?: { width: number; height: number; };
    /**
     * The game's camera (NCamera): field of view (degrees), per zoom step (near first) the height and the tilt in
     * degrees above the horizon (ZOOM_STEPS, ZOOM_STEPS_TILT, ZOOM_STEPS_MIN_TILT / MAX_TILT); the zoom step from which
     * the large map names show instead of the small ones (NMapName LARGE_NAMES_ZOOM_STEP)
     */
    camera: { fov: number; heights: number[]; tilts: number[]; minTilts: number[]; maxTilts: number[]; largeNames: number; };
    /** the water's colour map (gfx path; water.settings WaterColorTexturePath) */
    waterImage?: string;
    /** gfx/map/water/water.settings `WaterWave1…3.Speed`: how fast the water's three wave layers scroll (uv per second) */
    waveSpeeds?: [number, number, number];
    /**
     * The terrain's materials (map/terrain-detail.ts, gfx/map/terrain): ck3://map/<key>-detail.bin: per pixel of the
     * detail maps (`width` × `height`, bottom row first) 4 × Uint16 layer | intensity << 8 (layer 255: none); and
     * <key>-materials.bin: the BC3 arrays diffuse, normal, properties of `layers.length` layers `size`² with `levels`
     * mips (per array level by level, each level layer by layer). Absent without detail maps.
     */
    detail?: {
        key: string;
        width: number;
        height: number;
        size: number;
        levels: number;
        /** per layer: the material and how often it tiles across the map's width */
        layers: { name: string; tile: number; }[];
        /** settings.terrain: where the tiling starts (map pixels from the bottom left), blend range, normals' height scale */
        offset: [number, number];
        blendRange: number;
        normalScale: number;
    };
    /**
     * Trees and other map objects (map/terrain-objects.ts, gfx/map/map_object_data): ck3://map/<key>-objects.bin:
     * Float32 vertices (position with the pdxmesh scale, normal, tangent xyz + handedness, uv: 12 each), Uint32 indices
     * (per part from its first vertex), Float32 instances (x, y over the ground, z from the map's bottom, yaw, scale: 5
     * each; per group sorted by cell), Uint32 cells (start, count within the group; per group `cols` × `rows` cells of
     * `cell` map pixels, bottom row first).
     */
    objects?: {
        key: string;
        vertices: number;
        indices: number;
        instances: number;
        cell: number;
        cols: number;
        rows: number;
        /** a mesh part with its textures (gfx paths); `tree`: drawn with the tree shader (tint strip, colour map) */
        parts: { vertexStart: number; vertexCount: number; indexStart: number; indexCount: number; textures: { diffuse?: string; normal?: string; properties?: string; tint?: string; }; tree: boolean; snap?: boolean; coverage?: boolean; }[];
        /** a pdxmesh: its parts, top and radius (map pixels) */
        models: { name: string; parts: number[]; height: number; radius: number; }[];
        /** instances of a model in a layer: the zoom step it fades out at, clamped to the water level; `cells`: its first cell */
        groups: { model: number; fade: number; clamp: boolean; start: number; count: number; cells: number; dynamic?: boolean; }[];
    };
    /**
     * The game's map light and post-processing (gfx/map/environment/environment.txt; the TERRAIN_SUNNY_* and
     * MAP_OBJECTS_SUNNY_* constants of gfx/FX/jomini/map_lighting.fxh). Sun direction: azimuth 0 north, 0.25 west …;
     * elevation 0 horizon … 1 zenith.
     */
    look: {
        sun: { azimuth: number; elevation: number; color: [number, number, number]; intensity: number; ibl: number; };
        objectSun: { azimuth: number; elevation: number; color: [number, number, number]; intensity: number; ibl: number; };
        /** the environment cubemap (gfx path) and cubemap_intensity */
        cubemap?: string;
        cubemapIntensity: number;
        exposure: number;
        contrast: number;
        pivot: number;
        /** tonemap_function; TonyMcMapface's LUT: ck3://map/<key>-tonemap.bin, RGBA half floats (48 slices of 48² side by side) */
        tonemap: string;
        lut?: { key: string; width: number; height: number; };
        /** distance haze: sRGB colour, start and end distance (map pixels), strength */
        fog: { color: [number, number, number]; begin: number; end: number; max: number; };
        /**
         * The shadow tint (gfx/FX/shadow_tint.fxh; NMapColors MAP_SHADOW_TINT_*): the colour texture (gfx path, sRGB,
         * alpha = strength), the strength, the thresholds of n·l it fades over, its repeats over the map.
         */
        shadowTint: { texture: string; strength: number; min: number; max: number; tiling: [number, number]; };
    };
}

// --- the map's fog of war (src/main/map/fog.ts) ---

/**
 * The game's fog of war settings (docs/map.md, "Fog of war"): common/defines NFogOfWar through the mods' layering (a
 * mod's own file wins), and the sea crossings that make two provinces neighbours.
 */
export interface MapFogInfo
{
    /** the base alpha of a province out of sight (0 black … 1 not hidden) */
    alphaMin: number;
    /** a loaded mod ships the mask's shader (its own fog): the noise pattern is off, only the mask and the blend to black are drawn */
    ownShader: boolean;
    /** the noise pattern laid over the mask (strength, tiling over the map) */
    patternStrength: number;
    patternTiling: number;
    /** the camera's zoom step from which the fog fades out, and how fast (steps) */
    fadeOutZoomStep: number;
    fadeOutSpeed: number;
    contrast: number;
    brightness: number;
    /** the mask's size, the blur's radius in mask pixels */
    textureWidth: number;
    textureHeight: number;
    kernelScale: number;
    /** gfx path of the noise texture baked into the mask (absent: none) */
    noiseTexture?: string;
    /** the alpha of the viewpoint's realm and of the provinces next to it (0 … 1) */
    realmAlpha: number;
    neighborAlpha: number;
    /** adjacencies.csv's `sea` rows: pairs of provinces (from, to, from, to …) */
    links: number[];
}

// --- the map's overlays (src/main/map/overlays.ts) --------------------------------------------------------------

/**
 * Lines over the map (map/overlays.ts, docs/map.md "Rivers and sea crossings"): the rivers of rivers.png as smooth
 * lines and the sea crossings of adjacencies.csv, built once per version of the files.
 */
export interface MapOverlaysInfo
{
    key: string;
    /** the province map's size (map pixels) */
    width: number;
    height: number;
    /**
     * The rivers (none without rivers.png): ck3://map/<key>-riverlines.bin holds per level of detail (finest first) a
     * block at byte `at`: x, y per point (Float32, map pixels, y down), per river its first point and point count
     * (Uint32), per point the width class 1 … `classes` × 16 (Uint8; smoothed along the river, so fractional). A level is
     * simplified to within `tolerance` map pixels; each river is drawn as the quadratic B-spline of its points (through
     * the ends and the midpoints between points).
     */
    rivers?: {
        levels: { tolerance: number; points: number; rivers: number; at: number; }[];
        /** the width classes (NRivers NUM_WIDTH_PIXEL_VALUES: 13) and the widths of the first and last (WIDTH_MIN, WIDTH_MAX: 1 and 4 map pixels) */
        classes: number;
        widths: [number, number];
        /** rivers.settings: flow uv scale, flow speed (uv per second), noise scale, noise speed (the 3D map's moving water) */
        flow?: [number, number, number, number];
    };
    /** the crossings between land provinces (type `sea`, and `river_large`, marked `river`): provinces, the sea zone crossed, the line (map pixels, y down; x0 y0 at `from`) */
    crossings: { from: number; to: number; through: number; line: [number, number, number, number]; river?: boolean; }[];
}

// --- editing from the map (src/main/map/edit.ts) --------------------------------------------------------------

/**
 * A change the map makes in the active mod (docs/map.md, "Editing from the map"): at the map's date a county's culture
 * or faith (written on its capital barony's province), a barony's holding (history/provinces), a title's holder or
 * liege, a county's development (history/titles); a title's colour (its definition in common/landed_titles); `undo`:
 * the session's last map edit (with `plan`: only how many can be undone).
 */
export interface MapEditRequest
{
    kind: 'culture' | 'faith' | 'holding' | 'holder' | 'liege' | 'development' | 'color' | 'undo';
    /** the title: the county (culture, faith, development), the barony (holding), any tier (holder, liege, colour) */
    title?: string;
    /** culture, faith: the county's provinces in title order (its capital first); holding: the barony's province */
    provinces?: number[];
    /** development: the county's de jure lieges at the date, lowest first (their `change_development_level` counts too) */
    lieges?: string[];
    /**
     * a culture, faith or holding key; a character id (holder) or title key (liege), '0' for none; development: a whole
     * number; colour: #rrggbb
     */
    value?: string;
    /** the map's date (y.m.d) */
    date?: string;
    /**
     * date: from the date on (a `<date> = { … }` block); current: the statement in effect at the date is changed, from
     * its own date on, from the start when it is undated (history/provinces only). Default: current for culture, faith
     * and holding, else date.
     */
    when?: 'date' | 'current';
    /** nothing is written: what it would change (`current`, `target`) */
    plan?: boolean;
}

export interface MapEditResult
{
    ok: boolean;
    /** what was done, or why not */
    message?: string;
    mod?: { id: string; name: string; };
    /** the file written (absolute and game-relative) and the changed line */
    file?: string;
    rel?: string;
    line?: number;
    /** what else to know: the file copied into the mod first, later history that still changes it … */
    notes?: string[];
    /** map edits of this session that can be undone (every result says it, refusals too) */
    undo?: number;
    /** what the next undo takes back (main's words: `c_paris: culture = norse from the start`) */
    undoNext?: string;
    /** the undo step of this edit (mods/undo.ts) */
    step?: number;
    /**
     * history: the statement in effect at the date, its date ('' undated: from the start), value, file and its source;
     * `title`: the entry it is in when that is another one (development: a de jure liege's)
     */
    current?: { date: string; value: string; rel: string; from: string; title?: string; };
    /** the file an edit writes: `from` names the source whose file is copied into the mod first; `created`: a new file */
    target?: { rel: string; from?: string; created?: boolean; };
}

/** A character for the map's holder chooser (api.mapCharacters), with facts at the map's date. */
export interface MapCharacter
{
    id: string;
    /** first name */
    name: string;
    /** house (else dynasty) name at the date, with its prefix */
    house?: string;
    /** y.m.d */
    birth?: string;
    death?: string;
    /** alive at the date */
    alive: boolean;
    /** age at the date (at death when dead then) */
    age?: number;
    /** culture at the date */
    culture?: { key: string; name: string; };
    /** how they come into a list of suggestions ("son of Harald") */
    note?: string;
}

// --- coats of arms (src/main/coa/coa.ts) --------------------------------------------------------------------

/**
 * Whose arms: a landed title's, a title as its holder's realm (the banner of their government), a dynasty's (by id), a
 * house's, or any coat_of_arms entry (no frame).
 */
export type CoaKind = 'title' | 'realm' | 'dynasty' | 'house' | 'coa';

/**
 * A coat of arms resolved to what is drawn (coa/coa.ts; drawn by components/CoatOfArms.tsx; docs/map.md, "Coats of
 * arms"): a title's, dynasty's or house's entry of common/coat_of_arms/coat_of_arms, with its frame. A title's are
 * those of a game started at the date asked (else the first bookmark's).
 */
export interface CoaInfo
{
    /** the coat_of_arms entry drawn: the asked key, the entry it names (`98 = c_perigord`), a dynamic definition's, a
     *  game start effect's (the holder's house), or the random template */
    key: string;
    /** its own entry, another entry it names (a house without arms: its dynasty's), the first fitting item of its dynamic
     *  definition, set by a game start effect (`set_coa`), or random arms like the game makes for entries without any */
    how: 'own' | 'alias' | 'dynamic' | 'script' | 'random';
    /** where they come from, in a sentence (the tooltip) */
    note: string;
    /** they depend on the date (a title's holder): ask again when it changes */
    dated?: boolean;
    design: CoaDesign;
    /** the game's frame for this kind: title shield, dynasty or house frame of the culture */
    frame?: CoaFrame;
}

/** One coat of arms: a pattern in up to three colours, emblems over it, other arms drawn into parts of it. */
export interface CoaDesign
{
    /** gfx/coat_of_arms/patterns/…: red, green and blue channels paint color1, color2, color3 over the fallback colour */
    pattern: string;
    /** color1 … color5 as #rrggbb */
    colors: string[];
    /** other arms drawn into parts of these (quarters …), before the emblems */
    subs: CoaSub[];
    /** emblem instances, back to front (by `depth`, then as written) */
    emblems: CoaEmblem[];
}

export interface CoaEmblem
{
    /** gfx/coat_of_arms/colored_emblems/… or …/textured_emblems/… */
    texture: string;
    /** colored emblems: color1 (the base), color2 (green channel), color3 (red channel); textured emblems keep their own colours */
    colors?: string[];
    /** shown only on these pattern colours (1–3) */
    mask?: number[];
    /** centre, 0–1 of the arms (y down) */
    x: number;
    y: number;
    /** size, fraction of the arms; negative mirrors */
    sx: number;
    sy: number;
    /** degrees, clockwise */
    rotation: number;
}

export interface CoaSub
{
    design: CoaDesign;
    /** each place it is drawn: left, top, width, height (fractions of the arms) */
    at: [number, number, number, number][];
}

/** How the game's interface shows these arms (gui/shared/coat_of_arms.gui): a shape cut out, a frame around it. */
export interface CoaFrame
{
    /** its alpha is the shape of the arms */
    mask: string;
    /** drawn over the arms: a strip of square cells (dynasty and house frames: one per renown step), cell `index` */
    frame: string;
    index: number;
    /** the frame's size to the arms' (title 96:86) */
    ratio: number;
    /** the arms texture inside the shape: uv = (p − 0.5) / scale + 0.5 + offset (the gui's coat_of_arms_offset / _scale) */
    offset: [number, number];
    scale: [number, number];
    /** texture blended over the arms (overlay, 40 %) */
    overlay?: string;
    /** drawn behind, the frame's size (a realm's shadow), or `underRatio` of it (an unheld title's glow: 104 / 96) */
    under?: string;
    underRatio?: number;
    /** a strip's cell drawn at the frame's size `dy` of it higher (a realm's bar of its tier), room left above the frame */
    top?: { texture: string; index: number; dy: number; };
    /**
     * above it all (a realm's crown (coa_realm_*_crown: the tier's cell of crown_strip_115.dds), or its government's
     * decoration): `aspect` its height to the frame's width, `gap` the space below it (of the frame's width)
     */
    crown?: { texture: string; index: number; aspect: number; gap: number; };
}

export interface PortraitVariation
{
    /** 4-channel mask on the first UV set: which pattern covers which area */
    mask: string;
    /** per mask channel r g b a, then the second colour mask (properties red, normal blue; `SECOND_COLOR_MASK` meshes) */
    patterns: (PortraitPattern | null)[];
    /** 16 (or 32) colours per mask channel pattern slot, one row picked per character */
    palette: [number, number, number][];
}

// ---------------------------------------------------------------------------
// Historical characters: list filters and family tree
// ---------------------------------------------------------------------------

/** Filter for the Historical Characters list; facts are evaluated at `date` (default the 1066 bookmark). */
export interface CharacterFilter
{
    /** yyyy.mm.dd */
    date?: string;
    gender?: 'male' | 'female';
    /** age at the date; only characters alive then match */
    age?: { op: '<' | '>' | '='; value: number; };
    alive?: boolean;
    culture?: string;
    faith?: string;
    religion?: string;
    trait?: string;
    /** dynasty or house: key or part of its name */
    dynasty?: string;
    /** highest title held at the date: ruler (any), unlanded, or a tier */
    rank?: 'ruler' | 'unlanded' | 'barony' | 'county' | 'duchy' | 'kingdom' | 'empire';
    /** has a DNA entry (scripted appearance) */
    dna?: boolean;
}

export interface CharacterFacetValue
{
    key: string;
    label: string;
    count: number;
}

export interface CharacterFacets
{
    cultures: CharacterFacetValue[];
    faiths: CharacterFacetValue[];
    religions: CharacterFacetValue[];
    traits: CharacterFacetValue[];
}

/** A historical character as the statement picker lists it (CharacterTable.search). */
export interface CharacterHit
{
    id: string;
    /** first name, house or dynasty, nickname: "William de Normandie “the Conqueror”" */
    name: string;
    /** highest title at the 1066 bookmark, lifetime, id: "Duchy of Normandy · 1027–1087 · 140" */
    about: string;
    female: boolean;
}

export interface FamilyPerson
{
    id: string;
    /** first name (and nickname) */
    name: string;
    /** dynasty or house name */
    house?: string;
    female: boolean;
    /** yyyy.mm.dd */
    birth?: string;
    death?: string;
    /** highest title at the 1066 bookmark (display name) */
    title?: string;
}

export interface FamilyAncestor extends FamilyPerson
{
    father?: FamilyAncestor;
    mother?: FamilyAncestor;
}

export interface FamilyDescendant extends FamilyPerson
{
    /** the other parent of this child (for the root's children) */
    otherParent?: FamilyPerson;
    children: FamilyDescendant[];
}

export interface FamilyTree
{
    root: FamilyAncestor;
    spouses: FamilyPerson[];
    children: FamilyDescendant[];
    siblings: (FamilyPerson & { half?: boolean; })[];
}

/** Expert "Portrait" tab: what a portrait is built from, for checking mesh mods (no geometry). */
export interface PortraitReport
{
    label: string;
    gender: 'male' | 'female';
    age: number;
    /** portrait type block used: male, female, boy, girl */
    kind: string;
    source: string;
    entities: PortraitEntityReport[];
    decals: { bodyPart: string; texture: string; weight: number; post: boolean; }[];
    tags: string[];
    modifiers: string[];
}

export interface PortraitEntityReport
{
    /** torso, head, or the accessory gene that put it there */
    role: string;
    accessory?: string;
    entity: string;
    /** game-relative and absolute paths (reveal / open in the editor) */
    asset: string;
    assetAbs: string;
    mesh: string;
    meshAbs: string;
    /** skeleton it is skinned with (creatures: their own, attached at a body locator) */
    pose: 'torso' | 'head' | 'creature';
    bones: number;
    idle?: string;
    parts: { shape: string; vertices: number; triangles: number; shader?: string; diffuse?: string; min: [number, number, number]; max: [number, number, number]; }[];
    /** every blend shape attribute of the entity: weight from the genes and what happened */
    blendShapes: { attribute: string; target: string; weight: number; status: 'applied' | 'zero' | 'missing' | 'topology'; detail?: string; }[];
    /** additive animations (bone morphs) in effect: u = default + attribute value, neutral at 0.5 */
    boneMorphs: { attribute: string; animation: string; u: number; }[];
}

/** What the viewer asks for: toggles for fine features, proportions and the undressed look. */
export interface PortraitRequest
{
    blendShapes?: boolean;
    boneMorphs?: boolean;
    /** undressed as the game shows naked characters */
    naked?: boolean;
    /** undressed adults wear the fig leaf unless false */
    figLeaf?: boolean;
    /** the barbershop: genes set over the subject's DNA, and the age and sex to show */
    genes?: DnaGene[];
    age?: number;
    female?: boolean;
    /** a historical character at this date (y.m.d, the preview date: age, titles, clothes); absent: the 1066 bookmark */
    date?: string;
}

/**
 * One gene of a DNA (docs/portraits.md, "Barbershop"): both pairs as the files write them, template and value (0..255)
 * for morph and accessory genes, a palette point (x y, 0..255) for colour genes. The first pair is the one shown.
 */
export interface DnaGene
{
    gene: string;
    template?: string;
    value: number;
    template2?: string;
    value2?: number;
    /** colour genes: the palette points of both pairs */
    xy?: [number, number];
    xy2?: [number, number];
}

/** A gene the barbershop offers (common/genes: the genes with a `group`, as the game's ruler designer). */
export interface DnaGeneInfo
{
    gene: string;
    /** localized name (the gene key when there is none) */
    label: string;
    /** the ruler designer's group (face, eyes, nose, mouth, head_neck, ears, body, hair, beard …) and its name */
    group: string;
    groupLabel: string;
    kind: 'color' | 'morph' | 'accessory';
    /** colour genes: the palette image (gfx/portraits/<color>_palette.dds) */
    palette?: string;
    /** its templates; `visible` false: the ruler designer does not offer it */
    templates: { name: string; label: string; visible: boolean; }[];
    /** accessory genes: per portrait type (male, female, boy, girl) and template, what each value range (0..255) picks */
    accessories?: Record<string, Record<string, { accessory: string; from: number; to: number; }[]>>;
}

/** What the barbershop edits: the subject, its DNA, the genes on offer and where a save goes. */
export interface DnaEditorData
{
    label: string;
    female: boolean;
    age: number;
    source: string;
    genes: DnaGene[];
    catalog: DnaGeneInfo[];
    /**
     * "Beautify": the game's own rule for the most beautiful (trait beauty_good_3: genetic constraint beauty_3 (
     * ethnicity `default_constraints_template`'s options with `traits = { beauty_3 }`)): per gene the templates allowed
     * and the value range (0..255)
     */
    beauty: { gene: string; options: { template: string; min: number; max: number; }[]; }[];
    /** the ethnicity the character's culture gives (`ethnicity_template` without one): Randomize rolls from it */
    ethnicity: string;
    /**
     * where the DNA is kept: a dna_data entry (`character`: the character wearing it) or a bookmark portrait; `create`:
     * the character's face is generated or read from a bookmark dump; a save makes the dna_data entry `name` and sets
     * the character's `dna`
     */
    target: { type: 'dna_data' | 'bookmark_portraits' | 'savegame/characters'; name: string; character?: string; create?: boolean; };
}

export interface DnaSaveRequest
{
    target: DnaEditorData['target'];
    genes: DnaGene[];
}

export interface PortraitData
{
    label: string;
    gender: 'male' | 'female';
    age: number;
    /** Where the face comes from: bookmark portrait, DNA entry or generated from an ethnicity. */
    source: string;
    colors: { skin: [number, number, number]; hair: [number, number, number]; eyes: [number, number, number]; };
    parts: PortraitPart[];
    /** Accessories worn (gene → accessory) */
    accessories: { gene: string; accessory: string; template?: string; }[];
    /** tags set by genes and accessories (e.g. "hat", "shrink_arms") */
    tags: string[];
    /** portrait modifiers applied, as "group.modifier" (empty for bookmark portraits) */
    modifiers: string[];
    applied: { blendShapes: number; boneMorphs: number; genes: number; };
    /**
     * Decals that change no texel (fully transparent diffuse, nothing else), in the engine's decal list order: the bake
     * skips them, but shaders may read them: values coded in their 16×16 mip (docs/shaders.md, "Data decals"). The game
     * shaders get them as the decal list (DecalDataBuffer, DecalDiffuseArray, DecalCount).
     */
    dataDecals?: { diffuse: string; weight: number; post: boolean; blend: 'overlay' | 'replace' | 'hard_light' | 'multiply'; }[];
    /**
     * Creature portraits (a creature entity instead of the human, see docs/portraits.md): the entity and the animation
     * state it is posed in. The viewer frames the whole creature.
     */
    creature?: { entity: string; state?: string; };
    /** creature portraits: the whole decal list (nothing is baked), in the engine's order; their shaders pick from it */
    decals?: PortraitDecal[];
}

export type DecalBlend = 'overlay' | 'replace' | 'hard_light' | 'multiply';

/** One decal of the list the game's portrait shaders walk (GameScene.setDecalList): textures, strength, blend modes. */
export interface PortraitDecal
{
    diffuse?: string;
    normal?: string;
    properties?: string;
    /** gene strength through alpha_curve and age (0..1) */
    weight: number;
    /** decal_apply_order = post_skin_color */
    post: boolean;
    blend: { diffuse: DecalBlend; normal: DecalBlend; properties: DecalBlend; };
    /** uv_tiling */
    tiling?: [number, number];
}

/** API exposed to the renderer via the preload script (window.api). */
// ---------------------------------------------------------------------------
// Mods (docs/mods.md): discovered mods, mod lists with load order, how mods touch entries
// ---------------------------------------------------------------------------

export interface ModInfo
{
    /** stable id: the descriptor path relative to the user folder ('mod/ugc_2962333032.mod'); 'workshop/<id>' for a
     *  Workshop folder without one; 'launcher/<uuid>' for a launcher entry without one */
    id: string;
    name: string;
    version?: string;
    supportedVersion?: string;
    tags: string[];
    /** absolute folder of the mod's files (unpacked) */
    root?: string;
    /** absolute zip of a packed mod */
    archive?: string;
    /** Steam Workshop id */
    remoteId?: string;
    source: 'local' | 'steam' | 'pdx';
    /** folders whose files from the game and earlier mods are ignored */
    replacePaths: string[];
    /** 'missing': neither folder nor archive exists */
    status: 'ok' | 'missing';
    /** the outer descriptor in the user's mod folder, if registered */
    descriptorFile?: string;
    /**
     * the outer descriptor's own `path=` / `archive=` (as written) no longer resolves: the files were found elsewhere (the
     * launcher's row, the same place below this user folder); the game and the launcher still read the stale location
     */
    staleLocation?: string;
    /** the Paradox Launcher's uuid for the mod (needed to write launcher playsets) */
    launcherId?: string;
    /** preview image, absolute */
    thumbnail?: string;
    /** unpacked in the user's mod folder: can be the active (edited) mod, packed, deleted */
    editable: boolean;
    /**
     * a fixes patch mod made by "Fix for …" (its manifest names the mod it is for): that mod, and `obsolete` when the mod now
     * says it supports the game's version: its own files are for it, the patch mod's copies on top of them are old
     */
    patchFor?: { id: string; name: string; obsolete: boolean; };
}

export interface ModListEntry
{
    /** ModInfo.id */
    id: string;
    enabled: boolean;
}

export interface ModList
{
    /** 'playset:<uuid>' (Paradox Launcher), 'game' (dlc_load.json: what the game loads when started directly),
     *  'custom:<id>' (kept by this app) */
    ref: string;
    kind: 'playset' | 'game' | 'custom';
    name: string;
    /** the launcher's active playset */
    active?: boolean;
    /** a launcher playset synced with a Paradox account (its cloud id, sync state, last sync), warned about before writing */
    sync?: { pdxId?: string; state?: string; syncedOn?: string; };
    /** in load order: later mods win */
    mods: ModListEntry[];
}

export interface ModsState
{
    /** the CK3 user folder (detected or configured) and whether it exists */
    userDir: string;
    userDirFound: boolean;
    /** the launcher database could be read */
    launcher: boolean;
    /** every mod found: user mod folder descriptors, launcher entries, Steam Workshop folders */
    mods: ModInfo[];
    lists: ModList[];
    /** ModList.ref loaded into the index, or 'none' */
    selected: string;
    /** ModInfo.id of the mod being edited */
    activeMod?: string;
    /** the game's version (launcher-settings.json), for supported_version checks */
    gameVersion?: string;
}

/** One entry of a mod written the way an older game read it (docs/mods.md, "Migrating a mod"). */
export interface MigrationFinding
{
    /** the version step (`1.19→1.20`) */
    step: string;
    type: string;
    /** the type's readable (translated) name */
    typeLabel?: string;
    name: string;
    display: string;
    /** the mod's file it is in */
    rel: string;
    /** what is old about it (the card's words) */
    what: string[];
    /** the fix (modernize.ts); absent: marked, no automatic fix */
    fix?: { type: string; name: string; fix: string; };
}

/** What a mod needs to follow the loaded game's version. */
export interface MigrationPlan
{
    modId: string;
    supported?: string;
    /** the supported version names no game version (`1.*.*`, `*.*.*`): the steps are all of them */
    versionUnknown?: boolean;
    game?: string;
    steps: { from: string; to: string; label: string; changes: string[]; }[];
    findings: MigrationFinding[];
    /** the version's new folders the patch mod hides (the mod replaces the older ones they follow) */
    replacePaths?: string[];
    /** of those, the ones the patch mod does not hide yet (all, without a patch mod) */
    replacePathsTodo?: string[];
    /** per folder of `replacePaths`: the files of an earlier mod in it that the patch mod hides too */
    replacePathHides?: { folder: string; mod: string; files: number; }[];
    /** the new folders the patch mod does not hide because the mod ships files of its own in them (it laid them out for the new version itself) */
    replacePathsOwn?: string[];
    /** hidden folders the mod has files of its own directly in all the same: its religions still hold their faiths, which the fixes write there (the files of its own go with the hiding) */
    replacePathsShadowed?: string[];
    /** of those, the ones a patch mod of a run before hides all the same (it hides the mod's own files) */
    replacePathsStale?: string[];
    /**
     * the mod's copies of game files that no rule replaces with the game's: `same` (the game's file byte for byte), `current`:
     * holding what the new version's file has (the mod's own changes stay)
     */
    leftAlone?: { same: string[]; current: string[]; };
    /**
     * files the patch mod gets rewritten (a key renamed) or as the game's own (an older copy breaks): per rule;
     * `todo`: of `files`, the ones the existing patch mod still lacks the rule's work on (empty: done, a second run);
     * `notes`: what the rule would do, in words (the shader merge: effects added, effects left out, definitions lost)
     */
    rewrites?: { kind: 'rename' | 'restore' | 'mergefx' | 'empty' | 'settings' | 'modelStates' | 'texts' | 'rewrite' | 'merge' | 'icons' | 'defines' | 'statements' | 'adds' | 'gains' | 'banners' | 'libraries' | 'inert' | 'dataCalls' | 'guiTypes' | 'particles' | 'ddsLegacy' | 'maskMips' | 'renamed'; label: string; files: string[]; todo: string[]; notes?: string[]; }[];
    /** what the plan tells besides its rules (an entry the mod's file and a newer game file both define …) */
    notes?: string[];
    /** statements the rules name but cannot map (`file:line key = value`): they stay as written and no run changes them */
    unmapped?: string[];
    /**
     * interface files of the mod that call what the game version removed, which the owner can choose to take whole from the
     * game instead (never by default): the identifiers the game does not know, the lines of the mod's copy the game's file lacks,
     * the files that nothing would use then
     */
    optional?: { rel: string; names: string[]; custom: number; orphans: string[]; takes: string[]; reasons: string[]; }[];
    /**
     * the patch mod of a run before: the game version it was made for (its manifest; absent for one from before the
     * manifest), `outdated` when a game file it carries is not the game's now and the game is another version than the one
     * it was made for (or it has no manifest)
     */
    patchMod?: {
        name: string;
        builtFor?: string;
        outdated: boolean;
        /**
         * the patch mod is not where it belongs in the loaded list: `missing`: not in it (or disabled), so the mod's entries
         * stand as the mod wrote them; or `before` the mod (it would not override it); a run puts it right after the mod
         */
        placed?: 'missing' | 'before';
        /**
         * the mod changed (or dropped) files the patch mod holds copies of since it took them (the mod was updated): those
         * copies shadow the update. A run deletes what the last run left (`reset`, a count) and builds it again from the
         * mod; `edited` copies changed by hand stay (the update does not reach the ones in `keptStale`)
         */
        stale?: { files: string[]; reset: number; legacy: boolean; };
        keptStale?: string[];
        /** files the patch mod holds that no rule asks for any more (the mod stopped overriding a game file …): a run deletes them; `orphansEdited` stay */
        orphans?: string[];
        orphansEdited?: string[];
    };
    /** the folders the patch mod hides that the mod no longer calls for: a run takes them out of its descriptor */
    replacePathsGone?: string[];
    problem?: string;
}

/** What the owner chose in the dialog besides the rules (docs/mods.md, "Migrating a mod"). */
export interface MigrationOptions
{
    /** interface files taken whole from the game (the plan's `optional`); they stay taken in later runs */
    restore?: string[];
}

/** How far a migration or merge is (mods:progress). */
export interface MigrationProgress
{
    stage: string;
    done: number;
    /** 0: not counted yet */
    total: number;
}

/** What migrating a mod did: the patch mod made, the fixes made and refused. */
export interface MigrationResult
{
    patch: { id: string; name: string; folder: string; };
    list: string;
    copied: string[];
    fixed: string[];
    failed: { name: string; why: string; }[];
    notes: string[];
    /** replace_paths added to the patch mod */
    hidden: string[];
    /** files rewritten in the patch mod or put there as the game's own (MigrationPlan.rewrites) */
    rewritten: string[];
}

/** What deleting a mod of one's own takes (docs/mods.md "Deleting a mod"): shown before it happens. */
export interface DeleteModPlan
{
    id: string;
    name: string;
    /** its folder and outer descriptor (both go to the Recycle Bin) */
    folder: string;
    descriptor?: string;
    files: number;
    /** the app's own lists it is taken out of; whether the game's list (dlc_load.json) names it */
    lists: string[];
    gameList: boolean;
    /** launcher playsets naming it (left as they are: the launcher shows it as missing) */
    playsets: string[];
    active: boolean;
}

export interface DeleteModResult
{
    /** moved to the Recycle Bin (false: deleted for good, no bin) */
    trashed: boolean;
    undoSteps: number;
}

/** What merging a mod list's enabled mods takes (docs/mods.md "Merging mods"). */
export interface MergePlan
{
    ref: string;
    list: string;
    mods: { id: string; name: string; version?: string; supportedVersion?: string; }[];
    replacePaths: string[];
}

export interface MergeRequest
{
    /** the mod list whose enabled mods are merged, in its order */
    ref: string;
    name: string;
    /** the new mod's folder under the user's mod folder */
    folder: string;
}

export interface MergeResult
{
    mod: { id: string; name: string; folder: string; };
    /** the custom list made with the merged mod */
    list: string;
    files: number;
    /** files left out: replaced by a later mod's (same path, or its replace_path) */
    replaced: number;
    replacePaths: string[];
}

export interface NewModRequest
{
    name: string;
    /** folder name under the user's mod folder */
    folder: string;
    version: string;
    supportedVersion: string;
    tags: string[];
}

/** How loaded mods touch an entry (list badges, filters, detail header). */
export interface ModTouch
{
    /** added: no definition from the game; overridden: a mod definition replaces the game's (same key, or the whole
     *  file); same: every mod definition says what the game's does (the same script, spacing and comments aside, or
     *  the same text), no change; removed: only definitions in files a mod hid (same path or replace_path), gone
     *  from the game; merged: game and mods all contribute (on_actions; flags and variables the game and mods use) */
    state: 'added' | 'overridden' | 'same' | 'removed' | 'merged';
    /** ModInfo ids of the mods involved, in load order (the winning one last) */
    mods: string[];
    /** flags and variables (no definitions): `mods` are the mods whose script uses it; sharing one is no conflict */
    uses?: true;
    /**
     * defined twice among the loaded files where the game keeps no single winner (events, history characters,
     * localization outside replace/): it reports an error and which definition it uses is not defined
     */
    duplicate?: true;
    /**
     * a loaded save carries this entry (docs/saves.md): its own entry for it; a historical character the save has
     * (`character_lookup`) is overridden by the save's character
     */
    save?: { type: string; name: string; };
}

export interface DefOrigin
{
    /** ModInfo.id; absent = the game */
    mod?: string;
    /** the mod's name, or 'Game' */
    name: string;
    /** the definition's file is hidden by a later mod: its file of the same path, or its replace_path */
    hiddenBy?: { mod: string; name: string; how: 'file' | 'replace_path'; };
}

// ---------------------------------------------------------------------------
// Editing the active mod (docs/mods.md, "Editing the active mod")
// ---------------------------------------------------------------------------

/**
 * copy: append the entry's winning definition to the active mod's overrides file of its folder (localization: the
 * mod's replace file); file: copy the whole file holding it to the same path in the mod.
 */
export interface OverrideRequest
{
    type: string;
    name: string;
    mode: 'copy' | 'file';
    /** file: replace a file the mod has already (asked first) */
    overwrite?: boolean;
}

/** One way to override an entry, as it would go. */
export interface OverrideOption
{
    /** the file it writes, game-relative (= its path in the mod) */
    target?: string;
    /** why it is not possible */
    disabled?: string;
    /** the mod has the definition (copy) / the file (file, when it is the mod's own) already: the option opens it */
    open?: { file: string; rel: string; line?: number; };
    /** file: the mod has a file of that path (replacing it asks first) */
    exists?: boolean;
    /** what goes along and what to know: namespace, constants, the holding definition, merging, load order */
    notes: string[];
}

/** What overriding an entry in the active mod would do (the menu shows it before anything is written). */
export interface OverridePlan
{
    /** the active mod; `loaded`: in the loaded mod list, so the explorer shows its changes after a re-index */
    mod?: { id: string; name: string; loaded: boolean; };
    /** nothing can be done (no active mod, not editable, index not ready) */
    problem?: string;
    /** on_actions: an appended copy merges with the loaded definitions instead of replacing them */
    merging: boolean;
    loc: boolean;
    /** events, history characters: a copy is a second definition of the id, which the game picks at random or reports:
     *  replacing the whole file (or a new id) is the reliable way; the menu offers that first */
    noWinner?: boolean;
    copy: OverrideOption;
    file: OverrideOption;
}

export interface OverrideResult
{
    /** copied / replaced: written; exists: the mod has that file (nothing written; ask, then `overwrite`);
     *  opened: the mod has the definition already (nothing written; open `file` at `line`) */
    action: 'copied' | 'replaced' | 'exists' | 'opened';
    mod: { id: string; name: string; };
    /** absolute path of the file written or found, and the definition's line in it */
    file: string;
    rel: string;
    line?: number;
    /** the active mod is loaded: the index takes the file in (an incremental update) so the change shows */
    reindex: boolean;
    notes: string[];
    /** the undo step of the change (mods/undo.ts) */
    step?: number;
}

/**
 * Files of loaded mods changed on disk in a way only a re-index takes in (the main process watches their folders;
 * docs/mods.md, "Watching the loaded mods").
 */
export interface ModChange
{
    /** ModInfo id and name (the first of `mods`) */
    mod: string;
    name: string;
    /** every mod with such changes; `active`: the active mod */
    mods: { id: string; name: string; active: boolean; }[];
    /** changed paths relative to the mod folder (a sample; with several mods "<mod name>: <path>") */
    files: string[];
    /** how many changed paths in all when more than `files` holds (the game's added: shared/gameChange.ts) */
    total?: number;
    /** time of the last change (ms) */
    at: number;
}

/** The open game save (docs/saves.md): what it is. */
export interface SaveSummary
{
    file: string;
    /** the game's date in the save (fixed: the save's world is at that date) */
    date: string;
    version?: string;
    player?: string;
    title?: string;
    /** the mods it was played with (registry ids, `mod/ugc_….mod`) */
    mods: string[];
    living: number;
    dead: number;
    /** the characters played (`currently_played_characters`: the player's first) */
    players: number[];
    /** the changes not written yet (labels, oldest first) */
    changes: string[];
    /** characters changed */
    changed: number;
}

/** A save file in the user's `save games` (or opened from elsewhere): what its header and metadata say. */
export interface SaveListItem
{
    file: string;
    name: string;
    size: number;
    /** last written (ms) */
    mtime: number;
    player?: string;
    title?: string;
    date?: string;
    version?: string;
    /** binary (autosave, ironman): can't be loaded */
    binary: boolean;
    ironman?: boolean;
    mods: string[];
    /** it can't be read (not a save, damaged) */
    problem?: string;
}

/** The save the index has loaded (docs/saves.md): none, loaded, or asked for but not loadable. */
export interface LoadedSave
{
    /** the setting's file (absent: none asked for) */
    file?: string;
    /** the save as the user chose it, when `file` is its text copy (a binary save converted with rakaly) */
    source?: string;
    /** the index has it */
    loaded: boolean;
    date?: string;
    problem?: string;
    /** something to tell about a loaded save that is read, but not fully (a layout of its faiths the editor does not know) */
    note?: string;
    /** the characters played (savegame/characters ids, the player's first) */
    players?: number[];
    /** changes made to it, not written yet (their labels, oldest first) */
    pending?: number;
    edits?: string[];
}

/** A character found by the save's search. */
export interface SaveHit
{
    id: number;
    name: string;
    /** the house's name (its key without the prefix) */
    house?: string;
    birth?: string;
    alive: boolean;
    changed: boolean;
    /** a played character */
    player?: boolean;
}

/** A character of the save as it is now (its changes included). */
export interface SaveCharacterView
{
    id: number;
    alive: boolean;
    firstName: string;
    nickname?: string;
    birth?: string;
    female: boolean;
    culture?: { id: number; key?: string; };
    /** `name`: a reformed faith's own name */
    faith?: { id: number; key?: string; name?: string; };
    /** a 1.20 save: the rite of the faith (`main`: the faith's main rite; else one of its other rites, with a name of its own) */
    rite?: { id: number; name?: string; main: boolean; };
    house?: { id: number; key?: string; label?: string; };
    ethnicity?: string;
    sexuality?: string;
    /** diplomacy, martial, stewardship, intrigue, learning, prowess */
    skills: number[];
    traits: { index: number; key?: string; }[];
    death?: { date?: string; reason?: string; };
    spouses: { id: number; name: string; }[];
    children: { id: number; name: string; }[];
    gold?: number;
    piety?: number;
    prestige?: number;
    health?: number;
    stress?: number;
    hasDna: boolean;
    changed: boolean;
    /** the save's date */
    date: string;
}

/** One change of a save's character. */
export interface SaveCharacterEdit
{
    id: number;
    /** culture / faith: `number` is the save's id (saveLookup) */
    field: 'firstName' | 'nickname' | 'skills' | 'traits' | 'gold' | 'piety' | 'prestige' | 'health' | 'stress' | 'culture' | 'faith' | 'female' | 'nicknameKey' | 'birth' | 'sexuality' | 'house' | 'dna';
    text?: string;
    number?: number;
    numbers?: number[];
    /** traits: the whole list (keys) */
    keys?: string[];
    label?: string;
}

export interface RendererApi
{
    getSettings(): Promise<Settings>;
    setSettings(s: Partial<Settings>): Promise<Settings>;
    /** starts the app again (a new app language applies at start) */
    restartApp(): Promise<void>;
    /** the in-app folder picker (main/folders.ts): a folder's subfolders and file count, names only */
    listDirs(path: string): Promise<FolderListing>;
    /** drives that answer within 1.5 s (`/` off Windows) */
    drives(): Promise<string[]>;
    /** the nearest existing folder going up from a path */
    nearestFolder(path: string): Promise<string | null>;
    makeFolder(parent: string, name: string): Promise<{ path?: string; error?: string; }>;
    /** folders the app uses and shortcuts (Documents, Downloads …) */
    folderPlaces(): Promise<{ used: string[]; shortcuts: { name: string; path: string; }[]; }>;
    /** the system's folder dialog (the picker's fallback) */
    nativeFolder(title: string, start?: string): Promise<string | null>;
    /** a folder picked for the game or user folder: the right one near it (main/findNear.ts), with the picked one when it differs */
    nearFolder(kind: 'game' | 'user', path: string): Promise<BrowsedFolder>;
    /** folder picker for the CK3 user folder (Documents/Paradox Interactive/Crusader Kings III) */
    /** the first-run wizard: CK3 installs and user folders found on this machine (main detect.ts), best first */
    detectFolders(): Promise<{ installs: string[]; userDirs: string[]; documents: string; }>;
    /** whether a folder is a CK3 install (holds game/) or a user folder (holds mod/, launcher-v2.sqlite or dlc_load.json) */
    checkDir(kind: 'game' | 'user', dir: string): Promise<boolean>;
    languages(): Promise<string[]>;
    /** logical CPU cores (the automatic image worker count) */
    cpuCount(): Promise<number>;
    /** what the index caches take on disk: bytes, and how many mod lists they hold */
    indexCacheDisk(): Promise<{ bytes: number; caches: number; }>;
    status(): Promise<IndexStatus>;
    /** `force` (default): parse even when the index cache is valid ("Re-index now"); false: use it when still valid */
    rebuild(force?: boolean): Promise<void>;
    // mods (main process, src/main/mods/)
    modsState(): Promise<ModsState>;
    /** loads a mod list into the index ('none' = the game only); re-indexes */
    selectModList(ref: string): Promise<ModsState>;
    /** creates (no ref) or updates a custom list */
    saveModList(list: { ref?: string; name: string; mods: ModListEntry[]; }): Promise<ModsState>;
    deleteModList(ref: string): Promise<ModsState>;
    /**
     * writes a list back: to its launcher playset (database backed up first; local mods the launcher has not seen are
     * registered: `registered`) or to dlc_load.json. `unchecked`: nothing written, whether the launcher runs could not
     * be told; `launcherClosed` (the user says it is closed) writes anyway.
     */
    writeModList(ref: string, target: 'launcher' | 'game', mods: ModListEntry[], opts?: { launcherClosed?: boolean; }): Promise<{ backup?: string; registered?: string[]; unchecked?: string; }>;
    setActiveMod(id: string | null): Promise<ModsState>;
    /** a new local mod (descriptor + folder in the user's mod folder); becomes the active mod */
    createMod(req: NewModRequest): Promise<ModsState>;
    /** zips an unpacked local mod next to its folder */
    /** `exists`: the zip is already there and `overwrite` was not set: nothing written */
    packMod(id: string, overwrite?: boolean): Promise<{ file: string; files: number; exists?: boolean; }>;
    /** unpacks a packed mod into a folder in the user's mod folder and points its descriptor there */
    unpackMod(id: string): Promise<{ dir: string; files: number; }>;
    /** redoes an undone step (`step`, else the active mod's last undone one); `refused`: a file changed since the undo */
    redoChange(step?: number): Promise<{ id: number; label: string; mod?: { id: string; name: string; }; rel?: string; file?: string; line?: number; refused?: string; left: number; } | null>;
    /** the active mod's kept changes (newest first, also from before a restart) and those that can be redone */
    listChanges(): Promise<{ steps: { id: number; label: string; kind: string; at: number; }[]; redos: { id: number; label: string; kind: string; at: number; }[]; }>;
    // game saves (docs/saves.md): one open at a time, changes written to a new file
    /** the saves of the user folder's `save games`, newest first */
    listSaves(): Promise<{ dir: string; saves: SaveListItem[]; }>;
    /** loads a save into the index as the top layer (null: unloads); re-indexes. No file and not null: asks (dialog) */
    loadSave(file?: string | null): Promise<LoadedSave | null>;
    /** the save the index has loaded */
    loadedSave(): Promise<LoadedSave>;
    /** rakaly (the converter of binary saves; docs/saves.md): installed? its version */
    rakaly(): Promise<{ installed: boolean; version?: string; }>;
    /** downloads rakaly's latest release for this system from GitHub (only asked for when a binary save is loaded) */
    installRakaly(): Promise<{ version: string; }>;
    /** rakaly's latest release on GitHub (the settings' update check) */
    rakalyLatest(): Promise<{ version: string; }>;
    /** what a mod needs to follow the game's version (docs/mods.md "Migrating a mod") */
    migrationPlan(modId: string): Promise<MigrationPlan>;
    /** the mod's fixes for the game's version, in a patch mod loaded after it */
    migrateMod(modId: string, options?: MigrationOptions): Promise<MigrationResult>;
    /** merging a mod list's enabled mods into one (docs/mods.md "Merging mods") */
    mergePlan(ref: string): Promise<MergePlan>;
    mergeMods(req: MergeRequest): Promise<MergeResult>;
    /** stops a running migration or merge (after the fix or file at hand) */
    cancelModsTask(): Promise<void>;
    /** how far a migration or merge is */
    onModsProgress(cb: (p: MigrationProgress) => void): () => void;
    /** undoes the loaded save's last change (made through the usual editors) */
    undoSaveEdit(): Promise<{ label: string; pending: number; left: number; } | null>;
    /** writes the loaded save with its changes to a new file (no file: asks, next to the original); null: cancelled */
    writeSaveAs(file?: string): Promise<{ file: string; bytes: number; } | null>;
    /** a stale descriptor (ModInfo.staleLocation) pointed to where the mod was found (a backup first) */
    fixModLocation(id: string): Promise<{ descriptor: string; location: string; backup: string; }>;
    /** deleting a mod of one's own (docs/mods.md "Deleting a mod"): what it takes, then doing it */
    deleteModPlan(id: string): Promise<DeleteModPlan>;
    deleteMod(id: string): Promise<{ state: ModsState; result: DeleteModResult; }>;
    openModFolder(id: string): Promise<void>;
    /** a discovered mod's preview image as a data URL (scaled down), null when it has none */
    modThumbnail(id: string): Promise<string | null>;
    /** what overriding an entry in the active mod would do (nothing written) */
    overridePlan(type: string, name: string): Promise<OverridePlan>;
    /** overrides an entry in the active mod (re-indexes when the mod is loaded) */
    overrideEntry(req: OverrideRequest): Promise<OverrideResult>;
    /** a change of the active mod's files not re-indexed yet (null: none) */
    modChange(): Promise<ModChange | null>;
    onModChange(cb: (c: ModChange | null) => void): () => void;
    /** a statement's script as written in the active mod (the in-place editor's text) */
    scriptText(at: LineSource): Promise<ScriptText>;
    /** edits the active mod's script at a line anchor (checked, written, undoable; the index takes the file in) */
    editScript(req: ScriptEditRequest): Promise<ScriptEditResult>;
    /**
     * undoes a change the app made to a mod (`step`, else the active mod's last one; kept across restarts,
     * docs/mods.md "Undo"); null: nothing to undo
     */
    undoChange(step?: number): Promise<UndoResult | null>;
    /** drops a change that can't be undone any more (UndoResult.refused) from the undo list */
    forgetChange(step: number): Promise<boolean>;
    onStatus(cb: (s: IndexStatus) => void): () => void;
    /** the script database's facts (docs/script-database.md; null: no database) */
    scriptDbFacts(): Promise<ScriptFacts | null>;
    /** a new script database was opened (another game version, an update): its facts */
    onScriptDbFacts(cb: (f: ScriptFacts) => void): () => void;
    /** one entry of the script database with its explanation (null: not in it) */
    scriptDbEntry(kind: DbKind, key: string, variant?: string): Promise<DbEntry | null>;
    /** a kind's explained entries: key → [label, summary] (menus) */
    scriptDbLabels(kind: DbKind): Promise<Record<string, [string, string]>>;
    /** entries matching a text (key, label, explanation), best first */
    scriptDbSearch(text: string, kinds?: DbKind[], limit?: number): Promise<DbEntry[]>;
    /** the script database in use (game version, build, bundled or downloaded) and this run's last update check */
    scriptDbStatus(): Promise<ScriptDbStatus>;
    /** looks for a newer script database now (Settings), downloads and opens it */
    scriptDbCheckUpdate(): Promise<ScriptDbUpdateResult>;
    /** the types; `counts: false` without what the loaded mods do to each (quick: GameIndex.types) */
    types(counts?: boolean): Promise<TypeSummary[]>;
    typeDoc(type: string): Promise<{ file: string; text: string; }[]>;
    list(type: string): Promise<EntityListItem[]>;
    /** which DLC (or mod) each entry of the type comes with; base game entries left out (the picker's grouping) */
    dlcGroups(type: string): Promise<Record<string, string>>;
    /** the entries of a type limited to a DLC by their own script: its flag (= feature) and name (GameIndex.dlcFlags) */
    dlcFlags(type: string): Promise<Record<string, { flag: string; dlc: string; }>>;
    /** `modOnly`: only entries the loaded mods add, change or remove */
    /** `modOnly`: only what the loaded mods touch; `noRemoved`: without entries a mod removed */
    search(q: string, opts?: { limit?: number; types?: string[]; text?: boolean; modOnly?: boolean; noRemoved?: boolean; state?: string; }): Promise<SearchResult[]>;
    detail(type: string, name: string): Promise<EntityDetail | null>;
    graph(type: string, name: string, opts: GraphOptions): Promise<GraphData>;
    card(type: string, name: string): Promise<EntityCard | null>;
    story(type: string, name: string): Promise<EventStory | OnActionStory | null>;
    tooltip(type: string, name: string): Promise<TooltipInfo | null>;
    /** every entry of `userType` using the entry (a card's "Used by" row in full), most references first */
    usageAll(type: string, name: string, userType: string): Promise<UsageSummary['examples']>;
    /**
     * a script snippet (effects or triggers) as readable lines, like the Story/Summary view shows them; `names`: entries
     * the snippet names that are not made yet (the picker's "＋ New …": key → the name given), read by that name
     */
    describeScript(text: string, kind: 'effect' | 'trigger' | 'modifier' | 'field', type?: string, names?: Record<string, string>): Promise<Line[]>;
    /** lines a card left out for its size (Line.more), cut again by the same budget; null when no longer kept */
    moreLines(id: number): Promise<Line[] | null>;
    /** every stat modifier the game defines (modifier_definition_formats), most used first (the picker's modifier menus) */
    modifierKeys(): Promise<ModifierKeyInfo[]>;
    /** values a text field of the picker offers (shared/fieldCatalog.ts `suggest`: 'doctrine_parameters') */
    fieldSuggestions(source: string): Promise<FieldSuggestion[]>;
    /** the codes the game's localization uses (the text editor's "Insert code…") */
    locCodes(): Promise<LocCodes>;
    /** the saved scopes an entry's script names (who its texts can speak of) */
    locScopes(type: string, name: string): Promise<string[]>;
    /** a localization key's text as written and where its line is */
    locEntry(key: string): Promise<{ key: string; text?: string; rel?: string; abs?: string; line?: number; mod?: string; } | null>;
    /** changes a localization text in the active mod (its own line, else an override in its replace folder) */
    editLoc(key: string, text: string): Promise<ScriptEditResult>;
    /** a property of a widget in a `.gui` file, written into the active mod (docs/gui-designer.md, stage 3) */
    editGui(req: GuiEditRequest): Promise<ScriptEditResult>;
    /** fires an event from an on_action in the active mod ("When it happens…") */
    fireEvent(req: FireRequest): Promise<ScriptEditResult>;
    /** takes the event out of the active mod's lists of that on_action */
    unfireEvent(event: string, onAction: string): Promise<ScriptEditResult>;
    /** every on_action with its documentation; `event`: marks those firing it already */
    onActions(event?: string): Promise<OnActionInfo[]>;
    /**
     * makes new entries in the active mod (a card's acts: a faith, a term …): the files written, one undo step, all or
     * nothing (a failed batch takes back what it wrote). A picked statement's entries go with it: ScriptEditRequest.creates
     */
    /** `keys`: the keys given to entries made without one (a new character's id) */
    createEntries(creates: EntryCreate[]): Promise<{ files: string[]; notes: string[]; step?: number; keys?: string[]; }>;
    /** where a new entry of a type would go (the explorer's "New <type>…") */
    newEntryPlan(type: string): Promise<NewEntryPlan>;
    /** writes a new entry of a type into the active mod (template definition + localization) */
    createEntry(req: NewEntryRequest): Promise<NewEntryResult>;
    /** copies an event under a new id into the active mod (its texts under the new id) */
    duplicateEvent(req: DuplicateRequest): Promise<NewEntryResult>;
    /** an entry of any type copied under a new key into the active mod (events: duplicateEvent) */
    duplicateEntry(req: DuplicateEntryRequest): Promise<NewEntryResult>;
    /**
     * every effect / trigger key the loaded script uses, most used first, with its typical values (the statement
     * picker's "Other…" list; collected on a thread of its own on first request, then cached)
     */
    scriptKeys(kind: 'effect' | 'trigger'): Promise<ScriptKeyInfo[]>;
    /** folders of a file-based type (images, models); `modCount`: files from the loaded mods; `removed`: pictures a mod's replace_path removed */
    fileFolders(type: string): Promise<GalleryFolder[]>;
    /** `mod`: ModInfo id of the mod providing the file (absent = the game); `removed`: the mod whose replace_path removed it (images) */
    filesIn(type: string, folder: string): Promise<GalleryFile[]>;
    modelFolder(folder: string): Promise<ModelFolderItem[]>;
    modelInfo(path: string): Promise<ModelInfo | null>;
    /** geometry of a .mesh (textures from the pdxmesh declaring it) or of one pdxmesh of an .asset */
    modelGeometry(path: string, pdxmesh?: string): Promise<ModelGeometry | null>;
    /** model files whose materials use this texture */
    textureUsers(path: string): Promise<{ asset: string; pdxmesh: string; role: string; }[]>;
    /** every window, root widget, type and template of the game's `.gui` files (with the loaded mods) */
    guiList(): Promise<GuiItem[]>;
    /** one name's definitions, what they use and who uses it; null: no such name */
    guiDetail(kind: GuiKind, name: string): Promise<GuiDetail | null>;
    /** a window, widget or type laid out as the game would (the preview); `hidden`: GuiToggle ids switched off */
    guiLayout(kind: GuiKind, name: string, hidden: number[], opts?: GuiLayoutOptions): Promise<GuiLayoutView | null>;
    /** "Export for Blender…": asks where (save dialog), writes glTF + bin + PNG textures + manifest; null = cancelled */
    exportModel(path: string, pdxmesh?: string): Promise<ModelExportResult | null>;
    /** whether "Import from Blender…" can write into the active mod, and what */
    importModelPlan(path: string, pdxmesh?: string): Promise<ModelImportPlan>;
    /** "Import from Blender…": asks for a .gltf/.glb, writes the mesh and changed textures into the active mod; null = cancelled */
    importModel(path: string, pdxmesh?: string): Promise<ModelImportResult | null>;
    /**
     * An asset's ⋯ menu: its file as it is, a texture as PNG, a mesh as glTF for Blender (save dialog; null: cancelled);
     * an .asset stands for its pdxmesh's .mesh
     */
    exportAsset(path: string, as: 'original' | 'png' | 'gltf', pdxmesh?: string): Promise<{ file: string; gltf?: ModelExportResult; } | null>;
    /** the names an event uses without saving them: what firing it should pass along (`scope:child`), and who they are */
    eventScopes(name: string): Promise<{ name: string; about?: string; }[]>;
    /** moods, cameras, outfits an event portrait can have ("Who's who" portrait settings) */
    portraitOptions(): Promise<PortraitOptions>;
    /** every event background with its picture (the event card's "Change scene…") */
    eventBackgrounds(): Promise<EventBackgroundInfo[]>;
    /** the entries of `type` written inside a holder (a law group's laws, a religion's faiths) */
    childrenOf(type: string, holderType: string, holder: string): Promise<string[]>;
    /** an event's scene from an image file (open dialog, or `source`): written into the active mod and registered as a background */
    importEventScene(type: string, name: string, source?: ImageSource): Promise<{ reference: string; files: string[]; notes: string[]; step?: number; } | null>;
    /**
     * a card picture from an image of the user's (PictureChooser "From an image file…"): encoded like the game's
     * illustrations (DDS BC1, no mips; a DDS as it is) into `<folder>/<mod>_<name>.dds` of the active mod; the caller
     * writes the path into the statement
     */
    importPicture(folder: string, name: string, source?: ImageSource): Promise<{ path: string; files: string[]; notes: string[]; step?: number; } | null>;
    /** an image of the user's for the crop & rotate dialog (open dialog; a DDS comes decoded to PNG) */
    pickImage(title?: string): Promise<PickedImage | null>;
    /** replaces the asset in the active mod with a file (open dialog), converted to its format, saved under its name */
    replaceAsset(path: string, pdxmesh?: string, source?: ImageSource): Promise<ModelImportResult | null>;
    /** the active mod's own file for the asset (null: no active mod) */
    assetOverride(path: string, pdxmesh?: string): Promise<AssetOverride | null>;
    /** removes the active mod's file for the asset (recycle bin) */
    removeAssetOverride(path: string, pdxmesh?: string): Promise<AssetOverride & { loaded: boolean; step?: number; }>;
    /** one of the game's Effects compiled to WebGL2 GLSL (cached per request) */
    shader(req: ShaderRequest): Promise<ShaderProgram>;
    /**
     * A texture's pixels as raw RGBA (no PNG round trip, no alpha weighting): the DDS's own mip level nearest above
     * `maxSize` (0 = full size). For data the browser would alter: masks with colour under zero alpha.
     */
    textureData(path: string, maxSize?: number): Promise<TextureData | null>;
    /** the map at a history date (default: the first bookmark's); builds the province raster on first use */
    mapInfo(date?: string): Promise<MapInfo | null>;
    /** the map's parts that are the same at every date (renderer mapLoad.ts composes MapInfo) */
    mapStatic(): Promise<MapStatic | null>;
    /** the map's parts at a history date (default: the first bookmark's) */
    mapDated(date?: string): Promise<MapDated | null>;
    /** the holdings at a date for the 3D map: per mesh (MapTerrainInfo.objects groups marked `dynamic`) its instances: x, y, z (from the bottom), yaw, scale */
    mapHoldings(date?: string): Promise<Record<string, number[]> | null>;
    /** the 3D map's terrain (heights, rivers …); builds its rasters on first use */
    mapTerrain(): Promise<MapTerrainInfo | null>;
    /** the map's overlays (rivers as lines, sea crossings …), built on first use */
    mapOverlays(): Promise<MapOverlaysInfo | null>;
    /** the fog of war's settings (NFogOfWar of the loaded mods) and the sea links between provinces */
    mapFog(): Promise<MapFogInfo | null>;
    /** a change from the map in the active mod (a province's culture, a title's holder …) */
    mapEdit(req: MapEditRequest): Promise<MapEditResult>;
    /** writes a barbershop DNA into the active mod: its entry overridden, or a new dna_data entry and the character's `dna` */
    saveDna(req: DnaSaveRequest): Promise<ScriptEditResult>;
    /** characters by name, id, house or dynasty for the map's holder chooser, those alive at the date first */
    mapCharacters(q: string, date: string): Promise<MapCharacter[]>;
    /** the holder menu's first list: `seeds` ([id, why]) and their close family, the alive at `date` first; `others`: then everyone else alive then (by name) */
    mapHolderSuggestions(seeds: [string, string][], date: string, others?: boolean): Promise<MapCharacter[]>;
    /** the coat of arms of a title, dynasty or house (`kind`), or a coat_of_arms entry by key; a title's at the history date (y.m.d; none: the first bookmark's) */
    coatOfArms(kind: CoaKind, key: string, date?: string): Promise<CoaInfo | null>;
    /** every program and compile failure in the shader store (for window.__shaderCheck) */
    shaderPrograms(): Promise<{ programs: ShaderProgram[]; failures: { key: string; error: string; }[]; }>;
    /** appends to logs/shaders.log */
    logShader(entry: ShaderLogEntry): Promise<void>;
    portrait(type: string, name: string, opts?: PortraitRequest): Promise<PortraitData | null>;
    portraitReport(type: string, name: string, opts?: PortraitRequest): Promise<PortraitReport | null>;
    /** the barbershop: the DNA of a character (dna_data entry, bookmark portrait) and the genes it can change */
    /** `date`: a historical character at the preview date (their age then) */
    dnaEditor(type: string, name: string, date?: string): Promise<DnaEditorData | null>;
    /** the barbershop's "From ethnicity…": genes rolled from an ethnicity (another `seed`, another roll) */
    ethnicityGenes(ethnicity: string, seed: string): Promise<DnaGene[]>;
    characterFilter(filter: CharacterFilter): Promise<string[]>;
    characterFacets(): Promise<CharacterFacets>;
    /** `type`: savegame/characters for a loaded save's character (its family in the save) */
    familyTree(id: string, type?: string): Promise<FamilyTree | null>;
    /** birth and death (y.m.d) of historical characters */
    characterLifespans(ids: string[]): Promise<{ id: string; birth?: string; death?: string; female?: boolean; }[]>;
    /** historical characters by name, house or id, with who they are (the statement picker) */
    searchCharacters(q: string, limit?: number): Promise<CharacterHit[]>;
    /** opens a file in VS Code (at a line); a file inside a zip (`archive.zip › entry`) as a read-only temp copy */
    openFile(absPath: string, line?: number): Promise<void>;
    /** shows a file in its folder; a file inside a zip: the zip */
    revealFile(absPath: string): Promise<void>;
    /** the test API's target to open at start (CRUSADERPOPE_START; src/renderer/src/testApi.ts), else null */
    startTarget(): Promise<string | null>;
    /** the running app's version and a newer release, if any (checked once per start; null when off or none) */
    updateInfo(): Promise<{ current: string; update: UpdateInfo | null; }>;
}
