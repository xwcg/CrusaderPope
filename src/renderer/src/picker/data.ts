/**
 * The index data the statement picker reads (model.ts PickerData): entry lists per type, most used first; searches
 * for the big types; the "Other…" keys. Loaded once when the picker first opens (one request at a time, so preview
 * requests are not stuck behind them) and kept until the index changes — menus open without waiting.
 */
import type { FieldSuggestion, LocCodes, ModifierKeyInfo, NewEntryPlan, ScriptKeyInfo } from '../../../shared/api';
import { STATEMENTS, type PickKind } from '../../../shared/scriptCatalog';
import { api } from '../api';
import { activeModId } from '../modStore';
import type { PickerData, RefEntry } from './model';

/** too many entries to list: searched as one types */
const BIG = new Set(['characters']);

let lists = new Map<string, RefEntry[]>();
let loading = new Map<string, Promise<RefEntry[]>>();
let keys: Partial<Record<PickKind, ScriptKeyInfo[]>> = {};
let keysLoading: Promise<unknown> | null = null;
let suggestions = new Map<string, FieldSuggestion[]>();
let suggestionsLoading = new Map<string, Promise<unknown>>();
let locCodes: LocCodes | undefined;
let locCodesLoading: Promise<unknown> | null = null;
let modifiers: ModifierKeyInfo[] | undefined;
let modifiersLoading: Promise<unknown> | null = null;
let indexKey = '';

function loadSuggestions(source: string): Promise<unknown>
{
    let p = suggestionsLoading.get(source);

    if (!p)
    {
        const mine = (p = api
            .fieldSuggestions(source)
            .then((list) =>
            {
                if (suggestionsLoading.get(source) === mine)
                    suggestions.set(source, list);
            })
            .catch(() =>
            {
                if (suggestionsLoading.get(source) === mine)
                    suggestionsLoading.delete(source);
            }));
        suggestionsLoading.set(source, p);
    }

    return p;
}

// the names each event uses without saving them ("Pass along…")
let eventScopes = new Map<string, { name: string; about?: string; }[]>();
let eventScopesLoading = new Map<string, Promise<unknown>>();
function loadEventScopes(event: string): Promise<unknown>
{
    let p = eventScopesLoading.get(event);

    if (!p)
    {
        p = api.eventScopes(event).then(
            (l) => void eventScopes.set(event, l),
            () => void eventScopes.set(event, [])
        );
        eventScopesLoading.set(event, p);
    }

    return p;
}

// where a new entry of a type would go ("＋ New trait…"): the active mod's file, the next free event id
let plans = new Map<string, NewEntryPlan>();
let plansLoading = new Map<string, Promise<unknown>>();
function loadPlan(type: string): Promise<unknown>
{
    let p = plansLoading.get(type);

    if (!p)
    {
        const mine = (p = api.newEntryPlan(type).then(
            (plan) =>
            {
                if (plansLoading.get(type) === mine)
                    plans.set(type, plan);
            },
            () =>
            {
                if (plansLoading.get(type) === mine)
                    plans.set(type, { type, label: type, problem: 'unavailable', name: false });
            }
        ));
        plansLoading.set(type, p);
    }

    return p;
}

function loadLocCodes(): Promise<unknown>
{
    if (!locCodesLoading)
    {
        const mine = (locCodesLoading = api
            .locCodes()
            .then((c) =>
            {
                if (locCodesLoading === mine)
                    locCodes = c;
            })
            .catch(() =>
            {
                if (locCodesLoading === mine)
                    locCodesLoading = null;
            }));
    }

    return locCodesLoading;
}

function loadModifiers(): Promise<unknown>
{
    if (!modifiersLoading)
    {
        const mine = (modifiersLoading = api
            .modifierKeys()
            .then((list) =>
            {
                if (modifiersLoading === mine)
                    modifiers = list;
            })
            .catch(() =>
            {
                if (modifiersLoading === mine)
                    modifiersLoading = null;
            }));
    }

    return modifiersLoading;
}

function load(type: string): Promise<RefEntry[]>
{
    let p = loading.get(type);

    if (!p)
    {
        const mine = (p = api
            .list(type)
            .then((items) =>
            {
                const out = items
                    .map((i) => ({ name: i.name, display: i.display, icon: i.icon, refs: i.refs, mod: i.mod }))
                    .sort((a, b) => b.refs - a.refs || (a.name < b.name ? -1 : 1));

                if (loading.get(type) === mine)
                    lists.set(type, out);

                return out;
            })
            .catch(() =>
            {
                if (loading.get(type) === mine)
                    loading.delete(type);

                return [] as RefEntry[];
            }));
        loading.set(type, p);
    }

    return p;
}

