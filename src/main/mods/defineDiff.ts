/**
 * What the game's version of a defines file has that a mod's older copy lacks (migrations.ts `defines`, docs/mods.md): the keys
 * the copy does not have at all, and the keys whose value in the copy is a path to a file or folder that nothing loaded has
 * any more while the game's value is one the game ships: an asset the version moved or renamed (`TRAIT_OVERLAY_VIRTUE =
 * "…/virtue_big.dds"`, the game's `virtue.dds`). Plain Node.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse, type PNode } from '../indexer/parser.ts';
import { gameFile } from './gameLayers.ts';

/** Whether a path (a file or a folder, as the defines write them) exists in what the game would load. */
export interface PathTest
{
    /** in the mod, the patch mod, the other mods of the loaded list or the game */
    resolves(path: string): boolean;
    /** in the game's own files */
    inGame(path: string): boolean;
}

/** Where a mod's paths are looked for besides the game's own files. */
export interface PathWorld
{
    gameDir: string;
    /** the mod's files (relative paths) */
    modFiles: Iterable<string>;
    patchRoot?: string;
    /** the folders of the other mods of the loaded list (a path only one of them has is theirs) */
    others?: string[];
}

/**
 * List defines whose words name entries of the game (`GOVERNMENT_TYPES = { "feudal_government" … }`, the governments the engine
 * registers modifiers for): the mod's older list lacks the words 1.20 added, and a key is merged over the whole list, so the
 * patch mod writes the list again with the game's words that the loaded world has an entry for.
 */
export interface ListDefines
{
    /** define key (lower case) → how script names an entry of the words (`government`, as in `government:x`) */
    prefix: Map<string, string>;
    /** the `prefix:name` references the loaded world has no entry for (a word of the game's list that is one stays out) */
    absent: Set<string>;
    /** gets `Namespace.KEY: word, word` for each list that gains words */
    listed?: string[];
}

const wordNodes = (n: PNode): PNode[] => (Array.isArray(n.v) ? n.v.filter((c) => c.k === null && typeof c.v === 'string') : []);

const clean = (p: string): string => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

/**
 * The defines file a patch mod writes for a folder (`common/defines`): in a subfolder of its own, named to sort after the folder's other
 * subfolders. The game reads the files directly in a folder first and then its subfolders (docs/mods.md, "File order within a folder"),
 * and of a key two files define the later one's value wins. A file at the folder's root loaded before a mod's `graphic/00_graphics.txt`,
 * whose old value then won again: `TRAIT_OVERLAY_VIRTUE` kept naming the `virtue_big.dds` 1.20 removed in every game test of AGOT and
 * Dragon Age, although the patch mod set the game's value.
 */
export const definesFile = (folder: string, patchFolderName: string): string => `${folder}/zz_${patchFolderName}/zz_${patchFolderName}_defines.txt`;

/** A path as the defines write one: folders joined by `/`, no placeholder or wildcard. */
const isPath = (v: string): boolean => /^[\w .\-]+(?:\/[\w .\-]+)+\/?$/.test(v);

export function pathTest(w: PathWorld): PathTest
{
    // (the mod's files and the folders above them, lower case; zipped mods too)
    const own = new Set<string>();

    for (const rel of w.modFiles)
    {
        const parts = clean(rel).toLowerCase().split('/');

        for (let i = 1; i <= parts.length; i++)
            own.add(parts.slice(0, i).join('/'));
    }

    const inGame = (path: string): boolean => !!gameFile(w.gameDir, clean(path));
    const under = (root: string, path: string): boolean => existsSync(join(root, ...clean(path).split('/')));

    return {
        inGame,
        resolves: (path) => own.has(clean(path).toLowerCase()) || inGame(path) || (!!w.patchRoot && under(w.patchRoot, path)) || (w.others ?? []).some((r) => under(r, path))
    };
}

/**
 * Defines the game's version of a file has and the mod's copy lacks: per namespace the game's statements, as the game writes
 * them: a key the copy has not, and (with `paths`) a key whose path the copy points where nothing is while the game's value
 * is a file or folder the game has; `stale` gets those keys as `Namespace.KEY`. `taken`: the keys another loaded file defines
 * (`namespace|key` in lower case, `definedKeys`): a defines file of the patch mod loads after every ordinary file, so a key
 * somebody else sets must not be written.
 */
