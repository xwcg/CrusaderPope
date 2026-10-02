/**
 * History at a date as coats of arms need it (docs/map.md, "Coats of arms"): who holds a title and what the holder is
 * then — culture, faith, dynasty, house, traits, primary title, liege, government — plus what the triggers of dynamic
 * definitions, special selections and game start effects ask about titles, cultures, faiths and governments. Read
 * through the index's layering on first use: history/titles (holders, lieges, governments), history/provinces
 * (holdings, only when asked), characters, cultures, religions and governments by entry.
 * A lighter reading than the map's (map/titles.ts): the last `holder` / `liege` / `government` at or before the date;
 * a county's capital barony is held with the county when its own history names no holder (the game keeps them together).
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import { parse, type PNode } from '../indexer/parser.ts';
import { T_CHARACTER, T_FAITH, T_TITLE } from '../indexer/schema.ts';
import { bodyOf as layoutBody, faithField, riteHistory } from '../indexer/layouts.ts';
import { faithAt } from '../map/history-characters.ts';
import { DATE_KEY, dateNum, HISTORY_DATE, lastAt, lastIndexAt, scalarOf, type Dated } from '../map/history.ts';

/** title tiers by key prefix (tier_barony = 1 … tier_hegemony = 6) */
const TIER: Record<string, number> = { b: 1, c: 2, d: 3, k: 4, e: 5, h: 6 };
export const tierOf = (title: string): number => TIER[title[0]] ?? 0;
/** dates kept with their holders */
const KEEP = 8;

const kids = (n: PNode | undefined): PNode[] => (n && Array.isArray(n.v) ? n.v : []);
const field = (list: PNode[], key: string): string | undefined => scalarOf(list.find((c) => c.k === key));
const bare = (n: PNode | undefined): string[] => kids(n).flatMap((c) => (c.k === null && typeof c.v === 'string' ? [c.v] : []));

interface TitleNode
{
    /** de jure liege (landed_titles nesting) */
    parent?: string;
    kids: string[];
    /** the definition's file and text: from its key to its first nested title (its own fields), or its end */
    file: number;
    s: number;
    head: number;
    e: number;
}

interface Timeline
{
    /** '' from `holder = 0` / `liege = 0` on */
    holder: Dated<string>[];
    liege: Dated<string>[];
    government: Dated<string>[];
}

interface Person
{
    id: string;
    name: string;
    birth?: number;
    death?: number;
    culture: Dated<string>[];
    faith: Dated<string>[];
    /** 1.20: `rite = x` (its faith depends on the date) */
    rite: Dated<string>[];
    dynasty: Dated<string>[];
    house: Dated<string>[];
    /** trait changes in order: gained (true) or lost */
    traits: Dated<[string, boolean]>[];
}

/** A character at a date. */
export interface PersonAt
{
    id: string;
    name: string;
    culture?: string;
    faith?: string;
    dynasty?: string;
    house?: string;
    traits: Set<string>;
    age?: number;
    alive: boolean;
}

export interface CultureInfo
{
    /** coa_gfx, building_gfx, clothing_gfx, unit_gfx */
    gfx: Set<string>;
    pillars: Set<string>;
    traditions: Set<string>;
    heritage?: string;
}

export interface FaithInfo
{
    religion: string;
    doctrines: Set<string>;
    icon?: string;
}

export interface GovernmentInfo
{
    flags: Set<string>;
    /** government_rules that are `yes` */
    rules: Set<string>;
    holding?: string;
    heritages: Set<string>;
    religions: Set<string>;
    fallback: number;
    conditional: boolean;
    maskOffset?: [number, number];
    maskScale?: [number, number];
}

/** Who holds what at one date. */
interface AtDate
{
    when: number;
    holder: Map<string, string>;
    /** per title: since when its holder holds it */
    since: Map<string, number>;
    /** per character: their titles, highest tier first (noble families last), then held longest */
    held: Map<string, string[]>;
    people: Map<string, PersonAt | null>;
    liege: Map<string, string | undefined>;
    government: Map<string, string | undefined>;
}

