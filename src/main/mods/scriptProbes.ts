/**
 * Questions the libraries rule asks of the same pass over the loaded script files (libraries.ts reads every `common`,
 * `events`, `history` and `gfx` text once for the references; a probe sees each text too, so the files are not read again):
 * the events a mod's older copy of a game's event file hides, and the arguments of macro calls.
 */
import { parse } from '../indexer/parser.ts';
import { gameFact, isTokenName, onGameDisk, own } from './gameFacts.ts';
import type { GameFile, GameFiles } from './gamefiles.ts';
import { decodeTextBody } from './textCodec.ts';
import type { MacroDrift, MissingEvents } from './libraries.ts';
import { eachWord, isWordName, pastFastPath, wordSet } from './wordRuns.ts';

/**
 * A question asked of each loaded script text. `wants`: false when there is nothing to ask (the pass skips it). `gameWords`: words
 * (each a whole match of libraries.ts `TOKEN`) one of which a file of the game (source 0) must hold for its visit to change the
 * result: a game file with none of them need not be visited, nor read (gameFacts.ts); undefined: every file is visited.
 */
export interface ScriptProbe
{
    wants: boolean;
    gameWords?: string[];
    visit(f: { rel: string; source: number; }, text: string): void;
}

const stripBom = (s: string): string => s.replace(/^﻿/, '');

/**
 * A game file that the migrated mod or its patch mod hides: they replace it (`by`), or they replace the file of the same path that
 * replaced it; another migrated mod's patch mod holds a copy of a game file (the inert step's whole-file copies of events and
 * on_actions), and the mod after it replaces that copy: the game's text is gone from the loaded files all the same.
 */
export function lostToHiders(vfs: GameFiles, h: { file: { rel: string; source: number; }; by: number; how: 'file' | 'replace_path'; }, hiders: Set<number>): boolean
{
    return h.file.source === 0 && (hiders.has(h.by) || (h.how === 'file' && hiders.has(vfs.get(h.file.rel)?.source ?? -1)));
}

