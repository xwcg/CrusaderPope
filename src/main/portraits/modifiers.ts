/**
 * Portrait modifiers (gfx/portraits/portrait_modifiers) for historical characters — see docs/portraits.md.
 *
 * The game dresses characters through modifier groups: each group (applied by priority) picks one modifier by
 * weights computed from triggers (rank, culture, government, faith, …) and applies its DNA changes (accessory,
 * morph and colour genes). Here the character's facts come from history at a date (character history, title
 * history for titles and lieges), and a tolerant trigger evaluator follows scripted triggers with $PARAM$
 * substitution. Triggers we cannot know (flags, variables, wars, court positions …) evaluate to false.
 */
import { parse, type PNode } from '../indexer/parser.ts';
import type { GameIndex } from '../indexer/gameIndex.ts';
import { field, kids, scalar } from './assets.ts';

/** Start date of the 1066 bookmark, as yyyymmdd. */
export const BOOKMARK_DATE = 10660915;

export function dateNum(s: string | null | undefined): number | undefined
{
    const m = s ? /^(\d+)\.(\d+)\.(\d+)$/.exec(s) : null;
    return m ? +m[1] * 10000 + +m[2] * 100 + +m[3] : undefined;
}

const TIER_BY_PREFIX: Record<string, number> = { b: 1, c: 2, d: 3, k: 4, e: 5, h: 6 };
const TIER_NAMES: Record<string, number> = { tier_barony: 1, tier_county: 2, tier_duchy: 3, tier_kingdom: 4, tier_empire: 5, tier_hegemony: 6 };

export interface GeneValue
{
    template?: string;
    value: number;
    /** colour genes: normalized palette coordinates */
    xy?: [number, number];
    /** accessory genes: a modifier can name the accessory directly */
    accessory?: string;
}

/** DNA being modified: one entry per gene plus extra morph genes added on top (`mode = add`). */
export interface GeneState
{
    genes: Map<string, GeneValue>;
    extra: { gene: string; g: GeneValue; }[];
}

export interface CharacterFacts
{
    id: string;
    historical: boolean;
    female: boolean;
    date: number;
    age: number;
    birthYear?: number;
    culture?: string;
    faith?: string;
    traits: Set<string>;
    government?: string;
    dynasty?: string;
    /** titles held at the date, highest tier first */
    titles: { name: string; tier: number; }[];
    employer?: string;
    spouses: string[];
    father?: string;
    mother?: string;
    prowess: number;
}

export type Scope =
    | { t: 'char'; f: CharacterFacts; }
    | { t: 'culture'; name: string; }
    | { t: 'faith'; name: string; }
    | { t: 'religion'; name: string; }
    | { t: 'title'; name: string; tier: number; }
    /** a story cycle made by script (`create_story`); its variables are in the ScriptState */
    | { t: 'story'; type: string; id: string; }
    | { t: 'trait'; name: string; }
    /** the empty scope effects of the game's start run in */
    | { t: 'none'; }
    /** a value saved as a scope (`save_scope_value_as`) */
    | { t: 'value'; v: number; };

/** What a variable holds: a number (yes = 1) or a scope. */
export type VarValue = number | Scope;

/**
 * The script state effects set up — the game start's (gameStart.ts): global variables and variable lists, and the
 * variables and variable lists of characters, titles, stories … (by `varKey`).
 */
export interface ScriptState
{
    globals: Map<string, VarValue>;
    globalLists: Map<string, Scope[]>;
    vars: Map<string, Map<string, VarValue>>;
    lists: Map<string, Map<string, Scope[]>>;
}

/**
 * One evaluation's view of the script state: the state (made when first read — most portraits never read it), and
 * saved scopes (`save_temporary_scope_as`) and local variables of its own.
 */
export interface ScriptRun
{
    state: () => ScriptState;
    saved: Map<string, Scope>;
    locals: Map<string, VarValue>;
}

export function emptyState(): ScriptState
{
    return { globals: new Map(), globalLists: new Map(), vars: new Map(), lists: new Map() };
}

const EMPTY = emptyState();

export function freshRun(state: () => ScriptState = () => EMPTY): ScriptRun
{
    return { state, saved: new Map(), locals: new Map() };
}

/** Where a scope's variables are kept (characters and titles by id, not by the date their facts are for). */
export function varKey(s: Scope): string | undefined
{
    switch (s.t)
    {
        case 'char':
            return 'character:' + s.f.id;
        case 'story':
            return 'story:' + s.id;
        case 'culture':
        case 'faith':
        case 'religion':
        case 'title':
        case 'trait':
            return s.t + ':' + s.name;
    }

    return undefined;
}

interface CultureInfo
{
    gfx: Set<string>;
    pillars: Set<string>;
    traditions: Set<string>;
}

/** Character and title history read at a date. */
export class History
{
    private idx: GameIndex;
    private timelines: Map<string, { date: number; holder?: string; liege?: string; }[]> | null = null;
    private heldAt = new Map<number, Map<string, { name: string; tier: number; }[]>>();
    private factsCache = new Map<string, CharacterFacts | null>();
    private bodies = new Map<string, PNode[] | null>();
    private children: Map<string, string[]> | null = null;
    private faiths: Map<string, { religion: string; doctrines: Set<string>; }> | null = null;
    private cultures = new Map<string, CultureInfo | null>();

    constructor(idx: GameIndex)
    {
        this.idx = idx;
    }

    private titleTimelines(): Map<string, { date: number; holder?: string; liege?: string; }[]>
    {
        if (this.timelines)
            return this.timelines;

        this.timelines = new Map();
        // the files the game loads with the mods (a total conversion replaces history/titles)
        const vfs = this.idx.vfs;

        for (const file of vfs.list('history/titles', { ext: /\.txt$/i }))
        {
            for (const t of parse(vfs.readText(file) ?? ''))
            {
                if (!t.k || !Array.isArray(t.v) || !TIER_BY_PREFIX[t.k[0]])
                    continue;

                const entries: { date: number; holder?: string; liege?: string; }[] = [];

                for (const c of t.v)
                {
                    const date = dateNum(c.k);

                    if (date === undefined || !Array.isArray(c.v))
                        continue;

                    const holder = scalar(field(c.v, 'holder'));
                    const liege = scalar(field(c.v, 'liege'));

                    if (holder !== undefined || liege !== undefined)
                        entries.push({ date, holder, liege });
                }

                // (a title's history can be spread over files — development levels in one of their own: they merge)
                const all = [...(this.timelines.get(t.k) ?? []), ...entries];
                all.sort((a, b) => a.date - b.date);
                this.timelines.set(t.k, all);
            }
        }

        return this.timelines;
    }

    private lastAt(title: string, date: number, key: 'holder' | 'liege'): string | undefined
    {
        let v: string | undefined;

        for (const e of this.titleTimelines().get(title) ?? [])
        {
            if (e.date > date)
                break;

            if (e[key] !== undefined)
                v = e[key];
        }

        return v && v !== '0' ? v : undefined;
    }

