// Checks src/main/scriptKeysThread.ts (the picker's key scan thread as the index worker drives it, docs/picker.md
// "Other…") with tiny fake worker scripts in TEMP, and the real scriptKeysWorker.ts over a fake game folder:
// - each thread answers only its own requests (an older thread's late answer settles nothing of a newer one's);
// - close() rejects what is waiting and terminates the thread;
// - an {error} answer, an uncaught error and an exit end the thread and reject what is waiting;
// - a thread that does not stay ends after its first answer; a staying one answers rescans in order;
// - a request after the end is refused, a new thread starts fresh;
// - the real worker with a cache under the job's fingerprint: read: true answers from it, read: false scans and
//   leaves the cache file as it was.
// Usage: node --experimental-strip-types --no-warnings scripts/keys-thread-check.ts
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyScanThread, type KeyScanJob } from '../src/main/scriptKeysThread.ts';
import type { ScriptKeys } from '../src/shared/api.ts';

let failed = 0;
const check = (ok: boolean, what: string): void =>
{
    console.log((ok ? 'ok   ' : 'FAIL ') + what);

    if (!ok)
        failed++;
};

const tmp = mkdtempSync(join(tmpdir(), 'ckp-keys-thread-'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const keys = (name: string): ScriptKeys => ({ effect: [{ key: name } as never], trigger: [] });
const names = (k: ScriptKeys | undefined): string => (k ? k.effect.map((e) => (e as { key: string; }).key).join(',') : '');
const JOB: KeyScanJob = { gameDir: tmp, mods: [] };

/** A fake worker: `body` runs with `post` (parentPort.postMessage), `on` (incoming messages) and `data` (workerData). */
function fake(name: string, body: string): string
{
    const file = join(tmp, name + '.js');
    writeFileSync(file, `const { parentPort, workerData } = require('node:worker_threads');\nconst post = (m) => parentPort.postMessage(m);\nconst on = (f) => parentPort.on('message', f);\nconst data = workerData;\n${body}\n`);
    return file;
}

/** settles to ['ok', value] or ['err', message] (or 'pending' after `ms`) */
async function outcome<T>(p: Promise<T>, ms = 2000): Promise<['ok', T] | ['err', string] | ['pending']>
{
    return Promise.race([p.then((v): ['ok', T] => ['ok', v], (e: Error): ['err', string] => ['err', String(e?.message ?? e)]), sleep(ms).then((): ['pending'] => ['pending'])]);
}

const answerAfter = fake('answer-after', `setTimeout(() => post({ keys: { effect: [{ key: data.tag }], trigger: [] } }), data.ms);`);
const hang = fake('hang', `setInterval(() => require('node:fs').writeFileSync(data.beat, String(Date.now())), 20);`);
const errorAnswer = fake('error-answer', `post({ error: 'scan failed' }); on(() => post({ keys: { effect: [{ key: 'after-error' }], trigger: [] } }));`);
const exits = fake('exits', `setTimeout(() => process.exit(3), 30);`);
const throws = fake('throws', `setTimeout(() => { throw new Error('boom in the thread'); }, 30);`);
// (one message after the other, like the real worker's synchronous rescan; a slow one delays the next)
const echo = fake('echo', `post({ keys: { effect: [{ key: 'first' }], trigger: [] } }); let chain = Promise.resolve(); on((m) => { if (m.rescan) chain = chain.then(() => new Promise((r) => setTimeout(() => { post({ keys: { effect: m.rescan.map((k) => ({ key: k })), trigger: [] } }); r(); }, m.rescan[0] === 'slow' ? 80 : 5))); });`);

// 1. two threads side by side (an older build's, a newer one's): each request settles with its own thread's answer
{
    const ended: string[] = [];
    const older = new KeyScanThread(answerAfter, { ...JOB, tag: 'older', ms: 150 } as KeyScanJob, false, () => void ended.push('older'));
    const newer = new KeyScanThread(answerAfter, { ...JOB, tag: 'newer', ms: 30 } as KeyScanJob, false, () => void ended.push('newer'));
    const [a, b] = await Promise.all([outcome(older.first), outcome(newer.first)]);
    check(a[0] === 'ok' && names(a[1]) === 'older' && b[0] === 'ok' && names(b[1]) === 'newer', `each thread answers its own request (older: ${names(a[0] === 'ok' ? a[1] : undefined)}, newer: ${names(b[0] === 'ok' ? b[1] : undefined)})`);
    check(older.dead && newer.dead && ended.length === 2, `threads that do not stay end after their answer (ended: ${ended.join(', ')})`);
    const again = await outcome(older.rescan(['x']));
    check(again[0] === 'err', 'a request after the end is refused');
}

// 2. close(): what waits is rejected with the reason, the thread is terminated
{
    const beat = join(tmp, 'beat.txt');
    const t = new KeyScanThread(hang, { ...JOB, beat } as KeyScanJob, true);
    await sleep(200);
    const before = readFileSync(beat, 'utf8');
    t.close('The index is being rebuilt');
    const r = await outcome(t.first);
    check(r[0] === 'err' && r[1] === 'The index is being rebuilt', `close rejects the waiting request with its reason (${r.join(': ')})`);
    await sleep(150);
    const a = readFileSync(beat, 'utf8');
    await sleep(150);
    const b = readFileSync(beat, 'utf8');
    check(before !== '' && a === b && t.dead, 'close terminates the thread (its heartbeat stops)');
}

// 3. an {error} answer ends a staying thread (no rescan reaches it after)
{
    let ends = 0;
    const t = new KeyScanThread(errorAnswer, JOB, true, () => void ends++);
    const r = await outcome(t.first);
    check(r[0] === 'err' && r[1] === 'scan failed', `an {error} answer rejects the request (${r.join(': ')})`);
    check(t.dead && ends === 1, 'an {error} answer ends the thread (told once)');
    const again = await outcome(t.rescan(['common/x.txt']));
    check(again[0] === 'err', `a rescan after the error is refused (${again.join(': ')})`);
}

// 4. an exit and an uncaught error reject what waits
{
    const t = new KeyScanThread(exits, JOB, true);
    const r = await outcome(t.first);
    check(r[0] === 'err' && /3/.test(r[1]) && t.dead, `an exit rejects the waiting request (${r.join(': ')})`);
    const u = new KeyScanThread(throws, JOB, true);
    const s = await outcome(u.first);
    check(s[0] === 'err' && /boom in the thread/.test(s[1]) && u.dead, `an uncaught error rejects the waiting request (${s.join(': ')})`);
}

// 5. a staying thread: rescans answered in order, a slow one does not swap answers; closing rejects the queued ones
{
    const t = new KeyScanThread(echo, JOB, true);
    const f = await outcome(t.first);
    const slow = t.rescan(['slow']);
    const fast = t.rescan(['fast']);
    const [a, b] = await Promise.all([outcome(slow), outcome(fast)]);
    check(f[0] === 'ok' && names(f[1]) === 'first' && a[0] === 'ok' && names(a[1]) === 'slow' && b[0] === 'ok' && names(b[1]) === 'fast' && !t.dead, 'a staying thread answers its rescans in order and stays');
    const waiting = [t.rescan(['slow']), t.rescan(['two'])];
    t.close('closed');
    const rs = await Promise.all(waiting.map((p) => outcome(p)));
    check(rs.every((x) => x[0] === 'err' && x[1] === 'closed'), 'close rejects every queued rescan');
    const fresh = new KeyScanThread(echo, JOB, false);
    const n = await outcome(fresh.first);
    check(n[0] === 'ok' && names(n[1]) === 'first', 'a new thread after a close starts fresh');
}

// 6. the real scriptKeysWorker.ts over a fake game folder with a cache under fingerprint F
{
    const here = dirname(fileURLToPath(import.meta.url));
    const worker = resolve(here, '../src/main/scriptKeysWorker.ts');
    const game = join(tmp, 'install', 'game');
    mkdirSync(join(game, 'events'), { recursive: true });
    writeFileSync(join(game, 'events', 'ckp_events.txt'), 'namespace = ckp\nckp.1 = {\n\ttype = character_event\n\timmediate = {\n\t\tadd_gold = 1\n\t\tckp_marker_effect = yes\n\t}\n}\n');
    const cacheFile = join(tmp, 'script-keys.json');
    // (the worker's own code key: the sha1 of its file when it knows its file name, else empty (an ES module run))
    const codes = [createHash('sha1').update(readFileSync(worker)).digest('hex'), ''];
    let matched: string | null = null;

    for (const code of codes)
    {
        const text = JSON.stringify({ fingerprint: 'F', code, keys: keys('ckp_fake_cached') });
        writeFileSync(cacheFile, text);
        const t = new KeyScanThread(worker, { gameDir: game, mods: [], cache: { file: cacheFile, fingerprint: 'F', read: true } }, false);
        const r = await outcome(t.first, 30000);

        if (r[0] === 'ok' && names(r[1]) === 'ckp_fake_cached')
        {
            matched = code;
            break;
        }
    }

    check(matched !== null, `read: true answers from the cache under the job's fingerprint (code key ${matched === '' ? 'empty' : 'sha1'})`);
    const text = JSON.stringify({ fingerprint: 'F', code: matched ?? '', keys: keys('ckp_fake_cached') });
    writeFileSync(cacheFile, text);
    const t = new KeyScanThread(worker, { gameDir: game, mods: [], cache: { file: cacheFile, fingerprint: 'F', read: false } }, false);
    const r = await outcome(t.first, 30000);
    const scanned = r[0] === 'ok' ? r[1] : undefined;
    const effects = names(scanned).split(',');
    check(!!scanned && !effects.includes('ckp_fake_cached') && effects.includes('add_gold'), `read: false scans the files instead (${effects.length} effect keys, add_gold among them, not the cached one)`);
    check(readFileSync(cacheFile, 'utf8') === text, 'read: false leaves the cache file as it was (not written under the old fingerprint)');
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
