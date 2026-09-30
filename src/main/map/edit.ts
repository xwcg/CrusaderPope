/**
 * Changes made from the map in the active mod (docs/map.md, "Editing from the map"): at the map's date a county's
 * culture and faith (on its capital barony's province) and a barony's holding (history/provinces), a title's holder
 * and liege and a county's development (history/titles); a title's colour (its definition in common/landed_titles,
 * overridden into the mod first — mods/edit.ts). A history file of the mod replaces the game's file of that path
 * entirely, so the first edit of one copies the file the game loads now into the mod, byte for byte, and edits the
 * copy in place (edit-history.ts). Every edit is checked to give the value at the date before it is written, then
 * handed to the index; it is an undo step of the mod (mods/undo.ts, kind 'map': each file it wrote back to its bytes
 * before, a file it made removed — also after a restart). Plain Node.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { MapCharacter, MapEditRequest, MapEditResult } from '../../shared/api.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { TITLE_KEY } from '../indexer/override.ts';
import { T_TITLE } from '../indexer/schema.ts';
import { GameFiles, type GameFile } from '../mods/gamefiles.ts';
import { activeMod, applyOverride, fileTag, modPath, planOverride, write, type Active } from '../mods/edit.ts';
import { modsOfList, modsState, type ModsHost } from '../mods/manager.ts';
import { applyEdit, checkEdit, type EditOutcome } from '../mods/scriptEdit.ts';
import { change, describeChange, journalOf, undoChange } from '../mods/undo.ts';
import { DATE_KEY, dateNum } from './history.ts';
import { anchor, entriesIn, inEffect, lineOf, setInEntry, statementsOf, valueOf, type HistFile, type HistStmt, type SetAt } from './edit-history.ts';

/** keys and values written (ASCII: see bytesText) */
const VALUE = /^[\w.-]+$/;

/**
 * The history edits: the folder, the keys the map reads (the first is written; a later statement of either wins),
 * what it is called, the values it takes. `latest`: the value is the latest statement on the entry or its de jure
 * lieges (development), else the first entry's that has one (a county's culture: its first province with one).
 */
const HISTORY: Record<string, { dir: string; keys: string[]; what: string; value: RegExp; latest?: boolean; }> = {
    culture: { dir: 'history/provinces', keys: ['culture'], what: 'culture', value: VALUE },
    faith: { dir: 'history/provinces', keys: ['religion', 'faith'], what: 'faith', value: VALUE },
    holding: { dir: 'history/provinces', keys: ['holding'], what: 'holding', value: VALUE },
    holder: { dir: 'history/titles', keys: ['holder'], what: 'holder', value: VALUE },
    liege: { dir: 'history/titles', keys: ['liege'], what: 'liege', value: VALUE },
    development: { dir: 'history/titles', keys: ['change_development_level'], what: 'development', value: /^\d{1,3}$/, latest: true }
};

// ---------------------------------------------------------------------------
// Files as bytes
// ---------------------------------------------------------------------------

const BOM = '\xEF\xBB\xBF';

/**
 * A file's text with one character per byte (latin1), so that every byte round-trips: 36 of the game's 183
 * history/titles files and 27 of its 177 history/provinces files are not UTF-8 (Windows-1252 letters in comments).
 * The parser only looks at ASCII; the edits write ASCII.
 */
function bytesText(raw: Buffer): { text: string; bom: boolean; }
{
    const all = raw.toString('latin1');
    const bom = all.startsWith(BOM);
    return { text: bom ? all.slice(BOM.length) : all, bom };
}

const toBytes = (text: string, bom: boolean): Buffer => Buffer.from((bom ? BOM : '') + text, 'latin1');

/** UTF-8 text as bytesText has it (a mod's name in a header comment). */
const asBytes = (s: string): string => Buffer.from(s, 'utf8').toString('latin1');

/** What can be undone (every result carries it: the page keeps its Undo while there is one) — the active mod's map edits. */
function stack(host: ModsHost): Pick<MapEditResult, 'undo' | 'undoNext'>
{
    const steps = journalOf(host).list(host.settings().activeMod ?? '', 'map');
    return { undo: steps.length, undoNext: steps[0]?.label };
}

