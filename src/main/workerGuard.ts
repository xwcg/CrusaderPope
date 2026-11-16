/**
 * Watching a worker thread for its end (docs/app-architecture.md, "Workers that end"). A Worker that emits 'error'
 * without a listener rethrows it in the main process, and a worker that ran out of memory or exited leaves every
 * request it was handed unanswered: whoever owns the worker answers them from `gone`.
 */
import type { Worker } from 'node:worker_threads';

/**
 * Calls `gone` once when `w` is over, however: an uncaught error in it or running out of memory (`error` set; its
 * 'exit' follows and is not told again), or an exit without one (`exitCode`: also what `terminate()` gives, so an owner
 * that terminates workers itself must tell those from a crash).
 */
export function onWorkerGone(w: Worker, gone: (error: Error | undefined, exitCode: number | undefined) => void): void
{
    let told = false;
    const once = (error: Error | undefined, exitCode: number | undefined): void =>
    {
        if (told)
            return;

        told = true;
        gone(error, exitCode);
    };
    w.on('error', (error) => once(error, undefined));
    w.on('exit', (code) => once(undefined, code));
}
