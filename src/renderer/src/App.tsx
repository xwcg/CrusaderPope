import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IndexStatus, ModsState, TypeSummary } from '../../shared/api';
import { api } from './api';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { EntityList } from './components/EntityList';
import { DetailView, TypePage } from './components/DetailView';
import { IndexingScreen, SettingsDialog } from './components/SettingsDialog';
import { HoverCardLayer, clearTooltipCache } from './components/rich';
import { FILE_TYPES, FolderList, GalleryGrid, ModelGrid } from './components/Gallery';
import { MODS_ROUTE, ModsView } from './components/ModsView';
import { MAP_ROUTE, MapView } from './components/map/MapView';
import { Notices } from './components/Notices';
import { ChangeBar } from './components/ChangeBar';
import { setModsState } from './modStore';
import { resetShaderPrograms } from './three/gameShader';
import { useShaderRevision } from './revision';
import { hook } from './testApi';
import { FirstRunWizard } from './components/FirstRunWizard';
import { setGraphics } from './graphics';

export type Tab = 'read' | 'refs' | 'source' | 'graph' | 'portrait';

export interface Route
{
    type: string;
    name?: string;
    /** in the history: the tab and scroll position the page had when it was left (back / forward restore them) */
    tab?: Tab;
    scroll?: number;
}

/** The scrolled part of an explorer page (its detail body). */
const scrolled = (): HTMLElement | null => document.querySelector('.main .detail-body');

/** Scrolls the page to `top` once its content is tall enough (it loads after the page opens; gives up after ~3 s). */
function restoreScroll(top: number): void
{
    const until = performance.now() + 3000;
    const step = (): void =>
    {
        const el = scrolled();

        if (el && el.scrollHeight - el.clientHeight >= top)
        {
            el.scrollTop = top;
            return;
        }

        if (performance.now() < until)
            requestAnimationFrame(step);
        else if (el)
            el.scrollTop = top;
    };
    requestAnimationFrame(step);
}

export type Navigate = (r: Route) => void;

interface History
{
    stack: Route[];
    index: number;
}

