/**
 * The files of a mod kept while a job reads them many times: a migration's rules each read the mod's files again (each of
 * AGOT's text files 6 to 26 times per plan or run, round 11). Inside `keepingTexts` a file is read once and its bytes kept;
 * outside, every call reads it. The bytes, not the decoded text: they live outside the V8 heap, which all threads of the main
 * process share (4 GB, docs/indexer.md "One heap for all threads"), and the index worker rebuilds the index during a run;
 * decoding again is the cheaper half (textCodec.ts' ASCII path). A file the app writes meanwhile (`writeAtomic`, a deletion) is
 * forgotten and read again; the kept bytes are bounded by `KEEP_MAX` (beyond it a file is read every time, as without the job),
 * and they go when the last job ends.
 */
import { resolve } from 'node:path';
import { decodeTextBody } from './textCodec.ts';

/** what the kept files may hold, in bytes (AGOT's 8,603 text files: 555 MB) */
const KEEP_MAX = 640e6;

const kept = new Map<string, Uint8Array>();
let keeps = 0;
let weight = 0;
/** the job maps (`jobMap`), emptied with the kept files */
const jobMaps: Map<unknown, unknown>[] = [];

/** Whether a job keeps files now (`keepingTexts`). */
export const inJob = (): boolean => keeps > 0;

/**
 * A map that holds while a job keeps files and is empty outside one: for what a job works out again and again from files it does
 * not write (the game's), never from the mod's or the patch mod's.
 */
export function jobMap<K, V>(): { get(key: K): V | undefined; set(key: K, value: V): void; }
{
    const map = new Map<K, V>();
    jobMaps.push(map as Map<unknown, unknown>);
    return {
        get: (key) => (keeps ? map.get(key) : undefined),
        set: (key, value) => void (keeps && map.set(key, value))
    };
}

/** A file's key: the same file however its path is spelled (Windows paths are not case sensitive); an archive's entry as named. */
const keyOf = (file: string, entry?: string): string =>
{
    const path = process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file);
    return entry === undefined ? path : `${path}|${entry}`;
};

/** Runs `work` with the files `keptText` reads kept until the last such job ends (jobs may nest and overlap). */
export async function keepingTexts<T>(work: () => Promise<T>): Promise<T>
{
    keeps++;

    try
    {
        return await work();
    }
    finally
    {
        if (--keeps === 0)
        {
            kept.clear();
            weight = 0;
            jobMaps.forEach((m) => m.clear());
        }
    }
}

/**
 * The text of a file without its byte order mark (`decodeTextBody`), its bytes kept while a job holds files. `file`: the file, or
 * the archive of `entry`; `read`: its bytes (undefined: no text, nothing kept).
 */
export function keptText(file: string, entry: string | undefined, read: () => Uint8Array | undefined): string | undefined
{
    if (!keeps)
    {
        const data = read();
        return data && decodeTextBody(data);
    }

    const key = keyOf(file, entry);
    let data = kept.get(key);

    if (!data)
    {
        data = read();

        if (!data)
            return undefined;

        if (weight + data.length <= KEEP_MAX)
        {
            kept.set(key, data);
            weight += data.length;
        }
    }

    return decodeTextBody(data);
}

/** A file the app wrote or deleted: its kept bytes, if any, are read again next time. */
export function forgetText(file: string): void
{
    if (!keeps)
        return;

    const key = keyOf(file);
    const have = kept.get(key);

    if (have)
    {
        kept.delete(key);
        weight -= have.length;
    }
}
