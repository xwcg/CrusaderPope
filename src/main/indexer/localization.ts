/**
 * Parser for CK3 localization .yml files (not real YAML).
 *
 *   l_english:
 *    key:0 "value with "unescaped" quotes"   # comment
 *
 * The value runs from the first quote to the last quote on the line.
 */

export interface LocEntry
{
    key: string;
    text: string;
    line: number;
    /** Offset of the key in the file. */
    off: number;
}

export function parseLocalization(src: string): { language: string | null; entries: LocEntry[]; }
{
    const entries: LocEntry[] = [];
    let language: string | null = null;
    let pos = src.charCodeAt(0) === 0xfeff ? 1 : 0;
    let line = 0;
    const len = src.length;

    while (pos < len)
    {
        let eol = src.indexOf('\n', pos);

        if (eol < 0)
            eol = len;

        line++;
        const lineStart = pos;
        pos = eol + 1;

        // skip indentation
        let i = lineStart;

        while (i < eol && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9))
            i++;

        if (i >= eol || src.charCodeAt(i) === 35 /* # */)
            continue;

        const colon = src.indexOf(':', i);

        if (colon < 0 || colon >= eol)
            continue;

        const key = src.slice(i, colon);

        if (key.includes(' ') || key.includes('"'))
            continue;

        const q1 = src.indexOf('"', colon);

        if (q1 < 0 || q1 >= eol)
        {
            if (language === null && key.startsWith('l_'))
                language = key.slice(2);

            continue;
        }

        let q2 = src.lastIndexOf('"', eol);

        if (q2 <= q1)
            q2 = eol; // unterminated

        entries.push({ key, text: src.slice(q1 + 1, q2), line, off: i });
    }

    return { language, entries };
}

/** The text of the entry whose key starts at `off` (as parseLocalization reads it); undefined when there is none. */
export function locTextAt(src: string, off: number): string | undefined
{
    let eol = src.indexOf('\n', off);

    if (eol < 0)
        eol = src.length;

    const colon = src.indexOf(':', off);
    const q1 = colon < 0 || colon >= eol ? -1 : src.indexOf('"', colon);

    if (q1 < 0 || q1 >= eol)
        return undefined;

    let q2 = src.lastIndexOf('"', eol);

    if (q2 <= q1)
        q2 = eol;

    return src.slice(q1 + 1, q2);
}

/** Loc keys referenced via $key$ (optionally $key|U$). */
const DOLLAR_REF = /\$([A-Za-z0-9_.\-]+)(?:\|[^$]*)?\$/g;
/** Game concepts via [concept|E] or [concept_name|E]. */
const CONCEPT_REF = /\[([a-z_0-9]+)\|[A-Za-z]*\]/g;
/** Single-quoted args in data functions: [GetTrait('brave').GetName], Custom('X'). */
const QUOTED_ARG = /'([A-Za-z0-9_.]+)'/g;

export interface LocRefs
{
    loc: string[];
    concepts: string[];
    args: string[];
}

export function extractLocRefs(text: string): LocRefs
{
    const loc: string[] = [];
    const concepts: string[] = [];
    const args: string[] = [];

    if (text.includes('$'))
    {
        for (const m of text.matchAll(DOLLAR_REF))
            loc.push(m[1]);
    }

    if (text.includes('['))
    {
        for (const m of text.matchAll(CONCEPT_REF))
            concepts.push(m[1]);

        if (text.includes("'"))
        {
            for (const m of text.matchAll(QUOTED_ARG))
                args.push(m[1]);
        }
    }

    return { loc, concepts, args };
}
