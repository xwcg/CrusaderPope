// Runs the project's checks, several at a time: the type check, the i18n check and every scripts/*-check.ts /
// *-check.mjs with its default arguments (docs/dev-gotchas.md, "Checks and the index"). Each script's output goes to a
// file of its own under %TEMP%/ckp-checks/<time>/; a table at the end says pass / fail / time, and the failing lines.
// Usage: node scripts/run-checks.mjs [--jobs N] [--timeout MIN] [--only a,b] [--skip a,b] [--no-static] [--slots] [--list]
//                                    [--dir <scripts folder>] [--out <folder>]
//   --jobs N       checks at a time (default 2); every check that builds an index takes a core or more and 3 to 6 GB: on the
//                  32 GB development machine 3 at a time left 1 to 3 GB free and paged; measure free memory before raising it
//   --timeout MIN  minutes a check may run before it is killed (default 40; a check the table below knows may have its own)
//   --only / --skip  check names without the extension (card-text-check …), comma separated
//   --no-static    leave out the type check and the i18n check
//   --slots        take one of the two heavy-run slots (%TEMP%/ckp-heavy-N.lock) before a check that builds an index and
//                  give it back after it, for a machine several agents work on; a slot older than 45 minutes is stale
//   --dir          the scripts folder to run (default: the one this file is in; a copy of older scripts gives the "before" numbers)
//   --out          the output folder (default %TEMP%/ckp-checks/<time>)
// Left out, with the reason in the table: icon-check.mjs (drives the built app), mod-check.ts (needs MOD=<mod>), blender-check.ts
// unless Blender is found (BLENDER=<blender.exe>, else Blender 4.5 / 4.4 / 3.4 in its default folder), save-layer-check.ts unless a
// .ck3 file is in %TEMP%/ck3-saves. Exit code 1 when any check failed or timed out.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const list = (name) => (value(name, '') || '').split(',').map((s) => s.trim()).filter(Boolean);

// (--help, or a flag it does not know, prints the usage above and runs nothing: an unknown flag once started the whole suite)
{
    const withValue = new Set(['--jobs', '--timeout', '--only', '--skip', '--dir', '--out']);
    const known = new Set([...withValue, '--no-static', '--slots', '--list']);
    const unknown = argv.filter((a, i) => !(i > 0 && withValue.has(argv[i - 1])) && !known.has(a));

    if (unknown.length)
    {
        const usage = readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.startsWith('//')).slice(3, 17).map((l) => l.slice(3)).join('\n');
        console.log(`${unknown.includes('--help') || unknown.includes('-h') ? '' : `unknown: ${unknown.join(' ')}\n`}${usage}`);
        process.exit(unknown.every((a) => a === '--help' || a === '-h') ? 0 : 1);
    }
}

const jobs = Math.max(1, Number(value('--jobs', 2)) || 2);
const defaultTimeout = Number(value('--timeout', 40)) || 40;
const only = list('--only');
const skip = list('--skip');
const scriptsDir = resolve(value('--dir', here));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const outDir = resolve(value('--out', join(tmpdir(), 'ckp-checks', stamp)));
const useSlots = flag('--slots');

// node flags every check runs with (sqlite for the mod manager, gc for the memory printouts, a heap for the AGOT-sized runs)
const NODE_FLAGS = ['--experimental-strip-types', '--experimental-sqlite', '--expose-gc', '--no-warnings', '--max-old-space-size=8000'];
// checks with their own limit (minutes), arguments or environment
const SPECIAL = {
    'migrate-check': { minutes: 150 },
    'refresh-check': { minutes: 60 },
    'edit-coverage-check': { minutes: 60 },
    'zip-check': { minutes: 20 },
    // compiles HLSL with the Direct3D compiler where there is one; HLSL_RUN / HLSL_MODS / SHADERCACHE add the game-run proof (see its header)
    'shader-hlsl-check': { minutes: 15 },
    'cast-check': { args: ['court.8190'] },
    // (the game's documentation the script database is built from; `--facts` compares the tables as the app runs them)
    'game-docs-check': { args: ['data/game-docs/1.20.1.2/script_docs', '--facts'] }
};
const HEAVY = /\b(GameIndex|fastIndex|GameFiles)\b/;

