/**
 * Files inside packed mods have no disk path — GameFiles.where shows them as `archive.zip › entry`. To open one in an
 * editor, the entry is extracted to a temp folder as a read-only copy (docs/mods.md, "Files inside zips"); revealing
 * one shows the zip.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { entryNameProblem, ZipArchive } from './zip.ts';

/** Separator of GameFiles.where for a zip entry. */
export const ZIP_SEP = ' › ';

export function splitZipPath(p: string): { archive: string; entry: string; } | undefined
{
    const i = p.indexOf(ZIP_SEP);
    return i < 0 ? undefined : { archive: p.slice(0, i), entry: p.slice(i + ZIP_SEP.length) };
}

/**
 * The entry as a read-only file `<tempRoot>/<zip id>/<entry path>` (extracted once per zip version: the id covers the
 * zip's path, size and modification time).
 */
export function extractEntry(archive: string, entry: string, tempRoot: string): string
{
    const st = statSync(archive);
    const id = createHash('sha1')
        .update(`${resolve(archive).toLowerCase()}|${st.size}|${st.mtimeMs}`)
        .digest('hex')
        .slice(0, 16);
    const dir = join(tempRoot, id);
    const target = resolve(dir, ...entry.split('/'));
    const rel = relative(dir, target);

    // (`..foo/x` is a name like any other: only a `..` segment leaves the folder)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || entryNameProblem(entry))
        throw new Error('Not a file inside the zip: ' + entry);

    if (existsSync(target))
        return target;

    const zip = new ZipArchive(archive);

    try
    {
        const data = zip.readEntry(entry);

        if (!data)
            throw new Error(`${entry} was not found in ${archive}`);

        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data);
        // a copy: edits belong in the mod itself (unpack it on the Mods page)
        chmodSync(target, 0o444);
    }
    finally
    {
        zip.close();
    }

    return target;
}

/** Removes extracted copies older than `maxAgeMs` (best effort: read-only files are made writable first). */
export function cleanExtracted(tempRoot: string, maxAgeMs = 7 * 24 * 3600e3): void
{
    let dirs: string[];

    try
    {
        dirs = readdirSync(tempRoot);
    }
    catch
    {
        return;
    }

    const writable = (p: string): void =>
    {
        try
        {
            if (statSync(p).isDirectory())
            {
                for (const n of readdirSync(p))
                    writable(join(p, n));
            }
            else
                chmodSync(p, 0o666);
        }
        catch
        {
            /* gone */
        }
    };

    for (const d of dirs)
    {
        const p = join(tempRoot, d);

        try
        {
            if (Date.now() - statSync(p).mtimeMs < maxAgeMs)
                continue;

            writable(p);
            rmSync(p, { recursive: true, force: true });
        }
        catch
        {
            /* in use: next time */
        }
    }
}
