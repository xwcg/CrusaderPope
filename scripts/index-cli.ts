// Builds the index outside Electron and prints stats + sample queries.
// Usage: node --experimental-strip-types scripts/index-cli.ts [installDir] [entityType entityName]
// With mods: MODS=<launcher playset name | game> node --experimental-strip-types --experimental-sqlite scripts/index-cli.ts …
// (the list's mods are layered over the game as the app does; prints how they touch the entry and its definitions)
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GameIndex, resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { defaultInstall } from './ck3-install.ts';

const install = process.argv[2] ?? defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

let files = new GameFiles(gameDir);

if (process.env.MODS)
{
    // (the launcher database needs node:sqlite: --experimental-sqlite)
    const { readModsState, modsOfList } = await import('../src/main/mods/manager.ts');
    const state = await readModsState({ gameDir: install, language: 'english' }, gameDir, join(homedir(), 'Documents'));
    const list = state.lists.find((l) => l.name === process.env.MODS || l.ref === process.env.MODS);

    if (!list)
        throw new Error(`No mod list "${process.env.MODS}": ${state.lists.map((l) => l.name).join(', ')}`);

    files = new GameFiles(gameDir, modsOfList(state, list.ref));
    console.log('mods:', files.sources.map((s) => s.name).join(' → '));
}

const idx = new GameIndex(files, 'english');
let lastPhase = '';
idx.build((p) =>
{
    if (p.phase !== lastPhase)
    {
        console.log(`[${((performance.now() / 1000) | 0)}s] ${p.phase}`);
        lastPhase = p.phase;
    }
});
console.log(idx.stats, `heap ${(process.memoryUsage().heapUsed / 1e6) | 0} MB`);

const types = idx.types();
console.log(
    types.slice(0, 25)
        .map((t) => `${t.label}=${t.count}${t.modCount ? ` (mods ${t.modCount})` : ''}`)
        .join(', ')
);

const [type, name] = [process.argv[3] ?? 'traits', process.argv[4] ?? 'brave'];
const d = idx.detail(type, name);

if (d)
{
    console.log(`\n== ${d.typeLabel} ${d.name} "${d.display}" — ${d.description?.slice(0, 80)}`);

    if (d.mod)
        console.log(`mods: ${d.mod.state} by ${d.mod.mods.join(', ')}`);

    console.log('defs:', d.defs.map((x) => `${x.file}:${x.line}${x.origin ? ` [${x.origin.name}${x.origin.hiddenBy ? `, hidden by ${x.origin.hiddenBy.name} (${x.origin.hiddenBy.how})` : ''}]` : ''}`).join(', '));
    const show = (label: string, groups: typeof d.incoming): void =>
    {
        console.log(label);

        for (const g of groups)
            console.log(`  ${g.typeLabel} (${g.items.length}): ${g.items.slice(0, 8).map((i) => `${i.name}[${i.contexts[0]}]`).join(', ')}`);
    };
    show('outgoing', d.outgoing);
    show('incoming', d.incoming);

    if (d.event)
        console.log(JSON.stringify(d.event, null, 1).slice(0, 1500));
}
