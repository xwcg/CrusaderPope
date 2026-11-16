/**
 * The `libraries` rule on the main side (libraries.ts finds the entries in the index worker): the files of the patch mod
 * they go into, their text, and what the plan and the result say about them. One file per folder, named to load after
 * the mod's (`zz_<patch folder>_library.txt`): a folder's entries are defined nowhere else, so the order does not matter;
 * the name only tells whose file it is (the next run leaves its own files out of what counts as loaded).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tr, trn } from '../../shared/i18n.ts';
import { eolOf, type CarriedDef } from '../indexer/override.ts';
import { readTextFile } from './textCodec.ts';
import { LIBRARY_FILE, ON_ACTION_FOLDER, type LibraryEntry, type LibraryFolderWork, type LibraryWork, type MacroDrift, type MissingEvents, type MissingOnActions, type MovedEntry } from './libraries.ts';
import type { ReindexedCategory } from './libraryChecks.ts';

/** A file of the patch mod and what it holds. */
export interface LibraryOutput
{
    /** the path in the patch mod */
    rel: string;
    text: string;
    folder: string;
    /** the entries in it (none: an older run's file that holds nothing now) */
    entries: LibraryEntry[];
    /** a file of the mod written again with other values (interaction category indexes), not a library file */
    copy?: boolean;
    /** written by the inert references step (inertRule.ts), not the libraries rule */
    inert?: boolean;
    /** a file of an older run the rule does not produce any more: deleted (the text is empty) */
    remove?: boolean;
}

const BOM = '﻿';

/** The text of a constant as it is compared: spacing aside. */
const same = (a: CarriedDef, b: CarriedDef): boolean => (a.value ?? a.text).replace(/\s+/g, '') === (b.value ?? b.text).replace(/\s+/g, '');

/** One file's text. */
function fileText(label: string, entries: LibraryEntry[], flags = false): string
{
    const consts = new Map<string, CarriedDef>();

    for (const e of entries)
        for (const c of e.constants)
            if (!consts.has(c.name))
                consts.set(c.name, c);

    // (the comment is fixed English, not tr(): the state check compares the whole text, so a change of the app's language
    // must not make every file look out of date; for that reason the header keeps the em dash earlier runs wrote, and
    // writtenByTool reads it)
    const head = `# ${label} — written by CrusaderPope\n` +
        (entries.length ?
            (flags ?
                `# The mod's own entries, written again with the flags the game added to its entries of that name and loaded files test: ${entries.length}.` :
                (entries.every((e) => e.why === 'engine') ?
                    `# The game's own definitions, as the game writes them: ${entries.length} that files of the mod hide and the engine asks for.` :
                    `# The game's own definitions, as the game writes them: ${entries.length} that files of the mod hide and loaded files still use.`)) :
            '# Nothing to carry over (any more): the game\'s definitions are defined elsewhere or no loaded file uses them.');
    const text = head + '\n\n' + (consts.size ? [...consts.values()].map((c) => c.text).join('\n') + '\n\n' : '') + entries.map((e) => e.text).join('\n\n') + (entries.length ? '\n' : '');
    // (one line ending in the file: the first entry's (the game's files are CRLF), whatever its entries and constants came with)
    return BOM + text.replace(/\r?\n/g, entries.length ? eolOf(entries[0].text) : '\n');
}

/** The file name of a folder's output: `zz_<patch folder>_library.txt`, with more `z`s while a file of the mod sorts after it. */
function fileName(patchFolder: string, after: string | undefined, i: number): string
{
    let prefix = 'zz';
    const name = (): string => `${prefix}_${patchFolder}_library${i ? `_${i + 1}` : ''}.txt`;

    while (after && name().toLowerCase() <= after)
        prefix += 'z';

    return name();
}

/**
 * The files the patch mod gets for a run's work: per folder one file, or one per game file when two of them define a
 * constant of one name differently (constants are the file's own: a copy must carry its file's). `existing`: the
 * patch mod's files of an older run (library files), which the rule does not produce any more: those still carrying the tool's
 * header are deleted (`remove`), one changed by hand has no output (`leftLibraryFiles` names it). `patchRoot`: where to read them.
 */
