import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Resolve the directory that holds common/, events/ … from an install dir or the game dir itself. */
export function resolveGameDir(dir: string): string | null
{
    if (!dir)
        return null;

    if (existsSync(join(dir, 'game', 'common')))
        return join(dir, 'game');

    if (existsSync(join(dir, 'common')))
        return dir;

    return null;
}
