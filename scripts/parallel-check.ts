// Checks parallel parsing (GameIndex.parseAllParallel, indexer/parsePool.ts, parseWorker.ts; docs/indexer.md
// "Parallel parsing"): a build with its script files parsed on threads gives the same index as one on a single thread,
// column for column of the cache state (entities, definitions, references, contexts, name filters), and how long each
// took. The one-thread build also runs without the resolve memos (GameIndex.memoize), so the comparison proves those change nothing. `agot`: with the owner's AGOT (read only); `threads=N`.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings --max-old-space-size=12000 scripts/parallel-check.ts [agot] [threads=N]
// (threads=0 = parse threads off, checked against a pool run of the automatic number; the default is the app's automatic number)
import { availableParallelism, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ModInfo } from '../src/shared/api.ts';
import { resolveGameDir } from '../src/main/gameDir.ts';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { ParsePool } from '../src/main/indexer/parsePool.ts';
import { PARSE_THREADS_MAX, parseThreadCount } from '../src/shared/parseThreads.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { defaultUserDir } from '../src/main/mods/discover.ts';
import { readModsState } from '../src/main/mods/manager.ts';
import { defaultInstall } from './ck3-install.ts';

const gameDir = resolveGameDir(defaultInstall())!;
const threadsArg = process.argv.find((a) => a.startsWith('threads='));
const threads = threadsArg ? Number(threadsArg.slice(8)) : parseThreadCount(undefined, availableParallelism());
let mods: ModInfo[] = [];

if (process.argv.includes('agot'))
{
    const docs = join(homedir(), 'Documents');
    const st = await readModsState({ gameDir: defaultInstall(), language: 'english', userDir: defaultUserDir(docs) }, gameDir, docs);
    mods = st.mods.filter((m) => /2962333032/.test(m.id) && !/_fixes/.test(m.id));
}

let t = performance.now();
const one = new GameIndex(new GameFiles(gameDir, mods), 'english');
// (the one-thread index is also the one made without the resolve memos: they must change nothing, docs/indexer.md "Memory")
one.memoize = false;
one.build();
const tOne = performance.now() - t;
const a = one.exportState();

// (the pool's index: threads=0 still runs it, with the automatic number; the off index below is compared with it, not
// with a second parseAll, which would prove nothing: build() is scan() + parseAll() too)
const poolThreads = threads || Math.max(1, parseThreadCount(undefined, availableParallelism()));
t = performance.now();
const par = new GameIndex(new GameFiles(gameDir, mods), 'english');
par.scan();
await par.parseAllParallel(new ParsePool(resolve(import.meta.dirname, '../src/main/parseWorker.ts'), poolThreads));
const tPar = performance.now() - t;
const b = par.exportState();

// (threads=0: Settings.parseThreads "off", the index worker's own thread: scan, then parseAll with a progress callback,
// as the worker's build does)
let off: GameIndex | null = null;

if (threads === 0)
{
    off = new GameIndex(new GameFiles(gameDir, mods), 'english');
    off.scan();
    off.parseAll(() => undefined);
}

let failures = 0;

// Settings.parseThreads -> threads (shared/parseThreads.ts): absent / 0 automatic, -1 off, a number as is
for (const [setting, cores, want] of [[undefined, 12, 4], [undefined, 5, 3], [0, 4, 2], [0, 2, 1], [0, 1, 1], [-1, 12, 0], [5, 2, 5], [99, 12, PARSE_THREADS_MAX]] as const)
{
    if (parseThreadCount(setting, cores) !== want)
    {
        failures++;
        console.log(`FAIL parseThreadCount(${setting}, ${cores}) = ${parseThreadCount(setting, cores)}, want ${want}`);
    }
}

for (const k of Object.keys(a) as (keyof typeof a)[])
{
    const same = isDeepStrictEqual(a[k], b[k]);

    if (!same)
    {
        failures++;
        console.log(`FAIL ${k} differs`);
    }
}

if (off)
{
    const c = off.exportState();

    for (const k of Object.keys(c) as (keyof typeof c)[])
    {
        if (!isDeepStrictEqual(c[k], b[k]))
        {
            failures++;
            console.log(`FAIL off: ${k} differs from the pool's`);
        }
    }
}

const same = (x: GameIndex, y: GameIndex): boolean => isDeepStrictEqual(x.stats.entities, y.stats.entities) && x.stats.refs === y.stats.refs;
console.log(`${failures ? 'FAIL' : 'ok  '} ${Object.keys(a).length} columns compared; ${one.stats.entities} entries, ${one.stats.refs} refs${same(one, par) ? '' : ' (stats differ)'}`);
console.log(`one thread ${(tOne / 1000).toFixed(1)} s · ${poolThreads} parse threads ${(tPar / 1000).toFixed(1)} s${mods.length ? ' (with ' + mods.map((m) => m.name).join(', ') + ')' : ''}`);
process.exit(failures ? 1 : 0);
