/**
 * What a fixes patch mod ("Fix for 1.20…", migrate.ts) records about itself, in a dot file at its root (the game
 * ignores it; a merge leaves dot files out, packing keeps this one): the game version the last run was made for, and for each game
 * file it carries (the `restore` rule) the hash of the copy it wrote. A run after a game update can then tell a copy
 * that is the old game's file (refresh it) from one changed by hand (keep it). A shader file merged with the mod's own
 * effects (the `mergefx` rule) has a record of its own: the hash of the game's file and of the mod's files it was made
 * from, and of what was written. The rest of the patch mod is described too (`files`, `sources`, `generated`, `hidden`,
 * `base`: patchLife.ts), so a run can tell that the mod was updated since a copy was taken, and what no rule asks for any more.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST_FILE = '.crusaderpope-fixes.json';

/** A game file merged with the mod's effects: what it was made from and what was written. */
export interface MergedRecord
{
    /** sha1 of the game's file */
    game: string;
    /** sha1 over the mod's effect files (path and hash) */
    mod: string;
    /** sha1 of the copy as it was written */
    out: string;
}

export interface FixesManifest
{
    /** the game version of the last run (launcher-settings rawVersion) */
    game?: string;
    /** the restored game files: path → sha1 of the copy as it was written */
    restored: Record<string, string>;
    /** the game's shader files merged with the mod's effects: path → record */
    merged: Record<string, MergedRecord>;
    /**
     * the definitions the mod changed in a shader file that stay the game's (the merge keeps the game's), by path, all of
     * them: the notes of a run show them once, this is what is left to look at when the owner bisects a broken file
     */
    lost: Record<string, string[]>;
    /** the game's interface files the owner chose to take whole (the dialog's optional restores): they stay restored in later runs */
    optional?: string[];
    /**
     * every other file the last run left in the patch mod (not the restored and merged ones, the descriptor, the thumbnail):
     * path → sha1 as the run left it. A file that still has it is the run's own and can be deleted when the mod changed
     * (patchLife.ts); one that differs was changed by hand and stays.
     */
    files?: Record<string, string>;
    /** the patch mod's files made from a file of the mod: path → which file, and what that file was when it was copied */
    sources?: Record<string, SourceRecord>;
    /** the files of the generated kinds the rules write by name (merges, defines) that the last run left: when no rule names one any more it goes */
    generated?: string[];
    /** the folders the patch mod's descriptor hides because the mod replaces what they belong to: dropped when the mod stops replacing it */
    hidden?: string[];
    /** the mod the patch mod was made for (the Mods view tells when the mod catches up with the game and the patch mod is not needed) */
    base?: { id: string; name: string; };
    /**
     * the inert references step (inert.ts): the files its overrides and copies were made from (the game's by path → sha1 of the game's
     * file, the migrated mod's with `mod:` in front: an update that changes one leaves the patch mod masking the new text), the
     * `kind:name` of the entries it treated as missing, the whole-file copies of the game's and the mod's files it made (events,
     * on_actions), and for the files of the patch mod it rewrote in place the sha1 they had before (`raw`: a rule that writes a file
     * by its text, the merge, sees the rewritten file as its own)
     */
    inert?: { sources: Record<string, string>; names: string[]; copies?: string[]; raw?: Record<string, string>; };
}

/** A copy in the patch mod of a mod's file (or a file made from it): the mod's path, its hash and its stat when taken. */
export interface SourceRecord
{
    from: string;
    /** sha1 of the mod's file */
    src: string;
    /** size and modified time of the mod's file (of its zip for a packed mod): equal = unchanged, without reading it */
    stamp?: string;
}

export const sha1 = (data: Buffer): string => createHash('sha1').update(data).digest('hex');

