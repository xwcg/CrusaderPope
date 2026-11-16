// Checks src/main/indexer/cache.ts (docs/indexer.md, "Index cache") on a small made-up state, no game needed:
// - a round trip gives the state back (typed columns, string columns, JSON, nested keys);
// - a damaged file reads as null (a build follows), never as a state with short columns: the file cut short, a column's
//   offset past the end, a negative length, a typed column of a broken length, a wrong string count;
// - the temporary file has a name of its own per write, and leftovers of dead processes are removed;
// - a delete queued while a write runs (the setting turned off) leaves neither the cache nor a temporary file;
// - a writer thread (runCacheWriter) that exits, throws or answers an error releases the queue and leaves no temporary
//   file of its own (another thread's of this process kept); the real cacheWriter.ts writes a cache that reads back;
// - one cache per layering (docs/indexer.md, "One per mod list"): cacheFileFor / cacheSibling names, GameIndex.layerKey
//   per game folder, language and mods (the same key as scripts/fast-index.ts), the header's code and layer, the prune
//   (the K newest kept plus the ones in use; another code's, unreadable, legacy, dead-pid temporary and orphan sibling
//   files dropped; other files kept), deleteAllIndexCaches (other files kept), touchIndexCache, indexCacheDiskUse and
//   the setting's clamp (shared/indexCaches.ts).
// Usage: node --experimental-strip-types --no-warnings scripts/index-cache-check.ts
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Worker } from 'node:worker_threads';
import { CacheFileQueue, cacheFileFor, cacheKeyOf, cacheParts, cacheSibling, deleteAllIndexCaches, deleteIndexCache, indexCacheDiskUse, pruneIndexCaches, readIndexCache, runCacheWriter, touchIndexCache, writeIndexCache } from '../src/main/indexer/cache.ts';
import { GameIndex, type IndexState } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { INDEX_CACHES_DEFAULT, indexCachesKept } from '../src/shared/indexCaches.ts';
import type { ModInfo } from '../src/shared/api.ts';

let failed = 0;
const check = (ok: boolean, what: string): void =>
{
    console.log((ok ? 'ok   ' : 'FAIL ') + what);

    if (!ok)
        failed++;
};