export class CoaFacts
{
    private idx: GameIndex;
    private treeMap: Map<string, TitleNode> | undefined;
    private lines: Map<string, Timeline> | undefined;
    private holdings: Map<number, Dated<string>[]> | undefined;
    private persons = new Map<string, Person | null>();
    private dates = new Map<number, AtDate>();
    private cultures = new Map<string, CultureInfo | null>();
    private faiths: Map<string, FaithInfo> | undefined;
    private families = new Map<string, string | undefined>();
    private heads = new Set<string>();
    private governments: Map<string, GovernmentInfo> | undefined;
    private rules: Set<string> | undefined;
    private levels: { thresholds: number[]; step: number; } | undefined;
    private titleFields = new Map<string, Map<string, string>>();

    constructor(idx: GameIndex)
    {
        this.idx = idx;
    }

    /** The first bookmark's start date (dateNum), the date arms are shown at when none is given. */
    firstBookmark(): number | undefined
    {
        let first: number | undefined;

        for (const key of this.idx.names('bookmarks/bookmarks'))
        {
            const e = this.idx.get('bookmarks/bookmarks', key);
            const d = e && this.idx.winningDef(e) ? field(kids(this.idx.defNode(e)?.node), 'start_date') : undefined;

            if (d && DATE_KEY.test(d) && (first === undefined || dateNum(d) < first))
                first = dateNum(d);
        }

        return first;
    }

    /** The de jure tree from the index's landed_titles definitions (nested ones lie inside their liege's). */
    private tree(): Map<string, TitleNode>
    {
        if (this.treeMap)
            return this.treeMap;

        const byFile = new Map<number, { key: string; s: number; e: number; }[]>();

        for (const key of this.idx.names(T_TITLE))
        {
            const e = this.idx.get(T_TITLE, key);
            const d = e && this.idx.winningDef(e);

            if (!d)
                continue;

            const list = byFile.get(d.file);

            if (list)
                list.push({ key, s: d.start, e: d.end });
            else
                byFile.set(d.file, [{ key, s: d.start, e: d.end }]);
        }

        const tree = new Map<string, TitleNode>();

        for (const [file, list] of byFile)
        {
            list.sort((a, b) => a.s - b.s || b.e - a.e);
            const open: { key: string; e: number; }[] = [];

            for (const t of list)
            {
                while (open.length && open[open.length - 1].e <= t.s)
                    open.pop();

                const parent = open[open.length - 1]?.key;
                const p = parent ? tree.get(parent) : undefined;

                if (p && p.head === p.e)
                    p.head = t.s;

                tree.set(t.key, { parent, kids: [], file, s: t.s, head: t.e, e: t.e });
                open.push(t);
            }
        }

        for (const [key, n] of tree)
            if (n.parent)
                tree.get(n.parent)?.kids.push(key);

        return (this.treeMap = tree);
    }

    isTitle(key: string): boolean
    {
        return this.tree().has(key);
    }

    /** The title and its de jure lieges, up to the top. */
    dejureUp(title: string): string[]
    {
        const tree = this.tree();
        const out: string[] = [];

        for (let t: string | undefined = title; t && out.length < 8; t = tree.get(t)?.parent)
            out.push(t);

        return out;
    }

    /** A county's capital: its first barony. */
    private capitalBarony(county: string): string | undefined
    {
        return this.tree()
            .get(county)
            ?.kids
            .find((k) => tierOf(k) === 1);
    }

    /** A scalar of a title's definition (`capital`, `province`, `noble_family`, `landless` …), read up to its first nested title. */
    titleField(title: string, key: string): string | undefined
    {
        let m = this.titleFields.get(title);

        if (!m)
        {
            const n = this.tree().get(title);
            const head = n ? parse(this.idx.readFile(n.file).slice(n.s, n.head) + (n.head < n.e ? '}' : ''))[0] : undefined;
            m = new Map(kids(head).flatMap((c) => (c.k && typeof c.v === 'string' ? [[c.k, scalarOf(c)!] as [string, string]] : [])));
            this.titleFields.set(title, m);
        }

        return m.get(key);
    }

