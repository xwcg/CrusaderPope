/**
 * A text gamestate read lazily (docs/saves.md "The gamestate"): a save of a long game is hundreds of MB, so it is not
 * parsed as a whole. Byte scans find the top-level sections and the characters' blocks; a character (or any block) is
 * parsed with the script parser only when asked for. Edits are byte ranges replaced by new text, applied when the save
 * is written (`apply`); the rest of the file stays byte for byte as the game wrote it.
 *
 * Text is decoded as latin1 for parsing, so the parser's offsets are byte offsets; values are turned back into UTF-8.
 */
import { tr } from '../../shared/i18n.ts';
import { child, children, parse, scalar, type PNode } from '../indexer/parser.ts';

const LBRACE = 123;
const RBRACE = 125;
const QUOTE = 34;
const HASH = 35;
const EQ = 61;

/** A byte range [s, e) of the gamestate. */
export interface Range
{
    s: number;
    e: number;
}

/** An entry of a block: `key = value` (key null: a bare value); `block`: the value is `{ … }` (vs at the brace). */
export interface Entry
{
    key: string | null;
    /** start of the entry (its key, or the bare value) */
    s: number;
    /** the value's range (a block: from `{` to past `}`) */
    vs: number;
    ve: number;
    block: boolean;
}

const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
const isDelim = (c: number): boolean => isSpace(c) || c === LBRACE || c === RBRACE || c === EQ || c === QUOTE || c === HASH || c === 60 || c === 62 || c === 33 || c === 63;

/** Past the `}` closing the block whose `{` is at `open` (strings and comments skipped). */
export function blockEnd(b: Buffer, open: number, limit = b.length): number
{
    let depth = 0;

    for (let i = open; i < limit; i++)
    {
        const c = b[i];

        if (c === QUOTE)
        {
            for (i++; i < limit && b[i] !== QUOTE; i++)
                if (b[i] === 92)
                    i++;
        }
        else if (c === HASH)
        {
            while (i < limit && b[i] !== 10)
                i++;
        }
        else if (c === LBRACE)
            depth++;
        else if (c === RBRACE && --depth === 0)
            return i + 1;
    }

    return limit;
}

/** End of a scalar token starting at `i`. */
function tokenEnd(b: Buffer, i: number, limit: number): number
{
    if (b[i] === QUOTE)
    {
        for (i++; i < limit && b[i] !== QUOTE; i++)
            if (b[i] === 92)
                i++;

        return Math.min(limit, i + 1);
    }

    while (i < limit && !isDelim(b[i]))
        i++;

    return i;
}

function skipSpace(b: Buffer, i: number, limit: number): number
{
    for (;;)
    {
        while (i < limit && isSpace(b[i]))
            i++;

        if (i < limit && b[i] === HASH)
        {
            while (i < limit && b[i] !== 10)
                i++;

            continue;
        }

        return i;
    }
}

/** The entries of the block [from, to) (to the matching `}` when `from` is at a `{`) at its own depth. */
export function* entries(b: Buffer, from: number, to = b.length): Generator<Entry>
{
    let i = from;
    let limit = to;

    if (b[i] === LBRACE)
    {
        limit = blockEnd(b, i, to) - 1;
        i++;
    }

    for (;;)
    {
        i = skipSpace(b, i, limit);

        if (i >= limit)
            return;

        const c = b[i];

        if (c === RBRACE)
        {
            // (a stray `}`)
            i++;
            continue;
        }

        if (c === LBRACE)
        {
            const e = blockEnd(b, i, limit);
            yield { key: null, s: i, vs: i, ve: e, block: true };
            i = e;
            continue;
        }

        const ts = i;
        const te = tokenEnd(b, i, limit);
        let j = skipSpace(b, te, limit);

        // an operator: key = value
        if (j < limit && (b[j] === EQ || b[j] === 60 || b[j] === 62 || b[j] === 33 || b[j] === 63))
        {
            while (j < limit && (b[j] === EQ || b[j] === 60 || b[j] === 62 || b[j] === 33 || b[j] === 63))
                j++;

            j = skipSpace(b, j, limit);
            const key = b.subarray(ts, te).toString('latin1').replace(/^"|"$/g, '');

            if (b[j] === LBRACE)
            {
                const e = blockEnd(b, j, limit);
                yield { key, s: ts, vs: j, ve: e, block: true };
                i = e;
                continue;
            }

            const ve = tokenEnd(b, j, limit);
            // (a tagged block: `color = rgb { … }`)
            const k = skipSpace(b, ve, limit);

            if (b[k] === LBRACE && /^(rgb|hsv|hsv360|hex|LIST|list|RANGE|cylindrical)$/.test(b.subarray(j, ve).toString('latin1')))
            {
                const e = blockEnd(b, k, limit);
                yield { key, s: ts, vs: j, ve: e, block: true };
                i = e;
                continue;
            }

            yield { key, s: ts, vs: j, ve, block: false };
            i = ve;
            continue;
        }

        yield { key: null, s: ts, vs: ts, ve: te, block: false };
        i = te;
    }
}

