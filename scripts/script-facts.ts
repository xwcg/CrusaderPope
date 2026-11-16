// The checks apply the script database's facts like the app does (docs/script-database.md): the picker's and the
// describer's tables then hold the game's links, lists and scopes. Needs node:sqlite (the dev Node 22: run with
// --experimental-sqlite, as run-checks.mjs does) and a built database (npm run script-db).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScriptDb, scriptDbFile } from '../src/main/scriptDb.ts';
import { applyScriptFacts } from '../src/shared/scriptFacts.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Applies the newest built database's facts; false (with a note) when there is none or no node:sqlite. */
export function applyRepoScriptFacts(gameVersion?: string): boolean
{
    const db = ScriptDb.open(scriptDbFile(join(root, 'data', 'script-db'), gameVersion));

    if (!db)
    {
        console.warn('script database: none built or no node:sqlite (--experimental-sqlite); the hand-written tables are checked');
        return false;
    }

    applyScriptFacts(db.facts());
    db.close();
    return true;
}
