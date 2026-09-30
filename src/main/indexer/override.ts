/**
 * Text for overriding an entry in the active mod (docs/mods.md, "Editing the active mod"): the definition exactly as
 * written in its file — the comment block right above it and a comment after its closing brace included — plus what
 * it needs to stand alone in another file: its event namespace, the file's @constants it uses, the file-local
 * scripted triggers/effects it calls (events files). The index worker prepares it (GameIndex.overrideSource), the main
 * process picks the file and writes it (src/main/mods/edit.ts).
 */
import { createHash } from 'node:crypto';
import { parse, type PNode } from './parser.ts';

/**
 * Checksum of a file's text as the index reads it (UTF-8, without a byte order mark): line anchors carry it, and an
 * edit in place is refused when the file's text on disk has another one (docs/mods.md, "Editing in place").
 */
export function textHash(text: string): string
{
    return createHash('sha1')
        .update(text)
        .digest('hex')
        .slice(0, 20);
}

// ---------------------------------------------------------------------------
// A statement's own checks (LineSource.stmt): hashes of its text with whitespace left out — two 32-bit multiplicative
// hashes over its characters that are no whitespace (64 bits in all), one tight pass (a story anchors hundreds of
// statements, nested blocks inside each other: a cryptographic hash of each made AGOT's stories twice as slow)
// ---------------------------------------------------------------------------

const hex = (x: number): string => x.toString(16).padStart(8, '0');

/** The hash of [s, e) without whitespace (16 hex digits) and how many characters that is. */
function rangeHash(text: string, s: number, e: number): { hash: string; n: number; }
{
    let h1 = 0x811c9dc5;
    let h2 = 0x9747b28c;
    let n = 0;

    for (let i = s; i < e; i++)
    {
        const c = text.charCodeAt(i);

        if (c <= 32)
            continue;

        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 ^ c, 0x5bd1e995);
        h2 ^= h2 >>> 15;
        n++;
    }

    return { hash: hex(h1 >>> 0) + hex(h2 >>> 0), n };
}

/** Where the 32 characters that are no whitespace before `from` (dir -1) or from `from` on (dir 1) begin / end. */
function aroundEnd(text: string, from: number, dir: 1 | -1): number
{
    let i = from;

    for (let n = 0; n < 32;)
    {
        if (dir < 0 ? i <= 0 : i >= text.length)
            break;

        if (text.charCodeAt(dir < 0 ? i - 1 : i) > 32)
            n++;

        i += dir;
    }

    return i;
}

/**
 * A statement's own checks (LineSource.stmt, docs/mods.md "Editing in place"): its length and hash without whitespace,
 * and hashes of the 32 characters that are no whitespace before and after it — how an edit finds the statement again
 * after other parts of the file changed (the same after formatting: whitespace only).
 */
export function stmtCheck(text: string, s: number, e: number): { n: number; text: string; before: string; after: string; }
{
    const own = rangeHash(text, s, e);
    return { n: own.n, text: own.hash, before: rangeHash(text, aroundEnd(text, s, -1), s).hash, after: rangeHash(text, e, aroundEnd(text, e, 1)).hash };
}

/** How well [s, e) of a text matches a statement's checks: -1 not its text, else 0–2 (the sides that match too). */
export function stmtMatch(text: string, s: number, e: number, c: { text: string; before: string; after: string; }): number
{
    if (rangeHash(text, s, e).hash !== c.text)
        return -1;

    return (rangeHash(text, aroundEnd(text, s, -1), s).hash === c.before ? 1 : 0) + (rangeHash(text, e, aroundEnd(text, e, 1)).hash === c.after ? 1 : 0);
}

/**
 * Characters that are no whitespace before each offset of a text (locate compares statements' lengths first: a
 * statement's is `k[e] - k[s]`).
 */
export function nonSpaceCounts(text: string): Int32Array
{
    const k = new Int32Array(text.length + 1);

    for (let i = 0; i < text.length; i++)
        k[i + 1] = k[i] + (text.charCodeAt(i) > 32 ? 1 : 0);

    return k;
}

/** A file-level definition the copied text needs (a constant, a file-local scripted trigger/effect). */
export interface CarriedDef
{
    name: string;
    /** exactly as in the file */
    text: string;
    /** constants: the value (`@a = 1` and `@a=1` are the same constant) */
    value?: string;
    /** file-local definitions: scripted_trigger / scripted_effect */
    kind?: string;
}

