/**
 * The inert references step in the index worker (inert.ts is the rewrite, inertWorld.ts the world; libraries.ts calls this after the
 * library entries are chosen): what the patch mod gets so that statements naming entries the loaded world lacks are made harmless.
 *
 * - **Overrides of live entries**, one file per database folder (`zz_<patch folder>_inert.txt`): the winning definition of a
 *   key (the last loaded one) when it is in a file of the game or of the migrated mod, with its statements rewritten. The game takes
 *   the last definition of a key in a folder (docs/mods.md, "Which definition wins"), and the file sorts after the mod's. Where the
 *   winner is a file of another mod or of the patch mod, nothing is written (the patch mod's own files are rewritten in place). Not
 *   for `on_action` (they merge), events (no override by id), landed titles and the other nested world data, religions and cultures:
 *   the events and on_actions are copied whole, see below. Beside an override the game's original file still loads (the game
 *   reports at load what its statements name); copying the game's database files whole instead was tried and dropped (round 9:
 *   too little gained for the size, and a copy hides the game's later updates of the file). The copies an earlier run made are
 *   the patch life's to delete (`staleGameCopies`).
 * - **The patch mod's own files** (copies of the mod's files, files a fix made): rewritten in place, except the ones a rule
 *   regenerates by text (restored, merged, defines, library files) or the owner changed.
 * - **Whole-file copies** of the files of the game and of the mod that are no database of keys (the events: no override by id; the
 *   on_actions: they merge, a second definition adds to the first): the file at the same path in the patch mod replaces the file
 *   (files of one path replace each other, the later source's wins), written with its statements made harmless. Where the winner is
 *   a file of another mod, nothing is written. Where a rule of the run writes the path, the rule's file is rewritten in place (no
 *   copy beside it). A copy of the game's file is looked at again against the game's file under it (`InertOptions.copies`): a
 *   game update that changed it writes it again.
 *
 * The library entries are rewritten where they are chosen (libraries.ts `take`).
 */
import { commentStart, carriedDefs, fileConstants, trailingEnd, type CarriedDef } from '../indexer/override.ts';
import type { GameIndex } from '../indexer/gameIndex.ts';
import type { GameFile } from './gamefiles.ts';
import { parse } from '../indexer/parser.ts';
import { createHash } from 'node:crypto';
import { inertText, type InertKept, type InertKind, type InertResult, type InertWorld } from './inert.ts';
import { sha1 } from './fixesManifest.ts';
import { noteChange, own, storePart } from './gameFacts.ts';

/** A definition of the game written again with its statements made harmless. */
export interface InertEntry
{
    name: string;
    /** the game file it is defined in */
    rel: string;
    /** where it stands in that file (the entries go in the game's order) */
    pos: number;
    /** the whole definition, the comment above it and a comment behind it included, rewritten */
    text: string;
    /** the file's `@constants` its text uses */
    constants: CarriedDef[];
}

export interface InertFolderWork
{
    /**
     * The directory of the winning definitions' file (`common/decisions`, or `common/decisions/dlc_decisions/pam`): where the file goes. The
     * game loads a folder's files before its subfolders', so a file at the type's root would load before a game file in a subfolder.
     */
    folder: string;
    entries: InertEntry[];
    /** the last (lower case) file name directly in the directory (any source, but this step's own output): the file written must load after it */
    after?: string;
}

/** A file of the patch mod rewritten in place. */
export interface InertFile
{
    rel: string;
    text: string;
    /** the hash of the file as it was loaded (the patch mod's own file): a rule that writes the file by text sees it as done by this */
    raw?: string;
}

/** A whole-file copy of a file of the game or of the mod. */
export interface InertCopy
{
    rel: string;
    /** the text to write (the byte order mark of the file in front); undefined: the copy is there and needs nothing */
    text?: string;
    /** whose file it is a copy of */
    from: 'game' | 'mod';
}

/** The folders whose files are copied whole (see the top of the file). */
const COPY_FOLDERS = ['events', 'common/on_action'];

/** Whether a path is below one of the folders whose files are copied whole. */
const inCopyFolder = (rel: string): boolean => COPY_FOLDERS.some((top) => rel.toLowerCase().startsWith(top.toLowerCase() + '/'));

