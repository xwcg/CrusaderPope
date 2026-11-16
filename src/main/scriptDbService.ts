/**
 * The main process's script database (docs/script-database.md): opens the database for the configured game's version,
 * applies its facts to this process's tables and hands them to the index worker and the window; answers the window's
 * requests for entries and explanations. Updates fetched from the network are kept in the user data folder and
 * preferred over the bundled database of the same game version (step 6).
 */
import { app } from 'electron';
import { join } from 'node:path';
import { gameVersion } from './mods/discover.ts';
import { resolveGameDir } from './gameDir.ts';
import { ScriptDb, scriptDbFile, type DbEntry, type DbKind } from './scriptDb.ts';
import { checkScriptDbUpdate } from './scriptDbUpdate.ts';
import { applyScriptFacts, type ScriptDbStatus, type ScriptDbUpdateResult, type ScriptFacts } from '../shared/scriptFacts.ts';

let db: ScriptDb | null = null;
let facts: ScriptFacts | null = null;
const listeners: ((f: ScriptFacts) => void)[] = [];

/** The bundled databases' folder: packaged `<resources>/script-db`, in development `data/script-db` of the repository. */
export function bundledScriptDbDir(): string
{
    return app.isPackaged ? join(process.resourcesPath, 'script-db') : join(app.getAppPath(), 'data', 'script-db');
}

/** Downloaded databases (step 6): the user data folder's `script-db` */
export function downloadedScriptDbDir(): string
{
    return join(app.getPath('userData'), 'script-db');
}

/** The file to use for a game version: a downloaded one of the same or a closer version wins over the bundled one. */
function chooseFile(version: string | undefined): string | undefined
{
    const bundled = scriptDbFile(bundledScriptDbDir(), version);
    const downloaded = scriptDbFile(downloadedScriptDbDir(), version);

    if (!downloaded)
        return bundled;

    if (!bundled)
        return downloaded;

    const v = (f: string): string => /ck3-([\d.]+)\.sqlite$/.exec(f)?.[1] ?? '';
    const n = (s: string): number[] => s.split('.').map(Number);
    const a = n(v(downloaded)), b = n(v(bundled));

    for (let i = 0; i < Math.max(a.length, b.length); i++)
        if ((a[i] ?? 0) !== (b[i] ?? 0))
            return (a[i] ?? 0) > (b[i] ?? 0) ? downloaded : bundled;

    // (one game version in both: the later build; an app update's bundled database is newer than an old download)
    return builtOf(downloaded) > builtOf(bundled) ? downloaded : bundled;
}

function builtOf(file: string): string
{
    const d = ScriptDb.open(file);
    const built = d?.built ?? '';
    d?.close();
    return built;
}

/**
 * Opens the database for a game folder's version (again when the file changes), applies its facts here and tells the
 * listeners (the index worker, the window). No database or no node:sqlite: the hand-written tables stay.
 */
export function openScriptDb(gameDir: string, reopen = false): void
{
    const dir = resolveGameDir(gameDir);
    const file = chooseFile(dir ? gameVersion(dir) : undefined);

    if (db?.file === file && !reopen)
        return;

    db?.close();
    db = ScriptDb.open(file);
    facts = db ? db.facts() : null;

    if (!facts)
        return;

    applyScriptFacts(facts);

    for (const fn of listeners)
        fn(facts);
}

/** The facts of the open database (null: none). */
export function currentScriptFacts(): ScriptFacts | null
{
    return facts;
}

/** Called with the facts each time a database is opened (the index worker gets them so). */
export function onScriptFacts(fn: (f: ScriptFacts) => void): void
{
    listeners.push(fn);
}

/** The open database (null: none). */
export function scriptDb(): ScriptDb | null
{
    return db;
}

/** One entry with its explanation, for the window (help boxes, tooltips). */
export function scriptDbEntry(kind: DbKind, key: string, variant = ''): DbEntry | null
{
    return db?.entry(kind, key, variant) ?? null;
}

/** The labels and summaries of a kind's entries, for menus (key → [label, summary]). */
export function scriptDbLabels(kind: DbKind): Record<string, [string, string]>
{
    const out: Record<string, [string, string]> = {};

    for (const e of db?.all(kind) ?? [])
        if (e.explanation && !e.variant)
            out[e.key] = [e.explanation.label, e.explanation.summary];

    return out;
}

export function scriptDbSearch(text: string, kinds?: DbKind[], limit?: number): DbEntry[]
{
    return db?.search(text, kinds, limit) ?? [];
}


let lastCheck: ScriptDbUpdateResult | undefined;

export function scriptDbStatus(): ScriptDbStatus
{
    if (!db)
        return { last: lastCheck };

    return {
        game: db.version,
        built: db.built,
        source: db.file.startsWith(downloadedScriptDbDir()) ? 'downloaded' : 'bundled',
        explained: db.explainedCount(),
        last: lastCheck
    };
}

/**
 * Looks for a newer script database (scriptDbUpdate.ts) and, when one was downloaded, opens it: its facts go to this
 * process, the index worker and the window. `force`: also when checked less than a day ago (the Settings button).
 */
export async function updateScriptDb(gameDir: string, force = false): Promise<ScriptDbUpdateResult>
{
    const dir = resolveGameDir(gameDir);
    const result = await checkScriptDbUpdate({
        gameVersion: dir ? gameVersion(dir) : undefined,
        current: db ? { game: db.version, built: db.built } : undefined,
        dir: downloadedScriptDbDir(),
        stateFile: join(downloadedScriptDbDir(), 'state.json'),
        force,
        release: (file) =>
        {
            if (db?.file === file)
            {
                db.close();
                db = null;
            }
        }
    });
    lastCheck = result;

    if (result.state === 'updated')
        openScriptDb(gameDir, true);

    return result;
}
