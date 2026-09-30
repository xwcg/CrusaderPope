/**
 * Mod display state shared by the entity list, sidebar, search and galleries (docs/mods.md, "How entries show mod
 * changes"): the mods loaded into the index — read from the index status here, so no component has to pass them
 * down — their colours and wording, and the "mod content only" filter. Also the mods state (the active mod, for the
 * editing actions) and pending changes of the active mod's files (the top bar's re-index notice).
 */
import { useSyncExternalStore } from 'react';
import type { IndexStatus, ModChange, ModInfo, ModsState, ModTouch } from '../../shared/api';
import { api } from './api';

export interface LoadedMod
{
    id: string;
    name: string;
}

export type ModState = ModTouch['state'];

/** The state filter: all mod entries, one kind of change, the conflicts (two or more mods touch the entry) or the duplicates (defined twice, no single winner in the game). */
export type ModFilterState = ModState | 'all' | 'conflicts' | 'duplicates';

export interface ModFilter
{
    /** only entries / files the loaded mods add, change or remove */
    on: boolean;
    /** narrows the entity list (and the sidebar's counts) further */
    state: ModFilterState;
}

/**
 * Two or more mods touch the entry (ModTouch.mods, load order) — they change it one over the other, or merge. Not when
 * they all leave it as the game has it (same), nor for flags and variables (mods using one name).
 */
export function isConflict(t: ModTouch | undefined): boolean
{
    return !!t && t.mods.length > 1 && t.state !== 'same' && !t.uses;
}

/** Whether a touch passes the state filter. */
export function matchesState(t: ModTouch | undefined, state: ModFilterState): boolean
{
    if (!t)
        return false;

    return state === 'all' || (state === 'conflicts' ? isConflict(t) : state === 'duplicates' ? !!t.duplicate : t.state === state);
}

function createStore<T>(initial: T): { get: () => T; set: (v: T) => void; subscribe: (l: () => void) => () => void; }
{
    let value = initial;
    const listeners = new Set<() => void>();
    return {
        get: () => value,
        set: (v) =>
        {
            if (v === value)
                return;

            value = v;

            for (const l of listeners)
                l();
        },
        subscribe: (l) =>
        {
            listeners.add(l);
            return () => listeners.delete(l);
        }
    };
}

const loaded = createStore<LoadedMod[]>([]);
const filter = createStore<ModFilter>({ on: false, state: 'all' });
const OFF: ModFilter = { on: false, state: 'all' };

// the ready index says which mods it layered (IndexStats.mods, load order); other mods: the filter starts over
const onStatus = (s: IndexStatus): void =>
{
    if (s.state !== 'ready')
        return;

    const next = s.stats?.mods ?? [];
    const cur = loaded.get();

    if (next.length === cur.length && next.every((m, i) => m.id === cur[i].id && m.name === cur[i].name))
        return;

    const sameMods = next.length === cur.length && next.every((m, i) => m.id === cur[i].id);
    loaded.set(next);

    // (a mod renamed in its descriptor: the same mods, the filter stays)
    if (!sameMods)
        filter.set(OFF);
};
void api.status().then(onStatus);
api.onStatus(onStatus);

/** The mods loaded into the index, in load order (empty: the game alone). */
export function useLoadedMods(): LoadedMod[]
{
    return useSyncExternalStore(loaded.subscribe, loaded.get);
}

/** The shared "mod content only" filter; always off while no mods are loaded. */
export function useModFilter(): [ModFilter, (patch: Partial<ModFilter>) => void]
{
    const f = useSyncExternalStore(filter.subscribe, filter.get);
    const mods = useLoadedMods();
    return [mods.length ? f : OFF, setModFilter];
}

export function setModFilter(patch: Partial<ModFilter>): void
{
    filter.set({ ...filter.get(), ...patch });
}

// entries a mod removed out of the lists, searches and counts (total conversions remove most of the game's) —
// remembered in this viewer's storage
const HIDE_KEY = 'crusaderpope.hideRemoved';
const readHide = (): boolean =>
{
    try
    {
        return localStorage.getItem(HIDE_KEY) === '1';
    }
    catch
    {
        return false;
    }
};
const hideRemoved = createStore<boolean>(readHide());

/** Whether entries the loaded mods removed are left out of lists, search results and counts (off: listed, struck through). */
export function useHideRemoved(): [boolean, (on: boolean) => void]
{
    return [useSyncExternalStore(hideRemoved.subscribe, hideRemoved.get), setHideRemoved];
}

export function setHideRemoved(on: boolean): void
{
    hideRemoved.set(on);

    try
    {
        localStorage.setItem(HIDE_KEY, on ? '1' : '0');
    }
    catch
    {
        /* not remembered */
    }
}

/** Whether an entry stays in view: removed ones only while they are not hidden — or when the removed are asked for. */
export function shownWith(t: ModTouch | undefined, hide: boolean, filter?: ModFilter): boolean
{
    return !hide || t?.state !== 'removed' || (!!filter?.on && filter.state === 'removed');
}

// the mods state of the main process (App keeps it current): the active mod of the editing actions
const modsState = createStore<ModsState | null>(null);

export function setModsState(s: ModsState | null): void
{
    modsState.set(s);
}

export interface ActiveMod
{
    /** ModInfo id set as the active mod (it may not exist) */
    id?: string;
    mod?: ModInfo;
    /** in the loaded mod list: its changes show in the explorer after a re-index */
    loaded: boolean;
}

/** The active mod's id outside React (the statement picker lists its entries first). */
export function activeModId(): string | undefined
{
    return modsState.get()?.activeMod ?? undefined;
}

