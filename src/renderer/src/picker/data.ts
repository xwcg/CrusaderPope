/**
 * The index data the statement picker reads (model.ts PickerData): entry lists per type, most used first; searches
 * for the big types; the "Other…" keys. Loaded once when the picker first opens (one request at a time, so preview
 * requests are not stuck behind them) and kept until the index changes: menus open without waiting.
 */
import type { FieldSuggestion, LocCodes, ModifierKeyInfo, NewEntryPlan, ScriptKeyInfo } from '../../../shared/api';
import { scriptFacts, type DbEntry, type DbKind } from '../../../shared/scriptFacts';
import { STATEMENTS, preferKeys, type PickKind } from '../../../shared/scriptCatalog';
import { api } from '../api';
import { activeModId } from '../modStore';
import { setScriptedLists, type PickerData, type RefEntry } from './model';

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
/** settles when the index is ready the first time (watchIndex): lists asked before wait for it */
let readyNow: () => void = () => undefined;
const firstReady = new Promise<void>((resolve) => (readyNow = resolve));

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

// the text of a localization key (a named track's name in game: kept when the key exists); null: no such key
let locEntries = new Map<string, { text?: string; rel?: string; mod?: string; } | null>();
let locEntriesLoading = new Map<string, Promise<unknown>>();
function loadLocEntry(key: string): Promise<unknown>
{
    let p = locEntriesLoading.get(key);

    if (!p)
    {
        p = api.locEntry(key).then(
            (e) => void locEntries.set(key, e?.rel ? e : null),
            () => void locEntries.set(key, null)
        );
        locEntriesLoading.set(key, p);
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

// the script database's explanations (docs/script-database.md): per kind its explained keys' [label, summary], for the
// rows' tooltips and "Other…"; the entries themselves (the preview's doc card) asked one at a time. Kept until another
// database is in use (an update, another game version: api.onScriptDbFacts), not dropped with the index.
const DOC_KINDS: DbKind[] = ['effect', 'trigger', 'list', 'link', 'saved_scope', 'scope_type', 'modifier', 'on_action'];
let docLabels = new Map<DbKind, Record<string, [string, string]>>();
let docLabelsLoading = new Map<DbKind, Promise<unknown>>();
let docEntries = new Map<string, Promise<DbEntry | null>>();

function loadDocLabels(kind: DbKind): Promise<unknown>
{
    let p = docLabelsLoading.get(kind);

    if (!p)
    {
        const mine = (p = api.scriptDbLabels(kind).then(
            (l) =>
            {
                if (docLabelsLoading.get(kind) === mine)
                    docLabels.set(kind, l);
            },
            () =>
            {
                if (docLabelsLoading.get(kind) === mine)
                    docLabelsLoading.delete(kind);
            }
        ));
        docLabelsLoading.set(kind, p);
    }

    return p;
}

/**
 * A list's form written as a statement key (`every_vassal`, `random_vassal`, `ordered_vassal` an effect, `any_vassal` a
 * trigger): the list it belongs to, whose one entry the database keeps for all its forms (docs/script-database.md).
 */
function listOfForm(kind: DbKind, key: string): string | undefined
{
    const m = /^(every|random|ordered|any)_(\w+)$/.exec(key);

    if (!m || !(m[1] === 'any' ? kind === 'trigger' : kind === 'effect'))
        return undefined;

    return scriptFacts()?.lists.find((l) => l.name === m[2] && l.forms.includes(m[1]))?.name;
}

/** A game key's entry in the script database (its explanation, the game's own text); null: the database has none. */
export function docEntry(kind: DbKind, key: string, variant?: string): Promise<DbEntry | null>
{
    const list = listOfForm(kind, key);

    if (list)
        return docEntry('list', list);

    const k = `${kind}\u0000${key}\u0000${variant ?? ''}`;
    let p = docEntries.get(k);

    if (!p)
    {
        p = api.scriptDbEntry(kind, key, variant).catch(() =>
        {
            // (a failed request is asked again next time)
            docEntries.delete(k);
            return null;
        });
        docEntries.set(k, p);
    }

    return p;
}

api.onScriptDbFacts(() =>
{
    docLabels = new Map();
    docLabelsLoading = new Map();
    docEntries = new Map();
});

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
        // (asked before the index was ready the first time, as the picker's warm-up at start can: asked once it is,
        // so an empty answer of no index is never kept)
        const mine = (p = (indexKey ? Promise.resolve() : firstReady)
            .then(() => api.list(type))
            .then((items) =>
            {
                const out = items
                    .map((i) => ({ name: i.name, display: i.display, icon: i.icon, refs: i.refs, mod: i.mod, base: i.base }))
                    .sort((a, b) => b.refs - a.refs || (a.name < b.name ? -1 : 1));

                if (loading.get(type) === mine)
                {
                    lists.set(type, out);

                    if (type === 'scripted_lists')
                        setScriptedLists(out);
                }

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
                {
                    keys = { effect, trigger };
                    preferKeys([...effect, ...trigger].map((k) => k.key));
                }
            })
            .catch(() =>
            {
                if (keysLoading === mine)
                    keysLoading = null;
            }));
    }

    return keysLoading;
}

