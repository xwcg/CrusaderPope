// The index worker's memory through full builds, run as the app runs it: the bundled worker (esbuild of
// src/main/indexWorker.ts and its sibling threads, made here in a TEMP folder) in a Worker with the app's resource
// limits, sent the same `build` request. Polls the worker's heap (worker.getHeapStatistics) and the process's resident
// set, prints the heap at each stage and the peaks, and asks for a full GC when a build is ready (`live`) so the
// index's own size shows apart from garbage. `rebuild`: a second `build` request while the first index is ready (what
// the app does when a mod list changes); `cached`: then a build that loads the index cache the first one wrote (the app's start); `queries`: first open the views a user opens (the characters list …).
// Run it under Electron's V8 (pointer compression, the 4 GB cage; the numbers match the app's):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe --expose-gc scripts/index-worker-memory.ts [agot] [threads=N] [rebuild] [cached] [queries] [limit=MB]
// `limit=MB`: the worker's old-space limit (the app uses 6144, in effect ~4.4 GB): the smallest one a build survives shows what it needs live.
// `agot`: layered over A Game of Thrones (Workshop 2962333032, read only). `bundle=<dir>`: use a bundle made earlier.
// The index cache is not used (a full parse each time); the shader threads run as in the app.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ModInfo } from '../src/shared/api.ts';
import { parseDescriptor } from '../src/main/mods/descriptor.ts';
import { parseThreadCount } from '../src/shared/parseThreads.ts';
import { defaultInstall, workshopFolder } from './ck3-install.ts';

const MB = 1048576;
const root = resolve(import.meta.dirname, '..');
const threadsArg = process.argv.find((a) => a.startsWith('threads='));
const threads = threadsArg ? Number(threadsArg.slice(8)) : undefined;
const bundleArg = process.argv.find((a) => a.startsWith('bundle='));
const limitArg = process.argv.find((a) => a.startsWith('limit='));
const limit = limitArg ? Number(limitArg.slice(6)) : 6144;
const mods: ModInfo[] = [];

if (process.argv.includes('agot'))
{
    const dir = join(workshopFolder(), '2962333032');
    const d = parseDescriptor(readFileSync(join(dir, 'descriptor.mod'), 'utf8'));
    mods.push({ id: 'mod/ugc_2962333032.mod', name: d.name, tags: [], root: dir, source: 'steam', replacePaths: d.replacePaths, status: 'ok', editable: false });
}

// (the same bundle the app's build makes of the worker and its threads, without its other entries)
let bundle: string;

if (bundleArg)
    bundle = bundleArg.slice(7);
else
{
    bundle = mkdtempSync(join(tmpdir(), 'ckp-memtest-'));
    // (what this run made is removed when it ends, a failed one too: its own bundle folder and the cache file; a `bundle=<dir>` given stays)
    process.on('exit', () =>
    {
        try
        {
            rmSync(bundle, { recursive: true, force: true });
            rmSync(join(tmpdir(), 'ckp-memtest-cache'), { recursive: true, force: true });
        }
        catch { /* (a file still held: left in %TEMP%) */ }
    });
    const entries = ['indexWorker', 'parseWorker', 'cacheWriter', 'scriptKeysWorker', 'shaderWorker', 'mapWorker', 'mapTerrainWorker', 'mapOverlaysWorker', 'imageWorker'].map((n) => join(root, 'src/main', n + '.ts'));
    execFileSync(
        join(root, 'node_modules/.bin/esbuild.cmd'),
        [...entries, '--bundle', '--platform=node', '--format=cjs', '--target=node24', `--outdir=${bundle}`, '--define:__INDEX_CODE__="memtest"', '--external:electron', '--log-level=warning'],
        { stdio: 'inherit', shell: true }
    );
}

const code = `const { parentPort } = require('node:worker_threads');
parentPort.on('message', (m) => { if (m && m.gc) { gc(); gc(); parentPort.postMessage({ gcDone: m.gc }); } });
require(${JSON.stringify(join(bundle, 'indexWorker.js'))});`;
const worker = new Worker(code, { eval: true, resourceLimits: { maxOldGenerationSizeMb: limit } });
const sampler = new Worker(
    `const { parentPort } = require('node:worker_threads');
let peak = 0;
setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 15);
parentPort.on('message', () => { const p = peak; peak = 0; parentPort.postMessage(p); });`,
    { eval: true }
);
const peakRss = (): Promise<number> =>
    new Promise((res) =>
    {
        sampler.once('message', (p: number) => res(p));
        sampler.postMessage('reset');
    });

interface Status
{
    state: string;
    phase?: string;
    message?: string;
}

