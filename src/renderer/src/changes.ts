/**
 * The change bar (components/ChangeBar.tsx): what the app last changed in the active mod — an in-place edit, an undo,
 * an override, a Blender import, a refused edit — shown in one bar at the bottom of the window. A new change replaces
 * the one shown (no pile of notices); the session's changes stay listed behind "N changes".
 */
import { useSyncExternalStore } from 'react';

export interface ChangeAction
{
    label: string;
    run: () => void;
}

export interface Change
{
    id: number;
    kind: 'ok' | 'info' | 'error';
    /** "Changed: +4 Martial", "Undone", "Not added" */
    text: string;
    /** the mod's name */
    mod?: string;
    /** where: game-relative path and line ("common/traits/x.txt:17"); file/line open it */
    where?: string;
    file?: string;
    line?: number;
    /** smaller text: what went along, why it was refused */
    details?: string[];
    /** the bar's Undo undoes this undo step (main: mods/undo.ts) */
    undo?: number;
    actions?: ChangeAction[];
    at: number;
}

interface BarState
{
    current: Change | null;
    /** the session's changes (not the refusals), newest first */
    history: Change[];
    hidden: boolean;
}

let state: BarState = { current: null, history: [], hidden: false };
let seq = 0;
const listeners = new Set<() => void>();
const emit = (): void =>
{
    for (const l of listeners)
        l();
};

/** Shows a change in the bar (it replaces the one shown) and keeps it in the session's list. */
export function reportChange(c: Omit<Change, 'id' | 'at'>): void
{
    const change: Change = { ...c, id: ++seq, at: Date.now() };
    state = {
        current: change,
        history: c.kind === 'error' ? state.history : [change, ...state.history].slice(0, 100),
        hidden: false
    };
    emit();
}

/** Hides the bar until the next change. */
export function hideChangeBar(): void
{
    state = { ...state, hidden: true };
    emit();
}

export function useChangeBar(): BarState
{
    return useSyncExternalStore(
        (l) =>
        {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => state
    );
}
