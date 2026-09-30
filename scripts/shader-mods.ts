// The file layering of the shader scripts: the game alone, or with a mod list like the app loads it (docs/mods.md).
// `--mods <list>` names a launcher playset (name or uuid), `game` (dlc_load.json) or a list ref (`playset:<uuid>`).
// Only reads the user folder (launcher-v2.sqlite needs node --experimental-sqlite).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { modsOfList, readModsState } from '../src/main/mods/manager.ts';
import type { ModInfo } from '../src/shared/api.ts';
import { defaultInstall } from './ck3-install.ts';

/** Takes `--mods <list>` out of args; the game folder from CK3_DIR, the user folder from CK3_USER_DIR (else detected). */
export async function shaderFiles(args: string[]): Promise<{ vfs: GameFiles; mods: ModInfo[]; label: string; }>
{
    const gameDir = resolveGameDir(defaultInstall());

    if (!gameDir)
        throw new Error('game folder not found (CK3_DIR)');

    const at = args.indexOf('--mods');
    const want = at >= 0 ? args.splice(at, 2)[1] : undefined;

    if (!want)
        return { vfs: new GameFiles(gameDir), mods: [], label: 'game' };

    const state = await readModsState({ gameDir, language: 'english', userDir: process.env.CK3_USER_DIR }, gameDir, join(homedir(), 'Documents'));
    const list = state.lists.find((l) => l.ref === want || l.ref === 'playset:' + want || l.name === want);

    if (!list)
        throw new Error(`mod list "${want}" not found (lists: ${state.lists.map((l) => `${l.name} [${l.ref}]`).join(', ') || 'none — run node with --experimental-sqlite'})`);

    const mods = modsOfList(state, list.ref);
    return { vfs: new GameFiles(gameDir, mods), mods, label: `${list.name}: ${mods.map((m) => m.name).join(' → ')}` };
}
