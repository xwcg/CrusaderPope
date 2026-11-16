/**
 * The life of a fixes patch mod (docs/mods.md, "Migrating a mod to a newer game version", "The manifest"): what its manifest
 * records beyond the game files it carries, and what a run does with it.
 *
 * - `files`: every file the last run left in the patch mod (path → sha1). A file that still has its hash is the run's own;
 *   one that differs was changed by hand.
 * - `sources`: for each file made from one of the mod's files (the copy that is fixed, an emptied file …) the mod's path, its
 *   hash and its stat when it was taken. When the mod changes one of them, or drops it (the mod was updated), the copies
 *   shadow the update, and a run would report everything done: so the files the last run left are deleted and the
 *   migration builds them again from the mod as it is now (`modChanges`). A file changed by hand stays.
 * - what no rule names any more (a restored game file the mod stopped overriding, a merge or defines file whose rule has no
 *   hits) is deleted when it is still as the run wrote it (`orphanedRecords`).
 *
 * Not in this file: the writing (migrate.ts), the rules, the game's files (restore records keep their own logic).
 */
import { existsSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModInfo } from '../../shared/api.ts';
import { olderThanGame } from '../../shared/modRules.ts';
import { MANIFEST_FILE, readManifest, sha1, type FixesManifest, type SourceRecord } from './fixesManifest.ts';
import { ZipArchive } from './zip.ts';
import { forgetText } from './keptTexts.ts';

const lc = (s: string): string => s.toLowerCase();

/** A patch mod from before the records: a file this much (ms) newer than its manifest was touched after the last run. */
const LEGACY_SLACK = 2000;

/** The modified time of a file (ms), undefined when it cannot be read. */
export function mtimeOf(file: string): number | undefined
{
    try
    {
        return statSync(file).mtimeMs;
    }
    catch
    {
        return undefined;
    }
}

export type ModFiles = Map<string, { file?: string; entry?: string; }>;

/** The files at the top of a patch mod that are not part of its content. */
const OUTSIDE = new Set(['descriptor.mod', 'thumbnail.png', lc(MANIFEST_FILE)]);

/** A patch mod's files as paths below its folder (forward slashes), without the descriptor, thumbnail, manifest and half-written leftovers. */
export function patchFiles(root: string): string[]
{
    const out: string[] = [];

    if (!existsSync(root))
        return out;

    const walk = (dir: string, rel: string): void =>
    {
        for (const e of readdirSync(dir, { withFileTypes: true }))
        {
            const r = rel ? `${rel}/${e.name}` : e.name;

            if (e.isDirectory())
                walk(join(dir, e.name), r);
            else if (e.isFile() && !(rel === '' && OUTSIDE.has(lc(e.name))) && !/\.crusaderpope-tmp$/i.test(e.name))
                out.push(r);
        }
    };

    walk(root, '');
    return out;
}

/** The hashes of files of a patch mod (a file that cannot be read is left out). */
export function hashFiles(root: string, rels: string[]): Map<string, string>
{
    const out = new Map<string, string>();

    for (const rel of rels)
    {
        try
        {
            out.set(rel, sha1(readFileSync(join(root, ...rel.split('/')))));
        }
        catch
        {
            // (gone or locked: not recorded)
        }
    }

    return out;
}

/**
 * The script files of a patch mod (`common`, `events`; lower case paths) that a run may rewrite in place: the ones it made or
 * left as it recorded them. A file the owner changed since (its hash is not the record's) or put there by hand (no record, and it
 * was there before the run) is theirs. A file that was not there at the start of the run is the run's, recorded or not: the reset
 * after a mod update deleted the last run's file (or the owner deleted it) and this run made it again, as `recordLife` records it.
 * Undefined: a patch mod from before the records, where every file counts as the run's.
 * @param before the hashes of the files at the start of the run (a plan: none, the files as they are)
 */
