/**
 * The open save (docs/saves.md "Plan", stages 2–3): one at a time. Characters are searched by name, read with their
 * pending changes and edited; a change rewrites the character's whole block (kept as an overlay; the original bytes
 * stay as read), so reading a character shows its changes and undo is a stack of blocks. "Write save as" applies the
 * overlays to the gamestate and writes a new file; the original is never written.
 */
import { tr } from '../../shared/i18n.ts';
import type { SaveCharacterView, SaveCharacterEdit, SaveHit, SaveSummary } from '../../shared/api.ts';
import { readSave, writeSave, type SaveFile } from './envelope.ts';
import { entries, Gamestate, type CharacterRef, type Entry } from './gamestate.ts';

/** One name per character for the search: first name, house key, birth, place. */
interface NameRow
{
    id: number;
    name: string;
    house?: number;
    birth?: string;
    place: CharacterRef['place'];
}

/** `dynn_Dayne` → "Dayne" (the house's localization key without its prefix: shown until the text is looked up). */
export const houseLabel = (key?: string): string | undefined => (key ? key.replace(/^(dynn?|house)_/i, '').replace(/_/g, ' ') : undefined);

const quote = (s: string): string => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** A character block with a field set: replaced where it is, else added before the block's `}` (parents made). */
export function setField(block: Buffer, path: string[], value: string): Buffer
{
    // the entry of each step, its block's range
    let from = 0;
    let to = block.length;
    let depth = 1;

    for (let i = 0; i < path.length; i++)
    {
        const key = path[i];
        const open = block.indexOf(123, from);
        const close = (() =>
        {
            let d = 0;

            for (let j = open; j < to; j++)
            {
                if (block[j] === 34)
                {
                    for (j++; j < to && block[j] !== 34; j++)
                        if (block[j] === 92)
                            j++;
                }
                else if (block[j] === 123)
                    d++;
                else if (block[j] === 125 && --d === 0)
                    return j;
            }

            return to - 1;
        })();
        let found: Entry | undefined;

        for (const x of entries(block, open, close + 1))
        {
            if (x.key === key)
            {
                found = x;
                break;
            }
        }

        const last = i === path.length - 1;

        if (found && last)
            return Buffer.concat([block.subarray(0, found.vs), Buffer.from(value, 'utf8'), block.subarray(found.ve)]);

        if (found && found.block)
        {
            from = found.vs;
            to = found.ve;
            depth++;
            continue;
        }

        // (not there: the rest of the path written before this block's `}`)
        let text = '';
        const rest = path.slice(i);

        for (let k = 0; k < rest.length; k++)
            text += k === rest.length - 1 ? `${'\t'.repeat(depth + k)}${rest[k]}=${value}\n` : `${'\t'.repeat(depth + k)}${rest[k]}={\n`;

        for (let k = rest.length - 2; k >= 0; k--)
            text += `${'\t'.repeat(depth + k)}}\n`;

        // (after the last line break before `}`: the block's own indentation stays)
        let at = close;

        while (at > open && (block[at - 1] === 9 || block[at - 1] === 32))
            at--;

        const nl = at > open && block[at - 1] === 10 ? '' : '\n';
        return Buffer.concat([block.subarray(0, at), Buffer.from(nl + text, 'utf8'), block.subarray(at)]);
    }

    return block;
}

/** A character block with a field removed (absent: as it is). */
export function removeField(block: Buffer, key: string): Buffer
{
    const open = block.indexOf(123);

    for (const x of entries(block, open))
    {
        if (x.key !== key)
            continue;

        // (its whole line)
        let s = x.s;

        while (s > 0 && (block[s - 1] === 9 || block[s - 1] === 32))
            s--;

        let e = x.ve;

        while (e < block.length && (block[e] === 32 || block[e] === 9 || block[e] === 13))
            e++;

        if (block[e] === 10)
            e++;

        return Buffer.concat([block.subarray(0, s), block.subarray(e)]);
    }

    return block;
}

