/**
 * Examples of the game's text codes (docs/picker.md, "Text codes"): what `[ROOT.Char.GetTitledFirstName]` and the
 * like print, worked out for one historical character at the 1066 bookmark — William of Normandy (history id 140),
 * with his wife, parents, liege, faith, culture and duchy as the "others". The common character, title, faith and
 * culture functions are known; a faith's words come from its religion's `localization = { HighGodName = … }` block;
 * pairs like GetHerHis / GetWomanMan read "his / her". Anything else has no example.
 */
import type { PNode } from '../indexer/parser.ts';
import type { GameIndex } from '../indexer/gameIndex.ts';
import type { CharacterFacts, History } from '../portraits/modifiers.ts';

type V =
    | { t: 'char'; f: CharacterFacts; }
    | { t: 'title'; name: string; tier: number; }
    | { t: 'place'; county: string; }
    | { t: 'faith'; name: string; }
    | { t: 'culture'; name: string; }
    | { t: 'house'; key: string; }
    | { t: 'lang'; name: string; };

const SAMPLE = '140';
const TIER_WORD = ['', 'Barony', 'County', 'Duchy', 'Kingdom', 'Empire'];
const RANK: [string, string][] = [
    ['', ''],
    ['Baron', 'Baroness'],
    ['Count', 'Countess'],
    ['Duke', 'Duchess'],
    ['King', 'Queen'],
    ['Emperor', 'Empress']
];
/** the male half of a word pair (GetHerHis, GetWomanMan, GetDaughterSon …) */
const MALE = new Set(
    'He His Him Himself Man Men Son Sons Boy Boys Lord Lords King Kings Brother Brothers Husband Husbands Father Fathers Sir Master Gentleman Prince Princes Emperor Duke Count Baron Nephew Uncle Grandson Grandfather Groom Monk Monks Priest Lad Male Males Mister Patriarch Widower Bachelor Fiance Heir Hero Lordship'
        .split(
            ' '
        )
);

const kids = (n: PNode | undefined): PNode[] => (n && Array.isArray(n.v) ? n.v : []);
const possessive = (t: string): string => (/s$/.test(t) ? `${t}’` : `${t}’s`);

export class LocExamples
{
    private locBlocks = new Map<string, Map<string, string>>();
    private idx: GameIndex;
    private history: History;

    constructor(idx: GameIndex, history: History)
    {
        this.idx = idx;
        this.history = history;
    }

    /** Examples for the chains (after `ROOT.Char.`), where one can be worked out. */
    examples(chains: string[]): Record<string, string>
    {
        const out: Record<string, string> = {};
        const root = this.history.facts(SAMPLE);

        if (!root)
            return out;

        for (const c of chains)
        {
            try
            {
                const ex = this.chain(root, c);

                if (ex)
                    out[c] = ex;
            }
            catch
            {
                // (no example)
            }
        }

        return out;
    }

