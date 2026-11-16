// All cards of some types as flat text lines, to compare the describer before and after a change.
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=6000 scripts/card-dump.ts <out file> <type> [<type> …]
// One line per card line: "type:name<TAB>section<TAB>indent text". GAME=<install dir> (default: the development install).
// The index: scripts/fast-index.ts (parse threads, cached in %TEMP%/ckp-index-cache; FRESH=1 builds it anew).
import { writeFileSync } from 'node:fs';
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import type { Line, Rich } from '../src/shared/api.ts';
import { defaultInstall } from './ck3-install.ts';
import { fastIndex } from './fast-index.ts';

const [out, ...types] = process.argv.slice(2);
const gameDir = resolveGameDir(defaultInstall());

if (!gameDir || !out || !types.length)
{
    throw new Error('Usage: card-dump.ts <out file> <type> […]');
}

const idx = await fastIndex(gameDir, { cache: true });
const sb = new StoryBuilder(idx);
const text = (r: Rich): string => r.map((s) => (typeof s === 'string' ? s : s.text)).join('');
const flat = (ls: Line[], ind: string): string[] => ls.flatMap((l) => [ind + text(l.text), ...flat(l.conditions ?? [], ind + '  ? '), ...flat(l.children ?? [], ind + '  ')]);
const rows: string[] = [];

for (const type of types)
{
    for (const name of idx.names(type))
    {
        try
        {
            const card = sb.card(idx.get(type, name)!);

            for (const s of card.sections)
                for (const l of flat(s.lines, ''))
                    rows.push(`${type}:${name}\t${s.title}\t${l}`);
        }
        catch (err)
        {
            rows.push(`${type}:${name}\t!\t${err}`);
        }
    }
}

writeFileSync(out, rows.join('\n') + '\n');
console.log(`${rows.length} lines`);