    holderAt(title: string, date: number): string | undefined
    {
        return this.lastAt(title, date, 'holder');
    }

    /** De facto liege title of a title (title history `liege = k_france`). */
    liegeTitleAt(title: string, date: number): string | undefined
    {
        return this.lastAt(title, date, 'liege');
    }

    private tierMaps = new Map<number, Map<string, number>>();

    /** Highest title tier (1 barony … 6 hegemony) per holder at a date — for filtering many characters at once. */
    holderTiers(date: number): Map<string, number>
    {
        let m = this.tierMaps.get(date);

        if (m)
            return m;

        m = new Map();

        for (const title of this.titleTimelines().keys())
        {
            const h = this.holderAt(title, date);

            if (h)
                m.set(h, Math.max(m.get(h) ?? 0, TIER_BY_PREFIX[title[0]]));
        }

        this.tierMaps.set(date, m);

        if (this.tierMaps.size > 6)
            this.tierMaps.delete(this.tierMaps.keys().next().value!);

        return m;
    }

    private titlesAt(id: string, date: number): { name: string; tier: number; }[]
    {
        // (a holder map per date — one pass over the titles, what finding one character's titles costs anyway — for a
        // few dates)
        let m = this.heldAt.get(date);

        if (!m)
        {
            m = new Map();

            for (const title of this.titleTimelines().keys())
            {
                const h = this.holderAt(title, date);

                if (!h)
                    continue;

                let list = m.get(h);

                if (!list)
                    m.set(h, list = []);

                list.push({ name: title, tier: TIER_BY_PREFIX[title[0]] });
            }

            for (const list of m.values())
                list.sort((a, b) => b.tier - a.tier);

            this.heldAt.set(date, m);

            if (this.heldAt.size > 8)
                this.heldAt.delete(this.heldAt.keys().next().value!);
        }

        return m.get(id) ?? [];
    }

    /**
     * Facts about a historical character at a date: by default the 1066 bookmark, their death if earlier, or age 30
     * when born later.
     */
    facts(id: string, date?: number): CharacterFacts | null
    {
        const key = id + '@' + (date ?? '');
        const hit = this.factsCache.get(key);

        if (hit !== undefined)
            return hit;

        // (a character's definition, parsed once for every date asked)
        let body = this.bodies.get(id);

        if (body === undefined)
        {
            const e = this.idx.get('characters', id);
            const d = e && this.idx.defNode(e);
            this.bodies.set(id, body = d ? kids(d.node) : null);
        }

        if (!body)
        {
            this.factsCache.set(key, null);
            return null;
        }

        const dated = body
            .map((c) => ({ date: dateNum(c.k), c }))
            .filter((x): x is { date: number; c: PNode; } => x.date !== undefined && Array.isArray(x.c.v))
            .sort((a, b) => a.date - b.date);
        const birth = dated.find((x) => kids(x.c).some((y) => y.k === 'birth'))?.date;
        const death = dated.find((x) => kids(x.c).some((y) => y.k === 'death'))?.date;

        if (date === undefined)
        {
            date = BOOKMARK_DATE;

            if (death !== undefined && death < date)
                date = death;
            else if (birth !== undefined && birth > date)
                date = Math.min(birth + 300000, death ?? Infinity);
        }

        const f: CharacterFacts = {
            id,
            historical: true,
            female: scalar(field(body, 'female')) === 'yes',
            date,
            // (the dead do not age: a date after the death gives the age at death)
            age: birth !== undefined ? Math.floor((Math.min(date, death ?? Infinity) - birth) / 10000) : 35,
            birthYear: birth !== undefined ? Math.floor(birth / 10000) : undefined,
            culture: scalar(field(body, 'culture')),
            faith: scalar(field(body, 'religion')) ?? scalar(field(body, 'faith')),
            traits: new Set(body.filter((c) => c.k === 'trait' && typeof c.v === 'string').map((c) => c.v as string)),
            dynasty: scalar(field(body, 'dynasty')) ?? scalar(field(body, 'dynasty_house')),
            titles: [],
            spouses: [],
            father: scalar(field(body, 'father')),
            mother: scalar(field(body, 'mother')),
            prowess: parseFloat(scalar(field(body, 'prowess')) ?? '5') || 5
        };

        for (const { date: at, c } of dated)
        {
            if (at > date)
                break;

            for (const x of kids(c))
            {
                const v = typeof x.v === 'string' ? x.v : undefined;

                if (!v)
                    continue;

                if (x.k === 'culture')
                    f.culture = v;
                else if (x.k === 'religion' || x.k === 'faith')
                    f.faith = v;
                else if (x.k === 'trait' || x.k === 'add_trait')
                    f.traits.add(v);
                else if (x.k === 'remove_trait')
                    f.traits.delete(v);
                else if (x.k === 'government')
                    f.government = v;
                else if (x.k === 'employer')
                    f.employer = v;
                else if (x.k === 'add_spouse' || x.k === 'add_matrilineal_spouse')
                    f.spouses.push(v);
                else if (x.k === 'remove_spouse')
                    f.spouses = f.spouses.filter((s) => s !== v);
            }
        }

        f.titles = this.titlesAt(id, date);

        // rulers without a scripted government get the first fallback government (feudal)
        if (!f.government && f.titles.length)
            f.government = 'feudal_government';

        this.factsCache.set(key, f);
        return f;
    }

    /** Liege of a character: holder of the primary title's de facto liege title, else their employer. */
    liege(f: CharacterFacts): CharacterFacts | undefined
    {
        let id: string | undefined;

        if (f.titles.length)
        {
            const lt = this.liegeTitleAt(f.titles[0].name, f.date);
            id = lt ? this.holderAt(lt, f.date) : undefined;
        }
        else
            id = f.employer;

        return id && id !== f.id ? (this.facts(id, f.date) ?? undefined) : undefined;
    }

    topLiege(f: CharacterFacts): CharacterFacts
    {
        let cur = f;

        for (let i = 0; i < 8; i++)
        {
            const l = this.liege(cur);

            if (!l)
                break;

            cur = l;
        }

        return cur;
    }

    /** Parents, children and siblings. */
    closeFamily(f: CharacterFacts): CharacterFacts[]
    {
        if (!this.children)
        {
            // one pass over the character history files (parents are top-level fields)
            this.children = new Map();
            const vfs = this.idx.vfs;

            for (const file of vfs.list('history/characters', { ext: /\.txt$/i }))
            {
                for (const c of parse(vfs.readText(file) ?? ''))
                {
                    if (!c.k || !Array.isArray(c.v))
                        continue;

                    for (const p of ['father', 'mother'])
                    {
                        const pid = scalar(field(c.v, p));

                        if (pid)
                            (this.children.get(pid) ?? this.children.set(pid, []).get(pid)!).push(c.k);
                    }
                }
            }
        }

        const ids = new Set<string>();

        for (const p of [f.father, f.mother])
        {
            if (!p)
                continue;

            ids.add(p);

            for (const s of this.children.get(p) ?? [])
                ids.add(s);
        }

        for (const c of this.children.get(f.id) ?? [])
            ids.add(c);

        ids.delete(f.id);
        return [...ids].map((id) => this.facts(id, f.date)).filter((x): x is CharacterFacts => !!x);
    }

