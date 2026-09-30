import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * The index cache's code version (docs/indexer.md, "Cache"): a hash of the code that decides what the cached index
 * holds — GameIndex and the cache format, with every module they import at run time (relative value imports, followed
 * transitively; `import type` is left out: types don't change the data). Changes to the describer, stories, portraits
 * … keep the cache.
 */
function indexCodeHash(): string
{
    const roots = ['src/main/indexer/gameIndex.ts', 'src/main/indexer/cache.ts'].map((f) => resolve(__dirname, f));
    const seen = new Set<string>();
    const hash = createHash('sha1');
    const visit = (file: string): void =>
    {
        if (seen.has(file) || !existsSync(file))
            return;

        seen.add(file);
        const text = readFileSync(file, 'utf8');
        hash.update(file.slice(__dirname.length)).update(text);

        for (const m of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?[^'"]*?\sfrom\s+['"](\.[^'"]+)['"]/gm))
        {
            if (m[1])
                continue;

            const target = resolve(dirname(file), m[2]);
            visit(existsSync(target) ? target : `${target}.ts`);
        }
    };

    for (const r of roots)
        visit(r);

    return hash.digest('hex');
}

export default defineConfig({
    main: {
        define: { __INDEX_CODE__: JSON.stringify(indexCodeHash()) },
        build: {
            rollupOptions: {
                input: {
                    index: resolve(__dirname, 'src/main/index.ts'),
                    indexWorker: resolve(__dirname, 'src/main/indexWorker.ts'),
                    imageWorker: resolve(__dirname, 'src/main/imageWorker.ts'),
                    shaderWorker: resolve(__dirname, 'src/main/shaderWorker.ts'),
                    blenderWorker: resolve(__dirname, 'src/main/blenderWorker.ts'),
                    cacheWriter: resolve(__dirname, 'src/main/cacheWriter.ts'),
                    scriptKeysWorker: resolve(__dirname, 'src/main/scriptKeysWorker.ts'),
                    mapWorker: resolve(__dirname, 'src/main/mapWorker.ts'),
                    mapTerrainWorker: resolve(__dirname, 'src/main/mapTerrainWorker.ts'),
                    mapOverlaysWorker: resolve(__dirname, 'src/main/mapOverlaysWorker.ts')
                }
            }
        }
    },
    preload: {},
    renderer: {
        root: resolve(__dirname, 'src/renderer'),
        build: {
            rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') }
        },
        plugins: [react()]
    }
});
