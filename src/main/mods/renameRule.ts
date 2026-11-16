/**
 * The `renamed` rule on the main side (renamed.ts is the pure part; docs/mods.md, "Entries and names the game renamed"): what of the
 * mod's copies of the game's files names an entry or a value by a name the game version changed, and what the patch mod gets for it.
 *
 * - **An entry the game renamed** (renamed.ts `renamedPairs`): when nothing loaded names the old key outside its own definition, the
 *   patch mod's copy gives the entry the new key (`rename`): the game's texts, icons and references of the new key then reach it.
 *   Else the mod's world keeps the old key and gets what the game has under the new one (`alias`): the texts the game's program
 *   builds from the name and the texts the mod's copies name in the old spelling, written for the old name in a localization file of
 *   the patch mod (only keys no loaded file defines, in the game's languages the mod has localization in, English always); the game's
 *   files named after the new key (`gfx/interface/icons/traits/erudite.dds`) copied under the old name where no loaded file has that
 *   path; and for the inert step (inertWorld.ts) the new key as a name of the old one, so the game's content that names it is
 *   pointed at the mod's entry instead of made false.
 * - **A value the game spells otherwise** (renamed.ts `alignedValues`): a value of a copy that no loaded file defines or holds (a
 *   file, a model entity, a definition, a flag, a localization key: `NameAnswer` and the files), where the game's line at the same
 *   place writes a near spelling that exists, takes the game's; a value that differs from exactly one model entity of the loaded
 *   world only in letter case or `-` / `_` (an entity the game renamed so) takes that entity's; a value of the mod's own files in the
 *   folder of such a copy that has the part the copy's value changed (`artefact` of `artefact_icons_…`) takes the part's new
 *   spelling where the result exists.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tr, trn } from '../../shared/i18n.ts';
import { parse } from '../indexer/parser.ts';
import { locValues } from './dataCalls.ts';
import { GameMemo } from './gameFacts.ts';
import { layerRoots } from './gameLayers.ts';
import { isTextsFile } from './hiddenTexts.ts';
import { decodeText, readTextBody, readTextFile } from './textCodec.ts';
import { hasWord, isWordName, wordSet, type WordSet } from './wordRuns.ts';
import {
    alignedValues, applyEdits, derivedKeys, linkTypes, locFile, looseSpelling, nearSpelling, partRename, renamedPairs, renameEntryEdits, respelled, tooltipLinks,
    twinKey, twinText, valueTokens, withPart, type RenamedPair
} from './renamed.ts';

/** What the rule reads: the game, the mod's files, the patch mod and the other mods of the loaded list. */
export interface RenameInput
{
    gameDir: string;
    /** the mod's files (paths below its root) */
    modFiles: string[];
    /** a file of the mod as it wrote it (byte order mark cut) */
    modText(rel: string): string | undefined;
    /** a file as the rules see it now: the patch mod's copy, else the mod's */
    currentText(rel: string): string | undefined;
    patchRoot?: string;
    /** the folders of the other mods of the loaded list */
    others?: string[];
    /** the patch mod's folder name: its localization file is named after it */
    patchFolder: string;
    /** names another rule of the version renames (the statement rules): a pair with one of them is that rule's */
    handled?: Set<string>;
    /**
     * the folders whose entries the libraries rule brings back when a loaded file names them (scripted triggers, effects, values …): the
     * game's entry of the new name comes back there, so a pair kept under its old name needs no alias (the inert step is told none)
     */
    carried?: string[];
    /**
     * the entries the run writes into the patch mod before this rule's files (the merge rules': the game's entries the mod's older
     * copies lack): counted as defined, so that the run takes a value the game spells as one of them, as the plan after it does
     */
    planned?: Set<string>;
    /**
     * a cheap signature of what `modText` and `currentText` read for a file (the paths, sizes and times of the mod's file and the patch
     * mod's copy): while it stays, the rule takes what it found in the file the last time. Undefined: read every time
     */
    stamp?(rel: string): string | undefined;
    /** the job's look at Cancel, before each file (it throws; what a file gave is kept only once it is done) */
    stop?(): void;
}

/** Which of the names the loaded world has (the index worker, migrations.ts `knownNames`): a live definition, or anything else by the name. */
export type NameAnswer = (names: string[]) => Promise<Record<string, 'defined' | 'known'>>;

/** An entry the game renamed, and what is done for it. */
export interface RenamedEntry extends RenamedPair
{
    /** the copy that defines it */
    rel: string;
    mode: 'rename' | 'alias';
    /** alias: the texts written for the old name, and the game's files copied under it */
    texts: string[];
    copies: string[];
    /** alias: the inert step points the game's content that names the new key at the old one */
    aliased?: boolean;
}

/** What a file of the mod gets in its patch mod copy. */
export interface RenameFileWork
{
    /** entries given the new key */
    renames: { from: string; to: string; }[];
    /** values written as the game spells them: old → new */
    values: Map<string, string>;
}

