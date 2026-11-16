/**
 * The script database's facts applied to the picker's and the describer's tables (docs/script-database.md, step 2):
 * the game's own documentation decides where each link and list works and what it leads to; the hand-written tables
 * in scriptCatalog.ts keep what the docs do not say (labels, root menu places, mnemonics, list parameters, orders).
 * The main process reads the facts from the database (src/main/scriptDb.ts scriptFactsOf) and hands them to its
 * workers and the window; each applies them here once at start and again after a database update. Without facts
 * (no database, a runtime without node:sqlite) the hand-written tables stay as they are.
 */
import { tr } from './i18n.ts';
import { appScopeType, CHARACTER_ORDERS, ITERATORS, LINKS, PREFIX_SCOPES, SCOPE_LABELS, STATEMENTS, TITLE_ORDERS, type IteratorDef, type ScopeLink, type ScopeType } from './scriptCatalog.ts';

/** `order_by` values that fit a list's items (ordered_), by their type */
const ordersFor = (to: ScopeType): [string, string][] | undefined => (to === 'character' ? CHARACTER_ORDERS : to === 'landed_title' ? TITLE_ORDERS : undefined);

// ---- the script database's entries (src/main/scriptDb.ts reads them; the window gets them over IPC)

export type DbKind = 'effect' | 'trigger' | 'list' | 'link' | 'saved_scope' | 'scope_type' | 'modifier' | 'on_action' | 'custom_loc' | 'data_type' | 'data_function';

/** A role of a scope type in an entry: where it runs, what it takes or lists, a link's ends, a modifier's areas, an on_action's root */
export type DbRole = 'scope' | 'target' | 'input' | 'output' | 'area' | 'root';

export interface DbExplanation
{
    label: string;
    summary: string;
    details: string;
    fields: { name: string; text: string; values?: string; required?: boolean; default?: string; }[];
    sources: string[];
    /** the explanation rests on little (no doc of the game, an inference from the name and vanilla's use) */
    uncertain?: boolean;
}

export interface DbEntry
{
    id: number;
    kind: DbKind;
    key: string;
    /** '' or, for a name documented twice, 'data' (a link written `name:key`) or a number */
    variant: string;
    /** the game's own text as written */
    doc: string;
    facts: Record<string, unknown>;
    scopes: Partial<Record<DbRole, string[]>>;
    explanation?: DbExplanation;
}

/** A script database update check's answer (src/main/scriptDbUpdate.ts) */
export interface ScriptDbUpdateResult
{
    state: 'updated' | 'current' | 'skipped' | 'none' | 'off' | 'error';
    message: string;
    /** the game version and build of the database downloaded (updated) or offered */
    game?: string;
    built?: string;
}

/** The script database in use (src/main/scriptDbService.ts) */
export interface ScriptDbStatus
{
    /** the game version the database in use documents, its build, where it comes from; null: none in use */
    game?: string;
    built?: string;
    source?: 'bundled' | 'downloaded';
    explained?: number;
    /** the last update check's answer (this run) */
    last?: ScriptDbUpdateResult;
}

/** A plain scope link (`liege`) or a link that takes data (`faith:x`, `puppet:<type>`), with the game's scope type names */
export interface FactLink
{
    key: string;
    input: string[];
    output: string[];
    /** usable without a scope in front (`faith:x`, `dummy_male`) */
    global: boolean;
    /** our explanation's label and summary, when written */
    label?: string;
    summary?: string;
}

export interface FactList
{
    /** without every_ / random_ / ordered_ / any_ */
    name: string;
    forms: string[];
    scope: string[];
    target: string[];
    label?: string;
    summary?: string;
}

export interface ScriptFacts
{
    /** the game version the database documents */
    version: string;
    links: FactLink[];
    /** links that take data: a database prefix (`faith:`, `accolade_type:`) or a typed link (`puppet:<type>`) */
    dataLinks: FactLink[];
    lists: FactList[];
    /** effects and triggers with documented scopes (statements' scopes are checked against them) */
    statements: { key: string; kind: 'effect' | 'trigger'; scope: string[]; }[];
    savedScopes: { name: string; label?: string; summary?: string; }[];
    scopeTypes: { name: string; label?: string; summary?: string; }[];
    /** on_actions.log: whether the game's code fires it, and its root (empty: not documented) */
    onActions: { name: string; fromCode: boolean; root: string[]; }[];
}

let applied: ScriptFacts | null = null;
let revision = 0;
const listeners: (() => void)[] = [];

/** The hand-written tables as they were before any facts were applied (applying again starts from them). */
const hand = {
    links: LINKS.map((l) => ({ ...l, from: [...l.from] })),
    lists: ITERATORS.map((i) => ({ ...i, from: [...i.from] })),
    prefixes: { ...PREFIX_SCOPES },
    scopes: new Map(STATEMENTS.map((s) => [s, s.scopes === 'any' ? 'any' as const : [...s.scopes]]))
};

/** links the game documents only with data (`puppet:<type>`): not written bare (docs check of 2026-11-13) */
export const TYPED_LINKS: { key: string; from: ScopeType[]; to: ScopeType; }[] = [];

/** The facts last applied (null: none; the hand-written tables are in use). */
export function scriptFacts(): ScriptFacts | null
{
    return applied;
}

/** Counts up each time facts are applied: caches derived from LINKS / ITERATORS compare it. */
export function factsRevision(): number
{
    return revision;
}

/** Called after each apply (the describer's link map, the key scan's link keys). */
export function onFactsApplied(fn: () => void): void
{
    listeners.push(fn);
}

/** `primary_title` → "Primary title" (a label until the explanation gives one) */
export function humanizeKey(key: string): string
{
    const s = key.replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
}

