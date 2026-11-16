/**
 * The loaded save as files of the index (docs/saves.md, "The save as a layer of the index"): what the save holds, written
 * in the game's own script format so the index and the cards read it as they read game data.
 *
 * `savegame/characters/characters.txt`: every character of the save as a history-character-like block keyed by its save
 * id: name, sex, nickname, dynasty or house (game keys), culture and religion (keys from the save's lookups), skills,
 * traits, birth, parents (from the parents' `family_data.child`), spouses on the save's date, death.
 */
import type { SaveLayer } from '../mods/gamefiles.ts';
import { child, children, scalar } from '../indexer/parser.ts';
import { cleanText, entries, Gamestate } from './gamestate.ts';
import { projectState, SAVE_FAITHS_FILE } from './project-state.ts';

import { T_SAVE_CHARACTER } from '../indexer/schema.ts';

export { T_SAVE_CHARACTER };
/** the characters' files: 1,000 a file (an edit re-reads one, docs/saves.md) */
export const SAVE_CHARACTERS_PER_FILE = 1000;
export const saveCharactersFile = (n: number): string => `savegame/characters/characters_${String(n).padStart(3, '0')}.txt`;

const SKILL_KEYS = ['diplomacy', 'martial', 'stewardship', 'intrigue', 'learning', 'prowess'];
const utf8 = (latin1: string): string => Buffer.from(latin1, 'latin1').toString('utf8');
const quote = (s: string): string => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/** House id → the key a character refers to: `dynasty_house = <key>` (a static house), else `dynasty = <key>`. */
function houseRefs(g: Gamestate): Map<number, string>
{
    const out = new Map<number, string>();
    const b = g.buf;
    const dyn = g.section('dynasties');
    const dynKeys = new Map<number, string>();

    for (const x of entries(b, g.sub(dyn, 'dynasties')?.vs ?? 0, g.sub(dyn, 'dynasties')?.ve ?? 0))
    {
        if (!x.block || !x.key || !/^\d+$/.test(x.key))
            continue;

        for (const f of entries(b, x.vs, x.ve))
        {
            if (f.key === 'key' && !f.block)
            {
                dynKeys.set(Number(x.key), b.subarray(f.vs, f.ve).toString('latin1').replace(/^"|"$/g, ''));
                break;
            }
        }
    }

    const houses = g.sub(dyn, 'dynasty_house');

    if (!houses)
        return out;

    for (const x of entries(b, houses.vs, houses.ve))
    {
        if (!x.block || !x.key || !/^\d+$/.test(x.key))
            continue;

        let key: string | undefined;
        let dynasty: number | undefined;

        for (const f of entries(b, x.vs, x.ve))
        {
            if (f.block)
                continue;

            if (f.key === 'key')
                key = b.subarray(f.vs, f.ve).toString('latin1').replace(/^"|"$/g, '');
            else if (f.key === 'dynasty')
                dynasty = Number(b.subarray(f.vs, f.ve).toString('latin1'));
        }

        if (key)
            out.set(Number(x.key), `dynasty_house = ${key}`);
        else if (dynasty !== undefined && dynKeys.has(dynasty))
            out.set(Number(x.key), `dynasty = ${dynKeys.get(dynasty)}`);
    }

    return out;
}

