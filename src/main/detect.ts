/**
 * Finds the Crusader Kings III folders on this machine (the first-run wizard, docs/app-architecture.md "Settings"):
 *   - the install: Steam's libraries (Windows: Steam's registry key; Linux / macOS: Steam's home folders) read from
 *     `steamapps/libraryfolders.vdf`, plus Windows' uninstall entry of Steam app 1158310;
 *   - the user folder: Documents\Paradox Interactive\Crusader Kings III (Linux: ~/.local/share/Paradox Interactive/…).
 * Only folders that exist and hold the game (or user data) are returned; nothing is written.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGameDir } from './gameDir.ts';

const APP_ID = '1158310';
const GAME = 'Crusader Kings III';

/** A registry value (Windows; `reg query`), or undefined. */
function regValue(key: string, name: string): string | undefined
{
    try
    {
        const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        return new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`).exec(out)?.[1]?.trim();
    }
    catch
    {
        return undefined;
    }
}

/** Steam's own folders: where it is installed (each holds steamapps/libraryfolders.vdf). */
function steamRoots(home: string): string[]
{
    if (process.platform === 'win32')
    {
        return [
            regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
            regValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
            regValue('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
            'C:\\Program Files (x86)\\Steam'
        ].filter((p): p is string => !!p);
    }

    return [join(home, '.steam', 'steam'), join(home, '.local', 'share', 'Steam'), join(home, 'Library', 'Application Support', 'Steam')];
}

/** The library folders a Steam install lists (`"path" "D:\\SteamLibrary"`), its own first. */
function libraries(root: string): string[]
{
    const out = [root];

    try
    {
        const vdf = readFileSync(join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');

        for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g))
            out.push(m[1].replace(/\\\\/g, '\\'));
    }
    catch
    {
        // (no vdf: the root alone)
    }

    return out;
}

/** Crusader Kings III installs found (the folder holding `game/`), best first, no duplicates. */
export function findInstalls(home: string): string[]
{
    const found: string[] = [];
    const add = (dir: string | undefined): void =>
    {
        if (dir && resolveGameDir(dir) && !found.some((f) => f.toLowerCase() === dir.toLowerCase()))
            found.push(dir);
    };

    for (const root of steamRoots(home))
        for (const lib of libraries(root))
            add(join(lib, 'steamapps', 'common', GAME));

    if (process.platform === 'win32')
    {
        for (const hive of ['HKLM\\SOFTWARE\\Microsoft', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft'])
            add(regValue(`${hive}\\Windows\\CurrentVersion\\Uninstall\\Steam App ${APP_ID}`, 'InstallLocation'));
    }

    return found;
}

/** The game's user folders found (mods, playsets, saves), the usual one first. */
export function findUserDirs(documents: string, home: string): string[]
{
    return [join(documents, 'Paradox Interactive', GAME), join(home, '.local', 'share', 'Paradox Interactive', GAME), join(home, 'Documents', 'Paradox Interactive', GAME)].filter(
        (d, i, all) => existsSync(d) && all.indexOf(d) === i
    );
}