export class SaveSession
{
    readonly file: string;
    readonly save: SaveFile;
    readonly g: Gamestate;
    /** changed characters' blocks (the whole `id={…}`), UTF-8 */
    private blocks = new Map<number, Buffer>();
    /** what each change replaced (undefined: the block as read) */
    private undoStack: { id: number; path?: string; before: Buffer | undefined; label: string; }[] = [];
    /** changed blocks found by a path of keys (`county_manager/counties/c_x`, `landed_titles/landed_titles/3000`): range and bytes */
    private paths = new Map<string, { s: number; e: number; buf: Buffer; }>();
    private names: NameRow[] | null = null;

    /** `loaded`: the save already read (the index worker's, docs/saves.md) */
    constructor(file: string, loaded?: { save: SaveFile; g: Gamestate; })
    {
        this.file = file;
        this.save = loaded?.save ?? readSave(file);

        if (this.save.binary)
            throw new Error(tr('This save is binary (an autosave or an ironman save): only text saves can be read. Save the game by hand (not ironman) and open that save.'));

        this.g = loaded?.g ?? new Gamestate(this.save.gamestate);
        this.g.characters();
    }

    /** How many changes are not written yet. */
    get pending(): number
    {
        return this.undoStack.length;
    }

    summary(): SaveSummary
    {
        const meta = this.g.sub(this.g.section('meta_data'), 'mods');
        const mods = meta?.block ? [...entries(this.g.buf, meta.vs, meta.ve)].map((x) => this.g.buf.subarray(x.vs, x.ve).toString('utf8').replace(/^"|"$/g, '')) : [];
        const metaValue = (k: string): string | undefined =>
        {
            const e = this.g.sub(this.g.section('meta_data'), k);
            return e && !e.block ? this.g.buf.subarray(e.vs, e.ve).toString('utf8').replace(/^"|"$/g, '') : undefined;
        };
        const chars = [...this.g.characters().values()];
        return {
            players: this.players(),
            file: this.file,
            date: this.g.date(),
            version: metaValue('version'),
            player: metaValue('meta_player_name'),
            title: metaValue('meta_title_name'),
            mods,
            living: chars.filter((c) => c.place === 'living').length,
            dead: chars.filter((c) => c.place !== 'living').length,
            changes: this.undoStack.map((u) => u.label),
            changed: this.blocks.size
        };
    }

    /** The save's cultures or faiths (its ids, what a character refers to). */
    lookup(kind: 'culture' | 'faith'): { id: number; key: string; name?: string; }[]
    {
        const keys = kind === 'culture' ? this.g.cultures() : this.g.faiths();
        const names = kind === 'faith' ? this.g.faithNames() : new Map<number, string>();
        return [...keys].map(([id, key]) => ({ id, key, ...(names.has(id) ? { name: names.get(id) } : {}) }));
    }

    /** A character's DNA (base64) as it is now, its changes included. */
    dnaOf(id: number): string | undefined
    {
        const b = this.block(id);

        if (!b)
            return undefined;

        for (const x of entries(b, b.indexOf(123)))
            if (x.key === 'dna' && !x.block)
                return b.subarray(x.vs, x.ve).toString('latin1').replace(/^"|"$/g, '');

        return undefined;
    }

    /** The played characters (`currently_played_characters`). */
    players(): number[]
    {
        const e = this.g.section('currently_played_characters');
        return e?.block ? [...entries(this.g.buf, e.vs, e.ve)].map((x) => Number(this.g.buf.subarray(x.vs, x.ve).toString('latin1'))).filter((n) => !isNaN(n)) : [];
    }

    /** The block of a character as it is now (with its changes). */
    private block(id: number): Buffer | undefined
    {
        const ref = this.g.characters().get(id);
        return this.blocks.get(id) ?? (ref && this.g.buf.subarray(ref.s, ref.e));
    }

