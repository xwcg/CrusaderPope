/**
 * One key scan thread (scriptKeysWorker.ts) as the index worker sees it (docs/app-architecture.md, "Workers that
 * end"): its Worker, its own queue of requests, and its end. Each thread answers only its own requests, in the order
 * they were made (the first answer is the scan or the cached keys, then one per rescan), so the late answer of an
 * older build's thread never settles a newer thread's request.
 *
 * It ends, rejecting what is still waiting:
 * - when its owner closes it (a new build: `close(reason)`);
 * - after an `{error}` answer (the scanner's state is unknown after a failure);
 * - when the thread dies or exits (an uncaught error, out of memory, an exit; onWorkerGone);
 * - after its first answer when it does not stay (no editable mod loaded: nothing will be rescanned).
 */
import { Worker } from 'node:worker_threads';
import { onWorkerGone } from './workerGuard.ts';
import type { ModInfo, ScriptKeys } from '../shared/api.ts';
import { tr } from '../shared/i18n.ts';
import type { ScriptFacts } from '../shared/scriptFacts.ts';

/** What the thread is started with (scriptKeysWorker.ts `Job`). */
export interface KeyScanJob
{
    gameDir: string;
    mods: ModInfo[];
    /**
     * Cache file and the index fingerprint it must carry (absent: no cache). `read: false`: the files changed since
     * that fingerprint was taken (an update before the recache), so the cache is neither read nor written under it.
     */
    cache?: { file: string; fingerprint: string; read?: boolean; };
    /** the script database's facts (its links are scope switches for the scan; docs/script-database.md) */
    facts?: ScriptFacts | null;
}

interface Waiting
{
    resolve: (k: ScriptKeys) => void;
    reject: (e: Error) => void;
}

export class KeyScanThread
{
    /** whether it stays after its first answer for rescans (an editable mod loaded) */
    readonly stays: boolean;
    /** the first answer: the scan, or the keys cached under the job's fingerprint */
    readonly first: Promise<ScriptKeys>;
    private readonly worker: Worker;
    private readonly pending: Waiting[] = [];
    private ended = false;
    private readonly onEnd?: (t: KeyScanThread) => void;

    /** @param script the thread's file (a check passes a fake one) @param onEnd told once when the thread is over */
    constructor(script: string, job: KeyScanJob, stays: boolean, onEnd?: (t: KeyScanThread) => void)
    {
        this.stays = stays;
        this.onEnd = onEnd;
        this.first = new Promise<ScriptKeys>((resolve, reject) => this.pending.push({ resolve, reject }));
        // (nobody may ask for the first answer: an end before it is no unhandled rejection)
        this.first.catch(() => undefined);
        this.worker = new Worker(script, { workerData: job });
        this.worker.on('message', (m: { keys?: ScriptKeys; error?: string; }) => this.answer(m));
        onWorkerGone(this.worker, (error, exitCode) =>
        {
            if (!this.ended)
                this.end(error ?? new Error(tr('The key scan thread ended (exit code {code})', { code: exitCode ?? '?' })), false);
        });
    }

    /** over: closed, failed or gone (a request then needs a new thread) */
    get dead(): boolean
    {
        return this.ended;
    }

    /** The keys again after the files `rels` changed (a staying thread only; rejects when the thread is over). */
    rescan(rels: string[]): Promise<ScriptKeys>
    {
        if (this.ended || !this.stays)
            return Promise.reject(new Error(tr('The key scan thread is not running')));

        const p = new Promise<ScriptKeys>((resolve, reject) => this.pending.push({ resolve, reject }));
        this.worker.postMessage({ rescan: rels });
        return p;
    }

    /** Writes the keys as they are now under the index's new fingerprint (after the recache). */
    writeCache(cache: { file: string; fingerprint: string; }): void
    {
        if (!this.ended)
            this.worker.postMessage({ cache });
    }

    /** Ends the thread: terminated, every request still waiting rejected with `reason`. */
    close(reason: string): void
    {
        if (!this.ended)
            this.end(new Error(reason), true);
    }

    private answer(m: { keys?: ScriptKeys; error?: string; }): void
    {
        if (this.ended)
            return;

        const p = this.pending.shift();

        if (m.keys)
        {
            p?.resolve(m.keys);

            if (!this.stays)
                this.end(new Error(tr('The key scan thread is not running')), true);
        }
        else
        {
            const err = new Error(m.error ?? tr('No script keys'));
            p?.reject(err);
            this.end(err, true);
        }
    }

    private end(err: Error, terminate: boolean): void
    {
        this.ended = true;

        if (terminate)
            void this.worker.terminate();

        for (const p of this.pending.splice(0))
            p.reject(err);

        this.onEnd?.(this);
    }
}