    faith(name: string): { religion: string; doctrines: Set<string>; } | undefined
    {
        if (!this.faiths)
        {
            this.faiths = new Map();

            for (const religion of this.idx.names('religion/religion_types'))
            {
                const e = this.idx.get('religion/religion_types', religion);
                const d = e && this.idx.defNode(e);

                if (!d)
                    continue;

                const body = kids(d.node);
                const base = body.filter((c) => c.k === 'doctrine' && typeof c.v === 'string').map((c) => c.v as string);

                for (const faith of kids(field(body, 'faiths')))
                {
                    if (!faith.k || !Array.isArray(faith.v))
                        continue;

                    const own = faith.v.filter((c) => c.k === 'doctrine' && typeof c.v === 'string').map((c) => c.v as string);
                    this.faiths.set(faith.k, { religion, doctrines: new Set([...base, ...own]) });
                }
            }
        }

        return this.faiths.get(name);
    }

    culture(name: string): CultureInfo | undefined
    {
        let c = this.cultures.get(name);

        if (c === undefined)
        {
            const e = this.idx.get('culture/cultures', name);
            const d = e && this.idx.defNode(e);
            c = null;

            if (d)
            {
                const body = kids(d.node);
                const list = (k: string): string[] => kids(field(body, k)).map((x) => String(x.v));
                c = {
                    gfx: new Set([...list('clothing_gfx'), ...list('building_gfx'), ...list('coa_gfx'), ...list('unit_gfx')]),
                    pillars: new Set(['heritage', 'language', 'ethos', 'martial_custom'].map((k) => scalar(field(body, k))).filter((x): x is string => !!x)),
                    traditions: new Set(list('traditions'))
                };
            }

            this.cultures.set(name, c);
        }

        return c ?? undefined;
    }

    governmentFlags(name: string | undefined): Set<string>
    {
        const e = name ? this.idx.get('governments', name) : undefined;
        const d = e && this.idx.defNode(e);
        return new Set(d ? kids(field(kids(d.node), 'flags')).map((x) => String(x.v)) : []);
    }
}

interface EvalCtx
{
    root: CharacterFacts;
    genes: GeneState;
    consts: Map<string, string>;
    cache: Map<string, boolean>;
    depth: number;
    /** triggers with a fixed answer (the viewer's "undressed" mode forces should_be_naked_trigger & co.) */
    forced?: Map<string, boolean>;
    /** variables, saved scopes, global lists */
    run: ScriptRun;
}

const LOGIC_SKIP = new Set(['add', 'factor', 'desc', 'text', 'subject', 'object', 'value', 'amount', 'limit']);

/** Tolerant evaluation of trigger blocks for portrait weights. */
export class TriggerEvaluator
{
    private idx: GameIndex;
    readonly history: History;

    constructor(idx: GameIndex, history: History)
    {
        this.idx = idx;
        this.history = history;
    }

    /** All triggers of a block must hold; handles trigger_if / trigger_else_if / trigger_else chains. */
    block(list: PNode[], scope: Scope, ctx: EvalCtx): boolean
    {
        let chainDone = true;

        for (const n of list)
        {
            if (!n.k || LOGIC_SKIP.has(n.k))
                continue;

            if (n.k === 'trigger_if' || n.k === 'trigger_else_if' || n.k === 'trigger_else')
            {
                if (n.k === 'trigger_if')
                    chainDone = false;
                else if (chainDone)
                    continue;

                const body = kids(n);
                const limit = field(body, 'limit');

                if (n.k !== 'trigger_else' && limit && !this.block(kids(limit), scope, ctx))
                    continue;

                chainDone = true;

                if (!this.block(body, scope, ctx))
                    return false;

                continue;
            }

            chainDone = true;

            if (!this.node(n, scope, ctx))
                return false;
        }

        return true;
    }

    /**
     * At least one trigger holds. A trigger_if chain whose limits all fail is neutral here (in an AND it is neutral
     * as true): `should_be_naked_trigger` relies on it (OR { … trigger_if = { limit = { naked priests } … } }).
     */
    private any(list: PNode[], scope: Scope, ctx: EvalCtx): boolean
    {
        let chainDone = true;

        for (const n of list)
        {
            if (!n.k || LOGIC_SKIP.has(n.k))
                continue;

            if (n.k === 'trigger_if' || n.k === 'trigger_else_if' || n.k === 'trigger_else')
            {
                if (n.k === 'trigger_if')
                    chainDone = false;
                else if (chainDone)
                    continue;

                const body = kids(n);
                const limit = field(body, 'limit');

                if (n.k !== 'trigger_else' && limit && !this.block(kids(limit), scope, ctx))
                    continue;

                chainDone = true;

                if (this.block(body, scope, ctx))
                    return true;

                continue;
            }

            chainDone = true;

            if (this.node(n, scope, ctx))
                return true;
        }

        return false;
    }

    private num(v: string | undefined, ctx: EvalCtx, scope: Scope): number | undefined
    {
        if (v === undefined)
            return undefined;

        if (v.startsWith('@'))
            v = ctx.consts.get(v.slice(1)) ?? v;

        if (TIER_NAMES[v] !== undefined)
            return TIER_NAMES[v];

        const n = parseFloat(v);
        return Number.isFinite(n) && /^-?[\d.]+$/.test(v) ? n : this.value(v, scope, ctx);
    }

    /**
     * Script value block: `{ value = age multiply = 0.01 }` — value/add/subtract/multiply/divide/min/max and
     * if/else_if/else with `limit`, applied in order.
     */
    scriptValue(list: PNode[], scope: Scope, ctx: EvalCtx, start = 0): number
    {
        let acc = start;
        let chainDone = true;

        for (const c of list)
        {
            if (c.k === 'if' || c.k === 'else_if' || c.k === 'else')
            {
                if (c.k === 'if')
                    chainDone = false;
                else if (chainDone)
                    continue;

                const body = kids(c);
                const limit = field(body, 'limit');

                if (c.k !== 'else' && limit && !this.block(kids(limit), scope, ctx))
                    continue;

                chainDone = true;
                acc = this.scriptValue(body, scope, ctx, acc);
                continue;
            }

            chainDone = true;

            if (!c.k || c.k === 'limit' || c.k === 'desc')
                continue;

            // temporary scopes, and list iterators whose operations work on the value (a script value can find a
            // story holding a character's variables that way)
            if ((c.k === 'save_temporary_scope_as' || c.k === 'save_scope_as') && typeof c.v === 'string')
            {
                ctx.run.saved.set(c.v, scope);
                continue;
            }

            if (Array.isArray(c.v) && /^(every|ordered|random)_in_(global_)?list$/.test(c.k))
            {
                const limit = field(c.v, 'limit');
                const body = c.v.filter((x) => x.k !== 'variable' && x.k !== 'list');

                for (const s of this.listOf(scalar(field(c.v, 'variable')), scope, ctx, c.k.includes('global')))
                {
                    if (limit && !this.block(kids(limit), s, ctx))
                        continue;

                    acc = this.scriptValue(body, s, ctx, acc);

                    // (random / ordered: one of them — the first that fits)
                    if (!c.k.startsWith('every_'))
                        break;
                }

                continue;
            }

            const x = typeof c.v === 'string' ? (this.num(c.v, ctx, scope) ?? 0) : Array.isArray(c.v) ? this.scriptValue(c.v, scope, ctx) : 0;

            if (c.k === 'value')
                acc = x;
            else if (c.k === 'add')
                acc += x;
            else if (c.k === 'subtract')
                acc -= x;
            else if (c.k === 'multiply')
                acc *= x;
            else if (c.k === 'divide')
                acc = x ? acc / x : acc;
            else if (c.k === 'min')
                acc = Math.max(acc, x);
            else if (c.k === 'max')
                acc = Math.min(acc, x);
        }

        return acc;
    }