    /** The province a title stands for (`title_province`): a barony's own, else its capital's (a county's first barony). */
    titleProvince(title: string): number | undefined
    {
        let t: string | undefined = title;

        for (let n = 0; t && n < 6 && tierOf(t) > 1; n++)
            t = tierOf(t) === 2 ? this.capitalBarony(t) : this.titleField(t, 'capital');

        const p = t ? Number(this.titleField(t, 'province')) : NaN;
        return Number.isFinite(p) ? p : undefined;
    }

    /** history/titles as timelines: holder, liege, government. */
    private timelines(): Map<string, Timeline>
    {
        if (this.lines)
            return this.lines;

        const lines = new Map<string, Timeline>();
        const vfs = this.idx.vfs;

        for (const f of vfs.list('history/titles', { ext: /\.txt$/i }))
        {
            for (const top of parse(vfs.readText(f) ?? ''))
            {
                if (!top.k || !Array.isArray(top.v))
                    continue;

                let tl = lines.get(top.k);

                if (!tl)
                    lines.set(top.k, tl = { holder: [], liege: [], government: [] });

                const take = (c: PNode, date: number): void =>
                {
                    const v = scalarOf(c);

                    if (v === undefined)
                        return;

                    if (c.k === 'holder' || c.k === 'liege')
                        tl![c.k].push({ date, v: v === '0' ? '' : v });
                    else if (c.k === 'government')
                        tl!.government.push({ date, v });
                };

                for (const c of top.v)
                {
                    if (c.k && HISTORY_DATE.test(c.k) && Array.isArray(c.v))
                    {
                        for (const x of c.v)
                            take(x, dateNum(c.k));
                    }
                    else
                        take(c, 0);
                }
            }
        }

        // (stable: a later statement of one date stays later)
        for (const tl of lines.values())
            for (const l of [tl.holder, tl.liege, tl.government])
                l.sort((a, b) => a.date - b.date);

        return (this.lines = lines);
    }

    /** Who holds what at a date (the last dates are kept). */
    private at(when: number): AtDate
    {
        let s = this.dates.get(when);

        if (s)
            return s;

        s = { when, holder: new Map(), since: new Map(), held: new Map(), people: new Map(), liege: new Map(), government: new Map() };
        const lines = this.timelines();

        for (const [title, tl] of lines)
        {
            let k = lastIndexAt(tl.holder, when);

            if (k < 0 || !tl.holder[k].v)
                continue;

            const who = tl.holder[k].v;

            while (k > 0 && tl.holder[k - 1].v === who)
                k--;

            s.holder.set(title, who);
            s.since.set(title, tl.holder[k].date);
        }

        // a county's capital barony goes with the county unless its own history says otherwise
        for (const [title, who] of [...s.holder])
        {
            const b = tierOf(title) === 2 ? this.capitalBarony(title) : undefined;

            if (b && !s.holder.has(b) && lastIndexAt(lines.get(b)?.holder ?? [], when) < 0)
            {
                s.holder.set(b, who);
                s.since.set(b, s.since.get(title)!);
            }
        }

        for (const [title, who] of s.holder)
        {
            const list = s.held.get(who);

            if (list)
                list.push(title);
            else
                s.held.set(who, [title]);
        }

        const rank = (t: string): number => tierOf(t) - (this.titleField(t, 'noble_family') === 'yes' ? 10 : 0);

        for (const list of s.held.values())
            list.sort((a, b) => rank(b) - rank(a) || s!.since.get(a)! - s!.since.get(b)!);

        this.dates.set(when, s);

        if (this.dates.size > KEEP)
            this.dates.delete(this.dates.keys().next().value!);

        return s;
    }

    holder(title: string, when: number): string | undefined
    {
        return this.at(when).holder.get(title);
    }

