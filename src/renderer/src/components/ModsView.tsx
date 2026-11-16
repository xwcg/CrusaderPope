import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MigrateChip } from './MigrateDialog';
import { MergeDialog } from './MergeDialog';
import { createPortal } from 'react-dom';
import type { IndexStatus, ModInfo, ModList, ModListEntry, ModsState, NewModRequest } from '../../../shared/api';
import { api } from '../api';
import { AddModsDialog, ConfirmDialog, DeleteModDialog, ModThumb, NewModDialog, PromptDialog, SOURCE_LABEL, StatusChip, SupportedChip, errorText, modWarning, type NewModTarget } from './ModDialogs';
import { hook } from '../testApi';
import '../styles/mods.css';
import { Select } from './Select';

import { tr } from '../../../shared/i18n';
import { fold, foldHas } from '../../../shared/fold';
/** Route type of the Mods page (App.tsx), not an index type. */
export const MODS_ROUTE = '@mods';
/** the "All mods" page of the view */
const LIBRARY = '@all';

const KIND_LABEL: Record<ModList['kind'], string> = { playset: tr('Launcher playset'), game: tr('Game list'), custom: tr('Custom list') };

interface Draft
{
    name: string;
    mods: ModListEntry[];
}

// survives leaving the page (navigation remounts the view): the viewed list and unsaved edits
const memory: { view?: string; drafts: Record<string, Draft>; } = { drafts: {} };

const byIdOf = (state: ModsState): Map<string, ModInfo> => new Map(state.mods.map((m) => [m.id.toLowerCase(), m]));

/** The enabled mods of a list in load order (the renderer's twin of manager.modsOfList). */
export function enabledMods(state: ModsState, ref: string): ModInfo[]
{
    const list = state.lists.find((l) => l.ref === ref);
    const byId = byIdOf(state);
    return (list?.mods ?? [])
        .filter((e) => e.enabled)
        .map((e) => byId.get(e.id.toLowerCase()))
        .filter((m): m is ModInfo => !!m);
}

const sameEntries = (a: ModListEntry[], b: ModListEntry[]): boolean => a.length === b.length && a.every((e, i) => e.id === b[i].id && e.enabled === b[i].enabled);

function listLabel(state: ModsState, ref: string): string
{
    if (ref === 'none')
        return tr('None — game only');

    return state.lists.find((l) => l.ref === ref)?.name ?? tr('Missing list');
}

/** Top bar: the list the explorer loads and the active mod; opens the Mods page. */
/** The Mods tab of the top bar: the loaded list, its mod count and the active mod at a glance. */
export function ModsTab(props: { state: ModsState | null; open: boolean; onClick: () => void; }): React.JSX.Element
{
    const s = props.state;
    const loaded = s ? enabledMods(s, s.selected) : [];
    const active = s?.activeMod ? s.mods.find((m) => m.id === s.activeMod) : undefined;
    const name = s ? (s.selected === 'none' ? tr('No mods') : listLabel(s, s.selected)) : '…';
    const tip = s
        ? [
            tr('Loaded in the explorer: {listLabel}', { listLabel: listLabel(s, s.selected) }),
            ...loaded.map((m, i) => `  ${i + 1}. ${m.name}`),
            tr('Active mod: {mod}', { mod: active?.name ?? (s.activeMod ? s.activeMod + tr(' (not found)') : tr('none')) }),
            '',
            tr('Manage mods and mod lists')
        ].join('\n')
        : tr('Manage mods and mod lists');
    return (
        <button className={'app-tab mods-tab' + (props.open ? ' on' : '')} onClick={props.onClick} title={tip}>
            <span className="mi-label">{tr('Mods')}</span>
            <span className="mi-list">{name}</span>
            {loaded.length > 0 && <span className="mi-count">{loaded.length}</span>}
            {active && <span className="mi-active">✎ {active.name}</span>}
        </button>
    );
}

interface Notice
{
    /** warn: nothing done, but no failure either ("Nothing written …") */
    kind: 'ok' | 'warn' | 'error';
    text: string;
}

