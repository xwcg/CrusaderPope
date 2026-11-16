import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
// (the index cache's code version, docs/indexer.md "Index cache": the same function keys the scripts' cache, scripts/fast-index.ts;
// the game facts' kept on disk, docs/mods.md "The game's own files")
import { factsCodeHash, indexCodeHash } from './scripts/index-code-hash.ts';

export default defineConfig({
    main: {
        define: { __INDEX_CODE__: JSON.stringify(indexCodeHash(__dirname)), __FACTS_CODE__: JSON.stringify(factsCodeHash(__dirname)) },
        build: {
            rollupOptions: {
                input: {
                    boot: resolve(__dirname, 'src/main/boot.ts'),
                    index: resolve(__dirname, 'src/main/index.ts'),
                    indexWorker: resolve(__dirname, 'src/main/indexWorker.ts'),
                    migrationWorker: resolve(__dirname, 'src/main/migrationWorker.ts'),
                    imageWorker: resolve(__dirname, 'src/main/imageWorker.ts'),
                    shaderWorker: resolve(__dirname, 'src/main/shaderWorker.ts'),
                    blenderWorker: resolve(__dirname, 'src/main/blenderWorker.ts'),
                    cacheWriter: resolve(__dirname, 'src/main/cacheWriter.ts'),
                    scriptKeysWorker: resolve(__dirname, 'src/main/scriptKeysWorker.ts'),
                    mapWorker: resolve(__dirname, 'src/main/mapWorker.ts'),
                    mapTerrainWorker: resolve(__dirname, 'src/main/mapTerrainWorker.ts'),
                    mapOverlaysWorker: resolve(__dirname, 'src/main/mapOverlaysWorker.ts'),
                    parseWorker: resolve(__dirname, 'src/main/parseWorker.ts')
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
