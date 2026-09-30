/**
 * Historical characters as a table (history/characters): parsed once, then queried for the list filters (facts at
 * a date: age, culture, faith, traits, rank) and the family tree (parents, spouses, children, siblings).
 * See docs/indexer.md ("Historical characters").
 */
import { parse, type PNode } from '../indexer/parser.ts';
import type { GameIndex } from '../indexer/gameIndex.ts';
import { BOOKMARK_DATE, History, dateNum } from '../portraits/modifiers.ts';
import type { CharacterFacets, CharacterFacetValue, CharacterFilter, CharacterHit, FamilyAncestor, FamilyDescendant, FamilyPerson, FamilyTree } from '../../shared/api.ts';

interface CharRecord
{
    id: string;
    name: string;
    female: boolean;
    dynasty?: string;
    house?: string;
    father?: string;
    mother?: string;
    birth?: number;
    death?: number;
    culture?: string;
    faith?: string;
    traits: string[];
    dna?: string;
    /** dated changes in order: culture, faith, traits, spouses, nickname */
    changes: { date: number; k: string; v: string; }[];
}

interface Facts
{
    alive: boolean;
    age?: number;
    culture?: string;
    faith?: string;
    traits: Set<string>;
    spouses: string[];
    nickname?: string;
}

const TIERS: Record<string, number> = { barony: 1, county: 2, duchy: 3, kingdom: 4, empire: 5 };
const TRACKED = new Set(['culture', 'religion', 'faith', 'trait', 'add_trait', 'remove_trait', 'add_spouse', 'add_matrilineal_spouse', 'remove_spouse', 'give_nickname']);

function fmtDate(n: number | undefined): string | undefined
{
    return n === undefined ? undefined : `${Math.floor(n / 10000)}.${Math.floor(n / 100) % 100}.${n % 100}`;
}

export class CharacterTable
{
    private idx: GameIndex;
    private history: History;
    private records: Map<string, CharRecord> | null = null;
    private childIndex = new Map<string, string[]>();
    private spouseIndex = new Map<string, Set<string>>();
    private dynastyNames = new Map<string, string>();
    private searchable: { r: CharRecord; first: string; hay: string; }[] | undefined;

    constructor(idx: GameIndex, history: History)
    {
        this.idx = idx;
        this.history = history;
    }

    private load(): Map<string, CharRecord>
    {
        if (this.records)
            return this.records;

        const records = new Map<string, CharRecord>();

        // through the mod layering: characters in files a mod hid (AGOT's replace_path) are not in the game; a later
        // record of an id wins
        for (const file of this.idx.vfs.list('history/characters', { ext: /\.txt$/i }))
        {
            const text = this.idx.vfs.readText(file);

            if (text === undefined)
                continue;

            for (const n of parse(text))
            {
                if (!n.k || !Array.isArray(n.v))
                    continue;

                const r: CharRecord = { id: n.k, name: n.k, female: false, traits: [], changes: [] };

                for (const c of n.v)
                {
                    const v = typeof c.v === 'string' ? c.v : undefined;

                    switch (c.k)
                    {
                        case 'name':
                            if (v)
                                r.name = v;

                            break;
                        case 'female':
                            r.female = v === 'yes';
                            break;
                        case 'dynasty':
                            r.dynasty = v;
                            break;
                        case 'dynasty_house':
                            r.house = v;
                            break;
                        case 'father':
                            r.father = v;
                            break;
                        case 'mother':
                            r.mother = v;
                            break;
                        case 'culture':
                            r.culture = v;
                            break;
                        case 'religion':
                        case 'faith':
                            r.faith = v;
                            break;
                        case 'trait':
                            if (v)
                                r.traits.push(v);

                            break;
                        case 'dna':
                            r.dna = v;
                            break;
                        default:
                        {
                            const date = dateNum(c.k);

                            if (date === undefined || !Array.isArray(c.v))
                                break;

                            for (const x of c.v as PNode[])
                            {
                                if (x.k === 'birth')
                                    r.birth = date;
                                else if (x.k === 'death')
                                    r.death = date;
                                else if (x.k && TRACKED.has(x.k) && typeof x.v === 'string')
                                    r.changes.push({ date, k: x.k, v: x.v });
                            }
                        }
                    }
                }

                r.changes.sort((a, b) => a.date - b.date);
                records.set(r.id, r);
            }
        }

        // reverse indexes: children by parent, marriages from both sides (history records them on one side)
        for (const r of records.values())
        {
            for (const p of [r.father, r.mother])
                if (p)
                    (this.childIndex.get(p) ?? this.childIndex.set(p, []).get(p)!).push(r.id);

            for (const c of r.changes)
            {
                if (c.k !== 'add_spouse' && c.k !== 'add_matrilineal_spouse')
                    continue;

                (this.spouseIndex.get(r.id) ?? this.spouseIndex.set(r.id, new Set()).get(r.id)!).add(c.v);
                (this.spouseIndex.get(c.v) ?? this.spouseIndex.set(c.v, new Set()).get(c.v)!).add(r.id);
            }
        }

        for (const list of this.childIndex.values())
            list.sort((a, b) => (records.get(a)?.birth ?? 0) - (records.get(b)?.birth ?? 0));

        return (this.records = records);
    }

