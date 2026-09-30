// Portrait digests: one line per character — what the build applied (modifiers, accessories, tags, genes applied,
// creature state) and a hash of its geometry and textures — to compare two versions of the portrait pipeline.
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=8000 scripts/portrait-digest.ts [n] > out.txt
// n characters spread over the list (default 60); AGOT=1 layered over A Game of Thrones (Workshop 2962333032, read
// only) — then also the dragons (`dragon_*`); ONLY=<regex> just the characters it matches. DETAIL=1 prints the whole
// record instead of a hash.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GameIndex, resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { PortraitBuilder } from '../src/main/portraits/portrait.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { discoverMods } from '../src/main/mods/discover.ts';
import type { PortraitData } from '../src/shared/api.ts';
import { defaultInstall } from './ck3-install.ts';

const gameDir = resolveGameDir(defaultInstall());

if (!gameDir)
    throw new Error('No CK3 game dir');

let files = new GameFiles(gameDir);

if (process.env.AGOT)
{
    const mod = discoverMods(join(homedir(), 'no-user-folder'), gameDir, null).find((m) => m.remoteId === '2962333032');

    if (!mod)
        throw new Error('A Game of Thrones (Workshop 2962333032) is not installed');

    files = new GameFiles(gameDir, [mod]);
}

const idx = new GameIndex(files, 'english');
idx.build();
const pb = new PortraitBuilder(idx);
const n = Number(process.argv[2] ?? 60);
const names = idx.names('characters');
const picked = new Set<string>();

for (let i = 0; i < n; i++)
    picked.add(names[Math.floor((i * names.length) / n)]);

// (the creatures: characters holding a trait some trait portrait modifier shows a creature for)
if (process.env.AGOT)
{
    for (const name of names)
        if (/^dragon_/.test(name))
            picked.add(name);
}

const hash = (x: unknown): string =>
    createHash('sha1')
        .update(typeof x === 'string' ? x : JSON.stringify(x))
        .digest('hex')
        .slice(0, 12);
const round = (a: ArrayLike<number>): string => hash(Array.from(a, (v) => Math.round(v * 1000)).join(','));

for (const name of picked)
{
    if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name))
        continue;

    const e = idx.get('characters', name)!;
    let p: PortraitData | null;

    try
    {
        p = await pb.build(e);
    }
    catch (err)
    {
        console.log(name, 'ERROR', String(err).slice(0, 120));
        continue;
    }

    if (!p)
    {
        console.log(name, 'none');
        continue;
    }

    const record = {
        modifiers: p.modifiers,
        accessories: p.accessories,
        tags: p.tags,
        applied: p.applied,
        creature: p.creature,
        decals: p.decals?.map((d) => [d.diffuse, d.normal, d.properties, Math.round(d.weight * 1000)]),
        parts: p.parts.map((x) => [x.name, x.kind, x.shader, x.positions.length, round(x.positions), x.diffuse?.startsWith('data:') ? hash(x.diffuse) : x.diffuse])
    };
    console.log(name, process.env.DETAIL ? JSON.stringify(record) : hash(record), p.creature ? 'creature' : '');
}
