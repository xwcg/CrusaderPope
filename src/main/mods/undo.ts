/**
 * Undo of what the app writes into mods (docs/mods.md, "Undo"): in-place edits, overrides, new entries, duplicates,
 * texts, map edits, imports and replaced assets. Every write goes through `recordWrite` / `recordRemove` (edit.ts
 * `write`); the writes of one operation (`change`) are one step — each file with its bytes before (or that the app
 * made it, and the folders made for it) and the checksum of what it wrote last. Undoing a step restores every file
 * when all of them are still what it wrote (else refused: changed in another editor, or by a later step), removes the
 * files it made and the folders made for them when empty, and hands the files to the index.
 *
 * The steps survive a restart: kept in the app's userData (`undo/journal.json`, each file's earlier bytes in a file of
 * its own), the last 100 steps and at most 64 MB of earlier bytes (the oldest go first). Without a folder (scripts):
 * in memory. Plain Node.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { UndoResult } from '../../shared/api.ts';
import { writeAtomic, type ModsHost } from './manager.ts';

/** One file of a step. */
interface StepFile
{
    file: string;
    /** its path in the mod (shown) */
    rel: string;
    /** the file did not exist before the step (undo removes it), with the folders made for it (deepest first) */
    created?: boolean;
    dirs?: string[];
    /** its bytes before: in memory, or the blob in the journal's folder */
    data?: Buffer;
    blob?: string;
    size: number;
    /** sha1 of the bytes the step left (null: it removed the file) */
    after: string | null;
}

/** One undoable change: what the app did in one operation. */
interface Step
{
    id: number;
    at: number;
    /** what it was, in words ("Changed: +4 Martial", "Override of brave") */
    label: string;
    /** edit, override, create, map, import … — the map page undoes only its own */
    kind: string;
    mod?: { id: string; name: string; };
    files: StepFile[];
    /** where to show it after an undo: a line of its first file (the one an operation writes first) */
    line?: number;
}

const MAX_STEPS = 100;
const MAX_BYTES = 64 << 20;

const sha1 = (b: Uint8Array): string => createHash('sha1').update(b).digest('hex');

/** An operation being recorded (the writes made while it runs — AsyncLocalStorage keeps concurrent ones apart). */
interface Pending
{
    label: string;
    kind: string;
    mod?: { id: string; name: string; };
    /** the mod's folder: the files' paths in it are shown */
    root?: string;
    files: Map<string, StepFile>;
    line?: number;
    /** the step once committed */
    id?: number;
}

const pending = new AsyncLocalStorage<Pending>();

export class UndoJournal
{
    private steps: Step[] = [];
    private next = 1;
    private dir?: string;

    /** `dir`: where the journal is kept (none: in memory) */
    constructor(dir?: string)
    {
        this.dir = dir;
        this.load();
    }

    private load(): void
    {
        if (!this.dir)
            return;

        try
        {
            const j = JSON.parse(readFileSync(join(this.dir, 'journal.json'), 'utf8')) as { next: number; steps: Step[]; };
            this.steps = j.steps.filter((s) => s.files.every((f) => f.created || (f.blob && existsSync(join(this.dir!, f.blob)))));
            this.next = Math.max(j.next ?? 1, ...this.steps.map((s) => s.id + 1));
        }
        catch
        {
            this.steps = [];
        }
    }

    private save(): void
    {
        if (!this.dir)
            return;

        mkdirSync(this.dir, { recursive: true });
        const steps = this.steps.map((s) => ({ ...s, files: s.files.map(({ data: _d, ...f }) => f) }));
        writeAtomic(join(this.dir, 'journal.json'), JSON.stringify({ next: this.next, steps }));
        // (blobs of steps no longer kept)
        const keep = new Set(this.steps.flatMap((s) => s.files.map((f) => f.blob)));

        for (const name of readdirSync(this.dir))
        {
            if (name.endsWith('.bin') && !keep.has(name))
            {
                try
                {
                    unlinkSync(join(this.dir, name));
                }
                catch
                {
                    // (in use: next time)
                }
            }
        }
    }

