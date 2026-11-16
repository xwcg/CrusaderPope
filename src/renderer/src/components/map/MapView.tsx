/**
 * The map page (docs/map.md): the game's province map (ck3://map/<key>.bin, a province id per pixel) in 2D
 * (gl2d.ts: WebGL2 through a palette per mode) or 3D (Map3DView), coloured by a mode (model.ts: realms and vassals
 * at a date, de jure titles, the layers (cultures, faiths, terrain …)), with names (labels.ts), a legend, an
 * overview, hover and the side panel (MapPanel.tsx).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MapFogInfo, MapInfo } from '../../../../shared/api';
import { api } from '../../api';
import { imgUrl } from '../../img';
import type { Navigate } from '../../App';
import { Map2D, type View } from './gl2d';
import { drawLabels } from './labels';
import { centralProvince, focusOf, groupsOf, modesOf, type Mode, type Style } from './model';
import { MapPanel, MapTooltip } from './MapPanel';
import { DateControl } from './DateControl';
import { Map3DView } from './Map3DView';
import { Legend } from './Legend';
import { Minimap } from './Minimap';
import { ModeBar } from './pres-ModeBar';
import { provinceRaster } from './raster';
import { loadMapInfo } from './mapLoad';
import { drawOverlays2d } from './overlays2d';
import { undoMapEdit } from './MapEdit';
import { track } from '../../pending';
import { hook } from '../../testApi';
import '../../styles/map.css';
import { Select } from '../Select';
import { MapEditMenu } from './MapEditMenu';
import { mapMemory, rememberMap, setPreviewDate, usePreviewDate } from '../../viewState';
import { pickMapEdit } from './mapPick';
import { buildFog, defaultViewpoint, realmOf, viewpointName, type FogDraw, type Viewpoint } from './fog';
import { pickViewpoint } from './fogPick';

import { errorText } from '../../errors';
import { tr } from '../../../../shared/i18n';
import { fold } from '../../../../shared/fold';
export const MAP_ROUTE = '@map';

/** A picture of one colour (AGOT's terrain colour map is a grey placeholder). */
function isFlat(img: HTMLImageElement): boolean
{
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 16;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0, 32, 16);
    const d = ctx.getImageData(0, 0, 32, 16).data;
    let lo = 255;
    let hi = 0;

    for (let i = 0; i < d.length; i += 4)
    {
        const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
        lo = Math.min(lo, l);
        hi = Math.max(hi, l);
    }

    return hi - lo < 10;
}