    private nameRows(): NameRow[]
    {
        if (this.names)
            return this.names;

        const rows: NameRow[] = [];
        const b = this.g.buf;

        for (const ref of this.g.characters().values())
        {
            const row: NameRow = { id: ref.id, name: '', place: ref.place };

            // (the first fields: first_name, birth, dynasty_house come before the blocks)
            for (const x of entries(b, b.indexOf(123, ref.s), ref.e))
            {
                if (x.block)
                    break;

                if (x.key === 'first_name')
                    row.name = b.subarray(x.vs, x.ve).toString('utf8').replace(/^"|"$/g, '');
                else if (x.key === 'birth')
                    row.birth = b.subarray(x.vs, x.ve).toString('latin1');
                else if (x.key === 'dynasty_house')
                    row.house = Number(b.subarray(x.vs, x.ve).toString('latin1'));
            }

            rows.push(row);
        }

        this.names = rows;
        return rows;
    }

    /** Characters whose name (first name + house) holds every word of the query; the living first. */
    search(query: string, limit = 200, opts: { dead?: boolean; } = {}): SaveHit[]
    {
        const houses = this.g.houses();
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const out: SaveHit[] = [];
        const id = /^\d+$/.test(query.trim()) ? Number(query.trim()) : undefined;
        const players = new Set(this.players());
        // (the players first)
        const rows = [...this.nameRows()].sort((a, b) => Number(players.has(b.id)) - Number(players.has(a.id)));

        for (const r of rows)
        {
            if (!opts.dead && r.place !== 'living' && r.id !== id)
                continue;

            const house = houseLabel(r.house !== undefined ? houses.get(r.house) : undefined);
            const label = house ? `${r.name} ${house}` : r.name;
            const hay = label.toLowerCase();

            if (r.id !== id && !words.every((w) => hay.includes(w)))
                continue;

            out.push({ id: r.id, name: r.name, house, birth: r.birth, alive: r.place === 'living', changed: this.blocks.has(r.id), ...(players.has(r.id) ? { player: true } : {}) });

            if (out.length >= limit)
                break;
        }

        return out;
    }

    /** A character as it is now (its changes included). */
    character(id: number): SaveCharacterView | undefined
    {
        const ref = this.g.characters().get(id);
        const b = this.block(id);

        if (!ref || !b)
            return undefined;

        const c = this.g.characterFrom(id, ref.place, b);
        const name = (x: number): { id: number; name: string; } => ({ id: x, name: this.quickName(x) });
        return {
            id,
            alive: ref.place === 'living',
            firstName: c.firstName,
            nickname: c.nickname,
            birth: c.birth,
            female: c.female,
            culture: c.culture,
            faith: c.faith && { ...c.faith, name: this.g.faithNames().get(c.faith.id) },
            rite: c.rite,
            house: c.house && { id: c.house.id, key: c.house.key, label: houseLabel(c.house.key) },
            ethnicity: c.ethnicity,
            sexuality: c.sexuality,
            skills: c.skills,
            traits: c.traits,
            death: c.death,
            spouses: c.spouses.map(name),
            children: c.children.map(name),
            gold: c.gold,
            piety: c.piety,
            prestige: c.prestige,
            health: c.health,
            stress: c.stress,
            hasDna: !!c.dna,
            changed: this.blocks.has(id),
            date: this.g.date()
        };
    }

    private quickName(id: number): string
    {
        const b = this.block(id);

        if (!b)
            return `#${id}`;

        for (const x of entries(b, b.indexOf(123)))
        {
            if (x.key === 'first_name')
                return b.subarray(x.vs, x.ve).toString('utf8').replace(/^"|"$/g, '');

            if (x.block)
                break;
        }

        return `#${id}`;
    }

