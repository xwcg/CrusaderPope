// Checks the loaded mods' folder watcher (src/main/mods/watch.ts, docs/mods.md "Watching the loaded mods") on a TEMP
// folder: what reaches the index (onFiles) and what is reported. Windows reports last-access updates too (a read of a
// file not read for an hour): a raw fs.watch next to it shows whether this machine does (the control). The app's own
// writes: an edit's, and a migration run's burst (each file announced before it is made, folders made after, deletions),
// none handed on; a hand edit after the 4 s is.
// Usage: node --experimental-strip-types --no-warnings scripts/watch-check.ts [keep]
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deleteFiles } from '../src/main/mods/patchLife.ts';
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

/** `expect`: what is handed on: a function when it depends on what the OS reported (the control) */
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

    // A migration run's writes into the patch mod (the active mod from its step 2 on): each file announced before it is made
    // (migrate.ts `put`: ModsHost.wrote → ignore, 4 s), its folder made after the announcement, written through a temporary
    // file and a rename as writeAtomic does; deletions announced at once (patchLife.ts `deleteFiles`, their folders go too).
    // Unannounced, main took them for another editor's saves and formatted them (the next plan was never clean).
    const runFiles = Array.from({ length: 48 }, (_, i) => join(root, 'common', 'scripted_effects', `run_${i % 4}`, `run_${i}.txt`));
    const runWrite = (f: string, text: string): void =>
    {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f + '.crusaderpope-tmp', text);
        renameSync(f + '.crusaderpope-tmp', f);
    };
    await round('a run’s writes, each announced first (new folders, temporary files)', () =>
    {
        for (const f of runFiles)
        {
            w.ignore([f, f + '.crusaderpope-tmp']);
            runWrite(f, 'run_effect = { add_gold = 1 }\n');
        }
    }, []);
    const goneRels = runFiles.filter((_, i) => i % 4 === 0).map((f) => f.slice(root.length + 1).replace(/\\/g, '/'));
    await round('the run deleting a folder’s files, announced at once (the emptied folder goes too)', () => deleteFiles(root, goneRels, (files) => w.ignore(files)), []);
    check(!existsSync(join(root, 'common', 'scripted_effects', 'run_0')), 'the emptied folder was removed');
    // (the control: the same kind of writes unannounced reach onFiles, as another editor's saves)
    const loose = join(root, 'common', 'scripted_effects', 'loose', 'loose.txt');
    got.length = 0;
    runWrite(loose, 'loose_effect = { add_gold = 1 }\n');
    await wait(900);
    const handed = got.flatMap((g) => g.files);
    check(handed.includes('watch_test/common/scripted_effects/loose/loose.txt'), `the same kind of write unannounced: handed on, as another editor's save (the control: ${handed.join(', ')})`);
    // (the window ends: a hand edit of a file the run wrote is a save like any other again)
    await wait(4500 - 900 * 3);
    await round('a hand edit of a run’s file after the 4 s: handed on', () => writeFileSync(runFiles[1], 'run_effect = { add_gold = 2 }\n'), ['watch_test/common/scripted_effects/run_1/run_1.txt']);
    // a zipped mod: the zip watched through its folder; a read is nothing, a write the pending change
    const zip = put(join(tmp, 'zips', 'zip_test.zip'), Buffer.alloc(2048, 5));
    const zipMod: WatchedMod = { id: 'mod/zip_test.mod', name: 'Zip Test', root: zip, archive: true };
    utimesSync(zip, past, past);
    w.watch([...mods, zipMod]);
    await wait(300);
    await round('the zip read', () => readFileSync(zip), []);
    check(change === null, 'the zip read: nothing pending');
    await round('the zip written (not handed on: the pending change)', () => writeFileSync(zip, Buffer.alloc(2048, 6)), []);
    check(change !== null && (change as ModChange).files.some((f) => f === 'zip_test.zip'), `the zip written: pending (${JSON.stringify((change as ModChange | null)?.files)})`);
    w.building();

    // Linux: a Workshop mod is watched through Steam's list of installed items (its timeupdated), not its folder
    const workshop = join(tmp, 'steamapps', 'workshop');
    const item = join(workshop, 'content', '1158310', '2220098919');
    put(join(item, 'descriptor.mod'), 'name="Workshop Test"\n');
    const acf = (t: number): string =>
        `"AppWorkshop"\n{\n\t"appid"\t\t"1158310"\n\t"WorkshopItemsInstalled"\n\t{\n\t\t"2220098919"\n\t\t{\n\t\t\t"size"\t\t"100"\n\t\t\t"timeupdated"\t\t"${t}"\n\t\t}\n\t\t"123"\n\t\t{\n\t\t\t"timeupdated"\t\t"5"\n\t\t}\n\t}\n\t"WorkshopItemDetails"\n\t{\n\t\t"2220098919"\n\t\t{\n\t\t\t"timeupdated"\t\t"1"\n\t\t}\n\t}\n}\n`;
    const acfFile = put(join(workshop, 'appworkshop_1158310.acf'), acf(1000));
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    w.watch([...mods, { id: 'steam/2220098919', name: 'Workshop Test', root: item, workshop: true }]);
    Object.defineProperty(process, 'platform', { value: platform });
    check(w.watched().some((m) => m.id === 'steam/2220098919'), 'Linux: the Workshop mod watched (through Steam’s list)');
    await round('Linux: a file in the Workshop folder written (its folder is not watched)', () => writeFileSync(join(item, 'descriptor.mod'), 'name="Workshop Test 2"\n'), [], 2600);
    await round('Linux: Steam’s list rewritten, the item’s time the same', () => writeFileSync(acfFile, acf(1000) + '\n'), [], 2600);
    check(change === null, 'the list rewritten unchanged: nothing pending');
    await round('Linux: the item updated (its time in the list)', () => writeFileSync(acfFile, acf(2000)), [], 2600);
    check(change !== null && (change as ModChange).mods.some((m) => m.id === 'steam/2220098919'), 'the item updated: its mod pending');
    w.building();
    w.watch(mods);

    // a mod no longer loaded: let go, its pending change with it
    w.report([otherFile]);
    check(change !== null && (change as ModChange).mods.some((m) => m.id === 'mod/other_test.mod'), 'reported: the other mod’s change is pending');
    w.watch([mods[0]]);
    check(w.watched().length === 1 && change === null, 'the other mod let go: its pending change goes');

    // more changed files than the sample holds: the sample is the last 50, `total` counts all (the top bar's "and N more")
    w.report(Array.from({ length: 60 }, (_, i) => join(root, 'common', 'traits', `many_${i}.txt`)));
    const many = change as ModChange | null;
    check(!!many && many.files.length === 50 && many.total === 60 && many.files[49] === 'common/traits/many_59.txt', `60 files reported: ${many?.files.length} listed, total ${String(many?.total)}`);
    w.report([join(root, 'common', 'traits', 'many_0.txt')]);
    check((change as ModChange | null)?.total === 60 && (change as ModChange | null)?.files.length === 50, 'one of them again: still 60 in all (a set)');
    w.building();
    check(change === null, 'a build clears it');
    w.report([join(root, 'common', 'traits', 'few.txt')]);
    check((change as ModChange | null)?.files.length === 1 && (change as ModChange | null)?.total === undefined, 'one file: no total (the list is all of them)');
}
finally
{
    control.close();
    w.close();
    console.log(failures ? `\n${failures} FAILED` : '\nall ok', `(temp folder ${tmp})`);

    if (process.argv[2] !== 'keep')
        rmSync(tmp, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