export interface RenameWork
{
    entries: RenamedEntry[];
    files: Map<string, RenameFileWork>;
    /** files the patch mod gets whole: a localization file (`text`, the byte order mark in front), or a file of the game copied (`copy`: its path) */
    outputs: Map<string, { text?: string; copy?: string; }>;
    /**
     * for the inert step: `from` (the new key, which the game's content names) is the loaded world's `to`, an entry of the index type
     * `type`; `links`: the tooltip link types that name entries of its kind (`#TOOLTIP:GAME_TRAIT,…`), for the texts rule's lines
     */
    aliases: { type: string; from: string; to: string; links?: string[]; }[];
    /** the values spelled as the game does: how it was found and where */
    values: { from: string; to: string; how: 'line' | 'case' | 'part'; files: string[]; }[];
}

const lc = (s: string): string => s.toLowerCase();
const dirOf = (rel: string): string => rel.slice(0, rel.lastIndexOf('/'));
const LOC_FILE = /(^|\/)localization\//i;
/** The files whose statements the rule reads: script, interface, model files. */
const SCRIPT_FILE = /\.(txt|gui|asset)$/i;
/** The text files a word is looked for in (the mod's: what it knows, what it names). */
const WORD_FILE = /\.(txt|gui|asset|yml|shader|fxh)$/i;
/** A value that names a file: it has an extension of one. */
const FILE_VALUE = /\.(dds|png|tga|jpg|jpeg|bmp|mesh|asset|anim|txt|gui|shader|fxh|yml|wav|ogg|bk2|ttf|otf|fnt|cur|particle2|xml|json)$/i;
/** A top-level definition at the start of a line (a quick look before a file is parsed). */
const TOP_KEY = /^([^\s#={}"]+)[ \t]*=[ \t]*\{/gm;

const topKeys = (text: string): Set<string> => new Set([...text.matchAll(TOP_KEY)].map((m) => m[1]).filter((k) => !k.startsWith('@')));

/** The files below a folder: relative paths (with `/`) and their files. */
function walk(root: string, sub = ''): { rel: string; abs: string; }[]
{
    const out: { rel: string; abs: string; }[] = [];
    const go = (dir: string, rel: string): void =>
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

            if (e.isDirectory())
                go(join(dir, e.name), r);
            else if (e.isFile())
                out.push({ rel: r, abs: join(dir, e.name) });
        }
    };

    go(sub ? join(root, ...sub.split('/')) : root, sub);
    return out;
}

/** What the game's own files hold, read once per game folder. */
interface GameFacts
{
    /** script, interface and model files by lower-case path: the first layer's (`layerRoots` order) */
    script: Map<string, string>;
    /** the files below `gfx/` by lower-case path, and by lower-case file name and stem */
    gfx: Set<string>;
    gfxNames: Set<string>;
    gfxStems: Map<string, { rel: string; abs: string; }[]>;
    /** the model entities (`entity = { name = … }` of the `.asset` files) */
    entities: Set<string>;
    /** the English localization's texts and keys, and the words of the keys (`_` / `.` parts, lower case) */
    englishTexts?: Map<string, string>;
    english?: Set<string>;
    words?: Set<string>;
    /** per word asked: whether a file of the game names it (`gameMentions`) */
    mentions?: Map<string, boolean>;
}

const factsMemo = new GameMemo<GameFacts>();

function gameFacts(gameDir: string): GameFacts
{
    let f = factsMemo.get(gameDir, '');

    if (f)
        return f;

    f = { script: new Map(), gfx: new Set(), gfxNames: new Set(), gfxStems: new Map(), entities: new Set() };

    for (const root of layerRoots(gameDir))
    {
        for (const x of walk(root))
        {
            const rel = lc(x.rel);

            if (SCRIPT_FILE.test(rel) && !LOC_FILE.test(rel) && !f.script.has(rel))
                f.script.set(rel, x.abs);

            if (rel.startsWith('gfx/'))
            {
                f.gfx.add(rel);
                const name = rel.slice(rel.lastIndexOf('/') + 1);
                f.gfxNames.add(name);
                const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
                f.gfxStems.set(stem, [...(f.gfxStems.get(stem) ?? []), x]);

                if (rel.endsWith('.asset'))
                    entitiesOf(readTextFile(x.abs), f.entities);
            }
        }
    }

    factsMemo.set(gameDir, '', f);
    return f;
}

/** The model entities a `.asset` text defines. */
function entitiesOf(text: string, into: Set<string>): void
{
    if (!/\bentity\b/.test(text))
        return;

    for (const n of parse(text.replace(/^﻿/, '')))
    {
        const name = n.k === 'entity' && Array.isArray(n.v) ? n.v.find((c) => c.k === 'name' && typeof c.v === 'string') : undefined;

        if (name)
            into.add((name.v as string).replace(/^"|"$/g, ''));
    }
}

/** The keys of the game's localization in a language, and their texts (a replace folder's text wins), read when asked. */
function gameLoc(gameDir: string, language: string): Map<string, string>
{
    const out = new Map<string, string>();
    const files: string[] = [];

    for (const root of layerRoots(gameDir))
        for (const x of walk(root, 'localization'))
            if (new RegExp(`_l_${language}\\.yml$`, 'i').test(x.rel))
                files.push(x.abs);

    const replace = (f: string): boolean => /[\\/]replace[\\/]/i.test(f);

    for (const f of [...files.filter((x) => !replace(x)), ...files.filter(replace)])
        for (const [k, t] of locValues(readFileSync(f, 'utf8')))
            out.set(k, t);

    return out;
}