    /** Changes a character (one undo step). */
    edit(req: SaveCharacterEdit): SaveCharacterView
    {
        const ref = this.g.characters().get(req.id);
        const before = this.block(req.id);

        if (!ref || !before)
            throw new Error(tr('No character {id} in this save', { id: req.id }));

        const alive = ref.place === 'living';
        let b: Buffer = before;
        const num = (v: number | undefined, what: string): string =>
        {
            if (v === undefined || !isFinite(v))
                throw new Error(tr('Not a number: {what}', { what }));

            return String(Math.round(v * 100000) / 100000);
        };
        const needAlive = (what: string): void =>
        {
            if (!alive)
                throw new Error(tr('{what} can only be changed for a living character', { what }));
        };

        switch (req.field)
        {
            case 'firstName':
                if (!req.text?.trim())
                    throw new Error(tr('A name can\'t be empty'));

                b = setField(b, ['first_name'], quote(req.text.trim()));
                break;
            case 'nickname':
                b = setField(b, ['nickname_text'], quote(req.text?.trim() ?? ''));
                break;
            case 'skills':
                if (!req.numbers || req.numbers.length !== 6 || req.numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 100))
                    throw new Error(tr('Six skills, whole numbers from 0 to 100'));

                b = setField(b, ['skill'], `{ ${req.numbers.join(' ')} }`);
                break;
            case 'traits':
            {
                const lookup = this.g.traitLookup();
                const index = new Map(lookup.map((k, i) => [k, i]));
                const missing = (req.keys ?? []).filter((k) => !index.has(k));

                if (missing.length)
                    throw new Error(tr('Not a trait of this save: {keys}', { keys: missing.join(', ') }));

                const list = [...new Set(req.keys ?? [])].map((k) => index.get(k)!);
                b = list.length ? setField(b, ['traits'], `{ ${list.join(' ')} }`) : removeField(b, 'traits');
                break;
            }
            case 'culture':
            case 'faith':
            {
                const id = req.number;

                if (id === undefined || !(req.field === 'culture' ? this.g.cultures() : this.g.faiths()).has(id))
                    throw new Error(req.field === 'culture' ? tr('Not a culture of this save') : tr('Not a faith of this save'));

                if (req.field === 'faith')
                {
                    // (written as the save has it: `faith = <id>`, in a 1.20 save `rite = <a rite of the faith>`: the one the
                    // character has when it is the faith's, else the main rite)
                    const w = this.g.faithField(id, this.g.riteIn(b));

                    if (!w)
                        throw new Error(tr('This save has no rite for that faith'));

                    b = setField(b, [w.field], w.value);
                }
                else
                    b = setField(b, ['culture'], String(id));

                break;
            }
            case 'gold':
            {
                needAlive(tr('Gold'));
                // (written as the save has it: `gold = { value = x }`, older saves `gold = x`)
                const alive = this.g.characterFrom(req.id, ref.place, b).node.find((n) => n.k === 'alive_data');
                const plain = Array.isArray(alive?.v) && typeof alive.v.find((n) => n.k === 'gold')?.v === 'string';
                b = setField(b, plain ? ['alive_data', 'gold'] : ['alive_data', 'gold', 'value'], num(req.number, tr('gold')));
                break;
            }
            case 'piety':
                needAlive(tr('Piety'));
                b = setField(b, ['alive_data', 'piety', 'currency'], num(req.number, tr('piety')));
                break;
            case 'prestige':
                needAlive(tr('Prestige'));
                b = setField(b, ['alive_data', 'prestige', 'currency'], num(req.number, tr('prestige')));
                break;
            case 'health':
                needAlive(tr('Health'));
                b = setField(b, ['alive_data', 'health'], num(req.number, tr('health')));
                break;
            case 'stress':
                needAlive(tr('Stress'));
                b = setField(b, ['alive_data', 'stress'], num(req.number, tr('stress')));
                break;
            case 'female':
                b = req.number ? setField(b, ['female'], 'yes') : removeField(b, 'female');
                break;
            case 'nicknameKey':
                b = req.text ? setField(b, ['nickname'], req.text) : removeField(b, 'nickname');
                break;
            case 'birth':
                if (!/^\d+\.\d+\.\d+$/.test(req.text ?? ''))
                    throw new Error(tr('A date: year.month.day'));

                b = setField(b, ['birth'], req.text!);
                break;
            case 'sexuality':
                b = req.text ? setField(b, ['sexuality'], req.text) : removeField(b, 'sexuality');
                break;
            case 'dna':
                if (!req.text || !/^[A-Za-z0-9+/=]+$/.test(req.text))
                    throw new Error(tr('Not a DNA'));

                b = setField(b, ['dna'], `"${req.text}"`);
                break;
            case 'house':
                if (req.number === undefined || !this.g.houses().has(req.number))
                    throw new Error(tr('Not a house of this save'));

                b = setField(b, ['dynasty_house'], String(req.number));
                break;
            default:
                throw new Error(tr('Unknown change: {field}', { field: String(req.field) }));
        }