    /** A value by name: a number, `@constant`, tier or named script value (0 when unknown). */
    namedValue(name: string, scope: Scope, ctx: EvalCtx): number
    {
        return this.num(name, ctx, scope) ?? 0;
    }

    /** Numeric properties: age, highest_held_title_tier, primary_title.tier, scope:age, morph_gene_value:x, … */
    private value(path: string, scope: Scope, ctx: EvalCtx): number | undefined
    {
        if (path.startsWith('morph_gene_value:'))
            return ctx.genes.genes.get(path.slice(17))?.value ?? 0;

        // variables (the script state's), a value saved as a scope
        if (/^(var|local_var|global_var):/.test(path))
        {
            const x = this.variable(path, scope, ctx);
            return typeof x === 'number' ? x : x?.t === 'value' ? x.v : undefined;
        }

        if (path.startsWith('scope:') && !path.includes('.'))
        {
            const s = ctx.run.saved.get(path.slice(6));

            if (s?.t === 'value')
                return s.v;
        }

        const dot = path.lastIndexOf('.');

        if (dot > 0)
        {
            const s = this.scopeOf(path.slice(0, dot), scope, ctx);
            return s ? this.value(path.slice(dot + 1), s, ctx) : undefined;
        }

        const r = ctx.root;

        switch (path)
        {
            case 'scope:age':
                return r.age;
            case 'scope:year_of_birth':
                return r.birthYear ?? Math.floor(r.date / 10000) - r.age;
            case 'scope:highest_held_title_tier':
                return r.titles[0]?.tier ?? 0;
            case 'scope:current_weight':
            case 'scope:weight_for_portrait':
            case 'current_weight':
                return 0;
            case 'scope:prowess':
                return r.prowess;
            case 'current_year':
                return Math.floor(r.date / 10000);
        }

        // engine values for portraits (no script definition): our approximation
        if (path === 'prowess_for_portrait')
            return scope.t === 'char' ? scope.f.prowess / 100 : 0;

        if (scope.t === 'title' && path === 'tier')
            return scope.tier;

        if (scope.t === 'char')
        {
            const f = scope.f;

            switch (path)
            {
                case 'age':
                    return f.age;
                case 'highest_held_title_tier':
                    return f.titles[0]?.tier ?? 0;
                case 'prowess':
                    return f.prowess;
                case 'merit_level':
                    return 0;
                case 'num_of_spouses':
                    return f.spouses.length;
            }
        }

        // named script values (common/script_values)
        const sv = this.idx.get('script_values', path);
        const d = sv && this.idx.defNode(sv);

        if (!d)
            return undefined;

        if (typeof d.node.v === 'string')
            return parseFloat(d.node.v) || 0;

        if (ctx.depth >= 40)
            return undefined;

        ctx.depth++;
        const v = this.scriptValue(kids(d.node), scope, ctx);
        ctx.depth--;
        return v;
    }

    /** A variable of the scope (`var:x`), a local (`local_var:x`) or global one (`global_var:x`). */
    variable(key: string, scope: Scope, ctx: EvalCtx): VarValue | undefined
    {
        const colon = key.indexOf(':');
        const kind = key.slice(0, colon);
        const name = key.slice(colon + 1);

        if (kind === 'local_var')
            return ctx.run.locals.get(name);

        if (kind === 'global_var')
            return ctx.run.state().globals.get(name);

        const k = kind === 'var' ? varKey(scope) : undefined;
        return k ?
            ctx.run.state().vars
                .get(k)
                ?.get(name) :
            undefined;
    }

    /** A variable list: a global one, else the scope's (lists of saved scopes — `list = x` — are not kept). */
    listOf(name: string | undefined, scope: Scope, ctx: EvalCtx, global: boolean): Scope[]
    {
        if (!name)
            return [];

        const state = ctx.run.state();

        if (global)
            return state.globalLists.get(name) ?? [];

        const k = varKey(scope);
        return (k && state.lists.get(k)?.get(name)) || [];
    }

    /** Resolves scope paths: culture, faith, liege, primary_title, scope:culture, character:123, culture:x.y … */
    scopeOf(path: string, scope: Scope, ctx: EvalCtx): Scope | undefined
    {
        const parts = path.split('.');
        let cur: Scope | undefined = scope;

        for (const p of parts)
        {
            if (!cur)
                return undefined;

            cur = this.step(p, cur, ctx);
        }

        return cur;
    }

    private step(p: string, scope: Scope, ctx: EvalCtx): Scope | undefined
    {
        const colon = p.indexOf(':');

        if (colon > 0)
        {
            const kind = p.slice(0, colon);
            const name = p.slice(colon + 1);

            // saved scopes, traits (`trait:x = { is_in_list = traits }`), scopes variables hold
            if (kind === 'scope' && ctx.run.saved.has(name))
                return ctx.run.saved.get(name);

            if (kind === 'trait')
                return { t: 'trait', name };

            if (kind === 'var' || kind === 'local_var' || kind === 'global_var')
            {
                const ref = this.variable(p, scope, ctx);
                return typeof ref === 'object' ? ref : undefined;
            }

            if (kind === 'character')
            {
                const f = this.history.facts(name, ctx.root.date);
                return f ? { t: 'char', f } : undefined;
            }

            if (kind === 'culture')
                return { t: 'culture', name };

            if (kind === 'faith')
                return { t: 'faith', name };

            if (kind === 'religion')
                return { t: 'religion', name };

            if (kind === 'title')
                return { t: 'title', name, tier: TIER_BY_PREFIX[name[0]] ?? 0 };

            if (kind === 'scope')
            {
                if (name === 'culture')
                    return ctx.root.culture ? { t: 'culture', name: ctx.root.culture } : undefined;

                if (name === 'faith')
                    return ctx.root.faith ? { t: 'faith', name: ctx.root.faith } : undefined;

                return undefined;
            }

            return undefined;
        }

        if (p === 'this' || p === 'prev')
            return scope;

        if (p === 'root')
            return ctx.root.id ? { t: 'char', f: ctx.root } : { t: 'none' };

        if (scope.t === 'faith' && p === 'religion')
        {
            const r = this.history.faith(scope.name)?.religion;
            return r ? { t: 'religion', name: r } : undefined;
        }

        if (scope.t === 'title' && p === 'holder')
        {
            const h = this.history.holderAt(scope.name, ctx.root.date);
            const f = h ? this.history.facts(h, ctx.root.date) : null;
            return f ? { t: 'char', f } : undefined;
        }

        if (scope.t !== 'char')
            return undefined;

        const f = scope.f;

        switch (p)
        {
            case 'culture':
                return f.culture ? { t: 'culture', name: f.culture } : undefined;
            case 'faith':
                return f.faith ? { t: 'faith', name: f.faith } : undefined;
            case 'religion':
            {
                const r = f.faith ? this.history.faith(f.faith)?.religion : undefined;
                return r ? { t: 'religion', name: r } : undefined;
            }
            case 'primary_title':
                return f.titles[0] ? { t: 'title', ...f.titles[0] } : undefined;
            case 'liege':
            case 'court_owner':
            {
                const l = this.history.liege(f);
                return l ? { t: 'char', f: l } : undefined;
            }
            case 'top_liege':
                return { t: 'char', f: this.history.topLiege(f) };
            case 'primary_spouse':
            {
                const s = f.spouses[0] ? this.history.facts(f.spouses[0], f.date) : null;
                return s ? { t: 'char', f: s } : undefined;
            }
            case 'father':
            case 'mother':
            {
                const id = p === 'father' ? f.father : f.mother;
                const x = id ? this.history.facts(id, f.date) : null;
                return x ? { t: 'char', f: x } : undefined;
            }
        }

        return undefined;
    }

