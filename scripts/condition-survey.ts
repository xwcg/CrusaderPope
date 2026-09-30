// Condition blocks per type (StoryBuilder.conditionBlocks: the .info's documented triggers and the top-level trigger
// blocks the definitions write) with the root scope found — what the cards offer to make when a definition lacks one.
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=6000 scripts/condition-survey.ts [type …]
// GAME=<install dir> (default: the development install).
import { GameIndex, resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import { defaultInstall } from './ck3-install.ts';

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

const idx = new GameIndex(gameDir, 'english');
idx.build();
const sb = new StoryBuilder(idx);
const only = process.argv.slice(2);

for (const t of idx.types())
{
    if (only.length && !only.includes(t.id))
        continue;

    const blocks = sb.conditionBlocks(t.id);

    if (!blocks.size)
        continue;

    const list = [...blocks].map(([k, b]) => `${k}${b.scope ? ` (${b.scope})` : ''}`);
    console.log(`${t.id.padEnd(40)} root ${String(sb.rootScopeOf(t.id) ?? '-').padEnd(10)} ${list.join(', ')}`);
}
