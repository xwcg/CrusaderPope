/**
 * The map's titles (docs/map.md, "History and realms"): the de jure tree of common/landed_titles, and at a history
 * date the holders, lieges, primary titles, realms, de jure lieges, names and colours (history/titles as timelines:
 * titles-history.ts; holders: history-characters.ts; names: titles-names.ts; primary titles: titles-priority.ts).
 */
import { parse, type PNode } from '../indexer/parser.ts';
import { colorOf } from './color.ts';
import { lastAt, lastIndexAt, scalarOf } from './history.ts';
import { holderAt, type HolderBook } from './history-characters.ts';
import type { TitleTimelines } from './titles-history.ts';
import type { NameCtx, TitleNamer } from './titles-names.ts';
import { priorityFor, readPriority, type Priority, type PriorityFacts } from './titles-priority.ts';

const TITLE_KEY = /^[hekdcb]_/;
/** tiers from low to high */
export const TIER_RANK = 'bcdkeh';
/** landed_titles `@never_primary_score` */
const NEVER_PRIMARY = -1000;
/** CK3's age of adulthood (a culture's head is an adult) */
const ADULT = 16;

export interface TitleNode
{
    key: string;
    tier: string;
    color?: string;
    /** de jure liege (index), −1 at the top */
    parent: number;
    kids: number[];
    /** baronies: their province id */
    province?: number;
    /** `ai_primary_priority` (titles-priority.ts: −1000 for noble family titles, `landless = yes`) */
    priority: Priority;
    /** the definition (cultural names, capital …) */
    node: PNode;
}

export interface TitleTree
{
    titles: TitleNode[];
    byKey: Map<string, number>;
    /** per province id: its barony, −1 */
    baronyOf: number[];
}

/** The de jure tree: every file in load order; a title written again moves to its latest place. */
export function readTitleTree(texts: string[], count: number): TitleTree
{
    const titles: TitleNode[] = [];
    const byKey = new Map<string, number>();
    // the files' constants (`@never_primary_score = -1000`)
    let consts = new Map<string, number>();
    const num = (v: string | undefined): number => (v === undefined ? 0 : (consts.get(v) ?? Number(v)) || 0);
    const walk = (list: PNode[], parent: number): void =>
    {
        for (const n of list)
        {
            if (!n.k || !TITLE_KEY.test(n.k) || !Array.isArray(n.v))
                continue;

            let i = byKey.get(n.k);
            const priority = readPriority(n.v.find((c) => c.k === 'ai_primary_priority'), num);

            if (i === undefined)
            {
                i = titles.length;
                byKey.set(n.k, i);
                titles.push({ key: n.k, tier: n.k[0], parent, kids: [], priority, node: n });
            }
            else
            {
                const old = titles[i].parent;

                if (old >= 0)
                    titles[old].kids = titles[old].kids.filter((k) => k !== i);

                titles[i].parent = parent;
                titles[i].node = n;
                titles[i].priority = priority;
            }

            if (parent >= 0)
                titles[parent].kids.push(i);

            const t = titles[i];
            t.color = colorOf(n.v.find((c) => c.k === 'color')) ?? t.color;
            const prov = n.v.find((c) => c.k === 'province' && typeof c.v === 'string');

            if (prov)
                t.province = parseInt(prov.v as string, 10);

            walk(n.v, i);
        }
    };

    for (const text of texts)
    {
        const top = parse(text);
        consts = new Map(top.filter((n) => n.k?.startsWith('@') && typeof n.v === 'string').map((n) => [n.k!, Number(n.v)]));
        walk(top, -1);
    }

    const baronyOf = new Array<number>(count).fill(-1);
    titles.forEach((t, i) =>
    {
        if (t.province !== undefined && t.province < count)
            baronyOf[t.province] = i;
    });
    return { titles, byKey, baronyOf };
}

/** What the state at a date is read from (built once per index). */
export interface TitleEnv
{
    timelines: TitleTimelines;
    holders: HolderBook;
    namer: TitleNamer;
    /** a county's capital barony's holding at the date, a barony's own (history/provinces) */
    holding(title: number, when: number): string | undefined;
    /** a county's culture at the date (history/provinces: its first province that has one) */
    culture(county: number, when: number): string | undefined;
}