/** The save's characters as history-character files (`saveCharactersFile(n)` → its text). */
export function projectCharacters(g: Gamestate): Map<string, string>
{
    const chars = g.characters();
    const traits = g.traitLookup();
    const cultures = g.cultures();
    // (the faiths' keys as the game knows them: a reformed faith's template, its own `name` stays the save's)
    const faiths = g.faithGameKeys();
    const houses = houseRefs(g);
    const date = g.date();
    // parents: the save lists children on the parents (family_data.child), added to each child's block at the end
    const parents = new Map<number, { father?: number; mother?: number; }>();
    const blocks = new Map<number, string[]>();

    for (const ref of chars.values())
    {
        const n = g.character(ref.id)?.node ?? [];
        const s = (k: string): string | undefined =>
        {
            const v = scalar(child(n, k));
            return v === undefined ? undefined : utf8(v);
        };
        const lines: string[] = [];
        const add = (text: string): void => void lines.push('\t' + text);
        const female = s('female') === 'yes';
        add(`name = ${quote(cleanText(s('first_name') ?? ''))}`);

        if (female)
            add('female = yes');

        const nick = s('nickname');

        if (nick)
            add(`give_nickname = ${nick}`);

        const house = Number(s('dynasty_house'));

        if (houses.has(house))
            add(houses.get(house)!);

        const culture = cultures.get(Number(s('culture')));

        if (culture)
            add(`culture = ${culture}`);

        // (`faith = <id>` in 1.18 / 1.19 saves, `rite = <id>` in 1.20 ones)
        const faithId = g.faithOf(s('faith'), s('rite'));
        const faith = faithId === undefined ? undefined : faiths.get(faithId);

        if (faith)
            add(`religion = ${faith}`);

        const skills = child(n, 'skill');

        if (skills && Array.isArray(skills.v))
            skills.v.forEach((x, i) => SKILL_KEYS[i] && scalar(x) !== undefined && add(`${SKILL_KEYS[i]} = ${scalar(x)}`));

        const sexuality = s('sexuality');

        if (sexuality)
            add(`sexuality = ${({ he: 'heterosexual', ho: 'homosexual', bi: 'bisexual', as: 'asexual' } as Record<string, string>)[sexuality] ?? sexuality}`);

        const t = child(n, 'traits');

        for (const x of t && Array.isArray(t.v) ? t.v : [])
        {
            const key = traits[Number(scalar(x))];

            if (key)
                add(`trait = ${key}`);
        }

        const birth = s('birth');

        if (birth)
            add(`${birth} = { birth = yes }`);

        const fam = child(n, 'family_data');
        const list = (k: string): string[] => (fam ? children(fam, k).flatMap((x) => (Array.isArray(x.v) ? x.v.map((y) => scalar(y)) : [scalar(x)])).filter((x): x is string => !!x) : []);

        for (const id of list('child'))
        {
            const p = parents.get(Number(id)) ?? {};
            p[female ? 'mother' : 'father'] = ref.id;
            parents.set(Number(id), p);
        }

        // spouses: on the save's date (the save doesn't say since when)
        const spouses = list('spouse');

        if (spouses.length && ref.place === 'living')
            add(`${date} = { ${spouses.map((x) => `add_spouse = ${x}`).join(' ')} }`);

        const dead = child(n, 'dead_data');

        if (dead)
        {
            const reason = scalar(child(dead, 'reason'));
            add(`${scalar(child(dead, 'date')) ?? date} = { death = ${reason ? `{ death_reason = ${reason} }` : 'yes'} }`);
        }

        blocks.set(ref.id, lines);
    }

    const out = new Map<string, string>();
    let part: string[] = [];
    const flush = (): void =>
    {
        if (part.length)
            out.set(saveCharactersFile(out.size), part.join('\n') + '\n');

        part = [];
    };

    for (const [id, lines] of blocks)
    {
        const p = parents.get(id);

        if (p?.father !== undefined)
            lines.push(`\tfather = ${p.father}`);

        if (p?.mother !== undefined)
            lines.push(`\tmother = ${p.mother}`);

        part.push(`${id} = {\n${lines.join('\n')}\n}`);

        if (part.length >= SAVE_CHARACTERS_PER_FILE)
            flush();
    }

    flush();
    return out;
}

/** Historical characters the save has (`character_lookup`: a history id → the save's character). */
function characterOverrides(g: Gamestate): Map<string, { type?: string; name?: string; }>
{
    const out = new Map<string, { type?: string; name?: string; }>();
    const e = g.section('character_lookup');
    const chars = g.characters();

    if (!e?.block)
        return out;

    for (const x of entries(g.buf, e.vs, e.ve))
    {
        if (!x.key || x.block)
            continue;

        const id = Number(g.buf.subarray(x.vs, x.ve).toString('latin1'));

        // (a character the save no longer has: nothing carries the historical one)
        if (chars.has(id))
            out.set(`characters|${x.key}`, { type: T_SAVE_CHARACTER, name: String(id) });
    }

    return out;
}

/** The save's layer of the index: its files, made from the save. */
export function saveLayer(file: string, mtime: number, g: Gamestate, name: string): SaveLayer
{
    const state = projectState(g);
    return {
        id: 'save:' + file,
        name,
        file,
        mtime,
        files: new Map([
            ...[...projectCharacters(g)].map(([rel, text]) => [rel, Buffer.from(text, 'utf8')] as [string, Buffer]),
            [SAVE_FAITHS_FILE, Buffer.from(state.faiths, 'utf8')]
        ]),
        overrides: new Map([...characterOverrides(g), ...state.overrides]),
        facts: state.facts
    };
}
