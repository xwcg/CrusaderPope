/**
 * Title names at a date (docs/map.md, "History and realms"): the name history gives a title (`name = WEST_FRANCIA`,
 * `set_title_name`), else its cultural name for the holder's culture (landed_titles `cultural_names`); and a ruler's
 * primary title named as the game names realms on its map — after the holder's house ("Abbasid Empire") when their
 * government names realms after dynasties (governments: `dynasty_named_realms`) and their culture's name list allows it
 * (name_lists: `house_based_map_names`), with the tier name the game's flavorization gives the title
 * (common/flavorization); after their culture ("Pechenegs") or house and culture ("Ildeyid Pechenegs") when their
 * government has `uses_culture_and_house_head_named_realms` (nomads) and they head the culture or their house.
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { T_FAITH } from '../indexer/schema.ts';
import { scalarOf } from './history.ts';
import type { TitleTree } from './titles.ts';

/** title tier letter → the flavorization / loc word */
const TIER_WORDS: Record<string, string> = { b: 'barony', c: 'county', d: 'duchy', k: 'kingdom', e: 'empire', h: 'hegemony' };

/** Who a title's name depends on: its holder, and the top liege of the holder's realm. */
export interface NameCtx
{
    government?: string;
    culture?: string;
    faith?: string;
}

/** A culture as names and the head of the culture depend on it (common/culture/cultures). */
export interface CultureInfo
{
    heritage?: string;
    /** `name_list`s, the first is its primary one */
    lists: string[];
    /** its pillars: ethos, heritage, language, martial custom, head determination */
    pillars: Set<string>;
    /** how its head is found (`head_determination`: common/culture/pillars `head_determination_type`): domain (default), herd */
    head: string;
}

interface Flavour
{
    key: string;
    tier: string;
    priority: number;
    lists: [string, Set<string>][];
    /** barony flavours: the holding of the barony */
    holding?: string;
    topLiege: boolean;
    ownGovernment: boolean;
    onlyIndependent: boolean;
    onlyVassals: boolean;
}

interface Government
{
    key: string;
    dynastyNamed: boolean;
    /** `uses_culture_and_house_head_named_realms` (nomads) */
    nomadNamed: boolean;
    holding?: string;
    heritages: Set<string>;
    religions: Set<string>;
    fallback: number;
    conditional: boolean;
}

const kids = (n: PNode | undefined): PNode[] => (n && Array.isArray(n.v) ? n.v : []);
const field = (list: PNode[], k: string): PNode | undefined => list.find((c) => c.k === k);
const words = (n: PNode | undefined): string[] => kids(n).filter((c) => !c.k && typeof c.v === 'string').map((c) => c.v as string);
/** flavorization conditions the map can test; entries with others (flags, contracts, council) never apply */
const LISTS = ['governments', 'name_lists', 'heritages', 'faiths', 'religions', 'titles', 'de_jure_liege'];
const UNKNOWN = new Set(['flag', 'subject_contract_obligation_flags', 'council_position', 'domicile_type']);
/** culture keys that name its pillars */
const PILLARS = ['ethos', 'heritage', 'language', 'martial_custom', 'head_determination'];

export class TitleNamer
{
    private idx: GameIndex;
    private tree: TitleTree;
    private locs = new Map<string, string | null>();
    private cultural = new Map<number, Map<string, string>>();
    private cultures = new Map<string, CultureInfo | null>();
    private headTypes = new Map<string, string>();
    private listHouseNames = new Map<string, boolean>();
    private houses = new Map<string, string | null>();
    /** per tier word: its flavours, the highest priority first (file order among equals) */
    private flavours = new Map<string, Flavour[]>();
    private governments = new Map<string, Government>();
    private defaults = new Map<string, string | undefined>();
    /** per title: `can_be_named_after_dynasty = no`, `can_use_nomadic_naming = no` */
    private optOut = new Map<number, { dynasty: boolean; nomad: boolean; }>();
    private religions = new Map<string, string>();

