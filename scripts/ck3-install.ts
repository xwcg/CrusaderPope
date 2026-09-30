// The Crusader Kings III install the scripts read: CK3_DIR (or GAME), else the first one found on this machine (the
// first-run wizard's detection, src/main/detect.ts: Steam's libraries, the registry).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findInstalls } from '../src/main/detect.ts';

export function defaultInstall(): string
{
    const dir = process.env.CK3_DIR ?? process.env.GAME ?? findInstalls(homedir())[0];

    if (!dir)
        throw new Error('No Crusader Kings III install found — set CK3_DIR to the folder that holds game/.');

    return dir;
}

/** The Steam Workshop folder of Crusader Kings III next to the install (steamapps/workshop/content/1158310). */
export function workshopFolder(install = defaultInstall()): string
{
    return join(install, '..', '..', 'workshop', 'content', '1158310');
}