export function missingDefines(gameText: string, modText: string, paths?: PathTest, stale?: string[], taken?: Set<string>, lists?: ListDefines): Map<string, string[]>
{
    const has = new Map<string, Map<string, PNode>>();

    for (const ns of parse(modText))
    {
        if (!ns.k || !Array.isArray(ns.v))
            continue;

        const keys = has.get(ns.k) ?? new Map<string, PNode>();
        ns.v.forEach((c) => keys.set((c.k ?? '').toLowerCase(), c));
        has.set(ns.k, keys);
    }

    const out = new Map<string, string[]>();

    for (const ns of parse(gameText))
    {
        if (!ns.k || !Array.isArray(ns.v))
            continue;

        const add: string[] = [];

        for (const c of ns.v)
        {
            if (!c.k)
                continue;

            if (taken?.has(`${ns.k}|${c.k}`.toLowerCase()))
                continue;

            const mine = has.get(ns.k)?.get(c.k.toLowerCase());

            if (!mine)
            {
                if (lists && Array.isArray(c.v) && lists.prefix.has(c.k.toLowerCase()))
                {
                    // (the mod's copy lacks the list: the game's words that the world has an entry for)
                    const prefix = lists.prefix.get(c.k.toLowerCase())!;
                    const all = wordNodes(c);
                    const gain = all.filter((w) => !lists.absent.has(`${prefix}:${w.v}`));

                    if (gain.length === all.length)
                        add.push(gameText.slice(c.s, c.e));
                    else if (gain.length)
                        add.push(`${c.k} = {\n${gain.map((w) => '\t' + (w.q ? `"${w.v}"` : (w.v as string))).join('\n')}\n}`);

                    if (gain.length && gain.length < all.length)
                        lists.listed?.push(`${ns.k}.${c.k}: ${gain.map((w) => w.v).join(', ')}`);
                }
                else
                    add.push(gameText.slice(c.s, c.e));
            }
            else if (paths && typeof mine.v === 'string' && typeof c.v === 'string' && mine.v !== c.v && isPath(mine.v) && isPath(c.v) && !paths.resolves(mine.v) && paths.inGame(c.v))
            {
                add.push(gameText.slice(c.s, c.e));
                stale?.push(`${ns.k}.${c.k}`);
            }
            else if (lists && Array.isArray(mine.v) && Array.isArray(c.v) && lists.prefix.has(c.k.toLowerCase()))
            {
                // (a list the mod has: its words, then the game's that the mod's lacks and the world has an entry for)
                const prefix = lists.prefix.get(c.k.toLowerCase())!;
                const own = wordNodes(mine);
                const have = new Set(own.map((w) => (w.v as string).toLowerCase()));
                const gain = wordNodes(c).filter((w) => !have.has((w.v as string).toLowerCase()) && !lists.absent.has(`${prefix}:${w.v}`));

                if (gain.length)
                {
                    const word = (w: PNode): string => '\t' + (w.q ? `"${w.v}"` : (w.v as string));
                    add.push(`${c.k} = {\n${[...own, ...gain].map(word).join('\n')}\n}`);
                    lists.listed?.push(`${ns.k}.${c.k}: ${gain.map((w) => w.v).join(', ')}`);
                }
            }
        }

        if (add.length)
            out.set(ns.k, [...(out.get(ns.k) ?? []), ...add]);
    }

    return out;
}

/** The define references in script (`define:NFaith|KEY`) or interface text (`GetDefine('NFaith','KEY')`): `Namespace|KEY` as written. */
export function defineRefs(text: string): Set<string>
{
    const out = new Set<string>();

    for (const m of text.matchAll(/\bdefine:([A-Za-z0-9_]+)\|([A-Za-z0-9_]+)/g))
        out.add(`${m[1]}|${m[2]}`);

    for (const m of text.matchAll(/\bGetDefine\(\s*'([A-Za-z0-9_]+)'\s*,\s*'([A-Za-z0-9_]+)'\s*\)/g))
        out.add(`${m[1]}|${m[2]}`);

    return out;
}

/** The defines a defines file text defines, as `namespace|key` in lower case (the engine reads them case-insensitively). */
export function definedKeys(text: string, into: Set<string> = new Set()): Set<string>
{
    for (const ns of parse(text))
        if (ns.k && Array.isArray(ns.v))
            for (const c of ns.v)
                if (c.k)
                    into.add(`${ns.k}|${c.k}`.toLowerCase());

    return into;
}
