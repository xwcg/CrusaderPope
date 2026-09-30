/**
 * Backups of the files the app writes outside the mods (docs/mods.md, "Writing lists back"): the launcher database and
 * dlc_load.json are copied to `<user folder>/crusaderpope-backups/<name>-<date>_<time>-<ms>Z<ext>` (UTC) before each
 * write; the newest `keep` copies of each file are kept, older ones deleted — never the copy just made.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

/** Folder of the backups below the user folder. */
export const BACKUP_FOLDER = 'crusaderpope-backups';
/** How many copies of each file are kept. */
export const BACKUPS_KEPT = 10;

const two = (n: number): string => String(n).padStart(2, '0');

/** `2026-09-29_18-40-12-345Z` (UTC: no clock change or time zone makes a later copy's name look older). */
function stamp(ms: number): string
{
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}_${two(d.getUTCHours())}-${two(d.getUTCMinutes())}-${two(d.getUTCSeconds())}-${String(d.getUTCMilliseconds()).padStart(3, '0')}Z`;
}

const escape = (s: string): string => s.replace(/[.*+?^$(){}|[\]\\]/g, (c) => '\\' + c);

/**
 * The backups of a file (`launcher-v2.sqlite` → `launcher-v2-<stamp>.sqlite`), oldest first: by the time in the name —
 * UTC names (`…Z`), local time for the names app versions before 2026-10 wrote.
 */
export function backupsOf(dir: string, file: string): string[]
{
    const ext = extname(file);
    const base = basename(file, ext);
    const re = new RegExp('^' + escape(base) + '-(\\d{4})-(\\d\\d)-(\\d\\d)_(\\d\\d)-(\\d\\d)-(\\d\\d)-(\\d{3})(Z?)' + escape(ext) + '$', 'i');
    const found: { f: string; t: number; }[] = [];

    try
    {
        for (const f of readdirSync(dir))
        {
            const m = re.exec(f);

            if (!m)
                continue;

            const [y, mo, d, h, mi, s, ms] = m.slice(1, 8).map(Number);
            found.push({ f, t: m[8] ? Date.UTC(y, mo - 1, d, h, mi, s, ms) : new Date(y, mo - 1, d, h, mi, s, ms).getTime() });
        }
    }
    catch
    {
        return [];
    }

    return found.sort((a, b) => a.t - b.t || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0)).map((x) => join(dir, x.f));
}

/**
 * Copies `file` into `dir` under a name with the current time (UTC) and deletes the oldest copies beyond `keep` — never
 * the new one, whatever the clock did. Returns the new copy's path.
 */
export function rotatingBackup(file: string, dir: string, keep = BACKUPS_KEPT, now = Date.now()): string
{
    mkdirSync(dir, { recursive: true });
    const ext = extname(file);
    const base = basename(file, ext);
    let ms = now;
    let target = join(dir, `${base}-${stamp(ms)}${ext}`);

    // two writes within the same millisecond: the next free one
    while (existsSync(target))
        target = join(dir, `${base}-${stamp(++ms)}${ext}`);

    copyFileSync(file, target);
    const others = backupsOf(dir, file).filter((f) => f !== target);

    for (const old of others.slice(0, Math.max(0, others.length - (keep - 1))))
        rmSync(old, { force: true });

    return target;
}