export function libraryOutputs(work: LibraryFolderWork[], patchFolder: string, existing: string[], patchRoot?: string): LibraryOutput[]
{
    const out: LibraryOutput[] = [];
    const done = new Set<string>();

    for (const f of work.filter((x) => x.entries.length))
    {
        const bySource = new Map<string, LibraryEntry[]>();

        for (const e of f.entries)
            bySource.set(e.rel, [...(bySource.get(e.rel) ?? []), e]);

        // (one file unless the constants of two game files clash)
        const seen = new Map<string, CarriedDef>();
        let clash = false;

        for (const e of f.entries)
        {
            for (const c of e.constants)
            {
                const prev = seen.get(c.name);

                if (prev && !same(prev, c))
                    clash = true;

                seen.set(c.name, prev ?? c);
            }
        }

        const groups = clash ? [...bySource.values()] : [f.entries];

        groups.forEach((entries, i) =>
        {
            const rel = `${f.folder}/${fileName(patchFolder, f.after, i)}`;
            out.push({ rel, text: fileText(f.folder, entries, f.flags), folder: f.folder, entries });
            done.add(rel.toLowerCase());
        });
    }

    // (the files of the mod written again: the interaction categories with their new indexes)
    for (const f of work)
    {
        for (const c of f.copies ?? [])
        {
            out.push({ rel: c.rel, text: c.text, folder: f.folder, entries: [], copy: true });
            done.add(c.rel.toLowerCase());
        }
    }

    for (const rel of existing)
        if (!done.has(rel.toLowerCase()) && writtenByTool(readPatch(patchRoot, rel)))
            out.push({ rel, text: '', folder: rel.slice(0, rel.lastIndexOf('/')), entries: [], remove: true });

    return out;
}

/** Whether a file's text is one this tool wrote: its first line is the header `fileText` and inertRule.ts write (`# <folder>`, then `written by CrusaderPope`; the stub of an older run included). The em dash between them is the one the patch mods of earlier runs have. */
export const writtenByTool = (text: string | undefined): boolean => text !== undefined && /^# [^\r\n]* — written by CrusaderPope\r?\n/.test(text.replace(/^﻿/, ''));

/** The patch mod's library files of an older run that the rule does not produce any more and that were changed by hand: they stay. */
export function leftLibraryFiles(existing: string[], outputs: LibraryOutput[], patchRoot: string | undefined): string[]
{
    const have = new Set(outputs.map((o) => o.rel.toLowerCase()));
    return existing.filter((rel) => !have.has(rel.toLowerCase()) && readPatch(patchRoot, rel) !== undefined);
}

/** The note for library files an older run wrote that were changed by hand: kept. */
export const leftLibraryNote = (rels: string[]): string =>
    trn('{n} file of definitions in the patch mod is not needed any more but was changed by hand — kept (delete it if you do not need it): {list}', '{n} files of definitions in the patch mod are not needed any more but were changed by hand — kept (delete one if you do not need it): {list}', rels.length, { list: shortList(rels, 6) });

/** The note for library files of an older run that were deleted. */
export const removedLibraryNote = (rels: string[]): string =>
    trn('{n} file of definitions an older run carried over is not needed any more (the game’s definitions are defined elsewhere, or no loaded file uses them) — deleted: {list}', '{n} files of definitions an older run carried over are not needed any more (the game’s definitions are defined elsewhere, or no loaded file uses them) — deleted: {list}', rels.length, { list: shortList(rels, 6) });

/** The patch mod's library files of an older run, in the folders given (relative paths). */
export function existingLibraryFiles(patchRoot: string | undefined, folders: string[]): string[]
{
    const out: string[] = [];

    // (the on_actions are no folder of the migration's list: the rule adds them itself)
    for (const f of patchRoot ? [...new Set([...folders, ON_ACTION_FOLDER.folder])] : [])
    {
        const dir = join(patchRoot!, ...f.split('/'));

        if (existsSync(dir))
            for (const name of readdirSync(dir))
                if (LIBRARY_FILE.test(`${f}/${name}`))
                    out.push(`${f}/${name}`);
    }

    return out;
}

