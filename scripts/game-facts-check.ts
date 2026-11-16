// The facts of the game's files kept for the session (src/main/mods/gameFacts.ts, round 12) and what is built on them:
// - a fact is made again when its file's size, modification time or content (change time) differs, looked at once per scope; a
//   file that cannot be read keeps nothing;
// - the memos of whole folders (`GameMemo`) go when the game's build changes: Steam's build id, the executable, the revisions, a DLC
//   folder added;
// - the words of a file are the libraries scan's tokens (`TOKEN`) and loadedNames' words of the bytes, on every script and data file of
//   the game; `WordGate` holds what it should;
// - loadedNames with the game's words kept finds what it finds reading every file (names present, absent, of other characters);
// - the kept inert rewrites (inertWork.ts `gameInertText`) are the rewrite's result in each world, a changed answer rewrites again;
// - macroArgs on the definitions' shapes (macroArgs.ts `macroShape`) answers as on their parse trees, for the game's definitions.
// - kept on disk (`useFactStore`): taken back as made by the same code only, a changed file made again, a damaged file left.
// The real game is read when its folder is there (the game's install of docs/dev-gotchas.md); the rest runs in TEMP.
// Usage: node --experimental-strip-types --experimental-sqlite --no-warnings scripts/game-facts-check.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../src/main/indexer/parser.ts';
import { byteWordHashes, factCounts, factScope, forgetFacts, gameBuild, gameFact, GameMemo, own, saveFactStore, scriptWords, useFactStore, wordHash, wordHashes, WordGate } from '../src/main/mods/gameFacts.ts';
import { inertText, type InertKind, type InertWorld } from '../src/main/mods/inert.ts';
import { gameInertText, forgetGameRewrites } from '../src/main/mods/inertWork.ts';
import { keepingTexts } from '../src/main/mods/keptTexts.ts';
import { layerRoots } from '../src/main/mods/gameLayers.ts';
import { macroArgs, macroDefinitions, macroShape, type MacroDef } from '../src/main/mods/macroArgs.ts';
import { loadedNames } from '../src/main/mods/migrate.ts';
import { MIGRATIONS } from '../src/main/mods/migrations.ts';
import { decodeTextBody } from '../src/main/mods/textCodec.ts';

