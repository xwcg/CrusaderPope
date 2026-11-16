/**
 * The game's texts a mod's copies of its localization files hide (docs/mods.md, "Migrating a mod to a newer game version", the
 * `texts` rule). A mod file at the path of a game localization file replaces that file (same-path layering), so every key the
 * game's newer file has and the mod's older copy lacks is gone: raw keys in windows and tooltips ("Unlocalized text
 * 'GRANT_AS_GOVERNMENT_TYPE'", "Expected modifier localization key 'MOD_PIETY_STANDALONE_GAIN_MULT'").
 *
 * Which keys come back: the game's keys a copy lacks that no loaded localization file of the language defines, and that something
 * loaded uses: a loaded file outside the localization names it as a whole word (script, interface, the game's root files, the
 * patch mod's library files, the texts a run is about to write), a loaded text names it (`$KEY$`, `'KEY'`), the program has it as a
 * string of its own (`MOD_…` of the modifiers it registers), a text that comes back names it, or it is `NOT_` and a key that is
 * used (a negated custom description). Not every key the copy lacks: a mod also drops the game's keys on purpose (its own 25
 * loading tips where the game has 151, LOADING_TIP_%d in the executable; an empty credits file next to its own credits.txt). The
 * mod's keys are never touched: the texts go, as the game wrote them, into one file of the patch mod per language (no game file
 * has its path, so nothing is hidden; a key defined twice cannot come of it, the game's own file does not load).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { languageOf, locValues } from './dataCalls.ts';
import { engineStrings } from './engineStrings.ts';
import { GameMemo } from './gameFacts.ts';
import { gameFilesBelow, layerRoots } from './gameLayers.ts';
import { twinText } from './renamed.ts';
import { decodeText, decodeTextBody } from './textCodec.ts';

const lc = (s: string): string => s.toLowerCase();
const stripBom = (s: string): string => s.replace(/^﻿/, '');

/** The file the rule writes for a language in the patch mod (`folder`: the patch mod's folder name). */
export const textsFile = (folder: string, language: string): string => `localization/${language}/${folder}_game_texts_l_${language}.yml`;

/** Whether a path is one of the rule's files of a patch mod (any language). */
export const isTextsFile = (rel: string, folder: string): boolean => new RegExp(`^localization/[^/]+/${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_game_texts_l_[a-z_]+\\.yml$`, 'i').test(rel);