/** A file of the patch mod as it is; undefined when missing. */
function readPatch(patchRoot: string | undefined, rel: string): string | undefined
{
    const file = patchRoot ? join(patchRoot, ...rel.split('/')) : undefined;
    return file && existsSync(file) ? readTextFile(file) : undefined;
}

/** The outputs the patch mod does not hold as they would be written (a second run: none). */
export const libraryTodo = (outputs: LibraryOutput[], patchRoot: string | undefined): LibraryOutput[] => outputs.filter((o) => (o.remove ? readPatch(patchRoot, o.rel) !== undefined : readPatch(patchRoot, o.rel) !== o.text));

/** Up to `n` of a list, then "…". */
const shortList = (list: string[], n: number): string => (list.length > n ? list.slice(0, n).join(', ') + ', …' : list.join(', '));

/** The plan's line for a folder's work. */
export function libraryLabel(f: LibraryFolderWork): string
{
    if (f.flags)
        return trn('{label}: {n} entry of the mod gets flags the game added to its entry of that name, that loaded files test', '{label}: {n} entries of the mod get flags the game added to their entries of that name, that loaded files test', f.entries.length, { label: f.label });

    if (f.fired)
        return trn('{label}: {n} on_action the engine fires or loaded files name, that the mod’s older files hide', '{label}: {n} on_actions the engine fires or loaded files name, that the mod’s older files hide', f.entries.length, { label: f.label });

    if (!f.entries.length)
        return trn('{label}: {n} category of the mod gets another index, because a category of the game has its own', '{label}: {n} categories of the mod get another index, because a category of the game has theirs', f.reindexed?.length ?? 0, { label: f.label });

    return trn('{label}: {n} entry the game added to files the mod replaces, that loaded files still use', '{label}: {n} entries the game added to files the mod replaces, that loaded files still use', f.entries.length, { label: f.label });
}

/** What the plan shows under a folder's entry: the names, why they are carried, what to know. */
export function libraryNotes(f: LibraryFolderWork): string[]
{
    // (flag words: per entry the words it gets; the mod’s entry is written again, in a file loading after the mod’s)
    if (f.flags)
        return f.entries.map((e) => tr('{name} ({file}) gets {list}', { name: e.name, file: e.rel, list: shortList(e.words ?? [], 12) }));

    const referenced = f.entries.filter((e) => e.why === 'referenced');
    const needed = f.entries.filter((e) => e.why === 'needed');
    const engine = f.entries.filter((e) => e.why === 'engine');
    const notes: string[] = [];

    if (f.fired)
    {
        // (the on_actions: the engine fires them by itself, and says so in its log)
        if (engine.length)
            notes.push(trn('Fired by the engine, which logs “Couldn’t find predefined on action” for each one that is missing, and the personal tenet window reads two of them without a check — it crashes the game: {n} on_action — {list}', 'Fired by the engine, which logs “Couldn’t find predefined on action” for each one that is missing, and the personal tenet window reads two of them without a check — it crashes the game: {n} on_actions — {list}', engine.length, { list: shortList(engine.map((e) => e.name), 40) }));

        if (referenced.length)
            notes.push(trn('Named by loaded files: {n} on_action — {list}', 'Named by loaded files: {n} on_actions — {list}', referenced.length, { list: shortList(referenced.map((e) => `${e.name} (${e.by})`), 12) }));

        if (needed.length)
            notes.push(trn('Fired in turn by the on_actions carried over: {n} on_action — {list}', 'Fired in turn by the on_actions carried over: {n} on_actions — {list}', needed.length, { list: shortList(needed.map((e) => e.name), 40) }));

        return notes;
    }

    if (referenced.length)
        notes.push(trn('Named by loaded files: {n} entry — {list}', 'Named by loaded files: {n} entries — {list}', referenced.length, { list: shortList(referenced.map((e) => e.name), 40) }));

    if (engine.length)
        notes.push(trn('Asked for by the engine, which logs each one that is missing: {n} entry — {list}', 'Asked for by the engine, which logs each one that is missing: {n} entries — {list}', engine.length, { list: shortList(engine.map((e) => e.name), 40) }));

    if (needed.length)
        notes.push(trn('Named in turn by the entries carried over: {n} entry — {list}', 'Named in turn by the entries carried over: {n} entries — {list}', needed.length, { list: shortList(needed.map((e) => e.name), 40) }));

    if (f.replacePath)
        notes.push(tr('The mod hides this folder with a replace_path: only the entries a loaded file of the game, the mod or the patch mod still names are carried over, the rest of the game’s folder stays out.'));

    return notes;
}

