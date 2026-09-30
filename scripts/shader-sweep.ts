// Compiles every Effect the .asset files name, in both UV layouts — the requests the app precompiles while indexing
// (ShaderStore.precompile) — and reports which fail and why. `--mods <list>` layers a mod list like the app does
// (e.g. `--mods AGOT`); `--out <dir>` writes each program's GLSL ES (`<file>__<effect>__uv0|uv1.vs/fs.glsl`) and
// failures.txt, for diffing the output of compiler changes.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings scripts/shader-sweep.ts [--mods <list>] [--out <dir>]
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GameIndex } from '../src/main/indexer/gameIndex.ts';
import { ShaderLibrary } from '../src/main/shaders/compile.ts';
import { ShaderStore } from '../src/main/shaders/store.ts';
import type { ShaderRequest } from '../src/shared/api.ts';
import { shaderFiles } from './shader-mods.ts';

const args = process.argv.slice(2);
const { vfs, label } = await shaderFiles(args);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
const t0 = performance.now();
const idx = new GameIndex(vfs, 'english');
idx.scan();
const assets = idx.modelFiles().filter((m) => /\.asset$/i.test(m.rel));
const lib = new ShaderLibrary(vfs);
const store = new ShaderStore((req) => lib.compile(req), null, '');
await store.precompile(assets, vfs, {
    planned: () =>
    {},
    progress: () =>
    {},
    alive: () => true
});
const { programs, failures } = store.list();
console.log(`${label} — ${assets.length} .asset files: ${programs.length} of ${programs.length + failures.length} programs compile (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
// the meshsettings' additional_shader_defines follow NO_FOG (viewerShaderRequest) and name the program apart
const name = (file: string, effect: string, defines: string[] = []): string =>
{
    const extra = defines.slice(defines.indexOf('NO_FOG') + 1);
    const suffix = extra.length ?
        '__' + extra.join('+')
            .replace(/[^\w+.-]+/g, '_')
            .slice(0, 80) +
        '-' + createHash('sha1')
            .update(extra.join('\n'))
            .digest('hex')
            .slice(0, 6) :
        '';
    return `${file.replace(/^gfx\/FX\//i, '').replace(/[/\\]/g, '_')}__${effect}__${defines.includes('PDX_MESH_UV1') ? 'uv1' : 'uv0'}${suffix}`;
};
const failed = failures
    .map((f) =>
    {
        const req = JSON.parse(f.key) as ShaderRequest;
        return `${name(req.file, req.effect, req.defines)}: ${f.error.split('\n').slice(0, 3).join(' | ').slice(0, 300)}`;
    })
    .sort();

for (const f of failed)
    console.log('  FAIL ' + f);

const aliased = programs.filter((p) => p.aliases);

if (aliased.length)
    console.log(`${aliased.length} programs alias renamed constant buffer members: ${[...new Set(aliased.flatMap((p) => Object.keys(p.aliases!)))].join(' ')}`);

if (out)
{
    mkdirSync(out, { recursive: true });

    for (const p of programs)
    {
        writeFileSync(join(out, name(p.file, p.effect, p.defines) + '.vs.glsl'), p.vertex);
        writeFileSync(join(out, name(p.file, p.effect, p.defines) + '.fs.glsl'), p.fragment);
    }

    writeFileSync(join(out, 'failures.txt'), failed.join('\n') + '\n');
    console.log(`GLSL written to ${out}`);
}

vfs.close();