export function App(): React.JSX.Element
{
    const [status, setStatus] = useState<IndexStatus>({ state: 'idle' });
    const [types, setTypes] = useState<TypeSummary[]>([]);
    const [history, setHistory] = useState<History>({ stack: [{ type: 'events' }], index: 0 });
    const [tab, setTab] = useState<Tab>('read');
    const [showSettings, setShowSettings] = useState(false);
    // the first start: the wizard (Settings.setupDone false) before anything else; graphics settings for the views
    const [setup, setSetup] = useState<boolean | null>(null);
    useEffect(() =>
    {
        void api.getSettings().then((s) =>
        {
            setGraphics(s.graphics);
            setSetup(s.setupDone === false);
        });
    }, [showSettings]);
    // mods, mod lists, the loaded list and the active mod (top bar indicator, Mods page)
    const [mods, setMods] = useState<ModsState | null>(null);
    const route = history.stack[history.index];
    // the Explorer tab returns to the explorer page shown last (the history has Mods and Map pages in between)
    const lastExplorer = useMemo(() =>
    {
        for (let i = history.index; i >= 0; i--)
            if (history.stack[i].type !== MODS_ROUTE && history.stack[i].type !== MAP_ROUTE)
                return history.stack[i];

        return { type: 'events' };
    }, [history]);

    useEffect(() =>
    {
        void api.status().then(setStatus);
        return api.onStatus(setStatus);
    }, []);

    // a build; readyKey also changes with every incremental update (IndexStatus.revision): lists, galleries and the
    // detail reload in place (route, tab and scroll stay)
    const buildKey = status.state === 'ready' ? (status.stats?.ms ?? 0) + (status.gameDir ?? '') : '';
    const readyKey = buildKey && buildKey + '#' + (status.revision ?? 0);
    useEffect(() =>
    {
        if (readyKey)
            void api.types().then(setTypes);

        // (hover cards of entries the update changed)
        clearTooltipCache();
    }, [readyKey]);
    // another mod list can bring other FX files: no compiled program of the previous build is reused — nor after an
    // update that changed shader files (the 3D views reload: digest() carries the shader revision)
    const shaderRevision = useShaderRevision();
    useEffect(() => resetShaderPrograms(), [buildKey, shaderRevision]);
    // at startup and after each build (settings or files may have changed meanwhile)
    useEffect(() =>
    {
        void api
            .modsState()
            .then(setMods)
            .catch(() => undefined);
    }, [buildKey]);
    // (the editing actions read the active mod from the store)
    useEffect(() => setModsState(mods), [mods]);

    // the page being left keeps its tab and scroll position in the history
    const tabRef = useRef(tab);
    tabRef.current = tab;
    const leaving = (h: History): Route[] =>
    {
        const stack = [...h.stack];
        stack[h.index] = { ...stack[h.index], tab: tabRef.current, scroll: scrolled()?.scrollTop ?? 0 };
        return stack;
    };
    const restoring = useRef(false);
    const navigate = useCallback<Navigate>((r) =>
    {
        setHistory((h) =>
        {
            const cur = h.stack[h.index];

            if (cur.type === r.type && cur.name === r.name)
                return h;

            const stack = [...leaving(h).slice(0, h.index + 1), { type: r.type, name: r.name }].slice(-300);
            return { stack, index: stack.length - 1 };
        });
    }, []);
    // the test API (testApi.ts): straight to a page, and what is shown
    const latest = useRef({ route, tab, status, showSettings });
    latest.current = { route, tab, status, showSettings };
    useEffect(
        () =>
            hook('app', {
                route: navigate,
                map: (focus) => navigate({ type: MAP_ROUTE, name: focus }),
                mods: () => navigate({ type: MODS_ROUTE }),
                tab: setTab,
                settings: setShowSettings,
                state: () =>
                {
                    const l = latest.current;
                    return { index: l.status.state, section: l.route.type === MAP_ROUTE ? 'map' : l.route.type === MODS_ROUTE ? 'mods' : 'explorer', route: l.route, tab: l.tab, settings: l.showSettings };
                }
            }),
        [navigate]
    );

    const go = useCallback((by: number) =>
        setHistory((h) =>
        {
            const index = Math.min(h.stack.length - 1, Math.max(0, h.index + by));

            if (index === h.index)
                return h;

            restoring.current = true;
            return { stack: leaving(h), index };
        }), []);
    const back = useCallback(() => go(-1), [go]);
    const forward = useCallback(() => go(1), [go]);

    // back / forward: the tab and scroll position the page had
    useEffect(() =>
    {
        if (!restoring.current)
            return;

        restoring.current = false;

        if (route.tab)
            setTab(route.tab);

        if (route.scroll)
            restoreScroll(route.scroll);
    }, [route]);

    useEffect(() =>
    {
        const onKey = (e: KeyboardEvent): void =>
        {
            if (e.altKey && e.key === 'ArrowLeft')
                back();
            else if (e.altKey && e.key === 'ArrowRight')
                forward();
        };
        const onMouse = (e: MouseEvent): void =>
        {
            if (e.button === 3)
                back();
            else if (e.button === 4)
                forward();
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('mouseup', onMouse);
        return () =>
        {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('mouseup', onMouse);
        };
    }, [back, forward]);

    const typeSummary = useMemo(
        () => types.find((t) => t.id === route.type) ?? { id: route.type, label: route.type, group: '', count: 0, order: 0, hasDoc: false, searchOnly: false },
        [types, route.type]
    );

    if (setup === null)
        return <div className="app" />;

    if (setup)
        return <FirstRunWizard onDone={() => setSetup(false)} />;

    return (
        <div className="app">
            <TopBar
                status={status}
                canBack={history.index > 0}
                canForward={history.index < history.stack.length - 1}
                onBack={back}
                onForward={forward}
                navigate={navigate}
                onSettings={() => setShowSettings(true)}
                mods={mods}
                modsOpen={route.type === MODS_ROUTE}
                mapOpen={route.type === MAP_ROUTE}
                onMods={() => navigate({ type: MODS_ROUTE })}
                onMap={() => navigate({ type: MAP_ROUTE })}
                onExplorer={() => navigate(lastExplorer)}
            />
            {/* the Mods page works while indexing too: a list that breaks the index can be switched off */}
            {route.type === MODS_ROUTE ? <ModsView state={mods} setState={setMods} status={status} /> : route.type === MAP_ROUTE && status.state === 'ready' ? <MapView navigate={navigate} reloadKey={readyKey} focus={route.name} /> : status.state === 'ready' ?
                (
                    <div className="main">
                        <Sidebar types={types} active={route.type} onSelect={(t) => navigate({ type: t })} onOpen={(type, name) => navigate({ type, name })} />
                        {FILE_TYPES[route.type] ? <FolderList key={route.type} type={route.type} selected={route.name} reloadKey={readyKey} navigate={navigate} /> : <EntityList type={typeSummary} selected={route.name} reloadKey={readyKey} onSelect={(name) => navigate({ type: route.type, name })} navigate={navigate} />}
                        {FILE_TYPES[route.type] && (!route.name || route.name.endsWith('/')) ?
                            (
                                route.type === 'models' ? <ModelGrid folder={route.name ?? 'gfx/models'} navigate={navigate} reloadKey={readyKey} /> : <GalleryGrid folder={route.name ?? ''} navigate={navigate} reloadKey={readyKey} />
                            ) :
                            route.name ?
                            <DetailView key={route.type + '\u0000' + route.name} type={route.type} name={route.name} tab={tab} setTab={setTab} navigate={navigate} /> :
                            <TypePage type={typeSummary} />}
                    </div>
                ) :
                <IndexingScreen status={status} onSettings={() => setShowSettings(true)} />}
            {showSettings && <SettingsDialog status={status} onClose={() => setShowSettings(false)} />}
            <ChangeBar />
            <HoverCardLayer navigate={navigate} />
            <Notices />
        </div>
    );
}