export function ModsView(props: { state: ModsState | null; setState: (s: ModsState) => void; status: IndexStatus; }): React.JSX.Element
{
    const { state, setState } = props;
    const [view, setView] = useState<string | undefined>(memory.view);
    const [drafts, setDrafts] = useState<Record<string, Draft>>(memory.drafts);
    const [busy, setBusy] = useState<string | null>(null);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [dialog, setDialog] = useState<ReactNode>(null);

    useEffect(() =>
    {
        memory.view = view;
        memory.drafts = drafts;
    }, [view, drafts]);

    // mods may have changed on disk since the last look
    useEffect(() =>
    {
        void api
            .modsState()
            .then(setState)
            .catch((e) => setNotice({ kind: 'error', text: errorText(e) }));
    }, [setState]);

    // the test API (testApi.ts): the list shown, and another one
    const shownList = useRef<string | undefined>(undefined);
    useEffect(
        () =>
            hook('mods', {
                view: (ref) =>
                {
                    setView(ref);
                    setNotice(null);
                },
                state: () => shownList.current
            }),
        []
    );

    if (!state)
        return <div className="mods-page loading">{tr('Reading mods…')}</div>;

    const lists = state.lists;
    const viewRef = view && (view === LIBRARY || view === 'none' || lists.some((l) => l.ref === view)) ? view : defaultView(state);
    shownList.current = viewRef;
    const closeDialog = (): void => setDialog(null);
    // another list picked by hand: the last operation's message belonged to the previous one
    const open = (ref: string): void =>
    {
        setView(ref);
        setNotice(null);
    };

    /** Runs an operation: one at a time, its message or error in the notice bar. */
    const run = async (label: string, fn: () => Promise<string | Notice | void>): Promise<boolean> =>
    {
        setBusy(label);
        setNotice(null);

        try
        {
            const msg = await fn();

            if (msg)
                setNotice(typeof msg === 'string' ? { kind: 'ok', text: msg } : msg);

            return true;
        }
        catch (e)
        {
            setNotice({ kind: 'error', text: errorText(e) });
            return false;
        }
        finally
        {
            setBusy(null);
        }
    };
    const dropDraft = (ref: string): void =>
        setDrafts((d) =>
        {
            if (!(ref in d))
                return d;

            const next = { ...d };
            delete next[ref];
            return next;
        });
    /** the ref of the custom list a save created */
    const newListRef = (next: ModsState): string | undefined => next.lists.find((l) => l.kind === 'custom' && !lists.some((o) => o.ref === l.ref))?.ref;

    const select = (ref: string): void =>
        void run(tr('Loading into the explorer…'), async () =>
        {
            const next = await api.selectModList(ref);
            setState(next);
            // (the returned state: a save just before may have renamed the list)
            return ref === 'none' ? tr('The explorer shows the game without mods.') : tr('“{listLabel}” is loaded into the explorer.', { listLabel: listLabel(next, ref) });
        });

    const setActive = (id: string | null): void =>
        void run(tr('Setting the active mod…'), async () =>
        {
            setState(await api.setActiveMod(id));
        });

    const modActions: ModActions = {
        setActive,
        pack: (m) =>
        {
            const pack = (overwrite: boolean): void =>
                void run(tr('Packing {name}…', { name: m.name }), async () =>
                {
                    const r = await api.packMod(m.id, overwrite);

                    if (!r.exists)
                        return tr('Packed {files} {plural} into {file}.', { files: r.files, plural: r.files === 1 ? 'file' : 'files', file: r.file });

                    // a zip from an earlier pack (or an upload) is there: ask before replacing it
                    setDialog(
                        <ConfirmDialog title={tr('Replace the zip of “{name}”?', { name: m.name })} confirm={tr('Replace')} danger onClose={closeDialog} onConfirm={() => pack(true)}>
                            <p>
                                <code>{r.file}</code> {' '}{tr('exists already. Packing again replaces it with the mod folder\'s current files.')}</p>
                        </ConfirmDialog>
                    );
                    return undefined;
                });
            pack(false);
        },
        unpack: (m) =>
            setDialog(
                <ConfirmDialog
                    title={tr('Unpack “{name}”?', { name: m.name })}
                    confirm={tr('Unpack')}
                    onClose={closeDialog}
                    onConfirm={() =>
                        void run(tr('Unpacking {name}…', { name: m.name }), async () =>
                        {
                            const r = await api.unpackMod(m.id);
                            setState(await api.modsState());
                            return tr('Unpacked {files} {plural} into {dir}; the mod\'s descriptor points there now.', { files: r.files, plural: r.files === 1 ? 'file' : 'files', dir: r.dir });
                        })}
                >
                    <p>
                        {tr('The zip is extracted into a folder in your mod folder ({userDir}\\mod\\…) and the mod\'s descriptor is changed to point to that folder (', { userDir: state.userDir })}<code>path=</code> {' '}{tr('instead of')}{' '}<code>archive=</code>{tr('). The zip itself stays where it is.')}</p>
                </ConfirmDialog>
            ),
        fixLocation: (m) =>
            setDialog(
                <ConfirmDialog
                    title={tr('Point “{name}”’s descriptor to where it is?', { name: m.name })}
                    confirm={tr('Fix the path')}
                    onClose={closeDialog}
                    onConfirm={() =>
                        void run(tr('Fixing {name}…', { name: m.name }), async () =>
                        {
                            const r = await api.fixModLocation(m.id);
                            setState(await api.modsState());
                            return tr('{descriptor} points to {location} now. The old one: {backup}', r);
                        })}
                >
                    <p>
                        {tr('Its descriptor ({descriptorFile}) says the mod is in {stale}, but it was found in {found}. The game and the launcher look where the descriptor says; the launcher can’t register it until it is right.', { descriptorFile: m.descriptorFile, stale: m.staleLocation, found: m.root ?? m.archive })}</p>
                    <p>{tr('The descriptor is copied to crusaderpope-backups first.')}</p>
                </ConfirmDialog>
            ),
        openFolder: (m) =>
            void run(tr('Opening…'), async () =>
            {
                await api.openModFolder(m.id);
            }),
        remove: (m) =>
            setDialog(
                <DeleteModDialog
                    mod={m}
                    onClose={closeDialog}
                    onDelete={() =>
                        void run(tr('Deleting {name}…', { name: m.name }), async () =>
                        {
                            const { state: next, result } = await api.deleteMod(m.id);
                            setState(next);
                            return result.trashed ? tr('“{name}” is in the Recycle Bin.', { name: m.name }) : tr('“{name}” is deleted.', { name: m.name });
                        })}
                />
            )
    };

    const newMod = (): void =>
    {
        const loadedCustom = state.lists.find((l) => l.ref === state.selected && l.kind === 'custom');
        const viewedCustom = lists.find((l) => l.ref === viewRef && l.kind === 'custom');
        setDialog(
            <NewModDialog
                state={state}
                defaultTarget={viewedCustom?.ref ?? loadedCustom?.ref ?? 'new'}
                onClose={closeDialog}
                onCreate={async (req: NewModRequest, target: NewModTarget) =>
                {
                    // (a failure here stays in the dialog)
                    let next = await api.createMod(req);
                    const created = tr('Created “{name}” in {userDir}\\mod\\{folder} — it is the active mod.', { name: req.name, userDir: next.userDir, folder: req.folder });
                    const entry = { id: `mod/${req.folder}.mod`, enabled: true };
                    let show = LIBRARY;

                    try
                    {
                        if (target === 'new')
                        {
                            next = await api.saveModList({ name: req.name, mods: [entry] });
                            show = newListRef(next) ?? LIBRARY;
                        }
                        else if (target)
                        {
                            const saved = next.lists.find((l) => l.ref === target);

                            if (saved)
                            {
                                next = await api.saveModList({ ref: target, name: saved.name, mods: [...saved.mods, entry] });
                                // unsaved edits of that list get the mod too
                                setDrafts((d) => (d[target] ? { ...d, [target]: { ...d[target], mods: [...d[target].mods, entry] } } : d));
                                show = target;
                            }
                        }

                        setNotice({ kind: 'ok', text: created + (target && next.selected === show ? tr(' Its list is loaded: the explorer re-indexes.') : '') });
                    }
                    catch (e)
                    {
                        // the mod exists: report the list error on the page
                        setNotice({ kind: 'error', text: tr('{created} Adding it to the list failed: {errorText}', { created, errorText: errorText(e) }) });
                    }

                    setState(next);
                    setView(show);
                }}
            />
        );
    };

    const newList = (): void =>
        setDialog(
            <PromptDialog
                title={tr('New mod list')}
                label={tr('Name')}
                initial={tr('New list')}
                confirm={tr('Create list')}
                onClose={closeDialog}
                onConfirm={(name) =>
                    void run(tr('Creating the list…'), async () =>
                    {
                        const next = await api.saveModList({ name, mods: [] });
                        setState(next);
                        setView(newListRef(next));
                    })}
            />
        );

    return (
        <div className="mods-page">
            <aside className="mods-lists">
                <div className="ml-head">
                    <h2>{tr('Mods')}</h2>
                    {state.gameVersion && <span className="ml-game">{tr('game {gameVersion}', { gameVersion: state.gameVersion })}</span>}
                </div>
                <div className="ml-loaded">
                    <label>{tr('Loaded in the explorer')}</label>
                    <Select value={state.selected} disabled={!!busy} onChange={(e) => select(e.target.value)}>
                        <option value="none">{tr('None — game only')}</option>
                        {!lists.some((l) => l.ref === state.selected) && state.selected !== 'none' && <option value={state.selected}>{tr('Missing list')}</option>}
                        {lists.some((l) => l.kind === 'playset') && (
                            <optgroup label={tr('Launcher playsets')}>
                                {lists
                                    .filter((l) => l.kind === 'playset')
                                    .map((l) => (
                                        <option key={l.ref} value={l.ref}>
                                            {l.name}
                                            {l.active ? tr(' (launcher’s active playset)') : ''}
                                        </option>
                                    ))}
                            </optgroup>
                        )}
                        {lists
                            .filter((l) => l.kind === 'game')
                            .map((l) => (
                                <option key={l.ref} value={l.ref}>
                                    {l.name}
                                </option>
                            ))}
                        {lists.some((l) => l.kind === 'custom') && (
                            <optgroup label={tr('Custom lists')}>
                                {lists
                                    .filter((l) => l.kind === 'custom')
                                    .map((l) => (
                                        <option key={l.ref} value={l.ref}>
                                            {l.name}
                                        </option>
                                    ))}
                            </optgroup>
                        )}
                    </Select>
                    <IndexLine status={props.status} />
                </div>
                <div className="ml-scroll">
                    <ListItem label={tr('None — game only')} count={null} active={viewRef === 'none'} loaded={state.selected === 'none'} onClick={() => open('none')} />
                    <div className="ml-section">{tr('Launcher playsets')}</div>
                    {!state.launcher && <div className="ml-empty">{tr('The launcher database (launcher-v2.sqlite) was not found or could not be read.')}</div>}
                    {lists
                        .filter((l) => l.kind === 'playset')
                        .map((l) => <ListItem key={l.ref} list={l} state={state} dirty={isDirty(l, drafts[l.ref])} active={viewRef === l.ref} onClick={() => open(l.ref)} />)}
                    <div className="ml-section">{tr('Game')}</div>
                    {lists
                        .filter((l) => l.kind === 'game')
                        .map((l) => <ListItem key={l.ref} list={l} state={state} dirty={isDirty(l, drafts[l.ref])} active={viewRef === l.ref} onClick={() => open(l.ref)} />)}
                    {!lists.some((l) => l.kind === 'game') && <div className="ml-empty">{tr('No dlc_load.json yet (the launcher writes it when you press Play).')}</div>}
                    <div className="ml-section">
                        {tr('Custom lists')}<button className="ghost ml-add" onClick={newList} disabled={!!busy} title={tr('A new, empty list kept by this app')}>
                            {tr('+ New')}</button>
                    </div>
                    {lists
                        .filter((l) => l.kind === 'custom')
                        .map((l) => <ListItem key={l.ref} list={l} state={state} dirty={isDirty(l, drafts[l.ref])} active={viewRef === l.ref} onClick={() => open(l.ref)} />)}
                    {!lists.some((l) => l.kind === 'custom') && <div className="ml-empty">{tr('Lists kept by this app — e.g. a playset plus the mod you are writing.')}</div>}
                    <div className="ml-section">{tr('Library')}</div>
                    <ListItem label={tr('All mods')} count={state.mods.length} active={viewRef === LIBRARY} onClick={() => open(LIBRARY)} />
                </div>
                <ActiveModBox state={state} busy={!!busy} actions={modActions} onNew={newMod} />
            </aside>
            <section className="mods-main">
                {busy && <div className="mods-busy">{busy}</div>}
                {notice && (
                    <div className={'mods-notice ' + notice.kind}>
                        <span>{notice.text}</span>
                        <button className="ghost" onClick={() => setNotice(null)} title={tr('Dismiss')}>
                            ✕
                        </button>
                    </div>
                )}
                {viewRef === 'none' ? <NonePage state={state} busy={!!busy} onLoad={() => select('none')} /> : viewRef === LIBRARY ? <LibraryPage state={state} actions={modActions} onNew={newMod} busy={!!busy} /> : (
                    <ListEditor
                        key={viewRef}
                        state={state}
                        list={lists.find((l) => l.ref === viewRef)!}
                        draft={drafts[viewRef]}
                        busy={!!busy}
                        actions={modActions}
                        setDraft={(d) => setDrafts((all) => ({ ...all, [viewRef]: d }))}
                        dropDraft={() => dropDraft(viewRef)}
                        run={run}
                        setState={setState}
                        setView={setView}
                        setDialog={setDialog}
                        newListRef={newListRef}
                        select={select}
                    />
                )}
            </section>
            {dialog}
        </div>
    );
}

