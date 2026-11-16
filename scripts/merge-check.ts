// Checks "Merge into one mod…" (src/main/mods/merge.ts, mergeConflicts.ts) on a TEMP user folder: three mods in a
// custom list, A (a folder), B (a folder, later: a file of A's path, a replace_path hiding A's events, a trait A defines
// too) and C (a zip), merged into one: the later file wins, the hidden folder's files are gone, the replace_paths are
// in the new descriptor, the zip's file is in, the trait resolves as before, a list holds the merged mod, the active
// mod and the mods themselves are unchanged.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=6000 scripts/merge-check.ts [keep]
// Every index it builds is a fresh build on parse threads (scripts/fast-index.ts buildIndex; THREADS=0: one thread), never from a cache.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { modsOfList, modsState, type ModsHost } from '../src/main/mods/manager.ts';
import { mergeMods, planMerge } from '../src/main/mods/merge.ts';
import { packFolder } from '../src/main/mods/zip.ts';
import { defaultInstall } from './ck3-install.ts';
import { buildIndex } from './fast-index.ts';

let failures = 0;
const check = (ok: unknown, what: string): void =>
{
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);

    if (!ok)
        failures++;
};

const install = defaultInstall();
const gameDir = resolveGameDir(install)!;
const tmp = mkdtempSync(join(tmpdir(), 'ckp-merge-'));
const modDir = join(tmp, 'mod');
const put = (root: string, rel: string, text: string): void =>
{
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
};
const mod = (folder: string, name: string, extra = '', zip = false): void =>
{
    const d = `version="1.0"\nname="${name}"\n${extra}supported_version="1.20.*"\n`;
    const root = join(modDir, folder);
    writeFileSync(join(root, 'descriptor.mod'), d);
    const at = zip ? `archive="${join(modDir, folder + '.zip').replace(/\\/g, '/')}"` : `path="${root.replace(/\\/g, '/')}"`;
    writeFileSync(join(modDir, folder + '.mod'), d + at + '\n');
};

mkdirSync(modDir, { recursive: true });
const A = join(modDir, 'mod_a');
const B = join(modDir, 'mod_b');
const C = join(tmp, 'mod_c_src');
put(A, 'common/traits/m_traits_a.txt', 'm_conflict_trait = {\n\tcategory = personality\n}\n\nm_a_trait = {\n\tcategory = personality\n}\n');
put(A, 'common/scripted_values/m_shared.txt', 'm_value = 1\n');
put(A, 'events/m_a_events.txt', 'namespace = m_a\n');
put(A, 'events/sub/m_deep.txt', 'namespace = m_deep\n');
put(B, 'common/scripted_values/m_shared.txt', 'm_value = 2\n');
put(B, 'common/traits/0_m_traits_b.txt', 'm_conflict_trait = {\n\tcategory = lifestyle\n}\n');
put(B, '.git/HEAD', 'ref\n');
put(C, 'common/scripted_values/m_c.txt', 'm_c_value = 3\n');
put(C, 'descriptor.mod', 'version="1.0"\nname="Mod C"\nsupported_version="1.19.*"\n');
mod('mod_a', 'Mod A');
mod('mod_b', 'Mod B', 'replace_path="events"\n');
await packFolder(C, join(modDir, 'mod_c.zip'));
writeFileSync(join(modDir, 'mod_c.mod'), `version="1.0"\nname="Mod C"\nsupported_version="1.19.*"\narchive="${join(modDir, 'mod_c.zip').replace(/\\/g, '/')}"\n`);

const settings: Settings = {
    gameDir: install,
    language: 'english',
    userDir: tmp,
    activeMod: 'mod/mod_a.mod',
    customModLists: [{ id: 'l1', name: 'Three', mods: [{ id: 'mod/mod_a.mod', enabled: true }, { id: 'mod/mod_b.mod', enabled: true }, { id: 'mod/mod_c.mod', enabled: true }] }],
    modList: 'custom:l1'
};
let idx!: GameIndex;
const reindex = async (): Promise<void> =>
{
    const state = await modsState(host);
    idx = await buildIndex(new GameIndex(new GameFiles(gameDir, modsOfList(state, state.selected)), 'english'));
};
const host: ModsHost = {
    settings: () => settings,
    updateSettings: (patch) => Object.assign(settings, patch),
    gameDir: () => gameDir,
    documents: () => join(tmp, 'no-documents'),
    reindex: () => undefined,
    query: async <T>(method: string, ...params: unknown[]): Promise<T> =>
        (idx as unknown as Record<string, (...a: unknown[]) => T>)[method](...params),
    dataDir: () => join(tmp, 'data')
};

