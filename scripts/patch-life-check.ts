// Checks the patch mod's records (src/main/mods/patchLife.ts) on TEMP folders, without the game or an index: which files a run
// records as its own (a file put there by hand is not), what a reset deletes after the mod was updated (a file changed by hand
// stays; a patch mod from before the records keeps what was touched after its last run), a copy carried to another path, a
// copy the owner changed that a rule rewrote, which files a run may rewrite in place after a reset. The whole migration is
// scripts/migrate-check.ts.
// Usage: node --experimental-strip-types --no-warnings scripts/patch-life-check.ts
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModInfo } from '../src/shared/api.ts';
import { MANIFEST_FILE, sha1, type FixesManifest } from '../src/main/mods/fixesManifest.ts';
import { deleteFiles, hashFiles, modChanges, ownedFiles, patchFiles, recordLife, type ModFiles } from '../src/main/mods/patchLife.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

const tmp = mkdtempSync(join(tmpdir(), 'ckp-patchlife-'));
const mod = { id: 'mod/x.mod', name: 'X' } as ModInfo;
let n = 0;

/** A mod folder and a patch mod folder with the given files; the mod's files as the migration lists them. */
function world(modFiles: Record<string, string>, patchFilesText: Record<string, string>): { modRoot: string; patchRoot: string; modFiles: ModFiles; write: (side: 'mod' | 'patch', rel: string, text: string) => void; }
{
    const base = join(tmp, String(++n));
    const modRoot = join(base, 'mod');
    const patchRoot = join(base, 'patch');
    const listed: ModFiles = new Map();
    const write = (side: 'mod' | 'patch', rel: string, text: string): void =>
    {
        const file = join(side === 'mod' ? modRoot : patchRoot, ...rel.split('/'));
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, text);

        if (side === 'mod')
            listed.set(rel, { file });
    };
    mkdirSync(modRoot, { recursive: true });
    mkdirSync(patchRoot, { recursive: true });

    for (const [rel, text] of Object.entries(modFiles))
        write('mod', rel, text);

    for (const [rel, text] of Object.entries(patchFilesText))
        write('patch', rel, text);

    return { modRoot, patchRoot, modFiles: listed, write };
}

const run = (w: ReturnType<typeof world>, manifest: FixesManifest, carried?: ModFiles, since?: number): FixesManifest =>
{
    const before = hashFiles(w.patchRoot, patchFiles(w.patchRoot));
    // (the rules ran: nothing written here, the files are as the test left them)
    recordLife({ manifest, mod, modFiles: w.modFiles, patchRoot: w.patchRoot, before, carried, since });
    return manifest;
};
const empty = (): FixesManifest => ({ restored: {}, merged: {}, lost: {} });

