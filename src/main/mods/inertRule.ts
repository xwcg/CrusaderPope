/**
 * The inert references step on the main side (inertWork.ts finds the work in the index worker, inert.ts rewrites): the files of
 * the patch mod, what the plan and the result say about them. One file per directory of the winning definitions (`zz_<patch folder>_inert.txt`,
 * loading after the directory's other files, so after the winner), the patch mod's own files rewritten in place, and whole-file copies of the files of the game and of
 * the mod (events, on_actions) at their own paths.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tr, trn } from '../../shared/i18n.ts';
import { eolOf, type CarriedDef } from '../indexer/override.ts';
import { INERT_FILE, sourceKey, type InertEntry, type InertFolderWork, type InertWork } from './inertWork.ts';
import { sha1 } from './fixesManifest.ts';
import { patchFiles, SourceReader, type ModFiles } from './patchLife.ts';
import type { ModInfo } from '../../shared/api.ts';
import { writtenByTool, type LibraryOutput } from './libraryRule.ts';
import { readTextFile } from './textCodec.ts';

/** A file of the patch mod as text; undefined when missing. */
const readPatchFile = (patchRoot: string | undefined, rel: string): string | undefined =>
{
    const file = patchRoot ? join(patchRoot, ...rel.split('/')) : undefined;
    return file && existsSync(file) ? readTextFile(file) : undefined;
};

const BOM = '﻿';

/** The text of a constant as it is compared: spacing aside. */
const same = (a: CarriedDef, b: CarriedDef): boolean => (a.value ?? a.text).replace(/\s+/g, '') === (b.value ?? b.text).replace(/\s+/g, '');

/** The file name of a folder's output: `zz_<patch folder>_inert.txt`, with more `z`s while a file of the mod sorts after it. */
function fileName(patchFolder: string, after: string | undefined, i: number): string
{
    let prefix = 'zz';
    const name = (): string => `${prefix}_${patchFolder}_inert${i ? `_${i + 1}` : ''}.txt`;

    while (after && name().toLowerCase() <= after)
        prefix += 'z';

    return name();
}

/** One file's text (the comment is fixed English, not tr(): the state check compares the whole text; the header keeps the em dash earlier runs wrote, which libraryRule.ts writtenByTool reads). */
function fileText(folder: string, entries: InertEntry[]): string
{
    const consts = new Map<string, CarriedDef>();

    for (const e of entries)
        for (const c of e.constants)
            if (!consts.has(c.name))
                consts.set(c.name, c);

    const head = `# ${folder} — written by CrusaderPope\n` +
        (entries.length ?
            `# The definitions of the game and of the mod, as they write them, with the statements made harmless that name entries this playset does not have: ${entries.length}.` :
            '# Nothing to write (any more): no definition of the game or the mod names an entry this playset lacks.');
    const text = head + '\n\n' + (consts.size ? [...consts.values()].map((c) => c.text).join('\n') + '\n\n' : '') + entries.map((e) => e.text).join('\n\n') + (entries.length ? '\n' : '');
    return BOM + text.replace(/\r?\n/g, entries.length ? eolOf(entries[0].text) : '\n');
}

/**
 * The files the patch mod gets for the step's work: per folder one file (or one per game file when two of them define a constant
 * of one name differently: constants are the file's own), and the patch mod's own files rewritten. `existing`: the inert files of
 * an older run, which a folder without work now gets emptied.
 */
export function inertOutputs(work: InertWork, patchFolder: string, existing: string[], patchRoot?: string): LibraryOutput[]
{
    const out: LibraryOutput[] = [];
    const done = new Set<string>();

    for (const f of work.folders.filter((x) => x.entries.length))
    {
        const bySource = new Map<string, InertEntry[]>();

        for (const e of f.entries)
            bySource.set(e.rel, [...(bySource.get(e.rel) ?? []), e]);

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

        (clash ? [...bySource.values()] : [f.entries]).forEach((entries, i) =>
        {
            const rel = `${f.folder}/${fileName(patchFolder, f.after, i)}`;
            out.push({ rel, text: fileText(f.folder, entries), folder: f.folder, entries: [], copy: true, inert: true });
            done.add(rel.toLowerCase());
        });
    }

    for (const f of work.files)
    {
        out.push({ rel: f.rel, text: f.text, folder: f.rel.slice(0, f.rel.lastIndexOf('/')), entries: [], copy: true, inert: true });
        done.add(f.rel.toLowerCase());
    }

    // (the copies that are there and need nothing have no text: nothing is written)
    for (const c of work.copies)
    {
        if (c.text !== undefined && !done.has(c.rel.toLowerCase()))
        {
            out.push({ rel: c.rel, text: c.text, folder: c.rel.slice(0, c.rel.lastIndexOf('/')), entries: [], copy: true, inert: true });
            done.add(c.rel.toLowerCase());
        }
    }

    // (an inert file of an older run that has nothing to hold now (its entries moved to another directory, or the world has them) is deleted; one changed by hand stays)
    for (const rel of existing)
        if (!done.has(rel.toLowerCase()) && writtenByTool(readPatchFile(patchRoot, rel)))
            out.push({ rel, text: '', folder: rel.slice(0, rel.lastIndexOf('/')), entries: [], copy: true, inert: true, remove: true });

    return out;
}

