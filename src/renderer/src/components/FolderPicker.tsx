import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { FolderListing } from '../../../shared/api';
import { api } from '../api';

import { tr, trn } from '../../../shared/i18n';
import { fold, foldHas } from '../../../shared/fold';
/**
 * The in-app folder picker (docs/app-architecture.md, "Folder picker"): the native dialog freezes on huge folders and
 * network shares, this one lists subfolder names only (main/folders.ts). A path box (any path, `\\server\share` too),
 * places (folders the app uses, shortcuts, drives), a filter, "Select" on every row (a folder is picked without being
 * listed), "New folder" inline, the system dialog as a fallback. Answers are asynchronous: a newer navigation wins over
 * a slow reply; listings are kept for the session and refreshed in the background.
 */
export function pickFolder(start: string | undefined, title: string): Promise<string | null>
{
    return new Promise((resolve) =>
    {
        // (an element of its own: it opens over other dialogs)
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        const done = (p: string | null): void =>
        {
            root.unmount();
            host.remove();
            resolve(p);
        };
        root.render(<FolderPicker start={start} title={title} onDone={done} />);
    });
}

/** listings of this session, by path (case-insensitive on Windows) */
const cache = new Map<string, FolderListing>();
const keyOf = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase();
/** at most this many rows (a folder with thousands of subfolders: the filter narrows them) */
const ROWS = 2000;

/** a subfolder's path */
function joinPath(dir: string, name: string): string
{
    const sep = dir.includes('/') && !dir.includes('\\') ? '/' : '\\';
    return /[\\/]$/.test(dir) ? dir + name : dir + sep + name;
}