    /** The text icons' pictures (`@gold_icon!` → gfx/interface/icons/icon_gold.dds): gui texticon blocks. */
    iconImages(): Record<string, string>
    {
        const out: Record<string, string> = {};

        for (const gf of this.idx.vfs.list('gui', { engine: true, ext: /\.gui$/i }))
        {
            if (!/texticon/i.test(gf.rel))
                continue;

            const text = this.idx.vfs.readText(gf, { engine: true }) ?? '';

            for (const m of text.matchAll(/texticon\s*=\s*\{\s*icon\s*=\s*"?(\w+)"?[\s\S]*?texture\s*=\s*"([^"]+)"/g))
                out[m[1]] ??= m[2];
        }

        return out;
    }

    private chain(root: CharacterFacts, chain: string): string | undefined
    {
        const [body, fmt] = chain.split('|');
        const parts = body.split('.');
        let v: V = { t: 'char', f: root };

        for (let i = 0; i < parts.length; i++)
        {
            const r = this.step(v, parts[i]);

            if (r === undefined)
                return undefined;

            if (typeof r === 'string')
            {
                if (i < parts.length - 1)
                    return undefined;

                // (|U capitalizes, |l lowers the first letter — of each half of a pair)
                const each = (f: (s: string) => string): string =>
                    r.split(' / ')
                        .map(f)
                        .join(' / ');
                return fmt?.includes('U') ? each((s) => s.charAt(0).toUpperCase() + s.slice(1)) : fmt?.includes('l') ? each((s) => s.charAt(0).toLowerCase() + s.slice(1)) : r;
            }

            v = r;
        }

        // (a scope at the end: its name)
        const n = this.step(v, 'GetName');
        return typeof n === 'string' ? n : undefined;
    }

    private step(v: V, fn0: string): V | string | undefined
    {
        const fn = fn0.replace(/NoTooltip/g, '').replace(/Regnal$/, '');

        if (fn.endsWith('Possessive') && fn !== 'Possessive')
        {
            const base = this.step(v, fn.slice(0, -'Possessive'.length));
            return typeof base === 'string' ? possessive(base) : undefined;
        }

        switch (v.t)
        {
            case 'char':
                return this.charStep(v.f, fn);
            case 'title':
                return this.titleStep(v, fn);
            case 'place':
                if (fn === 'GetTitle' || fn === 'GetCounty')
                    return { t: 'title', name: v.county, tier: 2 };

                if (/^Get(Name|BaseName|BaseNameNoTier|NameNoTier)$/.test(fn))
                    return this.titleBase(v.county);

                return undefined;
            case 'faith':
                return this.faithStep(v.name, fn);
            case 'culture':
                return this.cultureStep(v.name, fn);
            case 'house':
                if (fn === 'GetName')
                    return this.houseName(v.key, true);

                if (fn === 'GetBaseName')
                    return this.houseName(v.key, false);

                return undefined;
            case 'lang':
                if (fn === 'GetName')
                    return this.idx.plainLoc(v.name) ?? this.label(v.name);

                return undefined;
        }
    }

    // -------------------------------------------------------------------------
    // characters
    // -------------------------------------------------------------------------

    private charStep(f: CharacterFacts, fn: string): V | string | undefined
    {
        const first = this.firstName(f);
        const top = f.titles[0];
        const rank = top ? RANK[top.tier]?.[f.female ? 1 : 0] : undefined;
        const titled = rank ? `${rank} ${first}` : first;

        switch (fn)
        {
            case 'GetFirstName':
            case 'GetName':
            case 'GetFirstNameNicknamed':
            case 'GetCouncilTitleFirstName':
                return first;
            case 'GetTitledFirstName':
            case 'GetShortUIName':
            case 'GetShortUINameNotMe':
            case 'GetUIName':
            case 'GetTitledHouseNameOrFirstName':
                return titled;
            case 'GetFullName':
                return `${first} ${f.dynasty ? this.houseName(f.dynasty, true) : ''}`.trim();
            case 'GetTitleAsName':
                return top && rank ? `${rank} of ${this.titleBase(top.name)}` : first;
            case 'GetTitleTierName':
                return rank;
            case 'GetDynastyName':
                return f.dynasty ? this.houseName(f.dynasty, false) : undefined;
            case 'GetAge':
                return String(f.age);
            case 'GetCouncilTitle':
                return f.female ? 'Chancellor' : 'Chancellor';
            case 'GetFaith':
                return f.faith ? { t: 'faith', name: f.faith } : undefined;
            case 'GetCulture':
                return f.culture ? { t: 'culture', name: f.culture } : undefined;
            case 'GetPrimaryTitle':
                return top ? { t: 'title', name: top.name, tier: top.tier } : undefined;
            case 'GetHouse':
            case 'GetDynasty':
                return f.dynasty ? { t: 'house', key: f.dynasty } : undefined;
            case 'GetFather':
            case 'GetMother':
            {
                const id = fn === 'GetFather' ? f.father : f.mother;
                const p = id ? this.history.facts(id, f.date) : null;
                return p ? { t: 'char', f: p } : undefined;
            }
            case 'GetPrimarySpouse':
            case 'GetSpouse':
            case 'GetBetrothed':
            {
                const s = f.spouses[0] ? this.history.facts(f.spouses[0], f.date) : null;
                return s ? { t: 'char', f: s } : undefined;
            }
            case 'GetLiege':
            case 'GetEmployer':
            case 'GetCourtOwner':
            {
                const l = this.history.liege(f);
                return l ? { t: 'char', f: l } : undefined;
            }
            case 'GetTopLiege':
                return { t: 'char', f: this.history.topLiege(f) };
            case 'GetCapitalLocation':
            case 'GetCurrentLocation':
            case 'GetLocation':
            {
                const county = f.titles.find((t) => t.tier === 2);
                return county ? { t: 'place', county: county.name } : undefined;
            }
        }

        // word pairs: GetHerHis → "his / her", GetWomanMan → "man / woman" (GetHerHisMy: "his / her")
        const words = /^Get((?:[A-Z][a-z]+){2,3})$/.exec(fn)?.[1].match(/[A-Z][a-z]+/g);

        if (words && MALE.has(words[1]))
            return [words[1], words[0], ...words.slice(2)].map((w) => w.toLowerCase()).join(' / ');

        return undefined;
    }

    private firstName(f: CharacterFacts): string
    {
        const e = this.idx.get('characters', f.id);
        const d = e && this.idx.defNode(e);
        const name = kids(d?.node).find((c) => c.k === 'name')?.v;
        const key = typeof name === 'string' ? name : f.id;
        return this.idx.plainLoc(key) ?? key;
    }

    // -------------------------------------------------------------------------
    // titles, faiths, cultures, houses
    // -------------------------------------------------------------------------

    private titleBase(name: string): string
    {
        const e = this.idx.get('landed_titles', name);
        return (e && this.idx.displayName(e)) ?? this.idx.plainLoc(name) ?? this.label(name.replace(/^[hbcdke]_/, ''));
    }

    private titleStep(v: { name: string; tier: number; }, fn: string): V | string | undefined
    {
        const base = this.titleBase(v.name);
        const tier = TIER_WORD[v.tier] ?? '';

        switch (fn)
        {
            case 'GetName':
                return tier ? `${tier} of ${base}` : base;
            case 'GetNameNoTier':
            case 'GetBaseName':
            case 'GetBaseNameNoTier':
                return base;
            case 'GetAdjective':
                return this.idx.plainLoc(`${v.name}_adj`) ?? base;
            case 'GetTierAsName':
                return tier;
            case 'GetDefinitiveName':
                return tier ? `the ${tier} of ${base}` : base;
            case 'GetHolder':
            {
                const id = this.history.holderAt(v.name, this.history.facts(SAMPLE)?.date ?? 10660915);
                const f = id ? this.history.facts(id) : null;
                return f ? { t: 'char', f } : undefined;
            }
            case 'GetDeJureLiege':
            {
                const l = this.history.liegeTitleAt(v.name, this.history.facts(SAMPLE)?.date ?? 10660915);
                return l ? { t: 'title', name: l, tier: 'bcdke'.indexOf(l.charAt(0)) + 1 } : undefined;
            }
        }

        return undefined;
    }

    /** A faith's (else its religion's) `localization = { Key = loc_key }` entries. */
    private locBlock(type: string, name: string): Map<string, string>
    {
        const k = type + ':' + name;
        let m = this.locBlocks.get(k);

        if (!m)
        {
            m = new Map();
            const e = this.idx.get(type, name);
            const d = e && this.idx.defNode(e);

            for (const c of kids(kids(d?.node).find((x) => x.k === 'localization')))
            {
                const val = typeof c.v === 'string' ? c.v : kids(c).find((x) => typeof x.v === 'string')?.v;

                if (c.k && typeof val === 'string')
                    m.set(c.k, val);
            }

            this.locBlocks.set(k, m);
        }

        return m;
    }

    private faithStep(name: string, fn: string): V | string | undefined
    {
        const e = this.idx.get('faith', name);
        const own = (e && this.idx.displayName(e)) ?? this.idx.plainLoc(name) ?? this.label(name);

        switch (fn)
        {
            case 'GetName':
                return own;
            case 'GetAdjective':
                return this.idx.plainLoc(`${name}_adj`) ?? own;
            case 'GetAdherentName':
                return this.idx.plainLoc(`${name}_adherent`) ?? own;
            case 'GetAdherentNamePlural':
                return this.idx.plainLoc(`${name}_adherent_plural`) ?? `${own}s`;
        }

        const religion = this.history.faith(name)?.religion;
        const key = this.locBlock('faith', name).get(fn) ?? (religion ? this.locBlock('religion/religion_types', religion).get(fn) : undefined);
        return key ? (this.idx.plainLoc(key) ?? undefined) : undefined;
    }

    private cultureStep(name: string, fn: string): V | string | undefined
    {
        const e = this.idx.get('culture/cultures', name);
        const own = (e && this.idx.displayName(e)) ?? this.idx.plainLoc(name) ?? this.label(name);

        switch (fn)
        {
            case 'GetName':
                return own;
            case 'GetCollectiveNoun':
                return this.idx.plainLoc(`${name}_collective_noun`) ?? `${own}s`;
            case 'GetLanguage':
            {
                const d = e && this.idx.defNode(e);
                const lang = kids(d?.node).find((c) => c.k === 'language')?.v;
                return typeof lang === 'string' ? { t: 'lang', name: lang } : undefined;
            }
        }

        return undefined;
    }

    /** A dynasty's / house's name, with its prefix ("de Normandie") or without ("Normandie"). */
    private houseName(key: string, prefix: boolean): string
    {
        const e = this.idx.get('dynasties', key) ?? this.idx.get('dynasty_houses', key);
        const d = e && this.idx.defNode(e);
        const body = kids(d?.node);
        const str = (k: string): string | undefined =>
        {
            const v = body.find((c) => c.k === k)?.v;
            return typeof v === 'string' ? v : undefined;
        };
        const nameKey = str('name');
        const name = nameKey ? (this.idx.plainLoc(nameKey) ?? nameKey.replace(/^dynn_/, '')) : (e && this.idx.displayName(e)) ?? key;
        const pre = prefix && str('prefix') ? this.idx.plainLoc(str('prefix')!) : undefined;
        return pre ? `${pre.trim()} ${name}` : name;
    }

    private label(key: string): string
    {
        const t = key.replace(/_/g, ' ');
        return t.charAt(0).toUpperCase() + t.slice(1);
    }
}
