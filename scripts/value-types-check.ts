// Checks the value types (docs/indexer.md "Value types", src/main/indexer/valueTypes.ts): the table is the one
// scripts/value-types-build.ts makes from the game now; a few values resolve to what the game reads them as (a saved
// scope's name links nothing, a coat of arms' colour a named colour, a great project's type not the building of the same
// name …); and no key of the game's script links a value to entries of two types beyond the ones listed here (AMBIGUOUS:
// names two types share where the table does not decide). Exit code 1 on any failure.
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=8000 scripts/value-types-check.ts [list]
// `list`: prints the keys that link two types now (to update AMBIGUOUS after a deliberate change). GAME=<install dir>.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, type PNode } from '../src/main/indexer/parser.ts';
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { defaultInstall } from './ck3-install.ts';
import { fastIndex } from './fast-index.ts';

const listOnly = process.argv[2] === 'list';
let failed = 0;
const fail = (what: string): void =>
{
    failed++;
    console.log('FAIL ' + what);
};
const gameDir = resolveGameDir(process.env.GAME ?? defaultInstall());

if (!gameDir)
    throw new Error('no game install');

// 1. the table is up to date
if (!listOnly)
{
    const tmp = mkdtempSync(join(tmpdir(), 'ckp-vt-check-'));

    try
    {
        const out = join(tmp, 'valueTypes.ts');
        const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--max-old-space-size=8000', 'scripts/value-types-build.ts'], { env: { ...process.env, VT_OUT: out }, encoding: 'utf8' });

        if (r.status !== 0)
            fail('value-types-build failed: ' + (r.stderr || r.stdout).slice(-400));
        else
        {
            const want = readFileSync(out, 'utf8').split(/\r?\n/);
            const have = readFileSync('src/main/indexer/valueTypes.ts', 'utf8').split(/\r?\n/);
            const diff = [...want.filter((l) => !have.includes(l)).map((l) => '+ ' + l), ...have.filter((l) => !want.includes(l)).map((l) => '- ' + l)];

            if (diff.length)
                fail(`src/main/indexer/valueTypes.ts is not what value-types-build makes now (${diff.length} lines differ; run it): ${diff.slice(0, 6).join(' | ')}`);
            else
                console.log(`ok   the table is up to date (${have.length} lines)`);
        }
    }
    finally
    {
        rmSync(tmp, { recursive: true, force: true });
    }
}

const idx = await fastIndex(gameDir, { cache: true });

// 2. values as the game reads them
const CASES: [string, string, string | null, string, string][] = [
    // [value, key, parent key (null: a definition's own field), the owner's type, what it links]
    ['potential_friend', 'save_scope_as', 'random_relation', 'events', ''],
    ['cleric', 'save_temporary_scope_as', 'scope:recipient', 'character_interactions', ''],
    ['red', 'color1', 'colored_emblem', 'coat_of_arms/coat_of_arms', 'named_colors:red'],
    ['mandala_capital_01', 'great_project_type', 'OR', 'casus_belli_types', 'great_projects/types:mandala_capital_01'],
    ['idle', 'animation', 'left_portrait', 'events', ''],
    ['idle', 'scripted_animation', 'left_portrait', 'events', 'scripted_animations:idle'],
    ['rival', 'opposites', null, 'scripted_relations', 'scripted_relations:rival'],
    ['craven', 'opposites', null, 'traits', 'traits:craven'],
    ['k_france', 'title', 'character', 'bookmarks/bookmarks', 'landed_titles:k_france'],
    ['bubonic_plague', 'epidemic', null, 'deathreasons', 'epidemics:bubonic_plague'],
    ['age_preset_child_features', 'age', 'setting', 'genes', 'genes:age_preset_child_features'],
    ['qarmatian', 'faith', null, 'religion/rite_types', 'faith:qarmatian']
];

if (!listOnly)
{
    for (const [v, k1, k0, owner, want] of CASES)
    {
        const got = idx.resolveToken(v, k1, k0, false, false, owner).map((e) => `${e.type}:${e.name}`).sort().join(', ');

        if (got !== want)
            fail(`${k0 ?? '@' + owner}.${k1} = ${v} links ${got || 'nothing'}, expected ${want || 'nothing'}`);
    }

    // (a trait group's name under has_trait: its traits)
    const group = idx.resolveToken('education_martial', 'has_trait', 'limit', false, false, 'events');

    if (!group.length || !group.every((e) => e.type === 'traits' && e.name.startsWith('education_martial_')))
        fail(`has_trait = education_martial links ${group.map((e) => e.type + ':' + e.name).join(', ') || 'nothing'}, expected the group's traits`);

    console.log(`ok   ${CASES.length + 1} values checked`);
}

