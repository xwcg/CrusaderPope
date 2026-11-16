/**
 * Definition libraries a mod's older copy of a game file hides (docs/mods.md, "Migrating a mod to a newer game
 * version", the `libraries` rule). A mod that overrides a game file with its copy of the older version hides every
 * definition the newer game added to that file, while the game's other files, the mod's own and the patch mod's still
 * call them. The game logs the unknown scripted triggers, effects, script values … and those scripts misbehave.
 *
 * For each folder of definitions that are inert until something names them (migrations.ts `libraries`): an entry a
 * hidden game file defines that no loaded file of the folder defines, and that a loaded file names, is carried over
 * as the game wrote it; then the same for what the carried entries name (a closure across the folders) until nothing
 * new comes. Runs in the index worker (it reads the layering of the loaded files, `GameFiles`), the text comes back
 * to the main process, which writes it (migrate.ts).
 *
 * Also here: entries the mod defines in its copy of a game file, which the game's newer version of that file no longer
 * has; a new game file defines it and, loading after the mod's, wins now (`movedEntries`).
 */
import { tr } from '../../shared/i18n.ts';
import type { GameIndex } from '../indexer/gameIndex.ts';
import { carriedDefs, commentStart, eolOf, fileConstants, trailingEnd, type CarriedDef } from '../indexer/override.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { factScope, isTokenName, onGameDisk, scriptWords, topKeysOf, WordGate } from './gameFacts.ts';
import type { GameFile, GameFiles } from './gamefiles.ts';
import { portraitAnimationCheck, reindexCategories, type ReindexedCategory } from './libraryChecks.ts';
import { INERT_FILE, addKept, addNames, gameInertText, inertWork, mergeSummary, type InertOptions, type InertSummary, type InertWork } from './inertWork.ts';
import { inertWorld } from './inertWorld.ts';
import { eventProbe, lostToHiders, macroProbe, nameProbe, type ScriptProbe } from './scriptProbes.ts';
import { hasWord, isWordName, pastFastPath, wordSet } from './wordRuns.ts';

/** The folder of the on_actions: not a library of migrations.ts (nothing names the engine's), the rule adds it itself. */
export const ON_ACTION_FOLDER: LibraryFolder = { folder: 'common/on_action', label: tr('On actions'), fired: true };

/** The folder of the interaction categories (the libraries rule gives a mod's category with a taken index another one). */
export const CATEGORY_FOLDER = 'common/character_interaction_categories';

/** The folder of the portrait animations (an entry whose animation states, packs or modifiers the loaded world lacks is not carried). */
export const ANIMATION_FOLDER = 'gfx/portraits/portrait_animations';

/** A library folder (migrations.ts `libraries`): what names its entries. */
export interface LibraryFolder
{
    folder: string;
    label: string;
    /**
     * where a name counts as a reference: in script (`script`, the default: a key or a value of a statement), in the
     * brackets of localization and interface text (`loc`: `[GetScriptedGui('x')]`, `Custom('x')`), or both
     */
    use?: 'script' | 'loc' | 'both';
    /**
     * the name is a reference in script only as the value of one of these keys (or a word in a list under one): the
     * names are common words that other things use too (an event theme `christian`, a decision group `religious`);
     * `*_x`: any key ending so
     */
    keys?: string[];
    /**
     * the name is also a reference as the value of `flag` inside a block under one of these keys
     * (`has_building_with_flag = { flag = x count = 1 }`)
     */
    flagIn?: string[];
    /**
     * the engine asks for the entries by itself (no script names them): every entry of a hidden game file that no loaded
     * file defines is carried, except the ones about content the loaded files lack, those whose key starts with the key of a
     * definition in one of `content` (folders), which a mod hides and no loaded file defines (the game's
     * `modifier_definition_formats`: `kru_opinion` for the culture `kru`)
     */
    engine?: { content: string[]; };
    /**
     * the engine fires the entries by itself (`common/on_action`: `on_rite_created`) or loaded files name them in lists: an
     * entry of a hidden game file that no loaded file defines is carried when a loaded file names it, or when nothing names
     * it at all (the engine fires it); not when only hidden game files name it (nothing fires it any more)
     */
    fired?: boolean;
}

/**
 * A folder whose entries carry flag words (a government's `flags = { … }`, a law's or trait's `flag = …` statements,
 * a doctrine's `parameters = { … }`) that scripts test (`government_has_flag = x`): a mod's older entry lacks the words
 * 1.20 gave the game's entry of that name.
 */
export interface FlagKind
{
    folder: string;
    label: string;
    /** the keys scripts test the words with */
    queries: string[];
    /** of those, the ones that also take a block with the word as its `flag` (`has_building_with_flag = { flag = x }`) */
    blocks?: string[];
    /** the list the words stand in (default `flags`; a doctrine's `parameters`: bare words, no `flag = x` statements, top level only) */
    list?: string;
}

/** What the query is given: the library folders and the flag kinds (migrations.ts `libraries`). */
export interface LibraryConfig
{
    folders: LibraryFolder[];
    flags: FlagKind[];
}

/** A carried entry. */
export interface LibraryEntry
{
    name: string;
    /** the game file it is defined in */
    rel: string;
    /** where it stands in that file (the entries go in the game's order) */
    pos: number;
    /** exactly as written: the comment block above it and a comment after it included */
    text: string;
    /** the file's `@constants` its text uses, transitively, in file order */
    constants: CarriedDef[];
    /** `referenced`: a loaded file names it; `needed`: an entry carried over names it; `engine`: the engine asks for it */
    why: 'referenced' | 'needed' | 'engine';
    /** the first loaded file naming it, or the entry that needs it */
    by: string;
    /** a flag entry: the words added to the mod's entry (its text is the mod's, written again with them) */
    words?: string[];
}

export interface LibraryFolderWork
{
    folder: string;
    label: string;
    entries: LibraryEntry[];
    /** the folder's game files are hidden by a `replace_path` (not only by a file of the same path) */
    replacePath: boolean;
    /** a flag kind: the entries are the mod's own, with words added */
    flags?: boolean;
    /** flag kinds: the words loaded files test that only an entry the mod does not have carries (`word (entry)`) */
    gone?: string[];
    /** flag kinds: the words the mod's entry has commented out (`#flag = x`): its author took them out (`word (entry)`) */
    declined?: string[];
    /** flag kinds: entries another loaded file defines last (`entry (file)`): that definition wins, a copy would win over it */
    redefined?: string[];
    /**
     * the game's entries a file of the mod or the patch mod has commented out (`# name = {`): the author took them out, so a
     * file naming them does not bring them back unless a script file of the mod itself does (`by`: what names it)
     */
    disabled?: { name: string; by: string; }[];
    /**
     * flag kinds: the last (lower case) file name of the folder among the files of the mod and its patch mod: the file
     * written must load after it, or the mod's own entry in that file wins over the copy with the words
     */
    after?: string;
    /** the entries are on_actions the engine fires (`LibraryFolder.fired`) */
    fired?: boolean;
    /** the game's entries the loaded world cannot use and the rule leaves out: what each names that no loaded file has (`name`, `what`) */
    lacking?: { name: string; what: string[]; }[];
    /** interaction categories of the mod that got another index, because the game's category has theirs (`reindexCategories`) */
    reindexed?: ReindexedCategory[];
    /** the files of the mod written again with the new indexes: the path, the whole text */
    copies?: { rel: string; text: string; }[];
}

