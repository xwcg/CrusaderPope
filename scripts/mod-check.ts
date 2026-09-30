// One mod on top of the game through discovery, layering and a full index build: files per folder (from the mod,
// hidden), index stats and ModTouch states per type. Tests total conversions quickly.
// Usage: MOD=<id or name part> node --experimental-strip-types --experimental-sqlite --max-old-space-size=8000 scripts/mod-check.ts
import { writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GameIndex, resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { readModsState } from '../src/main/mods/manager.ts';
import { defaultInstall } from './ck3-install.ts';

const log = (s: string): void => void writeSync(1, s + '\n');
const gameDir = resolveGameDir(defaultInstall())!;
const state = await readModsState({ gameDir, language: 'english' }, gameDir, join(homedir(), 'Documents'));
const want = (process.env.MOD ?? '').toLowerCase();
const mod = state.mods.find((m) => m.id.toLowerCase().includes(want) || m.name.toLowerCase().includes(want))!;
log(`${mod.name} [${mod.id}] ${mod.status} root=${mod.root} replace=${mod.replacePaths.length}`);
const vfs = new GameFiles(gameDir, [mod]);

for (const dir of ['common', 'common/culture', 'common/religion', 'common/traits', 'events', 'history', 'localization/english', 'gfx', 'map_data'])
{
    const f = vfs.list(dir, { engine: dir === 'gfx' });
    const h = vfs.hidden(dir, { engine: dir === 'gfx' });
    log(`  ${dir}: ${f.length} files (${f.filter((x) => x.source > 0).length} from the mod), hidden ${h.length} (${h.filter((x) => x.how === 'replace_path').length} by replace_path)`);
}

const t = Date.now();
const idx = new GameIndex(vfs, 'english');
idx.build();
log(`index: ${JSON.stringify(idx.stats)} in ${Date.now() - t} ms`);

for (const type of ['traits', 'culture/cultures', 'religion/religion_types', 'faith', 'landed_titles', 'characters', 'events'])
{
    const items = idx.list(type);
    const by: Record<string, number> = {};

    for (const it of items)
        by[it.mod?.state ?? 'game'] = (by[it.mod?.state ?? 'game'] ?? 0) + 1;

    log(`  ${type}: ${items.length} ${JSON.stringify(by)}`);
}