/** The titles at a date. */
export interface TitleState
{
    /** per title: the holder's character id, '' */
    holderOf: string[];
    /** per title: its de facto liege title from history (`liege`), −1 */
    liegeOf: Int32Array;
    /** per title: the de jure liege at the date */
    parentOf: Int32Array;
    /** per county: the realm (the top liege's primary title), −1 */
    realmOf: Int32Array;
    /** per county: the top liege's direct vassal it is under (their primary title), else the realm */
    vassalOf: Int32Array;
    /** per title: its name at the date when it is not the loc name (history `name`, cultural names, realm names) */
    nameOf: (string | undefined)[];
    /** per title: its own name when nameOf is a realm name after the holder's house or culture */
    baseNameOf: (string | undefined)[];
    /** per title: its colour at the date when history changed it (`set_title_color`) */
    colorOf: (string | undefined)[];
    /** the holders' character ids (a holder's index is their place here) */
    holders: string[];
    /** per title: its holder (index into holders), −1 */
    holderIx: Int32Array;
    /** per holder: their primary title */
    primary: Int32Array;
    /** per holder: their liege (index into holders), −1 */
    liege: Int32Array;
}

/**
 * Holders and lieges at the date (the last `holder` / `liege` at or before it; `0` clears), and what follows from
 * them: a holder's primary title is their highest-tier title (titles `ai_primary_priority` never makes primary — noble
 * families — only when they hold nothing else) — among several, the one `set_primary_title_to` names (character
 * history), else the one of the highest `ai_primary_priority` for them (titles-priority.ts), else the one held longest
 * (the game keeps the first title of a tier: a later one of the same tier does not replace it); their liege is the
 * holder of their primary title's `liege` (a lower title's `liege` can name the holder's own vassal: the emperor's
 * c_adrianopolis → d_strymon); a county's realm is its top liege's primary title.
 */