    private factsAt(r: CharRecord, date: number): Facts
    {
        const f: Facts = {
            alive: r.birth !== undefined && r.birth <= date && (r.death === undefined || r.death > date),
            culture: r.culture,
            faith: r.faith,
            traits: new Set(r.traits),
            spouses: []
        };

        if (r.birth !== undefined && r.birth <= date)
            f.age = Math.floor((Math.min(date, r.death ?? date) - r.birth) / 10000);

        for (const c of r.changes)
        {
            if (c.date > date)
                break;

            if (c.k === 'culture')
                f.culture = c.v;
            else if (c.k === 'religion' || c.k === 'faith')
                f.faith = c.v;
            else if (c.k === 'trait' || c.k === 'add_trait')
                f.traits.add(c.v);
            else if (c.k === 'remove_trait')
                f.traits.delete(c.v);
            else if (c.k === 'add_spouse' || c.k === 'add_matrilineal_spouse')
                f.spouses.push(c.v);
            else if (c.k === 'remove_spouse')
                f.spouses = f.spouses.filter((s) => s !== c.v);
            else if (c.k === 'give_nickname')
                f.nickname = c.v;
        }

        return f;
    }

    private dynastyName(key: string | undefined, type: string): string | undefined
    {
        if (!key)
            return undefined;

        const cacheKey = type + ':' + key;
        let n = this.dynastyNames.get(cacheKey);

        if (n === undefined)
        {
            // dynasties/houses name themselves: name = "dynn_Godwin", prefix = "dynnp_of"
            const e = this.idx.get(type, key);
            const d = e && this.idx.defNode(e);
            const body = d && Array.isArray(d.node.v) ? d.node.v : [];
            const field = (k: string): string | undefined =>
            {
                const c = body.find((x) => x.k === k);
                return typeof c?.v === 'string' ? c.v : undefined;
            };
            const nameKey = field('name');
            const prefixKey = field('prefix');
            const name = nameKey ? (this.idx.plainLoc(nameKey) ?? nameKey) : e ? this.idx.displayName(e) : undefined;
            const prefix = prefixKey ? this.idx.plainLoc(prefixKey) : undefined;
            n = name ? (prefix ? `${prefix.trim()} ${name}` : name) : '';
            this.dynastyNames.set(cacheKey, n);
        }

        return n || undefined;
    }

