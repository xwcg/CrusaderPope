/**
 * Thread collecting the effect and trigger keys the loaded script uses (describe/scriptKeys.ts) — the statement
 * picker's "Other effect… / Other condition…" list. Started by the index worker on first request; parses the script
 * files once more (≈ 2–4 s), or reads the result kept next to the index cache while the index fingerprint matches.
 *
 * With an editable mod loaded it stays: an incremental index update posts `{ rescan: paths }` and gets the keys again
 * (only those files read again — an editable mod's files are kept per file; a change of any other file scans all),
 * `{ cache: { file, fingerprint } }` writes the keys as they are now under the index's new fingerprint.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { GameFiles, type GameFile } from './mods/gamefiles.ts';
import { ScriptKeyScanner } from './describe/scriptKeys.ts';
import type { ModInfo, ScriptKeys } from '../shared/api.ts';

interface Job
{
    gameDir: string;
    mods: ModInfo[];
    /** cache file and the index fingerprint it must carry (absent: no cache) */
    cache?: { file: string; fingerprint: string; };
}

const job = workerData as Job;

/** this thread's code: a changed scan is not answered from an old cache (the index fingerprint does not cover it) */
function codeVersion(): string
{
    try
    {
        return createHash('sha1').update(readFileSync(__filename)).digest('hex');
    }
    catch
    {
        return '';
    }
}
const code = codeVersion();

function cached(): ScriptKeys | null
{
    if (!job.cache)
        return null;

    try
    {
        const j = JSON.parse(readFileSync(job.cache.file, 'utf8')) as { fingerprint: string; code?: string; keys: ScriptKeys; };
        return j.fingerprint === job.cache.fingerprint && j.code === code ? j.keys : null;
    }
    catch
    {
        return null;
    }
}

function writeCache(cache: { file: string; fingerprint: string; }, keys: ScriptKeys): void
{
    try
    {
        mkdirSync(dirname(cache.file), { recursive: true });
        writeFileSync(cache.file, JSON.stringify({ fingerprint: cache.fingerprint, code, keys }));
    }
    catch
    {
        // (no cache then)
    }
}

/** the mods whose files may change while the app runs (editable: unpacked in the user's mod folder) */
const editable = new Set(job.mods.filter((m) => m.editable && m.root).map((m) => m.id));
const stays = editable.size > 0;
let files: GameFiles | null = null;
let scanner: ScriptKeyScanner | null = null;

/** a full scan: an editable mod's files kept per file */
function scanAll(): ScriptKeys
{
    files?.close();
    files = new GameFiles(job.gameDir, job.mods);
    const f = files;
    scanner = new ScriptKeyScanner();
    return scanner.scan(f, undefined, (g: GameFile) => g.source > 0 && editable.has(f.sources[g.source]?.modId ?? ''));
}

let keys = cached();

if (!keys)
{
    try
    {
        keys = scanAll();
    }
    catch (err)
    {
        parentPort!.postMessage({ error: String((err as Error)?.message ?? err) });
    }

    if (keys && job.cache)
        writeCache(job.cache, keys);
}

if (keys)
    parentPort!.postMessage({ keys });

if (!stays)
    (files as GameFiles | null)?.close();
else
{
    parentPort!.on('message', (m: { rescan?: string[]; cache?: { file: string; fingerprint: string; }; }) =>
    {
        if (m.rescan)
        {
            try
            {
                // (answered from the cache so far: the files are scanned now; a change of a summed-up file: all again)
                keys = scanner && files && scanner.rescan(files, m.rescan) ? scanner.keys() : scanAll();
                parentPort!.postMessage({ keys });
            }
            catch (err)
            {
                parentPort!.postMessage({ error: String((err as Error)?.message ?? err) });
            }
        }
        else if (m.cache && keys)
            writeCache(m.cache, keys);
    });
}
