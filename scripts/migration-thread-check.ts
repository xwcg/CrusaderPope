// Checks src/main/mods/migrationThread.ts (docs/mods.md, "The migration worker"): "Fix for 1.20…"'s jobs on the migration
// worker, with a host that answers the index's questions itself (no index is built) and a TEMP user folder holding one 1.19
// mod: a plan comes back as the worker made it; an error and a cancel come back as such (a cancel while the plan waits for
// the index ends it at once, the worker stays usable); a run's progress reaches main; the host's synchronous calls (the game
// folder, the settings of each job) reach main's host; and the undo journal: steps a forwarded journal records land in the
// journal of main's host (one journal.json), their earlier bytes as written, undone from there.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings scripts/migration-thread-check.ts
// (WORKER=out/main/migrationWorker.js: the built worker instead of the source; under Electron's Node: ELECTRON_RUN_AS_NODE=1
// node_modules/electron/dist/electron.exe scripts/migration-thread-check.ts, its V8 with the one 4 GB heap of all threads)
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MigrationPlan, MigrationProgress, Settings } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import type { ModsHost } from '../src/main/mods/manager.ts';
import { MigrationCancelled, RunWrites } from '../src/main/mods/migrate.ts';
import { MigrationThread } from '../src/main/mods/migrationThread.ts';
import { ForwardedJournal, change, journalOf, recordWrite, takeForwarded, undoChange } from '../src/main/mods/undo.ts';
import { defaultInstall } from './ck3-install.ts';

let failed = 0;
const check = (ok: boolean, what: string): void =>
{
    console.log((ok ? 'ok   ' : 'FAIL ') + what);

    if (!ok)
        failed++;
};

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
{
    console.log('FAIL no game folder');
    process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'ckp-mthread-'));
const modRoot = join(tmp, 'mod', 'test');
mkdirSync(join(modRoot, 'common', 'traits'), { recursive: true });
const descriptor = 'version="1"\nname="Thread Test"\nsupported_version="1.19.*"\n';
writeFileSync(join(modRoot, 'descriptor.mod'), descriptor);
writeFileSync(join(tmp, 'mod', 'test.mod'), descriptor + `path="${modRoot.replace(/\\/g, '/')}"\n`);
writeFileSync(join(modRoot, 'common', 'traits', 'test_traits.txt'), 'test_trait = { }\n');
const modId = 'mod/test.mod';

let settings: Settings = { gameDir: install, language: 'english', userDir: tmp, customModLists: [{ id: 'l1', name: 'test', mods: [{ id: modId, enabled: true }] }], modList: 'custom:l1' } as Settings;
// (what the host was asked, and how the index answers the plan's question: a plan, no index, or never)
const asked: string[] = [];
let answer: 'plan' | 'none' | 'never' = 'plan';
const indexPlan = (): MigrationPlan => ({ steps: [], findings: [], problem: 'a problem the index found' } as unknown as MigrationPlan);
const host: ModsHost = {
    settings: () => settings,
    updateSettings: (patch) =>
    {
        asked.push('updateSettings');
        settings = { ...settings, ...patch };
    },
    gameDir: () =>
    {
        asked.push('gameDir');
        return gameDir;
    },
    documents: () => join(tmp, 'documents'),
    reindex: () => void asked.push('reindex'),
    query: <T>(method: string): Promise<T> =>
    {
        asked.push('query ' + method);

        if (method !== 'migrationPlan')
            return Promise.resolve(null as T);

        return answer === 'never' ? new Promise<T>(() => undefined) : Promise.resolve((answer === 'plan' ? indexPlan() : null) as T);
    },
    wrote: () => undefined,
    refreshFiles: (files) =>
    {
        refreshed.push([...files]);
        return Promise.resolve();
    },
    ready: () => Promise.resolve(),
    dataDir: () => join(tmp, 'data')
};
// (the files main's host was asked to take into the index, per call)
const refreshed: string[][] = [];

