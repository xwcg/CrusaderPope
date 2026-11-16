/**
 * What a game version added to definitions a mod's older copy of a game file still holds (migrations.ts `gains`): a
 * 1.19 copy of the game's tenet, doctrine, law group or modifier overrides the game's 1.20 definition of the same name and
 * lacks every key the version gave it (a tenet's `personal_tenet_modifier`, a doctrine's `divergence`, a law group's
 * `required_government_flag`) and the words the version put into its lists (`parameters`). The definition gets them from
 * the game's, last in it; what the mod's definition has stays.
 *
 * A rule's keys name things the older version did not have, and apply only while the mod shows no sign of knowing them: no
 * definition of the mod's files in the rule's `known` folders carries any of the rule's keys (a mod written for the new version
 * has them somewhere; where it left one out it did so on purpose). A list word counts besides only when no list of those files
 * has it (a parameter some other tenet of the mod has was known: leaving it out of this one was the mod's choice). Files the
 * app wrote (`writtenByApp`) are no sign of either.
 */
import { trn } from '../../shared/i18n.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { withoutAbsent } from './addKeys.ts';
import { indentAt, type StatementEdit } from './scriptRules.ts';

export interface GainRule
{
    /** path patterns of the files it concerns (the mod's, and the patch mod's own: the fixes write tenets and law groups there) */
    files: string[];
    label: string;
    /** keys the version added: the game's statements of the key (every one of them) go into a definition that lacks the key */
    keys?: string[];
    /** lists the version added words to (`parameters`): the game's words the definition lacks, and no list of the mod's files has */
    lists?: string[];
    /** patterns of the mod's files that show what the older copy knows (default: `files` and `pending`) */
    known?: string[];
    /**
     * patterns of the mod's files that hold these definitions before a fix moves them to `files` (1.19's tenets are doctrines,
     * its law groups sit in common/laws): they are planned from there; nothing is written into them
     */
    pending?: string[];
    /** the game's statements that name something the loaded world lacks are not taken (addKeys.ts `dropAbsent`) */
    dropAbsent?: boolean;
    /** the mod's own definitions the game gives nothing to are told (`tenets`: tenets without the personal tenet settings, `tenetGaps`) */
    gaps?: 'tenets';
}

/** What the game's definition of a name has of the keys and lists a rule asks for. */
export interface GameGain
{
    keys: Map<string, string[]>;
    /** per list: its words by name, as written */
    lists: Map<string, Map<string, string>>;
}

export type GameGains = Map<string, GameGain>;

/** What the mod's older files know: the keys they carry and the words of their lists. */
export interface GainScope
{
    /** the rule's keys, unless the older files carry one of them */
    keys: string[];
    /** whether the rule's lists get words (not when the older files carry a key of the rule) */
    lists: boolean;
    known: Set<string>;
}

const isBlock = (n: PNode): n is PNode & { v: PNode[]; } => Array.isArray(n.v);
const wordName = (n: PNode): string | undefined => n.k ?? (typeof n.v === 'string' ? n.v : undefined);

/** The folder a rule's definitions sit in, in the game too. */
export const gainFolder = (rule: GainRule): string => rule.files[0].slice(0, rule.files[0].lastIndexOf('/'));

/** The game's keys and list words of the rule per definition name, from the text of one of its files (a later file wins). */
export function gameGainsOf(text: string, rule: GainRule, into: GameGains): void
{
    const keys = rule.keys ?? [];
    const lists = rule.lists ?? [];

    if (![...keys, ...lists].some((k) => text.includes(k)))
        return;

    for (const n of parse(text))
    {
        if (!n.k || !isBlock(n))
            continue;

        const g: GameGain = { keys: new Map(), lists: new Map() };

        for (const c of n.v)
        {
            if (!c.k)
                continue;

            if (keys.includes(c.k))
                g.keys.set(c.k, [...(g.keys.get(c.k) ?? []), text.slice(c.s, c.e)]);

            if (lists.includes(c.k) && isBlock(c))
            {
                const words = g.lists.get(c.k) ?? new Map<string, string>();

                for (const m of c.v)
                {
                    const name = wordName(m);

                    if (name && !words.has(name))
                        words.set(name, text.slice(m.s, m.e));
                }

                g.lists.set(c.k, words);
            }
        }

        if (g.keys.size || g.lists.size)
            into.set(n.k, g);
        else
            into.delete(n.k);
    }
}