/** The note for flag words loaded files test that only an entry the mod does not have (or has written otherwise) carries. */
export function goneNote(f: LibraryFolderWork): string
{
    return trn('{label}: the game’s entries carry {n} flag that loaded files test and no loaded entry defines, and the mod has no such entry (or one built otherwise) to give it to: {list}', '{label}: the game’s entries carry {n} flags that loaded files test and no loaded entry defines, and the mod has no such entry (or one built otherwise) to give them to: {list}', f.gone!.length, { label: f.label, list: shortList(f.gone!, 12) });
}

/** The note for on_actions of a game file the mod hides that no loaded file defines and only hidden game files name (not carried). */
export function onActionNote(m: MissingOnActions): string
{
    return trn('{file}: the game defines {n} on_action there that no loaded file defines (the mod’s older copy of the file hides it), and only game files that are hidden name it, so nothing fires it now and it is not carried over — {list}', '{file}: the game defines {n} on_actions there that no loaded file defines (the mod’s older copy of the file hides them), and only game files that are hidden name them, so nothing fires them now and they are not carried over — {list}', m.names.length, { file: m.rel, list: shortList(m.names, 12) });
}

/** The note for the game's entries a folder leaves out because the loaded world lacks what they name (portrait animations). */
export function lackingNote(f: LibraryFolderWork): string
{
    const one = (l: { name: string; what: string[]; }): string => `${l.name} (${shortList(l.what, 3)})`;
    return trn('{label}: {n} entry of the game that loaded files name is left out, because the loaded files lack what it needs (the mod’s older copies of the files that define it) — {list}', '{label}: {n} entries of the game that loaded files name are left out, because the loaded files lack what they need (the mod’s older copies of the files that define it) — {list}', f.lacking!.length, { label: f.label, list: shortList(f.lacking!.map(one), 12) });
}

/** The note for interaction categories of the mod that got another index. */
export function reindexNote(m: ReindexedCategory): string
{
    return tr('{name} ({file}) had the index {from}, which the game’s {other} has: the engine keeps one of them and logs a gap behind it. It gets the index {to} in the patch mod’s copy of the file', { name: m.name, file: m.rel, from: m.from, other: m.with, to: m.to });
}

/** The note for an entry the game's new file defines over the mod's. */
export function movedNote(m: MovedEntry): string
{
    const keys = (list: string[]): string => shortList(list, 8);
    const diff = [m.modOnly.length ? tr('only the mod’s has {list}', { list: keys(m.modOnly) }) : '', m.gameOnly.length ? tr('only the game’s has {list}', { list: keys(m.gameOnly) }) : ''].filter(Boolean).join('; ');
    if (m.wins === 'mod')
        return tr('{name} ({type}) is defined in the game’s new {game} (the version moved it there) and in the mod’s {mod}, which loads after it, so the mod’s older body wins — no automatic choice{diff}', { name: m.name, type: m.type, mod: m.modFile, game: m.gameFile, diff: diff ? ` (${diff})` : '' });

    return tr('{name} ({type}) is defined in the mod’s {mod} and in the game’s new {game}, which loads after it and wins since the version moved it there — no automatic choice{diff}', { name: m.name, type: m.type, mod: m.modFile, game: m.gameFile, diff: diff ? ` (${diff})` : '' });
}

/** The note for entries a file of the mod has commented out that loaded files still name (the author took them out). */
export function disabledNote(f: LibraryFolderWork): string
{
    if (f.fired)
        return trn('{label}: {n} on_action the mod’s files have commented out (the author took it out) is left out although the engine or loaded files fire it — {list}', '{label}: {n} on_actions the mod’s files have commented out (the author took them out) are left out although the engine or loaded files fire them — {list}', f.disabled!.length, { label: f.label, list: shortList(f.disabled!.map((d) => `${d.name} (${d.by})`), 12) });

    return trn('{label}: {n} entry the mod’s files have commented out (the author took it out) is left out although other files name it — {list}', '{label}: {n} entries the mod’s files have commented out (the author took them out) are left out although other files name them — {list}', f.disabled!.length, { label: f.label, list: shortList(f.disabled!.map((d) => `${d.name} (${d.by})`), 12) });
}

