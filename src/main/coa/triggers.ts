/**
 * The conditions around coats of arms (docs/map.md, "Coats of arms") evaluated with history at a date (facts.ts):
 * dynamic definitions (root: the title), special selections of the template lists (root: the holder, scope:culture,
 * scope:faith, scope:title), the limits of game start effects (start.ts). Scripted triggers are followed with their
 * $PARAM$s, game rules are at their defaults, DLC features owned. What history cannot tell — flags, variables,
 * claims, modifiers, regions — is false (so `has_character_flag = x` fails and `… = no` holds).
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import type { PNode } from '../indexer/parser.ts';
import { DATE_KEY, dateNum } from '../map/history.ts';
import { tierOf, type CoaFacts } from './facts.ts';

export type Scope =
    | { t: 'none'; }
    | { t: 'char'; id: string; }
    | { t: 'title'; key: string; }
    | { t: 'culture' | 'faith' | 'religion' | 'dynasty' | 'house'; key: string; }
    | { t: 'province'; id: number; };

export interface TriggerCtx
{
    /** the date (dateNum): the game starts then */
    when: number;
    root: Scope;
    /** `scope:x`: saved scopes (save_temporary_scope_as, the special selections' culture, faith and title) */
    saved: Map<string, Scope>;
    /** scripted trigger results of this evaluation */
    cache: Map<string, boolean>;
    depth: number;
}

const TIER_NAMES: Record<string, number> = { tier_barony: 1, tier_county: 2, tier_duchy: 3, tier_kingdom: 4, tier_empire: 5, tier_hegemony: 6 };
/** `x:key` scopes by prefix */
const PREFIXED: Record<string, 'title' | 'culture' | 'faith' | 'religion' | 'dynasty' | 'house' | 'char'> = {
    title: 'title',
    culture: 'culture',
    faith: 'faith',
    religion: 'religion',
    dynasty: 'dynasty',
    house: 'house',
    character: 'char'
};
/** scope links followed from a scope (see step) */
const STEPS = new Set(['root', 'this', 'prev', 'holder', 'culture', 'faith', 'religion', 'dynasty', 'house', 'primary_title', 'liege', 'top_liege', 'de_jure_liege', 'empire', 'kingdom', 'duchy', 'county', 'title_province']);
const LOGIC_SKIP = new Set(['text', 'desc', 'subject', 'object', 'value', 'count', 'percent', 'limit']);

const kids = (n: PNode | undefined): PNode[] => (n && Array.isArray(n.v) ? n.v : []);

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

const same = (a: Scope | undefined, b: Scope | undefined): boolean =>
{
    if (!a || !b || a.t !== b.t)
        return false;

    if (a.t === 'none')
        return true;

    if (a.t === 'char')
        return a.id === (b as { id: string; }).id;

    if (a.t === 'province')
        return a.id === (b as { id: number; }).id;

    return a.key === (b as { key: string; }).key;
};
const keyOf = (s: Scope): string => (s.t === 'none' ? 'none' : s.t === 'char' || s.t === 'province' ? `${s.t}:${s.id}` : `${s.t}:${s.key}`);

export class CoaTriggers
{
    private idx: GameIndex;
    private facts: CoaFacts;

    constructor(idx: GameIndex, facts: CoaFacts)
    {
        this.idx = idx;
        this.facts = facts;
    }

    /** A context for an evaluation at a date. */
    ctx(when: number, root: Scope, saved: [string, Scope][] = []): TriggerCtx
    {
        return { when, root, saved: new Map(saved), cache: new Map(), depth: 0 };
    }

    /** All of a block's triggers hold (trigger_if / trigger_else_if / trigger_else chains included). */
    holds(list: PNode[], scope: Scope, ctx: TriggerCtx): boolean
    {
        return this.chain(list, scope, ctx, true);
    }

    /** all (AND) or any (OR) of a block; a trigger_if chain whose limits all fail counts as neither */
    private chain(list: PNode[], scope: Scope, ctx: TriggerCtx, all: boolean): boolean
    {
        let done = true;

        for (const n of list)
        {
            if (!n.k || LOGIC_SKIP.has(n.k))
                continue;

            let ok: boolean;

            if (n.k === 'trigger_if' || n.k === 'trigger_else_if' || n.k === 'trigger_else')
            {
                if (n.k === 'trigger_if')
                    done = false;
                else if (done)
                    continue;

                const limit = kids(n).find((c) => c.k === 'limit');

                if (n.k !== 'trigger_else' && limit && !this.holds(kids(limit), scope, ctx))
                    continue;

                done = true;
                ok = this.holds(kids(n), scope, ctx);
            }
            else
            {
                done = true;
                ok = this.node(n, scope, ctx);
            }

            if (ok !== all)
                return !all;
        }

        return all;
    }

