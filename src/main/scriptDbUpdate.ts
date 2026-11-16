/**
 * Script database updates without an app release (docs/script-database.md, step 6): the owner publishes the files of
 * scripts/script-db-release.ts as the assets of the GitHub release tagged `script-db`; at most once a day (unless
 * Settings.scriptDbUpdates is false) the app reads its manifest, and when it lists a database for the game's version
 * (or the newest older one) that this app can read (schema) and that was built later than the one in use, downloads
 * it, checks its SHA-256, test-opens it and keeps it in the user data folder, where scriptDbService prefers it over an
 * older bundled one. CRUSADERPOPE_SCRIPT_DB_FEED: `off` (no check; scripts/drive.mjs sets it), a manifest .json file
 * (tests; its databases are read next to it), or another URL.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { tr } from '../shared/i18n.ts';
import { ScriptDb } from './scriptDb.ts';
import type { ScriptDbUpdateResult } from '../shared/scriptFacts.ts';

const FEED = 'https://github.com/xwcg/CrusaderPope/releases/download/script-db/manifest.json';

/** the database schema this app reads (scripts/script-db-build.ts meta `schema`) */
export const SCRIPT_DB_SCHEMA = 1;

/** at most one check a day, unless asked */
const DAY = 24 * 3600 * 1000;

export interface ScriptDbManifest
{
    format: number;
    published: string;
    databases: { game: string; schema: number; built: string; explained: number; file: string; size: number; sha256: string; }[];
}


const num = (v: string): number[] => v.split('.').map((x) => Number(x) || 0);

function cmp(a: string, b: string): number
{
    const x = num(a), y = num(b);

    for (let i = 0; i < Math.max(x.length, y.length); i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) - (y[i] ?? 0);

    return 0;
}

async function fetchBytes(url: string): Promise<Buffer>
{
    const res = await fetch(url, { headers: { 'User-Agent': 'CrusaderPope' }, signal: AbortSignal.timeout(60_000) });

    if (!res.ok)
        throw new Error(tr('{url}: HTTP {status}', { url, status: res.status }));

    return Buffer.from(await res.arrayBuffer());
}

/** The manifest and a way to read its files: from the web, or (tests) from the folder of a local manifest */
async function feed(): Promise<{ manifest: ScriptDbManifest; file: (name: string) => Promise<Buffer>; } | null>
{
    const where = process.env.CRUSADERPOPE_SCRIPT_DB_FEED || FEED;

    if (where === 'off')
        return null;

    if (!/^https?:/i.test(where))
        return { manifest: JSON.parse(readFileSync(where, 'utf8')) as ScriptDbManifest, file: async (n) => readFileSync(join(dirname(where), n)) };

    const manifest = JSON.parse((await fetchBytes(where)).toString('utf8')) as ScriptDbManifest;
    const base = where.slice(0, where.lastIndexOf('/') + 1);
    return { manifest, file: (n) => fetchBytes(base + encodeURIComponent(n)) };
}

/**
 * Looks for a newer database for a game version (`current`: the one in use, its game version and build). Downloads
 * it into `dir` when there is one; `stateFile` keeps the time of the last check (once a day unless `force`).
 */
export async function checkScriptDbUpdate(opts: { gameVersion?: string; current?: { game: string; built: string; }; dir: string; stateFile: string; force?: boolean; release?: (file: string) => void; }): Promise<ScriptDbUpdateResult>
{
    try
    {
        if (!opts.force && existsSync(opts.stateFile))
        {
            const last = (JSON.parse(readFileSync(opts.stateFile, 'utf8')) as { checked?: number; }).checked ?? 0;

            if (Date.now() - last < DAY)
                return { state: 'skipped', message: tr('Checked less than a day ago.') };
        }

        const f = await feed();

        if (!f)
            return { state: 'off', message: tr('Script database updates are turned off.') };

        mkdirSync(dirname(opts.stateFile), { recursive: true });
        writeFileSync(opts.stateFile, JSON.stringify({ checked: Date.now() }));

        // (the game's version, else the newest older one; only a schema this app reads)
        const readable = f.manifest.databases.filter((d) => d.schema <= SCRIPT_DB_SCHEMA);
        const pick = opts.gameVersion
            ? readable.filter((d) => cmp(d.game, opts.gameVersion!) <= 0).sort((a, b) => cmp(b.game, a.game))[0]
            : readable.sort((a, b) => cmp(b.game, a.game))[0];

        if (!pick)
            return f.manifest.databases.some((d) => d.schema > SCRIPT_DB_SCHEMA)
                ? { state: 'none', message: tr('A newer script database needs a newer version of the app.') }
                : { state: 'none', message: tr('No script database for this game version yet.') };

        if (opts.current && cmp(opts.current.game, pick.game) > 0)
            return { state: 'current', message: tr('The script database in use is for a newer game version.'), game: pick.game, built: pick.built };

        if (opts.current && opts.current.game === pick.game && pick.built <= opts.current.built)
            return { state: 'current', message: tr('The script database is up to date.'), game: pick.game, built: pick.built };

        const gz = await f.file(pick.file);
        const hash = createHash('sha256').update(gz).digest('hex');

        if (hash !== pick.sha256)
            return { state: 'error', message: tr('The downloaded script database is damaged (its checksum does not match); the one in use stays.') };

        // (written beside, opened once to be sure it is a database of that game version, then put in place)
        mkdirSync(opts.dir, { recursive: true });
        const target = join(opts.dir, `ck3-${pick.game}.sqlite`);
        const temp = `${target}.download`;
        writeFileSync(temp, gunzipSync(gz));
        const test = ScriptDb.open(temp);
        const ok = test?.version === pick.game;
        test?.close();

        if (!ok)
        {
            rmSync(temp, { force: true });
            return { state: 'error', message: tr('The downloaded script database could not be read; the one in use stays.') };
        }

        // (the file in use may be the one replaced: closed first, Windows does not replace an open file)
        opts.release?.(target);
        renameSync(temp, target);
        return { state: 'updated', message: tr('Script database updated for game version {game}.', { game: pick.game }), game: pick.game, built: pick.built };
    }
    catch (e)
    {
        return { state: 'error', message: tr('Script database update check failed: {error}', { error: (e as Error).message }) };
    }
}