/** The note for flag words the mod’s entry has commented out. */
export function declinedNote(f: LibraryFolderWork): string
{
    return trn('{label}: {n} flag the game’s entry has and loaded files test is left out because the mod’s entry has it commented out (the author took it out): {list}', '{label}: {n} flags the game’s entries have and loaded files test are left out because the mod’s entries have them commented out (the author took them out): {list}', f.declined!.length, { label: f.label, list: shortList(f.declined!, 12) });
}

/** The note for entries another loaded file defines last, which a copy with the flags would win over. */
export function redefinedNote(f: LibraryFolderWork): string
{
    return trn('{label}: {n} entry of the mod is defined again by a file that loads after it, so that definition wins and the flags the game added are not written into a copy — {list}', '{label}: {n} entries of the mod are defined again by files that load after them, so those definitions win and the flags the game added are not written into a copy — {list}', f.redefined!.length, { label: f.label, list: shortList(f.redefined!, 12) });
}

/** The notes for the game's events that a mod's older copy of an event file hides and other loaded files name (at most 8 files, the rest summed up). */
export function eventNotes(list: MissingEvents[]): string[]
{
    const note = (m: MissingEvents): string => tr('{file}: the game’s file has {total} events, the mod’s copy hides {n} that other loaded files still fire — {list}. Events are content: no automatic choice', { file: m.rel, total: m.total, n: m.ids.length, list: shortList(m.ids, 8) });
    const rest = list.slice(8);
    return [...list.slice(0, 8).map(note), ...(rest.length ? [tr('{files} more event files of the game are replaced by the mod with a copy that lacks {n} events other loaded files fire', { files: rest.length, n: rest.reduce((n, m) => n + m.ids.length, 0) })] : [])];
}

/** The note for a macro call whose arguments do not fit the winning definition. */
export function macroNote(m: MacroDrift): string
{
    const owner = m.owner === 'mod' ? tr('the mod’s') : m.owner === 'game' ? tr('the game’s') : tr('another mod’s');
    const parts = [
        m.unknown.length ? tr('callers pass {list} that it does not take', { list: shortList(m.unknown.map((x) => `${x.arg} (${x.n}, e.g. ${x.rel})`), 4) }) : '',
        m.missing.length ? tr('callers leave out {list} that it needs', { list: shortList(m.missing.map((x) => `${x.arg} (${x.n}, e.g. ${x.rel})`), 4) }) : ''
    ].filter(Boolean).join('; ');
    const takes = m.takes.length ? tr('it takes {list}', { list: m.takes.join(', ') }) : tr('it takes no arguments');
    const game = m.gameTakes ? tr('; the game’s own takes {list}', { list: m.gameTakes.join(', ') || tr('none') }) : '';
    return tr('{name} ({type}) in {owner} {file}: {parts} ({takes}{game}) — the game logs “failed for unknown/missing arguments” and the call does not run. No automatic choice', { name: m.name, type: m.type.replace('_', ' '), owner, file: m.rel, parts, takes, game });
}

/** All the notes of a library work, for the plan and the result. */
export function workNotes(work: LibraryWork): string[]
{
    return [
        ...work.moved.map(movedNote),
        ...work.onActions.map(onActionNote),
        ...work.folders.filter((f) => f.lacking?.length).map(lackingNote),
        ...work.folders.flatMap((f) => f.reindexed ?? []).map(reindexNote),
        ...work.folders.filter((f) => f.gone?.length).map(goneNote),
        ...work.folders.filter((f) => f.declined?.length).map(declinedNote),
        ...work.folders.filter((f) => f.redefined?.length).map(redefinedNote),
        ...work.folders.filter((f) => f.disabled?.length).map(disabledNote),
        ...eventNotes(work.events ?? []),
        ...(work.macros ?? []).slice(0, 12).map(macroNote),
        ...((work.macros?.length ?? 0) > 12 ? [tr('{n} more macro calls do not fit their definitions', { n: work.macros.length - 12 })] : [])
    ];
}
