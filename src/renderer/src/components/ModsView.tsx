import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { IndexStatus, ModInfo, ModList, ModListEntry, ModsState, NewModRequest } from '../../../shared/api';
import { api } from '../api';
import { AddModsDialog, ConfirmDialog, ModThumb, NewModDialog, PromptDialog, SOURCE_LABEL, StatusChip, SupportedChip, errorText, modWarning, type NewModTarget } from './ModDialogs';
import { hook } from '../testApi';
import '../styles/mods.css';
import { Select } from './Select';

/** Route type of the Mods page (App.tsx) — not an index type. */
export const MODS_ROUTE = '@mods';
/** the "All mods" page of the view */
const LIBRARY = '@all';

const KIND_LABEL: Record<ModList['kind'], string> = { playset: 'Launcher playset', game: 'Game list', custom: 'Custom list' };

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
        return 'None — game only';

    return state.lists.find((l) => l.ref === ref)?.name ?? 'Missing list';
}

/** Top bar: the list the explorer loads and the active mod; opens the Mods page. */
/** The Mods tab of the top bar: the loaded list, its mod count and the active mod at a glance. */
export function ModsTab(props: { state: ModsState | null; open: boolean; onClick: () => void; }): React.JSX.Element
{
    const s = props.state;
    const loaded = s ? enabledMods(s, s.selected) : [];
    const active = s?.activeMod ? s.mods.find((m) => m.id === s.activeMod) : undefined;
    const name = s ? (s.selected === 'none' ? 'No mods' : listLabel(s, s.selected)) : '…';
    const tip = s
        ? [
            `Loaded in the explorer: ${listLabel(s, s.selected)}`,
            ...loaded.map((m, i) => `  ${i + 1}. ${m.name}`),
            `Active mod: ${active?.name ?? (s.activeMod ? s.activeMod + ' (not found)' : 'none')}`,
            '',
            'Manage mods and mod lists'
        ].join('\n')
        : 'Manage mods and mod lists';
    return (
        <button className={'app-tab mods-tab' + (props.open ? ' on' : '')} onClick={props.onClick} title={tip}>
            <span className="mi-label">Mods</span>
            <span className="mi-list">{name}</span>
            {loaded.length > 0 && <span className="mi-count">{loaded.length}</span>}
            {active && <span className="mi-active">✎ {active.name}</span>}
        </button>
    );
}