try
{
    console.log('building the index with the three mods …');
    await reindex();
    const plan = await planMerge(host, 'custom:l1');
    check(plan.mods.map((m) => m.name).join(',') === 'Mod A,Mod B,Mod C' && plan.replacePaths.join() === 'events', `plan: ${plan.mods.map((m) => m.name).join(' → ')}; replace_path ${plan.replacePaths.join(', ')}`);

    const progress: string[] = [];
    const r = await mergeMods(host, { ref: 'custom:l1', name: 'All Three', folder: 'all_three' }, { progress: (p) => progress.push(p.stage) });
    const out = join(modDir, 'all_three');
    const read = (rel: string): string | null => (existsSync(join(out, rel)) ? readFileSync(join(out, rel), 'utf8') : null);
    check(read('common/scripted_values/m_shared.txt') === 'm_value = 2\n', 'the later mod’s file of the same path wins');
    check(read('events/m_a_events.txt') === null && read('events/sub/m_deep.txt') === 'namespace = m_deep\n', 'B’s replace_path hides A’s events directly in the folder, not in its subfolders');
    check(read('common/traits/m_traits_a.txt') && read('common/traits/0_m_traits_b.txt') && read('common/scripted_values/m_c.txt') === 'm_c_value = 3\n', 'the other files, the zip’s too');
    check(read('.git/HEAD') === null, 'dot folders left out');
    const desc = read('descriptor.mod') ?? '';
    check(/name="All Three"/.test(desc) && /replace_path="events"/.test(desc) && /supported_version="1\.20/.test(desc) && /replace_path="events"/.test(readFileSync(join(modDir, 'all_three.mod'), 'utf8')), `descriptors:\n${desc}`);
    check(r.files === 5 && r.replaced === 2, `${r.files} files, ${r.replaced} left out`);
    const state = await modsState(host);
    const list = state.lists.find((l) => l.name === r.list);
    check(list?.mods.map((m) => m.id).join() === 'mod/all_three.mod' && state.selected === 'custom:l1', `the list “${r.list}” holds the merged mod; the loaded list stays`);
    check(settings.activeMod === 'mod/mod_a.mod', 'the active mod stays');
    check(readFileSync(join(A, 'common/scripted_values/m_shared.txt'), 'utf8') === 'm_value = 1\n' && existsSync(join(A, 'events/m_a_events.txt')), 'the mods themselves unchanged');
    // (the game orders a folder's files by path across sources: B's 0_… file before A's, so A's trait wins, merged too)
    const winner = idx.winningDef(idx.get('traits', 'm_conflict_trait')!)!;
    check(/m_traits_a/.test(idx.files[winner.file].rel), `the trait's winner: ${idx.files[winner.file].rel} (the same once merged: files by path)`);
    check(progress.length > 1, `progress: ${progress.length} reports`);

    let cancelled = '';

    try
    {
        await mergeMods(host, { ref: 'custom:l1', name: 'Again', folder: 'again' }, { cancelled: () => true });
    }
    catch (e)
    {
        cancelled = (e as Error).message;
    }

    check(/Cancelled/.test(cancelled) && !existsSync(join(modDir, 'again')) && !existsSync(join(modDir, 'again.mod')), `cancel: ${cancelled}; the half-made mod removed`);
}
catch (e)
{
    check(false, String((e as Error).stack ?? e));
}
finally
{
    // (the index holds mod C's zip open)
    idx?.vfs.close();

    if (process.argv[2] === 'keep')
        console.log('kept: ' + tmp);
    else
        rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `${failures} failed` : 'all ok');
process.exit(failures ? 1 : 0);