export interface OverrideText
{
    /** the top-level key the copy defines (a container's key when the definition is nested) */
    key: string;
    /** leading comment + definition (+ trailing comment), exactly as in the file */
    text: string;
    /** offset of the definition itself in `text` (after its leading comment), and of its end */
    at: number;
    end: number;
    /** 1-based line of the definition in its file */
    line: number;
    /** events: the namespace its id needs declared (`court` for court.8190) */
    namespace?: string;
    /** @constants of the file the text uses, in file order */
    constants: CarriedDef[];
    /** file-local scripted triggers/effects it calls (events files), in file order */
    locals: CarriedDef[];
    /** line endings of the file */
    eol: '\n' | '\r\n';
}

/**
 * What the worker hands the main process for "Copy to active mod" / "Replace the whole file" (GameIndex.overrideSource).
 */
export interface OverrideSource
{
    type: string;
    name: string;
    /** on_actions: definitions of several files merge — an appended copy adds to them */
    merging: boolean;
    /** no definition at all (flags, variables, images, models) */
    none?: boolean;
    /** only definitions in files a mod hid: nothing loaded to copy */
    removed?: boolean;
    /** index of the active mod among the loaded sources (-1: not loaded) */
    activeSource: number;
    /** the active mod's own loaded definition of the entry (its last one): edited instead of adding another */
    inMod?: { rel: string; abs: string; line: number; };
    /** the winning definition */
    def?: {
        rel: string;
        /** disk path, or `archive.zip › entry` */
        abs: string;
        line: number;
        /** 0 = the game, 1.. = mods in load order */
        source: number;
        /** "the game" or the mod's name */
        from: string;
        /** other files with loaded definitions of the entry (merging types: they still merge) */
        otherFiles: number;
    };
    /** script definitions: the text to append; absent when `copyProblem` says why it cannot be copied alone */
    copy?: OverrideText;
    /**
     * the definition sits in another definition: a faith in its religion, a law in its law group — copied whole —, a
     * landed title in its de jure liege (`path`)
     */
    container?: { type: string; name: string; };
    /** a landed title: its lieges from the top-level title down, written as empty blocks around it (titleText) */
    path?: string[];
    copyProblem?: string;
    /** localization keys: the entry from its key to the end of its line, and the index language */
    loc?: { lang: string; entry: string; eol: '\n' | '\r\n'; key: string; file: string; };
}

export const eolOf = (s: string): '\n' | '\r\n' => (s.includes('\r\n') ? '\r\n' : '\n');

/** Top-level node at an offset (an events file's `scripted_trigger` keyword is a node of its own). */
export function topLevelAt(ast: PNode[], off: number): PNode | undefined
{
    // top-level nodes are in source order: binary search the last one starting at or before `off`
    let lo = 0;
    let hi = ast.length - 1;
    let hit: PNode | undefined;

    while (lo <= hi)
    {
        const mid = (lo + hi) >> 1;

        if (ast[mid].s <= off)
        {
            hit = ast[mid];
            lo = mid + 1;
        }
        else
            hi = mid - 1;
    }

    return hit && off < Math.max(hit.e, hit.s + 1) ? hit : undefined;
}

function lineStartOf(src: string, pos: number): number
{
    let i = pos;

    while (i > 0 && src.charCodeAt(i - 1) !== 10)
        i--;

    return i;
}

/**
 * Where the copied text starts: the definition's line when only indentation precedes it, extended upwards over the
 * comment block directly above it (no blank line in between, at most 40 lines — like the index's doc comments).
 */
export function commentStart(src: string, start: number): number
{
    const ls = lineStartOf(src, start);

    if (src.slice(ls, start).trim())
        return start;

    let from = ls;

    for (let n = 0; from > 0 && n < 40; n++)
    {
        const prevEnd = from - 1; // the '\n' ending the previous line
        const prevStart = lineStartOf(src, prevEnd);

        if (
            !src.slice(prevStart, prevEnd)
                .trim()
                .startsWith('#')
        )
            break;

        from = prevStart;
    }

    return from;
}

/** The end of the copied text: a comment after the closing brace on the same line belongs to it. */
export function trailingEnd(src: string, end: number): number
{
    let i = end;

    while (i < src.length && (src[i] === ' ' || src[i] === '\t'))
        i++;

    if (src[i] !== '#')
        return end;

    while (i < src.length && src[i] !== '\n' && src[i] !== '\r')
        i++;

    return i;
}

/** File-level `@name = value` constants: name → exact text, value, offset. */
export function fileConstants(ast: PNode[], src: string): Map<string, CarriedDef & { s: number; }>
{
    const out = new Map<string, CarriedDef & { s: number; }>();

    for (const n of ast)
    {
        if (n.k && n.k.charCodeAt(0) === 64 && typeof n.v === 'string')
            out.set(n.k.slice(1), { name: n.k.slice(1), text: src.slice(n.s, n.e), value: n.v, s: n.s });
    }

    return out;
}

