// Checks the mod manager (src/main/mods/manager.ts) against a TEMP copy of the CK3 user folder: the launcher database,
// dlc_load.json and the mod/*.mod descriptors are copied (not mod content); the real folder is only read, and its
// files are compared before and after.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings scripts/mods-manage-check.ts [keep]
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModsState, Settings } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { defaultUserDir } from '../src/main/mods/discover.ts';
import { readLauncher } from '../src/main/mods/launcher.ts';
import { parseDescriptor } from '../src/main/mods/descriptor.ts';
import { ZipArchive } from '../src/main/mods/zip.ts';
import { runningLauncher } from '../src/main/mods/processes.ts';
import { BACKUP_FOLDER, backupsOf, rotatingBackup } from '../src/main/mods/backup.ts';
import { versionMatches, supportedVersionFor, modFolderProblem } from '../src/shared/modRules.ts';
import * as mgr from '../src/main/mods/manager.ts';
import { defaultInstall } from './ck3-install.ts';

const install = defaultInstall();
const real = process.env.CK3_USER_DIR ?? defaultUserDir(join(homedir(), 'Documents'));
const tmp = mkdtempSync(join(tmpdir(), 'ckp-user-'));

// what must not change in the real folder
const guarded = (): string[] => [
    join(real, 'launcher-v2.sqlite'),
    join(real, 'dlc_load.json'),
    ...readdirSync(join(real, 'mod')).filter((f) => /\.mod$/i.test(f)).map((f) => join(real, 'mod', f))
];
const hashes = (): string =>
    guarded()
        .map((f) => f + ' ' + (existsSync(f) ? createHash('sha1').update(readFileSync(f)).digest('hex') : '-'))
        .join('\n') + '\n' + readdirSync(join(real, 'mod')).sort().join('|');
const realBefore = hashes();

// the temp user folder
mkdirSync(join(tmp, 'mod'));

for (const f of ['launcher-v2.sqlite', 'dlc_load.json'])
    if (existsSync(join(real, f)))
        copyFileSync(join(real, f), join(tmp, f));

for (const f of readdirSync(join(real, 'mod')).filter((x) => /\.mod$/i.test(x)))
    copyFileSync(join(real, 'mod', f), join(tmp, 'mod', f));

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};
const rejects = async (p: Promise<unknown>, pattern: RegExp, what: string): Promise<void> =>
{
    try
    {
        await p;
        check(false, what + ' (no error)');
    }
    catch (e)
    {
        check(pattern.test(String((e as Error).message)), `${what}: ${(e as Error).message}`);
    }
};

let settings: Settings = { gameDir: install, language: 'english', userDir: tmp };
let reindexed = 0;
let launcherRunning: string | null | undefined;
const host: mgr.ModsHost = {
    settings: () => settings,
    updateSettings: (patch) => (settings = { ...settings, ...patch }),
    gameDir: () => resolveGameDir(settings.gameDir),
    documents: () => join(tmp, 'no-documents'),
    reindex: () => reindexed++,
    launcherRunning: async () => launcherRunning
};
const reindexedBy = async <T>(p: Promise<T>): Promise<{ value: T; n: number; }> =>
{
    const n0 = reindexed;
    const value = await p;
    return { value, n: reindexed - n0 };
};