let bad = 0;
let count = 0;
const check = (ok: unknown, what: string, detail?: string): void =>
{
    count++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `\n     ${detail}` : ''}`);

    if (!ok)
        bad++;
};

const tmp = mkdtempSync(join(tmpdir(), 'ckp-game-facts-'));

try
{
    // 1. a fact and its file's stamp
    const file = join(tmp, 'a.txt');
    // (a modification time of whole seconds: it can be put back exactly)
    const T = 1700000000;
    writeFileSync(file, 'alpha = { beta = 1 }\n');
    utimesSync(file, T, T);
    let made = 0;
    const fact = (): string | undefined => gameFact('check', file, (data) => (made++, data.toString('latin1')));
    check(fact() === 'alpha = { beta = 1 }\n' && made === 1, 'a fact is made from the file');
    check(fact() === 'alpha = { beta = 1 }\n' && made === 1, 'asked again: kept');
    const st = statSync(file);
    // (same size, the modification time put back: the change time still differs)
    writeFileSync(file, 'gamma = { beta = 1 }\n');
    utimesSync(file, T, T);
    check(statSync(file).size === st.size && statSync(file).mtimeMs === st.mtimeMs, 'the test file has the same size and modification time');
    check(fact() === 'gamma = { beta = 1 }\n' && made === 2, 'the content changed (same size and modification time): made again');
    writeFileSync(file, 'gamma = { beta = 12 }\n');
    check(fact() === 'gamma = { beta = 12 }\n' && made === 3, 'the size changed: made again');
    const before = statSync(file);
    utimesSync(file, before.atime, new Date(before.mtimeMs + 5000));
    check(fact() === 'gamma = { beta = 12 }\n' && made === 4, 'the modification time changed: made again');
    // (inside a scope the stamp is looked at once: a change during the scope is seen by the next)
    factScope(() =>
    {
        check(fact() !== undefined && made === 4, 'in a scope: the kept fact');
        writeFileSync(file, 'delta = 1\n');
        check(fact() === 'gamma = { beta = 12 }\n' && made === 4, 'in a scope: the stamp is the one the scope looked at');
    });
    check(fact() === 'delta = 1\n' && made === 5, 'after the scope: the change is seen');
    // (a job is a scope too)
    await keepingTexts(async () =>
    {
        check(fact() === 'delta = 1\n' && made === 5, 'in a job: the kept fact');
    });
    rmSync(file);
    check(fact() === undefined && made === 5, 'a file that is gone: no fact');
    mkdirSync(file);
    check(fact() === undefined && made === 5, 'a folder of the name: no fact');
    rmSync(file, { recursive: true });
    check(own('x'.repeat(40) + 'y') === 'x'.repeat(40) + 'y' && own('short') === 'short', 'own: the same string');

    // 2. the memos of whole folders and the game's build
    const steamapps = join(tmp, 'steamapps');
    const install = join(steamapps, 'common', 'Game');
    const gameDir = join(install, 'game');
    mkdirSync(join(gameDir, 'dlc', 'dlc001'), { recursive: true });
    mkdirSync(join(install, 'binaries'), { recursive: true });
    writeFileSync(join(install, 'binaries', 'ck3.exe'), 'exe1');
    writeFileSync(join(install, 'titus_rev.txt'), 'rev1');
    const acf = (id: string): void => writeFileSync(join(steamapps, 'appmanifest_1158310.acf'), `"AppState"\n{\n\t"appid"\t\t"1158310"\n\t"buildid"\t\t"${id}"\n}\n`);
    acf('100');
    const memo = new GameMemo<number>();
    memo.set(gameDir, 'k', 1);
    check(memo.get(gameDir, 'k') === 1, 'a game memo keeps its value');
    const b0 = gameBuild(gameDir);
    acf('101');
    // (outside a scope the build of the last two seconds is taken: a scope looks again)
    factScope(() => check(memo.get(gameDir, 'k') === undefined && gameBuild(gameDir) !== b0, 'Steam\'s build id changed: the memo is empty'));
    factScope(() => memo.set(gameDir, 'k', 2));
    factScope(() => check(memo.get(gameDir, 'k') === 2, 'set again: kept'));
    writeFileSync(join(install, 'binaries', 'ck3.exe'), 'exe22');
    factScope(() => check(memo.get(gameDir, 'k') === undefined, 'the executable changed: the memo is empty'));
    factScope(() => memo.set(gameDir, 'k', 3));
    writeFileSync(join(install, 'titus_rev.txt'), 'rev2');
    factScope(() => check(memo.get(gameDir, 'k') === undefined, 'the revision changed: the memo is empty'));
    factScope(() => memo.set(gameDir, 'k', 4));
    mkdirSync(join(gameDir, 'dlc', 'dlc002'));
    factScope(() => check(memo.get(gameDir, 'k') === undefined, 'a DLC folder came: the memo is empty'));
    factScope(() => memo.set(gameDir, 'k', 5));
    factScope(() => check(memo.get(gameDir, 'k') === 5, 'nothing changed: kept'));
    check(memo.get(join(tmp, 'other', 'game'), 'k') === undefined, 'another game folder: its own memo');

    // 3. the words of the game's files, as the scans find them
    const GAME = 'D:/SteamLibrary/steamapps/common/Crusader Kings III/game';

    if (existsSync(GAME))
    {
        const below = (dir: string, ext: RegExp, out: string[] = []): string[] =>
        {
            for (const e of readdirSync(dir, { withFileTypes: true }))
                if (e.isDirectory())
                    below(join(dir, e.name), ext, out);
                else if (ext.test(e.name))
                    out.push(join(dir, e.name));

            return out;
        };
        const scripts = ['common', 'events', 'history', 'gfx'].flatMap((top) => below(join(GAME, top), /\.(txt|gfx)$/i));
        let wrong = 0;
        let words = 0;

        for (const f of scripts)
        {
            const text = decodeTextBody(readFileSync(f));
            const want = Uint32Array.from(new Set([...text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => wordHash(m[0]) >>> 0))).sort();
            const have = wordHashes(text);
            words += want.length;

            if (want.length !== have.length || want.some((h, i) => h !== have[i]))
                wrong++;

            const kept = scriptWords(f);

            if (!kept || kept.empty !== !text || kept.words.length !== have.length || kept.words.some((h, i) => h !== have[i]))
                wrong++;
        }

        check(scripts.length > 3000 && wrong === 0, `the words of the game's ${scripts.length} script files are the libraries scan's tokens (${words} in all), kept as made`, `${wrong} differ`);
        const data = below(join(GAME, 'common'), /\.txt$/i).slice(0, 3000);
        let wrongBytes = 0;

        for (const f of data)
        {
            const b = readFileSync(f);
            const want = Uint32Array.from(new Set([...b.toString('latin1').matchAll(/[A-Za-z0-9_]+/g)].map((m) => wordHash(m[0]) >>> 0))).sort();
            const have = byteWordHashes(b);

            if (want.length !== have.length || want.some((h, i) => h !== have[i]))
                wrongBytes++;
        }

        check(wrongBytes === 0, `the words of ${data.length} game files' bytes are the runs of [A-Za-z0-9_]`, `${wrongBytes} differ`);
        const gate = new WordGate(['has_trait', 'no_such_word_anywhere_x']);
        const t = wordHashes('a = { has_trait = brave }');
        check(gate.holds(t) && !new WordGate(['no_such_word_anywhere_x']).holds(t) && !new WordGate([]).holds(t) && new WordGate(['brave']).holds(t) && !new WordGate(['brav']).holds(t), 'a gate holds a file with one of its words, whole words only');

        // 4. loadedNames: with the game's words kept, as reading every file
        const roots = layerRoots(GAME);
        const asked = ['has_trait', 'add_gold', 'no_such_name_in_any_file_q', 'MAX_REALM_SIZE', 'religion_fervor_hof', 'tooltip_unknown_zz', 'shader_name_x1'];
        const other = ['has_trait.x', 'has-trait'];
        const read = await loadedNames(roots, [], asked);
        const kept1 = await keepingTexts(() => loadedNames(roots, [], asked, undefined, new Set(roots)));
        const kept2 = await keepingTexts(() => loadedNames(roots, [], asked, undefined, new Set(roots)));
        const same = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));
        check(same(read, kept1) && same(read, kept2) && read.size >= 2, `loadedNames with the game's words kept finds what reading finds (${[...read].sort().join(', ')}), twice`);
        const otherRead = await loadedNames(roots, [], [...asked, ...other]);
        const otherKept = await keepingTexts(() => loadedNames(roots, [], [...asked, ...other], undefined, new Set(roots)));
        check(same(otherRead, otherKept), 'names of other characters: every file read, the same names');

        // 5. macroArgs on the shapes, for the game's definitions
        const defs: MacroDef[] = [];

        for (const folder of ['common/scripted_triggers', 'common/scripted_effects'])
            for (const f of below(join(GAME, folder), /\.txt$/i))
            {
                const text = decodeTextBody(readFileSync(f));

                if (text.includes('$'))
                    defs.push(...macroDefinitions(parse(text), true));
            }

        // (each statement group's own targets, as the rules ask, and one more)
        const lists = [...MIGRATIONS.flatMap((m) => m.statements ?? []).flatMap((g) => (g.macroArgs ? [g.macroArgs] : [])), [{ key: 'target', inside: ['num_sinful_traits'] }]];
        let differ = 0;

        for (const list of lists)
        {
            const a = macroArgs(defs, list);
            const b = macroArgs(defs.map(macroShape), list);

            for (const d of defs)
                for (const m of JSON.stringify(d.node).matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\$/g))
                    if (a.has(d.name, m[1]) !== b.has(d.name, m[1]) || a.left(d.name, m[1]) !== b.left(d.name, m[1]))
                        differ++;

            for (const d of defs.slice(0, 200))
                if (a.mentions(`x = { ${d.name} = { A = b } }`) !== b.mentions(`x = { ${d.name} = { A = b } }`))
                    differ++;
        }

        check(defs.length > 100 && differ === 0, `macroArgs on the shapes of the game's ${defs.length} definitions answers as on their parse trees`, `${differ} differ`);
    }
    else
        console.log('(no game folder: the checks on the game\'s files are left out)');

    // 6. the kept inert rewrites
    const text = 'my_effect = {\n\tadd_trait = gone_trait\n\tif = { limit = { has_trait = kept_trait } add_gold = 5 }\n\tadd_trait = other_trait\n}\n';
    let asks = 0;
    const world = (missing: Set<string>, renamed?: Record<string, string>): InertWorld => ({
        missing: (_kind: InertKind, name: string) => (asks++, missing.has(name)),
        ...(renamed ? { renamed: (_kind: InertKind, name: string) => renamed[name] } : {})
    });
    const same = (a: ReturnType<typeof inertText>, b: ReturnType<typeof inertText>): boolean =>
        a.text === b.text && a.edits === b.edits && JSON.stringify([...a.names].map(([k, s]) => [k, [...s]])) === JSON.stringify([...b.names].map(([k, s]) => [k, [...s]])) && JSON.stringify(a.kept) === JSON.stringify(b.kept);
    const folder = 'common/scripted_effects/x.txt';
    forgetGameRewrites();
    const w1 = world(new Set(['gone_trait']));
    const first = gameInertText(text, folder, w1);
    check(same(first, inertText(text, folder, world(new Set(['gone_trait'])))) && first.text !== text, 'a kept rewrite: the rewrite\'s result');
    asks = 0;
    const again = gameInertText(text, folder, world(new Set(['gone_trait'])));
    check(same(again, first) && asks > 0, 'asked again in a world of the same answers: the kept result (the questions asked again)');
    const w2 = world(new Set(['other_trait']));
    const changed = gameInertText(text, folder, w2);
    check(same(changed, inertText(text, folder, world(new Set(['other_trait'])))) && changed.text !== first.text, 'an answer changed: rewritten again, the rewrite\'s result');
    const renamed = gameInertText(text, folder, world(new Set(['gone_trait']), { gone_trait: 'new_trait' }));
    check(same(renamed, inertText(text, folder, world(new Set(['gone_trait']), { gone_trait: 'new_trait' }))) && renamed.text.includes('new_trait'), 'a world with renamed entries: rewritten in it');
    const none = gameInertText(text, folder, world(new Set()));
    check(none.text === text && same(none, inertText(text, folder, world(new Set()))), 'nothing missing: the text as it is');
    check(same(gameInertText(text, 'common/scripted_triggers/x.txt', w1), inertText(text, 'common/scripted_triggers/x.txt', world(new Set(['gone_trait'])))), 'another folder: its own rewrite');

    // 7. kept on disk between sessions: taken back as made, by the same code only; a changed file is made again
    forgetFacts();
    forgetGameRewrites();
    const storeFile = join(tmp, 'store', 'game-facts-check.bin');
    const f1 = join(tmp, 'w1.txt');
    const f2 = join(tmp, 'w2.txt');
    writeFileSync(f1, 'has_trait = brave\nadd_gold = 5\n');
    writeFileSync(f2, 'other = { x = 1 }\n');
    useFactStore(storeFile, 'code-1');
    const w1a = scriptWords(f1);
    const k2a = gameFact('check-keys', f2, (data) => parse(decodeTextBody(data)).map((n) => n.k));
    gameInertText(text, folder, world(new Set(['gone_trait'])));
    saveFactStore();
    check(existsSync(storeFile), 'the facts are written to the file');
    // (as a new thread: nothing in memory, the file opened again)
    forgetFacts();
    forgetGameRewrites();
    useFactStore(storeFile, 'code-1');
    let remade = 0;
    const w1b = scriptWords(f1);
    const k2b = gameFact('check-keys', f2, () => (remade++, ['made again']));
    check(!!w1a && !!w1b && w1b.words instanceof Uint32Array && w1b.empty === w1a.empty && w1b.words.length === w1a.words.length && w1b.words.every((h, i) => h === w1a.words[i]), 'taken back: a file\'s words (a Uint32Array) as made');
    check(remade === 0 && JSON.stringify(k2b) === JSON.stringify(k2a), 'taken back: another kind of fact, not made again');
    asks = 0;
    const back = gameInertText(text, folder, world(new Set(['gone_trait'])));
    check(same(back, first) && asks > 0, 'taken back: a rewrite, its answers asked again');
    check(same(gameInertText(text, folder, world(new Set(['other_trait']))), inertText(text, folder, world(new Set(['other_trait'])))), 'taken back, another answer: rewritten');
    writeFileSync(f2, 'other = { x = 12 }\n');
    check(JSON.stringify(gameFact('check-keys', f2, () => (remade++, ['made again']))) === '["made again"]' && remade === 1, 'taken back, the file changed since: made again');
    forgetFacts();
    useFactStore(storeFile, 'code-2');
    let fresh = 0;
    gameFact('check-keys', join(tmp, 'w1.txt'), () => (fresh++, []));
    check(fresh === 1, 'another code version: nothing taken');
    forgetFacts();
    writeFileSync(storeFile, Buffer.from('not a store'));
    useFactStore(storeFile, 'code-1');
    check(scriptWords(f1)?.words.length === w1a!.words.length, 'a damaged file: nothing taken, the facts are made');
}
finally
{
    rmSync(tmp, { recursive: true, force: true });
    forgetFacts();
}

console.log(`\n${count - bad} of ${count} ok (facts kept: ${JSON.stringify(factCounts())})`);
process.exit(bad ? 1 : 0);