const sortedEntries = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** The manifest of a patch mod; undefined when it has none (made before it existed) or it cannot be read. */
export function readManifest(patchRoot: string | undefined): FixesManifest | undefined
{
    const file = patchRoot ? join(patchRoot, MANIFEST_FILE) : undefined;

    if (!file || !existsSync(file))
        return undefined;

    try
    {
        const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<FixesManifest>;
        const merged: Record<string, MergedRecord> = {};

        for (const [rel, r] of Object.entries(j.merged && typeof j.merged === 'object' ? j.merged : {}))
            if (r && typeof r.game === 'string' && typeof r.mod === 'string' && typeof r.out === 'string')
                merged[rel] = { game: r.game, mod: r.mod, out: r.out };

        const lost: Record<string, string[]> = {};

        for (const [rel, names] of Object.entries(j.lost && typeof j.lost === 'object' ? j.lost : {}))
            if (Array.isArray(names))
                lost[rel] = names.filter((x) => typeof x === 'string');

        const optional = Array.isArray(j.optional) ? j.optional.filter((x) => typeof x === 'string') : [];
        // (a manifest from before these records has none of them: `files` and `sources` stay undefined, which is how a run tells)
        const files: Record<string, string> | undefined = j.files && typeof j.files === 'object' ? Object.fromEntries(Object.entries(j.files).filter(([, h]) => typeof h === 'string')) : undefined;
        const sources: Record<string, SourceRecord> | undefined = j.sources && typeof j.sources === 'object' ?
            Object.fromEntries(Object.entries(j.sources).filter(([, r]) => r && typeof r.from === 'string' && typeof r.src === 'string').map(([rel, r]) => [rel, { from: r.from, src: r.src, ...(typeof r.stamp === 'string' ? { stamp: r.stamp } : {}) }])) :
            undefined;
        const generated = Array.isArray(j.generated) ? j.generated.filter((x) => typeof x === 'string') : undefined;
        const hidden = Array.isArray(j.hidden) ? j.hidden.filter((x) => typeof x === 'string') : undefined;
        const base = j.base && typeof j.base.id === 'string' ? { id: j.base.id, name: typeof j.base.name === 'string' ? j.base.name : j.base.id } : undefined;
        const inert = j.inert && typeof j.inert === 'object' && j.inert.sources && typeof j.inert.sources === 'object' ?
            {
                sources: Object.fromEntries(Object.entries(j.inert.sources).filter(([, h]) => typeof h === 'string')),
                names: Array.isArray(j.inert.names) ? j.inert.names.filter((x) => typeof x === 'string') : [],
                ...(Array.isArray(j.inert.copies) ? { copies: j.inert.copies.filter((x) => typeof x === 'string') } : {}),
                ...(j.inert.raw && typeof j.inert.raw === 'object' ? { raw: Object.fromEntries(Object.entries(j.inert.raw).filter(([, h]) => typeof h === 'string')) as Record<string, string> } : {})
            } :
            undefined;
        return {
            game: typeof j.game === 'string' ? j.game : undefined,
            restored: j.restored && typeof j.restored === 'object' ? { ...j.restored } : {},
            merged,
            lost,
            ...(optional.length ? { optional } : {}),
            ...(files ? { files } : {}),
            ...(sources ? { sources } : {}),
            ...(generated ? { generated } : {}),
            ...(hidden ? { hidden } : {}),
            ...(base ? { base } : {}),
            ...(inert ? { inert } : {})
        };
    }
    catch
    {
        return undefined;
    }
}

/** Writes the manifest unless the file holds the same already; whether it wrote. `wrote`: the folder watcher told first (ModsHost.wrote). */
export function writeManifest(patchRoot: string, m: FixesManifest, wrote?: (files: string[]) => void): boolean
{
    const file = join(patchRoot, MANIFEST_FILE);
    const text = JSON.stringify({
        game: m.game,
        ...(m.base ? { base: m.base } : {}),
        restored: sortedEntries(m.restored),
        ...(Object.keys(m.merged).length ? { merged: sortedEntries(m.merged) } : {}),
        ...(Object.keys(m.lost).length ? { lost: sortedEntries(m.lost) } : {}),
        ...(m.optional?.length ? { optional: [...m.optional].sort() } : {}),
        ...(m.hidden ? { hidden: [...m.hidden].sort() } : {}),
        ...(m.generated ? { generated: [...m.generated].sort() } : {}),
        ...(m.sources ? { sources: sortedEntries(m.sources) } : {}),
        ...(m.files ? { files: sortedEntries(m.files) } : {}),
        ...(m.inert ? { inert: { sources: sortedEntries(m.inert.sources), names: [...m.inert.names].sort(), ...(m.inert.copies ? { copies: [...m.inert.copies].sort() } : {}), ...(m.inert.raw ? { raw: sortedEntries(m.inert.raw) } : {}) } } : {})
    }, null, 2) + '\n';

    if (existsSync(file) && readFileSync(file, 'utf8') === text)
        return false;

    // (through a temporary file: a kill never leaves half a manifest, which would read as a patch mod from before it)
    wrote?.([file, file + '.crusaderpope-tmp']);
    writeFileSync(file + '.crusaderpope-tmp', text);
    renameSync(file + '.crusaderpope-tmp', file);
    return true;
}
