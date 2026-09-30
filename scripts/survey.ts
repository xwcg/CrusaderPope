// Quick survey of CK3 script folders: top-level keys per folder, timing.
// Usage: node --experimental-strip-types scripts/survey.ts [gameDir] [subfolder]
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse, type PNode } from '../src/main/indexer/parser.ts';
import { defaultInstall } from './ck3-install.ts';

const GAME = process.argv[2] ?? defaultInstall() + '/game';
const sub = process.argv[3] ?? 'common';

function walk(d: string, out: string[] = []): string[]
{
    for (const e of readdirSync(d, { withFileTypes: true }))
    {
        const p = join(d, e.name);

        if (e.isDirectory())
            walk(p, out);
        else if (/\.txt$/i.test(e.name))
            out.push(p);
    }

    return out;
}

const files = walk(join(GAME, sub));
const t0 = Date.now();
let bytes = 0;
let nodes = 0;
const byFolder = new Map<string, { files: number; keys: string[]; shapes: Map<string, number>; }>();
const count = (ns: PNode[]): void =>
{
    for (const n of ns)
    {
        nodes++;

        if (Array.isArray(n.v))
            count(n.v);
    }
};

for (const f of files)
{
    const src = readFileSync(f, 'utf8');
    bytes += src.length;
    const ast = parse(src);
    const rel = relative(join(GAME, sub), f).split(sep).join('/');
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';
    let e = byFolder.get(folder);

    if (!e)
        byFolder.set(folder, e = { files: 0, keys: [], shapes: new Map() });

    e.files++;
    count(ast);

    for (const n of ast)
    {
        e.keys.push(n.k ?? '<bare:' + n.v + '>');
        const shape = n.k === null ? 'bare' : n.k.startsWith('@') ? '@const' : Array.isArray(n.v) ? 'block' : 'scalar';
        e.shapes.set(shape, (e.shapes.get(shape) ?? 0) + 1);
    }
}

console.log(`${files.length} files, ${(bytes / 1e6).toFixed(1)} MB, ${nodes} nodes, ${Date.now() - t0} ms`);

for (const [folder, e] of [...byFolder].sort())
{
    const uniq = [...new Set(e.keys.filter((k) => !k.startsWith('@')))];
    console.log(
        `${folder} [${e.files}f] ${[...e.shapes].map(([s, c]) => s + ':' + c).join(' ')} | ${uniq.length} keys: ${uniq.slice(0, 6).join(', ')}`
    );
}
