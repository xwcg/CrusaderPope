/**
 * App-wide notices (components/Notices.tsx): results of operations started in one view that must outlive it — an
 * override written into the active mod stays reported while the explorer re-indexes (the views are replaced by the
 * indexing screen meanwhile).
 */
import { useSyncExternalStore } from 'react';

export interface NoticeAction
{
    label: string;
    run: () => void;
}

export interface Notice
{
    id: number;
    kind: 'ok' | 'info' | 'error';
    title?: string;
    text: string;
    /** smaller lines under the text (what went along, what to know) */
    details?: string[];
    actions?: NoticeAction[];
}

let notices: Notice[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = (): void =>
{
    for (const l of listeners)
        l();
};

/** Shows a notice (the newest first; at most three stay). Errors stay until dismissed, others go after 30 s. */
export function pushNotice(n: Omit<Notice, 'id'>): number
{
    const id = ++seq;
    notices = [{ ...n, id }, ...notices].slice(0, 3);
    emit();

    // (long enough to outlast a re-index the notice announces)
    if (n.kind !== 'error')
        setTimeout(() => dismissNotice(id), 30_000);

    return id;
}

export function dismissNotice(id: number): void
{
    if (!notices.some((n) => n.id === id))
        return;

    notices = notices.filter((n) => n.id !== id);
    emit();
}

export function useNotices(): Notice[]
{
    return useSyncExternalStore(
        (l) =>
        {
            listeners.add(l);
            return () => listeners.delete(l);
        },
        () => notices
    );
}
