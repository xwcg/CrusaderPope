/**
 * The test API (docs/app-architecture.md, "Test API"): `window.__app.goto(target)` goes straight to a section and view
 * and resolves once it has loaded — nothing in flight (pending.ts), the page's pictures in, the 3D camera still — so
 * scripts/drive.mjs runs need no clicking through and no fixed waits (`{ goto }` steps). `__app.here()` is the target
 * of what is shown (look around by hand, then copy it into a test); CRUSADERPOPE_START=<target> opens one at start.
 *
 * Targets (strings; objects with the same fields work too):
 *   events                                a type's page
 *   events:court.8190#source              an entry on a tab (read, refs, source, graph, portrait)
 *   images:gfx/interface/icons/traits/    a gallery folder (models too); a file: images:gfx/…/brave.dds
 *   @map?dim=3d&mode=culture&date=1066.9.15&style=terrain&camera=1495,1385,12,0,38
 *     dim 2d | 3d; mode an id or label (realm, vassal, k, culture, holdings …); date y.m.d; style terrain | paper |
 *     plain; focus=landed_titles:k_france (as "Show on map"); box=x0,y0,x1,y1 (map pixels in view); select=<province>;
 *     camera=x,z,dist,yaw,pitch (3D: the point looked at in map pixels, the eye's distance, turn and tilt in degrees)
 *   @mods   @mods?list=@all                the Mods page (on a list: @all every mod, none, a list's ref)
 *   @settings                             the settings dialog over what is shown
 */
import type { IndexStatus } from '../../shared/api';
import type { Route, Tab } from './App';
import type { Map3D } from './components/map/map3d';
import type { Style } from './components/map/model';
import { api } from './api';
import { pending } from './pending';

export interface CameraPose
{
    x: number;
    z: number;
    dist: number;
    /** degrees: 0 north up, turning the view clockwise */
    yaw: number;
    /** degrees above the horizon (90 straight down) */
    pitch: number;
}

export interface MapTarget
{
    dim?: '2d' | '3d';
    mode?: string;
    date?: string;
    style?: Style;
    focus?: string;
    box?: [number, number, number, number];
    select?: number;
    camera?: CameraPose;
}

export interface Target
{
    type?: string;
    name?: string;
    tab?: Tab;
    map?: MapTarget;
    /** the Mods page; a string: on that list */
    mods?: string | true;
    settings?: boolean;
}

export interface MapState
{
    dim: '2d' | '3d';
    mode: string;
    date: string;
    style: Style;
    sel: number | null;
    /** 2D: the map pixels in view */
    box?: [number, number, number, number];
    /** 3D: the camera */
    camera?: CameraPose;
}

export interface AppState
{
    index: IndexStatus['state'];
    section: 'explorer' | 'map' | 'mods';
    route: Route;
    tab: Tab;
    settings: boolean;
    map?: MapState;
    /** the list the Mods page shows */
    mods?: string;
    /** a target that comes back here */
    target: string;
}

/** What the mounted parts of the app offer (App, MapView, Map3DView, ModsView). */
interface Hooks
{
    app?: {
        route(r: Route): void;
        map(focus?: string): void;
        mods(): void;
        tab(t: Tab): void;
        settings(open: boolean): void;
        state(): Pick<AppState, 'index' | 'section' | 'route' | 'tab' | 'settings'>;
    };
    map?: {
        /** forgets what an earlier goto asked for (the dates and modes picked by hand since count) */
        begin(): void;
        /** the map's data for the date asked is in */
        loaded(): boolean;
        /** date, mode (an id or label), style, 2D / 3D — an error for an unknown mode */
        set(t: MapTarget): string | null;
        /** the dimension and mode asked for are shown (3D: its scene may still be coming) */
        shown(): boolean;
        /** the selection; 2D: the box in view */
        view(t: MapTarget): void;
        state(): MapState;
    };
    map3d?: Map3D;
    mods?: {
        view(ref: string): void;
        state(): string | undefined;
    };
}

const hooks: Hooks = {};

/** A mounted part of the app offers itself to the test API; the function returned takes it back (unmounting). */
export function hook<K extends keyof Hooks>(k: K, h: NonNullable<Hooks[K]>): () => void
{
    hooks[k] = h as Hooks[K];
    return () =>
    {
        if (hooks[k] === h)
            hooks[k] = undefined;
    };
}