/** The languages a mod has localization in (`localization/<lang>/…`, `localization/replace/<lang>/…`, `…_l_<lang>.yml`), English always. */
function modLanguages(rels: string[]): string[]
{
    const out = new Set(['english']);

    for (const rel of rels.filter((r) => LOC_FILE.test(r)))
    {
        const m = /_l_([a-z_]+)\.yml$/i.exec(rel);

        if (m)
            out.add(lc(m[1]));
    }

    return [...out].sort();
}

/** The files of the loaded world besides the game: the mod's, the other mods', the patch mod's. */
interface Loaded
{
    /** lower-case paths of the files below `gfx/`, their names and their names without the extension, of every root but the game's */
    gfx: Set<string>;
    gfxNames: Set<string>;
    gfxStems: Set<string>;
    entities: Set<string>;
    /** the other mods' and the patch mod's files (the mod's are the input's) */
    files: { root: 'others' | 'patch'; rel: string; abs: string; }[];
}

function loadedFiles(input: RenameInput): Loaded
{
    const out: Loaded = { gfx: new Set(), gfxNames: new Set(), gfxStems: new Set(), entities: new Set(), files: [] };
    const gfx = (rel: string, text: () => string | undefined): void =>
    {
        const r = lc(rel);

        if (!r.startsWith('gfx/'))
            return;

        const name = r.slice(r.lastIndexOf('/') + 1);
        out.gfx.add(r);
        out.gfxNames.add(name);
        out.gfxStems.add(name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name);

        if (r.endsWith('.asset'))
            entitiesOf(text() ?? '', out.entities);
    };

    for (const rel of input.modFiles)
        gfx(rel, () => input.modText(rel));

    for (const [root, which] of [...(input.others ?? []).map((r) => [r, 'others'] as const), ...(input.patchRoot ? [[input.patchRoot, 'patch'] as const] : [])])
    {
        for (const x of walk(root))
        {
            out.files.push({ root: which, rel: x.rel, abs: x.abs });
            gfx(x.rel, () => readTextFile(x.abs));
        }
    }

    return out;
}

/** A file's size and time: what it was read as, cheaply. */
function stampOf(abs: string): string
{
    try
    {
        const s = statSync(abs);
        return `${abs}:${s.size}:${s.mtimeMs}`;
    }
    catch
    {
        return `${abs}:-`;
    }
}

/** What a copy of a game file gave: whether its keys and the game's differ both ways, the values the game's line writes otherwise, the values of the lines the game's lacks. */
interface CopyFound
{
    pair: boolean;
    aligned: { from: string; to: string; }[];
    values: string[];
}

/** The copies' findings by game folder and path, with the stamps they were made from (`RenameInput.stamp` and the game file's). */
const copyMemo = new Map<string, CopyFound & { key: string; }>();

/** A copy compared with the game's file of its path (the mod's text for the keys, the current text for the values). */
function copyWork(own: string | undefined, current: string | undefined, theirs: string, script: boolean): CopyFound
{
    if (own === undefined || current === undefined)
        return { pair: false, aligned: [], values: [] };

    const ck = script ? topKeys(own) : new Set<string>();
    const gk = script ? topKeys(theirs) : new Set<string>();
    const values = new Set<string>();
    const changed = (line: string): void =>
    {
        for (const x of valueTokens(line))
            if (/^[A-Za-z0-9_\-.]+$/.test(x.v))
                values.add(x.v);
    };
    const aligned = alignedValues(current, theirs, changed).map((v) => ({ from: v.from, to: v.to }));
    return { pair: script && [...ck].some((k) => !gk.has(k)) && [...gk].some((k) => !ck.has(k)), aligned, values: [...values] };
}

