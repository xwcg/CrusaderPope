/**
 * Compiler thread of the ShaderPool (shaders/pool.ts): its own ShaderLibrary — parsed FX files and the WebAssembly
 * glslang / SPIRV-Cross — compiling the requests it is sent one after another, each result posted as soon as it is
 * done (started all at once they all wait for the WebAssembly module and then finish in one burst). The FX files come
 * from its own layering of the game and the loaded mods (a mod's gfx/FX file replaces the game's).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ShaderLibrary } from './shaders/compile.ts';
import { GameFiles } from './mods/gamefiles.ts';
import type { ModInfo, ShaderRequest } from '../shared/api.ts';

const { gameDir, mods } = workerData as { gameDir: string; mods?: ModInfo[]; };
const lib = new ShaderLibrary(new GameFiles(gameDir, mods ?? []));
let queue: Promise<void> = Promise.resolve();

parentPort!.on('message', (m: { id: number; req: ShaderRequest; }) =>
{
    queue = queue.then(() =>
        lib.compile(m.req).then(
            (program) => parentPort!.postMessage({ id: m.id, program }),
            (e: Error) => parentPort!.postMessage({ id: m.id, error: String(e?.message ?? e) })
        )
    );
});