    /** Whether history ever gives the title a holder (a capital barony: its county's). */
    everHeld(title: string): boolean
    {
        const lines = this.timelines();

        if (lines.get(title)?.holder.some((h) => h.v))
            return true;

        const county = tierOf(title) === 1 ? this.tree().get(title)?.parent : undefined;
        return !!county && this.capitalBarony(county) === title && !!lines.get(county)?.holder.some((h) => h.v);
    }

    /** A character's titles at a date, the primary one first. */
    held(who: string, when: number): string[]
    {
        return this.at(when).held.get(who) ?? [];
    }

    primaryTitle(who: string, when: number): string | undefined
    {
        return this.held(who, when)[0];
    }

    /** The holder of the `liege` of their primary title. */
    liege(who: string, when: number): string | undefined
    {
        const s = this.at(when);

        if (s.liege.has(who))
            return s.liege.get(who);

        const p = this.primaryTitle(who, when);
        const lt = p ? lastAt(this.timelines().get(p)?.liege, when) : undefined;
        const l = lt ? s.holder.get(lt) : undefined;
        s.liege.set(who, l && l !== who ? l : undefined);
        return s.liege.get(who);
    }

    /** The liege's liege … up to the top (the character when independent). */
    topLiege(who: string, when: number): string
    {
        const seen = new Set([who]);

        for (let l = this.liege(who, when); l && !seen.has(l); l = this.liege(l, when))
        {
            seen.add(l);
            who = l;
        }

        return who;
    }

    /**
     * A character's government, as the map's government layer reads it (map/layers/rulers.ts): the latest `government`
     * of title history on a title they hold (it sets the then holder's, later holders keep it; the higher title on the
     * same date), else the game's default for their capital's holding: of the governments with that `primary_holding`,
     * one preferring their heritage or religion, without `can_get_government`, then the lowest `fallback`.
     */
    government(who: string, when: number): string | undefined
    {
        const s = this.at(when);

        if (s.government.has(who))
            return s.government.get(who);

        const titles = this.held(who, when);
        let g: { date: number; tier: number; v: string; } | undefined;

        for (const t of titles)
        {
            const list = this.timelines().get(t)?.government ?? [];
            const k = lastIndexAt(list, when);

            if (k >= 0 && (!g || list[k].date > g.date || (list[k].date === g.date && tierOf(t) > g.tier)))
                g = { date: list[k].date, tier: tierOf(t), v: list[k].v };
        }

        let v = g?.v;

        if (!v && titles.length)
        {
            const cap = this.titleField(titles[0], 'capital');
            const county = cap && s.holder.get(cap) === who ? cap : titles.find((t) => tierOf(t) === 2);
            const p = county ? this.titleProvince(county) : undefined;
            const holding = p === undefined ? undefined : this.holding(p, when);
            v = this.defaultGovernment(holding && holding !== 'none' && holding !== 'auto' ? holding : 'castle_holding', this.person(who, when));
        }

        s.government.set(who, v);
        return v;
    }

    private defaultGovernment(holding: string | undefined, p: PersonAt | null): string | undefined
    {
        const heritage = p?.culture ? this.culture(p.culture)?.heritage : undefined;
        const religion = p?.faith ? this.faith(p.faith)?.religion : undefined;
        const score = (g: GovernmentInfo): number => (g.holding === holding ? 4 : 0) + ((heritage && g.heritages.has(heritage)) || (religion && g.religions.has(religion)) ? 2 : 0) - (g.conditional ? 1 : 0);
        let best: [string, GovernmentInfo] | undefined;

        for (const e of this.governmentInfos())
            if (!best || score(e[1]) > score(best[1]) || (score(e[1]) === score(best[1]) && e[1].fallback < best[1].fallback))
                best = e;

        return best?.[0];
    }