/** The active mod (the one being edited) and whether the explorer loads it. */
export function useActiveMod(): ActiveMod
{
    const s = useSyncExternalStore(modsState.subscribe, modsState.get);

    if (!s?.activeMod)
        return { loaded: false };

    const id = s.activeMod.toLowerCase();
    const mod = s.mods.find((m) => m.id.toLowerCase() === id);
    const list = s.lists.find((l) => l.ref === s.selected);
    return { id: s.activeMod, mod, loaded: !!list?.mods.some((e) => e.enabled && e.id.toLowerCase() === id) };
}

// files of the active mod changed on disk since the last build (main's folder watcher)
const modChange = createStore<ModChange | null>(null);
void api.modChange().then((c) => modChange.set(c));
api.onModChange((c) => modChange.set(c));

/** A change of the active mod's files the index has not read yet (null: none). */
export function useModChange(): ModChange | null
{
    return useSyncExternalStore(modChange.subscribe, modChange.get);
}

const colors = new Map<string, string>();

/** Stable colour per mod, hashed from its id (FNV-1a → hue). */
export function modColor(id: string): string
{
    let c = colors.get(id);

    if (!c)
    {
        let h = 2166136261;

        for (let i = 0; i < id.length; i++)
            h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;

        c = `hsl(${h % 360}, 58%, 66%)`;
        colors.set(id, c);
    }

    return c;
}

export function modName(mods: LoadedMod[], id: string): string
{
    return mods.find((m) => m.id === id)?.name ?? id.replace(/^mod\//, '').replace(/\.mod$/, '');
}

const MINOR_WORD = /^(of|the|and|a|an|for|in|on|to|de|la|le|du|von)$/i;

/** Short form for compact chips: a short name as is, else its initials ("A Game of Thrones" → "AGoT"). */
export function modShort(name: string): string
{
    if (name.length <= 12)
        return name;

    const words = name
        .replace(/['’]s\b/g, '')
        .replace(/\([^)]*\)/g, ' ')
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
    const initials = words.map((w, i) => (i > 0 && MINOR_WORD.test(w) ? w[0].toLowerCase() : w[0].toUpperCase())).join('');
    return initials.length >= 2 ? initials.slice(0, 7) : name.slice(0, 11) + '…';
}

export const STATE_LABEL: Record<ModState, string> = { added: 'Added', overridden: 'Overridden', same: 'Same as the game', removed: 'Removed', merged: 'Merged' };
export const STATE_GLYPH: Record<ModState, string> = { added: '+', overridden: '✎', same: '=', removed: '−', merged: '⊕' };
export const CONFLICT_GLYPH = '⚔';
export const DUPLICATE_GLYPH = '⚠';
/** What a duplicate means (ModTouch.duplicate): the tooltip's and the banner's words. */
export const DUPLICATE_TEXT = 'Defined twice in the loaded files, and the game takes neither over the other: it reports the duplicate in error.log and which definition it uses is not defined.';

/** How to override an entry of a type the game keeps no winner for (after DUPLICATE_TEXT). */
export function duplicateAdvice(type: string): string
{
    return type === 'localization' ? 'Put the text into a localization replace/ folder for a real override.' : 'Replace the whole file (the same path) for a real override.';
}
const STATE_MEANING: Record<ModState, string> = {
    added: 'not in the game',
    overridden: "replaces the game's definition",
    same: "defined again by a mod, but the same as the game's (spacing and comments aside) — nothing changes",
    removed: 'only in files a mod hid — the game with these mods no longer has it',
    merged: 'the game and the mods all contribute'
};

/** The mod shown for a touch: the winning (or removing) one, last in `mods`. */
export function leadMod(t: ModTouch): string | undefined
{
    return t.mods[t.mods.length - 1];
}

/** Headline of a touch: "Overridden by A Game of Thrones", "Merged: the game and …". */
export function touchHeadline(t: ModTouch, mods: LoadedMod[]): string
{
    const names = t.mods.map((id) => modName(mods, id));

    if (t.uses)
        return `Used by ${t.state === 'merged' ? 'the game and ' : ''}${names.join(', ')}`;

    if (t.state === 'merged')
        return `Merged: the game and ${names.join(', ')}`;

    if (t.state === 'same')
        return `Same as the game in ${names.join(', ')}`;

    return `${STATE_LABEL[t.state]} by ${names[names.length - 1] ?? 'a mod'}`;
}

/**
 * Tooltip of a touch: headline, what the state means, and — when two or more mods touch the entry — the conflict:
 * every mod in load order and which one decides (the last).
 */
export function touchText(t: ModTouch, mods: LoadedMod[]): string
{
    const lines = [touchHeadline(t, mods), t.uses ? 'a flag or variable their script uses (it has no definition)' : STATE_MEANING[t.state]];

    if (t.duplicate)
        lines.push('', `${DUPLICATE_GLYPH} ${DUPLICATE_TEXT}`);

    if (isConflict(t))
    {
        const last = t.mods.length - 1;
        const decides = t.state === 'removed' ? 'removes it' : 'wins';
        lines.push(
            '',
            t.state === 'merged' ? `${t.mods.length} mods add to it (on_actions merge — nothing is lost), in load order:` : `Conflict: ${t.mods.length} mods change it — the last in load order ${decides}:`,
            ...t.mods.map((id, i) => `${i + 1}. ${modName(mods, id)}${i === last && t.state !== 'merged' ? ` ← ${decides}` : ''}`)
        );
    }

    return lines.join('\n');
}
