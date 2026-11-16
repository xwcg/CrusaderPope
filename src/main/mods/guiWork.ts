/**
 * Interface files of a mod written for an older game (docs/mods.md, "Migrating a mod to a newer game version", the
 * interface rules). The mod overrides the game's `.gui` files with its copies; a newer game version moves types between
 * files, drops data functions and restructures windows. Three things need the layering of the loaded files, so they run in
 * the index worker (`GameFiles`), the text comes back to the main process (guiRule.ts):
 *
 * - **types** the game's live windows use that the mod's older copies of shared files lack: the game's definitions (types
 *   and templates, as the game wrote them, with what they use: a closure) go into one file of the patch mod. Types are
 *   global; the first definition of a name wins, so only names no loaded file defines are added, against the files as the
 *   patch mod will leave them (a restored game file brings its own types back).
 * - **roots**: the game's code looks root widgets up by name in their file (`Could not find widget 'x' in file 'gui/y.gui'`, every frame);
 *   the roots of the game's copy of a file a mod overrides that the winning copy lacks are appended to the patch mod's copy as the game
 *   wrote them, and the types they use are carried like any other (the appended roots are live in the closure).
 * - **orphans**: a file of the mod with no counterpart in the game, whose windows and types nothing live uses once the
 *   patch mod restores game files (a custom window the restored one used to include). Only on clear evidence: something
 *   used it before the restores and nothing does after. A file nothing used before stays (it may be used by the engine).
 * - **removed names**: identifiers in a mod's copy that the game's interface, localization, data bindings and engine do
 *   not know: functions the version removed. With the price of taking the game's file instead (the mod's lines that
 *   differ from it, the files that would become orphans): the dialog offers it, never by default.
 */
import { readFileSync } from 'node:fs';
import { tr } from '../../shared/i18n.ts';
import { gwalk, parseGui, type GNode } from '../gui/parser.ts';
import { GETTER_TYPES, type GameIndex } from '../indexer/gameIndex.ts';
import { commentStart, eolOf, trailingEnd } from '../indexer/override.ts';
import { expressionSpans } from './dataCalls.ts';
import { engineStrings } from './engineStrings.ts';
import { factScope, GameMemo } from './gameFacts.ts';
import { gameFile, gameFilesBelow } from './gameLayers.ts';
import type { GameFile, GameFiles } from './gamefiles.ts';

const lc = (s: string): string => s.toLowerCase();

export interface GuiConfig
{
    /** the patch mod's file that gets the game's types (its own output: left out of what counts as loaded) */
    typesRel: string;
    /** gui files the other rules take whole from the game / empty (lower case paths) */
    restore: string[];
    empty: string[];
    /** files to price as optional restores besides the ones with unknown names: the data calls found a site no rewrite maps */
    candidates: string[];
    /** names the data call rules rename or map (they are not unknown) */
    covered: string[];
}

/** A type or template the game's windows use, carried over. */
export interface GuiTypeDef
{
    kind: 'type' | 'template';
    name: string;
    /** the game's file and line */
    file: string;
    line: number;
    lines: number;
    /** the loaded definition that uses it (`file:line name`) */
    by: string;
    /** written with the game's body of its base type inlined: the mod's older copy of that base lacks these hooks the type overrides */
    inlined?: { base: string; hooks: string[]; dropped?: string[]; };
    /** carried from a file of a mod (its copy the patch mod hides), not from the game's file */
    fromMod?: boolean;
    /** written as an alias of this type or template of the game's current file (the game renamed it) instead of the mod's old body */
    aliasOf?: string;
}

/** A type or template a file of the mod defined and the patch mod's restore or emptying took away, which loaded files still use. */
export interface GuiLost
{
    name: string;
    kind: 'type' | 'template';
    /** the file (before the rules) that defined it */
    from: string;
    users: { rel: string; lines: number[]; }[];
}

/**
 * Hooks (`blockoverride "x"`) that loaded files override and what they override does not declare (`block "x"`), while the game's own
 * version of a file the mod replaced does: the mod's older copy lacks them, so the overrides land on nothing (the engine logs nothing).
 */
export interface GuiHook
{
    /** the replaced game file whose game version declares them */
    file: string;
    names: string[];
    /** the overrides (`file:line`, the first few) */
    users: string[];
}

/** A file of the mod that nothing live uses any more. */
export interface GuiOrphan
{
    rel: string;
    defs: number;
    /** the restored or emptied files that used it before */
    by: string[];
    /** the names of its definitions */
    names: string[];
    /** the scripted GUIs its text calls (`GetScriptedGui('x')`) */
    scripted: string[];
}

/** A file whose lines call what the game version removed, and what taking the game's file instead costs. */
export interface GuiOffer
{
    rel: string;
    /** identifiers the game does not know (and the data call rules do not map) */
    names: string[];
    /** lines of the mod's copy that the game's file lacks */
    custom: number;
    /** files that would become orphans */
    orphans: string[];
    /** types and templates the copy uses that the patch mod's game files no longer define */
    lost: string[];
    /** hooks the game's version of this file declares that loaded files override */
    hooks: string[];
    /** types and templates the copy defines that loaded files use and the game's file lacks: the restore takes them away */
    takes: string[];
}

/** Root widgets of the game's copy of a file that the winning loaded copy lacks, appended to the patch mod's copy. */
export interface GuiRoots
{
    rel: string;
    /** the roots appended: name and the line in the game's file */
    roots: { name: string; line: number; }[];
    /** the whole text of the patch mod's copy: the winning text with the roots after it */
    text: string;
}

export interface GuiWork
{
    roots: GuiRoots[];
    types: { text: string; defs: GuiTypeDef[]; skipped: string[]; };
    orphans: GuiOrphan[];
    lost: GuiLost[];
    hooks: GuiHook[];
    offers: GuiOffer[];
    /** identifiers the game does not know in files of the mod with no game counterpart (the mod's own data bindings, or removed ones) */
    ownUnknown: { rel: string; names: string[]; }[];
}

export interface Def
{
    kind: 'type' | 'template' | 'local_template' | 'root';
    name: string;
    group?: string;
    line: number;
    s: number;
    e: number;
    /** widget kinds, bases and `using`: what it needs */
    refs: string[];
    /** names in its values: quoted (`'name'`) or the whole value */
    quoted: string[];
    /** the lines (first few) where each name of `refs` is used */
    refAt: Map<string, number[]>;
    /** a type's base (`type x = base`) */
    base?: string;
    /**
     * the hooks it declares (`block "x"`, anywhere inside it) and the ones it overrides (`blockoverride "x"`, with their lines and
     * `of`: the names of what is overridden, from which the block can come (the widget around it, its base and `using`))
     */
    blocks: string[];
    hooks: { name: string; line: number; of: string[]; }[];
    file: string;
}

export interface Summary
{
    defs: Def[];
}

/** The summaries by the file's stamp (`where|size|mtime`); the game's files' by their path (`game|…`), while the game's build is the same (gameFacts.ts). */
const summaries = new Map<string, Summary>();
const gameSummaries = new GameMemo<Summary>();

/** The definitions of a gui file (types, templates, root widgets and windows) with the names each one refers to. */
function summarize(key: string, rel: string, text: string, gameDir: string): Summary
{
    const game = key.startsWith('game|');
    const hit = game ? gameSummaries.get(gameDir, key) : summaries.get(key);

    if (hit)
        return hit;

    const sum = summarizeText(rel, text);

    if (game)
        gameSummaries.set(gameDir, key, sum);
    else
        summaries.set(key, sum);

    return sum;
}

/**
 * What a `blockoverride` inside `parents` (below the definition `top`) overrides the blocks of: the nearest statement around it
 * that is no block, by its kind, base and `using`s (for a type or template itself: its base and `using`s).
 */
function overridden(top: GNode, parents: GNode[]): string[]
{
    const around = [...parents].reverse().find((p) => p.key !== 'block' && p.key !== 'blockoverride') ?? top;
    const names = new Set<string>();

    // (a root widget is its kind: `activity_locale_widget = { blockoverride … }`; a type or template has a name, its key is `type`)
    if (around.key && !(around === top && top.name))
        names.add(around.key);

    if (around.base)
        names.add(around.base);

    for (const c of around.children ?? [])
        if (c.key === 'using' && c.value)
            names.add(c.value);

    return [...names];
}