/** The plan's work (see the top of the file). `answer`: the index's word on names. */
export async function renameWork(input: RenameInput, answer: NameAnswer): Promise<RenameWork>
{
    const game = gameFacts(input.gameDir);
    const work: RenameWork = { entries: [], files: new Map(), outputs: new Map(), aliases: [], values: [] };
    const fileOf = (rel: string): RenameFileWork =>
    {
        let f = work.files.get(rel);

        if (!f)
            work.files.set(rel, (f = { renames: [], values: new Map() }));

        return f;
    };
    const copies = input.modFiles.filter((rel) => SCRIPT_FILE.test(rel) && !LOC_FILE.test(rel) && game.script.has(lc(rel)));
    const loaded = loadedFiles(input);
    // (the model entities by their spelling with letter case and `-` / `_` aside)
    const entityLoose = new Map<string, string[]>();

    for (const e of [...game.entities, ...loaded.entities])
        if (!entityLoose.get(looseSpelling(e))?.includes(e))
            entityLoose.set(looseSpelling(e), [...(entityLoose.get(looseSpelling(e)) ?? []), e]);

    const isEntity = (v: string): boolean => game.entities.has(v) || loaded.entities.has(v);

    // 1. per copy: the entries that may be renamed (a quick look at the keys first), the values the game's line writes otherwise, the
    // values of the lines the game's file lacks that are a model entity in another letter case
    const pairFiles = new Map<string, { own: string; theirs: string; }>();
    const aligned: { rel: string; from: string; to: string; }[] = [];
    const caseFound: { rel: string; from: string; to: string; }[] = [];
    const gameTextOf = (rel: string): string => readTextBody(game.script.get(lc(rel))!);

    for (const rel of copies)
    {
        input.stop?.();
        // (what a file gave the last time, while it and the game's file are as they were)
        const stamp = input.stamp?.(rel);
        const key = stamp && `${stamp}|${stampOf(game.script.get(lc(rel))!)}`;
        let found: CopyFound | undefined = key ? copyMemo.get(`${input.gameDir}|${rel}`) : undefined;

        if (!found || (found as CopyFound & { key: string; }).key !== key)
        {
            found = copyWork(input.modText(rel), input.currentText(rel), gameTextOf(rel), /\.txt$/i.test(rel));

            if (key)
                copyMemo.set(`${input.gameDir}|${rel}`, { ...found, key });
        }

        if (found.pair)
            pairFiles.set(rel, { own: input.modText(rel)!, theirs: gameTextOf(rel) });

        for (const v of found.aligned)
            aligned.push({ rel, ...v });

        // (the values of the lines the game's file lacks that are a model entity in another letter case)
        for (const v of found.values)
        {
            const like = isEntity(v) ? undefined : entityLoose.get(looseSpelling(v));

            if (like?.length === 1)
                caseFound.push({ rel, from: v, to: like[0] });
        }
    }

    // 2. the entries, paired without the mod's words first
    const folderKeys = new Map<string, Set<string>>();
    const keysBelow = (dir: string, texts: () => Iterable<string>): Set<string> =>
    {
        let s = folderKeys.get(dir);

        if (!s)
        {
            s = new Set();

            for (const t of texts())
                topKeys(t).forEach((k) => s!.add(k));

            folderKeys.set(dir, s);
        }

        return s;
    };
    const gameKeysIn = (dir: string): Set<string> => keysBelow(`game|${dir}`, function* ()
    {
        for (const [rel, abs] of game.script)
            if (rel.startsWith(lc(dir) + '/') && rel.endsWith('.txt'))
                yield readTextFile(abs);
    });
    const modKeysIn = (dir: string): Set<string> => keysBelow(`mod|${dir}`, function* ()
    {
        for (const rel of input.modFiles)
            if (lc(rel).startsWith(lc(dir) + '/') && /\.txt$/i.test(rel))
                yield input.modText(rel) ?? '';

        for (const f of loaded.files)
            if (f.root === 'others' && lc(f.rel).startsWith(lc(dir) + '/') && /\.txt$/i.test(f.rel))
                yield readTextFile(f.abs);
    });
    const raw: (RenamedPair & { rel: string; })[] = [];

    for (const [rel, t] of pairFiles)
    {
        const dir = dirOf(rel);

        for (const p of renamedPairs(t.own, t.theirs, { gameDefines: (k) => gameKeysIn(dir).has(k), modDefines: (k) => modKeysIn(dir).has(k), modNames: () => false }))
            raw.push({ ...p, rel });
    }

    pairFiles.clear();
    const texts = new Map<string, Map<string, string>>([['english', englishTexts(game, input.gameDir)]]);
    const textsOf = (lang: string): Map<string, string> =>
    {
        let t = texts.get(lang);

        if (!t)
            texts.set(lang, (t = gameLoc(input.gameDir, lang)));

        return t;
    };
    const english = (): Set<string> => (game.english ??= new Set(textsOf('english').keys()));
    // (a word the old key has and the new lacks is a word of the game's, a part of its localization keys or of its keys in the folder: a
    // mod that renamed one of the game's entries for a setting of its own put a word of the setting in, which the game never had)
    const gameWorded = (p: RenamedPair & { rel: string; }): boolean =>
    {
        const to = new Set(lc(p.to).split('_'));
        const extra = lc(p.from).split('_').filter((w) => !to.has(w));

        if (!extra.length)
            return true;

        game.words ??= new Set([...english()].flatMap((k) => lc(k).split(/[._]/)));
        const folder = new Set([...gameKeysIn(dirOf(p.rel))].flatMap((k) => lc(k).split('_')));
        return extra.every((w) => game.words!.has(w) || folder.has(w));
    };
    const candidates = raw.filter((p) => !input.handled?.has(p.from) && !input.handled?.has(p.to) && gameWorded(p));
    const lineFound = aligned.filter((a) => nearSpelling(a.from, a.to));
    // (a value that is no file is looked for in the loaded files besides the copies that hold it: a gui template, a named colour …)
    const holders = new Set([...lineFound, ...caseFound].map((a) => lc(a.rel)));
    const bare = [...new Set([...lineFound, ...caseFound].map((a) => a.from).filter((v) => !FILE_VALUE.test(v)))];
    const words = wordsOf(input, loaded, candidates, bare, holders);
    input.stop?.();
    const pairs = candidates.filter((p) => !words.knows.has(p.to));

    // 3. what is done per entry
    const langs = pairs.length ? modLanguages(input.modFiles) : [];
    const ownLoc = (lang: string): string => `localization/${lang}/${input.patchFolder}_renamed_l_${lang}.yml`;
    const definedLoc = loadedLocKeys(input, loaded, langs, ownLoc, textsOf);
    const twins = new Map<string, Map<string, string>>();
    const taken = new Set([...input.modFiles, ...loaded.files.filter((f) => f.root === 'others').map((f) => f.rel)].map(lc));
    const pathTaken = (rel: string): boolean => game.gfx.has(lc(rel)) || taken.has(lc(rel));
    // (a key the run gives the new name has no texts of its old name to write: `action_<lesson>` of a lesson kept, for an action renamed)
    const renamedAway = pairs.filter((p) => !words.outside.has(p.from)).map((p) => p.from);
    const goneName = (key: string): boolean => renamedAway.some((r) => twinKey(key, r, r) !== undefined);
    // (the tooltip links of the game's texts in the languages written, read once: which link types name the entries of a folder)
    let links: Map<string, Set<string>> | undefined;
    const tooltips = (): Map<string, Set<string>> => (links ??= tooltipLinks((function* ()
    {
        for (const lang of langs)
            yield* textsOf(lang).values();
    })()));

    for (const p of pairs)
    {
        input.stop?.();
        const entry: RenamedEntry = { ...p, mode: words.outside.has(p.from) ? 'alias' : 'rename', texts: [], copies: [] };

        if (entry.mode === 'rename')
        {
            work.entries.push(entry);
            fileOf(p.rel).renames.push({ from: p.from, to: p.to });
            continue;
        }

        // (the texts: the keys the game's program builds from the name, and the keys the mod's copies name in the old spelling where the game's line names the new)
        const keys = new Set(derivedKeys(p.to, gameKeysIn(dirOf(p.rel)), (k) => english().has(k), english()));

        for (const a of aligned)
            if (twinKey(a.to, p.to, p.from) === a.from && english().has(a.to))
                keys.add(a.to);

        // (the game's content that names the new key: the inert step points it at the old one; not in a folder the libraries rule
        // carries, where the game's entry of the new name comes back)
        const alias = /^common\//i.test(p.rel) && !input.carried?.some((f) => lc(dirOf(p.rel)).startsWith(lc(f)));
        // (a tooltip link of the entry's kind in those texts names the new key: written as the old, as the data function arguments; the
        // texts rule's lines are given the link types with the alias)
        const kinds = keys.size || alias ? linkTypes(tooltips(), gameKeysIn(dirOf(p.rel)), p.to) : [];

        for (const lang of langs)
        {
            const lines = twins.get(lang) ?? new Map<string, string>();

            for (const key of keys)
            {
                const twin = twinKey(key, p.to, p.from)!;
                const text = textsOf(lang).get(key);

                if (text === undefined || definedLoc(lang, twin) || lines.has(twin) || goneName(twin))
                    continue;

                lines.set(twin, twinText(text, p.to, p.from, kinds));

                if (lang === 'english')
                    entry.texts.push(twin);
            }

            twins.set(lang, lines);
        }

        // (the game's files named after the new key, under the old name: the trait's icon)
        for (const f of game.gfxStems.get(lc(p.to)) ?? [])
        {
            const name = f.rel.slice(f.rel.lastIndexOf('/') + 1);
            const target = f.rel.slice(0, f.rel.length - name.length) + p.from + name.slice(p.to.length);

            if (!pathTaken(target) && !work.outputs.has(target))
            {
                work.outputs.set(target, { copy: f.abs });
                entry.copies.push(target);
            }
        }

        if (alias)
        {
            work.aliases.push({ type: dirOf(p.rel).slice('common/'.length), from: p.to, to: p.from, ...(kinds.length ? { links: kinds } : {}) });
            entry.aliased = true;
        }

        // (an entry kept under its old name with nothing to bring is not told)
        if (alias || entry.texts.length || entry.copies.length)
            work.entries.push(entry);
    }

    for (const [lang, lines] of twins)
        if (lines.size)
            work.outputs.set(ownLoc(lang), { text: locFile(lang, [...lines].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) });

    // 4. the values: the copies' lines that the game writes otherwise, the model entities in another letter case
    input.stop?.();
    const said = await answer([...new Set([...lineFound, ...caseFound].flatMap((a) => [a.from, a.to]))]);
    input.stop?.();
    const mentions = new Set([...words.mentions, ...gameMentions(game, bare.filter((v) => !said[v] && !words.mentions.has(v)))]);
    const fileExists = (v: string): boolean =>
    {
        const r = lc(v.replace(/\\/g, '/').replace(/^\/+/, ''));
        return r.includes('/') ? game.gfx.has(r) || loaded.gfx.has(r) || game.script.has(r) || taken.has(r) : game.gfxNames.has(r) || loaded.gfxNames.has(r);
    };
    // (a bare name can be a picture's: `icon = travel_positive` is gfx/interface/icons/modifiers/travel_positive.dds; an entry the run
    // writes before this rule's files, a game concept the merge rule brings, is defined once the run is done)
    const defined = (v: string): boolean => said[v] === 'defined' || !!input.planned?.has(v);
    const exists = (v: string): boolean => (FILE_VALUE.test(v) ? fileExists(v) : isEntity(v) || defined(v) || game.gfxStems.has(lc(v)) || loaded.gfxStems.has(lc(v)));
    const known = (v: string): boolean => exists(v) || !!said[v] || mentions.has(v);
    const decided = new Map<string, { to: string; how: 'line' | 'case' | 'part'; }>();
    const parts: { dir: string; from: string; to: string; }[] = [];

    for (const a of lineFound)
    {
        if (decided.has(a.from) || known(a.from) || !exists(a.to))
            continue;

        decided.set(a.from, { to: a.to, how: 'line' });
        const part = partRename(a.from, a.to);

        if (part && !parts.some((x) => x.dir === dirOf(a.rel) && x.from === part.from && x.to === part.to))
            parts.push({ dir: dirOf(a.rel), ...part });
    }

    for (const a of caseFound)
        if (!decided.has(a.from) && !known(a.from))
            decided.set(a.from, { to: a.to, how: 'case' });

    // (the part a copy's value changed, in the values of the mod's files of that folder: where the old value exists nowhere and the result
    // does; a file that holds a value decided already is one of them too: the line rule changes it in the copies only)
    const partFound: { rel: string; from: string; to: string; }[] = [];
    const partFiles = new Set<string>();

    for (const rel of parts.length ? input.modFiles.filter((r) => SCRIPT_FILE.test(r) && parts.some((p) => lc(p.dir) === lc(dirOf(r)))) : [])
        for (const x of valueTokens(input.currentText(rel) ?? ''))
            for (const p of parts.filter((y) => lc(y.dir) === lc(dirOf(rel))))
            {
                const to = withPart(x.v, p);

                if (!to || !FILE_VALUE.test(x.v))
                    continue;

                if (decided.has(x.v))
                    partFiles.add(rel);
                else
                    partFound.push({ rel, from: x.v, to });
            }

    Object.assign(said, partFound.length ? await answer([...new Set(partFound.flatMap((a) => [a.from, a.to]))]) : {});

    for (const a of partFound)
        if (!decided.has(a.from) && !known(a.from) && exists(a.to))
            decided.set(a.from, { to: a.to, how: 'part' });

    // (each value decided, in every copy and every file of a folder a part was found in, where it stands after a `=`)
    const where = new Map<string, Set<string>>();

    for (const rel of decided.size ? new Set([...copies, ...partFiles, ...partFound.map((a) => a.rel)]) : [])
    {
        const text = input.currentText(rel) ?? '';

        if (![...decided.keys()].some((v) => text.includes(v)))
            continue;

        for (const x of valueTokens(text))
        {
            const d = decided.get(x.v);

            if (!d)
                continue;

            fileOf(rel).values.set(x.v, d.to);
            where.set(x.v, (where.get(x.v) ?? new Set()).add(rel));
        }
    }

    for (const [from, d] of decided)
        if (where.has(from))
            work.values.push({ from, to: d.to, how: d.how, files: [...where.get(from)!].sort() });

    return work;
}