/** An entry the mod's copy of a game file has, that the game's newer version of the file moved to another file. */
export interface MovedEntry
{
    type: string;
    name: string;
    /** the mod's file defining it (its copy of the game file the entry left) */
    modFile: string;
    /** the game's file defining it now (`game`: loading after the mod's, it wins; `mod`: loading before it, the mod's copy wins) */
    gameFile: string;
    wins?: 'game' | 'mod';
    /** keys only the mod's definition has / only the game's has (the top level of the definitions) */
    modOnly: string[];
    gameOnly: string[];
}

/** on_actions the game defines in a file the mod hid, that no loaded file defines, and only game files that are hidden name (not carried: nothing fires them now). */
export interface MissingOnActions
{
    /** the game's file */
    rel: string;
    names: string[];
}

/** Events a game file the mod's copy replaces defines, that no loaded file defines and other loaded files name. */
export interface MissingEvents
{
    /** the game's file */
    rel: string;
    /** events the game's file defines */
    total: number;
    /** the ones the copy lacks that loaded files name */
    ids: string[];
}

/** Arguments of a macro call (a scripted effect, trigger or modifier) that the winning definition does not take, or lacks. */
export interface MacroDrift
{
    type: string;
    name: string;
    /** the winning definition's file and whose it is (`game`: the game's own, `mod`: the mod's or its patch mod's, `other`) */
    rel: string;
    owner: 'game' | 'mod' | 'other';
    /** the arguments (`$X$`) it takes (required ones first) */
    takes: string[];
    /** callers' arguments it does not take: name, how many callers pass it, the first caller's file */
    unknown: { arg: string; n: number; rel: string; }[];
    /** required arguments callers leave out */
    missing: { arg: string; n: number; rel: string; }[];
    /** the game's own definition takes these (when the winner is not the game's and differs) */
    gameTakes?: string[];
}

/** What the inert references step asks of the libraries rule: the entries it carries are rewritten where they are chosen. */
export interface LibraryInert
{
    /** the text of a definition of the folder, with its statements that name missing entries made harmless */
    text(folder: string, text: string): string;
    /** the libraries rule tells which doctrine parameters it is about to give the mod's doctrines (they exist then) */
    gainable(fn: (word: string) => boolean): void;
    /**
     * The libraries rule tells which entries of a folder it declined to carry back (the mod's files have them commented out, and no script
     * file of the mod itself names them): the author took them out, so the calls of them in the game's files are made harmless.
     */
    declined(fn: (folder: string, name: string) => boolean): void;
    /**
     * The libraries rule tells which flag words of a flag folder (`common/laws`) no loaded entry defines and none will (its notes' "no loaded
     * entry defines" words it cannot give to an entry of the mod): a test of one never holds in the loaded world, so it is made false.
     */
    flags?(fn: (folder: string, word: string) => boolean): void;
    /** a file of the patch mod that is a copy of a game file (the step writes them): the game's script, not the mod's; it does not bring back what the mod commented out */
    gameCopy?(rel: string): boolean;
    /**
     * The text a loaded script file will have once the inert step has written its copy (a whole-file copy of an event or on_action
     * file, a file of the patch mod rewritten in place): undefined when the step leaves the file as it is. The scan for the references
     * reads this text, so that the first run sees what the second sees: an entry only a statement the step makes false names is not carried.
     */
    rewritten?(f: { rel: string; source: number; }): string | undefined;
}

export interface LibraryWork
{
    folders: LibraryFolderWork[];
    moved: MovedEntry[];
    onActions: MissingOnActions[];
    events: MissingEvents[];
    macros: MacroDrift[];
    /** the inert references step (when asked for) */
    inert?: InertWork;
}

/**
 * The file name of what the rule writes into a folder (the scan leaves these out: they are its own output). The `z`s
 * grow when a file of the mod sorts after the name (a flag file must load after the entry it copies). Only the patch mod's
 * own files of that name are left out (`ownLibrary`): another mod's are loaded files like any.
 */
export const LIBRARY_FILE = /(?:^|\/)zz+_[^/]*_library(?:_\d+)?\.txt$/i;

/** Whether a loaded file is a library file of the patch mod (`patchSource`, -1: none): what a second run leaves out. */
const ownLibrary = (f: { rel: string; source: number; }, patchSource: number): boolean => patchSource > 0 && f.source === patchSource && (LIBRARY_FILE.test(f.rel) || INERT_FILE.test(f.rel));

const lc = (s: string): string => s.toLowerCase();
const stripBom = (s: string): string => s.replace(/^﻿/, '');
const TOKEN = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Whether a key matches one of a folder's `keys` (`*_modifier`: any key ending in `_modifier`). */
function keyMatches(keys: string[], key: string): boolean
{
    return keys.some((k) => (k.startsWith('*') ? key.endsWith(k.slice(1)) : key === k));
}

/**
 * The key a word at `p` stands under: `key = word`, or `key = { a b word }` when the list so far holds words only (a
 * statement inside the block makes it the block's content, not a list of values).
 */
