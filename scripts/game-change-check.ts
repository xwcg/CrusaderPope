// Checks the "Re-index" notice for game files changed under the running app (docs/indexer.md, "Not like a build"),
// no game install needed and nothing written outside TEMP:
// - GameIndex over a made-up game folder and a made-up mod folder in TEMP, built with stamps (fingerprint, as with the
//   cache on): a game file changed on disk and read again (readFile on a miss) is listed by staleGameFiles(), a mod
//   folder's file only by staleFiles() (with its path); a new build lists none; without stamps (cache off) none;
//   checkGameFiles (the window's focus) finds a file in the read cache and an unread one, not a ctime-only change,
//   not new text with the same size and mtime, not a file new in the game folder (the documented limits);
// - PendingChange (src/shared/gameChange.ts, main's notice state) fed by a fake index worker thread posting {stale}
//   the way indexWorker.ts postStale does, wired as src/main/index.ts wires it: what is sent to the windows;
// - when built (out/main/indexWorker.js): the real index worker over a made-up game folder, a game file changed
//   between its build and a request: the {stale} list it posts and main's notice from it, and a build clearing it.
// Usage: node --experimental-strip-types --no-warnings scripts/game-change-check.ts
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ModChange, ModInfo } from '../src/shared/api.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { GAME_CHANGE_ID, PendingChange } from '../src/shared/gameChange.ts';

let failed = 0;
const check = (ok: boolean, what: string): void =>
{
    console.log((ok ? 'ok   ' : 'FAIL ') + what);

    if (!ok)
        failed++;
};

