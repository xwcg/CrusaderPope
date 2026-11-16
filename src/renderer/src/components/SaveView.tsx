/**
 * The Save tab (docs/saves.md): the save files of the user folder's `save games`; load one into the index as the top
 * layer (its data in the explorer and on the map, over the game and the mods), unload it, load another file. A save
 * played with other mods than the loaded ones offers to load its mods.
 */
import React, { useEffect, useState } from 'react';
import type { IndexStatus, LoadedSave, ModsState, SaveListItem } from '../../../shared/api';
import { tr, trn } from '../../../shared/i18n';
import { api } from '../api';
import { reportChange } from '../changes';
import { errorText } from './ModDialogs';
import { versionMatches } from '../../../shared/modRules';
import { undoSaveEdit } from '../scriptEdits';
import { RakalyTool } from './ExternalTools';
import '../styles/saves.css';

export const SAVE_ROUTE = '@save';

const sizeText = (n: number): string => (n >= 1e6 ? tr('{n} MB', { n: (n / 1e6).toFixed(1) }) : tr('{n} KB', { n: Math.round(n / 1e3) }));
const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const lc = (s: string): string => s.toLowerCase();
/** "5 min ago", "3 h ago", "2 days ago", else the date. */
function ago(ms: number): string
{
    const m = Math.round((Date.now() - ms) / 60000);

    if (m < 1)
        return tr('just now');

    if (m < 60)
        return tr('{n} min ago', { n: m });

    if (m < 24 * 60)
        return tr('{n} h ago', { n: Math.round(m / 60) });

    if (m < 14 * 24 * 60)
        return trn('{n} day ago', '{n} days ago', Math.round(m / 1440));

    return new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });
}
/** A mod id as a save names it (`mod/ugc_<n>.mod`) and as the app may know it (`workshop/<n>`, no descriptor): the same. */
const modKey = (id: string): string => lc(id).replace(/^mod\/ugc_(\d+)\.mod$/, 'workshop/$1');

/**
 * How the version a save was made with compares with the installed game's: 'minor' when the game's major.minor
 * differs (1.18 against 1.20: the save may hold things the editor does not read), 'patch' when only the later components do
 * (1.20.0.4 against 1.20.1.2), undefined when they fit or there is nothing to compare.
 */
function versionGap(version: string | undefined, game: string | undefined): 'minor' | 'patch' | undefined
{
    if (versionMatches(version, game) !== false)
        return undefined;

    return versionMatches(version?.split('.').slice(0, 2).join('.'), game) === false ? 'minor' : 'patch';
}

const gapTitle = (version: string, game: string, gap: 'minor' | 'patch'): string =>
    (gap === 'minor' ? tr('Saved with {version}; the installed game is {game}: this save may hold things the editor does not read (a faith table in a layout it does not know is told on the page once the save is loaded)', { version, game }) : tr('Saved with {version}; the installed game is {game}', { version, game }));

/**
 * The save's mods against the loaded list: names and icons come from the loaded game files, so a save played with
 * other mods offers to load its own (a custom list "Save: <player>", selected; a re-index).
 */