/** The game's English localization texts, read once per game folder (the rule reads them for every plan with an entry to look at). */
function englishTexts(game: GameFacts, gameDir: string): Map<string, string>
{
    return (game.englishTexts ??= gameLoc(gameDir, 'english'));
}

/** Whole words of a list in raw bytes (`names`: the words as Latin-1 bytes), comments too. */
function namesInBytes(data: Buffer, names: { w: string; b: Buffer; }[], into: Set<string>): void
{
    const id = (c: number | undefined): boolean => c !== undefined && ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122));

    for (const x of names)
        for (let i = into.has(x.w) ? -1 : data.indexOf(x.b); i >= 0; i = data.indexOf(x.b, i + 1))
            if (!id(data[i - 1]) && !id(data[i + x.b.length]))
            {
                into.add(x.w);
                break;
            }
}

/** Which of the words the game's own script, interface and model files name (whole words, comments too): read once per word and game folder. */
function gameMentions(game: GameFacts, words: string[]): Set<string>
{
    const memo = (game.mentions ??= new Map());
    const ask = words.filter((w) => !memo.has(w));

    if (ask.length)
    {
        const found = new Set<string>();
        const names = ask.map((w) => ({ w, b: Buffer.from(w, 'latin1') }));

        for (const abs of game.script.values())
        {
            if (found.size === ask.length)
                break;

            try
            {
                namesInBytes(readFileSync(abs), names, found);
            }
            catch
            {
                // (a file that went away meanwhile)
            }
        }

        ask.forEach((w) => memo.set(w, found.has(w)));
    }

    return new Set(words.filter((w) => memo.get(w)));
}