/**
 * The whole-file copies of a record (the manifest's `inert.copies`) that the step does not make any more: copies of the game's
 * database files (`common/<type>/…`), which round 9 made for a while. The patch life deletes them as files no rule asks for
 * (migrate.ts `orphansOf`: the ones the run wrote and nobody changed since), so the game's file loads again and gets overrides.
 */
export const staleGameCopies = (copies: string[] | undefined): string[] => (copies ?? []).filter((rel) => !inCopyFolder(rel));

/** The key of a file in the record of sources: the game's files by their path, the mod's with `mod:` in front. */
export const sourceKey = (rel: string, from: 'game' | 'mod'): string => (from === 'game' ? rel : `mod:${rel}`);

export interface InertSummary
{
    /** the statements made false or dropped, per kind and name: the names are what the notes list */
    names: Record<string, string[]>;
    /** the statements left as they are, why, with the first few places */
    kept: Record<string, { n: number; examples: string[]; }>;
}

export interface InertWork
{
    folders: InertFolderWork[];
    files: InertFile[];
    /** the whole-file copies of files of the game and of the mod (events, on_actions), the ones that are there and need nothing included */
    copies: InertCopy[];
    /** the game files the overrides and copies were made from: the manifest records their hashes (a game update changes them) */
    sources: string[];
    /** the same for the migrated mod's files (the mod updates a file the override was made from: the override masks the new text) */
    modSources: string[];
    summary: InertSummary;
    /** the names an earlier run treated as missing that the world has now */
    present: string[];
}

/** Entity types whose definitions are world data, nested, registries or no script at all: never overridden. */
const SKIP_TYPES = new Set([
    'on_action', 'landed_titles', 'dynasties', 'dynasty_houses', 'characters', 'localization', 'flag', 'variable', 'events', 'images', 'models', 'defines',
    'religion/religion_types', 'faith', 'culture/cultures', 'bookmark_portraits', 'dna_data', 'culture/name_equivalency', 'culture/creation_names', 'holy_orders',
    'modifier_definition_formats', 'game_rules', 'game_rule_options', 'ethnicities', 'genes', 'named_colors', 'flavorization', 'nicknames', 'achievements',
    'accolade_types', 'deathreasons', 'game_concepts', 'terrain_types', 'graphical_unit_types', 'morpheme_strip_rules', 'event_transitions', 'event_2d_effects'
]);

/** Folders of other things below `common` that hold no database of the type (the type names a folder the file stands in). */
const isCoaOrHistory = (type: string): boolean => type.startsWith('coat_of_arms') || type.startsWith('history') || type.startsWith('bookmarks') || type.startsWith('portrait');

/** What the step is asked for: which files of the patch mod it may rewrite in place, which a rule regenerates, and the names an earlier run treated as missing. */
export interface InertOptions
{
    /** the patch mod's files (lower case paths) that are the run's own, so rewriting them is safe; undefined: all */
    owned?: string[];
    /** the patch mod's files (lower case paths) a rule regenerates by text (restored, merged, defines): left as they are */
    skip: string[];
    /** `kind:name` of the names the last run treated as missing */
    recorded: string[];
    /** the paths (lower case) that rules of the run write or edit: the patch mod's file there is theirs, rewritten in place; no copy is made beside it */
    ruleFiles?: string[];
    /** the whole-file copies an earlier run made (the manifest's `inert.copies`) */
    copies?: string[];
    /** the hashes of the files the earlier run's overrides and copies were made from (the manifest's `inert.sources`, `sourceKey`) */
    sources?: Record<string, string>;
    /** entries the loaded world has under another name (renameRule.ts): a statement naming `from` (of the index type `type`) names `to` instead of being made false */
    renamed?: { type: string; from: string; to: string; }[];
}

/** The patch mod's files this step writes whole or in part: what the scans leave out as an earlier run's output. */
export const INERT_FILE = /(?:^|\/)zz+_[^/]*_inert(?:_\d+)?\.txt$/i;