const dir = join(tmpdir(), `ckp-index-cache-check-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const file = join(dir, 'index.bin');
const FP = 'fp-1';

function state(): IndexState
{
    // (the string column last: cutting the file short then leaves every typed column whole, the case decode used to miss)
    return {
        version: 3,
        offs: new Int32Array([0, 5, 9, 1 << 20]),
        flags: new Uint8Array([1, 2, 3]),
        weights: new Float64Array([0.5, -2]),
        meta: { files: ['a.txt', 'b.txt'], nested: { n: new Uint16Array([7, 8, 9]) } },
        empty: [] as string[],
        oneEmpty: [''],
        names: ['brave', 'craven', 'ä_umlaut', 'x'.repeat(200)]
    } as unknown as IndexState;
}

/** The file's header and body, and a writer for a changed header over the same body. */
function parts(f: string): { header: { columns: { key: string; kind: string; off: number; len: number; }[]; }; body: Buffer; save(h: unknown): void; }
{
    const buf = readFileSync(f);
    const size = buf.readUInt32LE(0);
    const header = JSON.parse(buf.toString('utf8', 4, 4 + size));
    const body = buf.subarray((4 + size + 7) & ~7);
    return {
        header,
        body,
        save(h: unknown): void
        {
            const hb = Buffer.from(JSON.stringify(h), 'utf8');
            const len = Buffer.alloc(4);
            len.writeUInt32LE(hb.length, 0);
            const pad = Buffer.alloc(((4 + hb.length + 7) & ~7) - (4 + hb.length));
            writeFileSync(f, Buffer.concat([len, hb, pad, body]));
        }
    };
}

async function fresh(): Promise<void>
{
    deleteIndexCache(file);
    await writeIndexCache(file, FP, state());
}

const tmps = (): string[] => readdirSync(dir).filter((n) => n.endsWith('.tmp'));

// round trip
await fresh();
const back = readIndexCache(file, FP) as unknown as Record<string, unknown>;
const want = state() as unknown as Record<string, unknown>;
check(!!back && isDeepStrictEqual(back, want), 'round trip: the state read back equals the one written');
check(readIndexCache(file, 'fp-other') === null, 'another fingerprint: null');
check(tmps().length === 0, 'no temporary file left after a write');

// damaged files
{
    await fresh();
    const p = parts(file);
    const full = readFileSync(file);
    const names = p.header.columns.find((c) => c.key === 'names')!;
    // (cut inside the last string column only)
    writeFileSync(file, full.subarray(0, full.length - 50));
    check(readIndexCache(file, FP) === null, `file cut short inside the string column "names" (${names.len} bytes): null`);
}
{
    await fresh();
    writeFileSync(file, readFileSync(file).subarray(0, 40));
    check(readIndexCache(file, FP) === null, 'file cut short inside the first column: null');
}
for (const [what, change] of [
    ['an offset past the end', (c: { off: number; }) => (c.off += 1 << 16)],
    ['a negative offset', (c: { off: number; }) => (c.off = -8)],
    ['a negative length', (c: { len: number; }) => (c.len = -1)],
    ['a fractional length', (c: { len: number; }) => (c.len = 2.5)]
] as const)
{
    for (const key of ['offs', 'names'])
    {
        await fresh();
        const p = parts(file);
        change(p.header.columns.find((c) => c.key === key)! as never);
        p.save(p.header);
        check(readIndexCache(file, FP) === null, `${what} on column "${key}": null`);
    }
}
{
    await fresh();
    const p = parts(file);
    p.header.columns.find((c) => c.key === 'offs')!.len -= 2;
    p.save(p.header);
    check(readIndexCache(file, FP) === null, 'an Int32Array column of 14 bytes: null');
}
for (const [kind, what] of [['strings:5', 'one string more'], ['strings:3', 'one string fewer'], ['strings:0', 'none for a run of bytes'], ['strings:x', 'not a number'], ['strings:-1', 'negative']])
{
    await fresh();
    const p = parts(file);
    p.header.columns.find((c) => c.key === 'names')!.kind = kind;
    p.save(p.header);
    check(readIndexCache(file, FP) === null, `string count ${kind} (${what}) for 4 strings: null`);
}
{
    // (the damage checks refuse nothing a writer makes: a column re-saved unchanged still reads)
    await fresh();
    const p = parts(file);
    p.save(p.header);
    check(isDeepStrictEqual(readIndexCache(file, FP), want), 'header re-saved unchanged: reads as before');
}

// temporary files
{
    await fresh();
    const dead = join(dir, 'index.bin.999999.1.1.tmp');
    const own = join(dir, `index.bin.${process.pid}.0.77.tmp`);
    const old = join(dir, 'index.bin.tmp');
    const other = join(dir, 'other.bin.999999.1.1.tmp');

    for (const f of [dead, own, old, other])
        writeFileSync(f, 'x');

    await writeIndexCache(file, FP, state());
    check(!existsSync(dead) && !existsSync(old), 'after a write: a dead process\'s temporary file and the old fixed-name one are gone');
    check(existsSync(own) && existsSync(other), 'after a write: this process\'s (a write of its own may run) and another cache\'s are kept');
    deleteIndexCache(file);
    check(!existsSync(file) && !existsSync(own) && existsSync(other), 'deleteIndexCache: the cache and all its temporary files gone, another cache\'s kept');
    rmSync(other, { force: true });
}

// a delete while a write runs
{
    const q = new CacheFileQueue();
    let started!: () => void;
    const begun = new Promise<void>((r) => (started = r));
    const writing = q.run(async () =>
    {
        const w = writeIndexCache(file, FP, state());
        started();
        await w;
    });
    await begun;
    const deleted = q.delete(file);
    await Promise.all([writing, deleted]);
    check(!existsSync(file) && tmps().length === 0, 'a delete queued while a write runs: no index.bin, no .tmp afterwards');

    // (no unqueued control: whether a write that goes on brings the file back depends on where the delete lands, before
    // its open or between its close and rename; deleting its open temporary file instead fails its rename)

    // (a failed job leaves the queue going)
    await q.run(() => Promise.reject(new Error('fails')));
    let ran = false;
    await q.run(() => void (ran = true));
    check(ran, 'a failed job does not stop the queue');
}

// writer threads (runCacheWriter, as the index worker runs them): the queue goes on however a writer ends, and a writer
// that ended without writing leaves no temporary file
{
    const fakeWriter = (name: string, body: string): string =>
    {
        const p = join(dir, name + '.mjs');
        writeFileSync(p, `import { parentPort, threadId } from 'node:worker_threads';\nimport { writeFileSync } from 'node:fs';\nparentPort.once('message', (m) => {\n  const tmp = m.file + '.' + process.pid + '.' + threadId + '.1.tmp';\n  writeFileSync(tmp, 'half a cache');\n  ${body}\n});\n`);
        return p;
    };
    const exitsSilently = fakeWriter('exits', 'process.exit(0);');
    const throws = fakeWriter('throws', 'throw new Error(\'boom in the writer\');');
    const answersError = fakeWriter('answers-error', 'parentPort.postMessage({ error: \'disk full\' });');
    // (a bounded wait: a stalled queue fails the check instead of hanging the script)
    const within = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
    const job = { file, fingerprint: FP, parts: [] };
    const otherThread = join(dir, `index.bin.${process.pid}.999.1.tmp`);

    // (control: a fake writer run as a plain thread does leave its temporary file, so "removed" below is not vacuous)
    {
        const w = new Worker(exitsSilently);
        const tid = w.threadId;
        w.postMessage(job);
        await new Promise((r) => w.once('exit', r));
        const left = join(dir, `index.bin.${process.pid}.${tid}.1.tmp`);
        check(existsSync(left), 'control: a fake writer that exits leaves its temporary file when nobody removes it');
        rmSync(left, { force: true });
    }

    for (const [script, what] of [[exitsSilently, 'exits without an answer'], [throws, 'throws'], [answersError, 'answers {error}']] as const)
    {
        writeFileSync(otherThread, 'x');
        const r = await within(runCacheWriter(script, job), 10000);
        check(r === false, `a writer that ${what}: over, not written (${r})`);
        check(tmps().filter((t) => t !== `index.bin.${process.pid}.999.1.tmp`).length === 0, `a writer that ${what}: its temporary file removed`);
        check(existsSync(otherThread), `a writer that ${what}: another thread's temporary file of this process kept`);
    }

    rmSync(otherThread, { force: true });

    // (a temporary file that cannot be removed (held by another process on Windows: EBUSY / EPERM), made here as a
    // folder at its path, which rmSync without `recursive` refuses: the writer is still over, nothing throws)
    {
        const blocked = join(dir, 'blocked.mjs');
        writeFileSync(blocked, `import { parentPort, threadId } from 'node:worker_threads';\nimport { mkdirSync } from 'node:fs';\nparentPort.once('message', (m) => {\n  mkdirSync(m.file + '.' + process.pid + '.' + threadId + '.1.tmp');\n  process.exit(0);\n});\n`);
        let uncaught: unknown = null;
        const onUncaught = (e: unknown): void => void (uncaught = e);
        process.on('uncaughtException', onUncaught);
        const q = new CacheFileQueue();
        const first = q.run(async () => void (await runCacheWriter(blocked, job)));
        let after = false;
        const later = q.run(() => void (after = true));
        const r = await within(Promise.all([first, later]), 10000);
        process.off('uncaughtException', onUncaught);
        const held = tmps();
        check(r !== 'timeout' && after && uncaught === null && held.length === 1, `a writer whose temporary file cannot be removed: over, nothing thrown, the queue goes on, the file kept (${r === 'timeout' ? 'timeout' : 'done'}, ${String(uncaught)}, ${held.join(',')})`);

        // (control: the removal does fail on it, so "nothing thrown" above is not vacuous)
        let refused = false;

        try
        {
            rmSync(join(dir, held[0] ?? 'none.tmp'), { force: true });
        }
        catch
        {
            refused = true;
        }

        check(refused, 'control: rmSync({force}) throws on the blocked temporary file');

        for (const t of held)
            rmSync(join(dir, t), { recursive: true, force: true });
    }

    // (the real writer)
    rmSync(file, { force: true });
    const real = join(import.meta.dirname, '..', 'src', 'main', 'cacheWriter.ts');
    const { parts: realParts, transfer } = cacheParts(state());
    const ok = await within(runCacheWriter(real, { file, fingerprint: FP, parts: realParts }, transfer), 20000);
    check(ok === true && isDeepStrictEqual(readIndexCache(file, FP), want), `the real cacheWriter.ts: written, reads back equal (${ok})`);
    check(tmps().length === 0, 'the real cacheWriter.ts: no temporary file left');

    // (a writer that exits without answering no longer holds the queue: the delete queued behind it runs)
    // (a job after the silent writer brings a file back: only the delete's second half, after the queued jobs, removes it)
    const q = new CacheFileQueue();
    const writing = q.run(async () => void (await runCacheWriter(exitsSilently, job)));
    const rewrite = q.run(() => writeFileSync(file, 'written by a job queued before the delete'));
    const deleted = q.delete(file);
    let after = false;
    const later = q.run(() => void (after = true));
    const r = await within(Promise.all([writing, rewrite, deleted, later]), 10000);
    check(r !== 'timeout' && after && !existsSync(file), `a delete queued behind a writer that exits silently: its second half runs (the file a later job wrote is gone), the queue goes on (${r === 'timeout' ? 'timeout' : 'done'})`);
}

