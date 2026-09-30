/**
 * The script state the game's start sets up (docs/portraits.md, "Game-start state"). The effects of `on_game_start`
 * and `on_game_start_after_lobby` run — an on_action's `effect`, then its `events` (their `immediate`, when their
 * `trigger` holds), then its `on_actions`; events sent with `trigger_event`; scripted effects with their $PARAM$s —
 * as far as they set up state: global variables and variable lists, variables and variable lists of characters,
 * titles and stories (`create_story` runs its story cycle's `on_setup`; `create_character` its `after_creation`, the
 * new character a blank one), local variables and saved scopes, with `if` / `else_if` / `else`, `while`, `switch`,
 * `random_list` (the most likely entry), `random` (when its chance is at least 50) and iterators over variable lists.
 * Characters are the history's at the date asked for (`character:x.age` is their age then). Effects that change the
 * world itself (titles, traits, wars …) and iterators over it (every_ruler …) are not modelled: skipped. Triggers
 * and values go through the portrait evaluator (modifiers.ts).
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import type { PNode } from '../indexer/parser.ts';
import { T_EVENT, T_ON_ACTION, T_SCRIPTED_EFFECT } from '../indexer/schema.ts';
import { field, kids, scalar } from './assets.ts';
import { emptyState, varKey, type CharacterFacts, type Scope, type ScriptRun, type ScriptState, type TriggerEvaluator, type VarValue } from './modifiers.ts';

/** statements run at most (a guard against runaway loops and expansion) */
const BUDGET = 1_000_000;
/** iterations of one `while` at most (the engine's own limit is 1000) */
const MAX_LOOP = 1000;
/** blocks that run their statements in the same scope */
const SAME = new Set(['hidden_effect', 'custom_tooltip', 'custom_description', 'custom_description_no_bullet', 'custom_label']);
/** keys inside such blocks that are not statements */
const TEXT_KEYS = new Set(['text', 'subject', 'object', 'value', 'desc']);
/** states kept (by date) */
const CACHE = 6;

/** One run of effects: its root, and the saved scopes and local variables of that execution. */
interface Frame
{
    root: Scope;
    run: ScriptRun;
}

export class GameStart
{
    private idx: GameIndex;
    private ev: TriggerEvaluator;
    private states = new Map<number, ScriptState>();
    /** definitions' statements (with a scripted effect's arguments substituted), by kind, name and arguments */
    private parsed = new Map<string, PNode[][]>();

    constructor(idx: GameIndex, ev: TriggerEvaluator)
    {
        this.idx = idx;
        this.ev = ev;
    }

    /** The state after the game's start at a date (the history's characters then), cached for a few dates. */
    stateAt(date: number): ScriptState
    {
        const hit = this.states.get(date);

        if (hit)
            return hit;

        const state = new Runner(this.idx, this.ev, date, this.parsed).start();
        this.states.set(date, state);

        if (this.states.size > CACHE)
            this.states.delete(this.states.keys().next().value!);

        return state;
    }
}

class Runner
{
    private idx: GameIndex;
    private ev: TriggerEvaluator;
    private parsed: Map<string, PNode[][]>;
    private state = emptyState();
    /** the empty root of on_game_start, as facts for the evaluator (no character: `root` is the empty scope) */
    private nobody: CharacterFacts;
    private budget = BUDGET;
    private made = 0;
    /** scripted effects being run (with their arguments): a loop guard */
    private active = new Set<string>();

    constructor(idx: GameIndex, ev: TriggerEvaluator, date: number, parsed: Map<string, PNode[][]>)
    {
        this.idx = idx;
        this.ev = ev;
        this.parsed = parsed;
        this.nobody = { id: '', historical: false, female: false, date, age: 0, traits: new Set(), titles: [], spouses: [], prowess: 0 };
    }

    start(): ScriptState
    {
        for (const oa of ['on_game_start', 'on_game_start_after_lobby'])
            this.onAction(oa, { t: 'none' });

        return this.state;
    }