function loadKeys(): Promise<unknown>
{
    if (!keysLoading)
    {
        const mine = (keysLoading = Promise.all([api.scriptKeys('effect'), api.scriptKeys('trigger')])
            .then(([effect, trigger]) =>
            {
                if (keysLoading === mine)
                    keys = { effect, trigger };
            })
            .catch(() =>
            {
                if (keysLoading === mine)
                    keysLoading = null;
            }));
    }

    return keysLoading;
}

/** a new index (another build, another mod list, an incremental update): cached data is dropped */
function watchIndex(): void
{
    const check = (s: { state: string; stats?: { ms: number; }; gameDir?: string; revision?: number; }): void =>
    {
        if (s.state !== 'ready')
            return;

        const k = `${s.stats?.ms ?? 0}|${s.gameDir ?? ''}|${s.revision ?? 0}`;

        if (k === indexKey)
            return;

        if (indexKey)
        {
            lists = new Map();
            loading = new Map();
            keys = {};
            keysLoading = null;
            modifiers = undefined;
            modifiersLoading = null;
            suggestions = new Map();
            suggestionsLoading = new Map();
            locCodes = undefined;
            locCodesLoading = null;
            eventScopes = new Map();
            eventScopesLoading = new Map();
            plans = new Map();
            plansLoading = new Map();
        }

        indexKey = k;
    };
    void api.status().then(check);
    api.onStatus(check);
}
watchIndex();

/** Every index type the catalog's parameters list, small ones first. */
function catalogTypes(): string[]
{
    const types = new Set<string>();

    for (const s of STATEMENTS)
        for (const p of s.params)
        {
            if (p.kind === 'ref' && !BIG.has(p.type))
                types.add(p.type);

            if (p.kind === 'name')
                types.add(p.type);
        }

    const later = ['modifiers', 'events', 'landed_titles', 'flag', 'variable'];
    return [...[...types].filter((t) => !later.includes(t)), ...later.filter((t) => types.has(t))];
}

let prefetching: Promise<void> | null = null;

/** Loads what the menus will ask for, one request after the other (called when the picker opens). */
export function prefetch(): void
{
    void loadKeys();
    void loadModifiers();

    if (prefetching)
        return;

    prefetching = (async () =>
    {
        for (const t of catalogTypes())
            await load(t);
    })().finally(() =>
    {
        prefetching = null;
    });
}

export const pickerData: PickerData = {
    list: (type) =>
    {
        const l = lists.get(type);

        if (!l)
            void load(type);

        return l;
    },
    loaded: (type) => load(type),
    big: (type) => BIG.has(type),
    search: async (type, q) =>
    {
        if (!q.trim())
            return [];

        // (historical characters: full name, house, title and lifetime — the first names alone repeat)
        if (type === 'characters')
            return (await api.searchCharacters(q, 60)).map((c) => ({ name: c.id, display: c.name, about: c.about, refs: 0 }));

        return (await api.search(q, { types: [type], limit: 60, text: true })).map((r) => ({ name: r.name, display: r.display, icon: r.icon, refs: 0 }));
    },
    keys: (kind) =>
    {
        if (!keys[kind])
            void loadKeys();

        return keys[kind];
    },
    keysLoaded: () => loadKeys(),
    modifiers: () =>
    {
        if (!modifiers)
            void loadModifiers();

        return modifiers;
    },
    modifiersLoaded: () => loadModifiers(),
    suggestions: (source) =>
    {
        const l = suggestions.get(source);

        if (!l)
            void loadSuggestions(source);

        return l;
    },
    suggestionsLoaded: (source) => loadSuggestions(source),
    activeMod: () => activeModId(),
    locCodes: () =>
    {
        if (!locCodes)
            void loadLocCodes();

        return locCodes;
    },
    locCodesLoaded: () => loadLocCodes(),
    eventScopes: (event) =>
    {
        const l = eventScopes.get(event);

        if (!l)
            void loadEventScopes(event);

        return l;
    },
    eventScopesLoaded: (event) => loadEventScopes(event),
    newPlan: (type) =>
    {
        const p = plans.get(type);

        if (!p)
            void loadPlan(type);

        return p;
    },
    newPlanLoaded: (type) => loadPlan(type)
};