interface Notice
{
    kind: 'ok' | 'error';
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
        return <div className="mods-page loading">Reading mods…</div>;

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
    const run = async (label: string, fn: () => Promise<string | void>): Promise<boolean> =>
    {
        setBusy(label);
        setNotice(null);

        try
        {
            const msg = await fn();

            if (msg)
                setNotice({ kind: 'ok', text: msg });

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
        void run('Loading into the explorer…', async () =>
        {
            const next = await api.selectModList(ref);
            setState(next);
            // (the returned state: a save just before may have renamed the list)
            return ref === 'none' ? 'The explorer shows the game without mods.' : `“${listLabel(next, ref)}” is loaded into the explorer.`;
        });

    const setActive = (id: string | null): void =>
        void run('Setting the active mod…', async () =>
        {
            setState(await api.setActiveMod(id));
        });

    const modActions: ModActions = {
        setActive,
        pack: (m) =>
        {
            const pack = (overwrite: boolean): void =>
                void run(`Packing ${m.name}…`, async () =>
                {
                    const r = await api.packMod(m.id, overwrite);

                    if (!r.exists)
                        return `Packed ${r.files} ${r.files === 1 ? 'file' : 'files'} into ${r.file}.`;

                    // a zip from an earlier pack (or an upload) is there: ask before replacing it
                    setDialog(
                        <ConfirmDialog title={`Replace the zip of “${m.name}”?`} confirm="Replace" danger onClose={closeDialog} onConfirm={() => pack(true)}>
                            <p>
                                <code>{r.file}</code> exists already. Packing again replaces it with the mod folder&apos;s current files.
                            </p>
                        </ConfirmDialog>
                    );
                    return undefined;
                });
            pack(false);
        },
        unpack: (m) =>
            setDialog(
                <ConfirmDialog
                    title={`Unpack “${m.name}”?`}
                    confirm="Unpack"
                    onClose={closeDialog}
                    onConfirm={() =>
                        void run(`Unpacking ${m.name}…`, async () =>
                        {
                            const r = await api.unpackMod(m.id);
                            setState(await api.modsState());
                            return `Unpacked ${r.files} ${r.files === 1 ? 'file' : 'files'} into ${r.dir}; the mod's descriptor points there now.`;
                        })}
                >
                    <p>
                        The zip is extracted into a folder in your mod folder ({state.userDir}\mod\…) and the mod&apos;s descriptor is changed to point to that folder (
                        <code>path=</code> instead of <code>archive=</code>). The zip itself stays where it is.
                    </p>
                </ConfirmDialog>
            ),
        openFolder: (m) =>
            void run('Opening…', async () =>
            {
                await api.openModFolder(m.id);
            })
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
                    const created = `Created “${req.name}” in ${next.userDir}\\mod\\${req.folder} — it is the active mod.`;
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

                        setNotice({ kind: 'ok', text: created + (target && next.selected === show ? ' Its list is loaded: the explorer re-indexes.' : '') });
                    }
                    catch (e)
                    {
                        // the mod exists: report the list error on the page
                        setNotice({ kind: 'error', text: `${created} Adding it to the list failed: ${errorText(e)}` });
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
                title="New mod list"
                label="Name"
                initial="New list"
                confirm="Create list"
                onClose={closeDialog}
                onConfirm={(name) =>
                    void run('Creating the list…', async () =>
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
                    <h2>Mods</h2>
                    {state.gameVersion && <span className="ml-game">game {state.gameVersion}</span>}
                </div>
                <div className="ml-loaded">
                    <label>Loaded in the explorer</label>
                    <Select value={state.selected} disabled={!!busy} onChange={(e) => select(e.target.value)}>
                        <option value="none">None — game only</option>
                        {!lists.some((l) => l.ref === state.selected) && state.selected !== 'none' && <option value={state.selected}>Missing list</option>}
                        {lists.some((l) => l.kind === 'playset') && (
                            <optgroup label="Launcher playsets">
                                {lists
                                    .filter((l) => l.kind === 'playset')
                                    .map((l) => (
                                        <option key={l.ref} value={l.ref}>
                                            {l.name}
                                            {l.active ? ' (launcher’s active playset)' : ''}
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
                            <optgroup label="Custom lists">
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
                    <ListItem label="None — game only" count={null} active={viewRef === 'none'} loaded={state.selected === 'none'} onClick={() => open('none')} />
                    <div className="ml-section">Launcher playsets</div>
                    {!state.launcher && <div className="ml-empty">The launcher database (launcher-v2.sqlite) was not found or could not be read.</div>}
                    {lists
                        .filter((l) => l.kind === 'playset')
                        .map((l) => <ListItem key={l.ref} list={l} state={state} dirty={isDirty(l, drafts[l.ref])} active={viewRef === l.ref} onClick={() => open(l.ref)} />)}
                    <div className="ml-section">Game</div>
                    {lists
                        .filter((l) => l.kind === 'game')
                        .map((l) => <ListItem key={l.ref} list={l} state={state} dirty={isDirty(l, drafts[l.ref])} active={viewRef === l.ref} onClick={() => open(l.ref)} />)}
                    {!lists.some((l) => l.kind === 'game') && <div className="ml-empty">No dlc_load.json yet (the launcher writes it when you press Play).</div>}
                    <div className="ml-section">
                        Custom lists
                        <button className="ghost ml-add" onClick={newList} disabled={!!busy} title="A new, empty list kept by this app">
                            + New
                        </button>
                    </div>
                    {lists
                        .filter((l) => l.kind === 'custom')
                        .map((l) => <ListItem key={l.ref} list={l} state={state} dirty={isDirty(l, drafts[l.ref])} active={viewRef === l.ref} onClick={() => open(l.ref)} />)}
                    {!lists.some((l) => l.kind === 'custom') && <div className="ml-empty">Lists kept by this app — e.g. a playset plus the mod you are writing.</div>}
                    <div className="ml-section">Library</div>
                    <ListItem label="All mods" count={state.mods.length} active={viewRef === LIBRARY} onClick={() => open(LIBRARY)} />
                </div>
                <ActiveModBox state={state} busy={!!busy} actions={modActions} onNew={newMod} />
            </aside>
            <section className="mods-main">
                {busy && <div className="mods-busy">{busy}</div>}
                {notice && (
                    <div className={'mods-notice ' + notice.kind}>
                        <span>{notice.text}</span>
                        <button className="ghost" onClick={() => setNotice(null)} title="Dismiss">
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
        return <div className="ml-index busy">Indexing — {status.phase}…</div>;

    if (status.state === 'error')
        return <div className="ml-index bad">The index could not be built.</div>;

    if (status.state === 'ready' && status.stats)
        return <div className="ml-index">Index ready · {status.stats.files.toLocaleString()} files</div>;

    return <div className="ml-index" />;
}

function ListItem(props: { list?: ModList; state?: ModsState; label?: string; count?: number | null; dirty?: boolean; active: boolean; loaded?: boolean; onClick: () => void; }): React.JSX.Element
{
    const { list, state } = props;
    const loaded = props.loaded ?? (!!list && state?.selected === list.ref);
    const enabled = list ? list.mods.filter((e) => e.enabled).length : props.count;
    return (
        <div className={'ml-item' + (props.active ? ' active' : '')} onClick={props.onClick} title={list ? `${KIND_LABEL[list.kind]}: ${list.mods.length} mods, ${list.mods.filter((e) => e.enabled).length} enabled` : undefined}>
            <span className="ml-name">{list?.name ?? props.label}</span>
            {props.dirty && (
                <span className="ml-dirty" title="Unsaved changes">
                    ●
                </span>
            )}
            {list?.active && (
                <span className="ml-badge launcher" title="The Paradox Launcher's active playset">
                    launcher
                </span>
            )}
            {loaded && (
                <span className="ml-badge loaded" title="Loaded in the explorer">
                    loaded
                </span>
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
    openFolder: (m: ModInfo) => void;
}

function ActiveModBox(props: { state: ModsState; busy: boolean; actions: ModActions; onNew: () => void; }): React.JSX.Element
{
    const { state } = props;
    const active = state.activeMod ? state.mods.find((m) => m.id === state.activeMod) : undefined;
    return (
        <div className="ml-foot">
            <label>Active mod — the one you edit</label>
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
                <div className="ml-active none">{state.activeMod ? `${state.activeMod} (not found)` : 'None'}</div>}
            <div className="ml-foot-actions">
                <button className="primary" onClick={props.onNew} disabled={props.busy || !state.userDirFound}>
                    New mod…
                </button>
                {active && (
                    <button onClick={() => props.actions.openFolder(active)} disabled={props.busy}>
                        Open folder
                    </button>
                )}
                {state.activeMod && (
                    <button className="ghost" onClick={() => props.actions.setActive(null)} disabled={props.busy} title="No active mod">
                        Clear
                    </button>
                )}
            </div>
            <div className={'ml-userdir' + (state.userDirFound ? '' : ' bad')} title="The CK3 user folder (settings.json: userDir)">
                {state.userDirFound ? state.userDir : `User folder not found: ${state.userDir}`}
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
                    <span className="chip">No mod list</span>
                    {loaded && <span className="chip ok">Loaded in the explorer</span>}
                </div>
                <h1>None — game only</h1>
                <div className="me-sub">The explorer indexes the game without any mods.</div>
                <div className="me-actions">
                    <button className="primary" disabled={loaded || props.busy} onClick={props.onLoad}>
                        {loaded ? 'Loaded in the explorer' : 'Load into explorer'}
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
        const f = q.trim().toLowerCase();
        return state.mods
            .filter((m) => !f || [m.name, m.id, m.version ?? '', SOURCE_LABEL[m.source], ...m.tags].some((s) => s.toLowerCase().includes(f)))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [state.mods, q]);
    const inLists = (m: ModInfo): string[] => state.lists.filter((l) => l.mods.some((e) => e.id.toLowerCase() === m.id.toLowerCase())).map((l) => l.name);
    return (
        <div className="me">
            <header className="me-head">
                <div className="me-kicker">
                    <span className="chip">Library</span>
                </div>
                <h1>All mods</h1>
                <div className="me-sub">
                    {state.mods.length} mods: descriptors in your mod folder, the launcher&apos;s mods and Steam Workshop folders. {state.mods.filter((m) => m.editable).length} can be edited here (unpacked in your mod folder).
                </div>
                <div className="me-actions">
                    <input className="mods-search" placeholder="Filter by name, tag, source…" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
                    <span style={{ flex: 1 }} />
                    <button className="primary" onClick={props.onNew} disabled={props.busy || !state.userDirFound}>
                        New mod…
                    </button>
                </div>
            </header>
            <div className="me-rows">
                {mods.map((m) => <ModRow key={m.id} entry={{ id: m.id, enabled: true }} mod={m} state={state} actions={props.actions} busy={props.busy} note={inLists(m).length ? 'in ' + inLists(m).join(', ') : 'in no list'} />)}
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
    run: (label: string, fn: () => Promise<string | void>) => Promise<boolean>;
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
        run('Saving…', async () =>
        {
            setState(await api.saveModList({ ref: list.ref, name: current.name, mods: current.mods }));
            props.dropDraft();
            return `Saved “${current.name.trim() || 'Unnamed list'}”.${loaded ? ' It is loaded: the explorer re-indexes when its mods changed.' : ''}`;
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
                title="Save as a new list"
                label="Name of the new custom list"
                initial={`${current.name} (copy)`}
                confirm="Save list"
                onClose={closeDialog}
                onConfirm={(name) =>
                    void run('Saving…', async () =>
                    {
                        const next = await api.saveModList({ name, mods: current.mods });
                        setState(next);
                        props.dropDraft();
                        props.setView(props.newListRef(next));
                        return `Saved as “${name}”.`;
                    })}
            />
        );

    const remove = (): void =>
        setDialog(
            <ConfirmDialog
                title={`Delete “${list.name}”?`}
                confirm="Delete list"
                danger
                onClose={closeDialog}
                onConfirm={() =>
                    void run('Deleting…', async () =>
                    {
                        setState(await api.deleteModList(list.ref));
                        props.dropDraft();
                        props.setView(undefined);
                        return `Deleted “${list.name}”.${loaded ? ' The explorer shows the game without mods now.' : ''}`;
                    })}
            >
                <p>This removes the app&apos;s own list. No mod files, playsets or game files are touched.</p>
            </ConfirmDialog>
        );

    const backups = `${state.userDir}\\crusaderpope-backups`;
    // (as manager.ts `registrable`: local mods of the user's mod folder the launcher has not registered)
    const unregistered = current.mods.map((e) => byId.get(e.id.toLowerCase())).filter((m) => m && !m.launcherId && m.source === 'local' && m.status === 'ok' && m.descriptorFile && /^mod\/[^/\\]+\.mod$/i.test(m.id));
    const toLauncher = (launcherClosed: boolean): Promise<boolean> =>
        run('Writing the launcher playset…', async () =>
        {
            const r = await api.writeModList(list.ref, 'launcher', current.mods, launcherClosed ? { launcherClosed } : undefined);

            // nothing written: the process list could not be read — the user may say the launcher is closed
            if (r.unchecked)
            {
                setDialog(
                    <ConfirmDialog title="Is the Paradox Launcher closed?" confirm="It is closed — write" danger onClose={closeDialog} onConfirm={() => void toLauncher(true)}>
                        <p>{r.unchecked}</p>
                        <p>Write only when the Paradox Launcher is not running: it keeps its playsets in memory and would overwrite the change (or be confused by it). The database is backed up first either way.</p>
                    </ConfirmDialog>
                );
                return 'Nothing written — the app could not check whether the Paradox Launcher is running.';
            }

            setState(await api.modsState());
            props.dropDraft();
            const reg = r.registered?.length ? ` Registered in the launcher: ${r.registered.join(', ')}.` : '';
            return `Written to the launcher playset “${list.name}”.${reg} Backup of the launcher database: ${r.backup}`;
        });

    const writeLauncher = (): void =>
        setDialog(
            <ConfirmDialog title={`Write “${list.name}” to the Paradox Launcher?`} confirm="Write to launcher" onClose={closeDialog} onConfirm={() => void toLauncher(false)}>
                <p>
                    The playset&apos;s mods, their order and enabled flags are replaced with this list ({current.mods.length} mods, {enabled.length} enabled).
                </p>
                {unregistered.length > 0 && (
                    <p>
                        The launcher has not registered {unregistered.map((m) => `“${m!.name}”`).join(', ')} yet: the app adds {unregistered.length === 1 ? 'it' : 'them'} to its mod list, as the launcher does when it finds a new mod.
                    </p>
                )}
                <p>
                    The launcher database is copied first to <code>{backups}</code> (the last 10 copies are kept). Close the Paradox Launcher before writing — it keeps its playsets in memory.
                </p>
            </ConfirmDialog>
        );

    const writeGame = (): void =>
        setDialog(
            <ConfirmDialog
                title="Write to the game list (dlc_load.json)?"
                confirm="Write game list"
                onClose={closeDialog}
                onConfirm={() =>
                    void run('Writing dlc_load.json…', async () =>
                    {
                        const r = await api.writeModList(list.ref, 'game', current.mods);
                        setState(await api.modsState());

                        if (list.kind === 'game')
                            props.dropDraft();

                        return `Written ${enabled.length} mods to dlc_load.json.${r.backup ? ' Backup: ' + r.backup : ''}`;
                    })}
            >
                <p>
                    The {enabled.length} enabled mods of “{current.name}” become the mods the game loads when started without the launcher, in this order. The launcher replaces this list with its playset when you press Play.
                </p>
                <p>
                    The current file is copied first to <code>{backups}</code> (the last 10 copies are kept).
                </p>
            </ConfirmDialog>
        );

    const dirtyText = custom
        ? 'Save to keep them.'
        : list.kind === 'playset'
        ? 'Write them to the launcher playset, or save them as a new list.'
        : 'Write them to the game list, or save them as a new list.';

    return (
        <div className="me">
            <header className="me-head">
                <div className="me-kicker">
                    <span className="chip">{KIND_LABEL[list.kind]}</span>
                    {list.active && <span className="chip accent">Active in the launcher</span>}
                    {loaded && <span className="chip ok">Loaded in the explorer</span>}
                    {list.kind === 'game' && <span className="chip">dlc_load.json</span>}
                </div>
                <h1>
                    {custom ? <input className="me-name" value={current.name} disabled={props.busy} onChange={(e) => edit(current.mods, e.target.value)} spellCheck={false} title="Rename the list" /> : (
                        list.name
                    )}
                    {dirty && (
                        <span className="me-dirty-mark" title="Unsaved changes">
                            ●
                        </span>
                    )}
                </h1>
                <div className="me-sub">
                    {current.mods.length} {current.mods.length === 1 ? 'mod' : 'mods'} · {enabled.length} enabled
                    {warnings > 0 && <span className="warn-text">· {warnings} with warnings</span>} · load order top to bottom, later mods win
                </div>
                <div className="me-actions">
                    <button className="primary" disabled={props.busy || (loaded && !dirty)} onClick={load} title={loaded && dirty && !custom ? 'The saved list is loaded' : undefined}>
                        {loaded && !dirty ? 'Loaded in the explorer' : custom && dirty ? 'Save & load into explorer' : dirty ? 'Load saved version' : 'Load into explorer'}
                    </button>
                    {custom && (
                        <button disabled={props.busy || !dirty} onClick={() => void save()}>
                            Save
                        </button>
                    )}
                    <button disabled={props.busy} onClick={saveAs}>
                        Save as new list…
                    </button>
                    {list.kind === 'playset' && (
                        <button disabled={props.busy || !state.launcher} onClick={writeLauncher}>
                            Write to launcher playset…
                        </button>
                    )}
                    <button disabled={props.busy} onClick={writeGame} title="Make these the mods the game loads when started directly">
                        Write to game list (dlc_load.json)…
                    </button>
                    {custom && (
                        <button className="danger" disabled={props.busy} onClick={remove}>
                            Delete list
                        </button>
                    )}
                    <span style={{ flex: 1 }} />
                    <button disabled={props.busy} onClick={() => setAdding(true)}>
                        + Add mods
                    </button>
                </div>
            </header>
            {dirty && (
                <div className="me-dirty">
                    <span>● Unsaved changes. {dirtyText}</span>
                    <button onClick={props.dropDraft} disabled={props.busy}>
                        Discard changes
                    </button>
                </div>
            )}
            <div className="me-rows">
                {current.mods.length === 0 && <div className="list-empty">No mods in this list yet — “+ Add mods” picks from every mod found.</div>}
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
                    <span className="mr-grip" title="Drag to reorder">
                        ⋮⋮
                    </span>
                    <span className="mr-pos">{i + 1}</span>
                    <input
                        type="checkbox"
                        checked={entry.enabled}
                        disabled={props.busy}
                        onChange={props.onToggle}
                        title={entry.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                    />
                </>
            )}
            <ModThumb mod={mod} />
            <div className="mr-main">
                <div className="mr-line1">
                    <span className="mr-name">{mod?.name ?? entry.id}</span>
                    {mod?.version && <span className="mr-version">v{mod.version}</span>}
                    {active && <span className="chip accent">✎ active mod</span>}
                </div>
                {mod ?
                    (
                        <div className="mr-chips">
                            <span className="chip">{SOURCE_LABEL[mod.source]}</span>
                            <StatusChip mod={mod} />
                            <SupportedChip mod={mod} game={state.gameVersion} />
                            {mod.editable && <span className="chip ok" title="Unpacked in your mod folder: can be edited, packed, be the active mod">editable</span>}
                            {mod.replacePaths.length > 0 && (
                                <span className="chip" title={'replace_path — the game’s and earlier mods’ files directly in these folders are ignored:\n' + mod.replacePaths.join('\n')}>
                                    replaces {mod.replacePaths.length} {mod.replacePaths.length === 1 ? 'folder' : 'folders'}
                                </span>
                            )}
                            {!mod.launcherId && mod.descriptorFile && (
                                <span
                                    className="chip"
                                    title={mod.source === 'local' ? 'The Paradox Launcher has not registered this mod yet — writing a launcher playset with it registers it' : 'The Paradox Launcher has not registered this mod yet (it cannot be in a launcher playset until the launcher has started once)'}>
                                    not in launcher
                                </span>
                            )}
                        </div>
                    ) :
                    (
                        <div className="mr-chips">
                            <span className="chip bad" title="No descriptor, launcher entry or Workshop folder has this id">Not found</span>
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
                        <button className="ghost" disabled={props.busy || i === 0} onClick={() => props.onMove?.(i - 1)} title="Load earlier">
                            ↑
                        </button>
                        <button className="ghost" disabled={props.busy || i === (props.count ?? 1) - 1} onClick={() => props.onMove?.(i + 2)} title="Load later">
                            ↓
                        </button>
                        <button className="ghost" disabled={props.busy} onClick={props.onRemove} title="Remove from the list">
                            ✕
                        </button>
                    </>
                )}
                {mod && (
                    <button
                        className="ghost"
                        title="Mod actions"
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
            ? { label: 'Clear the active mod', hint: 'No mod is being edited', run: () => props.actions.setActive(null) }
            : {
                label: 'Set as active mod',
                hint: 'The mod you are editing',
                disabled: mod.editable ? undefined : 'Only unpacked mods in your mod folder can be edited here',
                run: () => props.actions.setActive(mod.id)
            },
        {
            label: 'Pack into a zip',
            hint: mod.root ? `${mod.root}.zip` : '',
            disabled: mod.editable ? undefined : 'Only unpacked mods in your mod folder can be packed',
            run: () => props.actions.pack(mod)
        },
        {
            label: 'Unpack into the mod folder',
            hint: 'Extract the zip and point the descriptor to the folder',
            disabled: !packed ? 'Not a packed mod' : !mod.descriptorFile ? 'No descriptor in your mod folder' : undefined,
            run: () => props.actions.unpack(mod)
        },
        {
            label: packed ? 'Show the zip' : 'Open folder',
            hint: mod.root ?? mod.archive ?? '',
            disabled: mod.status === 'missing' ? 'The mod’s files were not found' : undefined,
            run: () => props.actions.openFolder(mod)
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
