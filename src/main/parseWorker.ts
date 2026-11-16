/**
 * A parse thread of a build (docs/indexer.md, "Parallel parsing"): reads script files and extracts their definitions
 * and reference candidates (indexer/fileExtract.ts); the index worker applies them in file order. Started by
 * indexer/parsePool.ts.
 */
import { readFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { extractBuffers, extractScript } from './indexer/fileExtract.ts';
import type { ParseJob, ParseReply } from './indexer/parsePool.ts';
import { ZipArchive } from './mods/zip.ts';

const zips = new Map<string, ZipArchive>();

function read(j: ParseJob): string | undefined
{
    try
    {
        let buf: Buffer | undefined;

        if (j.abs)
            buf = readFileSync(j.abs);
        else if (j.zip && j.entry)
        {
            let z = zips.get(j.zip);

            if (!z)
                zips.set(j.zip, z = new ZipArchive(j.zip, j.base ?? 0));

            buf = z.readEntry(j.entry);
        }

        // (as GameFiles.readText: UTF-8 without a byte order mark)
        return buf?.toString('utf8').replace(/^﻿/, '');
    }
    catch
    {
        return undefined;
    }
}

parentPort!.on('message', (m: { batch: number; jobs: ParseJob[]; }) =>
{
    const reply: ParseReply = { batch: m.batch, results: [] };
    const transfer: ArrayBuffer[] = [];

    for (const j of m.jobs)
    {
        const src = read(j);
        const ex = src === undefined ? null : extractScript(src, j.area, j.type, j.hidden, j.file, j.rel);
        reply.results.push({ i: j.i, ex });

        if (ex)
            transfer.push(...extractBuffers(ex));
    }

    parentPort!.postMessage(reply, transfer);
});
