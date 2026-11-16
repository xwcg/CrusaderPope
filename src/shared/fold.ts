// Text for comparing without accents and case, so a name typed on a keyboard without the letter still matches
// (`odwazna` finds "odważna", `etienne` "Étienne", `еж` "ёж"): used by the text searches over display names.

const SPECIAL: Record<string, string> = { 'ß': 'ss', 'ł': 'l', 'ø': 'o', 'đ': 'd', 'æ': 'ae', 'œ': 'oe', 'ð': 'd', 'þ': 'th', 'ı': 'i' };

/**
 * Lower case with the accents taken off: a letter and its combining marks (U+0300–036F: Latin and Cyrillic accents, ё and й
 * become е and и) are split and the marks dropped; ß ł ø đ æ œ ð þ ı are spelled in plain letters. Kana, Hangul and Han are
 * left as they are (their marks are no accents), so are plain ASCII texts but for their case.
 */
export function fold(s: string): string
{
    if (!/[^\x00-\x7f]/.test(s))
        return s.toLowerCase();

    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC').replace(/[ßłøđæœðþı]/g, (c) => SPECIAL[c]);
}

/**
 * Whether `hay` holds the already folded needle (`foldHas(name, fold(typed))`): the text searches fold the typed text once
 * and each candidate with this. Nothing (undefined, empty) holds nothing; an empty needle is held by any text.
 */
export function foldHas(hay: string | undefined, foldedNeedle: string): boolean
{
    return !!hay && fold(hay).includes(foldedNeedle);
}
