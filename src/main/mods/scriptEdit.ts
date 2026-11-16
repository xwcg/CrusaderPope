/**
 * Editing the active mod in place (docs/mods.md, "Editing in place"): replace, remove or insert statements of its
 * script files at the anchors the readable view's lines carry (Line.src: the statement's offsets in the file's text as
 * indexed, and the text's checksum).
 *
 * Every edit is checked before anything is written: only script files of the active editable mod (never the game,
 * other mods or zips); the statement must be found where the anchor says, or (the file changed elsewhere since)
 * again by its own text (`locate`); the new text must parse without new problems and the edited definition's braces
 * balance. The file is changed only in the edited range: its byte order mark, line endings and indentation style
 * stay. Written atomically (edit.ts `write`: formatted, recorded as an undo step, undo.ts), announced to the folder
 * watcher, then handed to the index (`ModsHost.refreshFiles`). Plain Node (scripts use it too); IPC: ./ipc.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { EntityDetail, FireRequest, LineSource, ScriptEditRequest, ScriptEditResult, ScriptText } from '../../shared/api.ts';
import { Lexer, parse, TK_EOF, TK_LBRACE, TK_OP, TK_RBRACE, TK_STR, type PNode, type Token } from '../indexer/parser.ts';
import { parseLocalization } from '../indexer/localization.ts';
import { eolOf, nonSpaceCounts, stmtMatch, textHash, topLevelAt } from '../indexer/override.ts';
import { activeMod, fileTag, formatted, isProvenance, modPath, write, type Active } from './edit.ts';
import { change, describeChange } from './undo.ts';
import { createEntries } from './create.ts';
import { mapRange, trailOf, type Splice, type TrailEntry } from './textTrail.ts';
import { isCodeComment, lostComments, mapPosition } from '../../shared/scriptFormat.ts';
import { bareField } from '../../shared/fieldCatalog.ts';
import type { ModsHost } from './manager.ts';

import { tr, trn } from '../../shared/i18n.ts';
// ---------------------------------------------------------------------------
// The text operations (pure: the check script runs them on strings)
// ---------------------------------------------------------------------------

/** How a file is written: its line ends and one level of indentation (a tab, or the spaces it indents with). */
export interface Layout
{
    eol: '\n' | '\r\n';
    unit: string;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

export function layoutOf(text: string): Layout
{
    let tabs = 0;
    let spaces = 0;
    let width = 0;

    for (const m of text.matchAll(/^([ \t]+)\S/gm))
    {
        if (m[1].charCodeAt(0) === 9)
            tabs++;
        else
        {
            spaces++;
            width = gcd(width, m[1].length);
        }
    }

    return { eol: eolOf(text), unit: tabs >= spaces ? '\t' : ' '.repeat(width >= 2 && width <= 8 ? width : 4) };
}

function lineStartAt(text: string, pos: number): number
{
    return text.lastIndexOf('\n', pos - 1) + 1;
}

/** The offset of the line break ending the line holding `pos` (its `\n`), or the text's end. */
function lineEndAt(text: string, pos: number): number
{
    const nl = text.indexOf('\n', pos);
    return nl < 0 ? text.length : nl;
}

/** Leading whitespace of the line holding `pos`. */
function indentOf(text: string, pos: number): string
{
    const ls = lineStartAt(text, pos);
    let i = ls;

    while (i < text.length && (text[i] === ' ' || text[i] === '\t'))
        i++;

    return text.slice(ls, i);
}

const blank = (s: string): boolean => /^[ \t]*$/.test(s);

/** Only whitespace, or a comment, from `pos` to the end of its line. */
function restIsBlank(text: string, pos: number): boolean
{
    const rest = text.slice(pos, lineEndAt(text, pos)).trim();
    return rest === '' || rest.startsWith('#');
}

/** The line before the one starting at `ls`: [start, end) without its line break; undefined at the text's start. */
function lineBefore(text: string, ls: number): { s: number; e: number; } | undefined
{
    if (ls <= 0)
        return undefined;

    let e = ls - 1;

    if (e > 0 && text[e - 1] === '\r')
        e--;

    return { s: lineStartAt(text, e), e };
}

/**
 * Script text as the file writes it: the relative indentation of its lines kept (tabs, or `unit`-wide runs of
 * spaces, count as levels), `base` in front of every line (but the first when `inline`: it continues a line),
 * and the file's line ends.
 */
export function reindent(text: string, base: string, layout: Layout, inline: boolean): string
{
    const lines = text.replace(/\r\n?/g, '\n').split('\n');

    while (lines.length && !lines[0].trim())
        lines.shift();

    while (lines.length && !lines[lines.length - 1].trim())
        lines.pop();

    const width = layout.unit === '\t' ? 4 : layout.unit.length;
    const level = (l: string): number =>
    {
        let n = 0;
        let sp = 0;

        for (let i = 0; i < l.length; i++)
        {
            const c = l[i];

            if (c === '\t')
            {
                n++;
                sp = 0;
            }
            else if (c === ' ')
            {
                if (++sp === width)
                {
                    n++;
                    sp = 0;
                }
            }
            else
                break;
        }

        return n;
    };
    const levels = lines.map((l) => (l.trim() ? level(l) : -1));
    const min = Math.min(...levels.filter((x) => x >= 0));
    return lines
        .map((l, i) => (levels[i] < 0 ? '' : (i === 0 && inline ? '' : base) + layout.unit.repeat(levels[i] - min) + l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')))
        .join(layout.eol);
}

// (commented-out script, not words about a statement: shared with the picker's Change path, scriptFormat keepWritten)
export { isCodeComment };

/**
 * Where the comment lines describing a statement start: the comment lines directly above it (no blank line between,
 * at most 40, like doc comments), up to the first one that is commented-out script (it and what is above it stay);
 * the statement's line when there are none. (The picker's Change path reads them the same way: scriptFormat.ts
 * unitsOf.)
 */
export function docStart(text: string, s: number): number
{
    const ls = lineStartAt(text, s);

    if (!blank(text.slice(ls, s)))
        return s;

    let from = ls;

    for (let n = 0; n < 40; n++)
    {
        const prev = lineBefore(text, from);

        if (!prev)
            break;

        const line = text.slice(prev.s, prev.e);

        if (!line.trim().startsWith('#') || isCodeComment(line))
            break;

        from = prev.s;
    }

    return from;
}

/**
 * What removing a statement at [s, e) takes along: on a line of its own, the whole line(s), a comment after it on
 * the line and the comment lines directly above it that describe it (docStart: no blank line between, not
 * commented-out script) included; sharing its line, the statement and the space next to it.
 */
function removalRange(text: string, s: number, e: number): [number, number]
{
    const ls = lineStartAt(text, s);
    const first = blank(text.slice(ls, s));

    if (first && restIsBlank(text, e))
    {
        let from = docStart(text, s);
        let to = lineEndAt(text, e);

        if (to < text.length)
        {
            to++;
            // between two blank lines: one of them goes too
            const above = lineBefore(text, from);
            const next = lineEndAt(text, to);

            if ((!above || !text.slice(above.s, above.e).trim()) && to < text.length && !text.slice(to, next).trim())
                to = Math.min(next + 1, text.length);
        }
        else if (from > 0)
        {
            // the file's last line (no line break after it): the break before goes instead
            from--;

            if (from > 0 && text[from - 1] === '\r')
                from--;
        }

        return [from, to];
    }

    if (first)
    {
        let to = e;

        while (to < text.length && (text[to] === ' ' || text[to] === '\t'))
            to++;

        return [s, to];
    }

    let from = s;

    while (from > ls && (text[from - 1] === ' ' || text[from - 1] === '\t'))
        from--;

    return [from, e];
}

/**
 * Where an overrides file's provenance comment (`# key … copied from …`, edit.ts) of a definition starting its
 * line at `from` begins: one blank line above it, with the blank line before it; `from` when there is none.
 */
function provenanceStart(text: string, from: number, key: string): number
{
    const gap = lineBefore(text, from);

    if (!gap || text.slice(gap.s, gap.e).trim())
        return from;

    const prov = lineBefore(text, gap.s);

    if (!prov)
        return from;

    const line = text.slice(prov.s, prov.e).trim();

    // (edit.ts's provenance text, a tr() text: found by its words in the app's language, or in English; the key a word
    // of it wherever the translation puts it)
    if (!line.startsWith('#') || !line.split(/[^\w.-]+/).includes(key) || !isProvenance(line.slice(1).trim()))
        return from;

    const sep = lineBefore(text, prov.s);
    return sep && !text.slice(sep.s, sep.e).trim() ? sep.s : prov.s;
}

/** The first line inside a block (between `open` and `close`) with a statement: its indentation. */
function childIndent(text: string, open: number, close: number): string | undefined
{
    let pos = lineEndAt(text, open) + 1;
    let comment: string | undefined;

    while (pos < close)
    {
        const end = Math.min(lineEndAt(text, pos), close);
        const line = text.slice(pos, end);
        const t = line.trim();

        if (t && !t.startsWith('#'))
            return indentOf(text, pos);

        if (t && comment === undefined)
            comment = indentOf(text, pos);

        pos = end + 1;
    }

    return comment;
}

export interface EditOutcome
{
    text: string;
    /** where the changed statement starts in the new text (removed: where it was) */
    at: number;
    /** the one range of the text before it changed (absent: several, a swap): the file's trail keeps it (textTrail.ts) */
    span?: Splice;
}

/** An edit that replaces [from, to) of a text with `ins`. */
function spliced(text: string, from: number, to: number, ins: string, at: number): EditOutcome
{
    return { text: text.slice(0, from) + ins + text.slice(to), at, span: { p: from, oldEnd: to, newEnd: from + ins.length } };
}

/**
 * The file's text with an edit applied (req.at's offsets are into `text`, the file's text without a byte order mark).
 * Throws when the edit can't be made (nothing to add, no block to add into).
 */
export function applyEdit(text: string, req: ScriptEditRequest): EditOutcome
{
    const layout = layoutOf(text);
    const { eol, unit } = layout;
    const { s } = req.at;
    let { e } = req.at;
    const body = req.text ?? '';

    // (after an if / else_if its else goes first: the new statement follows the whole chain; an else itself goes after
    // the chain's else_ifs, and there is only one)
    const bodyKey = req.op === 'insert' && (req.where ?? 'after') === 'after' ? parse(body)[0]?.k ?? '' : undefined;

    if (bodyKey !== undefined && !ELSE_KEY.test(bodyKey))
        e = chainEnd(text, s, e);
    else if (bodyKey === 'else' || bodyKey === 'trigger_else')
        e = chainEnd(text, s, e, true);

    if (req.op === 'remove' || (req.op === 'replace' && !body.trim()))
    {
        const [from, to] = removalRange(text, s, e);
        return spliced(text, from, to, '', from);
    }

    if (req.op === 'removeDef')
    {
        const ast = parse(text);
        const top = topLevelAt(ast, s);

        if (!top)
            throw new Error(tr('The definition was not found in the file.'));

        // an events file's `scripted_effect x = { }`: the keyword is a node of its own
        const next = ast[ast.indexOf(top) + 1];
        const local = top.k === null && (top.v === 'scripted_effect' || top.v === 'scripted_trigger') && next?.k;
        const key = local ? next.k! : (top.k ?? '');
        let [from, to] = removalRange(text, top.s, local ? next.e : top.e);
        // (whole lines when it stands alone: then also its provenance comment of an overrides file)
        const whole = from === lineStartAt(text, from) && (to === text.length || text[to - 1] === '\n');

        if (whole)
            from = provenanceStart(text, from, key);

        return spliced(text, from, to, '', from);
    }

    if (req.op === 'swap')
    {
        const o = req.with;

        if (!o || o.file !== req.at.file)
            throw new Error(tr('Nothing to swap with.'));

        const [x, y] = s < o.s ? [req.at, o] : [o, req.at];

        if (x.e > y.s)
            throw new Error(tr('The statements overlap.'));

        return { text: text.slice(0, x.s) + text.slice(y.s, y.e) + text.slice(x.e, y.s) + text.slice(x.s, x.e) + text.slice(y.e), at: x.s };
    }

    // (a list's item becoming a statement of its own: written after the list, the item removed; the list's `}` comes
    // after the item, so inserting first keeps the item's offsets)
    if (req.op === 'replace' && req.outside && body.trim())
    {
        const holder = holderOf(parse(text), s, e);

        if (!holder)
            throw new Error(tr('The statement is not inside a block.'));

        const added = applyEdit(text, { ...req, op: 'insert', where: 'after', outside: undefined, at: { ...req.at, s: holder.s, e: holder.e, inner: undefined } });
        const [from, to] = removalRange(added.text, s, e);
        return { text: added.text.slice(0, from) + added.text.slice(to), at: added.at - (to - from) };
    }

    if (req.op === 'replace')
    {
        // (another statement in its place: on its own line(s), the comment lines directly above the old one and the comment
        // after it on its line are about it and go along (as a removal takes them); sharing its line, only the statement)
        if (req.withComments && blank(text.slice(lineStartAt(text, s), s)) && restIsBlank(text, e))
        {
            const base = indentOf(text, s);
            const from = docStart(text, s);
            let to = lineEndAt(text, e);

            if (to > from && text[to - 1] === '\r')
                to--;

            return spliced(text, from, to, base + reindent(body, base, layout, true), from + base.length);
        }

        return spliced(text, s, e, reindent(body, indentOf(text, s), layout, true), s);
    }

    if (req.op !== 'insert')
        throw new Error(tr('Unknown edit: ') + String(req.op));

    if (!body.trim())
        throw new Error(tr('Nothing to add.'));

    const block = req.wrap
        ? `${req.wrap} = {\n${
            body
                .replace(/\r\n?/g, '\n')
                .split('\n')
                .map((l) => (l.trim() ? '\t' + l : l))
                .join('\n')
        }\n}`
        : body;
    const multi = block.trim().includes('\n');
    const ls = lineStartAt(text, s);
    const firstOnLine = blank(text.slice(ls, s));
    const where = req.where ?? 'after';

    if (where === 'inside')
    {
        if (!req.at.inner)
            throw new Error(tr('This statement has no block to add to.'));

        const [open, close] = req.at.inner;
        const blockIndent = indentOf(text, s);
        const kids = childIndent(text, open, close) ?? blockIndent + unit;
        const closeLs = lineStartAt(text, close);

        if (closeLs > open && blank(text.slice(closeLs, close)))
        {
            // `}` on a line of its own: the new lines go right before it
            return spliced(text, closeLs, closeLs, reindent(block, kids, layout, false) + eol, closeLs + kids.length);
        }

        if (!text.slice(open, close).trim())
        {
            // an empty block `x = { }` opens up
            return spliced(text, open, close, eol + reindent(block, kids, layout, false) + eol + blockIndent, open + eol.length + kids.length);
        }

        // a one-liner `limit = { a = yes }`: a short statement joins it, a longer one opens it up
        let p = close;

        while (p > open && (text[p - 1] === ' ' || text[p - 1] === '\t'))
            p--;

        if (!multi)
            return spliced(text, p, p, ' ' + reindent(block, '', layout, true), p + 1);

        return spliced(text, p, close, eol + reindent(block, kids, layout, false) + eol + blockIndent, p + eol.length + kids.length);
    }

    if (where === 'before')
    {
        if (firstOnLine)
        {
            // before the comment lines that belong to the statement
            const pos = docStart(text, s);
            const base = indentOf(text, s);
            return spliced(text, pos, pos, reindent(block, base, layout, false) + eol, pos + base.length);
        }

        if (!multi)
            return spliced(text, s, s, reindent(block, '', layout, true) + ' ', s);

        const base = indentOf(text, s) + unit;
        return spliced(text, s, s, reindent(block, base, layout, true) + eol + base, s);
    }

    // after the statement
    if (restIsBlank(text, e))
    {
        const base = firstOnLine ? indentOf(text, s) : indentOf(text, s) + unit;
        const end = lineEndAt(text, e);
        const lines = reindent(block, base, layout, false);

        if (end < text.length)
            return spliced(text, end + 1, end + 1, lines + eol, end + 1 + base.length);

        return spliced(text, text.length, text.length, eol + lines, text.length + eol.length + base.length);
    }

    if (!multi)
        return spliced(text, e, e, ' ' + reindent(block, '', layout, true), e + 1);

    const base = firstOnLine ? indentOf(text, s) : indentOf(text, s) + unit;
    let to = e;

    while (to < text.length && (text[to] === ' ' || text[to] === '\t'))
        to++;

    return spliced(text, e, to, eol + base + reindent(block, base, layout, true) + eol + base, e + eol.length + base.length);
}

/**
 * Problems a text has as script, beyond what the tolerant parser silently repairs: braces that close nothing or are
 * never closed, operators without a key or a value, unclosed quotes. An edit must not add any.
 */
export function scriptProblems(text: string): string[]
{
    const lex = new Lexer(text);
    const out: string[] = [];
    const opens: number[] = [];
    let prev: Token | undefined;

    for (;;)
    {
        const t = lex.next();

        if (t.t === TK_EOF)
            break;

        if (t.t === TK_LBRACE)
            opens.push(t.line);
        else if (t.t === TK_RBRACE)
        {
            if (prev?.t === TK_OP)
                out.push(tr('line {line}: nothing after “{text}”', { line: t.line, text: prev.text }));

            if (opens.pop() === undefined)
                out.push(`line ${t.line}: a “}” that closes nothing`);
        }
        else if (t.t === TK_OP)
        {
            if (prev?.t === TK_OP)
                out.push(tr('line {line}: two operators in a row', { line: t.line }));
            else if (prev?.t !== TK_STR)
                out.push(tr('line {line}: “{text}” without a key', { line: t.line, text: t.text }));
        }
        else if (t.t === TK_STR && t.q && (t.e - t.s < 2 || text.charCodeAt(t.e - 1) !== 34))
            out.push(tr('line {line}: a quote that is never closed', { line: t.line }));

        prev = t;
    }

    if (prev?.t === TK_OP)
        out.push(tr('line {line}: nothing after “{text}” at the end', { line: prev.line, text: prev.text }));

    for (const l of opens)
        out.push(`line ${l}: a “{” that is never closed`);

    return out;
}

/** else / else_if (trigger_else …): they belong to the if right before them */
const ELSE_KEY = /^(else|else_if|trigger_else|trigger_else_if)$/;
/** what an else may follow */
const IF_KEY = /^(if|else_if|trigger_if|trigger_else_if)$/;

/** The siblings of the statement at [s, e) and its index among them. */
function siblingsAt(nodes: PNode[], s: number, e: number): { list: PNode[]; i: number; } | undefined
{
    for (let i = 0; i < nodes.length; i++)
    {
        const n = nodes[i];

        if (n.s === s && n.e === e)
            return { list: nodes, i };

        if (n.s <= s && e <= n.e && Array.isArray(n.v))
            return siblingsAt(n.v, s, e);
    }

    return undefined;
}

/**
 * Where the if / else chain of the statement at [s, e) ends (its last else); `e` when none follows it. `beforeElse`:
 * where an else goes (after the last else_if); refused when the chain has its else already.
 */
function chainEnd(text: string, s: number, e: number, beforeElse = false): number
{
    const at = siblingsAt(parse(text), s, e);

    if (!at)
        return e;

    let i = at.i;

    while (i + 1 < at.list.length && IF_KEY.test(at.list[i].k ?? '') && ELSE_KEY.test(at.list[i + 1].k ?? ''))
    {
        if (beforeElse && !IF_KEY.test(at.list[i + 1].k ?? ''))
            throw new Error(tr('This if has an else already.'));

        i++;
    }

    return at.list[i].e;
}

/** Lines of else / else_if (trigger_else …) that do not directly follow an if / else_if: the game can't read them. */
export function orphanElses(nodes: PNode[], out: number[] = []): number[]
{
    nodes.forEach((n, i) =>
    {
        const prev = nodes[i - 1]?.k ?? '';

        if (n.k && ELSE_KEY.test(n.k) && !(IF_KEY.test(prev) && prev.startsWith('trigger_') === n.k.startsWith('trigger_')))
            out.push(n.line);

        if (Array.isArray(n.v))
            orphanElses(n.v, out);
    });
    return out;
}

/** The statement written at exactly [s, e): one node, or a run of siblings (`scripted_effect x = { }`). */
/** The block statement whose block holds the statement at [s, e) directly (a list holding its item). */
function holderOf(nodes: PNode[], s: number, e: number, parent?: PNode): PNode | undefined
{
    for (const n of nodes)
    {
        if (n.s <= s && e <= n.e && Array.isArray(n.v))
        {
            if (n.s === s && n.e === e)
                return parent;

            return holderOf(n.v, s, e, n);
        }

        if (n.s === s && n.e === e)
            return parent;
    }

    return undefined;
}

function statementAt(nodes: PNode[], s: number, e: number): PNode | undefined
{
    for (let i = 0; i < nodes.length; i++)
    {
        const n = nodes[i];

        if (n.s === s)
        {
            for (let j = i; j < nodes.length && nodes[j].e <= e; j++)
                if (nodes[j].e === e)
                    return n;

            if (Array.isArray(n.v) && e <= n.e)
                return statementAt(n.v, s, e);

            return undefined;
        }

        if (n.s < s && e <= n.e && Array.isArray(n.v))
            return statementAt(n.v, s, e);

        if (n.s > s)
            return undefined;
    }

    return undefined;
}

/** A statement node spanning [s, e): a node, or a run `scripted_effect x = { }` (the keyword is a node of its own). */
interface Span
{
    s: number;
    e: number;
    node: PNode;
}

/** Every statement of a parsed text, at any depth, with the runs of local definitions. */
function spans(nodes: PNode[], out: Span[] = []): Span[]
{
    for (let i = 0; i < nodes.length; i++)
    {
        const n = nodes[i];
        out.push({ s: n.s, e: n.e, node: n });
        const next = nodes[i + 1];

        if (n.k === null && (n.v === 'scripted_effect' || n.v === 'scripted_trigger') && next?.k)
            out.push({ s: n.s, e: next.e, node: next });

        if (Array.isArray(n.v))
            spans(n.v, out);
    }

    return out;
}

/**
 * Runs of two or more neighbouring statements whose text without whitespace is `n` long (`k`: the text's prefix counts):
 * the candidates for an anchor that spans several statements (a title change's create, change and resolve, one line).
 */
function runs(nodes: PNode[], k: Int32Array, n: number, out: Span[] = []): Span[]
{
    for (let i = 0; i < nodes.length; i++)
    {
        for (let j = i + 1; j < nodes.length; j++)
        {
            const len = k[nodes[j].e] - k[nodes[i].s];

            if (len > n)
                break;

            if (len === n)
                out.push({ s: nodes[i].s, e: nodes[j].e, node: nodes[j] });
        }

        const kids = nodes[i].v;

        if (Array.isArray(kids))
            runs(kids, k, n, out);
    }

    return out;
}

/**
 * The anchor's statement in the file's current text (docs/mods.md, "Editing in place"): where the anchor says while
 * the file is the text it was made from (its checksum); else, when the app's own writes since lead from that text to
 * this one (`trail`, textTrail.ts), where they moved it (`viaTrail`); else (another editor, an undo, a write the
 * trail lost) found again by its own text and the text around it (`stmt`, whitespace left out), so changes elsewhere
 * in the file don't block it. Of several statements written the same, the one with the same text around it (then the
 * one still at the anchor's place). Throws when the statement itself changed, is gone, or can't be told apart from
 * another one.
 */
export function locate(text: string, at: LineSource, ast: PNode[] = parse(text), trail?: readonly TrailEntry[]): LineSource
{
    const stale = (): Error => new Error(tr('{rel}: the statement at line {line} changed since the explorer read it — wait until the index has taken the change in (or re-index), then try again.', { rel: at.rel, line: at.line }));
    const hash = textHash(text);

    if (hash === at.hash)
    {
        if (!statementAt(ast, at.s, at.e))
            throw new Error(tr('{rel}: the statement is not where it was (line {line}) — the file changed since the explorer read it.', { rel: at.rel, line: at.line }));

        return at;
    }

    const traced = trail?.length ? viaTrail(text, at, ast, trail, hash, stale) : undefined;
    return traced ?? byOwnText(text, at, ast, hash, stale);
}

/**
 * The anchor's statement found by its own text (`stmt`) among the statements of the current parse, all of them or
 * those inside [lo, hi) (`viaTrail`: the range an edit replaced it in); see `locate`.
 */
function byOwnText(text: string, at: LineSource, ast: PNode[], hash: string, stale: () => Error, lo = 0, hi = text.length): LineSource
{
    const c = at.stmt;

    if (!c)
        throw new Error(tr('{rel} changed since the explorer read it — wait until the index has taken the change in (or re-index), then try again.', { rel: at.rel }));

    let best: Span[] = [];
    let score = -1;
    // (its length without whitespace first: prefix counts)
    const k = nonSpaceCounts(text);

    // (a statement, or a run of neighbouring ones for an anchor that spans several: a title change's create … resolve)
    for (const x of [...spans(ast), ...runs(ast, k, c.n)])
    {
        if (x.s < lo || x.e > hi || k[x.e] - k[x.s] !== c.n)
            continue;

        const m = stmtMatch(text, x.s, x.e, c);

        if (m > score)
        {
            best = [x];
            score = m;
        }
        else if (m === score && m >= 0)
            best.push(x);
    }

    const hit = best.length === 1 ? best[0] : best.find((x) => x.s === at.s && x.e === at.e);

    if (!hit)
        throw stale();

    const n = hit.node;
    const moved: LineSource = { ...at, s: hit.s, e: hit.e, line: lineAt(text, hit.s), hash };

    // (its block: the braces of the node found; re-spacing may have moved them within the statement)
    if (at.inner)
    {
        if (!Array.isArray(n.v) || text.charCodeAt(n.e - 1) !== 125)
            throw stale();

        moved.inner = [n.vs + 1, n.e - 1];
    }

    return moved;
}

/** The one statement written at exactly [s, e) (a node, or the run `scripted_effect x = { }`: its block's node). */
function spanAt(nodes: PNode[], s: number, e: number): PNode | undefined
{
    for (let i = 0; i < nodes.length; i++)
    {
        const n = nodes[i];

        if (n.s === s)
        {
            if (n.e === e)
                return n;

            const next = nodes[i + 1];
            return n.k === null && (n.v === 'scripted_effect' || n.v === 'scripted_trigger') && next?.k && next.e === e ? next : undefined;
        }

        if (n.s < s && e <= n.e && Array.isArray(n.v))
            return spanAt(n.v, s, e);

        if (n.s > s)
            return undefined;
    }

    return undefined;
}

/** Where a statement's first word (its key) ends: the first whitespace, operator or brace. */
function keyEnd(text: string, s: number): number
{
    let i = s;

    while (i < text.length)
    {
        const c = text.charCodeAt(i);

        // (whitespace, = < > ! ? { })
        if (c <= 32 || c === 61 || c === 60 || c === 62 || c === 33 || c === 63 || c === 123 || c === 125)
            break;

        i++;
    }

    return i;
}

/**
 * An anchor made from an older text of the file, mapped through the app's writes since (textTrail.ts `mapRange`), when
 * the mapped range holds up in the current text: a statement there (a statement the writes did not touch: its own
 * text too, `stmt`); one a write changed inside (a block that got a line) must be a block (its anchor has `inner`) with
 * the same key, its braces at its ends. Throws `stale` when an edit replaced or removed the statement, changed it at
 * its edge, or changed inside one without a block (its text elsewhere would be another statement: a twin). One that
 * lay inside a range an edit replaced (a definition saved whole, a statement wrapped in a block, or the replaced
 * statement itself) is looked for by its own text inside that range only: there it is the same statement, outside it
 * would be a twin (refused when it is not inside). Undefined (its own text decides, as for another editor's change)
 * when the chain is broken or the change's range was taken from the texts (it may have been next to the statement).
 */
function viaTrail(text: string, at: LineSource, ast: PNode[], trail: readonly TrailEntry[], hash: string, stale: () => Error): LineSource | undefined
{
    const m = mapRange(trail, at.hash, hash, at.s, at.e);

    if (m !== 'touched' && m?.within)
        return byOwnText(text, at, ast, hash, stale, m.s, m.e);

    if (m === 'touched' || (m?.grew && !at.inner && !m.guessed))
        throw stale();

    if (!m || m.s < 0 || m.e > text.length)
        return undefined;

    const one = spanAt(ast, m.s, m.e);

    if (m.grew)
    {
        // (the key and the character after it were before every change: the same statement, grown)
        if (!at.inner || !one || keyEnd(text, m.s) - m.s >= m.room)
            return undefined;
    }
    else if (!statementAt(ast, m.s, m.e) || (at.stmt && stmtMatch(text, m.s, m.e, at.stmt) < 0))
        return undefined;

    const moved: LineSource = { ...at, s: m.s, e: m.e, line: lineAt(text, m.s), hash };

    if (at.inner)
    {
        if (!one || !Array.isArray(one.v) || text.charCodeAt(one.e - 1) !== 125)
            return undefined;

        moved.inner = [one.vs + 1, one.e - 1];
    }

    return moved;
}

/**
 * Whether an edit may be made to `text` (the file's current text): the anchor's statement must be there as the
 * anchor says (`locate` found it); the edited text must parse without new problems, the new statements alone must be
 * well-formed and the edited definition's braces balance. Throws with the reason.
 */
export function checkEdit(text: string, req: ScriptEditRequest, out: EditOutcome): void
{
    const { at } = req;
    const ast = parse(text);

    if (!statementAt(ast, at.s, at.e))
        throw new Error(tr('{rel}: the statement is not where it was (line {line}) — the file changed since the explorer read it.', { rel: at.rel, line: at.line }));

    if (req.op === 'swap' && (!req.with || !statementAt(ast, req.with.s, req.with.e)))
        throw new Error(tr('{rel}: the other statement is not where it was — the file changed since the explorer read it.', { rel: at.rel }));

    if (req.op === 'insert' && req.where === 'inside')
    {
        const inner = at.inner;

        if (!inner || text.charCodeAt(inner[0] - 1) !== 123 || text.charCodeAt(inner[1]) !== 125 || inner[0] < at.s || inner[1] >= at.e)
            throw new Error(tr('{rel}: the block at line {line} is not where it was.', { rel: at.rel, line: at.line }));
    }

    const body = req.text ?? '';

    if ((req.op === 'insert' || req.op === 'replace') && body.trim())
    {
        const own = scriptProblems(body);

        if (own.length)
            throw new Error(tr('The script is not complete: {join}.', { join: own.slice(0, 3).join('; ') }));

        const nodes = parse(body);

        // (a list's items are values alone: `opposites = { craven }`)
        if (at.kind !== 'other' && !(at.kind === 'field' && at.fields && bareField(at.fields)) && !nodes.some((n) => n.k))
            throw new Error(tr('That is no statement (key = value).'));
    }

    // (an else / else_if right after its if: an edit may not separate them, nor put an else after an else)
    const orphans = orphanElses(parse(out.text));

    if (orphans.length > orphanElses(ast).length)
        throw new Error(tr('An “else” would not follow its “if” any more (line {orphans}) — an else / else_if must come right after the if / else_if it belongs to. Change or remove the “Otherwise” parts first, or edit them together in the script editor (Shift+Enter).', { orphans: orphans[orphans.length - 1] }));

    const before = scriptProblems(text);
    const after = scriptProblems(out.text);

    if (after.length > before.length)
    {
        const added = after.filter((p) => !before.includes(p));
        throw new Error(tr('The file would not parse cleanly: {join}.', { join: (added.length ? added : after).slice(0, 3).join('; ') }));
    }

    if (req.op === 'removeDef')
        return;

    // the edited definition: its braces balance as before
    const oldTop = topLevelAt(ast, at.s);
    const newTop = topLevelAt(parse(out.text), out.at);
    const count = (t: string, n?: PNode): number => (n ? scriptProblems(t.slice(n.s, n.e)).length : 0);

    if (newTop && count(out.text, newTop) > count(text, oldTop))
        throw new Error(tr('The edited definition ({value}) would not be balanced: {join}.', { value: newTop.k ?? '?', join: scriptProblems(out.text.slice(newTop.s, newTop.e)).slice(0, 2).join('; ') }));
}

export function lineAt(text: string, off: number): number
{
    let n = 1;

    for (let i = text.indexOf('\n'); i >= 0 && i < off; i = text.indexOf('\n', i + 1))
        n++;

    return n;
}

// ---------------------------------------------------------------------------
// Files of the active mod
// ---------------------------------------------------------------------------

const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** The active mod's file an anchor names, or why it may not be edited here. */
function modFile(a: Active, at: LineSource): string
{
    if (!at.mod || at.mod.toLowerCase() !== a.mod.id.toLowerCase())
        throw new Error(tr('{rel} is {value} file, not {name}’s — override the entry in {name} to edit it.', { rel: at.rel, value: at.mod ? 'another mod’s' : 'the game’s', name: a.mod.name }));

    if (!/\.txt$/i.test(at.rel) && !isLocFile(at.rel))
        throw new Error(tr('{rel}: only script files (.txt) and localization files (localization/….yml) are edited in place.', { rel: at.rel }));

    const abs = resolve(a.root, ...at.rel.split('/'));
    const r = relative(a.root, abs);

    if (!r || r.startsWith('..') || isAbsolute(r))
        throw new Error(tr('{rel} is not a path inside the mod folder.', { rel: at.rel }));

    if (!samePath(resolve(at.file), abs))
        throw new Error(tr('{file} is not {name}’s {rel}.', { file: at.file, name: a.mod.name, rel: at.rel }));

    if (!existsSync(abs) || !statSync(abs).isFile())
        throw new Error(tr('{rel} is not in {name} any more.', { rel: at.rel, name: a.mod.name }));

    return abs;
}

/** A localization file of a mod (`localization/<lang>/….yml`): its entries are edited line by line. */
const isLocFile = (rel: string): boolean => /^localization\/.+\.yml$/i.test(rel);

/** The entries of a localization file's text: each key's line from the key to the line's end (a comment after it too). */
function locLines(text: string): { key: string; s: number; e: number; line: number; }[]
{
    return parseLocalization(text).entries.map((en) =>
    {
        let e = text.indexOf('\n', en.off);

        if (e < 0)
            e = text.length;

        if (text.charCodeAt(e - 1) === 13)
            e--;

        return { key: en.key, s: en.off, e, line: en.line };
    });
}

/**
 * A localization entry's line in the file's current text: where the anchor says while the file is the text it was made
 * from; else found again by its own checks (`stmt`: the line without whitespace, the text around it), as `locate`
 * finds statements. Throws when the line itself changed or is gone.
 */
export function locateLoc(text: string, at: LineSource): LineSource
{
    const lines = locLines(text);

    if (textHash(text) === at.hash)
    {
        if (!lines.some((l) => l.s === at.s && l.e === at.e))
            throw new Error(tr('{rel}: the text is not where it was (line {line}) — the file changed since the explorer read it.', { rel: at.rel, line: at.line }));

        return at;
    }

    const c = at.stmt;
    const scored = c ? lines.map((l) => ({ l, m: stmtMatch(text, l.s, l.e, c) })).filter((x) => x.m >= 0) : [];
    const top = Math.max(-1, ...scored.map((x) => x.m));
    const best = scored.filter((x) => x.m === top);
    const hit = best.length === 1 ? best[0].l : best.find((x) => x.l.s === at.s)?.l;

    if (!hit)
        throw new Error(tr('{rel}: the text at line {line} changed since the explorer read it — wait until the index has taken the change in (or re-index), then try again.', { rel: at.rel, line: at.line }));

    return { ...at, s: hit.s, e: hit.e, line: hit.line, hash: textHash(text) };
}

/**
 * An edit of a localization entry's line (the Source tab's editor on a key of the mod): replace (the new text must be
 * one entry line ` key:0 "text"` (a comment after it may stay) of the same key), or remove its line. The file keeps
 * its `l_<lang>:` header and every other line as they are.
 */
export function editLocLine(text: string, req: ScriptEditRequest): { text: string; line: number; }
{
    const at = locateLoc(text, req.at);
    const key = text.slice(at.s, text.indexOf(':', at.s));
    const body = (req.text ?? '').trim();

    if (req.op === 'remove' || req.op === 'removeDef' || (req.op === 'replace' && !body))
    {
        const ls = text.lastIndexOf('\n', at.s - 1) + 1;
        const nl = text.indexOf('\n', at.e);
        return { text: text.slice(0, ls) + text.slice(nl < 0 ? text.length : nl + 1), line: at.line };
    }

    if (req.op !== 'replace')
        throw new Error(tr('A localization line is changed or removed here — a new key goes in with ✎ on its text.'));

    if (/[\r\n]/.test(body))
        throw new Error(tr('A localization entry is one line: {key}:0 "text" (line breaks in the text are written as \\n).', { key }));

    const m = /^(\S+?):(\d*)\s*"(.*)"\s*(#.*)?$/.exec(body);

    if (!m)
        throw new Error(tr('That is no localization line — write it as {key}:0 "text".', { key }));

    if (m[1] !== key)
        throw new Error(tr('The key must stay {key} (another key is another entry: ✎ on its text writes it).', { key }));

    return { text: text.slice(0, at.s) + body + text.slice(at.e), line: at.line };
}

/** A script file's text (without its byte order mark), refused when it is not UTF-8 (rewriting it would damage it). */
export function readScript(file: string): { text: string; bom: boolean; raw: Buffer; }
{
    const raw = readFileSync(file);
    const all = raw.toString('utf8');

    if (!Buffer.from(all, 'utf8').equals(raw))
        throw new Error(tr('{file} is not UTF-8 text — it can\'t be edited safely here.', { file }));

    const bom = all.charCodeAt(0) === 0xfeff;
    return { text: bom ? all.slice(1) : all, bom, raw };
}

export async function active(host: ModsHost): Promise<Active>
{
    const a = await activeMod(host);

    if (typeof a === 'string')
        throw new Error(a);

    return a;
}

/** Hands a written file to the index: incrementally where it can, else a re-index. */
export async function refresh(host: ModsHost, file: string): Promise<void>
{
    if (host.refreshFiles)
        await host.refreshFiles([file]);
    else
        host.reindex();
}

// ---------------------------------------------------------------------------
// Operations (IPC: mods:scriptText, mods:editScript; undo: undo.ts, mods:undo)
// ---------------------------------------------------------------------------

/** A statement's script as written, for the in-place editor (continuation lines without its own indentation). */
export async function statementText(host: ModsHost, at: LineSource): Promise<ScriptText>
{
    try
    {
        const file = modFile(await active(host), at);
        const { text } = readScript(file);

        // (a localization entry: its line as written)
        if (isLocFile(at.rel))
        {
            const l = locateLoc(text, at);
            return { text: text.slice(l.s, l.e), indent: ' ' };
        }

        const here = locate(text, at, undefined, trailOf(file));
        const base = indentOf(text, here.s);
        const lines = text.slice(here.s, here.e).split(/\r?\n/);
        const rest = lines.slice(1).map((l) => (l.startsWith(base) ? l.slice(base.length) : l.replace(/^[ \t]+/, '')));
        // (an else follows it: the picker may not wrap it or put statements between them)
        const sib = siblingsAt(parse(text), here.s, here.e);
        const next = sib?.list[sib.i + 1]?.k ?? '';
        return { text: [lines[0], ...rest].join('\n'), indent: layoutOf(text).unit, ...(ELSE_KEY.test(next) ? { elseAfter: true } : {}) };
    }
    catch (e)
    {
        return { text: '', indent: '\t', problem: (e as Error).message };
    }
}

/**
 * Makes an edit in the active mod's script (see the file comment): one undo step. `req.creates`: the entries the
 * statement needs are made first, in the same step (a picked statement's new trait …: create.ts createEntries; they may
 * go into the statement's own file: its anchor is found again, `locate`); a refused statement takes them back at once
 * (rollback: no step is left).
 */
export function editScript(host: ModsHost, req: ScriptEditRequest): Promise<ScriptEditResult>
{
    // (a loaded save's entry: the save is changed, docs/saves.md "Edits")
    if (req.at.mod?.startsWith('save:'))
        return saveEdit(host, req);

    return change(
        host,
        req.label ?? tr('Edit of {rel}:{line}', { rel: req.at.rel, line: req.at.line }),
        'edit',
        async () =>
        {
            const made = req.creates?.length ? await createEntries(host, req.creates) : undefined;
            const r = await edit(host, req);

            if (made?.notes.length)
                r.notes.push(...made.notes);

            return r;
        },
        { rollback: true }
    );
}

/**
 * An edit of a loaded save's entry: made to its generated file's text like a mod file's (located, applied, checked,
 * on the one top-level block it is in), then the index worker takes the block in and changes the save with it (refused
 * when the save can't take a part). Undone with the save's own undo; written with "Write save as".
 */
async function saveEdit(host: ModsHost, req: ScriptEditRequest): Promise<ScriptEditResult>
{
    if (req.creates?.length)
        throw new Error(tr('New entries can\'t be made in a save'));

    const text = await host.query!<string | null>('saveFileText', req.at.rel);

    if (text === null)
        throw new Error(tr('The save is no longer loaded'));

    const ast = parse(text);
    const at = locate(text, req.at, ast);
    const with_ = req.with ? locate(text, req.with, ast) : undefined;
    const top = ast.find((n) => n.k && n.s <= at.s && at.e <= n.e);

    if (!top || (with_ && (with_.s < top.s || with_.e > top.e)))
        throw new Error(tr('The change must stay inside one entry of the save'));

    const block = text.slice(top.s, top.e);
    const shift = (a: LineSource): LineSource => ({ ...a, s: a.s - top.s, e: a.e - top.s, ...(a.inner ? { inner: [a.inner[0] - top.s, a.inner[1] - top.s] as [number, number] } : {}) });
    const local: ScriptEditRequest = { ...req, at: shift(at), ...(with_ ? { with: shift(with_) } : {}) };
    const out = applyEdit(block, local);
    checkEdit(block, local, out);

    if (out.text === block)
        throw new Error(tr('Nothing changed.'));

    const label = req.label ?? tr('Changed in the save');
    const r = await host.query!<{ line: number; pending: number; changes: number; }>('saveSetBlock', req.at.rel, top.s, top.e, block, out.text, label);
    return {
        mod: { id: req.at.mod!, name: tr('Savegame') },
        save: true,
        file: req.at.file,
        rel: req.at.rel,
        line: r.line,
        undo: 0,
        notes: [tr('Changed in the loaded save ({n} not written yet) — “Write save as…” on the Save tab writes them', { n: r.pending })]
    };
}

async function edit(host: ModsHost, req: ScriptEditRequest): Promise<ScriptEditResult>
{
    const a = await active(host);
    const file = modFile(a, req.at);
    const { text, bom } = readScript(file);
    const mod = { id: a.mod.id, name: a.mod.name };

    // a localization entry's line (written with the byte order mark the game wants for localization files)
    if (isLocFile(req.at.rel))
    {
        const out = editLocLine(text, req);

        if (out.text === text)
            throw new Error(tr('Nothing changed.'));

        write(host, file, '\uFEFF' + out.text);
        describeChange({ line: out.line });
        await refresh(host, file);
        return { mod, file, rel: req.at.rel, line: out.line, undo: 0, notes: bom ? [] : [tr('The file got the byte order mark the game wants for localization files.')] };
    }

    // (where the statements are now: the file may have changed since the index read it; the app's own writes since
    // are in its trail)
    const ast = parse(text);
    const trail = trailOf(file);
    req = { ...req, at: locate(text, req.at, ast, trail), ...(req.with ? { with: locate(text, req.with, ast, trail) } : {}) };
    const fromTrack = req.fromTrack;

    // (a new named track on a trait that writes `track`: that block becomes `tracks`, its track named after the trait,
    // the new one after it; the calls are given their track below)
    if (fromTrack)
    {
        const node = statementAt(ast, req.at.s, req.at.e);

        if (!node || node.k !== 'track' || !Array.isArray(node.v))
            throw new Error(tr('The trait’s track = { … } is no longer where the card read it: open the trait again.'));

        req = { ...req, op: 'replace', where: undefined, fromTrack: undefined, text: tracksText(text, node, fromTrack, req.text ?? '', layoutOf(text).unit) };
    }

    const out = applyEdit(text, req);
    checkEdit(text, req, out);

    if (out.text === text)
        throw new Error(tr('Nothing changed.'));

    // (formatted as it is written: the line and the undo check follow the text as written; the trail keeps the
    // edit's own range, then the re-spacing)
    const done = formatted(host, file, out.text);
    write(host, file, (bom ? '﻿' : '') + done, { text: out.text, ...(out.span ? { splice: out.span } : {}) });
    const line = lineAt(done, done === out.text ? out.at : mapPosition(out.text, done, out.at));
    describeChange({ line });
    await refresh(host, file);
    // (the comments that went: only the range the edit changed is read, the rest of the file is the same)
    const sp = out.span;
    const notes = sp ? commentNotes(text.slice(sp.p, sp.oldEnd), out.text.slice(sp.p, sp.newEnd)) : commentNotes(text, out.text);

    if (fromTrack)
        notes.push(tr('{rel}: the trait’s track is now written as tracks; its first track is named {trait}, the name the game gave it, so the experience characters have in it stays.', { rel: req.at.rel, trait: fromTrack }), ...(await trackCalls(host, a, fromTrack)));

    return { mod, file, rel: req.at.rel, line, undo: 0, notes };
}

/**
 * A trait that got a second track (ScriptEditRequest.fromTrack): the mod's add_trait_xp / has_trait_xp of it without a
 * `track` get `track = <trait>` (trackCallEdits; each file written in the edit's undo step), and the notes say so and
 * name the entries outside the mod that call them too (the index's references in those statements; their files are
 * not the mod's to change).
 */
async function trackCalls(host: ModsHost, a: Active, trait: string): Promise<string[]>
{
    const notes: string[] = [];
    const files: string[] = [];
    let calls = 0;

    for (const file of modScriptFiles(a))
    {
        const { text, bom } = readScript(file);

        if (!text.includes('_trait_xp') || !text.includes(trait))
            continue;

        const edits = trackCallEdits(text, trait);

        if (!edits.length)
            continue;

        let t = text;

        for (const x of [...edits].sort((p, q) => q.s - p.s))
            t = t.slice(0, x.s) + x.text + t.slice(x.e);

        write(host, file, (bom ? '﻿' : '') + t, { text: t });
        await refresh(host, file);
        files.push(relIn(a, file));
        calls += edits.length;
    }

    if (calls)
        notes.push(tr('{n} add_trait_xp / has_trait_xp of {trait} in your mod got track = {trait} ({files}).', { n: calls, trait, files: files.join(', ') }));

    const detail = await host.query?.<EntityDetail | null>('detail', 'traits', trait);
    const own = a.mod.id.toLowerCase();
    const outside = (detail?.incoming ?? [])
        .flatMap((g) => g.items)
        .filter((i) => i.contexts.some((c) => /\b(add|has)_trait_xp\b/.test(c)) && i.mod?.mods[i.mod.mods.length - 1]?.toLowerCase() !== own);

    if (outside.length)
        notes.push(tr('Outside your mod {n} entries use add_trait_xp / has_trait_xp of {trait} and need track = {trait} now: {names}', { n: outside.length, trait, names: outside.slice(0, 8).map((i) => i.name).join(', ') + (outside.length > 8 ? ' …' : '') }));

    return notes;
}

/**
 * The change bar's note when an edit took comments out of the file (docs/mods.md, "Comments next to a statement"): a
 * removed statement's comments go with it, so does what the picker's Change path let go with a statement it removed or
 * replaced; any other edit that drops one (the script editor, a rewritten text version) is named the same way.
 */
export function commentNotes(before: string, after: string): string[]
{
    const gone = lostComments(before, after);

    if (!gone.length)
        return [];

    const list = gone.slice(0, 3).map((c) => (c.length > 60 ? c.slice(0, 59) + '…' : c)).join(' · ') + (gone.length > 3 ? ' …' : '');
    return [trn('A comment went with the removed script: {list} (Undo brings it back)', '{n} comments went with the removed script: {list} (Undo brings them back)', gone.length, { list })];
}

// ---------------------------------------------------------------------------
// Localization texts (an event's title, descriptions, option names; docs/mods.md "Editing in place")
// ---------------------------------------------------------------------------

/**
 * Changes a localization key's text in the active mod: in the mod's own line when the key's winning definition is the
 * mod's, else as an override in `localization/<lang>/replace/<mod>_l_<lang>.yml` (the replace folder wins over every
 * other loc file). The line keeps its version number and comment; line breaks become `\n`. Undoable like script edits.
 */
export function editLoc(host: ModsHost, req: { key: string; text: string; }): Promise<ScriptEditResult>
{
    return change(host, tr('Text of {key}', { key: req.key }), 'text', () => locEdit(host, req));
}

async function locEdit(host: ModsHost, req: { key: string; text: string; }): Promise<ScriptEditResult>
{
    const a = await active(host);
    const key = req.key.trim();

    if (!/^[\w.:-]+$/.test(key))
        throw new Error(tr('“{key}” is no localization key.', { key }));

    const info = await host.query<{ rel?: string; mod?: string; } | null>?.('locEntry', key);
    const lang = host.settings().language || 'english';
    const own = !!info?.rel && !!info.mod && info.mod.toLowerCase() === a.mod.id.toLowerCase();
    // (the mod's own key: its line; a new key: the mod's loc file; the game's or another mod's: an override)
    const rel = own ? info!.rel! : !info?.rel ? `localization/${lang}/${fileTag(a)}_l_${lang}.yml` : `localization/${lang}/replace/${fileTag(a)}_l_${lang}.yml`;
    const file = modPath(a, rel);

    if (!file)
        throw new Error(tr('{rel} is not a path inside the mod folder.', { rel }));

    const exists = existsSync(file);
    const { text } = exists ? readScript(file) : { text: `l_${lang}:\n` };
    const eol = eolOf(text);
    const lines = text.split(/\r?\n/);
    const trailing = lines.length > 1 && lines[lines.length - 1] === '';

    if (trailing)
        lines.pop();

    const clean = req.text.replace(/\r?\n/g, '\\n');
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let i = lines.findIndex((l) => new RegExp(`^\\s*${esc}:\\d*\\s`).test(l));

    if (i >= 0)
    {
        // (the text runs to the line's last quote; a comment after it stays)
        const m = /^(\s*\S+?:\d*\s*")(.*)"(\s*(?:#.*)?)$/.exec(lines[i]);
        lines[i] = m ? `${m[1]}${clean}"${m[3]}` : ` ${key}:0 "${clean}"`;
    }
    else
    {
        lines.push(` ${key}:0 "${clean}"`);
        i = lines.length - 1;
    }

    const out = lines.join(eol) + eol;
    // (write makes the folders; the undo step removes them again)
    write(host, file, '﻿' + out);
    const mod = { id: a.mod.id, name: a.mod.name };
    describeChange({ line: i + 1 });
    await refresh(host, file);
    return { mod, file, rel, line: i + 1, undo: 0, notes: own || !info?.rel ? [] : [tr('The game\'s text is overridden in {rel} (the replace folder wins).', { rel })] };
}

// ---------------------------------------------------------------------------
// What fires an event: on_actions (docs/mods.md, "What fires an event")
// ---------------------------------------------------------------------------

/** The active mod's on_action files (common/on_action and its subfolders). */
function onActionFiles(a: Active): string[]
{
    const root = modPath(a, 'common/on_action');
    const out: string[] = [];
    const walk = (dir: string): void =>
    {
        if (!existsSync(dir))
            return;

        for (const d of readdirSync(dir, { withFileTypes: true }))
        {
            const p = join(dir, d.name);

            if (d.isDirectory())
                walk(p);
            else if (/\.txt$/i.test(d.name))
                out.push(p);
        }
    };

    if (root)
        walk(root);

    return out.sort();
}

/** the statements that name a trait's track: `track = <name>` is required in them once the trait has several (their docs) */
const TRACK_STATEMENTS = new Set(['add_trait_xp', 'has_trait_xp']);

/**
 * A trait's `track = { … }` written as `tracks = { <trait> = { … } <add> }` (docs/picker.md, "A written track turned
 * into tracks"), unindented for applyEdit's replace: the single track keeps the trait's own name, the one the game
 * gives the shorthand (_traits.info), so experience characters have in it and text functions naming it stay the same.
 */
export function tracksText(text: string, node: PNode, trait: string, add: string, unit: string): string
{
    const base = indentOf(text, node.s);
    const lines = text
        .slice(node.s, node.e)
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((l, i) => (i && l.startsWith(base) ? l.slice(base.length) : l));
    lines[0] = lines[0].replace(/^track(?=\s*=)/, trait);
    const extra = add.replace(/\r\n?/g, '\n').split('\n');
    return ['tracks = {', ...lines.map((l) => unit + l), ...extra.map((l) => unit + l), '}'].join('\n');
}

/**
 * The edits that give a trait's `add_trait_xp` / `has_trait_xp` statements without a `track` the trait's own track
 * (`track = <trait>`, right after their `trait = <trait>`; on a line of its own when that statement has one): what a
 * trait that gets a second track needs (the game: "Track name is required if the trait has multiple tracks").
 */
export function trackCallEdits(text: string, trait: string, ast: PNode[] = parse(text)): { s: number; e: number; text: string; }[]
{
    const out: { s: number; e: number; text: string; }[] = [];
    const { eol } = layoutOf(text);
    const walk = (nodes: PNode[]): void =>
    {
        for (const n of nodes)
        {
            if (!Array.isArray(n.v))
                continue;

            const name = n.v.find((c) => c.k === 'trait' && typeof c.v === 'string');

            if (n.k && TRACK_STATEMENTS.has(n.k) && name && name.v === trait && !n.v.some((c) => c.k === 'track'))
            {
                // (alone on its line: the new statement gets a line of its own, indented like it)
                const ownLine = blank(text.slice(lineStartAt(text, name.s), name.s)) && restIsBlank(text, name.e);
                out.push({ s: name.e, e: name.e, text: ownLine ? `${eol}${indentOf(text, name.s)}track = ${trait}` : ` track = ${trait}` });
            }

            walk(n.v);
        }
    };
    walk(ast);
    return out;
}

/** The script files of the mod (`common/`, `events/`, `history/`): where its own calls of a statement can be. */
function modScriptFiles(a: Active): string[]
{
    const out: string[] = [];
    const walk = (dir: string): void =>
    {
        if (!existsSync(dir))
            return;

        for (const d of readdirSync(dir, { withFileTypes: true }))
        {
            const p = join(dir, d.name);

            if (d.isDirectory())
                walk(p);
            else if (/\.txt$/i.test(d.name))
                out.push(p);
        }
    };

    for (const rel of ['common', 'events', 'history'])
    {
        const root = modPath(a, rel);

        if (root)
            walk(root);
    }

    return out.sort();
}

/** An anchor for a node of a file's text (the edits' `at`, made here instead of by the index). */
export function anchorIn(file: string, rel: string, text: string, n: PNode): LineSource
{
    const a: LineSource = { file, rel, line: n.line, s: n.s, e: n.e, kind: 'other', hash: textHash(text) };

    if (Array.isArray(n.v) && text.charCodeAt(n.e - 1) === 125)
        a.inner = [n.vs + 1, n.e - 1];

    return a;
}

export const relIn = (a: Active, file: string): string => relative(a.root, file).replace(/\\/g, '/');

/** An event id (or an on_action's name) in an on_action's lists (a bare entry; `weight = entry`). */
const isEntry = (x: PNode, event: string): boolean => x.v === event && (x.k === null || /^\d+(\.\d+)?$/.test(x.k));

/** The mod's own on_action that sends `event` to someone of theirs when `onAction` happens (fireEvent with `send`). */
function relayName(a: Active, event: string, onAction: string): string
{
    const slug = event.replace(/\W+/g, '_').toLowerCase();
    const tag = fileTag(a).toLowerCase();
    return `${slug.startsWith(tag + '_') ? slug : `${tag}_${slug}`}_on_${onAction.replace(/^on_/, '')}`;
}

/** A top-level on_action block that sends `event` from its effect (trigger_event). */
function sendsEvent(text: string, b: PNode, event: string): boolean
{
    const e = event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`trigger_event\\s*=\\s*(?:\\{[^}]*?\\bid\\s*=\\s*)?${e}(?![\\w.])`).test(text.slice(b.s, b.e));
}

/**
 * Fires an event from an on_action (docs/mods.md, "What fires an event"): its id goes into the on_action's `events`
 * list (always, when the event's trigger holds) or its `random_events` (sometimes: one of them is picked, `weight`) in
 * the active mod; on_actions of the same name merge, so the game's lists stay. The mod's own block for the on_action
 * gets it (into its list (before a `delay`, which would hold it back), or a new list); else a new block goes into
 * `common/on_action/<mod>_on_actions.txt`.
 *
 * `send`: someone of theirs gets it (a parent, the liege …). An on_action's `effect` can't be added to (only one per
 * on_action, the game's info says), so the mod gets an on_action of its own (`<event>_on_<on_action>`, documented
 * `# root is …`) whose effect keeps the one it is about (`save_scope_as = <keepAs>`) and sends the event
 * (`random_parent = { limit = { … } trigger_event = <event> }`); the on_action fires it from `on_actions` (always) or
 * `random_on_action` (sometimes; an older `random_on_actions` list of the block is renamed to it and added into).
 */
export function fireEvent(host: ModsHost, req: FireRequest): Promise<ScriptEditResult>
{
    return change(host, tr('{onAction} fires {event}', { onAction: req.onAction, event: req.event }), 'edit', () => fire(host, req));
}

async function fire(host: ModsHost, req: FireRequest): Promise<ScriptEditResult>
{
    const a = await active(host);

    if (!/^[\w.-]+$/.test(req.event) || !/^[\w.-]+$/.test(req.onAction))
        throw new Error(tr('No event or on_action to write.'));

    if (req.keepAs && !/^\w+$/.test(req.keepAs))
        throw new Error(tr('“{keepAs}” is no scope name (letters, digits, _).', { keepAs: req.keepAs }));

    const always = req.how === 'always';
    const relay = req.send?.trim() ? relayName(a, req.event, req.onAction) : undefined;
    const item = relay ?? req.event;
    // (the documented spelling, _on_actions.info: `random_on_action`; no game file writes `random_on_actions`)
    const listKey = relay ? (always ? 'on_actions' : 'random_on_action') : always ? 'events' : 'random_events';
    const entry = always ? item : `${Math.max(1, Math.round(req.weight ?? 100))} = ${item}`;
    // (the mod's file with a block for it, else its own on_action file)
    let file = onActionFiles(a).find((f) => parse(readScript(f).text).some((n) => n.k === req.onAction && Array.isArray(n.v)));
    file ??= modPath(a, `common/on_action/${fileTag(a)}_on_actions.txt`);

    if (!file)
        throw new Error(tr('The mod has no folder to write into.'));

    const rel = relIn(a, file);
    const exists = existsSync(file);
    const { text, bom } = exists ? readScript(file) : { text: '', bom: true };
    const nodes = parse(text);

    if (relay && nodes.some((n) => n.k === relay))
        throw new Error(tr('{relay} sends {event} already ({rel}) — ✕ it first to change who gets it.', { relay, event: req.event, rel }));

    const block = nodes.find((n) => n.k === req.onAction && Array.isArray(n.v));
    const notes: string[] = [];
    let out: EditOutcome;

    if (block)
    {
        const kids = block.v as PNode[];

        if (!relay && kids.some((c) => (c.k === 'events' || c.k === 'random_events') && Array.isArray(c.v) && c.v.some((x) => isEntry(x, req.event))))
            throw new Error(tr('{onAction} fires {event} already ({rel}).', { onAction: req.onAction, event: req.event, rel }));

        // (a `random_on_actions` list, as this app wrote it before, is renamed to the documented spelling and added
        // into, so the on_action keeps one list; with both spellings there, the singular one gets it)
        const plural = listKey === 'random_on_action' ? kids.findLast((c) => c.k === 'random_on_actions' && Array.isArray(c.v)) : undefined;
        const list = kids.findLast((c) => c.k === listKey && Array.isArray(c.v)) ?? plural;

        if (list)
        {
            const delay = (list.v as PNode[]).find((x) => x.k === 'delay');
            out = delay ? applyEdit(text, { op: 'insert', at: anchorIn(file, rel, text, delay), where: 'before', text: entry }) : applyEdit(text, { op: 'insert', at: anchorIn(file, rel, text, list), where: 'inside', text: entry });

            // (the key comes before what the insert added, so its offset still holds)
            if (list === plural && out.text.startsWith('random_on_actions', list.s))
            {
                out = { text: out.text.slice(0, list.s) + 'random_on_action' + out.text.slice(list.s + 'random_on_actions'.length), at: out.at > list.s ? out.at - 1 : out.at };
                notes.push(tr('{rel}: the list random_on_actions is now spelled random_on_action; the game does not read the plural (error.log: “Unexpected token”), so its entries never fired.', { rel }));
            }
        }
        else
            out = applyEdit(text, { op: 'insert', at: anchorIn(file, rel, text, block), where: 'inside', text: `${listKey} = {\n\t${entry}\n}` });
    }
    else
    {
        const { eol, unit } = layoutOf(text || '\n');
        const head = text.trim() ? text.replace(/\s*$/, '') + eol + eol : `# ${a.mod.name}: events fired by on_actions (written by CrusaderPope)${eol}${eol}`;
        const add = [`${req.onAction} = {`, `${unit}${listKey} = {`, `${unit}${unit}${entry}`, `${unit}}`, '}'].join(eol) + eol;
        out = { text: head + add, at: head.length };
    }

    if (relay)
    {
        const { eol, unit } = layoutOf(out.text);
        // (the picker's script: tab-indented)
        const send = req.send!
            .trim()
            .split(/\r?\n/)
            .map((l) => unit + unit + l.replace(/^\t+/, (m) => unit.repeat(m.length)));
        const about = (req.about?.trim() || `the one ${req.onAction} is about`).replace(/\s+/g, ' ');
        const lines = [
            `# Sends ${req.event} when ${req.onAction} happens (written by CrusaderPope)`,
            `# root is ${about}`,
            ...(req.keepAs ? [`# scope:${req.keepAs} is ${about}`] : []),
            `${relay} = {`,
            `${unit}effect = {`,
            ...(req.keepAs ? [`${unit}${unit}save_scope_as = ${req.keepAs}`] : []),
            ...send,
            `${unit}}`,
            '}'
        ];
        const base = out.text.replace(/\s*$/, '');
        out = { text: base + eol + eol + lines.join(eol) + eol, at: base.length + 2 * eol.length };
    }

    if (scriptProblems(out.text).length > scriptProblems(text).length)
        throw new Error(tr('The on_action file would not read right: {value}', { value: scriptProblems(out.text)[0] }));

    // (write makes the folders; the undo step removes them again)
    write(host, file, (bom ? '﻿' : '') + out.text);
    const mod = { id: a.mod.id, name: a.mod.name };
    const line = lineAt(out.text, out.at);
    describeChange({ line });
    await refresh(host, file);
    return { mod, file, rel, line, undo: 0, notes: [...(relay ? [tr('{onAction} fires {relay}, which sends {event}.', { onAction: req.onAction, relay, event: req.event })] : []), ...notes] };
}

/**
 * Stops firing an event from an on_action: its entry leaves the active mod's lists of that on_action (an emptied list
 * goes too, and an emptied block). An on_action of the mod's that sends the event (fireEvent `send`) goes as a whole,
 * and so do the entries firing it. Refused when only the game's files (or another mod's) fire it from there.
 */
export function unfireEvent(host: ModsHost, req: { event: string; onAction: string; }): Promise<ScriptEditResult>
{
    return change(host, tr('{onAction} no longer fires {event}', { onAction: req.onAction, event: req.event }), 'edit', () => unfire(host, req));
}

async function unfire(host: ModsHost, req: { event: string; onAction: string; }): Promise<ScriptEditResult>
{
    const a = await active(host);

    for (const file of onActionFiles(a))
    {
        const { text: before, bom } = readScript(file);
        const rel = relIn(a, file);
        let text = before;
        let changed = false;
        let relayGone = false;
        let at = 0;

        // (one thing at a time: the text is read again after each removal)
        for (let guard = 0; guard < 50; guard++)
        {
            const nodes = parse(text);
            let target: PNode | undefined;

            if (!relayGone)
            {
                target = nodes.find((b) => b.k === req.onAction && Array.isArray(b.v) && !(b.v as PNode[]).some((l) => l.k === 'events' || l.k === 'random_events') && sendsEvent(text, b, req.event));

                if (target)
                    relayGone = true;
            }

            for (const b of target ? [] : nodes)
            {
                if (!Array.isArray(b.v))
                    continue;

                // (the event in the on_action's lists; once its sender went, the entries firing the sender, under either
                // spelling of the random list: the documented `random_on_action`, and the plural this app wrote before)
                const keys = b.k === req.onAction ? ['events', 'random_events'] : relayGone ? ['on_actions', 'random_on_action', 'random_on_actions', 'first_valid_on_action'] : [];
                const value = b.k === req.onAction ? req.event : req.onAction;

                for (const l of b.v)
                {
                    if (!l.k || !keys.includes(l.k) || !Array.isArray(l.v))
                        continue;

                    const entry = l.v.find((x) => isEntry(x, value));

                    if (!entry)
                        continue;

                    const rest = l.v.filter((x) => x !== entry && (x.k === null || /^\d/.test(x.k)));
                    // (the last entry: the list goes; the list was all the block had: the block goes)
                    target = rest.length ? entry : b.v.every((x) => x === l) ? b : l;
                    break;
                }

                if (target)
                    break;
            }

            if (!target)
                break;

            const out = applyEdit(text, { op: 'remove', at: anchorIn(file, rel, text, target) });
            text = out.text;
            at = out.at;
            changed = true;
        }

        if (!changed)
            continue;

        write(host, file, (bom ? '﻿' : '') + text);
        const mod = { id: a.mod.id, name: a.mod.name };
        const line = lineAt(text, at);
        describeChange({ line });
        await refresh(host, file);
        return { mod, file, rel, line, undo: 0, notes: [] };
    }

    throw new Error(tr('{name} does not fire {event} from {onAction} — the game\'s files (or another mod\'s) do.', { name: a.mod.name, event: req.event, onAction: req.onAction }));
}
