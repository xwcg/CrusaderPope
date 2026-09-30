// Builds portraits in Node and prints what was applied (sanity check for the portrait pipeline).
// Usage: node --experimental-strip-types --max-old-space-size=6000 scripts/portrait-cli.ts [type name …]
// With mods: MODS=<launcher playset name | uuid | game> node --experimental-strip-types --experimental-sqlite … (the
// list's mods layered over the game as the app does), e.g. MODS=<playset> … characters <id>
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GameIndex, resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { PortraitBuilder } from '../src/main/portraits/portrait.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { defaultInstall } from './ck3-install.ts';

const install = defaultInstall();
const gameDir = resolveGameDir(install)!;
let files = new GameFiles(gameDir);

if (process.env.MODS)
{
    // (the launcher database needs node:sqlite: --experimental-sqlite)
    const { readModsState, modsOfList } = await import('../src/main/mods/manager.ts');
    const state = await readModsState({ gameDir: install, language: 'english' }, gameDir, join(homedir(), 'Documents'));
    const want = process.env.MODS;
    const list = state.lists.find((l) => l.name === want || l.ref === want || l.ref === 'playset:' + want);

    if (!list)
        throw new Error(`No mod list "${want}": ${state.lists.map((l) => l.name).join(', ')}`);

    files = new GameFiles(gameDir, modsOfList(state, list.ref));
    console.log('mods:', files.sources.map((s) => s.name).join(' → '));
}

const idx = new GameIndex(files, 'english');
idx.build();
const pb = new PortraitBuilder(idx);
const args = process.argv.slice(2);
const targets = args.length ? args : ['dna_data', '163112_halfdan_whiteshirt', 'characters', '145665', 'bookmark_portraits', 'bookmark_adventurers_almos_arpad'];

for (let i = 0; i < targets.length; i += 2)
{
    const e = idx.get(targets[i], targets[i + 1]);

    if (!e)
    {
        console.log('not found', targets[i], targets[i + 1]);
        continue;
    }

    const t0 = performance.now();
    const p = await pb.build(e);

    if (!p)
    {
        console.log('no portrait for', e.name);
        continue;
    }

    console.log(`\n${p.label} (${p.gender}, ${p.age}) — ${p.source} — ${(performance.now() - t0).toFixed(0)} ms`);
    console.log('accessories', p.accessories.map((a) => `${a.gene}=${a.accessory}`).join(' '));
    console.log('tags', p.tags.join(','));
    console.log('modifiers', p.modifiers.join(' '));
    console.log('applied', p.applied, 'colors', JSON.stringify(p.colors, (_k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)));

    if (p.creature)
    {
        console.log('creature', p.creature.entity, 'state', p.creature.state, '·', p.decals?.length ?? 0, 'decals');
    }

    for (const part of p.parts)
    {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];

        for (let v = 0; v < part.positions.length; v += 3)
        {
            for (let a = 0; a < 3; a++)
            {
                min[a] = Math.min(min[a], part.positions[v + a]);
                max[a] = Math.max(max[a], part.positions[v + a]);
            }
        }

        const nan = part.positions.some((x) => !Number.isFinite(x));
        // baked textures are data URLs: their size only
        const tex = (t: string | undefined): string | undefined => (t?.startsWith('data:') ? `(bake, ${(t.length / 1024).toFixed(0)} KB)` : t);
        console.log(`  ${part.kind.padEnd(5)} ${(part.group ?? '').padEnd(10)} ${part.name.padEnd(40)} v${part.positions.length / 3} bbox ${min.map((x) => x.toFixed(1))} .. ${max.map((x) => x.toFixed(1))}${nan ? ' NaN!' : ''} ${part.cutout ? 'cutout ' : ''}tex ${tex(part.diffuse)}`);
    }
}
