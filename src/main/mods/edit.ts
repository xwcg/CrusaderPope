/**
 * Editing the active mod (docs/mods.md, "Editing the active mod"): overriding an entry by
 * - copying its winning definition into the mod's overrides file of that folder, `zz_<mod folder>_overrides.txt` — it
 *   loads after the game's files there, and for database types the later definition of a key wins; localization
 *   keys go to the mod's `localization/<lang>/replace/<mod folder>_l_<lang>.yml`, which wins over all loc files;
 * - copying the whole file holding it to the same path in the mod — a same-path file replaces the game's (and
 *   earlier mods') file.
 *
 * The index worker prepares the text (GameIndex.overrideSource: byte-exact, with the namespace, constants and
 * file-local definitions it needs); here the file is chosen and written. Plain Node (scripts use it too).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { ModInfo, OverrideOption, OverridePlan, OverrideRequest, OverrideResult } from '../../shared/api.ts';
import { eolOf, fileLocals, TITLE_KEY, type OverrideSource, type OverrideText } from '../indexer/override.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { parseLocalization } from '../indexer/localization.ts';
import { T_CHARACTER, T_EVENT } from '../indexer/schema.ts';
import { modsOfList, modsState, writeAtomic, type ModsHost } from './manager.ts';
import { formatScript, isScriptFile, mapPosition } from '../../shared/scriptFormat.ts';
import { change, describeChange, recordWrite } from './undo.ts';

export interface Active
{
    mod: ModInfo;
    root: string;
    /** in the loaded mod list: the index shows its changes after a re-index */
    loaded: boolean;
    /** the loaded list's mods after it (load order): a replace_path of theirs hides its files there */
    after: ModInfo[];
}

/** A prepared write: the whole new content of one file. */
interface Write
{
    abs: string;
    rel: string;
    content: string;
    line: number;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The mod being edited, or why there is none to edit. */
export async function activeMod(host: ModsHost): Promise<Active | string>
{
    const state = await modsState(host);
    const id = state.activeMod;

    if (!id)
        return 'No active mod. Set one on the Mods page (Mods tab): “New mod…”, or a mod’s ⋯ menu → “Set as active mod”.';

    const mod = state.mods.find((m) => m.id.toLowerCase() === id.toLowerCase());

    if (!mod)
        return `The active mod (${id}) was not found — choose another one on the Mods page (Mods tab).`;

    if (!mod.editable || !mod.root)
        return `“${mod.name}” cannot be edited here: only unpacked mods in your mod folder can. Choose another active mod on the Mods page.`;

    // (an operation running: its undo step is this mod's)
    describeChange({ mod, root: mod.root });
    const list = modsOfList(state, state.selected);
    const at = list.findIndex((m) => m.id === mod.id);
    return { mod, root: mod.root, loaded: at >= 0, after: at >= 0 ? list.slice(at + 1) : [] };
}

/**
 * The mods loading after the active one whose replace_path is this folder (game-relative): the game ignores the active
 * mod's files directly in it (docs/mods.md, "Load order and layering") — a file written there would not load.
 */
export function hiddenBy(a: Active, relDir: string): ModInfo[]
{
    const dir = relDir.replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '')
        .toLowerCase();
    return a.after.filter((m) =>
        m.status === 'ok' && m.replacePaths.some((p) =>
            p.replace(/\\/g, '/')
                .replace(/^\/+|\/+$/g, '')
                .toLowerCase() === dir
        )
    );
}

/** Why a file of the active mod in this folder would not load (a later mod's replace_path), or undefined. */
export function hiddenProblem(a: Active, relDir: string): string | undefined
{
    const by = hiddenBy(a, relDir);

    if (!by.length)
        return undefined;

    const names = by.map((m) => m.name).join(' and ');
    return `${names} ${by.length === 1 ? 'loads' : 'load'} after ${a.mod.name} and ${by.length === 1 ? 'replaces' : 'replace'} ${relDir} (replace_path): the game ignores ${a.mod.name}’s files there — move ${a.mod.name} below ${by.length === 1 ? 'it' : 'them'} in the load order (Mods page).`;
}

/** The mod's file for a game-relative path; undefined when it would lie outside its folder (a zip entry named `../x`). */
export function modPath(a: Active, rel: string): string | undefined
{
    const abs = join(a.root, ...rel.split('/'));
    const r = relative(a.root, abs);
    return r && !r.startsWith('..') && !isAbsolute(r) ? abs : undefined;
}

