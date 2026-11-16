// Checks src/main/workerGuard.ts (docs/app-architecture.md, "Workers that end"): how a worker thread's end reaches its
// owner (an uncaught error, running out of memory, process.exit in the worker, terminate()), each told once, with
// the error when there is one; and that the owner's requests can be failed from it (the pattern index.ts and
// imageService.ts use: a pending map, rejected when the worker is gone).
// Usage: node --experimental-strip-types --no-warnings scripts/worker-guard-check.ts
import { Worker } from 'node:worker_threads';
import { onWorkerGone } from '../src/main/workerGuard.ts';

let failed = 0;
const check = (ok: boolean, what: string): void =>
{
    console.log((ok ? 'ok   ' : 'FAIL ') + what);

    if (!ok)
        failed++;
};

interface Told
{
    times: number;
    error?: Error;
    code?: number;
}

/** A worker running `code`; resolves when the guard has told its end (and a little later, for a second telling). */
async function run(code: string, limits?: { maxOldGenerationSizeMb: number; }, after?: (w: Worker) => void): Promise<Told>
{
    const told: Told = { times: 0 };
    const w = new Worker(code, { eval: true, resourceLimits: limits });
    await new Promise<void>((done) =>
    {
        onWorkerGone(w, (error, exitCode) =>
        {
            told.times++;
            told.error = error;
            told.code = exitCode;
            done();
        });
        after?.(w);
    });
    await new Promise((r) => setTimeout(r, 200));
    return told;
}

let t = await run('throw new Error("boom");');
check(t.times === 1 && t.error?.message === 'boom', 'an uncaught error is told once, with the error');

t = await run('process.exit(3);');
check(t.times === 1 && !t.error && t.code === 3, 'process.exit(3) is told once, with the exit code');

t = await run('setInterval(() => {}, 1000);', undefined, (w) => void setTimeout(() => void w.terminate(), 100));
check(t.times === 1 && !t.error && t.code === 1, 'terminate() is told once as an exit (the owner tells it from a crash by what it terminated)');

t = await run('const keep = []; for (;;) keep.push(new Array(1e5).fill(Math.random()));', { maxOldGenerationSizeMb: 64 });
check(t.times === 1 && (t.error as NodeJS.ErrnoException | undefined)?.code === 'ERR_WORKER_OUT_OF_MEMORY','running out of memory is told once, with the error');

// the owner's pattern: requests of a worker that ends fail at once instead of waiting for an answer
{
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; }>();
    const w = new Worker('const { parentPort } = require("node:worker_threads"); parentPort.on("message", (m) => { if (m.id === 1) parentPort.postMessage({ id: 1, result: "answer" }); else throw new Error("worker fell over"); });', { eval: true });
    w.on('message', (m: { id: number; result: unknown; }) =>
    {
        pending.get(m.id)?.resolve(m.result);
        pending.delete(m.id);
    });
    const gone = new Promise<void>((done) => onWorkerGone(w, (error) =>
    {
        for (const p of pending.values())
            p.reject(error ?? new Error('stopped'));

        pending.clear();
        done();
    }));
    const ask = (id: number): Promise<unknown> => new Promise((resolve, reject) =>
    {
        pending.set(id, { resolve, reject });
        w.postMessage({ id });
    });
    const first = await ask(1);
    const second = ask(2).then(() => 'answered', (e: Error) => e.message);
    const third = ask(3).then(() => 'answered', (e: Error) => e.message);
    await gone;
    check(first === 'answer', 'a request before the end is answered');
    check((await second) === 'worker fell over' && (await third) === 'worker fell over', 'requests in flight when the worker falls over are rejected with its error');
    check(pending.size === 0, 'no request is left pending');
}

console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