function blender()
{
    const dirs = ['Blender 4.5', 'Blender 4.4', 'Blender 3.4'].map((v) => join('C:\\Program Files\\Blender Foundation', v, 'blender.exe'));
    return [process.env.BLENDER, ...dirs].find((p) => p && existsSync(p));
}

function firstSave()
{
    const dir = join(tmpdir(), 'ck3-saves');
    const walk = (d) =>
    {
        try
        {
            for (const e of readdirSync(d, { withFileTypes: true }))
            {
                const p = join(d, e.name);

                if (e.isDirectory())
                {
                    const f = walk(p);

                    if (f)
                        return f;
                }
                else if (/\.ck3$/i.test(e.name))
                    return p;
            }
        }
        catch
        {
            // (no folder, no save)
        }

        return undefined;
    };
    return walk(dir);
}

// ---- what to run
const tasks = [];

if (!flag('--no-static'))
{
    tasks.push({ name: 'typecheck', cmd: process.execPath, args: [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.node.json'], then: [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.web.json'], minutes: 15 });
    tasks.push({ name: 'i18n-check', cmd: process.execPath, args: ['--experimental-strip-types', '--no-warnings', join(root, 'scripts', 'i18n.ts'), 'check'], minutes: 10 });
}

const skipped = [];

for (const f of readdirSync(scriptsDir).sort())
{
    const m = /^(.+-check(?:-[a-z]+)?)\.(ts|mjs)$/.exec(f);

    if (!m)
        continue;

    const name = m[1];

    if (only.length && !only.includes(name))
        continue;

    if (skip.includes(name))
        continue;

    const file = join(scriptsDir, f);
    const sp = SPECIAL[name] ?? {};
    let args = [...(sp.args ?? [])];

    if (name === 'icon-check')
    {
        skipped.push([name, 'drives the built app']);
        continue;
    }

    if (name === 'mod-check' && !process.env.MOD)
    {
        skipped.push([name, 'needs MOD=<mod>']);
        continue;
    }

    if (name === 'blender-check' && !blender())
    {
        skipped.push([name, 'no Blender found']);
        continue;
    }

    if (name === 'save-check' || name === 'save-layer-check')
    {
        const save = firstSave();

        if (name === 'save-layer-check' && !save)
        {
            skipped.push([name, 'no .ck3 in %TEMP%/ck3-saves']);
            continue;
        }

        if (name === 'save-layer-check')
            args = [save];
    }

    const text = readFileSync(file, 'utf8');
    tasks.push({ name, cmd: process.execPath, args: [...NODE_FLAGS, file, ...args], minutes: sp.minutes ?? defaultTimeout, heavy: HEAVY.test(text) || name === 'blender-check' });
}

if (flag('--list'))
{
    for (const t of tasks)
        console.log(`${t.name}${t.heavy ? ' (builds an index)' : ''} ${t.minutes} min`);

    for (const [n, why] of skipped)
        console.log(`${n}: left out, ${why}`);

    process.exit(0);
}

// ---- heavy slots (several agents on one machine)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function takeSlot(key)
{
    for (;;)
    {
        for (let n = 1; n <= 2; n++)
        {
            const dir = join(tmpdir(), `ckp-heavy-${n}.lock`);

            try
            {
                mkdirSync(dir);
                writeFileSync(join(dir, 'owner'), key);
                return dir;
            }
            catch (e)
            {
                if (e.code !== 'EEXIST')
                    throw e;

                try
                {
                    if (Date.now() - statSync(dir).mtimeMs > 45 * 60000)
                    {
                        rmSync(dir, { recursive: true, force: true });
                        n--;
                    }
                }
                catch
                {
                    // (gone meanwhile)
                }
            }
        }

        await sleep(5000);
    }
}