export async function mapEdit(host: ModsHost, req: MapEditRequest): Promise<MapEditResult>
{
    try
    {
        if (req.kind === 'undo')
            return req.plan ? { ok: true, ...stack(host) } : { ...(await undo(host)), ...stack(host) };

        // (one undo step: the history file or the title copied into the mod first goes with the edit)
        const r = await change(host, `Map: ${req.kind}`, 'map', async (): Promise<MapEditResult> =>
        {
            const a = await activeMod(host);

            if (typeof a === 'string')
                return { ok: false, message: a };

            if (!a.loaded)
                return { ok: false, message: `The active mod ${a.mod.name} is not in the mod list loaded in the explorer — load a list with it to edit from the map.` };

            return req.kind === 'color' ? await setColor(host, a, req) : await setHistory(host, a, req);
        });
        return { ...r, ...stack(host) };
    }
    catch (e)
    {
        return { ok: false, message: (e as Error).message, ...stack(host) };
    }
}

/** The loaded game files (the list the explorer loads) and the active mod's place in them (−1: not loaded). */
async function layering(host: ModsHost, a: Active): Promise<{ vfs: GameFiles; mine: number; }>
{
    const gameDir = host.gameDir();

    if (!gameDir)
        throw new Error('The game folder is not set.');

    const state = await modsState(host);
    const vfs = new GameFiles(gameDir, modsOfList(state, state.selected));
    return { vfs, mine: vfs.sources.findIndex((s) => s.modId?.toLowerCase() === a.mod.id.toLowerCase()) };
}

/**
 * A mod after the active one whose replace_path hides the folder of `rel` (AGOT's `history/titles`): the active mod's
 * files there are not loaded at all.
 */
function hiddenBy(vfs: GameFiles, mine: number, rel: string): string | undefined
{
    const dir = rel.slice(0, rel.lastIndexOf('/')).toLowerCase();
    return vfs.sources.find((s) => s.index > mine && s.replacePaths.some((p) => p.toLowerCase() === dir))?.name;
}

function checkNotHidden(vfs: GameFiles, mine: number, rel: string, mod: string): void
{
    const by = hiddenBy(vfs, mine, rel);

    if (by)
        throw new Error(`${by} loads after ${mod} and replaces ${rel.slice(0, rel.lastIndexOf('/'))} (replace_path), so ${mod}’s files there are not loaded — move ${mod} below it in the load order.`);
}

// ---------------------------------------------------------------------------
// History: culture, faith, holding, holder, liege, development
// ---------------------------------------------------------------------------