function SaveMods({ save }: { save: SaveListItem; }): React.JSX.Element | null
{
    const [state, setState] = useState<ModsState | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() =>
    {
        void api.modsState().then(setState, () => setState(null));
    }, [save.file]);

    if (!state)
        return null;

    const loaded = (state.lists.find((l) => l.ref === state.selected)?.mods ?? []).filter((m) => m.enabled).map((m) => modKey(m.id));
    const wanted = save.mods.map(modKey);

    if (loaded.length === wanted.length && loaded.every((m, i) => m === wanted[i]))
        return null;

    // (the app's own id of a mod the save names)
    const appId = (id: string): string | undefined => state.mods.find((m) => modKey(m.id) === modKey(id))?.id;
    const nameOf = (id: string): string => state.mods.find((m) => modKey(m.id) === modKey(id))?.name ?? id;
    const missing = save.mods.filter((id) => !appId(id));
    const load = async (): Promise<void> =>
    {
        setBusy(true);

        try
        {
            const name = tr('Save: {player}', { player: save.player ?? save.name });
            const known = state.lists.find((l) => l.kind === 'custom' && l.name === name);
            const after = await api.saveModList({ ref: known?.ref, name, mods: save.mods.filter((id) => !missing.includes(id)).map((id) => ({ id: appId(id)!, enabled: true })) });
            const ref = known?.ref ?? [...after.lists].reverse().find((l) => l.kind === 'custom' && l.name === name)?.ref;

            if (ref)
                setState(await api.selectModList(ref));
        }
        catch (e)
        {
            reportChange({ kind: 'error', text: tr('Mods not loaded'), details: [errorText(e)] });
        }
        finally
        {
            setBusy(false);
        }
    };
    return (
        <div className="save-mods">
            <div>{tr('This save was played with other mods than the loaded ones: what it refers to may be missing.')}</div>
            <div className="dim">{save.mods.length ? save.mods.map(nameOf).join(', ') : tr('no mods')}</div>
            {missing.length > 0 && <div className="save-error">{tr('Not installed: {mods}', { mods: missing.join(', ') })}</div>}
            {/* (none of them installed: nothing to load) */}
            {missing.length < save.mods.length && <button className="small" disabled={busy} onClick={() => void load()}>{busy ? tr('Loading…') : tr('Load the save\'s mods')}</button>}
        </div>
    );
}

