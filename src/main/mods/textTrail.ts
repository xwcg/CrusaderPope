/**
 * The app's own writes to script files, as a trail per file (docs/mods.md, "Editing in place", "Finding the
 * statement"): which text each write turned into which, and where it changed. An anchor made from an older text of the
 * file (the view has not reloaded yet) is mapped through the writes since, so a block that got a line follows its new
 * length and of two statements written the same the right one is found by its mapped offsets (scriptEdit.ts `locate`).
 *
 * Each entry is one write: the checksums of the text before and after it (as `textHash`, without a byte order mark),
 * the range it changed (`p`, `oldEnd` in the text before; `newEnd` in the edited text) and, when formatting re-spaced
 * the written text, how its characters that are no whitespace moved (`fmt`). No texts are kept. The chain is looked
 * up by checksum: a write the trail did not see (an undo, another editor) usually breaks it (not when it restored a
 * text the trail knows), and locate then finds statements by their own text as before.
 */
import { resolve } from 'node:path';
import { textHash } from '../indexer/override.ts';

/** What a write changed: [p, oldEnd) of the text before became [p, newEnd) of the edited text. */
export interface Splice
{
    p: number;
    oldEnd: number;
    newEnd: number;
}

/**
 * Formatting of the edited text (whitespace only): for each run of characters that are no whitespace moved by the
 * same amount, where it starts in the edited text (`at`, ascending) and by how much it moved (`d`).
 */
export interface Respacing
{
    at: Int32Array;
    d: Int32Array;
}

export interface TrailEntry extends Splice
{
    /** textHash of the text before the write and of the text written */
    from: string;
    to: string;
    fmt?: Respacing;
    /**
     * the range is the edit's own (the writer said it: an in-place edit); else it was taken from the texts and may be
     * wider than the edit
     */
    exact?: boolean;
}

/** How many writes a file keeps (an anchor older than that is found by its own text). */
const PER_FILE = 32;
/** How many files keep a trail (the least recently written goes first). */
const FILES = 256;
/** A formatting map larger than this is not kept (that write breaks the chain). */
const MAX_RUNS = 1 << 20;

const trails = new Map<string, TrailEntry[]>();

const keyOf = (file: string): string =>
{
    const p = resolve(file);
    return process.platform === 'win32' ? p.toLowerCase() : p;
};

/** The writes recorded for a file, oldest first. */
export function trailOf(file: string): readonly TrailEntry[]
{
    return trails.get(keyOf(file)) ?? [];
}

/** Records a write (edit.ts `write`). */
export function recordTrail(file: string, entry: TrailEntry): void
{
    const k = keyOf(file);
    const list = trails.get(k) ?? [];
    trails.delete(k);
    list.push(entry);

    if (list.length > PER_FILE)
        list.splice(0, list.length - PER_FILE);

    trails.set(k, list);

    if (trails.size > FILES)
        trails.delete(trails.keys().next().value!);
}

/** Whether a given splice describes `before` → `mid`. */
function fits(before: string, mid: string, x: Splice): boolean
{
    return x.p >= 0 && x.p <= x.oldEnd && x.oldEnd <= before.length && x.p <= x.newEnd && x.newEnd <= mid.length && before.length - x.oldEnd === mid.length - x.newEnd &&
        before.startsWith(mid.slice(0, x.p)) && before.endsWith(mid.slice(x.newEnd));
}

/**
 * The range two texts differ in, when the writer did not say: the common prefix and suffix. An insertion of text that
 * repeats what is next to it could be placed at several offsets; the range taken covers all of them (the common prefix
 * taken first and the common suffix taken first, both), so a statement next to such an insertion counts as touching it
 * (locate falls back) rather than being shifted by a guess.
 */
function diffRange(before: string, mid: string): Splice
{
    if (before === mid)
        return { p: before.length, oldEnd: before.length, newEnd: before.length };

    const min = Math.min(before.length, mid.length);
    let pre = 0;

    while (pre < min && before.charCodeAt(pre) === mid.charCodeAt(pre))
        pre++;

    let suf = 0;

    while (suf < min && before.charCodeAt(before.length - 1 - suf) === mid.charCodeAt(mid.length - 1 - suf))
        suf++;

    const p = Math.min(pre, min - suf);
    const keep = Math.min(suf, min - pre);
    return { p, oldEnd: before.length - keep, newEnd: mid.length - keep };
}

/**
 * How formatting moved the characters that are no whitespace (code above 32, as the statement checks count them) from
 * `mid` to `out`; undefined when those characters are not the same in both (then it was no re-spacing).
 */
function respacing(mid: string, out: string): Respacing | undefined
{
    const at: number[] = [];
    const d: number[] = [];
    let j = 0;
    let last = NaN;

    for (let i = 0; i < mid.length; i++)
    {
        const c = mid.charCodeAt(i);

        if (c <= 32)
            continue;

        while (j < out.length && out.charCodeAt(j) <= 32)
            j++;

        if (j >= out.length || out.charCodeAt(j) !== c)
            return undefined;

        if (j - i !== last)
        {
            if (at.length >= MAX_RUNS)
                return undefined;

            at.push(i);
            d.push(j - i);
            last = j - i;
        }

        j++;
    }

    while (j < out.length && out.charCodeAt(j) <= 32)
        j++;

    return j === out.length ? { at: Int32Array.from(at), d: Int32Array.from(d) } : undefined;
}

/**
 * A write as a trail entry: `before` the file's text, `mid` the text the edit made, `out` what was written (`mid`
 * formatted, or `mid` itself); all without a byte order mark. `splice`: the range the edit changed in `before`, when
 * the writer knows it (an in-place edit: applyEdit); checked against the texts, else (or when absent) taken from them.
 * Undefined when the formatting changed more than whitespace.
 */
