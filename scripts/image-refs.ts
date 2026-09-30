// Survey how script references images: per type, which keys hold image paths or icon names.
// Usage: node --experimental-strip-types scripts/image-refs.ts [gameDir]
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse, type PNode } from '../src/main/indexer/parser.ts';
import { defaultInstall } from './ck3-install.ts';

const GAME = process.argv[2] ?? defaultInstall() + '/game';
const ICON_KEYS = new Set(['icon', 'picture', 'background', 'texture', 'illustration', 'type_icon', 'reference', 'frame', 'image', 'sprite', 'large_icon', 'small_icon', 'thumbnail', 'portrait', 'banner']);

function walk(d: string, out: string[] = []): string[]
{
    for (const e of readdirSync(d, { withFileTypes: true }))
    {
        const p = join(d, e.name);

        if (e.isDirectory())
            walk(p, out);
        else if (e.name.endsWith('.txt'))
            out.push(p);
    }

    return out;
}

const stats = new Map<string, { n: number; examples: Set<string>; }>();
const add = (k: string, ex: string): void =>
{
    let s = stats.get(k);

    if (!s)
        stats.set(k, s = { n: 0, examples: new Set() });

    s.n++;

    if (s.examples.size < 3)
        s.examples.add(ex);
};

for (const area of ['common', 'events'])
{
    for (const f of walk(join(GAME, area)))
    {
        const rel = relative(join(GAME, area), f).split(sep);
        const type = area === 'events' ? 'events' : rel.length > 2 ? rel.slice(0, 2).join('/') : rel[0];
        const visit = (nodes: PNode[], path: string[]): void =>
        {
            for (const n of nodes)
            {
                if (typeof n.v === 'string')
                {
                    const v = n.v;
                    const isPath = /\.(dds|png|tga)$/i.test(v);

                    if (isPath)
                        add(`${type} | ${path.slice(-1).join('>')}>${n.k ?? '(bare)'} | PATH`, v);
                    else if (n.k && ICON_KEYS.has(n.k) && !/^(yes|no)$/.test(v))
                        add(`${type} | ${path.slice(-1).join('>')}>${n.k} | NAME`, v);
                }
                else
                    visit(n.v, [...path, n.k ?? '']);
            }
        };
        visit(parse(readFileSync(f, 'utf8')), []);
    }
}

const rows = [...stats].sort((a, b) => b[1].n - a[1].n);

for (const [k, s] of rows.slice(0, Number(process.argv[3] ?? 140)))
    console.log(String(s.n).padStart(6), k, '  e.g.', [...s.examples].join(' ; '));

console.log(existsSync(GAME));