/** A history file as the game loads it now. */
interface Loaded extends HistFile
{
    f: GameFile;
    bom: boolean;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The files of a history folder (load order, through the loaded mods' layering) with one of the entries. */
function filesWith(vfs: GameFiles, dir: string, entries: string[]): Loaded[]
{
    const quick = new RegExp(`^[ \\t]*(?:${entries.map(esc).join('|')})[ \\t]*=`, 'm');
    const out: Loaded[] = [];

    for (const f of vfs.list(dir, { ext: /\.txt$/i }))
    {
        const raw = vfs.read(f);

        if (!raw)
            continue;

        const { text, bom } = bytesText(raw);

        if (!quick.test(text))
            continue;

        const file: Loaded = { f, bom, text, nodes: parse(text) };

        if (entries.some((e) => entriesIn(file, e).length))
            out.push(file);
    }

    return out;
}

/** A statement in effect and the entry it is in. */
interface InEffect
{
    entry: string;
    stmt: HistStmt;
}

/**
 * The statement in effect at the date: of the first entry that has one (a county's culture: its capital first), or —
 * `latest` — the latest of all (development: the county's or a de jure liege's; the county's on the same date).
 */
function readAt(files: HistFile[], entries: string[], keys: string[], when: number, latest?: boolean): InEffect | undefined
{
    let best: InEffect | undefined;

    for (const entry of entries)
    {
        const stmt = inEffect(statementsOf(files, entry), keys, when);

        if (!stmt)
            continue;

        if (!latest)
            return { entry, stmt };

        if (!best || stmt.date > best.stmt.date)
            best = { entry, stmt };
    }

    return best;
}

/** A character's facts at a date from the index (undefined: not known — no index); null: no such character. */
async function characterAt(host: ModsHost, id: string, date: string): Promise<MapCharacter | null | undefined>
{
    try
    {
        return host.query ? await host.query<MapCharacter | null>('mapCharacter', id, date) : undefined;
    }
    catch
    {
        return undefined;
    }
}

async function setHistory(host: ModsHost, a: Active, req: MapEditRequest): Promise<MapEditResult>
{
    const spec = HISTORY[req.kind];

    if (!spec)
        throw new Error(`Unknown map edit: ${req.kind}`);

    const date = req.date && DATE_KEY.test(req.date) ? req.date : undefined;

    if (!date)
        throw new Error('No date: the map’s date says when the change happens.');

    const when = dateNum(date);
    const titles = spec.dir === 'history/titles';
    const title = req.title && VALUE.test(req.title) ? req.title : undefined;
    const entries = titles
        ? title
            ? [title, ...(spec.latest ? (req.lieges ?? []).filter((t) => VALUE.test(t)) : [])]
            : []
        : (req.provinces ?? []).filter((p) => Number.isInteger(p) && p > 0).map(String);

    if (!entries.length)
        throw new Error('Nothing to change: no province or title given.');

    const { vfs, mine } = await layering(host, a);
    const files = filesWith(vfs, spec.dir, entries);

    // the statement in effect (a county's culture: of its first province that has one; development: maybe a de jure
    // liege's) and the entry written: that province's (else the capital's), the title's own
    const cur = readAt(files, entries, spec.keys, when, spec.latest);
    const entry = spec.latest ? entries[0] : (cur?.entry ?? entries[0]);
    const own = cur?.entry === entry ? cur.stmt : undefined;
    const whenMode = req.when ?? (titles ? 'date' : 'current');

    // the file: the one with the entry's statement in effect, else the last with the entry, else the mod's own for new entries
    const withEntry = files.map((f, i) => (entriesIn(f, entry).length ? i : -1)).filter((i) => i >= 0);
    const fi = own ? own.file : (withEntry.pop() ?? -1);
    const src = fi >= 0 ? files[fi] : undefined;
    const rel = src ? src.f.rel : `${spec.dir}/${fileTag(a)}_${spec.dir.slice(spec.dir.indexOf('/') + 1)}.txt`;

    if (src && src.f.source > mine)
        throw new Error(`${vfs.sources[src.f.source].name} loads after ${a.mod.name} and has ${rel} too, so its version keeps winning — move ${a.mod.name} below it in the load order.`);

    checkNotHidden(vfs, mine, rel, a.mod.name);
    const abs = modPath(a, rel);

    if (!abs)
        throw new Error(`${rel} is not a path inside the mod folder.`);

    const from = src && src.f.source !== mine ? vfs.sources[src.f.source].name : undefined;
    const mod = { id: a.mod.id, name: a.mod.name };

    if (req.plan)
    {
        const f = cur && files[cur.stmt.file].f;
        const current = cur && f && { date: cur.stmt.block?.k ?? '', value: valueOf(cur.stmt.node), rel: f.rel, from: vfs.sources[f.source].name, title: cur.entry !== entry ? cur.entry : undefined };
        return { ok: true, mod, current, target: { rel, from, created: (!src && !existsSync(abs)) || undefined } };
    }

    const value = (req.value ?? '').trim();

    if (!spec.value.test(value))
        throw new Error(`“${value}” is no ${spec.what}${spec.latest ? ' (a whole number)' : ''}.`);

    const none = value === '0' && (req.kind === 'holder' || req.kind === 'liege');
    const before = cur && valueOf(cur.stmt.node);

    if (before === value || (none && (!before || before === '0')))
        throw new Error(`The ${spec.what} of ${title ?? entry} is ${none ? 'none' : value} at ${date} already.`);

    // when: from the date on; else the statement in effect replaced — a de jure liege's development: the county's own
    // from the same date (it wins then); no statement: from the start (province history — title history is dated only)
    let at: SetAt;

    if (whenMode === 'date')
        at = { date };
    else if (own)
        at = { stmt: own.node };
    else if (cur?.stmt.block?.k)
        at = { date: cur.stmt.block.k };
    else if (!titles)
        at = {};
    else
        throw new Error(`${title} has no ${spec.what} in its history before ${date} — change it from ${date} on.`);

    // the text to edit: the file as loaded (copied into the mod when it is not the mod's), else the mod's file for new entries
    const old = existsSync(abs) ? readFileSync(abs) : null;
    const base = src ?? (old ? bytesText(old) : { text: asBytes(`# ${a.mod.name}: history written by CrusaderPope (the map)\n`), bom: true });
    const out = setInEntry(base.text, entry, spec.keys, value, at);

    // the map must read the new value at the date
    const next = { text: out.text, nodes: parse(out.text) };
    const got = readAt(fi >= 0 ? files.map((f, i) => (i === fi ? next : f)) : [...files, next], entries, spec.keys, when, spec.latest);
    const shown = got && valueOf(got.stmt.node);

    if (shown !== value)
        throw new Error(`The change would not show at ${date}: the ${spec.what} read there would be ${shown ?? 'none'}${got && got.entry !== entry ? ` (${got.entry}’s)` : ''} (${rel}).`);

    const notes: string[] = [];

    if (from)
        notes.push(`${rel} is copied from ${from === 'Game' ? 'the game' : from} first: a history file of the same path replaces the whole file.`);

    if (!src)
        notes.push(`${entry} had no history: a new entry in ${rel}.`);

    const since = at.stmt ? own?.block?.k : at.date;

    if (req.kind === 'holder' && !none)
    {
        const who = await characterAt(host, value, since ?? date);

        if (who === null)
            throw new Error(`There is no character ${value} in the loaded game files.`);

        if (who && !who.alive)
            notes.push(`${who.name}${who.house ? ' ' + who.house : ''} (${value}) is not alive at ${since ?? date}${who.birth ? ` (born ${who.birth}${who.death ? `, died ${who.death}` : ''})` : ''}.`);
    }

    const later = (spec.latest ? entries : [entry])
        .map((e) => ({ e, s: statementsOf(files, e).find((s) => s.date > when && spec.keys.includes(s.node.k!)) }))
        .filter((x): x is { e: string; s: HistStmt; } => !!x.s)
        .sort((x, y) => x.s.date - y.s.date)[0];

    if (later)
        notes.push(`Later history still changes it: ${later.s.block?.k} (${later.e === entry ? '' : later.e + ': '}${later.s.node.k} = ${valueOf(later.s.node)}).`);

    const how = at.stmt ? (since ? `since ${since}` : 'from the start') : at.date ? (at.date === date ? `from ${date}` : `since ${at.date}`) : 'from the start';
    return commit(host, mod, `${title ?? entry}: ${at.stmt?.k ?? spec.keys[0]} = ${value} ${how}`, [{ abs, rel, bytes: toBytes(out.text, base.bom) }], lineOf(out.text, out.at), notes);
}

// ---------------------------------------------------------------------------
// A title's colour (common/landed_titles)
// ---------------------------------------------------------------------------

/**
 * The title's block in a landed_titles file, at any depth: the last one with values of its own — not an empty block
 * written only as the way to a title inside it (override.ts titleText) —, else the last one.
 */
function findTitle(nodes: PNode[], key: string): PNode | undefined
{
    let found: PNode | undefined;
    let way: PNode | undefined;
    const walk = (list: PNode[]): void =>
    {
        for (const n of list)
        {
            if (!Array.isArray(n.v))
                continue;

            if (n.k === key)
            {
                if (n.v.every((c) => c.k !== null && TITLE_KEY.test(c.k) && Array.isArray(c.v)))
                    way = n;
                else
                    found = n;
            }

            walk(n.v);
        }
    };
    walk(nodes);
    return found ?? way;
}

/** The title's `color = { r g b }` set: its colour statement replaced, else added first in its block. */
export function setTitleColor(text: string, title: string, rgb: number[]): EditOutcome
{
    const node = findTitle(parse(text), title);

    if (!node)
        throw new Error(`${title} was not found in the file.`);

    const stmt = `color = { ${rgb.join(' ')} }`;
    const kids = (node.v as PNode[]).filter((c) => c.k);
    const old = kids.filter((c) => c.k === 'color').pop();
    const req = old
        ? { op: 'replace' as const, at: anchor(text, old), text: stmt }
        : { op: 'insert' as const, at: anchor(text, kids[0] ?? node), where: kids.length ? ('before' as const) : ('inside' as const), text: stmt };
    const out = applyEdit(text, req);
    checkEdit(text, req, out);
    return out;
}

async function setColor(host: ModsHost, a: Active, req: MapEditRequest): Promise<MapEditResult>
{
    const title = req.title ?? '';

    if (!VALUE.test(title))
        throw new Error('No title given.');

    const plan = await planOverride(host, T_TITLE, title);

    if (plan.problem)
        throw new Error(plan.problem);

    const opt = plan.copy;

    if (opt.disabled)
        throw new Error(opt.disabled);

    const rel = opt.open?.rel ?? opt.target;
    const target = opt.open?.file ?? (rel ? modPath(a, rel) : undefined);

    if (!rel || !target)
        throw new Error(`${title} cannot be copied into ${a.mod.name}.`);

    const { vfs, mine } = await layering(host, a);
    checkNotHidden(vfs, mine, rel, a.mod.name);
    const mod = { id: a.mod.id, name: a.mod.name };

    if (req.plan)
        return { ok: true, mod, target: { rel, created: !existsSync(target) || undefined }, notes: opt.notes };

    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(req.value ?? '');

    if (!m)
        throw new Error(`“${req.value ?? ''}” is no colour (#rrggbb).`);

    const rgb = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));