const KEY_LINE = /^[ \t]*([^\s:#"]+):\d*[ \t]+"/;

/** The keys of a localization file with their lines as written: from the key to the end of its line (a comment after the text kept); a later line of a key wins. */
export function locLines(text: string): Map<string, string>
{
    const out = new Map<string, string>();

    for (const raw of text.split('\n'))
    {
        const line = raw.replace(/\r$/, '');
        const m = KEY_LINE.exec(line);

        if (m)
            out.set(m[1], line.trimStart().trimEnd());
    }

    return out;
}

/**
 * The keys a localization file defines, also a line without a blank before its text (`KEY:0"text"`, which the line reader of the
 * data call rules skips): a key the mod writes so is the mod's, and comes from nowhere else.
 */
export function locKeys(text: string, out: Set<string> = new Set()): Set<string>
{
    for (const m of text.matchAll(/^[ \t]*([^\s:#"]+):\d*[ \t]*"/gm))
        out.add(m[1]);

    return out;
}

/** The keys a localization text names: `$KEY$` (with a format, `$KEY|U$`) and a quoted argument, `[Localize( 'KEY' )]`. */
export function textRefs(text: string, out: Set<string> = new Set()): Set<string>
{
    for (const m of text.matchAll(/\$([A-Za-z0-9_.\-]+)[$|]/g))
        out.add(m[1]);

    for (const m of text.matchAll(/'([A-Za-z0-9_.\-]+)'/g))
        out.add(m[1]);

    return out;
}

/** The folders no localization key is named from (data only), skipped by the scan for speed: map objects, DNA, ethnicities, coats of arms. */
const DATA_FOLDERS = /^(?:gfx\/fx|gfx\/map\/map_object_data|map_data|common\/dna_data|common\/ethnicities|common\/bookmark_portraits|common\/coat_of_arms|tests|dlc|localization)(?:\/|$)/i;

/** A file of a root that may name a localization key: script, interface and sprite files (`.txt`, `.gui`, `.gfx`) outside the data folders. */
const namingFile = (rel: string): boolean =>
    /\.(?:txt|gui|gfx)$/i.test(rel) && !DATA_FOLDERS.test(rel) && !rel.split('/')
        .pop()!
        .startsWith('.');

/** The files below a root (paths relative to it), each folder read once. */
function walkRoot(root: string, keep: (rel: string, dir: boolean) => boolean): string[]
{
    const out: string[] = [];
    const walk = (dir: string, rel: string): void =>
    {
        let entries;

        try
        {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch
        {
            return;
        }

        for (const e of entries)
        {
            const r = rel ? `${rel}/${e.name}` : e.name;

            if (e.isDirectory() ? keep(r, true) : e.isFile() && keep(r, false))
                e.isDirectory() ? walk(join(dir, e.name), r) : out.push(r);
        }
    };
    walk(root, '');
    return out;
}

const ID = new Uint8Array(256);

for (let c = 0; c < 256; c++)
    ID[c] = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122) || c === 46 || c === 45 ? 1 : 0;

/**
 * A scanner for whole words (identifier characters, `.` and `-` as localization keys have them): only a word whose length and first
 * byte some wanted name has is made a string and looked up, so a file of hundreds of megabytes is read at disk speed.
 */
function wordScanner(names: Set<string>): (buf: Buffer, found: Set<string>) => void
{
    const max = Math.max(0, ...[...names].map((n) => n.length));
    const gate = new Uint8Array((max + 1) * 256);

    for (const n of names)
        gate[n.length * 256 + n.charCodeAt(0)] = 1;

    return (buf, found) =>
    {
        let s = -1;

        for (let i = 0, n = buf.length; i <= n; i++)
        {
            if (i < n && ID[buf[i]])
            {
                if (s < 0)
                    s = i;

                continue;
            }

            if (s >= 0)
            {
                const len = i - s;

                if (len <= max && gate[len * 256 + buf[s]])
                {
                    const w = buf.toString('latin1', s, i);

                    if (names.has(w))
                        found.add(w);
                }

                s = -1;
            }
        }
    };
}

/** What a game localization file of a language gives (read once per game folder and language): its keys and the keys its texts name. */
const gameLocMemo = new GameMemo<{ rel: string; keys: string[]; refs: string[]; }[]>();

function gameLoc(gameDir: string, language: string): { rel: string; keys: string[]; refs: string[]; }[]
{
    const id = `${gameDir}|${language}`;
    let list = gameLocMemo.get(gameDir, id);

    if (!list)
    {
        list = gameFilesBelow(gameDir, 'localization', new RegExp(`_l_${language}\\.yml$`, 'i')).map((f) =>
        {
            const text = stripBom(readFileSync(f.abs, 'utf8'));
            const refs = new Set<string>();

            for (const t of locValues(text).values())
                textRefs(t, refs);

            return { rel: f.rel, keys: [...locKeys(text)], refs: [...refs] };
        });
        gameLocMemo.set(gameDir, id, list);
    }

    return list;
}

/** The game's localization files of every language by lower-case path (the first layer's file of a path), listed once per game folder. */
const locFilesMemo = new GameMemo<Map<string, string>>();

function gameLocFiles(gameDir: string): Map<string, string>
{
    let files = locFilesMemo.get(gameDir, '');

    if (!files)
    {
        files = new Map(gameFilesBelow(gameDir, 'localization', /\.yml$/i).map((f) => [lc(f.rel), f.abs]));
        locFilesMemo.set(gameDir, '', files);
    }

    return files;
}

/** What the rule reads (migrate.ts makes it for the plan and the run). */
export interface TextsInput
{
    gameDir: string;
    /** the mod's files by path */
    modFiles: Map<string, unknown>;
    /** a file of the mod as it loads now: the patch mod's copy of its path, else the mod's (decoded, byte order mark cut) */
    readMod: (rel: string) => string | undefined;
    /** the bytes of a mod's file as the mod has it (the scan for names) */
    modBytes: (rel: string) => Buffer | undefined;
    patchRoot?: string;
    /** the patch mod's folder name (the rule's files carry it) */
    folder: string;
    /** the folders of the other mods of the loaded list */
    others?: string[];
    /** the `replace_path`s of the mod and its patch mod (a game file directly in one does not load) */
    replacePaths: string[];
    /** the path patterns of the localization files the rule looks at */
    patterns: string[];
    /** texts a run is about to write elsewhere in the patch mod (the plan: the libraries rule's files): names in them count */
    extra?: string[];
    globMatch: (pattern: string, rel: string) => boolean;
    /**
     * entries the loaded world has under another name (renameRule.ts aliases: the game's `from` is the world's `to`, a trait the mod keeps
     * under its 1.19 key): a line that comes back names `to` in its quoted arguments, `GetTrait('erudite')` written `GetTrait('scholar')`,
     * and in its tooltip links of the entry's kind (`links`, `#TOOLTIP:GAME_TRAIT,erudite`), as the renamed rule writes its own texts
     * (renamed.ts `twinText`) and the inert step the game's script
     */
    renamed?: { from: string; to: string; links?: string[]; }[];
}

/** A copy of a game localization file with keys to bring back. */
export interface TextsCopy
{
    language: string;
    /** the keys added, in the game's file's order */
    keys: string[];
    /** the keys the copy lacks that no loaded file defines and nothing uses: left out */
    unused: string[];
}

export interface TextsWork
{
    /** per copy (the mod's path) with keys to add */
    copies: Map<string, TextsCopy>;
    /** the copies that lack keys no loaded file defines of which nothing uses one (the mod's own loading tips): those keys, told */
    idle: Map<string, string[]>;
    /** per language: the file to write and its text */
    outputs: Map<string, { rel: string; text: string; }>;
    /** the rule's files the patch mod has that no language needs any more */
    stale: string[];
}

/** The rule's work (see the file's comment). Nothing is read beyond the copies when none lacks a key no loaded file defines. */
export function textsWork(c: TextsInput): TextsWork
{
    const own = (rel: string): boolean => isTextsFile(rel, c.folder);
    const patchFiles = c.patchRoot ? walkRoot(c.patchRoot, (rel, dir) => (dir ? !/^\.|^dlc$/i.test(rel) : true)) : [];
    const patchSet = new Set(patchFiles.map(lc));
    const stale = patchFiles.filter(own);
    const modSet = new Set([...c.modFiles.keys()].map(lc));
    const replaced = c.replacePaths.map((p) => lc(p.replace(/\\/g, '/').replace(/\/+$/, '')));
    // (a game file the mod or the patch mod hides: one of the same path, or one directly in a folder they replace)
    const hidden = (rel: string): boolean => modSet.has(lc(rel)) || patchSet.has(lc(rel)) || replaced.includes(lc(rel.slice(0, rel.lastIndexOf('/'))));
    const empty: TextsWork = { copies: new Map(), idle: new Map(), outputs: new Map(), stale };

    // 1. the copies: the mod's localization files at the path of a game file, and the game's keys they lack
    const copies: { rel: string; language: string; text: string; game: Map<string, string>; lacking: string[]; }[] = [];

    for (const rel of c.modFiles.keys())
    {
        const g = /\.yml$/i.test(rel) && c.patterns.some((p) => c.globMatch(p, rel)) ? gameLocFiles(c.gameDir).get(lc(rel)) : undefined;
        const text = g ? c.readMod(rel) : undefined;

        if (text === undefined)
            continue;

        const game = locLines(decodeTextBody(readFileSync(g!)));
        const have = locKeys(text);
        const lacking = [...game.keys()].filter((k) => !have.has(k));

        if (lacking.length)
            copies.push({ rel, language: languageOf(text, rel), text, game, lacking });
    }

    if (!copies.length)
        return empty;

    // 2. what the loaded localization files of the copies' languages define and name (the game's that load, the mod's as they load,
    // the patch mod's own, the other mods'; the rule's own files left out: a second run must see what the first saw)
    const languages = [...new Set(copies.map((x) => x.language))];
    const defined = new Map<string, Set<string>>(languages.map((l) => [l, new Set()]));
    const refs = new Set<string>();
    const take = (language: string, text: string): void =>
    {
        locKeys(text, defined.get(language));
        locValues(text).forEach((t) => textRefs(t, refs));
    };

    for (const language of languages)
        for (const f of gameLoc(c.gameDir, language))
            if (!hidden(f.rel))
            {
                f.keys.forEach((k) => defined.get(language)!.add(k));
                f.refs.forEach((r) => refs.add(r));
            }

    for (const rel of c.modFiles.keys())
    {
        if (!/^localization\/.*\.yml$/i.test(rel))
            continue;

        const text = c.readMod(rel);
        const language = text === undefined ? undefined : languageOf(text, rel);

        if (language && defined.has(language))
            take(language, text!);
    }

    const readPatch = (rel: string): string => decodeTextBody(readFileSync(join(c.patchRoot!, ...rel.split('/'))));

    for (const rel of patchFiles)
        if (/^localization\/.*\.yml$/i.test(rel) && !own(rel) && !modSet.has(lc(rel)))
        {
            const text = readPatch(rel);
            const language = languageOf(text, rel);

            if (defined.has(language))
                take(language, text);
        }

    for (const root of c.others ?? [])
        for (const rel of walkRoot(join(root, 'localization'), (r, dir) => dir || /\.yml$/i.test(r)))
        {
            const text = decodeTextBody(readFileSync(join(root, 'localization', ...rel.split('/'))));
            const language = languageOf(text, rel);

            if (defined.has(language))
                take(language, text);
        }

    // (the candidates: lacking, and defined by no loaded file of their language)
    const cands = new Map<string, Set<string>>();

    for (const x of copies)
        for (const k of x.lacking)
            if (!defined.get(x.language)!.has(k))
                (cands.get(k) ?? cands.set(k, new Set()).get(k)!).add(x.language);

    if (!cands.size)
        return empty;

    // 3. what uses them: the program's strings, the loaded files outside the localization (as words), the loaded texts, the texts to write
    const names = new Set(cands.keys());
    const used = new Set<string>();
    const engine = engineStrings(c.gameDir)?.names;

    for (const k of names)
        if (engine?.has(k) || refs.has(k))
            used.add(k);

    const scan = wordScanner(names);
    const look = (buf: Buffer | undefined): void =>
    {
        if (buf && used.size < names.size)
            scan(buf, used);
    };

    for (const root of layerRoots(c.gameDir))
        for (const rel of walkRoot(root, (r, dir) => (dir ? !DATA_FOLDERS.test(r) : namingFile(r) && !hidden(r))))
            look(readFileSync(join(root, ...rel.split('/'))));

    for (const rel of c.modFiles.keys())
        if (namingFile(rel) && !patchSet.has(lc(rel)))
            look(c.modBytes(rel));

    for (const rel of patchFiles)
        if (namingFile(rel))
            look(readFileSync(join(c.patchRoot!, ...rel.split('/'))));

    for (const root of c.others ?? [])
        for (const rel of walkRoot(root, (r, dir) => (dir ? !DATA_FOLDERS.test(r) : namingFile(r))))
            look(readFileSync(join(root, ...rel.split('/'))));

    for (const t of c.extra ?? [])
        look(Buffer.from(t, 'latin1'));

    // (what the texts that come back name in turn; a negated custom description, NOT_x, of a key that is used)
    const values = new Map<string, string>();

    for (const x of copies)
        for (const k of x.lacking)
            if (cands.has(k) && !values.has(k))
                values.set(k, x.game.get(k)!);

    for (let queue = [...used]; queue.length;)
    {
        const next: string[] = [];

        for (const k of queue)
        {
            const line = values.get(k);
            const more = [...(line ? textRefs(line.slice(line.indexOf('"'))) : []), `NOT_${k}`];

            for (const r of more)
                if (cands.has(r) && !used.has(r))
                {
                    used.add(r);
                    next.push(r);
                }
        }

        queue = next;
    }

    // 4. per copy the keys that come back (the game's order), per language one file
    const work: TextsWork = { copies: new Map(), idle: new Map(), outputs: new Map(), stale: [] };
    const byLanguage = new Map<string, { rel: string; lines: string[]; }[]>();
    const eols = new Map<string, string>();
    // (the game's line with the names the world has under another written as those)
    const aliased = (line: string): string => (c.renamed ?? []).reduce((t, r) => twinText(t, r.from, r.to, r.links), line);

    for (const x of copies)
    {
        const lost = x.lacking.filter((k) => cands.has(k) && cands.get(k)!.has(x.language));
        const keys = lost.filter((k) => used.has(k));

        if (!keys.length)
        {
            if (lost.length)
                work.idle.set(x.rel, lost);

            continue;
        }

        work.copies.set(x.rel, { language: x.language, keys, unused: lost.filter((k) => !used.has(k)) });
        byLanguage.set(x.language, [...(byLanguage.get(x.language) ?? []), { rel: x.rel, lines: keys.map((k) => ' ' + aliased(x.game.get(k)!)) }]);

        if (!eols.has(x.language))
            eols.set(x.language, x.text.includes('\r\n') ? '\r\n' : '\n');
    }

    for (const [language, groups] of byLanguage)
    {
        const eol = eols.get(language)!;
        const body = groups.map((g) => [`# ${g.rel}: the game's texts of the keys the mod's copy of this file lacks, which loaded files use (CrusaderPope)`, ...g.lines].join(eol));
        work.outputs.set(language, { rel: textsFile(c.folder, language), text: `﻿l_${language}:${eol}${body.join(eol + eol)}${eol}` });
    }

    const written = new Set([...work.outputs.values()].map((o) => lc(o.rel)));
    work.stale = stale.filter((rel) => !written.has(lc(rel)));
    return work;
}

/** The copies' keys the work brings back, and the ones nothing uses, for the plan's and the result's notes (keys in the game's order; the copies none of whose keys come back last). */
export function textsSummary(work: TextsWork): { rel: string; keys: string[]; unused: string[]; }[]
{
    return [...[...work.copies].map(([rel, x]) => ({ rel, keys: x.keys, unused: x.unused })), ...[...work.idle].map(([rel, unused]) => ({ rel, keys: [], unused }))];
}

/** Whether the patch mod's file of a language holds what the work would write (byte order mark and all). */
export function textsDone(patchRoot: string | undefined, out: { rel: string; text: string; }): boolean
{
    const file = patchRoot ? join(patchRoot, ...out.rel.split('/')) : undefined;
    return !!file && existsSync(file) && decodeText(readFileSync(file)) === out.text;
}
