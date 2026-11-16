// The game's .gui files through the GUI parser (src/main/gui/parser.ts): what the top level holds, how many statements
// of which keys, and what the parser could not make sense of (statements without a value or a block).
// Usage: node --experimental-strip-types --no-warnings scripts/gui-survey.ts [key …]
// GAME=<install dir> (default: the development install). With keys: the top-level statements of those keys, listed.
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { gvalue, gwalk, parseGui, type GNode } from '../src/main/gui/parser.ts';
import { defaultInstall } from './ck3-install.ts';

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

const files = new GameFiles(gameDir);
const list = files.list('gui', { engine: true, ext: /\.gui$/i });
const top = new Map<string, number>();
const keys = new Map<string, number>();
const odd = new Map<string, string[]>();
const bare = new Map<string, number>();
const bareAt = new Map<string, string[]>();
const only = process.argv.slice(2);
let bytes = 0;
let statements = 0;
const t0 = performance.now();
let parsed = 0;

for (const f of list)
{
    const text = files.readText(f) ?? '';
    bytes += text.length;
    const nodes = parseGui(text);
    parsed++;

    for (const n of nodes)
    {
        top.set(n.key || '(bare)', (top.get(n.key || '(bare)') ?? 0) + 1);

        if (only.includes(n.key || '(bare)'))
            console.log(`${f.rel}:${n.line}  ${n.key}${n.name ? ' ' + n.name : ''}${n.base ? ' = ' + n.base : ''}${n.value !== undefined ? ' = ' + n.value : ''}  name=${gvalue(n.children, 'name') ?? ''}`);
    }

    gwalk(nodes, (n, parents) =>
    {
        statements++;
        keys.set(n.key, (keys.get(n.key) ?? 0) + 1);

        if (!n.key && n.value !== undefined)
        {
            const p = parents.at(-1)?.key ?? '(top)';
            bare.set(p, (bare.get(p) ?? 0) + 1);

            if (process.env.BARE === p && (bareAt.get(p)?.length ?? 0) < 12)
                bareAt.set(p, [...(bareAt.get(p) ?? []), `${f.rel}:${n.line} ${n.value}`]);
        }

        // (a keyed statement with nothing: a value lost, a keyword the parser did not take)
        if (n.key && n.value === undefined && !n.children && !n.name)
        {
            const l = odd.get(n.key) ?? [];

            if (l.length < 3)
                l.push(`${f.rel}:${n.line}`);

            odd.set(n.key, l);
        }
    });
}

const ms = performance.now() - t0;
const sorted = (m: Map<string, number>, n: number): string =>
    [...m]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, c]) => `${k}:${c}`)
        .join('  ');
console.log(`${parsed} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, ${statements} statements, parsed in ${ms.toFixed(0)} ms`);
console.log('top level:', sorted(top, 40));
console.log('keys:', sorted(keys, 80));
console.log('bare values by parent:', sorted(bare, 60));

for (const l of bareAt.values())
    console.log(l.join('\n'));

console.log('keyed statements with nothing:', [...odd].map(([k, l]) => `${k} (${l.join(', ')})`).join('\n  ') || 'none');