const utf8 = (latin1: string): string => Buffer.from(latin1, 'latin1').toString('utf8');

/**
 * A save's text without the game's formatting codes (pdx_unlimiter's Ck3Strings cleans them alike): character 21
 * starts a code (`\x15ONCLICK:CHARACTER,123`, `\x15L`, `\x15indent_newline:0`, also glued to a word), `\x15!` ends a
 * formatted part.
 */
export function cleanText(s: string): string
{
    if (!s.includes('\x15'))
        return s;

    // (also a code glued to a word: `III\x15indent_newline:0`)
    return s.replace(/\x15!/g, '').replace(/\x15[^\s\x15]*/g, '').replace(/\s+/g, ' ').trim();
}

/** Where a character is written: alive (`living`), dead and kept (`dead_unprunable`), dead and prunable. */
export type CharacterPlace = 'living' | 'dead_unprunable' | 'dead_prunable';

export interface CharacterRef extends Range
{
    id: number;
    place: CharacterPlace;
}

/** A character as the save has it (ids resolved where the save says what they are). */
export interface SaveCharacter
{
    id: number;
    place: CharacterPlace;
    firstName: string;
    nickname?: string;
    birth?: string;
    female: boolean;
    culture?: { id: number; key?: string; };
    faith?: { id: number; key?: string; };
    /** 1.20: the rite of the faith (`main`: the faith's main rite; otherwise one of its other rites) */
    rite?: { id: number; name?: string; main: boolean; };
    house?: { id: number; key?: string; };
    ethnicity?: string;
    sexuality?: string;
    skills: number[];
    traits: { index: number; key?: string; }[];
    dna?: string;
    death?: { date?: string; reason?: string; };
    spouses: number[];
    children: number[];
    gold?: number;
    piety?: number;
    prestige?: number;
    health?: number;
    stress?: number;
    /** the parsed block (offsets relative to the block's start) */
    node: PNode[];
    /** the block's range in the gamestate */
    at: Range;
}

/** What the save says of one faith (see `Gamestate.faithRows`). */
interface FaithRow
{
    tag?: string;
    template?: string;
    name?: string;
    mainRite?: number;
}

/** A pending change: the range replaced by the text (UTF-8). */
export interface SaveEdit extends Range
{
    text: string;
}

export class Gamestate
{
    readonly buf: Buffer;
    /** top-level entries in file order (a key may repeat: `triggered_event`) */
    readonly top: Entry[] = [];
    private chars: Map<number, CharacterRef> | null = null;
    private traitKeys: string[] | null = null;
    private cultureKeys: Map<number, string> | null = null;
    private faithKeys: Map<number, string> | null = null;
    private houseKeys: Map<number, string> | null = null;
    private faithNameMap: Map<number, string> | null = null;
    private faithInfo: Map<number, FaithRow> | null = null;
    private riteInfo: Map<number, { faith: number; name?: string; }> | null = null;
    private riteFaithMap: Map<number, number> | null = null;
    private riteNameMap: Map<number, string> | null = null;
    /** the faith table found (null: none; undefined: not looked for yet) */
    private table: (Entry & { layout: 'faiths' | 'religion'; }) | null | undefined;
    readonly edits: SaveEdit[] = [];

    constructor(buf: Buffer)
    {
        this.buf = buf;

        for (const e of entries(buf, 0))
            this.top.push(e);
    }

    /** The first top-level entry of a key. */
    section(key: string): Entry | undefined
    {
        return this.top.find((e) => e.key === key);
    }

    /** A top-level scalar (`date`, `bookmark_date` …). */
    value(key: string): string | undefined
    {
        const e = this.section(key);
        return e && !e.block ? utf8(this.buf.subarray(e.vs, e.ve).toString('latin1')).replace(/^"|"$/g, '') : undefined;
    }