/** the last part of a path (a drive root: itself) */
function baseName(p: string): string
{
    const t = p.replace(/[\\/]+$/, '');
    return t.slice(Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/')) + 1) || p;
}

function FolderPicker(props: { start?: string; title: string; onDone: (p: string | null) => void; }): React.JSX.Element
{
    const [path, setPath] = useState('');
    const [input, setInput] = useState('');
    const [listing, setListing] = useState<FolderListing | null>(null);
    const [loading, setLoading] = useState(false);
    const [updating, setUpdating] = useState(false);
    const [filter, setFilter] = useState('');
    const [places, setPlaces] = useState<{ used: string[]; shortcuts: { name: string; path: string; }[]; } | null>(null);
    const [drives, setDrives] = useState<string[]>([]);
    // the inline "New folder" field: its name (null: closed) and what went wrong
    const [newName, setNewName] = useState<string | null>(null);
    const [newError, setNewError] = useState('');
    const token = useRef(0);

    /** shows a folder: the session's listing at once, then a fresh one (a newer navigation wins) */
    const open = (p: string, opts: { nearest?: boolean; } = {}): void =>
    {
        const t = ++token.current;
        const cached = cache.get(keyOf(p));
        setPath(p);
        setInput(p);
        setFilter('');
        setNewName(null);
        setListing(cached ?? null);
        setLoading(!cached);
        setUpdating(!!cached);
        void api.listDirs(p).then((l) =>
        {
            if (t !== token.current)
                return;

            // (a start folder not made yet: the nearest one that is)
            if (l.notFound && opts.nearest)
            {
                void api.nearestFolder(p).then((n) => t === token.current && (n && n !== p ? open(n) : (setListing(l), setLoading(false), setUpdating(false))));
                return;
            }

            if (!l.error)
                cache.set(keyOf(p), l);

            setListing(l);
            setLoading(false);
            setUpdating(false);
        });
    };

    useEffect(() =>
    {
        void api.folderPlaces().then((pl) =>
        {
            setPlaces(pl);

            if (!props.start)
                open(pl.used[0] ?? pl.shortcuts[0]?.path ?? 'C:\\');
        });
        void api.drives().then(setDrives);

        if (props.start)
            open(props.start, { nearest: true });
    }, []);

    const foldedFilter = fold(filter);
    const rows = listing ? listing.dirs.filter((d) => !filter || foldHas(d, foldedFilter)) : [];

    const makeFolder = (): void =>
    {
        if (newName === null)
            return;

        void api.makeFolder(path, newName).then((r) =>
        {
            if (r.error || !r.path)
                setNewError(r.error ?? tr('The folder could not be made.'));
            else
            {
                cache.delete(keyOf(path));
                open(r.path);
            }
        });
    };

    const place = (p: string, label?: string, sub?: string): React.JSX.Element => (
        <button key={p} className={'fp-place' + (keyOf(p) === keyOf(path) ? ' active' : '')} title={p} onClick={() => open(p)}>
            <span>{label ?? baseName(p)}</span>
            {sub && <small>{sub}</small>}
        </button>
    );

    return (
        <div
            className="fp-backdrop"
            onMouseDown={(e) => e.target === e.currentTarget && props.onDone(null)}
            onKeyDown={(e) =>
            {
                if (e.key === 'Escape')
                {
                    // (the dialog it was opened from must not take the same key as its own)
                    e.preventDefault();
                    props.onDone(null);
                }
            }}
        >
            <div className="fp" role="dialog" aria-label={props.title}>
                <h2>{props.title}</h2>
                <div className="fp-pathbar">
                    <button title={tr('Up one folder')} disabled={!listing?.parent} onClick={() => listing?.parent && open(listing.parent)}>
                        ↑
                    </button>
                    <input
                        className="fp-path"
                        value={input}
                        spellCheck={false}
                        placeholder={tr('A folder\'s path — \\\\server\\share\\folder works too')}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) =>
                        {
                            if (e.key === 'Enter' && input.trim())
                                open(input.trim(), { nearest: true });
                        }}
                        autoFocus
                    />
                    <button
                        title={tr('Read the folder again')}
                        onClick={() =>
                        {
                            cache.delete(keyOf(path));
                            open(path);
                        }}
                    >
                        {tr('Refresh')}</button>
                </div>
                <div className="fp-body">
                    <nav className="fp-places">
                        {!!places?.used.length && (
                            <>
                                <h4>{tr('Used by this app')}</h4>
                                {places.used.map((p) => place(p, baseName(p), p.slice(0, p.length - baseName(p).length).replace(/[\\/]$/, '')))}
                            </>
                        )}
                        {!!places?.shortcuts.length && (
                            <>
                                <h4>{tr('Shortcuts')}</h4>
                                {places.shortcuts.map((s) => place(s.path, s.name))}
                            </>
                        )}
                        {!!drives.length && (
                            <>
                                <h4>{tr('Drives')}</h4>
                                {drives.map((d) => place(d, d))}
                            </>
                        )}
                    </nav>
                    <div className="fp-main">
                        <div className="fp-tools">
                            <input className="fp-filter" value={filter} placeholder={tr('Filter folders…')} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
                            <button
                                onClick={() =>
                                {
                                    setNewName('');
                                    setNewError('');
                                }}
                                disabled={!listing || !!listing.error}
                            >
                                {tr('New folder')}</button>
                        </div>
                        <div className="fp-list">
                            {newName !== null && (
                                <div className="fp-new">
                                    <input
                                        value={newName}
                                        placeholder={tr('New folder\'s name — Enter makes it, Esc cancels')}
                                        autoFocus
                                        onChange={(e) =>
                                        {
                                            setNewName(e.target.value);
                                            setNewError('');
                                        }}
                                        onKeyDown={(e) =>
                                        {
                                            if (e.key === 'Enter')
                                                makeFolder();

                                            // (Esc closes the field, not the picker)
                                            if (e.key === 'Escape')
                                            {
                                                e.stopPropagation();
                                                setNewName(null);
                                            }
                                        }}
                                    />
                                    {newError && <span className="fp-error">{newError}</span>}
                                </div>
                            )}
                            {loading && <div className="fp-status">{tr('Loading…')}</div>}
                            {listing?.error && <div className="fp-error fp-status">{listing.notFound ? tr('This folder does not exist.') : listing.error}</div>}
                            {rows.slice(0, ROWS).map((d) => (
                                <div key={d} className="fp-row" onClick={() => open(joinPath(path, d))}>
                                    <span className="fp-icon" aria-hidden="true">
                                        ▸
                                    </span>
                                    <span className="fp-name">{d}</span>
                                    <button
                                        className="fp-select"
                                        title={tr('Pick this folder without opening it')}
                                        onClick={(e) =>
                                        {
                                            e.stopPropagation();
                                            props.onDone(joinPath(path, d));
                                        }}
                                    >
                                        {tr('Select')}</button>
                                </div>
                            ))}
                            {rows.length > ROWS && <div className="fp-status">{tr('…and {more} more — use the filter', { more: (rows.length - ROWS).toLocaleString() })}</div>}
                            {listing && !listing.error && !rows.length && !loading && <div className="fp-status">{filter ? tr('No folder matches the filter.') : tr('No subfolders.')}</div>}
                        </div>
                        <div className="fp-count">
                            {listing && !listing.error && tr('{folders} · {files}', { folders: trn('{n} folder', '{n} folders', listing.dirs.length), files: trn('{n} file', '{n} files', listing.files) })}
                            {updating && tr(' · updating…')}
                        </div>
                    </div>
                </div>
                <div className="actions">
                    <button title={tr('Windows\' own folder dialog')} onClick={() => void api.nativeFolder(props.title, path || undefined).then((p) => p && props.onDone(p))}>
                        {tr('System dialog…')}</button>
                    <span style={{ flex: 1 }} />
                    <button onClick={() => props.onDone(null)}>{tr('Cancel')}</button>
                    <button className="primary" disabled={!listing || !!listing.error} onClick={() => props.onDone(path)}>
                        {tr('Select this folder')}</button>
                </div>
            </div>
        </div>
    );
}