/** File-local `scripted_trigger x = { }` / `scripted_effect x = { }` of an events file: name → exact text, offset. */
export function fileLocals(ast: PNode[], src: string): Map<string, CarriedDef & { s: number; }>
{
    const out = new Map<string, CarriedDef & { s: number; }>();

    for (let i = 0; i + 1 < ast.length; i++)
    {
        const kw = ast[i];
        const n = ast[i + 1];

        if (kw.k !== null || (kw.v !== 'scripted_trigger' && kw.v !== 'scripted_effect') || !n.k || !Array.isArray(n.v))
            continue;

        out.set(n.k, { name: n.k, kind: kw.v, text: src.slice(kw.s, n.e), s: kw.s });
    }

    return out;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Constant names a text uses: `@name`, and names inside inline math `@[ a * 2 ]`. */
export function constantsUsed(text: string): Set<string>
{
    const out = new Set<string>();

    for (const m of text.matchAll(/@\[([^\]]*)\]/g))
        for (const id of m[1].matchAll(IDENT))
            out.add(id[0]);

    for (const m of text.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g))
        out.add(m[1]);

    return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a text uses a name as a whole script token (a scripted trigger/effect call `name = yes`). */
export function usesName(text: string, name: string): boolean
{
    return new RegExp(`(?<![\\w.:@$'-])${escapeRe(name)}(?![\\w.:@$'-])`).test(text);
}

/** One pattern finding any of these names as a whole script token (as usesName does), global: for matchAll. */
export function namesPattern(names: string[]): RegExp
{
    return new RegExp(`(?<![\\w.:@$'-])(?:${names.map(escapeRe).join('|')})(?![\\w.:@$'-])`, 'g');
}

/** A copy of a substring that doesn't keep its (big) file text alive. */
const own = (s: string): string => (s.length > 12 ? (' ' + s).slice(1) : s);

/**
 * A file's `@name = value` constants as the "same as the game" check compares them (GameIndex.sameUses): name → the
 * value as written (a quoted string with its quotes, inline maths `@[ … ]`, a word; a block's text) — at any depth
 * (coat of arms files define constants inside blocks), the last of a name winning. Lines are read with a pattern; a
 * file with a constant the pattern doesn't read whole (a block value, a second statement on its line) is parsed.
 */