    sameScope(a: Scope | undefined, b: Scope | undefined): boolean
    {
        if (!a || !b || a.t !== b.t)
            return false;

        if (a.t === 'value')
            return a.v === (b as { v: number; }).v;

        return a.t === 'none' || varKey(a) === varKey(b);
    }

    private scopeKey(s: Scope): string
    {
        return s.t === 'char' ? 'c' + s.f.id + '@' + s.f.date : s.t === 'value' ? 'value:' + s.v : (varKey(s) ?? s.t);
    }

    node(n: PNode, scope: Scope, ctx: EvalCtx): boolean
    {
        const k = n.k!;
        const v = typeof n.v === 'string' ? n.v : undefined;
        const block = Array.isArray(n.v) ? n.v : undefined;
        // `?=` (exists and equals) compares like `=`: a side that does not exist fails either way
        const op = n.op === '?=' ? '=' : (n.op ?? '=');

        if (block && (k === 'any_in_global_list' || k === 'any_in_list'))
        {
            const rest = block.filter((c) => c.k !== 'variable' && c.k !== 'list' && c.k !== 'count' && c.k !== 'percent');
            return this.listOf(scalar(field(block, 'variable')), scope, ctx, k === 'any_in_global_list').some((s) => this.block(rest, s, ctx));
        }

        if (block && (k === 'is_target_in_global_variable_list' || k === 'is_target_in_variable_list'))
        {
            const target = this.scopeOf(scalar(field(block, 'target')) ?? '', scope, ctx);
            return this.listOf(scalar(field(block, 'name')), scope, ctx, k.includes('global')).some((s) => this.sameScope(s, target));
        }

        switch (k)
        {
            case 'AND':
                return this.block(block ?? [], scope, ctx);
            case 'OR':
                return this.any(block ?? [], scope, ctx);
            case 'NOT':
            case 'NAND':
                return !this.block(block ?? [], scope, ctx);
            case 'NOR':
                return !this.any(block ?? [], scope, ctx);
            case 'calc_true_if':
            {
                const amount = parseFloat(scalar(field(block ?? [], 'amount')) ?? '1') || 1;
                return (block ?? []).filter((c) => c.k && !LOGIC_SKIP.has(c.k) && this.block([c], scope, ctx)).length >= amount;
            }
            case 'always':
                return v === 'yes';
            case 'custom_tooltip':
            case 'custom_description':
            case 'trigger': // weight modifiers may wrap their conditions: modifier = { factor = 0 trigger = { … } }
                return block ? this.block(block, scope, ctx) : true;
            case 'save_temporary_scope_as':
            case 'save_scope_as':
                if (v)
                    ctx.run.saved.set(v, scope);

                return true;
            case 'exists':
            {
                if (!v)
                    return false;

                if (v === 'this' || v === 'root')
                    return true;

                // a variable (of a scope on the way: `scope:story.var:x`) — a number exists as well as a scope
                const m = /^(?:(.+)\.)?((?:var|local_var|global_var):\w+)$/.exec(v);

                if (m)
                {
                    const on = m[1] ? this.scopeOf(m[1], scope, ctx) : scope;
                    return !!on && this.variable(m[2], on, ctx) !== undefined;
                }

                // ~300 historical overrides test `exists = character:X`: no need to build their facts
                if (v.startsWith('character:'))
                    return !!this.idx.get('characters', v.slice(10));

                return !!this.scopeOf(v, scope, ctx);
            }
            case 'has_gene':
            {
                const cat = scalar(field(block ?? [], 'category')) ?? '';
                const tmpl = scalar(field(block ?? [], 'template'));
                return ctx.genes.genes.get(cat)?.template === tmpl || ctx.genes.extra.some((x) => x.gene === cat && x.g.template === tmpl);
            }
            case 'has_dlc_feature':
            case 'has_dlc':
                return true;
        }

        const forced = ctx.forced?.get(k);

        if (forced !== undefined)
            return forced === (v !== 'no');

        // scripted triggers: `name = yes|no` or `name = { PARAM = value }` (parameters substituted by defNode)
        const st = this.idx.get('scripted_triggers', k);

        if (st)
        {
            if (ctx.depth > 40)
                return false;

            const params: Record<string, string> = {};

            for (const c of block ?? [])
                if (c.k && typeof c.v === 'string')
                    params[c.k] = c.v;

            const cacheKey = this.scopeKey(scope) + '|' + k + '|' + JSON.stringify(params);
            let res = ctx.cache.get(cacheKey);

            if (res === undefined)
            {
                const d = this.idx.defNode(st, Object.keys(params).length ? params : undefined);
                ctx.depth++;
                res = d ? this.block(kids(d.node), scope, ctx) : false;
                ctx.depth--;
                ctx.cache.set(cacheKey, res);
            }

            return v === 'no' ? !res : res;
        }

        // comparison with a script value: `morph_gene_value:gene_baldness > { value = age multiply = 0.01 }`
        if (block && op !== '=' && op !== '?=')
        {
            const lhs = this.value(k, scope, ctx);
            return lhs !== undefined && compare(lhs, op, this.scriptValue(block, scope, ctx));
        }

        // scope change: `culture = { … }`, `liege ?= { … }`, `scope:culture ?= { … }`, `any_close_family_member = { … }`
        if (block)
        {
            if (k === 'any_close_family_member' || k === 'any_child' || k === 'any_parent' || k === 'any_sibling' || k === 'any_spouse')
            {
                if (scope.t !== 'char')
                    return false;

                const fam = k === 'any_spouse' ? scope.f.spouses.map((s) => this.history.facts(s, scope.f.date)).filter((x): x is CharacterFacts => !!x) : this.history.closeFamily(scope.f);
                return fam.some((f) => this.block(block, { t: 'char', f }, ctx));
            }

            const target = this.scopeOf(k, scope, ctx);
            return target ? this.block(block, target, ctx) : false;
        }

        if (v === undefined)
            return false;

        // comparisons with numbers / tiers
        if (op !== '=' || /^-?[\d.]+$/.test(v) || v.startsWith('@') || TIER_NAMES[v] !== undefined)
        {
            const lhs = this.value(k, scope, ctx);
            const rhs = this.num(v, ctx, scope);

            if (lhs !== undefined && rhs !== undefined)
                return compare(lhs, op, rhs);

            if (op !== '=' && op !== '!=')
                return false;
        }

        // identity: `this = character:90104`, `culture = culture:norse`, `faith.religion = religion:x`, `primary_title = title:k_x`
        if (/^(character|culture|faith|religion|title|scope):/.test(v) || v === 'root' || v === 'this')
        {
            if ((k === 'this' || k === 'root') && v.startsWith('character:'))
            {
                const who = k === 'root' ? ctx.root.id : scope.t === 'char' ? scope.f.id : undefined;
                return (who === v.slice(10)) === (op !== '!=');
            }

            const same = this.sameScope(this.scopeOf(k, scope, ctx), this.scopeOf(v, scope, ctx));
            return op === '!=' ? !same : same;
        }

        const yes = v === 'yes';
        return this.leaf(k, v, yes, scope, ctx);
    }

