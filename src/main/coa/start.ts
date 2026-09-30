/**
 * Coats of arms script sets when the game starts (docs/map.md, "Coats of arms"). The effects of `on_game_start` and
 * `on_game_start_after_lobby` are walked — an on_action's `effect`, then its `events`, then its `on_actions`; events
 * sent with `trigger_event` (their `trigger` and `immediate`); scripted effects with their $PARAM$s; `if` / `else_if`
 * / `else`, character iterators (`every_ruler` …), title iterators and links (`every_held_title`, `primary_title`,
 * `every_noble_family`, `title:x`, `holder`) — for `set_coa` on a title. Each becomes a rule: which titles (a named
 * one, any a character holds, a character's primary title, noble family titles), the limits on the way (on the title,
 * on its holder, or on nothing: `game_start_date`), and the arms (an entry, the holder's house or dynasty, another
 * title's). AGOT: every ruler's held titles get `set_coa = holder.house` (events/agot_events/agot_coa_events.txt);
 * vanilla: `title:e_scandinavia = { set_coa = e_scandinavia_norse }` before 1000, noble families their holder's house.
 * Limits on characters that are not the title's holder (the ruler whose noble families are iterated) are not kept.
 * Also what the walk finds done to a named dynasty's renown (the cell of its frame): AGOT's starting levels.
 */
import type { GameIndex } from '../indexer/gameIndex.ts';
import type { PNode } from '../indexer/parser.ts';
import { T_EVENT, T_ON_ACTION, T_SCRIPTED_EFFECT } from '../indexer/schema.ts';

export interface StartRule
{
    /** which titles: a named one, any a character holds, a character's primary title, noble family titles */
    target: { how: 'key'; key: string; } | { how: 'held' | 'primary' | 'noble'; };
    /** limits on the way: on the title, on its holder, on nothing (`not`: an earlier branch of an if chain was not taken) */
    when: { on: 'title' | 'holder' | 'none'; list: PNode[]; not: boolean; }[];
    /** a coat_of_arms entry, the holder's house or dynasty arms, another title's arms */
    arms: { coa: string; } | { of: 'house' | 'dynasty'; } | { title: string; };
    /** where the `set_coa` is written: file:line */
    at: string;
}

/**
 * A named dynasty's renown set at game start (`dynasty:dynn_Targaryen = { … }`): renown added (`add_dynasty_prestige`),
 * levels added (`add_dynasty_prestige_level`), or its level brought up / down to a value (`while = { limit = {
 * dynasty_prestige_level < 8 } add_dynasty_prestige_level = 1 }` — AGOT's agot_set_dynasty_level_history_effect).
 */
export interface RenownStep
{
    dynasty: string;
    step: { add: number; } | { levels: number; } | { atLeast: number; } | { atMost: number; };
    /** limits on nothing (`current_date < 8001.6.1`) on the way */
    when: { list: PNode[]; not: boolean; }[];
}

/** A scope while walking: nothing, a character, a title (and the character holding it, when known), a named dynasty. */
interface Abs
{
    t: 'none' | 'char' | 'title' | 'dynasty';
    target?: StartRule['target'];
    /** a title's holder scope; a character that is a title's holder */
    holder?: Abs;
    holderOf?: Abs;
    dynasty?: string;
}

interface Cond
{
    on: Abs;
    list: PNode[];
    not: boolean;
}

/** character iterators (a new character in scope: the next title's holder) */
const CHARS = /^(every|random|ordered)_(ruler|independent_ruler|living_character|player|vassal|vassal_or_below|courtier|pool_character|close_family_member|child|house_member|dynasty_member)$/;
const HELD = /^(every|random|ordered)_held_title$/;
/** effects whose blocks run in the same scope */
const SAME = new Set(['hidden_effect', 'custom_tooltip', 'custom_description']);
/** walking stops after this many statements (a guard against runaway expansion) */
const BUDGET = 400_000;

const kids = (n: PNode | undefined): PNode[] => (n && Array.isArray(n.v) ? n.v : []);
const scalar = (list: PNode[], key: string): string | undefined =>
{
    const c = list.find((x) => x.k === key);
    return typeof c?.v === 'string' ? c.v : undefined;
};