function defaultView(state: ModsState): string
{
    if (state.selected !== 'none' && state.lists.some((l) => l.ref === state.selected))
        return state.selected;

    return state.lists.find((l) => l.active)?.ref ?? state.lists[0]?.ref ?? LIBRARY;
}

function isDirty(list: ModList, draft: Draft | undefined): boolean
{
    return !!draft && (!sameEntries(draft.mods, list.mods) || draft.name !== list.name);
}

function IndexLine({ status }: { status: IndexStatus; }): React.JSX.Element
{
    if (status.state === 'indexing')
        return <div className="ml-index busy">{tr('Indexing — {phase}…', { phase: status.phase })}</div>;

    if (status.state === 'error')
        return <div className="ml-index bad">{tr('The index could not be built.')}</div>;

    if (status.state === 'ready' && status.stats)
        return <div className="ml-index">{tr('Index ready · {files} files', { files: status.stats.files.toLocaleString() })}</div>;

    return <div className="ml-index" />;
}

function ListItem(props: { list?: ModList; state?: ModsState; label?: string; count?: number | null; dirty?: boolean; active: boolean; loaded?: boolean; onClick: () => void; }): React.JSX.Element
{
    const { list, state } = props;
    const loaded = props.loaded ?? (!!list && state?.selected === list.ref);
    const enabled = list ? list.mods.filter((e) => e.enabled).length : props.count;
    return (
        <div className={'ml-item' + (props.active ? ' active' : '')} onClick={props.onClick} title={list ? tr('{KIND_LABEL}: {modsCount} mods, {modsCount2} enabled', { KIND_LABEL: KIND_LABEL[list.kind], modsCount: list.mods.length, modsCount2: list.mods.filter((e) => e.enabled).length }) : undefined}>
            <span className="ml-name">{list?.name ?? props.label}</span>
            {props.dirty && (
                <span className="ml-dirty" title={tr('Unsaved changes')}>
                    ●
                </span>
            )}
            {list?.active && (
                <span className="ml-badge launcher" title={tr('The Paradox Launcher\'s active playset')}>
                    {tr('launcher')}</span>
            )}
            {loaded && (
                <span className="ml-badge loaded" title={tr('Loaded in the explorer')}>
                    {tr('loaded')}</span>
            )}
            {enabled !== null && enabled !== undefined && <span className="ml-count">{enabled}</span>}
        </div>
    );
}