const thread = new MigrationThread(process.env.WORKER ? resolve(process.env.WORKER) : fileURLToPath(new URL('../src/main/migrationWorker.ts', import.meta.url)), host);

try
{
    // a plan: made in the worker, its host's calls answered by this one
    let plan = await thread.plan(modId, {});
    check(plan.problem === 'a problem the index found', 'a plan comes back from the worker as it made it');
    check(asked.includes('query migrationPlan') && asked.includes('gameDir'), 'the worker asked this host (the index query, the synchronous game folder)');

    // an error of the job
    answer = 'none';
    const noIndex = await thread.plan(modId, {}).then(() => undefined, (e: Error) => e);
    check(!!noIndex && !(noIndex instanceof MigrationCancelled) && noIndex.message === 'The index is not ready', 'a failed plan comes back as its error (' + noIndex?.message + ')');

    // a cancel while the plan waits for the index: it ends at once, and the worker takes the next job
    answer = 'never';
    const waiting = thread.plan(modId, {}).then(() => undefined, (e: Error) => e);
    await new Promise((r) => setTimeout(r, 300));
    const at = performance.now();
    thread.cancel();
    const cancelled = await waiting;
    const took = performance.now() - at;
    check(cancelled instanceof MigrationCancelled && took < 1000, `a cancel ends a plan waiting for the index (MigrationCancelled after ${Math.round(took)} ms: ${cancelled?.message})`);
    answer = 'plan';
    plan = await thread.plan(modId, {});
    check(plan.problem === 'a problem the index found', 'the next job after a cancel runs as before (the cancel was its job\'s alone)');

    // a run: its progress reaches main; the plan's problem ends it with that error
    const stages: MigrationProgress[] = [];
    const run = await thread.run(modId, { progress: (p) => stages.push(p) }).then(() => undefined, (e: Error) => e);
    check(run?.message === 'a problem the index found' && !(run instanceof MigrationCancelled), 'a run fails with its plan\'s problem');
    check(stages.length > 0 && stages[0].stage === 'Reading the mod…', 'the run\'s progress reached main before its end');

    // the settings each job reads: main's of the moment (another user folder: the mod is not there)
    const before = settings;
    settings = { ...settings, userDir: join(tmp, 'elsewhere') };
    const gone = await thread.plan(modId, {}).then(() => undefined, (e: Error) => e);
    check(!!gone && /^No mod /.test(gone.message), 'a job reads the settings main has when it starts (another user folder: ' + gone?.message + ')');
    settings = before;
    plan = await thread.plan(modId, {});
    check(plan.problem === 'a problem the index found', 'and the settings changed back with the next job');
}
catch (e)
{
    check(false, 'a job threw: ' + (e as Error).stack);
}

// the files a run wrote and did not hand to the index (migrate.ts RunWrites): a write after its update is pending again, a re-index
// takes in everything before it, the temporary file a write goes through is none of the mod's, paths alike whatever their case and slashes
{
    const w = new RunWrites();
    w.wrote(['C:\\p\\a.txt', 'C:\\p\\a.txt.crusaderpope-tmp', 'C:\\p\\b.txt']);
    w.reindexed();
    w.wrote(['C:\\p\\c.txt', 'C:\\p\\d.txt']);
    w.indexed(['c:/P/C.TXT']);
    w.wrote(['C:\\p\\e.txt']);
    check(w.pending().join() === 'C:\\p\\d.txt,C:\\p\\e.txt' && w.pending(['C:/p/E.txt']).join() === 'C:\\p\\d.txt', `the run's writes not handed to the index (${w.pending().join(', ')})`);
}