    /** A scope path: `holder.culture`, `scope:faith.religion`, `title:k_denmark.holder`, `root` … (undefined: none). */
    resolve(path: string, scope: Scope, ctx: TriggerCtx): Scope | undefined
    {
        let cur: Scope | undefined = scope;

        for (const p of path.split('.'))
        {
            if (!cur)
                return undefined;

            cur = this.step(p, cur, ctx);
        }

        return cur;
    }

    /** Whether a key is a scope path (then `key = { … }` changes scope and `key = x` compares scopes). */
    private isPath(k: string): boolean
    {
        return k.split('.').every((p) => STEPS.has(p) || /^(ROOT|THIS|PREV)$/.test(p) || (p.includes(':') && (p.startsWith('scope:') || Object.hasOwn(PREFIXED, p.slice(0, p.indexOf(':'))))));
    }

    private step(p: string, s: Scope, ctx: TriggerCtx): Scope | undefined
    {
        const colon = p.indexOf(':');

        if (colon > 0)
        {
            const kind = p.slice(0, colon);
            const name = p.slice(colon + 1);

            if (kind === 'scope')
                return ctx.saved.get(name);

            const t = Object.hasOwn(PREFIXED, kind) ? PREFIXED[kind] : undefined;

            if (t === 'char')
                return this.idx.get('characters', name) ? { t: 'char', id: name } : undefined;

            if (t === 'title')
                return this.facts.isTitle(name) ? { t: 'title', key: name } : undefined;

            return t ? { t, key: name } : undefined;
        }

        if (/^(this|prev)$/i.test(p))
            return s;

        if (/^root$/i.test(p))
            return ctx.root;

        const f = this.facts;
        const when = ctx.when;

        if (s.t === 'title')
        {
            if (p === 'holder')
            {
                const h = f.holder(s.key, when);
                return h ? { t: 'char', id: h } : undefined;
            }

            if (p === 'title_province')
            {
                const id = f.titleProvince(s.key);
                return id === undefined ? undefined : { t: 'province', id };
            }

            if (p === 'de_jure_liege')
            {
                const up = f.dejureUp(s.key)[1];
                return up ? { t: 'title', key: up } : undefined;
            }

            const tier = { county: 2, duchy: 3, kingdom: 4, empire: 5 }[p];
            const at = tier ? f.dejureUp(s.key).find((t) => tierOf(t) === tier) : undefined;
            return at ? { t: 'title', key: at } : undefined;
        }

        if (s.t === 'faith' && p === 'religion')
        {
            const r = f.faith(s.key)?.religion;
            return r ? { t: 'religion', key: r } : undefined;
        }

        if (s.t === 'house' && p === 'dynasty')
        {
            const d = f.houseDynasty(s.key);
            return d ? { t: 'dynasty', key: d } : undefined;
        }

        if (s.t !== 'char')
            return undefined;

        const who = f.person(s.id, when);

        switch (p)
        {
            case 'culture':
                return who?.culture ? { t: 'culture', key: who.culture } : undefined;
            case 'faith':
                return who?.faith ? { t: 'faith', key: who.faith } : undefined;
            case 'religion':
            {
                const r = who?.faith ? f.faith(who.faith)?.religion : undefined;
                return r ? { t: 'religion', key: r } : undefined;
            }
            case 'dynasty':
                return who?.dynasty ? { t: 'dynasty', key: who.dynasty } : undefined;
            case 'house':
                return who?.house ? { t: 'house', key: who.house } : undefined;
            case 'primary_title':
            {
                const t = f.primaryTitle(s.id, when);
                return t ? { t: 'title', key: t } : undefined;
            }
            case 'liege':
            {
                const l = f.liege(s.id, when);
                return l ? { t: 'char', id: l } : undefined;
            }
            case 'top_liege':
                return { t: 'char', id: f.topLiege(s.id, when) };
        }

        return undefined;
    }