export function summarizeText(rel: string, text: string): Summary
{
    const defs: Def[] = [];

    const refsOf = (n: GNode): Pick<Def, 'refs' | 'quoted' | 'refAt' | 'blocks' | 'hooks'> =>
    {
        const refs = new Set<string>();
        const quoted = new Set<string>();
        const refAt = new Map<string, number[]>();
        const blocks = new Set<string>();
        const hooks: Def['hooks'] = [];
        const see = (name: string, line: number): void =>
        {
            refs.add(name);
            const at = refAt.get(name) ?? refAt.set(name, []).get(name)!;

            if (at.length < 4)
                at.push(line);
        };

        if (n.base)
            see(n.base, n.line);

        gwalk(n.children ?? [], (c, parents) =>
        {
            if (c.key === 'block' && c.name)
                blocks.add(c.name);
            else if (c.key === 'blockoverride' && c.name)
                hooks.push({ name: c.name, line: c.line, of: overridden(n, parents) });

            if (c.key === 'using' && c.value)
                see(c.value, c.line);
            else if (c.children && c.key)
                see(c.key, c.line);

            if (c.base)
                see(c.base, c.line);

            if (c.value)
            {
                for (const m of c.value.matchAll(/'([A-Za-z_]\w*)'/g))
                    quoted.add(m[1]);

                // (a value that is a definition's name: `datamodel`-less references like `type = x`)
                if (/^[A-Za-z_]\w*$/.test(c.value))
                    quoted.add(c.value);
            }
        });
        return { refs: [...refs], quoted: [...quoted], refAt, blocks: [...blocks], hooks };
    };

    const add = (kind: Def['kind'], n: GNode, group?: string): void =>
    {
        if (n.name)
            defs.push({ kind, name: n.name, group, line: n.line, s: n.s, e: n.e, base: n.base, ...refsOf(n), file: rel });
    };

    for (const n of parseGui(text))
    {
        if (n.key === 'types' || n.key === 'Types')
        {
            for (const t of n.children ?? [])
                if ((t.key === 'type' || t.key === 'local_type') && t.name)
                    add('type', t, n.name);
        }
        else if ((n.key === 'type' || n.key === 'local_type') && n.name)
            add('type', n);
        else if (n.key === 'template' && n.name)
            add('template', n);
        else if (n.key === 'local_template' && n.name)
            add('local_template', n);
        else if (n.children && n.key && !['layer', 'texticon', 'textformatting', ''].includes(n.key) && !n.key.startsWith('@'))
        {
            const name = n.children.find((c) => c.key === 'name')?.value ?? n.key;
            defs.push({ kind: 'root', name, line: n.line, s: n.s, e: n.e, ...refsOf(n), file: rel });
        }
    }

    return { defs };
}

/** A loaded interface file: the text as the patch mod will leave it. */
interface LFile
{
    rel: string;
    text: string;
    sum: Summary;
    origin: 'game' | 'mod' | 'patch' | 'other';
    /** the game has a file of the path */
    inGame: boolean;
    /** a patch mod's file that stands for no copy of the mod's (its own: a game file it carries, perhaps changed by hand) */
    ownCopy?: boolean;
    /** the loaded file the text was read from (its byte-order mark is not in `text`) */
    src?: GameFile;
}

interface Scenario
{
    files: LFile[];
}

/** Which of the loaded definitions something live uses: from every root widget through kinds, bases, `using` and quoted names. */
export function reachable(files: LFile[]): Set<Def>
{
    const byName = new Map<string, Def[]>();

    for (const f of files)
        for (const d of f.sum.defs)
            if (d.kind !== 'root')
                (byName.get(d.name) ?? byName.set(d.name, []).get(d.name)!).push(d);

    const live = new Set<Def>();
    const stack: Def[] = [];

    for (const f of files)
        for (const d of f.sum.defs)
            if (d.kind === 'root')
            {
                live.add(d);
                stack.push(d);
            }

    while (stack.length)
    {
        const d = stack.pop()!;

        for (const r of [...d.refs, ...d.quoted])
            for (const t of byName.get(r) ?? [])
                if (!live.has(t))
                {
                    live.add(t);
                    stack.push(t);
                }
    }

    return live;
}

/** The loaded interface files before the rules (`base`) and as the patch mod will leave them (`final`). */
export function scenarios(vfs: GameFiles, modSource: number, patchSource: number, cfg: GuiConfig, texts: Map<string, string>, extraRestore: string[] = []): { base: Scenario; final: Scenario; }
{
    const ext = /\.gui$/i;
    const restore = new Set([...cfg.restore, ...extraRestore].map(lc));
    const empty = new Set(cfg.empty.map(lc));
    const hiddenByPatch = new Map<string, GameFile>();
    const modUnderPatch = new Set<string>();

    if (patchSource > 0)
        for (const h of vfs.hidden('gui', { ext, engine: true }))
            if (h.by === patchSource)
            {
                hiddenByPatch.set(lc(h.file.rel), h.file);

                // (the mod's own copy only: another mod's, or another patch mod's restore of the game's file, is not this
                // patch mod's business)
                if (h.file.source === modSource)
                    modUnderPatch.add(lc(h.file.rel));
            }

    const counterpart = new Map<string, boolean>();
    const inGame = (rel: string): boolean =>
    {
        let has = counterpart.get(lc(rel));

        if (has === undefined)
        {
            has = !!gameFile(vfs.gameDir, rel);
            counterpart.set(lc(rel), has);
        }

        return has;
    };
    const cached = (key: string, load: () => string): string =>
    {
        let text = texts.get(key);

        if (text === undefined)
        {
            text = load();
            texts.set(key, text);
        }

        return text;
    };
    const read = (f: GameFile): { text: string; key: string; } =>
    {
        const st = vfs.stat(f);
        const key = `${vfs.where(f)}|${st.size}|${st.mtime}`;
        return { text: cached(key, () => vfs.readText(f) ?? ''), key };
    };
    const gameRead = (rel: string): { text: string; key: string; } | undefined =>
    {
        const g = gameFile(vfs.gameDir, rel);
        return g ? { text: cached(`game|${g}`, () => readFileSync(g, 'utf8').replace(/^﻿/, '')), key: `game|${g}` } : undefined;
    };
    const base: LFile[] = [];
    const final: LFile[] = [];

    for (const w of vfs.list('gui', { ext, engine: true }))
    {
        const origin = w.source === 0 ? 'game' : w.source === modSource ? 'mod' : w.source === patchSource ? 'patch' : 'other';

        // (the patch mod's own output is rewritten by this run: left out of what counts as loaded)
        if (origin === 'patch' && lc(w.rel) === lc(cfg.typesRel))
            continue;

        const here = read(w);
        const make = (r: { text: string; key: string; } | undefined, from: LFile['origin'], src?: GameFile): LFile | undefined => (r ? { rel: w.rel, text: r.text, sum: summarize(r.key, w.rel, r.text, vfs.gameDir), origin: from, inGame: inGame(w.rel), ownCopy: from === 'patch' && !modUnderPatch.has(lc(w.rel)), src } : undefined);
        const isEmpty = !here.text.trim();
        let b: LFile | undefined;
        let f: LFile | undefined;

        if (origin === 'patch' && (isEmpty || restore.has(lc(w.rel)) || empty.has(lc(w.rel))))
        {
            // (a copy the rules wrote: before them, the file it hides)
            const prev = hiddenByPatch.get(lc(w.rel));
            b = prev ? make(read(prev), prev.source === 0 ? 'game' : prev.source === modSource ? 'mod' : 'other', prev) : undefined;
            f = isEmpty || empty.has(lc(w.rel)) ? undefined : restore.has(lc(w.rel)) ? make(gameRead(w.rel) ?? here, 'game') : make(here, 'patch', w);
        }
        else
        {
            b = make(here, origin, w);
            f = restore.has(lc(w.rel)) ? make(gameRead(w.rel) ?? here, 'game') : empty.has(lc(w.rel)) ? undefined : b;
        }

        if (b)
            base.push(b);

        if (f)
            final.push(f);
    }

    return { base: { files: base }, final: { files: final } };
}