interface ModActions
{
    setActive: (id: string | null) => void;
    pack: (m: ModInfo) => void;
    unpack: (m: ModInfo) => void;
    fixLocation: (m: ModInfo) => void;
    openFolder: (m: ModInfo) => void;
    remove: (m: ModInfo) => void;
}

function ActiveModBox(props: { state: ModsState; busy: boolean; actions: ModActions; onNew: () => void; }): React.JSX.Element
{
    const { state } = props;
    const active = state.activeMod ? state.mods.find((m) => m.id === state.activeMod) : undefined;
    return (
        <div className="ml-foot">
            <label>{tr('Active mod — the one you edit')}</label>
            {active ?
                (
                    <div className="ml-active">
                        <ModThumb mod={active} size="small" />
                        <div className="ml-active-name" title={active.root}>
                            {active.name}
                            <small>{active.id}</small>
                        </div>
                    </div>
                ) :
                <div className="ml-active none">{state.activeMod ? tr('{activeMod} (not found)', { activeMod: state.activeMod }) : tr('None')}</div>}
            <div className="ml-foot-actions">
                <button className="primary" onClick={props.onNew} disabled={props.busy || !state.userDirFound}>
                    {tr('New mod…')}</button>
                {active && (
                    <button onClick={() => props.actions.openFolder(active)} disabled={props.busy}>
                        {tr('Open folder')}</button>
                )}
                {state.activeMod && (
                    <button className="ghost" onClick={() => props.actions.setActive(null)} disabled={props.busy} title={tr('No active mod')}>
                        {tr('Clear')}</button>
                )}
            </div>
            <div className={'ml-userdir' + (state.userDirFound ? '' : ' bad')} title={tr('The CK3 user folder (settings.json: userDir)')}>
                {state.userDirFound ? state.userDir : tr('User folder not found: {userDir}', { userDir: state.userDir })}
            </div>
        </div>
    );
}

function NonePage(props: { state: ModsState; busy: boolean; onLoad: () => void; }): React.JSX.Element
{
    const loaded = props.state.selected === 'none';
    return (
        <div className="me">
            <header className="me-head">
                <div className="me-kicker">
                    <span className="chip">{tr('No mod list')}</span>
                    {loaded && <span className="chip ok">{tr('Loaded in the explorer')}</span>}
                </div>
                <h1>{tr('None — game only')}</h1>
                <div className="me-sub">{tr('The explorer indexes the game without any mods.')}</div>
                <div className="me-actions">
                    <button className="primary" disabled={loaded || props.busy} onClick={props.onLoad}>
                        {loaded ? tr('Loaded in the explorer') : tr('Load into explorer')}
                    </button>
                </div>
            </header>
        </div>
    );
}