/** The patch mod's inert files of an older run (relative paths). */
export function existingInertFiles(patchRoot: string | undefined): string[]
{
    return patchRoot && existsSync(patchRoot) ? patchFiles(patchRoot).filter((rel) => INERT_FILE.test(rel)) : [];
}

/** Up to `n` of a list, then "…". */
const shortList = (list: string[], n: number): string => (list.length > n ? list.slice(0, n).join(', ') + ', …' : list.join(', '));

/** The plan's line for a folder's override file. */
export function inertLabel(f: InertFolderWork): string
{
    return trn('{folder}: {n} definition of the game or the mod names entries this playset does not have — its statements are made false', '{folder}: {n} definitions of the game or the mod name entries this playset does not have — their statements are made false', f.entries.length, { folder: f.folder });
}

/** The plan's line for the patch mod's own files. */
export function inertFilesLabel(n: number): string
{
    return trn('{n} file of the patch mod names entries this playset does not have — its statements are made false', '{n} files of the patch mod name entries this playset does not have — their statements are made false', n);
}

/** The plan's line for the whole-file copies of the game's and the mod's events and on_actions. */
export function inertCopiesLabel(n: number): string
{
    return trn('{n} file of the game or the mod (events, on_actions) names entries this playset does not have — a copy in the patch mod has its statements made false', '{n} files of the game or the mod (events, on_actions) name entries this playset does not have — copies in the patch mod have their statements made false', n);
}

/** Why the kinds are called what they are (plan notes). */
const KIND_NAMES: Record<string, () => string> = {
    religion: () => tr('religions'), faith: () => tr('faiths'), rite: () => tr('rites'), culture: () => tr('cultures'), doctrine: () => tr('doctrines'),
    title: () => tr('titles'), trait: () => tr('traits'), law: () => tr('laws'), pillar: () => tr('cultural pillars and languages'), innovation: () => tr('innovations'),
    family: () => tr('religion families'), maa: () => tr('men-at-arms types'), artifact: () => tr('artifact templates'), struggle: () => tr('struggles'),
    rule: () => tr('game rule options'), modifier: () => tr('static modifiers'), event: () => tr('events'), region: () => tr('geographical regions'),
    doctrine_param: () => tr('doctrine parameters'), culture_param: () => tr('cultural parameters'),
    perk: () => tr('lifestyle perks'), accolade: () => tr('accolade types'), tradition: () => tr('cultural traditions'), poi: () => tr('points of interest'), inspiration: () => tr('inspiration types'), cb: () => tr('casus belli types'), holy_site: () => tr('holy sites'),
    scripted_trigger: () => tr('scripted triggers the mod took out'), scripted_effect: () => tr('scripted effects the mod took out'), script_value: () => tr('script values the mod took out'),
    modifier_type: () => tr('modifier types the engine makes for content (a trait’s experience gain, a culture’s opinion …)'),
    government_flag: () => tr('government flags'), law_flag: () => tr('law flags'), legitimacy_flag: () => tr('legitimacy flags'), trait_flag: () => tr('trait flags'),
    building_flag: () => tr('building flags'), contract_flag: () => tr('subject contract flags')
};