    /** The statements of a definition's (visible) definitions, parsed once (`params`: a scripted effect's arguments). */
    private bodiesOf(type: string, name: string, params?: Record<string, string>): PNode[][]
    {
        const key = type + ':' + name + (params ? JSON.stringify(params) : '');
        let hit = this.parsed.get(key);

        if (!hit)
        {
            const e = this.idx.get(type, name);
            hit = e ? e.defs.flatMap((d, i) => (this.idx.isHiddenDef(d) ? [] : [kids(this.idx.defNode(e, params, i)?.node)])) : [];

            // (scripted effects, events, story cycles: the winning definition only)
            if (type !== T_ON_ACTION)
                hit = e ? [kids(this.idx.defNode(e, params)?.node)] : [];

            this.parsed.set(key, hit);
        }

        return hit;
    }

    private frame(root: Scope): Frame
    {
        return { root, run: { state: () => this.state, saved: new Map(), locals: new Map() } };
    }

    /** The evaluator's context in a frame (a fresh trigger cache: variables change between evaluations). */
    private ctx(f: Frame): Parameters<TriggerEvaluator['block']>[2]
    {
        const root = f.root.t === 'char' ? f.root.f : this.nobody;
        return { root, genes: { genes: new Map(), extra: [] }, consts: new Map(), cache: new Map(), depth: 0, run: f.run };
    }

    private holds(list: PNode[] | undefined, scope: Scope, f: Frame): boolean
    {
        return !list || this.ev.block(list, scope, this.ctx(f));
    }

    private number(v: PNode['v'] | undefined, scope: Scope, f: Frame): number
    {
        if (v === undefined)
            return 0;

        if (Array.isArray(v))
            return this.ev.scriptValue(v, scope, this.ctx(f));

        if (v === 'yes')
            return 1;

        if (v === 'no')
            return 0;

        return this.ev.namedValue(v, scope, this.ctx(f));
    }

    /** What `value = …` writes: a scope when it names one, else a number. */
    private value(v: PNode['v'] | undefined, scope: Scope, f: Frame): VarValue
    {
        if (typeof v === 'string' && !/^-?[\d.]+$/.test(v) && v !== 'yes' && v !== 'no')
        {
            const s = this.ev.scopeOf(v, scope, this.ctx(f));

            if (s && s.t !== 'value')
                return s;
        }

        return this.number(v, scope, f);
    }

    /** The variables of a scope (made when missing). */
    private vars(scope: Scope): Map<string, VarValue> | undefined
    {
        const k = varKey(scope);

        if (!k)
            return undefined;

        let m = this.state.vars.get(k);

        if (!m)
            this.state.vars.set(k, m = new Map());

        return m;
    }

    private lists(scope: Scope): Map<string, Scope[]> | undefined
    {
        const k = varKey(scope);

        if (!k)
            return undefined;

        let m = this.state.lists.get(k);

        if (!m)
            this.state.lists.set(k, m = new Map());

        return m;
    }

    // ---------------------------------------------------------------------------------------------------------------
    // on_actions, events

    private onAction(name: string, root: Scope): void
    {
        if (this.active.has('oa:' + name))
            return;

        // (the lists of an on_action's definitions merge; the effect runs first, then the events, then the on_actions)
        const bodies = this.bodiesOf(T_ON_ACTION, name);

        if (!bodies.length)
            return;

        this.active.add('oa:' + name);
        const f0 = this.frame(root);

        if (bodies.every((b) => this.holds(kids(field(b, 'trigger')), root, f0)))
        {
            for (const b of bodies)
                for (const c of b)
                    if (c.k === 'effect')
                        this.exec(kids(c), root, this.frame(root));

            for (const b of bodies)
                for (const c of b)
                    if (c.k === 'events')
                    {
                        for (const id of kids(c))
                            if (id.k === null && typeof id.v === 'string')
                                this.event(id.v, root);
                    }

            for (const b of bodies)
                for (const c of b)
                    if (c.k === 'on_actions')
                    {
                        for (const id of kids(c))
                            if (id.k === null && typeof id.v === 'string')
                                this.onAction(id.v, root);
                    }
        }

        this.active.delete('oa:' + name);
    }