export function SaveView({ status }: { status: IndexStatus; }): React.JSX.Element
{
    const [list, setList] = useState<{ dir: string; saves: SaveListItem[]; } | null>(null);
    const [loaded, setLoaded] = useState<LoadedSave | null>(null);
    const [busy, setBusy] = useState(false);
    // a binary save waiting for rakaly (the prompt), one being converted
    const [ask, setAsk] = useState<SaveListItem | null>(null);
    const [converting, setConverting] = useState(false);
    // the installed game's version (what a save's is compared with)
    const [game, setGame] = useState<string | undefined>();
    useEffect(() =>
    {
        void api.modsState().then((m) => setGame(m.gameVersion), () => setGame(undefined));
    }, []);

    const refresh = (): void =>
    {
        void api.listSaves().then(setList);
        void api.loadedSave().then(setLoaded);
    };

    // (again when a build is done: the loaded save is known then)
    useEffect(refresh, [status.state]);

    const load = async (file?: string | null): Promise<void> =>
    {
        setBusy(true);

        try
        {
            const r = await api.loadSave(file);

            if (r || file === null)
                setLoaded(r ?? { loaded: false });
        }
        catch (e)
        {
            reportChange({ kind: 'error', text: tr('Save not loaded'), details: [errorText(e)] });
        }
        finally
        {
            setBusy(false);
        }
    };

    const write = async (): Promise<void> =>
    {
        setBusy(true);

        try
        {
            const r = await api.writeSaveAs();

            if (r)
            {
                reportChange({ kind: 'ok', text: tr('Save written'), details: [r.file, tr('Load it in the game to play with the changes.')] });
                refresh();
            }
        }
        catch (e)
        {
            reportChange({ kind: 'error', text: tr('Not written'), details: [errorText(e)] });
        }
        finally
        {
            setBusy(false);
        }
    };

    const current = loaded?.file ? list?.saves.find((s) => lc(s.file) === lc(loaded.source ?? loaded.file!)) : undefined;
    // a binary save to load: rakaly asked for first when it isn't there
    const loadBinary = async (s: SaveListItem): Promise<void> =>
    {
        if ((await api.rakaly()).installed)
            await convertAndLoad(s.file);
        else
            setAsk(s);
    };
    const convertAndLoad = async (file: string): Promise<void> =>
    {
        setAsk(null);
        setConverting(true);

        try
        {
            await load(file);
        }
        finally
        {
            setConverting(false);
        }
    };
    const indexing = status.state === 'indexing';
    const [filter, setFilter] = useState('');
    const [showEdits, setShowEdits] = useState(false);
    const shown = (list?.saves ?? []).filter((s) => !filter || lc(`${s.player ?? ''} ${s.title ?? ''} ${s.name}`).includes(lc(filter)));
    const isAuto = (s: SaveListItem): boolean => /^autosave/i.test(s.name);
    const groups: [string, SaveListItem[]][] = [
        [tr('Saves'), shown.filter((s) => !isAuto(s))],
        [tr('Autosaves'), shown.filter(isAuto)]
    ];
    const isLoaded = (s: SaveListItem): boolean => !!loaded?.file && lc(loaded.source ?? loaded.file) === lc(s.file);
    const state = !loaded?.file ? 'none' : indexing ? 'busy' : loaded.loaded ? 'ok' : 'error';

    return (
        <div className="save-manager">
            <div className="save-page-head">
                <h2>{tr('Savegame')}</h2>
                <p>{tr('Load a save to see its world in the explorer and on the map — its characters, titles and realms at its date, over the game and the mods — and change it.')}</p>
            </div>

            {/* the loaded save */}
            <section className={'save-hero ' + state}>
                {loaded?.file ?
                    (
                        <>
                            <div className="save-hero-main">
                                <div className="save-hero-title">
                                    <span className="save-hero-name">{current?.player ?? (loaded.source ?? loaded.file).split(/[\\/]/).pop()}</span>
                                    {current?.title && <span className="save-hero-realm">{current.title}</span>}
                                </div>
                                <div className="save-chips">
                                    {(loaded.date ?? current?.date) && <span className="save-chip gold">{loaded.date ?? current?.date}</span>}
                                    {current?.version && (() =>
                                    {
                                        // (a save of another major.minor whose faiths were found in a layout the editor reads is no warning:
                                        // the version string is only a hint, what the save holds is what counts; `loaded.note`)
                                        const seen = versionGap(current.version, game);
                                        const gap = seen === 'minor' && !loaded.note ? 'patch' : seen;
                                        return (
                                            <span className={'save-chip' + (gap === 'minor' ? ' warn' : '')} title={gap && game ? gapTitle(current.version!, game, gap) : undefined}>
                                                {gap === 'minor' ? '⚠ ' : ''}{tr('version {v}', { v: current.version })}
                                            </span>
                                        );
                                    })()}
                                    {current && <span className="save-chip">{current.mods.length ? trn('{n} mod', '{n} mods', current.mods.length, { n: current.mods.length }) : tr('no mods')}</span>}
                                    {current?.binary && <span className="save-chip">{current.ironman ? tr('ironman') : tr('binary')} · {tr('converted')}</span>}
                                </div>
                                <div className="save-status">
                                    <span className="save-dot" />
                                    {state === 'busy' ?
                                        tr('Loading into the index…') :
                                        state === 'ok' ?
                                        tr('Loaded — the explorer and the map show this save') :
                                        tr('Not loaded: {problem}', { problem: loaded.problem ?? tr('see the index status') })}
                                </div>
                            </div>
                            <div className="save-hero-side">
                                <button className="primary" disabled={busy || indexing || !loaded.pending} onClick={() => void write()} title={tr('Writes the save with its changes to a new file next to the original')}>
                                    {tr('Write save as…')}</button>
                                <div className="save-hero-row">
                                    <button className="ghost small" disabled={busy || indexing || !loaded.edits?.length} onClick={() => void undoSaveEdit().then(refresh)}>{tr('Undo')}</button>
                                    <button className="ghost small" disabled={busy || indexing} onClick={() => void load(null)}>{tr('Unload')}</button>
                                </div>
                            </div>
                            {state === 'ok' && (
                                <div className="save-pending">
                                    {loaded.pending ?
                                        (
                                            <button className="link" onClick={() => setShowEdits(!showEdits)}>
                                                {trn('{n} change not written yet', '{n} changes not written yet', loaded.pending, { n: loaded.pending })} {showEdits ? '▴' : '▾'}
                                            </button>
                                        ) :
                                        <span className="dim">{tr('No changes yet — edit the save’s characters in the explorer (Savegame → Characters) or its counties on the map.')}</span>}
                                    {showEdits && !!loaded.edits?.length && <ol className="save-edits">{loaded.edits.map((x, i) => <li key={i}>{x}</li>)}</ol>}
                                </div>
                            )}
                            {state === 'ok' && loaded.note && <div className="save-note">{loaded.note}</div>}
                            {current && <SaveMods save={current} />}
                        </>
                    ) :
                    (
                        <div className="save-empty">
                            <div className="save-empty-mark">⚜</div>
                            <div>
                                <div className="save-hero-name">{tr('No save loaded')}</div>
                                <div className="dim">{tr('Choose one of your saves below, or open a save file from elsewhere.')}</div>
                            </div>
                        </div>
                    )}
            </section>

            {/* a binary save waiting for rakaly */}
            {ask && (
                <section className="save-binary">
                    <div className="save-binary-text">{tr('“{name}” is a binary save (an autosave or an ironman save). To open it, the app first converts it into a text save with rakaly — a separate open-source program that isn’t installed yet.', { name: ask.player ?? ask.name })}</div>
                    <RakalyTool onInstalled={() => void convertAndLoad(ask.file)} />
                    <div className="save-hero-row">
                        <button className="ghost small" onClick={() => setAsk(null)}>{tr('Cancel')}</button>
                    </div>
                </section>
            )}

            {/* the save files */}
            <section className="save-files">
                <div className="save-files-head">
                    <input className="save-filter" placeholder={tr('Filter saves…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
                    <span className="save-folder" title={list?.dir}>{list?.dir}</span>
                    <button className="ghost small" disabled={busy || indexing} onClick={() => void load()}>{tr('Open a save file…')}</button>
                    <button className="ghost small" onClick={refresh} title={tr('Read the folder again')}>↻</button>
                </div>
                {!list ?
                    <div className="save-none">{tr('Reading the saves…')}</div> :
                    !list.saves.length ?
                    <div className="save-none">{tr('No saves in this folder yet — save a game in Crusader Kings III, or open a save file from elsewhere.')}</div> :
                    !shown.length ?
                    <div className="save-none">{tr('No save matches “{filter}”', { filter })}</div> :
                    groups.filter(([, l]) => l.length).map(([label, l]) => (
                        <div key={label} className="save-group">
                            <div className="save-group-head">{label}<span className="dim"> · {l.length}</span></div>
                            {l.map((s) =>
                            {
                                const on = isLoaded(s);
                                const gap = versionGap(s.version, game);
                                return (
                                    <div key={s.file} className={'save-row' + (on ? ' on' : '') + (s.problem ? ' bad' : '')} title={s.file}>
                                        <div className="save-row-main">
                                            <div className="save-row-name">
                                                {s.player ?? s.name}
                                                {s.title && <span className="save-row-realm"> · {s.title}</span>}
                                                {s.ironman && <span className="save-badge">{tr('ironman')}</span>}
                                                {s.binary && !s.ironman && <span className="save-badge">{tr('binary')}</span>}
                                                {on && <span className="save-badge gold">{tr('loaded')}</span>}
                                            </div>
                                            <div className="save-row-meta">
                                                {s.date && <span className="save-row-date">{s.date}</span>}
                                                {s.version && <span className={gap === 'minor' ? 'save-row-warn' : undefined} title={gap && game ? gapTitle(s.version, game, gap) : undefined}>{gap === 'minor' ? '⚠ ' : ''}{s.version}</span>}
                                                {s.mods.length > 0 && <span>{trn('{n} mod', '{n} mods', s.mods.length, { n: s.mods.length })}</span>}
                                                <span>{sizeText(s.size)}</span>
                                                <span title={when(s.mtime)}>{ago(s.mtime)}</span>
                                                <span className="save-row-file">{s.name + '.ck3'}</span>
                                            </div>
                                        </div>
                                        <div className="save-row-act">
                                            {s.problem ?
                                                <span className="save-error" title={s.problem}>{tr('unreadable')}</span> :
                                                on ?
                                                null :
                                                converting && ask === null && busy ?
                                                <span className="dim">{tr('Converting…')}</span> :
                                                s.binary ?
                                                <button className="small" disabled={busy || indexing} title={tr('A binary save: converted to a text save with rakaly first')} onClick={() => void loadBinary(s)}>{tr('Load…')}</button> :
                                                <button className="small" disabled={busy || indexing} onClick={() => void load(s.file)}>{tr('Load')}</button>}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
            </section>
        </div>
    );
}