export function trailEntry(before: string, mid: string, out: string, splice?: Splice): TrailEntry | undefined
{
    const exact = !!splice && fits(before, mid, splice);
    const x = exact ? splice! : diffRange(before, mid);
    let fmt: Respacing | undefined;

    if (out !== mid)
    {
        fmt = respacing(mid, out);

        if (!fmt)
            return undefined;
    }

    return { from: textHash(before), to: textHash(out), p: x.p, oldEnd: x.oldEnd, newEnd: x.newEnd, ...(fmt ? { fmt } : {}), ...(exact ? { exact } : {}) };
}

/** The run of the formatting map an offset of the edited text is in (the last one starting at or before it), or -1. */
function runAt(f: Respacing, i: number): number
{
    let lo = 0;
    let hi = f.at.length - 1;
    let k = -1;

    while (lo <= hi)
    {
        const m = (lo + hi) >> 1;

        if (f.at[m] <= i)
        {
            k = m;
            lo = m + 1;
        }
        else
            hi = m - 1;
    }

    return k;
}

/** Where a character of the edited text (that is no whitespace) is in the formatted text. */
function moved(f: Respacing, i: number): number
{
    const k = runAt(f, i);
    return k < 0 ? -1 : i + f.d[k];
}

/**
 * A range of the edited text in the formatted text, at least as wide as needed: every character that is no whitespace
 * inside [s, e) stays inside (its ends may be whitespace, unlike a statement's).
 */
function movedRange(f: Respacing, s: number, e: number): [number, number]
{
    const k = runAt(f, s);
    let s2 = k < 0 ? 0 : s + f.d[k];

    // (s on whitespace after its run: the next run's first character may move before s + d)
    if (k + 1 < f.at.length)
        s2 = Math.min(s2, f.at[k + 1] + f.d[k + 1]);

    const k2 = runAt(f, e - 1);
    return [Math.max(0, s2), k2 < 0 ? 0 : e + f.d[k2]];
}

/** A statement's range mapped through the trail. */
export interface Mapped
{
    s: number;
    e: number;
    /** a write changed something inside it (it encloses the change) */
    grew: boolean;
    /** one of the writes it grew by had a range taken from the texts (not the edit's own) */
    guessed: boolean;
    /** the fewest characters from its start a write left unchanged before its change (its key must fit in them) */
    room: number;
    /**
     * the statement lay inside a range an in-place edit replaced (a whole definition saved with a line changed, a
     * statement wrapped in a block): [s, e) is that range in the current text, which holds the statement if it is
     * still there (locate finds it there by its own text, so not a twin outside)
     */
    within: boolean;
}

/**
 * Maps a statement's range [s, e) in the text with checksum `from` through the trail to the text with checksum `to`
 * (the file now): a range before a write's change stays, one after it shifts by the change's length, one that
 * encloses it (the change after its first character, before its last) keeps its start and its end shifts.
 * One inside a range an edit replaced (`exact`, the replacement not empty; also the range itself: a statement wrapped
 * in a block) becomes that replaced range (`within`), followed through later writes as a range (a later change
 * overlapping it widens it). `'touched'`: an edit's own range removed the statement or overlaps it otherwise (starts
 * inside it, or ends inside it): changed at its edge. Undefined when the chain is broken (a write the trail did not
 * see), or a range taken from the texts overlaps it (the edit may have been next to it).
 */
export function mapRange(trail: readonly TrailEntry[], from: string, to: string, s: number, e: number): Mapped | 'touched' | undefined
{
    if (!(s < e))
        return undefined;

    // (the newest write from that text whose chain leads to the current text: a restore the trail did not see, an
    // undo then a redo, can lead back to a text an older write came from; a broken chain says nothing, not even
    // "touched")
    let i = -1;

    for (let k = trail.length - 1; k >= 0 && i < 0; k--)
    {
        if (trail[k].from !== from)
            continue;

        let j = k;
        let h = from;

        while (h !== to && j < trail.length && trail[j].from === h)
            h = trail[j++].to;

        if (h === to)
            i = k;
    }

    if (i < 0)
        return undefined;

    let grew = false;
    let guessed = false;
    let room = Infinity;
    let within = false;
    let h = from;

    for (; h !== to; i++)
    {
        const w = trail[i];
        const d = w.newEnd - w.oldEnd;

        if (e <= w.p)
        {
            // before the change
        }
        else if (s >= w.oldEnd)
        {
            s += d;
            e += d;
        }
        else if (within)
        {
            // (a range, not a statement: widened over the change)
            s = Math.min(s, w.p);
            e = e > w.oldEnd ? e + d : w.newEnd;
        }
        else if (s < w.p && w.oldEnd < e)
        {
            grew = true;
            guessed ||= !w.exact;
            room = Math.min(room, w.p - s);
            e += d;
        }
        else if (w.exact && w.p <= s && e <= w.oldEnd && w.newEnd > w.p)
        {
            within = true;
            s = w.p;
            e = w.newEnd;
        }
        else
            return w.exact ? 'touched' : undefined;

        if (w.fmt)
        {
            if (within)
                [s, e] = movedRange(w.fmt, s, e);
            else
            {
                // (s is at a character that is no whitespace, e right after one: both keep their character)
                const s2 = moved(w.fmt, s);
                const e2 = moved(w.fmt, e - 1);

                if (s2 < 0 || e2 < 0)
                    return undefined;

                s = s2;
                e = e2 + 1;
            }
        }

        h = w.to;
    }

    return { s, e, grew, guessed, room, within };
}