    const notes: string[] = [];

    if (!opt.open)
    {
        const r = await applyOverride(host, { type: T_TITLE, name: title, mode: 'copy' });
        notes.push(`${title} is copied into ${r.rel} first.`, ...r.notes);
    }

    const { text, bom } = bytesText(readFileSync(target));
    const out = setTitleColor(text, title, rgb);
    return commit(host, mod, `${title}: color = { ${rgb.join(' ')} }`, [{ abs: target, rel, bytes: toBytes(out.text, bom) }], lineOf(out.text, out.at), notes);
}

// ---------------------------------------------------------------------------
// Writing and undoing
// ---------------------------------------------------------------------------

/** Hands written files to the index: incrementally where it can, else a re-index. */
async function refresh(host: ModsHost, files: string[]): Promise<void>
{
    if (host.refreshFiles)
        await host.refreshFiles(files);
    else
        host.reindex();
}

/** Writes an edit's files (the running undo step records them) and waits until the index has them. */
async function commit(host: ModsHost, mod: { id: string; name: string; }, what: string, files: { abs: string; rel: string; bytes: Buffer; }[], line: number, notes: string[]): Promise<MapEditResult>
{
    for (const f of files)
        write(host, f.abs, f.bytes);

    describeChange({ label: what, line });
    await refresh(host, files.map((f) => f.abs));
    return { ok: true, message: what, mod, file: files[0].abs, rel: files[0].rel, line, notes };
}

/** Undoes the active mod's last map edit (mods/undo.ts) when its files are still as it wrote them. */
async function undo(host: ModsHost): Promise<MapEditResult>
{
    const u = await undoChange(host, { mod: host.settings().activeMod ?? '', kind: 'map' });

    if (!u)
        return { ok: false, message: 'No map edit to undo.' };

    if (u.refused)
        return { ok: false, message: `${u.label}: ${u.refused}` };

    return { ok: true, message: `Undone: ${u.label}`, mod: u.mod, file: u.file, rel: u.rel, line: u.line, notes: u.removed.length ? [`Removed again: ${u.removed.join(', ')}`] : [] };
}