export function constantValues(src: string): Map<string, string>
{
    const out = new Map<string, string>();

    if (!src.includes('@'))
        return out;

    const re = /^[ \t]*@([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*("(?:[^"\\\r\n]|\\.)*"|@\[[^\]]*\]|[^\s#{}"=<>]+)?([^\r\n]*)/gm;

    for (let m = re.exec(src); m; m = re.exec(src))
    {
        if (m[2] === undefined || !/^\s*(#|$)/.test(m[3]))
            return constantNodes(src);

        out.set(own(m[1]), own(m[2]));
    }

    return out;
}

/** constantValues() by the parser: every `@name = …` statement at any depth. */
function constantNodes(src: string): Map<string, string>
{
    const out = new Map<string, string>();
    const walk = (list: PNode[]): void =>
    {
        for (const n of list)
        {
            if (n.k && n.k.charCodeAt(0) === 64)
                out.set(own(n.k.slice(1)), own(typeof n.v === 'string' ? (n.q ? '"' + n.v + '"' : n.v) : src.slice(n.vs, n.e)));

            if (Array.isArray(n.v))
                walk(n.v);
        }
    };
    walk(parse(src));
    return out;
}

/**
 * The file-level definitions a text needs, transitively (a local effect may use a constant or another local), each
 * list in file order — a constant or local must be defined before its use.
 */
export function carriedDefs(
    text: string,
    consts: Map<string, CarriedDef & { s: number; }>,
    locals: Map<string, CarriedDef & { s: number; }>
): { constants: CarriedDef[]; locals: CarriedDef[]; }
{
    const needC = new Map<string, CarriedDef & { s: number; }>();
    const needL = new Map<string, CarriedDef & { s: number; }>();
    const queue = [text];

    while (queue.length)
    {
        const t = queue.pop()!;

        for (const c of constantsUsed(t))
        {
            const d = consts.get(c);

            if (d && !needC.has(c))
            {
                needC.set(c, d);
                queue.push(d.value ?? '');
            }
        }

        for (const [name, d] of locals)
        {
            if (needL.has(name) || !usesName(t, name))
                continue;

            needL.set(name, d);
            queue.push(d.text);
        }
    }

    const strip = ({ s: _s, ...d }: CarriedDef & { s: number; }): CarriedDef => d;
    return {
        constants: [...needC.values()].sort((a, b) => a.s - b.s).map(strip),
        locals: [...needL.values()].sort((a, b) => a.s - b.s).map(strip)
    };
}

/**
 * The text to copy for a definition at [start, end) of a file: its comment block, itself, a comment after it; and the
 * constants, file-local definitions and namespace it needs.
 * @param start where the definition starts (for events-file locals: the `scripted_trigger` keyword)
 * @param key the top-level key it defines
 */
export function overrideText(
    src: string,
    ast: PNode[],
    def: { start: number; end: number; line: number; key: string; },
    opts: { area: string; eventId?: string; }
): OverrideText
{
    const from = commentStart(src, def.start);
    const to = trailingEnd(src, def.end);
    const text = src.slice(from, to);
    const locals = opts.area === 'events' ? fileLocals(ast, src) : new Map<string, CarriedDef & { s: number; }>();
    // (the definition itself is not carried along — copying a local itself is refused before)
    locals.delete(def.key);
    const carried = carriedDefs(text, fileConstants(ast, src), locals);
    const dot = opts.eventId ? opts.eventId.indexOf('.') : -1;
    return {
        key: def.key,
        text,
        at: def.start - from,
        end: def.end - from,
        line: def.line,
        namespace: dot > 0 ? opts.eventId!.slice(0, dot) : undefined,
        constants: carried.constants,
        locals: carried.locals,
        eol: eolOf(src)
    };
}

/** A landed title's key: its tier's letter and an underscore (`e_francia`, `c_paris`, `b_paris`). */
export const TITLE_KEY = /^[hekdcb]_/;

/** The blocks from a top-level node down to the one starting at `s` (undefined: `s` is not a block inside it). */
export function pathTo(top: PNode, s: number): PNode[] | undefined
{
    const out = [top];
    let n = top;

    while (n.s !== s)
    {
        const next = Array.isArray(n.v) ? n.v.find((c) => Array.isArray(c.v) && c.s <= s && s < c.e) : undefined;

        if (!next)
            return undefined;

        out.push(next);
        n = next;
    }

    return out.length > 1 ? out : undefined;
}

/**
 * A landed title written inside its de jure lieges (`chain`: the top-level title down to it). The game merges a title
 * written again into the one it has — the values written, its place from where it is written (docs/mods.md, "Editing
 * the active mod") — so the copy is the title's own block as written (its comment block and a trailing comment) without
 * its de jure vassals, which stay as they are, inside empty blocks of its lieges, with the constants it uses. Nothing
 * else of the empire is written again (a later copy of a liege can't reset a vassal the mod changed).
 */
export function titleText(src: string, ast: PNode[], chain: PNode[]): OverrideText
{
    const target = chain[chain.length - 1];
    const eol = eolOf(src);
    const from = commentStart(src, target.s);
    const to = trailingEnd(src, target.e);
    let body = src.slice(from, to);
    let cut = 0;
    const kids = Array.isArray(target.v) ? target.v : [];

    // the vassals, back to front (the earlier offsets stay): each with its comment lines — a vassal on lines of its own
    // takes them whole
    for (let i = kids.length - 1; i >= 0; i--)
    {
        const k = kids[i];

        if (!k.k || !TITLE_KEY.test(k.k) || !Array.isArray(k.v))
            continue;

        const s = commentStart(src, k.s);
        let e = trailingEnd(src, k.e);

        if (s === lineStartOf(src, s))
        {
            while (src[e] === ' ' || src[e] === '\t')
                e++;

            if (src[e] === '\r')
                e++;

            if (src[e] === '\n')
                e++;
        }

        body = body.slice(0, s - from) + body.slice(e - from);
        cut += e - s;
    }

    const lieges = chain.slice(0, -1);
    const open = lieges.map((n, i) => '\t'.repeat(i) + n.k + ' = {' + eol).join('');
    const close = lieges.map((_n, i) => eol + '\t'.repeat(lieges.length - 1 - i) + '}').join('');
    const carried = carriedDefs(body, fileConstants(ast, src), new Map());
    return {
        key: target.k!,
        text: open + body + close,
        at: open.length + (target.s - from),
        end: open.length + (target.e - from) - cut,
        line: target.line,
        constants: carried.constants,
        locals: carried.locals,
        eol
    };
}