// ---- running
mkdirSync(outDir, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const results = [];

function runProcess(t, args, logFile, minutes)
{
    return new Promise((resolveRun) =>
    {
        const log = (s) => writeFileSync(logFile, s, { flag: 'a' });
        const child = spawn(t.cmd, args, { cwd: root, env, windowsHide: true });
        let timedOut = false;
        const timer = setTimeout(() =>
        {
            timedOut = true;

            if (process.platform === 'win32')
                spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
            else
                child.kill('SIGKILL');
        }, minutes * 60000);
        child.stdout.on('data', (d) => log(d));
        child.stderr.on('data', (d) => log(d));
        child.on('error', (e) =>
        {
            log(`\n[run-checks] could not start: ${e.message}\n`);
        });
        child.on('close', (code) =>
        {
            clearTimeout(timer);
            resolveRun({ code: timedOut ? -1 : code, timedOut });
        });
    });
}

async function runTask(t)
{
    const logFile = join(outDir, `${t.name}.log`);
    writeFileSync(logFile, '');
    const slot = useSlots && t.heavy ? await takeSlot(`run-checks ${process.pid} ${t.name}`) : null;
    const t0 = Date.now();

    try
    {
        let r = await runProcess(t, t.args, logFile, t.minutes);

        if (r.code === 0 && t.then)
            r = await runProcess(t, t.then, logFile, t.minutes);

        const ms = Date.now() - t0;
        const text = readFileSync(logFile, 'utf8');
        const lines = text.split(/\r?\n/);
        const bad = lines.filter((l) => /\bFAIL(ED)?\b|^\s*not ok|\berror TS\d+|Error:|✗/.test(l)).slice(0, 8);
        const note = r.timedOut ? `killed after ${t.minutes} min` : r.code === 0 ? '' : `exit ${r.code}`;
        const tail = lines.filter((l) => l.trim()).slice(-4);
        const failing = r.code === 0 ? [] : bad.length ? bad : tail.length ? tail : ['(no output)'];
        results.push({ name: t.name, ok: r.code === 0, ms, note, failing, log: logFile });
        console.log(`${r.code === 0 ? 'pass' : 'FAIL'}  ${t.name}  ${(ms / 1000).toFixed(1)} s${note ? '  ' + note : ''}`);
    }
    finally
    {
        if (slot)
            rmSync(slot, { recursive: true, force: true });
    }
}

let next = 0;
const t00 = Date.now();
await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, async () =>
{
    while (next < tasks.length)
        await runTask(tasks[next++]);
}));

// ---- summary
results.sort((a, b) => a.name.localeCompare(b.name));
const width = Math.max(...results.map((r) => r.name.length), 4);
const out = [];
out.push(`${'check'.padEnd(width)}  result  time`);

for (const r of results)
    out.push(`${r.name.padEnd(width)}  ${r.ok ? 'pass  ' : 'FAIL  '}  ${(r.ms / 1000).toFixed(1).padStart(7)} s${r.note ? '  ' + r.note : ''}`);

for (const [n, why] of skipped)
    out.push(`${n.padEnd(width)}  left out: ${why}`);

const failed = results.filter((r) => !r.ok);
out.push(`${results.length - failed.length} passed, ${failed.length} failed, ${skipped.length} left out; ${((Date.now() - t00) / 1000).toFixed(0)} s on ${jobs} at a time; sum of the checks ${(results.reduce((s, r) => s + r.ms, 0) / 1000).toFixed(0)} s`);

for (const r of failed)
{
    out.push('', `--- ${r.name} (${r.log})`);

    for (const l of r.failing)
        out.push('  ' + l.slice(0, 300));
}

out.push('', `outputs: ${outDir}`);
const summary = out.join('\n');
writeFileSync(join(outDir, 'summary.txt'), summary + '\n');
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(results.map(({ name, ok, ms, note }) => ({ name, ok, ms, note })), null, 1));
console.log('\n' + summary);
process.exit(failed.length ? 1 : 0);
