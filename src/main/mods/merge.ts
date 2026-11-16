/**
 * Merging mods into one (docs/mods.md, "Merging mods"): the enabled mods of a mod list, in its load order, written into
 * one new local mod, the game's own layering applied: a later mod's file replaces an earlier one's of the same path,
 * a mod's `replace_path` also hides the earlier mods' files in that folder (and stays in the new descriptor: it hides
 * the game's too). The mods themselves stay as they are; a new custom list holds the merged mod. Entries resolve as
 * before: the game orders a folder's files by path across all sources (mod order decides only between files of one
 * path), and the merge keeps every path.
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MergePlan, MergeRequest, MergeResult, MigrationProgress, ModInfo } from '../../shared/api.ts';
import { tr } from '../../shared/i18n.ts';
import { modFolderProblem, supportedVersionFor } from '../../shared/modRules.ts';
import { createMod, modsOfList, modsState, saveList, skipInModZip, type ModsHost } from './manager.ts';
import { addReplacePaths } from './migrate.ts';
import { ZipArchive } from './zip.ts';

const lc = (s: string): string => s.toLowerCase();
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

/** The files of a mod: relative path → where it is (a file, or an entry of its zip). */
export function filesOf(mod: ModInfo): Map<string, { file?: string; entry?: string; }>
{
    const out = new Map<string, { file?: string; entry?: string; }>();

    if (mod.root)
    {
        const walk = (dir: string, rel: string): void =>
        {
            for (const e of readdirSync(dir, { withFileTypes: true }))
            {
                const r = rel ? `${rel}/${e.name}` : e.name;

                if (e.isDirectory())
                    walk(join(dir, e.name), r);
                else if (e.isFile())
                    out.set(r, { file: join(dir, e.name) });
            }
        };
        walk(mod.root, '');
    }
    else if (mod.archive)
    {
        const zip = new ZipArchive(mod.archive);

        try
        {
            for (const e of zip.files())
                if (!e.dir)
                    out.set(norm(e.name), { entry: e.name });
        }
        finally
        {
            zip.close();
        }
    }

    // (the descriptor is written anew; dot files, OS litter and zips at the top are no mod content)
    for (const rel of [...out.keys()])
        if (lc(rel) === 'descriptor.mod' || skipInModZip(rel))
            out.delete(rel);

    return out;
}

/** In a `replace_path` folder: directly in it (the game hides only those, not its subfolders; docs/mods.md). */
const inFolder = (rel: string, folder: string): boolean => lc(rel.slice(0, rel.lastIndexOf('/'))) === lc(folder);

/** The mods of a list a merge takes: its enabled ones, in load order (those found). */
async function listMods(host: ModsHost, ref: string): Promise<{ name: string; mods: ModInfo[]; }>
{
    const state = await modsState(host);
    const list = state.lists.find((l) => l.ref === ref);

    if (!list)
        throw new Error(tr('Unknown mod list: ') + ref);

    const mods = modsOfList(state, ref).filter((m) => m.status === 'ok');

    if (mods.length < 2)
        throw new Error(tr('“{name}” has fewer than two enabled mods — nothing to merge.', { name: list.name }));

    return { name: list.name, mods };
}

export async function planMerge(host: ModsHost, ref: string): Promise<MergePlan>
{
    const { name, mods } = await listMods(host, ref);
    return {
        ref,
        list: name,
        mods: mods.map((m) => ({ id: m.id, name: m.name, version: m.version, supportedVersion: m.supportedVersion })),
        replacePaths: [...new Set(mods.flatMap((m) => m.replacePaths.map(norm)))]
    };
}

export interface MergeRun
{
    progress?(p: MigrationProgress): void;
    cancelled?(): boolean;
}