/** Up to this many words a search per word is faster than a pass of whole words (wordRuns.ts; round 12's bench). */
const FEW_WORDS = 24;

/**
 * What the loaded files besides the game's say of words, read in one pass:
 * - `knows`: the new keys of the pairs that a file of the mod names (its script, interface and model files; not its localization: a key
 *   with the word as a part may be any text, `nick_the_erudite`): renamed.ts `PairWorld.modNames`;
 * - `outside`: the old keys a loaded file names outside the key's own definition (the mod's other files, the copy outside the entry, the
 *   other mods' and the patch mod's files but the patch mod's copy of the file and this rule's localization file, their localization
 *   keys): those keep their name (`alias`);
 * - `mentions`: the values (`bare`) that a script, interface or model file names besides the copies that hold them (`holders`).
 */
function wordsOf(input: RenameInput, loaded: Loaded, pairs: (RenamedPair & { rel: string; })[], bare: string[], holders: Set<string>): { knows: Set<string>; outside: Set<string>; mentions: Set<string>; }
{
    const out = { knows: new Set<string>(), outside: new Set<string>(), mentions: new Set<string>() };

    if (!pairs.length && !bare.length)
        return out;

    const esc = (w: string): string => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // (one pattern for all the words of a list; a localization file is read by its keys, the word as a part of one)
    const pattern = (list: string[]): { list: string[]; re?: RegExp; part?: RegExp; lower: Map<string, string>; words: WordSet; others: string[]; } =>
    {
        const alt = [...list].sort((a, b) => b.length - a.length).map(esc).join('|');
        const words = wordSet(list.filter(isWordName));
        const others = list.filter((w) => !isWordName(w));
        return list.length
            ? { list, re: new RegExp(`(?<![A-Za-z0-9_])(${alt})(?![A-Za-z0-9_])`, 'g'), part: new RegExp(`(?:^|[._])(${alt})(?=[._]|$)`, 'gim'), lower: new Map(list.map((w) => [lc(w), w])), words, others }
            : { list, lower: new Map(), words, others };
    };
    const news = pattern([...new Set(pairs.map((p) => p.to))]);
    const olds = pattern([...new Set(pairs.map((p) => p.from))]);
    const values = pattern(bare);
    // (the expression finds only words the text has, so it runs when one not found yet is there: a search per word for a few; for
    // more, a word of word characters as a whole word (wordRuns.ts, one pass; the expression would not take it otherwise), another
    // anywhere in the text)
    const inText = (text: string, p: typeof news, into: Set<string>): void =>
    {
        const there = p.list.length <= FEW_WORDS
            ? p.list.some((w) => !into.has(w) && text.includes(w))
            : (p.words.size > 0 && hasWord(text, p.words, into)) || p.others.some((w) => !into.has(w) && text.includes(w));

        if (p.re && there)
            for (const m of text.matchAll(p.re))
                into.add(m[1]);
    };
    const inKeys = (text: string, p: typeof news, into: Set<string>): void =>
    {
        if (!p.part)
            return;

        const keys = [...text.matchAll(/^[ \t]*([^\s:#"]+):/gm)].map((m) => m[1]).join('\n');

        for (const m of keys.matchAll(p.part))
            into.add(p.lower.get(lc(m[1])) ?? m[1]);
    };
    const copies = new Map(pairs.map((p) => [lc(p.rel), p.rel]));
    const isLoc = (rel: string): boolean => LOC_FILE.test(rel) && /\.yml$/i.test(rel);
    const words = [news.list.join(' '), olds.list.join(' '), values.list.join(' ')].join('|');
    // (a file's words, made by `look`, or taken from the last plan while the file and the words asked are as they were)
    const scan = (id: string, stamp: string | undefined, extra: string, look: (into: WordsFound) => void): void =>
    {
        const key = stamp && `${stamp}|${words}|${extra}`;
        let found = key ? wordMemo.get(id) : undefined;

        if (!found || found.key !== key)
        {
            found = { key: key || '', knows: new Set(), outside: new Set(), mentions: new Set() };
            look(found);

            if (key)
                wordMemo.set(id, found);
        }

        found.knows.forEach((w) => out.knows.add(w));
        found.outside.forEach((w) => out.outside.add(w));
        found.mentions.forEach((w) => out.mentions.add(w));
    };

    for (const rel of input.modFiles.filter((r) => WORD_FILE.test(r)))
    {
        input.stop?.();
        const copy = copies.get(lc(rel));
        const own = copy ? pairs.filter((p) => p.rel === copy).map((p) => p.from) : [];
        const holder = holders.has(lc(rel));

        scan(`mod|${rel}`, input.stamp?.(rel), `${own.join(' ')}|${holder}`, (into) =>
        {
            const text = input.modText(rel);

            if (text === undefined)
                return;

            // (a localization key with the word as a part is no sign the mod knows the new key: a nickname "the Erudite" is not the trait)
            if (isLoc(rel))
            {
                inKeys(text, olds, into.outside);
                return;
            }

            inText(text, news, into.knows);

            if (SCRIPT_FILE.test(rel) && !holder)
                inText(text, values, into.mentions);

            // (the copy itself: each old key outside its own definitions, the other old keys anywhere in it)
            inText(text, own.length ? pattern(olds.list.filter((w) => !own.includes(w))) : olds, into.outside);

            if (own.length)
            {
                const top = parse(text);

                for (const w of own)
                    inText(top.filter((n) => n.k !== w).map((n) => text.slice(n.s, n.e)).join('\n'), pattern([w]), into.outside);
            }
        });
    }

    for (const f of loaded.files.filter((x) => WORD_FILE.test(x.rel)))
    {
        input.stop?.();
        // (the patch mod's copy of a file with an old key, and this rule's own localization file, name the old keys for the rule; the
        // texts rule's file holds the game's own lines, whose keys of a renamed entry have the old key as a part when the new one is the
        // old with a word more (`action_<old>_rites_desc`): read, a second run would keep the key the first one renamed)
        if (f.root === 'patch' && (copies.has(lc(f.rel)) || /_renamed_l_[a-z_]+\.yml$/i.test(f.rel) || isTextsFile(f.rel, input.patchFolder)))
            continue;

        const holder = holders.has(lc(f.rel));

        scan(`file|${f.abs}`, stampOf(f.abs), `${holder}`, (into) =>
        {
            const text = readTextFile(f.abs);

            if (isLoc(f.rel))
                inKeys(text, olds, into.outside);
            else
            {
                inText(text, olds, into.outside);

                if (SCRIPT_FILE.test(f.rel) && !holder)
                    inText(text, values, into.mentions);
            }
        });
    }

    return out;
}

/** The words a file gave `wordsOf`, and what they were asked with. */
interface WordsFound
{
    key: string;
    knows: Set<string>;
    outside: Set<string>;
    mentions: Set<string>;
}

/** `wordsOf`'s findings per file (`mod|<path>`, `file|<path>`) with the stamp and the words they were made from. */
const wordMemo = new Map<string, WordsFound>();

/** Whether a loaded file defines a localization key in a language: the game's, the mod's, the other mods' and the patch mod's (its own file of this rule aside). */
function loadedLocKeys(input: RenameInput, loaded: Loaded, langs: string[], own: (lang: string) => string, gameTexts: (lang: string) => Map<string, string>): (lang: string, key: string) => boolean
{
    const memo = new Map<string, Set<string>>();
    const ofLang = (lang: string): Set<string> =>
    {
        let s = memo.get(lang);

        if (s)
            return s;

        s = new Set(gameTexts(lang).keys());
        const mine = new RegExp(`_l_${lang}\\.yml$`, 'i');

        for (const rel of input.modFiles.filter((r) => LOC_FILE.test(r) && mine.test(r)))
            locValues(input.modText(rel) ?? '').forEach((_, k) => s!.add(k));

        for (const f of loaded.files.filter((x) => LOC_FILE.test(x.rel) && mine.test(x.rel) && lc(x.rel) !== lc(own(lang))))
            locValues(decodeText(readFileSync(f.abs))).forEach((_, k) => s!.add(k));

        memo.set(lang, s);
        return s;
    };

    return (lang, key) => langs.includes(lang) && ofLang(lang).has(key);
}

/** A file's text with the rule's work done: entries given their new keys, values spelled as the game does. */
export function renamedFileText(text: string, f: RenameFileWork): string
{
    let out = text;

    for (const r of f.renames)
        out = applyEdits(out, renameEntryEdits(out, r.from, r.to));

    return respelled(out, f.values);
}

/** What the plan and the result tell of the rule's work. */
export function renameNotes(w: RenameWork): string[]
{
    const notes: string[] = [];
    const list = (xs: string[], n = 6): string => (xs.length > n ? xs.slice(0, n).join(', ') + ', …' : xs.join(', '));

    for (const e of w.entries)
    {
        const why = e.how === 'body' ? tr('the same definition under another key') : tr('the old key with a word more or less, the definitions alike');

        if (e.mode === 'rename')
            notes.push(tr('{rel}: the game renamed {from} to {to} ({why}); nothing else names {from}, so the patch mod’s copy calls it {to}', { rel: e.rel, from: e.from, to: e.to, why }));
        else
            notes.push(tr('{rel}: the game renamed {from} to {to} ({why}); the mod’s files name {from}, so it keeps its key and gets what the game has under {to}: {texts}; files {files}; {content}', {
                rel: e.rel, from: e.from, to: e.to, why,
                texts: e.texts.length ? trn('{n} text ({list})', '{n} texts ({list})', e.texts.length, { list: list(e.texts) }) : tr('no text missing'),
                files: e.copies.length ? list(e.copies) : tr('none missing'),
                content: e.aliased ? tr('the game’s own content that names {to} is pointed at {from} where it would be made false', { to: e.to, from: e.from }) : tr('the game’s entry {to} comes back with the libraries rule', { to: e.to })
            }));
    }

    for (const v of w.values)
    {
        const how = v.how === 'line' ? tr('the game’s line at the same place') : v.how === 'case' ? tr('the one model entity of that name in another letter case') : tr('the part the game renamed in the folder’s other values');
        notes.push(trn('{from} → {to} (exists nowhere; {how}): {n} file, {list}', '{from} → {to} (exists nowhere; {how}): {n} files, {list}', v.files.length, { from: v.from, to: v.to, how, list: list(v.files, 3) }));
    }

    return notes;
}