export function readStart(idx: GameIndex): { arms: StartRule[]; renown: RenownStep[]; }
{
    const rules: StartRule[] = [];
    const renown: RenownStep[] = [];
    /** definitions being walked, and those whose walk set no arms or renown */
    const active = new Set<string>();
    const barren = new Set<string>();
    let budget = BUDGET;

    /** a number, or a script value that is one (`high_dynasty_prestige_level = 7`) */
    const num = (v: string | undefined): number | undefined =>
    {
        const e = v && !/^-?[\d.]+$/.test(v) ? idx.get('script_values', v) : undefined;
        const x = e ? idx.defNode(e)?.node.v : v;
        return typeof x === 'string' && /^-?[\d.]+$/.test(x) ? Number(x) : undefined;
    };

    /** a renown step in a named dynasty's scope (`while`: only the level-setting loop) */
    const renownOf = (c: PNode): RenownStep['step'] | undefined =>
    {
        const v = num(typeof c.v === 'string' ? c.v : undefined);

        if (c.k === 'add_dynasty_prestige' && v !== undefined)
            return { add: v };

        if (c.k === 'add_dynasty_prestige_level' && v !== undefined)
            return { levels: v };

        if (c.k !== 'while')
            return undefined;

        const test = kids(kids(c).find((x) => x.k === 'limit')).find((x) => x.k === 'dynasty_prestige_level');
        const by = num(scalar(kids(c), 'add_dynasty_prestige_level'));
        const to = num(typeof test?.v === 'string' ? test.v : undefined);

        if (to === undefined)
            return undefined;

        if (test?.op === '<' && by === 1)
            return { atLeast: to };

        if (test?.op === '>' && by === -1)
            return { atMost: to };

        return undefined;
    };

    const emit = (title: Abs, value: string, conds: Cond[], saved: Map<string, Abs>, at: string): void =>
    {
        const arms = armsOf(value, title, saved);

        if (!arms || !title.target)
            return;

        const when: StartRule['when'] = [];

        for (const c of conds)
        {
            const on = c.on === title ? 'title' : c.on.t === 'none' ? 'none' : c.on === title.holder || c.on.holderOf === title ? 'holder' : undefined;

            if (on)
                when.push({ on, list: c.list, not: c.not });
        }

        rules.push({ target: title.target, when, arms, at });
    };

    /** `holder.house`, `root.house`, `scope:x.dynasty`, `title:x`, an entry key (variables: unknown) */
    const armsOf = (v: string, title: Abs, saved: Map<string, Abs>): StartRule['arms'] | undefined =>
    {
        if (v.includes('var:'))
            return undefined;

        const m = /^(.+)\.(house|dynasty)$/.exec(v);

        if (m)
        {
            const of = m[2] as 'house' | 'dynasty';

            if (m[1] === 'holder')
                return { of };

            const who = /^root$/i.test(m[1]) ? saved.get('@root') : m[1].startsWith('scope:') ? saved.get(m[1].slice(6)) : undefined;
            return who && (who === title.holder || who.holderOf === title) ? { of } : undefined;
        }

        if (v.startsWith('title:'))
            return { title: v.slice(6) };

        if (/^(house|dynasty):/.test(v))
            return { coa: v.slice(v.indexOf(':') + 1) };

        return /^[\w-]+$/.test(v) && !/^(this|root|prev|holder)$/i.test(v) ? { coa: v } : undefined;
    };

    const file = (d: { file: number; line: number; }, n: PNode): string => `${idx.fileRel(d.file)}:${d.line + n.line - 1}`;

    /** Walks a definition unless it is being walked (a loop) or an earlier walk of it set nothing (then none will). */
    const visit = (key: string, f: () => void): void =>
    {
        if (active.has(key) || barren.has(key))
            return;

        active.add(key);
        const before = rules.length + renown.length;
        f();
        active.delete(key);

        if (rules.length + renown.length === before)
            barren.add(key);
    };

    const walkOnAction = (name: string, root: Abs, conds: Cond[], saved: Map<string, Abs>): void =>
    {
        const e = idx.get(T_ON_ACTION, name);

        if (!e)
            return;

        visit('oa:' + name, () =>
        {
            // (the lists of an on_action's definitions merge; the effect runs first, then the events, then the on_actions)
            const defs = e.defs.flatMap((d, i) => (idx.isHiddenDef(d) ? [] : [{ d, body: kids(idx.defNode(e, undefined, i)?.node) }]));
            const trig = defs.flatMap(({ body }) => body.filter((c) => c.k === 'trigger').map((c): Cond => ({ on: root, list: kids(c), not: false })));
            const all = [...conds, ...trig];

            for (const { d, body } of defs)
                for (const c of body)
                    if (c.k === 'effect')
                        walk(kids(c), root, all, new Map(saved), (n) => file(d, n));

            for (const { body } of defs)
                for (const c of body)
                    if (c.k === 'events')
                    {
                        for (const id of kids(c))
                            if (id.k === null && typeof id.v === 'string')
                                walkEvent(id.v, root, all, saved);
                    }

            for (const { body } of defs)
                for (const c of body)
                    if (c.k === 'on_actions')
                    {
                        for (const id of kids(c))
                            if (id.k === null && typeof id.v === 'string')
                                walkOnAction(id.v, root, all, saved);
                    }
        });
    };

    const walkEvent = (id: string, root: Abs, conds: Cond[], saved: Map<string, Abs>): void =>
    {
        const e = idx.get(T_EVENT, id);
        const d = e && idx.winningDef(e);

        if (!e || !d)
            return;

        visit('ev:' + id, () =>
        {
            const body = kids(idx.defNode(e)?.node);
            const all = [...conds, ...body.filter((c) => c.k === 'trigger').map((c): Cond => ({ on: root, list: kids(c), not: false }))];
            const inner = new Map(saved).set('@root', root);

            for (const c of body)
                if (c.k === 'immediate')
                    walk(kids(c), root, all, inner, (n) => file(d, n));
        });
    };

    const walk = (list: PNode[], s: Abs, conds: Cond[], saved: Map<string, Abs>, at: (n: PNode) => string): void =>
    {
        let chain: PNode[][] = [];

        for (const c of list)
        {
            if (!c.k || --budget < 0)
                continue;

            const block = Array.isArray(c.v) ? c.v : undefined;
            const v = typeof c.v === 'string' ? c.v : undefined;

            if (c.k === 'if' || c.k === 'else_if' || c.k === 'else')
            {
                if (c.k === 'if')
                    chain = [];

                const limit = block?.find((x) => x.k === 'limit');
                const branch = [...conds, ...chain.map((l): Cond => ({ on: s, list: l, not: true })), ...(limit ? [{ on: s, list: kids(limit), not: false }] : [])];
                walk(block ?? [], s, branch, saved, at);

                if (limit)
                    chain.push(kids(limit));

                continue;
            }

            if (s.t === 'dynasty' && s.dynasty)
            {
                const step = renownOf(c);

                if (step)
                {
                    renown.push({ dynasty: s.dynasty, step, when: conds.filter((x) => x.on.t === 'none').map(({ list, not }) => ({ list, not })) });
                    continue;
                }
            }

            if (c.k === 'set_coa')
            {
                if (v && s.t === 'title')
                    emit(s, v, conds, saved, at(c));

                continue;
            }

            if (c.k === 'save_scope_as' || c.k === 'save_temporary_scope_as')
            {
                if (v)
                    saved.set(v, s);

                continue;
            }

            if (c.k === 'trigger_event')
            {
                const id = v ?? scalar(block ?? [], 'id');
                const oa = block && scalar(block, 'on_action');

                if (id)
                    walkEvent(id, s, conds, saved);
                else if (oa)
                    walkOnAction(oa, s, conds, saved);

                continue;
            }

            if (block && SAME.has(c.k))
            {
                walk(block, s, conds, saved, at);
                continue;
            }

            const to = block && enter(c.k, s, saved);

            if (to)
            {
                const limit = block.find((x) => x.k === 'limit');
                walk(block, to, limit ? [...conds, { on: to, list: kids(limit), not: false }] : conds, new Map(saved), at);
                continue;
            }

            // scripted effects: `name = yes`, `name = { PARAM = value }`
            const se = idx.get(T_SCRIPTED_EFFECT, c.k);
            const d = se && idx.winningDef(se);

            if (!se || !d || !(v === 'yes' || block))
                continue;

            const params: Record<string, string> = {};

            for (const x of block ?? [])
                if (x.k && typeof x.v === 'string')
                    params[x.k] = x.v;

            visit('se:' + c.k + JSON.stringify(params), () => walk(kids(idx.defNode(se, block ? params : undefined)?.node), s, conds, saved, (n) => file(d, n)));
        }
    };

    /** The scope a block key leads to (undefined: not followed). */
    const enter = (k: string, s: Abs, saved: Map<string, Abs>): Abs | undefined =>
    {
        const key = k.startsWith('title:') ? k.slice(6) : undefined;

        if (key)
            return { t: 'title', target: { how: 'key', key }, holder: s.t === 'char' ? s : undefined };

        if (k.startsWith('dynasty:'))
            return { t: 'dynasty', dynasty: k.slice(8) };

        if (CHARS.test(k))
            return { t: 'char' };

        if (s.t === 'char' && HELD.test(k))
            return { t: 'title', target: { how: 'held' }, holder: s };

        if (s.t === 'char' && k === 'primary_title')
            return { t: 'title', target: { how: 'primary' }, holder: s };

        if (s.t === 'char' && k === 'every_noble_family')
            return { t: 'title', target: { how: 'noble' } };

        if (s.t === 'title' && k === 'holder')
        {
            if (s.holder)
                return s.holder;

            return (s.holder = { t: 'char', holderOf: s });
        }

        if (/^root$/i.test(k))
            return saved.get('@root');

        if (k.startsWith('scope:'))
            return saved.get(k.slice(6));

        return undefined;
    };

    const none: Abs = { t: 'none' };

    for (const oa of ['on_game_start', 'on_game_start_after_lobby'])
        walkOnAction(oa, none, [], new Map([['@root', none]]));

    return { arms: rules, renown };
}
