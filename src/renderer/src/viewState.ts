/**
 * State that outlives a view (docs/app-architecture.md, "Views that remember"): the preview date (one date for the
 * map and every character page : the map's date control and the character's set it alike) and what the map showed
 * (mode, 2D / 3D, style, selection, the 2D view, the 3D camera), so switching tabs comes back to it. Kept in memory
 * and in localStorage (a fresh start comes back too; storage failing is no matter).
 */
import { useSyncExternalStore } from 'react';

const KEY = 'crusaderpope.viewState';

/** What the map shows (MapView, Map3DView). */
export interface MapMemory
{
    mode?: string;
    dim?: '2d' | '3d';
    style?: string;
    /** a style chosen in the menu (it stays: no automatic paper map) */
    stylePicked?: boolean;
    sel?: number | null;
    /** the fog of war: on, whose view (a title or character), chosen by hand (else the selection's realm / a save's player is taken each time it is turned on) */
    fog?: { on: boolean; vp?: { kind: 'title' | 'character'; key: string; }; picked?: boolean; };
    /** the 2D view of the map of this key (map pixels: top left, pixels per screen pixel) */
    view?: { key: string; x: number; y: number; scale: number; };
    /** the 3D camera's pose (map3dCamera `pose`) */
    pose?: { key: string; x: number; z: number; dist: number; yaw: number; pitch: number; };
}

interface Stored
{
    date?: string;
    map: MapMemory;
}

let state: Stored = load();
const listeners = new Set<() => void>();

function load(): Stored
{
    try
    {
        const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Stored | null;
        return s && typeof s === 'object' ? { date: s.date, map: s.map ?? {} } : { map: {} };
    }
    catch
    {
        return { map: {} };
    }
}

let saving = 0;

function save(): void
{
    // (often while panning: written once things rest)
    clearTimeout(saving);
    saving = window.setTimeout(() =>
    {
        try
        {
            localStorage.setItem(KEY, JSON.stringify(state));
        }
        catch
        {
            // (no storage: memory only)
        }
    }, 400);
}

/** The preview date (y.m.d), the map's and every character page's; undefined: not chosen yet (the first bookmark). */
export function usePreviewDate(): string | undefined
{
    return useSyncExternalStore(
        (l) =>
        {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => state.date
    );
}

export function previewDate(): string | undefined
{
    return state.date;
}

export function setPreviewDate(date: string | undefined): void
{
    if (date === state.date)
        return;

    state = { ...state, date };
    save();

    for (const l of listeners)
        l();
}

/** What the map showed last. */
export function mapMemory(): MapMemory
{
    return state.map;
}

/** Remembers part of what the map shows (no re-render: the map reads it when it is made). */
export function rememberMap(patch: Partial<MapMemory>): void
{
    state = { ...state, map: { ...state.map, ...patch } };
    save();
}