    /** Numbers: a title's tier, a character's age and highest tier, the game's start date (dateNum). */
    private value(k: string, s: Scope, ctx: TriggerCtx): number | undefined
    {
        if (k === 'game_start_date' || k === 'current_date')
            return ctx.when;

        if (k === 'current_year')
            return Math.floor(ctx.when / 10000);

        if (k.includes('.'))
        {
            const dot = k.lastIndexOf('.');
            const on = this.resolve(k.slice(0, dot), s, ctx);
            return on ? this.value(k.slice(dot + 1), on, ctx) : undefined;
        }

        if (s.t === 'title' && k === 'tier')
            return tierOf(s.key);

        if (s.t !== 'char')
            return undefined;

        if (k === 'age')
            return this.facts.person(s.id, ctx.when)?.age;

        if (k === 'highest_held_title_tier')
            return tierOf(this.facts.primaryTitle(s.id, ctx.when) ?? '');

        return undefined;
    }

    private num(v: string): number | undefined
    {
        if (TIER_NAMES[v] !== undefined)
            return TIER_NAMES[v];

        if (DATE_KEY.test(v))
            return dateNum(v);

        return /^-?[\d.]+$/.test(v) ? Number(v) : undefined;
    }

    private node(n: PNode, s: Scope, ctx: TriggerCtx): boolean
    {
        const k = n.k!;
        const v = typeof n.v === 'string' ? n.v : undefined;
        const block = Array.isArray(n.v) ? n.v : undefined;
        const op = n.op === '?=' ? '=' : (n.op ?? '=');

        switch (k)
        {
            case 'AND':
                return this.holds(block ?? [], s, ctx);
            case 'OR':
                return this.chain(block ?? [], s, ctx, false);
            case 'NOT':
            case 'NAND':
                return !this.holds(block ?? [], s, ctx);
            case 'NOR':
                return !this.chain(block ?? [], s, ctx, false);
            case 'calc_true_if':
            {
                const amount = Number(kids(n).find((c) => c.k === 'amount')?.v) || 1;
                return (block ?? []).filter((c) => c.k && !LOGIC_SKIP.has(c.k) && c.k !== 'amount' && this.node(c, s, ctx)).length >= amount;
            }
            case 'always':
                return v === 'yes';
            case 'custom_tooltip':
            case 'custom_description':
                return block ? this.holds(block, s, ctx) : true;
            case 'save_temporary_scope_as':
            case 'save_scope_as':
                if (v)
                    ctx.saved.set(v, s);

                return true;
            case 'exists':
                return !!v && !!this.resolve(v, s, ctx);
            case 'has_dlc_feature':
            case 'has_dlc':
                return true;
            case 'has_game_rule':
                return !!v && this.facts.gameRuleDefault(v);
        }

        // scripted triggers: `name = yes|no` or `name = { PARAM = value }`
        const st = this.idx.get('scripted_triggers', k);

        if (st && this.idx.winningDef(st))
        {
            if (ctx.depth > 30)
                return false;

            const params: Record<string, string> = {};

            for (const c of block ?? [])
                if (c.k && typeof c.v === 'string')
                    params[c.k] = c.v;

            const key = `${keyOf(s)}|${k}|${JSON.stringify(params)}`;
            let res = ctx.cache.get(key);

            if (res === undefined)
            {
                ctx.depth++;
                res = this.holds(kids(this.idx.defNode(st, block ? params : undefined)?.node), s, ctx);
                ctx.depth--;
                ctx.cache.set(key, res);
            }

            return v === 'no' ? !res : res;
        }

        if (block)
        {
            // a scope change (`holder = { … }`, `scope:title ?= { … }`) or an iterator
            if (this.isPath(k))
            {
                const to = this.resolve(k, s, ctx);
                return !!to && this.holds(block, to, ctx);
            }

            return this.iterate(k, block, s, ctx);
        }

        if (v === undefined)
            return false;

        // numbers, tiers and dates: `tier > tier_county`, `game_start_date <= 1000.1.1`, `age >= 16` (unknown: false)
        const rhs = this.num(v);

        if (rhs !== undefined || (op !== '=' && op !== '!='))
        {
            const lhs = this.value(k, s, ctx);
            return lhs !== undefined && rhs !== undefined ? compare(lhs, op, rhs) : op === '!=';
        }

        // scopes compared: `holder = title:k_denmark.holder`, `scope:religion = religion:x`, `this = title:k_france`
        if (this.isPath(k) && (this.isPath(v) || v.includes(':')))
        {
            const eq = same(this.resolve(k, s, ctx), this.resolve(v, s, ctx));
            return op === '!=' ? !eq : eq;
        }

        return this.leaf(k, v, s, ctx);
    }