/** per type: its entries' DLC or mod (the grouping) */
const dlcs = new Map<string, Record<string, string>>();
const dlcLoading = new Map<string, Promise<unknown>>();

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
            locEntries = new Map();
            locEntriesLoading = new Map();
            plans = new Map();
            plansLoading = new Map();
            dlcs.clear();
            dlcLoading.clear();
            flagsOf.clear();
            flagsLoading.clear();
        }

        indexKey = k;
        readyNow();
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
    // (the iterator menus offer the scripted lists beside their base list, model.ts itersMenu: asked first, before the
    // keys and the modifier list, which take the worker longer)
    void load('scripted_lists');
    void loadKeys();
    void loadModifiers();

    // (the explanations' labels: small, from the main process's database, no index needed)
    for (const k of DOC_KINDS)
        void loadDocLabels(k);

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

/** lists grouped by DLC (Tab in the picker): remembered between sessions */
let grouped = ((): boolean =>
{
    try
    {
        return localStorage.getItem('picker.groupByDlc') === '1';
    }
    catch
    {
        return false;
    }
})();

/** per type: its entries limited to a DLC by their own script (flag, DLC name) */
const flagsOf = new Map<string, Record<string, { flag: string; dlc: string; }>>();
const flagsLoading = new Map<string, Promise<unknown>>();

function loadFlags(type: string): Promise<unknown>
{
    let p = flagsLoading.get(type);

    if (!p)
    {
        p = api
            .dlcFlags(type)
            .then((g) => void flagsOf.set(type, g))
            .catch(() => void flagsLoading.delete(type));
        flagsLoading.set(type, p);
    }

    return p;
}

function loadDlc(type: string): Promise<unknown>
{
    let p = dlcLoading.get(type);

    if (!p)
    {
        p = api
            .dlcGroups(type)
            .then((g) => void dlcs.set(type, g))
            .catch(() => void dlcLoading.delete(type));
        dlcLoading.set(type, p);
    }

    return p;
}

export const pickerData: PickerData = {
    grouped: () => grouped,
    setGrouped: (on) =>
    {
        grouped = on;

        try
        {
            localStorage.setItem('picker.groupByDlc', on ? '1' : '0');
        }
        catch
        {
            // (no storage: for this session only)
        }
    },
    dlcGroups: (type) =>
    {
        const g = dlcs.get(type);

        if (!g)
            void loadDlc(type);

        return g;
    },
    dlcLoaded: (type) => loadDlc(type),
    dlcFlags: (type) =>
    {
        const g = flagsOf.get(type);

        if (!g)
            void loadFlags(type);

        return g;
    },
    dlcFlagsLoaded: (type) => loadFlags(type),
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

        // (historical characters: full name, house, title and lifetime; the first names alone repeat)
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
    locEntry: (key) =>
    {
        const e = locEntries.get(key);

        if (e === undefined)
            void loadLocEntry(key);

        return e;
    },
    locEntryLoaded: (key) => loadLocEntry(key),
    newPlan: (type) =>
    {
        const p = plans.get(type);

        if (!p)
            void loadPlan(type);

        return p;
    },
    newPlanLoaded: (type) => loadPlan(type),
    docLabel: (kind, key) =>
    {
        // (a list's form: its list's entry)
        const list = listOfForm(kind, key);
        const l = docLabels.get(list ? 'list' : kind);

        if (!l)
            void loadDocLabels(list ? 'list' : kind);

        return l?.[list ?? key];
    },
    docLabels: (kind) =>
    {
        const l = docLabels.get(kind);

        if (!l)
            void loadDocLabels(kind);

        return l;
    },
    docLabelsLoaded: (kind) => loadDocLabels(kind)
};
