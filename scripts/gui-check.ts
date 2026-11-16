// The GUI library (src/main/gui/library.ts) over the game's files: what it finds, and how much of what the files use
// it can resolve (templates, types, textures, scripted GUIs, text keys).
// Usage: node --experimental-strip-types --no-warnings --max-old-space-size=6000 scripts/gui-check.ts [windows]
// `windows`: list every window and root widget (name, file:line, what it is made from).
// GAME=<install dir> (default: the development install).
// The index: scripts/fast-index.ts (parse threads, cached in %TEMP%/ckp-index-cache; FRESH=1 builds it anew).
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { GameFiles } from '../src/main/mods/gamefiles.ts';
import { GuiLibrary, type GuiEntry, type GuiRef } from '../src/main/gui/library.ts';
import { defaultInstall } from './ck3-install.ts';
import { fastIndex } from './fast-index.ts';

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

const files = new GameFiles(gameDir);
const t0 = performance.now();
const lib = new GuiLibrary(files);
console.log(`${lib.files.length} files read and parsed in ${(performance.now() - t0).toFixed(0)} ms`);

const where = (e: GuiEntry): string => `${e.file.rel}:${e.line}`;

if (process.argv[2] === 'windows')
{
    for (const e of [...lib.entries('window'), ...lib.entries('root')])
        console.log(`${e.kind.padEnd(6)} ${e.name.padEnd(48)} ${e.base.padEnd(28)} ${where(e)}`);

    process.exit(0);
}

for (const k of ['window', 'root', 'type', 'template'] as const)
    console.log(`${k}: ${lib.entries(k).length}`);

// definitions of one name more than once
const dup = new Map<string, GuiEntry[]>();

for (const e of lib.entries())
{
    const d = lib.defs(e.kind, e.name);

    if (d.length > 1 && !e.local)
        dup.set(e.kind + ':' + e.name, d);
}

console.log(`names defined more than once: ${dup.size}`);

for (const [k, d] of [...dup].slice(0, 12))
    console.log('  ' + k + ': ' + d.map(where).join(', '));

// what the definitions use, and what resolves
const idx = await fastIndex(files, { cache: true });
const scripted = idx.types().find((t) => t.id === 'scripted_guis')?.id;
console.log(`index type of scripted GUIs: ${scripted ?? 'none'}`);
const seen = new Map<GuiRef['kind'], { total: number; missing: Map<string, number>; }>();

for (const e of lib.entries())
{
    for (const r of lib.refsOf(e))
    {
        let s = seen.get(r.kind);

        if (!s)
            seen.set(r.kind, s = { total: 0, missing: new Map() });

        s.total++;
        const ok = r.kind === 'template' ?
            lib.defs('template', r.name).length > 0
            : r.kind === 'type' ?
            lib.defs('type', r.name).length > 0
            : r.kind === 'texture' ?
            !!files.get(r.name, { engine: true })
            : r.kind === 'scriptedGui' ?
            !!scripted && !!idx.get(scripted, r.name)
            : r.kind === 'text' ?
            idx.locRaw(r.name) !== undefined || /^[-\d.%]+$/.test(r.name)
            : true;

        if (!ok)
            s.missing.set(r.name, (s.missing.get(r.name) ?? 0) + 1);
    }
}

for (const [k, s] of seen)
{
    const m = [...s.missing].sort((a, b) => b[1] - a[1]);
    console.log(`${k}: ${s.total} uses, ${m.length} names without a target${m.length ? ', e.g. ' + m.slice(0, 8).map(([n, c]) => `${n}×${c}`).join(' ') : ''}`);
}

// scripted GUIs the files call, and those nothing calls
if (scripted)
{
    const names = idx.names(scripted);
    const unused = names.filter((n) => !lib.usedBy('scriptedGui', n).length);
    console.log(`scripted GUIs: ${names.length}, called from .gui files: ${names.length - unused.length}, not called: ${unused.length}${unused.length ? ', e.g. ' + unused.slice(0, 8).join(' ') : ''}`);
}