    /** The entry of `key` inside a block entry. */
    sub(e: Entry | undefined, key: string): Entry | undefined
    {
        if (!e?.block)
            return undefined;

        for (const x of entries(this.buf, e.vs, e.ve))
            if (x.key === key)
                return x;

        return undefined;
    }

    /** A range parsed (offsets relative to its start). */
    parse(r: Range): PNode[]
    {
        return parse(this.buf.subarray(r.s, r.e).toString('latin1'));
    }

    /** The current date of the game. */
    date(): string
    {
        return this.value('date') ?? '';
    }

    /** Every character of the save: id → where its block is. */
    characters(): Map<number, CharacterRef>
    {
        if (this.chars)
            return this.chars;

        const out = new Map<number, CharacterRef>();
        const add = (e: Entry | undefined, place: CharacterPlace): void =>
        {
            if (!e?.block)
                return;

            for (const x of entries(this.buf, e.vs, e.ve))
            {
                if (!x.block || x.key === null || !/^\d+$/.test(x.key))
                    continue;

                const id = Number(x.key);
                out.set(id, { id, place, s: x.s, e: x.ve });
            }
        };

        add(this.section('living'), 'living');
        add(this.section('dead_unprunable'), 'dead_unprunable');
        add(this.sub(this.section('characters'), 'dead_prunable'), 'dead_prunable');
        this.chars = out;
        return out;
    }

    /** `traits_lookup`: a character's `traits` are indices into it. */
    traitLookup(): string[]
    {
        if (!this.traitKeys)
        {
            const e = this.section('traits_lookup');
            this.traitKeys = e?.block ? [...entries(this.buf, e.vs, e.ve)].map((x) => this.buf.subarray(x.vs, x.ve).toString('latin1')) : [];
            // (the game writes the list on one line; a key that is a brace itself (a mod's broken trait) ends the block
            // early: the line's words are the list, each at its index, the brace one of them)
            const eol = e?.block ? this.buf.indexOf(10, e.ve) : -1;

            if (e && eol > e.ve && /\S/.test(this.buf.subarray(e.ve, eol).toString('latin1')))
                this.traitKeys = this.buf.subarray(e.vs + 1, eol).toString('latin1').trim().replace(/\s*\}$/, '').split(/\s+/);
        }