/** What `namedByScript` read in one query: the names asked so far, and the script files' quoted words (`quotedWords`). */
interface ScriptNames
{
    named: Map<string, boolean>;
    quoted?: QuotedWords;
}

/**
 * The script files' pieces between two quote marks in a row (`"` or `'`) that are words of [A-Za-z0-9_] (short enough to be a name):
 * per file each one's place in that row and its number in `words` (each word once, not a slice of its file).
 */
interface QuotedWords
{
    words: string[];
    ids: Map<string, number>;
    files: { at: Int32Array; id: Int32Array; }[];
}

/** the longest word kept (a longer name, or one of other characters, is asked of the files themselves) */
const QUOTED_MAX = 200;
const QUOTED_NAME = /^[A-Za-z0-9_]*$/;

function quotedWords(texts: Iterable<string>): QuotedWords
{
    const out: QuotedWords = { words: [], ids: new Map(), files: [] };
    const run = /[A-Za-z0-9_]*/y;

    for (const text of texts)
    {
        const at: number[] = [];
        const id: number[] = [];
        let dq = text.indexOf('"');
        let sq = text.indexOf('\'');
        let open = -1;
        let k = 0;

        while (dq >= 0 || sq >= 0)
        {
            let i: number;

            if (sq < 0 || (dq >= 0 && dq < sq))
            {
                i = dq;
                dq = text.indexOf('"', i + 1);
            }
            else
            {
                i = sq;
                sq = text.indexOf('\'', i + 1);
            }

            if (open >= 0)
            {
                run.lastIndex = open + 1;
                run.test(text);

                if (run.lastIndex === i && i - open - 1 <= QUOTED_MAX)
                {
                    const w = text.slice(open + 1, i);
                    let n = out.ids.get(w);

                    if (n === undefined)
                    {
                        out.ids.set(w, (n = out.words.length));
                        // (its own string, not a slice that keeps the file's text)
                        out.words.push(w.length > 12 ? (' ' + w).slice(1) : w);
                    }

                    at.push(k);
                    id.push(n);
                }

                k++;
            }

            open = i;
        }

        out.files.push({ at: Int32Array.from(at), id: Int32Array.from(id) });
    }

    return out;
}

/**
 * Which of the names script files put in quotes: an interface type is named from script too (`gui = "event_window_widget_x"` in
 * an event), so a type no loaded interface file reaches may still be used (the script files of events and common, every layer).
 * The files are read once per query: what `["'](names)["']` finds is a piece between two quote marks in a row that is a name,
 * the closing mark not opening the next piece, which the quoted words kept say for names of word characters.
 */
function namedByScript(vfs: GameFiles, names: Set<string>, memo: ScriptNames): Set<string>
{
    const ask = [...names].filter((n) => !memo.named.has(n));

    if (ask.length)
    {
        for (const n of ask)
            memo.named.set(n, false);

        const files = (): GameFile[] => ['events', 'common'].flatMap((dir) => vfs.list(dir, { ext: /\.txt$/i, engine: true }));

        if (ask.every((n) => n.length <= QUOTED_MAX && QUOTED_NAME.test(n)))
        {
            const q = (memo.quoted ??= quotedWords((function* (): Generator<string> { for (const f of files()) yield vfs.readText(f) ?? ''; })()));
            const wanted = new Set(ask.map((n) => q.ids.get(n)).filter((n): n is number => n !== undefined));

            for (const p of wanted.size ? q.files : [])
            {
                // (the place a match may start at: after a match, the piece after the next)
                let next = 0;

                for (let j = 0; j < p.at.length; j++)
                {
                    if (p.at[j] >= next && wanted.has(p.id[j]))
                    {
                        memo.named.set(q.words[p.id[j]], true);
                        next = p.at[j] + 2;
                    }
                }
            }
        }
        else
        {
            const re = new RegExp(`["'](${ask.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})["']`, 'g');

            for (const f of files())
            {
                const text = vfs.readText(f);

                if (text)
                    for (const m of text.matchAll(re))
                        memo.named.set(m[1], true);
            }
        }
    }

    return new Set([...names].filter((n) => memo.named.get(n)));
}

/**
 * The root widgets of the game's copy of every file a mod (or the patch mod) overrides that the winning copy lacks (the engine
 * looks a root up by its name), appended to the winning text as the game wrote them (comments above included). A name another
 * loaded file defines as a root stays out. Returns the scenario with those files as they will be left.
 */
export function withRoots(vfs: GameFiles, scn: Scenario): { scenario: Scenario; roots: GuiRoots[]; }
{
    const rootsOf = (f: LFile): Def[] => f.sum.defs.filter((d) => d.kind === 'root');
    const roots: GuiRoots[] = [];
    const files: LFile[] = [];

    for (const f of scn.files)
    {
        // (a mod's copy, or the patch mod's copy of it; not the patch mod's own copy of a game file no mod overrides, which is
        // the game's text or one changed by hand)
        const g = (f.origin === 'mod' || (f.origin === 'patch' && !f.ownCopy)) && f.inGame ? gameFile(vfs.gameDir, f.rel) : undefined;
        const gameText = g ? readFileSync(g, 'utf8').replace(/^﻿/, '') : undefined;

        if (gameText === undefined || gameText === f.text.replace(/^﻿/, ''))
        {
            files.push(f);
            continue;
        }

        const defined = new Set<string>(rootsOf(f).map((d) => d.name));

        for (const o of scn.files)
            if (o !== f)
                for (const d of rootsOf(o))
                    defined.add(d.name);

        const missing: Def[] = [];

        for (const d of summarizeText(f.rel, gameText).defs)
            if (d.kind === 'root' && !defined.has(d.name))
            {
                defined.add(d.name);
                missing.push(d);
            }

        if (!missing.length)
        {
            files.push(f);
            continue;
        }

        const eol = eolOf(f.text);
        // (the byte-order mark of the copy it is appended to stays as it is: a copy without one gets none)
        const bom = f.src ? (() => { const b = vfs.read(f.src); return !!b && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf; })() : true;
        const blockOf = (d: Def): string =>
        {
            const cs = commentStart(gameText, d.s);
            const ls = gameText.lastIndexOf('\n', d.s - 1) + 1;
            const from = cs === d.s && !gameText.slice(ls, d.s).trim() ? ls : cs;
            return gameText.slice(from, trailingEnd(gameText, d.e)).replace(/\s+$/, '');
        };
        const blocks = missing.map(blockOf);

        // (what the roots need that is local to the file: its local templates, and the `@name = value` constants; the winning
        // copy may lack both, and a root that uses an undefined constant would not load)
        const gameDefs = summarizeText(f.rel, gameText).defs;
        const haveLocal = new Set(f.sum.defs.filter((d) => d.kind === 'local_template').map((d) => d.name));
        const locals = new Map<string, Def>(gameDefs.filter((d) => d.kind === 'local_template' && !haveLocal.has(d.name)).map((d) => [d.name, d]));
        const needed = new Set<string>();
        const queue = [...missing];

        for (let d = queue.pop(); d; d = queue.pop())
            for (const r of d.refs)
                if (locals.has(r) && !needed.has(r))
                {
                    needed.add(r);
                    queue.push(locals.get(r)!);
                }

        const localBlocks = [...needed].map((n) => blockOf(locals.get(n)!));
        const gameConsts = new Map<string, string>();

        for (const m of gameText.matchAll(/^[ \t]*@([A-Za-z_]\w*)[ \t]*=[^\r\n]*/gm))
            gameConsts.set(m[1], m[0].trim());

        const ownConsts = new Set([...f.text.matchAll(/^[ \t]*@([A-Za-z_]\w*)[ \t]*=/gm)].map((m) => m[1]));
        const usedConsts = new Set<string>();
        let scan = [...blocks, ...localBlocks].join('\n');

        for (let more = true; more;)
        {
            more = false;

            for (const m of scan.matchAll(/@([A-Za-z_]\w*)/g))
                if (gameConsts.has(m[1]) && !ownConsts.has(m[1]) && !usedConsts.has(m[1]))
                {
                    usedConsts.add(m[1]);
                    scan += '\n' + gameConsts.get(m[1]);
                    more = true;
                }
        }

        const consts = [...usedConsts].map((n) => gameConsts.get(n)!);
        blocks.unshift(...(consts.length ? [consts.join('\n')] : []), ...localBlocks);
        // (fixed English, its em dash too: the state check compares the whole text, a change of the app's language must not make it look out of date)
        const head = `# Root widgets the game's ${f.rel} has and the mod's older copy lacks — ${missing.length}, as the game writes them (the game's code looks them up by name). Written by CrusaderPope.`;
        const body = f.text.replace(/^﻿/, '').replace(/\s+$/, '');
        const text = (bom ? '﻿' : '') + (body + '\n\n' + head + '\n\n' + blocks.join('\n\n') + '\n').replace(/\r?\n/g, eol);
        roots.push({ rel: f.rel, roots: missing.map((d) => ({ name: d.name, line: d.line })), text });
        files.push({ ...f, text, sum: summarizeText(f.rel, text), origin: 'patch' });
    }

    return { scenario: { files }, roots };
}

