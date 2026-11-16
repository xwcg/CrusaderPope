/**
 * The game's own files, as the game layers them: the game folder, its DLC folders, then the engine layers `jomini/` and
 * `clausewitz/` next to `game/`. Used by the migration (migrate.ts, guiWork.ts, dataCallRule.ts) to read what the game
 * itself writes: a file the mod overrides, the localization keys, the gui types.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inJob, jobMap } from './keptTexts.ts';

/** The DLC folders per game folder, while the dlc folder is as it was (its modification time: a folder added or taken changes it). */
const dlcMemo = new Map<string, { mtime: number; roots: string[]; }>();

/** The game folder and the folders of its DLCs (a file of the game may be in either). */
export function gameRoots(gameDir: string): string[]
{
    const dlc = join(gameDir, 'dlc');
    let mtime: number;

    try
    {
        mtime = statSync(dlc).mtimeMs;
    }
    catch
    {
        return [gameDir];
    }

    const have = dlcMemo.get(gameDir);

    if (have?.mtime === mtime)
        return [...have.roots];

    const roots = [gameDir, ...(existsSync(dlc) ? readdirSync(dlc, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dlc, d.name)) : [])];
    dlcMemo.set(gameDir, { mtime, roots });
    return [...roots];
}

/** The roots of the game's files, engine layers included. */
export function layerRoots(gameDir: string): string[]
{
    const install = dirname(gameDir);
    return [...gameRoots(gameDir), join(install, 'jomini'), join(install, 'clausewitz')];
}

/**
 * The files found for paths, and which folders of the layers are there, during a migration job (the game's folders do not change
 * while it runs; keptTexts.ts `jobMap`).
 */
const found = jobMap<string, string | null>();
const folders = jobMap<string, boolean>();

/** Whether a folder of a layer is one, asked once per job (a file below a folder that is not there is not there either). */
function isFolder(dir: string): boolean
{
    let is = folders.get(dir);

    if (is === undefined)
    {
        try
        {
            is = statSync(dir).isDirectory();
        }
        catch
        {
            is = false;
        }

        folders.set(dir, is);
    }

    return is;
}

/**
 * The game's own file of a path, as the game layers it: the game folder, then its DLC folders, then the engine layers
 * jomini and clausewitz (GameFiles' engine roots; shader includes like gfx/FX/jomini/portrait.shader and
 * gfx/FX/cw/pdxmesh.fxh live only there).
 */
export function gameFile(gameDir: string, rel: string): string | undefined
{
    const key = `${gameDir}|${rel}`;
    const have = found.get(key);

    if (have !== undefined)
        return have ?? undefined;

    const parts = rel.split('/');
    // (in a job a layer whose folder of the path is missing is passed over; not for folder names Windows would read without a
    // trailing dot or space, which the file's own path does not drop)
    const byFolder = inJob() && !parts.slice(0, -1).some((p) => /[. ]$/.test(p));
    const file = layerRoots(gameDir).map((r) => join(r, ...parts)).find((f) => (!byFolder || isFolder(dirname(f))) && existsSync(f));
    found.set(key, file ?? null);
    return file;
}

/** Every file below a folder in the game's layers (the first layer's file wins a path): the relative path and the file. */
export function gameFilesBelow(gameDir: string, folder: string, ext: RegExp): { rel: string; abs: string; }[]
{
    const out = new Map<string, { rel: string; abs: string; }>();
    const walk = (dir: string, rel: string): void =>
    {
        if (!existsSync(dir))
            return;

        for (const e of readdirSync(dir, { withFileTypes: true }))
        {
            if (e.isDirectory())
                walk(join(dir, e.name), `${rel}/${e.name}`);
            else if (ext.test(e.name) && !out.has(`${rel}/${e.name}`.toLowerCase()))
                out.set(`${rel}/${e.name}`.toLowerCase(), { rel: `${rel}/${e.name}`, abs: join(dir, e.name) });
        }
    };

    for (const r of layerRoots(gameDir))
        walk(join(r, ...folder.split('/')), folder);

    return [...out.values()];
}
