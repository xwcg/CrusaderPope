/**
 * "Fix for 1.20…" off Electron's main thread (docs/mods.md, "The migration worker"): the plan and the run of a mod's migration
 * run in a worker thread of their own (migrationWorker.ts); main only passes messages, so the window stays responsive while
 * the rules work through a mod's files, and Cancel is seen at once (a flag both threads read: the job looks at it where it
 * can stop).
 *
 * The job reaches the settings, the index, the folder watcher and the undo journal through main: the worker's ModsHost
 * forwards every call to main's. The calls ModsHost makes synchronous (the game folder, settings written, the watcher told
 * of a write before it is made, an undo step: undo.ts `ForwardedJournal`) wait in the worker until main has answered
 * (Atomics.wait; the answer comes on a port of its own); the others are messages. Main takes the worker's messages in the
 * order they were sent, so a re-index asked for before a wait for the index has started by then, as on one thread. The
 * settings come along with main's messages when they changed (numbered: the newest wins).
 *
 * One worker for the session (its memos of the game's files last as main's did), started by the first job; one that ends
 * (out of memory, a crash) fails the jobs it had, and the next job starts a new one. Plain Node.
 */
import { join } from 'node:path';
import { MessageChannel, Worker, parentPort, receiveMessageOnPort, workerData, type MessagePort } from 'node:worker_threads';
import type { MigrationPlan, MigrationProgress, MigrationResult, Settings } from '../../shared/api.ts';
import type { ModsHost } from './manager.ts';
import { onWorkerGone } from '../workerGuard.ts';
import { ForwardedJournal, takeForwarded, type JournalOp } from './undo.ts';
import { MigrationCancelled, migrateMod, planCancelled, planMigration, RunWrites, type MigrationRun } from './migrate.ts';
import { deleteFactStores, factsCode, saveFactStore, stopFactStore, useFactStore } from './gameFacts.ts';
import { tr } from '../../shared/i18n.ts';

/** The jobs of "Fix for 1.20…" (mods/ipc.ts): on a thread of their own (`MigrationThread`), or on the caller's (`jobsHere`). */
export interface MigrationJobs
{
    plan(modId: string, run: MigrationRun): Promise<MigrationPlan>;
    run(modId: string, run: MigrationRun): Promise<MigrationResult>;
    /** the running job stops where it looks for a cancel (its `cancelled` says so) */
    cancel(): void;
}

/** The jobs on the calling thread: `cancelled` is the run's own. */
export function jobsHere(host: ModsHost): MigrationJobs
{
    return {
        plan: (modId, run) => planMigration(host, modId, { cancelled: run.cancelled }),
        run: (modId, run) => migrateMod(host, modId, run),
        cancel: () => undefined
    };
}

// the flags both threads read (an Int32Array over a SharedArrayBuffer): the job's cancel, a synchronous call answered
const CANCEL = 0;
const ANSWERED = 1;

/** The calls of the worker's host that wait for main's answer (ModsHost's synchronous ones). */
type SyncCall = 'gameDir' | 'documents' | 'dataDir' | 'updateSettings' | 'wrote' | 'journal';
/** The calls that are answered by a message (ModsHost's promises). */
type AsyncCall = 'query' | 'refreshFiles' | 'ready' | 'trash' | 'launcherRunning';

/** Which optional calls main's host has: the worker's host has the same, so `host.x?.()` and `if (host.x)` decide alike. */
interface HostShape
{
    query: boolean;
    wrote: boolean;
    refreshFiles: boolean;
    ready: boolean;
    dataDir: boolean;
    trash: boolean;
    launcherRunning: boolean;
}

interface WorkerSetup
{
    flags: SharedArrayBuffer;
    /** the worker's end of the port synchronous calls are answered on */
    answers: MessagePort;
    shape: HostShape;
}

/** What main sends: a job, an answer to a call, a cancel; the first two may bring the settings (`version`: the newest wins). */
type ToWorker = { settings?: Settings; version?: number; } & (
    | { job: number; kind: 'plan'; modId: string; }
    | { job: number; kind: 'run'; modId: string; restore?: string[]; }
    | { reply: number; result?: unknown; error?: string; }
    | { result?: unknown; error?: string; }
    | { cancel: true; });