    /** @param flavorization the texts of common/flavorization in load order */
    constructor(idx: GameIndex, tree: TitleTree, flavorization: string[])
    {
        this.idx = idx;
        this.tree = tree;
        const byKey = new Map<string, Flavour>();

        for (const text of flavorization)
        {
            for (const n of parse(text))
            {
                const body = kids(n);

                if (!n.k || scalarOf(field(body, 'type')) !== 'title' || body.some((c) => c.k && UNKNOWN.has(c.k)))
                    continue;

                const rules = kids(field(body, 'flavourization_rules'));
                const rule = (k: string): string | undefined => scalarOf(field(rules, k));
                byKey.set(n.k, {
                    key: n.k,
                    tier: scalarOf(field(body, 'tier')) ?? 'none',
                    priority: Number(scalarOf(field(body, 'priority')) ?? 0),
                    lists: LISTS.filter((k) => field(body, k)).map((k) => [k, new Set(words(field(body, k)))]),
                    holding: scalarOf(field(body, 'holding')),
                    topLiege: rule('top_liege') !== 'no',
                    ownGovernment: rule('ignore_top_liege_government') === 'yes',
                    onlyIndependent: rule('only_independent') === 'yes',
                    onlyVassals: rule('only_vassals') === 'yes'
                });
            }
        }

        // (an entry without a tier is for every tier: _flavourization.info — d_khorezm's "Khwarezmshahdom", k_saxony's "Principality")
        for (const tier of Object.values(TIER_WORDS))
        {
            this.flavours.set(
                tier,
                [...byKey.values()].filter((f) => f.tier === tier || f.tier === 'none').sort((a, b) => b.priority - a.priority)
            );
        }

        for (const key of idx.names('governments'))
        {
            const e = idx.get('governments', key);
            const body = kids(e && idx.defNode(e)?.node);

            if (!body.length)
                continue;

            const rules = kids(field(body, 'government_rules'));
            this.governments.set(key, {
                key,
                dynastyNamed: scalarOf(field(rules, 'dynasty_named_realms')) === 'yes',
                nomadNamed: scalarOf(field(rules, 'uses_culture_and_house_head_named_realms')) === 'yes',
                holding: scalarOf(field(body, 'primary_holding')),
                heritages: new Set(words(field(body, 'primary_heritages'))),
                religions: new Set(words(field(body, 'preferred_religions'))),
                fallback: Number(scalarOf(field(body, 'fallback')) ?? 0) || Infinity,
                conditional: !!field(body, 'can_get_government')
            });
        }

        for (const religion of idx.names('religion/religion_types'))
        {
            const e = idx.get('religion/religion_types', religion);

            for (const f of kids(field(kids(e && idx.defNode(e)?.node), 'faiths')))
                if (f.k)
                    this.religions.set(f.k, religion);
        }

        // (faiths of religions a mod hid are not in the game)
        for (const f of [...this.religions.keys()])
            if (!idx.get(T_FAITH, f))
                this.religions.delete(f);
    }

    /** Localization of a key (a loc key or a title key), plain text. */
    loc(key: string): string | undefined
    {
        let v = this.locs.get(key);

        if (v === undefined)
        {
            v = this.idx.plainLoc(key)?.trim() || null;
            this.locs.set(key, v);
        }

        return v ?? undefined;
    }

    culture(key: string): CultureInfo | undefined
    {
        let c = this.cultures.get(key);

        if (c === undefined)
        {
            const e = this.idx.get('culture/cultures', key);
            const body = kids(e && this.idx.defNode(e)?.node);
            const pillars = new Set(PILLARS.map((k) => scalarOf(field(body, k))).filter((p): p is string => !!p));
            const head = scalarOf(field(body, 'head_determination'));
            c = body.length
                ? { heritage: scalarOf(field(body, 'heritage')), lists: body.filter((x) => x.k === 'name_list').map((x) => scalarOf(x)!), pillars, head: head ? this.headType(head) : 'domain' }
                : null;
            this.cultures.set(key, c);
        }

        return c ?? undefined;
    }

    /** common/culture/pillars: `head_determination_herd = { head_determination_type = herd }` */
    private headType(pillar: string): string
    {
        let v = this.headTypes.get(pillar);

        if (v === undefined)
        {
            const e = this.idx.get('culture/pillars', pillar);
            v = scalarOf(field(kids(e && this.idx.defNode(e)?.node), 'head_determination_type')) ?? 'domain';
            this.headTypes.set(pillar, v);
        }

        return v;
    }

    /** A faith's religion (common/religion/religion_types). */
    religionOf(faith: string | undefined): string | undefined
    {
        return faith ? this.religions.get(faith) : undefined;
    }

