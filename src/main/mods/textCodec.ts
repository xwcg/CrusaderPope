/**
 * Text files that are not (all) UTF-8, round-tripped without loss. A mod saved by an ANSI editor has Windows-1252 letters
 * (`# Sancho Ramírez`, a name in a string) as single bytes, which UTF-8 decoding turns into U+FFFD: written back, the
 * file would have lost them (the game's own history files have such comments, and it reads them).
 *
 * `decodeText` decodes UTF-8 and maps every byte that belongs to no valid sequence to the lone surrogate U+DC00 + byte
 * (the way Python's `surrogateescape` does), `encodeText` writes those back as the bytes they came from. A valid UTF-8
 * file decodes exactly like `toString('utf8')`, and a file's text keeps one position per character, so the rules'
 * offsets, regular expressions and comparisons work on the text as before. A rule that adds non-ASCII text to such a
 * file writes it as UTF-8 next to the single bytes (the file was not UTF-8 to begin with).
 */
import { isAscii } from 'node:buffer';
import { readFileSync } from 'node:fs';

/** A byte that is no part of a valid sequence, as the text holds it (U+DC80 … U+DCFF). */
const escaped = (byte: number): string => String.fromCharCode(0xdc00 + byte);

/** Whether the bytes start with UTF-8's byte order mark. */
const hasBom = (data: Uint8Array): boolean => data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;

/** The text of a buffer: UTF-8, the bytes that are no UTF-8 as lone surrogates (`encodeText` turns them back). */
export function decodeText(data: Uint8Array): string
{
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const bom = hasBom(buf);

    // (ASCII after an optional byte order mark, most script files: latin1 reads the same characters, a byte each, about three
    // times faster than UTF-8, and the text is held as one byte per character)
    if (isAscii(bom ? buf.subarray(3) : buf))
        return bom ? '\uFEFF' + buf.toString('latin1', 3) : buf.toString('latin1');

    const text = buf.toString('utf8');

    // (no replacement character: the bytes were valid (the common case, one pass over the text))
    if (!text.includes('�'))
        return text;

    const parts: string[] = [];
    let from = 0;
    let i = 0;

    while (i < buf.length)
    {
        const n = sequenceLength(buf, i);

        if (n)
        {
            i += n;
            continue;
        }

        if (i > from)
            parts.push(buf.toString('utf8', from, i));

        parts.push(escaped(buf[i]));
        from = ++i;
    }

    if (i > from)
        parts.push(buf.toString('utf8', from, i));

    return parts.join('');
}

/** The length of the valid UTF-8 sequence at `i` (an ASCII byte: 1); 0 when the byte starts none. */
function sequenceLength(buf: Buffer, i: number): number
{
    const b = buf[i];

    if (b < 0x80)
        return 1;

    const more = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : 0;

    if (!more || i + more >= buf.length)
        return 0;

    // (the second byte's range leaves out overlong forms, surrogates and what lies above U+10FFFF)
    const low = b === 0xe0 ? 0xa0 : b === 0xf0 ? 0x90 : 0x80;
    const high = b === 0xed ? 0x9f : b === 0xf4 ? 0x8f : 0xbf;

    if (buf[i + 1] < low || buf[i + 1] > high)
        return 0;

    for (let k = 2; k <= more; k++)
        if (buf[i + k] < 0x80 || buf[i + k] > 0xbf)
            return 0;

    return more + 1;
}

/** A lone surrogate of `escaped` (not the second half of a pair). */
const ESCAPED = /(?<![\uD800-\uDBFF])[\uDC80-\uDCFF]/g;

/** The bytes of a text (`decodeText`'s lone surrogates go back to the single bytes they came from). */
export function encodeText(text: string): Buffer
{
    if (text.search(ESCAPED) < 0)
        return Buffer.from(text, 'utf8');

    const parts: Buffer[] = [];
    let from = 0;

    for (const m of text.matchAll(ESCAPED))
    {
        if (m.index! > from)
            parts.push(Buffer.from(text.slice(from, m.index), 'utf8'));

        parts.push(Buffer.from([m[0].charCodeAt(0) - 0xdc00]));
        from = m.index! + 1;
    }

    if (from < text.length)
        parts.push(Buffer.from(text.slice(from), 'utf8'));

    return Buffer.concat(parts);
}

/** A text file as `decodeText` reads it (the byte order mark stays). */
export const readTextFile = (file: string): string => decodeText(readFileSync(file));

/**
 * The text of a buffer without its byte order mark: `decodeText(data).replace(/^\uFEFF/, '')`, the mark left out before
 * decoding (an ASCII file's text then stays one byte per character, not a slice of a two-byte string).
 */
export const decodeTextBody = (data: Uint8Array): string => decodeText(hasBom(data) ? data.subarray(3) : data);

/** A text file without its byte order mark (`decodeTextBody`). */
export const readTextBody = (file: string): string => decodeTextBody(readFileSync(file));