export async function mergeMods(host: ModsHost, req: MergeRequest, run: MergeRun = {}): Promise<MergeResult>
{
    const name = String(req?.name ?? '').trim();
    const folder = String(req?.folder ?? '').trim();

    if (!name)
        throw new Error(tr('Enter a name for the mod.'));

    const problem = modFolderProblem(folder);

    if (problem)
        throw new Error(problem);

    const { mods } = await listMods(host, req.ref);
    const report = (p: MigrationProgress): void => run.progress?.(p);

    // 1. what ends up in the merged mod: each mod's files over the earlier ones' (by path; its replace_paths hide the
    // earlier ones' in those folders)
    report({ stage: tr('Reading the mods…'), done: 0, total: 0 });
    const files = new Map<string, { mod: ModInfo; file?: string; entry?: string; }>();
    let replaced = 0;

    for (const mod of mods)
    {
        for (const folderPath of mod.replacePaths.map(norm))
        {
            for (const rel of [...files.keys()])
            {
                if (inFolder(rel, folderPath))
                {
                    files.delete(rel);
                    replaced++;
                }
            }
        }

        for (const [rel, where] of filesOf(mod))
        {
            if (files.has(rel))
                replaced++;

            files.set(rel, { mod, ...where });
        }
    }

    // 2. the new mod (its descriptor: the replace_paths of all, the newest supported version, the tags of all; making
    // a mod makes it the active one; the one edited stays)
    const active = host.settings().activeMod;
    let state = await modsState(host);
    const versions = mods.map((m) => m.supportedVersion).filter((v): v is string => !!v).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    state = await createMod(host, {
        name,
        folder,
        version: '1',
        supportedVersion: versions[versions.length - 1] ?? (supportedVersionFor(state.gameVersion) || ''),
        tags: [...new Set(mods.flatMap((m) => m.tags))].slice(0, 10)
    });
    const merged = state.mods.find((m) => m.root && lc(m.root.split(/[\\/]/).pop()!) === lc(folder));
    host.updateSettings({ activeMod: active });

    if (!merged?.root)
        throw new Error(tr('The merged mod could not be made'));

    const replacePaths = [...new Set(mods.flatMap((m) => m.replacePaths.map(norm)))];
    addReplacePaths(merged, replacePaths);

    // 3. the files copied (from folders or zips)
    const zips = new Map<string, ZipArchive>();
    let done = 0;

    try
    {
        for (const [rel, where] of files)
        {
            if (done % 50 === 0)
            {
                report({ stage: tr('Copying {rel}', { rel }), done, total: files.size });
                // (the copying is synchronous: a turn of the event loop lets Cancel and the progress through)
                await new Promise((r) => setImmediate(r));
            }

            if (run.cancelled?.())
                throw new Error(tr('Cancelled — nothing was kept'));

            const out = join(merged.root, ...rel.split('/'));
            mkdirSync(dirname(out), { recursive: true });

            if (where.file)
                copyFileSync(where.file, out);
            else if (where.entry && where.mod.archive)
            {
                let zip = zips.get(where.mod.archive);

                if (!zip)
                    zips.set(where.mod.archive, zip = new ZipArchive(where.mod.archive));

                const data = zip.readEntry(where.entry);

                if (!data)
                    throw new Error(tr('{rel} could not be read from {zip}', { rel: where.entry, zip: where.mod.archive }));

                writeFileSync(out, data);
            }

            done++;
        }
    }
    catch (e)
    {
        // (cancelled or failed: the half-made mod goes, made by this merge a moment ago)
        for (const z of zips.values())
            z.close();

        zips.clear();
        rmSync(merged.root, { recursive: true, force: true });

        if (merged.descriptorFile)
            rmSync(merged.descriptorFile, { force: true });

        throw e;
    }
    finally
    {
        for (const z of zips.values())
            z.close();
    }

    // 4. a list with the merged mod (not loaded: the user loads it when they want)
    const listName = tr('{name} (merged)', { name });
    await saveList(host, { name: listName, mods: [{ id: merged.id, enabled: true }] });

    return { mod: { id: merged.id, name, folder }, list: listName, files: files.size, replaced, replacePaths };
}