    /** The government names realms after the ruler's culture and house (nomads). */
    nomadNamed(government: string | undefined): boolean
    {
        return !!government && !!this.governments.get(government)?.nomadNamed;
    }

    /** The loc key of a title's cultural name for a culture (its name lists in order), if it has one. */
    culturalName(t: number, culture: string | undefined): string | undefined
    {
        if (!culture)
            return undefined;

        let names = this.cultural.get(t);

        if (!names)
        {
            names = new Map(kids(field(kids(this.tree.titles[t].node), 'cultural_names')).map((c) => [c.k!, scalarOf(c)!]));
            this.cultural.set(t, names);
        }

        if (!names.size)
            return undefined;

        for (const list of this.culture(culture)?.lists ?? [])
            if (names.has(list))
                return names.get(list);

        return undefined;
    }

    /** A house's (or dynasty's) name without its prefix: dynasty_houses / dynasties `name = dynn_Abbasid`. */
    houseName(type: 'dynasty_houses' | 'dynasties', key: string): string | undefined
    {
        const k = type + ':' + key;
        let v = this.houses.get(k);

        if (v === undefined)
        {
            const e = this.idx.get(type, key);
            const name = scalarOf(field(kids(e && this.idx.defNode(e)?.node), 'name'));
            v = (name && (this.loc(name) ?? name)) || null;
            this.houses.set(k, v);
        }

        return v ?? undefined;
    }

    /**
     * The government a ruler without one from history gets: of those whose primary holding is the holding of their
     * capital, one that prefers their heritage or religion, else the first fallback (feudal).
     */
    defaultGovernment(holding: string | undefined, culture: string | undefined, faith: string | undefined): string | undefined
    {
        const key = `${holding}|${culture}|${faith}`;

        if (this.defaults.has(key))
            return this.defaults.get(key);

        const heritage = culture ? this.culture(culture)?.heritage : undefined;
        const religion = this.religionOf(faith);
        const score = (g: Government): number => (g.holding === holding ? 4 : 0) + ((heritage && g.heritages.has(heritage)) || (religion && g.religions.has(religion)) ? 2 : 0) - (g.conditional ? 1 : 0);
        let best: Government | undefined;

        for (const g of this.governments.values())
            if (!best || score(g) > score(best) || (score(g) === score(best) && g.fallback < best.fallback))
                best = g;

        this.defaults.set(key, best?.key);
        return best?.key;
    }

    /**
     * The tier name flavorization gives a title (`type = title`): of the entries for its tier whose conditions hold,
     * the first of the highest priority. The conditions are tested on the top liege (`top_liege = no`: the holder); a
     * barony's `holding` on its holding at the date.
     */
    tierName(t: number, dejure: number[], holder: NameCtx, top: NameCtx, independent: boolean, holding?: string): string | undefined
    {
        for (const f of this.flavours.get(TIER_WORDS[this.tree.titles[t].tier]) ?? [])
        {
            if ((f.onlyIndependent && !independent) || (f.onlyVassals && independent) || (f.holding && f.holding !== holding))
                continue;

            const who = f.topLiege ? top : holder;
            const government = f.ownGovernment ? holder.government : who.government;
            const culture = who.culture ? this.culture(who.culture) : undefined;
            const ok = f.lists.every(([k, set]) =>
            {
                switch (k)
                {
                    case 'governments':
                        return !!government && set.has(government);
                    case 'name_lists':
                        return !!culture?.lists.some((l) => set.has(l));
                    case 'heritages':
                        return !!culture?.heritage && set.has(culture.heritage);
                    case 'faiths':
                        return !!who.faith && set.has(who.faith);
                    case 'religions':
                        return set.has(this.religionOf(who.faith) ?? '');
                    case 'titles':
                        return set.has(this.tree.titles[t].key);
                    default:
                        return dejure.some((d) => set.has(this.tree.titles[d].key));
                }
            });

            if (ok)
                return this.loc(f.key);
        }

        return undefined;
    }