        this.undoStack.push({ id: req.id, before: this.blocks.get(req.id), label: req.label ?? tr('Changed {name}', { name: this.quickName(req.id) }) });
        this.blocks.set(req.id, b);
        return this.character(req.id)!;
    }

    /** Undoes the last change: the character it changed (null: nothing to undo). */
    undo(): { id: number; label: string; } | null
    {
        const u = this.undoStack.pop();

        if (!u)
            return null;

        if (u.path)
        {
            const p = this.paths.get(u.path)!;

            if (u.before)
                this.paths.set(u.path, { ...p, buf: u.before });
            else
                this.paths.delete(u.path);

            return { id: u.id, label: u.label };
        }

        if (u.before)
            this.blocks.set(u.id, u.before);
        else
            this.blocks.delete(u.id);

        return { id: u.id, label: u.label };
    }

    /** The gamestate with every change. */
    gamestate(): Buffer
    {
        this.g.edits.length = 0;
        const chars = this.g.characters();

        for (const [id, b] of this.blocks)
        {
            const ref = chars.get(id)!;
            this.g.edit(ref, b.toString('utf8'));
        }

        for (const p of this.paths.values())
            this.g.edit(p, p.buf.toString('utf8'));

        return this.g.apply();
    }

    /** The block a path of keys names (`county_manager/counties/c_x`): its range in the gamestate. */
    private findPath(path: string): { s: number; e: number; } | undefined
    {
        const keys = path.split('/');
        let e = this.g.section(keys[0]);

        for (const k of keys.slice(1))
            e = this.g.sub(e, k);

        return e?.block ? { s: e.s, e: e.ve } : undefined;
    }

    /** A changed block by its path (map edits); undefined: unchanged. */
    changedBlock(path: string): Buffer | undefined
    {
        return this.paths.get(path)?.buf;
    }

    /** A block by its path as it is now (its changes included); undefined: the save has none. */
    pathBlock(path: string): Buffer | undefined
    {
        const p = this.paths.get(path);

        if (p)
            return p.buf;

        const r = this.findPath(path);
        return r && this.g.buf.subarray(r.s, r.e);
    }

    /** Changes fields of a block found by its path (`null`: removed), one undo step. */
    editPath(path: string, changes: { field: string[]; value: string | null; }[], label: string): void
    {
        const r = this.paths.get(path) ?? (() =>
        {
            const f = this.findPath(path);
            return f && { ...f, buf: this.g.buf.subarray(f.s, f.e) as Buffer };
        })();

        if (!r)
            throw new Error(tr('The save has no {path}', { path }));

        let b = r.buf;

        for (const c of changes)
            b = c.value === null ? removeField(b, c.field[0]) : setField(b, c.field, c.value);

        this.undoStack.push({ id: -1, path, before: this.paths.get(path)?.buf, label });
        this.paths.set(path, { s: r.s, e: r.e, buf: b });
    }

    /** Writes the save with its changes to a new file (never the one it was read from). */
    async writeAs(out: string): Promise<{ file: string; bytes: number; }>
    {
        if (out.toLowerCase() === this.file.toLowerCase())
            throw new Error(tr('The save is written to a new file, not over the one it was read from'));

        const g = this.gamestate();
        await writeSave(out, this.save, g);
        return { file: out, bytes: g.length };
    }
}