/** What the worker sends: a job's progress and end, its host's calls. */
type FromWorker =
    | { job: number; progress: MigrationProgress; }
    | { job: number; done: unknown; }
    | { job: number; failed: { message: string; stack?: string; cancelled: boolean; }; }
    | { sync: SyncCall; args: unknown[]; }
    | { call: number; method: AsyncCall; args: unknown[]; }
    | { reindex: true; };

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The jobs on the migration worker (main's side). `file`: the worker's script (the app: migrationWorker.js beside index.js). */
export class MigrationThread implements MigrationJobs
{
    private worker?: Worker;
    private answers?: MessagePort;
    private readonly flags = new Int32Array(new SharedArrayBuffer(8));
    private readonly jobs = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void; progress?: (p: MigrationProgress) => void; }>();
    private seq = 0;
    /** the settings the worker has (`version` numbers them) */
    private sent?: Settings;
    private version = 0;
    /**
     * what the jobs wrote or deleted (their `wrote` calls) and did not hand to the index (their `refreshFiles` calls, a re-index):
     * a run hands that over itself at its end, also after a Cancel or an error; a worker that crashes cannot, so main does
     */
    private writes = new RunWrites();

    private readonly file: string;
    private readonly host: ModsHost;
    /** more for the worker's workerData (a script's own worker entry reads it) */
    private readonly extra: Record<string, unknown>;

    constructor(file: string, host: ModsHost, extra: Record<string, unknown> = {})
    {
        this.file = file;
        this.host = host;
        this.extra = extra;
    }

    plan(modId: string, run: MigrationRun): Promise<MigrationPlan>
    {
        return this.start({ kind: 'plan', modId }, run);
    }

    run(modId: string, run: MigrationRun): Promise<MigrationResult>
    {
        return this.start({ kind: 'run', modId, restore: run.restore }, run);
    }

    cancel(): void
    {
        Atomics.store(this.flags, CANCEL, 1);
        // (a plan waiting for the index stops waiting: serveMigrations)
        this.worker?.postMessage({ cancel: true } satisfies ToWorker);
    }

    private start<T>(msg: { kind: 'plan'; modId: string; } | { kind: 'run'; modId: string; restore?: string[]; }, run: MigrationRun): Promise<T>
    {
        const w = this.ensure();
        const job = ++this.seq;
        // (a cancel is for the job it reaches: each job starts without one, as mods/ipc.ts's long tasks do)
        Atomics.store(this.flags, CANCEL, 0);
        w.ref();
        return new Promise<T>((resolve, reject) =>
        {
            this.jobs.set(job, { resolve: resolve as (v: never) => void, reject, progress: run.progress });

            try
            {
                this.send(w, { job, ...msg });
            }
            catch (e)
            {
                this.jobs.delete(job);
                reject(e as Error);
            }
        });
    }

    /** Posts to the worker (or on the answers port), with the settings when they changed since it last had them. */
    private send(to: { postMessage(m: unknown): void; }, msg: ToWorker): void
    {
        const s = this.host.settings();

        if (s !== this.sent)
        {
            this.sent = s;
            msg.settings = s;
            msg.version = ++this.version;
        }

        to.postMessage(msg);
    }

    private ensure(): Worker
    {
        if (this.worker)
            return this.worker;

        const { port1, port2 } = new MessageChannel();
        const shape: HostShape = {
            query: !!this.host.query, wrote: !!this.host.wrote, refreshFiles: !!this.host.refreshFiles, ready: !!this.host.ready,
            dataDir: !!this.host.dataDir, trash: !!this.host.trash, launcherRunning: !!this.host.launcherRunning
        };
        const setup: WorkerSetup = { flags: this.flags.buffer as SharedArrayBuffer, answers: port2, shape };
        // (a young generation of 192 MB, as the index worker's: the rules make short-lived texts and parse trees; the old
        // generation is bounded by the 4 GB all threads of the process share, docs/indexer.md "One heap for all threads")
        const w = new Worker(this.file, {
            workerData: { ...this.extra, ...setup },
            transferList: [port2],
            resourceLimits: { maxOldGenerationSizeMb: 4096, maxYoungGenerationSizeMb: 192 }
        });
        this.worker = w;
        this.answers = port1;
        // (a new worker has no settings yet)
        this.sent = undefined;
        w.on('message', (m: FromWorker) => this.message(w, m));
        onWorkerGone(w, (error) =>
        {
            if (this.worker !== w)
                return;

            this.worker = undefined;
            this.answers?.close();
            this.answers = undefined;
            const why = new Error(error ? tr('The migration worker crashed: ') + error.message : tr('The migration worker stopped.'));
            // (the files its run wrote that no step handed to the index yet: the run's end would have; once, before the job fails, so the
            // plan the dialog reads next sees them)
            const left = this.writes.pending();
            this.writes = new RunWrites();
            const handed = left.length && this.host.refreshFiles ? this.host.refreshFiles(left).catch(() => undefined) : Promise.resolve();
            const jobs = [...this.jobs.values()];
            this.jobs.clear();
            void handed.then(() => jobs.forEach((j) => j.reject(why)));
        });
        return w;
    }

    private message(w: Worker, m: FromWorker): void
    {
        if ('sync' in m)
        {
            this.answer(m.sync, m.args);
            return;
        }

        if ('call' in m)
        {
            void this.serve(w, m.call, m.method, m.args);
            return;
        }

        if ('reindex' in m)
        {
            this.writes.reindexed();
            this.host.reindex();
            return;
        }

        const job = this.jobs.get(m.job);

        if (!job)
            return;

        if ('progress' in m)
        {
            job.progress?.(m.progress);
            return;
        }

        this.jobs.delete(m.job);

        // (a job that ended, however, handed its files over itself: migrate.ts finishRun)
        if (!this.jobs.size)
        {
            this.writes = new RunWrites();
            w.unref();
        }

        if ('done' in m)
        {
            job.resolve(m.done as never);
            return;
        }

        const e = m.failed.cancelled ? new MigrationCancelled(m.failed.message) : new Error(m.failed.message);

        if (m.failed.stack)
            e.stack = m.failed.stack;

        job.reject(e);
    }

    /** A synchronous call of the worker's host: answered on the answers port, then the worker is woken. */
    private answer(call: SyncCall, args: unknown[]): void
    {
        let reply: ToWorker;

        try
        {
            reply = { result: this.syncCall(call, args) };
        }
        catch (e)
        {
            reply = { error: messageOf(e) };
        }

        try
        {
            this.send(this.answers!, reply);
        }
        catch (e)
        {
            // (an answer that cannot be sent: the worker must not wait for ever)
            this.answers!.postMessage({ error: messageOf(e) });
        }

        Atomics.store(this.flags, ANSWERED, 1);
        Atomics.notify(this.flags, ANSWERED);
    }

    private syncCall(call: SyncCall, args: unknown[]): unknown
    {
        switch (call)
        {
            case 'gameDir':
                return this.host.gameDir();
            case 'documents':
                return this.host.documents();
            case 'dataDir':
                return this.host.dataDir?.();
            case 'updateSettings':
                this.host.updateSettings(args[0] as Partial<Settings>);
                // (sent with the answer even when the host changed its settings object in place, as scripts' hosts do)
                this.sent = undefined;
                return undefined;
            case 'wrote':
                this.writes.wrote(args[0] as string[]);
                this.host.wrote?.(args[0] as string[]);
                return undefined;
            case 'journal':
                return takeForwarded(this.host, args[0] as JournalOp, args[1] as unknown[]);
        }
    }

    /** A call of the worker's host that main answers by a message, when it is done. */
    private async serve(w: Worker, id: number, method: AsyncCall, args: unknown[]): Promise<void>
    {
        let reply: ToWorker;

        try
        {
            reply = { reply: id, result: await this.asyncCall(method, args) };
        }
        catch (e)
        {
            reply = { reply: id, error: messageOf(e) };
        }

        // (a worker that ended meanwhile asks nothing any more)
        if (this.worker !== w)
            return;

        try
        {
            this.send(w, reply);
        }
        catch (e)
        {
            this.send(w, { reply: id, error: messageOf(e) });
        }
    }

    private asyncCall(method: AsyncCall, args: unknown[]): Promise<unknown>
    {
        switch (method)
        {
            case 'query':
                return this.host.query!(args[0] as string, ...args.slice(1));
            case 'refreshFiles':
                this.writes.indexed(args[0] as string[]);
                return this.host.refreshFiles!(args[0] as string[]);
            case 'ready':
                return this.host.ready!();
            case 'trash':
                return this.host.trash!(args[0] as string);
            case 'launcherRunning':
                return this.host.launcherRunning!();
        }
    }
}

