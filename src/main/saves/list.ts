/**
 * The save files of a folder (the Save tab, docs/saves.md): what each one's header and metadata say, read without
 * the gamestate (a few KB per file).
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SaveListItem } from '../../shared/api.ts';
import { readHeader } from './envelope.ts';
import { cleanText, entries } from './gamestate.ts';

function readPart(file: string, at: number, len: number): Buffer
{
    const fd = openSync(file, 'r');

    try
    {
        const b = Buffer.alloc(len);
        const n = readSync(fd, b, 0, len, at);
        return b.subarray(0, n);
    }
    finally
    {
        closeSync(fd);
    }
}

/** A binary save's text copy (made with rakaly, rakaly.ts `meltSave`), when there is one for it as it is now. */
export function meltedCopy(dataDir: string, file: string, st = statSync(file)): string | undefined
{
    const out = join(dataDir, 'melted', `${basename(file).replace(/\.ck3$/i, '')}.${st.size}-${Math.round(st.mtimeMs)}.ck3`);
    return existsSync(out) ? out : undefined;
}

/** One save's header and metadata (a binary save's: its text copy's, when there is one, `dataDir`). */
export function saveItem(file: string, dataDir?: string): SaveListItem
{
    const st = statSync(file);
    const item: SaveListItem = { file, name: basename(file).replace(/\.ck3$/i, ''), size: st.size, mtime: st.mtimeMs, binary: false, mods: [] };

    try
    {
        const h = readHeader(readPart(file, 0, 40));
        item.binary = h.kind === 1 || h.kind === 3 || h.kind === 5;
        const meta = readPart(file, h.length, h.metaLen);

        // (binary metadata: its strings aren't keyed by name: its text copy's, else the file's name says who)
        const copy = item.binary && dataDir ? meltedCopy(dataDir, file, st) : undefined;

        if (copy)
            return { ...saveItem(copy), file, name: item.name, size: item.size, mtime: item.mtime, binary: true };

        if (item.binary || !meta.length)
            return item;

        const top = [...entries(meta, 0)].find((e) => e.key === 'meta_data');

        if (!top?.block)
            return item;

        const str = (s: number, e: number): string => cleanText(meta.subarray(s, e).toString('utf8').replace(/^"|"$/g, ''));

        for (const x of entries(meta, top.vs, top.ve))
        {
            if (x.key === 'mods' && x.block)
                item.mods = [...entries(meta, x.vs, x.ve)].map((m) => str(m.vs, m.ve));
            else if (!x.block && x.key === 'meta_player_name')
                item.player = str(x.vs, x.ve);
            else if (!x.block && x.key === 'meta_title_name')
                item.title = str(x.vs, x.ve);
            else if (!x.block && x.key === 'meta_date')
                item.date = str(x.vs, x.ve);
            else if (!x.block && x.key === 'version')
                item.version = str(x.vs, x.ve);
            else if (!x.block && x.key === 'ironman')
                item.ironman = str(x.vs, x.ve) === 'yes';
        }
    }
    catch (e)
    {
        item.problem = e instanceof Error ? e.message : String(e);
    }

    return item;
}

/** The `.ck3` files of a folder, newest first. */
export function listSaves(dir: string, dataDir?: string): SaveListItem[]
{
    let names: string[];

    try
    {
        names = readdirSync(dir).filter((n) => /\.ck3$/i.test(n));
    }
    catch
    {
        return [];
    }

    return names.map((n) => saveItem(join(dir, n), dataDir)).sort((a, b) => b.mtime - a.mtime);
}
