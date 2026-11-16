/**
 * What a new historical character is made from (docs/mods.md, "New characters"; mods/create.ts `character`): a
 * relative's basics as their history writes them, and a name from a culture's name list. Run in the index worker.
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import type { PNode } from '../indexer/parser.ts';

/** A character's basics: their own fields (not the dated changes), parents and birth date. */
export interface CharacterBasis
{
    id: string;
    name?: string;
    female: boolean;
    /** y.m.d of `<date> = { birth = yes }` */
    birth?: string;
    dynasty?: string;
    house?: string;
    culture?: string;
    /** a faith or (1.20) a rite, as written */
    faith?: string;
    father?: string;
    mother?: string;
    traits: string[];
}

const DATE = /^\d+\.\d+\.\d+$/;
const kids = (n: PNode | undefined): PNode[] => (n && Array.isArray(n.v) ? n.v : []);
const value = (list: PNode[], k: string): string | undefined =>
{
    const c = list.find((x) => x.k === k && typeof x.v === 'string');
    return c ? (c.v as string).replace(/"/g, '') : undefined;
};

export function characterBasis(idx: GameIndex, id: string): CharacterBasis | null
{
    const e = idx.get('characters', id);
    const node = e && idx.defNode(e)?.node;

    if (!node || !Array.isArray(node.v))
        return null;

    const list = node.v;
    const born = list.find((c) => c.k && DATE.test(c.k) && kids(c).some((x) => x.k === 'birth'));
    return {
        id,
        name: value(list, 'name'),
        female: value(list, 'female') === 'yes',
        birth: born?.k ?? undefined,
        dynasty: value(list, 'dynasty'),
        house: value(list, 'dynasty_house'),
        culture: value(list, 'culture'),
        faith: value(list, 'rite') ?? value(list, 'religion') ?? value(list, 'faith'),
        father: value(list, 'father'),
        mother: value(list, 'mother'),
        traits: list.filter((c) => c.k === 'trait' && typeof c.v === 'string').map((c) => c.v as string)
    };
}

/** Every name of a name block, plain (`{ a b }`) or in weight groups (`{ 10 = { a b } 1 = { c } }`). */
function namesOf(n: PNode | undefined): string[]
{
    const plain = (l: PNode[]): string[] => l.filter((c) => !c.k && typeof c.v === 'string').map((c) => (c.v as string).replace(/"/g, ''));
    return [...plain(kids(n)), ...kids(n).filter((c) => c.k && Array.isArray(c.v)).flatMap((c) => plain(kids(c)))];
}

/** A name for a new character of the culture (its name lists' male_names / female_names), picked by `seed`. */
export function cultureName(idx: GameIndex, culture: string | undefined, female: boolean, seed: number): string | undefined
{
    const e = culture ? idx.get('culture/cultures', culture) : undefined;
    const node = e && idx.defNode(e)?.node;
    const lists = kids(node).filter((c) => c.k === 'name_list' && typeof c.v === 'string').map((c) => c.v as string);
    const names = lists.flatMap((l) =>
    {
        const ne = idx.get('culture/name_lists', l);
        const nn = ne && idx.defNode(ne)?.node;
        return namesOf(kids(nn).find((c) => c.k === (female ? 'female_names' : 'male_names')));
    });

    return names.length ? names[Math.abs(Math.floor(seed)) % names.length] : undefined;
}
