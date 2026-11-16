/**
 * Two checks of the `libraries` rule that look at the loaded world instead of at names (libraries.ts):
 *
 * - `portraitAnimationCheck`: a portrait animation of the game's `gfx/portraits/portrait_animations` names animation states
 *   (`head = "divine_gesture_3"`, defined in the `.asset` files of the portrait models), modifier packs
 *   (`portrait_modifier_pack = crozier`, in a `.modifierpack` file) and portrait modifiers (`animations_props = x`). A mod
 *   that replaces those files with older copies lacks what 1.20 added, and the engine logs the animation, the pack or the
 *   modifier as unknown for every one of its types (AGOT: 299 + 7 + 4 lines): such an entry is not carried.
 * - `reindexCategories`: the character interaction categories have an `index` each, must have no gaps ("DO NOT LEAVE GAPS IN
 *   index OR THE GAME WILL CRASH") and the engine drops a category whose index another one uses ("already uses index 15,
 *   overwriting"). 1.20 added `interaction_debug_pam` at 15; a mod's own category (AGOT's debug category) that has 15 too
 *   overwrites it and leaves a gap behind. The mod's category gets the next free index, in a copy of its file.
 */
import { tr } from '../../shared/i18n.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import type { GameFiles } from './gamefiles.ts';
import type { LibraryEntry } from './libraries.ts';

const stripBom = (s: string): string => s.replace(/^﻿/, '');

type Own = (f: { rel: string; source: number; }) => boolean;

/** The scalar values under the keys wanted, anywhere in a definition. */
function valuesOf(n: PNode, keys: Set<string>, out: [string, string][] = []): [string, string][]
{
    for (const c of Array.isArray(n.v) ? n.v : [])
    {
        if (c.k && typeof c.v === 'string' && keys.has(c.k))
            out.push([c.k, c.v]);
        else if (Array.isArray(c.v))
            valuesOf(c, keys, out);
    }

    return out;
}

const STATE_KEYS = new Set(['head', 'torso']);
const WANTED = new Set(['head', 'torso', 'portrait_modifier_pack', 'animations', 'animations_props']);

/**
 * What the loaded world has for a portrait animation: the animation states, modifier packs and portrait modifiers. Read when
 * the first entry is asked about. Returns, per animation definition, what it names that the world lacks (nothing: it fits).
 */
export function portraitAnimationCheck(vfs: GameFiles): (n: PNode) => string[]
{
    let states: Set<string> | undefined;
    let packs: Set<string> | undefined;
    let modifiers: Set<string> | undefined;
    const known = (): void =>
    {
        if (states)
            return;

        states = new Set();
        packs = new Set();
        modifiers = new Set();

        for (const f of vfs.list('gfx/models/portraits', { ext: /\.asset$/i }))
            for (const m of (vfs.readText(f) ?? '').matchAll(/\bstate\s*=\s*\{\s*name\s*=\s*"([^"]+)"/g))
                states.add(m[1]);

        for (const f of vfs.list('gfx/portraits/portrait_animations', { ext: /\.modifierpack$/i }))
            for (const n of parse(stripBom(vfs.readText(f) ?? '')))
                if (n.k && Array.isArray(n.v))
                    packs.add(n.k);

        // (`animations = { name = { … } }`, `animations_props = { … }`: the names are the second level of every file)
        for (const f of vfs.list('gfx/portraits/portrait_modifiers', { ext: /\.txt$/i }))
            for (const top of parse(stripBom(vfs.readText(f) ?? '')))
                for (const n of Array.isArray(top.v) ? top.v : [])
                    if (n.k && Array.isArray(n.v))
                        modifiers.add(n.k);
    };

    return (n) =>
    {
        const used = valuesOf(n, WANTED);

        if (!used.length)
            return [];

        known();
        const out = new Set<string>();

        for (const [k, v] of used)
        {
            if (STATE_KEYS.has(k) ? !states!.has(v) : k === 'portrait_modifier_pack' ? !packs!.has(v) : !modifiers!.has(v))
                out.add(STATE_KEYS.has(k) ? tr('animation state {name}', { name: v }) : k === 'portrait_modifier_pack' ? tr('modifier pack {name}', { name: v }) : tr('portrait modifier {name}', { name: v }));
        }

        return [...out];
    };
}

/** A category of the mod that got another index. */
export interface ReindexedCategory
{
    name: string;
    from: number;
    to: number;
    /** the file of the mod (or its patch mod) that defines it */
    rel: string;
    /** the game's category that has the index */
    with: string;
}

/** The `index = 15` statement of a category definition. */
function indexOf(n: PNode): PNode | undefined
{
    const ix = Array.isArray(n.v) ? n.v.find((c) => c.k === 'index' && typeof c.v === 'string' && /^\d+$/.test(c.v)) : undefined;
    return ix;
}

/** A category definition as the files give it. */
interface Category
{
    name: string;
    index: number;
    rel: string;
    source: number;
    /** the file's text and the value's place in it */
    text: string;
    at: number;
    end: number;
}

/**
 * The categories of the mod whose `index` is another category's of the game (loaded game files and the entries the rule
 * carries), each moved to the smallest index nobody has, with the text of the files with the new values. Undefined: none.
 * @param carried the game's categories the libraries rule carries over (their files are hidden)
 * @param hiders the sources of the mod and its patch mod
 */
export function reindexCategories(vfs: GameFiles, folder: string, hiders: Set<number>, own: Own, carried: LibraryEntry[]): { moved: ReindexedCategory[]; copies: { rel: string; text: string; }[]; } | undefined
{
    const last = new Map<string, Category>();

    for (const f of vfs.list(folder, { ext: /\.txt$/i }))
    {
        if (own(f))
            continue;

        const text = stripBom(vfs.readText(f) ?? '');

        for (const n of parse(text))
        {
            const ix = indexOf(n);

            if (n.k && !n.k.startsWith('@') && ix)
                last.set(n.k, { name: n.k, index: Number(ix.v), rel: f.rel, source: f.source, text, at: ix.vs, end: ix.e });
        }
    }

    // (the game's categories: its loaded files' last definitions, and the entries the rule carries)
    const byIndex = new Map<number, string>();

    for (const c of last.values())
        if (c.source === 0)
            byIndex.set(c.index, c.name);

    for (const e of carried)
    {
        for (const n of parse(e.text))
        {
            const ix = indexOf(n);

            if (n.k && ix)
                byIndex.set(Number(ix.v), n.k);
        }
    }

    const taken = new Set([...last.values()].map((c) => c.index).concat([...byIndex.keys()]));
    const moved: ReindexedCategory[] = [];
    const edits = new Map<string, { c: Category; to: number; }[]>();

    // (in file order; a category of the mod that has the game's own name is the game's entry changed, not a second one)
    for (const c of [...last.values()].filter((x) => hiders.has(x.source)))
    {
        const other = byIndex.get(c.index);

        if (other === undefined || other === c.name)
            continue;

        let to = 0;

        while (taken.has(to))
            to++;

        taken.add(to);
        moved.push({ name: c.name, from: c.index, to, rel: c.rel, with: other });
        edits.set(c.rel, [...(edits.get(c.rel) ?? []), { c, to }]);
    }

    if (!moved.length)
        return undefined;

    const copies = [...edits].map(([rel, list]) =>
    {
        let text = list[0].c.text;

        for (const { c, to } of [...list].sort((a, b) => b.c.at - a.c.at))
            text = text.slice(0, c.at) + String(to) + text.slice(c.end);

        return { rel, text: '﻿' + text };
    });
    return { moved, copies };
}