    /** A barony's holding at a date (history/provinces `holding`). */
    holding(province: number, when: number): string | undefined
    {
        if (!this.holdings)
        {
            this.holdings = new Map();
            const vfs = this.idx.vfs;

            for (const f of vfs.list('history/provinces', { ext: /\.txt$/i }))
            {
                for (const top of parse(vfs.readText(f) ?? ''))
                {
                    const id = Number(top.k);

                    if (!Number.isInteger(id) || !Array.isArray(top.v))
                        continue;

                    const list = this.holdings.get(id) ?? [];

                    for (const c of top.v)
                    {
                        if (c.k === 'holding' && typeof c.v === 'string')
                            list.push({ date: 0, v: c.v });
                        else if (c.k && HISTORY_DATE.test(c.k) && Array.isArray(c.v))
                        {
                            const h = field(c.v, 'holding');

                            if (h)
                                list.push({ date: dateNum(c.k), v: h });
                        }
                    }

                    list.sort((a, b) => a.date - b.date);
                    this.holdings.set(id, list);
                }
            }
        }

        return lastAt(this.holdings.get(province), when);
    }

    /** A character's history (history/characters, through the index's entry). */
    private read(id: string): Person | null
    {
        let p = this.persons.get(id);

        if (p !== undefined)
            return p;

        const e = this.idx.get(T_CHARACTER, id);
        const node = e && this.idx.winningDef(e) ? this.idx.defNode(e)?.node : undefined;
        p = null;

        if (node && Array.isArray(node.v))
        {
            const q: Person = { id, name: (e && this.idx.displayName(e)) ?? id, culture: [], faith: [], rite: [], dynasty: [], house: [], traits: [] };
            const take = (c: PNode, date: number): void =>
            {
                const v = scalarOf(c);

                if (c.k === 'culture' && v)
                    q.culture.push({ date, v });
                else if ((c.k === 'religion' || c.k === 'faith') && v)
                    q.faith.push({ date, v });
                else if (c.k === 'rite' && v)
                    q.rite.push({ date, v });
                else if (c.k === 'dynasty' && v)
                    q.dynasty.push({ date, v });
                else if (c.k === 'dynasty_house' && v)
                    q.house.push({ date, v });
                else if ((c.k === 'trait' || c.k === 'add_trait') && v)
                    q.traits.push({ date, v: [v, true] });
                else if (c.k === 'remove_trait' && v)
                    q.traits.push({ date, v: [v, false] });
                else if (c.k === 'birth' && date)
                    q.birth ??= date;
                else if (c.k === 'death' && date)
                    q.death ??= date;
            };

            for (const c of node.v)
            {
                if (c.k && HISTORY_DATE.test(c.k) && Array.isArray(c.v))
                {
                    for (const x of c.v)
                        take(x, dateNum(c.k));
                }
                else
                    take(c, 0);
            }

            for (const l of [q.culture, q.faith, q.rite, q.dynasty, q.house, q.traits] as Dated<unknown>[][])
                l.sort((a, b) => a.date - b.date);

            p = q;
        }

        this.persons.set(id, p);
        return p;
    }

    /** A character at a date: culture, faith, dynasty, house (else none: their dynasty's own), traits, age. */
    person(id: string, when: number): PersonAt | null
    {
        const s = this.at(when);
        let out = s.people.get(id);

        if (out !== undefined)
            return out;

        const p = this.read(id);
        out = null;

        if (p)
        {
            const traits = new Set<string>();

            for (const t of p.traits)
            {
                if (t.date > when)
                    break;

                if (t.v[1])
                    traits.add(t.v[0]);
                else
                    traits.delete(t.v[0]);
            }

            const dead = p.death !== undefined && p.death <= when;
            out = { id, name: p.name, culture: lastAt(p.culture, when), faith: faithAt(p.faith, p.rite, when, (r, w) => riteHistory(this.idx).faithOf(r, w)), dynasty: lastAt(p.dynasty, when), house: lastAt(p.house, when), traits, alive: !dead };

            if (p.birth !== undefined && p.birth <= when)
                out.age = Math.floor((Math.min(when, p.death ?? when) - p.birth) / 10000);

            // a house names its dynasty (common/dynasty_houses `dynasty`)
            if (out.house && !out.dynasty)
                out.dynasty = this.houseDynasty(out.house);
        }

        s.people.set(id, out);
        return out;
    }