    /** Adds a finished operation's step (its earlier bytes into blobs), dropping the oldest beyond the limits. */
    commit(p: Pending): number | undefined
    {
        if (!p.files.size)
            return undefined;

        const id = this.next++;
        const files = [...p.files.values()];
        files.forEach((f, i) =>
        {
            if (f.data && this.dir)
            {
                mkdirSync(this.dir, { recursive: true });
                f.blob = `${id}-${i}.bin`;
                writeFileSync(join(this.dir, f.blob), f.data);
                delete f.data;
            }
        });
        this.steps.push({ id, at: Date.now(), label: p.label, kind: p.kind, mod: p.mod, files, line: p.line });

        // (the newest step always stays)
        const bytes = (): number => this.steps.reduce((n, s) => n + s.files.reduce((m, f) => m + f.size, 0), 0);

        while (this.steps.length > 1 && (this.steps.length > MAX_STEPS || bytes() > MAX_BYTES))
            this.steps.shift();

        this.save();
        return id;
    }

    /** Steps of a mod (all when no mod), newest first; `kind`: only those. */
    list(mod?: string, kind?: string): { id: number; label: string; kind: string; at: number; }[]
    {
        return this.steps
            .filter((s) => (!mod || s.mod?.id.toLowerCase() === mod.toLowerCase()) && (!kind || s.kind === kind))
            .reverse()
            .map((s) => ({ id: s.id, label: s.label, kind: s.kind, at: s.at }));
    }

    /** Drops a step without undoing it (one that can't be undone any more: its files changed since — "Forget"). */
    forget(id: number): boolean
    {
        const i = this.steps.findIndex((s) => s.id === id);

        if (i < 0)
            return false;

        this.steps.splice(i, 1);
        this.save();
        return true;
    }

    /**
     * Why a step can't be undone now, or undefined: every file must be as it left it — a file it made and that is gone
     * since is no obstacle (removing it is what undo would do). A later step that touched the file is named: undo that
     * first; else the file changed outside the app (another editor, deleted).
     */
    private blocked(pick: Step): string | undefined
    {
        for (const f of pick.files)
        {
            const now = existsSync(f.file) ? sha1(readFileSync(f.file)) : null;

            if (now === f.after || (f.created && now === null))
                continue;

            const key = process.platform === 'win32' ? f.file.toLowerCase() : f.file;
            const later = this.steps.find((s) => s.id > pick.id && s.files.some((x) => (process.platform === 'win32' ? x.file.toLowerCase() : x.file) === key));

            if (later)
                return `${f.rel} was changed again by a later change (“${later.label}”) — undo that one first.`;

            if (f.after === null)
                return `${f.rel} is there again since (made in another editor?) — nothing was undone.`;

            return now === null ? `${f.rel} was deleted since (outside the app) — nothing was undone.` : `${f.rel} changed since (in another editor?) — nothing was undone.`;
        }

        return undefined;
    }