    /**
     * The realm name after the holder's house for a ruler's primary title ("Abbasid Empire"): governments with
     * `dynasty_named_realms`, cultures whose first name list has `house_based_map_names`, titles that don't forbid it
     * (`can_be_named_after_dynasty = no`). Localization: TITLE_CLAN_TIERED_NAME ("the $NAME$ $TIER|U$"), without the
     * article on the map.
     */
    houseRealmName(t: number, dejure: number[], holder: NameCtx & { house?: string; dynasty?: string; }, top: NameCtx, independent: boolean, holding?: string): string | undefined
    {
        if (!holder.government || !this.governments.get(holder.government)?.dynastyNamed)
            return undefined;

        const list = holder.culture ? this.culture(holder.culture)?.lists[0] : undefined;

        if (!list || !this.houseBasedNames(list))
            return undefined;

        if (this.optsOut(t).dynasty)
            return undefined;

        const house = this.houseOf(holder);
        const tier = house && this.tierName(t, dejure, holder, top, independent, holding);

        if (!house || !tier)
            return undefined;

        return this.template('TITLE_CLAN_TIERED_NAME', '$NAME$ $TIER|U$', { NAME: house, TIER: tier });
    }

    /**
     * The realm name of a nomad (governments: `uses_culture_and_house_head_named_realms`; titles opt out with
     * `can_use_nomadic_naming = no`): the head of the culture's realm after the culture — TITLE_NOMAD_NAME_CULTURE_HEAD
     * "$CULTURE_COLLECTIVE$" (loc `<culture>_collective_noun`: "Pechenegs") —, the head of a house's after house and
     * culture — TITLE_NOMAD_NAME_HOUSE_HEAD "$DYNASTY_NAME$ $CULTURE_COLLECTIVE$" ("Ildeyid Pechenegs"); other rulers'
     * keep their title's name (common/governments/_governments.info).
     */
    nomadRealmName(t: number, holder: NameCtx & { house?: string; dynasty?: string; }, cultureHead: boolean, houseHead: boolean): string | undefined
    {
        if ((!cultureHead && !houseHead) || !holder.culture || !this.nomadNamed(holder.government))
            return undefined;

        if (this.optsOut(t).nomad)
            return undefined;

        const people = this.loc(holder.culture + '_collective_noun') ?? this.loc(holder.culture);

        if (!people)
            return undefined;

        if (cultureHead)
            return this.template('TITLE_NOMAD_NAME_CULTURE_HEAD', '$CULTURE_COLLECTIVE$', { CULTURE_COLLECTIVE: people });

        const house = this.houseOf(holder);
        return house ? this.template('TITLE_NOMAD_NAME_HOUSE_HEAD', '$DYNASTY_NAME$ $CULTURE_COLLECTIVE$', { DYNASTY_NAME: house, CULTURE_COLLECTIVE: people }) : undefined;
    }

    private optsOut(t: number): { dynasty: boolean; nomad: boolean; }
    {
        let v = this.optOut.get(t);

        if (!v)
        {
            const body = kids(this.tree.titles[t].node);
            v = { dynasty: scalarOf(field(body, 'can_be_named_after_dynasty')) === 'no', nomad: scalarOf(field(body, 'can_use_nomadic_naming')) === 'no' };
            this.optOut.set(t, v);
        }

        return v;
    }

    /** The holder's house name (else their dynasty's) without its prefix. */
    private houseOf(holder: { house?: string; dynasty?: string; }): string | undefined
    {
        return holder.house ? this.houseName('dynasty_houses', holder.house) : holder.dynasty ? this.houseName('dynasties', holder.dynasty) : undefined;
    }

    /** A loc template with `$KEY$` / `$KEY|U$` filled in, the article left out (the map's names have none). */
    private template(key: string, fallback: string, values: Record<string, string>): string
    {
        return (this.idx.locRaw(key) ?? fallback)
            .replace(/\$(\w+)(\|U)?\$/g, (m, k: string, u: string | undefined) =>
            {
                const v = values[k];
                return v === undefined ? m : u ? v.charAt(0).toUpperCase() + v.slice(1) : v;
            })
            .replace(/^the /, '')
            .trim();
    }

    private houseBasedNames(list: string): boolean
    {
        let v = this.listHouseNames.get(list);

        if (v === undefined)
        {
            const e = this.idx.get('culture/name_lists', list);
            v = scalarOf(field(kids(e && this.idx.defNode(e)?.node), 'house_based_map_names')) === 'yes';
            this.listHouseNames.set(list, v);
        }

        return v;
    }
}