function keyOf(text: string, p: number): string | undefined
{
    const before = text.slice(Math.max(0, p - 400), p);
    const direct = /([A-Za-z0-9_:.]+)\s*(?:=|\?=)\s*["']?$/.exec(before);

    if (direct)
        return direct[1];

    const open = before.lastIndexOf('{');

    if (open < 0 || open < before.lastIndexOf('}') || /[={]/.test(before.slice(open + 1).replace(/#[^\n]*/g, '')))
        return undefined;

    return /([A-Za-z0-9_:.]+)\s*(?:=|\?=)\s*$/.exec(before.slice(0, open))?.[1];
}

/** The key of the block a word at `p` is inside (`has_building_with_flag = { flag = x count = 1 }`: the word's block). */
function blockKeyOf(text: string, p: number): string | undefined
{
    for (let i = p - 1, depth = 0; i >= Math.max(0, p - 400); i--)
    {
        if (text[i] === '}')
            depth++;
        else if (text[i] === '{' && !depth--)
            return /([A-Za-z0-9_:.]+)\s*(?:=|\?=)\s*$/.exec(text.slice(Math.max(0, i - 200), i))?.[1];
    }

    return undefined;
}

/** A reference found: the folder it is for, the name. */
export type Hit = { folder: LibraryFolder; name: string; };

/**
 * The names of `byName` a text uses. `mode`: script (a statement's key or value, comments and the top-level
 * definition's own key left out), localization (a word inside `[ ]`) or macro (a quoted word). Calls `hit` for each,
 * once per occurrence.
 */
export function scan(text: string, mode: 'script' | 'loc' | 'macro', byName: Map<string, LibraryFolder[]>, hit: (h: Hit, at: number) => void): void
{
    TOKEN.lastIndex = 0;

    for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text))
    {
        const folders = byName.get(m[0]);

        if (!folders)
            continue;

        const p = m.index;
        const ls = text.lastIndexOf('\n', p - 1) + 1;
        const seg = text.slice(ls, p);
        const pc = p > 0 ? text[p - 1] : '';
        const nc = text[p + m[0].length] ?? '';

        if (mode !== 'script')
        {
            // (a text of the file, not a comment line; the word inside brackets, not a function of a chain;
            // a data binding macro: a quoted name, `Custom('x')` inside the replacement text)
            if (seg.trimStart().startsWith('#') || pc === '.' || pc === ':' || (mode === 'loc' ? seg.lastIndexOf('[') <= seg.lastIndexOf(']') : pc !== '\'' && pc !== '"'))
                continue;

            for (const f of folders)
                if (f.use === 'loc' || f.use === 'both')
                    hit({ folder: f, name: m[0] }, p);

            continue;
        }

        // (a comment; a macro parameter or a constant; the top-level definition's own key)
        if (seg.includes('#') || pc === '@' || pc === '$' || nc === '$' || ls === p)
            continue;

        for (const f of folders)
        {
            if (f.use === 'loc')
                continue;

            if (pc === '.' || pc === ':')
            {
                // (a script value after a scope chain, or after `value:`)
                const prefix = pc === ':' ? /([A-Za-z0-9_]+)$/.exec(seg.slice(0, -1))?.[1] : undefined;

                if (!f.folder.endsWith('/script_values') || (pc === ':' && prefix !== 'value'))
                    continue;
            }

            if (f.keys)
            {
                // (the value of a listed key, or a word in the list it opens)
                const key = keyOf(text, p);

                if (!key || !(keyMatches(f.keys, key) || (key === 'flag' && !!f.flagIn && f.flagIn.includes(blockKeyOf(text, p) ?? ''))))
                    continue;
            }

            hit({ folder: f, name: m[0] }, p);
        }
    }
}

/**
 * The headers a file has commented out at the start of a line (`# name = {`, `##name = {`, `#name = 5`): the entries its
 * author took out. Header-shaped only: the `#` in the first column, at most one space before the name (a commented
 * statement inside an entry keeps its indentation: `# \t\t\tsome_trigger = yes`), and a block or a number behind the `=`
 * (a `= yes` statement is no entry). A commented statement inside an entry is no commented entry.
 */
const COMMENTED_HEADER = /^#+ ?([A-Za-z_][A-Za-z0-9_.:]*)[ \t]*=[ \t]*(?:\{|[-+]?\d|\r?$)/gm;

/** A game file a mod hid: its path, how it was hidden, the file, its text when asked. */
interface HiddenFile
{
    rel: string;
    how: 'file' | 'replace_path';
    file: GameFile;
    text(): string;
}

/** The keys of a hidden file's top-level statements, in order (a game file's kept for the session, gameFacts.ts). */
const hiddenKeys = (h: HiddenFile): (string | null)[] => (onGameDisk(h.file) ? topKeysOf(h.file.abs!) : undefined) ?? parse(h.text()).map((n) => n.k);

/**
 * A library folder's game files that a mod hid, with who hid them and how; the names the folder's loaded files define;
 * and the names a file of the mod or the patch mod has commented out (`commented`: name → that file).
 */
function folderState(vfs: GameFiles, f: LibraryFolder, hiders: Set<number>, patchSource: number, asGame?: (rel: string) => boolean): { hidden: HiddenFile[]; live: Set<string>; commented: Map<string, string>; }
{
    const exts = /\.(txt|gfx)$/i;
    const hidden = vfs.hidden(f.folder, { ext: exts })
        .filter((h) => lostToHiders(vfs, h, hiders))
        .map((h) => ({ rel: h.file.rel, how: h.how, file: h.file, text: (): string => stripBom(vfs.readText(h.file) ?? '') }));
    const live = new Set<string>();
    const commented = new Map<string, string>();

    for (const lf of vfs.list(f.folder, { ext: exts }))
    {
        if (ownLibrary(lf, patchSource))
            continue;

        // (a game file is no hider: only its keys count, kept for the session (gameFacts.ts))
        const keys = onGameDisk(lf) ? topKeysOf(lf.abs!) : undefined;

        if (keys)
        {
            for (const k of keys)
                if (!k.startsWith('@'))
                    live.add(k);

            continue;
        }

        const text = stripBom(vfs.readText(lf) ?? '');

        for (const n of parse(text))
            if (n.k && !n.k.startsWith('@'))
                live.add(n.k);

        if (hiders.has(lf.source) && !asGame?.(lf.rel))
            for (const m of text.matchAll(COMMENTED_HEADER))
                if (!commented.has(m[1]))
                    commented.set(m[1], lf.rel);
    }

    return { hidden, live, commented };
}

/**
 * The names of the definitions in `folders` that a mod hides and no loaded file defines: the content the loaded files
 * lack. An engine registry's entry about one of them (`kru_opinion`) has nothing to format.
 */
export function goneContent(vfs: GameFiles, folders: string[], hiders: Set<number>, patchSource: number): string[]
{
    const names = new Set<string>();

    for (const folder of folders)
    {
        const st = folderState(vfs, { folder, label: folder }, hiders, patchSource);

        for (const h of st.hidden)
            for (const k of hiddenKeys(h))
                if (k && !k.startsWith('@') && k.length >= 3 && !st.live.has(k))
                    names.add(k);
    }

    return [...names];
}

/** A block of an entry that carries flag words, by the keys down to it: `flag = a` statements or a `flags = { a b }` list. */
interface FlagSite
{
    path: string[];
    list: boolean;
    words: string[];
}

/**
 * The blocks of a definition with flag words: its own, and those of the blocks inside (a law group's laws). `listKey`:
 * the list the words stand in (`flags`; a doctrine's `parameters` also holds `x = yes` entries, which are words too, and
 * has no `flag = x` statements and no blocks to look into).
 */
function flagSites(n: PNode, listKey = 'flags', path: string[] = []): FlagSite[]
{
    const out: FlagSite[] = [];
    const statements: string[] = [];
    const list: string[] = [];
    const parameters = listKey === 'parameters';

    for (const c of Array.isArray(n.v) ? n.v : [])
    {
        if (c.k === 'flag' && typeof c.v === 'string' && !parameters)
            statements.push(c.v);
        else if (c.k === listKey && Array.isArray(c.v))
            list.push(...c.v.filter((w) => (w.k === null || parameters) && typeof w.v === 'string').map((w) => (w.k === null ? w.v : w.k) as string));
        else if (c.k && Array.isArray(c.v) && !parameters)
            out.push(...flagSites(c, listKey, [...path, c.k]));
    }

    return [...(statements.length ? [{ path, list: false, words: statements }] : []), ...(list.length ? [{ path, list: true, words: list }] : []), ...out];
}

/**
 * Whether a comment in an entry's text names a flag word as a flag the author took out: `#flag = word`, or the word
 * alone behind the `#` (a commented line of a `flags = { }` list, or `x = yes` of a `parameters` list). The word ends
 * the comment (a trailing comment may follow): prose that begins with the word does not count. The text is the entry
 * itself, not the comment lines above it (a commented-out entry glued to it is no removal of this one's words).
 */
function commentsWord(text: string, word: string): boolean
{
    return new RegExp('#[ \\t]*(?:flag[ \\t]*=[ \\t]*)?' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[ \\t]*=[ \\t]*yes)?[ \\t]*(?:#.*)?\\r?$', 'm').test(text);
}

/** What a flag kind needs: the words the game's entries have that no loaded entry defines, and the mod's own entries. */
interface FlagState
{
    kind: FlagKind;
    want: Map<string, { entry: string; site: FlagSite; }[]>;
    defs: Map<string, { rel: string; text: string; node: PNode; from: number; to: number; consts: ReturnType<typeof fileConstants>; }>;
    /** the last file name (lower case) among the files of the mod and its patch mod in the folder */
    after: string;
    /** the last loaded definition of each entry, whoever's it is (files load in path order): its file, and whether the mod's or its patch mod's */
    last: Map<string, { rel: string; hider: boolean; }>;
}

/**
 * @param asGame a file of the patch mod that is a whole-file copy of a game file (the inert step's, or a copy of a game database file an
 *   older run made, which the run deletes before this step): the game's entries, not the mod's
 * @param alias the name the mod keeps a game entry under (the renamed rule's alias: the game's `erudite` is the mod's `scholar`): the
 *   words of the game's entry are the mod's entry's to carry, when the mod has no entry of the game's name
 */
function flagState(vfs: GameFiles, kind: FlagKind, hiders: Set<number>, patchSource: number, asGame?: (rel: string) => boolean, alias?: (name: string) => string | undefined): FlagState
{
    const exts = /\.txt$/i;
    const live = new Set<string>();
    const defs: FlagState['defs'] = new Map();
    const last: FlagState['last'] = new Map();
    let after = '';

    for (const lf of vfs.list(kind.folder, { ext: exts }))
    {
        if (ownLibrary(lf, patchSource))
            continue;

        const hider = hiders.has(lf.source) && !asGame?.(lf.rel);

        if (hider && lc(lf.rel.slice(lf.rel.lastIndexOf('/') + 1)) > after)
            after = lc(lf.rel.slice(lf.rel.lastIndexOf('/') + 1));

        const text = stripBom(vfs.readText(lf) ?? '');
        const ast = parse(text);
        const consts = fileConstants(ast, text);

        for (const n of ast)
        {
            if (!n.k || n.k.startsWith('@'))
                continue;

            flagSites(n, kind.list).forEach((s) => s.words.forEach((w) => live.add(w)));
            last.set(n.k, { rel: lf.rel, hider });

            // (the last loaded definition of the mod or its patch mod: what the file written for it replaces)
            if (hider)
                defs.set(n.k, { rel: lf.rel, text, node: n, from: commentStart(text, n.s), to: trailingEnd(text, n.e), consts });
        }
    }

    const want: FlagState['want'] = new Map();

    // (the entry of the mod that carries a game entry's words: the one of its name, else the one the mod keeps it under)
    const carrier = (name: string): string =>
    {
        const kept = defs.has(name) ? undefined : alias?.(name);
        return kept && defs.has(kept) ? kept : name;
    };

    for (const h of vfs.hidden(kind.folder, { ext: exts }).filter((x) => lostToHiders(vfs, x, hiders)))
    {
        for (const n of parse(stripBom(vfs.readText(h.file) ?? '')))
            if (n.k && !n.k.startsWith('@'))
                for (const site of flagSites(n, kind.list))
                    for (const w of site.words.filter((x) => !live.has(x)))
                        want.set(w, [...(want.get(w) ?? []), { entry: carrier(n.k), site }]);
    }

    return { kind, want, defs, after, last };
}

/**
 * What the rule can do with a flag word of one of the game's entries that carry it (`FlagState.want`): `add` it to the mod's entry of that
 * name; not when the mod has no such entry or block (`gone`), when another loaded file defines the entry last (`redefined`: that definition
 * wins, a copy of the mod's would win over it), or when a comment of the mod's entry has the word (`declined`: the author took it out).
 */
function carrierFate(s: FlagState, c: { entry: string; site: FlagSite; }, word: string): 'add' | 'gone' | 'redefined' | 'declined'
{
    const def = s.defs.get(c.entry);

    if (!def || !addFlagWords(def.text, def.node, c.site.path, c.site.list, [word], s.kind.list))
        return 'gone';

    const winner = s.last.get(c.entry);

    if (winner && !winner.hider)
        return 'redefined';

    return commentsWord(def.text.slice(def.node.s, def.to), word) ? 'declined' : 'add';
}

/** The end of the line an offset is on (before its line break). */
function lineEnd(text: string, p: number): number
{
    const i = text.indexOf('\n', p);
    return i < 0 ? text.length : i > 0 && text[i - 1] === '\r' ? i - 1 : i;
}

/**
 * The text that adds flag words to the block at `path` inside a definition: into its `flags` list (`listKey`; made when it has
 * none) or as `flag = word` statements after its last. On a line of their own after the last one or, when the block
 * closes on that line, behind it. Undefined: the block is not there.
 */
function addFlagWords(text: string, entry: PNode, path: string[], list: boolean, words: string[], listKey = 'flags'): { at: number; text: string; } | undefined
{
    let block: PNode | undefined = entry;

    for (const k of path)
        block = Array.isArray(block?.v) ? block!.v.find((c) => c.k === k && Array.isArray(c.v)) : undefined;

    if (!block || !Array.isArray(block.v))
        return undefined;

    const eol = eolOf(text);
    const after = (last: PNode, container: PNode, lines: string[], inline: string): { at: number; text: string; } =>
    {
        const le = lineEnd(text, last.e);
        const ls = text.lastIndexOf('\n', last.s - 1) + 1;
        const indent = /^[ \t]*/.exec(text.slice(ls))![0];
        return container.e - 1 < le ? { at: last.e, text: ' ' + inline } : { at: le, text: lines.map((l) => eol + indent + l).join('') };
    };
    const kids = block.v;

    if (list)
    {
        const flags = kids.find((c) => c.k === listKey && Array.isArray(c.v));
        const items = flags && Array.isArray(flags.v) ? flags.v : [];

        if (flags && !items.length)
            return { at: flags.vs + 1, text: ` ${words.join(' ')} ` };

        if (flags)
            return after(items[items.length - 1], flags, words, words.join(' '));

        const line = `${listKey} = { ${words.join(' ')} }`;
        return kids.length ? after(kids[kids.length - 1], block, [line], line) : undefined;
    }

    const lines = words.map((w) => `flag = ${w}`);
    const same = kids.filter((c) => c.k === 'flag');
    const last = same[same.length - 1] ?? kids[kids.length - 1];
    return last ? after(last, block, lines, lines.join(' ')) : undefined;
}

/**
 * The localization lines the game shows for the index language, that have a bracket (`[ROOT.Char.Custom2('x')]`): per
 * key the winning definition; a file in `localization/replace/<language>` beats `localization/<language>/replace`, which
 * beats the rest; among equals the later source (a mod's text beats the game's), then the later path. A string a mod
 * replaces names nothing any more, so the function it calls is not referenced. By file, for the notes' sake.
 */
function winningLocalization(vfs: GameFiles, language: string): Map<string, string[]>
{
    const files = [`localization/${language}`, `localization/replace/${language}`].flatMap((d) => vfs.list(d, { ext: /\.yml$/i }));
    const best = new Map<string, { rank: number; source: number; at: number; rel: string; line: string; }>();
    const KEY = /^[ \t]*([A-Za-z0-9_.\-']+):\d*[ \t]*"/;

    files.forEach((f, at) =>
    {
        const text = vfs.readText(f);
        const rank = f.rel.toLowerCase().startsWith(`localization/replace/${language}/`) ? 2 : /\/replace\//i.test(f.rel) ? 1 : 0;

        if (!text)
            return;

        for (const line of text.split('\n'))
        {
            const m = KEY.exec(line);

            if (!m)
                continue;

            const prev = best.get(m[1]);

            if (!prev || rank > prev.rank || (rank === prev.rank && (f.source > prev.source || (f.source === prev.source && at >= prev.at))))
                best.set(m[1], { rank, source: f.source, at, rel: f.rel, line: line.includes('[') ? line : '' });
        }
    });

    const out = new Map<string, string[]>();

    for (const b of best.values())
        if (b.line)
            out.set(b.rel, [...(out.get(b.rel) ?? []), b.line]);

    return out;
}

/**
 * What the loaded files of a mod stack still call that the mod's older copies of game files hide.
 * @param vfs the layering of the loaded sources
 * @param config the library folders and flag kinds (migrations.ts)
 * @param modSource the migrated mod's source index (a game file it hid counts), `patchSource` its patch mod (-1: none)
 * @param language the index language (only its localization is read by the game)
 * @param extra texts the run is about to write into the patch mod: names in them count like names in loaded files
 * @param probes more questions to ask of the same pass over the loaded script files (events, macro arguments)
 * @param inert makes the statements of the entries chosen harmless that name entries the loaded world lacks (inert.ts)
 * @param renamed the entries the mod keeps under their old keys (renameRule.ts aliases: `from`, the game's new key in the folder
 *   `common/<type>`, is the mod's `to`): a flag kind gives the words of the game's entry to the mod's entry of the old key
 */
export function libraryWork(vfs: GameFiles, config: LibraryConfig, modSource: number, patchSource: number, language: string, extra: string[] = [], probes: ScriptProbe[] = [], inert?: LibraryInert, renamed: { type: string; from: string; to: string; }[] = []): LibraryWork['folders']
{
    const folders = config.folders;
    const hiders = new Set([modSource, patchSource].filter((s) => s > 0));
    // 1. the candidates: defined in a game file the mod hid, nowhere in the folder's loaded files
    const cands = new Map<string, { folder: LibraryFolder; entry: Omit<LibraryEntry, 'why' | 'by'>; consts: ReturnType<typeof fileConstants>; disabled?: string; lacks?: string[]; }>();
    const replaced = new Set<string>();
    const byName = new Map<string, LibraryFolder[]>();
    // (the entries of an engine registry: carried whole, nothing names them)
    const engine = new Set<string>();
    // (the on_actions: the engine fires them, or lists name them)
    const fired = new Set<string>();
    // (the folders the rule looks at itself: the on_actions of the engine, which no migration lists)
    const all = [...folders, ...(folders.length ? [ON_ACTION_FOLDER] : [])];
    let animation: ReturnType<typeof portraitAnimationCheck> | undefined;

    for (const f of all)
    {
        const st = folderState(vfs, f, hiders, patchSource, inert?.gameCopy);
        const gone = f.engine ? goneContent(vfs, f.engine.content, hiders, patchSource) : [];

        for (const h of st.hidden)
        {
            const text = h.text();
            const ast = parse(text);
            const consts = fileConstants(ast, text);

            for (const n of ast)
            {
                if (!n.k || n.k.startsWith('@') || st.live.has(n.k) || !(Array.isArray(n.v) || typeof n.v === 'string'))
                    continue;

                // (about content the loaded files lack: nothing to format)
                if (f.engine && gone.some((g) => n.k!.startsWith(g + '_')))
                    continue;

                const from = commentStart(text, n.s);
                const entryText = text.slice(from, trailingEnd(text, n.e));
                // (a portrait animation of states, packs or modifiers the loaded world lacks: the engine logs it for every type of portrait)
                const lacks = f.folder === ANIMATION_FOLDER && Array.isArray(n.v) ? (animation ??= portraitAnimationCheck(vfs))(n) : [];
                // (a name two hidden files define: the later file's is the game's)
                cands.set(`${f.folder}|${n.k}`, {
                    folder: f, entry: { name: n.k, rel: h.rel, pos: n.s, text: entryText, constants: carriedDefs(entryText, consts, new Map()).constants }, consts,
                    ...(st.commented.has(n.k) ? { disabled: st.commented.get(n.k) } : {}), ...(lacks.length ? { lacks } : {})
                });

                if (f.engine)
                    engine.add(`${f.folder}|${n.k}`);
                else if (f.fired)
                    fired.add(`${f.folder}|${n.k}`);
                else
                    byName.set(n.k, [...(byName.get(n.k) ?? []).filter((x) => x !== f), f]);

                if (h.how === 'replace_path')
                    replaced.add(f.folder);
            }
        }
    }

    // the flag words: the game's entries carry some no loaded entry defines (the keys scripts test them with are the references)
    // (an alias of the folder's entries: its type is the folder below `common/`, or a subfolder of it)
    const aliasIn = (folder: string) => (name: string): string | undefined =>
        renamed.find((r) => r.from === name && (lc(`common/${r.type}`) === lc(folder) || lc(`common/${r.type}`).startsWith(lc(folder) + '/')))?.to;
    const flagStates = config.flags.map((k) => flagState(vfs, k, hiders, patchSource, inert?.gameCopy, aliasIn(k.folder))).filter((s) => s.want.size);

    // (a doctrine parameter the game's doctrine has and the mod's lacks is given to the mod's doctrine below: it exists, for what follows)
    inert?.gainable((word) => flagStates.some((s) => s.kind.list === 'parameters' && !!s.want.get(word)?.some((c) => s.defs.has(c.entry))));

    // (a flag word that no loaded entry defines and that step 5 cannot give to an entry of the mod, wherever a file tests it: nothing in the
    // loaded world has it, so a test of it never holds ("Unknown law flag"), and the inert step makes it false in the files it writes. The
    // doctrine parameters are a kind of their own, given above)
    inert?.flags?.((folder, word) =>
    {
        const s = flagStates.find((x) => x.kind.folder === folder && x.kind.list !== 'parameters');
        return !!s?.want.get(word)?.every((c) => carrierFate(s, c, word) !== 'add');
    });

    // (a scripted trigger, effect or script value the mod's files have commented out: the rule does not carry it back unless a script file of the
    // mod itself names it, so the callers in the game's files are made harmless; the files the pass reads are asked first, once, what names them)
    const COMMENTED_KINDS = new Set(['common/scripted_triggers', 'common/scripted_effects', 'common/script_values']);
    let ownNamed: Set<string> | undefined;
    const namedByMod = (): Set<string> =>
    {
        if (ownNamed)
            return ownNamed;

        const named = (ownNamed = new Set<string>());
        const wanted = new Map<string, LibraryFolder[]>();

        for (const [key, c] of cands)
            if (c.disabled && COMMENTED_KINDS.has(c.folder.folder))
                wanted.set(key.slice(c.folder.folder.length + 1), [c.folder]);

        if (!wanted.size)
            return named;

        // (one expression of all the names; past V8's fast path (wordRuns.ts: AGOT has some 840, 7 times slower than the scan it
        // spares) the names of word characters as whole words in one pass, the others in an expression of their own, unless one
        // could change how it splits: then all of them in one, as before)
        const names = [...wanted.keys()];
        const split = pastFastPath(names) && !names.some((n) => /[|()[\]\\]/.test(n));
        const words = split ? wordSet(names.filter(isWordName)) : undefined;
        const others = split ? names.filter((n) => !isWordName(n)) : names;
        const any = others.length ? new RegExp(`\\b(?:${others.join('|')})\\b`) : undefined;
        const look = (text: string): void =>
        {
            if ((!!words && words.size > 0 && hasWord(text, words)) || !!any?.test(text))
                scan(text, 'script', wanted, (h) => void named.add(`${h.folder.folder}|${h.name}`));
        };

        for (const top of ['common', 'events', 'history', 'gfx'])
        {
            for (const lf of vfs.list(top, { ext: /\.(txt|gfx)$/i }))
            {
                if (hiders.has(lf.source) && !inert?.gameCopy?.(lf.rel) && !ownLibrary(lf, patchSource))
                    look(vfs.readText(lf) ?? '');
            }
        }

        extra.forEach(look);
        return named;
    };
    inert?.declined((folder, name) =>
    {
        const key = `${folder}|${name}`;
        return !!cands.get(key)?.disabled && !namedByMod().has(key);
    });

    const flagFolders = new Map<string, LibraryFolder>();
    const queried = new Map<string, string>();

    for (const s of flagStates)
    {
        const pseudo: LibraryFolder = { folder: FLAG_PREFIX + s.kind.folder, label: s.kind.label, keys: s.kind.queries, flagIn: s.kind.blocks };
        flagFolders.set(s.kind.folder, pseudo);

        for (const w of s.want.keys())
            byName.set(w, [...(byName.get(w) ?? []), pseudo]);
    }

    const chosen = new Map<string, LibraryEntry>();
    // (the interaction categories of the mod that have the index of one of the game's)
    const categories = (carried: LibraryEntry[]): ReturnType<typeof reindexCategories> =>
        (folders.some((f) => f.folder === CATEGORY_FOLDER) ? reindexCategories(vfs, CATEGORY_FOLDER, hiders, (x) => ownLibrary(x, patchSource), carried) : undefined);
    // (who names the on_actions: the loaded files in the pass below, the hidden ones when no loaded file does)
    const oa = fired.size ? nameProbe(vfs, [...fired].map((k) => k.slice(ON_ACTION_FOLDER.folder.length + 1)), ['common', 'events', 'history', 'gfx']) : undefined;
    const passes: ScriptProbe[] = oa ? [...probes, oa] : probes;

    if (!cands.size && !flagStates.length && !passes.some((p) => p.wants))
    {
        const cat = categories([]);
        return cat ? [{ folder: CATEGORY_FOLDER, label: folders.find((f) => f.folder === CATEGORY_FOLDER)!.label, entries: [], replacePath: false, reindexed: cat.moved, copies: cat.copies }] : [];
    }

    // 2. the entries a loaded file names
    // (the entries the mod's files have commented out are the author's removals: only a script file of the mod itself that
    // names one brings it back; what else names it is told)
    const refused = new Map<string, string>();
    // (the entries the loaded world cannot use: what they name that it lacks)
    const lacking = new Map<string, string[]>();
    const take = (key: string, why: LibraryEntry['why'], by: string, ownScript = false): boolean =>
    {
        const c = cands.get(key);

        if (!c || chosen.has(key))
            return !!c;

        if (c.lacks)
        {
            lacking.set(key, c.lacks);
            return false;
        }

        if (c.disabled && !(why === 'referenced' && ownScript))
        {
            if (!refused.has(key))
                refused.set(key, by);

            return false;
        }

        // (the statements that name what the loaded world lacks are made harmless before the entry is read for what it names in turn)
        const text = inert ? inert.text(c.folder.folder, c.entry.text) : c.entry.text;
        chosen.set(key, { ...c.entry, ...(text === c.entry.text ? {} : { text, constants: carriedDefs(text, c.consts, new Map()).constants }), why, by });
        return true;
    };

    // (an engine registry's entries: no file names them)
    for (const key of engine)
        take(key, 'engine', '');

    const query = (h: Hit, by: string): void =>
    {
        const key = `${h.folder.folder.slice(FLAG_PREFIX.length)}|${h.name}`;

        if (!queried.has(key))
            queried.set(key, by);
    };
    const seen = (rel: string, mode: 'script' | 'loc' | 'macro', text: string, ownScript = false): void =>
    {
        scan(text, mode, byName, (h) =>
        {
            if (h.folder.folder.startsWith(FLAG_PREFIX))
                query(h, rel);
            else
                take(`${h.folder.folder}|${h.name}`, 'referenced', rel, ownScript);
        });
    };
    const scripts = ['common', 'events', 'history', 'gfx'].flatMap((top) => vfs.list(top, { ext: /\.(txt|gfx)$/i }));
    const guis = vfs.list('gui', { ext: /\.(gui|txt)$/i });
    // (a game file that holds none of the words the pass looks for (the names to find, the probes' words) gives the pass nothing: it
    // is not read; gameFacts.ts keeps each game file's words for the session. Without words from every probe that asks, all are read)
    const asking = passes.filter((p) => p.wants);
    const gate = asking.every((p) => p.gameWords) ? new WordGate([...[...byName.keys()].filter(isTokenName), ...asking.flatMap((p) => p.gameWords!)]) : undefined;

    // (the patch mod's own library files are the previous run's output: a second run must see what the first saw)
    for (const f of scripts.filter((x) => !ownLibrary(x, patchSource)))
    {
        // (a game file: whether it is empty and its words, without reading it; one the inert step rewrites is read as before)
        const words = gate && onGameDisk(f) ? scriptWords(f.abs!) : undefined;

        if (words && (words.empty || (inert?.rewritten?.(f) === undefined && !gate!.holds(words.words))))
            continue;

        const text = vfs.readText(f);

        if (!text)
            continue;

        const view = inert?.rewritten?.(f) ?? text;
        seen(f.rel, 'script', view, hiders.has(f.source) && !inert?.gameCopy?.(f.rel));
        passes.forEach((p) => p.wants && p.visit(f, view));
    }

    for (const f of guis)
    {
        const text = vfs.readText(f);

        if (text?.includes('['))
            seen(f.rel, 'loc', text);
    }

    // (the texts the game shows: of the keys defined twice the winning definition; a string a mod's replace folder
    // overwrites names nothing any more)
    for (const [rel, lines] of winningLocalization(vfs, language))
        seen(rel, 'loc', lines.join('\n'));

    for (const f of vfs.list('data_binding', { ext: /\.txt$/i }))
    {
        const text = vfs.readText(f);

        if (text)
            seen(f.rel, 'macro', text);
    }

    extra.forEach((t, i) =>
    {
        seen(tr('(a file this run writes, {n})', { n: i + 1 }), 'script', t, true);
        oa?.visit({ rel: tr('(a file this run writes, {n})', { n: i + 1 }), source: modSource }, t);
    });

    // (the on_actions: named by a loaded file: carried, it fires them; named by nothing: the engine fires it; named only by game
    // files that are hidden: nothing fires it any more, the notes tell it)
    if (oa)
    {
        const refs = oa.result();

        for (const key of fired)
        {
            const name = key.slice(ON_ACTION_FOLDER.folder.length + 1);
            const by = refs.loaded.get(name);

            if (by !== undefined)
                take(key, 'referenced', by);
            else if (!refs.hidden.has(name))
                take(key, 'engine', tr('fired by the engine'));
        }
    }

    // 3. what they name in turn, across the folders, until nothing is new
    for (let queue = [...chosen.entries()]; queue.length;)
    {
        const next: [string, LibraryEntry][] = [];

        for (const [, e] of queue)
        {
            scan(e.text, 'script', byName, (h) =>
            {
                const key = `${h.folder.folder}|${h.name}`;

                // (the words a carried entry tests count as tested: no loaded file may do, the file that did is hidden)
                if (h.folder.folder.startsWith(FLAG_PREFIX))
                    query(h, e.name);
                else if (h.name !== e.name && cands.has(key) && !chosen.has(key) && take(key, 'needed', e.name))
                    next.push([key, chosen.get(key)!]);
            });

            // (an on_action a carried entry fires in turn)
            for (const name of oa?.mentions(e.text) ?? [])
            {
                const key = `${ON_ACTION_FOLDER.folder}|${name}`;

                if (name !== e.name && cands.has(key) && !chosen.has(key) && take(key, 'needed', e.name))
                    next.push([key, chosen.get(key)!]);
            }
        }

        queue = next;
    }

    // (what the carried on_actions fire (events, macro calls) is asked of the probes like the files of the pass: the carried file is a loaded file)
    const carriedHere = tr('{folder} (carried over)', { folder: ON_ACTION_FOLDER.folder });

    for (const [key, e] of chosen)
        if (key.startsWith(ON_ACTION_FOLDER.folder + '|'))
            probes.forEach((p) => p.wants && p.visit({ rel: carriedHere, source: modSource }, e.text));

    // 4. per folder, in the game's order
    const out: LibraryFolderWork[] = [];

    for (const f of all)
    {
        const entries = [...chosen].filter(([k]) => k.startsWith(f.folder + '|')).map(([, e]) => e).sort((a, b) => (lc(a.rel) < lc(b.rel) ? -1 : lc(a.rel) > lc(b.rel) ? 1 : a.pos - b.pos));
        const disabled = [...refused].filter(([k, by]) => k.startsWith(f.folder + '|') && !chosen.has(k) && by).map(([k, by]) => ({ name: k.slice(f.folder.length + 1), by })).sort((a, b) => (a.name < b.name ? -1 : 1));
        const lacks = [...lacking].filter(([k]) => k.startsWith(f.folder + '|') && !chosen.has(k)).map(([k, what]) => ({ name: k.slice(f.folder.length + 1), what })).sort((a, b) => (a.name < b.name ? -1 : 1));
        const cat = f.folder === CATEGORY_FOLDER ? categories(entries) : undefined;

        if (entries.length || disabled.length || lacks.length || cat)
        {
            out.push({
                folder: f.folder, label: f.label, entries, replacePath: replaced.has(f.folder), ...(disabled.length ? { disabled } : {}), ...(f.fired ? { fired: true } : {}),
                ...(lacks.length ? { lacking: lacks } : {}), ...(cat ? { reindexed: cat.moved, copies: cat.copies } : {})
            });
        }
    }

    // 5. the flag words a loaded file tests, added to the mod's own entry of the game's entry that carries them
    for (const s of flagStates)
    {
        const adds = new Map<string, { site: FlagSite; words: string[]; by: string; }[]>();
        const gone: string[] = [];
        const declined: string[] = [];
        const redefined: string[] = [];

        for (const [word, carriers] of s.want)
        {
            const by = queried.get(`${s.kind.folder}|${word}`);

            if (!by)
                continue;

            for (const c of carriers)
            {
                const fate = carrierFate(s, c, word);

                if (fate === 'gone')
                {
                    gone.push(`${word} (${c.entry})`);
                    continue;
                }

                if (fate === 'redefined')
                {
                    redefined.push(`${c.entry} (${s.last.get(c.entry)!.rel})`);
                    continue;
                }

                if (fate === 'declined')
                {
                    declined.push(`${word} (${c.entry})`);
                    continue;
                }

                const list = adds.get(c.entry) ?? [];
                const at = list.find((x) => x.site.list === c.site.list && x.site.path.join('/') === c.site.path.join('/'));

                if (at)
                    at.words.push(word);
                else
                    list.push({ site: c.site, words: [word], by });

                adds.set(c.entry, list);
            }
        }

        const entries: LibraryEntry[] = [];

        for (const [name, list] of adds)
        {
            const def = s.defs.get(name)!;
            const edits = list.map((a) => addFlagWords(def.text, def.node, a.site.path, a.site.list, [...new Set(a.words)], s.kind.list)!).sort((a, b) => b.at - a.at);
            let text = def.text;

            for (const e of edits)
                text = text.slice(0, e.at) + e.text + text.slice(e.at);

            const entryText = text.slice(def.from, def.to + edits.reduce((n, e) => n + e.text.length, 0));
            entries.push({ name, rel: def.rel, pos: def.node.s, text: entryText, constants: carriedDefs(entryText, def.consts, new Map()).constants, why: 'referenced', by: list[0].by, words: [...new Set(list.flatMap((a) => a.words))] });
        }

        if (entries.length || gone.length || declined.length || redefined.length)
        {
            out.push({
                folder: s.kind.folder, label: s.kind.label, entries: entries.sort((a, b) => a.pos - b.pos), replacePath: false, flags: true, gone: [...new Set(gone)],
                ...(declined.length ? { declined: [...new Set(declined)] } : {}), ...(redefined.length ? { redefined: [...new Set(redefined)] } : {}), after: s.after
            });
        }
    }

    return out;
}

/** The pseudo folder name of a flag kind in the name map (the real folder behind it). */
const FLAG_PREFIX = 'flags|';

/** A definition's text without comments and spacing: two definitions that read the same are equal. */
function canon(idx: GameIndex, e: Parameters<GameIndex['defNode']>[0], defIdx: number): string
{
    const d = idx.defNode(e, undefined, defIdx);
    return d ? d.src.slice(d.node.s, d.node.e).split('\n').map((l) => l.replace(/#.*$/, '')).join(' ').replace(/\s+/g, '') : '';
}

/**
 * Entries the mod defines in its copy of a game file (same path) that the game's newer version of the file no longer
 * has, while a game file of another path defines them: the game's loads after the mod's file and wins now; the mod's
 * addition to it and the game's change meet. And the other way round: the game's other file loads before the mod's copy,
 * which wins with its older body (an entry the game moved to an earlier-sorting file; told only when the bodies differ).
 * No automatic choice: the notes say it.
 */
export function movedEntries(idx: GameIndex, modSource: number, patchSource: number): MovedEntry[]
{
    const mods = new Set([modSource, patchSource].filter((s) => s > 0));
    // (the game's files a mod hid, by path: the entries they define)
    const hiddenGame = new Map<string, Set<number>>();

    idx.files.forEach((f, i) =>
    {
        if (f.hidden && f.source === 0 && !f.gone)
            hiddenGame.set(lc(f.rel), (hiddenGame.get(lc(f.rel)) ?? new Set()).add(i));
    });

    const out: MovedEntry[] = [];

    for (const e of idx.entities)
    {
        if (e.dead || e.defs.length < 2 || e.type === 'on_action' || e.type === 'localization' || e.type === 'flag' || e.type === 'variable')
            continue;

        const win = idx.winningIdx(e);
        const w = win < 0 ? undefined : e.defs[win];

        if (!w)
            continue;

        const wf = idx.files[w.file];
        const keys = (i: number): string[] =>
        {
            const n = idx.defNode(e, undefined, i)?.node;
            return Array.isArray(n?.v) ? [...new Set((n.v as PNode[]).map((c) => c.k ?? (typeof c.v === 'string' ? c.v : '')).filter(Boolean))] : [];
        };

        // (the mod's copy of a game file wins: the game's file that now defines the entry loads before it)
        if (wf.source !== 0)
        {
            const gi = e.defs.findIndex((d, i) => i !== win && idx.files[d.file].source === 0 && !idx.files[d.file].hidden && idx.files[d.file].area === 'common' && !d.local);
            const oldFiles = hiddenGame.get(lc(wf.rel));

            if (gi < 0 || wf.hidden || !mods.has(wf.source) || wf.area !== 'common' || w.local || !oldFiles || lc(wf.rel) === lc(idx.files[e.defs[gi].file].rel) || e.defs.some((d) => oldFiles.has(d.file)))
                continue;

            // (an entry the version moved to another folder (a law group out of common/laws) is the layout step's work)
            if (lc(wf.rel.slice(0, wf.rel.lastIndexOf('/'))) !== lc(idx.files[e.defs[gi].file].rel.slice(0, idx.files[e.defs[gi].file].rel.lastIndexOf('/'))))
                continue;

            // (a body the same as the game's is no conflict; only the ones that differ are told)
            if (canon(idx, e, win) === canon(idx, e, gi))
                continue;

            const mk = keys(win);
            const gk = keys(gi);
            out.push({ type: e.type, name: e.name, modFile: wf.rel, gameFile: idx.files[e.defs[gi].file].rel, wins: 'mod', modOnly: mk.filter((k) => !gk.includes(k)), gameOnly: gk.filter((k) => !mk.includes(k)) });
            continue;
        }

        if (wf.area !== 'common' || w.local)
            continue;

        // (the mod's loaded definition in a file the game's older copy of which lacks the entry)
        const mi = e.defs.findIndex((d, i) => i !== win && !idx.files[d.file].hidden && mods.has(idx.files[d.file].source) && idx.files[d.file].area === 'common');
        const m = mi < 0 ? undefined : e.defs[mi];

        if (!m)
            continue;

        const mf = idx.files[m.file];
        const old = hiddenGame.get(lc(mf.rel));

        if (!old || lc(mf.rel) === lc(wf.rel) || e.defs.some((d) => old.has(d.file)))
            continue;

        const mk = keys(mi);
        const gk = keys(win);
        out.push({ type: e.type, name: e.name, modFile: mf.rel, gameFile: wf.rel, wins: 'game', modOnly: mk.filter((k) => !gk.includes(k)), gameOnly: gk.filter((k) => !mk.includes(k)) });
    }

    return out.sort((a, b) => (a.type + a.name < b.type + b.name ? -1 : 1));
}

/**
 * The on_actions the game defines in a file the mod or its patch mod hid, that no loaded file defines, and that the libraries
 * rule neither carries nor tells otherwise (`told`: carried, or commented out by the mod): the ones only game files that are
 * hidden name, which nothing fires any more. The engine fires on_actions by itself (`on_rite_created` when a rite is made,
 * and the personal tenet window reads `on_personal_tenet_gain`), so a name in no loaded file does not exist: the same name in
 * several files merges. The ones the engine fires or a loaded file names are carried (libraryWork, `LibraryFolder.fired`);
 * of the rest the notes say that what the game's hooks did (events, effects) is not brought back.
 */
export function missingOnActions(vfs: GameFiles, modSource: number, patchSource: number, told: Set<string> = new Set()): MissingOnActions[]
{
    const hiders = new Set([modSource, patchSource].filter((s) => s > 0));
    const folder = 'common/on_action';
    const live = new Set<string>();

    for (const lf of vfs.list(folder, { ext: /\.txt$/i }))
    {
        if (ownLibrary(lf, patchSource))
            continue;

        for (const k of (onGameDisk(lf) ? topKeysOf(lf.abs!) : undefined) ?? parse(stripBom(vfs.readText(lf) ?? '')).map((n) => n.k))
            if (k)
                live.add(k);
    }

    const byFile = new Map<string, Set<string>>();

    for (const h of vfs.hidden(folder, { ext: /\.txt$/i }).filter((x) => lostToHiders(vfs, x, hiders)))
    {
        for (const n of parse(stripBom(vfs.readText(h.file) ?? '')))
            if (n.k && !n.k.startsWith('@') && !live.has(n.k) && !told.has(n.k) && Array.isArray(n.v))
                byFile.set(h.file.rel, (byFile.get(h.file.rel) ?? new Set()).add(n.k));
    }

    return [...byFile].map(([rel, names]) => ({ rel, names: [...names] })).sort((a, b) => (lc(a.rel) < lc(b.rel) ? -1 : 1));
}

/**
 * The query of the index worker: the library work for a mod (`modId`) and its patch mod (`patchId`), with the moved
 * entries. Source indices as the migration plan finds them.
 */
export function migrationLibraries(idx: GameIndex, config: LibraryConfig, modId: string, patchId: string | undefined, extra: string[], inertOpts?: InertOptions): LibraryWork | null
{
    // (the game files' stamps looked at once for the query: gameFacts.ts)
    return factScope(() => librariesQuery(idx, config, modId, patchId, extra, inertOpts));
}

function librariesQuery(idx: GameIndex, config: LibraryConfig, modId: string, patchId: string | undefined, extra: string[], inertOpts?: InertOptions): LibraryWork | null
{
    const find =(id: string | undefined): number => (id ? idx.vfs.sources.findIndex((s) => s.modId?.toLowerCase() === id.toLowerCase()) : -1);
    const source = find(modId);

    if (source < 1)
        return null;

    const patch = find(patchId);
    const hiders = new Set([source, patch].filter((s) => s > 0));
    // (asked of the pass over the script files that finds the references: the events the mod's copies hide, the macro arguments)
    const events = eventProbe(idx.vfs, hiders);
    // (the patch mod's copies of game files, from an earlier run of the inert step: the game's script still)
    const gameCopies = new Set((inertOpts?.copies ?? []).filter((rel) => inertOpts?.sources?.[rel]).map((rel) => rel.toLowerCase()));
    const gameCopy = (rel: string): boolean => gameCopies.has(rel.toLowerCase());
    const macros = macroProbe(idx.vfs, hiders, (f) => ownLibrary(f, patch), (f) => f.source === patch && gameCopy(f.rel));
    // (the inert references step: what the carried entries name that the loaded world lacks is made harmless as they are chosen)
    const world = inertWorld(idx, { renamed: inertOpts?.renamed });
    // (the content the loaded files lack, as the engine registry's formats see it: the modifier types the engine makes for it do not exist)
    const engineContent = config.folders.find((f) => f.engine)?.engine?.content;

    if (engineContent)
        world.gone = new Set(goneContent(idx.vfs, engineContent, hiders, patch));

    const summary: InertSummary = { names: {}, kept: {} };
    // (the inert step's files, made once: the scan for the references reads their text (the first run sees what the second one sees),
    // and the work below returns them; the step needs the library rule's `gainable` words, so it is made when the scan asks)
    const own = (rel: string, src: number): boolean => patch > 0 && src === patch && (LIBRARY_FILE.test(rel) || INERT_FILE.test(rel));
    let stepWork: InertWork | undefined;
    let stepTexts: Map<string, string> | undefined;
    const step = (): InertWork =>
        (stepWork ??= inertWork(idx, world, source, patch, own, inertOpts!.owned ? new Set(inertOpts!.owned) : undefined, new Set(inertOpts!.skip), inertOpts!.recorded, { ruleFiles: inertOpts!.ruleFiles, copies: inertOpts!.copies, sources: inertOpts!.sources }));
    const rewritten = (f: { rel: string; source: number; }): string | undefined =>
    {
        if (!stepTexts)
        {
            // (a copy replaces the file of its path in the patch mod: the file it is made from, and the copy of an earlier run, read the new text)
            stepTexts = new Map();
            const w = step();

            for (const c of w.copies)
                if (c.text !== undefined)
                    for (const src of [c.from === 'game' ? 0 : source, patch])
                        stepTexts.set(`${src}|${c.rel.toLowerCase()}`, c.text);

            for (const x of w.files)
                stepTexts.set(`${patch}|${x.rel.toLowerCase()}`, x.text);
        }

        return stepTexts.get(`${f.source}|${f.rel.toLowerCase()}`)?.replace(/^\uFEFF/, '');
    };
    const inert: LibraryInert | undefined = inertOpts ?
        {
            text(folder, text)
            {
                // (an entry of a hidden game file: kept for the session with the answers it read, inertWork.ts)
                const r = gameInertText(text, folder, world);
                addNames(summary, r.names);
                r.kept.forEach((k) => addKept(summary, k, folder));
                return r.text;
            },
            gainable(fn)
            {
                world.gainable = (_kind, word) => fn(word);
            },
            declined(fn)
            {
                world.declined = fn;
            },
            flags(fn)
            {
                world.flagMissing = fn;
            },
            gameCopy,
            rewritten
        } :
        undefined;
    const folders = libraryWork(idx.vfs, config, source, patch, idx.language, extra, [events, macros], inert, inertOpts?.renamed);
    // (the ones carried, and the ones the mod's files have commented out, are told elsewhere)
    const oa = folders.find((f) => f.folder === ON_ACTION_FOLDER.folder);
    const told = new Set([...(oa?.entries.map((e) => e.name) ?? []), ...(oa?.disabled?.map((d) => d.name) ?? [])]);
    const work: LibraryWork = { folders, moved: movedEntries(idx, source, patch), onActions: missingOnActions(idx.vfs, source, patch, told), events: events.result(), macros: macros.result() };

    if (inertOpts)
    {
        // (another patch mod's inert files are loaded files like any: the playset is the world they were made for, so a second patch mod finds nothing to add)
        const w = step();
        work.inert = { ...w, summary: mergeSummary(w.summary, summary) };
    }

    return work;
}

