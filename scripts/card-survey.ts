// Readable cards outside Electron: which types show nothing (one card as text: scripts/story-cli.ts).
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=6000 scripts/card-survey.ts [type …]
// Per type: how many sampled entries (up to 25, spread over the list) have an empty card, the visible lines per entry
// and the top-level keys of the empty ones (what is not shown yet); all types without arguments.
// GAME=<install dir> (default: the development install).
import { GameIndex, resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { StoryBuilder } from '../src/main/describe/stories.ts';
import type { EntityCard, Line } from '../src/shared/api.ts';
import { defaultInstall } from './ck3-install.ts';

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
{
    throw new Error('No CK3 game dir at ' + install);
}

const idx = new GameIndex(gameDir, 'english');
idx.build();
const sb = new StoryBuilder(idx);
const count = (ls: Line[]): number => ls.reduce((n, l) => n + (l.hidden ? 0 : 1) + (l.children ? count(l.children) : 0), 0);
const only = process.argv.slice(2);
const rows: string[] = [];

for (const t of idx.types())
{
    if (only.length ? !only.includes(t.id) : ['localization', 'flag', 'variable', 'images', 'models', 'events', 'on_action', 'characters'].includes(t.id))
        continue;

    const names = idx.names(t.id);

    if (!names.length)
        continue;

    const step = Math.max(1, Math.floor(names.length / 25));
    let empty = 0;
    let lines = 0;
    let n = 0;
    const unshown = new Map<string, number>();

    for (let i = 0; i < names.length && n < 25; i += step)
    {
        const e = idx.get(t.id, names[i])!;
        let card: EntityCard;

        try
        {
            card = sb.card(e);
        }
        catch (err)
        {
            console.log(`card ${t.id}:${names[i]} failed:`, err);
            continue;
        }

        n++;

        const c = card.sections.reduce((k, s) => k + count(s.lines), 0);
        lines += c;

        if (!c && !card.facts.length)
            empty++;

        const d = idx.defNode(e);

        if (d && Array.isArray(d.node.v) && !c)
        {
            for (const k of d.node.v)
                if (k.k)
                    unshown.set(k.k, (unshown.get(k.k) ?? 0) + 1);
        }
    }

    if (!n)
        continue;

    const top = [...unshown]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([k]) => k)
        .join(' ');

    rows.push(`${String(Math.round((100 * empty) / n)).padStart(3)}% empty  ${(lines / n).toFixed(1).padStart(5)} lines/entry  ${String(names.length).padStart(6)}  ${t.id}  [${t.label}]  ${top}`);
}

rows.sort((a, b) => parseInt(b) - parseInt(a));
console.log(rows.join('\n'));