// one cache per layering
{
    const anchor = join(dir, 'index.bin');
    const k1 = '0123456789abcdef';
    check(cacheFileFor(anchor, k1) === join(dir, `index-${k1}.bin`) && cacheFileFor(anchor, k1) === cacheFileFor(join(dir, 'other.name'), k1), 'cacheFileFor: index-<key>.bin in the anchor\'s folder, whatever the anchor\'s name');
    check(cacheKeyOf(cacheFileFor(anchor, k1)) === k1 && cacheKeyOf(anchor) === null && cacheKeyOf(join(dir, 'index-xyz.bin')) === null, 'cacheKeyOf: the key of index-<key>.bin, null for index.bin and other names');
    check(cacheSibling(cacheFileFor(anchor, k1), 'script-keys') === join(dir, `script-keys-${k1}.json`) && cacheSibling(cacheFileFor(anchor, k1), 'shaders') === join(dir, `shaders-${k1}.json`), 'cacheSibling: script-keys-<key>.json and shaders-<key>.json beside the index');

    // (layerKey: a made-up game folder; two mod folders)
    const game = join(dir, 'game-install', 'game');
    mkdirSync(join(game, 'common'), { recursive: true });
    const modDir = (n: string): string =>
    {
        const d = join(dir, 'mods', n);
        mkdirSync(join(d, 'common'), { recursive: true });
        return d;
    };
    const mod = (id: string, root: string, replacePaths: string[] = []): ModInfo => ({ id, name: id, tags: [], root, source: 'local', replacePaths, status: 'ok', editable: false });
    const a = modDir('a');
    const b = modDir('b');
    const key = (mods: ModInfo[], lang = 'english'): string => new GameIndex(new GameFiles(game, mods), lang).layerKey();
    const vanilla = key([]);
    const keys = [vanilla, key([], 'german'), key([mod('mod/a.mod', a)]), key([mod('mod/a.mod', a), mod('mod/b.mod', b)]), key([mod('mod/b.mod', b), mod('mod/a.mod', a)]), key([mod('mod/a.mod', a, ['common/traits'])]), key([mod('mod/a.mod', b)])];
    check(/^[0-9a-f]{16}$/.test(vanilla) && key([]) === vanilla, `layerKey: 16 hex digits, the same for the same layering (${vanilla})`);
    check(new Set(keys).size === keys.length, 'layerKey: another language, another mod, another order, a replace_path, another location: each a key of its own');
    const idx = new GameIndex(new GameFiles(game, [mod('mod/a.mod', a)]), 'english');
    const fast = createHash('sha1').update(`${idx.gameDir}\n${idx.language}\n${idx.vfs.identity()}`).digest('hex').slice(0, 16);
    check(idx.layerKey() === fast, 'layerKey: the key scripts/fast-index.ts names its files by');

    // (the header carries code and layer)
    const fk = cacheFileFor(anchor, k1);
    await writeIndexCache(fk, FP, state(), { code: 'code-A', layer: k1 });
    const h = parts(fk).header as unknown as { code?: string; layer?: string; };
    check(h.code === 'code-A' && h.layer === k1 && isDeepStrictEqual(readIndexCache(fk, FP), want), 'a write with meta: the header has code and layer, the state reads back');

    // (touch: the most recently used)
    const old = new Date(Date.now() - 3600_000);
    utimesSync(fk, old, old);
    touchIndexCache(fk);
    check(statSync(fk).mtimeMs > Date.now() - 60_000, 'touchIndexCache: the file\'s modification time is now');
    touchIndexCache(join(dir, 'index-ffffffffffffffff.bin'));
    check(true, 'touchIndexCache on a missing file: nothing thrown');
}