export function ownedFiles(patchRoot: string, manifest: FixesManifest | undefined, before?: Map<string, string>): string[] | undefined
{
    if (!manifest?.files)
        return undefined;

    const out: string[] = [];
    const rels = patchFiles(patchRoot).filter((rel) => /^(common|events)\//i.test(rel) && /\.txt$/i.test(rel));
    const now = before ?? hashFiles(patchRoot, rels);

    for (const rel of rels)
    {
        const had = now.get(rel);

        // (a recorded file missing at the start counted as the owner's before: after a reset every file the run made again was left
        // out of the in-place rewrites, and only the plan after the run, with the new records, found them to do)
        if (had === undefined || had === manifest.files[rel])
            out.push(lc(rel));
    }

    return out;
}

/** Size and modified time of a mod's file (of the zip, for a packed mod): the same = the same file, without reading it. */
export function stampOf(mod: ModInfo, where: { file?: string; entry?: string; }): string | undefined
{
    try
    {
        const st = statSync(where.file ?? mod.archive!);
        return `${st.size}:${Math.floor(st.mtimeMs)}`;
    }
    catch
    {
        return undefined;
    }
}

/** Reads the hashes of a mod's files; a packed mod's zip is opened once. */
export class SourceReader
{
    private zip: ZipArchive | undefined;
    private readonly mod: ModInfo;

    constructor(mod: ModInfo)
    {
        this.mod = mod;
    }

    hash(where: { file?: string; entry?: string; }): string | undefined
    {
        try
        {
            if (where.file)
                return sha1(readFileSync(where.file));

            if (where.entry && this.mod.archive)
            {
                this.zip ??= new ZipArchive(this.mod.archive);
                const data = this.zip.readEntry(where.entry);
                return data ? sha1(data) : undefined;
            }
        }
        catch
        {
            // (unreadable: reads as changed)
        }

        return undefined;
    }

    close(): void
    {
        this.zip?.close();
        this.zip = undefined;
    }
}

const lowerIndex = (modFiles: ModFiles): Map<string, string> => new Map([...modFiles.keys()].map((k) => [lc(k), k]));

/** What the mod changed since the patch mod took its copies, and what a run does about it. */
export interface PatchChanges
{
    /** the patch mod's files made from a file of the mod that the mod changed or dropped since (path in the patch mod) */
    stale: { rel: string; from: string; why: 'changed' | 'gone' | 'newer'; }[];
    /** the files a run deletes to build them again from the mod as it is: all that the last run left and nobody changed */
    reset: string[];
    /** files of the patch mod changed by hand since the run left them: they stay, a stale one is told */
    edited: string[];
    /** of those, the ones made from a file the mod changed since (the update does not reach them) */
    keptStale: string[];
    /** no record of the patch mod's files (made before it): the mod's files newer than the copies stand for a change */
    legacy: boolean;
}

/**
 * The mod against the patch mod's records. `outside`: the paths (lower case) the patch mod holds as the game's, which have
 * their own records (restored, merged). Nothing is stale when the mod is as it was when the copies were taken.
 */
export function modChanges(mod: ModInfo, modFiles: ModFiles, patchRoot: string | undefined, manifest: FixesManifest | undefined, outside: Set<string>): PatchChanges
{
    const none: PatchChanges = { stale: [], reset: [], edited: [], keptStale: [], legacy: false };

    // (no manifest at all: nothing proves the tool made the folder, it is not the tool's to delete from; a run writes the records)
    if (!patchRoot || !existsSync(patchRoot) || !manifest)
        return none;

    const byLower = lowerIndex(modFiles);
    const rels = patchFiles(patchRoot).filter((rel) => !outside.has(lc(rel)));
    const reader = new SourceReader(mod);
    let stale: PatchChanges['stale'] = [];
    const legacy = !manifest?.sources || !manifest.files;

    try
    {
        if (!legacy)
        {
            const present = new Set(rels.map(lc));

            for (const [rel, rec] of Object.entries(manifest!.sources!))
            {
                // (a copy deleted since: nothing shadows)
                if (!present.has(lc(rel)))
                    continue;

                // (a copy carried to another path (a banner texture from the old folder), and the mod now ships a file at the
                // copy's own path: that one is the mod's, the copy shadows it)
                if (lc(rec.from) !== lc(rel) && byLower.has(lc(rel)))
                {
                    stale.push({ rel, from: byLower.get(lc(rel))!, why: 'changed' });
                    continue;
                }

                const key = byLower.get(lc(rec.from));
                const where = key ? modFiles.get(key) : undefined;

                if (!where)
                {
                    stale.push({ rel, from: rec.from, why: 'gone' });
                    continue;
                }

                if (rec.stamp && stampOf(mod, where) === rec.stamp)
                    continue;

                if (reader.hash(where) !== rec.src)
                    stale.push({ rel, from: rec.from, why: 'changed' });
            }
        }
        else
        {
            // (a patch mod from before the records: a mod file modified after the copy was last written is certainly not what the
            // copy was made from; the rules write the copy after taking it)
            for (const rel of rels)
            {
                const key = byLower.get(lc(rel));
                const where = key ? modFiles.get(key) : undefined;

                if (!where)
                    continue;

                try
                {
                    const theirs = statSync(where.file ?? mod.archive!).mtimeMs;
                    const ours = statSync(join(patchRoot, ...rel.split('/'))).mtimeMs;

                    if (theirs > ours + 2000)
                        stale.push({ rel, from: key!, why: 'newer' });
                }
                catch
                {
                    // (unreadable: not told)
                }
            }
        }
    }
    finally
    {
        reader.close();
    }

    if (!stale.length)
        return { ...none, legacy };

    // (what the last run left, as it is now: the run's own files go, the ones changed by hand stay)
    const edited: string[] = [];
    const reset: string[] = [];

    if (manifest?.files)
    {
        const now = hashFiles(patchRoot, Object.keys(manifest.files).filter((rel) => !outside.has(lc(rel))));

        for (const [rel, recorded] of Object.entries(manifest.files))
        {
            const have = now.get(rel);

            if (have === undefined)
                continue;

            (have === recorded ? reset : edited).push(rel);
        }
    }
    else
    {
        // (no record of what the run left: a file touched after the last run wrote its manifest was changed or made by hand,
        // and stays; the files from before that are taken as the run's)
        const since = mtimeOf(join(patchRoot, MANIFEST_FILE));

        for (const rel of rels)
        {
            const at = mtimeOf(join(patchRoot, ...rel.split('/')));
            (since !== undefined && at !== undefined && at > since + LEGACY_SLACK ? edited : reset).push(rel);
        }
    }

    // (a copy changed by hand is the owner's: the mod's update does not count against it, or every run would start over)
    const keptStale = stale.filter((s) => edited.includes(s.rel)).map((s) => s.rel);
    stale = stale.filter((s) => !keptStale.includes(s.rel));

    return stale.length ? { stale, reset, edited, keptStale, legacy } : { ...none, edited, keptStale, legacy };
}

/** The records of files that no rule names any more, and what to do with each. */
export interface OrphanedRecords
{
    /** files still as the run wrote them: deleted */
    remove: string[];
    /** files changed by hand: kept (and told) */
    edited: string[];
    /** records whose file is gone already: dropped */
    forget: string[];
}

/**
 * The patch mod's restored and merged game files that no restore or merge rule names (`claimed`, lower case: the mod stopped
 * overriding the game's file, or the game dropped it) and its generated files that no rule writes (`named`): the stale
 * copy would shadow the game's file for ever, a defines file would override the mod's updated values. `dropped`: more files a run
 * wrote that no rule makes any more (the inert step's whole-file copies of game database files: inertWork.ts `staleGameCopies`),
 * judged like the generated ones by the hash the manifest keeps of each file the run left.
 */
export function orphanedRecords(manifest: FixesManifest, patchRoot: string, claimed: Set<string>, named: Set<string>, dropped: string[] = []): OrphanedRecords
{
    const out: OrphanedRecords = { remove: [], edited: [], forget: [] };
    const hashOf = (rel: string): string | undefined =>
    {
        const file = join(patchRoot, ...rel.split('/'));
        return existsSync(file) ? sha1(readFileSync(file)) : undefined;
    };

    for (const rel of new Set([...Object.keys(manifest.restored), ...Object.keys(manifest.merged)]))
    {
        if (claimed.has(lc(rel)))
            continue;

        const have = hashOf(rel);
        const wrote = manifest.merged[rel]?.out ?? manifest.restored[rel];

        (have === undefined ? out.forget : have === wrote ? out.remove : out.edited).push(rel);
    }

    for (const rel of [...new Set([...(manifest.generated ?? []), ...dropped])])
    {
        if (named.has(lc(rel)))
            continue;

        const have = hashOf(rel);
        const wrote = manifest.files?.[rel];

        (have === undefined ? out.forget : have === wrote ? out.remove : out.edited).push(rel);
    }

    return out;
}

/**
 * Deletes files of a patch mod, and the folders that were left empty (up to the mod's own). `wrote`: the folder watcher told
 * of them first, all at once (ModsHost.wrote; the folders go with their files).
 */
export function deleteFiles(patchRoot: string, rels: string[], wrote?: (files: string[]) => void): void
{
    if (rels.length)
        wrote?.(rels.map((rel) => join(patchRoot, ...rel.split('/'))));

    for (const rel of rels)
    {
        const file = join(patchRoot, ...rel.split('/'));
        forgetText(file);

        try
        {
            unlinkSync(file);
        }
        catch
        {
            continue;
        }

        for (let dir = dirname(file); dir.length > patchRoot.length; dir = dirname(dir))
        {
            try
            {
                rmdirSync(dir);
            }
            catch
            {
                break;
            }
        }
    }
}

/**
 * Records what a run left: every file but the restored and merged ones (their records are their own) with its hash, and the
 * mod's file each was made from. A file the run did not write (the same bytes as at its start: `before`) keeps the record it
 * had, so a hand-edited copy stays recognised as one, and a source that changed stays changed until it is rebuilt. A file
 * the run rewrote although it was changed by hand before (a rule edits the owner's copy) keeps its old records too: it is the
 * owner's still.
 *
 * Only the run's own files are recorded, because a reset deletes the recorded ones: a file nobody recorded and the run did
 * not write (put there by hand, or left by a run killed before its manifest) is left out. The one exception is a patch mod
 * from before the records (`manifest.files` unset): it is taken whole, except what was touched after its last run
 * (`since`: its manifest's time).
 *
 * `carried`: the copies a rule made at another path than their source (a banner texture from the old folder), with the mod's
 * file each was taken from.
 */
export function recordLife(c: { manifest: FixesManifest; mod: ModInfo; modFiles: ModFiles; patchRoot: string; before: Map<string, string>; carried?: ModFiles; since?: number; }): void
{
    const { manifest, patchRoot } = c;
    const records = manifest.files !== undefined;
    const outside = new Set([...Object.keys(manifest.restored), ...Object.keys(manifest.merged)].map(lc));
    const rels = patchFiles(patchRoot).filter((rel) => !outside.has(lc(rel)));
    const after = hashFiles(patchRoot, rels);
    const byLower = lowerIndex(c.modFiles);
    const files: Record<string, string> = {};
    const sources: Record<string, SourceRecord> = {};
    const reader = new SourceReader(c.mod);

    try
    {
        for (const rel of rels)
        {
            const now = after.get(rel);

            if (now === undefined)
                continue;

            const wrote = c.before.get(rel) !== now;
            const prev = manifest.files?.[rel];

            if (!wrote && prev === undefined)
            {
                const at = mtimeOf(join(patchRoot, ...rel.split('/')));

                if (records || (c.since !== undefined && at !== undefined && at > c.since + LEGACY_SLACK))
                    continue;
            }

            // (recorded, and not as the last run left it: the owner changed it, and a rule's rewrite does not make it the run's)
            const theirs = prev !== undefined && c.before.has(rel) && c.before.get(rel) !== prev;
            files[rel] = theirs ? prev : wrote || prev === undefined ? now : prev;

            const key = byLower.get(lc(rel));
            const carried = c.carried?.get(rel);
            const where = (key ? c.modFiles.get(key) : undefined) ?? carried;
            const had = manifest.sources?.[rel];

            if (!where)
            {
                // (a copy carried to another path keeps its record: the mod dropping its source is seen, also when this run only
                // rewrote it in place, as the texture rule does to the plain header, and did not carry it again)
                if (had && lc(had.from) !== lc(rel) && (!wrote || c.before.has(rel)))
                    sources[rel] = had;

                continue;
            }

            if ((!wrote || theirs) && had)
            {
                sources[rel] = had;
                continue;
            }

            const from = carried && !(key && c.modFiles.get(key)) ? [...c.modFiles].find(([, v]) => v.file === carried.file && v.entry === carried.entry)?.[0] : key;
            const src = reader.hash(where);

            if (src && from)
                sources[rel] = { from, src, ...(stampOf(c.mod, where) ? { stamp: stampOf(c.mod, where) } : {}) };
        }
    }
    finally
    {
        reader.close();
    }

    manifest.files = files;
    manifest.sources = sources;
}

// (the patch mod of a mod, as the Mods view tells it)
const baseCache = new Map<string, { mtime: number; base: { id: string; name: string; } | undefined; }>();

/**
 * For a mod that is a fixes patch mod (its manifest names the mod it was made for): that mod, and whether the patch mod has
 * become needless: the mod now says it supports the game's version, so its own files are for it and the patch mod's copies
 * on top of them are old. Undefined for any other mod.
 */
export function patchFor(mod: ModInfo, mods: ModInfo[], game: string | undefined): { id: string; name: string; obsolete: boolean; } | undefined
{
    if (!mod.root)
        return undefined;

    const file = join(mod.root, MANIFEST_FILE);

    let mtime: number;

    try
    {
        mtime = statSync(file).mtimeMs;
    }
    catch
    {
        return undefined;
    }

    let hit = baseCache.get(file);

    if (!hit || hit.mtime !== mtime)
    {
        hit = { mtime, base: readManifest(mod.root)?.base };
        baseCache.set(file, hit);
    }

    if (!hit.base)
        return undefined;

    const base = mods.find((m) => lc(m.id) === lc(hit.base!.id));
    return { id: hit.base.id, name: base?.name ?? hit.base.name, obsolete: !!base && base.status === 'ok' && !!base.supportedVersion && !!game && !olderThanGame(base.supportedVersion, game) };
}