/**
 * Whether the app wrote the file: its leading comment lines name CrusaderPope (every file the fixes create has such a header:
 * `# tenets of the mod (moved from doctrines for 1.20 by CrusaderPope)`). Its definitions say nothing of what the mod knows:
 * the tenet-doctrine and law-group fixes write them with the fields of the game's, so they would make the next fix and the
 * migration think the mod knew the 1.20 fields.
 */
export function writtenByApp(text: string): boolean
{
    for (const line of text.replace(/^﻿/, '').split(/\r?\n/))
    {
        const t = line.trim();

        if (t && !t.startsWith('#'))
            return false;

        if (t.includes('CrusaderPope'))
            return true;
    }

    return false;
}

/** What the older files (their texts) carry of the rule's keys and lists; files the app wrote count for nothing. */
export function gainScope(rule: GainRule, texts: string[]): GainScope
{
    const carried = new Set<string>();
    const known = new Set<string>();
    const lists = rule.lists ?? [];

    for (const text of texts.filter((t) => !writtenByApp(t)))
    {
        for (const n of parse(text))
        {
            for (const c of isBlock(n) ? n.v : [])
            {
                if (!c.k)
                    continue;

                carried.add(c.k);

                if (lists.includes(c.k) && isBlock(c))
                    for (const m of c.v)
                    {
                        const name = wordName(m);

                        if (name)
                            known.add(name);
                    }
            }
        }
    }

    // (one key of the rule in the older files is enough: the mod is written for the new version, and what it left out it left out)
    const aware = (rule.keys ?? []).some((k) => carried.has(k));
    return { keys: aware ? [] : (rule.keys ?? []), lists: !aware, known };
}

/** The indentation of a block's statements: its first statement's when that stands on a line of its own, else one level in from the block's line. */
const innerIndent = (block: PNode & { v: PNode[]; }, text: string): string => (block.v.length && text.slice(block.vs, block.v[0].s).includes('\n') ? indentAt(text, block.v[0].s) : indentAt(text, block.s) + '\t');

/**
 * Statements put last in a block (a definition, a list): one line each, in the indentation of the block's statements, before
 * its closing brace, in the file's line ends.
 */
function insertLast(block: PNode & { v: PNode[]; }, text: string, statements: string[]): StatementEdit
{
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const close = block.e - 1;
    const lineStart = text.lastIndexOf('\n', close - 1) + 1;
    const base = indentAt(text, block.s);
    const indent = innerIndent(block, text);
    const lines = statements.map((s) => indent + s.replace(/\r?\n/g, eol));

    // (the brace stands on a line of its own: the lines go before it; else the block is cut open there)
    if (!text.slice(lineStart, close).trim())
        return { s: lineStart, e: lineStart, text: lines.map((l) => l + eol).join('') };

    // (the blanks before the brace go: `{ a }` opens as `{ a`, the lines, `}`)
    let from = close;

    while (from > block.vs + 1 && /[ \t]/.test(text[from - 1]))
        from--;

    return { s: from, e: close, text: lines.map((l) => eol + l).join('') + eol + base };
}

/**
 * The insertions that give each definition of a text what the game's definition of its name has and it lacks: the rule's keys
 * (`scope.keys`) and list words, last in the definition. `entries`: the names of the definitions that get something.
 */