const outside = (rel: string): OverrideOption => ({ disabled: `${rel} is not a path inside the mod folder.`, notes: [] });

/** The mod's folder name as part of a file name: `my_mod` (other characters than letters, digits, _ and - become _). */
export function fileTag(a: Active): string
{
    return (
        basename(a.root)
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'mod'
    );
}

/** Load order within a folder: file names compared lowercase, like GameFiles.list. */
const sortsAfter = (a: string, b: string): boolean => a.toLowerCase() > b.toLowerCase();

/** `zz_<mod>_overrides.txt` (then `…_2.txt` …), with more z in front while it would not load after `after`. */
function overridesName(tag: string, k: number, after: string): string
{
    let name = `zz_${tag}_overrides${k > 1 ? '_' + k : ''}.txt`;

    while (!sortsAfter(name, after))
        name = 'z' + name;

    return name;
}

/** A text file of the mod: its text, null when missing, false when not UTF-8 (rewriting it would damage it). */
function readUtf8(file: string): string | null | false
{
    if (!existsSync(file))
        return null;

    const raw = readFileSync(file);
    const text = raw.toString('utf8');
    return Buffer.from(text, 'utf8').equals(raw) ? text : false;
}

function lineAt(text: string, off: number): number
{
    let n = 1;

    for (let i = 0; i < off && i < text.length; i++)
        if (text.charCodeAt(i) === 10)
            n++;

    return n;
}

/** Top-level keys of a script file with the line of their last definition (@constants and namespaces aside). */
function topKeys(ast: PNode[]): Map<string, number>
{
    const out = new Map<string, number>();

    for (const n of ast)
        if (n.k && n.k.charCodeAt(0) !== 64 && n.k !== 'namespace')
            out.set(n.k, n.line);

    return out;
}

/**
 * The line of a landed title's last definition with values of its own, at any depth (not the empty blocks written as
 * the way to a title inside them — override.ts titleText).
 */
function titleLine(ast: PNode[], key: string): number | undefined
{
    let line: number | undefined;
    const walk = (list: PNode[]): void =>
    {
        for (const n of list)
        {
            if (!n.k || !TITLE_KEY.test(n.k) || !Array.isArray(n.v))
                continue;

            if (n.k === key && !n.v.every((c) => c.k !== null && TITLE_KEY.test(c.k) && Array.isArray(c.v)))
                line = n.line;

            walk(n.v);
        }
    };
    walk(ast);
    return line;
}

/**
 * The mod's own definition of a key among the script files of a folder (the last one in load order); `title`: a landed
 * title, at any depth.
 */
function findInFolder(dir: string, relDir: string, key: string, title = false): OverrideOption['open']
{
    let names: string[];

    try
    {
        names = readdirSync(dir)
            .filter((n) => /\.txt$/i.test(n) && statSync(join(dir, n)).isFile())
            .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    }
    catch
    {
        return undefined;
    }

    let found: OverrideOption['open'];

    for (const n of names)
    {
        const ast = parse(readFileSync(join(dir, n), 'utf8'));
        const line = title ? titleLine(ast, key) : topKeys(ast).get(key);

        if (line !== undefined)
            found = { file: join(dir, n), rel: relDir + '/' + n, line };
    }

    return found;
}