const types = (names: string[]): ScopeType[] => [...new Set(names.map(appScopeType).filter((t): t is ScopeType => !!t))];

export function applyScriptFacts(facts: ScriptFacts): void
{
    // ---- links: the game's inputs and output for the hand-written ones, the rest of the game's plain links added
    const plain = new Map(facts.links.map((l) => [l.key, l]));
    const data = new Map(facts.dataLinks.map((l) => [l.key, l]));
    const links: ScopeLink[] = [];

    for (const h of hand.links)
    {
        const f = plain.get(h.key);

        if (h.key === 'root' || (!f && !data.has(h.key)))
        {
            links.push({ ...h, from: [...h.from] });
            continue;
        }

        if (!f)
            continue;

        const from = types(f.input);
        const to = types(f.output);
        links.push({ ...h, from: f.input.length ? from : [...h.from], to: to.includes(h.to) || !to.length ? h.to : to[0] });
    }

    const known = new Set(links.map((l) => l.key));

    for (const f of facts.links)
    {
        const from = types(f.input);
        const to = types(f.output)[0];

        if (known.has(f.key) || !to || !from.length)
            continue;

        links.push({ key: f.key, label: f.label || tr(humanizeKey(f.key)), from, to });
    }

    LINKS.splice(0, LINKS.length, ...links);

    // ---- typed links (`puppet:<type>`) and database prefixes (`accolade_type:x`)
    TYPED_LINKS.splice(0, TYPED_LINKS.length);

    for (const k of Object.keys(PREFIX_SCOPES))
        delete PREFIX_SCOPES[k];

    Object.assign(PREFIX_SCOPES, hand.prefixes);

    for (const f of facts.dataLinks)
    {
        const to = types(f.output)[0];

        if (!to)
            continue;

        if (f.global && !(f.key in PREFIX_SCOPES))
            PREFIX_SCOPES[f.key] = to;
        else if (!f.global && f.input.length)
            TYPED_LINKS.push({ key: f.key, from: types(f.input), to });
    }

    // ---- lists: the game's scopes, item type and forms for the hand-written ones, the rest of the game's lists added
    const lists = new Map(facts.lists.map((l) => [l.name, l]));
    const iterators: IteratorDef[] = [];

    for (const h of hand.lists)
    {
        const f = lists.get(h.list);

        // (not in the docs: a scripted list of vanilla, common/scripted_lists; kept as written)
        if (!f)
        {
            iterators.push({ ...h, from: [...h.from] });
            continue;
        }

        const scope = types(f.scope);
        const to = types(f.target);
        const it: IteratorDef = {
            ...h,
            from: scope.length ? scope : [...h.from],
            to: to.includes(h.to) || !to.length ? h.to : to[0],
            effect: f.forms.includes('every') || f.forms.includes('random'),
            trigger: f.forms.includes('any'),
            global: !f.scope.length
        };

        // (the orders follow the items: a list whose item type the docs corrected gets its type's orders)
        if (!f.forms.includes('ordered'))
            delete it.orders;
        else if (it.to !== h.to || !it.orders)
        {
            const o = ordersFor(it.to);

            if (o)
                it.orders = o;
            else
                delete it.orders;
        }

        iterators.push(it);
    }

    const listed = new Set(iterators.map((i) => i.list));

    for (const f of facts.lists)
    {
        const to = types(f.target)[0];

        if (listed.has(f.name) || !to)
            continue;

        const scope = types(f.scope);
        iterators.push({
            list: f.name,
            label: f.label || tr(humanizeKey(f.name).toLowerCase()),
            // (a list of the whole game is offered where the hand-written ones are: on a character)
            from: scope.length ? scope : ['character'],
            to,
            effect: f.forms.includes('every') || f.forms.includes('random'),
            trigger: f.forms.includes('any'),
            ...(!f.scope.length ? { global: true } : {}),
            ...(f.forms.includes('ordered') && ordersFor(to) ? { orders: ordersFor(to) } : {})
        });
    }

    ITERATORS.splice(0, ITERATORS.length, ...iterators);

    // ---- statements: offered only where the game's docs say the key works (when they say it)
    const docScopes = new Map(facts.statements.map((s) => [`${s.kind}:${s.key}`, types(s.scope)]));

    for (const s of STATEMENTS)
    {
        const orig = hand.scopes.get(s);

        if (!orig || orig === 'any' || !orig.length)
            continue;

        const key = /^\s*\[?\s*(\w+)\s*(?:=|<|>)/.exec(s.script)?.[1];
        const doc = key ? docScopes.get(`${s.kind}:${key}`) : undefined;
        const kept = doc?.length ? orig.filter((t) => doc.includes(t)) : orig;
        s.scopes = kept.length ? kept : [...orig];
    }

    applied = facts;
    revision++;

    for (const fn of listeners)
        fn();
}

let onActionMap: { rev: number; map: Map<string, { fromCode: boolean; root?: ScopeType; }>; } | null = null;

/**
 * What the game's docs say of an on_action (on_actions.log): fired by the game's code, and its root as a scope type
 * (undefined root: "none", not documented). Undefined: no facts, or an on_action the docs do not list (a mod's own).
 */
export function onActionFact(name: string): { fromCode: boolean; root?: ScopeType; } | undefined
{
    if (!applied)
        return undefined;

    if (onActionMap?.rev !== revision)
        onActionMap = { rev: revision, map: new Map((applied.onActions ?? []).map((o) => [o.name, { fromCode: o.fromCode, root: types(o.root)[0] }])) };

    return onActionMap.map.get(name);
}

/** Whether the app knows a scope type of the game (a label for it). */
export function knownScopeType(game: string): boolean
{
    const t = appScopeType(game);
    return !!t && t in SCOPE_LABELS;
}