export function gainEdits(text: string, rule: GainRule, scope: GainScope, game: GameGains, absent?: Set<string>): { edits: StatementEdit[]; entries: string[]; }
{
    const edits: StatementEdit[] = [];
    const entries: string[] = [];

    for (const n of parse(text))
    {
        const g = n.k && isBlock(n) ? game.get(n.k) : undefined;

        if (!g || !n.k || !isBlock(n))
            continue;

        const lines: string[] = [];
        const own = n.v.filter((c) => c.k);

        for (const key of scope.keys)
        {
            if (own.some((c) => c.k === key))
                continue;

            const found = withoutAbsent(g.keys.get(key) ?? [], absent ?? new Set());
            lines.push(...found);
        }

        const added: PNode[] = [];

        for (const key of scope.lists ? rule.lists ?? [] : [])
        {
            const words = g.lists.get(key);
            const block = own.find((c) => c.k === key && isBlock(c));

            if (!words)
                continue;

            // (a word the definition has in any of its lists, or the older files know anywhere, is not new)
            const there = new Set((rule.lists ?? []).flatMap((l) => own.filter((c) => c.k === l && isBlock(c)).flatMap((c) => (c.v as PNode[]).map(wordName))));
            const wanted = [...words].filter(([name]) => !scope.known.has(name) && !there.has(name)).map(([, t]) => t);

            if (!wanted.length)
                continue;

            if (block && isBlock(block))
            {
                edits.push(insertLast(block, text, wanted));
                added.push(block);
            }
            else
            {
                const indent = innerIndent(n, text);
                lines.push(`${key} = {\n${wanted.map((w) => `${indent}\t${w}`).join('\n')}\n${indent}}`);
            }
        }

        if (lines.length)
            edits.push(insertLast(n, text, lines));

        if (lines.length || added.length)
            entries.push(n.k);
    }

    return { edits, entries };
}

/** The tenets of a mod the game gave nothing to: its own (the game defines no tenet of the name) with none of the personal tenet settings. */
export interface TenetGaps
{
    /** the game's 1.19 tenets that 1.20 removed (the game's texts still name them) */
    removed: string[];
    /** the mod's other own tenets */
    own: string[];
}

/**
 * The tenets in the texts (the mod's tenet files, and the doctrine files where 1.19 kept them: top-level entries named `tenet_…`)
 * that the game does not define (`game`: the game's tenets with their settings) and that carry none of `keys` (the settings the
 * version gave every tenet of the game). `named`: the tenet keys the game's texts still name (their localization), which tells a
 * tenet 1.20 removed from one the mod made.
 */
export function tenetGaps(texts: string[], keys: string[], game: GameGains, named: Set<string>): TenetGaps
{
    const removed = new Set<string>();
    const own = new Set<string>();

    for (const text of texts)
    {
        for (const n of parse(text))
        {
            if (!n.k || !isBlock(n) || !/^tenet_/.test(n.k) || game.has(n.k) || n.v.some((c) => c.k && keys.includes(c.k)))
                continue;

            (named.has(n.k) ? removed : own).add(n.k);
        }
    }

    return { removed: [...removed].sort(), own: [...own].sort() };
}

/** What the plan and the result say of the tenets without personal tenet settings (none: nothing). */
export function tenetGapNotes(g: TenetGaps): string[]
{
    const list = (names: string[]): string => (names.length > 10 ? names.slice(0, 10).join(', ') + ', …' : names.join(', '));
    const notes: string[] = [];

    if (g.own.length)
        notes.push(trn('{n} tenet of the mod has no personal tenet settings (personal_tenet_modifier, personal_tenet_parameters), which 1.20 gives every tenet of the game: chosen as a personal tenet it gives only the Spiritual Fulfillment gain. They are the author’s to write; nothing is invented here — {list}', '{n} tenets of the mod have no personal tenet settings (personal_tenet_modifier, personal_tenet_parameters), which 1.20 gives every tenet of the game: chosen as a personal tenet they give only the Spiritual Fulfillment gain. They are the author’s to write; nothing is invented here — {list}', g.own.length, { list: list(g.own) }));

    if (g.removed.length)
        notes.push(trn('{n} tenet of the mod is one the game had in 1.19 and removed in 1.20 (its texts still name it), so there are no game settings to give it: as a personal tenet it gives only the Spiritual Fulfillment gain — {list}', '{n} tenets of the mod are ones the game had in 1.19 and removed in 1.20 (its texts still name them), so there are no game settings to give them: as personal tenets they give only the Spiritual Fulfillment gain — {list}', g.removed.length, { list: list(g.removed) }));

    return notes;
}
