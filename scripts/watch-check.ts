// Checks the loaded mods' folder watcher (src/main/mods/watch.ts, docs/mods.md "Watching the loaded mods") on a TEMP
// folder: what reaches the index (onFiles) and what is reported. Windows reports last-access updates too (a read of a
// file not read for an hour): a raw fs.watch next to it shows whether this machine does (the control).
// Usage: node --experimental-strip-types --no-warnings scripts/watch-check.ts [keep]
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModWatcher, type WatchedMod } from '../src/main/mods/watch.ts';
import type { ModChange } from '../src/shared/api.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ckp-watch-'));
const user = join(tmp, 'mod');
const root = join(user, 'watch_test');
const other = join(user, 'other_test');
const put = (file: string, text: string | Buffer): string =>
{
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
    return file;
};
// the files, their access time two hours back (NTFS updates it on a read when it is older than an hour)
const icon = put(join(root, 'gfx/interface/icons/traits/test_icon.dds'), Buffer.alloc(4096, 1));
const icon2 = put(join(root, 'gfx/interface/icons/traits/test_icon2.dds'), Buffer.alloc(4096, 2));
const trait = put(join(root, 'common/traits/test_traits.txt'), 'test_trait = { category = personality }\n');
const inner = put(join(root, 'descriptor.mod'), 'name="Watch Test"\n');
const outer = put(join(user, 'watch_test.mod'), `name="Watch Test"\npath="${root.replace(/\\/g, '/')}"\n`);
const otherFile = put(join(other, 'common/traits/other.txt'), 'other_trait = { }\n');
const past = new Date(Date.now() - 2 * 3600 * 1000);

for (const f of [icon, icon2, trait, inner, outer, otherFile])
    utimesSync(f, past, past);

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const rel = (f: string): string => f.slice(user.length + 1).replace(/\\/g, '/');

// what the watcher hands on, per mod
const got: { mod: string; files: string[]; }[] = [];
let change: ModChange | null = null;
const w = new ModWatcher((c) => (change = c), (files, mod) => got.push({ mod: mod.id, files: files.map(rel) }));
const mods: WatchedMod[] = [
    { id: 'mod/watch_test.mod', name: 'Watch Test', root, active: true, descriptor: outer },
    { id: 'mod/other_test.mod', name: 'Other Test', root: other }
];
// the control: every event the OS delivers for the mod folder
const raw: string[] = [];
const control = watch(root, { recursive: true }, (_e, f) => raw.push(String(f)));
w.watch(mods);
check(w.watched().length === 2, 'both mods watched');
// (the first walk of their files)
await wait(800);

/** `expect`: what is handed on — a function when it depends on what the OS reported (the control) */
const round = async (what: string, act: () => void, expect: string[] | (() => string[]), ms = 900): Promise<void> =>
{
    got.length = 0;
    raw.length = 0;
    act();
    await wait(ms);
    const files = got.flatMap((g) => g.files).sort();
    const want = (typeof expect === 'function' ? expect() : expect).sort();
    check(JSON.stringify(files) === JSON.stringify(want), `${what}: ${files.join(', ') || 'nothing handed on'} (the OS reported ${raw.length ? raw.join(', ') : 'nothing'})`);
};

try
{
    await round('reads of an image and the descriptors (access times two hours old)', () =>
    {
        readFileSync(icon);
        readFileSync(inner);
        readFileSync(outer);
    }, []);
    await round('an image written', () => writeFileSync(icon, Buffer.alloc(4096, 3)), ['watch_test/gfx/interface/icons/traits/test_icon.dds']);
    await round('another image copied over it (the copy keeps the source’s times)', () => copyFileSync(icon2, icon), ['watch_test/gfx/interface/icons/traits/test_icon.dds']);
    await round('a script file read (the index compares it with the version it read itself: handed on)', () => readFileSync(trait), () => (raw.length ? ['watch_test/common/traits/test_traits.txt'] : []));
    await round('the outer descriptor renamed', () => writeFileSync(outer, readFileSync(outer, 'utf8').replace('Watch Test', 'Watch Test 2')), ['watch_test.mod']);
    await round('the other mod’s file written', () => writeFileSync(otherFile, 'other_trait = { category = fame }\n'), ['other_test/common/traits/other.txt']);
    await round('an app write (ignored)', () =>
    {
        w.ignore([icon2, icon2 + '.crusaderpope-tmp']);
        writeFileSync(icon2, Buffer.alloc(4096, 4));
    }, []);
    await round('a read of the app’s own write since (no change)', () => readFileSync(icon2), []);
    // a mod no longer loaded: let go, its pending change with it
    w.report([otherFile]);
    check(change !== null && (change as ModChange).mods.some((m) => m.id === 'mod/other_test.mod'), 'reported: the other mod’s change is pending');
    w.watch([mods[0]]);
    check(w.watched().length === 1 && change === null, 'the other mod let go: its pending change goes');
}
finally
{
    control.close();
    w.close();
    console.log(failures ? `\n${failures} FAILED` : '\nall ok', '— temp folder', tmp);

    if (process.argv[2] !== 'keep')
        rmSync(tmp, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