/** Two summaries as one. */
export function mergeSummary(a: InertSummary, b: InertSummary): InertSummary
{
    const out: InertSummary = { names: {}, kept: {} };

    for (const s of [a, b])
    {
        for (const [kind, names] of Object.entries(s.names))
            out.names[kind] = [...new Set([...(out.names[kind] ?? []), ...names])].sort();

        for (const [reason, k] of Object.entries(s.kept))
        {
            const o = (out.kept[reason] ??= { n: 0, examples: [] });
            o.n += k.n;
            o.examples.push(...k.examples.filter((x) => !o.examples.includes(x)).slice(0, Math.max(0, 4 - o.examples.length)));
        }
    }

    return out;
}

/** A question inertText asked of the world: `missing(kind, name)`, `effectKeeps(name)`, `renamed(kind, name)`. */
interface Question
{
    ask: 'missing' | 'effectKeeps' | 'renamed';
    kind: InertKind;
    name: string;
}

/** The questions asked so far, each once, by number. */
const questionIds = new Map<string, number>();
const questions: Question[] = [];

function questionId(ask: Question['ask'], kind: InertKind, name: string): number
{
    const key = `${ask}\0${kind}\0${name}`;
    let id = questionIds.get(key);

    if (id === undefined)
    {
        id = questions.length;
        questionIds.set(key, id);
        questions.push({ ask, kind, name: own(name) });
    }

    return id;
}

const answerOf = (world: InertWorld, q: Question): unknown =>
    (q.ask === 'missing' ? world.missing(q.kind, q.name) : q.ask === 'effectKeeps' ? world.effectKeeps!(q.name) : world.renamed!(q.kind, q.name));

/** A kept rewrite: the world's answers it read, and its result (the text only when the rewrite changed it). */
interface KeptRewrite
{
    asked: Uint32Array;
    answers: unknown[];
    same: boolean;
    text?: string;
    edits: number;
    names: InertResult['names'];
    kept: InertKept[];
}

/** what the kept rewrites may number (a bound; the game's texts a query rewrites are ~44,000 entries and files) */
const KEPT_MAX = 400000;
const rewrites = new Map<string, KeptRewrite>();

// (kept between sessions with the facts, gameFacts.ts: each use checks a rewrite by the text's hash and the world's answers)
storePart('inertRewrites', {
    give: () => ({ questions, rewrites: [...rewrites] }),
    take(value)
    {
        const v = value as { questions: Question[]; rewrites: [string, KeptRewrite][]; };

        if (questions.length || rewrites.size)
            return;

        v.questions.forEach((q, i) => (questions.push(q), questionIds.set(`${q.ask}\0${q.kind}\0${q.name}`, i)));
        v.rewrites.forEach(([k, r]) => rewrites.set(k, r));
    }
});

/**
 * `inertText` of one of the game's texts, kept for the session with the world's answers it read (round 12). inertText reads nothing
 * but its arguments, and the world only through `missing`, `effectKeeps` and `renamed`; it holds no state between calls. So a rewrite of
 * the same text and folder, in a world that has the same optional questions and gives the same answer to every question the kept
 * rewrite asked, asks those questions in the same order and gives the same result: the questions are asked again (each world keeps
 * its own answers), and the kept result is taken only when every answer is the same; otherwise the text is rewritten and kept anew.
 * Keyed by the text's hash: no text of the game is kept, but a rewritten one. Not for the mod's texts (they change with each run).
 */
export function gameInertText(text: string, folder: string, world: InertWorld): InertResult
{
    const key = `${world.effectKeeps ? 'e' : '-'}${world.renamed ? 'r' : '-'}|${folder}|${createHash('sha1').update(text).digest('hex')}`;
    const have = rewrites.get(key);

    if (have && have.answers.every((a, i) => answerOf(world, questions[have.asked[i]]) === a))
        return { text: have.same ? text : have.text!, edits: have.edits, names: have.names, kept: have.kept };

    const asked = new Map<number, unknown>();
    let clash = false;
    const note = <T>(id: number, answer: T): T =>
    {
        // (the same question twice with another answer: the world changed under the rewrite, nothing is kept)
        if (asked.has(id) && asked.get(id) !== answer)
            clash = true;

        asked.set(id, answer);
        return answer;
    };
    const recording: InertWorld = {
        missing: (kind, name) => note(questionId('missing', kind, name), world.missing(kind, name)),
        ...(world.effectKeeps ? { effectKeeps: (name: string) => note(questionId('effectKeeps', 'scripted_effect', name), world.effectKeeps!(name)) } : {}),
        ...(world.renamed ? { renamed: (kind: InertKind, name: string) => note(questionId('renamed', kind, name), world.renamed!(kind, name)) } : {})
    };
    const r = inertText(text, folder, recording);

    // (kept with strings of their own: the names and texts are views into the game's text, gameFacts.ts `own`)
    if (!clash && (have || rewrites.size < KEPT_MAX))
    {
        noteChange();
        rewrites.set(key, {
            asked: Uint32Array.from(asked.keys()), answers: [...asked.values()].map((a) => (typeof a === 'string' ? own(a) : a)), same: r.text === text, ...(r.text === text ? {} : { text: own(r.text) }), edits: r.edits,
            names: new Map([...r.names].map(([kind, set]) => [kind, new Set([...set].map(own))])), kept: r.kept.map((k) => ({ ...k, name: own(k.name), entry: own(k.entry) }))
        });
    }

    return r;
}

