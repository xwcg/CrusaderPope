/**
 * Compiler threads (shaderWorker.ts): Effects compile in parallel, off the index worker — indexing's shader phase
 * uses several cores and an on-demand compile never holds up queries. Threads start on first use and end after a
 * minute without work.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { ModInfo, ShaderProgram, ShaderRequest } from '../../shared/api.ts';

interface Thread
{
    w: Worker;
    busy: number;
}

/** Rejection of requests dropped by terminate(): not a compile failure (the store must not remember it). */
export class CancelledError extends Error
{
    constructor()
    {
        super('Shader compilation cancelled');
    }
}

export class ShaderPool
{
    private threads: Thread[] = [];
    private pending = new Map<number, { resolve: (p: ShaderProgram) => void; reject: (e: Error) => void; t: Thread; }>();
    private seq = 0;
    private idle: ReturnType<typeof setTimeout> | null = null;
    private hash: string | undefined;
    // plain fields, no parameter properties: scripts load store.ts, which imports this file, with strip-types
    private readonly script: string;
    private readonly files: { gameDir: string; mods: ModInfo[]; };
    private readonly size: number;

    /** @param files what each thread layers for its ShaderLibrary: the game folder and the loaded mods in load order */
    constructor(script: string, files: { gameDir: string; mods: ModInfo[]; }, size: number)
    {
        this.script = script;
        this.files = files;
        this.size = size;
    }

    /**
     * The compiler's code: a hash of the thread script (the compiler is bundled there, not into the index worker) —
     * part of the store's fingerprint, so a changed compiler compiles afresh.
     */
    get version(): string
    {
        if (this.hash === undefined)
        {
            try
            {
                this.hash = createHash('sha1').update(readFileSync(this.script)).digest('hex');
            }
            catch
            {
                this.hash = '';
            }
        }

        return this.hash;
    }

    compile(req: ShaderRequest): Promise<ShaderProgram>
    {
        this.start();

        if (this.idle)
        {
            clearTimeout(this.idle);
            this.idle = null;
        }

        let t = this.threads[0];

        for (const x of this.threads)
            if (x.busy < t.busy)
                t = x;

        t.busy++;
        const id = ++this.seq;
        return new Promise((resolve, reject) =>
        {
            this.pending.set(id, { resolve, reject, t });
            t.w.postMessage({ id, req });
        });
    }

    terminate(): void
    {
        if (this.idle)
            clearTimeout(this.idle);

        this.idle = null;

        for (const t of this.threads)
            void t.w.terminate();

        this.threads = [];

        for (const p of this.pending.values())
            p.reject(new CancelledError());

        this.pending.clear();
    }

    private start(): void
    {
        for (let i = this.threads.length; i < this.size; i++)
        {
            const t: Thread = { w: new Worker(this.script, { workerData: this.files }), busy: 0 };
            t.w.on('message', (m: { id: number; program?: ShaderProgram; error?: string; }) =>
            {
                const p = this.pending.get(m.id);

                if (!p)
                    return;

                this.pending.delete(m.id);
                p.t.busy--;

                if (m.error !== undefined)
                    p.reject(new Error(m.error));
                else
                    p.resolve(m.program!);

                if (!this.pending.size)
                    this.armIdle();
            });
            // a crashed thread fails its requests; the next compile starts a replacement
            t.w.on('error', (err) =>
            {
                this.threads = this.threads.filter((x) => x !== t);

                for (const [id, p] of this.pending)
                {
                    if (p.t !== t)
                        continue;

                    this.pending.delete(id);
                    p.reject(err);
                }
            });
            this.threads.push(t);
        }
    }

    private armIdle(): void
    {
        if (this.idle)
            clearTimeout(this.idle);

        this.idle = setTimeout(() =>
        {
            if (!this.pending.size)
                this.terminate();
        }, 60_000);
    }
}
