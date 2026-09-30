// Reports, per type, how many entries got an icon / illustration and shows samples.
// Usage: node --experimental-strip-types --max-old-space-size=6000 scripts/icon-coverage.ts [minCount]
import { GameIndex, resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { defaultInstall } from './ck3-install.ts';

const idx = new GameIndex(resolveGameDir(defaultInstall())!, 'english');
idx.build();
const min = Number(process.argv[2] ?? 5);
const rows: string[] = [];

for (const t of idx.types())
{
    if (['localization', 'flag', 'variable', 'images', 'characters'].includes(t.id) || t.count < min)
        continue;

    let icons = 0;
    let illus = 0;
    const samples: string[] = [];

    for (const item of idx.list(t.id))
    {
        const e = idx.get(t.id, item.name)!;
        const r = idx.imagesOf(e);

        if (r.icon)
            icons++;

        if (r.illu)
            illus++;

        if ((r.icon || r.illu) && samples.length < 2)
            samples.push(`${item.name} → ${r.icon?.name ?? '-'} | ${r.illu?.name ?? '-'}`);
    }

    rows.push(`${t.id.padEnd(34)} ${String(t.count).padStart(6)}  icon ${String(Math.round((icons / t.count) * 100)).padStart(3)}%  illu ${String(Math.round((illus / t.count) * 100)).padStart(3)}%  ${samples.join('  ;  ')}`);
}

console.log(idx.stats, 'images:', idx.types().find((t) => t.id === 'images')?.count);
console.log(rows.join('\n'));