/** The kept rewrites (a check's look and the memory notes); `forgetGameRewrites` drops them. */
export const gameRewriteCount = (): { rewrites: number; questions: number; answers: number; } => ({ rewrites: rewrites.size, questions: questions.length, answers: [...rewrites.values()].reduce((n, r) => n + r.answers.length, 0) });

export function forgetGameRewrites(): void
{
    rewrites.clear();
}

/** The summary line for kept statements. */
export function addKept(sum: InertSummary, k: InertKept, rel: string): void
{
    const key = `${k.reason}`;
    const s = (sum.kept[key] ??= { n: 0, examples: [] });
    s.n++;

    if (s.examples.length < 4 && !s.examples.some((x) => x.startsWith(`${k.entry} `)))
        s.examples.push(`${k.entry} (${rel.slice(rel.lastIndexOf('/') + 1)}) ${k.kind ? `${k.kind}:${k.name}` : k.name}`);
}

export function addNames(sum: InertSummary, names: Map<InertKind, Set<string>>): void
{
    for (const [kind, set] of names)
    {
        const have = new Set(sum.names[kind] ?? []);
        set.forEach((n) => have.add(n));
        sum.names[kind] = [...have].sort();
    }
}

/**
 * @param idx the index of the playset as loaded (the patch mod's files, a previous run's included)
 * @param world which entries the world lacks
 * @param modSource the migrated mod's source index, `patchSource` its patch mod's (-1: none)
 * @param ownOutput whether a file is an output of this step or of the library rule (left out: a second run sees what the first saw)
 * @param patchFiles the patch mod's files that may be rewritten in place (lower case paths; undefined: any), minus `skipPatch`
 * @param recorded `kind:name` of the names an earlier run treated as missing
 */
