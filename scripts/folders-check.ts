// Checks the in-app folder picker's file-system side (src/main/folders.ts) and the Browse… search
// (src/main/findNear.ts) on a TEMP folder of 9,000 files: listing and searching by name make no stat call per entry
// (the file functions are counted), a Crusader Kings III install two levels down is found, a missing start folder
// leads to its nearest existing parent; and times them, also on a real folder given as an argument.
// Usage: node --experimental-strip-types --no-warnings scripts/folders-check.ts [a big folder of your own to time it on]
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// count the calls that touch an entry's metadata (stat, lstat, existsSync, access), patched before the modules load
const calls: Record<string, number> = {};
const count = <T extends (...a: never[]) => unknown>(name: string, f: T): T =>
    ((...a: never[]) =>
    {
        calls[name] = (calls[name] ?? 0) + 1;
        return f(...a);
    }) as T;
// (through a mutable view: the typings mark some of them read-only)
const sync = fs as unknown as Record<string, (...a: never[]) => unknown>;
const prom = fs.promises as unknown as Record<string, (...a: never[]) => unknown>;

for (const k of ['statSync', 'lstatSync', 'existsSync'])
    sync[k] = count(k, sync[k]);

for (const k of ['stat', 'lstat', 'access'])
    prom[k] = count('promises.' + k, prom[k]);

syncBuiltinESMExports();

const { listDirs, nearestExisting, makeFolder } = await import('../src/main/folders.ts');
const { browsed } = await import('../src/main/findNear.ts');

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};
const reset = (): void =>
{
    for (const k of Object.keys(calls))
        delete calls[k];
};
const total = (): number => Object.values(calls).reduce((a, b) => a + b, 0);
const timed = async <T>(f: () => Promise<T>): Promise<[T, number]> =>
{
    const t = performance.now();
    const r = await f();
    return [r, Math.round(performance.now() - t)];
};

const root = mkdtempSync(join(tmpdir(), 'ckp-folders-'));

try
{
    // 9,000 files and 40 subfolders (2, 10, 100 … to check the numeric order), one of them holding an install deeper down
    const big = join(root, 'big');
    mkdirSync(big);

    for (let i = 0; i < 9000; i++)
        writeFileSync(join(big, `file_${i}.txt`), '');

    for (let i = 0; i < 40; i++)
        mkdirSync(join(big, `folder ${i * 5}`));

    const install = join(big, 'folder 10', 'Crusader Kings III');
    mkdirSync(join(install, 'game', 'common', 'landed_titles'), { recursive: true });
    mkdirSync(join(install, 'game', 'events'), { recursive: true });

    reset();
    const [l, ms] = await timed(() => listDirs(big));
    check(l.dirs.length === 40 && l.files === 9000 && total() === 0, `listing 9,000 files and 40 folders: ${ms} ms, ${total()} stat-like calls`);
    check(l.dirs[0] === 'folder 0' && l.dirs[1] === 'folder 5' && l.dirs[2] === 'folder 10', `folders in numeric order: ${l.dirs.slice(0, 4).join(', ')} …`);
    check(l.parent === root, 'its parent');

    const drive = await listDirs(join(root, '..').split(/[\\/]/)[0] + '\\');
    check(drive.parent === null && !drive.error, `a drive root has no parent (${drive.path})`);

    const missing = await listDirs(join(big, 'not', 'there'));
    check(missing.notFound && missing.error, 'a missing folder: an error as data, notFound');
    check((await nearestExisting(join(big, 'not', 'there', 'yet'))) === big, 'a missing start folder: its nearest existing parent');

    // the Browse… search: the install two levels down; the user folder (named Crusader Kings III) nowhere: no folder
    // checked on disk for it
    reset();
    const [g, gms] = await timed(() => browsed(big, 'game'));
    check(g?.path === install, `game: the install two levels down found (${gms} ms, ${calls.existsSync ?? 0} existsSync, only for folders named like it)`);
    reset();
    const [u, ums] = await timed(() => browsed(big, 'user'));
    // (the install's folder is named Crusader Kings III: the only one checked (3 files looked for), and it is no user folder)
    check(u?.path === big && !u.picked && (calls.existsSync ?? 0) === 3, `user: none near, the folder as picked (${ums} ms, ${calls.existsSync ?? 0} existsSync: only the one folder named Crusader Kings III of 40 + its subfolders)`);

    // new folder
    const made = await makeFolder(big, 'New one');
    check(made.path === join(big, 'New one'), 'new folder made');
    check((await makeFolder(big, 'New one')).error?.includes('exists already'), 'a second time: "exists already"');
    check((await makeFolder(big, 'bad:name')).error, 'an invalid name: refused');

    // a real folder (argument): listing and searching it
    const real = process.argv[2];

    if (real)
    {
        reset();
        const [rl, rms] = await timed(() => listDirs(real));
        console.log(`     ${real}: ${rl.dirs.length} folders, ${rl.files} files listed in ${rms} ms (${total()} stat-like calls)`);

        for (const kind of ['game', 'user'] as const)
        {
            reset();
            const [r, t] = await timed(() => browsed(real, kind));
            console.log(`     Browse… search for the ${kind} folder from it: ${t} ms, ${calls.existsSync ?? 0} existsSync → ${r?.picked ? r.path : 'as picked'}`);
        }
    }
}
finally
{
    rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
process.exitCode = failures ? 1 : 0;