const tmp = mkdtempSync(join(tmpdir(), 'ckp-game-change-'));
// (also when the run ends early, e.g. a piped head: only the folder made above)
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
const game = join(tmp, 'install', 'game');
const modRoot = join(tmp, 'mod', 'ckp_mod');
const put = (root: string, rel: string, text: string): string =>
{
    const abs = join(root, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    return abs;
};
const EFFECT = 'common/scripted_effects/ckp_effects.txt';
const EVENTS = 'events/ckp_events.txt';
const MOD_EFFECT = 'common/scripted_effects/ckp_mod_effects.txt';
put(game, EFFECT, 'ckp_a_effect = {\n\tadd_gold = 1\n}\n');
put(game, EVENTS, 'namespace = ckp\nckp.1 = {\n\ttype = character_event\n\timmediate = {\n\t\tckp_a_effect = yes\n\t}\n}\n');
put(game, 'localization/english/ckp_l_english.yml', '﻿l_english:\n ckp.1.t: "A test"\n');
put(modRoot, 'descriptor.mod', 'version="1.0"\nname="CKP Mod"\nsupported_version="1.*"\n');
put(modRoot, MOD_EFFECT, 'ckp_m_effect = {\n\tadd_gold = 2\n}\n');
const mod: ModInfo = { id: 'mod/ckp_mod.mod', name: 'CKP Mod', tags: [], root: modRoot, source: 'local', replacePaths: [], status: 'ok', editable: true };

/** A build as the app makes it; `stamps`: with the cache on (fingerprint sets each file's stamp). */
function build(stamps: boolean): GameIndex
{
    const idx = new GameIndex(new GameFiles(game, [mod]), 'english');
    idx.build();

    if (stamps)
        idx.fingerprint('game-change-check');

    return idx;
}

const slot = (idx: GameIndex, source: number, rel: string): number => idx.files.findIndex((f) => f.source === source && f.rel === rel && !f.gone);

/** Changes a file on disk: new text, its time a minute later (a game file's stamp compares size and mtime). */
function change(root: string, rel: string, text: string): void
{
    const abs = put(root, rel, text);
    const t = new Date(Date.now() + 60_000);
    utimesSync(abs, t, t);
}

// 1. GameIndex
{
    const idx = build(true);
    const ev = slot(idx, 0, EVENTS);
    const fx = slot(idx, 0, EFFECT);
    const mfx = slot(idx, 1, MOD_EFFECT);
    check(ev >= 0 && fx >= 0 && mfx >= 0 && !!idx.files[ev].stamp, `the made-up files are indexed with stamps (slots ${ev}, ${fx}, ${mfx})`);
    check(idx.staleFiles().length === 0, 'a fresh build: nothing stale');

    idx.readFile(fx);
    check(idx.staleFiles().length === 0, 'an unchanged game file read again: nothing stale');

    change(game, EVENTS, 'namespace = ckp\nckp.1 = {\n\ttype = character_event\n\timmediate = {\n\t\tckp_a_effect = yes\n\t\tadd_prestige = 5\n\t}\n}\n');
    check(idx.staleGameFiles().length === 0, 'a game file changed on disk but not read again: not known yet');

    const text = idx.readFile(ev);
    check(text.includes('add_prestige'), 'readFile on a miss reads the new text');
    check(JSON.stringify(idx.staleGameFiles()) === JSON.stringify([EVENTS]), `read again: staleGameFiles() = ${JSON.stringify(idx.staleGameFiles())}`);
    const st = idx.staleFiles();
    check(st.length === 1 && st[0].source === 0 && st[0].abs === undefined, 'staleFiles(): the game file, without a disk path (no update takes it in)');

    idx.readFile(ev);
    check(idx.staleGameFiles().length === 1, 'read once more (a cache hit): listed once');

    change(modRoot, MOD_EFFECT, 'ckp_m_effect = {\n\tadd_gold = 3\n}\n');
    idx.readFile(mfx);
    const all = idx.staleFiles();
    check(all.length === 2 && all.some((f) => f.source === 1 && !!f.abs), 'a mod folder\'s file changed and read again: in staleFiles() with its disk path');
    check(JSON.stringify(idx.staleGameFiles()) === JSON.stringify([EVENTS]), 'staleGameFiles(): still only the game\'s file (a mod folder\'s has its own watcher event)');

    const again = build(true);
    check(again.staleFiles().length === 0, 'a new build: nothing stale');
    again.readFile(slot(again, 0, EVENTS));
    check(again.staleGameFiles().length === 0, 'a new build reads the changed file as its version: read again, not stale');

    // (checkGameFiles, run when the app's window gets the focus: every stamped game file against its disk version)
    {
        const sweep = build(true);
        const sev = slot(sweep, 0, EVENTS);
        const sfx = slot(sweep, 0, EFFECT);
        sweep.readFile(sev);
        check(sweep.checkGameFiles() > 0 && sweep.staleGameFiles().length === 0, `checkGameFiles on unchanged files: compared ${sweep.checkGameFiles()}, nothing stale`);

        // (a ctime alone (an attribute change) does not change the fingerprint, which hashes size and mtime)
        const evAbs = join(game, ...EVENTS.split('/'));
        const c0 = statSync(evAbs).ctimeMs;
        chmodSync(evAbs, 0o444);
        chmodSync(evAbs, 0o666);
        const c1 = statSync(evAbs).ctimeMs;
        sweep.checkGameFiles();
        check(c1 !== c0 && sweep.staleGameFiles().length === 0, `only the ctime changed (${c0} -> ${c1}): not stale (Re-index would load the same cache)`);

        // (one in the read cache (a later readFile is a hit, not checked) and one not read since the build)
        change(game, EVENTS, 'namespace = ckp\nckp.1 = {\n\ttype = character_event\n}\n');
        change(game, EFFECT, 'ckp_a_effect = {\n\tadd_gold = 7\n}\n');
        sweep.readFile(sev);
        check(sweep.staleGameFiles().length === 0, 'changed files, the read one a cache hit: not known before the check');
        sweep.checkGameFiles();
        check(JSON.stringify(sweep.staleGameFiles()) === JSON.stringify([EFFECT, EVENTS].sort((a, b) => slot(sweep, 0, a) - slot(sweep, 0, b))), `checkGameFiles: both listed (${JSON.stringify(sweep.staleGameFiles())}; slots ${sev}, ${sfx})`);
        const n = sweep.checkGameFiles();
        check(sweep.staleGameFiles().length === 2, `checked again (${n} compared): the same two`);
    }

    // (the limits named in docs/indexer.md: what the check does not see)
    {
        // (a known whole-second time before the build stamps the file: utimesSync below takes Dates, whole milliseconds,
        // so a fractional file system time would not come back)
        const fxAbs = join(game, ...EFFECT.split('/'));
        const whole = new Date(Math.floor(Date.now() / 1000) * 1000);
        utimesSync(fxAbs, whole, whole);
        const lim = build(true);
        const fp0 = lim.fingerprint('game-change-check');
        const before = statSync(fxAbs);
        const old = readFileSync(fxAbs, 'utf8');
        const same = old.replace(/\d/, (d) => String((Number(d) + 1) % 10));
        writeFileSync(fxAbs, same);
        utimesSync(fxAbs, before.atime, before.mtime);
        const after = statSync(fxAbs);
        lim.checkGameFiles();
        check(same !== old && after.size === before.size && after.mtimeMs === before.mtimeMs && lim.staleGameFiles().length === 0,
            `new text with the same size and mtime (${before.size} bytes, mtime ${after.mtimeMs}): not stale`);
        check(lim.fingerprint('game-change-check') === fp0, 'the same file: fingerprint() is unchanged too (the hash a Re-index validates the cache against; this compares two hashes of one in-memory index, it runs no build and loads no cache)');

        const added = put(game, 'events/ckp_new_events.txt', 'namespace = ckpnew\n');
        const compared = lim.checkGameFiles();
        check(lim.staleGameFiles().length === 0, `a file new in the game folder: not one the index read, not found (${compared} compared)`);
        rmSync(added);
    }

    // (cache off: no stamps, so nothing can be told; documented)
    const plain = build(false);
    change(game, EFFECT, 'ckp_a_effect = {\n\tadd_gold = 10\n}\n');
    plain.readFile(slot(plain, 0, EFFECT));
    check(plain.staleGameFiles().length === 0, 'without stamps (the cache off): a changed game file is not noticed');
}

// 2. PendingChange fed by a fake index worker (index.ts: msg.stale -> setGame; modWatcher's onChange -> setMods;
// rebuild -> clear() then the watcher's setMods(null); 'mods:changeState' -> current)
{
    const sent: (ModChange | null)[] = [];
    const pending = new PendingChange((c) => sent.push(c));
    const fakeWorker = join(tmp, 'fake-index-worker.mjs');
    // (posts its lists in order, as postStale does: the same list twice, then a build's empty one)
    writeFileSync(fakeWorker, `import { parentPort } from 'node:worker_threads';\nparentPort.once('message', (lists) => { for (const l of lists) parentPort.postMessage({ stale: l }); parentPort.postMessage({ done: true }); });\n`);
    const feed = (lists: string[][]): Promise<void> =>
        new Promise((resolve, reject) =>
        {
            const w = new Worker(fakeWorker);
            w.on('message', (msg: { stale?: string[]; done?: boolean; }) =>
            {
                if (msg.stale)
                {
                    pending.setGame(msg.stale);
                    return;
                }

                if (msg.done)
                {
                    void w.terminate();
                    resolve();
                }
            });
            w.once('error', reject);
            w.postMessage(lists);
        });

    await feed([[EVENTS]]);
    const one = sent.at(-1);
    check(sent.length === 1 && !!one && one.mods.length === 1 && one.mods[0].id === GAME_CHANGE_ID && one.mod === GAME_CHANGE_ID, 'a game file stale, no mod change: one notice, the game its only entry');
    check(!!one && JSON.stringify(one.files) === JSON.stringify([EVENTS]) && one.mods[0].active === false, `its files: ${JSON.stringify(one?.files)}`);
    check(JSON.stringify(pending.current) === JSON.stringify(one), 'mods:changeState answers the same');

    await feed([[EVENTS]]);
    check(sent.length === 1, 'the same list again: nothing sent');

    const modChange: ModChange = { mod: mod.id, name: mod.name, mods: [{ id: mod.id, name: mod.name, active: true }], files: [MOD_EFFECT], at: 1 };
    pending.setMods(modChange);
    const both = sent.at(-1);
    check(!!both && both.mod === mod.id && both.mods.length === 2 && both.mods[1].id === GAME_CHANGE_ID, 'with a mod\'s change: the mod first, the game last');
    check(!!both && both.files.length === 2 && both.files[0] === `${mod.name}: ${MOD_EFFECT}` && both.files[1].endsWith(`: ${EVENTS}`), `each path with its owner: ${JSON.stringify(both?.files)}`);
    check(!!both && both.at >= Date.now() - 60_000, 'its time: the newer of the two');

    const many = Array.from({ length: 40 }, (_, i) => `common/ckp/f${i}.txt`);
    await feed([many]);
    const capped = sent.at(-1);
    check(!!capped && capped.files.length === 26 && capped.files[0].startsWith(mod.name + ': '), `40 game files with a mod's: the mod's path kept, 25 of the game's (${capped?.files.length} paths)`);
    check(capped?.total === 41, `and the count of all: 41 (${capped?.total}), the notice's "and N more" counts from it`);

    // (a build: the worker's empty list, main's rebuild too; the watcher's own building() clears the mods' side)
    await feed([[]]);
    check(JSON.stringify(sent.at(-1)) === JSON.stringify(modChange), 'the game\'s list emptied: the mod\'s change alone, unchanged');
    pending.setMods(null);
    check(sent.at(-1) === null && pending.current === null, 'and the mod\'s gone too: no notice');
    const before = sent.length;
    pending.setGame([]);
    check(sent.length === before, 'an empty list again (rebuild and the worker\'s build both clear it): nothing sent');

    // (rebuild: pendingChange.clear() then modWatcher.building(), whose set(null) calls setMods(null) when it had one)
    {
        const got: (ModChange | null)[] = [];
        const p2 = new PendingChange((c) => got.push(c));
        p2.setMods(modChange);
        p2.setGame([EVENTS]);
        const n0 = got.length;
        p2.clear();
        p2.setMods(null);
        check(got.length === n0 + 1 && got.at(-1) === null && p2.current === null, `a build with both pending: one null sent, no notice in between (${JSON.stringify(got.slice(n0))})`);
        p2.clear();
        check(got.length === n0 + 1, 'clear with nothing pending: nothing sent');
    }

    const plainMod = new PendingChange(() => undefined);
    plainMod.setMods(modChange);
    check(plainMod.current === modChange, 'no game file stale: the watcher\'s change passed on as it is');
}

// 3. the built index worker (out/main/indexWorker.js, `npx electron-vite build`) over a made-up game folder, its
// messages wired into PendingChange as index.ts does: the real postStale after a request, the empty list at a build
{
    const built = join(import.meta.dirname, '..', 'out', 'main', 'indexWorker.js');

    if (!existsSync(built))
        console.log('skip the built index worker: no out/main/indexWorker.js (npx electron-vite build)');
    else
    {
        const g = join(tmp, 'install2', 'game');
        put(g, EFFECT, 'ckp_a_effect = {\n\tadd_gold = 1\n}\n');
        put(g, 'localization/english/ckp_l_english.yml', '﻿l_english:\n ckp.1.t: "A test"\n');
        const sent: (ModChange | null)[] = [];
        const pending = new PendingChange((c) => sent.push(c));
        const stales: string[][] = [];
        const w = new Worker(built);
        let id = 0;
        const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; }>();
        w.on('message', (msg: { id?: number; result?: unknown; error?: string; stale?: string[]; }) =>
        {
            // (index.ts: `if (msg.stale) { if (w === worker) pendingChange.setGame(msg.stale); return; }`)
            if (msg.stale)
            {
                stales.push(msg.stale);
                pending.setGame(msg.stale);
                return;
            }

            const p = msg.id === undefined ? undefined : waiting.get(msg.id);

            if (!p)
                return;

            waiting.delete(msg.id!);

            if (msg.error)
                p.reject(new Error(msg.error));
            else
                p.resolve(msg.result);
        });
        const call = (method: string, ...params: unknown[]): Promise<unknown> =>
            new Promise((resolve, reject) =>
            {
                const n = ++id;
                waiting.set(n, { resolve, reject });
                w.postMessage({ id: n, method, params });
            });
        const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 300));
        const buildIt = (): Promise<unknown> => call('build', g, 'english', { file: join(tmp, 'cache2', 'index.bin'), code: 'game-change-check', enabled: true }, [], undefined, 0);

        await buildIt();
        check(JSON.stringify(stales) === '[[]]', `a build: the worker posts an empty list first (${JSON.stringify(stales)})`);
        check(!!(await call('detail', 'scripted_effects', 'ckp_a_effect')), 'the made-up effect has a detail');
        await settle();
        check(stales.length === 1, 'a request on unchanged files: nothing more posted');

        // (a new build: the detail above put the file in the read cache, which a hit does not check)
        await buildIt();
        change(g, EFFECT, 'ckp_a_effect = {\n\tadd_gold = 100\n}\n');
        await call('detail', 'scripted_effects', 'ckp_a_effect');
        await settle();
        check(JSON.stringify(stales.at(-1)) === JSON.stringify([EFFECT]), `the file changed on disk, then a request reads it: posted ${JSON.stringify(stales.at(-1))}`);
        const shown = sent.at(-1);
        check(!!shown && shown.mods.length === 1 && shown.mods[0].id === GAME_CHANGE_ID && shown.files[0] === EFFECT, 'main\'s notice: the game, with the file');
        const count = stales.length;
        await call('detail', 'scripted_effects', 'ckp_a_effect');
        await settle();
        check(stales.length === count, 'the same list after the next request: not posted again');

        await buildIt();
        await settle();
        check(JSON.stringify(stales.at(-1)) === '[]' && pending.current === null, 'Re-index (a build): the empty list, no notice');

        // (the window's focus: main calls checkGameFiles; a file in the read cache, changed after its read)
        await call('detail', 'scripted_effects', 'ckp_a_effect');
        change(g, EFFECT, 'ckp_a_effect = {\n\tadd_gold = 200\n}\n');
        await call('detail', 'scripted_effects', 'ckp_a_effect');
        await settle();
        check(JSON.stringify(stales.at(-1)) === '[]', 'changed after its read, then read again (a cache hit): not posted');
        const compared = await call('checkGameFiles');
        await settle();
        check(typeof compared === 'number' && compared > 0 && JSON.stringify(stales.at(-1)) === JSON.stringify([EFFECT]) && pending.current?.files[0] === EFFECT, `checkGameFiles (${String(compared)} compared): posted ${JSON.stringify(stales.at(-1))}, main's notice has it`);

        await w.terminate();
    }
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
