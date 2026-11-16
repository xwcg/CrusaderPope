/**
 * Whole words of a text found without a regular expression of all of them. An alternation of names is fast until its source
 * passes about 20 KB (V8 leaves its optimized path there: between 500 and 600 names of 1.20's length, 20 to 25 times slower,
 * round 11 and 12); a substring test per name costs names x text. A word here is a run of [A-Za-z0-9_] with no such character on
 * either side: for a name of those characters only, what `\bname\b` and `(?<![A-Za-z0-9_])name(?![A-Za-z0-9_])` find (names with
 * other characters keep their regular expression).
 */

/** [A-Za-z0-9_] by character code */
const WORD = new Uint8Array(128);

for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_')
    WORD[c.charCodeAt(0)] = 1;

/** Whether a name is one word of [A-Za-z0-9_] (the passes below find it exactly as the regular expressions did). */
export const isWordName = (name: string): boolean => /^[A-Za-z0-9_]+$/.test(name);

/**
 * Whether an alternation of these names is past V8's fast path (its source over 16,000 characters, under the 20 KB where it
 * drops): below, the expression is the faster way (about 1.2 ns a character against 3.5 for a pass of whole words).
 */
export const pastFastPath = (names: readonly string[]): boolean => names.reduce((n, s) => n + s.length + 1, 0) > 16000;

/** Names to look for as whole words: a bit per hash of a name, its shortest and longest length (a run is looked up only past them). */
export interface WordSet
{
    has(word: string): boolean;
    size: number;
    min: number;
    max: number;
    bits: Uint8Array;
}

/** The hash `eachWord` keeps while it reads a run (`h * 31 + c`, 32 bits). */
function hashOf(s: string): number
{
    let h = 0;

    for (let i = 0; i < s.length; i++)
        h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;

    return h;
}

export function wordSet(names: Iterable<string>): WordSet
{
    const set = new Set(names);
    const bits = new Uint8Array(1 << 16);
    let min = Infinity;
    let max = 0;

    for (const n of set)
    {
        bits[hashOf(n) & 0xffff] = 1;
        min = Math.min(min, n.length);
        max = Math.max(max, n.length);
    }

    return { has: (w) => set.has(w), size: set.size, min, max, bits };
}

/**
 * Each whole word of the text that the set holds, in order, with where it starts and ends. `hit` returning true stops the walk;
 * the result says whether it stopped.
 */
export function eachWord(text: string, words: WordSet, hit: (word: string, from: number, to: number) => boolean | void): boolean
{
    const n = text.length;
    let i = 0;

    while (i < n)
    {
        let c = text.charCodeAt(i);

        if (c >= 128 || WORD[c] === 0)
        {
            i++;
            continue;
        }

        const from = i;
        let h = c;

        while (++i < n && (c = text.charCodeAt(i)) < 128 && WORD[c] === 1)
            h = (Math.imul(h, 31) + c) | 0;

        const len = i - from;

        if (len >= words.min && len <= words.max && words.bits[h & 0xffff] === 1)
        {
            const w = text.slice(from, i);

            if (words.has(w) && hit(w, from, i))
                return true;
        }
    }

    return false;
}

/** Whether the text has a whole word the set holds (and `skip` does not). */
export const hasWord = (text: string, words: WordSet, skip?: Set<string>): boolean => eachWord(text, words, (w) => !skip?.has(w));
