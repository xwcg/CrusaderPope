/**
 * Per-file Bloom filters of the names a file's tokens look up while references are resolved (docs/indexer.md,
 * "Incremental updates"): when an update creates or removes an entry, the files whose filter may hold its name are
 * the only ones whose references can resolve differently — they are resolved again. No false negatives; a false
 * positive costs one needless re-parse.
 *
 * A filter is a Uint32Array of 2^n bits, three probes per name from two 32-bit string hashes (double hashing).
 */

const PROBES = 3;
/** bits per name added (names repeat within a file, so the real rate per distinct name is higher) */
const BITS_PER_NAME = 6;
const MIN_BITS = 64;

/** The name's two hashes: FNV-1a and a multiplicative one (odd, for the probe step). */
export function nameHash(s: string): [number, number]
{
    let a = 0x811c9dc5;
    let b = 0x9747b28c;

    for (let i = 0; i < s.length; i++)
    {
        const c = s.charCodeAt(i);
        a = Math.imul(a ^ c, 16777619);
        b = Math.imul(b ^ c, 0x5bd1e995);
        b ^= b >>> 13;
    }

    return [a >>> 0, (b | 1) >>> 0];
}

/** An empty filter sized for up to `count` names. */
export function newBloom(count: number): Uint32Array
{
    let bits = MIN_BITS;

    while (bits < count * BITS_PER_NAME)
        bits *= 2;

    return new Uint32Array(bits >>> 5);
}

/** Adds a name (hashed inline: this runs for every candidate of a build). */
export function bloomAdd(words: Uint32Array, s: string): void
{
    let a = 0x811c9dc5;
    let b = 0x9747b28c;

    for (let i = 0; i < s.length; i++)
    {
        const c = s.charCodeAt(i);
        a = Math.imul(a ^ c, 16777619);
        b = Math.imul(b ^ c, 0x5bd1e995);
        b ^= b >>> 13;
    }

    a >>>= 0;
    b = (b | 1) >>> 0;
    const mask = words.length * 32 - 1;

    for (let k = 0; k < PROBES; k++)
    {
        const bit = (a + k * b) & mask;
        words[bit >>> 5] |= 1 << (bit & 31);
    }
}

/** A filter holding `names` (undefined when there are none). */
export function makeBloom(names: string[]): Uint32Array | undefined
{
    if (!names.length)
        return undefined;

    const words = newBloom(names.length);

    for (const n of names)
        bloomAdd(words, n);

    return words;
}

/** Whether the filter may hold a name (by its nameHash). */
export function bloomHas(words: Uint32Array | undefined, h: [number, number]): boolean
{
    if (!words)
        return false;

    const mask = words.length * 32 - 1;

    for (let k = 0; k < PROBES; k++)
    {
        const bit = (h[0] + k * h[1]) & mask;

        if (!(words[bit >>> 5] & (1 << (bit & 31))))
            return false;
    }

    return true;
}