        return this.traitKeys;
    }

    /** ids of a database block (`id = { … key = x … }`) → the key it names (`field`, the first of them found). */
    private keysOf(db: Entry | undefined, fields: string[]): Map<number, string>
    {
        const out = new Map<number, string>();

        if (!db?.block)
            return out;

        for (const x of entries(this.buf, db.vs, db.ve))
        {
            if (!x.block || x.key === null || !/^\d+$/.test(x.key))
                continue;

            // (the field listed first wins: `name` before `culture_template`)
            let best = fields.length;
            let found: string | undefined;

            for (const f of entries(this.buf, x.vs, x.ve))
            {
                const rank = f.key && !f.block ? fields.indexOf(f.key) : -1;

                if (rank >= 0 && rank < best)
                {
                    best = rank;
                    found = this.buf.subarray(f.vs, f.ve).toString('latin1').replace(/^"|"$/g, '');
                }
            }

            if (found !== undefined)
                out.set(Number(x.key), utf8(found));
        }

        return out;
    }

    cultures(): Map<number, string>
    {
        return (this.cultureKeys ??= this.keysOf(this.sub(this.section('culture_manager'), 'cultures'), ['name', 'culture_template']));
    }

    /**
     * The save's layout of faiths (docs/saves.md "Lookups"): `faiths` (1.20: a top-level `faiths = { database = {
     * … } }`, each faith's template `faith_type`, with a top-level `rites` database a character's `rite` points into),
     * `religion` (1.18 / 1.19: `religion = { faiths = { … } }`, the template `template`, a character's `faith`), or
     * `none` (neither is there: the save is in a layout this code does not read).
     */
    faithLayout(): 'faiths' | 'religion' | 'none'
    {
        const table = this.faithTable();
        return !table ? 'none' : table.layout;
    }

    /** The block holding the faiths (`id = { … }` entries) by the save's layout. */
    faithTable(): (Entry & { layout: 'faiths' | 'religion'; }) | undefined
    {
        if (this.table === undefined)
        {
            const db = this.sub(this.section('faiths'), 'database');
            const old = db?.block ? undefined : this.sub(this.section('religion'), 'faiths');
            this.table = db?.block ? { ...db, layout: 'faiths' } : old?.block ? { ...old, layout: 'religion' } : null;
        }

        return this.table ?? undefined;
    }

    /** The block of the rites (1.20: a top-level `rites = { database = { … } }`; earlier saves have none). */
    riteTable(): Entry | undefined
    {
        const db = this.sub(this.section('rites'), 'database');
        return db?.block ? db : undefined;
    }

    /** Every faith of the save: id → its tag, template, own name and main rite. */
    private faithRows(): Map<number, FaithRow>
    {
        if (this.faithInfo)
            return this.faithInfo;

        const out = new Map<number, FaithRow>();
        const db = this.faithTable();

        for (const x of db ? entries(this.buf, db.vs, db.ve) : [])
        {
            if (!x.block || x.key === null || !/^\d+$/.test(x.key))
                continue;

            const row: FaithRow = {};

            for (const f of entries(this.buf, x.vs, x.ve))
            {
                if (!f.key || f.block)
                    continue;

                const v = (): string => utf8(this.buf.subarray(f.vs, f.ve).toString('latin1').replace(/^"|"$/g, ''));

                // (the template: `template` in 1.18 / 1.19, `faith_type` in 1.20; the first of them found stays)
                if (f.key === 'tag' || f.key === 'name')
                    row[f.key] ??= v();
                else if (f.key === 'template' || f.key === 'faith_type')
                    row.template ??= v();
                else if (f.key === 'main_rite' && /^\d+$/.test(v()))
                    row.mainRite = Number(v());
            }

            out.set(Number(x.key), row);
        }

        return (this.faithInfo = out);
    }

    /** The faith's key as the save names it: its tag (a reformed faith's `dynamic_faith_<id>`), else its template. */
    faiths(): Map<number, string>
    {
        if (!this.faithKeys)
        {
            this.faithKeys = new Map();

            for (const [id, r] of this.faithRows())
            {
                const key = r.tag ?? r.template;

                if (key !== undefined)
                    this.faithKeys.set(id, key);
            }
        }

        return this.faithKeys;
    }

    /** A faith made in the game (reformed): its tag is not its template's (or it has none and is a `dynamic_faith_<id>`). */
    private isReformed(r: FaithRow): boolean
    {
        return !!r.tag && (r.template !== undefined ? r.tag !== r.template : /^dynamic_faith/.test(r.tag));
    }

    /** Faith id → the key the game's files know it by: its template (a reformed faith's too); the tag where it has none. */
    faithGameKeys(): Map<number, string>
    {
        const out = new Map<number, string>();

        for (const [id, r] of this.faithRows())
        {
            const key = r.template ?? r.tag;

            if (key !== undefined)
                out.set(id, key);
        }

        return out;
    }

    /**
     * A faith's own name (`name`): faith id → name. 1.18 / 1.19 wrote one only for a reformed faith; 1.20 writes the
     * (localised) name of every faith, so there only a reformed faith's own is one.
     */
    faithNames(): Map<number, string>
    {
        if (!this.faithNameMap)
        {
            const old = this.faithLayout() === 'religion';
            this.faithNameMap = new Map();

            for (const [id, r] of this.faithRows())
                if (r.name !== undefined && (old || this.isReformed(r)))
                    this.faithNameMap.set(id, r.name);
        }

        return this.faithNameMap;
    }

    /** Rite id → the faith it belongs to (1.20: `rites.database.<id>.faith`; no rites in earlier saves). */
    riteFaiths(): Map<number, number>
    {
        return (this.riteFaithMap ??= new Map([...this.riteRows()].map(([id, r]) => [id, r.faith])));
    }

    /**
     * Rite id → its own name (1.20: `rites.database.<id>.data.name`). A rite is a variant of a faith with tenets and
     * doctrines of its own; the faith's `main_rite` is the one a faith starts with, every other one was made by the
     * rite growth (`create_dynamic_rite`) or the faith's scripted rites.
     */
    riteNames(): Map<number, string>
    {
        return (this.riteNameMap ??= new Map([...this.riteRows()].filter(([, r]) => r.name !== undefined).map(([id, r]) => [id, r.name!])));
    }

    private riteRows(): Map<number, { faith: number; name?: string; }>
    {
        if (!this.riteInfo)
        {
            this.riteInfo = new Map();
            const db = this.riteTable();

            for (const x of db ? entries(this.buf, db.vs, db.ve) : [])
            {
                if (!x.block || x.key === null || !/^\d+$/.test(x.key))
                    continue;

                let faith = '';
                let name: string | undefined;

                for (const e of entries(this.buf, x.vs, x.ve))
                {
                    if (e.key === 'faith' && !e.block)
                        faith = this.buf.subarray(e.vs, e.ve).toString('latin1');
                    else if (e.key === 'data' && e.block)
                    {
                        const n = [...entries(this.buf, e.vs, e.ve)].find((d) => d.key === 'name' && !d.block);
                        name = n ? utf8(this.buf.subarray(n.vs, n.ve).toString('latin1').replace(/^"|"$/g, '')) : undefined;
                    }
                }

                if (/^\d+$/.test(faith))
                    this.riteInfo.set(Number(x.key), { faith: Number(faith), name });
            }
        }

        return this.riteInfo;
    }

    /** A faith's main rite (1.20: `main_rite`) when it is one of the faith's own rites. */
    mainRiteOf(faith: number): number | undefined
    {
        const main = this.faithRows().get(faith)?.mainRite;
        return main !== undefined && this.riteFaiths().get(main) === faith ? main : undefined;
    }

    /** The `rite` a character's or county's block names (the block as `id = { … }`), as written; undefined: none. */
    riteIn(block: Buffer): string | undefined
    {
        const node = parse(block.toString('latin1'))[0];
        return scalar(child(Array.isArray(node?.v) ? node.v : [], 'rite'));
    }

    /**
     * The faith a character or county names: `faith = <faith id>` (1.18 / 1.19) or `rite = <rite id>` (1.20: the rite's
     * faith); undefined when it names none (a missing field, the "none" id, a rite the save does not have).
     */
    faithOf(faith: string | undefined, rite?: string): number | undefined
    {
        // (4294967295: the game's "none")
        if (faith !== undefined && /^\d+$/.test(faith) && faith !== '4294967295')
            return Number(faith);

        return rite !== undefined && /^\d+$/.test(rite) ? this.riteFaiths().get(Number(rite)) : undefined;
    }

    /**
     * What a character or county gets written to be of a faith, in the layout of the save: `faith = <id>`, or in a
     * save with rites `rite = <a rite of the faith>`: the rite the character or county has now (`current`, the value of
     * its `rite`) when that is one of the faith's own (choosing the faith it already has must not change its rite),
     * else the faith's main rite, else the first rite that belongs to it. undefined: the faith has no rite to write.
     */
    faithField(faith: number, current?: string): { field: 'faith' | 'rite'; value: string; } | undefined
    {
        if (!this.riteTable())
            return { field: 'faith', value: String(faith) };

        if (current !== undefined && /^\d+$/.test(current) && this.riteFaiths().get(Number(current)) === faith)
            return { field: 'rite', value: current };

        const rite = this.mainRiteOf(faith) ?? [...this.riteFaiths()].find(([, f]) => f === faith)?.[0];
        return rite === undefined ? undefined : { field: 'rite', value: String(rite) };
    }

    /** Something the page should say about this save's layout: the faiths cannot be found. undefined: all is as expected. */
    layoutNote(): string | undefined
    {
        if (this.faithLayout() === 'none')
            return tr('This save keeps its faiths in a layout the editor does not read: faiths show as empty and cannot be changed.');

        return undefined;
    }

    houses(): Map<number, string>
    {
        return (this.houseKeys ??= this.keysOf(this.sub(this.section('dynasties'), 'dynasty_house'), ['key', 'name']));
    }

    /** A character read from its block. */
    character(id: number): SaveCharacter | undefined
    {
        const ref = this.characters().get(id);
        return ref && this.characterFrom(id, ref.place, this.buf.subarray(ref.s, ref.e), ref);
    }

    /** A character read from a block (`id={…}`; its range in the gamestate: `at`, when it is the one read). */
    characterFrom(id: number, place: CharacterPlace, block: Buffer, at: Range = { s: 0, e: block.length }): SaveCharacter
    {
        // (`id = { … }`: the block's own entries)
        const node = parse(block.toString('latin1'))[0];
        const body = Array.isArray(node?.v) ? node.v : [];
        const str = (n: PNode | undefined): string | undefined =>
        {
            const v = scalar(n);
            return v === undefined ? undefined : utf8(v);
        };
        const num = (n: PNode | undefined): number | undefined =>
        {
            const v = scalar(n);
            return v === undefined || v === '' || isNaN(Number(v)) ? undefined : Number(v);
        };
        const list = (n: PNode | undefined): string[] => (n && Array.isArray(n.v) ? n.v.map((x) => scalar(x)).filter((x): x is string => x !== undefined) : []);
        const alive = child(body, 'alive_data');
        const family = child(body, 'family_data');
        const dead = child(body, 'dead_data');
        const traits = this.traitLookup();
        const idOf = (n: PNode | undefined, keys: () => Map<number, string>): { id: number; key?: string; } | undefined =>
        {
            const v = num(n);
            return v === undefined ? undefined : { id: v, key: keys().get(v) };
        };
        const amount = (n: PNode | undefined, field: string): number | undefined => num(child(n ?? [], field));
        const riteValue = scalar(child(body, 'rite'));
        const faithId = this.faithOf(scalar(child(body, 'faith')), riteValue);
        const riteId = riteValue !== undefined && /^\d+$/.test(riteValue) && this.riteFaiths().has(Number(riteValue)) ? Number(riteValue) : undefined;

        return {
            id,
            place,
            firstName: cleanText(str(child(body, 'first_name')) ?? ''),
            nickname: cleanText(str(child(body, 'nickname_text')) || str(child(body, 'nickname')) || '') || undefined,
            birth: str(child(body, 'birth')),
            female: scalar(child(body, 'female')) === 'yes',
            culture: idOf(child(body, 'culture'), () => this.cultures()),
            // (1.18 / 1.19: `faith = <id>`; 1.20: `rite = <id>`, the rite's faith)
            faith: faithId === undefined ? undefined : { id: faithId, key: this.faiths().get(faithId) },
            rite: riteId === undefined ? undefined : { id: riteId, name: this.riteNames().get(riteId), main: this.mainRiteOf(this.riteFaiths().get(riteId)!) === riteId },
            house: idOf(child(body, 'dynasty_house'), () => this.houses()),
            ethnicity: str(child(body, 'ethnicity')),
            sexuality: str(child(body, 'sexuality')),
            skills: list(child(body, 'skill')).map(Number),
            traits: list(child(body, 'traits')).map((x) => ({ index: Number(x), key: traits[Number(x)] })),
            dna: str(child(body, 'dna')),
            death: dead ? { date: str(child(dead, 'date')), reason: str(child(dead, 'reason')) } : undefined,
            spouses: family ? children(family, 'spouse').flatMap((s) => (Array.isArray(s.v) ? list(s) : [scalar(s) ?? ''])).filter(Boolean).map(Number) : [],
            children: family ? list(child(family, 'child')).map(Number) : [],
            // (gold: `gold = { value = x }`, in older saves `gold = x`)
            gold: alive ? (typeof child(alive, 'gold')?.v === 'string' ? num(child(alive, 'gold')) : amount(child(alive, 'gold'), 'value')) : undefined,
            piety: alive ? amount(child(alive, 'piety'), 'currency') : undefined,
            prestige: alive ? amount(child(alive, 'prestige'), 'currency') : undefined,
            health: alive ? num(child(alive, 'health')) : undefined,
            stress: alive ? num(child(alive, 'stress')) : undefined,
            node: body,
            at
        };
    }

    /**
     * Replaces a range with text (UTF-8). Overlapping an edit already made, that one is replaced when it lies inside
     * the new range, refused otherwise.
     */
    edit(r: Range, text: string): void
    {
        for (let i = this.edits.length - 1; i >= 0; i--)
        {
            const x = this.edits[i];

            if (x.e <= r.s || x.s >= r.e)
                continue;

            if (x.s >= r.s && x.e <= r.e)
                this.edits.splice(i, 1);
            else
                throw new Error(tr('An edit overlaps another one'));
        }

        this.edits.push({ s: r.s, e: r.e, text });
    }

    /** The gamestate with the edits applied. */
    apply(): Buffer
    {
        if (!this.edits.length)
            return this.buf;

        const parts: Buffer[] = [];
        let at = 0;

        for (const x of [...this.edits].sort((a, b) => a.s - b.s))
        {
            parts.push(this.buf.subarray(at, x.s), Buffer.from(x.text, 'utf8'));
            at = x.e;
        }

        parts.push(this.buf.subarray(at));
        return Buffer.concat(parts);
    }
}
