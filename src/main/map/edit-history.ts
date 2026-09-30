/**
 * History edits from the map (docs/map.md, "Editing from the map"), the text side: an entry's statements across the
 * history files (history/provinces, history/titles) with the one in effect at a date, and a file's text with
 * `key = value` set — the statement in effect replaced, in a `<date> = { }` block, as an undated statement or as a new
 * entry. Bytes outside the edited range stay; the file's indentation and line ends are kept. Plain Node.
 */
import type { LineSource } from '../../shared/api.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { applyEdit, checkEdit, layoutOf, reindent, scriptProblems, type EditOutcome } from '../mods/scriptEdit.ts';
import { dateNum, HISTORY_DATE, unquote } from './history.ts';

/** A history file's text (without its byte order mark) and parse. */
export interface HistFile
{
    text: string;
    nodes: PNode[];
}

/** A statement of an entry: undated (date 0) or in a dated block. */
export interface HistStmt
{
    /** index into the files */
    file: number;
    node: PNode;
    /** the `<date> = { }` block holding it */
    block?: PNode;
    date: number;
}

const isDated = (c: PNode): boolean => !!c.k && HISTORY_DATE.test(c.k) && Array.isArray(c.v);

/** An entry's top-level blocks in a file (a file can have one twice). */
export const entriesIn = (f: HistFile, entry: string): PNode[] => f.nodes.filter((n) => n.k === entry && Array.isArray(n.v));

/** Every statement of an entry, files in load order, sorted by date — as the map reads them (history.ts HistoryBook). */
export function statementsOf(files: HistFile[], entry: string): HistStmt[]
{
    const out: HistStmt[] = [];
    files.forEach((f, file) =>
    {
        for (const top of entriesIn(f, entry))
        {
            for (const c of top.v as PNode[])
            {
                if (!c.k)
                    continue;

                if (isDated(c))
                {
                    for (const x of c.v as PNode[])
                        x.k && out.push({ file, node: x, block: c, date: dateNum(c.k) });
                }
                else
                    out.push({ file, node: c, date: 0 });
            }
        }
    });
    return out.sort((a, b) => a.date - b.date);
}

/** The statement of one of the keys in effect at a date: the last at or before it (a faith is `religion` or `faith`). */
export function inEffect(stmts: HistStmt[], keys: string[], when: number): HistStmt | undefined
{
    let found: HistStmt | undefined;

    for (const s of stmts)
    {
        if (s.date > when)
            break;

        if (keys.includes(s.node.k!))
            found = s;
    }

    return found;
}

/** A statement's value, unquoted ('' for blocks). */
export const valueOf = (n: PNode): string => (typeof n.v === 'string' ? unquote(n.v) : '');

/** An anchor for a node (applyEdit and checkEdit read its offsets and block). */
export function anchor(text: string, n: PNode): LineSource
{
    const a: LineSource = { file: '', rel: '', line: n.line, s: n.s, e: n.e, kind: 'other', hash: '' };

    if (Array.isArray(n.v) && text.charCodeAt(n.e - 1) === 125)
        a.inner = [n.vs + 1, n.e - 1];

    return a;
}

function insert(text: string, n: PNode, where: 'after' | 'before' | 'inside', body: string): EditOutcome
{
    const req = { op: 'insert' as const, at: anchor(text, n), where, text: body };
    const out = applyEdit(text, req);
    checkEdit(text, req, out);
    return out;
}

/**
 * A statement's value replaced (`key = value`). A comment after it on its line goes too: it spoke of the old value
 * (`holder = 90104 #King Charles the Bald`).
 */
function replaceStatement(text: string, n: PNode, stmt: string): EditOutcome
{
    let e = n.e;
    const nl = text.indexOf('\n', e);
    const lineEnd = nl < 0 ? text.length : text[nl - 1] === '\r' ? nl - 1 : nl;

    if (/^[ \t]*#/.test(text.slice(e, lineEnd)))
        e = lineEnd;

    const out = { text: text.slice(0, n.s) + stmt + text.slice(e), at: n.s };

    if (scriptProblems(out.text).length > scriptProblems(text).length)
        throw new Error(`The file would not parse cleanly: ${scriptProblems(out.text)[0]}.`);

    return out;
}

/** Where a value is set: that statement (the one in effect), a dated block at `date`, or else an undated statement. */
export interface SetAt
{
    stmt?: PNode;
    date?: string;
}

/**
 * The file's text with `value` set in the entry (see SetAt) — `keys[0] = value` written, a statement of one of the
 * keys replaced keeping its key (a faith's `faith = x` stays `faith`):
 * - `stmt`: that statement is replaced — from its own date on (undated: from the start);
 * - `date`: in the entry's last block of that date (its statement of the keys replaced, else added), else a new
 *   `<date> = { }` block after the entry's last dated block up to that date (file order), else before its first later
 *   one, else at its end;
 * - neither: an undated statement after the entry's last undated one, else first in the entry.
 * No such entry in the file: a new one at its end.
 */
export function setInEntry(text: string, entry: string, keys: string[], value: string, at: SetAt): EditOutcome
{
    const stmt = `${keys[0]} = ${value}`;

    if (at.stmt)
        return replaceStatement(text, at.stmt, `${at.stmt.k} = ${value}`);

    const tops = entriesIn({ text, nodes: parse(text) }, entry);
    const top = tops[tops.length - 1];
    const dated = at.date ? `${at.date} = {\n\t${stmt}\n}` : undefined;

    if (!top)
    {
        const layout = layoutOf(text || '\n');
        const base = text.replace(/\s*$/, '');
        const head = base ? base + layout.eol + layout.eol : '';
        return { text: head + reindent(`${entry} = {\n\t${(dated ?? stmt).replace(/\n/g, '\n\t')}\n}`, '', layout, false) + layout.eol, at: head.length };
    }

    const kids = (top.v as PNode[]).filter((c) => c.k);

    if (at.date && dated)
    {
        const when = dateNum(at.date);
        const same = kids.filter((c) => isDated(c) && dateNum(c.k!) === when).pop();

        if (same)
        {
            const old = (same.v as PNode[]).filter((c) => keys.includes(c.k!)).pop();
            return old ? replaceStatement(text, old, `${old.k} = ${value}`) : insert(text, same, 'inside', stmt);
        }

        const before = kids.filter((c) => isDated(c) && dateNum(c.k!) < when).pop();

        if (before)
            return insert(text, before, 'after', dated);

        const after = kids.find((c) => isDated(c));

        if (after)
            return insert(text, after, 'before', dated);

        return insert(text, top, 'inside', dated);
    }

    const undated = kids.filter((c) => !isDated(c)).pop();

    if (undated)
        return insert(text, undated, 'after', stmt);

    return kids.length ? insert(text, kids[0], 'before', stmt) : insert(text, top, 'inside', stmt);
}

/** The 1-based line of an offset. */
export function lineOf(text: string, off: number): number
{
    let n = 1;

    for (let i = text.indexOf('\n'); i >= 0 && i < off; i = text.indexOf('\n', i + 1))
        n++;

    return n;
}