    /**
     * Undoes a step (`id`, else the newest of `mod` — of `kind`): when every file is still what it wrote (blocked), each
     * goes back to its bytes before, the files it made are removed (and the folders made for them, when empty). Returns
     * the files changed — for the index —, or `refused` with why (the step stays: "Forget" drops it); null when there is
     * nothing to undo.
     */
    undo(host: ModsHost, which: { id?: number; mod?: string; kind?: string; }): (UndoResult & { changed: string[]; }) | null
    {
        const pick = which.id !== undefined ? this.steps.find((s) => s.id === which.id) : this.steps.filter((s) => (!which.mod || s.mod?.id.toLowerCase() === which.mod.toLowerCase()) && (!which.kind || s.kind === which.kind)).pop();

        if (!pick)
        {
            if (which.id !== undefined)
                return { id: which.id, label: 'That change', kind: '', removed: [], also: [], left: 0, refused: 'It can’t be undone any more (it is no longer kept: the last 100 changes are).', changed: [] };

            return null;
        }

        const left = (): Step[] => this.steps.filter((s) => s !== pick && (!pick.mod || s.mod?.id.toLowerCase() === pick.mod.id.toLowerCase()));
        const base = { id: pick.id, label: pick.label, kind: pick.kind, mod: pick.mod };
        const refused = this.blocked(pick);

        if (refused)
            return { ...base, rel: pick.files[0]?.rel, removed: [], also: [], left: left().length + 1, refused, changed: [] };

        // (every file checked first: all or nothing)
        const changed = restore(host, pick.files, (f) => f.data ?? readFileSync(join(this.dir!, f.blob!)));
        this.steps.splice(this.steps.indexOf(pick), 1);
        this.save();
        const shown = pick.files.find((f) => !f.created) ?? pick.files[0];
        const rest = left();
        const next = rest[rest.length - 1];
        return {
            ...base,
            file: shown.created ? undefined : shown.file,
            rel: shown.rel,
            line: shown === pick.files[0] ? pick.line : undefined,
            removed: pick.files.filter((f) => f.created).map((f) => f.rel),
            also: pick.files.filter((f) => !f.created && f !== shown).map((f) => f.rel),
            left: rest.length,
            next: next && { id: next.id, label: next.label },
            changed
        };
    }
}

/**
 * The files of a step back to their bytes before (newest first): made ones removed with the folders made for them when
 * empty; the watcher is told first. Returns the files touched.
 */
