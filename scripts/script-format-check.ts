// The script formatter (src/shared/scriptFormat.ts) over the game's script files: how many it re-spaces, leaves as they
// are, refuses (their tokens don't nest — the text is kept), and whether formatting twice changes anything (it must not).
// Also sameScript (the "same as the game" comparison): a re-spaced file says the same, one changed number does not.
// Reads only. Usage: node --experimental-strip-types --no-warnings scripts/script-format-check.ts [folder …]
// (folders under game/, default common events history gfx/portraits gfx/coat_of_arms). GAME=<install dir> (default: the
// development install).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGameDir } from '../src/main/indexer/gameIndex.ts';
import { formatScript, isScriptFile, sameScript, scriptSignature } from '../src/shared/scriptFormat.ts';
import { defaultInstall } from './ck3-install.ts';

const install = defaultInstall();
const gameDir = resolveGameDir(install);

if (!gameDir)
    throw new Error('No CK3 game dir at ' + install);

const folders = process.argv.slice(2).length ? process.argv.slice(2) : ['common', 'events', 'history', 'gfx/portraits', 'gfx/coat_of_arms'];
const files: string[] = [];

const walk = (dir: string): void =>
{
    for (const e of readdirSync(dir, { withFileTypes: true }))
    {
        const p = join(dir, e.name);

        if (e.isDirectory())
            walk(p);
        else if (isScriptFile(p))
            files.push(p);
    }
};

for (const f of folders)
    walk(join(gameDir, f));

let changed = 0;
let same = 0;
let bytes = 0;
const refused: string[] = [];
const unstable: string[] = [];
const notSame: string[] = [];
const t0 = performance.now();

for (const f of files)
{
    const text = readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    bytes += text.length;
    const once = formatScript(text);

    if (once === text)
    {
        // (formatted already, or refused: a trailing space it would drop tells them apart)
        if (formatScript(text + ' ') === text + ' ')
            refused.push(f.slice(gameDir.length + 1));
        else
            same++;

        continue;
    }

    changed++;

    if (formatScript(once) !== once)
        unstable.push(f.slice(gameDir.length + 1));

    // sameScript ("same as the game", docs/mods.md): the re-spaced text says the same, one changed number does not —
    // and it agrees with the tokenizer's view (scriptSignature)
    // (the first number that is not in a comment)
    const m = [...text.matchAll(/=[ \t]*(\d+)\b/g)].find((x) => !text.slice(text.lastIndexOf('\n', x.index) + 1, x.index).includes('#'));
    const mutated = m ? text.slice(0, m.index) + '= ' + (Number(m[1]) + 1) + text.slice(m.index + m[0].length) : undefined;
    const sigText = scriptSignature(text);

    if (!sameScript(text, once) || sigText !== scriptSignature(once) || (mutated !== undefined && (sameScript(text, mutated) || sigText === scriptSignature(mutated))))
        notSame.push(f.slice(gameDir.length + 1));
}

console.log(`${files.length} files, ${(bytes / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - t0)} ms: ${changed} re-spaced, ${same} as they were, ${refused.length} refused, ${unstable.length} not stable, ${notSame.length} where sameScript is wrong`);

for (const f of refused)
    console.log('  refused     ' + f);

for (const f of unstable)
    console.log('  not stable  ' + f);

for (const f of notSame)
    console.log('  sameScript  ' + f);

process.exitCode = unstable.length || notSame.length ? 1 : 0;