    houseDynasty(house: string): string | undefined
    {
        const e = this.idx.get('dynasty_houses', house);
        return e && this.idx.winningDef(e) ? field(kids(this.idx.defNode(e)?.node), 'dynasty') : undefined;
    }

    dynastyCulture(dynasty: string): string | undefined
    {
        const e = this.idx.get('dynasties', dynasty);
        return e && this.idx.winningDef(e) ? field(kids(this.idx.defNode(e)?.node), 'culture') : undefined;
    }

    culture(key: string): CultureInfo | undefined
    {
        let c = this.cultures.get(key);

        if (c === undefined)
        {
            const e = this.idx.get('culture/cultures', key);
            const body = kids(e && this.idx.winningDef(e) ? this.idx.defNode(e)?.node : undefined);
            const list = (k: string): string[] => bare(body.find((x) => x.k === k));
            c = body.length
                ? {
                    gfx: new Set(['coa_gfx', 'building_gfx', 'clothing_gfx', 'unit_gfx'].flatMap(list)),
                    pillars: new Set(['heritage', 'language', 'ethos', 'martial_custom'].map((k) => field(body, k)).filter((x): x is string => !!x)),
                    traditions: new Set(list('traditions')),
                    heritage: field(body, 'heritage')
                }
                : null;
            this.cultures.set(key, c);
        }

        return c ?? undefined;
    }

    /**
     * Faiths: their religion, doctrines (the religion's too, 1.20 the main rite's), icon — nested in their religion, or
     * (1.20) in religion/faith_types (docs/game-structure.md, "Layouts that changed").
     */
    faith(key: string): FaithInfo | undefined
    {
        if (!this.faiths)
        {
            this.faiths = new Map();
            const religionDoctrines = new Map<string, string[]>();
            const doctrinesOf = (body: PNode[]): string[] => body.flatMap((c) => (c.k === 'doctrine' && typeof c.v === 'string' ? [c.v] : c.k === 'doctrines' ? kids(c).filter((x) => x.k === null && typeof x.v === 'string').map((x) => x.v as string) : []));

            for (const religion of this.idx.names('religion/religion_types'))
            {
                const e = this.idx.get('religion/religion_types', religion);
                const body = kids(e && this.idx.winningDef(e) ? this.idx.defNode(e)?.node : undefined);

                if (!body.length)
                    continue;

                this.families.set(religion, field(body, 'family'));
                const doctrines = doctrinesOf(body);
                religionDoctrines.set(religion, doctrines);

                for (const f of kids(body.find((c) => c.k === 'faiths')))
                {
                    if (!f.k || !Array.isArray(f.v))
                        continue;

                    const own = f.v.filter((c) => c.k === 'doctrine' && typeof c.v === 'string').map((c) => c.v as string);
                    this.faiths.set(f.k, { religion, doctrines: new Set([...doctrines, ...own]), icon: field(f.v, 'icon') });
                    const head = field(f.v, 'religious_head');

                    if (head)
                        this.heads.add(head.replace(/^title:/, ''));
                }
            }

            for (const name of this.idx.names(T_FAITH))
            {
                const body = layoutBody(this.idx, this.idx.get(T_FAITH, name));
                const religion = faithField(body, 'religion');

                if (this.faiths.has(name) || typeof religion?.v !== 'string')
                    continue;

                const rite = field(body, 'main_rite');
                const riteDoctrines = rite ? doctrinesOf(layoutBody(this.idx, this.idx.get('religion/rite_types', rite))) : [];
                const icon = faithField(body, 'icon');
                this.faiths.set(name, { religion: religion.v, doctrines: new Set([...(religionDoctrines.get(religion.v) ?? []), ...riteDoctrines, ...doctrinesOf(body)]), icon: typeof icon?.v === 'string' ? icon.v : undefined });
                const head = faithField(body, 'religious_head');

                if (typeof head?.v === 'string')
                    this.heads.add(head.v.replace(/^title:/, ''));
            }
        }

        return this.faiths.get(key);
    }