let status: Status = { state: 'idle' };
let ready: (() => void) | null = null;
const pending = new Map<number, (m: { result?: unknown; error?: string; }) => void>();
let gcWaiter: (() => void) | null = null;
worker.on('message', (m: { id?: number; status?: Status; result?: unknown; error?: string; gcDone?: number; log?: unknown; }) =>
{
    if (m.gcDone)
        gcWaiter?.();
    else if (m.status)
    {
        status = m.status;

        if (status.state === 'ready' || status.state === 'error')
            ready?.();
    }
    else if (m.id !== undefined)
        pending.get(m.id)?.(m);
});
worker.on('error', (e) =>
{
    console.log('WORKER ERROR', String(e).slice(0, 300));
    process.exit(2);
});

let reqId = 0;
const call = (method: string, ...params: unknown[]): Promise<unknown> =>
    new Promise((res, rej) =>
    {
        const id = ++reqId;
        pending.set(id, (m) => (m.error ? rej(new Error(m.error)) : res(m.result)));
        worker.postMessage({ id, method, params });
    });
const heap = async (): Promise<{ used: number; total: number; }> =>
{
    const h = await worker.getHeapStatistics();
    return { used: h.used_heap_size / MB, total: h.total_heap_size / MB };
};
const gcNow = (): Promise<void> =>
    new Promise((res) =>
    {
        gcWaiter = res;
        worker.postMessage({ gc: 1 });
    });
const mem = (): string => `rss ${(process.memoryUsage().rss / MB).toFixed(0)} MB`;

/** Runs one build to its end, polling: the heap at each phase's first sight, the peak seen. */
async function buildOnce(tag: string, force = true): Promise<void>
{
    await peakRss();
    const t0 = performance.now();
    const seen = new Map<string, { at: number; used: number; rss: number; }>();
    let peak = 0;
    let peakAt = '';
    const done = new Promise<void>((res) => (ready = res));
    const timer = setInterval(() =>
    {
        void heap().then((h) =>
        {
            const phase = status.phase ?? status.state;

            if (h.used > peak)
            {
                peak = h.used;
                peakAt = phase;
            }

            if (!seen.has(phase))
                seen.set(phase, { at: performance.now() - t0, used: h.used, rss: process.memoryUsage().rss / MB });
        }, () => undefined);
    }, 100);
    status = { state: 'indexing' };
    const cache = { file: join(tmpdir(), 'ckp-memtest-cache', 'index.bin'), code: 'memtest', enabled: true, force };
    void call('build', defaultInstall(), 'english', cache, mods, undefined, threads);
    await done;
    clearInterval(timer);
    const ms = performance.now() - t0;
    const rss = await peakRss();

    if (status.state === 'error')
    {
        console.log(`${tag}: ERROR ${status.message?.slice(0, 400)}`);
        process.exit(1);
    }

    console.log(`${tag}: ready after ${(ms / 1000).toFixed(1)} s; worker heap peak ${peak.toFixed(0)} MB (during "${peakAt}"); process rss peak ${(rss / MB).toFixed(0)} MB`);

    for (const [phase, s] of seen)
        console.log(`    ${(s.at / 1000).toFixed(1).padStart(5)} s  ${phase.padEnd(34)} heap ${s.used.toFixed(0).padStart(5)} MB   rss ${s.rss.toFixed(0).padStart(5)} MB`);

    const before = await heap();
    await gcNow();
    const after = await heap();
    console.log(`    ready: heap ${before.used.toFixed(0)} MB, live after GC ${after.used.toFixed(0)} MB (total ${after.total.toFixed(0)} MB); ${mem()}`);
}

/** What a user opens first: lists, a few cards, the character table, the map data. */
async function queries(): Promise<void>
{
    const t0 = performance.now();
    await call('types');
    await call('list', 'traits');
    await call('characterFacets');
    await call('characterFilter', {});
    await call('detail', 'traits', 'brave');
    console.log(`    queries: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    const h = await heap();
    await gcNow();
    const a = await heap();
    console.log(`    after queries: heap ${h.used.toFixed(0)} MB, live ${a.used.toFixed(0)} MB; ${mem()}`);
}

console.log(`${mods.length ? 'with ' + mods[0].name : 'vanilla'}, parse threads ${threads === undefined ? 'automatic (' + parseThreadCount(undefined, availableParallelism()) + ')' : threads}, ${process.versions.electron ? 'Electron' : 'Node'} ${process.version}, bundle ${bundle}`);
await buildOnce('build 1');

if (process.argv.includes('queries'))
    await queries();

if (process.argv.includes('cached'))
{
    // (the cache file is written a moment after the build is ready)
    await new Promise((res) => setTimeout(res, 5000));
    await buildOnce('build 2 (from the index cache)', false);
}

if (process.argv.includes('rebuild'))
    await buildOnce('build 2 (a full build after a ready one)');

if (process.argv.includes('queries') && process.argv.includes('rebuild'))
    await queries();

console.log(`done; ${mem()}`);
await worker.terminate();

process.exit(0);