export function titleState(tree: TitleTree, env: TitleEnv, when: number): TitleState
{
    const { titles, byKey } = tree;
    const tl = env.timelines;
    const n = titles.length;
    const holderOf = new Array<string>(n).fill('');
    const liegeOf = new Int32Array(n).fill(-1);
    const parentOf = new Int32Array(n);
    const since = new Float64Array(n);
    const colorOfT = new Array<string | undefined>(n);
    const holderIx = new Int32Array(n).fill(-1);
    const holders: string[] = [];
    const ixOf = new Map<string, number>();
    const heldBy: number[][] = [];

    for (let i = 0; i < n; i++)
    {
        const hl = tl.holder[i];
        let k = hl.length ? lastIndexAt(hl, when) : -1;

        if (k >= 0 && hl[k].v)
        {
            const who = hl[k].v;
            holderOf[i] = who;

            while (k > 0 && hl[k - 1].v === who)
                k--;

            since[i] = hl[k].date;
            let h = ixOf.get(who);

            if (h === undefined)
            {
                ixOf.set(who, h = holders.length);
                holders.push(who);
                heldBy.push([]);
            }

            holderIx[i] = h;
            heldBy[h].push(i);
        }

        const ll = tl.liege[i];
        liegeOf[i] = ll.length ? (lastAt(ll, when) ?? -1) : -1;
        // (a de jure liege of a lower tier is ignored: the tree stays a tree)
        const dl = tl.dejure[i];
        const dj = dl.length ? lastAt(dl, when) : undefined;
        parentOf[i] = dj !== undefined && (dj < 0 || TIER_RANK.indexOf(titles[dj].tier) > TIER_RANK.indexOf(titles[i].tier)) ? dj : titles[i].parent;
        const cl = tl.color[i];

        if (cl.length)
            colorOfT[i] = lastAt(cl, when);
    }

    env.holders.load(holders);
    const H = holders.length;
    const { namer } = env;

    // per holder: culture, faith … at the date
    const facts = holders.map((id) =>
    {
        const h = env.holders.get(id);
        const f = h ? holderAt(h, when) : {};
        const c = f.culture ? namer.culture(f.culture) : undefined;
        return { ...f, pillars: c?.pillars, religion: namer.religionOf(f.faith) } satisfies PriorityFacts;
    });

    // primary titles: the highest tier; set_primary_title_to, else the highest priority, else the one held longest
    const rank = (t: number): number => TIER_RANK.indexOf(titles[t].tier);
    const primary = new Int32Array(H);

    for (let h = 0; h < H; h++)
    {
        const all = heldBy[h];

        if (all.length === 1)
        {
            primary[h] = all[0];
            continue;
        }

        const score = all.map((t) => priorityFor(titles[t].priority, facts[h]));
        // (titles that are never primary — noble families — only when there is nothing else)
        const some = score.some((s) => s > NEVER_PRIMARY);
        let top = -1;

        for (let j = 0; j < all.length; j++)
            if ((!some || score[j] > NEVER_PRIMARY) && (top < 0 || rank(all[j]) > rank(all[top])))
                top = j;

        const r = rank(all[top]);
        const set = byKey.get(lastAt(env.holders.get(holders[h])?.primary, when) ?? '');
        let best = top;

        for (let j = 0; j < all.length; j++)
        {
            if (j === best || rank(all[j]) !== r || (some && score[j] <= NEVER_PRIMARY))
                continue;

            if (all[j] === set || (all[best] !== set && (score[j] > score[best] || (score[j] === score[best] && since[all[j]] < since[all[best]]))))
                best = j;
        }

        primary[h] = all[best];
    }

    // lieges: the holder of their primary title's `liege` (else of another title of that tier)
    const liege = new Int32Array(H).fill(-1);

    for (let h = 0; h < H; h++)
    {
        const p = primary[h];
        let l = liegeOf[p] >= 0 ? holderIx[liegeOf[p]] : -1;

        if (l < 0 || l === h)
        {
            l = -1;

            for (const t of heldBy[h])
            {
                if (t === p || titles[t].tier !== titles[p].tier || liegeOf[t] < 0)
                    continue;

                const x = holderIx[liegeOf[t]];

                if (x >= 0 && x !== h)
                {
                    l = x;
                    break;
                }
            }
        }

        liege[h] = l;
    }

    // the top liege, and the top liege's direct vassal each holder is under (themselves when they are one)
    const top = new Int32Array(H).fill(-1);
    const under = new Int32Array(H).fill(-1);
    const chain: number[] = [];

    for (let h0 = 0; h0 < H; h0++)
    {
        if (top[h0] >= 0)
            continue;

        chain.length = 0;
        let h = h0;

        while (h >= 0 && top[h] < 0 && !chain.includes(h))
        {
            chain.push(h);
            h = liege[h];
        }

        // (a chain that runs into one already known ends where it did; a loop ends at its last new member)
        let t: number;
        let u: number;

        if (h >= 0 && top[h] >= 0)
            [t, u] = [top[h], under[h] === h && h === top[h] ? -1 : under[h]];
        else
            [t, u] = [chain[chain.length - 1], -1];

        for (let j = chain.length - 1; j >= 0; j--)
        {
            const c = chain[j];
            top[c] = t;

            if (c === t)
                under[c] = c;
            else
            {
                if (u < 0)
                    u = c;

                under[c] = u;
            }
        }
    }

    const realmOf = new Int32Array(n).fill(-1);
    const vassalOf = new Int32Array(n).fill(-1);

    for (let ci = 0; ci < n; ci++)
    {
        const h = holderIx[ci];

        if (h < 0 || titles[ci].tier !== 'c')
            continue;

        realmOf[ci] = primary[top[h]];
        vassalOf[ci] = primary[under[h]];
    }

    // governments: the last `government` of their titles since they hold them (their primary title's first), else
    // the default for their capital's holding (their capital from history, else their primary title's, else their first county)
    const governments = new Array<string | undefined | null>(H).fill(null);
    const government = (h: number): string | undefined =>
    {
        const known = governments[h];

        if (known !== null)
            return known;

        const p = primary[h];
        // (a title's last `government` since they hold it)
        const stated = (i: number): { date: number; v: string; } | undefined =>
        {
            const list = tl.government[i];
            const k = list.length ? lastIndexAt(list, when) : -1;
            return k >= 0 && list[k].date >= since[i] ? list[k] : undefined;
        };
        let g = stated(p);

        if (!g)
        {
            for (const i of heldBy[h])
            {
                const x = stated(i);

                if (x && (!g || x.date > g.date))
                    g = x;
            }
        }

        let v = g?.v;

        if (!v)
        {
            const mine = (t: number | undefined): number | undefined => (t !== undefined && holderIx[t] === h ? t : undefined);
            const county = mine(byKey.get(lastAt(env.holders.get(holders[h])?.capital, when) ?? '')) ??
                mine(byKey.get(scalarOf(Array.isArray(titles[p].node.v) ? titles[p].node.v.find((c) => c.k === 'capital') : undefined) ?? '')) ??
                heldBy[h].find((i) => titles[i].tier === 'c');
            v = namer.defaultGovernment(county !== undefined ? env.holding(county, when) : undefined, facts[h].culture, facts[h].faith);
        }

        governments[h] = v;
        return v;
    };
    const ctxs = new Array<NameCtx & { house?: string; dynasty?: string; }>(H);
    const ctxOf = (h: number): NameCtx & { house?: string; dynasty?: string; } => (ctxs[h] ??= { ...facts[h], government: government(h) });

    // heads of cultures and houses, as far as nomad names need them (lazily)
    const counties = new Int32Array(H);

    for (let h = 0; h < H; h++)
        for (const t of heldBy[h])
            if (titles[t].tier === 'c')
                counties[h]++;

    const age = (h: number): number =>
    {
        const b = env.holders.get(holders[h])?.birth;
        return b === undefined ? 0 : when - b;
    };
    /** more powerful: the higher primary title, then more counties, then older */
    const stronger = (a: number, b: number): boolean => rank(primary[a]) !== rank(primary[b]) ? rank(primary[a]) > rank(primary[b]) : counties[a] !== counties[b] ? counties[a] > counties[b] : age(a) > age(b);
    const cultureHeads = new Map<string, number>();
    let countyCultures: (string | undefined)[] | undefined;
    const cultureHead = (culture: string): number =>
    {
        let head = cultureHeads.get(culture);

        if (head !== undefined)
            return head;

        head = -1;

        if (namer.culture(culture)?.head === 'herd')
        {
            // the highest title among the culture's rulers, then the most herd (not in history: their counties)
            for (let h = 0; h < H; h++)
                if (facts[h].culture === culture && (head < 0 || stronger(h, head)))
                    head = h;
        }
        else
        {
            // the adult who holds the most counties of the culture
            countyCultures ??= titles.map((t, ci) => (t.tier === 'c' && holderIx[ci] >= 0 ? env.culture(ci, when) : undefined));
            const mine = new Int32Array(H);
            countyCultures.forEach((c, ci) => c === culture && mine[holderIx[ci]]++);

            for (let h = 0; h < H; h++)
                if (mine[h] && age(h) >= ADULT * 10000 && (head < 0 || mine[h] > mine[head] || (mine[h] === mine[head] && stronger(h, head))))
                    head = h;
        }

        cultureHeads.set(culture, head);
        return head;
    };
    // (a house's head passes to the primary heir; at the start the most powerful member leads it)
    let houseHeads: Map<string, number> | undefined;
    const houseHead = (h: number): boolean =>
    {
        const houseKey = (x: number): string | undefined => (facts[x].house ? 'h:' + facts[x].house : facts[x].dynasty ? 'd:' + facts[x].dynasty : undefined);

        if (!houseHeads)
        {
            houseHeads = new Map();

            for (let x = 0; x < H; x++)
            {
                const k = houseKey(x);

                if (!k)
                    continue;

                const cur = houseHeads.get(k);

                if (cur === undefined || stronger(x, cur))
                    houseHeads.set(k, x);
            }
        }

        const k = houseKey(h);
        return !!k && houseHeads.get(k) === h;
    };

    // names: history's, else the cultural name for the holder's culture; a primary title may be named after the house
    // (or a nomad's culture)
    const nameOf = new Array<string | undefined>(n);
    const baseNameOf = new Array<string | undefined>(n);

    for (let i = 0; i < n; i++)
    {
        const nl = tl.name[i];
        const key = nl.length ? lastAt(nl, when) : undefined;
        const h = holderIx[i];

        if (key)
            nameOf[i] = namer.loc(key) ?? key;
        else if (h >= 0)
        {
            const cn = namer.culturalName(i, facts[h].culture);

            if (cn)
                nameOf[i] = namer.loc(cn) ?? cn;
        }

        if (h < 0 || primary[h] !== i)
            continue;

        const who = ctxOf(h);
        let realm: string | undefined;

        if (namer.nomadNamed(who.government))
        {
            const culture = who.culture;
            realm = namer.nomadRealmName(i, who, !!culture && cultureHead(culture) === h, houseHead(h));
        }
        else
        {
            const dejure: number[] = [];

            for (let p = parentOf[i]; p >= 0; p = parentOf[p])
                dejure.push(p);

            realm = namer.houseRealmName(i, dejure, who, ctxOf(top[h]), top[h] === h, titles[i].tier === 'b' ? env.holding(i, when) : undefined);
        }

        if (realm)
        {
            baseNameOf[i] = nameOf[i] ?? namer.loc(titles[i].key);
            nameOf[i] = realm;
        }
    }

    return { holderOf, liegeOf, parentOf, realmOf, vassalOf, nameOf, baseNameOf, colorOf: colorOfT, holders, holderIx, primary, liege };
}