try
{
    // 1. a file put into the patch mod by hand is not recorded, so a reset after a mod update leaves it
    {
        const w = world({ 'common/a.txt': 'one' }, { 'common/a.txt': 'fixed one' });
        const m = run(w, empty());
        check(!!m.files?.['common/a.txt'] && !!m.sources?.['common/a.txt'], 'the first run records its copy and the source');
        w.write('patch', 'common/mine.txt', 'my own file');
        run(w, m);
        check(m.files?.['common/mine.txt'] === undefined && m.files?.['common/a.txt'] !== undefined, `a file put there by hand is not taken as the run's own (${Object.keys(m.files ?? {}).join(', ')})`);
        w.write('mod', 'common/a.txt', 'two');
        const c = modChanges(mod, w.modFiles, w.patchRoot, m, new Set());
        check(c.stale.length === 1 && c.reset.join() === 'common/a.txt' && !c.reset.includes('common/mine.txt'), `the mod's update resets the recorded copy only (${c.reset.join()})`);
    }

    // 2. a file the run did write is recorded, also a new one
    {
        const w = world({ 'common/a.txt': 'one' }, {});
        const m = empty();
        const before = hashFiles(w.patchRoot, patchFiles(w.patchRoot));
        w.write('patch', 'common/a.txt', 'fixed');
        w.write('patch', 'common/new.txt', 'made');
        recordLife({ manifest: m, mod, modFiles: w.modFiles, patchRoot: w.patchRoot, before });
        check(Object.keys(m.files ?? {}).sort().join() === 'common/a.txt,common/new.txt', `files the run wrote are recorded (${Object.keys(m.files ?? {}).join()})`);
    }

    // 3. a patch mod from before the records: taken whole by the first run, except what was touched after its last run
    {
        const w = world({ 'common/a.txt': 'one' }, { 'common/a.txt': 'fixed one', 'common/old.txt': 'made by the tool' });
        const manifestFile = join(w.patchRoot, MANIFEST_FILE);
        writeFileSync(manifestFile, '{}');
        const t = new Date(Date.now() - 600000);
        utimesSync(manifestFile, t, t);
        utimesSync(join(w.patchRoot, 'common', 'a.txt'), new Date(t.getTime() - 5000), new Date(t.getTime() - 5000));
        utimesSync(join(w.patchRoot, 'common', 'old.txt'), new Date(t.getTime() - 5000), new Date(t.getTime() - 5000));
        w.write('patch', 'common/hand.txt', 'written by hand after the last run');
        const m = empty();
        run(w, m, undefined, t.getTime());
        check(Object.keys(m.files ?? {}).sort().join() === 'common/a.txt,common/old.txt', `the first run takes the files of the patch mod from before the records, but not what was touched after its last run (${Object.keys(m.files ?? {}).join()})`);

        // (the same patch mod when the mod file is newer than its copy: the reset leaves the hand-made file)
        const later = new Date(Date.now() + 60000);
        utimesSync(join(w.modRoot, 'common', 'a.txt'), later, later);
        const legacy = modChanges(mod, w.modFiles, w.patchRoot, { restored: {}, merged: {}, lost: {} }, new Set());
        check(legacy.legacy && legacy.stale.map((s) => s.rel).join() === 'common/a.txt' && legacy.reset.slice().sort().join() === 'common/a.txt,common/old.txt' && legacy.edited.join() === 'common/hand.txt', `without records: the files from before the manifest are reset, the one touched after it stays (reset ${legacy.reset.join()}, kept ${legacy.edited.join()})`);
    }

    // 4. no manifest at all: nothing proves the tool made the folder, nothing is stale
    {
        const w = world({ 'common/a.txt': 'one' }, { 'common/a.txt': 'fixed one' });
        const later = new Date(Date.now() + 60000);
        utimesSync(join(w.modRoot, 'common', 'a.txt'), later, later);
        const c = modChanges(mod, w.modFiles, w.patchRoot, undefined, new Set());
        check(!c.stale.length && !c.reset.length, 'a folder without a manifest is never reset');
    }

    // 5. a copy the owner changed and a rule rewrote stays the owner's: the next update does not delete it
    {
        const w = world({ 'common/f.txt': 'one' }, { 'common/f.txt': 'fixed one' });
        const m = run(w, empty());
        const recorded = m.files!['common/f.txt'];
        w.write('patch', 'common/f.txt', 'fixed one # my edit');
        w.write('mod', 'common/f.txt', 'two');
        // (a rule rewrites the copy in the next run)
        const before = hashFiles(w.patchRoot, patchFiles(w.patchRoot));
        w.write('patch', 'common/f.txt', 'fixed one # my edit # renamed');
        recordLife({ manifest: m, mod, modFiles: w.modFiles, patchRoot: w.patchRoot, before });
        check(m.files!['common/f.txt'] === recorded, 'the rewritten copy keeps the record it had (it is still the owner’s)');
        const c = modChanges(mod, w.modFiles, w.patchRoot, m, new Set());
        check(!c.stale.length && c.keptStale.join() === 'common/f.txt' && !c.reset.length, `and the update of its source is told, not applied (${JSON.stringify(c)})`);
    }

    // 6. a copy made at another path than its source (a banner texture): the mod updating the source reaches it
    {
        const w = world({ 'gfx/old/b.dds': 'banner one' }, {});
        const m = empty();
        const before = hashFiles(w.patchRoot, patchFiles(w.patchRoot));
        w.write('patch', 'gfx/new/b.dds', 'banner one');
        recordLife({ manifest: m, mod, modFiles: w.modFiles, patchRoot: w.patchRoot, before, carried: new Map([['gfx/new/b.dds', w.modFiles.get('gfx/old/b.dds')!]]) });
        check(m.sources?.['gfx/new/b.dds']?.from === 'gfx/old/b.dds', `the copy has its source recorded (${JSON.stringify(m.sources)})`);
        // (a run that does not write it keeps the record)
        run(w, m);
        check(m.sources?.['gfx/new/b.dds']?.from === 'gfx/old/b.dds', 'and a run that leaves it alone keeps the record');
        check(!modChanges(mod, w.modFiles, w.patchRoot, m, new Set()).stale.length, 'the mod as it was: nothing stale');
        w.write('mod', 'gfx/old/b.dds', 'banner two');
        const c = modChanges(mod, w.modFiles, w.patchRoot, m, new Set());
        check(c.stale.map((s) => s.rel).join() === 'gfx/new/b.dds' && c.reset.join() === 'gfx/new/b.dds', `the mod updating the texture in the old folder makes the copy stale (${JSON.stringify(c.stale)})`);
        w.write('mod', 'gfx/old/b.dds', 'banner one');
        w.write('mod', 'gfx/new/b.dds', 'the mod’s own banner in the new folder');
        const d = modChanges(mod, w.modFiles, w.patchRoot, m, new Set());
        check(d.stale.map((s) => s.rel).join() === 'gfx/new/b.dds', `the mod shipping a file at the copy's own path makes it stale too (${JSON.stringify(d.stale)})`);
    }

    // 7. a source the mod dropped
    {
        const w = world({ 'common/a.txt': 'one' }, { 'common/a.txt': 'fixed one' });
        const m = run(w, empty());
        w.modFiles.delete('common/a.txt');
        const c = modChanges(mod, w.modFiles, w.patchRoot, m, new Set());
        check(c.stale[0]?.why === 'gone' && c.reset.join() === 'common/a.txt', 'a file the mod dropped: its copy is stale');
    }

    // 8. after a reset the files the run makes again are its own: the inert step may rewrite them in place in this run (they were left
    // out of it before, as if changed by hand, and only the plan after the run, with the new records, found the rewrite to do)
    {
        const w = world({ 'common/a.txt': 'one' }, { 'common/a.txt': 'fixed one', 'common/zz_merged.txt': 'merged', 'common/b.txt': 'fixed b' });
        const m = run(w, empty());
        w.write('patch', 'common/b.txt', 'fixed b # my edit');
        w.write('patch', 'common/hand.txt', 'put there by hand');
        w.write('mod', 'common/a.txt', 'two');
        const c = modChanges(mod, w.modFiles, w.patchRoot, m, new Set());
        check(c.reset.slice().sort().join() === 'common/a.txt,common/zz_merged.txt' && c.edited.join() === 'common/b.txt', `the update resets the run's files, the one changed by hand stays (reset ${c.reset.join()}, kept ${c.edited.join()})`);
        deleteFiles(w.patchRoot, c.reset);
        const before = hashFiles(w.patchRoot, patchFiles(w.patchRoot));
        // (the run makes them again; a file its last run had and the owner deleted, made again, is the same case)
        w.write('patch', 'common/a.txt', 'fixed two');
        w.write('patch', 'common/zz_merged.txt', 'merged');
        const owned = ownedFiles(w.patchRoot, m, before) ?? [];
        check(owned.slice().sort().join() === 'common/a.txt,common/zz_merged.txt', `in the run, the files it made again after the reset are its own, the ones changed or put there by hand are not (${owned.join(', ')})`);
        recordLife({ manifest: m, mod, modFiles: w.modFiles, patchRoot: w.patchRoot, before });
        const plan = ownedFiles(w.patchRoot, m) ?? [];
        check(plan.slice().sort().join() === owned.slice().sort().join(), `and the plan after the run sees the same files as the run's (${plan.join(', ')})`);
    }

    // 9. sha1 of the record is the hash of the bytes
    {
        const w = world({}, { 'x.txt': 'abc' });
        check(hashFiles(w.patchRoot, ['x.txt']).get('x.txt') === sha1(Buffer.from('abc')), 'hashFiles is the sha1 of the bytes');
    }
}
finally
{
    rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
