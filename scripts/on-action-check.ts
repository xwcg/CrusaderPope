// The static check behind "no on_action the engine fires is missing" (docs/mods.md, "on_actions the mod's copy hides"): after a
// migration, an on_action that the game defines in a file a mod hides, that no script of the game or the mods names (so the engine
// fires it by itself: on_rite_created, on_personal_tenet_gain …), must be defined by a loaded file. If not, the engine logs "Couldn't
// find predefined on action named x" and the personal tenet window of 1.20 crashes the game. Independent of the rule (libraries.ts):
// a token search over every script file, loaded or hidden, not the index.
import type { GameFiles } from '../src/main/mods/gamefiles.ts';
import { parse } from '../src/main/indexer/parser.ts';

const stripBom = (s: string): string => s.replace(/^﻿/, '');

/**
 * The on_actions of the game's hidden on_action files that no loaded on_action file defines and no script file names at all.
 */
export function engineOnActionsMissing(vfs: GameFiles): string[]
{
    const folder = 'common/on_action';
    const live = new Set<string>();

    for (const f of vfs.list(folder, { ext: /\.txt$/i }))
        for (const n of parse(stripBom(vfs.readText(f) ?? '')))
            if (n.k && Array.isArray(n.v))
                live.add(n.k);

    const hidden = new Set<string>();

    for (const h of vfs.hidden(folder, { ext: /\.txt$/i }).filter((x) => x.file.source === 0))
        for (const n of parse(stripBom(vfs.readText(h.file) ?? '')))
            if (n.k && !n.k.startsWith('@') && Array.isArray(n.v) && !live.has(n.k))
                hidden.add(n.k);

    // (the ones a mod's file has commented out, `# name = {`: the author took them out)
    const commented = new Set<string>();

    for (const f of vfs.list(folder, { ext: /\.txt$/i }).filter((x) => x.source > 0))
        for (const m of (vfs.readText(f) ?? '').matchAll(/^#+ ?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*\{/gm))
            commented.add(m[1]);

    commented.forEach((n) => hidden.delete(n));

    if (!hidden.size)
        return [];

    // (a word of the file that is no definition's key at the start of a line, and not in a comment)
    const named = new Set<string>();
    const word = /[A-Za-z_][A-Za-z0-9_]*/g;
    const scan = (text: string): void =>
    {
        for (const line of text.split('\n'))
        {
            if (!line.includes('_'))
                continue;

            const body = line.includes('#') ? line.slice(0, line.indexOf('#')) : line;
            word.lastIndex = 0;

            for (let m = word.exec(body); m; m = word.exec(body))
            {
                if (hidden.has(m[0]) && !(!body.slice(0, m.index).trim() && /^\s*=/.test(body.slice(m.index + m[0].length))))
                    named.add(m[0]);
            }
        }
    };

    for (const top of ['common', 'events', 'history', 'gfx'])
    {
        for (const f of vfs.list(top, { ext: /\.(txt|gfx)$/i }))
            scan(vfs.readText(f) ?? '');

        for (const h of vfs.hidden(top, { ext: /\.(txt|gfx)$/i }))
            scan(vfs.readText(h.file) ?? '');
    }

    return [...hidden].filter((n) => !named.has(n)).sort();
}