/** An event id and its definition: `hunt.0080 = {` at the start of a line. */
const EVENT_ID = /(?<![A-Za-z0-9_.:@$])([A-Za-z_][A-Za-z0-9_]*\.\d+)(?![A-Za-z0-9_])/g;
const EVENT_HEADER = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*\.\d+)[ \t]*=[ \t]*\{/gm;

/**
 * Events a game file that a mod replaces (same path) defines, that no loaded file defines and other loaded files name
 * (`trigger_event = hunt.0080`, an `events = { }` list, an `on_start_event`): the mod's older copy hides them and the
 * game's activities, on_actions … still fire them. Not carried: an event is content, the mod author's call.
 */
export function eventProbe(vfs: GameFiles, hiders: Set<number>): ScriptProbe & { result(): MissingEvents[]; }
{
    // (the events of each hidden game file of events/)
    const wanted = new Map<string, string>();
    const totals = new Map<string, number>();

    for (const h of vfs.hidden('events', { ext: /\.txt$/i }).filter((x) => lostToHiders(vfs, x, hiders)))
    {
        const ids = [...stripBom(vfs.readText(h.file) ?? '').matchAll(EVENT_HEADER)].map((m) => m[1]);
        totals.set(h.file.rel, ids.length);
        ids.forEach((id) => wanted.set(id, h.file.rel));
    }

    const defined = new Set<string>();
    const named = new Map<string, string>();

    return {
        wants: wanted.size > 0,
        // (an id the expression finds starts after no word character and ends at its `.`: its namespace is a whole word of the text)
        gameWords: [...new Set([...wanted.keys()].map((id) => id.slice(0, id.indexOf('.'))))],
        visit(f, text)
        {
            for (const m of text.matchAll(EVENT_ID))
            {
                if (!wanted.has(m[1]))
                    continue;

                const ls = text.lastIndexOf('\n', m.index! - 1) + 1;
                const seg = text.slice(ls, m.index!);

                if (seg.includes('#'))
                    continue;

                if (!seg.trim() && /^[ \t]*=[ \t]*\{/.test(text.slice(m.index! + m[0].length, m.index! + m[0].length + 24)))
                    defined.add(m[1]);
                else if (!named.has(m[1]))
                    named.set(m[1], f.rel);
            }
        },
        result()
        {
            const byFile = new Map<string, string[]>();

            for (const [id, rel] of wanted)
                if (!defined.has(id) && named.has(id))
                    byFile.set(rel, [...(byFile.get(rel) ?? []), id]);

            return [...byFile].map(([rel, ids]) => ({ rel, total: totals.get(rel) ?? ids.length, ids })).sort((a, b) => (b.ids.length - a.ids.length) || (a.rel < b.rel ? -1 : 1));
        }
    };
}

/** What a scripted definition takes: every `$X$` (`declared`), those a call must give (`required`: no `|default`, not in a `[[X] … ]` part). */
export interface MacroParams
{
    declared: Set<string>;
    required: Set<string>;
    /**
     * a parameter is not written in capitals (`$dragon_age$`, passed as `dragon_age = 5`): a call's arguments cannot be told from
     * its other statements, so such a definition is not checked
     */
    lower: boolean;
}

/** A line without its comment (a `#` outside quotes). */
function noComment(line: string): string
{
    let quoted = false;

    for (let i = 0; i < line.length; i++)
    {
        if (line[i] === '"')
            quoted = !quoted;
        else if (line[i] === '#' && !quoted)
            return line.slice(0, i);
    }

    return line;
}

/** The macro parameters of a definition's text. */
export function macroParams(src: string): MacroParams
{
    const text = src.split('\n').map(noComment).join('\n');
    const declared = new Set<string>();
    const required = new Set<string>();
    let depth = 0;

    for (let i = 0; i < text.length; i++)
    {
        const c = text[i];

        if (c === '[')
        {
            // (`[[X] … ]`: the part between is there only when the call gives X; `[[!X] … ]` only when it does not)
            const head = text[i + 1] === '[' ? /^\[\[!?([A-Za-z0-9_]+)\]/.exec(text.slice(i, i + 80)) : null;

            if (head)
            {
                declared.add(head[1]);
                depth++;
                i += head[0].length - 1;
            }
            else if (depth > 0)
                depth++;
        }
        else if (c === ']' && depth > 0)
            depth--;
        else if (c === '$')
        {
            const m = /^\$([A-Za-z0-9_]+)(\|[^$\n]*)?\$/.exec(text.slice(i, i + 120));

            if (m)
            {
                declared.add(m[1]);

                if (!m[2] && depth === 0)
                    required.add(m[1]);

                i += m[0].length - 1;
            }
        }
    }

    return { declared, required, lower: [...declared].some((a) => !/^[A-Z][A-Z0-9_]*$/.test(a)) };
}

/** Statements of a call block that are no arguments although they are written in capitals. */
const NOT_ARGS = new Set(['NOT', 'OR', 'AND', 'NOR', 'NAND', 'ROOT', 'THIS', 'PREV', 'FROM']);

/** The arguments (capitalised keys at the first level) of the block that opens at `open`. */
function callArgs(text: string, open: number): Set<string>
{
    const args = new Set<string>();

    for (let i = open, depth = 0; i < text.length; i++)
    {
        const c = text[i];

        if (c === '#')
        {
            const e = text.indexOf('\n', i);
            i = e < 0 ? text.length : e;
        }
        else if (c === '"')
        {
            const e = text.indexOf('"', i + 1);
            i = e < 0 ? text.length : e;
        }
        else if (c === '{')
            depth++;
        else if (c === '}')
        {
            if (!--depth)
                break;
        }
        else if (depth === 1 && c >= 'A' && c <= 'Z' && /[\s{}]/.test(text[i - 1]))
        {
            const m = /^[A-Z][A-Z0-9_]*/.exec(text.slice(i, i + 64))!;

            if (!NOT_ARGS.has(m[0]) && /^\s*(?:=(?!=)|[<>]=?|!=|\?=)/.test(text.slice(i + m[0].length, i + m[0].length + 8)))
                args.add(m[0]);

            i += m[0].length - 1;
        }
    }

    return args;
}

/** The folders whose definitions take macro arguments, and what they are called in the notes. */
const MACRO_FOLDERS: [string, string][] = [['scripted_effect', 'common/scripted_effects'], ['scripted_trigger', 'common/scripted_triggers'], ['scripted_modifier', 'common/scripted_modifiers']];

interface MacroDef
{
    type: string;
    rel: string;
    source: number;
    params: MacroParams;
}

/**
 * Calls of scripted effects, triggers and modifiers (`name = { ARG = x }`) whose arguments do not fit the winning
 * definition: an argument it does not take ("failed for unknown arguments"), a required one left out ("failed for missing
 * arguments"). A mod's older copy of a definition takes the old arguments while the game's own callers pass the new ones
 * (a changed `$RITE$`), a mod's caller does not know the arguments the game's newer definition asks for. Only what
 * involves the mod: the winning definition is its own (or its patch mod's), or the caller is.
 * @param ownLibrary whether a file is the patch mod's library file (what an earlier run wrote is no definition)
 */
export function macroProbe(vfs: GameFiles, hiders: Set<number>, ownLibrary: (f: { rel: string; source: number; }) => boolean, gameCopy?: (f: { rel: string; source: number; }) => boolean): ScriptProbe & { result(): MacroDrift[]; }
{
    const defs = new Map<string, MacroDef>();
    const gameDefs = new Map<string, MacroDef>();
    // (a file's definitions and what each takes, in its order; a game file's kept for the session, gameFacts.ts)
    const paramsIn = (text: string): [string, MacroParams][] =>
        parse(text).flatMap((n) => (n.k && !n.k.startsWith('@') && Array.isArray(n.v) ? [[n.k, macroParams(text.slice(n.s, n.e))] as [string, MacroParams]] : []));
    // (kept for the session: strings of their own, gameFacts.ts `own`)
    const owned = ([name, p]: [string, MacroParams]): [string, MacroParams] => [own(name), { declared: new Set([...p.declared].map(own)), required: new Set([...p.required].map(own)), lower: p.lower }];
    const paramsOf = (f: GameFile): [string, MacroParams][] =>
        (onGameDisk(f) ? gameFact('macroParams', f.abs!, (data) => paramsIn(decodeTextBody(data)).map(owned)) : undefined) ?? paramsIn(stripBom(vfs.readText(f) ?? ''));
    const add = (map: Map<string, MacroDef>, type: string, f: { rel: string; source: number; }, params: [string, MacroParams][]): void =>
    {
        for (const [name, p] of params)
            map.set(name, { type, rel: f.rel, source: f.source, params: p });
    };

    for (const [type, folder] of MACRO_FOLDERS)
    {
        // (the game's own, as far as a mod hides it: kept apart to say what it takes)
        for (const h of vfs.hidden(folder, { ext: /\.txt$/i }).filter((x) => x.file.source === 0))
            add(gameDefs, type, h.file, paramsOf(h.file));

        for (const f of vfs.list(folder, { ext: /\.txt$/i }))
        {
            if (ownLibrary(f))
                continue;

            const params = paramsOf(f);
            add(defs, type, f, params);

            if (f.source === 0)
                add(gameDefs, type, f, params);
        }
    }

    type Seen = { n: number; rel: string; nh: number; relh: string; };
    const found = new Map<string, { unknown: Map<string, Seen>; missing: Map<string, Seen>; }>();
    const bump = (map: Map<string, Seen>, arg: string, rel: string, hider: boolean): void =>
    {
        const s = map.get(arg) ?? { n: 0, rel, nh: 0, relh: '' };
        s.n++;

        if (hider && !s.nh++)
            s.relh = rel;

        map.set(arg, s);
    };
    // (not behind `:` or `.`: `var:name = {`, `scope:name = {` change the scope into a saved one, they call nothing)
    const CALL = /(?<![A-Za-z0-9_:.])([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*\{/g;

    return {
        wants: defs.size > 0,
        // (a game file is no hider: what it calls counts only for the definitions of the mod and its patch mod (`result` takes the
        // hiders' calls of the others); a call's name starts after no word character and ends before `=`: a whole word of the text)
        gameWords: [...defs].filter(([name, d]) => hiders.has(d.source) && !d.params.lower && isTokenName(name)).map(([name]) => name),
        visit(f, text)
        {
            const hider = hiders.has(f.source) && !gameCopy?.(f);

            for (const m of text.matchAll(CALL))
            {
                const def = defs.get(m[1]);

                if (!def || def.params.lower)
                    continue;

                const ls = text.lastIndexOf('\n', m.index! - 1) + 1;

                // (the definition's own header, or a comment)
                if (ls === m.index || text.slice(ls, m.index!).includes('#'))
                    continue;

                const args = callArgs(text, m.index! + m[0].length - 1);
                const unknown = [...args].filter((a) => !def.params.declared.has(a));
                const missing = [...def.params.required].filter((a) => !args.has(a));

                if (!unknown.length && !missing.length)
                    continue;

                const rec = found.get(m[1]) ?? { unknown: new Map(), missing: new Map() };
                unknown.forEach((a) => bump(rec.unknown, a, f.rel, hider));
                missing.forEach((a) => bump(rec.missing, a, f.rel, hider));
                found.set(m[1], rec);
            }
        },
        result()
        {
            const out: MacroDrift[] = [];

            for (const [name, rec] of found)
            {
                const def = defs.get(name)!;
                const owner = def.source === 0 ? 'game' : hiders.has(def.source) ? 'mod' : 'other';
                // (the mod's own definition: every caller counts; otherwise only the mod's callers)
                const pick = (map: Map<string, Seen>): MacroDrift['unknown'] =>
                    [...map].map(([arg, s]) => ({ arg, n: owner === 'mod' ? s.n : s.nh, rel: owner === 'mod' ? s.rel : s.relh })).filter((x) => x.n > 0).sort((a, b) => (b.n - a.n) || (a.arg < b.arg ? -1 : 1));
                const unknown = pick(rec.unknown);
                const missing = pick(rec.missing);

                if (!unknown.length && !missing.length)
                    continue;

                const game = gameDefs.get(name);
                const takes = (p: MacroParams): string[] => [...p.declared].sort((a, b) => Number(p.required.has(b)) - Number(p.required.has(a)) || (a < b ? -1 : 1));
                const differs = !!game && owner !== 'game' && (game.params.declared.size !== def.params.declared.size || [...game.params.declared].some((a) => !def.params.declared.has(a)));
                out.push({ type: def.type, name, rel: def.rel, owner, takes: takes(def.params), unknown, missing, ...(differs ? { gameTakes: takes(game!.params) } : {}) });
            }

            return out.sort((a, b) => (a.name < b.name ? -1 : 1));
        }
    };
}

/** Who names the on_actions a hidden game file defines: loaded files (name → the first), and, of the rest, game files that are hidden. */
export interface OnActionRefs
{
    loaded: Map<string, string>;
    hidden: Set<string>;
}

/**
 * The files that name some on_actions (`on_actions = { x }`, `random_on_action = { 10 = x }`, `trigger_event = { on_action = x }` …):
 * every token of the wanted names that is no definition's key and not in a comment. A token search, not the index: the index
 * holds no reference of a hidden file, and which key a name stands under does not matter for a name this particular. The loaded
 * files come through `visit` (the pass the references are found in); the hidden ones are read once, in `result()`, and only for
 * the names no loaded file names.
 * @param names the on_actions of a hidden game file that no loaded file defines
 * @param hiddenFolders the folders whose hidden files may name them (the script folders)
 */
export function nameProbe(vfs: GameFiles, names: string[], hiddenFolders: string[]): ScriptProbe & { result(): OnActionRefs; mentions(text: string): string[]; }
{
    const loaded = new Map<string, string>();
    const wanted = new Set(names);
    // (longest first: a name that starts another is not taken for it; the lookarounds make the match a whole word)
    const re = new RegExp('(?<![A-Za-z0-9_.:@$])(' + [...names].sort((a, b) => b.length - a.length).join('|') + ')(?![A-Za-z0-9_$])', 'g');
    // (past V8's fast path, names of word characters only: found as whole words in one pass (wordRuns.ts), what the expression
    // finds of them)
    const words = pastFastPath(names) && names.every(isWordName) ? wordSet(names) : undefined;
    const found = (text: string, at: number, end: number, name: string, hit: (name: string) => void): void =>
    {
        const ls = text.lastIndexOf('\n', at - 1) + 1;
        const seg = text.slice(ls, at);

        // (a comment; the definition's own key)
        if (seg.includes('#') || (!seg.trim() && /^[ \t]*=/.test(text.slice(end, end + 8))))
            return;

        hit(name);
    };
    const find = (text: string, hit: (name: string) => void): void =>
    {
        if (!wanted.size)
            return;

        if (words)
        {
            // (the lookarounds besides a word character: not after `.`, `:`, `@` or `$`, not before `$`)
            eachWord(text, words, (w, from, to) =>
            {
                const before = from > 0 ? text[from - 1] : '';

                if (before !== '.' && before !== ':' && before !== '@' && before !== '$' && text[to] !== '$')
                    found(text, from, to, w, hit);
            });
            return;
        }

        re.lastIndex = 0;

        for (let m = re.exec(text); m; m = re.exec(text))
            found(text, m.index, m.index + m[0].length, m[1], hit);
    };

    return {
        wants: wanted.size > 0,
        // (a name of a word's shape is found only where no word character is on either side: a whole word of the text; a name of other
        // characters can be found inside words, every file is visited)
        gameWords: names.every(isTokenName) ? [...wanted] : undefined,
        visit(f, text)
        {
            find(text, (n) => !loaded.has(n) && loaded.set(n, f.rel));
        },
        mentions(text)
        {
            const out = new Set<string>();
            find(text, (n) => out.add(n));
            return [...out];
        },
        result()
        {
            const hidden = new Set<string>();
            const left = new Set([...wanted].filter((n) => !loaded.has(n)));

            for (const folder of left.size ? hiddenFolders : [])
            {
                for (const h of vfs.hidden(folder, { ext: /\.(txt|gfx)$/i }))
                {
                    const text = vfs.readText(h.file);

                    if (text)
                        find(text, (n) => left.has(n) && hidden.add(n));
                }
            }

            return { loaded, hidden };
        }
    };
}