// a worker that crashes in a run: main hands the index what the run wrote and no step took in (the run's end would have), once,
// before the job fails; a run that ended hands its files over itself (a worker that speaks the protocol and crashes on cue)
{
    const fake = join(tmp, 'crashing-worker.mjs');
    writeFileSync(fake, `import { parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads';
const flags = new Int32Array(workerData.flags);
const sync = (call, args) =>
{
    Atomics.store(flags, 1, 0);
    parentPort.postMessage({ sync: call, args });
    let got;
    while (!(got = receiveMessageOnPort(workerData.answers)))
        Atomics.wait(flags, 1, 0);
    return got.message.result;
};
let calls = 0;
const call = (method, args) => parentPort.postMessage({ call: ++calls, method, args });
parentPort.on('message', (m) =>
{
    if (!('job' in m))
        return;
    const p = (f) => 'C:\\\\patch\\\\' + f;
    if (m.modId === 'crash')
    {
        sync('wrote', [[p('a.txt'), p('a.txt.crusaderpope-tmp')]]);
        call('refreshFiles', [[p('a.txt')]]);
        sync('wrote', [[p('b.txt')]]);
        parentPort.postMessage({ reindex: true });
        sync('wrote', [[p('c.txt'), p('c.txt.crusaderpope-tmp')]]);
        sync('wrote', [[p('d.txt')]]);
        call('refreshFiles', [[p('c.txt')]]);
        sync('wrote', [[p('c.txt'), p('c.txt.crusaderpope-tmp')]]);
    }
    else
    {
        sync('wrote', [[p('x.txt')]]);
        parentPort.postMessage({ job: m.job, failed: { message: 'Cancelled', cancelled: true } });
    }
    setTimeout(() => { throw new Error('crash in the test'); }, 100);
});
`);
    const crashing = new MigrationThread(fake, host);
    const at = refreshed.length;
    const crashed = await crashing.run('crash', {}).then(() => undefined, (e: Error) => ({ e, calls: refreshed.length - at }));
    const handed = refreshed.slice(at);
    // (the job's own two updates, then main's one for what was left: c written again after its update, d never handed over)
    check(!!crashed && /crashed: crash in the test/.test(crashed.e.message) && handed.length === 3 && crashed.calls === 3 && handed[2].map((f) => f.split('\\').pop()).sort().join() === 'c.txt,d.txt',
        `a crashed run's files no step took in go to the index once, before the job fails (${crashed?.e.message}; updates ${JSON.stringify(handed)})`);
    const at2 = refreshed.length;
    const ended = await crashing.run('ends', {}).then(() => undefined, (e: Error) => e);
    await new Promise((r) => setTimeout(r, 400));
    check(ended instanceof MigrationCancelled && refreshed.length === at2, `a run that ended (here: cancelled) leaves its files to its own end: main hands nothing over when the worker crashes after it (${refreshed.length - at2} updates)`);
}

// the undo journal of a thread that forwards it: the steps are kept by main's host's journal
{
    const file = join(modRoot, 'common', 'traits', 'test_traits.txt');
    const forwarded = new ForwardedJournal((op, args) => takeForwarded(host, op, structuredClone(args)));
    const worker: ModsHost = { ...host, undoJournal: () => forwarded };
    const r = await change(worker, 'Changed the trait', 'edit', async () =>
    {
        recordWrite(worker, file, () =>
        {
            writeFileSync(file, 'test_trait = { changed = yes }\n');
            return 'test_trait = { changed = yes }\n';
        });
        return { undo: 0 } as { undo: number; step?: number; };
    });
    const main = journalOf(host);
    const steps = main.list();
    check(steps.length === 1 && steps[0].id === r.step && steps[0].label === 'Changed the trait', 'a forwarded step is in main\'s journal, with its id given back (' + JSON.stringify(steps) + ')');
    check(r.undo === 1, 'the forwarded count of steps (' + r.undo + ')');
    check(readdirSync(join(tmp, 'data', 'undo')).some((f) => f.endsWith('.bin')) && JSON.parse(readFileSync(join(tmp, 'data', 'undo', 'journal.json'), 'utf8')).steps.length === 1, 'its earlier bytes in a blob of main\'s journal folder, one journal.json');
    const undone = await undoChange(host, { id: r.step });
    check(!!undone && !undone.refused && readFileSync(file, 'utf8') === 'test_trait = { }\n', 'undone from main\'s journal: the file as it was');
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);