/**
 * The orphans of a scenario: files of the mod with no game counterpart with a definition that was live before and none now,
 * and that no script file names.
 */
function orphansOf(base: Scenario, final: Scenario, restoredBy: Set<string>, vfs: GameFiles, scripted: ScriptNames): GuiOrphan[]
{
    const liveBase = reachable(base.files);
    const liveFinal = reachable(final.files);
    const out: GuiOrphan[] = [];
    const cands: { f: LFile; nameable: Def[]; }[] = [];
    // (the file a run before emptied is no longer among the loaded ones (the patch mod's blank copy hides the mod's): it is still the orphan it was)
    const loadedRels = new Set(final.files.map((f) => lc(f.rel)));
    const emptiedBefore = base.files.filter((f) => f.origin === 'mod' && !f.inGame && !loadedRels.has(lc(f.rel)) && !restoredBy.has(lc(f.rel)));

    for (const f of [...final.files, ...emptiedBefore])
    {
        const nameable = f.sum.defs.filter((d) => d.kind !== 'root');

        // (the mod's own file: not the game's, not another mod's)
        if ((f.origin !== 'mod' && f.origin !== 'patch') || f.inGame || !nameable.length || f.sum.defs.some((d) => d.kind === 'root'))
            continue;

        if (nameable.some((d) => liveFinal.has(d)) || !nameable.some((d) => liveBase.has(d)))
            continue;

        cands.push({ f, nameable });
    }

    // (script names types too: a file with a type an event or other script file names is not "used by nothing")
    const named = namedByScript(vfs, new Set(cands.flatMap((c) => c.nameable.map((d) => d.name))), scripted);

    for (const { f, nameable } of cands)
    {
        if (nameable.some((d) => named.has(d.name)))
            continue;

        // (who used it: the restored or emptied files that name one of its definitions)
        const names = new Set(nameable.map((d) => d.name));
        const by = new Set<string>();

        for (const g of base.files)
            if (restoredBy.has(lc(g.rel)) && g.sum.defs.some((d) => [...d.refs, ...d.quoted].some((r) => names.has(r))))
                by.add(g.rel);

        out.push({ rel: f.rel, defs: nameable.length, by: [...by], names: nameable.map((d) => d.name), scripted: [...new Set([...f.text.matchAll(/\bGetScriptedGui\(\s*'([^']+)'/g)].map((m) => m[1]))] });
    }

    return out.sort((a, b) => (lc(a.rel) < lc(b.rel) ? -1 : 1));
}

// ---- hooks (`block` / `blockoverride`)

/**
 * The hooks a use of the type can override: every `block` in the definitions of that name and, transitively, of every name they
 * refer to (a base, a template, a widget of another type: the engine lets an override reach blocks of nested types).
 */
function blockClosure(name: string, lookup: (name: string) => Def[], memo: Map<string, Set<string>>): Set<string>
{
    let out = memo.get(name);

    if (!out)
    {
        out = new Set<string>();
        const seen = new Set<string>([name]);
        const todo = [name];

        while (todo.length)
            for (const d of lookup(todo.pop()!))
            {
                for (const b of d.blocks)
                    out.add(b);

                for (const r of d.refs)
                    if (!seen.has(r))
                    {
                        seen.add(r);
                        todo.push(r);
                    }
            }

        memo.set(name, out);
    }

    return out;
}

/** The statement that starts at an offset (the types of a `types` group included). */
function nodeAt(nodes: GNode[], s: number): GNode | undefined
{
    for (const n of nodes)
    {
        if (n.s === s)
            return n;

        if (n.children && n.s < s && s < n.e)
        {
            const hit = nodeAt(n.children, s);

            if (hit)
                return hit;
        }
    }

    return undefined;
}

const indentAt = (text: string, pos: number): string => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', pos - 1) + 1))![0];

/** Statements' text moved to another indent: the common indent taken off, `indent` put on, blank lines at both ends dropped. */
function reindent(text: string, indent: string): string
{
    const lines = text.split(/\r?\n/);

    while (lines.length && !lines[0].trim())
        lines.shift();

    while (lines.length && !lines[lines.length - 1].trim())
        lines.pop();

    const common = Math.min(...lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
    return lines.map((l) => (l.trim() ? indent + l.slice(common) : '')).join('\n');
}

/**
 * A type `type x = base { blockoverride … }` written with the game's body of `base` instead of the loaded one: the definition of
 * `base` in the game's file with each block the type overrides replaced by the override's statements (the `block` stays, so a use
 * can still override it), the type's own statements after them. Undefined when an override has no block in the game's body
 * itself (it may sit in a nested type: the loaded definition decides there) or a text does not parse as expected.
 */
export function inlineBase(ownText: string, own: Def, baseText: string, base: Def): { text: string; overrides: string[]; } | undefined
{
    const o = nodeAt(parseGui(ownText), own.s);
    const b = nodeAt(parseGui(baseText), base.s);

    if (!o?.inner || !b?.inner || !b.children || b.key !== 'type' || !b.base)
        return undefined;

    const overrides = new Map<string, GNode>();

    for (const c of o.children ?? [])
        if (c.key === 'blockoverride' && c.name && c.inner && !overrides.has(c.name))
            overrides.set(c.name, c);

    if (!overrides.size)
        return undefined;

    const unit = baseText.includes('\n\t') ? '\t' : '    ';
    const [is, ie] = b.inner;
    const found = new Set<string>();
    const reps: { s: number; e: number; text: string; }[] = [];
    let covered = -1;

    gwalk(b.children, (n) =>
    {
        const ov = n.key === 'block' && n.name && n.inner ? overrides.get(n.name) : undefined;

        if (!ov)
            return;

        found.add(n.name!);

        // (a block inside one that is replaced goes with it)
        if (n.s >= covered)
        {
            const pad = indentAt(baseText, n.s);
            const inner = reindent(ownText.slice(ov.inner![0], ov.inner![1]), pad + unit);
            reps.push({ s: n.s, e: n.e, text: baseText.slice(n.s, n.inner![0]) + '\n' + (inner ? inner + '\n' : '') + pad + '}' });
            covered = n.e;
        }
    });

    if ([...overrides.keys()].some((k) => !found.has(k)))
        return undefined;

    let body = '';
    let at = is;

    for (const r of reps)
    {
        body += baseText.slice(at, r.s) + r.text;
        at = r.e;
    }

    body += baseText.slice(at, ie);

    const head = baseText.slice(b.s, is).replace(/^type(\s+)\S+/, (_m, ws: string) => `type${ws}${own.name}`);
    const pad = indentAt(baseText, b.s) + unit;
    // (from the start of the statement's line: its first line has the indent the others are measured against)
    const lineFrom = (pos: number): number => (ownText.slice(ownText.lastIndexOf('\n', pos - 1) + 1, pos).trim() ? pos : ownText.lastIndexOf('\n', pos - 1) + 1);
    const extras = (o.children ?? []).filter((c) => c.key !== 'blockoverride').map((c) => reindent(ownText.slice(lineFrom(c.s), c.e), pad));
    const core = body.replace(/\s+$/, '');
    const text = head + core + (extras.length ? '\n\n' + extras.join('\n\n') : '') + body.slice(core.length) + baseText.slice(ie, b.e);
    return { text, overrides: [...overrides.keys()] };
}

/** Getters whose argument names no entry of a script database (a localization key, a concept, a history id): left alone by `dropAbsentWidgets`. */
const NOT_A_DATABASE = new Set(['localization', 'game_concepts', 'characters']);

/**
 * Whether the playset lacks the entry a data function names: `absent('GetDecision', 'tgp_x')` is true when the database the function reads
 * has entries at all and none of the loaded files defines that key (the mod took it out, the game version dropped it). A function the
 * index does not map to a database is never absent.
 */
export function absentKeyTest(idx: GameIndex): (getter: string, key: string) => boolean
{
    const names = new Map<string, Set<string>>();
    // (the entries some loaded file defines: a definition in a file a mod hid is kept in the index to show what was replaced, it is not live)
    const of = (type: string): Set<string> => names.get(type) ?? names.set(type, new Set(idx.names(type).filter((n) => idx.get(type, n)?.defs.some((d) => !idx.isHiddenDef(d))))).get(type)!;

    return (getter, key) =>
    {
        const types = GETTER_TYPES[getter];

        if (!types || types.some((t) => NOT_A_DATABASE.has(t)) || types.every((t) => !of(t).size))
            return false;

        return !types.some((t) => of(t).has(key));
    };
}

/**
 * A carried type's text without the widgets that call a data function with a literal key the playset lacks
 * (`visible = "[ObjectsEqual( GetDecision('x'), Decision.Self)]"` where no loaded file defines the decision `x`): the game logs
 * `Key x not found at Database: common/decisions` for every evaluation of every instance. Only the type's own leaf widgets go: a
 * widget with blocks or widgets inside stays as the game wrote it. `dropped`: `name (GetDecision('x'))` per widget.
 */
export function dropAbsentWidgets(text: string, absent: (getter: string, key: string) => boolean): { text: string; dropped: string[]; }
{
    const root = parseGui(text)[0];
    const cuts: { s: number; e: number; }[] = [];
    const dropped: string[] = [];

    for (const c of root?.key === 'type' ? root.children ?? [] : [])
    {
        if (!c.children || c.key === 'block' || c.key === 'blockoverride' || c.children.some((x) => x.key === 'block' || x.key === 'blockoverride' || x.children?.some((y) => y.key === 'name' || y.inner !== undefined)))
            continue;

        let hit: string | undefined;

        for (const sp of expressionSpans(text, c.s, c.e))
            for (const m of text.slice(sp.s, sp.e).matchAll(/\b(Get\w+)\(\s*'([^']+)'/g))
                if (!hit && absent(m[1], m[2]))
                    hit = `${m[1]}('${m[2]}')`;

        if (!hit)
            continue;

        const ls = text.lastIndexOf('\n', c.s - 1) + 1;
        const le = text.indexOf('\n', c.e);
        const alone = !text.slice(ls, c.s).trim() && !text.slice(c.e, le < 0 ? text.length : le).trim();
        cuts.push(alone ? { s: ls, e: le < 0 ? text.length : le + 1 } : { s: c.s, e: c.e });
        dropped.push(`${c.children.find((x) => x.key === 'name')?.value ?? c.key} (${hit})`);
    }

    return { text: cuts.sort((a, b) => b.s - a.s).reduce((t, x) => t.slice(0, x.s) + t.slice(x.e), text), dropped };
}

/**
 * Types and templates a file of the mod defined (before the rules) that no loaded file defines now (the patch mod's restore or
 * emptying took them away, `carried` are the ones written from the game's files) and a live definition still uses.
 */
function lostTypes(base: Scenario, left: Scenario, carried: Set<string>): GuiLost[]
{
    const defined = new Set(carried);

    for (const f of left.files)
        for (const d of f.sum.defs)
            if (d.kind !== 'root')
                defined.add(d.name);

    const was = new Map<string, Def>();

    for (const f of base.files)
        for (const d of f.sum.defs)
            if ((d.kind === 'type' || d.kind === 'template') && !defined.has(d.name) && !was.has(d.name))
                was.set(d.name, d);

    if (!was.size)
        return [];

    const live = reachable(left.files);
    const users = new Map<string, Map<string, number[]>>();

    for (const f of left.files)
    {
        // (a file of the game itself cannot use what only a mod defined)
        if (f.origin === 'game')
            continue;

        for (const d of f.sum.defs)
            if (live.has(d))
                for (const r of d.refs)
                    if (was.has(r))
                    {
                        const byFile = users.get(r) ?? users.set(r, new Map()).get(r)!;
                        const lines = byFile.get(f.rel) ?? byFile.set(f.rel, []).get(f.rel)!;

                        for (const n of d.refAt.get(r) ?? [d.line])
                            if (lines.length < 4 && !lines.includes(n))
                                lines.push(n);
                    }
    }

    return [...users].map(([name, byFile]) =>
    {
        const d = was.get(name)!;
        return { name, kind: d.kind as 'type' | 'template', from: d.file, users: [...byFile].map(([rel, lines]) => ({ rel, lines: lines.sort((a, b) => a - b) })).sort((a, b) => (lc(a.rel) < lc(b.rel) ? -1 : 1)) };
    }).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Hooks that loaded files override and what they override does not declare (the thing named, its base, its `using`s, and what these
 * use: a block of an unrelated definition, the types carried over included, is no help), which the game's own version of a
 * replaced file does: grouped by that file. `more`: definitions of the files the patch mod writes (the types carried over).
 */
function missingHooks(vfs: GameFiles, files: LFile[], more: Summary | undefined, moreRel: string): GuiHook[]
{
    const sums = [...files.map((f) => ({ rel: f.rel, sum: f.sum })), ...(more ? [{ rel: moreRel, sum: more }] : [])];
    const byName = new Map<string, Def[]>();

    for (const { sum } of sums)
        for (const d of sum.defs)
            if (d.kind !== 'root')
                (byName.get(d.name) ?? byName.set(d.name, []).get(d.name)!).push(d);

    // (a hook lands where the thing it overrides declares it: a block somewhere else in the loaded files, the carried types' included, is no help)
    const closures = new Map<string, Set<string>>();
    const lookup = (n: string): Def[] => byName.get(n) ?? [];
    const sites = new Map<string, string[]>();

    for (const { rel, sum } of sums)
        for (const d of sum.defs)
            for (const h of d.hooks)
                if (!h.of.some((o) => blockClosure(o, lookup, closures).has(h.name)))
                {
                    const at = sites.get(h.name) ?? sites.set(h.name, []).get(h.name)!;
                    const s = `${rel}:${h.line}`;

                    if (at.length < 6 && !at.includes(s))
                        at.push(s);
                }

    if (!sites.size)
        return [];

    const out: GuiHook[] = [];

    for (const f of files)
    {
        // (the files of the mod and its patch mod: another mod's older copy is its author's to fix)
        if ((f.origin !== 'mod' && f.origin !== 'patch') || !f.inGame)
            continue;

        const g = gameFile(vfs.gameDir, f.rel);
        const text = g ? readFileSync(g, 'utf8').replace(/^﻿/, '') : undefined;

        if (!g || text === undefined || text === f.text)
            continue;

        const own = new Set(f.sum.defs.flatMap((d) => d.blocks));
        const names = [...new Set(summarize(`game|${g}`, f.rel, text, vfs.gameDir).defs.flatMap((d) => d.blocks))].filter((n) => sites.has(n) && !own.has(n)).sort();

        if (names.length)
            out.push({ file: f.rel, names, users: [...new Set(names.flatMap((n) => sites.get(n)!))].slice(0, 6) });
    }

    return out.sort((a, b) => (lc(a.file) < lc(b.file) ? -1 : 1));
}

/**
 * The types to write and what stays lost for the files as left: the game's types first, then the types the mod's hidden copies
 * defined that loaded files still use (carried into the same file, with what they use in turn).
 */
function typesFor(vfs: GameFiles, before: Scenario, left: Scenario, absent?: (getter: string, key: string) => boolean): { types: GuiWork['types']; lost: GuiLost[]; }
{
    const first = missingTypes(vfs, left, undefined, undefined, absent);
    const lost = lostTypes(before, left, new Set(first.defs.map((d) => d.name)));

    if (!lost.length)
        return { types: first, lost };

    const types = missingTypes(vfs, left, before, new Set(lost.map((l) => l.name)), absent);
    return { types, lost: lostTypes(before, left, new Set(types.defs.map((d) => d.name))) };
}

/**
 * The game's types and templates that the files as left use and no file defines: for every game file the mod (or any mod)
 * overrides with another text, the definitions of the game's copy no loaded file has, kept when a loaded definition uses
 * them, with those they use in turn (and the local templates of their file, made global). A type that overrides hooks its
 * loaded base lacks is written with the game's base inlined (`inlineBase`) where that can be done.
 */
function missingTypes(vfs: GameFiles, final: Scenario, before?: Scenario, rescue?: Set<string>, absent?: (getter: string, key: string) => boolean): GuiWork['types']
{
    const loaded = new Set<string>();
    const used = new Map<string, Def>();
    const byName = new Map<string, Def[]>();

    for (const f of final.files)
        for (const d of f.sum.defs)
        {
            if (d.kind === 'type' || d.kind === 'template')
                loaded.add(`${d.kind}:${d.name}`);

            if (d.kind !== 'root')
                (byName.get(d.name) ?? byName.set(d.name, []).get(d.name)!).push(d);

            for (const r of d.refs)
                if (!used.has(r))
                    used.set(r, d);
        }

    // (the game's own copy of each file a mod replaced)
    interface Cand { def: Def; text: string; repl?: string; more?: string[]; inlined?: GuiTypeDef['inlined']; mod?: boolean; alias?: string; }
    const cands = new Map<string, Cand>();
    const locals = new Map<string, Cand[]>();
    const gameTypes = new Map<string, Cand>();

    for (const f of final.files)
    {
        if (f.origin === 'game' || !f.inGame)
            continue;

        const g = gameFile(vfs.gameDir, f.rel);
        const text = g ? readFileSync(g, 'utf8').replace(/^﻿/, '') : undefined;

        if (!g || text === undefined || text === f.text)
            continue;

        const sum = summarize(`game|${g}`, f.rel, text, vfs.gameDir);

        for (const d of sum.defs)
        {
            if (d.kind === 'type')
                gameTypes.set(d.name, { def: d, text });

            if (d.kind === 'local_template')
                locals.set(f.rel, [...(locals.get(f.rel) ?? []), { def: d, text }]);
            else if ((d.kind === 'type' || d.kind === 'template') && !loaded.has(`${d.kind}:${d.name}`))
                cands.set(`${d.kind}:${d.name}`, { def: d, text });
        }
    }

    // (the definitions of the mod's files the rules hide that loaded files still use, and nothing defines any more: carried too,
    // with what they use in turn from the same files)
    const hidden = new Map<string, Cand>();
    const hiddenLocals = new Map<string, Cand[]>();

    if (before && rescue?.size)
        for (const f of before.files)
        {
            if (f.origin === 'game')
                continue;

            for (const d of f.sum.defs)
            {
                if (d.kind === 'local_template')
                    hiddenLocals.set(f.rel, [...(hiddenLocals.get(f.rel) ?? []), { def: d, text: f.text, mod: true }]);
                else if ((d.kind === 'type' || d.kind === 'template') && !loaded.has(`${d.kind}:${d.name}`) && !hidden.has(`${d.kind}:${d.name}`))
                    hidden.set(`${d.kind}:${d.name}`, { def: d, text: f.text, mod: true });
            }
        }

    // (a definition of a hidden copy the game's current file of the same path renamed: same kind and base, a name the copy does not
    // define, close to the old one; then the game's definition answers to the old name too)
    const hiddenNames = new Map<string, Set<string>>();

    for (const f of before?.files ?? [])
        if (f.origin !== 'game')
            hiddenNames.set(lc(f.rel), new Set([...(hiddenNames.get(lc(f.rel)) ?? []), ...f.sum.defs.map((d) => d.name)]));

    const gameDefs = new Map<string, { defs: Def[]; text: string; }>();
    const skipped: string[] = [];
    const fileTexts = new Map(final.files.map((f) => [lc(f.rel), f.text]));
    const renamed = (c: Cand, userText?: string): string | undefined =>
    {
        const rel = c.def.file;
        let game = gameDefs.get(lc(rel));

        if (!game)
        {
            const g = gameFile(vfs.gameDir, rel);
            const text = g ? readFileSync(g, 'utf8').replace(/^﻿/, '') : '';
            game = { defs: g ? summarizeText(rel, text).defs : [], text };
            gameDefs.set(lc(rel), game);
        }

        if (c.def.name.length < 8)
            return undefined;

        const own = hiddenNames.get(lc(rel)) ?? new Set<string>();
        const ranked = game.defs.filter((d) => d.kind === c.def.kind && !own.has(d.name) && loaded.has(`${d.kind}:${d.name}`)).map((d) => ({ d, rank: renameOf(c.def, d) })).filter((x) => x.rank);
        const best = Math.min(...ranked.map((x) => x.rank));
        const near = ranked.filter((x) => x.rank === best).map((x) => x.d);

        if (near.length !== 1)
            return undefined;

        // (the new definition reads data its users do not provide: an alias would leave it empty; the old body stays, told)
        const to = near[0];
        const have = new Set([...dataRoots(c.text.slice(c.def.s, c.def.e)), ...(userText ? dataRoots(userText) : [])]);
        const oldOnly = [...dataRoots(c.text.slice(c.def.s, c.def.e))].filter((r) => !dataRoots(game!.text.slice(to.s, to.e)).has(r));
        const newOnly = [...dataRoots(game.text.slice(to.s, to.e))].filter((r) => !have.has(r));

        if (oldOnly.length && newOnly.length)
        {
            skipped.push(`${c.def.name} (${c.def.file}): ${tr('the game renamed it {to}, but {to} reads {list}, which the old definition and its users do not provide (the old one reads {old}) — the mod’s old body is carried instead of an alias', { to: to.name, list: newOnly.join(', '), old: oldOnly.join(', ') })}`);
            return undefined;
        }

        return to.name;
    };

    // (a type that overrides hooks its loaded base lacks: the game's body of the base instead, where it can be done)
    const closures = new Map<string, Set<string>>();
    const lookup = (n: string): Def[] => byName.get(n) ?? [cands.get(`type:${n}`), cands.get(`template:${n}`)].flatMap((c) => (c ? [c.def] : []));
    const prepare = (c: Cand): Cand =>
    {
        const d = c.def;
        const gb = d.kind === 'type' && d.base && d.hooks.length ? gameTypes.get(d.base) : undefined;

        if (!gb)
            return c;

        const have = blockClosure(d.base!, lookup, closures);

        if (!d.hooks.some((h) => !have.has(h.name)))
            return c;

        // (the type's own overrides, not the ones inside its statements)
        const own = nodeAt(parseGui(c.text), d.s);
        const direct = new Set((own?.children ?? []).flatMap((x) => (x.key === 'blockoverride' && x.name ? [x.name] : [])));
        const lacking = [...direct].filter((n) => !have.has(n));
        const r = lacking.length ? inlineBase(c.text, d, gb.text, gb.def) : undefined;
        // (and without the widgets of the game's body that name entries the playset lacks)
        const cut = r && absent ? dropAbsentWidgets(r.text, absent) : undefined;
        return r ? { ...c, repl: cut?.text ?? r.text, more: gb.def.refs, inlined: { base: d.base!, hooks: lacking, ...(cut?.dropped.length ? { dropped: cut.dropped } : {}) } } : c;
    };

    // (what a loaded definition uses first, then what those use)
    const chosen = new Map<string, Cand & { by: string; }>();
    const stack: Cand[] = [];

    for (const [key, c] of cands)
    {
        const user = used.get(c.def.name);

        if (user)
        {
            const p = prepare(c);
            chosen.set(key, { ...p, by: `${user.file}:${user.line} ${user.name}` });
            stack.push(p);
        }
    }

    for (const [key, c] of hidden)
    {
        const user = rescue!.has(c.def.name) && !cands.has(key) ? used.get(c.def.name) : undefined;

        if (user && !chosen.has(key))
        {
            const alias = renamed(c, (fileTexts.get(lc(user.file)) ?? '').slice(user.s, user.e));
            chosen.set(key, { ...c, alias, by: `${user.file}:${user.line} ${user.name}` });

            if (!alias)
                stack.push(c);
        }
    }

    while (stack.length)
    {
        const c = stack.pop()!;

        for (const r of [...c.def.refs, ...(c.more ?? [])])
        {
            const dep = c.mod
                ? (cands.get(`type:${r}`) ?? cands.get(`template:${r}`) ?? hidden.get(`type:${r}`) ?? hidden.get(`template:${r}`) ?? (hiddenLocals.get(c.def.file) ?? []).find((l) => l.def.name === r))
                : (cands.get(`type:${r}`) ?? cands.get(`template:${r}`) ?? (locals.get(c.def.file) ?? []).find((l) => l.def.name === r));

            if (!dep)
                continue;

            const key = dep.def.kind === 'local_template' ? `template:${dep.def.name}` : `${dep.def.kind}:${dep.def.name}`;

            // (a local template is global in the copy: unless a loaded template has the name already)
            if (dep.def.kind === 'local_template' && loaded.has(key))
            {
                skipped.push(`${c.def.name} (${c.def.file}): ${tr('uses the file’s local template {name}, which a loaded file defines as a template', { name: dep.def.name })}`);
                continue;
            }

            if (!chosen.has(key))
            {
                const p = prepare(dep);
                const alias = dep.mod && dep.def.kind !== 'local_template' ? renamed(dep, c.text.slice(c.def.s, c.def.e)) : undefined;
                chosen.set(key, { ...p, alias, by: `${c.def.file}:${c.def.line} ${c.def.name}` });

                if (!alias)
                    stack.push(p);
            }
        }
    }

    const defs: GuiTypeDef[] = [];
    const parts: { file: string; s: number; group?: string; text: string; }[] = [];
    let eol = '\n';

    for (const c of chosen.values())
    {
        const t = c.text;
        const from = (() =>
        {
            const cs = commentStart(t, c.def.s);
            // (no comments above: the line from its indent)
            const ls = t.lastIndexOf('\n', c.def.s - 1) + 1;
            return cs === c.def.s && !t.slice(ls, c.def.s).trim() ? ls : cs;
        })();
        let text = t.slice(from, trailingEnd(t, c.def.e));

        if (c.repl !== undefined)
        {
            // (a line of fixed English above the type, like the file's header: the state check compares the whole text)
            const pad = /[ \t]*$/.exec(t.slice(from, c.def.s))![0];
            const note = `# CrusaderPope: the mod's older ${c.inlined!.base} lacks the hooks this type overrides (${c.inlined!.hooks.join(', ')}): written with the game's ${c.inlined!.base} body.\n${pad}`;
            text = t.slice(from, c.def.s) + note + c.repl + t.slice(c.def.e, trailingEnd(t, c.def.e));
        }

        if (c.alias)
        {
            const pad = /^[ \t]*/.exec(t.slice(t.lastIndexOf('\n', c.def.s - 1) + 1))![0];
            text = c.def.kind === 'type' ? `${pad}type ${c.def.name} = ${c.alias} {}` : `${pad}template ${c.def.name}\n${pad}{\n${pad}\tusing = ${c.alias}\n${pad}}`;
        }

        if (c.def.kind === 'local_template')
            text = text.replace(/^(\s*(?:#[^\n]*\n\s*)*)local_template\b/, '$1template');

        if (!defs.length)
            eol = eolOf(t);

        parts.push({ file: c.def.file, s: c.def.s, group: c.def.group, text });
        defs.push({ kind: c.def.kind === 'type' ? 'type' : 'template', name: c.def.name, file: c.def.file, line: c.def.line, lines: text.split('\n').length, by: c.by, inlined: c.inlined, ...(c.mod ? { fromMod: true } : {}), ...(c.alias ? { aliasOf: c.alias } : {}) });
    }

    if (!parts.length)
        return { text: '', defs: [], skipped };

    // (by game file, in the file's order; types back in the group they were in)
    const order = parts.map((p, i) => ({ p, d: defs[i] })).sort((a, b) => (lc(a.p.file) < lc(b.p.file) ? -1 : lc(a.p.file) > lc(b.p.file) ? 1 : a.p.s - b.p.s));
    const sorted = order.map((x) => x.d);
    const blocks: string[] = [];
    let i = 0;

    while (i < order.length)
    {
        const { p } = order[i];

        if (p.group)
        {
            const inGroup = [p.text];
            let j = i + 1;

            while (j < order.length && order[j].p.file === p.file && order[j].p.group === p.group)
                inGroup.push(order[j++].p.text);

            blocks.push(`types ${p.group}\n{\n${inGroup.join('\n\n')}\n}`);
            i = j;
        }
        else
        {
            blocks.push(p.text);
            i++;
        }
    }

    // (fixed English, its em dash too: the state check compares the whole text, a change of the app's language must not make it look out of date)
    const head = `# Types and templates the game's windows use that the mod's older copies of shared interface files lack — ${sorted.length}, as the game writes them. Written by CrusaderPope.`;
    return { text: '﻿' + (head + '\n\n' + blocks.join('\n\n') + '\n').replace(/\r?\n/g, eol), defs: sorted, skipped };
}

// ---- names the game does not know

/** The identifiers of data expressions (single-quoted strings left out). */
function identifiersOf(text: string, kind: 'gui' | 'loc'): Set<string>
{
    const out = new Set<string>();
    const take = (line: string, from: number, to: number): void =>
    {
        for (const sp of expressionSpans(line, from, to))
            for (const m of line.slice(sp.s, sp.e).replace(/'[^']*'/g, "''").matchAll(/[A-Za-z_][A-Za-z0-9_]*/g))
                out.add(m[0]);
    };

    for (const raw of text.split('\n'))
    {
        if (!raw.includes('['))
            continue;

        if (kind === 'gui')
        {
            let q = false;
            let end = raw.length;

            for (let i = 0; i < raw.length; i++)
            {
                if (raw[i] === '"')
                    q = !q;
                else if (raw[i] === '#' && !q)
                {
                    end = i;
                    break;
                }
            }

            take(raw, 0, end);
        }
        else
        {
            const m = /^[ \t]*[^\s:#"]+:\d*[ \t]+"/.exec(raw);

            if (m)
                take(raw, m[0].length, raw.lastIndexOf('"'));
        }
    }

    return out;
}

/** What the game knows by name: its interface and localization expressions, and the strings of its executable. Read once. */
interface Vocab
{
    ids: Set<string>;
    exe: Set<string>;
}

const vocabMemo = new GameMemo<Vocab>();

function vocabulary(gameDir: string): Vocab
{
    let v = vocabMemo.get(gameDir, '');

    if (!v)
    {
        const ids = new Set<string>();

        for (const f of gameFilesBelow(gameDir, 'gui', /\.gui$/i))
            for (const id of identifiersOf(readFileSync(f.abs, 'utf8'), 'gui'))
                ids.add(id);

        for (const f of gameFilesBelow(gameDir, 'localization', /_l_english\.yml$/i))
            for (const id of identifiersOf(readFileSync(f.abs, 'utf8'), 'loc'))
                ids.add(id);

        // (the identifiers in the executable's strings, engineStrings.ts; no executable to read: the names the interface and localization
        // know are all there is)
        const exe = engineStrings(gameDir)?.runs ?? new Set<string>();

        v = { ids, exe };
        vocabMemo.set(gameDir, '', v);
    }

    return v;
}

/** The names the loaded mods define for the data system: data binding macros, game concepts and their aliases, customizable localization. */
function definedNames(vfs: GameFiles): Set<string>
{
    const out = new Set<string>();
    const text = (dir: string): string[] => vfs.list(dir, { ext: /\.txt$/i, engine: true }).map((f) => vfs.readText(f) ?? '');

    for (const t of text('data_binding'))
        for (const m of t.matchAll(/definition\s*=\s*"([^"(]+)/g))
            out.add(m[1].trim());

    for (const t of text('common/game_concepts'))
    {
        for (const m of t.matchAll(/^\s{0,1}([A-Za-z_]\w*)\s*=\s*\{/gm))
            out.add(m[1]);

        for (const m of t.matchAll(/alias\s*=\s*\{([^}]*)\}/g))
            for (const w of m[1].split(/\s+/))
                if (w)
                    out.add(w);
    }

    for (const t of text('common/customizable_localization'))
        for (const m of t.matchAll(/^([A-Za-z_]\w*)\s*=\s*\{/gm))
            out.add(m[1]);

    return out;
}

/** The objects the data expressions of a text start from (`Faith` in `[Faith.GetDoctrines]`, `Rite` in an argument); global functions left out. */
export function dataRoots(text: string): Set<string>
{
    const out = new Set<string>();

    for (const m of text.matchAll(/\[[^\]\n]*\]/g))
        for (const r of m[0].replace(/'[^']*'/g, "''").matchAll(/(?<![.\w])([A-Z][A-Za-z0-9]*)\s*\./g))
            if (!/^(?:Get|Is|Has|Select|Not|And|Or|Localize|Concatenate)/.test(r[1]))
                out.add(r[1]);

    return out;
}

/**
 * How the game's definition `to` is the 1.20 form of the mod's old definition `old` (same file, same kind), 0 when it is not:
 * 1 the old name plus one `_word` (whatever the base; what the new one reads is checked by the caller), 2 the same base and a name
 * close to it (edit distance 2), 3 another base (`vbox` -> `hbox`) with the name changed by the same substitution. The caller takes the
 * best rank and needs exactly one definition in it.
 */
export function renameOf(old: Def, to: Def): number
{
    if (new RegExp(`^${old.name}_[a-z0-9]+$`).test(to.name))
        return 1;

    if (old.base === to.base)
        return editDistance(to.name, old.name) <= 2 ? 2 : 0;

    if (!old.base || !to.base)
        return 0;

    const word = new RegExp(`(^|_)${old.base}(?=_|$)`);
    return word.test(old.name) && old.name.replace(word, `$1${to.base}`) === to.name ? 3 : 0;
}

/** The number of single-character changes (insert, delete, replace) between two names. */
function editDistance(a: string, b: string): number
{
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);

    for (let i = 1; i <= a.length; i++)
    {
        const row = [i];

        for (let j = 1; j <= b.length; j++)
            row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));

        prev = row;
    }

    return prev[b.length];
}

const norm = (s: string): string => s.trim();

/** Lines of a text that a game text lacks (blank lines and comments aside). */
function customLines(text: string, game: string): number
{
    const have = new Set(game.split('\n').map(norm));
    return text.split('\n').map(norm).filter((l) => l && !l.startsWith('#') && !have.has(l)).length;
}

/**
 * The work in the loaded interface files for a mod and its patch mod: the types to carry over, the files nothing uses, the
 * identifiers the game does not know in the mod's copies and what taking the game's file would cost.
 */
export function guiWork(idx: GameIndex, cfg: GuiConfig, modId: string, patchId: string | undefined): GuiWork | null
{
    // (the game's build looked at once for the query: gameFacts.ts)
    return factScope(() => guiQuery(idx, cfg, modId, patchId));
}

function guiQuery(idx: GameIndex, cfg: GuiConfig, modId: string, patchId: string | undefined): GuiWork | null
{
    const find =(id: string | undefined): number => (id ? idx.vfs.sources.findIndex((s) => s.modId?.toLowerCase() === id.toLowerCase()) : -1);
    const modSource = find(modId);

    if (modSource < 1)
        return null;

    const patchSource = find(patchId);
    const vfs = idx.vfs;
    const texts = new Map<string, string>();
    const sc = scenarios(vfs, modSource, patchSource, cfg, texts);
    const base = sc.base;
    const rooted = withRoots(vfs, sc.final);
    const final = rooted.scenario;
    const restoredBy = new Set([...cfg.restore, ...cfg.empty].map(lc));
    const scripted: ScriptNames = { named: new Map() };
    const orphans = orphansOf(base, final, restoredBy, vfs, scripted);

    // (a file nothing uses is emptied: the types are then computed without it)
    const gone = new Set(orphans.map((o) => lc(o.rel)));
    const left: Scenario = { files: final.files.filter((f) => !gone.has(lc(f.rel))) };
    const { types, lost } = typesFor(vfs, base, left, absentKeyTest(idx));

    // (what the restores took away that loaded files still use and nothing carried, and the hooks that land on nothing)
    const hooks = missingHooks(vfs, left.files, types.text ? summarizeText(cfg.typesRel, types.text.replace(/^﻿/, '')) : undefined, cfg.typesRel);
    const lostBy = new Map<string, Set<string>>();
    const hooksBy = new Map<string, string[]>(hooks.map((h) => [lc(h.file), h.names]));

    for (const l of lost)
        for (const u of l.users)
            (lostBy.get(lc(u.rel)) ?? lostBy.set(lc(u.rel), new Set()).get(lc(u.rel))!).add(l.name);

    // (names the game does not know)
    // (read when a name needs it: a mod with no interface files of its own never asks)
    let vocab: Vocab | undefined;
    let defined: Set<string> | undefined;
    const covered = new Set(cfg.covered);
    const known = (id: string): boolean =>
    {
        vocab ??= vocabulary(vfs.gameDir);
        defined ??= definedNames(vfs);
        return vocab.ids.has(id) || vocab.exe.has(id) || defined.has(id) || covered.has(id);
    };
    const offers: GuiOffer[] = [];
    const ownUnknown: GuiWork['ownUnknown'] = [];
    const candidates = new Set(cfg.candidates.map(lc));

    for (const f of left.files)
    {
        if (f.origin === 'game' || (f.origin !== 'mod' && f.origin !== 'patch'))
            continue;

        const g = f.inGame ? gameFile(vfs.gameDir, f.rel) : undefined;
        const gameText = g ? readFileSync(g, 'utf8').replace(/^﻿/, '') : undefined;

        if (gameText === f.text)
            continue;

        const names = [...identifiersOf(f.text, 'gui')].filter((id) => /^[A-Z][A-Za-z0-9_]{2,}$/.test(id) && !known(id)).sort();

        if (!f.inGame)
        {
            if (names.length)
                ownUnknown.push({ rel: f.rel, names });

            continue;
        }

        const lostHere = [...(lostBy.get(lc(f.rel)) ?? [])].sort();
        const hooksHere = hooksBy.get(lc(f.rel)) ?? [];

        if (!names.length && !lostHere.length && !hooksHere.length && !candidates.has(lc(f.rel)))
            continue;

        // (the price of the game's file instead: the mod's lines it lacks, the files that nothing would use then)
        const after = scenarios(vfs, modSource, patchSource, cfg, texts, [f.rel]);
        const more = orphansOf(after.base, after.final, new Set([...restoredBy, lc(f.rel)]), vfs, scripted).filter((o) => !gone.has(lc(o.rel)));
        // (and the types the copy defines that loaded files use: the game's file lacks them, the types are computed again for the files left)
        const goneAfter = new Set([...gone, ...more.map((o) => lc(o.rel))]);
        const leftAfter: Scenario = { files: withRoots(vfs, after.final).scenario.files.filter((x) => !goneAfter.has(lc(x.rel))) };
        // (before the types are carried: what the offered restore makes the patch mod's types file take over from the mod's copy)
        const lostAfter = lostTypes(after.base, leftAfter, new Set(missingTypes(vfs, leftAfter).defs.map((d) => d.name)));
        const takes = lostAfter.filter((l) => !lost.some((x) => x.name === l.name)).map((l) => l.name);
        offers.push({ rel: f.rel, names, custom: customLines(f.text, gameText!), orphans: more.map((o) => o.rel), lost: lostHere, hooks: hooksHere, takes });
    }

    return { roots: rooted.roots, types, orphans, lost, hooks, offers, ownUnknown };
}