export function inertWork(idx: GameIndex, world: InertWorld, modSource: number, patchSource: number, ownOutput: (rel: string, source: number) => boolean, patchFiles: Set<string> | undefined, skipPatch: Set<string>, recorded: string[], more: Pick<InertOptions, 'ruleFiles' | 'copies' | 'sources'> = {}): InertWork
{
    const summary: InertSummary = { names: {}, kept: {} };
    const vfs = idx.vfs;

    // 1. the winner of each key of the database folders, by file
    const wanted = new Map<number, { folder: string; names: Set<string>; }>();

    for (const e of idx.entities)
    {
        if (!e || e.dead || !e.defs.length || SKIP_TYPES.has(e.type) || isCoaOrHistory(e.type))
            continue;

        let win = -1;

        for (let i = e.defs.length - 1; i >= 0; i--)
        {
            const d = e.defs[i];
            const fi = idx.files[d.file];

            if (fi.hidden || fi.gone || ownOutput(fi.rel, fi.source) || (idx.files[d.file].area !== 'common'))
                continue;

            // (a landed title written as the way to one inside it is no definition)
            if (d.meta?.path)
                continue;

            win = i;
            break;
        }

        if (win < 0)
            continue;

        const fi = idx.files[e.defs[win].file];
        const typeFolder = `common/${e.type}`;

        // (a file below a folder other than the type's: the layout is not known, nothing is written for it)
        if (!fi.rel.toLowerCase().startsWith(typeFolder.toLowerCase() + '/'))
            continue;

        // (the copy goes into the directory of the winning file, where it loads after it)
        const folder = fi.rel.slice(0, fi.rel.lastIndexOf('/'));

        // (a file of another mod, or the patch mod's own, is not ours to override here)
        if (fi.source !== 0 && fi.source !== modSource)
            continue;

        const w = wanted.get(e.defs[win].file) ?? { folder, names: new Set<string>() };
        w.names.add(e.name);
        wanted.set(e.defs[win].file, w);
    }

    const byFolder = new Map<string, InertEntry[]>();
    const sources = new Set<string>();
    const modSources = new Set<string>();

    for (const [fileIdx, w] of wanted)
    {
        const fi = idx.files[fileIdx];
        const mod = fi.source !== 0;
        const text = vfs.readText(fi.gf);

        if (!text)
            continue;

        const ast = parse(text);
        const consts = fileConstants(ast, text);
        // (the last definition of a name in the file wins)
        const last = new Map<string, number>();
        ast.forEach((n, i) => n.k && w.names.has(n.k) && last.set(n.k, i));

        for (const [name, i] of last)
        {
            const n = ast[i];
            const from = commentStart(text, n.s);
            const original = text.slice(from, trailingEnd(text, n.e));
            const r = (mod ? inertText : gameInertText)(original, fi.rel, world);

            if (r.text === original)
                continue;

            r.kept.forEach((k) => addKept(summary, k, fi.rel));
            addNames(summary, r.names);
            (mod ? modSources : sources).add(fi.rel);
            const list = byFolder.get(w.folder) ?? [];
            list.push({ name, rel: fi.rel, pos: n.s, text: r.text, constants: carriedDefs(r.text, consts, new Map()).constants });
            byFolder.set(w.folder, list);
        }
    }

    // 2. whole-file copies of the files of the game and of the mod that have no entries to override one by one (events, on_actions)
    const copies: InertCopy[] = [];
    // (the paths the patch mod's file is in place for: step 3 leaves them alone)
    const handled = new Set<string>();
    const ruleFiles = new Set(more.ruleFiles ?? []);
    const bomOf = (raw: Buffer | undefined): string => (!!raw && raw.length > 2 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? '﻿' : '');
    const copyFrom = (source: number): 'game' | 'mod' => (source === 0 ? 'game' : 'mod');
    const keep = (rel: string, from: 'game' | 'mod'): void => void (from === 'game' ? sources : modSources).add(rel);

    // (a) the copies an earlier run made: against the file under them (a game update, a rule that now finds more to make false)
    if (patchSource > 0 && more.copies?.length)
    {
        // (a copy of a game database file an earlier run made is no copy of this step's any more: see `staleGameCopies`)
        const wanted = new Set(more.copies.filter(inCopyFolder).map((c) => c.toLowerCase()));
        const mine = new Map<string, boolean>();
        const under = new Map<string, GameFile>();

        for (const top of COPY_FOLDERS)
        {
            for (const f of vfs.list(top, { ext: /\.txt$/i }))
                if (f.source === patchSource && wanted.has(f.rel.toLowerCase()))
                    mine.set(f.rel.toLowerCase(), true);

            // (the file the patch mod's copy hides: the last one before it)
            for (const h of vfs.hidden(top, { ext: /\.txt$/i }))
                if (h.by === patchSource && (h.file.source === 0 || h.file.source === modSource) && wanted.has(h.file.rel.toLowerCase()))
                    under.set(h.file.rel.toLowerCase(), h.file);
        }

        for (const rel of more.copies.filter(inCopyFolder))
        {
            const lc = rel.toLowerCase();
            const file = under.get(lc);

            // (changed by hand, deleted, or a rule's now: not ours to write; the file under it is loaded again when the copy is gone, and step (b) sees it)
            if (!file || !mine.has(lc) || ruleFiles.has(lc) || (patchFiles && !patchFiles.has(lc)))
                continue;

            const raw = vfs.read(file);
            const text = vfs.readText(file);

            if (!raw || !text)
                continue;

            const from = copyFrom(file.source);
            const r = (file.source === 0 ? gameInertText : inertText)(text, file.rel, world);
            const changed = more.sources?.[sourceKey(file.rel, from)] !== sha1(raw);
            handled.add(lc);
            keep(file.rel, from);
            r.kept.forEach((k) => addKept(summary, k, file.rel));

            // (nothing to make false in the file now and it is the one the copy was made from: the copy stays as that run wrote it)
            if (r.text === text && !changed)
            {
                copies.push({ rel: file.rel, from });
                continue;
            }

            addNames(summary, r.names);
            copies.push({ rel: file.rel, from, text: bomOf(raw) + r.text });
        }
    }

    // (b) the loaded files of the game and of the mod that name what the world lacks
    {
        for (const top of COPY_FOLDERS)
        {
            for (const f of vfs.list(top, { ext: /\.txt$/i }))
            {
                const lc = f.rel.toLowerCase();

                // (a file of another mod is that mod's; the patch mod's own files are step 3's)
                if ((f.source !== 0 && f.source !== modSource) || ruleFiles.has(lc) || handled.has(lc))
                    continue;

                const text = vfs.readText(f);

                if (!text)
                    continue;

                const r = (f.source === 0 ? gameInertText : inertText)(text, f.rel, world);
                r.kept.forEach((k) => addKept(summary, k, f.rel));

                if (r.text === text)
                    continue;

                const from = copyFrom(f.source);
                addNames(summary, r.names);
                keep(f.rel, from);
                copies.push({ rel: f.rel, from, text: bomOf(vfs.read(f)) + r.text });
            }
        }
    }

    // 3. the patch mod's own files
    const files: InertFile[] = [];
    // (an earlier run's copy of a game database file: the run deletes it before this step, or the owner changed it; not rewritten either way)
    const stale = new Set(staleGameCopies(more.copies).map((rel) => rel.toLowerCase()));

    if (patchSource > 0)
    {
        for (const top of ['common', 'events'])
        {
            for (const f of vfs.list(top, { ext: /\.txt$/i }))
            {
                const lc = f.rel.toLowerCase();

                if (f.source !== patchSource || ownOutput(f.rel, f.source) || skipPatch.has(lc) || handled.has(lc) || stale.has(lc) || (patchFiles && !patchFiles.has(lc)))
                    continue;

                const text = vfs.readText(f);

                if (!text)
                    continue;

                // (the byte order mark is part of the file: the text read leaves it out)
                const raw = vfs.read(f);
                const r = inertText(text, f.rel, world);

                if (r.text !== text)
                {
                    addNames(summary, r.names);
                    files.push({ rel: f.rel, text: bomOf(raw) + r.text, ...(raw ? { raw: sha1(raw) } : {}) });
                }

                r.kept.forEach((k) => addKept(summary, k, f.rel));
            }
        }
    }

    const folders: InertFolderWork[] = [...byFolder]
        .map(([folder, entries]) => ({
            folder,
            entries: entries.sort((a, b) => (a.rel.toLowerCase() < b.rel.toLowerCase() ? -1 : a.rel.toLowerCase() > b.rel.toLowerCase() ? 1 : a.pos - b.pos)),
            after: lastFileOf(vfs.list(folder, { ext: /\.txt$/i }).filter((f) => f.rel.lastIndexOf('/') === folder.length), ownOutput)
        }))
        .sort((a, b) => (a.folder < b.folder ? -1 : 1));

    const present = recorded.filter((r) => !world.missing(r.slice(0, r.indexOf(':')) as InertKind, r.slice(r.indexOf(':') + 1)));
    return {
        folders, files: files.sort((a, b) => (a.rel < b.rel ? -1 : 1)), copies: copies.sort((a, b) => (a.rel < b.rel ? -1 : 1)), sources: [...sources].sort(), modSources: [...modSources].sort(), summary, present
    };
}

/** The last (lower case) file name among the files directly in a directory (the step's own outputs left out), else undefined. */
function lastFileOf(files: { rel: string; source: number; }[], ownOutput: (rel: string, source: number) => boolean): string | undefined
{
    let after = '';

    for (const f of files)
    {
        const name = f.rel.slice(f.rel.lastIndexOf('/') + 1).toLowerCase();

        if (!ownOutput(f.rel, f.source) && name > after)
            after = name;
    }

    return after || undefined;
}
