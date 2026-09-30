/**
 * Serves game images to the renderer through the `ck3://img/<game path>?w=<max size>` protocol — the file the game
 * would load for that path, with the loaded mods layered on top (a mod's texture replaces the game's).
 * Decoding happens in a pool of image workers (one per CPU core unless set in Settings) fed least-busy first, so a big texture
 * doesn't hold up the ones queued behind it; identical requests in flight share one decode; results are kept in an
 * in-memory LRU.
 */
import { app, net, protocol } from 'electron';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { availableParallelism } from 'node:os';
import { resolveGameDir } from './gameDir.ts';
import type { ModInfo } from '../shared/api.ts';

const CACHE_BYTES = 160 * 1024 * 1024;

interface Pending
{
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
}

let workers: Worker[] = [];
/** requests in flight per worker */
const busy = new Map<Worker, number>();
const decoding = new Map<string, Promise<Buffer>>();
let reqId = 0;
const pending = new Map<number, Pending>();
const cache = new Map<string, Buffer>();
let cacheBytes = 0;
let ready: Promise<unknown> = Promise.resolve();

/** A request whose worker was terminated by initImages (another mod list): asked again on the new workers. */
class Restarted extends Error
{}

function call(w: Worker, msg: Record<string, unknown>, transfer?: ArrayBuffer[]): Promise<unknown>
{
    return new Promise((resolve, reject) =>
    {
        const id = ++reqId;
        pending.set(id, { resolve, reject });
        w.postMessage({ ...msg, id }, transfer ?? []);
    });
}

function remember(key: string, buf: Buffer): void
{
    cache.set(key, buf);
    cacheBytes += buf.length;

    while (cacheBytes > CACHE_BYTES)
    {
        const [k, v] = cache.entries().next().value as [string, Buffer];
        cache.delete(k);
        cacheBytes -= v.length;
    }
}