/** The notes the step adds to the plan and the result. */
export function inertNotes(work: InertWork): string[]
{
    const notes: string[] = [];
    const kinds = Object.entries(work.summary.names).filter(([, names]) => names.length).sort(([a], [b]) => (a < b ? -1 : 1));

    for (const [kind, names] of kinds)
        notes.push(trn('Statements about {kind} that this playset does not have are made false: {n} name — {list}', 'Statements about {kind} that this playset does not have are made false: {n} names — {list}', names.length, { kind: (KIND_NAMES[kind] ?? (() => kind))(), list: shortList(names, 12) }));

    const kept = work.summary.kept;
    const why: Record<string, () => string> = {
        scope: () => tr('a block that saves a scope the rest of the entry may use'),
        variable: () => tr('an effect block that sets a variable or a list'),
        macro: () => tr('a block that holds the only use of a macro argument ($NAME$): the callers pass it, and the game fails a call with an argument the definition does not take'),
        context: () => tr('a statement that is no known test or effect (a variable, an argument of an effect)'),
        value: () => tr('a script value the mod took out: it is a number, no rewrite can make one up')
    };

    for (const [reason, k] of Object.entries(kept).sort(([a], [b]) => (a < b ? -1 : 1)))
        notes.push(trn('Left as it is although it names an entry this playset does not have: {n} statement, {why} — {list}', 'Left as they are although they name entries this playset does not have: {n} statements, {why} — {list}', k.n, { why: (why[reason] ?? (() => reason))(), list: shortList(k.examples, 4) }));

    if (work.present.length)
        notes.push(trn('{n} name an earlier run treated as missing exists now: the patch mod’s copies stay as that run wrote them (delete one to take the mod’s file again) — {list}', '{n} names an earlier run treated as missing exist now: the patch mod’s copies stay as that run wrote them (delete one to take the mod’s file again) — {list}', work.present.length, { list: shortList(work.present, 8) }));

    return notes;
}

/** The record the manifest keeps (`FixesManifest.inert`). */
export interface InertRecord
{
    /** the files the overrides and copies come from, with their hashes: the game's by their path, the migrated mod's with `mod:` in front */
    sources: Record<string, string>;
    names: string[];
    /** the whole-file copies of the game's and the mod's files */
    copies?: string[];
    /** files of the patch mod rewritten in place: the hash they had before (a rule that writes a file by its text compares with it) */
    raw?: Record<string, string>;
}

/**
 * The record the manifest keeps: the hashes of the files the overrides and copies come from (a game or mod update that changes one
 * leaves the patch mod masking the new text), the names treated as missing, the copies, and the files rewritten in place.
 * @param modFile the hash of a file of the migrated mod
 * @param previous the record of the run before: the files it rewrote in place and this run did not touch keep their entry while `exists`
 */
export function inertRecord(work: InertWork, gameFile: (rel: string) => string | undefined, recorded: string[] = [], modFile?: (rel: string) => string | undefined, previous?: InertRecord, exists?: (rel: string) => boolean): InertRecord | undefined
{
    const sources: Record<string, string> = {};

    for (const rel of work.sources)
    {
        const file = gameFile(rel);

        if (file)
            sources[sourceKey(rel, 'game')] = sha1(readFileSync(file));
    }

    for (const rel of work.modSources)
    {
        const hash = modFile?.(rel);

        if (hash)
            sources[sourceKey(rel, 'mod')] = hash;
    }

    // (the names of the last runs stay: a copy of the patch mod rewritten in place no longer names them, a second run must record the same; the ones that exist now go)
    const names = [...new Set([...recorded, ...Object.entries(work.summary.names).flatMap(([kind, list]) => list.map((n) => `${kind}:${n}`))])].filter((n) => !work.present.includes(n)).sort();
    const copies = work.copies.map((c) => c.rel).sort();
    const raw: Record<string, string> = {};

    for (const [rel, hash] of Object.entries(previous?.raw ?? {}))
        if (!exists || exists(rel))
            raw[rel] = hash;

    for (const f of work.files)
        if (f.raw)
            raw[f.rel] = f.raw;

    return names.length || Object.keys(sources).length || copies.length || Object.keys(raw).length ?
        { sources, names, ...(copies.length ? { copies } : {}), ...(Object.keys(raw).length ? { raw } : {}) } :
        undefined;
}

/** The hash of a file of the migrated mod by its path (case aside); `close` when done (a packed mod's zip is opened once). */
export function modFileHash(mod: ModInfo, modFiles: ModFiles): { hash: (rel: string) => string | undefined; close: () => void; }
{
    const reader = new SourceReader(mod);
    const lower = new Map([...modFiles.keys()].map((k) => [k.toLowerCase(), k]));

    return {
        hash: (rel) =>
        {
            const key = lower.get(rel.toLowerCase());
            const where = key ? modFiles.get(key) : undefined;
            return where ? reader.hash(where) : undefined;
        },
        close: () => reader.close()
    };
}

/** The files a game update changed since the record was made (the overrides made from them are out of date). */
export function inertChanged(record: { sources: Record<string, string>; } | undefined, gameFile: (rel: string) => string | undefined, modFile?: (rel: string) => string | undefined): string[]
{
    return Object.entries(record?.sources ?? {}).filter(([key, hash]) =>
    {
        if (key.startsWith('mod:'))
            return !!modFile && modFile(key.slice(4)) !== hash;

        const file = gameFile(key);
        return !file || sha1(readFileSync(file)) !== hash;
    }).map(([key]) => key);
}
