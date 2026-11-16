/**
 * Writes one index cache file off the index worker (indexer/cache.ts): receives the prepared parts (typed arrays
 * transferred, string columns pre-joined), then encodes and writes them, and exits.
 */
import { parentPort } from 'node:worker_threads';
import { writeCacheParts, type CacheMeta, type CachePart } from './indexer/cache.ts';

parentPort!.once('message', (m: { file: string; fingerprint: string; parts: CachePart[]; meta?: CacheMeta; }) =>
{
    writeCacheParts(m.file, m.fingerprint, m.parts, m.meta).then(
        () => parentPort!.postMessage({ ok: true }),
        (e: Error) => parentPort!.postMessage({ error: String(e?.message ?? e) })
    );
});