    /** `any_*` iterators the arms' conditions use; others are false. */
    private iterate(k: string, block: PNode[], s: Scope, ctx: TriggerCtx): boolean
    {
        const f = this.facts;
        let over: Scope[] | undefined;

        if (k === 'any_this_title_or_de_jure_above' && s.t === 'title')
            over = f.dejureUp(s.key).map((key) => ({ t: 'title', key }));
        else if (k === 'any_de_jure_liege_or_above' && s.t === 'title')
            over = f.dejureUp(s.key)
                .slice(1)
                .map((key) => ({ t: 'title', key }));
        else if (k === 'any_held_title' && s.t === 'char')
            over = f.held(s.id, ctx.when).map((key) => ({ t: 'title', key }));
        else if (k === 'any_liege_or_above' && s.t === 'char')
        {
            over = [];
            const seen = new Set([s.id]);

            for (let l = f.liege(s.id, ctx.when); l && !seen.has(l); l = f.liege(l, ctx.when))
            {
                seen.add(l);
                over.push({ t: 'char', id: l });
            }
        }

        return !!over?.some((x) => this.holds(block, x, ctx));
    }

    private leaf(k: string, v: string, s: Scope, ctx: TriggerCtx): boolean
    {
        const f = this.facts;
        const yes = v !== 'no';
        const is = (x: boolean): boolean => x === yes;
        const when = ctx.when;

        if (s.t === 'culture')
        {
            const c = f.culture(s.key);

            if (/^has_(coa|building|clothing|unit)_gfx$/.test(k))
                return !!c?.gfx.has(v);

            if (k === 'has_cultural_pillar')
                return !!c?.pillars.has(v);

            if (k === 'has_cultural_tradition')
                return !!c?.traditions.has(v);
        }
        else if (s.t === 'faith')
        {
            const x = f.faith(s.key);

            if (k === 'has_doctrine')
                return !!x?.doctrines.has(v);

            if (k === 'has_icon')
                return x?.icon === v;

            if (k === 'religion_tag')
                return x?.religion === v;
        }
        else if (s.t === 'religion')
        {
            if (k === 'is_in_family')
                return f.religionFamily(s.key) === v;
        }
        else if (s.t === 'province')
        {
            if (k === 'has_holding_type')
                return f.holding(s.id, when) === v;
        }
        else if (s.t === 'title')
        {
            switch (k)
            {
                case 'is_holy_order':
                case 'is_mercenary_company':
                    // (created in play, not by history)
                    return is(false);
                case 'is_head_of_faith':
                    return is(f.isHeadOfFaith(s.key));
                case 'is_noble_family_title':
                    return is(f.titleField(s.key, 'noble_family') === 'yes');
                case 'is_landless_type_title':
                    return is(f.titleField(s.key, 'landless') === 'yes');
                case 'has_holder':
                    return is(!!f.holder(s.key, when));
            }
        }
        else if (s.t === 'char')
        {
            const who = f.person(s.id, when);
            const government = (): string | undefined => f.government(s.id, when);
            const landed = (): boolean => f.held(s.id, when).length > 0;

            switch (k)
            {
                case 'is_ruler':
                case 'is_landed':
                case 'is_playable_character':
                    return is(landed());
                case 'is_independent_ruler':
                    return is(landed() && !f.liege(s.id, when));
                case 'is_lowborn':
                    return is(!who?.dynasty);
                case 'is_alive':
                    return is(!!who?.alive);
                case 'is_adult':
                    return is((who?.age ?? 0) >= 16);
                case 'has_trait':
                    return !!who?.traits.has(v);
                case 'has_government':
                    return government() === v;
                case 'government_has_flag':
                    return !!f.governmentInfo(government())?.flags.has(v);
                case 'government_allows':
                    return !!f.governmentInfo(government())?.rules.has(v);
                case 'has_title':
                    return f.held(s.id, when).includes(v.replace(/^title:/, ''));
                case 'has_culture':
                    return !!who?.culture && 'culture:' + who.culture === v;
                case 'has_faith':
                    return !!who?.faith && 'faith:' + who.faith === v;
                case 'has_religion':
                    return !!who?.faith && 'religion:' + f.faith(who.faith)?.religion === v;
            }
        }

        // flags, variables, claims, modifiers, laws, regions …: unknown — false (`… = no` holds)
        return v === 'no';
    }
}
