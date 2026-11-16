/**
 * The in-app folder picker's file-system side (docs/app-architecture.md, "Folder picker"): the native folder dialog
 * freezes on huge folders and network shares (Explorer loads icons, thumbnails and metadata of every entry), so the
 * renderer's FolderPicker lists folders through these instead. One `readdir` per folder, no stat per entry, errors as
 * data. Plain Node.
 */
import { access, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import type { FolderListing } from '../shared/api.ts';

import { tr } from '../shared/i18n.ts';
/** dot-folders and Windows' system folders */
const HIDDEN = /^(\.|\$)|^(System Volume Information)$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** `path.dirname`, null at a drive or share root (`C:\`, `\\server\share\`). */
function parentOf(p: string): string | null
{
    const parent = dirname(p);
    return parent === p || parse(p).root === p ? null : parent;
}

/** A folder's subfolders (sorted as people count: 2 before 10) and how many files it holds, names only. */
export async function listDirs(path: string): Promise<FolderListing>
{
    try
    {
        const entries = await readdir(path, { withFileTypes: true });
        const dirs: string[] = [];
        let files = 0;

        for (const e of entries)
        {
            if (e.isDirectory())
            {
                if (!HIDDEN.test(e.name))
                    dirs.push(e.name);
            }
            else
                files++;
        }

        return { path, parent: parentOf(path), dirs: dirs.sort(collator.compare), files };
    }
    catch (e)
    {
        const code = (e as NodeJS.ErrnoException).code;
        return { path, parent: parentOf(path), dirs: [], files: 0, error: (e as Error).message, notFound: code === 'ENOENT' || code === 'ENOTDIR' };
    }
}

/** A promise that gives up after `ms` (a disconnected network drive answers late or never). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T>
{
    return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** The drives that answer within 1.5 s (`C:\` … `Z:\`); `/` elsewhere. */
export async function drives(): Promise<string[]>
{
    if (process.platform !== 'win32')
        return ['/'];

    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`);
    const ok = await Promise.all(
        letters.map((d) =>
            within(
                access(d).then(
                    () => true,
                    () => false
                ),
                1500,
                false
            )
        )
    );
    return letters.filter((_, i) => ok[i]);
}

/** The nearest folder that exists, going up from `path` (a start folder that is not made yet). */
export async function nearestExisting(path: string): Promise<string | null>
{
    let p: string | null = path;

    while (p)
    {
        const ok = await within(
            access(p).then(
                () => true,
                () => false
            ),
            3000,
            false
        );

        if (ok)
            return p;

        p = parentOf(p);
    }

    return null;
}

/** A new folder in `parent`; its path, or what went wrong. */
export async function makeFolder(parent: string, name: string): Promise<{ path?: string; error?: string; }>
{
    const n = name.trim();

    if (!n || /[<>:"/\\|?*\u0000-\u001f]/.test(n) || /^\.+$/.test(n) || /[. ]$/.test(n))
        return { error: tr('Not a valid folder name.') };

    const path = join(parent, n);

    try
    {
        await mkdir(path);
        return { path };
    }
    catch (e)
    {
        return { error: (e as NodeJS.ErrnoException).code === 'EEXIST' ? tr('“{n}” exists already.', { n }) : (e as Error).message };
    }
}