/**
 * The worker's side (migrationWorker.ts): the jobs main sends, run on a host that forwards to main's. `watch.checked` is told of
 * every look at the cancel flag (a script measuring how soon a cancel is seen).
 */
export function serveMigrations(watch: { checked?(): void; } = {}): void
{
    const port = parentPort!;
    const setup = workerData as WorkerSetup;
    const flags = new Int32Array(setup.flags);
    const answers = setup.answers;
    let settings: Settings | undefined;
    let version = 0;
    const take = (m: { settings?: Settings; version?: number; }): void =>
    {
        if (m.version !== undefined && m.version > version)
        {
            version = m.version;
            settings = m.settings;
        }
    };

    // (a call ModsHost makes synchronous: main answers on the answers port and wakes this thread; one at a time, this thread waits)
    const sync = (call: SyncCall, args: unknown[]): unknown =>
    {
        Atomics.store(flags, ANSWERED, 0);
        port.postMessage({ sync: call, args } satisfies FromWorker);
        let got: { message: { result?: unknown; error?: string; settings?: Settings; version?: number; }; } | undefined;

        while (!(got = receiveMessageOnPort(answers)))
            Atomics.wait(flags, ANSWERED, 0);

        take(got.message);

        if (got.message.error !== undefined)
            throw new Error(got.message.error);

        return got.message.result;
    };

    let calls = 0;
    const waiting = new Map<number, { method: AsyncCall; resolve: (v: unknown) => void; reject: (e: Error) => void; }>();
    const call = <T>(method: AsyncCall, args: unknown[]): Promise<T> => new Promise<T>((resolve, reject) =>
    {
        const id = ++calls;
        waiting.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
        port.postMessage({ call: id, method, args } satisfies FromWorker);
    });
    // (plan jobs running: a cancel ends their waits for the index's answers at once, a plan writes nothing; the index worker
    // finishes the query, its answer is dropped. A run's waits stay: what it does next needs the index anyway)
    let planning = 0;

    const shape = setup.shape;
    const host: ModsHost = {
        settings: () => settings!,
        updateSettings: (patch) => void sync('updateSettings', [patch]),
        gameDir: () => sync('gameDir', []) as string | null,
        documents: () => sync('documents', []) as string,
        reindex: () => port.postMessage({ reindex: true } satisfies FromWorker),
        undoJournal: () => journal,
        ...(shape.query ? { query: <T>(method: string, ...params: unknown[]) => call<T>('query', [method, ...params]) } : {}),
        ...(shape.wrote ? { wrote: (files: string[]) => void sync('wrote', [files]) } : {}),
        ...(shape.refreshFiles ? { refreshFiles: (files: string[]) => call<void>('refreshFiles', [files]) } : {}),
        ...(shape.ready ? { ready: () => call<void>('ready', []) } : {}),
        ...(shape.dataDir ? { dataDir: () => sync('dataDir', []) as string } : {}),
        ...(shape.trash ? { trash: (path: string) => call<void>('trash', [path]) } : {}),
        ...(shape.launcherRunning ? { launcherRunning: () => call<string | null | undefined>('launcherRunning', []) } : {})
    };
    const journal = new ForwardedJournal((op, args) => sync('journal', [op, args]));

    const runJob = async (m: { job: number; kind: 'plan'; modId: string; } | { job: number; kind: 'run'; modId: string; restore?: string[]; }): Promise<void> =>
    {
        const run: MigrationRun = {
            progress: (p) => port.postMessage({ job: m.job, progress: p } satisfies FromWorker),
            cancelled: () =>
            {
                watch.checked?.();
                return Atomics.load(flags, CANCEL) !== 0;
            },
            ...(m.kind === 'run' && m.restore ? { restore: m.restore } : {})
        };

        if (m.kind === 'plan')
            planning++;

        // (the game facts of this thread kept next to the index cache while the cache is on: gameFacts.ts)
        const code = factsCode();
        const dir = host.dataDir?.();

        if (code && dir && host.settings().indexCache !== false)
            useFactStore(join(dir, 'index-cache', 'game-facts-migration.bin'), code);
        else if (code && dir)
        {
            stopFactStore();
            deleteFactStores(join(dir, 'index-cache'));
        }

        try
        {
            const done = m.kind === 'plan' ? await planMigration(host, m.modId, { cancelled: run.cancelled }) : await migrateMod(host, m.modId, run);
            port.postMessage({ job: m.job, done } satisfies FromWorker);
        }
        catch (e)
        {
            port.postMessage({ job: m.job, failed: { message: messageOf(e), stack: e instanceof Error ? e.stack : undefined, cancelled: e instanceof MigrationCancelled } } satisfies FromWorker);
        }
        finally
        {
            if (m.kind === 'plan')
                planning--;

            // (after the answer is sent: the dialog does not wait for the file)
            saveFactStore();
        }
    };

    port.on('message', (m: ToWorker) =>
    {
        take(m);

        if ('cancel' in m)
        {
            for (const [id, w] of planning ? waiting : [])
                if (w.method === 'query')
                {
                    waiting.delete(id);
                    w.reject(planCancelled());
                }
        }
        else if ('reply' in m)
        {
            const w = waiting.get(m.reply);
            waiting.delete(m.reply);

            if (m.error !== undefined)
                w?.reject(new Error(m.error));
            else
                w?.resolve(m.result);
        }
        else if ('job' in m)
            void runJob(m);
    });
}