function LibraryPage(props: { state: ModsState; actions: ModActions; busy: boolean; onNew: () => void; }): React.JSX.Element
{
    const { state } = props;
    const [q, setQ] = useState('');
    const mods = useMemo(() =>
    {
        const f = fold(q.trim());
        return state.mods
            .filter((m) => !f || [m.name, m.id, m.version ?? '', SOURCE_LABEL[m.source], ...m.tags].some((s) => foldHas(s, f)))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [state.mods, q]);
    const inLists = (m: ModInfo): string[] => state.lists.filter((l) => l.mods.some((e) => e.id.toLowerCase() === m.id.toLowerCase())).map((l) => l.name);
    return (
        <div className="me">
            <header className="me-head">
                <div className="me-kicker">
                    <span className="chip">{tr('Library')}</span>
                </div>
                <h1>{tr('All mods')}</h1>
                <div className="me-sub">
                    {tr('{modsCount} mods: descriptors in your mod folder, the launcher\'s mods and Steam Workshop folders. {modsCount2} can be edited here (unpacked in your mod folder).', { modsCount: state.mods.length, modsCount2: state.mods.filter((m) => m.editable).length })}</div>
                <div className="me-actions">
                    <input className="mods-search" placeholder={tr('Filter by name, tag, source…')} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
                    <span style={{ flex: 1 }} />
                    <button className="primary" onClick={props.onNew} disabled={props.busy || !state.userDirFound}>
                        {tr('New mod…')}</button>
                </div>
            </header>
            <div className="me-rows">
                {mods.map((m) => <ModRow key={m.id} entry={{ id: m.id, enabled: true }} mod={m} state={state} actions={props.actions} busy={props.busy} note={inLists(m).length ? tr('in ') + inLists(m).join(', ') : tr('in no list')} />)}
            </div>
        </div>
    );
}

function ListEditor(props: {
    state: ModsState;
    list: ModList;
    draft?: Draft;
    busy: boolean;
    actions: ModActions;
    setDraft: (d: Draft) => void;
    dropDraft: () => void;
    run: (label: string, fn: () => Promise<string | Notice | void>) => Promise<boolean>;
    setState: (s: ModsState) => void;
    setView: (ref: string | undefined) => void;
    setDialog: (d: ReactNode) => void;
    newListRef: (next: ModsState) => string | undefined;
    select: (ref: string) => void;
}): React.JSX.Element
{
    const { state, list, run, setState, setDialog } = props;
    const current: Draft = props.draft ?? { name: list.name, mods: list.mods };
    const dirty = isDirty(list, props.draft);
    const loaded = state.selected === list.ref;
    const custom = list.kind === 'custom';
    const byId = useMemo(() => byIdOf(state), [state]);
    const game = state.gameVersion;
    const [drag, setDrag] = useState<{ from: number; over: number | null; } | null>(null);
    const [adding, setAdding] = useState(false);
    const closeDialog = (): void => setDialog(null);

    const edit = (mods: ModListEntry[], name = current.name): void => props.setDraft({ name, mods });
    const move = (from: number, to: number): void =>
    {
        // `to` = insertion point before removal
        const mods = [...current.mods];
        const [e] = mods.splice(from, 1);
        mods.splice(to > from ? to - 1 : to, 0, e);
        edit(mods);
    };
    const enabled = current.mods.filter((e) => e.enabled);
    const warnings = enabled.map((e) => modWarning(byId.get(e.id.toLowerCase()), game)).filter(Boolean).length;
    const inList = new Set(current.mods.map((e) => e.id.toLowerCase()));
    // row keys: the id (a list read from the launcher could name a mod twice)
    const seen = new Map<string, number>();
    const keys = current.mods.map((e) =>
    {
        const n = (seen.get(e.id) ?? 0) + 1;
        seen.set(e.id, n);
        return n === 1 ? e.id : `${e.id}#${n}`;
    });
    // where a dragged row would land; none when dropping it there changes nothing
    const dropAt = drag && drag.over !== null && drag.over !== drag.from && drag.over !== drag.from + 1 ? drag.over : null;

    const save = (): Promise<boolean> =>
        run(tr('Saving…'), async () =>
        {
            setState(await api.saveModList({ ref: list.ref, name: current.name, mods: current.mods }));
            props.dropDraft();
            return tr('Saved “{name}”.{loadedNote}', { name: current.name.trim() || 'Unnamed list', loadedNote: loaded ? tr(' It is loaded: the explorer re-indexes when its mods changed.') : '' });
        });

    const load = (): void =>
    {
        if (custom && dirty)
            void save().then((ok) => ok && props.select(list.ref));
        else
            props.select(list.ref);
    };

    const saveAs = (): void =>
        setDialog(
            <PromptDialog
                title={tr('Save as a new list')}
                label={tr('Name of the new custom list')}
                initial={tr('{name} (copy)', { name: current.name })}
                confirm={tr('Save list')}
                onClose={closeDialog}
                onConfirm={(name) =>
                    void run(tr('Saving…'), async () =>
                    {
                        const next = await api.saveModList({ name, mods: current.mods });
                        setState(next);
                        props.dropDraft();
                        props.setView(props.newListRef(next));
                        return tr('Saved as “{name}”.', { name });
                    })}
            />
        );

    const remove = (): void =>
        setDialog(
            <ConfirmDialog
                title={tr('Delete “{name}”?', { name: list.name })}
                confirm={tr('Delete list')}
                danger
                onClose={closeDialog}
                onConfirm={() =>
                    void run(tr('Deleting…'), async () =>
                    {
                        setState(await api.deleteModList(list.ref));
                        props.dropDraft();
                        props.setView(undefined);
                        return tr('Deleted “{name}”.{loadedNote}', { name: list.name, loadedNote: loaded ? tr(' The explorer shows the game without mods now.') : '' });
                    })}
            >
                <p>{tr('This removes the app\'s own list. No mod files, playsets or game files are touched.')}</p>
            </ConfirmDialog>
        );

    const sep = state.userDir?.includes('\\') ? '\\' : '/';
    const backups = `${(state.userDir ?? '').replace(/[\\/]+$/, '')}${sep}crusaderpope-backups`;
    // (as manager.ts `registrable`: local mods of the user's mod folder the launcher has not registered)
    const unregistered = current.mods.map((e) => byId.get(e.id.toLowerCase())).filter((m) => m && !m.launcherId && m.source === 'local' && m.status === 'ok' && m.descriptorFile && /^mod\/[^/\\]+\.mod$/i.test(m.id));
    const toLauncher = (launcherClosed: boolean): Promise<boolean> =>
        run(tr('Writing the launcher playset…'), async () =>
        {
            const r = await api.writeModList(list.ref, 'launcher', current.mods, launcherClosed ? { launcherClosed } : undefined);

            // nothing written: the process list could not be read; the user may say the launcher is closed
            if (r.unchecked)
            {
                setDialog(
                    <ConfirmDialog title={tr('Is the Paradox Launcher closed?')} confirm={tr('It is closed — write')} danger onClose={closeDialog} onConfirm={() => void toLauncher(true)}>
                        <p>{r.unchecked}</p>
                        <p>{tr('Write only when the Paradox Launcher is not running: it keeps its playsets in memory and would overwrite the change (or be confused by it). The database is backed up first either way.')}</p>
                    </ConfirmDialog>
                );
                return { kind: 'warn' as const, text: tr('Nothing written — the app could not check whether the Paradox Launcher is running.') };
            }

            setState(await api.modsState());
            props.dropDraft();
            const reg = r.registered?.length ? tr(' Registered in the launcher: {registered}.', { registered: r.registered.join(', ') }) : '';
            return tr('Written to the launcher playset “{name}”.{reg} Backup of the launcher database: {backup}', { name: list.name, reg, backup: r.backup });
        });

    const writeLauncher = (): void =>
        setDialog(
            <ConfirmDialog title={tr('Write “{name}” to the Paradox Launcher?', { name: list.name })} confirm={tr('Write to launcher')} onClose={closeDialog} onConfirm={() => void toLauncher(false)}>
                <p>
                    {tr('The playset\'s mods, their order and enabled flags are replaced with this list ({modsCount} mods, {enabledCount} enabled).', { modsCount: current.mods.length, enabledCount: enabled.length })}</p>
                {unregistered.length > 0 && (
                    <p>
                        {tr('The launcher has not registered {unregistered} yet: the app adds', { unregistered: unregistered.map((m) => `“${m!.name}”`).join(', ') })}{' '}{unregistered.length === 1 ? 'it' : 'them'} {' '}{tr('to its mod list, as the launcher does when it finds a new mod.')}</p>
                )}
                <p>
                    {tr('The launcher database is copied first to')}{' '}<code>{backups}</code> {' '}{tr('(the last 10 copies are kept). Close the Paradox Launcher before writing — it keeps its playsets in memory.')}</p>
                {list.sync && (
                    <p className="wizard-warn">
                        {tr('This playset is synced with your Paradox account ({state}{when}). The launcher may replace the change with the copy in the cloud the next time it syncs — the app does not change the sync data. To keep the change for sure: turn off syncing for this playset in the launcher first, or write to a playset that is not synced.', { state: list.sync.state ?? tr('cloud id {id}', { id: list.sync.pdxId ?? '?' }), when: list.sync.syncedOn ? tr(', last synced {date}', { date: list.sync.syncedOn }) : '' })}</p>
                )}
            </ConfirmDialog>
        );

    const writeGame = (): void =>
        setDialog(
            <ConfirmDialog
                title={tr('Write to the game list (dlc_load.json)?')}
                confirm={tr('Write game list')}
                onClose={closeDialog}
                onConfirm={() =>
                    void run(tr('Writing dlc_load.json…'), async () =>
                    {
                        const r = await api.writeModList(list.ref, 'game', current.mods);
                        setState(await api.modsState());

                        if (list.kind === 'game')
                            props.dropDraft();

                        return tr('Written {enabledCount} mods to dlc_load.json.{backup}', { enabledCount: enabled.length, backup: r.backup ? ' Backup: ' + r.backup : '' });
                    })}
            >
                <p>
                    {tr('The {enabledCount} enabled mods of “{name}” become the mods the game loads when started without the launcher, in this order. The launcher replaces this list with its playset when you press Play.', { enabledCount: enabled.length, name: current.name })}</p>
                <p>
                    {tr('The current file is copied first to')}{' '}<code>{backups}</code> {' '}{tr('(the last 10 copies are kept).')}</p>
            </ConfirmDialog>
        );

    const dirtyText = custom
        ? tr('Save to keep them.')
        : list.kind === 'playset'
        ? tr('Write them to the launcher playset, or save them as a new list.')
        : tr('Write them to the game list, or save them as a new list.');

    return (
        <div className="me">
            <header className="me-head">
                <div className="me-kicker">
                    <span className="chip">{KIND_LABEL[list.kind]}</span>
                    {list.sync && (
                        <span className="chip" title={tr('Synced with your Paradox account ({state}) — the launcher may bring back the cloud copy after a change written here', { state: list.sync.state ?? list.sync.pdxId ?? '?' })}>
                            {tr('☁ synced')}
                        </span>
                    )}
                    {list.active && <span className="chip accent">{tr('Active in the launcher')}</span>}
                    {loaded && <span className="chip ok">{tr('Loaded in the explorer')}</span>}
                    {list.kind === 'game' && <span className="chip">dlc_load.json</span>}
                </div>
                <h1>
                    {custom ? <input className="me-name" value={current.name} disabled={props.busy} onChange={(e) => edit(current.mods, e.target.value)} spellCheck={false} title={tr('Rename the list')} /> : (
                        list.name
                    )}
                    {dirty && (
                        <span className="me-dirty-mark" title={tr('Unsaved changes')}>
                            ●
                        </span>
                    )}
                </h1>
                <div className="me-sub">
                    {current.mods.length} {current.mods.length === 1 ? 'mod' : 'mods'} {' '}{tr('· {enabledCount} enabled', { enabledCount: enabled.length })}{warnings > 0 && <span className="warn-text">{' '}{tr('· {warnings} with warnings', { warnings })}</span>} {' '}{tr('· load order top to bottom, later mods win')}</div>
                <div className="me-actions">
                    <button className="primary" disabled={props.busy || (loaded && !dirty)} onClick={load} title={loaded && dirty && !custom ? tr('The saved list is loaded') : undefined}>
                        {loaded && !dirty ? tr('Loaded in the explorer') : custom && dirty ? tr('Save & load into explorer') : dirty ? tr('Load saved version') : tr('Load into explorer')}
                    </button>
                    {custom && (
                        <button disabled={props.busy || !dirty} onClick={() => void save()}>
                            {tr('Save')}</button>
                    )}
                    <button disabled={props.busy} onClick={saveAs}>
                        {tr('Save as new list…')}</button>
                    {list.kind === 'playset' && (
                        <button disabled={props.busy || !state.launcher} onClick={writeLauncher}>
                            {tr('Write to launcher playset…')}</button>
                    )}
                    <button disabled={props.busy} onClick={writeGame} title={tr('Make these the mods the game loads when started directly')}>
                        {tr('Write to game list (dlc_load.json)…')}</button>
                    {current.mods.filter((m) => m.enabled).length >= 2 && (
                        <button
                            disabled={props.busy || dirty}
                            onClick={() => setDialog(<MergeDialog state={state} listRef={list.ref} onDone={setState} onClose={closeDialog} />)}
                            title={dirty ? tr('Save the list first') : tr('Its enabled mods, in this order, copied into one new mod')}>
                            {tr('Merge into one mod…')}</button>
                    )}
                    {custom && (
                        <button className="danger" disabled={props.busy} onClick={remove}>
                            {tr('Delete list')}</button>
                    )}
                    <span style={{ flex: 1 }} />
                    <button disabled={props.busy} onClick={() => setAdding(true)}>
                        {tr('+ Add mods')}</button>
                </div>
            </header>
            {dirty && (
                <div className="me-dirty">
                    <span>{tr('● Unsaved changes. {dirtyText}', { dirtyText })}</span>
                    <button onClick={props.dropDraft} disabled={props.busy}>
                        {tr('Discard changes')}</button>
                </div>
            )}
            <div className="me-rows">
                {current.mods.length === 0 && <div className="list-empty">{tr('No mods in this list yet — “+ Add mods” picks from every mod found.')}</div>}
                {current.mods.map((e, i) => (
                    <ModRow
                        key={keys[i]}
                        entry={e}
                        mod={byId.get(e.id.toLowerCase())}
                        state={state}
                        index={i}
                        count={current.mods.length}
                        actions={props.actions}
                        busy={props.busy}
                        drop={dropAt === i ? 'before' : dropAt === i + 1 && i === current.mods.length - 1 ? 'after' : undefined}
                        onToggle={() => edit(current.mods.map((x, j) => (j === i ? { ...x, enabled: !x.enabled } : x)))}
                        onMove={(to) => move(i, to)}
                        onRemove={() => edit(current.mods.filter((_, j) => j !== i))}
                        onDragStart={() => setDrag({ from: i, over: null })}
                        onDragOver={(after) => setDrag((d) => (d ? { ...d, over: after ? i + 1 : i } : d))}
                        onDrop={() =>
                        {
                            if (drag && dropAt !== null)
                                move(drag.from, dropAt);

                            setDrag(null);
                        }}
                        onDragEnd={() => setDrag(null)}
                    />
                ))}
            </div>
            {adding && <AddModsDialog state={state} listName={current.name} inList={inList} onAdd={(id) => edit([...current.mods, { id, enabled: true }])} onClose={() => setAdding(false)} />}
        </div>
    );
}

function ModRow(props: {
    entry: ModListEntry;
    mod?: ModInfo;
    state: ModsState;
    actions: ModActions;
    busy: boolean;
    /** list rows (absent in the library) */
    index?: number;
    count?: number;
    note?: string;
    drop?: 'before' | 'after';
    onToggle?: () => void;
    onMove?: (to: number) => void;
    onRemove?: () => void;
    onDragStart?: () => void;
    onDragOver?: (after: boolean) => void;
    onDrop?: () => void;
    onDragEnd?: () => void;
}): React.JSX.Element
{
    const { entry, mod, state } = props;
    const inList = props.index !== undefined;
    const i = props.index ?? 0;
    const active = !!mod && state.activeMod === mod.id;
    const [menu, setMenu] = useState<{ x: number; y: number; } | null>(null);
    return (
        <div
            className={'mod-row' + (inList && !entry.enabled ? ' off' : '') + (props.drop ? ' drop-' + props.drop : '') + (active ? ' active-mod' : '')}
            draggable={inList && !props.busy}
            onDragStart={(e) =>
            {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', entry.id);
                props.onDragStart?.();
            }}
            onDragOver={(e) =>
            {
                if (!inList)
                    return;

                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                props.onDragOver?.(e.clientY > r.top + r.height / 2);
            }}
            onDrop={(e) =>
            {
                e.preventDefault();
                props.onDrop?.();
            }}
            onDragEnd={props.onDragEnd}
        >
            {inList && (
                <>
                    <span className="mr-grip" title={tr('Drag to reorder')}>
                        ⋮⋮
                    </span>
                    <span className="mr-pos">{i + 1}</span>
                    <input
                        type="checkbox"
                        checked={entry.enabled}
                        disabled={props.busy}
                        onChange={props.onToggle}
                        title={entry.enabled ? tr('Enabled — click to disable') : tr('Disabled — click to enable')}
                    />
                </>
            )}
            <ModThumb mod={mod} />
            <div className="mr-main">
                <div className="mr-line1">
                    <span className="mr-name">{mod?.name ?? entry.id}</span>
                    {mod?.version && <span className="mr-version">v{mod.version}</span>}
                    {active && <span className="chip accent">{tr('✎ active mod')}</span>}
                </div>
                {mod ?
                    (
                        <div className="mr-chips">
                            <span className="chip">{SOURCE_LABEL[mod.source]}</span>
                            <StatusChip mod={mod} />
                            <SupportedChip mod={mod} game={state.gameVersion} />
                            <MigrateChip mod={mod} game={state.gameVersion} disabled={props.busy} />
                            {mod.patchFor?.obsolete && (
                                <span className="chip bad" title={tr('{name} now says it supports the game’s version: its own files are for it, and this patch mod’s older copies on top of them override them. Take the patch mod out of the list (✕) or delete it.', { name: mod.patchFor.name })}>
                                    {tr('patch not needed any more')}</span>
                            )}
                            {mod.editable && <span className="chip ok" title={tr('Unpacked in your mod folder: can be edited, packed, be the active mod')}>{tr('editable')}</span>}
                            {mod.replacePaths.length > 0 && (
                                <span className="chip" title={tr('replace_path — the game’s and earlier mods’ files directly in these folders are ignored:\n') + mod.replacePaths.join('\n')}>
                                    {tr('replaces {replacePathsCount}', { replacePathsCount: mod.replacePaths.length })} {mod.replacePaths.length === 1 ? 'folder' : 'folders'}
                                </span>
                            )}
                            {mod.staleLocation && (
                                <button
                                    className="chip bad"
                                    disabled={props.busy}
                                    onClick={() => props.actions.fixLocation(mod)}
                                    title={tr('Its descriptor points to {stale}, but the mod is in {found} — click to fix the path (the launcher can’t register it until then)', { stale: mod.staleLocation, found: mod.root ?? mod.archive })}
                                >
                                    {tr('path outdated — fix')}
                                </button>
                            )}
                            {!mod.launcherId && mod.descriptorFile && (
                                <span
                                    className="chip"
                                    title={mod.source === 'local' ? tr('The Paradox Launcher has not registered this mod yet — writing a launcher playset with it registers it') : tr('The Paradox Launcher has not registered this mod yet (it cannot be in a launcher playset until the launcher has started once)')}>
                                    {tr('not in launcher')}</span>
                            )}
                        </div>
                    ) :
                    (
                        <div className="mr-chips">
                            <span className="chip bad" title={tr('No descriptor, launcher entry or Workshop folder has this id')}>{tr('Not found')}</span>
                        </div>
                    )}
                <div className="mr-path" title={mod?.root ?? mod?.archive ?? entry.id}>
                    {entry.id}
                    {mod && (mod.root || mod.archive) ? ' · ' + (mod.root ?? mod.archive) : ''}
                    {props.note ? ' · ' + props.note : ''}
                </div>
            </div>
            <div className="mr-actions">
                {inList && (
                    <>
                        <button className="ghost" disabled={props.busy || i === 0} onClick={() => props.onMove?.(i - 1)} title={tr('Load earlier')}>
                            ↑
                        </button>
                        <button className="ghost" disabled={props.busy || i === (props.count ?? 1) - 1} onClick={() => props.onMove?.(i + 2)} title={tr('Load later')}>
                            ↓
                        </button>
                        <button className="ghost" disabled={props.busy} onClick={props.onRemove} title={tr('Remove from the list')}>
                            ✕
                        </button>
                    </>
                )}
                {mod && (
                    <button
                        className="ghost"
                        title={tr('Mod actions')}
                        onClick={(e) =>
                        {
                            const r = e.currentTarget.getBoundingClientRect();
                            setMenu({ x: r.right, y: r.bottom });
                        }}
                    >
                        ⋯
                    </button>
                )}
            </div>
            {/* (outside the row: a disabled row's opacity would dim the menu) */}
            {menu && mod && createPortal(<ModMenu mod={mod} state={state} x={menu.x} y={menu.y} busy={props.busy} actions={props.actions} onClose={() => setMenu(null)} />, document.body)}
        </div>
    );
}

function ModMenu(props: { mod: ModInfo; state: ModsState; x: number; y: number; busy: boolean; actions: ModActions; onClose: () => void; }): React.JSX.Element
{
    const { mod, onClose } = props;
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() =>
    {
        const onDown = (e: MouseEvent): void =>
        {
            if (ref.current && !ref.current.contains(e.target as Node))
                onClose();
        };
        const onKey = (e: KeyboardEvent): void =>
        {
            if (e.key === 'Escape')
                onClose();
        };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        return () =>
        {
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('keydown', onKey);
        };
    }, [onClose]);
    const active = props.state.activeMod === mod.id;
    const packed = !!mod.archive && !mod.root;
    const items: { label: string; hint: string; disabled?: string; run: () => void; }[] = [
        active
            ? { label: tr('Clear the active mod'), hint: tr('No mod is being edited'), run: () => props.actions.setActive(null) }
            : {
                label: tr('Set as active mod'),
                hint: tr('The mod you are editing'),
                disabled: mod.editable ? undefined : tr('Only unpacked mods in your mod folder can be edited here'),
                run: () => props.actions.setActive(mod.id)
            },
        {
            label: tr('Pack into a zip'),
            hint: mod.root ? tr('{root}.zip', { root: mod.root }) : '',
            disabled: mod.editable ? undefined : tr('Only unpacked mods in your mod folder can be packed'),
            run: () => props.actions.pack(mod)
        },
        {
            label: tr('Unpack into the mod folder'),
            hint: tr('Extract the zip and point the descriptor to the folder'),
            disabled: !packed ? tr('Not a packed mod') : !mod.descriptorFile ? tr('No descriptor in your mod folder') : undefined,
            run: () => props.actions.unpack(mod)
        },
        {
            label: packed ? tr('Show the zip') : tr('Open folder'),
            hint: mod.root ?? mod.archive ?? '',
            disabled: mod.status === 'missing' ? tr('The mod’s files were not found') : undefined,
            run: () => props.actions.openFolder(mod)
        },
        {
            label: tr('Delete mod…'),
            hint: tr('Its folder and descriptor to the Recycle Bin'),
            disabled: mod.editable ? undefined : tr('Only mods of your own — unpacked in your mod folder — can be deleted here'),
            run: () => props.actions.remove(mod)
        }
    ];
    const left = Math.max(8, Math.min(props.x - 280, window.innerWidth - 300));
    const top = Math.min(props.y + 4, window.innerHeight - 20 - items.length * 48);
    return (
        <div className="popover mod-menu" ref={ref} style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
            {items.map((it) => (
                <div
                    key={it.label}
                    className={'item' + (it.disabled || props.busy ? ' disabled' : '')}
                    title={it.disabled}
                    onClick={() =>
                    {
                        if (it.disabled || props.busy)
                            return;

                        onClose();
                        it.run();
                    }}
                >
                    <span>{it.label}</span>
                    <small>{it.disabled ?? it.hint}</small>
                </div>
            ))}
        </div>
    );
}