/** Must run before app 'ready'. */
export function registerImageScheme(): void
{
    protocol.registerSchemesAsPrivileged([{ scheme: 'ck3', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
}

/**
 * (Re)starts the workers for a game folder and the loaded mods (enabled mods of the selected list in load order —
 * each worker layers them like the index does); `poolSize` 0/absent = one per CPU core.
 */
export function initImages(installDir: string, poolSize?: number, mods: ModInfo[] = []): void
{
    for (const w of workers)
        void w.terminate();

    // requests in flight never get an answer now (and a late one must not fill the new cache with the old files)
    for (const p of pending.values())
        p.reject(new Restarted());

    pending.clear();
    workers = [];
    ready = Promise.resolve();
    busy.clear();
    decoding.clear();
    cache.clear();
    cacheBytes = 0;
    const gameDir = resolveGameDir(installDir);

    if (!gameDir)
        return;

    const cacheDir = join(app.getPath('userData'), 'imgcache');
    const size = poolSize && poolSize > 0 ? Math.min(64, Math.round(poolSize)) : availableParallelism();

    for (let i = 0; i < size; i++)
    {
        const w = new Worker(join(__dirname, 'imageWorker.js'));
        w.on('message', (msg: { id: number; result?: unknown; error?: string; }) =>
        {
            const p = pending.get(msg.id);

            if (!p)
                return;

            pending.delete(msg.id);

            if (msg.error)
                p.reject(new Error(msg.error));
            else
                p.resolve(msg.result);
        });
        workers.push(w);
    }

    ready = Promise.all(workers.map((w) => call(w, { op: 'init', gameDir, cacheDir, mods })));
    // (a restart before the workers are up rejects it: the waiting requests retry)
    ready.catch(() =>
    {});
}

/** `removed`: the picture a mod's replace_path hid (galleries show it as removed). */
async function getImage(rel: string, w: number, face = 0, ch = '', removed = false): Promise<Buffer>
{
    const key = rel.toLowerCase() + '|' + w + '|' + face + '|' + ch + (removed ? '|removed' : '');
    const hit = cache.get(key);

    if (hit)
    {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
    }

    const running = decoding.get(key);

    if (running)
        return running;

    const job = (async () =>
    {
        for (let attempt = 0;; attempt++)
        {
            try
            {
                await ready;

                if (!workers.length)
                    throw new Error('No game folder');

                let worker = workers[0];

                for (const x of workers)
                    if ((busy.get(x) ?? 0) < (busy.get(worker) ?? 0))
                        worker = x;

                busy.set(worker, (busy.get(worker) ?? 0) + 1);

                try
                {
                    const ab = (await call(worker, { op: 'img', rel, w, face, ch, removed })) as ArrayBuffer;
                    const buf = Buffer.from(ab);
                    remember(key, buf);
                    return buf;
                }
                finally
                {
                    if (busy.has(worker))
                        busy.set(worker, (busy.get(worker) ?? 1) - 1);
                }
            }
            catch (e)
            {
                // the workers restarted meanwhile (another mod list): ask the new ones
                if (!(e instanceof Restarted) || attempt >= 3)
                    throw e;
            }
        }
    })();
    decoding.set(key, job);

    try
    {
        return await job;
    }
    finally
    {
        // (a restart may have put a newer job under this key)
        if (decoding.get(key) === job)
            decoding.delete(key);
    }
}

/**
 * Image files of a loaded mod changed (an incremental index update): their decoded copies go, and the workers look
 * for the files again (a new one may now replace the game's, a deleted one uncover it). Thumbnails on disk are keyed
 * by the file's size and time — a changed file gets new ones.
 */
export function refreshImages(rels: string[]): void
{
    const changed = new Set(rels.map((r) => r.replace(/\\/g, '/').toLowerCase()));
    const hit = (key: string): boolean => changed.has(key.slice(0, key.indexOf('|')));

    for (const [k, buf] of [...cache])
    {
        if (!hit(k))
            continue;

        cache.delete(k);
        cacheBytes -= buf.length;
    }

    for (const k of [...decoding.keys()])
        if (hit(k))
            decoding.delete(k);

    for (const w of workers)
        void call(w, { op: 'forget', rels: [...changed] }).catch(() =>
        {});
}

export async function imageInfo(rel: string): Promise<unknown>
{
    await ready;

    if (!workers.length)
        return { found: false };

    return call(workers[0], { op: 'info', rel });
}

/**
 * Call after app 'ready'. `files`: other hosts serving one folder's files by name (`ck3://map/<key>.bin` — the map's
 * province rasters, docs/map.md), streamed as they are.
 */
export function handleImageProtocol(files: Record<string, { dir: () => string; name: RegExp; }> = {}): void
{
    protocol.handle('ck3', async (req) =>
    {
        const url = new URL(req.url);
        const folder = files[url.hostname];

        if (folder)
        {
            const name = url.pathname.replace(/^\/+/, '');

            if (!folder.name.test(name))
                return new Response('Not found', { status: 404 });

            const r = await net.fetch(pathToFileURL(join(folder.dir(), name)).href).catch(() => null);

            if (!r?.ok)
                return new Response('Not found', { status: 404 });

            return new Response(r.body, { headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' } });
        }

        if (url.hostname !== 'img')
            return new Response('Not found', { status: 404 });

        const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
        // (callers append `?face=…` to a URL that may carry `?v=…` already: every `?` separates parameters)
        const params = new URLSearchParams(url.search.slice(1).replace(/\?/g, '&'));
        const w = Math.max(0, Math.min(4096, parseInt(params.get('w') ?? '0', 10) || 0));
        // ?face=0..5 serves one face of a cubemap (portrait environments)
        const face = Math.max(0, Math.min(5, parseInt(params.get('face') ?? '0', 10) || 0));
        // ?ch=r|g|b|a shows one channel as grey, ?ch=rgb the colour without alpha (texture inspection); ?v=<revision>
        // only makes a changed file's URL new
        const chParam = params.get('ch') ?? '';
        const ch = /^(r|g|b|a|rgb)$/.test(chParam) ? chParam : '';
        // ?removed=1: the picture a mod's replace_path hid (the file the path had before)
        const removed = params.get('removed') === '1';

        try
        {
            const png = await getImage(rel, w, face, ch, removed);
            // no-cache: the same URL shows another file once a different mod list is loaded — a newly mounted image asks
            // again (answered from the LRU above, which initImages empties) instead of reusing the renderer's old copy.
            // (Chromium sends no If-None-Match for this scheme, so an ETag would not save the transfer.)
            return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' } });
        }
        catch (err)
        {
            return new Response(String((err as Error).message), { status: 404 });
        }
    });
}