    private event(id: string, root: Scope): void
    {
        const body = this.bodiesOf(T_EVENT, id)[0] ?? [];
        const key = 'ev:' + id + ':' + (varKey(root) ?? root.t);

        if (!body.length || this.active.has(key))
            return;

        this.active.add(key);
        const f = this.frame(root);

        if (this.holds(kids(field(body, 'trigger')), root, f))
            this.exec(kids(field(body, 'immediate')), root, f);

        this.active.delete(key);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // effects

    private exec(list: PNode[], scope: Scope, f: Frame): void
    {
        let chainDone = true;

        for (const c of list)
        {
            if (!c.k || --this.budget < 0)
                continue;

            const k = c.k;
            const block = Array.isArray(c.v) ? c.v : undefined;
            const v = typeof c.v === 'string' ? c.v : undefined;

            if (k === 'if' || k === 'else_if' || k === 'else')
            {
                if (k === 'if')
                    chainDone = false;
                else if (chainDone)
                    continue;

                if (k !== 'else' && !this.holds(kids(field(block ?? [], 'limit')), scope, f))
                    continue;

                chainDone = true;
                this.exec((block ?? []).filter((x) => x.k !== 'limit'), scope, f);
                continue;
            }

            chainDone = true;

            if (block && SAME.has(k))
            {
                this.exec(block.filter((x) => !TEXT_KEYS.has(x.k ?? '')), scope, f);
                continue;
            }

            if (this.statement(k, c, block, v, scope, f))
                continue;

            // scripted effects: `name = yes`, `name = { PARAM = value }`
            const se = this.idx.get(T_SCRIPTED_EFFECT, k);

            if (se && (v === 'yes' || block))
            {
                const params: Record<string, string> = {};

                for (const x of block ?? [])
                    if (x.k && typeof x.v === 'string')
                        params[x.k] = x.v;

                const key = 'se:' + k + JSON.stringify(params);

                if (this.active.has(key) || this.active.size > 60)
                    continue;

                this.active.add(key);
                this.exec(this.bodiesOf(T_SCRIPTED_EFFECT, k, block ? params : undefined)[0] ?? [], scope, f);
                this.active.delete(key);
                continue;
            }

            // a scope switch: `character:x = { … }`, `scope:x = { … }`, `title:x.holder = { … }`, `var:x = { … }`
            if (block)
            {
                const to = this.ev.scopeOf(k, scope, this.ctx(f));

                if (to && to.t !== 'value' && to.t !== 'none')
                    this.exec(block, to, f);
            }
        }
    }

    /** The statements modelled; false: not one of them. */
    private statement(k: string, c: PNode, block: PNode[] | undefined, v: string | undefined, scope: Scope, f: Frame): boolean
    {
        const name = (): string | undefined => v ?? scalar(field(block ?? [], 'name'));
        const target = (): Scope | undefined => this.ev.scopeOf(scalar(field(block ?? [], 'target')) ?? '', scope, this.ctx(f));

        switch (k)
        {
            case 'while':
            {
                const body = (block ?? []).filter((x) => x.k !== 'limit' && x.k !== 'count');
                const limit = field(block ?? [], 'limit');
                const count = field(block ?? [], 'count');
                const times = count ? Math.min(MAX_LOOP, Math.floor(this.number(count.v, scope, f))) : MAX_LOOP;

                for (let i = 0; i < times && this.budget > 0; i++)
                {
                    if (limit && !this.holds(kids(limit), scope, f))
                        break;

                    if (!limit && !count)
                        break;

                    this.exec(body, scope, f);
                }

                return true;
            }
            case 'random_list':
            {
                // (the most likely entry: the biggest base weight)
                let best: PNode | undefined;
                let most = -Infinity;

                for (const x of block ?? [])
                {
                    const w = x.k && /^-?[\d.]+$/.test(x.k) ? parseFloat(x.k) : x.k ? this.number(x.k, scope, f) : NaN;

                    if (Array.isArray(x.v) && w > most)
                    {
                        best = x;
                        most = w;
                    }
                }

                if (best)
                    this.exec(kids(best).filter((x) => x.k !== 'modifier' && x.k !== 'trigger' && x.k !== 'show_chance' && x.k !== 'desc'), scope, f);

                return true;
            }
            case 'random':
                if (this.number(field(block ?? [], 'chance')?.v, scope, f) >= 50)
                    this.exec((block ?? []).filter((x) => x.k !== 'chance' && x.k !== 'modifier'), scope, f);

                return true;
            case 'switch':
            {
                const on = scalar(field(block ?? [], 'trigger'));

                if (!on)
                    return true;

                for (const x of block ?? [])
                {
                    if (!x.k || x.k === 'trigger' || !Array.isArray(x.v))
                        continue;

                    const test: PNode = { ...x, k: on, op: '=', v: x.k };

                    if (x.k === 'fallback' || this.ev.node(test, scope, this.ctx(f)))
                    {
                        this.exec(x.v, scope, f);
                        break;
                    }
                }

                return true;
            }
            case 'show_as_tooltip':
                return true;
            case 'save_scope_as':
            case 'save_temporary_scope_as':
                if (v)
                    f.run.saved.set(v, scope);

                return true;
            case 'save_scope_value_as':
            case 'save_temporary_scope_value_as':
            {
                const n = name();

                if (n)
                {
                    const x = this.value(field(block ?? [], 'value')?.v, scope, f);
                    f.run.saved.set(n, typeof x === 'number' ? { t: 'value', v: x } : x);
                }

                return true;
            }
            case 'set_variable':
            case 'set_local_variable':
            case 'set_global_variable':
            {
                const n = name();
                const vars = k === 'set_variable' ? this.vars(scope) : k === 'set_local_variable' ? f.run.locals : this.state.globals;

                if (n && vars)
                    vars.set(n, block ? this.value(field(block, 'value')?.v ?? 'yes', scope, f) : 1);

                return true;
            }
            case 'change_variable':
            case 'change_local_variable':
            case 'change_global_variable':
            case 'clamp_variable':
            case 'clamp_local_variable':
            case 'clamp_global_variable':
            case 'round_variable':
            case 'round_local_variable':
            case 'round_global_variable':
            {
                const n = name();
                const vars = /_local_/.test(k) ? f.run.locals : /_global_/.test(k) ? this.state.globals : this.vars(scope);

                if (!n || !vars)
                    return true;

                const cur = vars.get(n);
                let x = typeof cur === 'number' ? cur : 0;

                for (const o of block ?? [])
                {
                    const by = (): number => this.number(o.v, scope, f);

                    switch (o.k)
                    {
                        case 'add':
                            x += by();
                            break;
                        case 'subtract':
                            x -= by();
                            break;
                        case 'multiply':
                            x *= by();
                            break;
                        case 'divide':
                        {
                            const d = by();
                            x = d ? x / d : x;
                            break;
                        }
                        case 'modulo':
                        {
                            const d = by();
                            x = d ? x % d : x;
                            break;
                        }
                        case 'min':
                            x = Math.max(x, by());
                            break;
                        case 'max':
                            x = Math.min(x, by());
                            break;
                        case 'nearest':
                        {
                            const d = by();
                            x = d ? Math.round(x / d) * d : x;
                            break;
                        }
                    }
                }

                vars.set(n, x);
                return true;
            }
            case 'remove_variable':
            case 'remove_local_variable':
            case 'remove_global_variable':
            {
                const n = name();
                const vars = k === 'remove_variable' ? this.vars(scope) : k === 'remove_local_variable' ? f.run.locals : this.state.globals;

                if (n)
                    vars?.delete(n);

                return true;
            }
            case 'add_to_variable_list':
            case 'add_to_global_variable_list':
            case 'add_to_temporary_list':
            case 'add_to_list':
            case 'add_to_local_variable_list':
            {
                // (lists of saved scopes — add_to_list, add_to_temporary_list — are not kept; local lists live with the scope's)
                if (k === 'add_to_list' || k === 'add_to_temporary_list')
                    return true;

                const n = name();
                const t = target();
                const lists = k === 'add_to_global_variable_list' ? this.state.globalLists : this.lists(scope);

                if (n && t && lists)
                {
                    const list = lists.get(n) ?? [];

                    if (!list.some((x) => this.ev.sameScope(x, t)))
                        list.push(t);

                    lists.set(n, list);
                }

                return true;
            }
            case 'remove_list_variable':
            case 'remove_list_global_variable':
            {
                const n = name();
                const t = target();
                const lists = k === 'remove_list_global_variable' ? this.state.globalLists : this.lists(scope);
                const list = n ? lists?.get(n) : undefined;

                if (list && t)
                    lists!.set(n!, list.filter((x) => !this.ev.sameScope(x, t)));

                return true;
            }
            case 'clear_variable_list':
            case 'clear_global_variable_list':
            {
                const n = name();

                if (n)
                    (k === 'clear_global_variable_list' ? this.state.globalLists : this.lists(scope))?.delete(n);

                return true;
            }
            case 'every_in_list':
            case 'every_in_global_list':
            case 'random_in_list':
            case 'random_in_global_list':
            case 'ordered_in_list':
            case 'ordered_in_global_list':
            {
                const list = [...this.ev.listOf(scalar(field(block ?? [], 'variable')), scope, this.ctx(f), k.includes('global'))];
                const limit = field(block ?? [], 'limit');
                const body = (block ?? []).filter((x) => !['variable', 'list', 'limit', 'order_by', 'position', 'min', 'max', 'check_range_bounds', 'weight'].includes(x.k ?? ''));

                for (const s of list)
                {
                    if (limit && !this.holds(kids(limit), s, f))
                        continue;

                    this.exec(body, s, f);

                    if (!k.startsWith('every_'))
                        break;
                }

                return true;
            }
            case 'create_story':
            {
                const type = v ?? scalar(field(block ?? [], 'type'));
                const story: Scope = { t: 'story', type: type ?? '', id: String(++this.made) };
                const setup = type ? field(this.bodiesOf('story_cycles', type)[0] ?? [], 'on_setup') : undefined;

                // (on_setup runs in the story, an execution of its own)
                if (setup)
                    this.exec(kids(setup), story, this.frame(f.root));

                for (const x of block ?? [])
                    if ((x.k === 'save_scope_as' || x.k === 'save_temporary_scope_as') && typeof x.v === 'string')
                        f.run.saved.set(x.v, story);

                return true;
            }
            case 'create_character':
            {
                const b = block ?? [];
                const age = Number(scalar(field(b, 'age')));
                const who: CharacterFacts = {
                    id: 'created:' + ++this.made,
                    historical: false,
                    female: scalar(field(b, 'gender')) === 'female',
                    date: this.nobody.date,
                    age: Number.isFinite(age) ? age : 25,
                    traits: new Set(b.filter((x) => x.k === 'trait' && typeof x.v === 'string').map((x) => x.v as string)),
                    titles: [],
                    spouses: [],
                    prowess: 5
                };
                const made: Scope = { t: 'char', f: who };

                for (const x of b)
                    if ((x.k === 'save_scope_as' || x.k === 'save_temporary_scope_as') && typeof x.v === 'string')
                        f.run.saved.set(x.v, made);

                this.exec(kids(field(b, 'after_creation')), made, f);
                return true;
            }
            case 'trigger_event':
            {
                const id = v ?? scalar(field(block ?? [], 'id'));
                const oa = scalar(field(block ?? [], 'on_action'));

                if (id)
                    this.event(id, scope);
                else if (oa)
                    this.onAction(oa, scope);

                return true;
            }
        }

        return false;
    }
}