/** The mod's own entry of a localization key in its files of a language (the last one: replace/ files last). */
function findLocInMod(dir: string, relDir: string, key: string): OverrideOption['open']
{
    const files: { abs: string; rel: string; }[] = [];
    const walk = (d: string, rel: string): void =>
    {
        let list;

        try
        {
            list = readdirSync(d, { withFileTypes: true });
        }
        catch
        {
            return;
        }

        for (const e of list)
        {
            if (e.isDirectory())
                walk(join(d, e.name), rel + '/' + e.name);
            else if (e.isFile() && /\.yml$/i.test(e.name))
                files.push({ abs: join(d, e.name), rel: rel + '/' + e.name });
        }
    };
    walk(dir, relDir);
    const replace = (r: string): number => (/\/replace\//i.test(r) ? 1 : 0);
    files.sort((a, b) => replace(a.rel) - replace(b.rel) || (a.rel.toLowerCase() < b.rel.toLowerCase() ? -1 : 1));
    let found: OverrideOption['open'];

    for (const f of files)
    {
        const e = parseLocalization(readFileSync(f.abs, 'utf8')).entries.find((x) => x.key === key);

        if (e)
            found = { file: f.abs, rel: f.rel, line: e.line };
    }

    return found;
}

/** Where a new `namespace = x` goes: after the file's last namespace line, else after the comment lines at its top. */
function namespaceAt(body: string, ast: PNode[]): number
{
    const ns = ast.filter((n) => n.k === 'namespace');

    if (ns.length)
    {
        const nl = body.indexOf('\n', ns[ns.length - 1].e);
        return nl < 0 ? body.length : nl + 1;
    }

    let pos = 0;

    while (pos < body.length)
    {
        const nl = body.indexOf('\n', pos);
        const end = nl < 0 ? body.length : nl + 1;

        if (
            !body.slice(pos, end)
                .trim()
                .startsWith('#')
        )
            break;

        pos = end;
    }

    return pos;
}

const sameText = (a: string, b: string): boolean => a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();

/**
 * An overrides file with the copied definition appended (the file's namespace declared at its top once; constants
 * and file-local definitions it needs before it, once per file) — or why this file cannot take it: a constant or
 * local definition of the same name with other content is there.
 */
export function composeScript(existing: string | null, c: OverrideText, provenance: string, header: string): { content?: string; line?: number; notes: string[]; conflict?: string; }
{
    const notes: string[] = [];
    const bom = existing === null || existing.charCodeAt(0) === 0xfeff;
    let body = existing === null ? '' : existing.replace(/^﻿/, '');
    const eol = body ? eolOf(body) : c.eol;
    const ast = parse(body);
    const consts = new Map<string, string>();

    for (const n of ast)
        if (n.k && n.k.charCodeAt(0) === 64 && typeof n.v === 'string')
            consts.set(n.k.slice(1), n.v);

    const addConsts = c.constants.filter((x) => !consts.has(x.name));
    const clash = c.constants.find((x) => consts.has(x.name) && consts.get(x.name) !== x.value);

    if (clash)
        return { notes, conflict: `@${clash.name} is ${consts.get(clash.name)} there, not ${clash.value}` };

    const locals = fileLocals(ast, body);
    const addLocals = c.locals.filter((x) => !locals.has(x.name));
    const differs = c.locals.find((x) => locals.has(x.name) && !sameText(locals.get(x.name)!.text, x.text));

    if (differs)
        return { notes, conflict: `its ${differs.kind} ${differs.name} is another one` };

    if (existing === null)
        body = `# ${header}${eol}`;

    if (body && !body.endsWith('\n'))
        body += eol;

    if (c.namespace && !ast.some((n) => n.k === 'namespace' && n.v === c.namespace))
    {
        const at = namespaceAt(body, existing === null ? [] : ast);
        body = body.slice(0, at) + `namespace = ${c.namespace}` + eol + body.slice(at);
        notes.push(`Declares namespace = ${c.namespace} at the top of the file.`);
    }

    body += eol + `# ${provenance}` + eol + eol;

    if (addConsts.length)
    {
        body += addConsts.map((x) => x.text + eol).join('') + eol;
        notes.push(`Takes along the ${plural(addConsts.length, 'constant', 'constants')} it uses: ${addConsts.map((x) => '@' + x.name).join(', ')}.`);
    }

    if (addLocals.length)
    {
        body += addLocals.map((x) => x.text + eol + eol).join('');
        notes.push(`Takes along the file-local ${addLocals.map((x) => `${x.kind} ${x.name}`).join(', ')} it calls.`);
    }

    const at = body.length + c.at;
    body += c.text + eol;
    return { content: (bom ? '﻿' : '') + body, line: lineAt(body, at), notes };
}

/** A replace file with the localization entry appended (a new one: UTF-8 with BOM and the `l_<lang>:` header). */
export function composeLoc(existing: string | null, loc: NonNullable<OverrideSource['loc']>): { content: string; line: number; }
{
    const bom = existing === null || existing.charCodeAt(0) === 0xfeff;
    let body = existing === null ? '' : existing.replace(/^﻿/, '');
    const eol = body ? eolOf(body) : loc.eol;

    if (!body.trim())
        body = `l_${loc.lang}:${eol}`;

    if (!body.endsWith('\n'))
        body += eol;

    const at = body.length;
    body += ' ' + loc.entry + eol;
    return { content: (bom ? '﻿' : '') + body, line: lineAt(body, at) };
}

function planLocCopy(a: Active, loc: NonNullable<OverrideSource['loc']>): { option: OverrideOption; write?: Write; }
{
    const locDir = modPath(a, `localization/${loc.lang}`);

    if (!locDir)
        return { option: outside(`localization/${loc.lang}`) };

    // (the game reads both replace folders: localization/<lang>/replace/ and localization/replace/<lang>/)
    const found = findLocInMod(locDir, `localization/${loc.lang}`, loc.key) ?? findLocInMod(modPath(a, `localization/replace/${loc.lang}`)!, `localization/replace/${loc.lang}`, loc.key);

    if (found)
        return { option: { open: found, notes: [`${a.mod.name} has this key already (${found.rel}:${found.line}) — edit it there.`] } };

    // (a replace file of the game or another mod could hold the key: the mod's must load after it)
    const winning = /\/replace\//i.test(loc.file) ? basename(loc.file) : '';
    let name = `${fileTag(a)}_l_${loc.lang}.yml`;

    while (winning && !sortsAfter(name, winning))
        name = 'z' + name;

    // a later mod's replace_path over the replace folder hides the mod's file there: the other replace folder then
    const dirs = [`localization/${loc.lang}/replace`, `localization/replace/${loc.lang}`];
    const dir = dirs.find((d) => !hiddenBy(a, d).length);
    const notes: string[] = [];

    if (!dir)
        return { option: { disabled: hiddenProblem(a, dirs[0])!, notes: [hiddenProblem(a, dirs[1])!] } };

    if (dir !== dirs[0])
        notes.push(`Not in ${dirs[0]}: ${hiddenProblem(a, dirs[0])} ${dir} is read as a replace folder too.`);

    const rel = `${dir}/${name}`;
    const abs = modPath(a, rel)!;
    const existing = readUtf8(abs);

    if (existing === false)
        return { option: { disabled: `${rel} is not UTF-8 text — it cannot be added to safely.`, notes: [] } };

    const r = composeLoc(existing, loc);
    return {
        option: { target: rel, notes: [...notes, 'The replace folder loads after all other localization files, so this text wins.'] },
        write: { abs, rel, content: r.content, line: r.line }
    };
}

function planCopy(a: Active, s: OverrideSource): { option: OverrideOption; write?: Write; }
{
    if (s.inMod)
        return { option: { open: { file: s.inMod.abs, rel: s.inMod.rel, line: s.inMod.line }, notes: [`${a.mod.name} defines it already (${s.inMod.rel}:${s.inMod.line}) — edit that definition.`] } };

    if (s.none)
        return { option: { disabled: 'Nothing to copy: the entry has no definition.', notes: [] } };

    if (s.removed)
        return { option: { disabled: 'A mod removed this entry: there is no loaded definition to copy.', notes: [] } };

    if (s.loc)
        return planLocCopy(a, s.loc);

    const d = s.def;
    const c = s.copy;

    if (!d || !c)
        return { option: { disabled: s.copyProblem ?? 'This definition cannot be copied alone.', notes: [] } };

    const relDir = d.rel.slice(0, d.rel.lastIndexOf('/'));
    const dir = modPath(a, relDir);

    if (!dir)
        return { option: outside(relDir) };

    // (a later mod's replace_path over the folder: no file of the mod there loads — no other folder holds the type's
    // definitions for sure: the game's subfolder reading under a replace_path is not known)
    const hidden = hiddenProblem(a, relDir);
    // the index sees the mod's definitions only while it is loaded: its files of that folder are checked too
    const found = findInFolder(dir, relDir, c.key, !!s.path);

    if (found)
        return { option: { open: found, notes: [`${a.mod.name} defines ${c.key} already (${found.rel}:${found.line}) — edit that definition.`, ...(hidden ? [hidden] : [])] } };

    if (hidden)
        return { option: { disabled: hidden, notes: [] } };

    const notes: string[] = [];

    if (s.path)
        notes.push(
            `It is written inside ${s.path.join(' › ')}: the copy is ${s.name} without its de jure vassals, inside empty blocks of those — the game adds a title written again to the one it has, so they and the vassals stay as they are.`
        );
    else if (s.container)
        notes.push(`It is defined inside ${s.container.name}: the copy holds all of ${s.container.name} (the game overrides top-level keys).`);

    if (s.merging)
        notes.push(
            'On_actions merge: the copy is added to the loaded definitions instead of replacing them — whatever stays in it runs twice. Edit it down to what you add, or replace the whole file for a real override.'
        );

    // the game keeps no single winner for these (docs/mods.md, "Which definition wins")
    if (s.type === T_EVENT)
        notes.push(
            'The game does not override single events: the copy is a second event of this id — the game reports "Duplicated event ID" in error.log and which of the two fires is not defined. Replace the whole file for a real override, or duplicate it as a new event.'
        );
    else if (s.type === T_CHARACTER)
        notes.push('History characters do not override each other: the copy is a second character of this id ("Duplicate character id in history" in error.log). Replace the whole file instead.');

    const provenance = `${c.key}${s.path ? ` (in ${s.path.join(' › ')})` : s.container ? ` (holds ${s.name})` : ''} — copied from ${d.rel}:${c.line} (${d.from})`;
    const header = `${a.mod.name}: overrides written by CrusaderPope. This file loads after the other files of its folder, so its definitions win${s.merging ? ' (on_actions merge instead)' : ''}.`;
    const defFile = d.rel.slice(d.rel.lastIndexOf('/') + 1);
    const skipped: string[] = [];

    for (let k = 1; k <= 20; k++)
    {
        const name = overridesName(fileTag(a), k, defFile);
        const rel = relDir + '/' + name;
        const abs = join(dir, name);
        const existing = readUtf8(abs);

        if (existing === false)
        {
            skipped.push(`${rel} is not UTF-8 text`);
            continue;
        }

        const r = composeScript(existing, c, provenance, header);

        if (r.conflict)
        {
            skipped.push(`${rel}: ${r.conflict}`);
            continue;
        }

        if (skipped.length)
            notes.push(`Not in ${skipped.join('; ')}.`);

        return { option: { target: rel, notes: [...notes, ...r.notes] }, write: { abs, rel, content: r.content!, line: r.line! } };
    }

    return { option: { disabled: `No overrides file can take it: ${skipped.join('; ')}.`, notes } };
}

function planFile(a: Active, s: OverrideSource): OverrideOption
{
    if (s.none)
        return { disabled: 'The entry has no definition, so no file.', notes: [] };

    if (s.removed)
        return { disabled: 'A mod removed this entry: the files that defined it are not loaded.', notes: [] };

    const d = s.def!;

    if (s.activeSource > 0 && d.source === s.activeSource)
        return { open: { file: d.abs, rel: d.rel, line: d.line }, notes: [`${d.rel} is ${a.mod.name}’s own file already.`] };

    const abs = modPath(a, d.rel);

    if (!abs)
        return outside(d.rel);

    const hidden = hiddenProblem(a, d.rel.slice(0, d.rel.lastIndexOf('/')));

    if (hidden)
        return { disabled: hidden, notes: [] };

    const notes = [`Copies ${d.rel} as the game loads it now (from ${d.from}); ${a.mod.name}’s file of the same path replaces it.`];

    if (s.activeSource > 0 && d.source > s.activeSource)
        notes.push(`${d.from} loads after ${a.mod.name} and has this file too, so its version keeps winning — move ${a.mod.name} below it in the load order.`);

    if (s.merging && d.otherFiles)
        notes.push(`${d.otherFiles} other ${plural(d.otherFiles, 'file defines', 'files define')} it too — on_actions merge, so ${plural(d.otherFiles, 'that one still adds', 'those still add')} to it.`);

    return { target: d.rel, exists: existsSync(abs), notes };
}

interface Prepared
{
    plan: OverridePlan;
    active?: Active;
    source?: OverrideSource;
    copy?: Write;
}

async function prepare(host: ModsHost, type: string, name: string): Promise<Prepared>
{
    const loc = type === 'localization';
    const none = (why: string): OverrideOption => ({ disabled: why, notes: [] });
    const a = await activeMod(host);

    if (typeof a === 'string')
        return { plan: { problem: a, merging: false, loc, copy: none(a), file: none(a) } };

    const mod = { id: a.mod.id, name: a.mod.name, loaded: a.loaded };
    const s = host.query ? await host.query<OverrideSource | null>('overrideSource', type, name, a.mod.id) : null;

    if (!s)
    {
        const why = 'The index is not ready, or it has no such entry.';
        return { plan: { mod, problem: why, merging: false, loc, copy: none(why), file: none(why) } };
    }

    const copy = planCopy(a, s);
    return { plan: { mod, merging: s.merging, loc: !!s.loc, copy: copy.option, file: planFile(a, s) }, active: a, source: s, copy: copy.write };
}

/** What overriding an entry in the active mod would do: target files, notes, or why it is not possible. */
export async function planOverride(host: ModsHost, type: string, name: string): Promise<OverridePlan>
{
    return (await prepare(host, type, name)).plan;
}

/**
 * Writes a file of the active mod (a script file formatted — `formatted`), recorded for undo (undo.ts: the running
 * operation's step); returns what was written.
 */
export function write(host: ModsHost, file: string, data: string | Uint8Array): string | Uint8Array
{
    // (before writing: the folder watcher must know these are the app's own)
    host.wrote?.([file, file + '.crusaderpope-tmp']);
    return recordWrite(host, file, () =>
    {
        mkdirSync(dirname(file), { recursive: true });
        const out = typeof data === 'string' ? formatted(host, file, data) : data;
        writeAtomic(file, out);
        return out;
    });
}

/** A line (1-based) of a text as it was written: where its first statement went when formatting re-spaced the text. */
export function lineAfter(before: string, after: string | Uint8Array, line: number): number
{
    if (typeof after !== 'string' || after === before)
        return line;

    let off = 0;

    for (let n = 1; n < line; n++)
    {
        const i = before.indexOf('\n', off);

        if (i < 0)
            break;

        off = i + 1;
    }

    return lineAt(after, mapPosition(before, after, off));
}

/**
 * A script file's text as the mod keeps it: formatted (shared/scriptFormat.ts — whitespace only) unless the setting is
 * off or it is no script file; a byte order mark stays.
 */
export function formatted(host: ModsHost, file: string, text: string): string
{
    if (host.settings().formatScripts === false || !isScriptFile(file))
        return text;

    const bom = text.startsWith('﻿');
    const body = bom ? text.slice(1) : text;
    const out = formatScript(body);
    return out === body ? text : (bom ? '﻿' : '') + out;
}

/**
 * Overrides an entry in the active mod (see the file comment). Nothing is written when the mod defines the entry
 * already (`opened`: edit that one) or has the file to replace (`exists`: ask, then `overwrite`). Re-indexes when the
 * mod is in the loaded list, so the override shows. One undo step (`step`).
 */
export function applyOverride(host: ModsHost, req: OverrideRequest): Promise<OverrideResult>
{
    return change(host, `Override of ${req.name}${req.mode === 'file' ? ' (its whole file)' : ''}`, 'override', () => override(host, req));
}

async function override(host: ModsHost, req: OverrideRequest): Promise<OverrideResult>
{
    const p = await prepare(host, req.type, req.name);
    const { plan, active: a, source: s } = p;

    if (plan.problem || !a || !s)
        throw new Error(plan.problem ?? 'Nothing to override.');

    const mod = { id: a.mod.id, name: a.mod.name };
    const opt = req.mode === 'file' ? plan.file : plan.copy;

    if (opt.open)
        return { action: 'opened', mod, file: opt.open.file, rel: opt.open.rel, line: opt.open.line, reindex: false, notes: opt.notes };

    if (opt.disabled)
        throw new Error(opt.disabled);

    if (req.mode === 'copy')
    {
        const w = p.copy!;
        const line = lineAfter(w.content, write(host, w.abs, w.content), w.line);
        describeChange({ line });

        if (a.loaded)
            taken(host, w.abs);

        return { action: 'copied', mod, file: w.abs, rel: w.rel, line, reindex: a.loaded, notes: opt.notes };
    }

    const d = s.def!;
    // (planFile refused paths outside the mod)
    const abs = modPath(a, d.rel)!;

    if (opt.exists && !req.overwrite)
        return { action: 'exists', mod, file: abs, rel: d.rel, line: d.line, reindex: false, notes: opt.notes };

    const bytes = await host.query!<Uint8Array | null>('overrideFileBytes', req.type, req.name);

    if (!bytes)
        throw new Error(`${d.rel} could not be read.`);

    write(host, abs, bytes);
    describeChange({ line: d.line });

    if (a.loaded)
        taken(host, abs);

    return { action: 'replaced', mod, file: abs, rel: d.rel, line: d.line, reindex: a.loaded, notes: opt.notes };
}

/** A file written into the loaded active mod: the index takes it in (incrementally where it can, else by a re-index). */
function taken(host: ModsHost, file: string): void
{
    if (host.refreshFiles)
        void host.refreshFiles([file]);
    else
        host.reindex();
}