    private leaf(k: string, v: string, yes: boolean, scope: Scope, ctx: EvalCtx): boolean
    {
        // variables of any scope, local and global ones, variable lists
        switch (k)
        {
            case 'has_variable':
                return this.variable('var:' + v, scope, ctx) !== undefined;
            case 'has_local_variable':
                return ctx.run.locals.has(v);
            case 'has_global_variable':
                return ctx.run.state().globals.has(v);
            case 'has_global_variable_list':
                return this.listOf(v, scope, ctx, true).length > 0;
            case 'has_variable_list':
                return this.listOf(v, scope, ctx, false).length > 0;
        }

        if (scope.t === 'culture')
        {
            const c = this.history.culture(scope.name);

            if (!c)
                return false;

            if (/^has_(clothing|building|coa|unit)_gfx$/.test(k))
                return c.gfx.has(v);

            if (k === 'has_cultural_pillar')
                return c.pillars.has(v);

            if (k === 'has_cultural_tradition')
                return c.traditions.has(v);

            return false;
        }

        if (scope.t === 'faith')
        {
            if (k === 'has_doctrine')
                return !!this.history.faith(scope.name)?.doctrines.has(v);

            if (k === 'religion_tag')
                return this.history.faith(scope.name)?.religion === v;

            return false;
        }

        if (scope.t === 'story')
            return k === 'story_type' && scope.type === v;

        // (portrait triggers get the character's traits as the list `traits`: portrait_has_trait_trigger)
        if (scope.t === 'trait')
            return k === 'is_in_list' && v === 'traits' && ctx.root.traits.has(scope.name);

        if (scope.t !== 'char')
            return false;

        const f = scope.f;
        const flags = (): Set<string> => this.history.governmentFlags(f.government);
        const bool = (x: boolean): boolean => x === yes;

        switch (k)
        {
            case 'is_female':
                return bool(f.female);
            case 'is_male':
                return bool(!f.female);
            case 'is_adult':
                return bool(f.age >= 16);
            case 'is_child':
                return bool(f.age < 16);
            case 'is_alive':
                return bool(true);
            case 'is_ruler':
            case 'is_landed':
            case 'is_playable_character':
                return bool(f.titles.length > 0);
            case 'is_independent_ruler':
                return bool(f.titles.length > 0 && !this.history.liege(f));
            case 'is_lowborn':
                return bool(!f.dynasty);
            case 'is_married':
                return bool(f.spouses.length > 0);
            case 'is_clergy':
                return bool(flags().has('government_is_theocracy'));
            case 'is_landless_adventurer':
                return bool(flags().has('government_is_landless_adventurer'));
            case 'has_trait':
                return f.traits.has(v);
            case 'has_government':
                return f.government === v;
            case 'government_has_flag':
                return flags().has(v);
            case 'has_title':
                return f.titles.some((t) => 'title:' + t.name === v);
            case 'has_culture':
                return 'culture:' + f.culture === v;
            case 'has_faith':
                return 'faith:' + f.faith === v;
            case 'has_religion':
                return !!f.faith && 'religion:' + this.history.faith(f.faith)?.religion === v;
        }

        // flags, variables, modifiers, laws, activities, wars, court and council positions, … are unknown: false
        // (so `has_character_flag = x` fails and `is_at_war = no` holds)
        return v === 'no';
    }
}

function compare(a: number, op: string, b: number): boolean
{
    switch (op)
    {
        case '<':
            return a < b;
        case '<=':
            return a <= b;
        case '>':
            return a > b;
        case '>=':
            return a >= b;
        case '!=':
            return a !== b;
        default:
            return a === b;
    }
}

interface ModDef
{
    name: string;
    dna: PNode[];
    weight: PNode[];
}

interface ModGroup
{
    name: string;
    priority: number;
    order: number;
    max: boolean;
    fallback?: string;
    mods: ModDef[];
    consts: Map<string, string>;
}

/** gfx/portraits/trait_portrait_modifiers: `group = { entry = { traits trigger base dna_modifiers = { human = { … } } } }` */
export interface TraitEntry
{
    group: string;
    name: string;
    traits: string[];
    trigger?: PNode[];
    base?: string;
    /** dna modifiers per portrait type (`human`) */
    dna: Map<string, PNode[]>;
    consts: Map<string, string>;
}

/** gfx/portraits/portrait_animations: per group and portrait kind the options (torso state + weight) and a default */
interface AnimGroup
{
    name: string;
    kinds: Map<string, { options: { name: string; torso?: string; weight: PNode[]; }[]; fallback?: string; }>;
    consts: Map<string, string>;
}

/** Applies the portrait modifier groups to a DNA for a character. */
export class PortraitModifiers
{
    private idx: GameIndex;
    readonly eval: TriggerEvaluator;
    private groupList: ModGroup[] | null = null;
    private traitGroups: TraitEntry[][] | null = null;
    private animGroups: AnimGroup[] | null = null;

    constructor(idx: GameIndex, history: History)
    {
        this.idx = idx;
        this.eval = new TriggerEvaluator(idx, history);
    }

