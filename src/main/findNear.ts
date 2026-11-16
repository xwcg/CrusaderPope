/**
 * The folder a Browse… meant (the settings' and the first-run wizard's): the one picked, else the nearest below it
 * (breadth first, up to `down` levels: a picked `steamapps`, `steamapps\common` or `Documents`), else above it (up to
 * `up` levels: a picked `…\game\common` or `…\Crusader Kings III\mod`).
 * Names first (docs/app-architecture.md, "Folder search"): below, a folder is only checked on disk when its name could
 * be the one (`named`); every other one costs just the `readdir` of its level, never a stat. The folders of a level
 * are listed 32 at a time; the search stops after `limit` folders or `ms` milliseconds; hidden and system folders are
 * skipped. Plain Node.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const SKIP = /^(\.|\$)|^(node_modules|System Volume Information|Windows|ProgramData)$/i;

/** `fn` over `items`, at most `n` at a time; results in order. */
export async function mapLimit<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]>
{
    const out = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> =>
    {
        while (next < items.length)
        {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
}

/** A folder's subfolder names (none when it can't be read). */
async function subfolders(dir: string): Promise<string[]>
{
    try
    {
        return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !SKIP.test(d.name)).map((d) => d.name);
    }
    catch
    {
        return [];
    }
}

export interface Wanted
{
    /** is it the folder (checked on disk) */
    ok: (dir: string) => boolean;
    /** could a folder of this name be it? Only those are checked below the one picked */
    named: (name: string) => boolean;
}

export async function findNear(start: string, want: Wanted, opts: { down?: number; up?: number; limit?: number; ms?: number; } = {}): Promise<string | null>
{
    const { down = 2, up = 3, limit = 2000, ms = 1500 } = opts;
    const until = Date.now() + ms;

    if (want.ok(start))
        return start;

    // below: level by level (the nearest match wins), each level's folders listed in parallel
    let level = [start];
    let seen = 0;

    for (let depth = 1; depth <= down && level.length && seen < limit && Date.now() < until; depth++)
    {
        const lists = await mapLimit(level, 32, (dir) => (Date.now() < until ? subfolders(dir) : Promise.resolve([])));
        const next: string[] = [];

        for (let i = 0; i < level.length && seen < limit; i++)
        {
            for (const n of lists[i])
            {
                const sub = join(level[i], n);

                if (want.named(n) && want.ok(sub))
                    return sub;

                next.push(sub);

                if (++seen >= limit)
                    break;
            }
        }

        level = next;
    }

    // above (a few folders: each checked)
    let dir = start;

    for (let i = 0; i < up; i++)
    {
        const parent = dirname(dir);

        if (parent === dir)
            break;

        dir = parent;

        if (want.ok(dir))
            return dir;
    }

    return null;
}

/**
 * A Crusader Kings III install (the folder holding `game/`), or its `game` folder: stricter than resolveGameDir (a mod
 * folder has a `common` too, Victoria 3 a `game/common`): landed titles are what a search may land on.
 */
export function isGameInstall(dir: string): boolean
{
    if (existsSync(join(dir, 'game', 'common', 'landed_titles')) && existsSync(join(dir, 'game', 'events')))
        return true;

    return basename(dir).toLowerCase() === 'game' && existsSync(join(dir, 'common', 'landed_titles')) && existsSync(join(dir, 'events'));
}

/**
 * The game's user folder: named `Crusader Kings III` (every Paradox game keeps its own next to it, with the same launcher
 * files) and holding the launcher's database, dlc_load.json or `mod`.
 */
export function isUserDir(dir: string): boolean
{
    return basename(dir).toLowerCase() === 'crusader kings iii' && ['launcher-v2.sqlite', 'dlc_load.json', 'mod'].some((f) => existsSync(join(dir, f)));
}

/** What a search looks for: an install (Steam and GOG name it Crusader Kings III; its `game` folder) or the user folder. */
export const WANTED: Record<'game' | 'user', Wanted> = {
    game: { ok: isGameInstall, named: (n) => /crusader|ck3|^game$/i.test(n) },
    user: { ok: isUserDir, named: (n) => n.toLowerCase() === 'crusader kings iii' }
};

/** A Browse… answer: the folder meant (an install rather than its `game` folder), and the one picked when it differs. */
export async function browsed(picked: string | null, kind: 'game' | 'user'): Promise<{ path: string; picked?: string; } | null>
{
    if (!picked)
        return null;

    let found = await findNear(picked, WANTED[kind]);

    // (the install rather than its game folder, which the settings show elsewhere)
    if (found && kind === 'game' && basename(found).toLowerCase() === 'game' && isGameInstall(dirname(found)))
        found = dirname(found);

    return found && found !== picked ? { path: found, picked } : { path: picked };
}
