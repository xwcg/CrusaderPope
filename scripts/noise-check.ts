// Prints the most-referenced entities per type to spot false-positive reference matches.
// Usage: node --experimental-strip-types --expose-gc scripts/noise-check.ts
import { GameIndex, resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { defaultInstall } from './ck3-install.ts';

const gameDir = resolveGameDir(process.argv[2] ?? defaultInstall())!;
const idx = new GameIndex(gameDir, 'english');
idx.build();
(globalThis as { gc?: () => void; }).gc?.();
console.log(idx.stats, `heap after gc ${(process.memoryUsage().heapUsed / 1e6) | 0} MB`);

const skip = new Set(['localization', 'flag', 'variable']);
const rows: { type: string; name: string; n: number; ctx: string; }[] = [];

for (const t of idx.types())
{
    if (skip.has(t.id))
        continue;

    for (const item of idx.list(t.id))
    {
        if (item.refs < 150)
            continue;

        const d = idx.detail(t.id, item.name)!;
        const ctxCount = new Map<string, number>();

        for (const g of d.incoming)
            for (const i of g.items)
                for (const c of i.contexts)
                    ctxCount.set(c.split(' › ').pop()!, (ctxCount.get(c.split(' › ').pop()!) ?? 0) + i.count);

        const top = [...ctxCount]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([c, n]) => `${c}:${n}`)
            .join(' ');
        rows.push({ type: t.id, name: item.name, n: item.refs, ctx: top });
    }
}

rows.sort((a, b) => b.n - a.n);

for (const r of rows.slice(0, Number(process.argv[3] ?? 80)))
    console.log(`${r.n}\t${r.type}\t${r.name}\t${r.ctx}`);