    private groups(): ModGroup[]
    {
        if (this.groupList)
            return this.groupList;

        const out: ModGroup[] = [];
        const vfs = this.idx.vfs;
        let order = 0;

        // in load order: the game's files and the mods' (a mod's file of the same name replaces the game's)
        for (const file of vfs.list('gfx/portraits/portrait_modifiers', { ext: /\.txt$/i, shallow: true, engine: true }))
        {
            const text = vfs.readText(file) ?? '';
            const consts = new Map<string, string>();

            for (const m of text.matchAll(/^\s*@(\w+)\s*=\s*"?([^\s"#]+)"?/gm))
                consts.set(m[1], m[2]);

            for (const g of parse(text))
            {
                if (!g.k || g.k.startsWith('@') || !Array.isArray(g.v))
                    continue;

                const usage = scalar(field(g.v, 'usage')) ?? 'both';

                if (usage !== 'game' && usage !== 'both')
                    continue;

                const mods: ModDef[] = [];

                for (const m of g.v)
                {
                    if (!m.k || !Array.isArray(m.v) || m.k === 'add_accessory_modifiers')
                        continue;

                    const dna = field(m.v, 'dna_modifiers');

                    if (!dna)
                        continue;

                    const mu = scalar(field(m.v, 'usage')) ?? 'both';

                    // event-only outfits (require_outfit_tags) never apply outside events
                    if ((mu !== 'game' && mu !== 'both') || scalar(field(m.v, 'require_outfit_tags')) === 'yes')
                        continue;

                    mods.push({ name: m.k, dna: kids(dna), weight: kids(field(m.v, 'weight')) });
                }

                out.push({
                    name: g.k,
                    priority: parseFloat(scalar(field(g.v, 'priority')) ?? '0') || 0,
                    order: order++,
                    max: scalar(field(g.v, 'selection_behavior')) === 'max',
                    fallback: scalar(field(g.v, 'fallback')),
                    mods,
                    consts
                });
            }
        }

        out.sort((a, b) => a.priority - b.priority || a.order - b.order);
        return (this.groupList = out);
    }

    private weight(m: ModDef, ctx: EvalCtx): number
    {
        const scope: Scope = { t: 'char', f: ctx.root };
        const num = (n: PNode | undefined): number =>
        {
            if (!n)
                return 0;

            if (Array.isArray(n.v))
                return num(field(n.v, 'value'));

            const s = String(n.v);
            return parseFloat(s.startsWith('@') ? (ctx.consts.get(s.slice(1)) ?? '0') : s) || 0;
        };
        let w = num(field(m.weight, 'base'));

        for (const mod of m.weight)
        {
            if (mod.k !== 'modifier' || !Array.isArray(mod.v))
                continue;

            if (!this.eval.block(mod.v, scope, ctx))
                continue;

            const add = field(mod.v, 'add');
            const factor = field(mod.v, 'factor');

            if (add)
                w += num(add);

            if (factor)
                w *= num(factor);
        }

        return w;
    }

    /** Runs every group in priority order; returns the names of the chosen modifiers. */
    apply(state: GeneState, root: CharacterFacts, seed: string, rng: (seed: string) => () => number, forced?: Map<string, boolean>, run: ScriptRun = freshRun()): string[]
    {
        const chosen: string[] = [];
        const cache = new Map<string, boolean>();

        for (const g of this.groups())
        {
            const ctx: EvalCtx = { root, genes: state, consts: g.consts, cache, depth: 0, forced, run };
            const rand = rng(seed + ':' + g.name);
            const weights = g.mods.map((m) => ({ m, w: this.weight(m, ctx) }));
            let pick = weights.find((x) => x.w >= 100)?.m;

            if (!pick)
            {
                const positive = weights.filter((x) => x.w > 0);

                if (g.max)
                    pick = positive.sort((a, b) => b.w - a.w)[0]?.m;
                else
                {
                    const total = positive.reduce((s, x) => s + x.w, 0);
                    let r = rand() * total;
                    pick = positive.find((x) => (r -= x.w) <= 0)?.m ?? positive[positive.length - 1]?.m;
                }
            }

            pick ??= g.mods.find((m) => m.name === g.fallback);

            if (!pick)
                continue;

            chosen.push(g.name + '.' + pick.name);
            this.applyDna(pick, state, rand, ctx);
            // later triggers (has_gene) see the modified DNA; cached results may depend on it
            cache.clear();
        }

        return chosen;
    }

    /** A named script value for a character (with the script state of `run`). */
    scriptValue(name: string, root: CharacterFacts, run: ScriptRun = freshRun()): number
    {
        const ctx: EvalCtx = { root, genes: { genes: new Map(), extra: [] }, consts: new Map(), cache: new Map(), depth: 0, run };
        return this.eval.namedValue(name, { t: 'char', f: root }, ctx);
    }

    /** The files of a gfx/portraits folder in load order, parsed, with their `@constants`. */
    private gfxFiles(dir: string): { nodes: PNode[]; consts: Map<string, string>; }[]
    {
        const vfs = this.idx.vfs;
        return vfs.list(dir, { ext: /\.txt$/i, shallow: true, engine: true }).map((file) =>
        {
            const text = vfs.readText(file) ?? '';
            const consts = new Map<string, string>();

            for (const m of text.matchAll(/^\s*@(\w+)\s*=\s*"?([^\s"#]+)"?/gm))
                consts.set(m[1], m[2]);

            return { nodes: parse(text), consts };
        });
    }

    private traitModifierGroups(): TraitEntry[][]
    {
        if (this.traitGroups)
            return this.traitGroups;

        const out: TraitEntry[][] = [];

        for (const { nodes, consts } of this.gfxFiles('gfx/portraits/trait_portrait_modifiers'))
        {
            for (const g of nodes)
            {
                if (!g.k || g.k.startsWith('@') || !Array.isArray(g.v))
                    continue;

                const entries: TraitEntry[] = [];

                for (const e of g.v)
                {
                    if (!e.k || !Array.isArray(e.v))
                        continue;

                    const dna = new Map<string, PNode[]>();

                    for (const t of kids(field(e.v, 'dna_modifiers') ?? field(e.v, 'dna_modifier')))
                        if (t.k && Array.isArray(t.v))
                            dna.set(t.k, t.v);

                    const trigger = field(e.v, 'trigger');
                    entries.push({
                        group: g.k,
                        name: e.k,
                        traits: kids(field(e.v, 'traits')).map((x) => String(x.v)),
                        trigger: trigger ? kids(trigger) : undefined,
                        base: scalar(field(e.v, 'base')),
                        dna,
                        consts
                    });
                }

                out.push(entries);
            }
        }

        return (this.traitGroups = out);
    }

    /** Every trait portrait modifier entry. */
    traitEntryList(): TraitEntry[]
    {
        return this.traitModifierGroups().flat();
    }

    /**
     * Trait portrait modifiers that apply to a character: per group the first entry whose traits the character has
     * and whose trigger holds (_trait_modifier.info). The builder applies them only to creatures (see portrait.ts).
     */
    traitEntries(root: CharacterFacts, run: ScriptRun = freshRun()): TraitEntry[]
    {
        const out: TraitEntry[] = [];

        for (const entries of this.traitModifierGroups())
        {
            const hit = entries.find((e) =>
            {
                if (!e.traits.some((t) => root.traits.has(t)))
                    return false;

                if (!e.trigger)
                    return true;

                const ctx: EvalCtx = { root, genes: { genes: new Map(), extra: [] }, consts: e.consts, cache: new Map(), depth: 0, run };
                return this.eval.block(e.trigger, { t: 'char', f: root }, ctx);
            });

            if (hit)
                out.push(hit);
        }

        return out;
    }

    /** Applies trait portrait modifier entries (and their `base` entries) for a portrait type; returns their names. */
    applyTraits(state: GeneState, root: CharacterFacts, entries: TraitEntry[], type: string, seed: string, rng: (seed: string) => () => number, run: ScriptRun = freshRun()): string[]
    {
        const byName = new Map(
            this.traitModifierGroups()
                .flat()
                .map((e) => [e.name, e])
        );
        const out: string[] = [];

        for (const e of entries)
        {
            const chain = [e.base ? byName.get(e.base) : undefined, e].filter((x): x is TraitEntry => !!x);

            for (const x of chain)
            {
                const ctx: EvalCtx = { root, genes: state, consts: x.consts, cache: new Map(), depth: 0, run };
                this.applyDna({ name: x.name, dna: x.dna.get(type) ?? [], weight: [] }, state, rng(seed + ':' + x.group + ':' + x.name), ctx);
            }

            out.push('trait:' + e.group + '.' + e.name);
        }

        return out;
    }

    private animationGroups(): AnimGroup[]
    {
        if (this.animGroups)
            return this.animGroups;

        const out: AnimGroup[] = [];

        for (const { nodes, consts } of this.gfxFiles('gfx/portraits/portrait_animations'))
        {
            for (const g of nodes)
            {
                if (!g.k || g.k.startsWith('@') || !Array.isArray(g.v))
                    continue;

                const kinds: AnimGroup['kinds'] = new Map();
                const blocks = new Map(g.v.filter((c) => c.k).map((c) => [c.k!, c]));

                for (const kind of ['male', 'female', 'boy', 'girl'])
                {
                    // `female = male` references another kind's block
                    let b = blocks.get(kind);

                    for (let i = 0; i < 3 && b && typeof b.v === 'string'; i++)
                        b = blocks.get(b.v);

                    if (!b || !Array.isArray(b.v))
                        continue;

                    const options: { name: string; torso?: string; weight: PNode[]; }[] = [];
                    let fallback: string | undefined;

                    for (const o of b.v)
                    {
                        if (!o.k || !Array.isArray(o.v))
                            continue;

                        if (o.k === 'default')
                            fallback = scalar(field(o.v, 'torso'));
                        else
                            options.push({ name: o.k, torso: scalar(field(kids(field(o.v, 'animation')), 'torso')), weight: kids(field(o.v, 'weight')) });
                    }

                    kinds.set(kind, { options, fallback });
                }

                out.push({ name: g.k, kinds, consts });
            }
        }

        return (this.animGroups = out);
    }

    /**
     * The torso animation state of a creature portrait: the first portrait animation group with options the creature
     * entity has a state for, its option chosen like a modifier (weight ≥ 100 wins, else weighted random, else the
     * default). Human portraits keep their idle pose — their animations are not evaluated.
     */
    creatureState(root: CharacterFacts, kind: string, known: (state: string) => boolean, seed: string, rng: (seed: string) => () => number, run: ScriptRun = freshRun()): string | undefined
    {
        for (const g of this.animationGroups())
        {
            const k = g.kinds.get(kind);

            if (!k || !(k.fallback && known(k.fallback)) && !k.options.some((o) => o.torso && known(o.torso)))
                continue;

            const ctx: EvalCtx = { root, genes: { genes: new Map(), extra: [] }, consts: g.consts, cache: new Map(), depth: 0, run };
            const weights = k.options.filter((o) => o.torso && known(o.torso)).map((o) => ({ o, w: this.weight({ name: o.name, dna: [], weight: o.weight }, ctx) }));
            let pick = weights.find((x) => x.w >= 100)?.o;

            if (!pick)
            {
                const positive = weights.filter((x) => x.w > 0);
                let r = rng(seed + ':' + g.name)() * positive.reduce((s, x) => s + x.w, 0);
                pick = positive.find((x) => (r -= x.w) <= 0)?.o ?? positive[positive.length - 1]?.o;
            }

            const state = pick?.torso ?? k.fallback;

            if (state && known(state))
                return state;
        }

        return undefined;
    }

    private applyDna(m: ModDef, state: GeneState, rand: () => number, ctx: EvalCtx): void
    {
        for (const c of m.dna)
        {
            if (!Array.isArray(c.v))
                continue;

            const gene = scalar(field(c.v, 'gene'));

            if (!gene)
                continue;

            const mode = scalar(field(c.v, 'mode')) ?? 'add';
            const template = scalar(field(c.v, 'template'));
            const range = kids(field(c.v, 'range')).map((x) => parseFloat(String(x.v)));
            // value: number, script value block (e.g. muscularity from prowess), a named script value or `@constant`,
            // `range = { a b }` or random
            const valueNode = field(c.v, 'value');
            const named = typeof valueNode?.v === 'string' && !/^-?[\d.]+$/.test(valueNode.v) ? valueNode.v : undefined;
            const value = Array.isArray(valueNode?.v)
                ? this.eval.scriptValue(valueNode.v, { t: 'char', f: ctx.root }, ctx)
                : named
                ? this.eval.namedValue(named, { t: 'char', f: ctx.root }, ctx)
                : valueNode
                ? parseFloat(String(valueNode.v)) || 0
                : range.length >= 2
                ? range[0] + rand() * (range[1] - range[0])
                : rand();
            const cur = state.genes.get(gene);

            if (c.k === 'accessory')
            {
                if (mode === 'modify' || mode === 'modify_multiply')
                {
                    if (cur && (!template || cur.template === template))
                        cur.value = mode === 'modify' ? cur.value + value : cur.value * value;
                }
                else
                    state.genes.set(gene, { template, value, accessory: scalar(field(c.v, 'accessory')) });
            }
            else if (c.k === 'morph')
            {
                // `add` stacks an extra gene; the same template again (e.g. a DNA dump that already contains the special
                // genes) replaces instead of doubling
                if (mode === 'replace' || (mode === 'add' && (!cur || cur.template === template)))
                    state.genes.set(gene, { template, value });
                else if (mode === 'add')
                    state.extra.push({ gene, g: { template, value } });
                else if (cur && (!template || cur.template === template))
                    cur.value = mode === 'modify' ? cur.value + value : cur.value * value;
            }
            else if (c.k === 'color')
            {
                const x = parseFloat(scalar(field(c.v, 'x')) ?? '0') || 0;
                const y = parseFloat(scalar(field(c.v, 'y')) ?? '0') || 0;

                if (mode === 'replace')
                    state.genes.set(gene, { value: 0, xy: [x, y] });
                else if (cur?.xy)
                    cur.xy = [cur.xy[0] + x, cur.xy[1] + y];
            }
        }
    }
}