    /** Ids of the characters matching the filter. */
    filter(f: CharacterFilter): string[]
    {
        const records = this.load();
        const date = dateNum(f.date) ?? BOOKMARK_DATE;
        const tiers = f.rank ? this.history.holderTiers(date) : undefined;
        const religionOf = (faith: string | undefined): string | undefined => (faith ? this.history.faith(faith)?.religion : undefined);
        const dyn = f.dynasty?.trim().toLowerCase();
        const out: string[] = [];

        for (const r of records.values())
        {
            if (f.gender && (r.female ? 'female' : 'male') !== f.gender)
                continue;

            if (f.dna !== undefined && !!r.dna !== f.dna)
                continue;

            if (dyn)
            {
                const names = [r.dynasty, r.house, this.dynastyName(r.dynasty, 'dynasties'), this.dynastyName(r.house, 'dynasty_houses')];

                if (!names.some((x) => x?.toLowerCase().includes(dyn)))
                    continue;
            }

            const at = this.factsAt(r, date);

            if (f.alive !== undefined && at.alive !== f.alive)
                continue;

            if (f.age)
            {
                if (!at.alive || at.age === undefined)
                    continue;

                if (f.age.op === '<' ? !(at.age < f.age.value) : f.age.op === '>' ? !(at.age > f.age.value) : at.age !== f.age.value)
                    continue;
            }

            if (f.culture && at.culture !== f.culture)
                continue;

            if (f.faith && at.faith !== f.faith)
                continue;

            if (f.religion && religionOf(at.faith) !== f.religion)
                continue;

            if (f.trait && !at.traits.has(f.trait))
                continue;

            if (f.rank)
            {
                const tier = tiers!.get(r.id) ?? 0;

                if (f.rank === 'ruler' ? tier === 0 : f.rank === 'unlanded' ? tier > 0 : tier !== TIERS[f.rank])
                    continue;
            }

            out.push(r.id);
        }

        return out;
    }

    /** Values to offer in the filter dropdowns, with how many characters start with them. */
    facets(): CharacterFacets
    {
        const records = this.load();
        const count = (m: Map<string, number>, k: string | undefined): void =>
        {
            if (k)
                m.set(k, (m.get(k) ?? 0) + 1);
        };
        const cultures = new Map<string, number>();
        const faiths = new Map<string, number>();
        const religions = new Map<string, number>();
        const traits = new Map<string, number>();

        for (const r of records.values())
        {
            count(cultures, r.culture);
            count(faiths, r.faith);
            count(religions, r.faith ? this.history.faith(r.faith)?.religion : undefined);

            for (const t of r.traits)
                count(traits, t);
        }

        const list = (m: Map<string, number>, type: string): CharacterFacetValue[] =>
            [...m]
                .map(([key, n]) =>
                {
                    const e = this.idx.get(type, key);
                    return { key, label: (e && this.idx.displayName(e)) || key, count: n };
                })
                .sort((a, b) => a.label.localeCompare(b.label));
        return {
            cultures: list(cultures, 'culture/cultures'),
            faiths: list(faiths, 'faith'),
            religions: list(religions, 'religion/religion_types'),
            traits: list(traits, 'traits')
        };
    }

    /**
     * Historical characters by name for the statement picker (docs/picker.md, "Historical characters"): every word
     * typed is in the first name, the id, the house's or the dynasty's name; rulers at the 1066 bookmark first (higher
     * tiers first), then by how well the first word fits the first name, then by birth. Each with its full name
     * ("William de Normandie “the Conqueror”") and who it is (highest title, lifetime, id).
     */
    search(q: string, limit = 60): CharacterHit[]
    {
        const records = this.load();
        const terms = q.toLowerCase()
            .split(/\s+/)
            .filter(Boolean);

        if (!terms.length)
            return [];

        const tiers = this.history.holderTiers(BOOKMARK_DATE);
        const hits: { r: CharRecord; score: number; }[] = [];
        // (what a search looks in, made once: first name, id, house and dynasty names)
        this.searchable ??= [...records.values()].map((r) =>
        {
            const first = (this.idx.plainLoc(r.name) ?? r.name).toLowerCase();
            return { r, first, hay: `${first} ${r.id.toLowerCase()} ${(this.dynastyName(r.house, 'dynasty_houses') ?? '').toLowerCase()} ${(this.dynastyName(r.dynasty, 'dynasties') ?? '').toLowerCase()}` };
        });

        for (const { r, first, hay } of this.searchable)
        {
            if (!terms.every((t) => hay.includes(t)))
                continue;

            const fit = r.id.toLowerCase() === terms[0] ? 0 : first === terms[0] ? 1 : first.startsWith(terms[0]) ? 2 : 3;
            hits.push({ r, score: fit * 10 - (tiers.get(r.id) ?? 0) });
        }

        hits.sort((a, b) => a.score - b.score || (a.r.birth ?? 0) - (b.r.birth ?? 0));
        return hits.slice(0, limit).map(({ r }) =>
        {
            const nick = this.factsAt(r, r.death ?? BOOKMARK_DATE).nickname;
            const nickName = nick ? this.idx.plainLoc(nick) : undefined;
            const house = this.dynastyName(r.house, 'dynasty_houses') ?? this.dynastyName(r.dynasty, 'dynasties');
            const titles = this.history.facts(r.id)?.titles ?? [];
            const top = titles[0] ? this.idx.get('landed_titles', titles[0].name) : undefined;
            const year = (n: number | undefined): string => (n === undefined ? '?' : String(Math.floor(n / 10000)));
            const life = r.birth !== undefined || r.death !== undefined ? `${year(r.birth)}–${r.death === undefined ? '' : year(r.death)}` : '';
            return {
                id: r.id,
                name: [this.idx.plainLoc(r.name) ?? r.name, house, nickName ? `“${nickName}”` : ''].filter(Boolean).join(' '),
                about: [top ? (this.idx.displayName(top) ?? top.name) : '', life, r.id].filter(Boolean).join(' · '),
                female: r.female
            };
        });
    }