const TABS = new Set<string>(['read', 'refs', 'source', 'graph', 'portrait']);

/** y, y.m or y.m.d → y.m.d */
function day(s: string): string
{
    const [y, m = '1', d = '1'] = s.trim().split('.');
    const v = [y, m, d].map(Number);

    if (!v.every(Number.isInteger))
        throw new Error(`Not a date: ${s}`);

    return v.join('.');
}

/** A target string → its fields. */
export function parseTarget(s: string): Target
{
    const t = s.trim();

    if (!t.startsWith('@'))
    {
        const hash = t.lastIndexOf('#');
        const tab = hash >= 0 && TABS.has(t.slice(hash + 1)) ? (t.slice(hash + 1) as Tab) : undefined;
        const head = tab ? t.slice(0, hash) : t;
        const colon = head.indexOf(':');
        return colon < 0 ? { type: head, tab } : { type: head.slice(0, colon), name: head.slice(colon + 1), tab };
    }

    const q = t.indexOf('?');
    const head = q < 0 ? t : t.slice(0, q);
    const p = new URLSearchParams(q < 0 ? '' : t.slice(q + 1));

    if (head === '@settings')
        return { settings: true };

    if (head === '@mods')
        return { mods: p.get('list') ?? true };

    if (head !== '@map')
        throw new Error(`Unknown target: ${s} (@map, @mods, @settings or type:name#tab)`);

    const nums = (k: string, n: number): number[] | undefined =>
    {
        const v = p.get(k);

        if (v === null)
            return undefined;

        const out = v.split(',').map(Number);

        if (out.length < n || !out.every(Number.isFinite))
            throw new Error(`${k}=${v}: ${n} numbers`);

        return out;
    };
    const map: MapTarget = {};
    const dim = p.get('dim');

    if (dim)
    {
        if (dim !== '2d' && dim !== '3d')
            throw new Error(`dim=${dim}: 2d or 3d`);

        map.dim = dim;
    }

    const style = p.get('style');

    if (style)
    {
        if (style !== 'terrain' && style !== 'paper' && style !== 'plain')
            throw new Error(`style=${style}: terrain, paper or plain`);

        map.style = style;
    }

    if (p.get('mode'))
        map.mode = p.get('mode')!;

    if (p.get('date'))
        map.date = day(p.get('date')!);

    if (p.get('focus'))
        map.focus = p.get('focus')!;

    const box = nums('box', 4);

    if (box)
        map.box = box.slice(0, 4) as [number, number, number, number];

    const sel = nums('select', 1);

    if (sel)
        map.select = sel[0];

    const cam = nums('camera', 3);

    if (cam)
        map.camera = { x: cam[0], z: cam[1], dist: cam[2], yaw: cam[3] ?? 0, pitch: cam[4] ?? 45 };

    return { map };
}

const r1 = (v: number): string => String(Math.round(v * 10) / 10);

/** The target of a state. */
function targetOf(s: Omit<AppState, 'target'>): string
{
    if (s.section === 'mods')
        return s.mods ? `@mods?list=${encodeURIComponent(s.mods).replace(/%40/g, '@')}` : '@mods';

    if (s.section === 'map' && s.map)
    {
        const m = s.map;
        const parts = [`dim=${m.dim}`, `mode=${encodeURIComponent(m.mode)}`, `date=${m.date}`, `style=${m.style}`];

        if (m.camera)
            parts.push(`camera=${[m.camera.x, m.camera.z].map(r1).join(',')},${Number(m.camera.dist.toPrecision(4))},${r1(m.camera.yaw)},${r1(m.camera.pitch)}`);
        else if (m.box)
            parts.push(`box=${m.box.map(Math.round).join(',')}`);

        if (m.sel !== null)
            parts.push(`select=${m.sel}`);

        return '@map?' + parts.join('&');
    }

    // (a gallery folder has no tabs)
    const n = s.route.name;
    return n === undefined ? s.route.type : n.endsWith('/') ? `${s.route.type}:${n}` : `${s.route.type}:${n}#${s.tab}`;
}