// the prune
{
    const pd = join(dir, 'prune');
    const setup = async (): Promise<string[]> =>
    {
        rmSync(pd, { recursive: true, force: true });
        mkdirSync(pd, { recursive: true });
        const ks: string[] = [];

        // (six lists of the current code, the first the oldest)
        for (let i = 0; i < 6; i++)
        {
            const k = (i + 1).toString(16).repeat(16);
            ks.push(k);
            const f = join(pd, `index-${k}.bin`);
            await writeIndexCache(f, FP, state(), { code: 'code-A', layer: k });
            writeFileSync(join(pd, `script-keys-${k}.json`), '{}');
            writeFileSync(join(pd, `shaders-${k}.json`), '{}');
            const t = new Date(Date.now() - (10 - i) * 60_000);
            utimesSync(f, t, t);
        }

        return ks;
    };
    let ks = await setup();
    // (the newest file of another code, one written before the header had a code, an unreadable one)
    const other = 'a'.repeat(16);
    await writeIndexCache(join(pd, `index-${other}.bin`), FP, state(), { code: 'code-B', layer: other });
    writeFileSync(join(pd, `shaders-${other}.json`), '{}');
    const noCode = 'b'.repeat(16);
    await writeIndexCache(join(pd, `index-${noCode}.bin`), FP, state());
    const junk = 'c'.repeat(16);
    writeFileSync(join(pd, `index-${junk}.bin`), 'not a cache');
    // (the one-file cache of older versions, temporary files, an orphan sibling, a sibling of a key in use whose index
    // is still on the way, files that are not the cache's)
    for (const n of ['index.bin', 'script-keys.json', 'shaders.json', 'shaders.json.tmp', `index-${ks[0]}.bin.999999.1.1.tmp`, 'index.bin.999999.2.1.tmp', 'index.bin.tmp', `index-${ks[5]}.bin.${process.pid}.0.9.tmp`, `script-keys-${'d'.repeat(16)}.json`, `shaders-${'e'.repeat(16)}.json`, 'game-facts-index.bin', 'game-facts-migration.bin', 'notes.txt'])
        writeFileSync(join(pd, n), 'x');

    const left = (): string[] => readdirSync(pd).sort();
    const r = pruneIndexCaches(pd, 3, 'code-A', [ks[0], 'e'.repeat(16)]);
    const keptWant = [ks[0], ks[3], ks[4], ks[5]];
    check(isDeepStrictEqual([...r.kept].sort(), [...keptWant].sort()), `keep 3 with the oldest in use: the 3 newest plus the one in use kept (${r.kept.join(',')})`);
    const names = left();
    const has = (n: string): boolean => names.includes(n);
    check(keptWant.every((k) => has(`index-${k}.bin`) && has(`script-keys-${k}.json`) && has(`shaders-${k}.json`)), 'the kept lists keep their index, keys and shaders');
    check([ks[1], ks[2]].every((k) => !has(`index-${k}.bin`) && !has(`script-keys-${k}.json`) && !has(`shaders-${k}.json`)), 'the older lists beyond 3 go with their siblings');
    check(!has(`index-${other}.bin`) && !has(`shaders-${other}.json`), 'the newest file, but of another code (an app update, another language): gone at once, with its sibling');
    check(!has(`index-${noCode}.bin`) && !has(`index-${junk}.bin`), 'a file written without a code and an unreadable one: gone');
    check(!has('index.bin') && !has('script-keys.json') && !has('shaders.json') && !has('shaders.json.tmp'), 'the one-file cache of older versions: gone');
    check(!has(`index-${ks[0]}.bin.999999.1.1.tmp`) && !has('index.bin.999999.2.1.tmp') && !has('index.bin.tmp') && has(`index-${ks[5]}.bin.${process.pid}.0.9.tmp`), 'temporary files: a dead process\'s and the old fixed name gone, this process\'s kept');
    check(!has(`script-keys-${'d'.repeat(16)}.json`) && has(`shaders-${'e'.repeat(16)}.json`), 'a sibling whose index is gone: removed, unless its key is in use (its index on the way)');
    check(['game-facts-index.bin', 'game-facts-migration.bin', 'notes.txt'].every(has), 'other files of the folder (the game facts) kept');

    // (no key in use: the newest K; keep clamped to at least 1)
    ks = await setup();
    check(isDeepStrictEqual(pruneIndexCaches(pd, 2, 'code-A').kept, [ks[5], ks[4]]), 'keep 2, nothing in use: the 2 newest');
    check(isDeepStrictEqual(pruneIndexCaches(pd, 0, 'code-A').kept, [ks[5]]), 'keep 0 is taken as 1: the newest stays');
    ks = await setup();
    const none = pruneIndexCaches(pd, 3, 'code-Z', [ks[2]]);
    check(isDeepStrictEqual(none.kept, [ks[2]]) && left().filter((n) => n.startsWith('index-')).length === 1, 'every file of another code gone, except the one in use');

    // (a file that can be neither read nor removed now, as one held by another process: here a folder of the name.
    // Kept, never thrown on, and the older lists after it in the prune still go)
    ks = await setup();
    const held = join(pd, `index-${'f'.repeat(16)}.bin`);
    mkdirSync(held);
    const th = new Date(Date.now() - 5.5 * 60_000);
    utimesSync(held, th, th);
    let threw = false;
    let hp: { removed: string[]; kept: string[]; } = { removed: [], kept: [] };

    try
    {
        hp = pruneIndexCaches(pd, 1, 'code-A');
    }
    catch
    {
        threw = true;
    }

    check(!threw && existsSync(held) && isDeepStrictEqual(hp.kept, [ks[5]]) && ks.slice(0, 5).every((k) => !existsSync(join(pd, `index-${k}.bin`))), `a held file (a folder of the name, between the newest and the rest): kept, nothing thrown, the 5 older lists still removed (${hp.removed.length} removed)`);
    rmSync(held, { recursive: true, force: true });

    // (disk use)
    ks = await setup();
    writeFileSync(join(pd, 'game-facts-index.bin'), 'y'.repeat(1000));
    const use = indexCacheDiskUse(pd);
    const sum = readdirSync(pd).filter((n) => n !== 'game-facts-index.bin').reduce((s, n) => s + statSync(join(pd, n)).size, 0);
    check(use.caches === 6 && use.bytes === sum, `indexCacheDiskUse: 6 lists, ${use.bytes} bytes = the index, keys and shaders files (${sum}), the game facts not counted`);
    check(isDeepStrictEqual(indexCacheDiskUse(join(pd, 'missing')), { bytes: 0, caches: 0 }), 'indexCacheDiskUse of a missing folder: 0');

    // (all deleted: the setting off)
    for (const n of ['index.bin', 'shaders.json', `index-${ks[0]}.bin.${process.pid}.0.3.tmp`, 'notes.txt'])
        writeFileSync(join(pd, n), 'x');

    deleteAllIndexCaches(pd);
    check(isDeepStrictEqual(left(), ['game-facts-index.bin', 'notes.txt']), `deleteAllIndexCaches: every index, keys, shaders and temporary file gone, other files kept (${left().join(',')})`);

    const q = new CacheFileQueue();
    ks = await setup();
    let ran = false;
    const w = q.run(async () =>
    {
        await writeIndexCache(join(pd, `index-${'f'.repeat(16)}.bin`), FP, state(), { code: 'code-A', layer: 'f'.repeat(16) });
        ran = true;
    });
    writeFileSync(join(pd, 'notes.txt'), 'x');
    await q.deleteAll(pd);
    await w;
    check(ran && isDeepStrictEqual(left(), ['notes.txt']),'CacheFileQueue.deleteAll behind a write: the file it wrote is gone too');
}

// the setting
check(indexCachesKept(undefined) === INDEX_CACHES_DEFAULT && INDEX_CACHES_DEFAULT === 3 && indexCachesKept(0) === 1 && indexCachesKept(9) === 8 && indexCachesKept(4) === 4 && indexCachesKept(2.6) === 3 && indexCachesKept(Number.NaN) === 3, 'indexCachesKept: absent 3, clamped to 1..8, whole numbers');

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
