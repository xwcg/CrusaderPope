/**
 * Parse threads for a build (docs/indexer.md, "Parallel parsing"): script files go out in batches to a few threads
 * (parseWorker.ts), each returns what the files define and refer to (fileExtract.ts); the results come back in any
 * order; the caller applies them in file order.
 */
import { Worker } from 'node:worker_threads';
import type { ScriptExtract } from './fileExtract.ts';
import { tr } from '../../shared/i18n.ts';

/** A file to parse: where it is (a disk file, or a zip entry) and how the index reads it. */
export interface ParseJob
{
    /** its place in the caller's list */
    i: number;
    /** its index in GameIndex.files (the candidates carry it) */
    file: number;
    abs?: string;
    zip?: string;
    base?: number;
    entry?: string;
    area: string;
    type: string;
    hidden: boolean;
    /** the file's path (history/cultures: its name is the entry's) */
    rel: string;
}

export interface ParseReply
{
    batch: number;
    /** null: the file could not be read */
    results: { i: number; ex: ScriptExtract | null; }[];
}

const BATCH = 12;

/** A build's parsing stopped: a newer build started meanwhile (its results would be thrown away). */
export class ParseSuperseded extends Error
{
    constructor()
    {
        super(tr('superseded by a newer build'));
    }
}

export class ParsePool
{
    private readonly script: string;
    private readonly size: number;

    constructor(script: string, size: number)
    {
        this.script = script;
        this.size = Math.max(1, size);
    }

    /**
     * Parses the jobs; `onResult` gets each as it comes back. Threads end when all are done, or when `alive` says the
     * build was superseded (a newer one started): then it rejects with ParseSuperseded and sends nothing more.
     */
    run(jobs: ParseJob[], onResult: (i: number, ex: ScriptExtract | null) => void, alive: () => boolean = () => true): Promise<void>
    {
        if (!jobs.length)
            return Promise.resolve();

        const batches: ParseJob[][] = [];

        for (let k = 0; k < jobs.length; k += BATCH)
            batches.push(jobs.slice(k, k + BATCH));

        const threads = Math.min(this.size, batches.length);
        const workers: Worker[] = [];

        return new Promise<void>((resolve, reject) =>
        {
            let next = 0;
            let left = batches.length;
            let failed = false;
            // (settled once the threads are gone: their heaps count against the one the process's threads share;
            // docs/indexer.md "Parallel parsing")
            const finish = (e?: unknown): void =>
            {
                void Promise.allSettled(workers.map((w) => w.terminate())).then(() => (e ? reject(e) : resolve()));
            };
            const send = (w: Worker): void =>
            {
                if (next < batches.length)
                {
                    w.postMessage({ batch: next, jobs: batches[next] });
                    next++;
                }
            };

            for (let t = 0; t < threads; t++)
            {
                // (a limit of its own: a thread's default heap is small, and one parses a whole batch at a time)
                const w = new Worker(this.script, { resourceLimits: { maxOldGenerationSizeMb: 2048 } });
                workers.push(w);
                w.on('message', (r: ParseReply) =>
                {
                    if (failed)
                        return;

                    if (!alive())
                    {
                        failed = true;
                        finish(new ParseSuperseded());
                        return;
                    }

                    try
                    {
                        for (const x of r.results)
                            onResult(x.i, x.ex);
                    }
                    catch (e)
                    {
                        failed = true;
                        finish(e);
                        return;
                    }

                    send(w);

                    if (--left === 0)
                        finish();
                });
                w.on('error', (e) =>
                {
                    if (!failed)
                    {
                        failed = true;
                        finish(e);
                    }
                });
                // (two batches each in flight: a thread never waits for the next)
                send(w);
                send(w);
            }
        });
    }
}