// 3. keys that link a value to entries of two types: names shared by two types where nothing decides
const AMBIGUOUS = new Set<string>([
    // (1.20.1.2, 2026-11-15: a name two types share where neither the game's use nor its docs decide; none left since
    // torture_memory_effect.TYPE, used only as `flag:$TYPE$`, names a flag: schema.ts prefixedParam)
]);
const NOT_TYPES = new Set(['localization', 'flags', 'variables']);
const defAt = new Map<number, Map<number, { type: string; name: string; }[]>>();

for (const e of idx.entities)
{
    if (!e || e.dead || NOT_TYPES.has(e.type))
        continue;

    for (const d of e.defs)
    {
        const m = defAt.get(d.file) ?? defAt.set(d.file, new Map()).get(d.file)!;
        (m.get(d.line) ?? m.set(d.line, []).get(d.line)!).push({ type: e.type, name: e.name });
    }
}

const twoTypes = new Map<string, { n: number; types: string; ex: string; }>();
const memo = new Map<string, string>();

function resolve(v: string, quoted: boolean, k1: string | null, k0: string | null, owner: string, at: string): void
{
    const mk = `${v}|${k1}|${k0}|${owner}|${quoted}`;
    let types = memo.get(mk);

    if (types === undefined)
    {
        types = [...new Set(idx.resolveToken(v, k1, k0, false, quoted, owner).filter((e) => !NOT_TYPES.has(e.type)).map((e) => e.type))].sort().join(' + ');
        memo.set(mk, types);
    }

    if (!types.includes(' + '))
        return;

    const ctx = k0 === null ? `@${owner}|${k1}` : `${k0}.${k1}`;
    const c = twoTypes.get(ctx) ?? twoTypes.set(ctx, { n: 0, types, ex: `${v} @${at}` }).get(ctx)!;
    c.n++;
}

function walk(nodes: PNode[], owner: string, path: string[], fileDefs: Map<number, { type: string; name: string; }[]>, rel: string): void
{
    const k0 = path.length ? path[path.length - 1] : null;

    for (const n of nodes)
    {
        if (Array.isArray(n.v))
        {
            const nested = n.k ? fileDefs.get(n.line)?.find((d) => d.name === n.k) : undefined;

            if (nested)
            {
                walk(n.v, nested.type, [], fileDefs, rel);
                continue;
            }

            path.push(n.k ?? '');
            walk(n.v, owner, path, fileDefs, rel);
            path.pop();
            continue;
        }

        // (a prefixed or dotted name is a chain that names each of its steps: `situation:x.var:y`)
        if (n.v === '' || (n.k !== null && n.v.length < 2) || n.v.includes(':') || n.v.includes('.'))
            continue;

        resolve(n.v, !!n.q, n.k ?? k0, n.k === null ? (path.length > 1 ? path[path.length - 2] : null) : k0, owner, `${rel}:${n.line}`);
    }
}

for (let f = 0; f < idx.files.length; f++)
{
    const fi = idx.files[f];
    const defs = defAt.get(f);

    if (!fi || fi.source !== 0 || !defs || fi.area === 'localization' || fi.area === 'savegame')
        continue;

    let nodes: PNode[];

    try
    {
        nodes = parse(readFileSync(fi.abs, 'utf8').replace(/^﻿/, ''));
    }
    catch
    {
        continue;
    }

    const top = (list: PNode[]): void =>
    {
        for (const n of list)
        {
            if (!Array.isArray(n.v) || !n.k)
                continue;

            const d = defs.get(n.line)?.find((x) => x.name === n.k);

            if (d)
                walk(n.v, d.type, [], defs, fi.rel);
            else
                top(n.v);
        }
    };
    top(nodes);
}

const keyed = [...twoTypes].sort((a, b) => b[1].n - a[1].n);

if (listOnly)
{
    for (const [ctx, c] of keyed)
        console.log(`    ${JSON.stringify(ctx)}, // ${c.n}× ${c.types} (${c.ex})`);
}
else
{
    const fresh = keyed.filter(([ctx]) => !AMBIGUOUS.has(ctx));

    for (const [ctx, c] of fresh)
        fail(`${ctx} links two types (${c.types}), ${c.n}×, e.g. ${c.ex}: name the right one in the value table or a rule, or list it in AMBIGUOUS`);

    console.log(`${fresh.length ? 'FAIL' : 'ok  '} ${keyed.length} keys link two types, ${keyed.length - fresh.length} of them listed`);
}

console.log(failed ? `${failed} failure(s)` : 'value-types-check: ok');
process.exit(failed ? 1 : 0);