/** @param active the map page shows (false: kept loaded, hidden; App.tsx MAP_KEEP: no shortcuts) */
export function MapView(props: { navigate: Navigate; reloadKey: string; focus?: string; active?: boolean; }): React.JSX.Element
{
    const active = useRef(props.active !== false);
    active.current = props.active !== false;
    const [info, setInfo] = useState<MapInfo | null>(null);
    const [ids, setIds] = useState<Uint16Array | null>(null);
    const [error, setError] = useState<string | null>(null);
    // the preview date (the character pages' too, viewState.ts); what the map showed last comes back
    const date = usePreviewDate();
    const setDate = setPreviewDate;
    const memory = useRef(mapMemory()).current;
    // (an edit from the map: read it again)
    const [edits, setEdits] = useState(0);
    const [mode, setMode] = useState<Mode>((memory.mode as Mode | undefined) ?? 'realm');
    const [dim, setDim] = useState<'2d' | '3d'>(memory.dim ?? '2d');
    const [style, setStyle] = useState<Style>((memory.style as Style | undefined) ?? 'terrain');
    // (a style picked in the menu stays; otherwise a flat terrain colour map gives way to the paper map)
    const picked = useRef(!!memory.stylePicked);
    const [hover, setHover] = useState<{ p: number; x: number; y: number; } | null>(null);
    // the right-click menu in the picker (mapPick.ts); its Colour… opens the colour editor (MapEditMenu.tsx) at the point
    const [menu, setMenu] = useState<{ p: number; x: number; y: number; title: number; } | null>(null);
    const openMenu = useCallback((p: number, x: number, y: number): void =>
    {
        setSel(p > 0 ? p : null);
        setMenu(null);

        if (p <= 0 || !info)
            return;

        void pickMapEdit(info, p, { x, y }).then((r) =>
        {
            if (r && 'done' in r)
                setEdits((n) => n + 1);
            else if (r)
                setMenu({ p, x, y, title: r.colour });
        });
    }, [info]);
    // the selected province (its group is the mode's: a mode change keeps it selected)
    const [sel, setSel] = useState<number | null>(memory.sel ?? null);

    // (remembered for the next time the map is made: viewState.ts)
    useEffect(() => rememberMap({ mode, dim, style, stylePicked: picked.current, sel }), [mode, dim, style, sel]);
    const [focusBox, setFocusBox] = useState<[number, number, number, number] | undefined>(undefined);
    const [search, setSearch] = useState('');
    const wrap = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const labels = useRef<HTMLCanvasElement>(null);
    const overlay = useRef<HTMLCanvasElement>(null);
    // a legend row under the pointer: its group highlighted (one of its provinces)
    const [legendHover, setLegendHover] = useState<number | null>(null);
    const map2d = useRef<Map2D | null>(null);
    const view = useRef<View | null>(null);
    const frame = useRef(0);
    // the labels as last placed (their view and what they were placed from): while the view moves they are only moved
    // along (a CSS transform) and placed again once it rests; placing them every frame made zooming slow
    const labelsAt = useRef<{ v: View; t: number; key: unknown[]; } | null>(null);
    const labelsTimer = useRef<number | undefined>(undefined);
    // the minimap follows the view at most every 100 ms (a state change re-renders the page)
    const tickAt = useRef(0);
    const tickTimer = useRef<number | undefined>(undefined);
    const [ready, setReady] = useState(0);
    const [viewTick, setViewTick] = useState(0);
    // the date whose map and raster are in (null: none yet); the test API waits for the date it asked for
    const loadedFor = useRef<string | undefined | null>(null);

    // the map at the date (a new index, date or edit: again)
    useEffect(() =>
    {
        let live = true;
        setError(null);
        loadMapInfo(date)
            .then((i) =>
            {
                if (!live)
                    return;

                if (!i)
                    throw new Error(tr('The index is not ready'));

                setInfo(i);
                return provinceRaster(i.key).then((r) =>
                {
                    if (!live)
                        return;

                    setIds(r);
                    loadedFor.current = date;
                });
            })
            .catch((e: Error) => live && setError(errorText(e)));
        return () =>
        {
            live = false;
        };
    }, [date, props.reloadKey, edits]);

    const groups = useMemo(() => (info ? groupsOf(info, mode) : null), [info, mode]);
    const modes = useMemo(() => (info ? modesOf(info) : []), [info]);

    const draw = useCallback(() =>
    {
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() =>
        {
            const m = map2d.current;
            const cv = canvas.current;
            const v = view.current;

            if (!m || !cv || !v || !groups || !info)
                return;

            // (the view remembered for the next time the map is made)
            rememberMap({ view: { key: info.key, x: v.x, y: v.y, scale: v.scale } });
            const hp = legendHover ?? hover?.p;
            m.draw(cv, v, style, hp !== undefined ? groups.of[hp] + 1 : 0, sel !== null ? groups.of[sel] + 1 : 0, sel !== null && groups.of[sel] < 0 ? sel : 0);

            if (overlay.current)
                drawOverlays2d(overlay.current, v, info, style);

            const lc = labels.current;

            if (lc)
            {
                const now = performance.now();
                const last = labelsAt.current;
                const key = [info, groups, style];
                const place = (): void =>
                {
                    const at = view.current ?? v;
                    drawLabels(lc, at, info, groups, style);
                    lc.style.transform = '';
                    labelsAt.current = { v: { ...at }, t: performance.now(), key };
                };
                const same = !!last && last.key.every((k, i) => k === key[i]);

                if (same && last.v.x === v.x && last.v.y === v.y && last.v.scale === v.scale)
                    lc.style.transform = '';
                // (moving: the labels drawn last moved and scaled with the view, placed again when it rests)
                else if (same && now - last.t < 400)
                {
                    const k = last.v.scale / v.scale;
                    lc.style.transformOrigin = '0 0';
                    lc.style.transform = `translate(${(last.v.x - v.x) / v.scale}px, ${(last.v.y - v.y) / v.scale}px) scale(${k})`;
                    window.clearTimeout(labelsTimer.current);
                    labelsTimer.current = window.setTimeout(place, 140);
                }
                else
                {
                    window.clearTimeout(labelsTimer.current);
                    place();
                }
            }

            const now = performance.now();

            if (now - tickAt.current > 100)
            {
                tickAt.current = now;
                setViewTick((t) => t + 1);
            }
            else
            {
                window.clearTimeout(tickTimer.current);
                tickTimer.current = window.setTimeout(() =>
                {
                    tickAt.current = performance.now();
                    setViewTick((t) => t + 1);
                }, 100);
            }
        });
    }, [info, groups, hover, legendHover, sel, style]);

    // Ctrl+Z (outside text fields): the last map edit undone
    useEffect(() =>
    {
        const onKey = (e: KeyboardEvent): void =>
        {
            const t = e.target as HTMLElement | null;

            // (sliders and pickers keep the focus after use: they don't take Ctrl+Z; a hidden map takes none)
            if (!active.current || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z' || t?.closest('textarea, [contenteditable], input:not([type=range], [type=color], [type=checkbox])'))
                return;

            e.preventDefault();
            void undoMapEdit();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // (a new date keeps the drawing and its background: only the palettes change)
    const infoRef = useRef<MapInfo | null>(null);
    infoRef.current = info;
    const drawRef = useRef(draw);
    drawRef.current = draw;
    const mapKey = info?.key;
    const terrainImage = info?.terrainImage;
    const paperImage = info?.paperImage;

    // the fog of war (docs/map.md, "Fog of war"): on or off, whose view (a title or a character: their realm at the
    // date, one ring of neighbours around it), the game's settings (NFogOfWar, read again with the mods)
    const [fogOn, setFogOn] = useState(!!memory.fog?.on);
    const [fogVp, setFogVp] = useState<Viewpoint | null>(memory.fog?.vp ?? null);
    const fogPicked = useRef(!!memory.fog?.picked);
    const [fogDef, setFogDef] = useState<MapFogInfo | null>(null);
    useEffect(() => rememberMap({ fog: { on: fogOn, vp: fogVp ?? undefined, picked: fogPicked.current } }), [fogOn, fogVp]);
    useEffect(() =>
    {
        if (!fogOn)
            return;

        let live = true;
        void api.mapFog().then((d) => live && setFogDef(d)).catch(() => undefined);
        return () =>
        {
            live = false;
        };
    }, [fogOn, props.reloadKey, mapKey]);
    // (made again only for another map, date, viewpoint or settings; the neighbours of a raster are read once)
    const fogDraw = useMemo<FogDraw | null>(() => (fogOn && fogDef && info && ids && fogVp ? buildFog(info, ids, fogDef, fogVp) : null), [fogOn, fogDef, info, ids, fogVp]);
    const chooseFog = useCallback((at: { x: number; y: number; }): void =>
    {
        if (!info)
            return;

        void pickViewpoint(info, at).then((vp) =>
        {
            if (!vp)
                return;

            fogPicked.current = true;
            setFogVp(vp);
            setFogOn(true);
        });
    }, [info]);
    const toggleFog = (e: React.MouseEvent<HTMLElement>): void =>
    {
        if (fogOn)
            return setFogOn(false);

        // (a viewpoint chosen stays; else the played character of a loaded save, else the selected province's realm)
        const vp = fogPicked.current && fogVp ? fogVp : info ? defaultViewpoint(info, sel) ?? fogVp : fogVp;

        if (vp)
        {
            setFogVp(vp);
            setFogOn(true);
            return;
        }

        const r = e.currentTarget.getBoundingClientRect();
        chooseFog({ x: r.left, y: r.bottom });
    };

    // the 2D drawing once the raster is here
    useEffect(() =>
    {
        const cv = canvas.current;
        const info = infoRef.current;

        if (dim !== '2d' || !cv || !ids || !info)
            return;

        let m: Map2D;

        try
        {
            m = new Map2D(cv, info, ids);
        }
        catch (e)
        {
            setError(errorText(e));
            return;
        }

        map2d.current = m;

        // the view the map had (the same map), else the whole map in view
        const was = mapMemory().view;

        if (!view.current && was && was.key === info.key)
            view.current = { x: was.x, y: was.y, scale: was.scale };

        if (!view.current)
        {
            const s = Math.max(info.width / cv.clientWidth, info.height / cv.clientHeight);
            view.current = { x: (info.width - cv.clientWidth * s) / 2, y: (info.height - cv.clientHeight * s) / 2, scale: s };
        }

        setReady((n) => n + 1);
        return () =>
        {
            map2d.current = null;
            m.dispose();
        };
    }, [ids, mapKey, dim]);

    // the background picture (terrain colour map or paper map)
    useEffect(() =>
    {
        const m = map2d.current;
        const path = style === 'paper' ? paperImage : style === 'terrain' ? terrainImage : undefined;

        if (!m || !path)
            return;

        let live = true;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        // (counted while it loads: the test API waits for it)
        void track(
            new Promise<void>((resolve) =>
            {
                img.onload = () =>
                {
                    resolve();

                    if (!live || map2d.current !== m)
                        return;

                    if (style === 'terrain' && !picked.current && isFlat(img) && paperImage)
                        return setStyle('paper');

                    m.setBackground(img);
                    drawRef.current();
                };
                img.onerror = () => resolve();
            })
        );
        img.src = imgUrl(path, 4096);
        return () =>
        {
            live = false;
        };
    }, [style, terrainImage, paperImage, ready]);

    // the palettes of the mode
    useEffect(() =>
    {
        if (!map2d.current || !groups)
            return;

        map2d.current.setGroups(groups);
        drawRef.current();
        // (not on every hover: `draw` changes with it; the groups' distance field and textures are made again only for
        // other groups)
    }, [groups, ready]);

    // the fog of war in 2D: the mask for the table (made again only for another one)
    useEffect(() =>
    {
        const m = map2d.current;

        if (!m)
            return;

        try
        {
            m.setFog(fogDraw);
        }
        catch (e)
        {
            setError(errorText(e));
        }

        drawRef.current();
    }, [fogDraw, ready]);

    useEffect(() => draw(), [draw]);
    useEffect(() =>
    {
        const onResize = (): void => draw();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [draw]);

    /** keeps the view's centre on the map */
    const clamp = (v: View): View =>
    {
        const cv = canvas.current;

        if (!cv || !info)
            return v;

        const hw = (cv.clientWidth * v.scale) / 2;
        const hh = (cv.clientHeight * v.scale) / 2;
        return { ...v, x: Math.min(info.width - hw, Math.max(-hw, v.x)), y: Math.min(info.height - hh, Math.max(-hh, v.y)) };
    };

    const provinceAt = (e: { clientX: number; clientY: number; }): number =>
    {
        const cv = canvas.current;
        const v = view.current;

        if (!cv || !v || !ids || !info)
            return -1;

        const r = cv.getBoundingClientRect();
        const x = Math.floor(v.x + (e.clientX - r.left) * v.scale);
        const y = Math.floor(v.y + (e.clientY - r.top) * v.scale);

        if (x < 0 || y < 0 || x >= info.width || y >= info.height)
            return -1;

        return ids[y * info.width + x];
    };

    /** brings a box of map pixels into view (2D: at once; 3D: through its focus) */
    const fit = useCallback(
        (x0: number, y0: number, x1: number, y1: number) =>
        {
            setFocusBox([x0, y0, x1, y1]);
            const cv = canvas.current;

            if (!cv)
                return;

            const pad = 1.3;
            const s = Math.max(((x1 - x0 + 1) * pad) / cv.clientWidth, ((y1 - y0 + 1) * pad) / cv.clientHeight, 0.08);
            view.current = { x: (x0 + x1) / 2 - (cv.clientWidth * s) / 2, y: (y0 + y1) / 2 - (cv.clientHeight * s) / 2, scale: s };
            draw();
        },
        [draw]
    );

    /** selects a group (by one of its provinces), zoomed to it */
    const select = useCallback(
        (p: number, zoom: boolean) =>
        {
            setSel(p);
            const g = groups ? groups.of[p] : -1;

            if (zoom && g >= 0)
                fit(groups!.box[g * 4], groups!.box[g * 4 + 1], groups!.box[g * 4 + 2], groups!.box[g * 4 + 3]);
        },
        [groups, fit]
    );

    // "Show on map" (route name `type:key`): the entry's mode, selected and in view
    const focused = useRef<string | undefined>(undefined);
    useEffect(() =>
    {
        if (!props.focus || !info || !groups || focused.current === props.focus + info.key)
            return;

        const at = props.focus.indexOf(':');
        const f = focusOf(info, props.focus.slice(0, at), props.focus.slice(at + 1));

        if (!f)
            return;

        if (mode !== f.mode)
            return setMode(f.mode);

        if (dim === '2d' && !map2d.current)
            return;

        focused.current = props.focus + info.key;

        if (groups.area[f.group])
            select(centralProvince(info, groups, f.group), true);
    }, [props.focus, info, groups, mode, select, ready, dim]);

    // the test API (testApi.ts): the map's state read and set directly; `want` = what it asked for and waits to see
    const latest = useRef({ info, ids, groups, dim, mode, style, date, sel });
    latest.current = { info, ids, groups, dim, mode, style, date, sel };
    const want = useRef<{ date?: string; dim?: '2d' | '3d'; mode?: string; }>({});
    useEffect(
        () =>
            hook('map', {
                begin: () =>
                {
                    want.current = {};
                },
                loaded: () =>
                {
                    const l = latest.current;
                    return !!(l.info && l.ids && l.groups) && loadedFor.current === (want.current.date ?? l.date);
                },
                set: (t) =>
                {
                    const l = latest.current;

                    if (t.mode !== undefined)
                    {
                        const all = l.info ? modesOf(l.info) : [];
                        const m = all.find((x) => x.id === t.mode) ?? all.find((x) => x.label.toLowerCase() === t.mode!.toLowerCase());

                        if (!m)
                            return tr('Unknown map mode "{mode}" — {all}', { mode: t.mode, all: all.map((x) => `${x.id} (${x.label})`).join(', ') });

                        want.current.mode = m.id;
                        setMode(m.id);
                    }

                    if (t.date !== undefined)
                    {
                        want.current.date = t.date;
                        setDate(t.date);
                    }

                    if (t.style !== undefined)
                    {
                        picked.current = true;
                        setStyle(t.style);
                    }

                    if (t.dim !== undefined)
                    {
                        want.current.dim = t.dim;

                        if (t.dim === '3d' && l.dim === '2d')
                        {
                            // (as the 3D button: from where the 2D view is, the terrain's look rather than the paper map)
                            const v = view.current;
                            const cv = canvas.current;

                            if (v && cv)
                                setFocusBox([v.x, v.y, v.x + cv.clientWidth * v.scale, v.y + cv.clientHeight * v.scale]);

                            if (!picked.current && l.style === 'paper')
                                setStyle('terrain');
                        }

                        setDim(t.dim);
                    }

                    return null;
                },
                shown: () =>
                {
                    const l = latest.current;
                    const w = want.current;
                    return (w.dim ?? l.dim) === l.dim && (w.mode ?? l.mode) === l.mode && (l.dim === '3d' || !!map2d.current);
                },
                view: (t) =>
                {
                    if (t.select !== undefined)
                        setSel(t.select > 0 ? t.select : null);

                    const cv = canvas.current;

                    if (t.box && latest.current.dim === '2d' && cv)
                    {
                        const [x0, y0, x1, y1] = t.box;
                        const s = Math.max((x1 - x0) / cv.clientWidth, (y1 - y0) / cv.clientHeight, 0.05);
                        view.current = { x: (x0 + x1) / 2 - (cv.clientWidth * s) / 2, y: (y0 + y1) / 2 - (cv.clientHeight * s) / 2, scale: s };
                        drawRef.current();
                    }
                },
                state: () =>
                {
                    const l = latest.current;
                    const v = view.current;
                    const cv = canvas.current;
                    const box: [number, number, number, number] | undefined = l.dim === '2d' && v && cv ? [v.x, v.y, v.x + cv.clientWidth * v.scale, v.y + cv.clientHeight * v.scale] : undefined;
                    return { dim: l.dim, mode: l.mode, date: l.info?.date ?? '', style: l.style, sel: l.sel, box };
                }
            }),
        []
    );

    // pan (drag) and zoom (wheel, around the pointer)
    const drag = useRef<{ x: number; y: number; moved: boolean; } | null>(null);
    const onWheel = (e: React.WheelEvent): void =>
    {
        const cv = canvas.current;
        const v = view.current;

        if (!cv || !v || !info)
            return;

        const r = cv.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const my = e.clientY - r.top;
        const fitScale = Math.max(info.width / cv.clientWidth, info.height / cv.clientHeight) * 1.1;
        const s = Math.min(fitScale, Math.max(0.05, v.scale * Math.pow(1.0015, e.deltaY)));
        view.current = clamp({ x: v.x + mx * (v.scale - s), y: v.y + my * (v.scale - s), scale: s });
        draw();
    };
    const onDown = (e: React.PointerEvent): void =>
    {
        if (e.button !== 0 && e.button !== 1 && e.button !== 2)
            return;

        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, moved: false };
    };
    const onMove = (e: React.PointerEvent): void =>
    {
        const d = drag.current;
        const v = view.current;

        if (d && v)
        {
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;

            if (d.moved || Math.abs(dx) + Math.abs(dy) > 3)
            {
                d.moved = true;
                view.current = clamp({ ...v, x: v.x - dx * v.scale, y: v.y - dy * v.scale });
                d.x = e.clientX;
                d.y = e.clientY;
                draw();
            }
        }

        const p = provinceAt(e);
        const r = wrap.current!.getBoundingClientRect();
        setHover(p > 0 ? { p, x: e.clientX - r.left, y: e.clientY - r.top } : null);
    };
    const onUp = (e: React.PointerEvent): void =>
    {
        const d = drag.current;
        drag.current = null;

        if (!d || d.moved || (e.button !== 0 && e.button !== 2) || !groups)
            return;

        const p = provinceAt(e);

        if (e.button === 2)
            openMenu(p, e.clientX, e.clientY);
        else
            setSel(p > 0 ? p : null);
    };
    const jump = (x: number, y: number): void =>
    {
        const cv = canvas.current;
        const v = view.current;

        if (!cv || !v)
            return;

        view.current = clamp({ ...v, x: x - (cv.clientWidth * v.scale) / 2, y: y - (cv.clientHeight * v.scale) / 2 });
        draw();
    };

    const searchable = useMemo(() =>
    {
        if (!groups)
            return [];

        const out: { g: number; name: string; folded: string; }[] = [];

        for (let g = 0; g < groups.area.length; g++)
            if (groups.area[g])
            {
                const name = groups.name(g);
                out.push({ g, name, folded: fold(name) });
            }

        return out.sort((a, b) => a.name.localeCompare(b.name));
    }, [groups]);
    const runSearch = (): void =>
    {
        // (accents and case aside: "evreux" finds "Évreux")
        const q = fold(search.trim());

        if (!q || !groups)
            return;

        const hit = searchable.find((s) => s.folded === q) ?? searchable.find((s) => s.folded.startsWith(q)) ?? searchable.find((s) => s.folded.includes(q));

        if (hit && info)
            select(centralProvince(info, groups, hit.g), true);
    };

    const current = modes.find((m) => m.id === mode);

    return (
        <div className="map-page">
            <div className="map-toolbar">
                <ModeBar modes={modes} mode={mode} onMode={setMode} />
                {/* (a loaded save: its date only, no timeline) */}
                {info?.save && (
                    <span className="map-save-date" title={tr('The loaded save\'s state: its titles and realms at its date (the Save tab loads another or unloads it)')}>
                        {tr('Savegame · {date}', { date: info.save.date })}
                    </span>
                )}
                {info && !info.save && (
                    <DateControl
                        info={info}
                        historical={!!current?.historical}
                        onDate={setDate}
                        onNewBookmark={(date) =>
                        {
                            // (a key of its own: bm_<year>_<n>, the first free one; its card opens to fill it in)
                            const year = date.split('.')[0];
                            void api.createEntries([{ what: 'entry', key: `bm_${year}_${Date.now() % 100000}`, loc: `New bookmark ${date}`, fields: [['type', 'bookmarks/bookmarks'], ['start_date', date]] }])
                                .then((r) =>
                                {
                                    const key = /“([^”]+)”/.exec(r.notes[0] ?? '')?.[1];

                                    if (key)
                                        props.navigate({ type: 'bookmarks/bookmarks', name: key });
                                })
                                .catch((e: Error) => window.alert(errorText(e)));
                        }}
                    />
                )}
                <form
                    className="map-search"
                    onSubmit={(e) =>
                    {
                        e.preventDefault();
                        runSearch();
                    }}
                >
                    <input list="map-search-names" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr('Find {label}…', { label: current?.label.toLowerCase() ?? '' })} />
                    <datalist id="map-search-names">
                        {searchable.slice(0, 3000).map((s) => <option key={s.g} value={s.name} />)}
                    </datalist>
                </form>
                <div className="map-dims">
                    {(['2d', '3d'] as const).map((d) => (
                        <button
                            key={d}
                            className={'map-mode' + (dim === d ? ' on' : '')}
                            onClick={() =>
                            {
                                // (3D starts where the 2D view is)
                                const v = view.current;
                                const cv = canvas.current;

                                if (d === '3d' && dim === '2d' && v && cv)
                                    setFocusBox([v.x, v.y, v.x + cv.clientWidth * v.scale, v.y + cv.clientHeight * v.scale]);

                                // (the 3D terrain has the game's materials: a flat colour map (AGOT) no longer calls for the paper map)
                                if (d === '3d' && !picked.current && style === 'paper')
                                    setStyle('terrain');

                                setDim(d);
                            }}
                        >
                            {d.toUpperCase()}
                        </button>
                    ))}
                </div>
                <button
                    className={'map-mode map-fog' + (fogOn ? ' on' : '')}
                    onClick={toggleFog}
                    title={tr('Fog of war as the game draws it: what is out of sight of a realm (its provinces and one ring of neighbours at this date) goes dark — whose view: the selected province’s realm, a loaded save’s player, or any title or character. In 3D the fog shows only when zoomed in, as in the game')}
                >
                    {tr('Fog of war')}
                </button>
                {fogOn && info && (
                    <button
                        className="map-mode map-fog-view"
                        onClick={(e) =>
                        {
                            const r = e.currentTarget.getBoundingClientRect();
                            chooseFog({ x: r.left, y: r.bottom });
                        }}
                        title={fogVp && realmOf(info, fogVp) < 0 ? tr('{name} has no realm on {date}: nothing is hidden. Choose another view', { name: viewpointName(info, fogVp), date: info.date }) : fogDraw ? tr('Whose view the fog of war shows: {realm} provinces of the realm and {ring} next to it in sight, of {total} (choose a title or a character)', { realm: fogDraw.count.realm, ring: fogDraw.count.ring, total: fogDraw.count.total }) : tr('Whose view the fog of war shows (choose a title or a character)')}
                    >
                        {fogVp ? viewpointName(info, fogVp) : tr('Choose…')}
                    </button>
                )}
                <Select
                    className="map-style"
                    value={style}
                    onChange={(e) =>
                    {
                        picked.current = true;
                        setStyle(e.target.value as Style);
                    }}
                    title={tr('What is under the map mode\'s colours')}
                >
                    <option value="terrain">{tr('Terrain')}</option>
                    <option value="paper">{tr('Paper map')}</option>
                    <option value="plain">{tr('Plain')}</option>
                </Select>
            </div>
            <div className="map-body">
                {dim === '2d' ?
                    (
                        <div className="map-canvas" ref={wrap} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setHover(null)} onContextMenu={(e) => e.preventDefault()}>
                            <canvas ref={canvas} />
                            <canvas ref={overlay} className="map-labels map-overlay" />
                            <canvas ref={labels} className="map-labels" />
                            {!ids && !error && <div className="map-status">{info ? tr('Loading the province map…') : tr('Reading the map (the first time builds the province map)…')}</div>}
                            {error && <div className="map-status error">{error}</div>}
                            {hover && info && groups && !drag.current?.moved && <MapTooltip info={info} groups={groups} mode={mode} p={hover.p} x={hover.x} y={hover.y} />}
                            {info && groups && canvas.current && <Minimap info={info} groups={groups} view={view.current} size={{ w: canvas.current.clientWidth, h: canvas.current.clientHeight }} tick={viewTick} onJump={jump} />}
                        </div>
                    ) :
                    (
                        <div className="map-canvas map-3d" ref={wrap}>
                            {info && ids && groups ?
                                (
                                    <Map3DView
                                        info={info}
                                        ids={ids}
                                        groups={groups}
                                        mode={mode}
                                        style={style}
                                        sel={sel ?? -1}
                                        hover={legendHover ?? hover?.p ?? -1}
                                        onHover={(p, x, y) => setHover(p > 0 ? { p, x, y } : null)}
                                        onSelect={(p) => setSel(p > 0 ? p : null)}
                                        onMenu={openMenu}
                                        focus={focusBox}
                                        fog={fogDraw}
                                    />
                                ) :
                                <div className="map-status">{error ?? tr('Loading the map…')}</div>}
                            {hover && info && groups && <MapTooltip info={info} groups={groups} mode={mode} p={hover.p} x={hover.x} y={hover.y} />}
                        </div>
                    )}
                {info && groups && <Legend info={info} groups={groups} mode={mode} onPick={(g) => select(centralProvince(info, groups, g), true)} onHover={(g) => setLegendHover(g === null ? null : centralProvince(info, groups, g))} />}
                {info && menu && <MapEditMenu info={info} p={menu.p} x={menu.x} y={menu.y} title={menu.title} onClose={() => setMenu(null)} onChanged={() => setEdits((n) => n + 1)} />}
                {info && groups && sel !== null && <MapPanel info={info} groups={groups} mode={mode} sel={sel} navigate={props.navigate} onClose={() => setSel(null)} onZoom={() => select(sel, true)} onChanged={() => setEdits((n) => n + 1)} />}
            </div>
        </div>
    );
}