try
{
    // rules
    check(versionMatches('1.19.*', '1.19.0.6') === true, 'supported 1.19.* fits 1.19.0.6');
    check(versionMatches('1.18.4', '1.19.0.6') === false, 'supported 1.18.4 does not fit 1.19.0.6');
    check(versionMatches('*.*.*', '1.19.0.6') === true && versionMatches('1.19', '1.19.0.6') === true, 'wildcards and short versions');
    check(supportedVersionFor('1.19.0.6') === '1.19.*', 'default supported version 1.19.*');
    check(!modFolderProblem('my_mod-2') && !!modFolderProblem('bad name') && !!modFolderProblem('con') && !!modFolderProblem('x.mod'), 'folder name rules');
    const proc = await runningLauncher();
    console.log('launcher process now:', proc === null ? 'unknown (process list unreadable)' : (proc ?? 'not running'));

    let s: ModsState = await mgr.modsState(host);
    const agot = s.lists.find((l) => l.kind === 'playset' && l.name === 'AGOT')!;
    console.log(`temp user folder ${tmp}: ${s.mods.length} mods, lists: ${s.lists.map((l) => `${l.name} (${l.mods.length})`).join(', ')}`);
    check(s.launcher && agot && s.lists.some((l) => l.ref === 'game'), 'launcher playsets and the game list read');

    // selecting lists
    let r = await reindexedBy(mgr.selectList(host, agot.ref));
    check(r.n === 1 && r.value.selected === agot.ref && settings.modList === agot.ref, 'select AGOT playset → re-index');
    r = await reindexedBy(mgr.selectList(host, agot.ref));
    check(r.n === 0, 'select the same list again → no re-index');
    r = await reindexedBy(mgr.selectList(host, 'game'));
    check(r.n === 0, 'select the game list with the same mods → no re-index');
    await rejects(mgr.selectList(host, 'custom:nope'), /Unknown mod list/, 'select an unknown list');

    // custom lists
    const two = agot.mods.map((e) => ({ ...e }));
    r = await reindexedBy(mgr.saveList(host, { name: 'Check list', mods: [...two, two[0]] }));
    const custom = r.value.lists.find((l) => l.kind === 'custom' && l.name === 'Check list')!;
    check(custom && custom.mods.length === two.length && r.n === 0, 'new custom list (duplicates dropped, not loaded → no re-index)');
    r = await reindexedBy(mgr.selectList(host, custom.ref));
    check(r.n === 0, 'select the custom list with the same mods → no re-index');
    r = await reindexedBy(mgr.saveList(host, { ref: custom.ref, name: 'Check list 2', mods: two }));
    check(r.n === 0 && r.value.lists.some((l) => l.ref === custom.ref && l.name === 'Check list 2'), 'rename the loaded list → no re-index');
    r = await reindexedBy(mgr.saveList(host, { ref: custom.ref, name: 'Check list 2', mods: [two[1], { ...two[0], enabled: false }] }));
    check(r.n === 1, 'reorder/disable in the loaded list → re-index');
    await rejects(mgr.saveList(host, { ref: agot.ref, name: 'x', mods: [] }), /own lists/, 'save over a playset');

    // new mod
    await rejects(mgr.createMod(host, { name: 'Bad', folder: 'bad folder', version: '1', supportedVersion: '1.19.*', tags: [] }), /letters, digits/, 'create with a bad folder name');
    await rejects(mgr.createMod(host, { name: 'Bad "quoted"', folder: 'bad', version: '1', supportedVersion: '1.19.*', tags: [] }), /double quotes/, 'create with a quote in the name');
    r = await reindexedBy(mgr.createMod(host, { name: 'Check Mod', folder: 'check_mod', version: '1.0', supportedVersion: '1.19.*', tags: ['Gameplay', 'Events'] }));
    s = r.value;
    const made = s.mods.find((m) => m.id === 'mod/check_mod.mod');
    const outer = readFileSync(join(tmp, 'mod', 'check_mod.mod'), 'utf8');
    const inner = readFileSync(join(tmp, 'mod', 'check_mod', 'descriptor.mod'), 'utf8');
    console.log('outer descriptor:\n' + outer.trim().replace(/^/gm, '    '));
    check(made?.editable && s.activeMod === made.id && r.n === 0, 'created mod is editable and active');
    check(parseDescriptor(outer).path === join(tmp, 'mod', 'check_mod').replace(/\\/g, '/') && !/path=|archive=/.test(inner), 'outer path= absolute with /, inner without location');
    await rejects(mgr.createMod(host, { name: 'Again', folder: 'check_mod', version: '', supportedVersion: '', tags: [] }), /already exists/, 'create over an existing folder');

    // pack: dot folders and zips at the top stay out
    mkdirSync(join(tmp, 'mod', 'check_mod', 'common', 'traits'), { recursive: true });
    mkdirSync(join(tmp, 'mod', 'check_mod', '.git'), { recursive: true });
    writeFileSync(join(tmp, 'mod', 'check_mod', 'common', 'traits', 'zz_check.txt'), 'check_trait = { }\n');
    writeFileSync(join(tmp, 'mod', 'check_mod', '.git', 'HEAD'), 'ref: x\n');
    writeFileSync(join(tmp, 'mod', 'check_mod', 'old.zip'), 'x');
    const packed = await mgr.packMod(host, 'mod/check_mod.mod');
    const zip = new ZipArchive(packed.file);
    const names = zip.files()
        .map((e) => e.name)
        .sort();
    zip.close();
    check(packed.file === join(tmp, 'mod', 'check_mod.zip') && names.join(',') === 'common/traits/zz_check.txt,descriptor.mod', `packed ${packed.files} files: ${names.join(', ')}`);
    await rejects(mgr.packMod(host, 'mod/ugc_2962333032.mod'), /Only unpacked mods in your mod folder/, 'pack a Workshop mod');

    // unpack: a packed mod registered with archive=
    writeFileSync(join(tmp, 'mod', 'packed_check.mod'), `name="Packed Check"\nversion="2"\narchive="${packed.file.replace(/\\/g, '/')}"\n`);
    s = await mgr.modsState(host);
    const pm = s.mods.find((m) => m.id === 'mod/packed_check.mod');
    check(pm?.archive && !pm.root && !pm.editable, 'registered zip mod is packed');
    // …in the loaded list: unpacking moves its files → re-index
    await mgr.saveList(host, { ref: custom.ref, name: 'Check list 2', mods: [...two, { id: 'mod/packed_check.mod', enabled: true }] });
    const up = await reindexedBy(mgr.unpackMod(host, 'mod/packed_check.mod'));
    s = await mgr.modsState(host);
    const um = s.mods.find((m) => m.id === 'mod/packed_check.mod');
    const rewritten = parseDescriptor(readFileSync(join(tmp, 'mod', 'packed_check.mod'), 'utf8'));
    check(up.value.dir === join(tmp, 'mod', 'packed_check') && up.value.files === 2 && existsSync(join(up.value.dir, 'common', 'traits', 'zz_check.txt')), `unpacked ${up.value.files} files to ${up.value.dir}`);
    check(um?.root === up.value.dir && um.editable && !um.archive && rewritten.path && !rewritten.archive && rewritten.name === 'Packed Check', 'descriptor points to the folder, archive= gone');
    check(up.n === 1, 'unpacking a loaded mod → re-index');
    await rejects(mgr.unpackMod(host, 'mod/packed_check.mod'), /not a packed mod/, 'unpack an unpacked mod');
    // a real Paradox Mods zip (mod/pdx_12862/<uuid>.zip): its folder holds the zip → <name>_unpacked
    const pdxZip = join(real, 'mod', 'pdx_12862', '0170d9f0-fbef-11ea-bb1b-49296ffc8427.zip');

    if (existsSync(pdxZip))
    {
        mkdirSync(join(tmp, 'mod', 'pdx_12862'));
        copyFileSync(pdxZip, join(tmp, 'mod', 'pdx_12862', 'content.zip'));
        const d = readFileSync(join(tmp, 'mod', 'pdx_12862.mod'), 'utf8').replace(/archive="[^"]*"/, `archive="${join(tmp, 'mod', 'pdx_12862', 'content.zip').replace(/\\/g, '/')}"`);
        writeFileSync(join(tmp, 'mod', 'pdx_12862.mod'), d);
        const u2 = await mgr.unpackMod(host, 'mod/pdx_12862.mod');
        check(u2.dir === join(tmp, 'mod', 'pdx_12862_unpacked') && u2.files > 0, `Paradox Mods zip unpacked next to it: ${u2.dir} (${u2.files} files)`);
    }

    // a zip with an entry the app can't read (Deflate64): nothing unpacked, the descriptor as it was
    const badZip = join(tmp, 'mod', 'bad_check.zip');
    const zb = readFileSync(packed.file);
    const cen = zb.lastIndexOf(Buffer.from('descriptor.mod')) - 46;
    zb.writeUInt16LE(9, cen + 10);
    writeFileSync(badZip, zb);
    const badDesc = `name="Bad Check"\narchive="${badZip.replace(/\\/g, '/')}"\n`;
    writeFileSync(join(tmp, 'mod', 'bad_check.mod'), badDesc);
    await rejects(mgr.unpackMod(host, 'mod/bad_check.mod'), /Deflate64/, 'unpack a zip with an unreadable entry');
    check(!existsSync(join(tmp, 'mod', 'bad_check')) && readFileSync(join(tmp, 'mod', 'bad_check.mod'), 'utf8') === badDesc, 'failed unpack: no folder left, descriptor unchanged');

    // active mod
    await rejects(mgr.setActive(host, 'mod/ugc_2962333032.mod'), /cannot be the active mod/, 'activate a Workshop mod');
    s = await mgr.setActive(host, 'mod/packed_check.mod');
    check(s.activeMod === 'mod/packed_check.mod', 'activate an unpacked mod');
    s = await mgr.setActive(host, null);
    check(s.activeMod === undefined && !('activeMod' in JSON.parse(JSON.stringify(settings))), 'clear the active mod');

    // write a playset back
    const dbFile = join(tmp, 'launcher-v2.sqlite');
    const backupDir = join(tmp, BACKUP_FOLDER);
    const sha = (f: string): string => createHash('sha1').update(readFileSync(f)).digest('hex');
    await mgr.selectList(host, agot.ref);
    const reversed = [...agot.mods].reverse().map((e, i) => ({ id: e.id, enabled: i === 0 }));
    await rejects(mgr.writeList(host, agot.ref, 'launcher', [...reversed, { id: 'workshop/123', enabled: true }]), /does not know this mod yet: workshop\/123/, 'playset with a mod the launcher does not know (and the app cannot register)');
    launcherRunning = 'Paradox Launcher.exe';
    await rejects(mgr.writeList(host, agot.ref, 'launcher', reversed), /launcher is running/i, 'write while the launcher runs');
    // the process list cannot be read: nothing written, unless the user says the launcher is closed
    launcherRunning = null;
    const dbBefore = sha(dbFile);
    const u = await mgr.writeList(host, agot.ref, 'launcher', reversed);
    check(u.unchecked && !u.backup && sha(dbFile) === dbBefore && !existsSync(backupDir), `process list unreadable → nothing written: ${u.unchecked}`);
    launcherRunning = undefined;
    await rejects(mgr.writeList(host, custom.ref, 'launcher', reversed), /Only a Paradox Launcher playset/, 'write a custom list to the launcher');
    const bytesBefore = readFileSync(dbFile);
    const w = await reindexedBy(mgr.writeList(host, agot.ref, 'launcher', reversed));
    const back = await readLauncher(dbFile);
    const ps = back?.playsets.find((p) => 'playset:' + p.id === agot.ref);
    const lm = new Map(back!.mods.map((m) => [m.id, m.gameRegistryId]));
    console.log('playset read back:', ps?.mods.map((m) => `${lm.get(m.modId)}${m.enabled ? '' : ' (off)'} @${m.position}`).join(', '));
    check(w.value.backup?.startsWith(backupDir) && /launcher-v2-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d-\d{3}Z\.sqlite$/.test(w.value.backup) && readFileSync(w.value.backup).equals(bytesBefore), `launcher database backed up in the temp folder: ${w.value.backup}`);
    check(ps && ps.mods.map((m) => lm.get(m.modId)).join() === reversed.map((e) => e.id).join() && ps.mods.map((m) => m.enabled).join() === reversed.map((e) => e.enabled).join(), 'playset order and enabled flags written');
    check(w.n === 1, 'writing the loaded playset with other mods → re-index');
    const other = back!.playsets.filter((p) => p.id !== ps!.id);
    const orig = (await readLauncher(join(real, 'launcher-v2.sqlite')))!.playsets.filter((p) => p.id !== ps!.id);
    check(JSON.stringify(other) === JSON.stringify(orig), 'other playsets unchanged');

    // a new local mod goes into a playset: the app registers it as the launcher would (with the user's word that the
    // launcher is closed, as the process list is "unreadable" here)
    launcherRunning = null;
    const w2 = await mgr.writeList(host, agot.ref, 'launcher', [...reversed, { id: 'mod/check_mod.mod', enabled: true }], { launcherClosed: true });
    launcherRunning = undefined;
    const back2 = await readLauncher(dbFile);
    const row = back2?.mods.find((m) => m.gameRegistryId === 'mod/check_mod.mod');
    const ps2 = back2?.playsets.find((p) => 'playset:' + p.id === agot.ref);
    console.log('registered row:', JSON.stringify(row));
    check(
        w2.registered?.join() === 'Check Mod' && row && row.status === 'ready_to_play' && row.source === 'local' && row.displayName === 'Check Mod' && row.dirPath === join(tmp, 'mod', 'check_mod') && row.version === '1.0' && row.requiredVersion === '1.19.*' && row.tags.join() === 'Gameplay,Events',
        'new local mod registered in the launcher database'
    );
    check(ps2?.mods.length === reversed.length + 1 && ps2.mods[ps2.mods.length - 1].modId === row?.id && ps2.mods[ps2.mods.length - 1].enabled, 'the new mod is the playset’s last entry');
    s = await mgr.modsState(host);
    check(s.mods.find((m) => m.id === 'mod/check_mod.mod')?.launcherId === row?.id && s.lists.find((l) => l.ref === agot.ref)?.mods.some((e) => e.id === 'mod/check_mod.mod'), 'discovery knows its launcher id, the playset lists it');
    const w3 = await mgr.writeList(host, agot.ref, 'launcher', [...reversed, { id: 'mod/check_mod.mod', enabled: false }]);
    check(!w3.registered && (await readLauncher(dbFile))!.mods.filter((m) => m.gameRegistryId === 'mod/check_mod.mod').length === 1, 'writing it again does not register it twice');

    // a mod found only below this user folder while its descriptor names an old place: not registered (the game and the
    // launcher read the descriptor's location)
    mkdirSync(join(tmp, 'mod', 'moved_check', 'common'), { recursive: true });
    writeFileSync(join(tmp, 'mod', 'moved_check', 'descriptor.mod'), 'name="Moved Check"\n');
    writeFileSync(join(tmp, 'mod', 'moved_check.mod'), 'name="Moved Check"\npath="F:/#Nowhere/Paradox Interactive/Crusader Kings III/mod/moved_check"\n');
    s = await mgr.modsState(host);
    const moved = s.mods.find((m) => m.id === 'mod/moved_check.mod');
    check(moved?.status === 'ok' && moved.root === join(tmp, 'mod', 'moved_check') && !!moved.staleLocation, `relocated mod found, its descriptor stale: ${moved?.staleLocation}`);
    const dbMoved = sha(dbFile);
    await rejects(mgr.writeList(host, agot.ref, 'launcher', [...reversed, { id: 'mod/moved_check.mod', enabled: true }], { launcherClosed: true }), /still points to/, 'a mod whose descriptor is stale is not registered');
    check(sha(dbFile) === dbMoved, 'launcher database unchanged');

    // backups rotate: the newest 10 of each file are kept
    const rot = join(tmp, 'rotate');
    mkdirSync(rot);
    writeFileSync(join(rot, 'x.sqlite'), 'x');
    const t0 = Date.UTC(2026, 0, 1);
    const copies = Array.from({ length: 13 }, (_, i) => rotatingBackup(join(rot, 'x.sqlite'), join(rot, 'b'), 10, t0 + (i < 12 ? i * 1000 : 11 * 1000)));
    const kept = backupsOf(join(rot, 'b'), join(rot, 'x.sqlite'));
    check(kept.length === 10 && kept[0] === copies[3] && kept[9] === copies[12] && copies[12] !== copies[11], `backups rotate: ${kept.length} kept, oldest ${kept[0].slice(-28)}, same millisecond → the next one`);
    // the clock went back (a time zone, a corrected clock): the copy just made is never deleted by its own rotation
    const early = rotatingBackup(join(rot, 'x.sqlite'), join(rot, 'b'), 10, t0 - 3600e3);
    check(existsSync(early) && backupsOf(join(rot, 'b'), join(rot, 'x.sqlite')).length === 10, `clock back: the new copy ${early.slice(-28)} kept`);
    // names of earlier app versions (local time, no Z) sort by their time among the UTC ones
    const old = join(rot, 'b', 'x-2025-06-01_12-00-00-000.sqlite');
    writeFileSync(old, 'x');
    check(backupsOf(join(rot, 'b'), join(rot, 'x.sqlite'))[0] === old, 'an older local-time name sorts first');

    // write the game list
    await rejects(mgr.writeList(host, custom.ref, 'game', [{ id: 'workshop/123', enabled: true }]), /not registered: workshop\/123/, 'game list with an unregistered mod');
    const g = await mgr.writeList(host, custom.ref, 'game', [{ id: 'mod/check_mod.mod', enabled: true }, { id: 'mod/ugc_2962333032.mod', enabled: false }, { id: 'MOD/UGC_2978663046.MOD', enabled: true }]);
    const dl = readFileSync(join(tmp, 'dlc_load.json'), 'utf8');
    console.log('dlc_load.json:', dl);
    check(dl === '{"enabled_mods":["mod/check_mod.mod","mod/ugc_2978663046.mod"],"disabled_dlcs":[]}', 'dlc_load.json: enabled mods in order, disabled_dlcs kept');
    check(g.backup?.startsWith(backupDir) && readFileSync(g.backup, 'utf8') === readFileSync(join(real, 'dlc_load.json'), 'utf8'), 'old dlc_load.json backed up');

    // delete the loaded custom list → the game alone
    await mgr.selectList(host, custom.ref);
    r = await reindexedBy(mgr.deleteList(host, custom.ref));
    check(r.value.selected === 'none' && !r.value.lists.some((l) => l.ref === custom.ref) && r.n === 1, 'delete the loaded list → none, re-index');
    await rejects(mgr.deleteList(host, agot.ref), /own lists/, 'delete a playset');
}
finally
{
    check(hashes() === realBefore, 'the real user folder is unchanged');

    if (process.argv[2] !== 'keep')
        rmSync(tmp, { recursive: true, force: true });
    else
        console.log('kept', tmp);

    console.log(failures ? `${failures} FAILED` : 'all ok');
    process.exitCode = failures ? 1 : 0;
}