    // ---------------------------------------------------------------------------
    // Family tree
    // ---------------------------------------------------------------------------

    private person(id: string): FamilyPerson | undefined
    {
        const r = this.load().get(id);

        if (!r)
            return undefined;

        const nick = this.factsAt(r, r.death ?? BOOKMARK_DATE).nickname;
        const nickName = nick ? (this.idx.plainLoc(nick) ?? '') : '';
        const titles = this.history.facts(id)?.titles ?? [];
        const top = titles[0] ? this.idx.get('landed_titles', titles[0].name) : undefined;
        return {
            id,
            name: nickName ? `${this.idx.plainLoc(r.name) ?? r.name} ${nickName}` : (this.idx.plainLoc(r.name) ?? r.name),
            house: this.dynastyName(r.house, 'dynasty_houses') ?? this.dynastyName(r.dynasty, 'dynasties'),
            female: r.female,
            birth: fmtDate(r.birth),
            death: fmtDate(r.death),
            title: top ? (this.idx.displayName(top) ?? top.name) : undefined
        };
    }

    private ancestor(id: string | undefined, depth: number): FamilyAncestor | undefined
    {
        const p = id ? this.person(id) : undefined;

        if (!p)
            return undefined;

        const r = this.load().get(id!)!;
        return depth > 0 ? { ...p, father: this.ancestor(r.father, depth - 1), mother: this.ancestor(r.mother, depth - 1) } : p;
    }

    private descendants(id: string, depth: number): FamilyDescendant[]
    {
        const records = this.load();
        return (this.childIndex.get(id) ?? []).flatMap((cid) =>
        {
            const p = this.person(cid);

            if (!p)
                return [];

            const c = records.get(cid)!;
            const other = c.father === id ? c.mother : c.father;
            return [{ ...p, otherParent: other ? this.person(other) : undefined, children: depth > 1 ? this.descendants(cid, depth - 1) : [] }];
        });
    }

    /** Three generations up, the spouses, two generations down and the siblings of a historical character. */
    familyTree(id: string): FamilyTree | null
    {
        const records = this.load();
        const r = records.get(id);

        if (!r)
            return null;

        const root = this.ancestor(id, 3)!;
        const spouses = [...(this.spouseIndex.get(id) ?? [])].map((s) => this.person(s)).filter((p): p is FamilyPerson => !!p);
        const sib = new Map<string, boolean>();

        for (const p of [r.father, r.mother])
        {
            for (const s of p ? (this.childIndex.get(p) ?? []) : [])
            {
                if (s === id)
                    continue;

                const o = records.get(s)!;
                const full = !!r.father && !!r.mother && o.father === r.father && o.mother === r.mother;
                sib.set(s, (sib.get(s) ?? false) || full);
            }
        }

        const siblings = [...sib]
            .sort((a, b) => (records.get(a[0])?.birth ?? 0) - (records.get(b[0])?.birth ?? 0))
            .map(([s, full]) => ({ ...this.person(s)!, half: !full }));
        return { root, spouses, children: this.descendants(id, 2), siblings };
    }
}
