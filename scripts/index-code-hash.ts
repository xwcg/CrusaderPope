// The index cache's code version (docs/indexer.md, "Index cache"): a hash of the code that decides what the cached index
// holds. electron.vite.config.ts defines it into the app (__INDEX_CODE__), scripts/fast-index.ts keys its cache with it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * The hash of GameIndex and the cache format with every module they import at run time (relative value imports, followed
 * transitively; `import type` is left out: types don't change the data). Changes to the describer, stories, portraits …
 * keep the cache. `root`: the project folder.
 */
export function indexCodeHash(root: string): string
{
    // (the parse threads' side too: fileExtract.ts is the twin of gameIndex's indexScriptFile and gameIndex imports it as a
    // type only, parsePool.ts's job format and parseWorker.ts's file reading likewise; a change there changes what a build extracts)
    return codeHash(root, ['src/main/indexer/gameIndex.ts', 'src/main/indexer/cache.ts', 'src/main/indexer/fileExtract.ts', 'src/main/indexer/parsePool.ts', 'src/main/parseWorker.ts']);
}

/**
 * The code version of the game facts kept on disk (src/main/mods/gameFacts.ts, docs/mods.md "The game's own files"): the modules
 * that make facts and what they keep with them (the words, the keys, the macro definitions, the inert rewrites) and every module
 * they import, migrate.ts with nearly all of the migration. electron.vite.config.ts defines it into the app (__FACTS_CODE__).
 */
export function factsCodeHash(root: string): string
{
    return codeHash(root, ['src/main/mods/gameFacts.ts', 'src/main/mods/inertWork.ts', 'src/main/mods/libraries.ts', 'src/main/mods/scriptProbes.ts', 'src/main/mods/macroArgs.ts', 'src/main/mods/migrate.ts']);
}

/** The hash of modules with every module they import at run time (relative value imports, transitively). */
function codeHash(root: string, files: string[]): string
{
    const roots = files.map((f) => resolve(root, f));
    const seen = new Set<string>();
    const hash = createHash('sha1');
    const visit = (file: string): void =>
    {
        // (the app's texts and catalogs are not the index's code: the cache key carries the language and its catalog)
        if (seen.has(file) || !existsSync(file) || /[\\/]shared[\\/](i18n\.ts|locales[\\/])/.test(file))
            return;

        seen.add(file);
        const text = readFileSync(file, 'utf8');
        hash.update(file.slice(root.length)).update(text);

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
