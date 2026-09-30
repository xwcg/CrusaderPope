/**
 * Characters for the map's holder chooser (docs/map.md, "Editing from the map"), in the index worker: found by first
 * name, id, house or dynasty — every word of the query must match one of them — the one whose id the query is first,
 * then those alive at the map's date, then by how well the words match; each with house, birth and death, age and
 * culture at the date. Characters a mod removed (AGOT's replace_path hides the game's) are not offered.
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import { T_CHARACTER } from '../indexer/schema.ts';
import type { CharacterTable } from '../history/characters.ts';
import type { MapCharacter } from '../../shared/api.ts';
import { HolderBook, holderAt } from './history-characters.ts';
import { dateNum } from './history.ts';

/** A live character: id and first name, lowercase. */
interface Row
{
    id: string;
    lid: string;
    lname: string;
}

interface Cache
{
    rows: Row[];
    /** per date: who is alive then (the last few dates) */
    alive: Map<string, Set<string>>;
    book: HolderBook;
}

/** per character table: it is made again when history/characters change */
const caches = new WeakMap<CharacterTable, Cache>();

function cacheOf(idx: GameIndex, table: CharacterTable): Cache
{
    let c = caches.get(table);

    if (c)
        return c;

    const rows: Row[] = [];

    for (const id of idx.names(T_CHARACTER))
    {
        const e = idx.get(T_CHARACTER, id);

        if (!e || e.dead || !idx.winningDef(e))
            continue;

        rows.push({ id, lid: id.toLowerCase(), lname: (idx.displayName(e) ?? id).toLowerCase() });
    }

    caches.set(table, c = { rows, alive: new Map(), book: new HolderBook(idx) });
    return c;
}

function aliveAt(c: Cache, table: CharacterTable, date: string): Set<string>
{
    let s = c.alive.get(date);

    if (!s)
    {
        s = new Set(table.filter({ date, alive: true }));
        c.alive.set(date, s);

        if (c.alive.size > 4)
            c.alive.delete(c.alive.keys().next().value!);
    }

    return s;
}

/** How well a word matches a name or id: exact 0, start 1, inside 2, not −1. */
function quality(r: Row, w: string): number
{
    if (r.lname === w || r.lid === w)
        return 0;

    if (r.lname.startsWith(w) || r.lid.startsWith(w))
        return 1;

    return r.lname.includes(w) || r.lid.includes(w) ? 2 : -1;
}

const fmt = (n: number): string => `${Math.floor(n / 10000)}.${Math.floor(n / 100) % 100}.${n % 100}`;

/** A character's facts at the date (dateNum). */
function factsOf(idx: GameIndex, book: HolderBook, id: string, alive: boolean, when: number): MapCharacter
{
    const h = book.get(id);
    const out: MapCharacter = { id, name: h?.name ?? id, alive };

    if (!h)
        return out;

    const f = holderAt(h, when);
    const house = f.house ? idx.get('dynasty_houses', f.house) : f.dynasty ? idx.get('dynasties', f.dynasty) : undefined;

    if (house)
        out.house = idx.displayName(house) ?? undefined;

    if (h.birth !== undefined)
        out.birth = fmt(h.birth);

    if (h.death !== undefined)
        out.death = fmt(h.death);

    if (h.birth !== undefined && h.birth <= when)
        out.age = Math.floor((Math.min(when, h.death ?? when) - h.birth) / 10000);

    const culture = f.culture ? idx.get('culture/cultures', f.culture) : undefined;

    if (f.culture)
        out.culture = { key: f.culture, name: (culture && idx.displayName(culture)) ?? f.culture };

    return out;
}

/**
 * Characters for a query at a date (y.m.d), the best `limit`. An empty query only readies the lists for the date
 * (the chooser asks it when it opens: the first search reads every character, ~1.3 s with AGOT).
 */
export function mapCharacters(idx: GameIndex, table: CharacterTable, q: string, date: string, limit = 60): MapCharacter[]
{
    const words = q.trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    const c = cacheOf(idx, table);
    const alive = aliveAt(c, table, date);

    if (!words.length)
        return [];

    // (a word may name a house or dynasty: "brandon stark", "capet")
    const houses = words.map((w) => (w.length > 1 ? new Set(table.filter({ dynasty: w })) : new Set<string>()));
    // (an id typed whole means that one, alive or not: Enter takes it)
    const id = words.length === 1 ? words[0] : undefined;
    const found: { r: Row; first: boolean; alive: boolean; score: number; }[] = [];

    for (const r of c.rows)
    {
        let score = 0;

        for (let i = 0; i < words.length && score >= 0; i++)
        {
            const q = quality(r, words[i]);
            score = q >= 0 ? score + q : houses[i].has(r.id) ? score + 3 : -1;
        }

        if (score >= 0)
            found.push({ r, first: r.lid === id, alive: alive.has(r.id), score });
    }

    found.sort(
        (a, b) =>
            Number(b.first) - Number(a.first) ||
            Number(b.alive) - Number(a.alive) ||
            a.score - b.score ||
            (a.r.lname < b.r.lname ? -1 : a.r.lname > b.r.lname ? 1 : a.r.id.length - b.r.id.length || (a.r.id < b.r.id ? -1 : 1))
    );
    const top = found.slice(0, limit);
    c.book.load(top.map((x) => x.r.id));
    const when = dateNum(date);
    return top.map((x) => factsOf(idx, c.book, x.r.id, x.alive, when));
}

/** One character's facts at a date (y.m.d); null when the loaded game files have no such character. */
export function mapCharacter(idx: GameIndex, table: CharacterTable, id: string, date: string): MapCharacter | null
{
    const e = idx.get(T_CHARACTER, id);

    if (!e || e.dead || !idx.winningDef(e))
        return null;

    const c = cacheOf(idx, table);
    return factsOf(idx, c.book, id, aliveAt(c, table, date).has(id), dateNum(date));
}
