/** Map layers of the county holders at the date (docs/map.md): their dynasties, houses and governments. */
import type { PNode } from '../../indexer/parser.ts';
import { T_CHARACTER } from '../../indexer/schema.ts';
import { dateNum, scalarOf } from '../history.ts';
import { TIER_RANK } from '../titles.ts';
import { bodyOf, fieldOf, lastOf, once, perCounty, Things, type LayerCtx, type LayerDef } from '../layers.ts';
import { thingsOf } from './basic.ts';
import { pillars } from './culture.ts';
import { religions } from './faith.ts';

/** A value, or values from their dates on (0: undated) in date order. */
type Dated = string | [date: number, value: string][];

/** history/characters keys → what they are (`dynasty_house` a dynasty_houses key; the faith is `religion` or `faith`) */
const FACTS = { dynasty: 'dynasty', dynasty_house: 'house', culture: 'culture', religion: 'faith', faith: 'faith' } as const;
type Person = Partial<Record<(typeof FACTS)[keyof typeof FACTS], Dated>>;

const PERSON_KEYS = /^[ \t]*(dynasty|dynasty_house|culture|religion|faith)[ \t]*=[ \t]*"?([\w-]+)"?(?=[\s#}]|$)/gm;
const DATE_BLOCK = /(\d+\.\d+\.\d+)\s*=\s*\{/g;

/** The last value at or before the date. */
function valueAt(v: Dated | undefined, when: number): string | undefined
{
    if (typeof v !== 'object')
        return v;

    let out: string | undefined;

    for (const [d, x] of v)
    {
        if (d > when)
            break;

        out = x;
    }

    return out;
}

/**
 * Every character's dynasty, house, culture and faith (history/characters — one per line; mostly undated, some in a
 * date's block: Ecgberht founds house_british_isles_wessex on 839.1.1, converts change the faith), once per index:
 * the index's entries, file by file, their lines matched in one pass (vanilla ~250 ms for 71k characters; parsing
 * them would take ~360 ms more, reading only a date's holders ~70 ms per date).
 */
function people(ctx: LayerCtx): Map<string, Person>
{
    return once(ctx, 'people', () =>
    {
        const idx = ctx.idx;
        const byFile = new Map<number, { id: string; start: number; end: number; }[]>();

        for (const id of idx.names(T_CHARACTER))
        {
            const d = idx.winningDef(idx.get(T_CHARACTER, id)!);

            if (d)
                (byFile.get(d.file) ?? byFile.set(d.file, []).get(d.file)!).push({ id, start: d.start, end: d.end });
        }

        // (a substring of 13 or more characters keeps its whole file alive: those are copied, once per key)
        const keys = new Map<string, string>();
        const key = (s: string): string => (s.length < 13 ? s : (keys.get(s) ?? (keys.set(s, (' ' + s).slice(1)), keys.get(s)!)));
        const out = new Map<string, Person>();

        for (const [file, list] of byFile)
        {
            const text = idx.readFile(file);
            list.sort((a, b) => a.start - b.start);
            let ci = -1;

            for (const m of text.matchAll(PERSON_KEYS))
            {
                while (ci + 1 < list.length && list[ci + 1].start <= m.index)
                    ci++;

                const c = list[ci];

                if (!c || m.index >= c.end)
                    continue;

                // an indented line may be inside a block of the entry (braces counted from its start): the date's
                let date = 0;

                if (/^(\t\t|[ \t]{5})/.test(m[0]))
                {
                    let depth = 0;

                    for (let i = c.start; i < m.index; i++)
                        depth += text.charCodeAt(i) === 123 ? 1 : text.charCodeAt(i) === 125 ? -1 : 0;

                    const block = depth > 1 ? [...text.slice(c.start, m.index).matchAll(DATE_BLOCK)].pop() : undefined;

                    if (block)
                        date = dateNum(block[1]);
                }

                const p = out.get(c.id) ?? out.set(c.id, {}).get(c.id)!;
                const fact = FACTS[m[1] as keyof typeof FACTS];
                const old = p[fact];

                if (old === undefined && !date)
                    p[fact] = key(m[2]);
                else
                {
                    const list = typeof old === 'string' ? [[0, old] as [number, string]] : (old ?? []);
                    list.push([date, key(m[2])]);
                    p[fact] = list.sort((a, b) => a[0] - b[0]);
                }
            }
        }

        return out;
    });
}

/** A house's dynasty (common/dynasty_houses: `dynasty = <id>`). */
function houseDynasty(ctx: LayerCtx, house: string): string | undefined
{
    const m = once(ctx, 'houseDynasty', () => new Map<string, string | undefined>());

    if (!m.has(house))
        m.set(house, fieldOf(bodyOf(ctx, 'dynasty_houses', house), 'dynasty'));

    return m.get(house);
}

/** Lowborn holders (no dynasty) leave their counties without a group, as unheld ones: one group of them all spans the map. */
const dynasty: LayerDef = {
    id: 'dynasty',
    build: (ctx) =>
    {
        const who = people(ctx);
        const things = new Things();
        const values = perCounty(ctx, (ci) =>
        {
            const p = who.get(ctx.state.holderOf[ci]);
            const h = valueAt(p?.house, ctx.when);
            const d = valueAt(p?.dynasty, ctx.when) ?? (h ? houseDynasty(ctx, h) : undefined);
            return d ? things.of(d, () => ({ name: ctx.name('dynasties', d), type: ctx.idx.get('dynasties', d) ? 'dynasties' : undefined })) : -1;
        });
        return { id: 'dynasty', label: 'Dynasties', title: 'The dynasties of the county holders at the date', row: 'Dynasty', historical: true, things: things.list, values };
    }
};

/** A character with a `dynasty` and no `dynasty_house` belongs to the dynasty's own house (named like it). */
const house: LayerDef = {
    id: 'house',
    build: (ctx) =>
    {
        const who = people(ctx);
        const things = new Things();
        const values = perCounty(ctx, (ci) =>
        {
            const p = who.get(ctx.state.holderOf[ci]);
            const h = valueAt(p?.house, ctx.when);
            const d = valueAt(p?.dynasty, ctx.when);

            if (h)
                return things.of('h:' + h, () => ({ key: h, name: ctx.name('dynasty_houses', h), type: ctx.idx.get('dynasty_houses', h) ? 'dynasty_houses' : undefined }));

            return d ? things.of('d:' + d, () => ({ key: d, name: ctx.name('dynasties', d), type: ctx.idx.get('dynasties', d) ? 'dynasties' : undefined })) : -1;
        });
        return { id: 'house', label: 'Houses', title: 'The houses of the county holders at the date', row: 'House', historical: true, things: things.list, values };
    }
};

interface Government
{
    key: string;
    /** `primary_holding` */
    holding: string;
    /** `primary_heritages`, `preferred_religions` */
    heritages: string[];
    religions: string[];
    /** the order without preferences: `fallback` (1 first), without `can_get_government`, the mechanic's default */
    rank: number;
}

function governments(ctx: LayerCtx): Government[]
{
    return once(ctx, 'governments', () =>
        ctx.idx.names('governments').flatMap((key) =>
        {
            const body = bodyOf(ctx, 'governments', key);
            const holding = fieldOf(body, 'primary_holding');

            if (!holding)
                return [];

            const list = (k: string): string[] => body.filter((c) => c.k === k && Array.isArray(c.v)).flatMap((c) => (c.v as PNode[]).filter((x) => !x.k && typeof x.v === 'string').map((x) => x.v as string));
            const fallback = Number(fieldOf(body, 'fallback') ?? 0);
            const rank = (fallback > 0 ? fallback : 100) * 4 + (body.some((c) => c.k === 'can_get_government') ? 2 : 0) + (fieldOf(body, 'is_mechanic_type_default') === 'yes' ? 0 : 1);
            return [{ key, holding, heritages: list('primary_heritages'), religions: list('preferred_religions'), rank }];
        }));
}

/**
 * The government a holder gets when history names none (common/governments, _governments.info): one whose
 * `primary_holding` is their capital's holding — first one preferring them (`primary_heritages` has their culture's
 * heritage or `preferred_religions` their faith's religion: clan for arabic, iranian and turkic heritages and islam,
 * wanua for austronesian), then by `fallback` ("used when lacking other selection": feudal 1, clan 2), then one without
 * `can_get_government` (mostly DLC checks), then the mechanic's default.
 */
function fallbackGovernment(ctx: LayerCtx, holding: string, heritage: string | undefined, religion: string | undefined): string | undefined
{
    let best: Government | undefined;
    let bestScore = Infinity;

    for (const g of governments(ctx))
    {
        if (g.holding !== holding)
            continue;

        const score = g.rank + ((heritage && g.heritages.includes(heritage)) || (religion && g.religions.includes(religion)) ? 0 : 1000);

        if (score < bestScore)
            [best, bestScore] = [g, score];
    }

    return best?.key;
}

/**
 * The county holders' governments at the date: the latest `government = …` (history/titles — it sets the government
 * of the title's holder then, and later holders keep it) on a title the holder holds, the higher title on the same
 * date; else, as the game does, one for the holding of their capital (the capital county of their highest title, else
 * their first county; its first barony's `holding`), their culture and faith.
 */
const government: LayerDef = {
    id: 'government',
    build: (ctx) =>
    {
        const { list, at } = thingsOf(ctx, 'governments');
        const { titles } = ctx.tree;
        const held = new Map<string, number[]>();
        ctx.state.holderOf.forEach((who, t) => who && (held.get(who) ?? held.set(who, []).get(who)!).push(t));
        const who = people(ctx);
        const heritages = pillars(ctx, 'heritage');
        const faiths = religions(ctx);
        // per title: its `government` statements
        const stated = once(ctx, 'governmentStatements', () =>
        {
            const out = new Map<number, [date: number, key: string][]>();
            titles.forEach((t, i) =>
            {
                const list = (ctx.titleHistory.entries.get(t.key) ?? []).filter((s) => s.node.k === 'government' && scalarOf(s.node));

                if (list.length)
                    out.set(i, list.map((s) => [s.date, scalarOf(s.node)!]));
            });
            return out;
        });
        const of = new Map<string, number>();
        const govOf = (id: string): number =>
        {
            let g = of.get(id);

            if (g !== undefined)
                return g;

            const mine = held.get(id) ?? [];
            let best: { date: number; rank: number; key: string; } | undefined;
            let top = -1;

            for (const t of mine)
            {
                const rank = TIER_RANK.indexOf(titles[t].tier);

                if (top < 0 || rank > TIER_RANK.indexOf(titles[top].tier))
                    top = t;

                for (const [date, key] of stated.get(t) ?? [])
                {
                    if (date > ctx.when)
                        break;

                    if (!best || date > best.date || (date === best.date && rank >= best.rank))
                        best = { date, rank, key };
                }
            }

            let key = best?.key;

            if (!key)
            {
                const def = titles[top]?.node.v;
                const cap = ctx.tree.byKey.get(fieldOf(Array.isArray(def) ? def : [], 'capital') ?? '');
                const county = cap !== undefined && ctx.state.holderOf[cap] === id ? cap : titles[top]?.tier === 'c' ? top : mine.find((t) => titles[t].tier === 'c');
                const prov = county !== undefined ? ctx.countyProvinces(county)[0] : undefined;
                const holding = prov !== undefined ? scalarOf(lastOf(ctx.provinces, String(prov), ['holding'], ctx.when)?.node) : undefined;
                const p = who.get(id);
                const culture = heritages.ofCulture.get(valueAt(p?.culture, ctx.when) ?? '');
                const religion = faiths.religionOf.get(valueAt(p?.faith, ctx.when) ?? '');
                const [heritage, rel] = [culture !== undefined ? heritages.list[culture].key : undefined, religion !== undefined ? faiths.religions[religion].key : undefined];
                key = fallbackGovernment(ctx, holding && holding !== 'none' && holding !== 'auto' ? holding : 'castle_holding', heritage, rel) ?? fallbackGovernment(ctx, 'castle_holding', heritage, rel);
            }

            g = key ? (at.get(key) ?? -1) : -1;
            of.set(id, g);
            return g;
        };
        const values = perCounty(ctx, (ci) => (ctx.state.holderOf[ci] ? govOf(ctx.state.holderOf[ci]) : -1));
        return { id: 'government', label: 'Governments', title: 'The governments of the county holders at the date', row: 'Government', historical: true, things: list, values };
    }
};

export const RULER_LAYERS: LayerDef[] = [dynasty, house, government];
