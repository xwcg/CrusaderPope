/**
 * Province names for the map (docs/map.md, "Presentation"): baronies are named by their title; seas, lakes, rivers
 * and wastelands by the localization key definition.csv gives them (`sea_bay_biscay: "Bay of Biscay"`, the game's
 * map_items_l_*.yml), else made readable (`sea_coast_of_oland` → Sea Coast of Oland, `HUNGARIAN-MORAVIAN MOUNTAINS`
 * → Hungarian-Moravian Mountains, AGOT's `b_impassable_sea_2` → Impassable Sea 2).
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import { MAP_KINDS } from './kinds.ts';

const LAND = MAP_KINDS.indexOf('land');
const SMALL = new Set(['of', 'the', 'and', 'de', 'la', 'le', 'du', 'del', 'di', 'al', 'el', 'on', 'in', 'by', 'at', 'to', 'upon']);

/** `sea_coast_of_oland` → Sea Coast of Oland (a title key's tier prefix goes, words capitalized, small words not). */
function readableName(name: string): string
{
    const words = name
        .replace(/^[hekdcb]_(?=.)/, '')
        .replace(/_/g, ' ')
        .trim()
        .toLowerCase()
        .split(/\s+/);
    // (a capital after a hyphen too: Hungarian-Moravian)
    return words.map((w, i) => (i > 0 && SMALL.has(w) ? w : w.replace(/(^|-)(\p{L})/gu, (_, a: string, c: string) => a + c.toUpperCase()))).join(' ');
}

/**
 * Per province: its name when it has no barony — the localization of definition.csv's name, else readable. Land
 * provinces keep definition.csv's name (their barony names them; the side panel shows the raw one).
 */
export function provinceNames(idx: GameIndex, definitionNames: string[], kinds: number[]): string[]
{
    return definitionNames.map((n, p) =>
    {
        if (!n || kinds[p] === LAND)
            return n;

        // (a name, not a phrase: "the Indian Ocean" → The Indian Ocean)
        const loc = idx.plainLoc(n)?.trim();
        return loc ? loc.charAt(0).toUpperCase() + loc.slice(1) : readableName(n);
    });
}