/** What is shown. */
export function state(): AppState
{
    const a = hooks.app?.state() ?? { index: 'idle', section: 'explorer', route: { type: '' }, tab: 'read', settings: false };
    const s: Omit<AppState, 'target'> = { ...a };

    if (a.section === 'map' && hooks.map)
    {
        s.map = hooks.map.state();

        if (s.map.dim === '3d' && hooks.map3d)
            s.map.camera = hooks.map3d.cam.pose;
    }

    if (a.section === 'mods' && hooks.mods)
        s.mods = hooks.mods.state();

    return { ...s, target: targetOf(s) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(what: string, ok: () => boolean, deadline: number): Promise<void>
{
    while (!ok())
    {
        if (performance.now() > deadline)
            throw new Error(`goto: timed out waiting for ${what}`);

        await sleep(25);
    }
}

/** a picture of the page still loading (lazy ones off screen don't count: they wait for the scroll) */
function loadingPicture(): boolean
{
    const h = window.innerHeight;

    for (const img of document.images)
    {
        if (img.complete)
            continue;

        if (img.loading === 'lazy')
        {
            const r = img.getBoundingClientRect();

            if (r.bottom < 0 || r.top > h || (r.width === 0 && r.height === 0))
                continue;
        }

        return true;
    }

    return false;
}

/** Nothing in flight, the page's pictures in, the 3D camera still — for `quiet` ms on end. */
async function idle(deadline: number, quiet = 300): Promise<void>
{
    let since = -1;

    for (;;)
    {
        const now = performance.now();

        if (pending() > 0 || loadingPicture() || hooks.map3d?.cam.moving)
            since = -1;
        else if (since < 0)
            since = now;
        else if (now - since >= quiet)
            return;

        if (now > deadline)
            throw new Error(`goto: still loading at the timeout (${pending()} calls or loads in flight)`);

        await sleep(25);
    }
}

/**
 * Goes to a target (a string as above, or its fields) and resolves with the state once it has loaded; `settle`: ms to
 * wait on top (animations), `timeout`: ms for the whole (default 180 s — the first index or 3D map builds).
 */
export async function goto(target: string | Target, opts: { settle?: number; timeout?: number; } = {}): Promise<AppState>
{
    const t = typeof target === 'string' ? parseTarget(target) : target;
    const deadline = performance.now() + (opts.timeout ?? 180_000);
    await until('the app', () => !!hooks.app, deadline);
    const app = hooks.app!;

    // (the Mods page works while indexing; the rest waits for the index)
    if (t.mods === undefined)
        await until('the index', () => app.state().index === 'ready', deadline);

    if (t.mods !== undefined)
    {
        app.mods();
        await until('the Mods page', () => !!hooks.mods, deadline);

        if (typeof t.mods === 'string')
            hooks.mods!.view(t.mods);
    }
    else if (t.map)
    {
        const m = t.map;
        app.map(m.focus);
        await until('the map page', () => !!hooks.map, deadline);
        hooks.map!.begin();
        await until('the map', () => !!hooks.map?.loaded(), deadline);
        const error = hooks.map!.set(m);

        if (error)
            throw new Error(error);

        await until('the map at the date', () => !!hooks.map?.loaded() && hooks.map.shown(), deadline);

        if (hooks.map!.state().dim === '3d')
        {
            await until('the 3D view', () => !!hooks.map3d, deadline);
            const m3 = hooks.map3d!;

            if (m.camera)
                m3.cam.setPose(m.camera);
            else if (m.box)
                m3.cam.focus(m.box, true, 1);

            m3.invalidate();
        }

        hooks.map!.view(m);
    }
    else if (t.type)
    {
        app.route({ type: t.type, name: t.name });

        if (t.tab)
            app.tab(t.tab);
    }

    // (a page of its own closes the dialog; @settings opens it over the page shown)
    if (t.settings !== undefined)
        app.settings(t.settings);
    else
        app.settings(false);

    await idle(deadline);

    if (opts.settle)
        await sleep(opts.settle);

    return state();
}

/** window.__app; the start target (CRUSADERPOPE_START) once the app is up — `__app.started` settles when it is shown. */
export function installTestApi(): void
{
    const started = api.startTarget().then((t) => (t ? goto(t) : null));
    started.then(
        (s) => s && console.info('Start target:', s.target),
        (e: Error) => console.warn('Start target:', e.message)
    );
    (window as unknown as { __app: unknown; }).__app = { goto, state, here: () => state().target, parse: parseTarget, started };
}
