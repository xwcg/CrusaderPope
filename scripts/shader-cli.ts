// Compiles one of the game's Effects like the model viewer does and prints its interface; writes the GLSL ES sources
// (or, on failure, the assembled desktop GLSL with the error line) next to the given output prefix. `--mods <list>`
// layers a mod list like the app (scripts/shader-mods.ts).
// Usage: node --experimental-strip-types --experimental-sqlite scripts/shader-cli.ts <effect file> <effect> [DEFINE …] [-REMOVED_DEFINE …] [--mods <list>] [--out prefix]
// e.g.   node --experimental-strip-types scripts/shader-cli.ts gfx/FX/pdxmesh.shader standard_atlas PDX_MESH_UV1 NO_FOG -MAP_LIGHTING_HACK
import { writeFileSync } from 'node:fs';
import { ShaderLibrary } from '../src/main/shaders/compile.ts';
import { shaderFiles } from './shader-mods.ts';

const args = process.argv.slice(2);
const { vfs, label } = await shaderFiles(args);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
const [file, effect, ...defs] = args;

if (!file || !effect)
{
    console.log('usage: shader-cli.ts <effect file> <effect> [DEFINE …] [-REMOVED …] [--mods <list>] [--out prefix]');
    process.exit(1);
}

const lib = new ShaderLibrary(vfs);
const t0 = performance.now();

try
{
    const p = await lib.compile({
        file,
        effect,
        defines: defs.filter((d) => !d.startsWith('-')),
        remove: defs.filter((d) => d.startsWith('-')).map((d) => d.slice(1)),
        arrays: { Data: 48 },
        post: true
    });
    console.log(`OK ${(performance.now() - t0).toFixed(0)} ms (${label}) — defines ${p.defines.join(' ')}`);
    console.log('attributes', p.attributes.map((a) => `${a.name}:${a.type}`).join(' '));
    console.log('samplers  ', p.samplers.map((s) => `${s.name}:${s.type}${s.ref ? '@' + s.ref : ''}${s.file ? ' ' + s.file : ''}`).join(' '));
    console.log('states    ', JSON.stringify(p.states));

    if (p.aliases)
        console.log(
            'aliases   ',
            Object.entries(p.aliases)
                .map(([a, n]) => `${a}=${n}`)
                .join(' ')
        );

    const uniforms = [...new Set([...p.vertex.matchAll(/^uniform [^;]+;/gm), ...p.fragment.matchAll(/^uniform [^;]+;/gm)].map((m) => m[0]))];
    console.log(uniforms.join('\n'));

    if (out)
    {
        writeFileSync(out + '.vs.glsl', p.vertex);
        writeFileSync(out + '.fs.glsl', p.fragment);
    }
}
catch (e)
{
    console.log('FAIL', (e as Error).message);
    const src = (e as Error & { source?: string; }).source;

    if (src && out)
        writeFileSync(out + '.failed.glsl', src);

    process.exitCode = 1;
}

vfs.close();