    /** A religion's `family` (rf_abrahamic …). */
    religionFamily(religion: string): string | undefined
    {
        this.faith('');
        return this.families.get(religion);
    }

    /** The titles faiths name as their `religious_head`. */
    isHeadOfFaith(title: string): boolean
    {
        this.faith('');
        return this.heads.has(title);
    }

    private governmentInfos(): Map<string, GovernmentInfo>
    {
        if (this.governments)
            return this.governments;

        this.governments = new Map();

        for (const key of this.idx.names('governments'))
        {
            const e = this.idx.get('governments', key);
            const body = kids(e && this.idx.winningDef(e) ? this.idx.defNode(e)?.node : undefined);

            if (!body.length)
                continue;

            const pair = (k: string): [number, number] | undefined =>
            {
                const v = bare(body.find((c) => c.k === k)).map(Number);
                return v.length === 2 && v.every(Number.isFinite) ? [v[0], v[1]] : undefined;
            };
            this.governments.set(key, {
                flags: new Set(bare(body.find((c) => c.k === 'flags'))),
                rules: new Set(kids(body.find((c) => c.k === 'government_rules')).flatMap((c) => (c.k && c.v === 'yes' ? [c.k] : []))),
                holding: field(body, 'primary_holding'),
                heritages: new Set(bare(body.find((c) => c.k === 'primary_heritages'))),
                religions: new Set(bare(body.find((c) => c.k === 'preferred_religions'))),
                fallback: Number(field(body, 'fallback')) || 99,
                conditional: body.some((c) => c.k === 'can_get_government'),
                maskOffset: pair('realm_mask_offset'),
                maskScale: pair('realm_mask_scale')
            });
        }

        return this.governments;
    }

    governmentInfo(key: string | undefined): GovernmentInfo | undefined
    {
        return key ? this.governmentInfos().get(key) : undefined;
    }

    /** common/defines `NDynasty`: the renown levels' thresholds (LEVELS_PRESTIGE) and the levels a frame cell spans (LEVELS_PRESTIGE_GRAPHICAL_STEP). */
    renownLevels(): { thresholds: number[]; step: number; }
    {
        if (!this.levels)
        {
            this.levels = { thresholds: [], step: 1 };

            for (const f of this.idx.vfs.list('common/defines', { ext: /\.txt$/i, shallow: true }))
            {
                for (const top of parse(this.idx.vfs.readText(f) ?? ''))
                {
                    if (top.k !== 'NDynasty')
                        continue;

                    const t = bare(kids(top).find((c) => c.k === 'LEVELS_PRESTIGE')).map(Number);

                    if (t.length && t.every(Number.isFinite))
                        this.levels.thresholds = t;

                    const step = Number(field(kids(top), 'LEVELS_PRESTIGE_GRAPHICAL_STEP'));

                    if (step > 0)
                        this.levels.step = step;
                }
            }
        }

        return this.levels;
    }

    /** The game rules' default settings (common/game_rules `default = …`): what `has_game_rule` finds in a new game. */
    gameRuleDefault(setting: string): boolean
    {
        if (!this.rules)
        {
            this.rules = new Set();

            for (const key of this.idx.names('game_rules'))
            {
                const e = this.idx.get('game_rules', key);
                const d = e && this.idx.winningDef(e) ? field(kids(this.idx.defNode(e)?.node), 'default') : undefined;

                if (d)
                    this.rules.add(d);
            }
        }

        return this.rules.has(setting);
    }

    displayName(type: string, key: string): string
    {
        const e = this.idx.get(type, key);
        return (e && this.idx.displayName(e)) ?? key;
    }
}
