// What a built index keeps, field by field (docs/indexer.md, "Memory"): the index is built, a full GC measures the live
// heap, then one field after another is let go (and a GC again); the difference is what the field held. Run under
// Electron's own V8 for the sizes the app has (pointer compression):
//   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe --expose-gc scripts/index-breakdown.ts [agot]
// `agot`: layered over A Game of Thrones (Workshop 2962333032, read only). It reads the index's private fields, so a
// renamed field shows as a size of 0 (fix the name here).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import type { ModInfo } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { ParsePool } from '../src/main/indexer/parsePool.ts';
import { parseDescriptor } from '../src/main/mods/descriptor.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { defaultInstall, workshopFolder } from './ck3-install.ts';

const MB = 1048576;
const gameDir = resolveGameDir(defaultInstall())!;
const mods: ModInfo[] = [];

if (process.argv.includes('agot'))
{
    const root = join(workshopFolder(), '2962333032');
    const d = parseDescriptor(readFileSync(join(root, 'descriptor.mod'), 'utf8'));
    mods.push({ id: 'mod/ugc_2962333032.mod', name: d.name, tags: [], root, source: 'steam', replacePaths: d.replacePaths, status: 'ok', editable: false });
}

const gc = (): number =>
{
    const collect = (globalThis as { gc?: () => void }).gc;

    if (!collect)
        throw new Error('run with --expose-gc');

    collect();
    collect();
    return getHeapStatistics().used_heap_size / MB;
};
const idx = new GameIndex(new GameFiles(gameDir, mods), 'english') as unknown as Record<string, unknown> & GameIndex;
idx.scan();
await idx.parseAllParallel(new ParsePool(join(import.meta.dirname, '../src/main/parseWorker.ts'), 3));
const total = gc();
console.log(`${mods.length ? mods[0].name : 'vanilla'}: ${idx.stats.entities} entities, ${idx.stats.refs} references, ${total.toFixed(0)} MB live after the build`);
let prev = total;
const drop = (name: string, empty: () => void): void =>
{
    empty();
    const now = gc();
    console.log(`  ${name.padEnd(12)} ${(prev - now).toFixed(0).padStart(5)} MB`);
    prev = now;
};
const set = (field: string, value: unknown): void =>
{
    idx[field] = value;
};

drop('outgoing', () => set('outgoing', new Map()));
drop('incoming', () => set('incoming', new Map()));
drop('refsByFile', () => set('refsByFile', new Map()));

// (the seven reference columns)
drop('ref columns', () => ['rFrom', 'rTo', 'rFile', 'rLine', 'rOff', 'rLen', 'rCtx'].forEach((c) => set(c, [])));
drop('blooms', () => set('blooms', []));
drop('locText', () => set('locText', new Map()));
drop('byName', () => set('byName', new Map()));
drop('byType', () => set('byType', new Map()));
drop('entities', () => set('entities', []));
drop('files', () => set('files', []));
drop('ctx', () => set('ctx', { list: [], map: new Map() }));
console.log(`  everything else ${prev.toFixed(0)} MB (the game's type docs, image and model tables, caches, the script itself)`);
process.exit(0);
