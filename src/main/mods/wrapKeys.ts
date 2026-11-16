/**
 * Settings a definition writes at its top that a game version reads only inside a block of the definition (1.20's religions:
 * `family`, `graphical_faith` … in `religion_details = { }`). Each definition of a file has them moved into the block: the
 * first moved statement's place gets a block made when there is none, else they are added to the one there. Only those
 * statements move: everything else stays where it is, and a statement takes its comments with it (the lines right above
 * it, the one after it on its line). Pure text edits (offsets of the parser), applied with `applyStatementEdits`.
 */
import { type PNode } from '../indexer/parser.ts';
import { dropRange, indentAt, statementNote, type StatementEdit } from './scriptRules.ts';

/** The statements of a definition that stand at its top and belong in the block. */
export function wrapped(entry: PNode, keys: string[]): PNode[]
{
    return Array.isArray(entry.v) ? entry.v.filter((c) => c.k !== null && keys.includes(c.k) && typeof c.v === 'string') : [];
}

/**
 * Lines (already indented) put last in a block: before its closing brace, on a line of its own where the brace has one, else
 * the brace's line is split.
 */
export function appendLines(text: string, box: PNode, lines: string[]): StatementEdit
{
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const close = box.e - 1;
    const ls = text.lastIndexOf('\n', close - 1) + 1;
    const own = !text.slice(ls, close).trim();
    const base = indentAt(text, box.s);

    if (own)
        return { s: ls, e: ls, text: lines.join(eol) + eol };

    // (`{ a = b }`, `{ }`: the lines start on one of their own, after the last statement; the blanks before the brace go)
    let at = close;

    while (at > box.vs + 1 && /[ \t]/.test(text[at - 1]))
        at--;

    return { s: at, e: close, text: eol + lines.join(eol) + eol + base };
}

/** The edits that move the keys of one definition into its block `into` (none: nothing to move). */
export function wrapDefinition(text: string, entry: PNode, keys: string[], into: string): StatementEdit[]
{
    const moved = wrapped(entry, keys);

    if (!moved.length || !Array.isArray(entry.v))
        return [];

    const kids = entry.v;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const existing = kids.find((c) => c.k === into && Array.isArray(c.v));
    const has = new Set((existing && Array.isArray(existing.v) ? existing.v : []).map((c) => c.k));
    const base = indentAt(text, existing ? existing.s : moved[0].s);
    const inner = base + '\t';
    const notes = new Map(moved.map((x) => [x, statementNote(text, x, kids, entry.vs)]));
    // (a key the block has already wins; the one at the top is a leftover and goes)
    const lines = moved.filter((x) => !has.has(x.k)).map((x) =>
    {
        const note = notes.get(x)!;
        // (the first one's comment lines above stay where they are when the block takes its place)
        const lead = existing || x !== moved[0] ? note.lead.map((l) => `${inner}${l}${eol}`).join('') : '';
        return `${lead}${inner}${text.slice(x.s, x.e)}${note.trail ? ' ' + note.trail : ''}`;
    });
    const out: StatementEdit[] = [];

    if (existing)
    {
        if (lines.length)
            out.push(appendLines(text, existing, lines));
    }
    else
        out.push({ s: moved[0].s, e: notes.get(moved[0])!.end, text: `${into} = {${eol}${lines.join(eol)}${eol}${base}}` });

    for (const x of existing ? moved : moved.slice(1))
    {
        const note = notes.get(x)!;
        out.push(dropRange(text, { ...x, s: note.leadStart ?? x.s, e: note.end }));
    }

    return out;
}