function restore(host: ModsHost, files: StepFile[], before: (f: StepFile) => Buffer | undefined): string[]
{
    const changed: string[] = [];

    for (const f of [...files].reverse())
    {
        host.wrote?.([f.file, f.file + '.crusaderpope-tmp']);

        if (f.created)
        {
            if (existsSync(f.file))
                unlinkSync(f.file);

            for (const d of f.dirs ?? [])
            {
                try
                {
                    if (existsSync(d) && !readdirSync(d).length)
                        rmdirSync(d);
                }
                catch
                {
                    // (in use, not empty: it stays)
                }
            }
        }
        else
        {
            const bytes = before(f);

            if (!bytes)
                continue;

            mkdirSync(dirname(f.file), { recursive: true });
            writeAtomic(f.file, bytes);
        }

        changed.push(f.file);
    }

    return changed;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

const journals = new Map<string, UndoJournal>();
const memory = new WeakMap<ModsHost, UndoJournal>();

/** The host's journal: kept in its data folder (`undo/`), else in memory. */
export function journalOf(host: ModsHost): UndoJournal
{
    const dir = host.dataDir?.();

    if (!dir)
    {
        let j = memory.get(host);

        if (!j)
            memory.set(host, j = new UndoJournal());

        return j;
    }

    const key = join(dir, 'undo');
    let j = journals.get(key);

    if (!j)
        journals.set(key, j = new UndoJournal(key));

    return j;
}

/** Forgets the journals read (the next use reads them again from their folder — a restart, for the check script). */
export function dropJournals(): void
{
    journals.clear();
}

/**
 * Runs an operation that writes into a mod as one undoable step (nested operations join the outer one). The result
 * gets the step's id (`step`) when it is an object and something was written — and a numeric `undo` becomes how many
 * changes of the mod can be undone. `rollback`: when the operation fails, what it wrote so far is taken back at once
 * (a picked statement refused after its new entries were made: no step is left) — the outermost operation decides;
 * without it, what was written stays as a step (undoable).
 */
export async function change<T>(host: ModsHost, label: string, kind: string, fn: () => Promise<T>, opts: { rollback?: boolean; } = {}): Promise<T>
{
    const outer = pending.getStore();

    if (outer)
        return fn();

    const p: Pending = { label, kind, files: new Map() };
    let result: T;

    try
    {
        result = await pending.run(p, fn);
    }
    catch (e)
    {
        if (opts.rollback && p.files.size)
        {
            // (the files back as they were before the operation — nothing to undo, no step)
            const files = restore(host, [...p.files.values()], (f) => f.data);
            p.files.clear();

            if (host.refreshFiles)
                await host.refreshFiles(files).catch(() => undefined);
            else
                host.reindex();
        }

        throw e;
    }
    finally
    {
        p.id = journalOf(host).commit(p);
    }

    if (result && typeof result === 'object' && !Array.isArray(result))
    {
        const r = result as { step?: number; undo?: number; };

        if (p.id !== undefined)
            r.step = p.id;

        if (typeof r.undo === 'number')
            r.undo = journalOf(host).list(p.mod?.id).length;
    }

    return result;
}

/** The operation being recorded: its words, the mod (and its folder), the line to show after an undo. */
export function describeChange(patch: { label?: string; mod?: { id: string; name: string; }; root?: string; line?: number; }): void
{
    const p = pending.getStore();

    if (!p)
        return;

    if (patch.label)
        p.label = patch.label;

    // (the first mod named: an operation writes into the active mod)
    if (patch.mod && !p.mod)
    {
        p.mod = { id: patch.mod.id, name: patch.mod.name };
        p.root = patch.root;
    }

    if (patch.line !== undefined)
        p.line = patch.line;
}

/** The operation a write belongs to: the one running, else one of its own. */
function current(file: string): { p: Pending; own: boolean; }
{
    const p = pending.getStore();

    if (p)
        return { p, own: false };

    return { p: { label: `Wrote ${basename(file)}`, kind: 'write', files: new Map() }, own: true };
}

/** A file's path in the operation's mod (`common/traits/x.txt`), else its name. */
function relIn(p: Pending, file: string): string
{
    const r = p.root ? relative(p.root, file) : '';
    return r && !r.startsWith('..') && !isAbsolute(r) ? r.replace(/\\/g, '/') : basename(file);
}

/** The folders that don't exist yet above a file (deepest first) — those a write makes. */
function missingDirs(file: string): string[]
{
    const out: string[] = [];

    for (let d = dirname(file); !existsSync(d); d = dirname(d))
    {
        out.push(d);

        if (dirname(d) === d)
            break;
    }

    return out;
}

/** Before a file is written or removed: its bytes then (the first time in the step). */
function remember(p: Pending, file: string): StepFile
{
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    let f = p.files.get(key);

    if (!f)
    {
        const rel = relIn(p, file);
        const exists = existsSync(file);
        const data = exists ? readFileSync(file) : undefined;
        f = exists ? { file, rel, data, size: data!.length, after: null } : { file, rel, created: true, dirs: missingDirs(file), size: 0, after: null };
        p.files.set(key, f);
    }

    return f;
}

/**
 * Writes a file of a mod (`write` does it and returns what it wrote) and records it for undo. A write outside an
 * operation is a step of its own.
 */
export function recordWrite<T extends Uint8Array | string>(host: ModsHost, file: string, write: () => T): T
{
    const { p, own } = current(file);
    const f = remember(p, file);
    const out = write();
    f.after = sha1(typeof out === 'string' ? Buffer.from(out, 'utf8') : out);

    if (own)
        journalOf(host).commit(p);

    return out;
}

/** Removes a file of a mod (`remove`: how — to the recycle bin) and records it for undo. */
export async function recordRemove(host: ModsHost, file: string, remove: () => Promise<void> | void): Promise<void>
{
    const { p, own } = current(file);
    const f = remember(p, file);
    await remove();
    f.after = existsSync(file) ? sha1(readFileSync(file)) : null;

    if (own)
        journalOf(host).commit(p);
}

/** Undoes a step (see UndoJournal.undo — `refused`: why not, nothing written) and hands the files to the index. */
export async function undoChange(host: ModsHost, which: { id?: number; mod?: string; kind?: string; }): Promise<UndoResult | null>
{
    const r = journalOf(host).undo(host, which);

    if (!r)
        return null;

    const { changed, ...result } = r;

    if (!changed.length)
        return result;

    if (host.refreshFiles)
        await host.refreshFiles(changed);
    else
        host.reindex();

    return result;
}

/** Drops a step that can't be undone any more (its files changed since): the next undo reaches the ones before. */
export function forgetChange(host: ModsHost, id: number): boolean
{
    return journalOf(host).forget(id);
}
