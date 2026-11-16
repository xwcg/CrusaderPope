/**
 * The `dataCalls` rule on the main side (dataCalls.ts finds and rewrites the calls): the environment the rules read (the
 * tenets, the localization keys the game itself defines (a key whose text the game's replaces the mod's), the game's texts of
 * the keys its program fills itself and the calls its texts make (the context rule)) and the notes the plan and the result tell.
 */
import { readFileSync } from 'node:fs';
import { tr, trn } from '../../shared/i18n.ts';
import { locValues, type ContextChange, type DataCallEnv } from './dataCalls.ts';
import { engineStrings } from './engineStrings.ts';
import { GameMemo } from './gameFacts.ts';
import { gameFilesBelow } from './gameLayers.ts';

/**
 * The keys of the game's English localization (the game's layers, engine ones included), read once per game folder, with the
 * doctrine scope their text uses (`TENET_TYPE` / `DOCTRINE_TYPE`; empty: none or both).
 */
const keyMemo = new GameMemo<Map<string, 'tenet' | 'doctrine' | ''>>();

function gameLocKeys(gameDir: string): Map<string, 'tenet' | 'doctrine' | ''>
{
    let keys = keyMemo.get(gameDir, '');

    if (!keys)
    {
        keys = new Map();

        for (const f of gameFilesBelow(gameDir, 'localization', /_l_english\.yml$/i))
            for (const m of readFileSync(f.abs, 'utf8').matchAll(/^[ \t]*([^\s:#"]+):\d*[ \t]+"(.*)$/gm))
            {
                const tenet = /\bTENET_TYPE\b/.test(m[2]);
                const doctrine = /\bDOCTRINE_TYPE\b/.test(m[2]);
                keys.set(m[1], tenet && !doctrine ? 'tenet' : doctrine && !tenet ? 'doctrine' : '');
            }

        keyMemo.set(gameDir, '', keys);
    }

    return keys;
}

/**
 * The game's texts in a language of the keys that are strings of its executable (the only ones the context rule asks for), read once
 * per game folder and language: a replace folder's text wins (`localization/<lang>/replace/`, `localization/replace/<lang>/`).
 */
const textMemo = new GameMemo<Map<string, string>>();

function gameTexts(gameDir: string, language: string): Map<string, string>
{
    const id = `${gameDir}|${language}`;
    let texts = textMemo.get(gameDir, id);

    if (!texts)
    {
        texts = new Map();
        const names = engineStrings(gameDir)?.names;
        const replace = (rel: string): boolean => /(^|\/)replace\//i.test(rel.replace(/^localization\//i, ''));
        const files = names ? gameFilesBelow(gameDir, 'localization', new RegExp(`_l_${language}\\.yml$`, 'i')) : [];

        for (const f of [...files.filter((x) => !replace(x.rel)), ...files.filter((x) => replace(x.rel))])
            for (const [key, text] of locValues(readFileSync(f.abs, 'utf8')))
                if (names!.has(key))
                    texts.set(key, text);

        textMemo.set(gameDir, id, texts);
    }

    return texts;
}

/**
 * The calls the game's own texts make on the first segment of a chain (`Rite.GetAdherentNamePlural`) in its English localization
 * and its interface files, read once per game folder (when the context rule first asks).
 */
const callMemo = new GameMemo<Set<string>>();

function gameCallPairs(gameDir: string): Set<string>
{
    let pairs = callMemo.get(gameDir, '');

    if (!pairs)
    {
        pairs = new Set();

        for (const f of [...gameFilesBelow(gameDir, 'localization', /_l_english\.yml$/i), ...gameFilesBelow(gameDir, 'gui', /\.gui$/i)])
            for (const m of readFileSync(f.abs, 'utf8').matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)/g))
                pairs.add(`${m[1]}.${m[2]}`);

        callMemo.set(gameDir, '', pairs);
    }

    return pairs;
}

/**
 * What the rules read: the tenets (the statement rules' set), the game's localization keys (read when a rule first asks).
 * `named`: of the keys the context rule would touch, the ones a loaded script or interface file names (migrate.ts
 * `namedContextKeys`); without it no key counts as filled by the game's program, and the rule changes nothing.
 */
export function dataCallEnv(gameDir: string, tenets: Set<string>, named?: Set<string>): DataCallEnv
{
    return {
        tenets,
        gameKey: (key) => gameLocKeys(gameDir).has(key),
        gameScope: (key) => gameLocKeys(gameDir).get(key) || undefined,
        ...(named ? { engineFilled: (key: string): boolean => !named.has(key) && !!engineStrings(gameDir)?.names.has(key) } : {}),
        gameText: (key, language) => gameTexts(gameDir, language).get(key),
        gameCalls: (root, method) => gameCallPairs(gameDir).has(`${root}.${method}`)
    };
}

/** The notes of a data call group: the sites it cannot map, the keys the game's text replaces, the data contexts renamed, replaced by the game's text or kept as the mod's choice. */
export function dataCallNotes(left: string[], dropped: string[], contexts: ContextChange[] = []): string[]
{
    const notes: string[] = [];

    if (dropped.length)
        notes.push(trn('{n} localization key goes from the patch mod’s copy, the game’s text shows (its structure changed in the game version, or it calls what the game removed): {list}', '{n} localization keys go from the patch mod’s copy, the game’s text shows (their structure changed in the game version, or they call what the game removed): {list}', new Set(dropped).size, { list: shortList([...new Set(dropped)]) }));

    if (left.length)
        notes.push(trn('{n} site stays as written (the call changed in a way no rewrite maps): {list}', '{n} sites stay as written (the calls changed in a way no rewrite maps): {list}', left.length, { list: shortList(left, 8) }));

    // (per context pair: how many texts (a key in each of its languages) and which keys)
    const renamed = contexts.filter((c) => !c.why && !c.kept);
    const pairs = new Map<string, ContextChange[]>();

    for (const c of renamed)
        pairs.set(`${c.from} → ${c.to}`, [...(pairs.get(`${c.from} → ${c.to}`) ?? []), c]);

    if (renamed.length)
        notes.push(trn('{n} text the game fills itself names a data context the game version replaced: the patch mod’s copy names the game’s, the mod’s wording stays — {list}', '{n} texts the game fills itself name a data context the game version replaced: the patch mod’s copies name the game’s, the mod’s wording stays — {list}', renamed.length, {
            list: [...pairs].map(([pair, list]) => trn('{pair}: {n} text ({keys})', '{pair}: {n} texts ({keys})', list.length, { pair, keys: shortList([...new Set(list.map((c) => c.key))]) })).join('; ')
        }));

    // (no safe rename: the game's text of the key in the patch mod's copy; the key, both sides and why, once for its languages)
    const replaced = contexts.filter((c) => c.why);

    if (replaced.length)
        notes.push(trn('{n} text the game fills itself names a data context the game version replaced, and no rename is safe: the patch mod’s copy has the game’s text of the key (the mod’s wording of that key goes) — {list}', '{n} texts the game fills itself name a data context the game version replaced, and no rename is safe: the patch mod’s copies have the game’s text of the key (the mod’s wording of those keys goes) — {list}', replaced.length, {
            list: shortList([...new Set(replaced.map((c) => (c.english
                ? tr('{key} ({from}; the game’s: {to}): {why} — in English, the game has no text of it in that language', { key: c.key, from: c.from, to: c.to, why: c.why })
                : tr('{key} ({from}; the game’s: {to}): {why}', { key: c.key, from: c.from, to: c.to, why: c.why }))))], 8)
        }));

    // (the mod's file keeps the game's current text of the key as a comment: its own line is deliberate, nothing is changed)
    const kept = contexts.filter((c) => c.kept);

    if (kept.length)
        notes.push(trn('{n} text the game fills itself stays as the mod wrote it: the mod’s file keeps the game’s current text as a comment, so its own line is deliberate — {list}', '{n} texts the game fills itself stay as the mod wrote them: the mod’s file keeps the game’s current text as a comment, so its own line is deliberate — {list}', kept.length, { list: shortList([...new Set(kept.map((c) => c.key))]) }));

    return notes;
}

/** Up to `n` of a list, then "…". */
function shortList(list: string[], n = 6): string
{
    return list.length > n ? list.slice(0, n).join(', ') + ', …' : list.join(', ');
}
